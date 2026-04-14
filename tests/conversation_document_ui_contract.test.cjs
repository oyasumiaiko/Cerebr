const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('message_sender 已注册对话文档顶层工具并接入专用执行分支', async () => {
  const source = await readWorkspaceFile('src/core/message_sender.js');

  assert.match(source, /buildVirtualFileApplyPatchFunctionToolDefinition\(\)/);
  assert.match(source, /buildVirtualFileListFilesFunctionToolDefinition\(\)/);
  assert.match(source, /buildVirtualFileReadFileFunctionToolDefinition\(\)/);
  assert.match(source, /buildVirtualFileSearchFilesFunctionToolDefinition\(\)/);
  assert.match(source, /executeResponsesVirtualFileFunction\(functionName, parsedArgs, options\)/);
  assert.match(source, /serializeResponsesConversationDocumentFunctionToolOutput\(functionName, outputPayload\)/);
});

test('message_processor 已把裸相对路径链接替换为文档卡片，并监听文档变更事件', async () => {
  const source = await readWorkspaceFile('src/core/message_processor.js');
  const viewerSource = await readWorkspaceFile('src/utils/conversation_document_viewer.js');

  assert.match(source, /isConversationDocumentRelativeHref\(rawHref\)/);
  assert.match(source, /createConversationDocumentViewer/);
  assert.match(source, /syncConversationDocumentAttachmentStrip/);
  assert.match(source, /createConversationDocumentCard\(link\)/);
  assert.match(source, /CONVERSATION_DOCUMENT_CHANGE_EVENT_NAME/);
  assert.match(viewerSource, /conversation-document-card/);
  assert.match(viewerSource, /conversation-document-attachments/);
});

test('conversation_document_viewer 使用无边框图标按钮承载基础文档操作', async () => {
  const source = await readWorkspaceFile('src/utils/conversation_document_viewer.js');

  assert.match(source, /conversation-document-card__tool-button/);
  assert.match(source, /fa-regular fa-pen-to-square/);
  assert.match(source, /fa-regular fa-copy/);
  assert.match(source, /fa-solid fa-download/);
  assert.match(source, /fa-brands fa-markdown/);
  assert.match(source, /fa-solid fa-code/);
});

test('settings_manager 已注册文档渲染默认值偏好', async () => {
  const source = await readWorkspaceFile('src/ui/settings_manager.js');

  assert.match(source, /documentRenderMarkdownForMd/);
  assert.match(source, /documentRenderMarkdownForTxt/);
  assert.match(source, /documentHighlightCodeByExtension/);
  assert.match(source, /documentViewModeOverrides/);
});

test('chat_history_ui 已在 fork 与备份恢复链路中处理对话文档', async () => {
  const source = await readWorkspaceFile('src/ui/chat_history_ui.js');

  assert.match(source, /copyConversationDocuments\(parentConversationId, newConversationId\)/);
  assert.match(source, /const documents = await listConversationDocuments\(meta\.id\);/);
  assert.match(source, /await replaceConversationDocuments\(conversationToStore\.id, documentSnapshot\);/);
});
