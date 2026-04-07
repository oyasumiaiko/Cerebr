/**
 * 展开 / 收起时的滚动锚点纯函数。
 *
 * 目标：
 * - 只要元素上边缘仍在视口里，就统一按“保持上边缘不动”处理，
 *   这样展开时视觉上就是稳定地向下长，不会把顶部往上顶走；
 * - 当上边缘已经不可见、但下边缘仍可见时，再切到“保持下边缘不动”；
 * - 只有上下边缘都不可见时，才根据当前位置做平滑插值。
 */

function clamp01(value) {
  if (!Number.isFinite(Number(value))) return 0;
  return Math.max(0, Math.min(1, Number(value)));
}

/**
 * 计算当前元素应保持不变的“内部锚点比例”。
 *
 * 返回值范围为 [0, 1]：
 * - 0 表示更偏向保持顶部位置不变
 * - 1 表示更偏向保持底部位置不变
 *
 * 规则：
 * - 只要上边缘可见（包括整块都可见），直接返回 0，统一向下展开；
 * - 仅下边缘可见时返回 1；
 * - 只有上下边缘都不可见时，才用当前位置对可滚动区间做归一化，
 *   在顶部锚点与底部锚点之间平滑插值。
 *
 * @param {{elementTop: number, elementHeight: number, viewportHeight: number}} metrics
 * @returns {number}
 */
export function computeStableScrollAnchorRatio(metrics = {}) {
  const elementTop = Number(metrics.elementTop);
  const elementHeight = Number(metrics.elementHeight);
  const viewportHeight = Number(metrics.viewportHeight);
  if (!Number.isFinite(elementTop) || !Number.isFinite(elementHeight) || !Number.isFinite(viewportHeight)) {
    return 0;
  }
  if (elementHeight <= 0 || viewportHeight <= 0) return 0;

  const elementBottom = elementTop + elementHeight;
  const isTopEdgeVisible = elementTop >= 0 && elementTop <= viewportHeight;
  const isBottomEdgeVisible = elementBottom >= 0 && elementBottom <= viewportHeight;

  if (isTopEdgeVisible) {
    return 0;
  }
  if (isBottomEdgeVisible) {
    return 1;
  }

  const travel = viewportHeight - elementHeight;
  if (Math.abs(travel) < 1e-6) {
    return 0.5;
  }
  return clamp01(elementTop / travel);
}

/**
 * 计算元素当前应保持不变的视口内锚点位置。
 *
 * @param {{elementTop: number, elementHeight: number, viewportHeight: number}} metrics
 * @returns {{anchorRatio: number, anchorViewportY: number}}
 */
export function computeStableScrollAnchor(metrics = {}) {
  const elementTop = Number(metrics.elementTop);
  const elementHeight = Number(metrics.elementHeight);
  const anchorRatio = computeStableScrollAnchorRatio(metrics);
  return {
    anchorRatio,
    anchorViewportY: elementTop + Math.max(0, elementHeight) * anchorRatio
  };
}

/**
 * 根据展开/收起前后的元素几何信息，计算需要施加到 scrollTop 的补偿量。
 *
 * 正值表示应向下滚动更多，以把变化后“跑到更下方”的锚点拉回原位。
 *
 * @param {{
 *   beforeTop: number,
 *   beforeHeight: number,
 *   afterTop: number,
 *   afterHeight: number,
 *   viewportHeight: number
 * }} metrics
 * @returns {{anchorRatio: number, beforeAnchorViewportY: number, afterAnchorViewportY: number, scrollDelta: number}}
 */
export function computeStableScrollCompensation(metrics = {}) {
  const beforeTop = Number(metrics.beforeTop);
  const beforeHeight = Number(metrics.beforeHeight);
  const afterTop = Number(metrics.afterTop);
  const afterHeight = Number(metrics.afterHeight);
  const viewportHeight = Number(metrics.viewportHeight);

  const { anchorRatio, anchorViewportY: beforeAnchorViewportY } = computeStableScrollAnchor({
    elementTop: beforeTop,
    elementHeight: beforeHeight,
    viewportHeight
  });
  const afterAnchorViewportY = afterTop + Math.max(0, afterHeight) * anchorRatio;
  return {
    anchorRatio,
    beforeAnchorViewportY,
    afterAnchorViewportY,
    scrollDelta: afterAnchorViewportY - beforeAnchorViewportY
  };
}
