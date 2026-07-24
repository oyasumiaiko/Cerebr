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

test('normalizeConversationDocumentPath 支持空格与 Unicode，并拒绝越界路径', async () => {
  const {
    normalizeConversationDocumentHrefPath,
    normalizeConversationDocumentPath
  } = await loadConversationDocumentToolsModule();

  assert.equal(
    normalizeConversationDocumentPath('workspace\\研究 计划(终版).md'),
    '研究 计划(终版).md'
  );
  assert.equal(
    normalizeConversationDocumentHrefPath('workspace/%E9%9A%8F%E7%AC%94%20%E7%BB%88%E7%89%88.md'),
    '随笔 终版.md'
  );
  assert.equal(
    normalizeConversationDocumentHrefPath('workspace/a%2Fb.md'),
    'a%2Fb.md'
  );
  assert.throws(
    () => normalizeConversationDocumentPath('../secret.txt'),
    /不能包含空段、"\." 或 "\.\."/
  );
});

test('normalizeVirtualFileToolArguments 会对 skill target 做结构化校验并默认会话文件目标', async () => {
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
      kind: 'workspace',
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
      kind: 'workspace',
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
    ignore_case: true,
    limit: 10
  });
  assert.deepEqual(bashStyleSearch, {
    action: 'search_files',
    target: {
      kind: 'workspace',
      name: null
    },
    pattern: 'token',
    regex: false,
    case_mode: 'insensitive',
    path_glob: '**/*.md',
    context_before: 2,
    context_after: 2,
    max_results: 10
  });

  const copyFile = normalizeVirtualFileToolArguments(VIRTUAL_FILE_COPY_FILE_TOOL_NAME, {
    from: 'spec.md',
    to: 'spec.md'
  });
  assert.deepEqual(copyFile, {
    action: 'copy_file',
    target: {
      kind: 'workspace',
      name: null
    },
    source_path: 'spec.md',
    destination_path: 'spec.md'
  });

  const moveSkillFile = normalizeVirtualFileToolArguments(VIRTUAL_FILE_MOVE_FILE_TOOL_NAME, {
    target: {
      kind: 'skill',
      name: 'dom-probe'
    },
    from: 'references/old.md',
    to: 'references/new.md'
  });
  assert.equal(moveSkillFile.target.kind, 'skill');
  assert.equal(moveSkillFile.target.name, 'dom-probe');
  assert.equal(moveSkillFile.source_path, 'references/old.md');
  assert.equal(moveSkillFile.destination_path, 'references/new.md');

  const deleteFile = normalizeVirtualFileToolArguments(VIRTUAL_FILE_DELETE_FILE_TOOL_NAME, {
    path: 'spec.md'
  });
  assert.equal(deleteFile.action, 'delete_file');
  assert.equal(deleteFile.file_path, 'spec.md');

  const legacyWorkspacePrefixRead = normalizeVirtualFileToolArguments(VIRTUAL_FILE_READ_FILE_TOOL_NAME, {
    path: 'workspace/spec.md'
  });
  assert.equal(legacyWorkspacePrefixRead.file_path, 'spec.md');

  const legacyWorkspacePrefixSearch = normalizeVirtualFileToolArguments(VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME, {
    pattern: 'token',
    glob: 'workspace/**/*.md'
  });
  assert.equal(legacyWorkspacePrefixSearch.path_glob, '**/*.md');
});

