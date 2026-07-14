const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  return fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

test('纯对话模式只隔离新请求工具和上下文，不重写既有历史 contextual items', async () => {
  const source = await readWorkspaceFile('src/core/message_sender.js');

  assert.match(source, /const canWriteContextToCurrentUserNode = !regenerateMode/);
  assert.match(
    source,
    /targetUserNodeForContext\?\.id === currentUserMessageIdForContext/
  );
  assert.match(
    source,
    /if \(canWriteContextToCurrentUserNode\) \{\s*syncUserContextualInputsForConversationTurn/s
  );
  assert.match(source, /const isPureConversationRequest = pureConversationApiMode \|\| isPureConversationApiConfig\(config\)/);
  assert.match(source, /const shouldPrepareEnvironmentContext = isOpenAIResponsesApiConfig\(effectiveApiConfig\)\s*&& !isPureConversationRequest/);
  assert.match(source, /当前 API 已启用纯对话模式，不能执行会生成额外上下文的 \/compact/);
  assert.doesNotMatch(source, /delete targetUserNode\.contextual_input_items_before/);
});

test('API 纯对话模式有持久化选择器和独立消息模板开关', async () => {
  const settingsSource = await readWorkspaceFile('src/api/api_settings.js');
  const htmlSource = await readWorkspaceFile('src/ui/sidebar/sidebar.html');

  assert.match(htmlSource, /class="api-request-mode"[\s\S]*value="enhanced"[\s\S]*value="pure_chat"/);
  assert.match(htmlSource, /class="user-message-template-enabled"/);
  assert.match(settingsSource, /requestMode: normalizeApiRequestMode\(c\.requestMode\)/);
  assert.match(settingsSource, /userMessagePreprocessorEnabled: c\.userMessagePreprocessorEnabled !== false/);
});

test('纯对话模式仍允许保存宿主页 metadata 作为会话来源记录', async () => {
  const senderSource = await readWorkspaceFile('src/core/message_sender.js');
  const processorSource = await readWorkspaceFile('src/core/message_processor.js');
  const historyUiSource = await readWorkspaceFile('src/ui/chat_history_ui.js');

  assert.match(senderSource, /pageMeta: pageContentSnapshot \|\| buildCurrentPageMetaSnapshot\(\)/);
  assert.match(senderSource, /pageContentSnapshot: pageContentSnapshot \|\| buildCurrentPageMetaSnapshot\(\)/);
  assert.match(processorSource, /const snapshot = createPageMetaSnapshot\(state\?\.pageInfo\)/);
  assert.match(historyUiSource, /source: 'first_user_message'/);
  assert.doesNotMatch(senderSource, /isolated: true/);
  assert.doesNotMatch(processorSource, /isolated: true/);
  assert.doesNotMatch(historyUiSource, /isolated_conversation/);
});

test('纯对话模式的 skill 请求显式关闭 background sender.tab.id 回退', async () => {
  const sidebarSource = await readWorkspaceFile('src/ui/sidebar/sidebar_app_context.js');
  const backgroundSource = await readWorkspaceFile('src/extension/background.js');

  assert.match(sidebarSource, /isolateFromHostPage = pageToolEnvironment\?\.exposeHostPageTools !== true/);
  assert.match(sidebarSource, /type: 'GET_MATCHING_SKILL_SUMMARIES'[\s\S]*isolateFromHostPage/);
  assert.match(sidebarSource, /type: 'SKILL_REGISTRY_ACTION'[\s\S]*isolateFromHostPage/);
  assert.match(backgroundSource, /allowSenderTabFallback: !isolateFromHostPage/);
  assert.match(backgroundSource, /const targetTabId = isolateFromHostPage\s*\?\s*null/);
});
