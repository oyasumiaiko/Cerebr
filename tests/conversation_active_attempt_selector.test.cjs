const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadConversationActiveAttemptSelectorModule() {
  const filePath = path.resolve(__dirname, '../src/utils/conversation_active_attempt_selector.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('selectLatestRunningAttemptForCurrentConversation 优先返回当前会话的已绑定 attempt', async () => {
  const { selectLatestRunningAttemptForCurrentConversation } = await loadConversationActiveAttemptSelectorModule();

  const selected = selectLatestRunningAttemptForCurrentConversation(
    [
      { id: 'attempt_old', boundConversationId: 'conv_a', startedAt: 1000, finished: false },
      { id: 'attempt_new', boundConversationId: 'conv_a', startedAt: 2000, finished: false },
      { id: 'attempt_other', boundConversationId: 'conv_b', startedAt: 3000, finished: false }
    ],
    'conv_a'
  );

  assert.equal(selected?.id, 'attempt_new');
});

test('selectLatestRunningAttemptForCurrentConversation 优先按当前消息链 runtime key 精确匹配', async () => {
  const { selectLatestRunningAttemptForCurrentConversation } = await loadConversationActiveAttemptSelectorModule();

  const selected = selectLatestRunningAttemptForCurrentConversation(
    [
      { id: 'attempt_thread_a', boundConversationId: 'conv_a', runtimeConversationKey: 'conv_a::thread:thread_a', startedAt: 3000, finished: false },
      { id: 'attempt_thread_b', boundConversationId: 'conv_a', runtimeConversationKey: 'conv_a::thread:thread_b', startedAt: 2000, finished: false }
    ],
    'conv_a',
    'conv_a::thread:thread_b'
  );

  assert.equal(selected?.id, 'attempt_thread_b');
});

test('selectLatestRunningAttemptForCurrentConversation 在线程消息链中不会退回同会话其它线程', async () => {
  const { selectLatestRunningAttemptForCurrentConversation } = await loadConversationActiveAttemptSelectorModule();

  const selected = selectLatestRunningAttemptForCurrentConversation(
    [
      { id: 'attempt_thread_a', boundConversationId: 'conv_a', runtimeConversationKey: 'conv_a::thread:thread_a', startedAt: 3000, finished: false }
    ],
    'conv_a',
    'conv_a::thread:thread_b'
  );

  assert.equal(selected, null);
});

test('selectLatestRunningAttemptForCurrentConversation 主线不会把线程 attempt 当作当前 attempt', async () => {
  const { selectLatestRunningAttemptForCurrentConversation } = await loadConversationActiveAttemptSelectorModule();

  const selected = selectLatestRunningAttemptForCurrentConversation(
    [
      { id: 'attempt_thread_a', boundConversationId: 'conv_a', runtimeConversationKey: 'conv_a::thread:thread_a', startedAt: 3000, finished: false },
      { id: 'attempt_main', boundConversationId: 'conv_a', runtimeConversationKey: 'conv_a', startedAt: 1000, finished: false }
    ],
    'conv_a',
    'conv_a'
  );

  assert.equal(selected?.id, 'attempt_main');
});

test('selectLatestRunningAttemptForCurrentConversation 在当前会话已存在但尚未绑定时接受唯一未绑定 attempt', async () => {
  const { selectLatestRunningAttemptForCurrentConversation } = await loadConversationActiveAttemptSelectorModule();

  const selected = selectLatestRunningAttemptForCurrentConversation(
    [
      { id: 'attempt_draft', boundConversationId: '', startedAt: 1500, finished: false }
    ],
    'conv_saved_later'
  );

  assert.equal(selected?.id, 'attempt_draft');
});

test('selectLatestRunningAttemptForCurrentConversation 在多条未绑定 attempt 并发时拒绝猜测', async () => {
  const { selectLatestRunningAttemptForCurrentConversation } = await loadConversationActiveAttemptSelectorModule();

  const selected = selectLatestRunningAttemptForCurrentConversation(
    [
      { id: 'attempt_draft_a', boundConversationId: '', startedAt: 1500, finished: false },
      { id: 'attempt_draft_b', boundConversationId: '', startedAt: 2500, finished: false }
    ],
    'conv_saved_later'
  );

  assert.equal(selected, null);
});

test('selectLatestRunningAttemptForCurrentConversation 在尚无 currentConversationId 时返回最新未绑定 attempt', async () => {
  const { selectLatestRunningAttemptForCurrentConversation } = await loadConversationActiveAttemptSelectorModule();

  const selected = selectLatestRunningAttemptForCurrentConversation(
    [
      { id: 'attempt_old', boundConversationId: '', startedAt: 1000, finished: false },
      { id: 'attempt_new', boundConversationId: '', startedAt: 2000, finished: false }
    ],
    ''
  );

  assert.equal(selected?.id, 'attempt_new');
});
