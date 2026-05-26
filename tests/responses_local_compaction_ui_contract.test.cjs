const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('compact 成功态使用响应 usage 里的精确前后 token，非成功态保留尝试次数', async () => {
  const messageSenderSource = await readWorkspaceFile('src/core/message_sender.js');
  const messageProcessorSource = await readWorkspaceFile('src/core/message_processor.js');

  assert.match(
    messageSenderSource,
    /const compactUsage = normalizeApiUsageMeta\(compactPayload\?\.usage \|\| compactPayload\?\.response\?\.usage\);/
  );
  assert.match(
    messageSenderSource,
    /promptTokensBefore:\s*compactUsage\?\.promptTokens \?\? normalizedPayload\.promptTokensBefore \?\? null/
  );
  assert.match(
    messageSenderSource,
    /compactedOutputTokens:\s*compactUsage\?\.completionTokens \?\? null/
  );

  assert.match(
    messageProcessorSource,
    /const flowArrow = '→';/
  );
  assert.match(
    messageProcessorSource,
    /metaParts\.push\(`上下文 \$\{tokenBeforeLabel\} \$\{flowArrow\} \$\{tokenAfterLabel\} tokens`\);/
  );
  assert.match(
    messageProcessorSource,
    /if \(state === 'error' && status\?\.responseStatus\) metaParts\.push\(`HTTP \$\{status\.responseStatus\}`\);/
  );
  assert.match(
    messageProcessorSource,
    /const attemptLabel = status\?\.totalAttempts\s*\? `第 \$\{status\.attempt\}\/\$\{status\.totalAttempts\} 次`\s*: `第 \$\{status\.attempt\} 次`;/ 
  );
});

