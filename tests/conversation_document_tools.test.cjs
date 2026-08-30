const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadConversationDocumentToolsModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/virtual_file_io/index.js');
  return import(`${pathToFileURL(filePath).href}?test=${Date.now()}`);
}

function createInMemoryDocumentStore(seed = {}) {
  const rows = new Map(
    Object.entries(seed).map(([filePath, content]) => [
      filePath,
      {
        path: filePath,
        content,
        updated_at: '2026-04-13T00:00:00.000Z'
      }
    ])
  );

  return {
    async listDocuments() {
      return Array.from(rows.values())
        .map((item) => ({ ...item }))
        .sort((left, right) => left.path.localeCompare(right.path));
    },
    async getDocument(_conversationId, filePath) {
      return rows.has(filePath) ? { ...rows.get(filePath) } : null;
    },
    async putDocument(_conversationId, documentRecord) {
      const next = { ...documentRecord };
      rows.set(next.path, next);
      return { ...next };
    },
    async mutateDocuments(_conversationId, mutator) {
      const current = Array.from(rows.values()).map((item) => ({ ...item }));
      const prepared = mutator(current);
      rows.clear();
      for (const documentRecord of prepared.documents) {
        rows.set(documentRecord.path, { ...documentRecord });
      }
      return {
        documents: Array.from(rows.values()).map((item) => ({ ...item })),
        value: prepared.value
      };
    },
    async replaceDocuments(_conversationId, documents) {
      rows.clear();
      for (const documentRecord of documents) {
        rows.set(documentRecord.path, { ...documentRecord });
      }
      return Array.from(rows.values()).map((item) => ({ ...item }));
    }
  };
}

function createLocalFileHandle(name, content) {
  return {
    kind: 'file',
    name,
    async queryPermission() {
      return 'granted';
    },
    async getFile() {
      return {
        name,
        lastModified: Date.parse('2026-04-13T00:00:00.000Z'),
        async text() {
          return content;
        }
      };
    }
  };
}

function createLocalDirectoryHandle(name, tree) {
  const entries = new Map();
  Object.entries(tree || {}).forEach(([entryName, value]) => {
    entries.set(
      entryName,
      typeof value === 'string'
        ? createLocalFileHandle(entryName, value)
        : createLocalDirectoryHandle(entryName, value)
    );
  });
  return {
    kind: 'directory',
    name,
    async queryPermission() {
      return 'granted';
    },
    async *entries() {
      for (const entry of entries.entries()) {
        yield entry;
      }
    },
    async getDirectoryHandle(entryName) {
      const entry = entries.get(entryName);
      if (!entry || entry.kind !== 'directory') {
        throw new Error(`missing directory ${entryName}`);
      }
      return entry;
    },
    async getFileHandle(entryName) {
      const entry = entries.get(entryName);
      if (!entry || entry.kind !== 'file') {
        throw new Error(`missing file ${entryName}`);
      }
      return entry;
    }
  };
}

function createInMemoryLocalMountStore(mounts = []) {
  return {
    async listMounts() {
      return mounts.map((mount) => ({ ...mount }));
    }
  };
}

test('统一根相对路径支持 Unicode 和普通目录，并拒绝绝对路径与越界路径', async () => {
  const {
    normalizeConversationDocumentHrefPath,
    normalizeConversationDocumentPath
  } = await loadConversationDocumentToolsModule();

  assert.equal(
    normalizeConversationDocumentPath('workspace\\研究 计划(终版).md'),
    'workspace/研究 计划(终版).md'
  );
  assert.equal(
    normalizeConversationDocumentHrefPath('workspace/%E9%9A%8F%E7%AC%94%20%E7%BB%88%E7%89%88.md'),
    'workspace/随笔 终版.md'
  );
  assert.equal(
    normalizeConversationDocumentHrefPath('workspace/a%2Fb.md'),
    'workspace/a%2Fb.md'
  );
  assert.throws(
    () => normalizeConversationDocumentPath('../secret.txt'),
    /不能包含空段、"\." 或 "\.\."/
  );
  assert.throws(
    () => normalizeConversationDocumentPath('/absolute.txt'),
    /相对路径/
  );
});

