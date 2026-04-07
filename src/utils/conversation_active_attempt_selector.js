/**
 * 选择“当前侧栏应视为正在生成中的那条 attempt”。
 *
 * 为什么要单独抽出来：
 * - 新会话首条消息发送时，attempt 往往先跑在 draft queue key 上；
 * - conversationId 可能要等第一次持久化后才出现；
 * - 这段窗口里如果用户 Ctrl+Enter steer，我们不能只靠当前 conversationId 精确匹配，
 *   否则会把当前正在生成的 turn 误判成“不存在”。
 *
 * 这里的选择策略是保守的：
 * - 有明确 boundConversationId 命中时，优先选它；
 * - 若当前 conversationId 已存在，但没有任何 bound 命中，只在“恰好只有一条未绑定 attempt”
 *   时才把它视作当前 UI 的 in-flight turn，避免多草稿并发时误绑；
 * - 若当前 conversationId 还不存在，则优先选最新的未绑定 attempt。
 */

function normalizeConversationId(value) {
  if (value == null) return '';
  const normalized = String(value).trim();
  return normalized || '';
}

function getStartedAt(attempt) {
  const numeric = Number(attempt?.startedAt);
  return Number.isFinite(numeric) ? numeric : 0;
}

function selectLatestAttempt(attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  if (list.length <= 0) return null;
  return list
    .slice()
    .sort((left, right) => getStartedAt(right) - getStartedAt(left))[0] || null;
}

export function selectLatestRunningAttemptForCurrentConversation(attempts, currentConversationId = '') {
  const list = Array.isArray(attempts)
    ? attempts.filter((attempt) => attempt && attempt.finished !== true)
    : [];
  if (list.length <= 0) return null;

  const normalizedCurrentConversationId = normalizeConversationId(currentConversationId);
  const exactBoundMatches = list.filter((attempt) => (
    normalizeConversationId(attempt?.boundConversationId) === normalizedCurrentConversationId
  ));
  if (exactBoundMatches.length > 0) {
    return selectLatestAttempt(exactBoundMatches);
  }

  const unboundAttempts = list.filter((attempt) => !normalizeConversationId(attempt?.boundConversationId));
  if (!normalizedCurrentConversationId) {
    return selectLatestAttempt(unboundAttempts);
  }

  if (unboundAttempts.length === 1) {
    return unboundAttempts[0] || null;
  }

  return null;
}
