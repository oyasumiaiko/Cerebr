/**
 * 对话运行态存储。
 *
 * 设计目标：
 * - 只保存“当前会话 / 当前 turn 的运行态”，不承担长期持久化；
 * - 不引用 DOM，不把展开状态、测量结果等 view-local 状态混入这里；
 * - 提供极小 API，后续 queue / steer 可继续沿此层扩展，而不是再把状态散落回 DOM。
 */

function cloneRuntimeData(value) {
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

function normalizeConversationRuntimeId(conversationId) {
  if (conversationId == null) return '';
  const normalized = String(conversationId).trim();
  return normalized;
}

function createDefaultActiveTurnState() {
  return {
    attemptId: null,
    jobId: null,
    status: 'idle',
    startedAt: null,
    boundAssistantMessageId: null,
    preResponseStatus: null,
    // 仅表示“真实 answer 正文是否已经开始可见”，
    // 不把 reasoning / commentary / 工具活动 / 状态占位文案算进去。
    hasVisibleAnswerStarted: false,
    writeMode: null,
    conversationRevisionAtStart: null
  };
}

function createDefaultResponsesState() {
  return {
    accumulatedInputItems: [],
    accumulatedTimeline: [],
    assistantPhase: null,
    lastResponseId: null
  };
}

function createDefaultQueueState() {
  return {
    jobs: [],
    isFlushing: false,
    pausedHeadId: null,
    pendingMutation: null
  };
}

function createDefaultSteerState() {
  return {
    pendingSteers: [],
    targetTurnId: null,
    targetTurnStartedAtMs: null
  };
}

function createDefaultConversationRuntimeState(conversationId) {
  const normalizedConversationId = normalizeConversationRuntimeId(conversationId);
  return {
    conversationId: normalizedConversationId,
    activeTurn: createDefaultActiveTurnState(),
    responses: createDefaultResponsesState(),
    queue: createDefaultQueueState(),
    steer: createDefaultSteerState()
  };
}

function sanitizeConversationRuntimeState(rawState, conversationId) {
  const base = createDefaultConversationRuntimeState(conversationId);
  const state = (rawState && typeof rawState === 'object') ? rawState : {};
  const activeTurn = (state.activeTurn && typeof state.activeTurn === 'object') ? state.activeTurn : {};
  const responses = (state.responses && typeof state.responses === 'object') ? state.responses : {};
  const queue = (state.queue && typeof state.queue === 'object') ? state.queue : {};
  const steer = (state.steer && typeof state.steer === 'object') ? state.steer : {};

  base.activeTurn = {
    attemptId: (typeof activeTurn.attemptId === 'string' && activeTurn.attemptId.trim()) ? activeTurn.attemptId.trim() : null,
    jobId: (typeof activeTurn.jobId === 'string' && activeTurn.jobId.trim()) ? activeTurn.jobId.trim() : null,
    status: (typeof activeTurn.status === 'string' && activeTurn.status.trim()) ? activeTurn.status.trim() : 'idle',
    startedAt: Number.isFinite(Number(activeTurn.startedAt)) ? Number(activeTurn.startedAt) : null,
    boundAssistantMessageId: (typeof activeTurn.boundAssistantMessageId === 'string' && activeTurn.boundAssistantMessageId.trim())
      ? activeTurn.boundAssistantMessageId.trim()
      : null,
    preResponseStatus: (activeTurn.preResponseStatus && typeof activeTurn.preResponseStatus === 'object' && !Array.isArray(activeTurn.preResponseStatus))
      ? cloneRuntimeData(activeTurn.preResponseStatus)
      : null,
    hasVisibleAnswerStarted: activeTurn.hasVisibleAnswerStarted === true,
    writeMode: (activeTurn.writeMode === 'append' || activeTurn.writeMode === 'replace')
      ? activeTurn.writeMode
      : null,
    conversationRevisionAtStart: Number.isFinite(Number(activeTurn.conversationRevisionAtStart))
      ? Number(activeTurn.conversationRevisionAtStart)
      : null
  };

  base.responses = {
    accumulatedInputItems: Array.isArray(responses.accumulatedInputItems)
      ? cloneRuntimeData(responses.accumulatedInputItems)
      : [],
    accumulatedTimeline: Array.isArray(responses.accumulatedTimeline)
      ? cloneRuntimeData(responses.accumulatedTimeline)
      : [],
    assistantPhase: (typeof responses.assistantPhase === 'string' && responses.assistantPhase.trim())
      ? responses.assistantPhase.trim()
      : null,
    lastResponseId: (typeof responses.lastResponseId === 'string' && responses.lastResponseId.trim())
      ? responses.lastResponseId.trim()
      : null
  };

  base.queue = {
    jobs: Array.isArray(queue.jobs) ? cloneRuntimeData(queue.jobs) : [],
    isFlushing: queue.isFlushing === true,
    pausedHeadId: (typeof queue.pausedHeadId === 'string' && queue.pausedHeadId.trim())
      ? queue.pausedHeadId.trim()
      : null,
    pendingMutation: (queue.pendingMutation && typeof queue.pendingMutation === 'object')
      ? cloneRuntimeData(queue.pendingMutation)
      : null
  };

  base.steer = {
    pendingSteers: Array.isArray(steer.pendingSteers) ? cloneRuntimeData(steer.pendingSteers) : [],
    targetTurnId: (typeof steer.targetTurnId === 'string' && steer.targetTurnId.trim())
      ? steer.targetTurnId.trim()
      : null,
    targetTurnStartedAtMs: Number.isFinite(Number(steer.targetTurnStartedAtMs))
      ? Number(steer.targetTurnStartedAtMs)
      : null
  };

  return base;
}

/**
 * 创建对话运行态存储。
 * @returns {{
 *   getConversationRuntimeState: (conversationId: string) => Object,
 *   updateConversationRuntimeState: (conversationId: string, recipe: Function|Object) => Object,
 *   subscribeConversationRuntime: (conversationId: string, listener: Function) => Function,
 *   clearConversationRuntimeState: (conversationId: string) => boolean,
 *   resetConversationTurnRuntime: (conversationId: string) => Object|null
 * }}
 */
export function createConversationRuntimeStore() {
  const stateByConversationId = new Map();
  const listenersByConversationId = new Map();

  function peekStoredState(conversationId) {
    const normalizedConversationId = normalizeConversationRuntimeId(conversationId);
    if (!normalizedConversationId) return null;
    return stateByConversationId.get(normalizedConversationId) || null;
  }

  function ensureStoredState(conversationId) {
    const normalizedConversationId = normalizeConversationRuntimeId(conversationId);
    if (!normalizedConversationId) return null;
    const existing = peekStoredState(normalizedConversationId);
    if (existing) return existing;
    const created = createDefaultConversationRuntimeState(normalizedConversationId);
    stateByConversationId.set(normalizedConversationId, created);
    return created;
  }

  function notifyConversationListeners(conversationId, snapshotOverride = null) {
    const normalizedConversationId = normalizeConversationRuntimeId(conversationId);
    if (!normalizedConversationId) return;
    const listeners = listenersByConversationId.get(normalizedConversationId);
    if (!listeners || listeners.size === 0) return;
    const snapshot = snapshotOverride
      ? sanitizeConversationRuntimeState(cloneRuntimeData(snapshotOverride), normalizedConversationId)
      : getConversationRuntimeState(normalizedConversationId);
    listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (error) {
        console.warn('conversation_runtime_store listener 执行失败:', error);
      }
    });
  }

  function getConversationRuntimeState(conversationId) {
    const normalizedConversationId = normalizeConversationRuntimeId(conversationId);
    if (!normalizedConversationId) {
      return createDefaultConversationRuntimeState('');
    }
    const state = peekStoredState(normalizedConversationId) || createDefaultConversationRuntimeState(normalizedConversationId);
    return sanitizeConversationRuntimeState(cloneRuntimeData(state), normalizedConversationId);
  }

  function updateConversationRuntimeState(conversationId, recipe) {
    const normalizedConversationId = normalizeConversationRuntimeId(conversationId);
    if (!normalizedConversationId) {
      return createDefaultConversationRuntimeState('');
    }

    const currentState = ensureStoredState(normalizedConversationId);
    const draft = sanitizeConversationRuntimeState(cloneRuntimeData(currentState), normalizedConversationId);
    if (typeof recipe === 'function') {
      recipe(draft);
    } else if (recipe && typeof recipe === 'object') {
      Object.assign(draft, recipe);
    }

    const nextState = sanitizeConversationRuntimeState(draft, normalizedConversationId);
    stateByConversationId.set(normalizedConversationId, nextState);
    notifyConversationListeners(normalizedConversationId);
    return getConversationRuntimeState(normalizedConversationId);
  }

  function subscribeConversationRuntime(conversationId, listener) {
    const normalizedConversationId = normalizeConversationRuntimeId(conversationId);
    if (!normalizedConversationId || typeof listener !== 'function') {
      return () => {};
    }
    let listeners = listenersByConversationId.get(normalizedConversationId);
    if (!listeners) {
      listeners = new Set();
      listenersByConversationId.set(normalizedConversationId, listeners);
    }
    listeners.add(listener);
    try {
      listener(getConversationRuntimeState(normalizedConversationId));
    } catch (error) {
      console.warn('conversation_runtime_store listener 初始化失败:', error);
    }
    return () => {
      const currentListeners = listenersByConversationId.get(normalizedConversationId);
      if (!currentListeners) return;
      currentListeners.delete(listener);
      if (currentListeners.size === 0) {
        listenersByConversationId.delete(normalizedConversationId);
      }
    };
  }

  function clearConversationRuntimeState(conversationId) {
    const normalizedConversationId = normalizeConversationRuntimeId(conversationId);
    if (!normalizedConversationId) return false;
    const removed = stateByConversationId.delete(normalizedConversationId);
    if (removed) {
      notifyConversationListeners(
        normalizedConversationId,
        createDefaultConversationRuntimeState(normalizedConversationId)
      );
    }
    return removed;
  }

  function resetConversationTurnRuntime(conversationId) {
    const normalizedConversationId = normalizeConversationRuntimeId(conversationId);
    if (!normalizedConversationId) return null;
    return updateConversationRuntimeState(normalizedConversationId, (draft) => {
      draft.activeTurn = createDefaultActiveTurnState();
      draft.responses = createDefaultResponsesState();
      draft.steer = {
        ...createDefaultSteerState(),
        pendingSteers: Array.isArray(draft.steer?.pendingSteers)
          ? cloneRuntimeData(draft.steer.pendingSteers)
          : []
      };
    });
  }

  return {
    getConversationRuntimeState,
    updateConversationRuntimeState,
    subscribeConversationRuntime,
    clearConversationRuntimeState,
    resetConversationTurnRuntime
  };
}
