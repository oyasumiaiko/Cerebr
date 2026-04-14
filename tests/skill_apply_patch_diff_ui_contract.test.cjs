const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('response activity 会为顶层 apply_patch 渲染虚拟文件 diff 预览', async () => {
  const messageProcessorSource = await readWorkspaceFile('src/core/message_processor.js');
  const sidebarCssSource = await readWorkspaceFile('src/ui/styles/sidebar.css');

  assert.match(messageProcessorSource, /buildVirtualFileApplyPatchPreview/);
  assert.match(messageProcessorSource, /renderResponseActivitySkillApplyPatchPreview/);
  assert.match(messageProcessorSource, /response-activity-tool-diff-preview/);
  assert.match(messageProcessorSource, /response-activity-tool-diff-line is-/);

  assert.match(sidebarCssSource, /\.message \.response-activity-tool-diff-preview/);
  assert.match(sidebarCssSource, /\.message \.response-activity-tool-diff-file-header/);
  assert.match(sidebarCssSource, /\.message \.response-activity-tool-diff-line\.is-add/);
  assert.match(sidebarCssSource, /\.message \.response-activity-tool-diff-line\.is-delete/);
});
