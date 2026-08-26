/**
 * Responses 本地上下文压缩相关纯函数。
 *
 * 设计目标：
 * - 将 Responses compact v2 的 wire 规则、历史替换规则与本地 marker 规则集中管理；
 * - 让 `api_settings.js`、`message_sender.js`、`message_composer.js` 共享同一套实现，
 *   避免各处再各写一份 request body / SSE 校验 / marker 判断逻辑；
 * - 全部保持为 JSON 友好的纯函数，方便单元测试与后续扩展。
 */

export const RESPONSES_LOCAL_COMPACTION_SOURCE = 'responses_local';
export const RESPONSES_COMPACT_V2_BETA_FEATURE = 'remote_compaction_v2';
export const RESPONSES_COMPACT_V2_RETAINED_MESSAGE_TOKEN_BUDGET = 64_000;
export const RESPONSES_COMPACT_V2_MAX_RETAINED_AGENT_MESSAGE_TOKENS = 10_000;

const RESPONSES_COMPACT_V2_HIDDEN_USER_PREFIXES = Object.freeze([
  '<environment_context>',
  '<page_runtime_context',
  '<skill_context>'
]);

function cloneJsonValue(value) {
  if (value == null) return value ?? null;
  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(value);
    }
  } catch (_) {}

  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return null;
  }
}

function estimateJsonSerializedBytes(value) {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') return Number.POSITIVE_INFINITY;
    if (typeof TextEncoder === 'function') {
      return new TextEncoder().encode(serialized).length;
    }
    return serialized.length;
  } catch (_) {
    return Number.POSITIVE_INFINITY;
  }
}

function truncateCompactText(text, maxChars) {
  const content = (typeof text === 'string') ? text : String(text ?? '');
  const normalizedMaxChars = normalizePositiveInteger(maxChars);
  if (!content || normalizedMaxChars == null) return content;

  const chars = Array.from(content);
  if (chars.length <= normalizedMaxChars) return content;

  const notice = '[... compact truncated ...]';
  const noticeChars = Array.from(notice);
  if (normalizedMaxChars <= noticeChars.length + 2) {
    return chars.slice(0, normalizedMaxChars).join('');
  }

  const remaining = normalizedMaxChars - noticeChars.length;
  const prefixChars = Math.ceil(remaining / 2);
  const suffixChars = Math.max(0, remaining - prefixChars);
  return [
    chars.slice(0, prefixChars).join(''),
    notice,
    chars.slice(chars.length - suffixChars).join('')
  ].join('');
}

function estimateUtf8Bytes(value) {
  const text = (typeof value === 'string') ? value : String(value ?? '');
  if (typeof TextEncoder === 'function') {
    return new TextEncoder().encode(text).length;
  }
  return text.length;
}

function createResponsesCompactV2Error(message, options = {}) {
  const error = new Error(message);
  error.name = 'ResponsesCompactV2Error';
  error.code = (typeof options.code === 'string' && options.code.trim())
    ? options.code.trim()
    : 'responses_compact_v2_error';
  error.retryable = options.retryable === true;
  if (Number.isFinite(Number(options.status))) {
    error.status = Number(options.status);
  }
  return error;
}

function sanitizeCompactReplayInputItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const cloned = cloneJsonValue(item);
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) return null;

  const type = String(cloned.type || '').trim().toLowerCase();
  if (type === 'compaction_trigger') return null;
  return cloned;
}

function sanitizeCompactReplayInputItems(items) {
  return (Array.isArray(items) ? items : [])
    .map(item => sanitizeCompactReplayInputItem(item))
    .filter(Boolean);
}

function buildCompactRequestSummaryObject(requestBody) {
  const source = (requestBody && typeof requestBody === 'object' && !Array.isArray(requestBody))
    ? requestBody
    : {};
  const input = Array.isArray(source.input) ? source.input : [];
  let functionCallOutputCount = 0;
  let functionCallOutputBytes = 0;
  let maxFunctionCallOutputBytes = 0;

  input.forEach((item) => {
    const type = String(item?.type || '').trim().toLowerCase();
    if (type !== 'function_call_output' && type !== 'custom_tool_call_output') return;
    functionCallOutputCount += 1;
    const size = estimateJsonSerializedBytes(item?.output);
    if (!Number.isFinite(size) || size <= 0) return;
    functionCallOutputBytes += size;
    if (size > maxFunctionCallOutputBytes) {
      maxFunctionCallOutputBytes = size;
    }
  });

  return {
    serializedBytes: estimateJsonSerializedBytes(source),
    inputCount: input.length,
    compactionTriggerCount: input.filter(item => String(item?.type || '').trim().toLowerCase() === 'compaction_trigger').length,
    functionCallOutputCount,
    functionCallOutputBytes,
    maxFunctionCallOutputBytes,
    toolCount: Array.isArray(source.tools) ? source.tools.length : 0
  };
}