test('normalizeVirtualFileToolArguments 使用单一 environment_id 与精确参数', async () => {
  const {
    VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
    VIRTUAL_FILE_COPY_FILE_TOOL_NAME,
    VIRTUAL_FILE_LIST_FILES_TOOL_NAME,
    VIRTUAL_FILE_READ_FILE_TOOL_NAME,
    VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME,
    normalizeVirtualFileToolArguments
  } = await loadConversationDocumentToolsModule();

  assert.deepEqual(
    normalizeVirtualFileToolArguments(VIRTUAL_FILE_LIST_FILES_TOOL_NAME, {
      environment_id: null,
      path_glob: null
    }),
    {
      action: 'list_files',
      environment: {
        kind: 'root',
        environment_id: null,
        skill_name: null
      },
      path_glob: null
    }
  );

  assert.deepEqual(
    normalizeVirtualFileToolArguments(VIRTUAL_FILE_READ_FILE_TOOL_NAME, {
      environment_id: 'skill:dom-probe',
      path: 'spec.md',
      start_line: 20,
      end_line: 40
    }),
    {
      action: 'read_file',
      environment: {
        kind: 'skill',
        environment_id: 'skill:dom-probe',
        skill_name: 'dom-probe'
      },
      file_path: 'spec.md',
      read_options: {
        start_line: 20,
        end_line: 40
      }
    }
  );

  assert.throws(
    () => normalizeVirtualFileToolArguments(VIRTUAL_FILE_READ_FILE_TOOL_NAME, {
      environment_id: 'skill:DOM-PROBE',
      path: 'spec.md',
      start_line: null,
      end_line: null
    }),
    /精确/
  );
  assert.throws(
    () => normalizeVirtualFileToolArguments(VIRTUAL_FILE_READ_FILE_TOOL_NAME, {
      environment_id: null,
      path: 'spec.md',
      start_line: 20,
      end_line: null
    }),
    /必须同时/
  );

  assert.deepEqual(
    normalizeVirtualFileToolArguments(VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME, {
      environment_id: null,
      pattern: 'token',
      regex: false,
      path_glob: '**/*.md',
      ignore_case: true,
      context_lines: 2
    }),
    {
      action: 'search_files',
      environment: {
        kind: 'root',
        environment_id: null,
        skill_name: null
      },
      pattern: 'token',
      regex: false,
      ignore_case: true,
      path_glob: '**/*.md',
      context_lines: 2
    }
  );

  assert.deepEqual(
    normalizeVirtualFileToolArguments(VIRTUAL_FILE_COPY_FILE_TOOL_NAME, {
      environment_id: null,
      from: 'spec.md',
      to: 'copy.md'
    }),
    {
      action: 'copy_file',
      environment: {
        kind: 'root',
        environment_id: null,
        skill_name: null
      },
      source_path: 'spec.md',
      destination_path: 'copy.md'
    }
  );

  const patchArgs = normalizeVirtualFileToolArguments(VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME, {
    environment_id: null,
    patch: '*** Begin Patch\n*** Add File: notes.md\n+hello\n*** End Patch'
  });
  assert.equal(patchArgs.environment.kind, 'root');

  assert.throws(
    () => normalizeVirtualFileToolArguments('move_file', {
      environment_id: null,
      from: 'references/old.md',
      to: 'references/new.md'
    }),
    /不支持的 action `move_file`/
  );
  assert.throws(
    () => normalizeVirtualFileToolArguments('delete_file', {
      environment_id: null,
      path: 'spec.md'
    }),
    /不支持的 action `delete_file`/
  );
  assert.throws(
    () => normalizeVirtualFileToolArguments(VIRTUAL_FILE_READ_FILE_TOOL_NAME, {
      environment_id: null,
      path: 'spec.md',
      start_line: null,
      end_line: null,
      numbered: true
    }),
    /不接受参数 numbered/
  );
});

