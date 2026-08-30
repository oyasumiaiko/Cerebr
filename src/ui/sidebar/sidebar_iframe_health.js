const SIDEBAR_IFRAME_HEARTBEAT_INTERVAL_MS = 3000;

function normalizeConversationId(value) {
  return (typeof value === 'string' && value.trim()) ? value.trim() : '';
}

/**
 * 从 iframe 内部向宿主页 content script 上报最小健康状态。
 *
 * 这里只携带：
 * - iframe 是否已经完成服务初始化；
 * - 当前打开的 conversationId；
 * - 当前 iframe 中是否仍有生成任务。
 *
 * 消息通过既有私有 MessagePort 传递，不广播到宿主页 window，也不保存消息正文、队列或请求体。
 * 宿主页据此在 iframe 灰屏失联后选择性重载，并在新 iframe 中重新打开同一个持久化对话。
 *
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 */
export function createSidebarIframeHealthReporter(appContext) {
  let runtimeReady = false;
  let heartbeatTimerId = null;
  let unsubscribeStreamingState = null;
  let disposed = false;
  let debugUnresponsive = false;
  let debugActiveTaskOverride = null;

  function buildHeartbeat() {
    const messageSender = appContext.services.messageSender;
    const currentConversationId = normalizeConversationId(
      appContext.services.chatHistoryUI?.getCurrentConversationId?.()
      || messageSender?.getCurrentConversationId?.()
    );
    const streamingConversationIds = messageSender?.getStreamingConversationIds?.();
    const hasActiveTask = debugActiveTaskOverride === null
      ? Array.isArray(streamingConversationIds) && streamingConversationIds.length > 0
      : debugActiveTaskOverride;
    return {
      type: 'SIDEBAR_IFRAME_HEARTBEAT',
      sentAt: Date.now(),
      ready: runtimeReady,
      conversationId: currentConversationId,
      hasActiveTask
    };
  }

  function postHeartbeat() {
    if (disposed || debugUnresponsive || appContext.state.isStandalone) return false;
    return appContext.utils.postHostMessage?.(buildHeartbeat()) === true;
  }

  function reportFocused() {
    if (disposed || appContext.state.isStandalone) return false;
    return appContext.utils.postHostMessage?.({
      type: 'SIDEBAR_IFRAME_FOCUSED',
      sentAt: Date.now()
    }) === true;
  }

  function respondToHealthProbe(probeToken) {
    const normalizedProbeToken = (typeof probeToken === 'string' && probeToken.trim())
      ? probeToken.trim()
      : '';
    if (disposed || debugUnresponsive || appContext.state.isStandalone || !normalizedProbeToken) {
      return false;
    }
    return appContext.utils.postHostMessage?.({
      ...buildHeartbeat(),
      type: 'SIDEBAR_IFRAME_HEALTH_PROBE_RESULT',
      probeToken: normalizedProbeToken
    }) === true;
  }

  function attachServices() {
    if (disposed || runtimeReady) return;
    runtimeReady = true;
    const messageSender = appContext.services.messageSender;
    if (typeof messageSender?.subscribeStreamingConversationState === 'function') {
      unsubscribeStreamingState = messageSender.subscribeStreamingConversationState(() => {
        postHeartbeat();
      });
    }
    postHeartbeat();
  }

  function stopHeartbeat() {
    if (heartbeatTimerId) {
      window.clearInterval(heartbeatTimerId);
      heartbeatTimerId = null;
    }
    try { unsubscribeStreamingState?.(); } catch (_) {}
    unsubscribeStreamingState = null;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stopHeartbeat();
    window.removeEventListener('focus', reportFocused, true);
    window.removeEventListener('pointerdown', reportFocused, true);
    document.removeEventListener('CONVERSATION_API_CONTEXT_CHANGED', postHeartbeat);
  }

  function debugStopAllHealthSignals() {
    debugUnresponsive = true;
    stopHeartbeat();
  }

  function debugSetActiveTaskOverride(value) {
    debugActiveTaskOverride = value === null ? null : value === true;
    return postHeartbeat();
  }

  if (!appContext.state.isStandalone) {
    postHeartbeat();
    heartbeatTimerId = window.setInterval(postHeartbeat, SIDEBAR_IFRAME_HEARTBEAT_INTERVAL_MS);
    window.addEventListener('focus', reportFocused, true);
    window.addEventListener('pointerdown', reportFocused, true);
    document.addEventListener('CONVERSATION_API_CONTEXT_CHANGED', postHeartbeat);
    window.addEventListener('pagehide', dispose, { once: true });
  }

  return {
    attachServices,
    dispose,
    postHeartbeat,
    respondToHealthProbe,
    // 只供本地浏览器回归停止健康信号；焦点通知仍保留，以便真实点击表达“用户现在要用这个实例”。
    __debugStopHeartbeat: debugStopAllHealthSignals,
    __debugSetActiveTaskOverride: debugSetActiveTaskOverride
  };
}
