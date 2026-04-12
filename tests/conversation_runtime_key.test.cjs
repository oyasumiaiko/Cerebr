const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadConversationRuntimeKeyModule() {
  const filePath = path.resolve(__dirname, '../src/utils/conversation_runtime_key.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('isDraftConversationQueueKey only matches draft queue keys', async () => {
  const { isDraftConversationQueueKey } = await loadConversationRuntimeKeyModule();

  assert.equal(isDraftConversationQueueKey('__draft_queue_1'), true);
  assert.equal(isDraftConversationQueueKey('conv_123'), false);
  assert.equal(isDraftConversationQueueKey(''), false);
});

test('resolveAttemptRuntimeConversationKey keeps explicit real runtime key when already bound to a real conversation', async () => {
  const { resolveAttemptRuntimeConversationKey } = await loadConversationRuntimeKeyModule();

  assert.equal(resolveAttemptRuntimeConversationKey({
    explicitRuntimeConversationKey: 'conv_existing',
    boundConversationId: 'conv_saved',
    activeDraftConversationQueueKey: '__draft_queue_1'
  }), 'conv_existing');
});

test('resolveAttemptRuntimeConversationKey upgrades old draft runtime key to bound conversation id once the conversation is saved', async () => {
  const { resolveAttemptRuntimeConversationKey } = await loadConversationRuntimeKeyModule();

  assert.equal(resolveAttemptRuntimeConversationKey({
    explicitRuntimeConversationKey: '__draft_queue_7',
    boundConversationId: 'conv_saved_7',
    activeDraftConversationQueueKey: '__draft_queue_7'
  }), 'conv_saved_7');
});

test('resolveAttemptRuntimeConversationKey keeps draft runtime key before the conversation is saved', async () => {
  const { resolveAttemptRuntimeConversationKey } = await loadConversationRuntimeKeyModule();

  assert.equal(resolveAttemptRuntimeConversationKey({
    explicitRuntimeConversationKey: '__draft_queue_9',
    boundConversationId: '',
    activeDraftConversationQueueKey: '__draft_queue_9'
  }), '__draft_queue_9');
});

test('resolveAttemptRuntimeConversationKey falls back through explicit, bound, active, then draft context', async () => {
  const { resolveAttemptRuntimeConversationKey } = await loadConversationRuntimeKeyModule();

  assert.equal(resolveAttemptRuntimeConversationKey({
    fallbackConversationId: 'conv_fallback',
    activeConversationId: 'conv_active',
    activeDraftConversationQueueKey: '__draft_queue_3'
  }), 'conv_fallback');

  assert.equal(resolveAttemptRuntimeConversationKey({
    activeConversationId: 'conv_active',
    activeDraftConversationQueueKey: '__draft_queue_3'
  }), 'conv_active');

  assert.equal(resolveAttemptRuntimeConversationKey({
    activeDraftConversationQueueKey: '__draft_queue_3'
  }), '__draft_queue_3');
});
