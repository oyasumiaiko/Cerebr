const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  return fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

test('发送失败后的 queue 保留逻辑只由统一判定函数决定', async () => {
  const source = await readWorkspaceFile('src/core/message_sender.js');

  assert.match(
    source,
    /if \(result\?\.ok !== true && shouldRetainFailedConversationQueueJob\(result\)\) \{[\s\S]*?status: 'failed'/,
    'executeConversationQueueJob 不应在已有错误气泡时继续无条件塞回 failed queue 项'
  );
  assert.match(
    source,
    /failureHandledByMessageUi: !!messageElement/,
    'sendMessageCore 需要显式告诉 queue 层失败是否已经由聊天区错误气泡承接'
  );
});

test('已落库用户消息的重试改写为 regenerate payload，避免重复追加 user message', async () => {
  const source = await readWorkspaceFile('src/core/message_sender.js');

  assert.match(
    source,
    /const retryCommittedUserMessageId = resolveCommittedUserMessageRetryId\(\{[\s\S]*?committedUserMessageId[\s\S]*?\}\);/
  );
  assert.match(
    source,
    /regenerateMode: true,[\s\S]*?messageId: retryCommittedUserMessageId,[\s\S]*?targetAiMessageId: normalizeConversationId\(mergedHint\.targetAiMessageId\) \|\| null/,
    '重试已落库用户消息时必须围绕原 user message 重新生成 assistant'
  );
});

test('失败气泡承接当前任务后不会继续自动冲刷后续 FIFO queue', async () => {
  const source = await readWorkspaceFile('src/core/message_sender.js');

  assert.match(
    source,
    /let shouldAutoContinueQueue = true;[\s\S]*?result\?\.failureHandledByMessageUi === true[\s\S]*?shouldAutoContinueQueue = false;/,
    '当前 turn 已失败时，后续 queued 消息不能在缺失 assistant 回复的历史上继续自动发送'
  );
  assert.match(
    source,
    /\(shouldAutoContinueQueue \|\| shouldResumeQueuedRetryAfterHandledFailure\)[\s\S]*?&& hasQueuedMessagesForConversation\(normalizedQueueKey\)[\s\S]*?scheduleConversationQueueFlush\(normalizedQueueKey\);/,
    'queue flush 必须受失败阻断状态控制'
  );
});

test('错误气泡出现瞬间点击重试时，显式 retry job 可以恢复 queue flush', async () => {
  const source = await readWorkspaceFile('src/core/message_sender.js');

  assert.match(
    source,
    /resumeAfterHandledFailure: true/,
    '手动错误重试入队时需要标记它可以穿过本轮失败阻断'
  );
  assert.match(
    source,
    /shouldResumeQueuedRetryAfterHandledFailure[\s\S]*?task\?\.resumeAfterHandledFailure === true[\s\S]*?shouldAutoContinueQueue \|\| shouldResumeQueuedRetryAfterHandledFailure/,
    '失败 finally 应允许已入队的显式 retry job 继续触发 flush'
  );
});

test('草稿会话首条消息失败后，retry queue key 改绑到真实 conversation id', async () => {
  const source = await readWorkspaceFile('src/core/message_sender.js');

  assert.match(
    source,
    /const resolveRetryQueueKey = \(conversationId = ''\) => \{[\s\S]*?const retryThreadId = getThreadIdForQueue\(normalizedConversationQueueKey\);[\s\S]*?isDraftConversationQueueKey\(normalizedConversationQueueKey\)[\s\S]*?resolveConversationQueueKey\(retryConversationId, \{ threadId: retryThreadId \}\)/,
    '首条消息落库后不能继续用 __draft_queue_* 执行手动或自动重试'
  );
  assert.match(
    source,
    /const retryQueueKey = resolveRetryQueueKey\(retryBoundConversationId\);[\s\S]*?dispatchConversationJob\([\s\S]*?retryQueueKey,/,
    '手动重试应使用重新解析后的 queue key'
  );
});
