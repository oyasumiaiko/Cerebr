const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadModule() {
  const modulePath = path.resolve(__dirname, '../src/utils/conversation_document_tool_summary.js');
  return import(pathToFileURL(modulePath).href);
}

test('顶层 read_file 在 skill target 下会显示文件前缀与简短摘要', async () => {
  const {
    buildVirtualFileSummaryParts,
    buildVirtualFilePrimaryText,
    getVirtualFileToolTypeLabel
  } = await loadModule();

  const record = {
    type: 'function_call',
    name: 'read_file',
    arguments: JSON.stringify({
      target: {
        kind: 'skill',
        name: 'dom-probe'
      },
      path: 'src/helpers/dom.js'
    })
  };

  const parts = buildVirtualFileSummaryParts(record);
  assert.deepEqual(parts, {
    action: '读取',
    value: 'src/helpers/dom.js',
    valueUrl: '',
    meta: 'dom-probe',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
  assert.equal(buildVirtualFilePrimaryText(record), '读取 src/helpers/dom.js dom-probe');
  assert.equal(getVirtualFileToolTypeLabel(record), '文件');
});

test('顶层 read_file 在按行范围读取时会把 Lx-Ly 追加到文件路径摘要', async () => {
  const {
    buildVirtualFileSummaryParts,
    buildVirtualFilePrimaryText
  } = await loadModule();

  const record = {
    type: 'function_call',
    name: 'read_file',
    arguments: JSON.stringify({
      target: {
        kind: 'skill',
        name: 'worldquant-brain-knowledge-cache'
      },
      path: 'src/cache.js',
      line_range: '1:260',
      numbered: true
    })
  };

  const parts = buildVirtualFileSummaryParts(record);
  assert.deepEqual(parts, {
    action: '读取',
    value: 'src/cache.js L1-L260',
    valueUrl: '',
    meta: 'worldquant-brain-knowledge-cache',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
  assert.equal(
    buildVirtualFilePrimaryText(record),
    '读取 src/cache.js L1-L260 worldquant-brain-knowledge-cache'
  );
});

test('顶层 read_file/search_files 摘要支持 bash 风格参数', async () => {
  const {
    buildVirtualFileSummaryParts,
    buildVirtualFilePrimaryText
  } = await loadModule();

  const readRecord = {
    type: 'function_call',
    name: 'read_file',
    arguments: JSON.stringify({
      target: {
        kind: 'skill',
        name: 'dom-probe'
      },
      path: 'src/main.js',
      line_range: '20,40p',
      numbered: true
    })
  };
  assert.deepEqual(buildVirtualFileSummaryParts(readRecord), {
    action: '读取',
    value: 'src/main.js L20-L40',
    valueUrl: '',
    meta: 'dom-probe',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
  assert.equal(buildVirtualFilePrimaryText(readRecord), '读取 src/main.js L20-L40 dom-probe');

  const searchRecord = {
    type: 'function_call',
    name: 'search_files',
    arguments: JSON.stringify({
      target: {
        kind: 'skill',
        name: 'dom-probe'
      },
      pattern: 'token',
      glob: 'src/**/*.js',
      before: 1,
      after: 1
    })
  };
  assert.deepEqual(buildVirtualFileSummaryParts(searchRecord), {
    action: '搜索',
    value: 'token',
    valueUrl: '',
    meta: 'dom-probe · src/**/*.js',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
});

test('顶层 copy_file/move_file/delete_file 摘要使用 shell 风格动词', async () => {
  const {
    buildVirtualFileSummaryParts,
    buildVirtualFilePrimaryText
  } = await loadModule();

  const copyRecord = {
    type: 'function_call',
    name: 'copy_file',
    arguments: JSON.stringify({
      from: 'local/project/src/a.js',
      to: 'project/src/a.js'
    })
  };
  assert.deepEqual(buildVirtualFileSummaryParts(copyRecord), {
    action: '复制',
    value: 'local/project/src/a.js -> project/src/a.js',
    valueUrl: '',
    meta: '',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
  assert.equal(
    buildVirtualFilePrimaryText(copyRecord),
    '复制 local/project/src/a.js -> project/src/a.js'
  );

  const moveRecord = {
    type: 'function_call',
    name: 'move_file',
    arguments: JSON.stringify({
      target: {
        kind: 'skill',
        name: 'dom-probe'
      },
      from: 'references/old.md',
      to: 'references/new.md'
    })
  };
  assert.equal(buildVirtualFilePrimaryText(moveRecord), '移动 references/old.md -> references/new.md dom-probe');

  const deleteRecord = {
    type: 'function_call',
    name: 'delete_file',
    arguments: JSON.stringify({
      path: 'workspace/project/src/a.js'
    })
  };
  assert.equal(buildVirtualFilePrimaryText(deleteRecord), '删除 project/src/a.js');
});

test('顶层 apply_patch 在 skill target 下会显示首个文件与 diff 汇总', async () => {
  const {
    buildVirtualFileSummaryParts,
    buildVirtualFilePrimaryText
  } = await loadModule();

  const record = {
    type: 'function_call',
    name: 'apply_patch',
    arguments: JSON.stringify({
      target: {
        kind: 'skill',
        name: 'dom-probe'
      },
      patch: [
        '*** Begin Patch',
        '*** Update File: src/main.js',
        '@@',
        ' old',
        '+new',
        '-old',
        '*** Add File: references/notes.md',
        '+hello',
        '*** End Patch'
      ].join('\n')
    })
  };

  const parts = buildVirtualFileSummaryParts(record);
  assert.deepEqual(parts, {
    action: '修改',
    value: 'src/main.js',
    valueUrl: '',
    meta: 'dom-probe · +2 · -1 · 另 1 个文件',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
  assert.equal(buildVirtualFilePrimaryText(record), '修改 src/main.js dom-probe · +2 · -1 · 另 1 个文件');
});

test('会话文档 apply_patch 成功后可提取自动预览卡片描述', async () => {
  const {
    buildConversationDocumentApplyPatchPreviewDescriptors
  } = await loadModule();

  const record = {
    type: 'function_call',
    name: 'apply_patch',
    output: [
      {
        type: 'input_text',
        text: 'Success. Updated the following files:\nM workspace/src/a.md\nA src/b.md\nD src/old.md'
      }
    ],
    arguments: JSON.stringify({
      patch: [
        '*** Begin Patch',
        '*** Update File: workspace/src/a.md',
        '@@',
        ' old',
        '-old',
        '+new',
        '*** Add File: src/b.md',
        '+hello',
        '*** Delete File: src/old.md',
        '*** End Patch'
      ].join('\n')
    })
  };

  assert.deepEqual(
    buildConversationDocumentApplyPatchPreviewDescriptors(record, { requireSuccessfulOutput: true }),
    [
      { path: 'src/a.md', title: 'src/a.md', operation: 'update' },
      { path: 'src/b.md', title: 'src/b.md', operation: 'add' }
    ]
  );
});

test('会话文档 apply_patch 自动预览会跳过失败输出和 skill target', async () => {
  const {
    buildConversationDocumentApplyPatchPreviewDescriptors
  } = await loadModule();

  const patch = [
    '*** Begin Patch',
    '*** Update File: src/main.js',
    '@@',
    ' old',
    '+new',
    '*** End Patch'
  ].join('\n');

  assert.deepEqual(
    buildConversationDocumentApplyPatchPreviewDescriptors({
      type: 'function_call',
      name: 'apply_patch',
      output: [{ type: 'input_text', text: 'Error: patch failed' }],
      arguments: JSON.stringify({ patch })
    }, { requireSuccessfulOutput: true }),
    []
  );

  assert.deepEqual(
    buildConversationDocumentApplyPatchPreviewDescriptors({
      type: 'function_call',
      name: 'apply_patch',
      output: [{ type: 'input_text', text: 'Success. Updated the following files:\nM src/main.js' }],
      arguments: JSON.stringify({
        target: { kind: 'skill', name: 'dom-probe' },
        patch
      })
    }, { requireSuccessfulOutput: true }),
    []
  );
});

test('会话文档 apply_patch 自动预览对 Move 使用新路径', async () => {
  const {
    buildConversationDocumentApplyPatchPreviewDescriptors
  } = await loadModule();

  const record = {
    type: 'function_call',
    name: 'apply_patch',
    output: [{ type: 'input_text', text: 'Success. Updated the following files:\nM dst/new.md' }],
    arguments: JSON.stringify({
      patch: [
        '*** Begin Patch',
        '*** Update File: src/old.md',
        '*** Move to: dst/new.md',
        '@@',
        ' old',
        '+new',
        '*** End Patch'
      ].join('\n')
    })
  };

  assert.deepEqual(
    buildConversationDocumentApplyPatchPreviewDescriptors(record, { requireSuccessfulOutput: true }),
    [
      { path: 'dst/new.md', title: 'dst/new.md', operation: 'move' }
    ]
  );
});
