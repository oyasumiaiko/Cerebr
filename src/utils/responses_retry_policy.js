/**
 * Responses API 请求/流式响应的恢复性重试策略。
 *
 * 设计要点：
 * - 与 Codex 当前策略保持同一个数量级：默认最多重试 5 次，200ms 起步指数退避并加入轻微抖动；
 * - 只把“可能随时间恢复”的错误归为可重试，避免上下文超限、鉴权失败、请求体错误这类确定性问题空转；
 * - 这里保持纯函数，调用方负责 UI 状态、AbortSignal、实际 sleep 和重新发起请求。
 */

export const DEFAULT_RESPONSES_API_MAX_RETRIES = 5;
export const DEFAULT_RESPONSES_API_RETRY_BASE_DELAY_MS = 200;
export const RESPONSES_API_RETRY_JITTER_MIN = 0.9;
export const RESPONSES_API_RETRY_JITTER_MAX = 1.1;

const FATAL_ERROR_MARKERS = Object.freeze([
  'authentication',
  'authorization',
  'invalid_api_key',
  'invalid api key',
  'permission_denied',
  'forbidden',
  'unauthorized',
  'context_length',
  'context window',
  'maximum context',
  'input exceeds',
  'too many tokens',
  'invalid_request',
  'invalid request',
  'bad_request',
  'bad request',
  'unsupported_parameter',
  'unsupported value',
  'invalid_prompt',
  'quota_exceeded',
  'insufficient_quota',
  'usage_limit',
  'billing',
  'usage_not_included',
  'policy',
  'safety',
  'cyber'
]);

const RETRYABLE_ERROR_MARKERS = Object.freeze([
  'rate_limit',
  'rate limit',
  'server_overloaded',
  'server overloaded',
  'overloaded',
  'capacity',
  'temporarily unavailable',
  'try again',
  'timeout',
  'timed out',
  'internal_error',
  'internal server',
  'server_error',
  'service_unavailable',
  'unavailable',
  'connection',
  'network',
  'stream',
  'eof',
  'closed before',
  'disconnected'
]);

const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 425, 429]);
const FATAL_HTTP_STATUSES = new Set([400, 401, 403, 404, 422]);

function normalizeString(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeErrorPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (payload.error && typeof payload.error === 'object') return payload.error;
  if (payload.response && typeof payload.response === 'object' && payload.response.error) {
    return payload.response.error;
  }
  return payload;
}

function collectErrorTextParts(payload) {
  const normalized = normalizeErrorPayload(payload);
  if (typeof normalized === 'string') return [normalized];
  if (!normalized || typeof normalized !== 'object') return [];

  const parts = [];
  for (const key of ['type', 'code', 'status', 'reason', 'message']) {
    const value = normalized[key];
    if (typeof value === 'string' && value.trim()) parts.push(value.trim());
  }

  if (payload && payload !== normalized && typeof payload === 'object') {
    for (const key of ['type', 'status']) {
      const value = payload[key];
      if (typeof value === 'string' && value.trim()) parts.push(value.trim());
    }
  }

  return parts;
}

function includesAnyMarker(text, markers) {
  const normalized = normalizeString(text).toLowerCase();
  if (!normalized) return false;
  return markers.some(marker => normalized.includes(marker));
}

function isRetryableHttpStatus(status) {
  const numericStatus = toFiniteNumber(status);
  if (numericStatus == null) return false;
  return RETRYABLE_HTTP_STATUSES.has(numericStatus) || numericStatus >= 500;
}

function isFatalHttpStatus(status) {
  const numericStatus = toFiniteNumber(status);
  if (numericStatus == null) return false;
  return FATAL_HTTP_STATUSES.has(numericStatus);
}

export function normalizeResponsesRetryAfterMs(value) {
  const numericValue = toFiniteNumber(value);
  if (numericValue == null || numericValue < 0) return null;
  return Math.round(numericValue);
}

export function parseResponsesRetryAfterMs(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.round(asNumber * 1000);
  }

  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

export function parseRetryDelayFromResponsesMessage(message) {
  const text = normalizeString(message);
  if (!text) return null;

  const match = text.match(/(?:try again|retry)\s+in\s+([0-9]+(?:\.[0-9]+)?)\s*(ms|millisecond|milliseconds|s|sec|secs|second|seconds|m|min|mins|minute|minutes)?/i);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = String(match[2] || 's').toLowerCase();
  if (unit === 'ms' || unit.startsWith('millisecond')) return Math.round(value);
  if (unit === 'm' || unit.startsWith('min')) return Math.round(value * 60_000);
  return Math.round(value * 1000);
}

