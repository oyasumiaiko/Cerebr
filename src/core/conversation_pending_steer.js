/**
 * 标准 steer 的纯逻辑辅助函数。
 *
 * 设计目标：
 * - 把“pending steer 属于哪个 turn、何时该被同 turn 吸收、何时该恢复成 queue follow-up”
 *   这类语义从 message_sender 中抽出来，方便单元测试直接校验；
 * - 保持纯函数，不触碰 DOM、不依赖全局 sender 状态；
 * - 让后续如果需要继续向 Codex 的更完整 turn runner 靠拢时，这层仍可复用。
 */

function cloneSteerData(value) {
  if (value == null) return value ?? null;
  try {
    return structuredClone(value);
  } catch (_) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  }
}

function normalizeStringId(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

function normalizeTurnIdList(turnIds) {
  if (!Array.isArray(turnIds)) return [];
  return turnIds
    .map((turnId) => normalizeStringId(turnId))
    .filter(Boolean);
}

/**
 * 判断某条 pending steer 是否属于指定 turn。
 *
 * 对齐 Codex TS 的语义：
 * - 若 steer 已绑定明确的 targetTurnId，则优先按 turnId 严格匹配；
 * - 否则回退到 turnStartedAtMs，解决“旧 turn 已完成但完成通知晚到”的竞态。
 *
 * @param {Object|null|undefined} pendingSteer
 * @param {string|null|undefined} turnId
 * @param {number|null|undefined} turnStartedAtMs
 * @returns {boolean}
 */
export function pendingSteerTargetsTurn(pendingSteer, turnId, turnStartedAtMs) {
  const steerTurnId = normalizeStringId(pendingSteer?.targetTurnId);
  const normalizedTurnId = normalizeStringId(turnId);
  if (steerTurnId != null) {
    return steerTurnId === normalizedTurnId;
  }

  const steerStartedAtMs = normalizeTimestamp(pendingSteer?.targetTurnStartedAtMs);
  const normalizedTurnStartedAtMs = normalizeTimestamp(turnStartedAtMs);
  return (
    steerStartedAtMs != null
    && normalizedTurnStartedAtMs != null
    && steerStartedAtMs === normalizedTurnStartedAtMs
  );
}

/**
 * 将 pending steer 列表按“是否属于当前 turn”拆成两组。
 *
 * @param {Array<any>|null|undefined} pendingSteers
 * @param {{turnId?: string|null, turnStartedAtMs?: number|null}} options
 * @returns {{matched: Array<any>, remaining: Array<any>}}
 */
export function splitPendingSteersByTurn(pendingSteers, options = {}) {
  return splitPendingSteersByTurnIds(pendingSteers, {
    turnIds: [options?.turnId ?? null],
    turnStartedAtMs: options?.turnStartedAtMs ?? null
  });
}

/**
 * 将 pending steer 列表按“是否属于当前 turnId 候选集合”拆成两组。
 *
 * 这里给 message_sender 提供一个低技术债务的能力：
 * - 当前 turn 的稳定身份应该是 request/attempt 级 id；
 * - 但历史上已有一部分 pending steer 可能绑定到了 assistant message id；
 * - 因此在匹配时允许调用方一次给出多个等价 turn id（主 id + 兼容旧写法的 alias）。
 *
 * @param {Array<any>|null|undefined} pendingSteers
 * @param {{turnIds?: Array<string|null|undefined>, turnStartedAtMs?: number|null}} options
 * @returns {{matched: Array<any>, remaining: Array<any>}}
 */
export function splitPendingSteersByTurnIds(pendingSteers, options = {}) {
  const list = Array.isArray(pendingSteers) ? pendingSteers : [];
  const matched = [];
  const remaining = [];
  const turnIds = normalizeTurnIdList(options?.turnIds);
  const turnStartedAtMs = options?.turnStartedAtMs ?? null;

  list.forEach((pendingSteer) => {
    const steerMatched = turnIds.length > 0
      ? turnIds.some((turnId) => pendingSteerTargetsTurn(pendingSteer, turnId, turnStartedAtMs))
      : pendingSteerTargetsTurn(pendingSteer, null, turnStartedAtMs);
    if (steerMatched) {
      matched.push(cloneSteerData(pendingSteer));
    } else {
      remaining.push(cloneSteerData(pendingSteer));
    }
  });

  return { matched, remaining };
}

/**
 * 选择“当前边界可被同 turn 吸收”的 steer。
 *
 * 关键语义：
 * - 只有存在自然 follow-up window（例如工具结果之后的下一跳）时，steer 才能进入同一个 turn；
 * - 如果当前 turn 即将自然结束、没有后续边界，则 steer 继续保持 pending，等待 turn 完成后恢复成 queue follow-up。
 *
 * @param {Array<any>|null|undefined} pendingSteers
 * @param {{turnId?: string|null, turnStartedAtMs?: number|null, hasNaturalFollowUp?: boolean}} options
 * @returns {{accepted: Array<any>, remaining: Array<any>}}
 */
export function collectPendingSteersForFollowUpWindow(pendingSteers, options = {}) {
  const list = Array.isArray(pendingSteers) ? pendingSteers : [];
  if (options?.hasNaturalFollowUp !== true) {
    return {
      accepted: [],
      remaining: list.map((pendingSteer) => cloneSteerData(pendingSteer))
    };
  }

  const { matched, remaining } = splitPendingSteersByTurn(list, options);
  return {
    accepted: matched,
    remaining
  };
}

/**
 * 将“当前 turn 未来得及吸收的 steer”恢复成 queue follow-up job。
 *
 * 这里故意不决定“为什么恢复”，只吃调用方传入的状态：
 * - 正常 completed：恢复成 queued，表示“作为 turn 后的最新 queue 消息继续发送”；
 * - interrupted / error：恢复成 paused，等待用户确认。
 *
 * @param {Object|null|undefined} pendingSteer
 * @param {Object} options
 * @param {() => string} options.createJobId
 * @param {string|null|undefined} [options.conversationId]
 * @param {number|null|undefined} [options.conversationRevisionAtEnqueue]
 * @param {Object|null|undefined} [options.retryPolicy]
 * @param {'queued'|'paused'} [options.status='queued']
 * @param {string|null|undefined} [options.failureMessage]
 * @param {number|null|undefined} [options.createdAt]
 * @returns {Object|null}
 */
export function buildRestoredQueueJobFromPendingSteer(pendingSteer, options = {}) {
  const payload = (pendingSteer && typeof pendingSteer.payload === 'object')
    ? cloneSteerData(pendingSteer.payload)
    : null;
  if (!payload) return null;

  const createJobId = (typeof options.createJobId === 'function')
    ? options.createJobId
    : null;
  if (!createJobId) {
    throw new Error('buildRestoredQueueJobFromPendingSteer requires createJobId');
  }

  const status = options.status === 'paused' ? 'paused' : 'queued';
  const createdAt = normalizeTimestamp(options.createdAt) ?? Date.now();
  const failureMessage = normalizeStringId(options.failureMessage);

  return {
    id: createJobId(),
    kind: 'append_user_message',
    status,
    paused: status === 'paused',
    conversationId: normalizeStringId(options.conversationId) || '',
    conversationRevisionAtEnqueue: Number.isFinite(Number(options.conversationRevisionAtEnqueue))
      ? Math.max(0, Math.floor(Number(options.conversationRevisionAtEnqueue)))
      : 0,
    anchorMessageId: '',
    targetAiMessageId: '',
    payload,
    retryPolicy: cloneSteerData(options.retryPolicy) || null,
    retryCount: 0,
    availableAt: null,
    staleReason: null,
    failureMessage,
    queuedAt: createdAt,
    createdAt
  };
}

/**
 * 批量恢复同一 turn 的 pending steer，顺序保持不变。
 *
 * @param {Array<any>|null|undefined} pendingSteers
 * @param {Object} options 透传给 buildRestoredQueueJobFromPendingSteer
 * @returns {Array<Object>}
 */
export function buildRestoredQueueJobsFromPendingSteers(pendingSteers, options = {}) {
  const list = Array.isArray(pendingSteers) ? pendingSteers : [];
  return list
    .map((pendingSteer) => buildRestoredQueueJobFromPendingSteer(pendingSteer, options))
    .filter(Boolean);
}

/**
 * 根据 turn 的结束状态，决定“未被吸收的 steer”恢复成 queue 时的表现。
 *
 * 这里对齐我们当前要模拟的 Codex 语义：
 * - 正常 completed：恢复成可自动继续发送的 queued follow-up；
 * - interrupted / error：恢复成 paused follow-up，等用户确认。
 *
 * @param {'completed'|'interrupted'|'error'|string|null|undefined} turnOutcome
 * @returns {{status:'queued'|'paused', failureMessage:string|null}}
 */
export function resolvePendingSteerRestoreDisposition(turnOutcome) {
  const normalizedOutcome = normalizeStringId(turnOutcome) || 'error';
  if (normalizedOutcome === 'completed') {
    return {
      status: 'queued',
      failureMessage: null
    };
  }
  if (normalizedOutcome === 'interrupted') {
    return {
      status: 'paused',
      failureMessage: '当前生成在接受转向输入前被中断'
    };
  }
  return {
    status: 'paused',
    failureMessage: '当前生成在接受转向输入前结束'
  };
}
