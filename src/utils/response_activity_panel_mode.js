/**
 * response-activity 思考窗口的模式状态机。
 *
 * 设计目标：
 * - 思考进行中：只允许 `peek` / `expanded` 两态，不允许彻底收起；
 * - 思考结束：自动收起一次，进入 `collapsed`；
 * - 思考结束后：标题栏点击在 `expanded` / `collapsed` 间切换；
 * - 思考中的点击：在 `peek` / `expanded` 间切换。
 */

function normalizeManualState(value) {
  const normalized = (typeof value === 'string') ? value.trim().toLowerCase() : '';
  if (normalized === 'expanded' || normalized === 'collapsed') return normalized;
  return '';
}

/**
 * @param {{
 *   manualState?: string|null,
 *   lifecycleInitialized?: boolean,
 *   autoCollapsedAfterFinish?: boolean,
 *   isInProgress?: boolean
 * }} [options]
 * @returns {{
 *   expanded: boolean,
 *   peek: boolean,
 *   lifecycleInitialized: boolean,
 *   autoCollapsedAfterFinish: boolean,
 *   clearManualState: boolean
 * }}
 */
export function resolveResponseActivityPanelModeState(options = {}) {
  const manualState = normalizeManualState(options.manualState);
  const lifecycleInitialized = options.lifecycleInitialized === true;
  const autoCollapsedAfterFinish = options.autoCollapsedAfterFinish === true;
  const isInProgress = options.isInProgress === true;

  if (!lifecycleInitialized) {
    if (isInProgress) {
      return {
        expanded: false,
        peek: true,
        lifecycleInitialized: true,
        autoCollapsedAfterFinish: false,
        clearManualState: false
      };
    }
    return {
      expanded: false,
      peek: false,
      lifecycleInitialized: true,
      autoCollapsedAfterFinish: true,
      clearManualState: false
    };
  }

  if (isInProgress) {
    return {
      expanded: manualState === 'expanded',
      peek: manualState !== 'expanded',
      lifecycleInitialized: true,
      autoCollapsedAfterFinish: false,
      clearManualState: false
    };
  }

  if (!autoCollapsedAfterFinish) {
    return {
      expanded: false,
      peek: false,
      lifecycleInitialized: true,
      autoCollapsedAfterFinish: true,
      clearManualState: true
    };
  }

  if (manualState === 'expanded') {
    return {
      expanded: true,
      peek: false,
      lifecycleInitialized: true,
      autoCollapsedAfterFinish: true,
      clearManualState: false
    };
  }

  return {
    expanded: false,
    peek: false,
    lifecycleInitialized: true,
    autoCollapsedAfterFinish: true,
    clearManualState: false
  };
}
