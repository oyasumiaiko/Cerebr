/**
 * 标准 steer 所需的 turn 身份辅助函数。
 *
 * 这里刻意把“attempt -> steer turn identity”的规则抽成纯函数，原因是：
 * - 标准 steer 绑定的是 in-flight turn，而不是最终渲染出来的 assistant 消息；
 * - assistant message id 可能在 turn 中途才生成，不能作为唯一稳定 id；
 * - 我们仍需要兼容历史上已经用 aiMessageId 绑定过的 pending steer。
 */

function normalizeConversationId(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

/**
 * 计算某个 attempt 对应的稳定 steer 目标身份。
 *
 * 规则：
 * - 优先使用 attempt.id 作为主 turnId；它从请求开始到结束都稳定不变；
 * - 若历史中已有“把 aiMessageId 当成 turnId”写入的 steer，则把 aiMessageId 作为 alias 保留，
 *   只用于兼容匹配，不再作为新 steer 的主绑定目标。
 *
 * @param {Object|null|undefined} attemptState
 * @returns {{turnId:string|null, legacyTurnIds:Array<string>, turnStartedAtMs:number|null}}
 */
export function buildAttemptSteerTargetIdentity(attemptState) {
  if (!attemptState || typeof attemptState !== 'object') {
    return {
      turnId: null,
      legacyTurnIds: [],
      turnStartedAtMs: null
    };
  }

  const attemptId = normalizeConversationId(attemptState.id);
  const aiMessageId = normalizeConversationId(attemptState.aiMessageId);
  const turnId = attemptId || aiMessageId || null;
  const legacyTurnIds = [];

  if (aiMessageId && aiMessageId !== turnId) {
    legacyTurnIds.push(aiMessageId);
  }

  return {
    turnId,
    legacyTurnIds,
    turnStartedAtMs: normalizeTimestamp(attemptState.startedAt)
  };
}

/**
 * 生成用于匹配 pending steer 的 turnId 候选集合。
 *
 * @param {Object|null|undefined} attemptState
 * @returns {{turnIds:Array<string>, turnStartedAtMs:number|null}}
 */
export function buildPendingSteerMatchOptionsForAttempt(attemptState) {
  const identity = buildAttemptSteerTargetIdentity(attemptState);
  const turnIds = [];

  if (identity.turnId) {
    turnIds.push(identity.turnId);
  }
  identity.legacyTurnIds.forEach((turnId) => {
    if (!turnId || turnIds.includes(turnId)) return;
    turnIds.push(turnId);
  });

  return {
    turnIds,
    turnStartedAtMs: identity.turnStartedAtMs
  };
}
