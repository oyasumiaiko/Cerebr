/**
 * Responses 工具详情块的“完成后延迟自动收起”纯函数。
 *
 * 设计目标：
 * - 工具进行中时保持展开；
 * - 工具刚完成时，不要立刻收起，而是继续展开一小段时间；
 * - 到达截止时间后再自动收起，并记录为“已自动收起”；
 * - 用户手动展开/收起始终优先于自动逻辑。
 */

export const RESPONSE_ACTIVITY_TOOL_AUTO_COLLAPSE_DELAY_MS = 2000;

function normalizeManualState(value) {
  const normalized = (typeof value === 'string') ? value.trim().toLowerCase() : '';
  if (normalized === 'expanded' || normalized === 'collapsed') return normalized;
  return '';
}

function normalizeOptionalTimestampMs(value) {
  if (value == null || value === '') return null;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) return null;
  return numberValue;
}

/**
 * 计算工具详情块下一帧的展开/自动收起状态。
 *
 * @param {{
 *   manualState?: string|null,
 *   shouldAutoRemainExpanded?: boolean,
 *   autoCollapsed?: boolean,
 *   pendingAutoCollapseDeadlineAtMs?: number|null,
 *   nowMs?: number|null,
 *   autoCollapseDelayMs?: number|null
 * }} [options]
 * @returns {{
 *   expanded: boolean,
 *   autoCollapsed: boolean,
 *   pendingAutoCollapseDeadlineAtMs: number|null
 * }}
 */
export function resolveResponseActivityToolExpansionState(options = {}) {
  const manualState = normalizeManualState(options.manualState);
  const shouldAutoRemainExpanded = options.shouldAutoRemainExpanded === true;
  const autoCollapsed = options.autoCollapsed === true;
  const pendingAutoCollapseDeadlineAtMs = normalizeOptionalTimestampMs(options.pendingAutoCollapseDeadlineAtMs);
  const nowMs = normalizeOptionalTimestampMs(options.nowMs) ?? Date.now();
  const autoCollapseDelayMs = normalizeOptionalTimestampMs(options.autoCollapseDelayMs)
    ?? RESPONSE_ACTIVITY_TOOL_AUTO_COLLAPSE_DELAY_MS;

  if (manualState === 'expanded') {
    return {
      expanded: true,
      autoCollapsed,
      pendingAutoCollapseDeadlineAtMs: null
    };
  }

  if (manualState === 'collapsed') {
    return {
      expanded: false,
      autoCollapsed,
      pendingAutoCollapseDeadlineAtMs: null
    };
  }

  if (shouldAutoRemainExpanded) {
    return {
      expanded: true,
      autoCollapsed: false,
      pendingAutoCollapseDeadlineAtMs: null
    };
  }

  if (autoCollapsed) {
    return {
      expanded: false,
      autoCollapsed: true,
      pendingAutoCollapseDeadlineAtMs: null
    };
  }

  if (pendingAutoCollapseDeadlineAtMs == null) {
    return {
      expanded: true,
      autoCollapsed: false,
      pendingAutoCollapseDeadlineAtMs: nowMs + autoCollapseDelayMs
    };
  }

  if (pendingAutoCollapseDeadlineAtMs > nowMs) {
    return {
      expanded: true,
      autoCollapsed: false,
      pendingAutoCollapseDeadlineAtMs
    };
  }

  return {
    expanded: false,
    autoCollapsed: true,
    pendingAutoCollapseDeadlineAtMs: null
  };
}