function formatCompactRequestSummary(summary) {
  const normalized = (summary && typeof summary === 'object') ? summary : {};
  return [
    `serialized_bytes=${Number.isFinite(Number(normalized.serializedBytes)) ? Number(normalized.serializedBytes) : '?'}`,
    `input_count=${Number.isFinite(Number(normalized.inputCount)) ? Number(normalized.inputCount) : '?'}`,
    `compaction_trigger_count=${Number.isFinite(Number(normalized.compactionTriggerCount)) ? Number(normalized.compactionTriggerCount) : '?'}`,
    `function_call_output_count=${Number.isFinite(Number(normalized.functionCallOutputCount)) ? Number(normalized.functionCallOutputCount) : '?'}`,
    `function_call_output_bytes=${Number.isFinite(Number(normalized.functionCallOutputBytes)) ? Number(normalized.functionCallOutputBytes) : '?'}`,
    `max_function_call_output_bytes=${Number.isFinite(Number(normalized.maxFunctionCallOutputBytes)) ? Number(normalized.maxFunctionCallOutputBytes) : '?'}`,
    `tool_count=${Number.isFinite(Number(normalized.toolCount)) ? Number(normalized.toolCount) : '?'}`
  ].join(', ');
}

function sanitizeCompactReasoningConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cloned = cloneJsonValue(value);
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) return null;

  const sanitized = {};
  if (Object.prototype.hasOwnProperty.call(cloned, 'effort')) {
    sanitized.effort = cloned.effort;
  }
  if (Object.prototype.hasOwnProperty.call(cloned, 'summary')) {
    sanitized.summary = cloned.summary;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function sanitizeCompactTextConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const verbosity = (typeof value.verbosity === 'string' && value.verbosity.trim())
    ? value.verbosity.trim()
    : '';
  return verbosity ? { verbosity } : null;
}

function normalizePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.max(1, Math.floor(parsed));
  return Number.isFinite(normalized) ? normalized : null;
}

/**
 * 从普通 `/responses` 请求构造 Codex 同款 compact v2 请求体。
 *
 * 关键协议：
 * - 仍然发送到原 `/responses` endpoint；
 * - 使用与正常 turn 相同的 instructions、工具和推理设置；
 * - 清除旧 `compaction_trigger` 后，在 input 末尾追加且只追加一个 trigger；
 * - 强制 SSE，因为 v2 的成功边界是 `response.output_item.done(type=compaction)`
 *   与随后的 `response.completed`，不能把 `[DONE]` 或连接关闭当成成功。
 *
 * @param {any} requestBody
 * @returns {Object}
 */
export function buildResponsesCompactV2RequestBody(requestBody) {
  const source = (requestBody && typeof requestBody === 'object' && !Array.isArray(requestBody))
    ? requestBody
    : {};
  const projected = {};

  [
    'model',
    'instructions',
    'tools',
    'stream_options',
    'service_tier',
    'prompt_cache_key',
    'prompt_cache_options',
    'client_metadata'
  ].forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(source, key)) return;
    const cloned = cloneJsonValue(source[key]);
    if (typeof cloned === 'undefined' || (cloned === null && source[key] == null)) return;
    projected[key] = cloned;
  });

  const reasoning = sanitizeCompactReasoningConfig(source.reasoning);
  if (reasoning) {
    projected.reasoning = reasoning;
  }

  const text = sanitizeCompactTextConfig(source.text);
  if (text) {
    projected.text = text;
  }

  const include = (Array.isArray(source.include) ? source.include : [])
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => value.trim());
  if (!include.includes('reasoning.encrypted_content')) {
    include.push('reasoning.encrypted_content');
  }
  projected.include = [...new Set(include)];
  projected.parallel_tool_calls = source.parallel_tool_calls === true;
  projected.store = source.store === true;
  projected.tool_choice = 'auto';
  projected.stream = true;
  projected.input = sanitizeCompactReplayInputItems(source.input);
  projected.input.push({ type: 'compaction_trigger' });
  return projected;
}

