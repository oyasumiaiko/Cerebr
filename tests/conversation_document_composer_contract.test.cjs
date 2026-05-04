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
  assert.match(inputController, /extractPlainTextFromContenteditable/);
  assert.match(inputController, /replace\(\/\\r\\n\?\/g,\s*'\\n'\)/);
  assert.match(inputController, /\.trim\(\)/);
  assert.match(chatHistoryUi, /async function ensureCurrentConversationId/);
  assert.match(chatHistoryUi, /ensureCurrentConversationId,/);
  assert.match(chatHistoryUi, /listConversationDocuments\(targetConversationId\)/);
  assert.match(composerSource, /支持 \.md、\.txt、\.html、\.js 等纯文本文件/);
  assert.doesNotMatch(composerSource, /function shouldOfferLongTextDocumentPrompt\(text\)/);
  assert.doesNotMatch(composerSource, /转为文件并发送链接/);
  assert.doesNotMatch(messageSenderSource, /maybeHandleLongTextBeforeSend/);
});

test('文件创建面板支持导入本地文件，并为无文件名上传兜底 untitled', async () => {
  const composerSource = await readWorkspaceFile('src/ui/conversation_document_composer.js');

  assert.match(composerSource, /buildSuggestedConversationDocumentPathFromUploadName/);
  assert.match(composerSource, /const filename = normalizedName \|\| 'untitled';/);
  assert.match(composerSource, /导入本地文件/);
  assert.match(composerSource, /importLocalDocumentFile/);
  assert.match(composerSource, /consumePendingUploadedFileEnvironmentEntries/);
});

test('文件创建面板支持添加只读 local 文件与文件夹映射', async () => {
  const composerSource = await readWorkspaceFile('src/ui/conversation_document_composer.js');
  const pickerHtml = await readWorkspaceFile('src/ui/local_file_picker/local_file_picker.html');
  const pickerScript = await readWorkspaceFile('src/ui/local_file_picker/local_file_picker.js');
  const contentScript = await readWorkspaceFile('src/extension/content.js');

  assert.match(composerSource, /showOpenFilePicker/);
  assert.match(composerSource, /showDirectoryPicker/);
  assert.match(composerSource, /isEmbeddedExtensionFrame/);
  assert.match(composerSource, /LOCAL_FILE_PICKER_MESSAGE_TYPE/);
  assert.match(composerSource, /window\.open/);
  assert.match(composerSource, /添加本地文件/);
  assert.match(composerSource, /添加本地文件夹/);
  assert.match(composerSource, /putLocalFileMount/);
  assert.match(composerSource, /consumePendingLocalMountEnvironmentEntries/);
  assert.match(pickerHtml, /local_file_picker\.js/);
  assert.match(pickerScript, /window\.showOpenFilePicker/);
  assert.match(pickerScript, /window\.showDirectoryPicker/);
  assert.match(pickerScript, /window\.opener\.postMessage/);
  assert.match(pickerScript, /CEREBR_LOCAL_FILE_PICKER_RESULT/);
  assert.match(contentScript, /file-system-access/);
});
