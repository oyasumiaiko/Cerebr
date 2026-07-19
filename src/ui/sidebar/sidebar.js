import { createSidebarAppContext, registerSidebarUtilities } from './sidebar_app_context.js';
import { initializeSidebarServices } from './sidebar_bootstrap.js';
import { registerSidebarEventHandlers } from './sidebar_events.js';
import { serializeSelectionTextWithMath } from '../../utils/math_selection_text.js';

installAltKeyBrowserMenuGuard();

/**
 * 判断是否需要屏蔽浏览器菜单栏的裸 Alt 默认行为。
 *
 * 说明：
 * - Chrome/Edge 在页面或 iframe 获得焦点时，按下再松开 Alt 会把焦点转移到浏览器菜单栏；
 * - Cerebr 里 Alt 是滚轮加速的按住型修饰键，用户只是按住 Alt 滚动时不应触发外层浏览器 UI；
 * - 这里只匹配 Alt 键本身的 keydown/keyup，不拦截 Alt+Enter 等组合键里的 Enter 事件；
 * - AltGraph 是输入法/键盘布局层面的字符输入修饰键，不能按普通 Alt 处理。
 *
 * @param {KeyboardEvent} event - 键盘事件。
 * @returns {boolean} 是否应阻止浏览器默认菜单栏行为。
 */
function shouldSuppressBrowserMenuAltKeyEvent(event) {
  if (!event || event.key !== 'Alt') return false;
  const isAltGraph = typeof event.getModifierState === 'function' && event.getModifierState('AltGraph');
  return !isAltGraph;
}

function suppressBrowserMenuAltKeyEvent(event) {
  if (!shouldSuppressBrowserMenuAltKeyEvent(event)) return;
  if (event.cancelable !== false) {
    event.preventDefault();
  }
}

function installAltKeyBrowserMenuGuard() {
  // 在模块加载阶段尽早注册，覆盖侧栏服务初始化完成前的极短窗口；不停止传播，保留内部 Alt 状态同步。
  window.addEventListener('keydown', suppressBrowserMenuAltKeyEvent, { capture: true });
  window.addEventListener('keyup', suppressBrowserMenuAltKeyEvent, { capture: true });
}

/**
 * 页面 DOM 就绪后执行整体启动流程：检测模式 -> 构建上下文 -> 初始化服务 -> 注册事件。
 */
document.addEventListener('DOMContentLoaded', async () => {
  const isStandalone = detectStandaloneMode();
  applyStandaloneClasses(isStandalone);

  const appContext = createSidebarAppContext(isStandalone);
  registerSidebarUtilities(appContext);
  setupLayoutObservers(appContext);
  setupSidebarSelectionBroadcast(appContext);
  exposeGlobals(appContext, isStandalone);

  await initializeSidebarServices(appContext);
  attachDebugShortcuts(appContext);
  registerSidebarEventHandlers(appContext);
});

/**
 * 识别当前页面是否运行在独立聊天模式下。
 * @returns {boolean} 是否独立模式。
 */
function detectStandaloneMode() {
  const currentUrl = new URL(window.location.href);
  const hashQuery = currentUrl.hash.startsWith('#') ? currentUrl.hash.substring(1) : '';
  const hashParams = new URLSearchParams(hashQuery);
  const standaloneParam = (
    currentUrl.searchParams.get('mode') === 'standalone' ||
    currentUrl.searchParams.get('standalone') === '1' ||
    hashParams.get('mode') === 'standalone' ||
    hashParams.get('standalone') === '1' ||
    currentUrl.hash.includes('standalone')
  );

  let isStandalone = standaloneParam;
  try {
    if (!isStandalone) {
      isStandalone = window.parent === window;
    }
  } catch (_) {
    // 跨域场景下访问 window.parent 可能抛异常，忽略并视为嵌入模式
  }
  return isStandalone;
}

/**
 * 根据模式为根节点 / body 添加或移除独立模式样式类。
 * @param {boolean} isStandalone - 独立模式标记。
 */
function applyStandaloneClasses(isStandalone) {
  if (document?.body) {
    document.body.classList.toggle('standalone-mode', isStandalone);
  }
  if (document?.documentElement) {
    const root = document.documentElement;
    root.classList.toggle('standalone-mode', isStandalone);
    // 独立聊天页面默认使用与网页「全屏模式」相同的布局（背景与输入框宽度等）
    root.classList.toggle('fullscreen-mode', isStandalone);
  }
}

/**
 * 建立输入容器高度的观察者，保持 CSS 变量与布局同步。
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 */
function setupLayoutObservers(appContext) {
  appContext.utils.updateInputContainerHeightVar();
  window.addEventListener('resize', appContext.utils.updateInputContainerHeightVar);
  const resizeObserver = new ResizeObserver(() => appContext.utils.updateInputContainerHeightVar());
  const inputEl = document.getElementById('input-container');
  if (inputEl) resizeObserver.observe(inputEl);
}

/**
 * 在嵌入模式下，将侧栏内部的选中文本通过私有 bridge 同步给宿主页面。
 * 这样内容脚本可以像感知网页选区一样感知侧栏选区，用于快捷总结等功能。
 * @param {ReturnType<typeof createSidebarAppContext>} appContext - 侧栏上下文
 */
