const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('预正文消息使用独立状态层渲染，并在删除时先中止对应请求', async () => {
  const messageProcessorSource = await readWorkspaceFile('src/core/message_processor.js');
  const sidebarAppContextSource = await readWorkspaceFile('src/ui/sidebar/sidebar_app_context.js');

  assert.match(messageProcessorSource, /assistant-pre-response-status/);
  assert.match(messageProcessorSource, /messageWrapperDiv\.classList\.add\('assistant-pre-response'\)/);
  assert.match(messageProcessorSource, /messageWrapperDiv\.classList\.remove\('assistant-pre-response'\)/);

  assert.match(sidebarAppContextSource, /const isPreResponseMessage = messageElement\.classList\.contains\('assistant-pre-response'\)/);
  assert.match(sidebarAppContextSource, /messageSender\.abortCurrentRequest\?\.\(messageElement\);/);
  assert.match(sidebarAppContextSource, /await messageSender\?\.requestConversationMessageDeletion\?\.\(\{ messageId \}\);/);
});
