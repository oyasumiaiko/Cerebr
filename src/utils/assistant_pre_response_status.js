/**
 * assistant“正文前状态”统一模型。
 *
 * 目标：
 * - 把“本地请求准备阶段”和“Responses SSE 已进入服务端处理阶段”的文案收口到同一处；
 * - 让 sender 只传阶段，不再到处散落硬编码状态文本；
 * - 为 renderer 提供稳定、可测试的最小状态对象。
 */

function normalizeString(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

export function createAssistantPreResponseStatus(text, stage, options = {}) {
  const normalizedText = normalizeString(text);
  if (!normalizedText) return null;
  const normalizedStage = normalizeString(stage);
  const note = normalizeString(options?.note);
  return {
    text: normalizedText,
    stage: normalizedStage || 'unknown',
    note: note || '',
    showSpinner: options?.showSpinner !== false
  };
}

export function normalizeAssistantPreResponseStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return createAssistantPreResponseStatus(value.text, value.stage, {
    note: value.note,
    showSpinner: value.showSpinner
  });
}

/**
 * 本地请求链路阶段。
 *
 * 设计取向：
 * - 对用户展示时收敛为少量高层阶段，避免同义文案在 UI 里来回抖动；
 * - 但仍保留少数“确实会卡住且值得知道”的页面上下文准备阶段。
 */
export function deriveAssistantPreResponseStatusFromLocalStage(stage, data = {}) {
  const normalizedStage = normalizeString(stage).toLowerCase();
  if (!normalizedStage) return null;

  if (normalizedStage === 'compose_messages') {
    return createAssistantPreResponseStatus('正在准备消息...', normalizedStage);
  }

  if (normalizedStage === 'get_js_runtime_frames') {
    return createAssistantPreResponseStatus(
      '正在准备页面上下文...',
      normalizedStage,
      { note: '需要先读取页面运行环境，再继续发起请求。' }
    );
  }

  if (normalizedStage === 'build_request_body') {
    return createAssistantPreResponseStatus('正在构造请求...', normalizedStage);
  }

  if (
    normalizedStage === 'api_key_file_loaded'
    || normalizedStage === 'api_key_file_load_failed'
    || normalizedStage === 'api_key_file_reload_start'
    || normalizedStage === 'api_key_selected'
    || normalizedStage === 'api_key_omitted'
  ) {
    return createAssistantPreResponseStatus('正在准备请求...', normalizedStage);
  }

  if (normalizedStage === 'http_request_start' || normalizedStage === 'send_request') {
    return createAssistantPreResponseStatus('正在发送请求...', normalizedStage);
  }

  if (normalizedStage === 'responses_retry_wait') {
    const retryAttempt = Number(data?.retryAttempt);
    const maxRetries = Number(data?.maxRetries);
    const suffix = Number.isFinite(retryAttempt) && Number.isFinite(maxRetries)
      ? `（${retryAttempt}/${maxRetries}）`
      : '';
    return createAssistantPreResponseStatus(
      `连接异常，正在重试${suffix}...`,
      normalizedStage,
      { note: '当前 Responses 请求会按原请求体重新发送。' }
    );
  }

  if (
    normalizedStage === 'http_request_sent'
    || normalizedStage === 'http_response_headers_received'
    || normalizedStage === 'response_headers_received'
    || normalizedStage === 'stream_wait_first_token'
    || normalizedStage === 'non_stream_read_body'
  ) {
    return createAssistantPreResponseStatus('请求已发出，等待模型响应...', normalizedStage);
  }

  if (normalizedStage === 'http_429_rate_limited') {
    return createAssistantPreResponseStatus(
      data?.willRetry ? '请求触发限流，正在重试...' : '请求触发限流...',
      normalizedStage
    );
  }

  if (normalizedStage === 'http_400_bad_request_not_blacklisted') {
    return createAssistantPreResponseStatus(
      '请求参数有误，正在读取详情...',
      normalizedStage
    );
  }

  if (normalizedStage === 'http_auth_or_bad_request_key_blacklisted') {
    return createAssistantPreResponseStatus(
      data?.willRetry ? '当前凭证不可用，正在重试...' : '当前凭证不可用...',
      normalizedStage
    );
  }

  if (normalizedStage === 'read_error_body') {
    const httpStatus = Number(data?.httpStatus);
    const suffix = Number.isFinite(httpStatus) ? ` (HTTP ${httpStatus})` : '';
    return createAssistantPreResponseStatus(`服务器返回错误${suffix}，正在读取详情...`, normalizedStage);
  }

  return null;
}

/**
 * 请求阶段事件 -> 正文前状态。
 */
export function deriveAssistantPreResponseStatusFromRequestEvent(event = {}) {
  const normalizedEvent = (event && typeof event === 'object') ? event : {};
  return deriveAssistantPreResponseStatusFromLocalStage(normalizedEvent.stage, normalizedEvent);
}

/**
 * Responses SSE 事件 -> 正文前状态。
 */
export function deriveAssistantPreResponseStatusFromResponsesSse(eventType, data = {}) {
  const type = normalizeString(eventType).toLowerCase();
  if (!type) return null;

  if (type === 'response.created' || type === 'response.in_progress') {
    return createAssistantPreResponseStatus(
      '模型正在思考...',
      'responses_in_progress',
      { note: '服务器已接受请求并开始当前轮处理。' }
    );
  }

  if (
    type === 'response.reasoning_text.delta'
    || type === 'response.reasoning_summary_text.delta'
    || type === 'response.reasoning_text.done'
    || type === 'response.reasoning_summary_text.done'
  ) {
    return createAssistantPreResponseStatus(
      '模型正在思考...',
      'responses_reasoning',
      { note: '服务器已返回推理相关事件。' }
    );
  }

  if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
    return createAssistantPreResponseStatus(
      '模型正在准备工具调用...',
      'responses_function_arguments'
    );
  }

  if (type === 'response.output_text.delta' || type === 'response.output_text.done') {
    return createAssistantPreResponseStatus(
      '模型正在生成回复...',
      'responses_output_text'
    );
  }

  if (type === 'response.completed') {
    return createAssistantPreResponseStatus(
      '正在整理回复...',
      'responses_completed'
    );
  }

  if (type === 'response.output_item.added' || type === 'response.output_item.done') {
    const item = (data?.item && typeof data.item === 'object') ? data.item : null;
    const itemType = normalizeString(item?.type).toLowerCase();
    const itemPhase = normalizeString(item?.phase).toLowerCase();

    if (itemType === 'reasoning' || (itemType === 'message' && itemPhase === 'commentary')) {
      return createAssistantPreResponseStatus(
        '模型正在思考...',
        'responses_reasoning_item'
      );
    }

    if (itemType === 'function_call' || itemType === 'web_search_call' || itemType === 'tool_search_call') {
      return createAssistantPreResponseStatus(
        '模型正在准备工具调用...',
        'responses_tool_call'
      );
    }

    if (itemType === 'message') {
      return createAssistantPreResponseStatus(
        '模型正在生成回复...',
        'responses_message_item'
      );
    }

    return createAssistantPreResponseStatus(
      '服务器正在继续处理当前轮...',
      'responses_output_item'
    );
  }

  return null;
}