test('apply_patch 工具定义聚焦虚拟文件补丁契约，不重复最终交付策略', async () => {
  const {
    buildVirtualFileApplyPatchFunctionToolDefinition
  } = await loadConversationDocumentToolsModule();

  const applyPatchDefinition = buildVirtualFileApplyPatchFunctionToolDefinition();
  assert.equal(applyPatchDefinition.strict, true);
  assert.match(applyPatchDefinition.description, /虚拟文本文件/);
  assert.match(applyPatchDefinition.description, /HTML/);
  assert.match(applyPatchDefinition.description, /A\/M\/D/);
  assert.doesNotMatch(applyPatchDefinition.description, /preview\.html/);
  assert.doesNotMatch(applyPatchDefinition.description, /最终回复/);
  assert.deepEqual(applyPatchDefinition.parameters.required, ['target', 'patch', 'max_output_chars']);
  assert.doesNotMatch(applyPatchDefinition.description, /workspace\//);
});

test('read_file/search_files 与文件操作工具定义暴露严格且低歧义的参数', async () => {
  const {
    buildVirtualFileCopyFileFunctionToolDefinition,
    buildVirtualFileDeleteFileFunctionToolDefinition,
    buildVirtualFileMoveFileFunctionToolDefinition,
    buildVirtualFileReadFileFunctionToolDefinition,
    buildVirtualFileSearchFilesFunctionToolDefinition
  } = await loadConversationDocumentToolsModule();

  const readDefinition = buildVirtualFileReadFileFunctionToolDefinition();
  assert.equal(readDefinition.strict, true);
  assert.match(readDefinition.description, /全文预览、字符片段或指定行范围/);
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
  assert.deepEqual(searchDefinition.parameters.required, ['target', 'pattern', 'regex', 'glob', 'ignore_case', 'context', 'before', 'after', 'limit', 'max_output_chars']);

  const copyDefinition = buildVirtualFileCopyFileFunctionToolDefinition();
  assert.match(copyDefinition.description, /cp from to/);
  assert.ok(copyDefinition.parameters.properties.from);
  assert.ok(copyDefinition.parameters.properties.to);
  assert.deepEqual(copyDefinition.parameters.required, ['target', 'from', 'to', 'max_output_chars']);

  const moveDefinition = buildVirtualFileMoveFileFunctionToolDefinition();
  assert.match(moveDefinition.description, /mv from to/);
  assert.deepEqual(moveDefinition.parameters.required, ['target', 'from', 'to', 'max_output_chars']);

  const deleteDefinition = buildVirtualFileDeleteFileFunctionToolDefinition();
  assert.match(deleteDefinition.description, /rm path/);
  assert.deepEqual(deleteDefinition.parameters.required, ['target', 'path', 'max_output_chars']);
});

test('apply_patch 遇到同名 Add File 时会按 Windows 语义追加 (2)', async () => {
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
        '*** Add File: workspace/计划.md',
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
  assert.deepEqual(result.affected_files.added, ['计划 (2).md']);
  assert.deepEqual(result.renamed_targets, [{
    requested_path: '计划.md',
    final_path: '计划 (2).md',
    reason: 'collision'
  }]);
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
  assert.equal(result.file.path, 'spec.md');
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

test('copy_file/move_file/delete_file 会显式管理对话虚拟文件且不覆盖目标', async () => {
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

  await assert.rejects(
    () => executeConversationDocumentAction(
      CONVERSATION_DOCUMENT_COPY_FILE_TOOL_NAME,
      {
        source_path: 'source.md',
        destination_path: 'existing.md'
      },
      {
        conversationId: 'conv-doc-5',
        store
      }
    ),
    /目标文件 existing\.md 已存在/
  );

  const moved = await executeConversationDocumentAction(
    CONVERSATION_DOCUMENT_MOVE_FILE_TOOL_NAME,
    {
      source_path: 'source.md',
      destination_path: 'renamed.md'
    },
    {
      conversationId: 'conv-doc-5',
      store
    }
  );
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.affected_files.modified, ['renamed.md']);
  assert.deepEqual(moved.affected_files.deleted, ['source.md']);
  assert.deepEqual(moved.change_event.deleted_paths, ['source.md']);

  const deleted = await executeConversationDocumentAction(
    CONVERSATION_DOCUMENT_DELETE_FILE_TOOL_NAME,
    {
      file_path: 'renamed.md'
    },
    {
      conversationId: 'conv-doc-5',
      store
    }
  );
  assert.equal(deleted.ok, true);
  assert.deepEqual(deleted.affected_files.deleted, ['renamed.md']);
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
