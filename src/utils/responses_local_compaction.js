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
      : cloneJsonValue(source[key]);
    if (typeof cloned === 'undefined') return;
    if (cloned === null && key === 'reasoning') return;
    projected[key] = cloned;
  });

  return projected;
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
