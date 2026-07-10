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

test('官方 apply_patch_call update_file 会直接读取 operation 并汇总 V4A diff', async () => {
  const {
    buildVirtualFileSummaryParts,
    buildVirtualFilePrimaryText,
    getVirtualFileToolTypeLabel,
    isVirtualFileToolCall
  } = await loadModule();

  const record = {
    type: 'apply_patch_call',
    call_id: 'call_patch_update',
    status: 'completed',
    operation: {
      type: 'update_file',
      path: 'docs/readme.md',
      diff: [
        '@@ Introduction',
        ' Introduction',
        '-old text',
        '+new text'
      ].join('\n')
    }
  };

  assert.equal(isVirtualFileToolCall(record), true);
  assert.equal(getVirtualFileToolTypeLabel(record), '文件');
  assert.deepEqual(buildVirtualFileSummaryParts(record), {
    action: '修改',
    value: 'docs/readme.md',
    valueUrl: '',
    meta: '+1 · -1',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
  assert.equal(buildVirtualFilePrimaryText(record), '修改 docs/readme.md +1 · -1');
});

test('官方 apply_patch_call create_file 会解析 @skill 路径并显示新增摘要', async () => {
  const {
    buildVirtualFileSummaryParts,
    buildVirtualFilePrimaryText
  } = await loadModule();

  const record = {
    type: 'apply_patch_call',
    call_id: 'call_patch_create',
    status: 'in_progress',
    operation: {
      type: 'create_file',
      path: '@skill/dom-probe/references/notes.md',
      diff: ['+# Notes', '+', '+body'].join('\n')
    }
  };

  assert.deepEqual(buildVirtualFileSummaryParts(record, { isInProgress: true }), {
    action: '正在新增',
    value: 'references/notes.md',
    valueUrl: '',
    meta: 'dom-probe · +3',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
  assert.equal(buildVirtualFilePrimaryText(record), '新增 references/notes.md dom-probe · +3');
});

test('官方 apply_patch_call delete_file 与旧 function_call delete_file 都保留删除摘要', async () => {
  const {
    buildVirtualFileSummaryParts,
    buildVirtualFilePrimaryText
  } = await loadModule();

  const officialRecord = {
    type: 'apply_patch_call',
    call_id: 'call_patch_delete',
    status: 'completed',
    operation: {
      type: 'delete_file',
      path: 'docs/obsolete.md'
    }
  };
  assert.deepEqual(buildVirtualFileSummaryParts(officialRecord), {
    action: '删除',
    value: 'docs/obsolete.md',
    valueUrl: '',
    meta: '',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
  assert.equal(buildVirtualFilePrimaryText(officialRecord), '删除 docs/obsolete.md');

  const legacyRecord = {
    type: 'function_call',
    name: 'delete_file',
    arguments: JSON.stringify({ path: 'workspace/docs/legacy.md' })
  };
  assert.equal(buildVirtualFilePrimaryText(legacyRecord), '删除 docs/legacy.md');
});
