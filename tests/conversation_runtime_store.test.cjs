const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadConversationRuntimeStoreModule() {
  const modulePath = path.resolve(__dirname, '../src/core/conversation_runtime_store.js');
  return import(pathToFileURL(modulePath).href);
}

test('activeTurn 默认把 hasVisibleAnswerStarted 设为 false', async () => {
  const { createConversationRuntimeStore } = await loadConversationRuntimeStoreModule();
  const store = createConversationRuntimeStore();
  const snapshot = store.getConversationRuntimeState('conv_default_flag');

  assert.equal(snapshot.activeTurn.hasVisibleAnswerStarted, false);
});

test('updateConversationRuntimeState 会保留 hasVisibleAnswerStarted', async () => {
  const { createConversationRuntimeStore } = await loadConversationRuntimeStoreModule();
  const store = createConversationRuntimeStore();

  store.updateConversationRuntimeState('conv_answer_started', (draft) => {
    draft.activeTurn.attemptId = 'attempt_answer_started';
    draft.activeTurn.status = 'streaming';
    draft.activeTurn.hasVisibleAnswerStarted = true;
  });

  const snapshot = store.getConversationRuntimeState('conv_answer_started');
  assert.equal(snapshot.activeTurn.attemptId, 'attempt_answer_started');
  assert.equal(snapshot.activeTurn.status, 'streaming');
  assert.equal(snapshot.activeTurn.hasVisibleAnswerStarted, true);
});
