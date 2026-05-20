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

const THREAD_RUNTIME_KEY_SEPARATOR = '::thread:';

function normalizeKey(value) {
  if (value == null) return '';
  const normalized = String(value).trim();
  return normalized || '';
}

/**
 * 将运行态 key 拆成“会话基准 key + 线程 key”。
 *
 * 运行态 key 的粒度不是单纯会话，而是消息链：
 * - 主线消息链直接使用 conversationId / draft key；
 * - 划词线程消息链在会话 key 后追加 threadId。
 *
 * 这样同一条消息链之后的发送保持 FIFO，不同线程或主线互不阻塞。
 *
 * @param {string|null|undefined} value
 * @returns {{ conversationKey: string, threadId: string }}
 */
export function parseConversationRuntimeKey(value) {
  const normalized = normalizeKey(value);
  if (!normalized) {
    return { conversationKey: '', threadId: '' };
  }

  const separatorIndex = normalized.indexOf(THREAD_RUNTIME_KEY_SEPARATOR);
  if (separatorIndex < 0) {
    return { conversationKey: normalized, threadId: '' };
  }

  const conversationKey = normalizeKey(normalized.slice(0, separatorIndex));
  const threadId = normalizeKey(normalized.slice(separatorIndex + THREAD_RUNTIME_KEY_SEPARATOR.length));
  if (!conversationKey || !threadId) {
    return { conversationKey: normalized, threadId: '' };
  }
  return { conversationKey, threadId };
}

/**
 * 构造消息链运行态 key。
 *
 * @param {string|null|undefined} conversationKey
 * @param {string|null|undefined} threadId
 * @returns {string}
 */
export function buildConversationRuntimeKey(conversationKey, threadId = '') {
  const base = parseConversationRuntimeKey(conversationKey).conversationKey;
  const inheritedThreadId = parseConversationRuntimeKey(conversationKey).threadId;
  const normalizedThreadId = normalizeKey(threadId) || inheritedThreadId;
  if (!base) return '';
  return normalizedThreadId
    ? `${base}${THREAD_RUNTIME_KEY_SEPARATOR}${normalizedThreadId}`
    : base;
}

export function getConversationKeyFromRuntimeKey(value) {
  return parseConversationRuntimeKey(value).conversationKey;
}

export function getThreadIdFromRuntimeKey(value) {
  return parseConversationRuntimeKey(value).threadId;
}

/**
 * 判断一个 queue key 是否仍然是“未落盘会话”的临时 draft key。
 *
 * @param {string|null|undefined} value
 * @returns {boolean}
 */
export function isDraftConversationQueueKey(value) {
  return getConversationKeyFromRuntimeKey(value).startsWith('__draft_queue_');
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
 * @param {string|null|undefined} [options.threadId]
 * @returns {string}
 */
export function resolveAttemptRuntimeConversationKey(options = {}) {
  const explicitRuntimeConversationKey = normalizeKey(options?.explicitRuntimeConversationKey);
  const explicitRuntimeParts = parseConversationRuntimeKey(explicitRuntimeConversationKey);
  const boundConversationId = normalizeKey(options?.boundConversationId);
  const fallbackConversationId = normalizeKey(options?.fallbackConversationId);
  const activeConversationId = normalizeKey(options?.activeConversationId);
  const activeDraftConversationQueueKey = normalizeKey(options?.activeDraftConversationQueueKey);
  const threadId = normalizeKey(options?.threadId) || explicitRuntimeParts.threadId;

  const hasBoundConversationId = !!(boundConversationId && !isDraftConversationQueueKey(boundConversationId));
  const hasExplicitRuntimeConversationKey = !!explicitRuntimeConversationKey;
  const explicitRuntimeConversationKeyIsDraft = isDraftConversationQueueKey(explicitRuntimeConversationKey);

  // 已有显式 runtime key 时，只有一种情况需要让位：
  // 旧 key 仍是 draft，而真实 conversationId 已经出现。
  if (hasExplicitRuntimeConversationKey && (!explicitRuntimeConversationKeyIsDraft || !hasBoundConversationId)) {
    return explicitRuntimeConversationKey;
  }

  if (hasBoundConversationId) return buildConversationRuntimeKey(boundConversationId, threadId);
  if (fallbackConversationId) return buildConversationRuntimeKey(fallbackConversationId, threadId);
  if (activeConversationId) return buildConversationRuntimeKey(activeConversationId, threadId);
  return buildConversationRuntimeKey(activeDraftConversationQueueKey, threadId);
}
