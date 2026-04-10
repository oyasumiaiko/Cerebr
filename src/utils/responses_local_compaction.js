/**
 * Responses 本地上下文压缩相关纯函数。
 *
 * 设计目标：
 * - 将“本地 compact”涉及的 wire 规则、历史 marker 规则和自动触发判定集中管理；
 * - 让 `api_settings.js`、`message_sender.js`、`message_composer.js` 共享同一套实现，
 *   避免各处再各写一份 endpoint 推导 / body 投影 / marker 判断逻辑；
 * - 全部保持为 JSON 友好的纯函数，方便单元测试与后续扩展。
 */

export const RESPONSES_LOCAL_COMPACTION_SOURCE = 'responses_local';
export const RESPONSES_LOCAL_COMPACTION_DEFAULT_THRESHOLD = 120000;
export const RESPONSES_LOCAL_COMPACTION_REQUEST_MAX_BYTES = 240000;
export const RESPONSES_LOCAL_COMPACTION_FUNCTION_OUTPUT_TEXT_LIMIT_STEPS = [4000, 2000, 1000, 500];

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

function sanitizeCompactFunctionOutputContentItem(item, maxTextChars) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const cloned = cloneJsonValue(item);
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) return null;

  const type = String(cloned.type || '').trim().toLowerCase();
  if (type === 'input_text' || type === 'output_text') {
    if (typeof cloned.text === 'string') {
      cloned.text = truncateCompactText(cloned.text, maxTextChars);
    }
    return cloned;
  }

  if (type === 'input_image') {
    const imageUrl = (typeof cloned.image_url === 'string') ? cloned.image_url.trim() : '';
    if (/^data:/i.test(imageUrl)) {
      const detailText = (typeof cloned.detail === 'string' && cloned.detail.trim())
        ? ` detail=${cloned.detail.trim()}`
        : '';
      return {
        type: 'input_text',
        text: `[inline image omitted from compact request; source=data-url${detailText}]`
      };
    }
    return cloned;
  }

  return cloned;
}

function sanitizeCompactFunctionOutputPayload(output, maxTextChars) {
  if (typeof output === 'string') {
    return truncateCompactText(output, maxTextChars);
  }
  if (Array.isArray(output)) {
    return output
      .map(item => sanitizeCompactFunctionOutputContentItem(item, maxTextChars))
      .filter(Boolean);
  }
  if (!output || typeof output !== 'object') {
    return cloneJsonValue(output);
  }

  const cloned = cloneJsonValue(output);
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
    return cloned;
  }

  if (typeof cloned.body === 'string') {
    cloned.body = truncateCompactText(cloned.body, maxTextChars);
    return cloned;
  }
  if (Array.isArray(cloned.body)) {
    cloned.body = cloned.body
      .map(item => sanitizeCompactFunctionOutputContentItem(item, maxTextChars))
      .filter(Boolean);
    return cloned;
  }
  if (Array.isArray(cloned.content)) {
    cloned.content = cloned.content
      .map(item => sanitizeCompactFunctionOutputContentItem(item, maxTextChars))
      .filter(Boolean);
    return cloned;
  }
  if (typeof cloned.text === 'string') {
    cloned.text = truncateCompactText(cloned.text, maxTextChars);
  }
  return cloned;
}

function sanitizeCompactReplayInputItem(item, maxTextChars) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const cloned = cloneJsonValue(item);
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) return null;

  const type = String(cloned.type || '').trim().toLowerCase();
  if (type === 'function_call_output' || type === 'custom_tool_call_output') {
    cloned.output = sanitizeCompactFunctionOutputPayload(cloned.output, maxTextChars);
  }
  return cloned;
}

function sanitizeCompactReplayInputItems(items, maxTextChars) {
  return (Array.isArray(items) ? items : [])
    .map(item => sanitizeCompactReplayInputItem(item, maxTextChars))
    .filter(Boolean);
}

function findNextCompactTurnBoundaryIndex(items) {
  const source = Array.isArray(items) ? items : [];
  for (let index = 1; index < source.length; index += 1) {
    const item = source[index];
    if (item?.type === 'message' && item?.role === 'user') {
      return index;
    }
  }
  return -1;
}

