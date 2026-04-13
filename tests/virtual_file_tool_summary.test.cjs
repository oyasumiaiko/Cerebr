const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadModule() {
  const modulePath = path.resolve(__dirname, '../src/utils/conversation_document_tool_summary.js');
  return import(pathToFileURL(modulePath).href);
}

test('顶层 read_file 在 skill target 下会显示技能文件摘要', async () => {
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
      file_path: 'src/helpers/dom.js'
    })
  };

  const parts = buildVirtualFileSummaryParts(record);
  assert.deepEqual(parts, {
    action: '读取文件',
    value: 'src/helpers/dom.js',
    valueUrl: '',
    meta: 'dom-probe',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
  assert.equal(buildVirtualFilePrimaryText(record), '读取文件 src/helpers/dom.js dom-probe');
  assert.equal(getVirtualFileToolTypeLabel(record), '技能文件');
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
    action: '修改了',
    value: 'src/main.js',
    valueUrl: '',
    meta: 'dom-probe · +2 · -1 · 另 1 个文件',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
  assert.equal(buildVirtualFilePrimaryText(record), '修改了 src/main.js dom-probe · +2 · -1 · 另 1 个文件');
});