export function summarizeResponsesCompactRequestBody(requestBody) {
  return buildCompactRequestSummaryObject(requestBody);
}

/**
 * 构造 compact v2 所需的 Codex 协议头。
 *
 * Cerebr 没有 Codex 的 installation/window 状态机，因此这里只发送服务端识别 v2 所需、
 * 且能被当前会话真实表达的请求种类和 compaction 语义；不会伪造线程或窗口标识。
 *
 * @returns {Object<string,string>}
 */
export function buildResponsesCompactV2RequestHeaders() {
  return {
    Accept: 'text/event-stream',
    'x-codex-beta-features': RESPONSES_COMPACT_V2_BETA_FEATURE,
    'x-codex-turn-metadata': JSON.stringify({
      request_kind: 'compaction',
      compaction: {
        trigger: 'manual',
        reason: 'user_requested',
        implementation: 'responses_compaction_v2',
        phase: 'standalone_turn',
        strategy: 'memento'
      }
    })
  };
}

function parseResponsesSseEventBlocks(rawText) {
  const text = (typeof rawText === 'string') ? rawText : '';
  const events = [];
  let eventName = '';
  let dataLines = [];

  const flush = () => {
    if (!eventName && dataLines.length === 0) return;
    events.push({ event: eventName, data: dataLines.join('\n').trim() });
    eventName = '';
    dataLines = [];
  };

  text.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line) => {
    if (line === '') {
      flush();
      return;
    }
    if (line.startsWith(':')) return;
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      return;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  });
  flush();
  return events;
}

function readResponsesErrorMessage(payload, fallback) {
  const candidates = [
    payload?.error?.message,
    payload?.response?.error?.message,
    payload?.message,
    fallback
  ];
  return candidates.find(value => typeof value === 'string' && value.trim())?.trim()
    || 'Responses compact v2 请求失败';
}

function readResponsesErrorCode(payload) {
  const value = payload?.error?.code ?? payload?.response?.error?.code ?? payload?.code;
  return (typeof value === 'string' && value.trim()) ? value.trim().toLowerCase() : '';
}

function isRetryableResponsesErrorCode(code) {
  return [
    'server_error',
    'rate_limit_exceeded',
    'service_unavailable',
    'timeout',
    'temporarily_unavailable'
  ].includes(String(code || '').trim().toLowerCase());
}

/**
 * 解析并严格校验 compact v2 SSE。
 *
 * 与 Codex 一致：允许同时出现其它 output item，但必须在 `response.completed` 前恰好收到
 * 一个 `response.output_item.done` 的 compaction item。连接关闭、`[DONE]`、零个或多个
 * compaction item 都不是成功。
 *
 * @param {string} rawText
 * @param {{status?:number, requestSummary?:Object}} [options]
 * @returns {{compactionOutput:Object,responseId:string|null,usage:Object|null,outputItemCount:number,compactionCount:number,responseBytes:number,eventCount:number}}
 */
