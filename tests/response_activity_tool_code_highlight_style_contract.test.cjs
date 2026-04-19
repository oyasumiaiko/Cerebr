const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('response_activity 的 JS 代码块只保留高亮 token，不再叠加 markdown 代码块的额外盒模型样式', async () => {
  const sidebarCssSource = await readWorkspaceFile('src/ui/styles/sidebar.css');

  assert.match(
    sidebarCssSource,
    /\.message \.response-activity-tool-code code\s*\{[\s\S]*color:\s*inherit;[\s\S]*font-family:\s*inherit;[\s\S]*font-size:\s*inherit;[\s\S]*line-height:\s*inherit;[\s\S]*white-space:\s*pre;[\s\S]*word-break:\s*normal;[\s\S]*overflow-wrap:\s*normal;[\s\S]*overflow:\s*visible;[\s\S]*\}/
  );
  assert.match(
    sidebarCssSource,
    /\.message \.response-activity-tool-code code\.hljs\s*\{[\s\S]*padding:\s*0;[\s\S]*border:\s*0;[\s\S]*background:\s*transparent;[\s\S]*color:\s*inherit;[\s\S]*font-family:\s*inherit;[\s\S]*font-size:\s*inherit;[\s\S]*line-height:\s*inherit;[\s\S]*overflow:\s*visible;[\s\S]*\}/
  );
});
