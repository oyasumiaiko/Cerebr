/**
 * 展开 / 收起时的滚动锚点纯函数。
 *
 * 目标：
 * - 若元素顶部贴近视口顶部，则更偏向“保持顶部不动”；
 * - 若元素底部贴近视口底部，则更偏向“保持底部不动”；
 * - 中间情况按当前元素在视口中的相对位置做平滑插值，而不是硬切换。
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
 * 统一公式：
 * - 当元素短于视口时，`elementTop` 会在 `[0, viewportHeight - elementHeight]` 之间移动；
 * - 当元素高于视口时，`elementTop` 会在 `[viewportHeight - elementHeight, 0]` 之间移动；
 * - 因而直接使用 `elementTop / (viewportHeight - elementHeight)` 就能同时覆盖两类情况，
 *   并在“只看得到上边缘 / 只看得到下边缘 / 两边都看不到 / 两边都看得到”之间平滑过渡。
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
