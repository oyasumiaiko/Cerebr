/**
 * 消息处理模块 - 负责消息的显示、更新和格式化
 * @module MessageProcessor
 */

/**
 * 创建消息处理器实例
 * @param {Object} appContext - 应用程序上下文对象
 * @param {HTMLElement} appContext.dom.chatContainer - 聊天容器元素
 * @param {Object} appContext.services.chatHistoryManager - 聊天历史管理器
 * @param {Function} appContext.services.imageHandler.processImageTags - 处理图片标签的函数
 * @returns {Object} 消息处理API
 */
import { renderMarkdownSafe } from '../utils/markdown_renderer.js';
import { enhanceMermaidDiagrams } from '../utils/mermaid_renderer.js';
import { extractThinkingFromText, mergeThoughts } from '../utils/thoughts_parser.js';
import { normalizeResponsesReasoningText } from '../utils/responses_activity_reasoning.js';
import { buildApiFooterRenderData } from '../utils/api_footer_template.js';
import {
  formatResponsesToolOutputForDisplay,
  hasResponsesToolOutputBody
} from '../utils/responses_tool_output.js';

/**
 * 纯函数：从 pageInfo 中提取“可持久化的页面元数据快照”（仅 url/title）。
 *
 * 为什么要做这一步：
 * - sidebar 里的 state.pageInfo 会随着用户切换标签页实时更新；
 * - 但“对话记录的来源页面”更符合直觉的语义是：以首条用户消息发出时所在的页面为准；
 * - 因此在创建首条用户消息节点时，冻结一份小而稳定的 {url,title}，供首次落盘会话时使用。
 *
 * 注意：
 * - 这里刻意不保存 pageInfo.content 等大字段，避免 IndexedDB 膨胀；
 * - 若 url/title 都为空，则返回 null（表示无法确定来源页）。
 *
 * @param {any} pageInfo
 * @returns {{url: string, title: string} | null}
 */
function createPageMetaSnapshot(pageInfo) {
  const url = typeof pageInfo?.url === 'string' ? pageInfo.url.trim() : '';
  const title = typeof pageInfo?.title === 'string' ? pageInfo.title.trim() : '';
  if (!url && !title) return null;
  return { url, title };
}

