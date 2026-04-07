/**
 * 纯函数：判断某个进行中的 attempt 是否属于指定会话队列 key。
 *
 * 这里优先使用 runtimeConversationKey，而不是只看 boundConversationId，
 * 因为一条新消息刚开始发送时，会话 ID 可能尚未持久化完成：
 * - boundConversationId 仍为空；
 * - 但 attempt.runtimeConversationKey 已经稳定指向当前 draft / 会话队列。
 *
 * 如果只按 boundConversationId 判断，就会把“仍在生成中的当前 turn”
 * 误判成“不属于当前会话”，从而让 steer / abort / queue 这些依赖
 * “当前是否有 in-flight turn”的逻辑全部看不到它。
 */

function normalizeQueueKey(value) {
  if (value == null) return '';
  const normalized = String(value).trim();
  return normalized || '';
}

export function attemptBelongsToConversationQueue(attemptState, queueKey) {
  if (!attemptState || attemptState.finished) return false;
  const normalizedQueueKey = normalizeQueueKey(queueKey);
  if (!normalizedQueueKey) return false;

  const attemptQueueKey = normalizeQueueKey(
    attemptState.runtimeConversationKey
    || attemptState.boundConversationId
  );
  return !!(attemptQueueKey && attemptQueueKey === normalizedQueueKey);
}