test('apply_patch 工具定义聚焦虚拟文件补丁契约，不重复最终交付策略', async () => {
  const {
    buildVirtualFileApplyPatchCustomToolDefinition
  } = await loadConversationDocumentToolsModule();

  const applyPatchDefinition = buildVirtualFileApplyPatchCustomToolDefinition();
  assert.equal(applyPatchDefinition.type, 'custom');
  assert.equal(
    applyPatchDefinition.description,
    'The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.'
  );
  assert.doesNotMatch(applyPatchDefinition.description, /Environment ID|manifest\.json|local\//);
  assert.equal(applyPatchDefinition.parameters, undefined);
  assert.equal(applyPatchDefinition.format.syntax, 'lark');
  assert.match(applyPatchDefinition.format.definition, /^start: begin_patch environment_id\? hunk\+ end_patch/m);
});

test('read_file/search_files/copy_file 只暴露当前精确参数', async () => {
  const {
    buildVirtualFileCopyFileFunctionToolDefinition,
    buildVirtualFileReadFileFunctionToolDefinition,
    buildVirtualFileSearchFilesFunctionToolDefinition
  } = await loadConversationDocumentToolsModule();

  const readDefinition = buildVirtualFileReadFileFunctionToolDefinition();
  assert.equal(readDefinition.strict, true);
  assert.match(readDefinition.description, /原始正文或指定行范围/);
  assert.match(readDefinition.description, /未添加行号/);
  assert.deepEqual(
    readDefinition.parameters.required,
    ['environment_id', 'path', 'start_line', 'end_line', 'max_output_chars']
  );
  assert.equal(readDefinition.parameters.properties.numbered, undefined);
  assert.equal(readDefinition.parameters.properties.line_range, undefined);
  assert.equal(readDefinition.parameters.properties.target, undefined);

  const searchDefinition = buildVirtualFileSearchFilesFunctionToolDefinition();
  assert.equal(searchDefinition.strict, true);
  assert.match(searchDefinition.description, /同一行只返回一次/);
  assert.deepEqual(
    searchDefinition.parameters.required,
    ['environment_id', 'pattern', 'regex', 'path_glob', 'ignore_case', 'context_lines', 'max_output_chars']
  );
  assert.equal(searchDefinition.parameters.properties.glob, undefined);
  assert.equal(searchDefinition.parameters.properties.context, undefined);
  assert.equal(searchDefinition.parameters.properties.before, undefined);
  assert.equal(searchDefinition.parameters.properties.after, undefined);
  assert.equal(searchDefinition.parameters.properties.target, undefined);

  const copyDefinition = buildVirtualFileCopyFileFunctionToolDefinition();
  assert.deepEqual(copyDefinition.parameters.required, ['environment_id', 'from', 'to']);
  assert.equal(copyDefinition.parameters.properties.max_output_chars, undefined);
  assert.equal(copyDefinition.parameters.properties.target, undefined);
});

test('apply_patch 遇到同名 Add File 时会覆盖原文件且不产生隐式改名', async () => {
  const {
    executeConversationDocumentAction,
    CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME
  } = await loadConversationDocumentToolsModule();

  const store = createInMemoryDocumentStore({
    '计划.md': '# old\n'
  });

  const result = await executeConversationDocumentAction(
    CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME,
    {
      patch: [
        '*** Begin Patch',
        '*** Add File: 计划.md',
        '+# new',
        '*** End Patch'
      ].join('\n')
    },
    {
      conversationId: 'conv-doc-1',
      store
    }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.affected_files.added, []);
  assert.deepEqual(result.affected_files.modified, ['计划.md']);
  assert.equal(result.renamed_targets, undefined);
  assert.equal((await store.getDocument('conv-doc-1', '计划.md')).content, '# new\n');
});

test('apply_patch Move 会覆盖目标并移除源文件', async () => {
  const {
    executeConversationDocumentAction,
    CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME
  } = await loadConversationDocumentToolsModule();
  const store = createInMemoryDocumentStore({
    'source.md': 'old source\n',
    'target.md': 'old target\n'
  });
  const result = await executeConversationDocumentAction(
    CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME,
    {
      patch: [
        '*** Begin Patch',
        '*** Update File: source.md',
        '*** Move to: target.md',
        '@@',
        '-old source',
        '+new target',
        '*** End Patch'
      ].join('\n')
    },
    { conversationId: 'conv-move-overwrite', store }
  );

  assert.deepEqual(result.affected_files.modified, ['target.md']);
  assert.equal(await store.getDocument('conv-move-overwrite', 'source.md'), null);
  assert.equal((await store.getDocument('conv-move-overwrite', 'target.md')).content, 'new target\n');
});

test('多 hunk 中任一上下文失败时不会执行事务提交', async () => {
  const {
    executeConversationDocumentAction,
    CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME
  } = await loadConversationDocumentToolsModule();
  const store = createInMemoryDocumentStore({
    'a.md': 'old a\n',
    'b.md': 'old b\n'
  });
  let mutationCount = 0;
  const mutateDocuments = store.mutateDocuments.bind(store);
  store.mutateDocuments = async (...args) => {
    mutationCount += 1;
    return mutateDocuments(...args);
  };

  await assert.rejects(
    () => executeConversationDocumentAction(
      CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME,
      {
        patch: [
          '*** Begin Patch',
          '*** Update File: a.md',
          '@@',
          '-old a',
          '+new a',
          '*** Update File: b.md',
          '@@',
          '-missing',
          '+new b',
          '*** End Patch'
        ].join('\n')
      },
      { conversationId: 'conv-atomic', store }
    ),
    /Failed to find expected lines in b\.md/
  );
  assert.equal(mutationCount, 1);
  assert.equal((await store.getDocument('conv-atomic', 'a.md')).content, 'old a\n');
  assert.equal((await store.getDocument('conv-atomic', 'b.md')).content, 'old b\n');
});

test('会话文件 apply_patch 在提交前拒绝同一源路径的多个操作', async () => {
  const {
    executeConversationDocumentAction,
    CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME
  } = await loadConversationDocumentToolsModule();
  const store = createInMemoryDocumentStore({ 'same.md': 'before\n' });
  let mutationCount = 0;
  const mutateDocuments = store.mutateDocuments.bind(store);
  store.mutateDocuments = async (...args) => {
    mutationCount += 1;
    return mutateDocuments(...args);
  };

  await assert.rejects(
    () => executeConversationDocumentAction(
      CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME,
      {
        patch: [
          '*** Begin Patch',
          '*** Add File: same.md',
          '+first',
          '*** Update File: same.md',
          '@@',
          '-before',
          '+second',
          '*** End Patch'
        ].join('\n')
      },
      { conversationId: 'conv-duplicate-source', store }
    ),
    (error) => error?.code === 'APPLY_PATCH_INVALID_PATCH'
      && error?.state_changed === false
      && /multiple operations target same\.md/.test(error?.message || '')
  );
  assert.equal(mutationCount, 1);
  assert.equal((await store.getDocument('conv-duplicate-source', 'same.md')).content, 'before\n');
});

test('会话文件 verifier 不允许 Move 后的目标内容成为同一 patch 后续 Update 的输入', async () => {
  const {
    executeConversationDocumentAction,
    CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME
  } = await loadConversationDocumentToolsModule();
  const store = createInMemoryDocumentStore({
    'a.txt': 'needle\n',
    'b.txt': 'other\n'
  });

  await assert.rejects(
    executeConversationDocumentAction(
      CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME,
      {
        patch: [
          '*** Begin Patch',
          '*** Update File: a.txt',
          '*** Move to: b.txt',
          '@@',
          '-needle',
          '+moved',
          '*** Update File: b.txt',
          '@@',
          '-moved',
          '+dependent',
          '*** End Patch'
        ].join('\n')
      },
      { conversationId: 'conv-snapshot', store }
    ),
    /Failed to find expected lines in b\.txt/
  );
  assert.equal((await store.getDocument('conv-snapshot', 'a.txt')).content, 'needle\n');
  assert.equal((await store.getDocument('conv-snapshot', 'b.txt')).content, 'other\n');
});

test('read_file 返回原始行范围并拒绝越界起始行', async () => {
  const {
    executeConversationDocumentAction,
    CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME
  } = await loadConversationDocumentToolsModule();

  const store = createInMemoryDocumentStore({
    'workspace/spec.md': 'line1\nline2\nline3\nline4\n'
  });

  const result = await executeConversationDocumentAction(
    CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME,
    {
      file_path: 'workspace/spec.md',
      start_line: 2,
      end_line: 3
    },
    {
      conversationId: 'conv-doc-2',
      store
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.file.path, 'workspace/spec.md');
  assert.equal(result.file.content, 'line2\nline3\n');
  assert.equal(result.file.numbered_content, undefined);
  await assert.rejects(
    () => executeConversationDocumentAction(
      CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME,
      { file_path: 'workspace/spec.md', start_line: 99, end_line: 120 },
      { conversationId: 'conv-doc-2', store }
    ),
    /超过文件总行数 4/
  );
});

test('read_file 在统一分页出口前不按字符预算预截断', async () => {
  const {
    executeConversationDocumentAction,
    CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME
  } = await loadConversationDocumentToolsModule();
  const store = createInMemoryDocumentStore({
    'large.txt': 'F'.repeat(70000)
  });

  const result = await executeConversationDocumentAction(
    CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME,
    {
      file_path: 'large.txt',
      start_line: null,
      end_line: null
    },
    {
      conversationId: 'conv-doc-large',
      store
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.file.content_read.max_output_chars, undefined);
  assert.equal(result.file.content.length, 70000);
});

test('search_files 会在当前对话文档里返回上下文命中', async () => {
  const {
    executeConversationDocumentAction,
    CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME
  } = await loadConversationDocumentToolsModule();

  const store = createInMemoryDocumentStore({
    'spec.md': 'alpha\nbeta token\ncharlie\n',
    'todo.txt': 'token again\n'
  });

  const result = await executeConversationDocumentAction(
    CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME,
    {
      pattern: 'token',
      context_lines: 1
    },
    {
      conversationId: 'conv-doc-3',
      store
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.total_matching_lines, 2);
  assert.equal(result.groups[0].file_path, 'spec.md');
  assert.deepEqual(result.groups[0].lines.map((line) => line.text), ['alpha', 'beta token', 'charlie']);

  const manyMatchesStore = createInMemoryDocumentStore({
    'many.txt': `${Array.from({ length: 250 }, (_, index) => `token ${index + 1}`).join('\n')}\n`
  });
  const allMatches = await executeConversationDocumentAction(
    CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME,
    { pattern: 'token' },
    { conversationId: 'conv-doc-many-search-results', store: manyMatchesStore }
  );
  assert.equal(allMatches.total_matching_lines, 250);
  assert.equal(allMatches.groups.length, 1);
  assert.equal(allMatches.groups[0].lines.length, 250);
});

test('write_file 内部 action 会写回内容并产出 change_event', async () => {
  const {
    executeConversationDocumentAction,
    CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION
  } = await loadConversationDocumentToolsModule();

  const store = createInMemoryDocumentStore({});
  const result = await executeConversationDocumentAction(
    CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION,
    {
      file_path: 'new note.md',
      content: 'hello'
    },
    {
      conversationId: 'conv-doc-4',
      store,
      allowInternalActions: true
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.file.path, 'new note.md');
  assert.deepEqual(result.change_event.updated_paths, ['new note.md']);
});

test('copy_file 按 cp 语义新增或覆盖目标，独立 move/delete action 不再执行', async () => {
  const {
    CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME,
    CONVERSATION_DOCUMENT_COPY_FILE_TOOL_NAME,
    executeConversationDocumentAction
  } = await loadConversationDocumentToolsModule();

  const store = createInMemoryDocumentStore({
    'source.md': '# source\n',
    'existing.md': '# existing\n'
  });

  const copied = await executeConversationDocumentAction(
    CONVERSATION_DOCUMENT_COPY_FILE_TOOL_NAME,
    {
      source_path: 'source.md',
      destination_path: 'source-copy.md'
    },
    {
      conversationId: 'conv-doc-5',
      store
    }
  );
  assert.equal(copied.ok, true);
  assert.equal(copied.file.path, 'source-copy.md');
  assert.deepEqual(copied.affected_files.added, ['source-copy.md']);

  await assert.rejects(
    () => executeConversationDocumentAction(
      CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME,
      {
        patch: [
          '*** Begin Patch',
          '*** Update File: local/project/src/a.js',
          '@@',
          '-const token = 1;',
          '+const token = 2;',
          '*** End Patch'
        ].join('\n')
      },
      {
        conversationId: 'conv-doc-5',
        store
      }
    ),
    /不能直接修改 local 映射路径/
  );

  const overwritten = await executeConversationDocumentAction(
    CONVERSATION_DOCUMENT_COPY_FILE_TOOL_NAME,
    {
      source_path: 'source.md',
      destination_path: 'existing.md'
    },
    {
      conversationId: 'conv-doc-5',
      store
    }
  );
  assert.deepEqual(overwritten.affected_files.modified, ['existing.md']);
  assert.equal((await store.getDocument('conv-doc-5', 'existing.md')).content, '# source\n');

  await assert.rejects(
    () => executeConversationDocumentAction(
      'move_file',
      { source_path: 'source.md', destination_path: 'renamed.md' },
      { conversationId: 'conv-doc-5', store }
    ),
    /不支持的 action `move_file`/
  );
  await assert.rejects(
    () => executeConversationDocumentAction(
      'delete_file',
      { file_path: 'source.md' },
      { conversationId: 'conv-doc-5', store }
    ),
    /不支持的 action `delete_file`/
  );
});

test('local mount 路径支持只读 read/list/search，并可复制到会话文件副本', async () => {
  const {
    CONVERSATION_DOCUMENT_COPY_FILE_TOOL_NAME,
    CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME,
    CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME,
    CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME,
    executeConversationDocumentAction
  } = await loadConversationDocumentToolsModule();

  const store = createInMemoryDocumentStore({});
  const localMountStore = createInMemoryLocalMountStore([
    {
      mount_path: 'local/project',
      kind: 'directory',
      source_name: 'project',
      updated_at: '2026-04-13T00:00:00.000Z',
      handle: createLocalDirectoryHandle('project', {
        'README.md': '# Project\n',
        src: {
          'a.js': 'const token = 1;\n'
        }
      })
    }
  ]);

  const readResult = await executeConversationDocumentAction(
    CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME,
    {
      file_path: 'local/project/src/a.js',
      start_line: 1,
      end_line: 1
    },
    {
      conversationId: 'conv-local-1',
      store,
      localMountStore
    }
  );
  assert.equal(readResult.ok, true);
  assert.equal(readResult.source, 'local');
  assert.equal(readResult.file.content, 'const token = 1;\n');

  const listResult = await executeConversationDocumentAction(
    CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME,
    {
      path_glob: 'local/project/**/*.js'
    },
    {
      conversationId: 'conv-local-1',
      store,
      localMountStore
    }
  );
  assert.deepEqual(listResult.files.map((file) => file.path), ['local/project/src/a.js']);

  const searchResult = await executeConversationDocumentAction(
    CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME,
    {
      pattern: 'token',
      path_glob: 'local/project'
    },
    {
      conversationId: 'conv-local-1',
      store,
      localMountStore
    }
  );
  assert.equal(searchResult.source, 'local');
  assert.equal(searchResult.total_matching_lines, 1);
  assert.equal(searchResult.groups[0].file_path, 'local/project/src/a.js');

  const copyResult = await executeConversationDocumentAction(
    CONVERSATION_DOCUMENT_COPY_FILE_TOOL_NAME,
    {
      source_path: 'local/project/src/a.js',
      destination_path: 'project/src/a.js'
    },
    {
      conversationId: 'conv-local-1',
      store,
      localMountStore
    }
  );
  assert.equal(copyResult.ok, true);
  assert.deepEqual(copyResult.affected_files.added, ['project/src/a.js']);
  assert.equal((await store.getDocument('conv-local-1', 'project/src/a.js')).content, 'const token = 1;\n');

  await assert.rejects(
    () => executeConversationDocumentAction(
      CONVERSATION_DOCUMENT_COPY_FILE_TOOL_NAME,
      {
        source_path: 'project/src/a.js',
        destination_path: 'local/project/src/b.js'
      },
      {
        conversationId: 'conv-local-1',
        store,
        localMountStore
      }
    ),
    /本地映射是只读/
  );
});

test('local 目录超过 1000 个文件时完整枚举并由统一 cursor 无重复分页', async () => {
  const {
    CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME,
    executeConversationDocumentAction
  } = await loadConversationDocumentToolsModule();
  const outputModule = await import(pathToFileURL(
    path.resolve(__dirname, '../src/agent_tools/shared/responses_tool_output.js')
  ).href);
  const pageCacheModule = await import(pathToFileURL(
    path.resolve(__dirname, '../src/agent_tools/shared/responses_tool_output_page_cache.js')
  ).href);
  const tree = Object.fromEntries(
    Array.from({ length: 1005 }, (_, index) => [
      `file-${String(index).padStart(4, '0')}.txt`,
      `content-${index}\n`
    ])
  );
  const localMountStore = createInMemoryLocalMountStore([{
    mount_path: 'local/many',
    kind: 'directory',
    source_name: 'many',
    updated_at: '2026-04-13T00:00:00.000Z',
    handle: createLocalDirectoryHandle('many', tree)
  }]);

  const unfiltered = await executeConversationDocumentAction(
    CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME,
    { path_glob: null },
    {
      conversationId: 'conv-local-many',
      store: createInMemoryDocumentStore({}),
      localMountStore: {
        async listMounts() {
          throw new Error('无过滤 list_files 不应扫描 local 挂载');
        }
      }
    }
  );
  assert.equal(unfiltered.total_files, 0);

  const result = await executeConversationDocumentAction(
    CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME,
    { path_glob: 'local/many' },
    {
      conversationId: 'conv-local-many',
      store: createInMemoryDocumentStore({}),
      localMountStore
    }
  );
  assert.equal(result.total_files, 1005);
  assert.equal(result.files.at(-1).path, 'local/many/file-1004.txt');

  const contentItems = outputModule.buildResponsesConversationDocumentToolOutputContentItems(
    'list_files',
    result
  );
  const sourceText = contentItems
    .filter((item) => item?.type === 'input_text')
    .map((item) => item.text || '')
    .join('');
  const cache = pageCacheModule.createResponsesToolOutputPageCache({
    createCursor: (() => {
      let index = 0;
      return () => `local-page-${index += 1}`;
    })()
  });
  let page = cache.paginate(contentItems, 5000);
  let reconstructed = '';
  while (page) {
    const pageText = page.contentItems
      .filter((item) => item?.type === 'input_text')
      .map((item) => item.text || '')
      .join('');
    const contentMatch = pageText.match(/<content>\n([\s\S]*?)\n<\/content>/);
    reconstructed += contentMatch ? contentMatch[1] : pageText;
    if (!page.nextCursor) break;
    page = cache.read(page.nextCursor, null);
  }

  assert.equal(reconstructed, sourceText);
  assert.equal((reconstructed.match(/local\/many\/file-0000\.txt/g) || []).length, 1);
  assert.equal((reconstructed.match(/local\/many\/file-1004\.txt/g) || []).length, 1);
});
