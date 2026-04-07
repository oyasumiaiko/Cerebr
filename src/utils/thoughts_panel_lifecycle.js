/**
 * 思考面板自动展开/收起生命周期决策（纯函数）。
 *
 * 设计目标：
 * - 首次出现且仍在“只有思考、正文尚未开始输出”的阶段时，默认展开；
 * - 一旦正文开始输出，立即自动收起一次；
 * - 如果直到结束都没有正文，也会在结束时自动收起一次；
 * - 用户手动点击后，后续刷新始终尊重用户选择；
 * - 该函数只返回“应当如何变更状态”，不直接操作 DOM。
 *
 * @param {{
 *   manualState?: string|null,
 *   lifecycleInitialized?: boolean,
 *   autoCollapsedAfterAnswerStart?: boolean,
 *   isUpdating?: boolean,
 *   hasVisibleAnswerStarted?: boolean,
 *   currentlyExpanded?: boolean
 * }} options
 * @returns {{
 *   expanded: boolean,
 *   lifecycleInitialized: boolean,
 *   autoCollapsedAfterAnswerStart: boolean
 * }}
 */
export function resolveThoughtsPanelLifecycleState(options = {}) {
  const manualState = String(options.manualState || '').trim().toLowerCase();
  const lifecycleInitialized = options.lifecycleInitialized === true;
  const autoCollapsedAfterAnswerStart = options.autoCollapsedAfterAnswerStart === true;
  const isUpdating = options.isUpdating === true;
  const hasVisibleAnswerStarted = options.hasVisibleAnswerStarted === true;
  const currentlyExpanded = options.currentlyExpanded === true;

  if (manualState === 'expanded' || manualState === 'collapsed') {
    return {
      expanded: manualState === 'expanded',
      lifecycleInitialized: true,
      autoCollapsedAfterAnswerStart
    };
  }

  let nextExpanded = currentlyExpanded;
  let nextLifecycleInitialized = lifecycleInitialized;
  let nextAutoCollapsedAfterAnswerStart = autoCollapsedAfterAnswerStart;

  if (!nextLifecycleInitialized) {
    nextLifecycleInitialized = true;
    if (isUpdating && !hasVisibleAnswerStarted) {
      nextExpanded = true;
      nextAutoCollapsedAfterAnswerStart = false;
    } else {
      nextExpanded = false;
      nextAutoCollapsedAfterAnswerStart = true;
    }
    return {
      expanded: nextExpanded,
      lifecycleInitialized: nextLifecycleInitialized,
      autoCollapsedAfterAnswerStart: nextAutoCollapsedAfterAnswerStart
    };
  }

  if (!nextAutoCollapsedAfterAnswerStart && hasVisibleAnswerStarted) {
    nextExpanded = false;
    nextAutoCollapsedAfterAnswerStart = true;
  } else if (!nextAutoCollapsedAfterAnswerStart && !isUpdating) {
    nextExpanded = false;
    nextAutoCollapsedAfterAnswerStart = true;
  }

  return {
    expanded: nextExpanded,
    lifecycleInitialized: nextLifecycleInitialized,
    autoCollapsedAfterAnswerStart: nextAutoCollapsedAfterAnswerStart
  };
}
