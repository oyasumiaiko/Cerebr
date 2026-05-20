const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  return fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

test('发送队列 key 使用当前线程消息链，而不是仅使用 conversationId', async () => {
  const source = await readWorkspaceFile('src/core/message_sender.js');

  assert.match(
    source,
    /const activeThreadContextForSend = prepareActiveThreadContextForAppend\(resolveActiveThreadContext\(\)\);[\s\S]*?singleOpts\.__threadContextSnapshot = activeThreadSnapshotForSend;/,
    '发送入口必须冻结当前线程上下文，避免稍后执行 queue 时读取到别的活跃线程'
  );
  assert.match(
    source,
    /const currentConversationQueueKey = getCurrentActiveConversationQueueKey\(\{\s*activeThreadContext: activeThreadContextForSend\s*\}\);/,
    '当前 queue key 必须纳入 activeThreadContext'
  );
  assert.match(
    source,
    /selectLatestRunningAttemptForCurrentConversation\([\s\S]*?activeRuntimeKey[\s\S]*?\)/,
    '选择当前进行中的 attempt 时必须按消息链 runtime key 精确匹配'
  );
});

test('线程 queue 后台执行按 conversationId 加载存储，但按 threadId 隔离 DOM', async () => {
  const source = await readWorkspaceFile('src/core/message_sender.js');

  assert.match(
    source,
    /const queueConversationId = getPersistedConversationIdForQueue\(normalizedQueueKey\);[\s\S]*?!isConversationIdCurrentlyActive\(queueConversationId\)/,
    '判断后台发送时只能看真实 conversationId，不能把 thread-scoped queue key 当作 IndexedDB id'
  );
  assert.match(
    source,
    /const shouldWriteThreadUserHistoryOnly = \([\s\S]*?!isThreadUiActive\(activeThreadContext\)[\s\S]*?threadHistoryMessages !== activeHistoryMessages[\s\S]*?\);/,
    '线程不可见或使用 detached history 时，用户消息只能写历史，不能渲染进当前线程 DOM'
  );
});
