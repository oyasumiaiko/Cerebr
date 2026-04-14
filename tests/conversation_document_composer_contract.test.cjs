const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('输入区已新增文档创建入口与 composer 服务接线', async () => {
  const sidebarHtml = await readWorkspaceFile('src/ui/sidebar/sidebar.html');
  const appContext = await readWorkspaceFile('src/ui/sidebar/sidebar_app_context.js');
  const bootstrap = await readWorkspaceFile('src/ui/sidebar/sidebar_bootstrap.js');
  const events = await readWorkspaceFile('src/ui/sidebar/sidebar_events.js');

  assert.match(sidebarHtml, /id="document-button"/);
  assert.match(appContext, /documentButton: document\.getElementById\('document-button'\)/);
  assert.match(bootstrap, /createConversationDocumentComposer/);
  assert.match(bootstrap, /services\.conversationDocumentComposer = createConversationDocumentComposer/);
  assert.match(events, /documentButton/);
  assert.match(events, /conversationDocumentComposer\?\.toggleCreatePanel/);
});

test('输入控制器与聊天历史 UI 已为文档创建提供基础能力', async () => {
  const inputController = await readWorkspaceFile('src/ui/input_controller.js');
  const chatHistoryUi = await readWorkspaceFile('src/ui/chat_history_ui.js');
  const composerSource = await readWorkspaceFile('src/ui/conversation_document_composer.js');
  const messageSenderSource = await readWorkspaceFile('src/core/message_sender.js');

  assert.match(inputController, /function insertTextAtCursor\(text\)/);
  assert.match(inputController, /insertTextAtCursor/);
  assert.match(inputController, /messageInput\.innerText/);
  assert.match(inputController, /replace\(\/\\r\\n\?\/g,\s*'\\n'\)/);
  assert.match(inputController, /\.trim\(\)/);
  assert.match(chatHistoryUi, /async function ensureCurrentConversationId/);
  assert.match(chatHistoryUi, /ensureCurrentConversationId,/);
  assert.match(chatHistoryUi, /listConversationDocuments\(targetConversationId\)/);
  assert.match(composerSource, /function shouldOfferLongTextDocumentPrompt\(text\)/);
  assert.match(composerSource, /转为文档并发送链接/);
  assert.match(messageSenderSource, /maybeHandleLongTextBeforeSend/);
});