function trimCompactInputItemsToRequestBudget(items, baseProjected) {
  let trimmedItems = Array.isArray(items) ? items.slice() : [];
  while (
    trimmedItems.length > 1
    && estimateJsonSerializedBytes({ ...baseProjected, input: trimmedItems })
      > RESPONSES_LOCAL_COMPACTION_REQUEST_MAX_BYTES
  ) {
    const nextBoundaryIndex = findNextCompactTurnBoundaryIndex(trimmedItems);
    if (nextBoundaryIndex > 0) {
      trimmedItems = trimmedItems.slice(nextBoundaryIndex);
      continue;
    }
    trimmedItems = trimmedItems.slice(1);
  }
  return trimmedItems;
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

function normalizePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.max(1, Math.floor(parsed));
  return Number.isFinite(normalized) ? normalized : null;
}

/**
 * 规范化 Responses 本地 compact 设置。
 *
 * 说明：
 * - `enabled` 只控制“发送前自动 compact”；
 * - 手动 `/compact` 不依赖该开关；
 * - 若只保存了 threshold，也允许保留，便于用户先设阈值再开启。
 *
 * @param {any} raw
 * @returns {{enabled:boolean, thresholdPromptTokens:number}|null}
 */
export function normalizeResponsesLocalCompactionSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const thresholdPromptTokens = normalizePositiveInteger(
    raw.thresholdPromptTokens ?? raw.threshold_prompt_tokens
  );
  const enabled = raw.enabled === true;

  if (!enabled && thresholdPromptTokens == null) {
    return null;
  }

  return {
    enabled,
    thresholdPromptTokens: thresholdPromptTokens || RESPONSES_LOCAL_COMPACTION_DEFAULT_THRESHOLD
  };
}

/**
 * 基于当前 `/responses` endpoint 推导 `/responses/compact`。
 *
 * 约束：
 * - 不引入 provider fallback；
 * - 直接在当前 baseUrl 末尾拼接 `/compact`；
 * - 对已经以 `/compact` 结尾的路径保持幂等。
 *
 * @param {any} baseUrl
 * @returns {string}
 */
