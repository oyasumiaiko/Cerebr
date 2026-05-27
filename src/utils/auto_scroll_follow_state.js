/**
 * 根据滚动位置推导“是否继续自动跟随到底部”。
 *
 * 设计约束：
 * - 用户只要主动滚动且尚未回到底部附近，就立刻停止自动跟随；
 * - 当用户重新回到底部附近时，才恢复自动跟随；
 * - 若全局 autoScroll 偏好被关闭，则这里始终返回 false；
 * - 仅凭“内容还在增长，当前离底部变远了”不能判定为用户手动打断，
 *   否则流式输出过程中会把正常的自动跟随误判为手动取消。
 * - 同理，仅凭 scrollTop 方向变化也不能判定为用户意图；Markdown 增量渲染、
 *   图片/代码块布局变化和浏览器滚动锚定都可能制造非用户触发的 scroll 事件。
 *
 * @param {{
 *   previousTop?: number,
 *   currentTop?: number,
 *   distanceFromBottom?: number,
 *   threshold?: number,
 *   autoScrollEnabled?: boolean,
 *   currentShouldAutoScroll?: boolean,
 *   userScrollIntent?: boolean
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
  const userScrollIntent = options.userScrollIntent === true;

  if (!autoScrollEnabled) {
    return false;
  }

  if (distanceFromBottom <= threshold) {
    return true;
  }

  if (userScrollIntent) {
    return false;
  }

  return currentShouldAutoScroll;
}
