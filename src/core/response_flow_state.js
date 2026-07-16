/**
 * 发送响应阶段的纯函数规则：
 * - 统一流式/非流式模式判定；
 * - 统一流式渲染阶段状态机（首帧/增量更新/空事件）。
 *
 * 设计原则：
 * - 只做输入 -> 输出的状态推导，不触发任何副作用；
 * - 便于在 message_sender 中集中处理 DOM/历史写入等副作用。
 */

function normalizeApiBase(value) {
  // 统一做 trim + lowercase，避免调用方传入 " GenAI " 等大小写/空白差异导致规则分叉。
  return (typeof value === 'string') ? value.trim().toLowerCase() : '';
}

function normalizeConnectionType(value) {
  const normalized = (typeof value === 'string') ? value.trim().toLowerCase() : '';
  if (normalized === 'gemini') return 'gemini';
  if (normalized === 'openai_responses') return 'openai_responses';
  if (normalized === 'openai') return 'openai';
  return '';
}

/**
 * 统一判定本次请求应走流式还是非流式。
 *
 * @param {{
 *   apiBase?: string,
 *   connectionType?: 'openai'|'openai_responses'|'gemini',
 *   geminiUseStreaming?: boolean,
 *   requestBodyStream?: boolean
 * }} [input]
 * @returns {'stream'|'non_stream'}
 */
export function resolveResponseHandlingMode(input = {}) {
  const apiBase = normalizeApiBase(input?.apiBase);
  const connectionType = normalizeConnectionType(input?.connectionType);
  const geminiUseStreaming = input?.geminiUseStreaming !== false;
  const requestBodyStream = input?.requestBodyStream === true;

  // Gemini 族接口不依赖 requestBody.stream，而是沿用配置项 useStreaming 作为单一真源。
  if (connectionType === 'gemini') {
    return geminiUseStreaming ? 'stream' : 'non_stream';
  }
  if (connectionType === 'openai' || connectionType === 'openai_responses') {
    return requestBodyStream ? 'stream' : 'non_stream';
  }
  if (apiBase === 'genai') {
    return geminiUseStreaming ? 'stream' : 'non_stream';
  }
  // 其余 OpenAI 兼容接口统一按 requestBody.stream 判定。
  return requestBodyStream ? 'stream' : 'non_stream';
}

function normalizeResponseContentType(value) {
  return (typeof value === 'string') ? value.trim().toLowerCase() : '';
}

/**
 * 根据服务端实际返回的 Content-Type 决定本次响应应如何解析。
 *
 * 设计目标：
 * - “是否向服务端声明 stream=true” 只影响发送侧，不再强绑定解析侧；
 * - 只要服务端实际返回了 SSE（text/event-stream），就统一按流式事件解析；
 * - 若服务端返回 JSON，则统一按非流式 JSON 解析；
 * - 其余不明确类型才回退到请求侧的期望模式。
 *
 * @param {{
 *   requestedMode?: 'stream'|'non_stream',
 *   responseContentType?: string,
 *   hasResponseBody?: boolean
 * }} [input]
 * @returns {'stream'|'non_stream'}
 */
export function resolveReceivedResponseHandlingMode(input = {}) {
  const requestedMode = input?.requestedMode === 'stream' ? 'stream' : 'non_stream';
  const responseContentType = normalizeResponseContentType(input?.responseContentType);
  const hasResponseBody = input?.hasResponseBody !== false;

  if (!hasResponseBody) {
    return 'non_stream';
  }
  if (responseContentType.includes('text/event-stream')) {
    return 'stream';
  }
  if (
    responseContentType.includes('application/json')
    || responseContentType.includes('+json')
    || responseContentType.includes('application/problem+json')
  ) {
    return 'non_stream';
  }
  return requestedMode;
}

/**
 * 统一流式渲染阶段状态机：
 * - 首帧：决定是否执行“占位升级/创建消息”；
 * - 后续帧：决定是否执行“增量更新”以及是否强制刷新；
 * - 空事件：保持状态不变，直接跳过。
 *
 * @param {{
 *   hasDelta?: boolean,
 *   hasStartedResponse?: boolean,
 *   hasMessageId?: boolean,
 *   hasAnswerContent?: boolean,
 *   hasEverShownAnswerContent?: boolean
 * }} [input]
 * @returns {{
 *   action: 'noop'|'first_chunk'|'wait_for_message'|'update_existing',
 *   forceUiUpdate: boolean,
 *   nextState: {
 *     hasStartedResponse: boolean,
 *     hasEverShownAnswerContent: boolean
 *   }
 * }}
 */
export function planStreamingRenderTransition(input = {}) {
  const hasDelta = input?.hasDelta === true;
  const hasStartedResponse = input?.hasStartedResponse === true;
  const hasMessageId = input?.hasMessageId === true;
  const hasAnswerContent = input?.hasAnswerContent === true;
  const hasEverShownAnswerContent = input?.hasEverShownAnswerContent === true;

  // 空事件：不触发任何渲染副作用，状态保持不变（常见于仅携带控制字段/心跳的数据块）。
  if (!hasDelta) {
    return {
      action: 'noop',
      forceUiUpdate: false,
      nextState: {
        hasStartedResponse,
        hasEverShownAnswerContent
      }
    };
  }

  if (!hasStartedResponse) {
    // 首帧：交由调用方执行“原地替换 / 占位升级 / 新建消息”三段式兜底。
    return {
      action: 'first_chunk',
      forceUiUpdate: false,
      nextState: {
        hasStartedResponse: true,
        hasEverShownAnswerContent: hasAnswerContent
      }
    };
  }

  const nextHasEverShownAnswerContent = hasEverShownAnswerContent || hasAnswerContent;
  if (!hasMessageId) {
    // 已有增量但目标消息尚未就绪：先推进状态，避免后续重复按“首帧”路径执行副作用。
    return {
      action: 'wait_for_message',
      forceUiUpdate: false,
      nextState: {
        hasStartedResponse: true,
        hasEverShownAnswerContent: nextHasEverShownAnswerContent
      }
    };
  }

  // 增量更新：当“正文首次出现”时返回 forceUiUpdate=true，确保 UI 立即落地，减少“只看到思考块”的错觉。
  const forceUiUpdate = hasAnswerContent && !hasEverShownAnswerContent;
  return {
    action: 'update_existing',
    forceUiUpdate,
    nextState: {
      hasStartedResponse: true,
      hasEverShownAnswerContent: nextHasEverShownAnswerContent
    }
  };
}

/**
 * Responses SSE 提前关闭时的收尾策略。
 *
 * 关键边界：
 * - reasoning、commentary、工具调用都属于可恢复的中间阶段，断线后可以回滚到本次请求基线并重试；
 * - 只有 final 正文或最终图片已经对用户可见时才停止重试，保留当前部分结果。
 *
 * @param {{
 *   hasTerminalEvent?: boolean,
 *   hasStartedResponse?: boolean,
 *   hasRenderedAssistantMessage?: boolean,
 *   hasVisibleAnswerContent?: boolean
 * }} [input]
 * @returns {'complete'|'retry'|'preserve_partial'}
 */
export function resolveResponsesStreamClosureAction(input = {}) {
  if (input?.hasTerminalEvent === true) {
    return 'complete';
  }

  const hasVisibleAnswerContent = input?.hasVisibleAnswerContent === true;

  if (hasVisibleAnswerContent) {
    return 'preserve_partial';
  }

  return 'retry';
}
