/**
 * 会话 queue / runtime key 的纯函数辅助。
 *
 * 这里单独抽一层的原因是：
 * - 发送首条消息时，attempt 往往先跑在 draft queue key（`__draft_queue_*`）上；
 * - 待会话真正落盘后，attempt 会绑定到真实 conversationId；
 * - 如果继续死守旧的 draft key，后续恢复 queue、runtime 迁移、后台续发都会落到过期键上。
 *
 * 这正是 steer fallback 丢消息的根因：
 * - steer 在 tool hop 场景里还能靠 attempt-local pending steer 被吸收；
 * - 但没有 follow-up window 时，turn 结束后需要把 steer 恢复成 queue job；
 * - 若此时 runtime key 仍是旧 draft key，恢复出来的 queue job 会挂到“当前会话已不再使用”的旧键上，
 *   导致当前会话看不到，也不会按预期自动续发。
 */

function normalizeKey(value) {
  if (value == null) return '';
  const normalized = String(value).trim();
  return normalized || '';
}

/**
 * 判断一个 queue key 是否仍然是“未落盘会话”的临时 draft key。
 *
 * @param {string|null|undefined} value
 * @returns {boolean}
 */
export function isDraftConversationQueueKey(value) {
  return normalizeKey(value).startsWith('__draft_queue_');
}

/**
 * 解析 attempt 当前应使用的 runtime queue key。
 *
 * 关键规则：
 * - 真实 conversationId 一旦可用，就不应再继续使用旧 draft key；
 * - 但若 explicit runtime key 本身已经是一个真实会话 key，则仍优先复用它；
 * - 这样既能保留“请求开始前先落到 draft key”的能力，又能在会话落盘后自然切换到正式 key。
 *
 * @param {Object} options
 * @param {string|null|undefined} [options.explicitRuntimeConversationKey]
 * @param {string|null|undefined} [options.boundConversationId]
 * @param {string|null|undefined} [options.fallbackConversationId]
 * @param {string|null|undefined} [options.activeConversationId]
 * @param {string|null|undefined} [options.activeDraftConversationQueueKey]
 * @returns {string}
 */
export function resolveAttemptRuntimeConversationKey(options = {}) {
  const explicitRuntimeConversationKey = normalizeKey(options?.explicitRuntimeConversationKey);
  const boundConversationId = normalizeKey(options?.boundConversationId);
  const fallbackConversationId = normalizeKey(options?.fallbackConversationId);
  const activeConversationId = normalizeKey(options?.activeConversationId);
  const activeDraftConversationQueueKey = normalizeKey(options?.activeDraftConversationQueueKey);

  const hasBoundConversationId = !!(boundConversationId && !isDraftConversationQueueKey(boundConversationId));
  const hasExplicitRuntimeConversationKey = !!explicitRuntimeConversationKey;
  const explicitRuntimeConversationKeyIsDraft = isDraftConversationQueueKey(explicitRuntimeConversationKey);

  // 已有显式 runtime key 时，只有一种情况需要让位：
  // 旧 key 仍是 draft，而真实 conversationId 已经出现。
  if (hasExplicitRuntimeConversationKey && (!explicitRuntimeConversationKeyIsDraft || !hasBoundConversationId)) {
    return explicitRuntimeConversationKey;
  }

  if (hasBoundConversationId) return boundConversationId;
  if (fallbackConversationId) return fallbackConversationId;
  if (activeConversationId) return activeConversationId;
  return activeDraftConversationQueueKey;
}
