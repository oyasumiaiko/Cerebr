const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadModule() {
  const filePath = path.resolve(__dirname, '../src/utils/regenerate_retry_target.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('canReplaceRetryOrRegenerateInPlace 允许“有目标 DOM 但历史节点暂未命中”的原地复用', async () => {
  const { canReplaceRetryOrRegenerateInPlace } = await loadModule();
  assert.equal(
    canReplaceRetryOrRegenerateInPlace({
      targetAiMessageId: 'ai_msg_1',
      hasTargetNode: false,
      hasTargetElement: true
    }),
    true
  );
});

test('canReplaceRetryOrRegenerateInPlace 在没有稳定 targetAiMessageId 时拒绝原地复用', async () => {
  const { canReplaceRetryOrRegenerateInPlace } = await loadModule();
  assert.equal(
    canReplaceRetryOrRegenerateInPlace({
      targetAiMessageId: '',
      hasTargetNode: true,
      hasTargetElement: true
    }),
    false
  );
});

test('shouldReuseTransientRegeneratePlaceholder 识别无 message-id 的错误/重试占位气泡', async () => {
  const { shouldReuseTransientRegeneratePlaceholder } = await loadModule();
  assert.equal(
    shouldReuseTransientRegeneratePlaceholder({
      isAiMessage: true,
      hasBoundMessageId: false,
      isErrorMessage: true,
      isLoadingMessage: false,
      hasRetryActions: true
    }),
    true
  );
});

test('shouldReuseTransientRegeneratePlaceholder 不会误复用已有正式 message-id 的 AI 消息', async () => {
  const { shouldReuseTransientRegeneratePlaceholder } = await loadModule();
  assert.equal(
    shouldReuseTransientRegeneratePlaceholder({
      isAiMessage: true,
      hasBoundMessageId: true,
      isErrorMessage: true,
      isLoadingMessage: false,
      hasRetryActions: true
    }),
    false
  );
});

test('resolveCommittedUserMessageRetryId 让已落库的普通用户消息改走 regenerate retry', async () => {
  const { resolveCommittedUserMessageRetryId } = await loadModule();
  assert.equal(
    resolveCommittedUserMessageRetryId({
      regenerateMode: false,
      committedUserMessageId: ' user_msg_1 '
    }),
    'user_msg_1'
  );
});

test('resolveCommittedUserMessageRetryId 不改写已有 regenerate 请求', async () => {
  const { resolveCommittedUserMessageRetryId } = await loadModule();
  assert.equal(
    resolveCommittedUserMessageRetryId({
      regenerateMode: true,
      committedUserMessageId: 'user_msg_1'
    }),
    ''
  );
});

test('shouldRetainFailedConversationQueueJob 在聊天区已有错误气泡时不再保留 failed queue 项', async () => {
  const { shouldRetainFailedConversationQueueJob } = await loadModule();
  assert.equal(
    shouldRetainFailedConversationQueueJob({
      failureHandledByMessageUi: true,
      retryScheduled: false,
      aborted: false
    }),
    false
  );
});

test('shouldRetainFailedConversationQueueJob 对前置失败保留 queue 项供用户编辑处理', async () => {
  const { shouldRetainFailedConversationQueueJob } = await loadModule();
  assert.equal(
    shouldRetainFailedConversationQueueJob({
      failureHandledByMessageUi: false,
      retryScheduled: false,
      aborted: false
    }),
    true
  );
});
