/**
 * 根据滚动位置推导“是否继续自动跟随到底部”。
 *
 * 设计约束：
 * - 用户只要主动上滚（scrollTop 变小），就立刻停止自动跟随；
 * - 当用户重新回到底部附近时，才恢复自动跟随；
 * - 若全局 autoScroll 偏好被关闭，则这里始终返回 false；
 * - 仅凭“内容还在增长，当前离底部变远了”不能判定为用户手动打断，
 *   否则流式输出过程中会把正常的自动跟随误判为手动取消。
 *
 * @param {{
 *   previousTop?: number,
 *   currentTop?: number,
 *   distanceFromBottom?: number,
 *   threshold?: number,
 *   autoScrollEnabled?: boolean,
 *   currentShouldAutoScroll?: boolean
 * }} [options]
 * @returns {boolean}
 */
export function deriveAutoScrollFollowState(options = {}) {
  const previousTop = Number.isFinite(Number(options.previousTop)) ? Number(options.previousTop) : 0;
  const currentTop = Number.isFinite(Number(options.currentTop)) ? Number(options.currentTop) : 0;
  const distanceFromBottom = Number.isFinite(Number(options.distanceFromBottom)) ? Number(options.distanceFromBottom) : 0;
  const threshold = Number.isFinite(Number(options.threshold))
    ? Math.max(0, Number(options.threshold))
    : 100;
  const autoScrollEnabled = options.autoScrollEnabled !== false;
  const currentShouldAutoScroll = options.currentShouldAutoScroll === true;

  if (!autoScrollEnabled) {
    return false;
  }

  if (distanceFromBottom <= threshold) {
    return true;
  }

  if (currentTop + 1 < previousTop) {
    return false;
  }

  return currentShouldAutoScroll;
}
