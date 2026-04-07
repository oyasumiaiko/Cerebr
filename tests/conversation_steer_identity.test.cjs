const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadConversationSteerIdentityModule() {
  const filePath = path.resolve(__dirname, '../src/utils/conversation_steer_identity.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('buildAttemptSteerTargetIdentity uses attempt id as stable turn id and keeps aiMessageId as legacy alias', async () => {
  const { buildAttemptSteerTargetIdentity } = await loadConversationSteerIdentityModule();

  const identity = buildAttemptSteerTargetIdentity({
    id: 'attempt_steady',
    aiMessageId: 'ai_msg_late_bound',
    startedAt: 123456
  });

  assert.deepEqual(identity, {
    turnId: 'attempt_steady',
    legacyTurnIds: ['ai_msg_late_bound'],
    turnStartedAtMs: 123456
  });
});

test('buildPendingSteerMatchOptionsForAttempt exposes both stable turn id and legacy aliases for matching', async () => {
  const { buildPendingSteerMatchOptionsForAttempt } = await loadConversationSteerIdentityModule();

  const matchOptions = buildPendingSteerMatchOptionsForAttempt({
    id: 'attempt_steady',
    aiMessageId: 'ai_msg_late_bound',
    startedAt: 123456
  });

  assert.deepEqual(matchOptions, {
    turnIds: ['attempt_steady', 'ai_msg_late_bound'],
    turnStartedAtMs: 123456
  });
});

test('buildAttemptSteerTargetIdentity falls back to aiMessageId only when attempt id is absent', async () => {
  const { buildAttemptSteerTargetIdentity } = await loadConversationSteerIdentityModule();

  const identity = buildAttemptSteerTargetIdentity({
    id: '',
    aiMessageId: 'ai_msg_only',
    startedAt: 789
  });

  assert.deepEqual(identity, {
    turnId: 'ai_msg_only',
    legacyTurnIds: [],
    turnStartedAtMs: 789
  });
});
