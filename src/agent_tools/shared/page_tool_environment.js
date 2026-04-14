/**
 * 统一描述“当前这次请求是否暴露宿主页增强工具”。
 *
 * 这里把几个容易混淆的概念拆开：
 * 1. 是否暴露 `page_content_read`；
 * 2. `js_runtime_execute` 当前应连接到宿主页，还是侧栏内部隔离沙箱；
 * 3. 是否应该把宿主页 frame 快照注入给模型。
 *
 * 这样后续无论是消息发送、UI 提示还是独立页模式，都能共享同一套明确语义，
 * 避免各处继续直接读 `isStandalone` / `isTemporaryMode` 然后各自猜含义。
 */

export const JS_RUNTIME_ENV_BOUND_HOST_PAGE = 'bound_host_page';
export const JS_RUNTIME_ENV_ISOLATED_SANDBOX = 'isolated_sandbox_iframe';

/**
 * 根据当前侧栏模式，解析本轮请求的页面工具暴露状态。
 *
 * 约定：
 * - 独立页模式下没有稳定宿主页，因此不暴露宿主页工具；
 * - 纯对话模式下同样不暴露宿主页工具；
 * - 上述两种情况下，JS 工具仍可用，但运行在侧栏内部隔离沙箱里。
 *
 * @param {{isStandalone?:boolean, isTemporaryMode?:boolean}} [options]
 * @returns {{
 *   isStandalone:boolean,
 *   isTemporaryMode:boolean,
 *   exposeHostPageTools:boolean,
 *   exposePageContentTool:boolean,
 *   jsRuntimeEnvironment:string,
 *   shouldInjectJsRuntimeFrameContext:boolean
 * }}
 */
export function resolvePageToolEnvironment(options = {}) {
  const isStandalone = options?.isStandalone === true;
  const isTemporaryMode = options?.isTemporaryMode === true;
  const exposeHostPageTools = !isStandalone && !isTemporaryMode;

  return {
    isStandalone,
    isTemporaryMode,
    exposeHostPageTools,
    exposePageContentTool: exposeHostPageTools,
    jsRuntimeEnvironment: exposeHostPageTools
      ? JS_RUNTIME_ENV_BOUND_HOST_PAGE
      : JS_RUNTIME_ENV_ISOLATED_SANDBOX,
    shouldInjectJsRuntimeFrameContext: exposeHostPageTools
  };
}

/**
 * 生成左上角状态点等 UI 可复用的说明文案。
 *
 * @param {{
 *   exposeHostPageTools?:boolean
 * }} mode
 * @returns {string}
 */
export function buildPageToolModeStatusTitle(mode = {}) {
  if (mode?.exposeHostPageTools) {
    return '网页增强模式：暴露页面内容工具，JS 运行在当前侧栏绑定网页标签页。';
  }
  return '纯对话模式：不暴露页面内容工具，JS 运行在隔离沙箱，不访问宿主标签页。';
}