export function parseResponsesCompactV2SseText(rawText, options = {}) {
  const normalizedOptions = (options && typeof options === 'object') ? options : {};
  const responseText = (typeof rawText === 'string') ? rawText : '';
  const trimmedResponseText = responseText.trim();
  const status = Number.isFinite(Number(normalizedOptions.status)) ? Number(normalizedOptions.status) : null;
  const summaryText = formatCompactRequestSummary(normalizedOptions.requestSummary);

  if (!trimmedResponseText) {
    throw createResponsesCompactV2Error(
      `Responses compact v2 返回空 SSE（HTTP ${status ?? '?'}）。请求摘要：${summaryText}`,
      { code: 'responses_compact_v2_empty_stream', retryable: true, status }
    );
  }

  const events = parseResponsesSseEventBlocks(responseText);
  let outputItemCount = 0;
  let compactionCount = 0;
  let compactionOutput = null;
  let sawCompleted = false;
  let responseId = null;
  let usage = null;

  for (const event of events) {
    if (!event.data || event.data === '[DONE]') continue;
    let payload = null;
    try {
      payload = JSON.parse(event.data);
    } catch (error) {
      throw createResponsesCompactV2Error(
        `Responses compact v2 SSE JSON 解析失败：${error?.message || 'invalid json'}。`
        + ` HTTP ${status ?? '?'}，请求摘要：${summaryText}，事件片段：${truncateCompactText(event.data, 240)}`,
        { code: 'responses_compact_v2_invalid_sse_json', retryable: false, status }
      );
    }

    const eventType = String(payload?.type || event.event || '').trim().toLowerCase();
    if (eventType === 'error' || eventType === 'response.failed' || eventType === 'response.incomplete') {
      const errorCode = readResponsesErrorCode(payload);
      throw createResponsesCompactV2Error(
        readResponsesErrorMessage(payload, `Responses compact v2 收到 ${eventType}`),
        {
          code: errorCode || eventType.replace(/\./g, '_'),
          retryable: isRetryableResponsesErrorCode(errorCode),
          status
        }
      );
    }

    if (eventType === 'response.output_item.done') {
      outputItemCount += 1;
      const item = payload?.item;
      const itemType = String(item?.type || '').trim().toLowerCase();
      if (itemType === 'compaction' || itemType === 'compaction_summary') {
        compactionCount += 1;
        if (!compactionOutput) {
          compactionOutput = cloneJsonValue(item);
          compactionOutput.type = 'compaction';
        }
      }
      continue;
    }

    if (eventType === 'response.completed') {
      sawCompleted = true;
      responseId = (typeof payload?.response?.id === 'string' && payload.response.id)
        ? payload.response.id
        : ((typeof payload?.response_id === 'string' && payload.response_id) ? payload.response_id : null);
      usage = cloneJsonValue(payload?.response?.usage || payload?.usage || null);
      break;
    }
  }

  if (!sawCompleted) {
    throw createResponsesCompactV2Error(
      'Responses compact v2 stream closed before response.completed',
      { code: 'responses_compact_v2_stream_incomplete', retryable: true, status }
    );
  }

  if (compactionCount !== 1) {
    throw createResponsesCompactV2Error(
      `Responses compact v2 预期恰好一个 compaction output item，实际 ${compactionCount} 个（全部 output item ${outputItemCount} 个）`,
      { code: 'responses_compact_v2_invalid_output_count', retryable: false, status }
    );
  }

  return {
    compactionOutput,
    responseId,
    usage,
    outputItemCount,
    compactionCount,
    responseBytes: estimateUtf8Bytes(responseText),
    eventCount: events.length
  };
}

function readMessageContentTextParts(item) {
  const content = item?.content;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .map(part => {
      if (!part || typeof part !== 'object') return '';
      return (typeof part.text === 'string') ? part.text : '';
    })
    .filter(Boolean);
}

function approximateTokenCount(text) {
  const content = (typeof text === 'string') ? text : String(text ?? '');
  if (!content) return 0;
  const bytes = (typeof TextEncoder === 'function')
    ? (new TextEncoder()).encode(content).length
    : content.length;
  return Math.ceil(bytes / 4);
}

function approximateMessageTokenCount(item) {
  const textTokens = readMessageContentTextParts(item)
    .reduce((total, text) => total + approximateTokenCount(text), 0);
  return Math.max(1, textTokens);
}

function isHiddenResponsesContextUserMessage(item) {
  const text = readMessageContentTextParts(item).join('\n').trimStart().toLowerCase();
  return RESPONSES_COMPACT_V2_HIDDEN_USER_PREFIXES.some(prefix => text.startsWith(prefix));
}