function setupSidebarSelectionBroadcast(appContext) {
  // 独立页面无需向外同步选区
  if (appContext.state.isStandalone) return;

  let lastSelection = '';

  window.addEventListener('selectionchange', () => {
    try {
      const selection = window.getSelection();
      const text = serializeSelectionTextWithMath(selection, { trim: true });

      // 文本未变化时不广播，避免产生噪音
      if (text === lastSelection) return;
      lastSelection = text;

      appContext.utils.postHostMessage({
        source: 'cerebr-sidebar',
        type: 'SIDEBAR_SELECTION_CHANGED',
        text
      });
    } catch (e) {
      // 同步选区失败不应影响主流程，仅记录日志
      console.warn('同步侧栏选区失败:', e);
    }
  });
}

/**
 * 暴露简化后的全局对象，供外部调试或内容脚本访问。
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 * @param {boolean} isStandalone - 当前环境标记。
 */
function exposeGlobals(appContext, isStandalone) {
  window.cerebr = window.cerebr || {};
  window.cerebr.environment = isStandalone ? 'standalone' : 'embedded';
  window.cerebr.settings = {
    prompts: () => appContext.services.promptSettingsManager?.getPrompts()
  };
  window.cerebr.pageInfo = appContext.state.pageInfo;

  // 暴露一个示例对话框函数，便于快速测试 UI 确认框
  window.cerebr.showConfirmDemo = async () => {
    try {
      const ok = await appContext.utils.showConfirm({
        message: '这是一个示例对话框',
        description: '用于演示统一的确认对话框样式与交互。是否继续？',
        confirmText: '继续',
        cancelText: '取消',
        type: 'info'
      });
      const resultText = ok ? '你选择了：继续' : '你选择了：取消';
      appContext.utils.showNotification({ message: resultText, type: ok ? 'success' : 'warning', duration: 1800 });
      return ok;
    } catch (e) {
      console.error('示例对话框演示失败:', e);
      appContext.utils.showNotification({ message: '示例对话框演示失败', type: 'error' });
      return false;
    }
  };

  // 暴露一个 request_user_input 内联卡片演示，便于后续 UI 回归时直接在真实 sidebar 里触发。
  window.cerebr.showRequestUserInputDemo = async () => {
    try {
      const result = await appContext.utils.showRequestUserInput({
        questions: [
          {
            header: '落地方式',
            id: 'delivery_mode',
            question: '这次修改你更希望我怎么继续？',
            options: [
              { label: '直接实现 (Recommended)', description: '按当前理解继续往前做。' },
              { label: '先给草图', description: '先展示结构，再决定细节。' },
              { label: '只做样式', description: '先把界面走通，逻辑稍后补。' }
            ]
          },
          {
            header: '验证方式',
            id: 'verification_mode',
            question: '这轮改完后你更希望我怎么验证？',
            options: [
              { label: '直接跑 smoke (Recommended)', description: '先看真实 UI 与交互是否正常。' },
              { label: '只跑单测', description: '先做逻辑验证，不立即开浏览器。' },
              { label: '先给截图', description: '先确认视觉，再继续交互验证。' }
            ]
          }
        ]
      });
      window.cerebr.debug = window.cerebr.debug || {};
      window.cerebr.debug.lastRequestUserInputDemoResult = result;
      return result;
    } catch (error) {
      console.error('request_user_input 演示失败:', error);
      appContext.utils.showNotification({ message: 'request_user_input 演示失败', type: 'error' });
      throw error;
    }
  };

  document.addEventListener('promptSettingsUpdated', () => {
    if (appContext.services.promptSettingsManager) {
      window.cerebr.settings.prompts = appContext.services.promptSettingsManager.getPrompts();
    }
  });
}

function attachDebugShortcuts(appContext) {
  const chatHistoryUI = appContext.services.chatHistoryUI;
  window.cerebr = window.cerebr || {};
  window.cerebr.debug = {
    repairRecentImages: (opts) => chatHistoryUI?.repairRecentImages?.(opts),
    purgeOrphanImageContents: () => chatHistoryUI?.purgeOrphanImageContents?.(),
    migrateImagePathsToRelative: () => chatHistoryUI?.migrateImagePathsToRelative?.(),
    setImageDownloadRoot: (root) => chatHistoryUI?.setDownloadRootManual?.(root),
    checkImagePathUrlMismatch: (limit) => chatHistoryUI?.checkImagePathUrlMismatch?.(limit),
    cleanImageUrlFields: () => chatHistoryUI?.cleanImageUrlFields?.(),
    resaveImagesWithNewScheme: (opts) => chatHistoryUI?.resaveImagesWithNewScheme?.(opts),
    scanDataUrlsInDb: (limit) => chatHistoryUI?.scanDataUrlsInDb?.(limit),
    getJsRuntimeStatus: () => appContext.utils.getJsRuntimeStatus?.(),
    getJsRuntimeFrames: (options) => appContext.utils.getJsRuntimeFrames?.(options),
    executeJsRuntime: (code, options) => appContext.utils.executeJsRuntime?.(code, options),
    // 仅暴露给本地调试 / 浏览器回归脚本：
    // - chatHistoryUI 便于在页面重载后重新载入指定会话；
    // - messageProcessor 便于检查消息 DOM 渲染路径。
    chatHistoryUI: appContext.services.chatHistoryUI,
    messageProcessor: appContext.services.messageProcessor,
    messageSender: appContext.services.messageSender
  };
}
