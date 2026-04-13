const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('response activity 已接入顶层虚拟文件摘要与 meta 样式', async () => {
  const messageProcessorSource = await readWorkspaceFile('src/core/message_processor.js');
  const sidebarCssSource = await readWorkspaceFile('src/ui/styles/sidebar.css');

  assert.match(messageProcessorSource, /buildVirtualFileSummaryParts/);
  assert.match(messageProcessorSource, /buildVirtualFilePrimaryText/);
  assert.match(messageProcessorSource, /getVirtualFileToolTypeLabel/);
  assert.match(messageProcessorSource, /response-activity-tool-meta/);

  assert.match(sidebarCssSource, /\.message \.response-activity-tool-meta/);
});