function truncateTextToApproximateTokenBudget(text, maxTokens) {
  const content = (typeof text === 'string') ? text : String(text ?? '');
  const normalizedMaxTokens = Math.max(0, Math.floor(Number(maxTokens) || 0));
  if (!content || normalizedMaxTokens <= 0) return '';
  const byteBudget = normalizedMaxTokens * 4;
  const encoder = (typeof TextEncoder === 'function') ? new TextEncoder() : null;
  const byteLength = value => encoder ? encoder.encode(value).length : value.length;
  if (byteLength(content) <= byteBudget) return content;

  const chars = Array.from(content);
  const notice = '\u2026';
  let prefix = '';
  let suffix = '';
  let left = 0;
  let right = chars.length - 1;
  let takeFromLeft = true;
  while (left <= right) {
    const candidate = takeFromLeft
      ? `${prefix}${chars[left]}${notice}${suffix}`
      : `${prefix}${notice}${chars[right]}${suffix}`;
    if (byteLength(candidate) > byteBudget) break;
    if (takeFromLeft) {
      prefix += chars[left];
      left += 1;
    } else {
      suffix = chars[right] + suffix;
      right -= 1;
    }
    takeFromLeft = !takeFromLeft;
  }
  return `${prefix}${notice}${suffix}`;
}

function truncateMessageToApproximateTokenBudget(item, maxTokens) {
  const cloned = cloneJsonValue(item);
  if (!cloned || maxTokens <= 0) return null;
  let remaining = Math.max(0, Math.floor(maxTokens));

  if (typeof cloned.content === 'string') {
    cloned.content = truncateTextToApproximateTokenBudget(cloned.content, remaining);
    return cloned.content ? cloned : null;
  }
  if (!Array.isArray(cloned.content)) return cloned;

  const content = [];
  for (const part of cloned.content) {
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text !== 'string') {
      content.push(part);
      continue;
    }
    if (remaining <= 0) continue;
    const nextPart = cloneJsonValue(part);
    nextPart.text = truncateTextToApproximateTokenBudget(part.text, remaining);
    if (!nextPart.text) continue;
    content.push(nextPart);
    remaining = Math.max(0, remaining - approximateTokenCount(nextPart.text));
  }
  cloned.content = content;
  return content.length > 0 ? cloned : null;
}

function isRetainedResponsesCompactV2InputItem(item, maxRetainedAgentMessageTokens) {
  const type = String(item?.type || '').trim().toLowerCase();
  if (type === 'agent_message') {
    const text = readMessageContentTextParts(item).join('\n');
    return !text.startsWith('Message Type: FINAL_ANSWER\n')
      && approximateMessageTokenCount(item) <= maxRetainedAgentMessageTokens;
  }
  if (type !== 'message') return false;
  if (String(item?.role || '').trim().toLowerCase() !== 'user') return false;
  return !isHiddenResponsesContextUserMessage(item);
}

/**
 * 按 Codex compact v2 的 replacement-history 规则重建后续 Responses input。
 *
 * 只保留真实 user 消息（以及未来可能出现的非 final agent_message），丢弃旧 assistant、工具、
 * reasoning、隐藏环境消息和旧 compaction，最后追加本次服务端返回的新 compaction item。
 * 保留消息从最新向前占用 64K 近似 token 预算，避免长期多次 compact 后 user 历史无限增长。
 *
 * @param {Array<any>} promptInput
 * @param {Object} compactionOutput
 * @param {{retainedMessageTokenBudget?:number,maxRetainedAgentMessageTokens?:number}} [options]
 * @returns {Array<Object>}
 */
export function buildResponsesCompactV2ReplacementHistory(promptInput, compactionOutput, options = {}) {
  if (String(compactionOutput?.type || '').trim().toLowerCase() !== 'compaction') {
    throw createResponsesCompactV2Error(
      'Responses compact v2 replacement history 缺少合法的 compaction item',
      { code: 'responses_compact_v2_missing_compaction_item', retryable: false }
    );
  }

  const retainedMessageTokenBudget = normalizePositiveInteger(options.retainedMessageTokenBudget)
    || RESPONSES_COMPACT_V2_RETAINED_MESSAGE_TOKEN_BUDGET;
  const maxRetainedAgentMessageTokens = normalizePositiveInteger(options.maxRetainedAgentMessageTokens)
    || RESPONSES_COMPACT_V2_MAX_RETAINED_AGENT_MESSAGE_TOKENS;
  const retainedCandidates = sanitizeCompactReplayInputItems(promptInput)
    .filter(item => isRetainedResponsesCompactV2InputItem(item, maxRetainedAgentMessageTokens));

  let remaining = retainedMessageTokenBudget;
  const retainedReversed = [];
  for (let index = retainedCandidates.length - 1; index >= 0; index -= 1) {
    if (remaining <= 0) break;
    const item = retainedCandidates[index];
    const tokenCount = approximateMessageTokenCount(item);
    if (tokenCount <= remaining) {
      retainedReversed.push(cloneJsonValue(item));
      remaining -= tokenCount;
      continue;
    }
    const truncated = truncateMessageToApproximateTokenBudget(item, remaining);
    if (truncated) retainedReversed.push(truncated);
    remaining = 0;
  }

  retainedReversed.reverse();
  retainedReversed.push(cloneJsonValue(compactionOutput));
  return retainedReversed;
}