export function buildResponsesCompactEndpointUrl(baseUrl) {
  const raw = (typeof baseUrl === 'string') ? baseUrl.trim() : '';
  if (!raw) {
    throw new Error('Responses compact 端点推导失败：baseUrl 为空。');
  }

  const trimmed = raw.replace(/\/+$/, '');
  if (/\/compact$/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/compact`;
}

/**
 * 从普通 `/responses` request body 投影出 compact 专用请求体。
 *
 * 只保留 compact 专用端点需要的字段；其它 create-only 字段一律不透传。
 *
 * @param {any} requestBody
 * @returns {Object}
 */
export function buildResponsesCompactRequestBody(requestBody) {
  const source = (requestBody && typeof requestBody === 'object' && !Array.isArray(requestBody))
    ? requestBody
    : {};
  const projected = {};

  [
    'model',
    'input',
    'instructions',
    'tools',
    'parallel_tool_calls',
    'reasoning',
    'text'
  ].forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(source, key)) return;
    const cloned = key === 'reasoning'
      ? sanitizeCompactReasoningConfig(source[key])
      : key === 'input'
        ? null
        : cloneJsonValue(source[key]);
    if (typeof cloned === 'undefined') return;
    if (cloned === null && key === 'reasoning') return;
    if (key !== 'input') {
      projected[key] = cloned;
    }
  });

  if (Object.prototype.hasOwnProperty.call(source, 'input')) {
    const inputItems = Array.isArray(source.input) ? source.input : [];
    const candidateLimits = RESPONSES_LOCAL_COMPACTION_FUNCTION_OUTPUT_TEXT_LIMIT_STEPS;
    let selectedInputItems = sanitizeCompactReplayInputItems(inputItems, candidateLimits[0]);

    for (let index = 0; index < candidateLimits.length; index += 1) {
      const maxTextChars = candidateLimits[index];
      const candidateInputItems = sanitizeCompactReplayInputItems(inputItems, maxTextChars);
      const candidateRequestBody = { ...projected, input: candidateInputItems };
      const candidateBytes = estimateJsonSerializedBytes(candidateRequestBody);
      selectedInputItems = candidateInputItems;
      if (
        candidateBytes <= RESPONSES_LOCAL_COMPACTION_REQUEST_MAX_BYTES
        || index === candidateLimits.length - 1
      ) {
        break;
      }
    }

    projected.input = trimCompactInputItemsToRequestBudget(selectedInputItems, projected);
  }

  return projected;
}

export function summarizeResponsesCompactRequestBody(requestBody) {
  return buildCompactRequestSummaryObject(requestBody);
}

export function parseResponsesCompactResponseText(rawText, options = {}) {
  const normalizedOptions = (options && typeof options === 'object') ? options : {};
  const responseText = (typeof rawText === 'string') ? rawText : '';
  const trimmedResponseText = responseText.trim();
  const status = Number.isFinite(Number(normalizedOptions.status)) ? Number(normalizedOptions.status) : null;
  const contentLength = (() => {
    const raw = normalizedOptions.contentLength;
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    if (Number.isFinite(Number(raw))) return String(Number(raw));
    return '';
  })();
  const summaryText = formatCompactRequestSummary(normalizedOptions.requestSummary);

  if (!trimmedResponseText) {
    throw new Error(
      `Compact 接口返回空响应体（HTTP ${status ?? '?'}${contentLength ? `, content-length=${contentLength}` : ''}）。`
      + ` 请求摘要：${summaryText}`
    );
  }

  try {
    return JSON.parse(trimmedResponseText);
  } catch (error) {
    const preview = truncateCompactText(trimmedResponseText, 240);
    throw new Error(
      `Compact 响应解析失败：${error?.message || 'invalid json'}。`
      + ` HTTP ${status ?? '?'}，请求摘要：${summaryText}，响应片段：${preview}`
    );
  }
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
 * 解析自动 compact 是否应当触发。
 *
 * @param {any} chain
 * @param {any} thresholdPromptTokens
 * @returns {{shouldCompact:boolean, promptTokensBefore:number|null, sourceAssistantMessageId:string|null}}
 */
export function resolveResponsesAutoCompactionDecision(chain, thresholdPromptTokens) {
  const normalizedThreshold = normalizePositiveInteger(thresholdPromptTokens);
  if (normalizedThreshold == null) {
    return {
      shouldCompact: false,
      promptTokensBefore: null,
      sourceAssistantMessageId: null
    };
  }

  const latestEntry = findLatestAssistantPromptTokenEntry(chain);
  if (!latestEntry) {
    return {
      shouldCompact: false,
      promptTokensBefore: null,
      sourceAssistantMessageId: null
    };
  }

  return {
    shouldCompact: latestEntry.promptTokens >= normalizedThreshold,
    promptTokensBefore: latestEntry.promptTokens,
    sourceAssistantMessageId: (typeof latestEntry.node?.id === 'string' && latestEntry.node.id.trim())
      ? latestEntry.node.id.trim()
      : null
  };
}

/**
 * 构造 compact marker 元信息。
 *
 * @param {Object} options
 * @returns {{source:string, sourceAssistantMessageId:string|null, promptTokensBefore:number|null, thresholdPromptTokens:number|null, compactedAt:number|null}}
 */
export function buildResponsesLocalCompactionMarker(options = {}) {
  const normalizedOptions = (options && typeof options === 'object') ? options : {};
  const sourceAssistantMessageId = (typeof normalizedOptions.sourceAssistantMessageId === 'string'
    && normalizedOptions.sourceAssistantMessageId.trim())
    ? normalizedOptions.sourceAssistantMessageId.trim()
    : null;
  const promptTokensBefore = normalizePositiveInteger(normalizedOptions.promptTokensBefore);
  const thresholdPromptTokens = normalizePositiveInteger(normalizedOptions.thresholdPromptTokens);
  const compactedAt = Number.isFinite(Number(normalizedOptions.compactedAt))
    ? Number(normalizedOptions.compactedAt)
    : Date.now();

  return {
    source: RESPONSES_LOCAL_COMPACTION_SOURCE,
    sourceAssistantMessageId,
    promptTokensBefore,
    thresholdPromptTokens,
    compactedAt
  };
}
