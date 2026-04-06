/**
 * @file 生成与 Codex 风格对齐的隐藏 environment_context。
 *
 * 设计目标：
 * - 只承载“当前日期 + 时区”这类稳定但有时效性的环境信息；
 * - 作为独立隐藏 contextual item 挂到用户消息之前，不污染用户正文；
 * - 采用“只有变化时才追加”的策略，避免每轮重复发送相同前缀。
 */

/**
 * 规范化 IANA 时区名；若不可用则回退到 Etc/UTC。
 *
 * @param {string|null|undefined} timezone
 * @returns {string}
 */
export function normalizeEnvironmentTimezone(timezone) {
  if (typeof timezone === 'string' && timezone.trim()) {
    return timezone.trim();
  }
  return 'Etc/UTC';
}

/**
 * 读取当前运行环境的 IANA 时区。
 *
 * @returns {string}
 */
export function detectEnvironmentTimezone() {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    return normalizeEnvironmentTimezone(resolved?.timeZone);
  } catch (_) {
    return 'Etc/UTC';
  }
}

/**
 * 按指定时区把时间格式化为 YYYY-MM-DD。
 *
 * @param {string} timezone
 * @param {number|Date|null|undefined} now
 * @returns {string}
 */
export function formatEnvironmentCurrentDate(timezone, now = null) {
  const tz = normalizeEnvironmentTimezone(timezone);
  const date = (now instanceof Date)
    ? now
    : (Number.isFinite(Number(now)) ? new Date(Number(now)) : new Date());

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const parts = formatter.formatToParts(date);
    const year = parts.find((item) => item.type === 'year')?.value || '1970';
    const month = parts.find((item) => item.type === 'month')?.value || '01';
    const day = parts.find((item) => item.type === 'day')?.value || '01';
    return `${year}-${month}-${day}`;
  } catch (_) {
    return date.toISOString().slice(0, 10);
  }
}

function escapeXmlText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 构造隐藏 environment_context 负载。
 *
 * @param {{
 *   timezone?: string|null,
 *   currentDate?: string|null,
 *   now?: number|Date|null
 * }} [options]
 * @returns {{type:'environment_context', current_date:string, timezone:string}}
 */
export function buildEnvironmentContextPayload(options = {}) {
  const timezone = normalizeEnvironmentTimezone(options?.timezone || detectEnvironmentTimezone());
  const currentDate = (typeof options?.currentDate === 'string' && options.currentDate.trim())
    ? options.currentDate.trim()
    : formatEnvironmentCurrentDate(timezone, options?.now);

  return {
    type: 'environment_context',
    current_date: currentDate,
    timezone
  };
}

/**
 * 生成稳定签名，供“仅在变化时追加”判断使用。
 *
 * @param {Object|null|undefined} payload
 * @returns {string}
 */
export function buildEnvironmentContextSignature(payload) {
  if (!payload || typeof payload !== 'object') return '';
  try {
    return JSON.stringify(payload);
  } catch (_) {
    return '';
  }
}

/**
 * 把隐藏 environment_context 负载转换为可直接插入 Responses input 的 item。
 *
 * @param {Object|null|undefined} payload
 * @returns {Array<Object>}
 */
export function buildEnvironmentContextInputItems(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const currentDate = (typeof payload.current_date === 'string') ? payload.current_date.trim() : '';
  const timezone = (typeof payload.timezone === 'string') ? payload.timezone.trim() : '';
  if (!currentDate || !timezone) return [];

  const text = [
    '<environment_context>',
    `  <current_date>${escapeXmlText(currentDate)}</current_date>`,
    `  <timezone>${escapeXmlText(timezone)}</timezone>`,
    '</environment_context>'
  ].join('\n');

  return [{
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text
      }
    ]
  }];
}

/**
 * 根据上一条已生效签名，决定是否真正为本轮追加 environment_context。
 *
 * @param {{
 *   payload?: Object|null,
 *   previousEffectiveSignature?: string|null
 * }} [options]
 * @returns {{signature:string|null, inputItems:Array<Object>|null}}
 */
export function resolveEnvironmentContextAttachment(options = {}) {
  const payload = (options?.payload && typeof options.payload === 'object') ? options.payload : null;
  const previousEffectiveSignature = (typeof options?.previousEffectiveSignature === 'string')
    ? options.previousEffectiveSignature
    : '';
  const signature = buildEnvironmentContextSignature(payload);
  const inputItems = buildEnvironmentContextInputItems(payload);

  if (!signature || inputItems.length <= 0) {
    return {
      signature: null,
      inputItems: null
    };
  }

  if (previousEffectiveSignature && previousEffectiveSignature === signature) {
    return {
      signature: null,
      inputItems: null
    };
  }

  return {
    signature,
    inputItems
  };
}