export function isResponsesCompactV2RetryableError(error) {
  return error?.retryable === true;
}

/**
 * 判断一个节点是否是可用于“截断模型可见历史”的 compact marker。
 *
 * 只有同时满足以下条件才视为有效：
 * - 含有本地 compact marker 元信息；
 * - 挂着一批可再次放进 Responses input 的 `response_input_items`。
 *
 * @param {any} node
 * @returns {boolean}
 */
export function isUsableResponsesLocalCompactionMarker(node) {
  const marker = node?.contextCompactionMarker;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return false;
  if (marker.source !== RESPONSES_LOCAL_COMPACTION_SOURCE) return false;
  return Array.isArray(node?.response_input_items) && node.response_input_items.length > 0;
}

/**
 * 获取当前链路里“最新可用 compact marker”的索引。
 *
 * @param {any} chain
 * @returns {number}
 */
export function getLatestResponsesLocalCompactionMarkerIndex(chain) {
  const source = Array.isArray(chain) ? chain : [];
  for (let index = source.length - 1; index >= 0; index -= 1) {
    if (isUsableResponsesLocalCompactionMarker(source[index])) {
      return index;
    }
  }
  return -1;
}

/**
 * 在不改 UI 可见历史的前提下，裁出“当前仍应进入模型上下文”的有效链。
 *
 * 规则：
 * - 若不存在 compact marker，返回原链；
 * - 若存在多个，只有最新 marker 及其之后的消息仍参与 prompt 构造；
 * - marker 自身依靠 `response_input_items` 承载 compact 后 replacement history。
 *
 * @param {any} chain
 * @returns {Array<any>}
 */
export function sliceConversationChainAfterLatestCompactionMarker(chain) {
  const source = Array.isArray(chain) ? chain : [];
  const markerIndex = getLatestResponsesLocalCompactionMarkerIndex(source);
  if (markerIndex < 0) return source.slice();
  return source.slice(markerIndex);
}

function readPromptTokens(node) {
  const raw = node?.apiUsage?.promptTokens;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * 在“有效链”里寻找最近一条带 promptTokens 的真实 assistant 消息。
 *
 * @param {any} chain
 * @returns {{node:Object, promptTokens:number}|null}
 */
export function findLatestAssistantPromptTokenEntry(chain) {
  const effectiveChain = sliceConversationChainAfterLatestCompactionMarker(chain);
  for (let index = effectiveChain.length - 1; index >= 0; index -= 1) {
    const node = effectiveChain[index];
    if (!node || node.role !== 'assistant') continue;
    if (isUsableResponsesLocalCompactionMarker(node)) continue;
    const promptTokens = readPromptTokens(node);
    if (promptTokens == null) continue;
    return { node, promptTokens };
  }
  return null;
}

/**
 * 构造 compact marker 元信息。
 *
 * @param {Object} options
 * @returns {{source:string, sourceAssistantMessageId:string|null, promptTokensBefore:number|null, compactedAt:number|null}}
 */
export function buildResponsesLocalCompactionMarker(options = {}) {
  const normalizedOptions = (options && typeof options === 'object') ? options : {};
  const sourceAssistantMessageId = (typeof normalizedOptions.sourceAssistantMessageId === 'string'
    && normalizedOptions.sourceAssistantMessageId.trim())
    ? normalizedOptions.sourceAssistantMessageId.trim()
    : null;
  const promptTokensBefore = normalizePositiveInteger(normalizedOptions.promptTokensBefore);
  const compactedAt = Number.isFinite(Number(normalizedOptions.compactedAt))
    ? Number(normalizedOptions.compactedAt)
    : Date.now();

  return {
    source: RESPONSES_LOCAL_COMPACTION_SOURCE,
    sourceAssistantMessageId,
    promptTokensBefore,
    compactedAt
  };
}