export function resolveResponsesRetryAfterMs(payload, options = {}) {
  const explicitDelay = normalizeResponsesRetryAfterMs(options?.retryAfterMs);
  if (explicitDelay != null) return explicitDelay;

  const headerDelay = parseResponsesRetryAfterMs(options?.retryAfterHeader);
  if (headerDelay != null) return headerDelay;

  const normalized = normalizeErrorPayload(payload);
  if (normalized && typeof normalized === 'object') {
    for (const key of ['retry_after_ms', 'retryAfterMs', 'delay_ms', 'delayMs']) {
      const delay = normalizeResponsesRetryAfterMs(normalized[key]);
      if (delay != null) return delay;
    }
    for (const key of ['retry_after', 'retryAfter']) {
      const delay = parseResponsesRetryAfterMs(normalized[key]);
      if (delay != null) return delay;
    }
    const messageDelay = parseRetryDelayFromResponsesMessage(normalized.message);
    if (messageDelay != null) return messageDelay;
  }

  if (typeof payload === 'string') {
    return parseRetryDelayFromResponsesMessage(payload);
  }

  return null;
}

export function buildResponsesRetryDelayMs(retryNumber, options = {}) {
  const requestedDelayMs = normalizeResponsesRetryAfterMs(options?.retryAfterMs);
  if (requestedDelayMs != null) return requestedDelayMs;

  const baseDelayMs = normalizeResponsesRetryAfterMs(options?.baseDelayMs)
    ?? DEFAULT_RESPONSES_API_RETRY_BASE_DELAY_MS;
  const normalizedRetryNumber = Math.max(1, Math.floor(Number(retryNumber) || 1));
  const exponent = Math.max(0, normalizedRetryNumber - 1);
  const rawDelay = baseDelayMs * (2 ** exponent);
  const jitterSource = (typeof options?.random === 'function') ? options.random : Math.random;
  const randomValue = Number(jitterSource());
  const boundedRandom = Number.isFinite(randomValue) ? Math.min(1, Math.max(0, randomValue)) : 0.5;
  const jitter = RESPONSES_API_RETRY_JITTER_MIN
    + boundedRandom * (RESPONSES_API_RETRY_JITTER_MAX - RESPONSES_API_RETRY_JITTER_MIN);
  return Math.max(0, Math.round(rawDelay * jitter));
}

export function classifyResponsesApiErrorPayload(payload, options = {}) {
  const httpStatus = toFiniteNumber(options?.httpStatus);
  const eventType = normalizeString(options?.eventType).toLowerCase();
  const retryAfterMs = resolveResponsesRetryAfterMs(payload, options);
  const text = collectErrorTextParts(payload).join(' ').toLowerCase();

  if (httpStatus != null) {
    if (isRetryableHttpStatus(httpStatus)) {
      return {
        retryable: true,
        fatal: false,
        reason: `http_${httpStatus}`,
        retryAfterMs
      };
    }
    if (isFatalHttpStatus(httpStatus)) {
      return {
        retryable: false,
        fatal: true,
        reason: `http_${httpStatus}`,
        retryAfterMs: null
      };
    }
  }

  if (includesAnyMarker(text, FATAL_ERROR_MARKERS)) {
    return {
      retryable: false,
      fatal: true,
      reason: 'fatal_payload',
      retryAfterMs: null
    };
  }

  if (includesAnyMarker(text, RETRYABLE_ERROR_MARKERS)) {
    return {
      retryable: true,
      fatal: false,
      reason: 'retryable_payload',
      retryAfterMs
    };
  }

  if (eventType === 'response.failed' || eventType === 'response.incomplete') {
    return {
      retryable: true,
      fatal: false,
      reason: eventType,
      retryAfterMs
    };
  }

  return {
    retryable: false,
    fatal: false,
    reason: 'unknown',
    retryAfterMs
  };
}

export function isRecoverableResponsesTransportError(error) {
  if (!error) return false;
  if (error?.name === 'AbortError') return false;
  const message = normalizeString(error?.message || error).toLowerCase();
  if (!message) return false;
  return includesAnyMarker(message, [
    'failed to fetch',
    'network',
    'connection',
    'timeout',
    'timed out',
    'stream',
    'body',
    'terminated',
    'eof',
    'closed before',
    'disconnected',
    '网络请求失败',
    '连接',
    '断联'
  ]);
}
