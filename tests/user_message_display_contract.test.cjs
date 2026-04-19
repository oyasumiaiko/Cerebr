const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('settings_manager 已注册用户消息 Markdown 渲染开关', async () => {
  const source = await readWorkspaceFile('src/ui/settings_manager.js');

  assert.match(source, /renderMarkdownForUserMessages/);
  assert.match(source, /label: '用户消息启用 Markdown 渲染'/);
});

test('message_processor 会按设置对用户消息走 Markdown 渲染并挂载固定展开按钮', async () => {
  const source = await readWorkspaceFile('src/core/message_processor.js');

  assert.match(source, /shouldRenderUserMessagesAsMarkdown/);
  assert.match(source, /renderMarkdownSafe\(messageText \|\| '', \{/);
  assert.match(source, /renderUserMessageTextContent\(messageDiv, textContentDiv, messageText\)/);
  assert.match(source, /user-message-text-content__toggle/);
  assert.match(source, /runWithStableToggleScroll\(toggleButton, \(\) => \{/);
  assert.match(source, /subscribe\?\.\('renderMarkdownForUserMessages'/);
});

test('sidebar.css 已为长用户消息提供 50vh 折叠体与右下角展开按钮样式', async () => {
  const source = await readWorkspaceFile('src/ui/styles/sidebar.css');

  assert.match(source, /\.user-message \.text-content\.user-message-text-content\.is-collapsible:not\(\.is-expanded\) \.user-message-text-content__body/);
  assert.match(source, /max-height: 50vh;/);
  assert.match(source, /\.user-message \.user-message-text-content__footer/);
  assert.match(source, /\.user-message \.user-message-text-content__toggle/);
  assert.match(source, /user-message-text-content__toggle-icon/);
});
