/**
 * 与“侧栏绑定网页标签页”相关的纯函数工具。
 *
 * 设计目标：
 * - 不再把“当前活动标签页”当成侧栏的默认目标页；
 * - 统一采用“显式传入的 tabId 优先，其次 sender.tab.id”这一条明确规则；
 * - 保持纯函数，便于 background 与测试共用，避免同类回归再次散落到多处。
 */

/**
 * 规范化一个可能来自消息参数 / sender / 运行态的 tabId。
 *
 * @param {any} value
 * @returns {number|null}
 */
export function normalizeSidebarTargetTabId(value) {
  if (value == null) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.trunc(numeric);
}

/**
 * 解析“本次侧栏请求应绑定的网页 tabId”。
 *
 * 规则非常严格：
 * 1. 若调用方已经显式传入 tabId，则必须使用它；
 * 2. 否则只允许回退到 sender.tab.id；
 * 3. 明确禁止再回退到“当前活动标签页”，避免用户切换标签页后把工具打到错误页面。
 *
 * @param {{explicitTabId?: any, senderTabId?: any, allowSenderTabFallback?: boolean}} source
 * @returns {number|null}
 */
export function resolveSidebarRequestTargetTabId(source = {}) {
  const explicitTabId = normalizeSidebarTargetTabId(source?.explicitTabId);
  if (explicitTabId !== null) return explicitTabId;

  // 纯对话 / 独立隔离模式会显式关闭 sender.tab.id 回退。
  // 这能区分“调用方忘了传 tabId”和“调用方明确要求本次不要绑定宿主页”。
  if (source?.allowSenderTabFallback === false) {
    return null;
  }

  const senderTabId = normalizeSidebarTargetTabId(source?.senderTabId);
  return senderTabId;
}
