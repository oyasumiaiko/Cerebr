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

  assert.match(source, /isConversationDocumentRelativeHref\(rawHref\)/);
  assert.match(source, /normalizeConversationDocumentHrefPath\(link\.getAttribute\('href'\) \|\| ''\)/);
  assert.match(source, /createConversationDocumentCard\(link\)/);
  assert.match(source, /CONVERSATION_DOCUMENT_CHANGE_EVENT_NAME/);
  assert.match(source, /conversation-document-card/);
});

test('chat_history_ui 已在 fork 与备份恢复链路中处理对话文档', async () => {
  const source = await readWorkspaceFile('src/ui/chat_history_ui.js');

  assert.match(source, /copyConversationDocuments\(parentConversationId, newConversationId\)/);
  assert.match(source, /const documents = await listConversationDocuments\(meta\.id\);/);
  assert.match(source, /await replaceConversationDocuments\(conversationToStore\.id, documentSnapshot\);/);
});
