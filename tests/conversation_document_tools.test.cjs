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

test('normalizeConversationDocumentPath 支持空格与 Unicode，并拒绝越界路径', async () => {
  const { normalizeConversationDocumentPath } = await loadConversationDocumentToolsModule();

  assert.equal(
    normalizeConversationDocumentPath('docs\\研究 计划(终版).md'),
    'docs/研究 计划(终版).md'
  );
  assert.throws(
    () => normalizeConversationDocumentPath('../secret.txt'),
    /不能包含空段、"\." 或 "\.\."/
  );
});

test('normalizeVirtualFileToolArguments 会对 skill target 做结构化校验并默认 conversation_document', async () => {
  const {
    VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
    VIRTUAL_FILE_LIST_FILES_TOOL_NAME,
    normalizeVirtualFileToolArguments
  } = await loadConversationDocumentToolsModule();

  const defaultDocumentTarget = normalizeVirtualFileToolArguments(VIRTUAL_FILE_LIST_FILES_TOOL_NAME, {});
  assert.deepEqual(defaultDocumentTarget, {
    action: 'list_files',
    target: {
      kind: 'conversation_document',
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
});

test('apply_patch 遇到同名 Add File 时会按 Windows 语义追加 (2)', async () => {
  const {
    executeConversationDocumentAction,
    CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME
  } = await loadConversationDocumentToolsModule();

  const store = createInMemoryDocumentStore({
    'docs/计划.md': '# old\n'
  });

  const result = await executeConversationDocumentAction(
    CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME,
    {
      patch: [
        '*** Begin Patch',
        '*** Add File: docs/计划.md',
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
  assert.deepEqual(result.affected_files.added, ['docs/计划 (2).md']);
  assert.deepEqual(result.renamed_targets, [{
    requested_path: 'docs/计划.md',
    final_path: 'docs/计划 (2).md',
    reason: 'collision'
  }]);
});

test('read_file 支持行范围与带行号输出', async () => {
  const {
    executeConversationDocumentAction,
    CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME
  } = await loadConversationDocumentToolsModule();

  const store = createInMemoryDocumentStore({
    'docs/spec.md': 'line1\nline2\nline3\nline4\n'
  });

  const result = await executeConversationDocumentAction(
    CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME,
    {
      file_path: 'docs/spec.md',
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
  assert.equal(result.file.content, 'line2\nline3\n');
  assert.match(result.file.numbered_content, /2 \| line2/);
  assert.match(result.file.numbered_content, /3 \| line3/);
});

test('search_files 会在当前对话文档里返回上下文命中', async () => {
  const {
    executeConversationDocumentAction,
    CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME
  } = await loadConversationDocumentToolsModule();

  const store = createInMemoryDocumentStore({
    'docs/spec.md': 'alpha\nbeta token\ncharlie\n',
    'notes/todo.txt': 'token again\n'
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
      file_path: 'docs/new note.md',
      content: 'hello'
    },
    {
      conversationId: 'conv-doc-4',
      store,
      allowInternalActions: true
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.file.path, 'docs/new note.md');
  assert.deepEqual(result.change_event.updated_paths, ['docs/new note.md']);
});
