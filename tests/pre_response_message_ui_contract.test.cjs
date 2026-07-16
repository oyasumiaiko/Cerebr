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
  const messageSenderSource = await readWorkspaceFile('src/core/message_sender.js');
  const sidebarAppContextSource = await readWorkspaceFile('src/ui/sidebar/sidebar_app_context.js');
  const uiManagerSource = await readWorkspaceFile('src/ui/ui_manager.js');
  const sidebarCssSource = await readWorkspaceFile('src/ui/styles/sidebar.css');
  const previewResponsesActivityTimelineOnLoadingMessageBody = (
    messageSenderSource.match(/function previewResponsesActivityTimelineOnLoadingMessage[\s\S]*?\n  }\n\n  function ensureAttemptOpenSteerWindowId/)
    || ['']
  )[0];
  const syncResponsesActivityPreviewToLoadingMessageBody = (
    messageSenderSource.match(/function syncResponsesActivityPreviewToLoadingMessage\(\)[\s\S]*?\n    }\n\n    \/\*\*/)
    || ['']
  )[0];
  const hasVisibleAssistantOutputBody = (
    messageSenderSource.match(/function hasVisibleAssistantOutput[\s\S]*?\n  }\n\n  \/\*\*/)
    || ['']
  )[0];

  assert.match(messageProcessorSource, /assistant-pre-response-status/);
  assert.match(messageProcessorSource, /response-activity-panel-status/);
  assert.match(messageProcessorSource, /entryKind: 'stream_error'/);
  assert.match(messageProcessorSource, /reconcileResponseActivityStreamErrorEntry/);
  assert.match(messageProcessorSource, /response-activity-stream-error-details/);
  assert.match(messageProcessorSource, /bindStableToggleDetails\(details, item\)/);
  assert.match(messageProcessorSource, /syncResponseActivityPanelStatus/);
  assert.match(messageProcessorSource, /resolveResponseActivityPanelStatusState/);
  assert.match(messageProcessorSource, /setResponseActivityPanelExpandedState/);
  assert.match(messageProcessorSource, /surface\.dataset\.collapsible = status\.collapsible === true \? 'true' : 'false'/);
  assert.match(messageProcessorSource, /surface\.setAttribute\('aria-label', '收起思考记录'\)/);
  assert.match(messageProcessorSource, /removeAssistantPreResponseStatusSurface/);
  assert.match(messageProcessorSource, /messageWrapperDiv\.classList\.add\('assistant-pre-response'\)/);
  assert.match(messageProcessorSource, /messageWrapperDiv\.classList\.remove\('assistant-pre-response'\)/);
  assert.match(uiManagerSource, /deriveAutoScrollFollowState/);
  assert.match(uiManagerSource, /container\.addEventListener\('scroll', handleContainerScrollAutoFollowState, \{ passive: true \}\)/);
  assert.match(sidebarCssSource, /\.response-activity-panel-status\[data-stage=\"completed_duration\"\]/);
  assert.match(sidebarCssSource, /\.response-activity-panel-status\.is-collapsible:hover/);
  assert.match(sidebarCssSource, /\.response-activity-entry--stream-error/);
  assert.match(sidebarCssSource, /\.response-activity-stream-error\[open\] \.response-activity-stream-error-chevron/);
  assert.match(messageSenderSource, /function renderAttemptPreResponseStatus[\s\S]*?response_activity_timeline/);
  assert.equal(hasVisibleAssistantOutputBody.includes('responseActivityTimeline.length > 0'), false);
  assert.equal(hasVisibleAssistantOutputBody.includes('input?.thoughts'), false);
  assert.equal(previewResponsesActivityTimelineOnLoadingMessageBody.includes('clearAttemptPreResponseStatus'), false);
  assert.equal(syncResponsesActivityPreviewToLoadingMessageBody.includes('clearAttemptPreResponseStatus'), false);

  assert.match(sidebarAppContextSource, /const isPreResponseMessage = messageElement\.classList\.contains\('assistant-pre-response'\)/);
  assert.match(sidebarAppContextSource, /messageSender\.abortCurrentRequest\?\.\(messageElement\);/);
  assert.match(sidebarAppContextSource, /await messageSender\?\.requestConversationMessageDeletion\?\.\(\{ messageId \}\);/);
});
