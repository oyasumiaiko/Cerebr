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

test('message_processor 会按设置对用户消息走 Markdown 渲染，且不再挂载展开按钮', async () => {
  const source = await readWorkspaceFile('src/core/message_processor.js');
  const senderSource = await readWorkspaceFile('src/core/message_sender.js');

  assert.match(source, /shouldRenderUserMessagesAsMarkdown/);
  assert.match(source, /renderMarkdownSafe\(messageText \|\| '', \{/);
  assert.match(source, /renderUserMessageTextContent\(messageDiv, textContentDiv, messageText\)/);
  assert.match(source, /syncConversationDocumentAttachmentStrip\(messageDiv\)/);
  assert.match(source, /syncUserContextualInputDebugView/);
  assert.match(source, /contextual-input-debug/);
  assert.match(senderSource, /buildContextualInputDebugEntry\('environment_context', environmentAttachment\),\s*buildContextualInputDebugEntry\('page_runtime_context', pageAttachment\),\s*buildContextualInputDebugEntry\('skill_context', skillAttachment\)/s);
  assert.match(source, /function buildLegacyContextualInputDebugEntries\(contextualItems\)/);
  assert.match(source, /detectContextualInputTextType\(text\)/);
  assert.match(source, /entry\.status === 'injected' && entry\.text/);
  assert.match(source, /subscribe\?\.\('renderMarkdownForUserMessages'/);
  assert.doesNotMatch(source, /user-message-text-content__toggle/);
  assert.doesNotMatch(source, /userMessageExpanded/);
  assert.doesNotMatch(source, /createUserMessageToggleButton/);
});

test('sidebar.css 保留用户消息滚动容器样式，不再定义展开按钮样式', async () => {
  const source = await readWorkspaceFile('src/ui/styles/sidebar.css');

  assert.match(source, /\.user-message \.text-content\.user-message-text-content/);
  assert.match(source, /\.user-message \.contextual-input-debug/);
  assert.match(source, /max-height: 50vh;/);
  assert.match(source, /overflow-y: auto;/);
  assert.doesNotMatch(source, /\.user-message \.user-message-text-content__footer/);
  assert.doesNotMatch(source, /\.user-message \.user-message-text-content__toggle/);
  assert.doesNotMatch(source, /user-message-text-content__toggle-icon/);
});
