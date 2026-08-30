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

test('normalizeVirtualFileToolArguments 默认使用根目录且 target object 只接受 skill', async () => {
  const {
    VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
    VIRTUAL_FILE_COPY_FILE_TOOL_NAME,
    VIRTUAL_FILE_DELETE_FILE_TOOL_NAME,
    VIRTUAL_FILE_LIST_FILES_TOOL_NAME,
    VIRTUAL_FILE_MOVE_FILE_TOOL_NAME,
    VIRTUAL_FILE_READ_FILE_TOOL_NAME,
    VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME,
    normalizeVirtualFileToolArguments
  } = await loadConversationDocumentToolsModule();

  const defaultDocumentTarget = normalizeVirtualFileToolArguments(VIRTUAL_FILE_LIST_FILES_TOOL_NAME, {});
  assert.deepEqual(defaultDocumentTarget, {
    action: 'list_files',
    target: {
      kind: 'root',
      name: null
    },
    path_glob: null
  });

  const skillPatchTarget = normalizeVirtualFileToolArguments(VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME, {
    target: {
      kind: 'skill',
      name: 'dom-probe'
    },
    patch: '*** Begin Patch\n*** Add File: notes.md\n+hello\n*** End Patch'
  });
  assert.equal(skillPatchTarget.target.kind, 'skill');
  assert.equal(skillPatchTarget.target.name, 'dom-probe');

  assert.throws(
    () => normalizeVirtualFileToolArguments(VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME, {
      target: { kind: 'skill' },
      patch: '*** Begin Patch\n*** Add File: notes.md\n+hello\n*** End Patch'
    }),
    /target.kind=skill 时 target.name 不能为空/
  );

  const bashStyleRead = normalizeVirtualFileToolArguments(VIRTUAL_FILE_READ_FILE_TOOL_NAME, {
    path: 'spec.md',
    line_range: '20,40p',
    numbered: true
  });
  assert.deepEqual(bashStyleRead, {
    action: 'read_file',
    target: {
      kind: 'root',
      name: null
    },
    file_path: 'spec.md',
    include_line_numbers: true,
    read_options: {
      start_line: 20,
      end_line: 40
    }
  });

  const bashStyleSearch = normalizeVirtualFileToolArguments(VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME, {
    pattern: 'token',
    glob: '**/*.md',
    context: 2,
    ignore_case: true
  });
  assert.deepEqual(bashStyleSearch, {
    action: 'search_files',
    target: {
      kind: 'root',
      name: null
    },
    pattern: 'token',
    regex: false,
    case_mode: 'insensitive',
    path_glob: '**/*.md',
    context_before: 2,
    context_after: 2,
    max_results: null
  });

  const copyFile = normalizeVirtualFileToolArguments(VIRTUAL_FILE_COPY_FILE_TOOL_NAME, {
    from: 'spec.md',
    to: 'spec.md'
  });
  assert.deepEqual(copyFile, {
    action: 'copy_file',
    target: {
      kind: 'root',
      name: null
    },
    source_path: 'spec.md',
    destination_path: 'spec.md'
  });

  assert.throws(
    () => normalizeVirtualFileToolArguments(VIRTUAL_FILE_MOVE_FILE_TOOL_NAME, {
      from: 'references/old.md',
      to: 'references/new.md'
    }),
    /不支持的 action `move_file`/
  );
  assert.throws(
    () => normalizeVirtualFileToolArguments(VIRTUAL_FILE_DELETE_FILE_TOOL_NAME, {
      path: 'spec.md'
    }),
    /不支持的 action `delete_file`/
  );

  const ordinaryWorkspaceDirectoryRead = normalizeVirtualFileToolArguments(VIRTUAL_FILE_READ_FILE_TOOL_NAME, {
    path: 'workspace/spec.md'
  });
  assert.equal(ordinaryWorkspaceDirectoryRead.file_path, 'workspace/spec.md');

  const ordinaryWorkspaceDirectorySearch = normalizeVirtualFileToolArguments(VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME, {
    pattern: 'token',
    glob: 'workspace/**/*.md'
  });
  assert.equal(ordinaryWorkspaceDirectorySearch.path_glob, 'workspace/**/*.md');
  assert.throws(
    () => normalizeVirtualFileToolArguments(VIRTUAL_FILE_LIST_FILES_TOOL_NAME, {
      target: { kind: 'workspace', name: null }
    }),
    /不支持的 target.kind `workspace`/
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

test('read_file/search_files 与文件操作工具定义暴露严格且低歧义的参数', async () => {
  const {
    buildVirtualFileCopyFileFunctionToolDefinition,
    buildVirtualFileReadFileFunctionToolDefinition,
    buildVirtualFileSearchFilesFunctionToolDefinition
  } = await loadConversationDocumentToolsModule();

  const readDefinition = buildVirtualFileReadFileFunctionToolDefinition();
  assert.equal(readDefinition.strict, true);
  assert.match(readDefinition.description, /全文或指定行范围/);
  assert.doesNotMatch(readDefinition.description, /字符片段/);
  assert.match(readDefinition.description, /# path/);
  assert.ok(readDefinition.parameters.properties.path);
  assert.ok(readDefinition.parameters.properties.line_range);
  assert.ok(readDefinition.parameters.properties.numbered);
  assert.deepEqual(readDefinition.parameters.required, ['target', 'path', 'line_range', 'numbered', 'max_output_chars']);
  assert.equal(readDefinition.parameters.properties.max_chars, undefined);
  assert.equal(readDefinition.parameters.properties.file_path, undefined);
  assert.equal(readDefinition.parameters.properties.start_line, undefined);
  assert.equal(readDefinition.parameters.properties.include_line_numbers, undefined);

  const searchDefinition = buildVirtualFileSearchFilesFunctionToolDefinition();
  assert.equal(searchDefinition.strict, true);
  assert.match(searchDefinition.description, /rg --heading --line-number --column/);
  assert.match(searchDefinition.description, /smart-case/);
  assert.ok(searchDefinition.parameters.properties.glob);
  assert.ok(searchDefinition.parameters.properties.before);
  assert.ok(searchDefinition.parameters.properties.after);
  assert.ok(searchDefinition.parameters.properties.ignore_case);
  assert.equal(searchDefinition.parameters.properties.path_glob, undefined);
  assert.equal(searchDefinition.parameters.properties.case_mode, undefined);
  assert.equal(searchDefinition.parameters.properties.max_results, undefined);
  assert.equal(searchDefinition.parameters.properties.limit, undefined);
  assert.deepEqual(searchDefinition.parameters.required, ['target', 'pattern', 'regex', 'glob', 'ignore_case', 'context', 'before', 'after', 'max_output_chars']);

  const copyDefinition = buildVirtualFileCopyFileFunctionToolDefinition();
  assert.match(copyDefinition.description, /cp -- from to/);
  assert.match(copyDefinition.description, /Move to:/);
  assert.match(copyDefinition.description, /Delete File:/);
  assert.ok(copyDefinition.parameters.properties.from);
  assert.ok(copyDefinition.parameters.properties.to);
  assert.deepEqual(copyDefinition.parameters.required, ['target', 'from', 'to', 'max_output_chars']);
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

test('多 hunk 中任一上下文失败时不会执行 replaceDocuments', async () => {
  const {
    executeConversationDocumentAction,
    CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME
  } = await loadConversationDocumentToolsModule();
  const store = createInMemoryDocumentStore({
    'a.md': 'old a\n',
    'b.md': 'old b\n'
  });
  let replaceCount = 0;
  const replaceDocuments = store.replaceDocuments.bind(store);
  store.replaceDocuments = async (...args) => {
    replaceCount += 1;
    return replaceDocuments(...args);
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
  assert.equal(replaceCount, 0);
  assert.equal((await store.getDocument('conv-atomic', 'a.md')).content, 'old a\n');
  assert.equal((await store.getDocument('conv-atomic', 'b.md')).content, 'old b\n');
});

test('会话文件 apply_patch 在提交前拒绝同一源路径的多个操作', async () => {
  const {
    executeConversationDocumentAction,
    CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME
  } = await loadConversationDocumentToolsModule();
  const store = createInMemoryDocumentStore({ 'same.md': 'before\n' });
  let replaceCount = 0;
  const replaceDocuments = store.replaceDocuments.bind(store);
  store.replaceDocuments = async (...args) => {
    replaceCount += 1;
    return replaceDocuments(...args);
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
  assert.equal(replaceCount, 0);
  assert.equal((await store.getDocument('conv-duplicate-source', 'same.md')).content, 'before\n');
});

test('read_file 支持行范围与带行号输出', async () => {
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
      end_line: 3,
      include_line_numbers: true
    },
    {
      conversationId: 'conv-doc-2',
      store
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.file.path, 'workspace/spec.md');
  assert.equal(result.file.content, 'line2\nline3\n');
  assert.match(result.file.numbered_content, /2 \| line2/);
  assert.match(result.file.numbered_content, /3 \| line3/);
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
      max_output_chars: 100
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
      context_before: 1,
      context_after: 1
    },
    {
      conversationId: 'conv-doc-3',
      store
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.total_matches, 2);
  assert.equal(result.matches[0].file_path, 'spec.md');
  assert.equal(result.matches[0].before[0].text, 'alpha');

  const manyMatchesStore = createInMemoryDocumentStore({
    'many.txt': `${Array.from({ length: 250 }, (_, index) => `token ${index + 1}`).join('\n')}\n`
  });
  const allMatches = await executeConversationDocumentAction(
    CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME,
    { pattern: 'token' },
    { conversationId: 'conv-doc-many-search-results', store: manyMatchesStore }
  );
  assert.equal(allMatches.total_matches, 250);
  assert.equal(allMatches.returned_match_count, 250);
  assert.equal(allMatches.truncated, false);
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
    CONVERSATION_DOCUMENT_DELETE_FILE_TOOL_NAME,
    CONVERSATION_DOCUMENT_MOVE_FILE_TOOL_NAME,
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
      CONVERSATION_DOCUMENT_MOVE_FILE_TOOL_NAME,
      { source_path: 'source.md', destination_path: 'renamed.md' },
      { conversationId: 'conv-doc-5', store }
    ),
    /不支持的 action `move_file`/
  );
  await assert.rejects(
    () => executeConversationDocumentAction(
      CONVERSATION_DOCUMENT_DELETE_FILE_TOOL_NAME,
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
      end_line: 1,
      include_line_numbers: true
    },
    {
      conversationId: 'conv-local-1',
      store,
      localMountStore
    }
  );
  assert.equal(readResult.ok, true);
  assert.equal(readResult.target.kind, 'local');
  assert.match(readResult.file.numbered_content, /1 \| const token = 1;/);

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
  assert.equal(searchResult.target.kind, 'local');
  assert.equal(searchResult.returned_match_count, 1);
  assert.equal(searchResult.matches[0].file_path, 'local/project/src/a.js');

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
