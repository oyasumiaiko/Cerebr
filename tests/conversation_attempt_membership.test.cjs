const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadConversationAttemptMembershipModule() {
  const filePath = path.resolve(__dirname, '../src/utils/conversation_attempt_membership.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('attemptBelongsToConversationQueue 在会话尚未持久化时优先匹配 runtimeConversationKey', async () => {
  const { attemptBelongsToConversationQueue } = await loadConversationAttemptMembershipModule();

  const matched = attemptBelongsToConversationQueue(
    {
      finished: false,
      runtimeConversationKey: 'draft_main',
      boundConversationId: ''
    },
    'draft_main'
  );

  assert.equal(matched, true);
});

test('attemptBelongsToConversationQueue 在 boundConversationId 可用时也能继续命中', async () => {
  const { attemptBelongsToConversationQueue } = await loadConversationAttemptMembershipModule();

  const matched = attemptBelongsToConversationQueue(
    {
      finished: false,
      runtimeConversationKey: 'conv_123',
      boundConversationId: 'conv_123'
    },
    'conv_123'
  );

  assert.equal(matched, true);
});

test('attemptBelongsToConversationQueue 不会把其它会话误判成当前会话', async () => {
  const { attemptBelongsToConversationQueue } = await loadConversationAttemptMembershipModule();

  const matched = attemptBelongsToConversationQueue(
    {
      finished: false,
      runtimeConversationKey: 'conv_a',
      boundConversationId: ''
    },
    'conv_b'
  );

  assert.equal(matched, false);
});
