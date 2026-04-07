/**
 * Responses Prompt Cache 相关纯函数。
 *
 * 设计目标：
 * - 把“如何为一个会话生成稳定 prompt_cache_key”的策略从发送流程里抽出来；
 * - 保持纯函数，方便单元测试与后续在 queue / 后台发送 / 会话恢复等路径复用；
 * - 不引入任何 DOM / storage / 全局状态依赖。
 */

/**
 * 规范化 prompt_cache_key。
 *
 * @param {any} value
 * @returns {string}
 */
export function normalizeResponsesPromptCacheKey(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

/**
 * 规范化 prompt_cache_retention。
 *
 * 当前只接受：
 * - in-memory
 * - 24h
 *
 * @param {any} value
 * @returns {string}
 */
export function normalizeResponsesPromptCacheRetention(value) {
  const normalized = (typeof value === 'string') ? value.trim().toLowerCase() : '';
  if (normalized === 'in-memory' || normalized === '24h') {
    return normalized;
  }
  return '';
}

/**
 * 判断当前 baseUrl 是否属于“官方 OpenAI Responses 端点”。
 *
 * 设计原因：
 * - `prompt_cache_retention` 不是所有 OpenAI-compatible 代理都支持；
 * - 一些第三方代理虽然兼容 `/responses`，但会在看到该字段时直接返回 400；
 * - 因此“自动补默认 retention”必须收敛到我们能确认支持的官方端点，
 *   避免再次把代理兼容性问题推给用户。
 *
 * 说明：
 * - 这里不阻止“用户显式填写 retention”；显式配置仍然尊重用户选择；
 * - 这里只控制“自动默认补 24h”的范围。
 *
 * @param {any} baseUrl
 * @returns {boolean}
 */
export function isOfficialOpenAIResponsesBaseUrl(baseUrl) {
  const normalized = (typeof baseUrl === 'string') ? baseUrl.trim() : '';
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    return parsed.hostname.toLowerCase() === 'api.openai.com';
  } catch (_) {
    return false;
  }
}

/**
 * 为当前会话构造一个稳定的默认 prompt_cache_key。
 *
 * 规则：
 * - 若调用方已经持有稳定 key，则直接复用；
 * - 否则优先使用真实 conversationId；
 * - 若当前仍是“草稿会话”，则使用草稿队列键生成 draft key。
 *
 * 说明：
 * - 这里不会自行随机生成值；调用方必须提供 conversationId 或 draftConversationKey 之一，
 *   从而保证 key 的来源可解释、可复现。
 *
 * @param {{existingKey?: string|null, conversationId?: string|null, draftConversationKey?: string|null}} options
 * @returns {string}
 */
export function buildDefaultResponsesPromptCacheKey(options = {}) {
  const existingKey = normalizeResponsesPromptCacheKey(options.existingKey);
  if (existingKey) return existingKey;

  const conversationId = (typeof options.conversationId === 'string')
    ? options.conversationId.trim()
    : '';
  if (conversationId) {
    return `conv:${conversationId}`;
  }

  const draftConversationKey = (typeof options.draftConversationKey === 'string')
    ? options.draftConversationKey.trim()
    : '';
  if (draftConversationKey) {
    return `draft:${draftConversationKey}`;
  }

  return '';
}

/**
 * 当请求已启用 prompt_cache_key，但调用方未显式指定 retention 时，
 * 为 Responses 请求补一个更稳定的默认 retention。
 *
 * 背景：
 * - in-memory retention 在数分钟无活动后很容易自然失效；
 * - Cerebr 已默认为会话构造稳定 prompt_cache_key，若仍沿用短 retention，
 *   用户会看到“同会话、相同前缀，但隔几分钟缓存又掉了”的体验；
 * - 但并非所有 OpenAI-compatible `/responses` 代理都支持该字段；
 * - 因此这里只会在“官方 OpenAI Responses 端点”上自动提升到 24h，
 *   其它代理保持不注入，用户若显式配置则仍尊重用户配置。
 *
 * @param {{promptCacheKey?: any, promptCacheRetention?: any, baseUrl?: any}} options
 * @returns {string}
 */
export function resolveDefaultResponsesPromptCacheRetention(options = {}) {
  const promptCacheKey = normalizeResponsesPromptCacheKey(options.promptCacheKey);
  if (!promptCacheKey) return '';

  const explicitRetention = normalizeResponsesPromptCacheRetention(options.promptCacheRetention);
  if (explicitRetention) return explicitRetention;

  if (!isOfficialOpenAIResponsesBaseUrl(options.baseUrl)) {
    return '';
  }

  return '24h';
}
