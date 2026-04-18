const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('response_activity 工具详情折叠时使用 JS hidden 状态，而不是只靠 CSS 压缩高度', async () => {
  const messageProcessorSource = await readWorkspaceFile('src/core/message_processor.js');
  const sidebarCssSource = await readWorkspaceFile('src/ui/styles/sidebar.css');

  assert.match(
    messageProcessorSource,
    /function setResponseActivityToolExpandedState\(toolItem, expanded\)/
  );
  assert.match(
    messageProcessorSource,
    /toolBody\.hidden = !nextExpanded;/
  );
  assert.match(
    messageProcessorSource,
    /toolBody\.setAttribute\('aria-hidden', nextExpanded \? 'false' : 'true'\);/
  );
  assert.match(
    sidebarCssSource,
    /\.message \.response-activity-tool-body\[hidden\]\s*\{\s*display:\s*none !important;\s*\}/s
  );
});
