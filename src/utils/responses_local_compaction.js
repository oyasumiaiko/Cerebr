/**
 * Responses 本地上下文压缩相关纯函数。
 *
 * 设计目标：
 * - 将“本地 compact”涉及的 wire 规则、历史 marker 规则集中管理；
 * - 让 `api_settings.js`、`message_sender.js`、`message_composer.js` 共享同一套实现，
 *   避免各处再各写一份 endpoint 推导 / body 投影 / marker 判断逻辑；
 * - 全部保持为 JSON 友好的纯函数，方便单元测试与后续扩展。
 */

export const RESPONSES_LOCAL_COMPACTION_SOURCE = 'responses_local';

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

function sanitizeCompactFunctionOutputPayload(output) {
  return cloneJsonValue(output);
}

function sanitizeCompactReplayInputItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const cloned = cloneJsonValue(item);
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) return null;

  const type = String(cloned.type || '').trim().toLowerCase();
  if (type === 'function_call_output' || type === 'custom_tool_call_output') {
    cloned.output = sanitizeCompactFunctionOutputPayload(cloned.output);
  }
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
 * - 当前只保留“手动 `/compact`”相关设置；
 * - 独立 compact 端点可显式覆盖；为空时回退到当前 Responses endpoint + `/compact`；
 * - 旧版自动 compact 配置（例如 enabled / thresholdPromptTokens）在这里直接丢弃，
 *   避免继续污染新的手动模式语义。
 *
 * @param {any} raw
 * @returns {{endpointUrl:string}|null}
 */
export function normalizeResponsesLocalCompactionSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const endpointUrl = (typeof (raw.endpointUrl ?? raw.compactEndpointUrl ?? raw.endpoint_url ?? raw.compact_endpoint_url) === 'string')
    ? String(raw.endpointUrl ?? raw.compactEndpointUrl ?? raw.endpoint_url ?? raw.compact_endpoint_url).trim()
    : '';
  if (!endpointUrl) {
    return null;
  }

  return {
    endpointUrl
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
 * 解析 compact 实际请求端点。
 *
 * 优先级：
 * - 若 API 页面为 compact 单独配置了端点，则优先使用它；
 * - 否则回退到当前 Responses endpoint 并在末尾追加 `/compact`。
 *
 * @param {any} baseUrl
 * @param {any} explicitCompactEndpointUrl
 * @returns {string}
 */
export function resolveResponsesCompactEndpointUrl(baseUrl, explicitCompactEndpointUrl) {
  const explicit = (typeof explicitCompactEndpointUrl === 'string') ? explicitCompactEndpointUrl.trim() : '';
  return buildResponsesCompactEndpointUrl(explicit || baseUrl);
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
    projected.input = sanitizeCompactReplayInputItems(inputItems);
  }

  return projected;
}

/**
 * 对 compact 请求应用显式 instructions 覆盖策略。
 *
 * 设计目标：
 * - compact 不应继续沿用“聊天发送链路里抽离出来的 system 指令”，否则会把用户自定义角色、
 *   全局模板、甚至别的模型人格一股脑带进 `/responses/compact`；
 * - 这里允许调用方在 compact 专用路径上覆盖成一份稳定的 instructions，或者显式删除。
 *
 * @param {any} requestBody
 * @param {string|null|undefined} instructionsText
 * @returns {Object}
 */
export function applyResponsesCompactInstructionsOverride(requestBody, instructionsText) {
  const source = (requestBody && typeof requestBody === 'object' && !Array.isArray(requestBody))
    ? requestBody
    : {};
  const nextBody = cloneJsonValue(source) || {};
  const normalizedInstructions = (typeof instructionsText === 'string')
    ? instructionsText.trim()
    : '';
  if (normalizedInstructions) {
    nextBody.instructions = normalizedInstructions;
  } else {
    delete nextBody.instructions;
  }
  return nextBody;
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
