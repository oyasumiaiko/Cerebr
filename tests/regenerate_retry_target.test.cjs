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