test('/compact 在线程模式下写入线程容器并修复线程尾指针', async () => {
  const messageSenderSource = await readWorkspaceFile('src/core/message_sender.js');

  assert.match(
    messageSenderSource,
    /function prepareThreadContextForAppend\(threadContext\) \{[\s\S]*container:\s*threadContainer[\s\S]*repairThreadAnnotation\?\.\(preparedContext\.threadId\)[\s\S]*preparedContext\.lastMessageId = preparedContext\.annotation\?\.lastMessageId \|\| null;[\s\S]*function prepareActiveThreadContextForAppend\(threadContext\) \{\s*return prepareThreadContextForAppend\(threadContext\);\s*\}/
  );
  assert.match(
    messageSenderSource,
    /const activeThreadContext = prepareActiveThreadContextForAppend\(resolveActiveThreadContext\(\)\);\s*const pendingMarkerResult = appendResponsesLocalCompactionMarker\(/
  );
  assert.match(
    messageSenderSource,
    /function resolveResponsesLocalCompactionInvocationContext\(\) \{[\s\S]*const activeThreadContext = prepareActiveThreadContextForAppend\(resolveActiveThreadContext\(\)\);[\s\S]*conversationChain = resolveConversationChainForAttempt\(/
  );
  assert.match(
    messageSenderSource,
    /container:\s*activeThreadContext\.container,\s*historyParentId,\s*preserveCurrentNode:\s*true,\s*historyPatch:\s*mergedHistoryPatch/
  );
});

test('compact marker 右键菜单只保留生命周期动作，删除 pending marker 会取消请求', async () => {
  const contextMenuSource = await readWorkspaceFile('src/ui/context_menu_manager.js');
  const sidebarAppContextSource = await readWorkspaceFile('src/ui/sidebar/sidebar_app_context.js');

  assert.match(
    contextMenuSource,
    /function resolveResponsesLocalCompactionMenuState\(messageElement\) \{[\s\S]*context-compaction-message[\s\S]*isResponsesLocalCompactionNode\(node\)[\s\S]*state/
  );
  assert.match(
    contextMenuSource,
    /function applyResponsesLocalCompactionContextMenu\(compactionMenuState\) \{[\s\S]*copyMessageButton\.style\.display = 'none';[\s\S]*closeAndHideContextSubmenu\(screenshotMenu, screenshotSubmenu\);[\s\S]*closeAndHideContextSubmenu\(regenerateButton, regenerateSubmenu\);[\s\S]*closeAndHideContextSubmenu\(insertMessageMenu, insertMessageSubmenu\);[\s\S]*closeAndHideContextSubmenu\(forkConversationButton, forkConversationSubmenu\);/
  );
  assert.match(
    contextMenuSource,
    /const isPending = compactionMenuState\.state === 'pending';[\s\S]*stopUpdateButton\.style\.display = isPending \? 'flex' : 'none';[\s\S]*setContextMenuItemLabel\(stopUpdateButton, 'far fa-stop', '取消压缩'\);/
  );
  assert.match(
    contextMenuSource,
    /if \(isResponsesLocalCompactionMessageElement\(messageElement\)\) return '';/
  );
  assert.match(
    contextMenuSource,
    /const compactionMenuState = resolveResponsesLocalCompactionMenuState\(currentMessageElement\);[\s\S]*messageSender\?\.cancelResponsesLocalCompaction\?\.\(compactionMenuState\.messageId\);/
  );
  assert.match(
    sidebarAppContextSource,
    /isResponsesLocalCompactionMessage[\s\S]*historyNode\?\.contextCompactionMarker[\s\S]*historyNode\?\.responsesLocalCompactionStatus[\s\S]*compactionState === 'pending'[\s\S]*messageSender\?\.cancelResponsesLocalCompaction\?\.\(messageId\);/
  );
});

test('/compact 运行期间同线程发送进入队列，完成时不清空新草稿', async () => {
  const messageSenderSource = await readWorkspaceFile('src/core/message_sender.js');

  assert.match(
    messageSenderSource,
    /function hasPendingWorkForConversationQueue\(queueKey\) \{[\s\S]*conversationQueueDrainLocks\.has\(normalizedQueueKey\)[\s\S]*hasRunningResponsesLocalCompactionForConversationQueue\(normalizedQueueKey\)/
  );
  assert.match(
    messageSenderSource,
    /function hasRunningResponsesLocalCompactionForConversationQueue\(queueKey\) \{[\s\S]*responsesLocalCompactionRuns\.values\(\)[\s\S]*runContext\?\.queueKey[\s\S]*runQueueKey === normalizedQueueKey/
  );
  assert.match(
    messageSenderSource,
    /const normalizedCompactionQueueKey = resolveResponsesLocalCompactionQueueKey\(\{[\s\S]*conversationQueueKey,[\s\S]*activeThreadContext[\s\S]*\}\);[\s\S]*queueKey: normalizedCompactionQueueKey/
  );
  assert.match(
    messageSenderSource,
    /finally \{[\s\S]*const queueKeyToFlush = runContext\.queueKey;[\s\S]*clearResponsesLocalCompactionRun\(normalizedTargetMessageId\);[\s\S]*scheduleConversationQueueFlush\(queueKeyToFlush\);/
  );
  assert.match(
    messageSenderSource,
    /const compactionQueueKey = getCurrentActiveConversationQueueKey\(\{[\s\S]*activeThreadContext[\s\S]*\}\);[\s\S]*runResponsesLocalCompactionWithRetries\(\{[\s\S]*conversationQueueKey: compactionQueueKey,[\s\S]*activeThreadContext/
  );
  assert.match(
    messageSenderSource,
    /const hasRunningCompactionInCurrentConversation = hasRunningResponsesLocalCompactionForConversationQueue\([\s\S]*currentConversationQueueKey[\s\S]*\);[\s\S]*const shouldEnqueue = hasRunningCompactionInCurrentConversation[\s\S]*hasQueuedMessagesInCurrentConversation[\s\S]*queueCurrentConversationMessages;/
  );
  assert.match(
    messageSenderSource,
    /const slashCommandInputSnapshot = rawText;[\s\S]*if \(!slashResult\.keepInput && isCurrentComposerTextStillSlashCommandSnapshot\(slashCommandInputSnapshot\)\) \{[\s\S]*clearInputs\(\);/
  );
  assert.match(
    messageSenderSource,
    /return \{[\s\S]*\.\.\.compactionResult,[\s\S]*keepInput: true[\s\S]*\};/
  );
});