function buildMessageSelector(rawMessageId) {
  if (!rawMessageId) return '';
  const raw = String(rawMessageId);
  const safeId = (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
    ? CSS.escape(raw)
    : raw.replace(/["\\]/g, '\\$&');
  return `.message[data-message-id="${safeId}"]`;
}

/**
 * 规范化 pathname，避免“尾部斜杠差异”导致的同页误判。
 * - 根路径 "/" 保持不变；
 * - 其它路径移除末尾 "/"。
 * @param {string} pathname
 * @returns {string}
 */
function normalizePathname(pathname) {
  if (typeof pathname !== 'string' || !pathname) return '/';
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

/**
 * 安全解析 URL：失败时返回 null，避免在纯函数中抛错。
 * @param {string} value
 * @returns {URL|null}
 */
function safeParseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new URL(value);
  } catch (_) {
    return null;
  }
}

/**
 * 生成“Markdown 链接解析上下文”，提前缓存 base URL，避免重复解析。
 * @param {string} baseUrl - 当前页面 URL（来自 content script 的 pageInfo）
 * @param {boolean} isStandalone - 是否独立模式（非 iframe）
 * @returns {{ baseUrl: string, base: URL|null, isStandalone: boolean }}
 */
function buildMarkdownLinkContext(baseUrl, isStandalone) {
  const normalizedBase = (typeof baseUrl === 'string') ? baseUrl.trim() : '';
  return {
    baseUrl: normalizedBase,
    base: safeParseUrl(normalizedBase),
    isStandalone: !!isStandalone
  };
}

/**
 * 解析 Markdown 链接并产出“打开策略”。
 *
 * 设计说明（新接手同学重点看这里）：
 * - 侧栏运行在扩展 iframe 内，Markdown 的相对链接/哈希默认会解析到扩展页面；
 * - 这会导致“本页内跳转”失效（例如 #anchor、#:~:text 或 ?t= 时间跳转）；
 * - 因此需要用“当前页面 URL”作为 base 重新解析，并判断是否属于“同页跳转”。
 *
 * 判定规则：
 * - 仅在 iframe 模式（非 standalone）下生效；
 * - 若解析后与当前页面“同源 + 同路径”，视为“同页跳转”，在当前标签页打开（target=_top）；
 * - 其它链接保持新标签页打开（target=_blank）；
 * - 无论打开方式如何，只要能解析出绝对 URL，就回写到 href，确保相对链接指向正确页面。
 *
 * @param {string} rawHref - 原始 href（未解析）
 * @param {{ baseUrl: string, base: URL|null, isStandalone: boolean }} context
 * @returns {{ resolvedUrl: string, target: string, rel: string }}
 */
function getMarkdownLinkPolicy(rawHref, context) {
  const result = {
    resolvedUrl: '',
    target: '_blank',
    rel: 'noopener noreferrer'
  };

  const hrefText = (typeof rawHref === 'string') ? rawHref.trim() : '';
  if (!hrefText) return result;

  const base = context?.base || null;
  let resolved = null;
  if (base) {
    try {
      resolved = new URL(hrefText, base.href);
    } catch (_) {
      resolved = null;
    }
  } else {
    resolved = safeParseUrl(hrefText);
  }

  if (resolved) {
    result.resolvedUrl = resolved.href;
  }

  // 独立模式不做“同页跳转”判断，避免导航离开扩展页面。
  if (context?.isStandalone) return result;

  if (!base || !resolved) return result;

  const sameOrigin = resolved.origin === base.origin;
  const samePath = normalizePathname(resolved.pathname) === normalizePathname(base.pathname);

  if (sameOrigin && samePath) {
    result.target = '_top';
    result.rel = '';
  }

  return result;
}

export function createMessageProcessor(appContext) {
  const {
    dom,
    services,
    state,
    utils
  } = appContext;

  const chatContainer = dom.chatContainer;
  const chatHistoryManager = services.chatHistoryManager;
  const imageHandler = services.imageHandler;
  const scrollToBottom = utils.scrollToBottom;
  const settingsManager = services.settingsManager;
  const apiManager = services.apiManager;
  
  // 保留占位：数学渲染现改为在 Markdown 渲染阶段由 KaTeX 完成

  /**
   * 为 Markdown 渲染区域设置“智能链接打开策略”。
   * @param {HTMLElement} rootElement - 消息容器或具体的 Markdown 区域
   */
  function decorateMarkdownLinks(rootElement) {
    if (!rootElement || typeof rootElement.querySelectorAll !== 'function') return;

    const baseUrl = (typeof state?.pageInfo?.url === 'string') ? state.pageInfo.url : '';
    const linkContext = buildMarkdownLinkContext(baseUrl, state?.isStandalone);

    const containers = [];
    if (typeof rootElement.matches === 'function' && rootElement.matches('.text-content, .thoughts-content, .response-activity-content--reasoning')) {
      containers.push(rootElement);
    }
    rootElement.querySelectorAll('.text-content, .thoughts-content, .response-activity-content--reasoning').forEach((node) => containers.push(node));

    const uniqueContainers = Array.from(new Set(containers));
    if (!uniqueContainers.length) {
      uniqueContainers.push(rootElement);
    }
    uniqueContainers.forEach((container) => {
      container.querySelectorAll('a').forEach((link) => {
        const rawHref = link.getAttribute('href') || '';
        const policy = getMarkdownLinkPolicy(rawHref, linkContext);
        const isSamePage = policy.target === '_top';
        const rawTextFragment = typeof rawHref === 'string' && rawHref.includes(':~:text=');
        const resolvedTextFragment = typeof policy.resolvedUrl === 'string' && policy.resolvedUrl.includes('#:~:text=');
        const hasTextFragment = rawTextFragment || resolvedTextFragment;

        if (policy.resolvedUrl) {
          link.setAttribute('href', policy.resolvedUrl);
          link.dataset.cerebrResolvedUrl = policy.resolvedUrl;
        } else {
          delete link.dataset.cerebrResolvedUrl;
        }

        link.target = policy.target;
        if (policy.rel) {
          link.setAttribute('rel', policy.rel);
        } else {
          link.removeAttribute('rel');
        }
        link.dataset.cerebrSamePage = isSamePage ? 'true' : 'false';
        link.dataset.cerebrTextFragment = hasTextFragment ? 'true' : 'false';
      });
    });
  }

  let markdownLinkInterceptorInstalled = false;

  /**
   * 在侧栏内拦截“同页跳转”链接，交由父页面执行跳转/定位。
   * 目的：解决 text fragment 在 iframe 内点击无效的问题。
   */
  function installMarkdownLinkInterceptor() {
    if (markdownLinkInterceptorInstalled) return;
    const handler = (event) => {
      if (!event || event.defaultPrevented) return;
      if (event.button !== 0) return; // 仅处理左键点击
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      const link = target.closest('a');
      if (!link) return;
      if (link.dataset.cerebrSamePage !== 'true') return;
      if (link.dataset.cerebrTextFragment !== 'true') return;

      const url = link.dataset.cerebrResolvedUrl || link.getAttribute('href') || '';
      if (!url) return;
      if (!window.parent || window.parent === window) return;

      event.preventDefault();
      event.stopPropagation();
      window.parent.postMessage({ type: 'OPEN_MARKDOWN_LINK', url }, '*');
    };

    if (chatContainer) {
      chatContainer.addEventListener('click', handler);
    }
    if (dom?.threadContainer && dom.threadContainer !== chatContainer) {
      dom.threadContainer.addEventListener('click', handler);
    }
    markdownLinkInterceptorInstalled = true;
  }

  function resolveMessageElement(messageId) {
    if (!messageId) return null;
    const selector = buildMessageSelector(messageId);
    if (!selector) return null;
    let element = chatContainer?.querySelector(selector) || null;
    if (element) return element;

    const threadContainer = dom?.threadContainer || null;
    if (threadContainer && threadContainer !== chatContainer) {
      element = threadContainer.querySelector(selector) || null;
    }
    return element;
  }

  function resolveScrollContainerForMessage(messageElement) {
    if (!messageElement) return chatContainer;
    const threadContainer = dom?.threadContainer || null;
    if (threadContainer && threadContainer.contains(messageElement)) {
      // 若线程容器嵌入在 chatContainer 内（侧栏模式），滚动容器仍应使用 chatContainer
      const isNestedInChat = typeof threadContainer.closest === 'function'
        ? !!threadContainer.closest('#chat-container')
        : false;
      if (!isNestedInChat) {
        return threadContainer;
      }
    }
    return chatContainer;
  }

  function resolveMessageListContainer(messageElement) {
    if (!messageElement) return chatContainer;
    const threadContainer = dom?.threadContainer || null;
    if (threadContainer && threadContainer.contains(messageElement)) {
      return threadContainer;
    }
    return chatContainer;
  }

  // 选区保护：当用户正在选中某条 AI 消息中的文本时，暂停对这条消息做整段 innerHTML 重渲染。
  //
  // 背景：
  // - 流式输出会频繁调用 updateAIMessage；
  // - 现有实现每次都会重写 `.text-content.innerHTML`，浏览器会把旧文本节点整体替换掉；
  // - 一旦用户正在选中文本，Range 绑定的节点被替换，选区就会闪烁、坍塌或直接消失。
  //
  // 这里采用“延迟渲染而不是强行恢复选区”的策略：
  // - 生成过程继续收流、继续写历史节点；
  // - 仅把这条消息的“最新待渲染快照”缓存在内存里；
  // - 等用户取消选区后，再把最后一版内容一次性渲染到 DOM。
  //
  // 这样做的优点是：
  // - 不需要把 DOM Range 映射回 Markdown/高亮后的复杂 HTML；
  // - 不会因为代码块高亮、KaTeX、折叠块等二次渲染而引入新的偏移误差；
  // - 代价只是“选中期间这条消息暂停视觉更新”，对交互更稳定。
  const deferredAiRenderByMessageId = new Map();
  let deferredAiRenderFlushRafId = null;

  function getSafeWindowSelection() {
    try {
      return window.getSelection ? window.getSelection() : null;
    } catch (_) {
      return null;
    }
  }

  function isNodeInsideMessage(node, messageElement) {
    if (!node || !messageElement || typeof messageElement.contains !== 'function') return false;
    return messageElement.contains(node);
  }

  function isMessageRenderBlockedBySelection(messageElement) {
    const selection = getSafeWindowSelection();
    if (!messageElement || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return false;
    }
    return isNodeInsideMessage(selection.anchorNode, messageElement)
      && isNodeInsideMessage(selection.focusNode, messageElement);
  }

  function clearDeferredAiRenderFlag(messageElement) {
    if (!messageElement?.dataset) return;
    delete messageElement.dataset.selectionRenderDeferred;
  }

  function markDeferredAiRender(messageId, payload, messageElement = null) {
    if (!messageId || !payload) return;
    deferredAiRenderByMessageId.set(messageId, payload);
    if (messageElement?.dataset) {
      messageElement.dataset.selectionRenderDeferred = 'true';
    }
  }

  // --- 超长对话虚拟化（远距离消息折叠）---
  // 目标：当消息数量极大时，只让“视野附近”的消息保持完整 DOM；
  //      对于视野很远处的消息，仅保留高度占位，从而显著降低布局/绘制压力。
  const messageVirtualizer = createMessageVirtualizer();

  function createMessageVirtualizer() {
    const virtualizedMap = new WeakMap();
    const containerStateMap = new WeakMap();

    // 可调参数：数值越大，越保守（渲染更多消息）；越小越激进（虚拟化更多消息）。
    const MIN_MESSAGES_FOR_VIRTUALIZE = 120;
    const KEEP_BUFFER_MULTIPLIER = 1.2; // 视口上下各保留 1.2x 高度
    const DROP_BUFFER_MULTIPLIER = 2.8; // 超过 2.8x 视口高度才进入虚拟化
    const MIN_KEEP_BUFFER_PX = 800;
    const MIN_DROP_BUFFER_PX = 1600;
    const PIN_TAIL_COUNT = 6; // 永远保留末尾若干消息（流式更新/快速查看）
    const BLUR_CULL_BUFFER_MULTIPLIER = 1.1; // 离屏模糊剔除缓冲区（避免临界抖动）
    const MIN_BLUR_CULL_BUFFER_PX = 420;

    function getContainerState(container) {
      let state = containerStateMap.get(container);
      if (!state) {
        state = {
          raf: null,
          pending: false,
          installed: false,
          scrollHandler: null,
          resizeObserver: null,
          mutationObserver: null,
          blurCullActive: false
        };
        containerStateMap.set(container, state);
      }
      return state;
    }

    function shouldPinMessage(messageEl, index, total, tailStart) {
      if (!messageEl || !messageEl.classList) return true;
      if (index >= tailStart) return true;
      if (messageEl.classList.contains('loading-message')) return true;
      if (messageEl.classList.contains('updating')) return true;
      if (messageEl.classList.contains('regenerating')) return true;
      if (messageEl.classList.contains('editing')) return true;
      if (messageEl.dataset?.virtualPin === '1') return true;
      try {
        if (messageEl.contains(document.activeElement)) return true;
      } catch (_) {}
      return false;
    }

    function snapshotInlineStyle(messageEl) {
      return {
        height: messageEl.style.height || '',
        minHeight: messageEl.style.minHeight || '',
        boxSizing: messageEl.style.boxSizing || '',
        overflow: messageEl.style.overflow || ''
      };
    }

    function restoreInlineStyle(messageEl, snapshot) {
      if (!messageEl) return;
      messageEl.style.height = snapshot?.height || '';
      messageEl.style.minHeight = snapshot?.minHeight || '';
      messageEl.style.boxSizing = snapshot?.boxSizing || '';
      messageEl.style.overflow = snapshot?.overflow || '';
    }

    function virtualizeMessage(messageEl) {
      if (!messageEl || messageEl.dataset?.virtualized === '1') return;
      const measuredHeight = messageEl.offsetHeight || 0;
      if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) return;

      const fragment = document.createDocumentFragment();
      while (messageEl.firstChild) {
        fragment.appendChild(messageEl.firstChild);
      }

      const styleSnapshot = snapshotInlineStyle(messageEl);
      messageEl.style.boxSizing = 'border-box';
      messageEl.style.height = `${Math.round(measuredHeight)}px`;
      messageEl.style.minHeight = `${Math.round(measuredHeight)}px`;
      messageEl.style.overflow = 'hidden';
      messageEl.classList.add('message-virtualized');
      messageEl.dataset.virtualized = '1';
      messageEl.dataset.virtualHeight = String(Math.round(measuredHeight));

      virtualizedMap.set(messageEl, { fragment, styleSnapshot });
    }

    function restoreMessage(messageEl) {
      if (!messageEl || messageEl.dataset?.virtualized !== '1') return;
      const record = virtualizedMap.get(messageEl);
      if (record) {
        while (messageEl.firstChild) {
          messageEl.removeChild(messageEl.firstChild);
        }
        messageEl.appendChild(record.fragment);
        restoreInlineStyle(messageEl, record.styleSnapshot);
        virtualizedMap.delete(messageEl);
      } else {
        restoreInlineStyle(messageEl, null);
      }
      messageEl.classList.remove('message-virtualized');
      delete messageEl.dataset.virtualized;
      delete messageEl.dataset.virtualHeight;
    }

    function ensureMessageVisible(messageEl) {
      if (!messageEl) return;
      if (messageEl.dataset?.virtualized === '1') {
        restoreMessage(messageEl);
      }
    }

    // 二分查找：找到第一个 bottom > offset 的消息索引
    function findFirstIndexByBottom(list, offset) {
      let low = 0;
      let high = list.length - 1;
      let first = list.length;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const el = list[mid];
        const bottom = (el?.offsetTop || 0) + (el?.offsetHeight || 0);
        if (bottom <= offset) {
          low = mid + 1;
        } else {
          first = mid;
          high = mid - 1;
        }
      }
      return first;
    }

    // 二分查找：找到最后一个 top < offset 的消息索引
    function findLastIndexByTop(list, offset) {
      let low = 0;
      let high = list.length - 1;
      let last = -1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const el = list[mid];
        const top = el?.offsetTop || 0;
        if (top < offset) {
          last = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      return last;
    }

    function restoreAll(container) {
      if (!container) return;
      const nodes = container.querySelectorAll('.message[data-virtualized="1"]');
      nodes.forEach((node) => restoreMessage(node));
    }

    function isMessageBlurEnabled() {
      try {
        const root = document?.documentElement;
        if (!root) return false;
        const raw = window.getComputedStyle(root).getPropertyValue('--cerebr-message-blur-radius');
        const radius = Number.parseFloat(raw);
        return Number.isFinite(radius) && radius > 0.1;
      } catch (_) {
        return false;
      }
    }

    function applyOffscreenBlurCull(messages, viewportTop, viewportBottom, viewportHeight, tailStart) {
      if (!Array.isArray(messages) || !messages.length) return;
      const blurKeepBuffer = Math.max(MIN_BLUR_CULL_BUFFER_PX, viewportHeight * BLUR_CULL_BUFFER_MULTIPLIER);
      const blurKeepTop = viewportTop - blurKeepBuffer;
      const blurKeepBottom = viewportBottom + blurKeepBuffer;
      const total = messages.length;

      for (let i = 0; i < total; i += 1) {
        const node = messages[i];
        if (!node || !node.classList) continue;
        // 尾部/更新中消息保持滤镜，避免流式输出与交互中的视觉跳变。
        const pinned = shouldPinMessage(node, i, total, tailStart);
        if (pinned) {
          node.classList.remove('message-offscreen-blur-disabled');
          continue;
        }
        const top = Number(node.offsetTop) || 0;
        const height = Math.max(1, Number(node.offsetHeight) || 0);
        const bottom = top + height;
        const isOutside = bottom < blurKeepTop || top > blurKeepBottom;
        node.classList.toggle('message-offscreen-blur-disabled', isOutside);
      }
    }

    function updateContainer(container) {
      if (!container) return;
      const state = getContainerState(container);
      const messageNodes = Array.from(container.querySelectorAll('.message'));
      const messages = messageNodes.filter((node) => (node?.offsetHeight || 0) > 0);
      const total = messages.length;
      if (!total) return;

      const viewportHeight = container.clientHeight || 0;
      if (viewportHeight <= 0) return;
      const viewportTop = container.scrollTop || 0;
      const viewportBottom = viewportTop + viewportHeight;
      const tailStart = Math.max(total - PIN_TAIL_COUNT, 0);
      const messageBlurEnabled = isMessageBlurEnabled();

      // 轻量优化：无论是否进入“DOM 虚拟化”，都先剔除离屏消息的 backdrop blur。
      if (messageBlurEnabled) {
        applyOffscreenBlurCull(messages, viewportTop, viewportBottom, viewportHeight, tailStart);
        state.blurCullActive = true;
      } else if (state.blurCullActive) {
        messages.forEach((node) => node.classList.remove('message-offscreen-blur-disabled'));
        state.blurCullActive = false;
      }

      if (total < MIN_MESSAGES_FOR_VIRTUALIZE) {
        restoreAll(container);
        return;
      }

      const keepBuffer = Math.max(MIN_KEEP_BUFFER_PX, viewportHeight * KEEP_BUFFER_MULTIPLIER);
      const dropBuffer = Math.max(MIN_DROP_BUFFER_PX, viewportHeight * DROP_BUFFER_MULTIPLIER);

      const keepTop = viewportTop - keepBuffer;
      const keepBottom = viewportBottom + keepBuffer;
      const dropTop = viewportTop - dropBuffer;
      const dropBottom = viewportBottom + dropBuffer;

      const firstKeepIdx = findFirstIndexByBottom(messages, keepTop);
      const lastKeepIdx = findLastIndexByTop(messages, keepBottom);
      const firstDropIdx = findFirstIndexByBottom(messages, dropTop);
      const lastDropIdx = findLastIndexByTop(messages, dropBottom);

      for (let i = 0; i < total; i += 1) {
        const node = messages[i];
        if (!node || !node.classList) continue;
        const isVirtualized = node.dataset?.virtualized === '1';
        const pinned = shouldPinMessage(node, i, total, tailStart);

        if (pinned) {
          if (isVirtualized) restoreMessage(node);
          continue;
        }

        const inKeepRange = i >= firstKeepIdx && i <= lastKeepIdx;
        const outsideDropRange = i < firstDropIdx || i > lastDropIdx;

        if (isVirtualized) {
          if (inKeepRange) restoreMessage(node);
          continue;
        }
        if (outsideDropRange) {
          virtualizeMessage(node);
        }
      }
    }

    function scheduleUpdate(container) {
      if (!container) return;
      const state = getContainerState(container);
      if (state.raf) {
        state.pending = true;
        return;
      }
      state.raf = requestAnimationFrame(() => {
        state.raf = null;
        updateContainer(container);
        if (state.pending) {
          state.pending = false;
          scheduleUpdate(container);
        }
      });
    }

    function installContainer(container) {
      if (!container) return;
      const state = getContainerState(container);
      if (state.installed) return;

      const onScroll = () => scheduleUpdate(container);
      container.addEventListener('scroll', onScroll, { passive: true });
      state.scrollHandler = onScroll;

      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => scheduleUpdate(container));
        ro.observe(container);
        state.resizeObserver = ro;
      }

      const mo = new MutationObserver(() => scheduleUpdate(container));
      mo.observe(container, { childList: true });
      state.mutationObserver = mo;

      state.installed = true;
    }

    function init() {
      installContainer(chatContainer);
      installContainer(dom?.threadContainer || null);
      scheduleUpdate(chatContainer);
      scheduleUpdate(dom?.threadContainer || null);
    }

    return {
      init,
      scheduleUpdate,
      ensureMessageVisible
    };
  }

  /**
   * 设置或更新思考过程的显示区域
   * @param {HTMLElement} messageWrapperDiv - 包裹单条消息的顶层div (e.g., .message)
   * @param {string|null} rawThoughts - 原始的思考过程文本，为null则移除该区域
   * @param {Function} processMathAndMarkdownFn - 用于处理Markdown和数学的函数引用
   */
  function setupThoughtsDisplay(messageWrapperDiv, rawThoughts, processMathAndMarkdownFn) {
    let thoughtsContentDiv = messageWrapperDiv.querySelector('.thoughts-content');

    if (rawThoughts && rawThoughts.trim() !== '') {
      let thoughtsInnerContent;
      let toggleButton;

      if (!thoughtsContentDiv) {
        thoughtsContentDiv = document.createElement('div');
        thoughtsContentDiv.className = 'thoughts-content';

        // 说明：折叠态只显示“思考内容”这一行；展开后才显示完整思考文本。
        // 设计目标：当 AI 开始输出正文（data-original-text 非空）时，默认自动折叠，避免思考块占用过多高度。
        toggleButton = document.createElement('button');
        toggleButton.className = 'thoughts-toggle';
        toggleButton.setAttribute('type', 'button');
        toggleButton.setAttribute('aria-label', '切换思考内容');
        toggleButton.setAttribute('aria-expanded', 'false');
        toggleButton.textContent = '思考内容';
        thoughtsContentDiv.appendChild(toggleButton);

        thoughtsInnerContent = document.createElement('div');
        thoughtsInnerContent.className = 'thoughts-inner-content';
        thoughtsContentDiv.appendChild(thoughtsInnerContent);

        toggleButton.addEventListener('click', (e) => {
          e.stopPropagation();
          // 用户手动操作后，不再执行“自动折叠/自动展开”，避免与用户意图冲突。
          thoughtsContentDiv.dataset.userToggled = 'true';
          const isExpanded = thoughtsContentDiv.classList.toggle('expanded');
          thoughtsContentDiv.dataset.manualState = isExpanded ? 'expanded' : 'collapsed';
          toggleButton.setAttribute('aria-expanded', isExpanded.toString());
        });
        toggleButton.dataset.listenerAdded = 'true';
        
        const textContentElement = messageWrapperDiv.querySelector('.text-content');
        if (textContentElement) {
             messageWrapperDiv.insertBefore(thoughtsContentDiv, textContentElement);
        } else {
             messageWrapperDiv.appendChild(thoughtsContentDiv); // Fallback
        }
      } else {
        // Thoughts section already exists, get its parts (兼容旧结构：清理旧的 prefix/button)
        const legacyPrefix = thoughtsContentDiv.querySelector('.thoughts-prefix');
        if (legacyPrefix) legacyPrefix.remove();
        const legacyExpandButton = thoughtsContentDiv.querySelector('.expand-thoughts-btn');
        if (legacyExpandButton) legacyExpandButton.remove();

        thoughtsInnerContent = thoughtsContentDiv.querySelector('.thoughts-inner-content');
        toggleButton = thoughtsContentDiv.querySelector('.thoughts-toggle');
        if (!toggleButton) {
          toggleButton = document.createElement('button');
          toggleButton.className = 'thoughts-toggle';
          toggleButton.setAttribute('type', 'button');
          toggleButton.setAttribute('aria-label', '切换思考内容');
          toggleButton.setAttribute('aria-expanded', 'false');
          toggleButton.textContent = '思考内容';
          thoughtsContentDiv.insertBefore(toggleButton, thoughtsContentDiv.firstChild);
        }
        if (!toggleButton.dataset.listenerAdded) {
          toggleButton.addEventListener('click', (e) => {
            e.stopPropagation();
            thoughtsContentDiv.dataset.userToggled = 'true';
            const isExpanded = thoughtsContentDiv.classList.toggle('expanded');
            thoughtsContentDiv.dataset.manualState = isExpanded ? 'expanded' : 'collapsed';
            toggleButton.setAttribute('aria-expanded', isExpanded.toString());
          });
          toggleButton.dataset.listenerAdded = 'true';
        }
        if (!thoughtsInnerContent) {
          thoughtsInnerContent = document.createElement('div');
          thoughtsInnerContent.className = 'thoughts-inner-content';
          thoughtsContentDiv.appendChild(thoughtsInnerContent);
        }
      }
      
      if (thoughtsInnerContent) {
          thoughtsInnerContent.innerHTML = processMathAndMarkdownFn(rawThoughts);
      }

      // 自动展开/折叠策略：
      // - 首次出现且仍在生成时，默认展开一次；
      // - 生成结束时，自动收起一次；
      // - 除这两个生命周期动作外，不再反复改写，避免刷新时闪烁；
      // - 用户一旦手动点击，后续刷新始终尊重用户选择。
      const isUpdating = messageWrapperDiv.classList.contains('updating')
        || isResponseActivityTurnRuntimeActive(messageWrapperDiv);
      if (
        thoughtsContentDiv.dataset.userToggled === 'true'
        && !String(thoughtsContentDiv.dataset.manualState || '').trim()
      ) {
        thoughtsContentDiv.dataset.manualState = thoughtsContentDiv.classList.contains('expanded') ? 'expanded' : 'collapsed';
      }
      const manualState = String(thoughtsContentDiv.dataset.manualState || '').trim().toLowerCase();
      const lifecycleInitialized = thoughtsContentDiv.dataset.autoLifecycleInitialized === 'true';
      const autoCollapsedAfterFinish = thoughtsContentDiv.dataset.autoCollapsedAfterFinish === 'true';
      let shouldBeExpanded = thoughtsContentDiv.classList.contains('expanded');

      if (manualState === 'expanded' || manualState === 'collapsed') {
        shouldBeExpanded = manualState === 'expanded';
      } else if (!lifecycleInitialized) {
        thoughtsContentDiv.dataset.autoLifecycleInitialized = 'true';
        if (isUpdating) {
          shouldBeExpanded = true;
          delete thoughtsContentDiv.dataset.autoCollapsedAfterFinish;
        } else {
          shouldBeExpanded = false;
          thoughtsContentDiv.dataset.autoCollapsedAfterFinish = 'true';
        }
      } else if (!autoCollapsedAfterFinish && !isUpdating) {
        shouldBeExpanded = false;
        thoughtsContentDiv.dataset.autoCollapsedAfterFinish = 'true';
      }

      thoughtsContentDiv.classList.toggle('expanded', shouldBeExpanded);
      if (toggleButton) {
        toggleButton.setAttribute('aria-expanded', shouldBeExpanded ? 'true' : 'false');
      }

    } else if (thoughtsContentDiv) {
      // No new thoughts, or thoughts are cleared, remove the entire thoughts section
      thoughtsContentDiv.remove();
    }
  }

  /**
   * 添加消息到聊天窗口
   * @param {string} text - 消息文本内容
  * @param {string} sender - 发送者 ('user' 或 'ai')
  * @param {boolean} skipHistory - 是否不更新历史记录
  * @param {DocumentFragment|null} fragment - 如使用文档片段则追加到此处，否则直接追加到聊天容器
  * @param {string|null} imagesHTML - 图片部分的 HTML 内容（可为空）
  * @param {string|null} [initialThoughtsRaw=null] - AI的初始思考过程文本 (可选)
  * @param {string|null} [messageIdToUpdate=null] - 如果是更新现有消息，则提供其ID
  * @param {{promptType?: string|null, promptMeta?: Object|null}|null} [meta=null] - 可选：写入历史节点的附加元信息（主要用于用户消息）
  * @param {{container?: HTMLElement|null, skipDom?: boolean, historyParentId?: string|null, preserveCurrentNode?: boolean, historyPatch?: Object|null}|null} [options=null] - 可选：渲染/历史写入控制
   * @returns {HTMLElement|null} 新生成或更新的消息元素（若 skipDom=true 则返回 null）
  */
  function appendMessage(text, sender, skipHistory = false, fragment = null, imagesHTML = null, initialThoughtsRaw = null, messageIdToUpdate = null, meta = null, options = null) {
    const renderOptions = (options && typeof options === 'object') ? options : {};
    const targetContainer = renderOptions.container || chatContainer;
    const shouldRenderDom = !renderOptions.skipDom;
    const historyParentId = (typeof renderOptions.historyParentId === 'string' && renderOptions.historyParentId.trim())
      ? renderOptions.historyParentId.trim()
      : chatHistoryManager.chatHistory.currentNode;
    const preserveCurrentNode = !!renderOptions.preserveCurrentNode;
    const historyPatch = (renderOptions.historyPatch && typeof renderOptions.historyPatch === 'object')
      ? renderOptions.historyPatch
      : null;

    let messageDiv;
    let node;
    // 提前拆分 <think> 段落，确保正文与思考摘要分离
    let messageText = text;
    let thoughtsForMessage = initialThoughtsRaw;
    if (typeof messageText === 'string') {
      const thinkExtraction = extractThinkingFromText(messageText);
      if (thinkExtraction.thoughtText) {
        thoughtsForMessage = mergeThoughts(thoughtsForMessage, thinkExtraction.thoughtText);
        messageText = thinkExtraction.cleanText;
      }
    }

    if (shouldRenderDom) {
      if (messageIdToUpdate) {
        const selector = buildMessageSelector(messageIdToUpdate);
        messageDiv = selector ? targetContainer.querySelector(selector) : null;
        if (!messageDiv) {
          console.error('appendMessage: 试图更新的消息未找到 DOM 元素', messageIdToUpdate);
          // Create a new one if update target is missing, this indicates a potential logic flaw elsewhere
          messageDiv = document.createElement('div');
          messageDiv.classList.add('message', `${sender}-message`);
          if (fragment) messageDiv.classList.add('batch-load'); // if it was intended for a fragment
        }
        // For updates, main text and thoughts are handled by updateAIMessage or setupThoughtsDisplay called from there.
        // appendMessage when messageIdToUpdate is present is mostly for ensuring the messageDiv exists.
        // So, we'll mostly clear and let updateAIMessage fill.
        // However, this function signature with messageIdToUpdate might be part of a specific workflow.
        // For now, let's assume if messageIdToUpdate is given, it's for initial AI message shell creation in streaming.
        // And actual content updates will be handled by updateAIMessage.

      } else {
        messageDiv = document.createElement('div');
        messageDiv.classList.add('message', `${sender}-message`);
      }

      if (fragment && !messageIdToUpdate) {
        messageDiv.classList.add('batch-load');
      }

      messageDiv.setAttribute('data-original-text', messageText); // Main answer text
      // thoughtsForMessage is handled below by setupThoughtsDisplay

      if (imagesHTML && imagesHTML.trim() && !messageIdToUpdate) {
        const imageContentDiv = document.createElement('div');
        imageContentDiv.classList.add('image-content');
        imageContentDiv.innerHTML = imagesHTML;
        imageContentDiv.querySelectorAll('img').forEach(img => {
          img.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            imageHandler.showImagePreview(img.src);
          });
        });
        messageDiv.appendChild(imageContentDiv);
      }
      
      // Setup thoughts display (handles creation/removal)
      // Pass `processMathAndMarkdown` from the outer scope
      setupThoughtsDisplay(messageDiv, thoughtsForMessage, processMathAndMarkdown);


      let textContentDiv = messageDiv.querySelector('.text-content');
      if (!textContentDiv) {
          textContentDiv = document.createElement('div');
          textContentDiv.classList.add('text-content');
          // Ensure textContentDiv is after thoughtsDiv if thoughtsDiv was added
          const thoughtsDiv = messageDiv.querySelector('.thoughts-content');
          if (thoughtsDiv && thoughtsDiv.nextSibling) {
              messageDiv.insertBefore(textContentDiv, thoughtsDiv.nextSibling);
          } else {
              messageDiv.appendChild(textContentDiv);
          }
      }
      try {
        if (sender === 'user') {
          textContentDiv.innerText = messageText;
        } else {
          textContentDiv.innerHTML = processMathAndMarkdown(messageText);
        }
      } catch (error) {
        console.error('处理数学公式和Markdown失败:', error);
        textContentDiv.innerText = messageText;
      }
      
      enhanceMarkdownContent(messageDiv);

      // 数学公式已在渲染阶段通过 KaTeX 输出，无需二次 auto-render

      if (!messageIdToUpdate) {
        if (fragment) {
          fragment.appendChild(messageDiv);
        } else if (targetContainer) {
          targetContainer.appendChild(messageDiv);
        }
      }
      
      // 为消息元素添加双击事件监听器，用于展开/折叠 foldMessageContent 创建的 details 元素
      if (!messageDiv.dataset.dblclickListenerAdded) {
        messageDiv.addEventListener('dblclick', function(event) { // 使用 function 关键字使 this 指向 messageDiv
          const detailsElement = this.querySelector('details.folded-message');
          if (detailsElement) {
            const summaryElement = detailsElement.querySelector('summary');
            if (summaryElement && summaryElement.contains(event.target)) {
              return;
            }

            const scrollContainer = targetContainer || chatContainer; // chatContainer 来自外部作用域
            // const scrollYBefore = scrollContainer.scrollTop; // 不再需要
            // const rectBefore = this.getBoundingClientRect(); // 不再需要

            // 切换 details 元素的 open 状态
            if (detailsElement.hasAttribute('open')) {
              detailsElement.removeAttribute('open');
            } else {
              detailsElement.setAttribute('open', '');
            }

            // 使用 requestAnimationFrame 等待浏览器完成布局更新
            requestAnimationFrame(() => {
              const messageTopRelativeToViewport = this.getBoundingClientRect().top;
              const scrollContainerTopRelativeToViewport = scrollContainer.getBoundingClientRect().top;
              const offsetToScroll = messageTopRelativeToViewport - scrollContainerTopRelativeToViewport;
              scrollContainer.scrollTop += offsetToScroll;
            });
          }
        });
      messageDiv.dataset.dblclickListenerAdded = 'true';
    }
  } else {
    messageDiv = null;
  }
    
    if (!skipHistory) {
      if (messageIdToUpdate) {
        node = chatHistoryManager.chatHistory.messages.find(m => m.id === messageIdToUpdate);
        if (node) {
          node.content = messageText; // Main answer
          if (thoughtsForMessage !== undefined) { // Allow setting thoughts to null/empty
             node.thoughtsRaw = thoughtsForMessage;
          }
          if (historyPatch && typeof historyPatch === 'object') {
            Object.assign(node, historyPatch);
          }
        } else {
             console.warn(`appendMessage: History node not found for update: ${messageIdToUpdate}`);
        }
      } else {
        const processedContent = imageHandler.processImageTags(messageText, imagesHTML);
        const addWithOptions = typeof chatHistoryManager.addMessageToTreeWithOptions === 'function'
          && (preserveCurrentNode || historyParentId !== chatHistoryManager.chatHistory.currentNode);
        if (addWithOptions) {
          node = chatHistoryManager.addMessageToTreeWithOptions(
            sender === 'user' ? 'user' : 'assistant',
            processedContent,
            historyParentId,
            { preserveCurrentNode }
          );
        } else {
          node = chatHistoryManager.addMessageToTree(
            sender === 'user' ? 'user' : 'assistant',
            processedContent,
            historyParentId
          );
        }
        if (thoughtsForMessage) {
          node.thoughtsRaw = thoughtsForMessage;
        }
        if (node) {
          node.hasInlineImages = (!imagesHTML && Array.isArray(processedContent) && processedContent.some(p => p?.type === 'image_url'));
        }
        // 将“指令类型”等元信息写入历史节点（只对用户消息生效）
        // 说明：这类信息一旦持久化，后续功能（例如对话标题生成）即可完全脱离“字符串/正则”猜测。
        if (node && node.role === 'user' && meta && typeof meta === 'object') {
          if (typeof meta.promptType === 'string') {
            node.promptType = meta.promptType;
          }
          if (meta.promptMeta && typeof meta.promptMeta === 'object') {
            node.promptMeta = meta.promptMeta;
          }
        }

        if (node && historyPatch && typeof historyPatch === 'object') {
          Object.assign(node, historyPatch);
        }

        // 关键：仅在“首条用户消息”写入页面元数据快照，用于固定会话来源页。
        // 这样即使在 AI 生成过程中用户切换到其它标签页，最终落盘的会话 URL/标题也不会被错误覆盖。
        try {
          if (node && node.role === 'user') {
            const hasOtherUserMessage = chatHistoryManager.chatHistory.messages.some(
              (m) => m && m.id !== node.id && String(m.role || '').toLowerCase() === 'user'
            );
            if (!hasOtherUserMessage) {
              const snapshot = createPageMetaSnapshot(state?.pageInfo);
              if (snapshot) node.pageMeta = snapshot;
            }
          }
        } catch (e) {
          console.warn('写入首条用户消息 pageMeta 失败（将回退为保存时读取 pageInfo）:', e);
        }
        if (messageDiv && node) {
          messageDiv.setAttribute('data-message-id', node.id);
          // 初次创建 AI 消息时插入一个空的 API footer，占位以便样式稳定
          if (sender === 'ai') {
            const apiFooter = document.createElement('div');
            apiFooter.className = 'api-footer';
            messageDiv.appendChild(apiFooter);
          }
        }
      }

      if (sender === 'ai' && !messageIdToUpdate && messageDiv) {
        messageDiv.classList.add('updating');
      }
    }

    // 如果存在划词线程管理器，则在渲染后补充高亮装饰
    try {
      if (messageDiv && node) {
        services.selectionThreadManager?.decorateMessageElement?.(messageDiv, node);
      }
    } catch (e) {
      console.warn('应用划词线程高亮失败:', e);
    }
    if (shouldRenderDom && messageDiv && targetContainer) {
      messageVirtualizer.scheduleUpdate(targetContainer);
    }
    return messageDiv;
  }

  function renderAiMessageDom(messageDiv, node, safeAnswerContent, resolvedThoughts) {
    if (!messageDiv) return false;

    clearDeferredAiRenderFlag(messageDiv);

    // 统一清理“错误态”残留，避免重试成功后仍显示红字/旧重试按钮。
    try {
      messageDiv.classList.remove('error-message');
      messageDiv.classList.remove('loading-message');
      messageDiv.classList.remove('regenerating');
      const retryActions = messageDiv.querySelectorAll('.error-retry-actions');
      retryActions.forEach((actionEl) => actionEl.remove());
      const rootTextNodes = Array.from(messageDiv.childNodes || []).filter(node => node && node.nodeType === 3);
      rootTextNodes.forEach((node) => node.remove());
    } catch (_) {}

    messageDiv.setAttribute('data-original-text', safeAnswerContent);
    // 思考过程文本由 setupThoughtsDisplay 统一处理
    setupThoughtsDisplay(messageDiv, resolvedThoughts, processMathAndMarkdown);

    let textContentDiv = messageDiv.querySelector('.text-content');
    if (!textContentDiv) {
      textContentDiv = document.createElement('div');
      textContentDiv.classList.add('text-content');
      const thoughtsDiv = messageDiv.querySelector('.thoughts-content');
      if (thoughtsDiv && thoughtsDiv.nextSibling) {
        messageDiv.insertBefore(textContentDiv, thoughtsDiv.nextSibling);
      } else {
        messageDiv.appendChild(textContentDiv);
      }
    }

    textContentDiv.innerHTML = processMathAndMarkdown(safeAnswerContent);

    enhanceMarkdownContent(messageDiv);
    setupResponseToolCallsDisplay(messageDiv, node.response_tool_calls || null);

    try {
      services.selectionThreadManager?.decorateMessageElement?.(messageDiv, node);
    } catch (e) {
      console.warn('更新 AI 消息时应用划词线程高亮失败:', e);
    }
    scrollToBottom(resolveScrollContainerForMessage(messageDiv));
    messageVirtualizer.scheduleUpdate(resolveMessageListContainer(messageDiv));
    return true;
  }

  function flushDeferredAiRenders() {
    if (!deferredAiRenderByMessageId.size) return;

    for (const [messageId, payload] of deferredAiRenderByMessageId.entries()) {
      const messageDiv = resolveMessageElement(messageId);
      if (!messageDiv) {
        deferredAiRenderByMessageId.delete(messageId);
        continue;
      }
      if (isMessageRenderBlockedBySelection(messageDiv)) {
        continue;
      }

      deferredAiRenderByMessageId.delete(messageId);
      renderAiMessageDom(
        messageDiv,
        payload?.node || null,
        payload?.safeAnswerContent || '',
        payload?.resolvedThoughts
      );
    }
  }

  function formatResponseToolCallArguments(rawArguments) {
    const text = (typeof rawArguments === 'string') ? rawArguments.trim() : '';
    if (!text) return '';
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch (_) {
      return text;
    }
  }

  const RESPONSE_ACTIVITY_JS_RUNTIME_TOOL_NAME = 'js_runtime_execute';

  function parseResponseToolCallArgumentsObject(rawArguments) {
    const text = (typeof rawArguments === 'string') ? rawArguments.trim() : '';
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function isResponseActivityJsRuntimeEntry(record) {
    return String(record?.type || '').toLowerCase() === 'function_call'
      && String(record?.name || '').trim().toLowerCase() === RESPONSE_ACTIVITY_JS_RUNTIME_TOOL_NAME;
  }

  function getResponseActivityJsRuntimeMeta(record) {
    const parsedArgs = parseResponseToolCallArgumentsObject(record?.arguments);
    const code = (typeof parsedArgs?.code === 'string') ? parsedArgs.code : '';
    const frameIds = Array.isArray(parsedArgs?.frame_ids)
      ? parsedArgs.frame_ids
        .map(value => Number(value))
        .filter(value => Number.isFinite(value))
        .map(value => Math.trunc(value))
      : [];
    return {
      code,
      frameIds,
      isTopLevel: frameIds.length <= 0
    };
  }

  function formatResponseActivityJsCodePreview(code) {
    const text = (typeof code === 'string') ? code : '';
    return text
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function formatResponseToolCallOutput(rawOutput) {
    return formatResponsesToolOutputForDisplay(rawOutput);
  }

  function buildResponseActivityJsRuntimeSummaryParts(record) {
    const meta = getResponseActivityJsRuntimeMeta(record);
    const codePreview = formatResponseActivityJsCodePreview(meta.code) || 'JavaScript';
    const action = meta.isTopLevel
      ? '已运行'
      : `已在${meta.frameIds.length}个iframe运行`;
    return {
      action,
      value: codePreview,
      valueUrl: '',
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  function renderResponseActivityJsRuntimeBody(toolBodyInner, entry) {
    if (!toolBodyInner || !entry) return;
    const meta = getResponseActivityJsRuntimeMeta(entry);
    const formattedOutput = formatResponseToolCallOutput(entry.output);

    const codeTitle = document.createElement('div');
    codeTitle.className = 'response-activity-tool-block-title';
    codeTitle.textContent = '代码';
    toolBodyInner.appendChild(codeTitle);

    const codeBlock = document.createElement('pre');
    codeBlock.className = 'response-activity-tool-code';
    const codeInner = document.createElement('code');
    codeInner.className = 'language-javascript';
    codeInner.textContent = meta.code || '';
    codeBlock.appendChild(codeInner);
    toolBodyInner.appendChild(codeBlock);

    if (formattedOutput) {
      const outputTitle = document.createElement('div');
      outputTitle.className = 'response-activity-tool-block-title';
      outputTitle.textContent = '返回值';
      toolBodyInner.appendChild(outputTitle);

      const outputBlock = document.createElement('pre');
      outputBlock.className = 'response-activity-tool-output';
      outputBlock.textContent = formattedOutput;
      toolBodyInner.appendChild(outputBlock);
    }
  }

  /**
   * 渲染“非 JS 自定义/内置工具”的详情体。
   *
   * 说明：
   * - 之前这里主要展示参数与 sources；
   * - 但现在像 `history_search` / `history_read` 这类函数工具，真正重要的是返回值；
   * - 因此把通用 output 也纳入详情区，避免工具已成功执行但 UI 看不到结果。
   *
   * @param {HTMLElement} toolBodyInner
   * @param {Object} entry
   */
  function renderResponseActivityGenericToolBody(toolBodyInner, entry) {
    if (!toolBodyInner || !entry) return;

    getResponseActivityToolSecondaryLines(entry).forEach((line) => {
      const secondary = document.createElement('div');
      secondary.className = 'response-activity-tool-secondary';
      secondary.textContent = line;
      toolBodyInner.appendChild(secondary);
    });

    if (typeof entry.arguments === 'string' && entry.arguments.trim()) {
      const pre = document.createElement('pre');
      pre.className = 'response-activity-tool-arguments';
      pre.textContent = formatResponseToolCallArguments(entry.arguments);
      toolBodyInner.appendChild(pre);
    }

    const formattedOutput = formatResponseToolCallOutput(entry.output);
    if (formattedOutput) {
      const outputTitle = document.createElement('div');
      outputTitle.className = 'response-activity-tool-block-title';
      outputTitle.textContent = '返回值';
      toolBodyInner.appendChild(outputTitle);

      const outputBlock = document.createElement('pre');
      outputBlock.className = 'response-activity-tool-output';
      outputBlock.textContent = formattedOutput;
      toolBodyInner.appendChild(outputBlock);
    }

    if (Array.isArray(entry.sources) && entry.sources.length > 0) {
      const sources = document.createElement('details');
      sources.className = 'response-activity-tool-sources';

      const sourceSummary = document.createElement('summary');
      sourceSummary.className = 'response-activity-tool-source-title';
      sourceSummary.textContent = `来源 ${entry.sources.length}`;
      sources.appendChild(sourceSummary);

      const sourceList = document.createElement('div');
      sourceList.className = 'response-activity-tool-source-list';
      entry.sources.forEach((source) => {
        const label = source.title || source.domain || source.url || '未命名来源';
        if (source.url) {
          const link = document.createElement('a');
          link.className = 'response-activity-tool-source-link';
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.href = source.url;
          link.textContent = label;
          sourceList.appendChild(link);
        } else {
          const text = document.createElement('span');
          text.className = 'response-activity-tool-source-link';
          text.textContent = label;
          sourceList.appendChild(text);
        }
      });
      sources.appendChild(sourceList);
      toolBodyInner.appendChild(sources);
    }
  }

  function getResponseToolCallTypeLabel(record) {
    const type = String(record?.type || '').toLowerCase();
    if (type === 'web_search_call') return '搜索';
    if (type === 'code_interpreter_call') return '代码解释器';
    if (isResponseActivityJsRuntimeEntry(record)) return 'JS';
    if (type === 'function_call') return '函数';
    return type || 'tool';
  }

  function getResponseToolCallActionLabel(actionType) {
    const normalized = String(actionType || '').toLowerCase();
    if (normalized === 'search') return '搜索';
    if (normalized === 'open_page') return '查看';
    if (normalized === 'find_in_page') return '页内查找';
    return normalized || '调用';
  }

  function getResponseActivityStatusLabel(status) {
    const normalized = String(status || '').toLowerCase();
    if (!normalized) return '';
    if (normalized === 'streaming' || normalized === 'in_progress') return '进行中';
    if (normalized === 'completed' || normalized === 'done') return '完成';
    return normalized;
  }

  function buildResponseToolCallPrimaryText(record) {
    if (!record || typeof record !== 'object') return '工具调用';
    const type = String(record.type || '').toLowerCase();
    if (type === 'web_search_call') {
      const actionLabel = getResponseToolCallActionLabel(record.action_type);
      const query = (typeof record.query === 'string' && record.query.trim()) ? record.query.trim() : '';
      const title = (typeof record.title === 'string' && record.title.trim()) ? record.title.trim() : '';
      const url = (typeof record.url === 'string' && record.url.trim()) ? record.url.trim() : '';
      const pattern = (typeof record.pattern === 'string' && record.pattern.trim()) ? record.pattern.trim() : '';
      if (String(record.action_type || '').toLowerCase() === 'search') {
        return query || title || pattern || url || actionLabel;
      }
      if (String(record.action_type || '').toLowerCase() === 'find_in_page') {
        const subject = pattern || query || '查找内容';
        const pageLabel = title || url;
        return pageLabel ? `${subject} 在 ${pageLabel}` : subject;
      }
      const subject = query || title || pattern || url;
      return subject ? `${actionLabel} ${subject}` : actionLabel;
    }
    if (isResponseActivityJsRuntimeEntry(record)) {
      const parts = buildResponseActivityJsRuntimeSummaryParts(record);
      return `${parts.action} ${parts.value}`.trim();
    }
    if (type === 'function_call') {
      const name = (typeof record.name === 'string' && record.name.trim()) ? record.name.trim() : '匿名函数';
      return `调用函数 ${name}`;
    }
    if (type === 'code_interpreter_call') {
      return '运行 Python';
    }
    return getResponseToolCallTypeLabel(record);
  }

  /**
   * 将工具调用主文案拆成“淡色动作词 + 正常色变量值”的结构，
   * 这样可以用颜色层级替代多余的冒号、括号等符号噪音。
   */
  function buildResponseToolCallPrimaryParts(record) {
    if (!record || typeof record !== 'object') {
      return { action: '', value: '工具调用', valueUrl: '', locationAction: '', locationValue: '', locationUrl: '' };
    }
    const type = String(record.type || '').toLowerCase();
    if (type === 'web_search_call') {
      const actionType = String(record.action_type || '').toLowerCase();
      const actionLabel = getResponseToolCallActionLabel(actionType);
      const query = (typeof record.query === 'string' && record.query.trim()) ? record.query.trim() : '';
      const title = (typeof record.title === 'string' && record.title.trim()) ? record.title.trim() : '';
      const url = (typeof record.url === 'string' && record.url.trim()) ? record.url.trim() : '';
      const pattern = (typeof record.pattern === 'string' && record.pattern.trim()) ? record.pattern.trim() : '';
      if (actionType === 'search') {
        return {
          action: '',
          value: query || title || pattern || url || actionLabel,
          valueUrl: ''
        };
      }
      if (actionType === 'find_in_page') {
        return {
          action: '',
          value: pattern || query || '查找内容',
          valueUrl: '',
          locationAction: (title || url) ? '在' : '',
          locationValue: title || url,
          locationUrl: url
        };
      }
      return {
        action: actionLabel,
        value: title || url || query || pattern || '',
        valueUrl: url
      };
    }
    if (isResponseActivityJsRuntimeEntry(record)) {
      return buildResponseActivityJsRuntimeSummaryParts(record);
    }
    if (type === 'function_call') {
      const name = (typeof record.name === 'string' && record.name.trim()) ? record.name.trim() : '匿名函数';
      return {
        action: '调用函数',
        value: name,
        valueUrl: ''
      };
    }
    if (type === 'code_interpreter_call') {
      return {
        action: '运行',
        value: 'Python',
        valueUrl: ''
      };
    }
    return {
      action: '',
      value: getResponseToolCallTypeLabel(record),
      valueUrl: ''
    };
  }

  function buildResponseActivityTimelineFromLegacyMetadata(node) {
    if (!node || typeof node !== 'object') return [];
    const timeline = [];
    const reasoningSummary = (typeof node.response_reasoning_summary === 'string')
      ? node.response_reasoning_summary.trim()
      : '';
    if (reasoningSummary) {
      timeline.push({
        kind: 'reasoning_summary',
        id: 'legacy_reasoning_summary',
        status: 'completed',
        text: reasoningSummary
      });
    }
    if (Array.isArray(node.response_tool_calls)) {
      node.response_tool_calls.forEach((record, index) => {
        if (!record || typeof record !== 'object') return;
        timeline.push({
          kind: 'tool_call',
          id: record.id || `legacy_tool_${index}`,
          ...record
        });
      });
    }
    return timeline;
  }

  function getResponseActivityTimeline(node) {
    if (!node || typeof node !== 'object') return [];
    const source = Array.isArray(node.response_activity_timeline) && node.response_activity_timeline.length > 0
      ? node.response_activity_timeline
      : buildResponseActivityTimelineFromLegacyMetadata(node);
    const timeline = Array.isArray(source)
      ? source.filter(entry => entry && typeof entry === 'object' && typeof entry.kind === 'string')
      : [];
    const hasCommentary = timeline.some(entry => String(entry?.kind || '').toLowerCase() === 'commentary');
    return hasCommentary
      ? timeline.filter(entry => String(entry?.kind || '').toLowerCase() !== 'reasoning_summary')
      : timeline;
  }

  function formatResponseActivityElapsedDuration(durationMs) {
    const totalMs = Number(durationMs);
    if (!Number.isFinite(totalMs) || totalMs < 0) return '';
    if (totalMs < 1000) return '<1秒';
    const totalSeconds = Math.floor(totalMs / 1000);
    if (totalSeconds < 60) return `${totalSeconds}秒`;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      const parts = [`${hours}小时`];
      if (minutes > 0) parts.push(`${minutes}分`);
      if (seconds > 0) parts.push(`${seconds}秒`);
      return parts.join(' ');
    }
    if (seconds === 0) {
      return `${minutes}分`;
    }
    return `${minutes}分 ${seconds}秒`;
  }

  function isResponseActivityEntryInProgress(entry) {
    const normalized = String(entry?.status || '').trim().toLowerCase();
    return normalized === 'streaming' || normalized === 'in_progress';
  }

  function isResponseActivityTurnRuntimeActive(messageWrapperDiv) {
    if (!messageWrapperDiv) return false;
    if (messageWrapperDiv.classList.contains('updating')) return true;
    const runtimeStatus = String(messageWrapperDiv.dataset?.responseRuntimeStatus || '').trim().toLowerCase();
    if (!runtimeStatus) return false;
    return !['idle', 'completed', 'aborted', 'error'].includes(runtimeStatus);
  }

  function getResponseActivityDurationMs(node, timeline, isInProgress = false) {
    const storedDuration = Number(node?.response_activity_duration_ms);
    if (!isInProgress && Number.isFinite(storedDuration) && storedDuration >= 0) {
      return storedDuration;
    }
    const startedAt = Number(node?.timestamp) || 0;
    if (startedAt <= 0) {
      return Number.isFinite(storedDuration) && storedDuration >= 0 ? storedDuration : null;
    }
    return Math.max(0, Date.now() - startedAt);
  }

  function buildResponseActivityPanelSummary(node, timeline, options = {}) {
    const narrativeCount = timeline.filter((entry) => {
      const kind = String(entry?.kind || '').toLowerCase();
      return kind === 'reasoning_summary' || kind === 'commentary';
    }).length;
    const toolCount = timeline.filter(entry => entry?.kind === 'tool_call').length;
    const isInProgress = options.isInProgress === true
      || timeline.some(entry => isResponseActivityEntryInProgress(entry));
    const durationMs = getResponseActivityDurationMs(node, timeline, isInProgress);
    const durationLabel = formatResponseActivityElapsedDuration(durationMs);
    const metaParts = [];
    if (durationLabel) {
      metaParts.push(isInProgress ? `已进行 ${durationLabel}` : `用时 ${durationLabel}`);
    }
    if (toolCount > 0) {
      metaParts.push(`${toolCount} 个工具调用`);
    }
    if (narrativeCount > 1 || (narrativeCount > 0 && toolCount === 0)) {
      metaParts.push(`${narrativeCount} 段过程记录`);
    }
    return {
      isInProgress,
      toolCount,
      reasoningCount: narrativeCount,
      title: isInProgress ? '思考中' : '思考记录',
      metaText: metaParts.join(' · ')
    };
  }

  function getResponseActivityToolEntryKey(entry, fallbackIndex = 0) {
    if (!entry || typeof entry !== 'object') return `tool:${fallbackIndex}`;
    const type = String(entry.type || 'tool').trim().toLowerCase() || 'tool';
    const id = String(entry.id || '').trim();
    if (id) return `${type}:${id}`;
    if (type === 'function_call') {
      return `${type}:${String(entry.name || '').trim()}:${fallbackIndex}`;
    }
    if (type === 'web_search_call') {
      return `${type}:${String(entry.action_type || '').trim()}:${String(entry.query || '').trim()}:${String(entry.url || '').trim()}:${fallbackIndex}`;
    }
    return `${type}:${fallbackIndex}`;
  }

  function readResponseActivityToolKeySet(timelineRoot, datasetKey) {
    const key = (typeof datasetKey === 'string' && datasetKey.trim()) ? datasetKey.trim() : '';
    if (!key) return new Set();
    const raw = String(timelineRoot?.dataset?.[key] || '').trim();
    if (!raw) return new Set();
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()));
    } catch (_) {
      return new Set();
    }
  }

  function writeResponseActivityToolKeySet(timelineRoot, datasetKey, keys) {
    if (!timelineRoot || !timelineRoot.dataset) return;
    const key = (typeof datasetKey === 'string' && datasetKey.trim()) ? datasetKey.trim() : '';
    if (!key) return;
    const list = Array.from(keys || []).filter(value => typeof value === 'string' && value.trim());
    if (list.length === 0) {
      delete timelineRoot.dataset[key];
      return;
    }
    timelineRoot.dataset[key] = JSON.stringify(list);
  }

  function readManuallyExpandedResponseActivityToolKeys(timelineRoot) {
    const manualKeys = readResponseActivityToolKeySet(timelineRoot, 'manualExpandedToolKeys');
    readResponseActivityToolKeySet(timelineRoot, 'expandedToolKeys').forEach((key) => manualKeys.add(key));
    return manualKeys;
  }

  function writeManuallyExpandedResponseActivityToolKeys(timelineRoot, keys) {
    writeResponseActivityToolKeySet(timelineRoot, 'manualExpandedToolKeys', keys);
    if (timelineRoot?.dataset) {
      delete timelineRoot.dataset.expandedToolKeys;
    }
  }

  function readManuallyCollapsedResponseActivityToolKeys(timelineRoot) {
    const manualKeys = readResponseActivityToolKeySet(timelineRoot, 'manualCollapsedToolKeys');
    readResponseActivityToolKeySet(timelineRoot, 'collapsedInProgressToolKeys').forEach((key) => manualKeys.add(key));
    return manualKeys;
  }

  function writeManuallyCollapsedResponseActivityToolKeys(timelineRoot, keys) {
    writeResponseActivityToolKeySet(timelineRoot, 'manualCollapsedToolKeys', keys);
    if (timelineRoot?.dataset) {
      delete timelineRoot.dataset.collapsedInProgressToolKeys;
    }
  }

  function readAutoCollapsedResponseActivityToolKeys(timelineRoot) {
    return readResponseActivityToolKeySet(timelineRoot, 'autoCollapsedToolKeys');
  }

  function writeAutoCollapsedResponseActivityToolKeys(timelineRoot, keys) {
    writeResponseActivityToolKeySet(timelineRoot, 'autoCollapsedToolKeys', keys);
  }

  function getResponseActivityToolSecondaryLines(entry) {
    const lines = [];
    const actionType = String(entry?.action_type || '').toLowerCase();
    const type = String(entry?.type || '').toLowerCase();
    const url = (typeof entry?.url === 'string' && entry.url.trim()) ? entry.url.trim() : '';
    if (url && type !== 'web_search_call') {
      lines.push(url);
    }
    const pattern = (typeof entry?.pattern === 'string' && entry.pattern.trim()) ? entry.pattern.trim() : '';
    const query = (typeof entry?.query === 'string' && entry.query.trim()) ? entry.query.trim() : '';
    if (pattern && pattern !== query && actionType !== 'find_in_page') {
      lines.push(`查找：${pattern}`);
    }
    return lines;
  }

  function getResponseActivityToolQueryLines(entry) {
    const actionType = String(entry?.action_type || '').toLowerCase();
    if (actionType === 'find_in_page') return [];
    const queries = [];
    const seen = new Set();
    const primaryQuery = (typeof entry?.query === 'string' && entry.query.trim()) ? entry.query.trim() : '';
    if (primaryQuery) {
      seen.add(primaryQuery);
      queries.push(primaryQuery);
    }
    if (Array.isArray(entry?.queries)) {
      entry.queries.forEach((query) => {
        if (typeof query !== 'string') return;
        const normalized = query.trim();
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        queries.push(normalized);
      });
    }
    return queries;
  }

  function isResponseActivitySearchQueryEntry(entry) {
    return String(entry?.type || '').toLowerCase() === 'web_search_call'
      && String(entry?.action_type || '').toLowerCase() === 'search'
      && getResponseActivityToolQueryLines(entry).length > 0;
  }

  function hasResponseActivityToolDetails(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (isResponseActivityJsRuntimeEntry(entry)) {
      const meta = getResponseActivityJsRuntimeMeta(entry);
      return !!((typeof meta.code === 'string' && meta.code.trim()) || hasResponsesToolOutputBody(entry.output));
    }
    if (String(entry?.action_type || '').toLowerCase() === 'find_in_page') {
      return false;
    }
    if (isResponseActivitySearchQueryEntry(entry)) {
      return Array.isArray(entry.sources) && entry.sources.length > 0;
    }
    if (getResponseActivityToolSecondaryLines(entry).length > 0) return true;
    if (typeof entry.arguments === 'string' && entry.arguments.trim()) return true;
    if (hasResponsesToolOutputBody(entry.output)) return true;
    if (Array.isArray(entry.sources) && entry.sources.length > 0) return true;
    return false;
  }

  function removeResponseActivityTimelineDisplay(messageWrapperDiv) {
    const timelineRoot = messageWrapperDiv?.querySelector?.('.response-activity-timeline');
    if (timelineRoot) timelineRoot.remove();
  }

  function setupResponseActivityTimelineDisplay(messageWrapperDiv, node, rawTimeline, processMathAndMarkdownFn) {
    if (!messageWrapperDiv) return false;
    const timeline = Array.isArray(rawTimeline)
      ? rawTimeline.filter(entry => entry && typeof entry === 'object' && typeof entry.kind === 'string')
      : [];
    let timelineRoot = messageWrapperDiv.querySelector('.response-activity-timeline');

    if (timeline.length === 0) {
      if (timelineRoot) timelineRoot.remove();
      return false;
    }

    if (!timelineRoot) {
      timelineRoot = document.createElement('div');
      timelineRoot.className = 'response-activity-timeline';
      const textContent = messageWrapperDiv.querySelector('.text-content');
      if (textContent) {
        messageWrapperDiv.insertBefore(timelineRoot, textContent);
      } else {
        const footer = messageWrapperDiv.querySelector('.api-footer');
        if (footer) {
          messageWrapperDiv.insertBefore(timelineRoot, footer);
        } else {
          messageWrapperDiv.appendChild(timelineRoot);
        }
      }
    }

    const isTurnRuntimeActive = isResponseActivityTurnRuntimeActive(messageWrapperDiv);
    const panelSummary = buildResponseActivityPanelSummary(node, timeline, {
      isInProgress: isTurnRuntimeActive
    });
    // 面板级自动展开/收起生命周期：
    // - 首次出现且仍在进行中：默认展开一次；
    // - 整个面板结束时：自动收起一次；
    // - 用户一旦手动点击，后续刷新只读 panelManualState，不再自动反复干预。
    const panelManualState = String(timelineRoot.dataset.panelManualState || '').trim().toLowerCase();
    const panelLifecycleInitialized = timelineRoot.dataset.panelAutoLifecycleInitialized === 'true';
    const panelAutoCollapsedAfterFinish = timelineRoot.dataset.panelAutoCollapsedAfterFinish === 'true';
    let panelExpanded = timelineRoot.dataset.panelExpanded === 'true';
    if (panelManualState === 'expanded' || panelManualState === 'collapsed') {
      panelExpanded = panelManualState === 'expanded';
    } else if (!panelLifecycleInitialized) {
      timelineRoot.dataset.panelAutoLifecycleInitialized = 'true';
      if (panelSummary.isInProgress) {
        panelExpanded = true;
        delete timelineRoot.dataset.panelAutoCollapsedAfterFinish;
      } else {
        panelExpanded = false;
        timelineRoot.dataset.panelAutoCollapsedAfterFinish = 'true';
      }
    } else if (!panelAutoCollapsedAfterFinish && !panelSummary.isInProgress) {
      panelExpanded = false;
      timelineRoot.dataset.panelAutoCollapsedAfterFinish = 'true';
    }

    timelineRoot.dataset.panelExpanded = panelExpanded ? 'true' : 'false';
    timelineRoot.classList.toggle('is-expanded', panelExpanded);
    timelineRoot.classList.toggle('is-streaming', !!panelSummary.isInProgress);
    timelineRoot.innerHTML = '';

    const panelToggle = document.createElement('button');
    panelToggle.className = 'response-activity-panel-toggle';
    panelToggle.setAttribute('type', 'button');
    panelToggle.setAttribute('aria-expanded', panelExpanded ? 'true' : 'false');

    const panelCopy = document.createElement('span');
    panelCopy.className = 'response-activity-panel-copy';

    const panelTitle = document.createElement('span');
    panelTitle.className = 'response-activity-panel-title';
    panelTitle.textContent = panelSummary.title;
    panelCopy.appendChild(panelTitle);

    if (panelSummary.metaText) {
      const panelMeta = document.createElement('span');
      panelMeta.className = 'response-activity-panel-meta';
      panelMeta.textContent = panelSummary.metaText;
      panelCopy.appendChild(panelMeta);
    }

    panelToggle.appendChild(panelCopy);

    const panelChevron = document.createElement('i');
    panelChevron.className = 'fa-solid fa-chevron-right response-activity-panel-chevron';
    panelToggle.appendChild(panelChevron);

    panelToggle.addEventListener('click', () => {
      const nextExpanded = timelineRoot.dataset.panelExpanded !== 'true';
      timelineRoot.dataset.panelManualState = nextExpanded ? 'expanded' : 'collapsed';
      timelineRoot.dataset.panelExpanded = nextExpanded ? 'true' : 'false';
      timelineRoot.classList.toggle('is-expanded', nextExpanded);
      panelToggle.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
    });
    timelineRoot.appendChild(panelToggle);

    const panelBody = document.createElement('div');
    panelBody.className = 'response-activity-panel-body';
    const panelBodyInner = document.createElement('div');
    panelBodyInner.className = 'response-activity-panel-body-inner';
    panelBody.appendChild(panelBodyInner);

    const manualExpandedToolKeys = readManuallyExpandedResponseActivityToolKeys(timelineRoot);
    const manualCollapsedToolKeys = readManuallyCollapsedResponseActivityToolKeys(timelineRoot);
    const autoCollapsedToolKeys = readAutoCollapsedResponseActivityToolKeys(timelineRoot);
    const visibleToolKeys = new Set();

    timeline.forEach((entry, index) => {
      if (entry?.kind !== 'tool_call') return;
      const hasDetails = hasResponseActivityToolDetails(entry);
      if (!hasDetails) return;
      const toolKey = getResponseActivityToolEntryKey(entry, index);
      visibleToolKeys.add(toolKey);
    });

    Array.from(manualExpandedToolKeys).forEach((key) => {
      if (!visibleToolKeys.has(key)) {
        manualExpandedToolKeys.delete(key);
      }
    });
    Array.from(manualCollapsedToolKeys).forEach((key) => {
      if (!visibleToolKeys.has(key)) {
        manualCollapsedToolKeys.delete(key);
      }
    });
    Array.from(autoCollapsedToolKeys).forEach((key) => {
      if (!visibleToolKeys.has(key)) {
        autoCollapsedToolKeys.delete(key);
      }
    });
    writeManuallyExpandedResponseActivityToolKeys(timelineRoot, manualExpandedToolKeys);
    writeManuallyCollapsedResponseActivityToolKeys(timelineRoot, manualCollapsedToolKeys);
    writeAutoCollapsedResponseActivityToolKeys(timelineRoot, autoCollapsedToolKeys);

    timeline.forEach((entry, index) => {
      if (entry.kind === 'reasoning_summary' || entry.kind === 'commentary') {
        const item = document.createElement('div');
        item.className = 'response-activity-entry response-activity-entry--reasoning';

        const content = document.createElement('div');
        content.className = 'response-activity-content response-activity-content--reasoning';
        const rawText = (typeof entry.text === 'string') ? entry.text : '';
        const normalizedText = entry.kind === 'reasoning_summary'
          ? normalizeResponsesReasoningText(rawText)
          : rawText.trim();
        content.innerHTML = processMathAndMarkdownFn(normalizedText);
        item.appendChild(content);
        panelBodyInner.appendChild(item);
        return;
      }

      const item = document.createElement('div');
      item.className = 'response-activity-entry response-activity-entry--tool';

      const toolKey = getResponseActivityToolEntryKey(entry, index);
      const renderSearchQueriesInline = isResponseActivitySearchQueryEntry(entry);
      const searchQueryLines = renderSearchQueriesInline ? getResponseActivityToolQueryLines(entry) : [];
      const hasDetails = hasResponseActivityToolDetails(entry);
      const isInProgress = isResponseActivityEntryInProgress(entry);
      const hasOutput = hasResponsesToolOutputBody(entry?.output);
      const shouldAutoRemainExpanded = isInProgress || (!hasOutput && isTurnRuntimeActive);
      // 工具级生命周期与面板一致：
      // - 默认只在“首次出现且尚无手动状态”时自动决定一次初始展开；
      // - 完成后只自动收起一次；
      // - 之后完全交由 manualExpanded/manualCollapsed 两个集合控制。
      let isExpanded = false;
      if (hasDetails) {
        if (manualExpandedToolKeys.has(toolKey)) {
          isExpanded = true;
        } else if (manualCollapsedToolKeys.has(toolKey)) {
          isExpanded = false;
        } else if (shouldAutoRemainExpanded) {
          isExpanded = true;
        } else {
          isExpanded = false;
          if (!autoCollapsedToolKeys.has(toolKey)) {
            autoCollapsedToolKeys.add(toolKey);
          }
        }
      }
      item.classList.toggle('is-expanded', isExpanded);

      const summaryTag = hasDetails ? 'button' : 'div';
      const summary = document.createElement(summaryTag);
      summary.className = 'response-activity-tool-summary';
      if (renderSearchQueriesInline) {
        summary.classList.add('response-activity-tool-summary--query-stack');
      }
      if (hasDetails) {
        summary.setAttribute('type', 'button');
        summary.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
      }

      const kind = document.createElement('span');
      kind.className = 'response-activity-tool-kind';
      kind.textContent = getResponseToolCallTypeLabel(entry);
      summary.appendChild(kind);

      if (renderSearchQueriesInline) {
        const queryStack = document.createElement('span');
        queryStack.className = 'response-activity-tool-query-stack';
        searchQueryLines.forEach((query) => {
          const queryLine = document.createElement('span');
          queryLine.className = 'response-activity-tool-query-line';
          queryLine.textContent = query;
          queryStack.appendChild(queryLine);
        });
        summary.appendChild(queryStack);
      } else {
        const primaryParts = buildResponseToolCallPrimaryParts(entry);
        const primary = document.createElement('span');
        primary.className = 'response-activity-tool-primary';

        if (primaryParts.action) {
          const action = document.createElement('span');
          action.className = 'response-activity-tool-action';
          action.textContent = primaryParts.action;
          primary.appendChild(action);
        }

        if (primaryParts.value) {
          if (primaryParts.valueUrl) {
            const link = document.createElement('a');
            link.className = 'response-activity-tool-link';
            link.href = primaryParts.valueUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = primaryParts.value;
            primary.appendChild(link);
          } else {
            const value = document.createElement('span');
            value.className = 'response-activity-tool-value';
            value.textContent = primaryParts.value;
            primary.appendChild(value);
          }
        }

        if (primaryParts.locationAction && primaryParts.locationValue) {
          const locationAction = document.createElement('span');
          locationAction.className = 'response-activity-tool-action';
          locationAction.textContent = primaryParts.locationAction;
          primary.appendChild(locationAction);

          if (primaryParts.locationUrl) {
            const link = document.createElement('a');
            link.className = 'response-activity-tool-link';
            link.href = primaryParts.locationUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = primaryParts.locationValue;
            primary.appendChild(link);
          } else {
            const locationValue = document.createElement('span');
            locationValue.className = 'response-activity-tool-value';
            locationValue.textContent = primaryParts.locationValue;
            primary.appendChild(locationValue);
          }
        }

        summary.appendChild(primary);
      }

      if (hasDetails) {
        const chevron = document.createElement('i');
        chevron.className = 'fa-solid fa-chevron-right response-activity-tool-chevron';
        summary.appendChild(chevron);
        summary.addEventListener('click', () => {
          const nextManualExpandedKeys = readManuallyExpandedResponseActivityToolKeys(timelineRoot);
          const nextManualCollapsedKeys = readManuallyCollapsedResponseActivityToolKeys(timelineRoot);
          const expanded = !item.classList.contains('is-expanded');
          if (expanded) {
            nextManualExpandedKeys.add(toolKey);
            nextManualCollapsedKeys.delete(toolKey);
          } else {
            nextManualCollapsedKeys.add(toolKey);
            nextManualExpandedKeys.delete(toolKey);
          }
          writeManuallyExpandedResponseActivityToolKeys(timelineRoot, nextManualExpandedKeys);
          writeManuallyCollapsedResponseActivityToolKeys(timelineRoot, nextManualCollapsedKeys);
          item.classList.toggle('is-expanded', expanded);
          summary.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        });
      }

      item.appendChild(summary);

      if (hasDetails) {
        const toolBody = document.createElement('div');
        toolBody.className = 'response-activity-tool-body';
        const toolBodyInner = document.createElement('div');
        toolBodyInner.className = 'response-activity-tool-body-inner';

        if (isResponseActivityJsRuntimeEntry(entry)) {
          renderResponseActivityJsRuntimeBody(toolBodyInner, entry);
        } else {
          renderResponseActivityGenericToolBody(toolBodyInner, entry);
        }

        toolBody.appendChild(toolBodyInner);
        item.appendChild(toolBody);
      }

      panelBodyInner.appendChild(item);
    });

    writeAutoCollapsedResponseActivityToolKeys(timelineRoot, autoCollapsedToolKeys);
    timelineRoot.appendChild(panelBody);

    return true;
  }

  /**
   * 同步 assistant 消息的附加元信息展示。
   * 规则：
   * - 若存在 Responses 活动时间线，则按时间线交错渲染 reasoning summary 与工具调用；
   * - 若只有旧版 summary / tool_calls 字段，则回退到旧展示；
   * - 其它 assistant 消息继续沿用原有 thoughts 展示。
   * @param {HTMLElement} messageWrapperDiv
   * @param {Array<any>|null|undefined} rawToolCalls
   */
  function setupResponseToolCallsDisplay(messageWrapperDiv, rawToolCalls) {
    if (!messageWrapperDiv) return;
    let toolCallsRoot = messageWrapperDiv.querySelector('.response-tool-calls');
    const toolCalls = Array.isArray(rawToolCalls)
      ? rawToolCalls.filter(item => item && typeof item === 'object')
      : [];

    if (toolCalls.length === 0) {
      if (toolCallsRoot) toolCallsRoot.remove();
      return;
    }

    const previousOpen = !!toolCallsRoot?.open;
    if (!toolCallsRoot) {
      toolCallsRoot = document.createElement('details');
      toolCallsRoot.className = 'response-tool-calls';
      const footer = messageWrapperDiv.querySelector('.api-footer');
      if (footer) {
        messageWrapperDiv.insertBefore(toolCallsRoot, footer);
      } else {
        messageWrapperDiv.appendChild(toolCallsRoot);
      }
    }

    let summary = toolCallsRoot.querySelector('summary');
    if (!summary) {
      summary = document.createElement('summary');
      toolCallsRoot.appendChild(summary);
    }
    summary.textContent = `工具调用 ${toolCalls.length}`;

    let list = toolCallsRoot.querySelector('.response-tool-call-list');
    if (!list) {
      list = document.createElement('div');
      list.className = 'response-tool-call-list';
      toolCallsRoot.appendChild(list);
    }
    list.innerHTML = '';

    toolCalls.forEach((record) => {
      const item = document.createElement('div');
      item.className = 'response-tool-call-item';

      const header = document.createElement('div');
      header.className = 'response-tool-call-header';

      const badge = document.createElement('span');
      badge.className = 'response-tool-call-badge';
      badge.textContent = getResponseToolCallTypeLabel(record);
      header.appendChild(badge);

      const primary = document.createElement('span');
      primary.className = 'response-tool-call-primary';
      primary.textContent = buildResponseToolCallPrimaryText(record);
      header.appendChild(primary);

      if (typeof record.status === 'string' && record.status.trim()) {
        const status = document.createElement('span');
        status.className = 'response-tool-call-status';
        status.textContent = record.status.trim();
        header.appendChild(status);
      }

      item.appendChild(header);

      if (Array.isArray(record.queries) && record.queries.length > 1) {
        const queries = document.createElement('div');
        queries.className = 'response-tool-call-secondary';
        queries.textContent = `查询：${record.queries.join(' | ')}`;
        item.appendChild(queries);
      } else if (typeof record.url === 'string' && record.url.trim() && String(record.type || '').toLowerCase() !== 'web_search_call') {
        const urlLine = document.createElement('div');
        urlLine.className = 'response-tool-call-secondary';
        urlLine.textContent = record.url.trim();
        item.appendChild(urlLine);
      }

      if (typeof record.arguments === 'string' && record.arguments.trim()) {
        const pre = document.createElement('pre');
        pre.className = 'response-tool-call-arguments';
        pre.textContent = formatResponseToolCallArguments(record.arguments);
        item.appendChild(pre);
      }

      if (Array.isArray(record.sources) && record.sources.length > 0) {
        const sources = document.createElement('div');
        sources.className = 'response-tool-call-sources';
        const sourceTitle = document.createElement('div');
        sourceTitle.className = 'response-tool-call-source-title';
        sourceTitle.textContent = `来源 ${record.sources.length}`;
        sources.appendChild(sourceTitle);

        const sourceList = document.createElement('div');
        sourceList.className = 'response-tool-call-source-list';
        record.sources.forEach((source) => {
          const label = source.title || source.domain || source.url || '未命名来源';
          if (source.url) {
            const link = document.createElement('a');
            link.className = 'response-tool-call-source-link';
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.href = source.url;
            link.textContent = label;
            sourceList.appendChild(link);
          } else {
            const text = document.createElement('span');
            text.className = 'response-tool-call-source-link';
            text.textContent = label;
            sourceList.appendChild(text);
          }
        });
        sources.appendChild(sourceList);
        item.appendChild(sources);
      }

      list.appendChild(item);
    });

    toolCallsRoot.open = previousOpen;
  }

  /**
   * 根据历史节点渲染 assistant footer。
   *
   * 设计说明：
   * - footer 也是视图投影的一部分，不应继续由 sender 分散地直接操作 DOM；
   * - sender 负责先把 apiUuid/apiUsage 等 durable 字段写入节点，再由 renderer 统一投影到界面。
   *
   * @param {HTMLElement|null} messageWrapperDiv
   * @param {Object|null} nodeLike
   * @returns {boolean}
   */
  function renderAssistantApiFooter(messageWrapperDiv, nodeLike) {
    if (!messageWrapperDiv || !nodeLike || typeof nodeLike !== 'object') return false;
    const role = String(nodeLike.role || '').toLowerCase();
    if (role !== 'assistant' && role !== 'ai') return false;

    let footer = messageWrapperDiv.querySelector('.api-footer');
    if (!footer) {
      footer = document.createElement('div');
      footer.className = 'api-footer';
      messageWrapperDiv.appendChild(footer);
    }

    const allConfigs = (typeof apiManager?.getAllConfigs === 'function')
      ? (apiManager.getAllConfigs() || [])
      : [];
    const footerTemplate = settingsManager?.getSetting?.('aiFooterTemplate');
    const footerTooltipTemplate = settingsManager?.getSetting?.('aiFooterTooltipTemplate');
    const renderData = buildApiFooterRenderData(nodeLike, {
      allConfigs,
      template: footerTemplate,
      tooltipTemplate: footerTooltipTemplate
    });
    footer.textContent = renderData.text;
    footer.title = renderData.title;
    return true;
  }

  /**
   * 根据历史节点把 assistant 消息的附加元数据显示到 DOM。
   * @param {string|null} messageId
   * @param {Object|null} nodeLike
   * @param {{fallbackElement?: HTMLElement|null}} [options]
   * @returns {boolean}
   */
  function syncAssistantMessageMetadata(messageId, nodeLike, options = {}) {
    const messageWrapperDiv = options?.fallbackElement || resolveMessageElement(messageId);
    const node = (nodeLike && typeof nodeLike === 'object')
      ? nodeLike
      : (messageId ? chatHistoryManager.chatHistory.messages.find(msg => msg.id === messageId) : null);
    if (!messageWrapperDiv || !node) return false;
    const role = String(node.role || '').toLowerCase();
    if (role !== 'assistant' && role !== 'ai') return false;

    const responseTimeline = getResponseActivityTimeline(node);
    if (responseTimeline.length > 0) {
      setupThoughtsDisplay(messageWrapperDiv, null, processMathAndMarkdown);
      setupResponseToolCallsDisplay(messageWrapperDiv, null);
      setupResponseActivityTimelineDisplay(messageWrapperDiv, node, responseTimeline, processMathAndMarkdown);
    } else {
      removeResponseActivityTimelineDisplay(messageWrapperDiv);
      const responseThoughts = node.thoughtsRaw || node.response_reasoning_summary || null;
      setupThoughtsDisplay(messageWrapperDiv, responseThoughts, processMathAndMarkdown);
      setupResponseToolCallsDisplay(messageWrapperDiv, node.response_tool_calls || null);
    }
    enhanceMarkdownContent(messageWrapperDiv);
    messageVirtualizer.scheduleUpdate(resolveMessageListContainer(messageWrapperDiv));
    return true;
  }

  /**
   * 统一同步 assistant 消息视图。
   *
   * Phase 1 目标：
   * - sender 只负责先改 durable/runtime state；
   * - 再通过这一入口触发正文 / thoughts / response activity / footer 的视图投影；
   * - 不再让 sender 到处散调多个 DOM patch 函数。
   *
   * @param {string|null} messageId
   * @param {{
   *   node?: Object|null,
   *   runtimeSnapshot?: Object|null,
   *   fallbackElement?: HTMLElement|null,
   *   content?: string,
   *   thoughtsRaw?: string|null,
   *   suppressMissingNodeWarning?: boolean
   * }} [options]
   * @returns {boolean}
   */
  function syncAssistantMessageView(messageId, options = {}) {
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    let node = (normalizedOptions.node && typeof normalizedOptions.node === 'object')
      ? normalizedOptions.node
      : (messageId ? chatHistoryManager.chatHistory.messages.find(msg => msg.id === messageId) : null);
    const fallbackElement = normalizedOptions.fallbackElement || null;

    if (Object.prototype.hasOwnProperty.call(normalizedOptions, 'content')) {
      updateAIMessage(
        messageId,
        normalizedOptions.content || '',
        normalizedOptions.thoughtsRaw,
        {
          fallbackNode: node || null,
          suppressMissingNodeWarning: normalizedOptions.suppressMissingNodeWarning === true
        }
      );
      node = (messageId ? chatHistoryManager.chatHistory.messages.find(msg => msg.id === messageId) : null) || node;
    }

    const messageWrapperDiv = fallbackElement || resolveMessageElement(messageId);
    if (messageWrapperDiv?.dataset) {
      const runtimeStatus = String(normalizedOptions.runtimeSnapshot?.activeTurn?.status || '').trim().toLowerCase();
      const boundAssistantMessageId = String(normalizedOptions.runtimeSnapshot?.activeTurn?.boundAssistantMessageId || '').trim();
      if (runtimeStatus && boundAssistantMessageId && boundAssistantMessageId === String(messageId || '').trim()) {
        messageWrapperDiv.dataset.responseRuntimeStatus = runtimeStatus;
      } else {
        delete messageWrapperDiv.dataset.responseRuntimeStatus;
      }
    }

    let syncedAny = false;
    if (messageWrapperDiv && node) {
      syncedAny = syncAssistantMessageMetadata(messageId, node, { fallbackElement: messageWrapperDiv }) || syncedAny;
      syncedAny = renderAssistantApiFooter(messageWrapperDiv, node) || syncedAny;
    }
    return syncedAny;
  }

  function scheduleFlushDeferredAiRenders() {
    if (deferredAiRenderFlushRafId != null) return;
    const schedule = (typeof requestAnimationFrame === 'function')
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16);
    deferredAiRenderFlushRafId = schedule(() => {
      deferredAiRenderFlushRafId = null;
      flushDeferredAiRenders();
    });
  }

  /**
   * 更新AI消息内容，包括思考过程和最终答案
   * @param {string} messageId - 要更新的消息的ID
   * @param {string} newAnswerContent - 最新的完整答案文本
   * @param {string|null} newThoughtsRaw - 最新的完整思考过程原始文本 (可选)
   */
  function updateAIMessage(messageId, newAnswerContent, newThoughtsRaw, options = null) {
    const updateOptions = (options && typeof options === 'object') ? options : {};
    const messageDiv = resolveMessageElement(messageId);
    let node = chatHistoryManager.chatHistory.messages.find(msg => msg.id === messageId);
    const fallbackNode = (updateOptions.fallbackNode && typeof updateOptions.fallbackNode === 'object')
      ? updateOptions.fallbackNode
      : null;
    if (!node && fallbackNode) {
      // 会话切换后，目标消息可能已不在当前内存会话；允许调用方提供绑定节点继续后台更新。
      node = fallbackNode;
    }

    messageVirtualizer.ensureMessageVisible(messageDiv);

    // 统一拆分 <think> 思考段落，保证思考摘要独立存储与展示
    let safeAnswerContent = newAnswerContent;
    let resolvedThoughts = newThoughtsRaw;
    let shouldUpdateThoughts = (newThoughtsRaw !== undefined);
    if (typeof safeAnswerContent === 'string') {
      const thinkExtraction = extractThinkingFromText(safeAnswerContent);
      safeAnswerContent = thinkExtraction.cleanText;
      if (thinkExtraction.thoughtText) {
        resolvedThoughts = mergeThoughts(resolvedThoughts, thinkExtraction.thoughtText);
        shouldUpdateThoughts = true;
      }
    }

    if (!node) {
      if (!updateOptions.suppressMissingNodeWarning) {
        console.error('updateAIMessage: 消息或历史节点未找到', messageId);
      }
      return false;
    }

    // --- 同步历史记录中的内容结构（支持图片 + 文本的混合内容） ---
    try {
      // 提取当前消息中已有的图片 HTML（如果存在）
      const imageContentDiv = messageDiv ? messageDiv.querySelector('.image-content') : null;
      const imagesHTML = imageContentDiv ? imageContentDiv.innerHTML : null;
      // 使用与 appendMessage 相同的逻辑，将文本和图片转换为统一的消息内容格式
      const processedContent = imageHandler.processImageTags(safeAnswerContent, imagesHTML || '');
      node.content = processedContent;
    } catch (e) {
      console.warn('updateAIMessage: 处理图片标签失败，回退为纯文本内容:', e);
      node.content = safeAnswerContent;
    }
    try {
      const hasImageParts = Array.isArray(node.content) && node.content.some(p => p?.type === 'image_url');
      const hasImageContainer = !!(messageDiv && messageDiv.querySelector('.image-content'));
      node.hasInlineImages = (!hasImageContainer && hasImageParts);
    } catch (_) {
      node.hasInlineImages = false;
    }

    if (shouldUpdateThoughts) { // 允许显式将思考过程设置为 null/空字符串
      node.thoughtsRaw = resolvedThoughts;
    }

    // 线程切换/面板关闭时可能找不到 DOM，仍需保证历史数据完整。
    if (!messageDiv) {
      return true;
    }

    // 若用户正在这条消息里拖选文本，则只缓存“最后一版待渲染内容”，等选区结束后再补渲染。
    if (isMessageRenderBlockedBySelection(messageDiv)) {
      markDeferredAiRender(
        messageId,
        {
          node,
          safeAnswerContent,
          resolvedThoughts
        },
        messageDiv
      );
      return true;
    }

    deferredAiRenderByMessageId.delete(messageId);
    return renderAiMessageDom(messageDiv, node, safeAnswerContent, resolvedThoughts);
  }

  function bindInlineImagePreviews(container) {
    if (!container) return;
    try {
      const previewTargets = container.querySelectorAll('.image-tag img, img.ai-inline-image');
      previewTargets.forEach(img => {
        if (img.dataset.previewBound === 'true') return;
        img.dataset.previewBound = 'true';
        img.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          imageHandler.showImagePreview(img.src);
        });
      });
    } catch (e) {
      console.error('绑定图片预览失败:', e);
    }
  }

  function isScrollContainerNearBottom(container, threshold = 72) {
    if (!container) return false;
    const distance = (container.scrollHeight || 0) - (container.scrollTop || 0) - (container.clientHeight || 0);
    return distance <= threshold;
  }

  /**
   * 对已经写入 DOM 的 Markdown 内容做统一增强。
   * 这里集中处理所有“必须依赖真实 DOM 才能完成”的步骤：
   * - 链接跳转策略修正；
   * - 代码高亮；
   * - 图片预览绑定；
   * - Mermaid 异步 SVG 渲染；
   *
   * 这样可以确保主消息区、编辑后回写、线程预览等多条渲染路径行为一致。
   *
   * @param {HTMLElement} rootElement
   * @param {{ forceMermaid?: boolean, updateLayout?: boolean, onAsyncRenderComplete?: Function }} [options]
   */
  function enhanceMarkdownContent(rootElement, options = {}) {
    if (!rootElement) return;

    decorateMarkdownLinks(rootElement);

    rootElement.querySelectorAll('pre code').forEach((block) => {
      if (block.closest('.mermaid-diagram__source')) return;
      try {
        if (typeof hljs === 'undefined' || typeof hljs.highlightElement !== 'function') return;
        const normalizedClassName = String(block.getAttribute('class') || '')
          .split(/\s+/)
          .map(token => token.trim())
          .filter(token => token && token !== 'hljs')
          .sort()
          .join(' ');
        const sourceText = typeof block.textContent === 'string' ? block.textContent : '';
        if (!sourceText.trim()) return;
        const nextSignature = `${normalizedClassName}::${sourceText}`;
        if (
          block.dataset.highlighted === 'yes'
          && block.dataset.cerebrHighlightSignature === nextSignature
        ) {
          return;
        }
        // highlight.js 再次处理已高亮节点时会刷 warning。
        // 这里用“代码文本 + 语言 class”的签名判定是否真的发生变化；
        // 若内容未变则直接跳过，若内容变了则先还原为纯文本后再重新高亮。
        block.textContent = sourceText;
        block.classList.remove('hljs');
        delete block.dataset.highlighted;
        hljs.highlightElement(block);
        block.dataset.cerebrHighlightSignature = nextSignature;
      } catch (_) {}
    });

    bindInlineImagePreviews(rootElement);

    enhanceMermaidDiagrams(rootElement, {
      force: !!options.forceMermaid,
      onRenderComplete(block, state) {
        if (options.updateLayout !== false && block?.isConnected) {
          const ownerMessage = block.closest?.('.message');
          if (ownerMessage) {
            const listContainer = resolveMessageListContainer(ownerMessage);
            if (listContainer) {
              messageVirtualizer.scheduleUpdate(listContainer);
            }

            const scrollContainer = resolveScrollContainerForMessage(ownerMessage);
            if (ownerMessage.classList.contains('updating') || isScrollContainerNearBottom(scrollContainer)) {
              scrollToBottom(scrollContainer);
            }
          }
        }

        if (typeof options.onAsyncRenderComplete === 'function') {
          options.onAsyncRenderComplete(block, state);
        }
      }
    });
  }

  let mermaidThemeRerenderRafId = null;

  function scheduleRerenderAllMermaidDiagrams() {
    if (mermaidThemeRerenderRafId != null) return;
    if (!document.querySelector('.mermaid-diagram')) return;

    const schedule = (typeof requestAnimationFrame === 'function')
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16);

    mermaidThemeRerenderRafId = schedule(() => {
      mermaidThemeRerenderRafId = null;
      enhanceMarkdownContent(document.body, { forceMermaid: true });
    });
  }

  /**
   * 切换美元符号数学渲染时，重新处理当前所有 AI 消息
   */
  function rerenderAiMessagesForMathSetting() {
    const containers = [chatContainer, dom?.threadContainer].filter((container, index, arr) => (
      !!container && arr.indexOf(container) === index
    ));
    if (!containers.length) return;

    const visitedMessageIds = new Set();
    containers.forEach((container) => {
      const aiMessages = container.querySelectorAll('.message.ai-message');
      if (!aiMessages.length) return;

      aiMessages.forEach((messageDiv) => {
        const messageId = messageDiv.getAttribute('data-message-id');
        const originalText = messageDiv.getAttribute('data-original-text');
        if (!messageId || typeof originalText !== 'string') return;
        if (visitedMessageIds.has(messageId)) return;
        visitedMessageIds.add(messageId);

        const historyNode = chatHistoryManager?.chatHistory?.messages?.find(msg => msg.id === messageId);
        if (!historyNode) return;

        try {
          updateAIMessage(messageId, originalText, historyNode.thoughtsRaw ?? null);
        } catch (error) {
          console.error('重新渲染消息失败:', messageId, error);
        }
      });
    });
  }

  /**
   * 获取提示词类型
   * @param {HTMLElement|string} content - 输入内容，可以是HTML元素或字符串
   * @param {Object} prompts - 提示词设置对象
   * @returns {string} 提示词类型 ('summary'|'selection'|'query'|'none')
   */
  function getPromptTypeFromContent(content, prompts) {
    if (!prompts) return 'none';
    // 归一化输入文本（去掉前后空白）
    const normalizedContent = (typeof content === 'string') ? content.trim() : content;

    // 检查是否是页面总结提示词
    if (prompts.summary?.prompt && normalizedContent === prompts.summary.prompt.trim()) {
      return 'summary';
    }

    // 检查是否是划词搜索提示词，将 selection prompt 中的 "<SELECTION>" 移除后进行匹配
    if (prompts.selection?.prompt) {
      const selectionPromptKeyword = prompts.selection.prompt.split('<SELECTION>')[0].trim();
      if (selectionPromptKeyword && normalizedContent.startsWith(selectionPromptKeyword)) {
        return 'selection';
      }
    }

    // 检查是否是普通查询提示词
    if (prompts.query?.prompt) {
      const queryPromptKeyword = prompts.query.prompt.split('<SELECTION>')[0].trim();
      if (queryPromptKeyword && normalizedContent.startsWith(queryPromptKeyword)) {
        return 'query';
      }
    }

    return 'none';
  }

  /**
   * 提取提示文本中的系统消息内容
   *
   * 此函数扫描输入的提示文本，并提取被 {{system}} 和 {{end_system}} 标记包裹的内容，
   * 该内容通常作为系统级指令被单独处理。
   *
   * @param {string} promptText - 包含自定义系统标记的提示文本
   * @returns {string} 返回提取出的系统消息内容；如果不存在则返回空字符串
   * @example
   * // 输入 "请总结以下内容 {{system}}额外指令{{end_system}}"，返回 "额外指令"
   */
  function extractSystemContent(promptText) {
    if (!promptText) return '';
    const regex = /{{system}}([\s\S]*?){{end_system}}/; // 使用捕获组
    const match = promptText.match(regex);
    return match ? match[1].trim() : '';
  }

  /**
   * 处理数学公式和Markdown
   * @param {string} text - 要处理的文本
   * @returns {string} 处理后的HTML
   */
  function processMathAndMarkdown(text) {
    const settingsManager = appContext.services.settingsManager;
    const enableDollarMath = settingsManager?.getSetting?.('enableDollarMath');
    // 折叠“搜索过程/思考过程”等自定义片段
    const foldedText = foldMessageContent(text || '');
    // 使用纯函数式渲染管线（禁用内联 HTML、支持 KaTeX、严格 DOMPurify）
    return renderMarkdownSafe(foldedText, { allowDetails: true, enableDollarMath });
  }

  try {
    services.settingsManager?.subscribe?.('enableDollarMath', () => {
      rerenderAiMessagesForMathSetting();
    });
  } catch (error) {
    console.warn('订阅 enableDollarMath 设置变化失败:', error);
  }

  // 监听全局选区变化：一旦用户取消/移出当前选区，就把之前延迟的 AI 消息 DOM 更新补上。
  try {
    document.addEventListener('selectionchange', scheduleFlushDeferredAiRenders);
  } catch (error) {
    console.warn('绑定 selectionchange 监听失败，选区保护将退化为仅本次渲染有效:', error);
  }

  try {
    const rootAttrObserver = new MutationObserver((mutations) => {
      const shouldRerenderMermaid = mutations.some((mutation) => (
        mutation.type === 'attributes'
        && ['class', 'data-theme', 'style'].includes(mutation.attributeName || '')
      ));
      if (shouldRerenderMermaid) {
        scheduleRerenderAllMermaidDiagrams();
      }
    });
    rootAttrObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style']
    });
  } catch (error) {
    console.warn('监听主题变化以重渲染 Mermaid 失败:', error);
  }

  // 在创建消息处理器时安装一次全局链接拦截器
  installMarkdownLinkInterceptor();
  messageVirtualizer.init();

  /**
   * 预处理 Markdown 文本，修正 "**bold**text" 这类连写导致的粗体解析问题
   * @param {string} text - 原始文本
   * @returns {string} 处理后的文本
   */
  // 旧的粗体修复、数学占位处理已内聚至 utils/markdown_renderer.js

  /**
   * 根据正则折叠消息文本，使用自定义正则表达式和摘要文本
   * @param {string} text - 原始消息文本
   * @returns {string} 处理后的消息文本，其中符合条件的部分被包裹在一个折叠元素中
   */
  function foldMessageContent(text) {
    if (typeof text !== 'string') return text;
    // 预先去掉 <think> 段落，思考摘要改由独立区域展示
    const { cleanText } = extractThinkingFromText(text);
    let normalizedText = cleanText;
    // 定义折叠配置
    const foldConfigs = [
      {
        regex: /^([\s\S]*)<\/search>/,
        summary: '搜索过程'
      }
    ];

    // 对每个配置应用折叠处理
    for (const config of foldConfigs) {
      const match = normalizedText.match(config.regex);
      if (match && match[1] && match[1].trim() !== '') {
        const foldedPart = match[1];
        const remainingPart = normalizedText.slice(match[0].length);
        const quotedFoldedPart = `<blockquote>${foldedPart}</blockquote>`;
        normalizedText = `<details class="folded-message"><summary>${config.summary}</summary><div>\n${quotedFoldedPart}</div></details>\n\n${remainingPart}`;
      }
    }

    return normalizedText;
  }

  /**
   * 预处理数学表达式
   * @param {string} text - 原始文本
   * @returns {Object} 包含处理后的文本和数学表达式的对象
   */
  // 数学预/后处理逻辑交由渲染器统一处理

  /**
   * 后处理数学表达式
   * @param {string} text - 处理后的文本
   * @param {Array} mathExpressions - 数学表达式数组
   * @returns {string} 替换数学表达式后的文本
   */
  // 参见 utils/markdown_renderer.js 中的 KaTeX 渲染
  
  // 返回公共API
  return {
    appendMessage,
    updateAIMessage,
    syncAssistantMessageView,
    syncAssistantMessageMetadata,
    renderAssistantApiFooter,
    processMathAndMarkdown,
    enhanceMarkdownContent,
    decorateMarkdownLinks,
    getPromptTypeFromContent,
    extractSystemContent
  };
}
