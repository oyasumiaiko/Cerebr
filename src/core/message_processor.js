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
import { resolveThoughtsPanelLifecycleState } from '../utils/thoughts_panel_lifecycle.js';
import { getAssistantActivityTimeline } from '../utils/assistant_activity_timeline.js';
import { resolveResponseActivityPanelModeState } from '../utils/response_activity_panel_mode.js';
import { resolveResponseActivityPanelStatusState } from '../utils/response_activity_panel_status.js';
import { resolveResponseActivityToolExpansionState } from '../utils/response_activity_tool_auto_collapse.js';
import { normalizeAssistantPreResponseStatus } from '../utils/assistant_pre_response_status.js';
import {
  buildVirtualFileApplyPatchPreview,
  buildSkillApplyPatchPreview
} from '../utils/skill_patch_preview.js';
import {
  buildSkillRegistryPrimaryText,
  buildResponseActivityCustomToolPrimaryText,
  buildResponseActivityCustomToolSummaryParts,
  buildSkillRegistrySummaryParts,
  getResponseActivityCustomToolTypeLabel,
  isResponseActivityImagePreviewToolCall,
  getSkillRegistryToolTypeLabel,
  isResponseActivityCustomToolCall,
  isSkillRegistryToolCall
} from '../utils/response_activity_tool_summary.js';
import {
  buildVirtualFilePrimaryText,
  buildVirtualFileSummaryParts,
  getVirtualFileToolTypeLabel,
  isVirtualFileToolCall
} from '../utils/conversation_document_tool_summary.js';
import {
  extractResponsesToolOutputInputImages,
  formatResponsesToolOutputForDisplay,
  hasResponsesToolOutputBody
} from '../agent_tools/shared/responses_tool_output.js';
import {
  CONVERSATION_DOCUMENT_CHANGE_EVENT_NAME,
  executeConversationDocumentAction,
  normalizeConversationDocumentHrefPath
} from '../agent_tools/virtual_file_io/index.js';
import { createConversationDocumentViewer } from '../utils/conversation_document_viewer.js';
import {
  computeContiguousDiffWindow,
  resolveRenderedSurfaceDiffBaseSignatures,
  getLegacyToolCallSnapshotKey,
  getResponseActivityEntrySnapshotKey
} from '../utils/assistant_incremental_render.js';
import {
  computeStableScrollAnchor,
  computeStableScrollCompensation
} from '../utils/scroll_anchor.js';

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

  function isConversationDocumentRelativeHref(rawHref) {
    const href = (typeof rawHref === 'string') ? rawHref.trim() : '';
    if (!href) return false;
    if (/^(?:[a-z][a-z0-9+.-]*:)/i.test(href)) return false;
    if (href.startsWith('/') || href.startsWith('./') || href.startsWith('../')) return false;
    if (href.startsWith('?') || href.startsWith('#')) return false;
    try {
      normalizeConversationDocumentHrefPath(href);
      return true;
    } catch (_) {
      return false;
    }
  }

  function resolveCurrentConversationDocumentId() {
    const conversationId = services.chatHistoryUI?.getCurrentConversationId?.();
    return (typeof conversationId === 'string') ? conversationId.trim() : '';
  }

  async function executeConversationDocumentUiAction(action, payload = {}) {
    const conversationId = resolveCurrentConversationDocumentId();
    if (!conversationId) {
      return {
        ok: false,
        error: {
          message: '当前对话尚未持久化，暂时无法读取或编辑文件。',
          name: 'ConversationDocumentUnavailableError',
          stack: ''
        }
      };
    }
    const result = await executeConversationDocumentAction(action, payload, {
      conversationId,
      allowInternalActions: true
    });
    if (result?.ok === true && result?.change_event) {
      try {
        document.dispatchEvent(new CustomEvent(CONVERSATION_DOCUMENT_CHANGE_EVENT_NAME, {
          detail: result.change_event
        }));
      } catch (_) {}
    }
    return result;
  }
  const conversationDocumentViewer = createConversationDocumentViewer({
    executeAction: executeConversationDocumentUiAction,
    resolveConversationId: resolveCurrentConversationDocumentId,
    settingsManager,
    enhanceMarkdownContent(rootElement) {
      enhanceMarkdownContent(rootElement);
    }
  });

  function createConversationDocumentCard(link) {
    return conversationDocumentViewer.createConversationDocumentCardFromLink(link);
  }

  function installConversationDocumentChangeListener() {
    conversationDocumentViewer.installConversationDocumentChangeListener();
  }

  function shouldRenderUserMessagesAsMarkdown() {
    return settingsManager?.getSetting?.('renderMarkdownForUserMessages') === true;
  }

  function isUserMessageExpanded(messageDiv) {
    return messageDiv?.dataset?.userMessageExpanded === 'true';
  }

  function setUserMessageExpandedState(messageDiv, expanded) {
    if (!messageDiv?.dataset) return;
    messageDiv.dataset.userMessageExpanded = expanded ? 'true' : 'false';
  }

  function updateUserMessageToggleButton(toggleButton, expanded) {
    if (!(toggleButton instanceof HTMLElement)) return;
    const icon = toggleButton.querySelector('.user-message-text-content__toggle-icon');
    if (icon) {
      icon.className = expanded
        ? 'fa-solid fa-chevron-up user-message-text-content__toggle-icon'
        : 'fa-solid fa-chevron-down user-message-text-content__toggle-icon';
      icon.setAttribute('aria-hidden', 'true');
    }
    const label = expanded ? '收起' : '展开';
    const text = toggleButton.querySelector('.user-message-text-content__toggle-label');
    if (text) {
      text.textContent = label;
    } else {
      toggleButton.textContent = label;
    }
    toggleButton.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggleButton.setAttribute('title', `${label}用户消息`);
    toggleButton.setAttribute('aria-label', `${label}用户消息`);
  }

  function measureUserMessageCollapsedOverflow(textContentDiv, body) {
    if (!(textContentDiv instanceof HTMLElement) || !(body instanceof HTMLElement)) return false;
    const wasExpanded = textContentDiv.classList.contains('is-expanded');
    const hadCollapsibleClass = textContentDiv.classList.contains('is-collapsible');
    if (wasExpanded) {
      textContentDiv.classList.remove('is-expanded');
    }
    if (!hadCollapsibleClass) {
      textContentDiv.classList.add('is-collapsible');
    }
    // 这里统一按“折叠态”的 50vh 约束测量一次，避免展开后误判为不需要按钮。
    const isOverflowing = (body.scrollHeight - body.clientHeight) > 1;
    if (!hadCollapsibleClass) {
      textContentDiv.classList.remove('is-collapsible');
    }
    if (wasExpanded) {
      textContentDiv.classList.add('is-expanded');
    }
    return isOverflowing;
  }

  function syncUserMessageTextContentOverflow(messageDiv, textContentDiv) {
    if (!(messageDiv instanceof HTMLElement) || !(textContentDiv instanceof HTMLElement)) return;
    const body = textContentDiv.querySelector('.user-message-text-content__body');
    const footer = textContentDiv.querySelector('.user-message-text-content__footer');
    const toggleButton = textContentDiv.querySelector('.user-message-text-content__toggle');
    if (!(body instanceof HTMLElement) || !(footer instanceof HTMLElement) || !(toggleButton instanceof HTMLElement)) {
      conversationDocumentViewer.syncConversationDocumentAttachmentStrip(messageDiv);
      return;
    }

    const isOverflowing = measureUserMessageCollapsedOverflow(textContentDiv, body);
    textContentDiv.classList.toggle('is-collapsible', isOverflowing);

    if (!isOverflowing) {
      setUserMessageExpandedState(messageDiv, false);
      textContentDiv.classList.remove('is-expanded');
      footer.hidden = true;
      conversationDocumentViewer.syncConversationDocumentAttachmentStrip(messageDiv);
      return;
    }

    const expanded = isUserMessageExpanded(messageDiv);
    textContentDiv.classList.toggle('is-expanded', expanded);
    footer.hidden = false;
    updateUserMessageToggleButton(toggleButton, expanded);
    conversationDocumentViewer.syncConversationDocumentAttachmentStrip(messageDiv);
  }

  function scheduleUserMessageOverflowSync(messageDiv, attempt = 0) {
    scheduleAfterLayout(() => {
      if (!(messageDiv instanceof HTMLElement)) return;
      const textContentDiv = messageDiv.querySelector('.text-content.user-message-text-content');
      if (!(textContentDiv instanceof HTMLElement) || !messageDiv.isConnected) {
        if (attempt < 4) {
          scheduleUserMessageOverflowSync(messageDiv, attempt + 1);
        }
        return;
      }
      syncUserMessageTextContentOverflow(messageDiv, textContentDiv);
    });
  }

  function createUserMessageToggleButton(messageDiv, textContentDiv) {
    const toggleButton = document.createElement('button');
    toggleButton.type = 'button';
    toggleButton.className = 'user-message-text-content__toggle';

    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-chevron-down user-message-text-content__toggle-icon';
    icon.setAttribute('aria-hidden', 'true');
    toggleButton.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'user-message-text-content__toggle-label';
    toggleButton.appendChild(label);

    toggleButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const nextExpanded = !isUserMessageExpanded(messageDiv);
      runWithStableToggleScroll(toggleButton, () => {
        setUserMessageExpandedState(messageDiv, nextExpanded);
        textContentDiv.classList.toggle('is-expanded', nextExpanded);
        updateUserMessageToggleButton(toggleButton, nextExpanded);
      });
    });

    updateUserMessageToggleButton(toggleButton, isUserMessageExpanded(messageDiv));
    return toggleButton;
  }

  function renderUserMessageTextContent(messageDiv, textContentDiv, messageText) {
    if (!(messageDiv instanceof HTMLElement) || !(textContentDiv instanceof HTMLElement)) return;
    const enableDollarMath = settingsManager?.getSetting?.('enableDollarMath') !== false;
    const renderAsMarkdown = shouldRenderUserMessagesAsMarkdown();

    textContentDiv.classList.add('user-message-text-content');
    textContentDiv.replaceChildren();

    const body = document.createElement('div');
    body.className = 'user-message-text-content__body';
    textContentDiv.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'user-message-text-content__footer';
    footer.hidden = true;
    footer.appendChild(createUserMessageToggleButton(messageDiv, textContentDiv));
    textContentDiv.appendChild(footer);

    if (renderAsMarkdown) {
      body.classList.add('user-message-text-content__body--markdown');
      body.innerHTML = renderMarkdownSafe(messageText || '', {
        allowDetails: true,
        enableDollarMath
      });
      enhanceMarkdownContent(body, {
        onAsyncRenderComplete() {
          scheduleUserMessageOverflowSync(messageDiv);
        }
      });
    } else {
      body.classList.add('user-message-text-content__body--plain');
      body.innerText = messageText || '';
    }

    scheduleUserMessageOverflowSync(messageDiv);
  }

  function rerenderUserMessagesForDisplaySettings() {
    const containers = [chatContainer, dom?.threadContainer].filter((container, index, arr) => (
      !!container && arr.indexOf(container) === index
    ));
    if (!containers.length) return;

    const visitedMessageIds = new Set();
    containers.forEach((container) => {
      container.querySelectorAll('.message.user-message').forEach((messageDiv) => {
        const messageId = messageDiv.getAttribute('data-message-id');
        if (messageId && visitedMessageIds.has(messageId)) return;
        if (messageId) visitedMessageIds.add(messageId);

        const originalText = messageDiv.getAttribute('data-original-text');
        if (typeof originalText !== 'string') return;

        let textContentDiv = messageDiv.querySelector('.text-content');
        if (!textContentDiv) {
          textContentDiv = document.createElement('div');
          textContentDiv.classList.add('text-content');
          messageDiv.appendChild(textContentDiv);
        }
        renderUserMessageTextContent(messageDiv, textContentDiv, originalText);
      });
    });
  }
  
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
      Array.from(container.querySelectorAll('a')).forEach((link) => {
        const rawHref = link.getAttribute('href') || '';
        if (isConversationDocumentRelativeHref(rawHref)) {
          try {
            const card = createConversationDocumentCard(link);
            const blockParent = link.parentElement;
            if (blockParent && blockParent.tagName === 'P' && blockParent.childElementCount === 1 && blockParent.textContent.trim() === link.textContent.trim()) {
              blockParent.replaceWith(card);
            } else {
              link.replaceWith(card);
            }
          } catch (_) {}
          return;
        }
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

    const ownerMessages = new Set();
    uniqueContainers.forEach((container) => {
      const messageElement = container?.closest?.('.message');
      if (messageElement instanceof HTMLElement) {
        ownerMessages.add(messageElement);
      }
    });
    if (rootElement instanceof HTMLElement && rootElement.classList?.contains('message')) {
      ownerMessages.add(rootElement);
    }
    ownerMessages.forEach((messageElement) => {
      conversationDocumentViewer.syncConversationDocumentAttachmentStrip(messageElement);
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

  function normalizeMessageId(messageId) {
    return (typeof messageId === 'string' || typeof messageId === 'number')
      ? String(messageId).trim()
      : '';
  }

  function resolveMessageElement(messageId) {
    const normalizedMessageId = normalizeMessageId(messageId);
    if (!normalizedMessageId) return null;
    const selector = buildMessageSelector(normalizedMessageId);
    if (!selector) return null;
    let element = chatContainer?.querySelector(selector) || null;
    if (element) return element;

    const threadContainer = dom?.threadContainer || null;
    if (threadContainer && threadContainer !== chatContainer) {
      element = threadContainer.querySelector(selector) || null;
    }
    return element;
  }

  /**
   * 优先按稳定 message-id 回查当前 live DOM。
   *
   * 这样做是为了兜住“旧 wrapper 已被虚拟列表/局部重建替换”的场景：
   * - 若 message-id 还能在当前界面找到，就永远信任这份 live 节点；
   * - 只有在根本找不到 live 节点时，才退回调用方传进来的 fallback。
   *
   * @param {string|null|undefined} messageId
   * @param {HTMLElement|null|undefined} fallbackElement
   * @returns {HTMLElement|null}
   */
  function resolveLiveMessageElement(messageId, fallbackElement = null) {
    const liveElement = resolveMessageElement(messageId);
    if (liveElement) return liveElement;
    if (!fallbackElement || typeof fallbackElement !== 'object') return null;
    if (fallbackElement.isConnected === false && !fallbackElement.parentNode) return null;
    return fallbackElement;
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

  const pendingStableToggleScrollAnchors = new WeakMap();

  function scheduleAfterLayout(callback) {
    const schedule = (typeof requestAnimationFrame === 'function')
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16);
    schedule(() => callback?.());
  }

  function captureStableToggleScrollAnchor(targetElement, scrollContainer = null) {
    if (!(targetElement instanceof HTMLElement)) return null;
    const ownerMessage = targetElement.classList?.contains('message')
      ? targetElement
      : targetElement.closest?.('.message');
    const resolvedScrollContainer = scrollContainer || resolveScrollContainerForMessage(ownerMessage || targetElement);
    if (!(resolvedScrollContainer instanceof HTMLElement)) return null;
    if (!resolvedScrollContainer.isConnected || !targetElement.isConnected) return null;

    const containerRect = resolvedScrollContainer.getBoundingClientRect();
    const targetRect = targetElement.getBoundingClientRect();
    const relativeTop = targetRect.top - containerRect.top;
    const targetHeight = targetRect.height;
    const viewportHeight = resolvedScrollContainer.clientHeight;
    const { anchorRatio, anchorViewportY } = computeStableScrollAnchor({
      elementTop: relativeTop,
      elementHeight: targetHeight,
      viewportHeight
    });

    return {
      targetElement,
      ownerMessage: ownerMessage instanceof HTMLElement ? ownerMessage : null,
      scrollContainer: resolvedScrollContainer,
      anchorRatio,
      anchorViewportY,
      beforeTop: relativeTop,
      beforeHeight: targetHeight,
      viewportHeight
    };
  }

  function restoreStableToggleScrollAnchor(anchorSnapshot) {
    if (!anchorSnapshot) return false;
    const {
      targetElement,
      ownerMessage,
      scrollContainer,
      anchorViewportY,
      anchorRatio,
      beforeTop,
      beforeHeight,
      viewportHeight
    } = anchorSnapshot;
    if (!(targetElement instanceof HTMLElement) || !(scrollContainer instanceof HTMLElement)) return false;
    if (!targetElement.isConnected || !scrollContainer.isConnected) return false;

    const containerRect = scrollContainer.getBoundingClientRect();
    const targetRect = targetElement.getBoundingClientRect();
    const afterTop = targetRect.top - containerRect.top;
    const afterHeight = targetRect.height;
    const compensation = computeStableScrollCompensation({
      beforeTop,
      beforeHeight,
      afterTop,
      afterHeight,
      viewportHeight
    });
    const scrollDelta = Number.isFinite(Number(compensation.scrollDelta))
      ? Number(compensation.scrollDelta)
      : ((afterTop + afterHeight * anchorRatio) - anchorViewportY);
    if (Number.isFinite(scrollDelta) && Math.abs(scrollDelta) > 0.01) {
      scrollContainer.scrollTop += scrollDelta;
    }

    const listContainer = resolveMessageListContainer(ownerMessage || targetElement);
    if (listContainer) {
      messageVirtualizer.scheduleUpdate(listContainer);
    }
    return true;
  }

  function runWithStableToggleScroll(targetElement, mutate, options = {}) {
    const anchorSnapshot = captureStableToggleScrollAnchor(
      targetElement,
      options?.scrollContainer || null
    );
    const result = mutate?.();
    if (anchorSnapshot) {
      scheduleAfterLayout(() => {
        restoreStableToggleScrollAnchor(anchorSnapshot);
      });
    }
    return result;
  }

  function queueStableToggleScrollAnchor(toggleOwnerElement, targetElement, options = {}) {
    if (!(toggleOwnerElement instanceof HTMLElement)) return;
    const anchorSnapshot = captureStableToggleScrollAnchor(
      targetElement,
      options?.scrollContainer || null
    );
    if (anchorSnapshot) {
      pendingStableToggleScrollAnchors.set(toggleOwnerElement, anchorSnapshot);
    } else {
      pendingStableToggleScrollAnchors.delete(toggleOwnerElement);
    }
  }

  function flushQueuedStableToggleScrollAnchor(toggleOwnerElement) {
    if (!(toggleOwnerElement instanceof HTMLElement)) return;
    const anchorSnapshot = pendingStableToggleScrollAnchors.get(toggleOwnerElement);
    if (!anchorSnapshot) return;
    pendingStableToggleScrollAnchors.delete(toggleOwnerElement);
    scheduleAfterLayout(() => {
      restoreStableToggleScrollAnchor(anchorSnapshot);
    });
  }

  function bindStableToggleDetails(detailsElement, anchorTarget = null, scrollContainer = null) {
    if (!(detailsElement instanceof HTMLElement) || detailsElement.dataset.stableToggleBound === 'true') return;
    const summary = detailsElement.querySelector(':scope > summary');
    if (!(summary instanceof HTMLElement)) return;
    const target = (anchorTarget instanceof HTMLElement) ? anchorTarget : detailsElement;
    const queueAnchor = (event) => {
      if (event?.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
      queueStableToggleScrollAnchor(detailsElement, target, { scrollContainer });
    };
    summary.addEventListener('click', queueAnchor);
    summary.addEventListener('keydown', queueAnchor);
    detailsElement.addEventListener('toggle', () => {
      flushQueuedStableToggleScrollAnchor(detailsElement);
    });
    detailsElement.dataset.stableToggleBound = 'true';
  }

  // assistant 消息的 surface 级快照缓存：
  // - text / thoughts / response_activity / footer / legacy tool_calls 分开记录；
  // - renderer 每次先构造下一版 surface snapshot，再做局部 reconcile；
  // - 这样流式更新时可以只改真正变化的 surface / entry / markdown block。
  const assistantSurfaceSnapshotByMessage = new WeakMap();
  // Response activity 面板是高频增量刷新的：
  // - 若每次都直接重建 DOM，不仅会让展开状态闪烁，
  // - 还会把用户正在阅读的代码/返回值块内部滚动位置重置到顶部。
  //
  // 这里用 message-wrapper 级 WeakMap 保留“瞬时 UI 状态”：
  // - 面板/工具展开状态的兜底快照；
  // - 各工具详情块（代码/参数/返回值）的内部 scrollTop；
  // - 嵌套 <details>（如来源列表）的 open 状态。
  //
  // 之所以挂在 messageWrapperDiv 上，而不是 timelineRoot 上，是因为
  // timelineRoot 在某些清理/重建路径里会被整个 remove；message wrapper 更稳定。
  const responseActivityUiStateByMessage = new WeakMap();
  // 工具详情块“完成后延迟自动收起”的计时元数据分两层保存：
  // - 优先按稳定 message-id 存到普通 Map，避免消息 DOM 被重建后 deadline 丢失；
  // - message-id 尚未落定时，再退回到 wrapper 级 WeakMap。
  //
  // 这是这次 bug 的关键修复点：
  // - 之前只按旧 wrapper 记 timer，一旦虚拟列表/重绘把节点替换掉，
  //   2 秒后的自动收起就会打到失效节点上；
  // - 现在只要消息有稳定 id，后续重绘拿到的新 wrapper 仍能读到同一份 deadline。
  const responseActivityAutoCollapseTimersByMessage = new WeakMap();
  const responseActivityAutoCollapseTimersByMessageId = new Map();

  function getAssistantSurfaceSnapshots(messageElement) {
    if (!messageElement || typeof messageElement !== 'object') return null;
    let state = assistantSurfaceSnapshotByMessage.get(messageElement);
    if (!state) {
      state = {
        text: null,
        thoughts: null,
        responseActivity: null,
        footer: null,
        legacyToolCalls: null
      };
      assistantSurfaceSnapshotByMessage.set(messageElement, state);
    }
    return state;
  }

  function resetAssistantSurfaceSnapshot(messageElement, surfaceName = null) {
    if (!messageElement || typeof messageElement !== 'object') return;
    if (!surfaceName) {
      assistantSurfaceSnapshotByMessage.delete(messageElement);
      return;
    }
    const state = getAssistantSurfaceSnapshots(messageElement);
    if (!state || !Object.prototype.hasOwnProperty.call(state, surfaceName)) return;
    state[surfaceName] = null;
  }

  function describeRenderedSurfaceBlock(node, options = {}) {
    if (!node) return null;
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    if (node.nodeType === Node.TEXT_NODE) {
      const text = String(node.textContent || '');
      if (!text) return null;
      const descriptor = {
        type: 'text',
        signature: `text:${text}`,
        text
      };
      if (normalizedOptions.includeNode) {
        descriptor.node = node;
      }
      return descriptor;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const descriptor = {
      type: 'element',
      signature: `element:${node.tagName.toLowerCase()}:${node.outerHTML}`,
      html: node.outerHTML
    };
    if (normalizedOptions.includeNode) {
      descriptor.node = node;
    }
    return descriptor;
  }

  function buildRenderedSurfaceBlocksFromHtml(renderedHtml) {
    const template = document.createElement('template');
    template.innerHTML = (typeof renderedHtml === 'string') ? renderedHtml : '';
    return Array.from(template.content.childNodes)
      .map(describeRenderedSurfaceBlock)
      .filter(Boolean);
  }

  function buildRenderedSurfaceBlocksFromDom(container, options = {}) {
    if (!container) return [];
    return Array.from(container.childNodes)
      .map((node) => describeRenderedSurfaceBlock(node, options))
      .filter(Boolean);
  }

  function buildMarkdownSurfaceSnapshot(rawText, renderedHtml, existingContainer = null) {
    const normalizedText = (typeof rawText === 'string') ? rawText : '';
    const normalizedHtml = (typeof renderedHtml === 'string') ? renderedHtml : '';
    const blocks = normalizedHtml
      ? buildRenderedSurfaceBlocksFromHtml(normalizedHtml)
      : [];
    return {
      rawText: normalizedText,
      renderedHtml: normalizedHtml,
      blocks,
      blockSignatures: blocks.map((block) => block.signature),
      domBlockSignatures: existingContainer ? buildRenderedSurfaceBlocksFromDom(existingContainer).map((block) => block.signature) : null
    };
  }

  function createNodeFromRenderedSurfaceBlock(block) {
    if (!block) return null;
    if (block.type === 'text') {
      return document.createTextNode(block.text || '');
    }
    if (block.type === 'element') {
      const template = document.createElement('template');
      template.innerHTML = block.html || '';
      return template.content.firstChild;
    }
    return null;
  }

  function reconcileRenderedSurfaceBlocks(container, nextSnapshot, previousSnapshot, options = {}) {
    if (!container || !nextSnapshot) return false;
    const currentDomBlocks = buildRenderedSurfaceBlocksFromDom(container, { includeNode: true });
    const previousSignatures = resolveRenderedSurfaceDiffBaseSignatures(
      Array.isArray(previousSnapshot?.blockSignatures) ? previousSnapshot.blockSignatures : [],
      currentDomBlocks.map((block) => block.signature)
    );
    const nextSignatures = Array.isArray(nextSnapshot.blockSignatures)
      ? nextSnapshot.blockSignatures
      : [];
    const diffWindow = computeContiguousDiffWindow(previousSignatures, nextSignatures);
    if (!diffWindow.hasChanges) {
      return false;
    }

    const anchorNode = currentDomBlocks[diffWindow.previousRangeStart]?.node || null;
    const fragment = document.createDocumentFragment();
    const insertedElements = [];
    nextSnapshot.blocks
      .slice(diffWindow.nextRangeStart, diffWindow.nextRangeEnd)
      .forEach((block) => {
        const nextNode = createNodeFromRenderedSurfaceBlock(block);
        if (!nextNode) return;
        fragment.appendChild(nextNode);
        if (nextNode.nodeType === Node.ELEMENT_NODE) {
          insertedElements.push(nextNode);
        }
      });

    if (anchorNode) {
      container.insertBefore(fragment, anchorNode);
    } else {
      container.appendChild(fragment);
    }

    currentDomBlocks
      .slice(diffWindow.previousRangeStart, diffWindow.previousRangeEnd)
      .forEach((block) => block?.node?.remove?.());

    if (typeof options.afterInsert === 'function') {
      insertedElements.forEach((element) => {
        try {
          options.afterInsert(element);
        } catch (_) {}
      });
    }
    return true;
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
  function ensureThoughtsSurface(messageWrapperDiv) {
    let thoughtsContentDiv = messageWrapperDiv.querySelector('.thoughts-content');
    let created = false;
    if (!thoughtsContentDiv) {
      thoughtsContentDiv = document.createElement('div');
      thoughtsContentDiv.className = 'thoughts-content';
      created = true;
    }

    const legacyPrefix = thoughtsContentDiv.querySelector('.thoughts-prefix');
    if (legacyPrefix) legacyPrefix.remove();
    const legacyExpandButton = thoughtsContentDiv.querySelector('.expand-thoughts-btn');
    if (legacyExpandButton) legacyExpandButton.remove();

    let toggleButton = thoughtsContentDiv.querySelector('.thoughts-toggle');
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
        runWithStableToggleScroll(thoughtsContentDiv, () => {
          thoughtsContentDiv.dataset.userToggled = 'true';
          const isExpanded = thoughtsContentDiv.classList.toggle('expanded');
          thoughtsContentDiv.dataset.manualState = isExpanded ? 'expanded' : 'collapsed';
          toggleButton.setAttribute('aria-expanded', isExpanded.toString());
        });
      });
      toggleButton.dataset.listenerAdded = 'true';
    }

    let thoughtsInnerContent = thoughtsContentDiv.querySelector('.thoughts-inner-content');
    if (!thoughtsInnerContent) {
      thoughtsInnerContent = document.createElement('div');
      thoughtsInnerContent.className = 'thoughts-inner-content';
      thoughtsContentDiv.appendChild(thoughtsInnerContent);
    }

    if (created) {
      const textContentElement = messageWrapperDiv.querySelector('.text-content');
      if (textContentElement) {
        messageWrapperDiv.insertBefore(thoughtsContentDiv, textContentElement);
      } else {
        messageWrapperDiv.appendChild(thoughtsContentDiv);
      }
    }

    return {
      thoughtsContentDiv,
      thoughtsInnerContent,
      toggleButton
    };
  }

  function reconcileMarkdownSurfaceContainer(container, rawText, processMathAndMarkdownFn, previousSnapshot) {
    if (!container) return null;
    const renderedHtml = processMathAndMarkdownFn(rawText || '');
    const nextSnapshot = buildMarkdownSurfaceSnapshot(rawText, renderedHtml, container);
    const previousSurfaceSnapshot = previousSnapshot || {
      blockSignatures: nextSnapshot.domBlockSignatures || []
    };
    reconcileRenderedSurfaceBlocks(container, nextSnapshot, previousSurfaceSnapshot, {
      afterInsert: (element) => enhanceMarkdownContent(element)
    });
    return nextSnapshot;
  }

  function setupThoughtsDisplay(messageWrapperDiv, rawThoughts, processMathAndMarkdownFn) {
    let thoughtsContentDiv = messageWrapperDiv.querySelector('.thoughts-content');
    const surfaceSnapshots = getAssistantSurfaceSnapshots(messageWrapperDiv);

    if (rawThoughts && rawThoughts.trim() !== '') {
      const {
        thoughtsContentDiv: nextThoughtsContentDiv,
        thoughtsInnerContent,
        toggleButton
      } = ensureThoughtsSurface(messageWrapperDiv);
      thoughtsContentDiv = nextThoughtsContentDiv;

      surfaceSnapshots.thoughts = reconcileMarkdownSurfaceContainer(
        thoughtsInnerContent,
        rawThoughts,
        processMathAndMarkdownFn,
        surfaceSnapshots.thoughts
      );

      // 自动展开/折叠策略：
      // - 首次出现且“正文尚未开始输出”时，默认展开一次；
      // - 一旦正文开始输出，就立即自动收起一次；
      // - 如果直到结束都没有正文，也会在结束时自动收起一次；
      // - 除这几个生命周期动作外，不再反复改写，避免刷新时闪烁；
      // - 用户一旦手动点击，后续刷新始终尊重用户选择。
      const isUpdating = messageWrapperDiv.classList.contains('updating')
        || isResponseActivityTurnRuntimeActive(messageWrapperDiv);
      const visibleAnswerText = (typeof messageWrapperDiv.getAttribute === 'function')
        ? String(messageWrapperDiv.getAttribute('data-original-text') || '').trim()
        : '';
      const hasVisibleAnswerStarted = visibleAnswerText.length > 0;
      if (
        thoughtsContentDiv.dataset.userToggled === 'true'
        && !String(thoughtsContentDiv.dataset.manualState || '').trim()
      ) {
        thoughtsContentDiv.dataset.manualState = thoughtsContentDiv.classList.contains('expanded') ? 'expanded' : 'collapsed';
      }
      const manualState = String(thoughtsContentDiv.dataset.manualState || '').trim().toLowerCase();
      const lifecycleState = resolveThoughtsPanelLifecycleState({
        manualState,
        lifecycleInitialized: thoughtsContentDiv.dataset.autoLifecycleInitialized === 'true',
        autoCollapsedAfterAnswerStart:
          thoughtsContentDiv.dataset.autoCollapsedAfterAnswerStart === 'true'
          || thoughtsContentDiv.dataset.autoCollapsedAfterFinish === 'true',
        isUpdating,
        hasVisibleAnswerStarted,
        currentlyExpanded: thoughtsContentDiv.classList.contains('expanded')
      });

      thoughtsContentDiv.dataset.autoLifecycleInitialized = lifecycleState.lifecycleInitialized ? 'true' : 'false';
      if (lifecycleState.autoCollapsedAfterAnswerStart) {
        thoughtsContentDiv.dataset.autoCollapsedAfterAnswerStart = 'true';
      } else {
        delete thoughtsContentDiv.dataset.autoCollapsedAfterAnswerStart;
      }
      delete thoughtsContentDiv.dataset.autoCollapsedAfterFinish;

      const applyExpandedState = () => {
        thoughtsContentDiv.classList.toggle('expanded', lifecycleState.expanded);
        if (toggleButton) {
          toggleButton.setAttribute('aria-expanded', lifecycleState.expanded ? 'true' : 'false');
        }
      };
      // 生命周期驱动的自动展开/收起只允许改变思考块自身布局：
      // - 不补偿外层 chatContainer 的 scrollTop；
      // - 否则思考流每次刷新都会把整条会话错误地“推着走”，
      //   破坏“最新消息顶部锚点保持稳定”的阅读体验。
      applyExpandedState();
    } else if (thoughtsContentDiv) {
      thoughtsContentDiv.remove();
      surfaceSnapshots.thoughts = null;
    } else {
      surfaceSnapshots.thoughts = null;
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
          renderUserMessageTextContent(messageDiv, textContentDiv, messageText);
        } else {
          const surfaceSnapshots = getAssistantSurfaceSnapshots(messageDiv);
          surfaceSnapshots.text = reconcileMarkdownSurfaceContainer(
            textContentDiv,
            messageText,
            processMathAndMarkdown,
            surfaceSnapshots.text
          );
        }
      } catch (error) {
        console.error('处理数学公式和Markdown失败:', error);
        if (sender === 'user') {
          textContentDiv.classList.add('user-message-text-content');
          textContentDiv.innerText = messageText;
          conversationDocumentViewer.syncConversationDocumentAttachmentStrip(messageDiv);
        } else {
          textContentDiv.innerText = messageText;
        }
      }

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

            runWithStableToggleScroll(detailsElement, () => {
              if (detailsElement.hasAttribute('open')) {
                detailsElement.removeAttribute('open');
              } else {
                detailsElement.setAttribute('open', '');
              }
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
      if (sender === 'ai' && messageDiv && node) {
        syncAssistantMessageMetadata(node.id, node, { fallbackElement: messageDiv });
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

  function renderAiMessageDom(messageDiv, node, safeAnswerContent, resolvedThoughts, options = {}) {
    if (!messageDiv) return false;
    const runtimeSnapshot = options?.runtimeSnapshot || null;
    const surfaceSnapshots = getAssistantSurfaceSnapshots(messageDiv);
    const scrollContainer = resolveScrollContainerForMessage(messageDiv);
    // 只在用户原本就接近底部时继续“粘底”滚动。
    // 这样流式更新不会把正在上方阅读旧内容的用户强行拽回底部。
    const shouldStickToBottom = isScrollContainerNearBottom(scrollContainer);

    // 统一清理“错误态”残留，避免重试成功后仍显示红字/旧重试按钮。
    try {
      messageDiv.classList.remove('assistant-pre-response');
      messageDiv.classList.remove('error-message');
      messageDiv.classList.remove('loading-message');
      messageDiv.classList.remove('regenerating');
      delete messageDiv.dataset.preResponseStage;
      messageDiv.removeAttribute('title');
      const preResponseStatus = messageDiv.querySelectorAll('.assistant-pre-response-status');
      preResponseStatus.forEach((statusEl) => statusEl.remove());
      const retryActions = messageDiv.querySelectorAll('.error-retry-actions');
      retryActions.forEach((actionEl) => actionEl.remove());
      const rootTextNodes = Array.from(messageDiv.childNodes || []).filter(node => node && node.nodeType === 3);
      rootTextNodes.forEach((node) => node.remove());
    } catch (_) {}

    messageDiv.setAttribute('data-original-text', safeAnswerContent);

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

    surfaceSnapshots.text = reconcileMarkdownSurfaceContainer(
      textContentDiv,
      safeAnswerContent,
      processMathAndMarkdown,
      surfaceSnapshots.text
    );

    syncAssistantMessageMetadata(node?.id || null, node, {
      fallbackElement: messageDiv,
      runtimeSnapshot
    });

    try {
      services.selectionThreadManager?.decorateMessageElement?.(messageDiv, node);
    } catch (e) {
      console.warn('更新 AI 消息时应用划词线程高亮失败:', e);
    }
    if (shouldStickToBottom && scrollContainer) {
      scrollToBottom(scrollContainer);
    }
    messageVirtualizer.scheduleUpdate(resolveMessageListContainer(messageDiv));
    return true;
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

  function isResponseActivitySkillRegistryEntry(record) {
    return isSkillRegistryToolCall(record);
  }

  function isResponseActivityConversationDocumentEntry(record) {
    return isVirtualFileToolCall(record);
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

  function extractResponseToolCallOutputImages(rawOutput) {
    return extractResponsesToolOutputInputImages(rawOutput);
  }

  function normalizeResponseActivityToolOutputImages(outputImages) {
    return Array.isArray(outputImages)
      ? outputImages.filter(image => image && typeof image.imageUrl === 'string' && image.imageUrl.trim())
      : [];
  }

  function buildResponseActivityToolImageList(outputImages) {
    const normalizedImages = normalizeResponseActivityToolOutputImages(outputImages);
    if (normalizedImages.length <= 0) return null;

    const imageList = document.createElement('div');
    imageList.className = 'response-activity-tool-image-list';

    normalizedImages.forEach((image, imageIndex) => {
      const figure = document.createElement('figure');
      figure.className = 'response-activity-tool-image-card';

      const img = document.createElement('img');
      img.className = 'response-activity-tool-image';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = image.imageUrl;
      img.alt = `工具返回图片 ${image.index + 1}`;
      img.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        imageHandler.showImagePreview(image.imageUrl);
      });
      figure.appendChild(img);

      if (normalizedImages.length > 1) {
        const caption = document.createElement('figcaption');
        caption.className = 'response-activity-tool-image-caption';
        caption.textContent = `图片 ${imageIndex + 1}`;
        figure.appendChild(caption);
      }

      imageList.appendChild(figure);
    });

    return imageList;
  }

  function appendResponseActivityToolOutput(toolBodyInner, outputText, outputImages, options = {}) {
    const normalizedText = (typeof outputText === 'string') ? outputText.trim() : '';
    const normalizedImages = normalizeResponseActivityToolOutputImages(outputImages);
    const suppressImages = options?.suppressImages === true;
    if (!normalizedText && normalizedImages.length <= 0) {
      return;
    }

    if (normalizedText || (normalizedImages.length > 0 && !suppressImages)) {
      const outputTitle = document.createElement('div');
      outputTitle.className = 'response-activity-tool-block-title';
      outputTitle.textContent = '返回值';
      toolBodyInner.appendChild(outputTitle);
    }

    if (normalizedText) {
      const outputBlock = document.createElement('pre');
      outputBlock.className = 'response-activity-tool-output';
      setupResponseActivityExpandableTextBlock(outputBlock);
      outputBlock.textContent = normalizedText;
      toolBodyInner.appendChild(outputBlock);
    }

    if (normalizedImages.length > 0 && !suppressImages) {
      const imageList = buildResponseActivityToolImageList(normalizedImages);
      if (imageList) {
        toolBodyInner.appendChild(imageList);
      }
    }
  }

  function buildResponseActivityJsRuntimeSummaryParts(record, options = {}) {
    const meta = getResponseActivityJsRuntimeMeta(record);
    const isInProgress = options?.isInProgress === true || isResponseActivityEntryInProgress(record);
    const codePreview = formatResponseActivityJsCodePreview(meta.code) || 'JavaScript';
    const action = meta.isTopLevel
      ? (isInProgress ? '运行中' : '已运行')
      : (isInProgress
          ? `正在${meta.frameIds.length}个iframe中运行`
          : `已在${meta.frameIds.length}个iframe运行`);
    return {
      action,
      value: codePreview,
      valueUrl: '',
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  function renderResponseActivityJsRuntimeBody(toolBodyInner, entry, snapshot = null, options = {}) {
    if (!toolBodyInner || !entry) return;
    const meta = getResponseActivityJsRuntimeMeta(entry);
    const formattedOutput = snapshot?.outputText || formatResponseToolCallOutput(entry.output);
    const outputImages = Array.isArray(snapshot?.outputImages)
      ? snapshot.outputImages
      : extractResponseToolCallOutputImages(entry.output);

    const codeTitle = document.createElement('div');
    codeTitle.className = 'response-activity-tool-block-title';
    codeTitle.textContent = '代码';
    toolBodyInner.appendChild(codeTitle);

    const codeBlock = document.createElement('pre');
    codeBlock.className = 'response-activity-tool-code';
    setupResponseActivityExpandableTextBlock(codeBlock);
    const codeInner = document.createElement('code');
    codeInner.className = 'language-javascript';
    codeInner.textContent = meta.code || '';
    codeBlock.appendChild(codeInner);
    toolBodyInner.appendChild(codeBlock);

    appendResponseActivityToolOutput(toolBodyInner, formattedOutput, outputImages, {
      suppressImages: options?.suppressOutputImages === true
    });
  }

  function shouldPreferResponseActivityToolInlineImagePreview(entry, outputImages) {
    return isResponseActivityImagePreviewToolCall(entry)
      && normalizeResponseActivityToolOutputImages(outputImages).length > 0;
  }

  function getSkillDiffOperationLabel(operation) {
    switch (String(operation || '').trim().toLowerCase()) {
      case 'add':
        return '新增';
      case 'delete':
        return '删除';
      case 'move':
        return '移动';
      default:
        return '修改';
    }
  }

  function renderResponseActivitySkillApplyPatchPreview(toolBodyInner, entry) {
    if (!toolBodyInner) return false;
    const preview = isResponseActivitySkillRegistryEntry(entry)
      ? buildSkillApplyPatchPreview(entry.arguments)
      : (isResponseActivityConversationDocumentEntry(entry)
          ? buildVirtualFileApplyPatchPreview(entry.arguments)
          : null);
    if (!preview || !Array.isArray(preview.files) || preview.files.length <= 0) return false;

    const summary = document.createElement('div');
    summary.className = 'response-activity-tool-diff-summary';

    const summaryPrimary = document.createElement('div');
    summaryPrimary.className = 'response-activity-tool-diff-summary-primary';
    summaryPrimary.textContent = `${preview.totalFiles} 个文件变更`;
    summary.appendChild(summaryPrimary);

    const summaryMeta = document.createElement('div');
    summaryMeta.className = 'response-activity-tool-diff-summary-meta';
    appendResponseActivityDiffStatTokens(summaryMeta, {
      additions: preview.totalAdditions,
      deletions: preview.totalDeletions
    });
    const summaryNotes = [];
    if (preview.skillName) summaryNotes.push(`skill ${preview.skillName}`);
    if (preview.truncatedFiles > 0) summaryNotes.push(`另有 ${preview.truncatedFiles} 个文件未展开`);
    if (summaryNotes.length > 0) {
      if (summaryMeta.childNodes.length > 0) {
        const spacer = document.createElement('span');
        spacer.className = 'response-activity-tool-diff-meta-spacer';
        spacer.textContent = ' ';
        summaryMeta.appendChild(spacer);
      }
      const notes = document.createElement('span');
      notes.className = 'response-activity-tool-diff-meta-note';
      notes.textContent = summaryNotes.join(' · ');
      summaryMeta.appendChild(notes);
    }
    if (summaryMeta.childNodes.length > 0) {
      summary.appendChild(summaryMeta);
    }
    toolBodyInner.appendChild(summary);

    const previewRoot = document.createElement('div');
    previewRoot.className = 'response-activity-tool-diff-preview';

    preview.files.forEach((file) => {
      const fileCard = document.createElement('section');
      fileCard.className = 'response-activity-tool-diff-file';

      const fileHeader = document.createElement('div');
      fileHeader.className = 'response-activity-tool-diff-file-header';

      const badge = document.createElement('span');
      badge.className = `response-activity-tool-diff-badge is-${file.operation || 'update'}`;
      badge.textContent = getSkillDiffOperationLabel(file.operation);
      fileHeader.appendChild(badge);

      const pathWrap = document.createElement('div');
      pathWrap.className = 'response-activity-tool-diff-path-wrap';

      const pathText = document.createElement('div');
      pathText.className = 'response-activity-tool-diff-path';
      pathText.textContent = file.path || '(unknown)';
      pathWrap.appendChild(pathText);

      if (file.movePath) {
        const moveText = document.createElement('div');
        moveText.className = 'response-activity-tool-diff-move-path';
        moveText.textContent = `→ ${file.movePath}`;
        pathWrap.appendChild(moveText);
      }

      fileHeader.appendChild(pathWrap);

      const statText = document.createElement('div');
      statText.className = 'response-activity-tool-diff-file-stats';
      appendResponseActivityDiffStatTokens(statText, {
        additions: file.additions,
        deletions: file.deletions
      });
      if (statText.childNodes.length <= 0) {
        const fallback = document.createElement('span');
        fallback.className = 'response-activity-tool-diff-meta-note';
        fallback.textContent = file.operation === 'delete' ? '文件已删除' : '结构变更';
        statText.appendChild(fallback);
      }
      fileHeader.appendChild(statText);

      fileCard.appendChild(fileHeader);

      const lines = Array.isArray(file.lines) ? file.lines : [];
      if (lines.length > 0) {
        const fileBody = document.createElement('div');
        fileBody.className = 'response-activity-tool-diff-file-body';

        lines.forEach((line) => {
          const row = document.createElement('div');
          row.className = `response-activity-tool-diff-line is-${line.kind || 'context'}`;

          const marker = document.createElement('span');
          marker.className = 'response-activity-tool-diff-line-marker';
          marker.textContent = line.kind === 'add'
            ? '+'
            : line.kind === 'delete'
              ? '-'
              : line.kind === 'hunk'
                ? '@'
                : line.kind === 'meta'
                  ? '·'
                  : ' ';
          row.appendChild(marker);

          const code = document.createElement('span');
          code.className = 'response-activity-tool-diff-line-text';
          code.textContent = line.text || '';
          row.appendChild(code);

          fileBody.appendChild(row);
        });

        if (file.truncated === true && file.omittedLineCount > 0) {
          const truncated = document.createElement('div');
          truncated.className = 'response-activity-tool-diff-truncated';
          truncated.textContent = `… 省略 ${file.omittedLineCount} 行`;
          fileBody.appendChild(truncated);
        }

        fileCard.appendChild(fileBody);
      }

      previewRoot.appendChild(fileCard);
    });

    toolBodyInner.appendChild(previewRoot);
    return true;
  }

  /**
   * 以结构化 token 渲染 diff 统计，便于让 `+N` / `-N` 独立着色。
   *
   * 设计约束：
   * - `+N` 与 `-N` 之间不使用圆点分隔；
   * - 颜色对齐 VSCode/Codex 常见的 added / removed git decoration 视觉语义；
   * - 其它说明文本由调用方另外追加，避免混成一段不可样式化的纯文本。
   */
  function appendResponseActivityDiffStatTokens(container, options = {}) {
    if (!(container instanceof HTMLElement)) return;
    const additions = Number.isFinite(Number(options.additions)) ? Number(options.additions) : 0;
    const deletions = Number.isFinite(Number(options.deletions)) ? Number(options.deletions) : 0;

    const appendToken = (text, className) => {
      const token = document.createElement('span');
      token.className = `response-activity-tool-diff-stat-token ${className}`.trim();
      token.textContent = text;
      container.appendChild(token);
    };

    if (additions > 0) {
      appendToken(`+${additions}`, 'is-add');
    }
    if (deletions > 0) {
      if (container.childNodes.length > 0) {
        const spacer = document.createElement('span');
        spacer.className = 'response-activity-tool-diff-meta-spacer';
        spacer.textContent = ' ';
        container.appendChild(spacer);
      }
      appendToken(`-${deletions}`, 'is-delete');
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
  function renderResponseActivityGenericToolBody(toolBodyInner, entry, snapshot = null, options = {}) {
    if (!toolBodyInner || !entry) return;
    const renderedPatchPreview = renderResponseActivitySkillApplyPatchPreview(toolBodyInner, entry);

    getResponseActivityToolSecondaryLines(entry).forEach((line) => {
      const secondary = document.createElement('div');
      secondary.className = 'response-activity-tool-secondary';
      secondary.textContent = line;
      toolBodyInner.appendChild(secondary);
    });

    if (!renderedPatchPreview && typeof entry.arguments === 'string' && entry.arguments.trim()) {
      const pre = document.createElement('pre');
      pre.className = 'response-activity-tool-arguments';
      setupResponseActivityExpandableTextBlock(pre);
      pre.textContent = formatResponseToolCallArguments(entry.arguments);
      toolBodyInner.appendChild(pre);
    }

    const formattedOutput = snapshot?.outputText || formatResponseToolCallOutput(entry.output);
    const outputImages = Array.isArray(snapshot?.outputImages)
      ? snapshot.outputImages
      : extractResponseToolCallOutputImages(entry.output);
    appendResponseActivityToolOutput(toolBodyInner, formattedOutput, outputImages, {
      suppressImages: options?.suppressOutputImages === true
    });

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
      bindStableToggleDetails(sources, sources);
    }
  }

  function getResponseToolCallTypeLabel(record) {
    const type = String(record?.type || '').toLowerCase();
    if (type === 'web_search_call') return '搜索';
    if (type === 'code_interpreter_call') return '代码';
    if (isResponseActivityJsRuntimeEntry(record)) return 'JS';
    if (isResponseActivityConversationDocumentEntry(record)) return getVirtualFileToolTypeLabel(record);
    if (isResponseActivitySkillRegistryEntry(record)) return getSkillRegistryToolTypeLabel(record);
    if (isResponseActivityCustomToolCall(record)) return getResponseActivityCustomToolTypeLabel(record);
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

  function buildResponseToolCallPrimaryText(record, options = {}) {
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
      const parts = buildResponseActivityJsRuntimeSummaryParts(record, options);
      return `${parts.action} ${parts.value}`.trim();
    }
    if (isResponseActivityConversationDocumentEntry(record)) {
      return buildVirtualFilePrimaryText(record, options);
    }
    if (isResponseActivitySkillRegistryEntry(record)) {
      return buildSkillRegistryPrimaryText(record, options);
    }
    if (isResponseActivityCustomToolCall(record)) {
      return buildResponseActivityCustomToolPrimaryText(record, options);
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
  function buildResponseToolCallPrimaryParts(record, options = {}) {
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
      return buildResponseActivityJsRuntimeSummaryParts(record, options);
    }
    if (isResponseActivityConversationDocumentEntry(record)) {
      return buildVirtualFileSummaryParts(record, options) || {
        action: '',
        value: '文件',
        valueUrl: '',
        meta: '',
        locationAction: '',
        locationValue: '',
        locationUrl: ''
      };
    }
    if (isResponseActivitySkillRegistryEntry(record)) {
      return buildSkillRegistrySummaryParts(record, options) || {
        action: '',
        value: '技能',
        valueUrl: '',
        meta: '',
        locationAction: '',
        locationValue: '',
        locationUrl: ''
      };
    }
    if (isResponseActivityCustomToolCall(record)) {
      return buildResponseActivityCustomToolSummaryParts(record, options) || {
        action: '',
        value: '工具',
        valueUrl: '',
        meta: '',
        locationAction: '',
        locationValue: '',
        locationUrl: ''
      };
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

  /**
   * response_activity 面板的“思考阶段是否仍在进行中”判定。
   *
   * 这里刻意与“整条 assistant 消息是否仍在 streaming”分开：
   * - 消息正文继续流式输出时，整条消息仍然是 updating；
   * - 但一旦已经开始展示可见正文，就说明思考阶段已经结束，面板应允许自动收起。
   *
   * 判定顺序：
   * 1. 优先使用本轮 runtimeSnapshot 的 hasVisibleAnswerStarted；
   * 2. 否则回退到 message wrapper 上缓存的 dataset；
   * 3. 最后用 DOM 上是否已经有可见正文做兜底。
   *
   * @param {HTMLElement|null} messageWrapperDiv
   * @param {Object|null} runtimeSnapshot
   * @param {Object|null} node
   * @returns {boolean}
   */
  function isResponseActivityThinkingRuntimeActive(messageWrapperDiv, runtimeSnapshot = null, node = null) {
    if (!messageWrapperDiv) return false;

    const normalizedMessageId = String(
      node?.id
      || messageWrapperDiv.getAttribute?.('data-message-id')
      || ''
    ).trim();
    const runtimeStatus = String(runtimeSnapshot?.activeTurn?.status || '').trim().toLowerCase();
    const boundAssistantMessageId = String(runtimeSnapshot?.activeTurn?.boundAssistantMessageId || '').trim();
    const runtimeBoundToCurrentMessage = !!(
      normalizedMessageId
      && boundAssistantMessageId
      && boundAssistantMessageId === normalizedMessageId
    );
    const runtimeTurnActive = !!runtimeStatus && !['idle', 'completed', 'aborted', 'error'].includes(runtimeStatus);

    if (runtimeBoundToCurrentMessage) {
      return runtimeTurnActive && runtimeSnapshot?.activeTurn?.hasVisibleAnswerStarted !== true;
    }

    const datasetThinkingActive = String(messageWrapperDiv.dataset?.responseThinkingRuntimeActive || '').trim().toLowerCase();
    if (datasetThinkingActive === 'true') return true;
    if (datasetThinkingActive === 'false') return false;

    if (!isResponseActivityTurnRuntimeActive(messageWrapperDiv)) return false;

    const visibleAnswerText = String(messageWrapperDiv.querySelector('.text-content')?.innerText || '').trim();
    if (visibleAnswerText) return false;

    return true;
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
      return kind === 'reasoning_summary' || kind === 'commentary' || kind === 'steer';
    }).length;
    const toolCount = timeline.filter(entry => entry?.kind === 'tool_call').length;
    // 这里的 in-progress 指“思考阶段仍在进行中”，不是“整条消息是否还在流”。
    const isInProgress = options.isThinkingInProgress === true;
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
      metaText: metaParts.join(' · '),
      durationLabel
    };
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

  function findResponseActivityToolItemByKey(timelineRoot, toolKey) {
    const normalizedToolKey = String(toolKey || '').trim();
    if (!timelineRoot || !normalizedToolKey) return null;
    return Array.from(timelineRoot.querySelectorAll('.response-activity-entry--tool'))
      .find((item) => String(item?.dataset?.responseActivityToolKey || '').trim() === normalizedToolKey) || null;
  }

  function readResponseActivityToolAutoCollapseDeadlineFromItem(toolItem) {
    const raw = String(toolItem?.dataset?.responseActivityToolAutoCollapseDeadlineAt || '').trim();
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  function writeResponseActivityToolAutoCollapseDeadlineToItem(toolItem, deadlineAtMs) {
    if (!toolItem?.dataset) return;
    const normalizedDeadlineAtMs = Number(deadlineAtMs);
    if (!Number.isFinite(normalizedDeadlineAtMs) || normalizedDeadlineAtMs < 0) {
      delete toolItem.dataset.responseActivityToolAutoCollapseDeadlineAt;
      return;
    }
    toolItem.dataset.responseActivityToolAutoCollapseDeadlineAt = String(normalizedDeadlineAtMs);
  }

  /**
   * 统一同步工具条目的“展开状态”和详情体 DOM 可见性。
   *
   * 这里刻意不用“仅靠 CSS 把高度压成 0 + opacity 置 0”的方式：
   * - 折叠后的工具详情若仍留在渲染树里，浏览器依然要为内部大段文本、代码块、
   *   图片来源列表等内容保留布局/样式参与，长对话下成本会持续累积；
   * - 因此这里在折叠时直接把详情体标记为 `hidden`，并同步 `inert`/`aria-hidden`，
   *   让其退出可见渲染与交互路径，只在真正展开时再恢复。
   *
   * @param {HTMLElement|null} toolItem
   * @param {boolean} expanded
   * @returns {void}
   */
  function setResponseActivityToolExpandedState(toolItem, expanded) {
    if (!(toolItem instanceof HTMLElement)) return;
    const nextExpanded = expanded === true;
    toolItem.classList.toggle('is-expanded', nextExpanded);
    const summary = toolItem.querySelector(':scope > .response-activity-tool-summary');
    summary?.setAttribute?.('aria-expanded', nextExpanded ? 'true' : 'false');

    const toolBody = toolItem.querySelector(':scope > .response-activity-tool-body');
    if (!(toolBody instanceof HTMLElement)) return;
    toolBody.hidden = !nextExpanded;
    toolBody.setAttribute('aria-hidden', nextExpanded ? 'false' : 'true');
    try {
      toolBody.inert = !nextExpanded;
    } catch (_) {}
  }

  /**
   * 当自动收起定时器到点时，先直接把 live DOM 上的工具条目标记为已自动收起。
   *
   * 这样做的目的不是绕开 renderer，而是给它一个“当前已收起”的稳定前态：
   * - 若后续 metadata 重绘顺利执行，这个 dataset 会继续被 renderer 读取并保留；
   * - 若某次重绘入口因为旧 wrapper 失效、消息暂不可见等原因没跑起来，
   *   用户也不会继续看到工具条目卡死在展开态。
   *
   * @param {HTMLElement|null} messageWrapperDiv
   * @param {string} toolKey
   * @returns {boolean}
   */
  function markResponseActivityToolAutoCollapsedInDom(messageWrapperDiv, toolKey) {
    const timelineRoot = messageWrapperDiv?.querySelector?.('.response-activity-timeline') || null;
    const normalizedToolKey = String(toolKey || '').trim();
    if (!timelineRoot || !normalizedToolKey) return false;

    const manualExpandedToolKeys = readManuallyExpandedResponseActivityToolKeys(timelineRoot);
    if (manualExpandedToolKeys.has(normalizedToolKey)) {
      return false;
    }

    const autoCollapsedToolKeys = readAutoCollapsedResponseActivityToolKeys(timelineRoot);
    autoCollapsedToolKeys.add(normalizedToolKey);
    writeAutoCollapsedResponseActivityToolKeys(timelineRoot, autoCollapsedToolKeys);

    const toolItem = findResponseActivityToolItemByKey(timelineRoot, normalizedToolKey);
    if (toolItem) {
      setResponseActivityToolExpandedState(toolItem, false);
      writeResponseActivityToolAutoCollapseDeadlineToItem(toolItem, null);
    }
    captureResponseActivityTransientUiState(messageWrapperDiv, timelineRoot);
    return true;
  }

  function getResponseActivityStoredUiState(messageWrapperDiv) {
    if (!messageWrapperDiv || typeof messageWrapperDiv !== 'object') return null;
    return responseActivityUiStateByMessage.get(messageWrapperDiv) || null;
  }

  function captureResponseActivityToolTransientUiState(toolItem) {
    if (!toolItem) return null;
    return {
      isExpanded: toolItem.classList.contains('is-expanded'),
      argumentsExpanded: toolItem.querySelector('.response-activity-tool-arguments')?.classList?.contains('is-fully-expanded') === true,
      argumentsScrollTop: Number(toolItem.querySelector('.response-activity-tool-arguments')?.scrollTop || 0),
      codeExpanded: toolItem.querySelector('.response-activity-tool-code')?.classList?.contains('is-fully-expanded') === true,
      codeScrollTop: Number(toolItem.querySelector('.response-activity-tool-code')?.scrollTop || 0),
      outputExpanded: toolItem.querySelector('.response-activity-tool-output')?.classList?.contains('is-fully-expanded') === true,
      outputScrollTop: Number(toolItem.querySelector('.response-activity-tool-output')?.scrollTop || 0),
      sourcesOpen: Array.from(toolItem.querySelectorAll('.response-activity-tool-sources')).some((detailsEl) => detailsEl?.open === true)
    };
  }

  function captureResponseActivityTransientUiState(messageWrapperDiv, timelineRoot = null) {
    const root = timelineRoot || messageWrapperDiv?.querySelector?.('.response-activity-timeline');
    if (!messageWrapperDiv || !root) return null;

    const nextState = {
      panelManualState: String(root.dataset?.panelManualState || '').trim(),
      panelExpanded: String(root.dataset?.panelExpanded || '').trim(),
      panelPeek: String(root.dataset?.panelPeek || '').trim(),
      panelAutoLifecycleInitialized: String(root.dataset?.panelAutoLifecycleInitialized || '').trim(),
      panelAutoCollapsedAfterFinish: String(
        root.dataset?.panelAutoCollapsedAfterFinish
        || root.dataset?.panelAutoCollapsedAfterAnswerStart
        || ''
      ).trim(),
      manualExpandedToolKeys: Array.from(readManuallyExpandedResponseActivityToolKeys(root)),
      manualCollapsedToolKeys: Array.from(readManuallyCollapsedResponseActivityToolKeys(root)),
      autoCollapsedToolKeys: Array.from(readAutoCollapsedResponseActivityToolKeys(root)),
      toolUiByKey: {}
    };

    root.querySelectorAll('.response-activity-entry--tool').forEach((item) => {
      const toolKey = String(item?.dataset?.responseActivityToolKey || '').trim();
      if (!toolKey) return;
      const toolState = captureResponseActivityToolTransientUiState(item);
      nextState.toolUiByKey[toolKey] = toolState;
    });

    responseActivityUiStateByMessage.set(messageWrapperDiv, nextState);
    return nextState;
  }

  function clearResponseActivityUiState(messageWrapperDiv) {
    if (!messageWrapperDiv || typeof messageWrapperDiv !== 'object') return;
    clearAllResponseActivityToolAutoCollapseSchedules(messageWrapperDiv);
    responseActivityUiStateByMessage.delete(messageWrapperDiv);
  }

  function isScrollableElementNearBottom(element, threshold = 24) {
    if (!element) return true;
    const distance = Math.max(0, (element.scrollHeight || 0) - (element.scrollTop || 0) - (element.clientHeight || 0));
    return distance <= threshold;
  }

  function scrollScrollableElementToBottom(element) {
    if (!element) return;
    element.scrollTop = Math.max(0, element.scrollHeight || 0);
  }

  function resolveResponseActivityAutoCollapseOwner(messageWrapperDiv, messageId = null) {
    const normalizedMessageId = normalizeMessageId(
      messageId
      || messageWrapperDiv?.getAttribute?.('data-message-id')
      || ''
    );
    if (normalizedMessageId) {
      return {
        kind: 'messageId',
        key: normalizedMessageId,
        messageId: normalizedMessageId
      };
    }
    if (!messageWrapperDiv || typeof messageWrapperDiv !== 'object') return null;
    return {
      kind: 'element',
      key: messageWrapperDiv,
      messageId: ''
    };
  }

  function getResponseActivityAutoCollapseScheduleContext(messageWrapperDiv, create = false, options = {}) {
    const owner = resolveResponseActivityAutoCollapseOwner(messageWrapperDiv, options?.messageId || null);
    if (!owner) return { owner: null, scheduleMap: null };
    let scheduleMap = owner.kind === 'messageId'
      ? (responseActivityAutoCollapseTimersByMessageId.get(owner.key) || null)
      : (responseActivityAutoCollapseTimersByMessage.get(owner.key) || null);
    if (!scheduleMap && create) {
      scheduleMap = new Map();
      if (owner.kind === 'messageId') {
        responseActivityAutoCollapseTimersByMessageId.set(owner.key, scheduleMap);
      } else {
        responseActivityAutoCollapseTimersByMessage.set(owner.key, scheduleMap);
      }
    }
    return { owner, scheduleMap };
  }

  function deleteResponseActivityAutoCollapseScheduleOwner(owner) {
    if (!owner) return;
    if (owner.kind === 'messageId') {
      responseActivityAutoCollapseTimersByMessageId.delete(owner.key);
      return;
    }
    responseActivityAutoCollapseTimersByMessage.delete(owner.key);
  }

  function readResponseActivityToolAutoCollapseDeadline(messageWrapperDiv, toolKey, options = {}) {
    const normalizedToolKey = String(toolKey || '').trim();
    if (!normalizedToolKey) return null;
    const { scheduleMap } = getResponseActivityAutoCollapseScheduleContext(messageWrapperDiv, false, options);
    const record = scheduleMap?.get(normalizedToolKey) || null;
    const deadlineAtMs = Number(record?.deadlineAtMs);
    return Number.isFinite(deadlineAtMs) && deadlineAtMs >= 0 ? deadlineAtMs : null;
  }

  function clearResponseActivityToolAutoCollapseSchedule(messageWrapperDiv, toolKey, options = {}) {
    const normalizedToolKey = String(toolKey || '').trim();
    if (!normalizedToolKey) return;
    const { owner, scheduleMap } = getResponseActivityAutoCollapseScheduleContext(messageWrapperDiv, false, options);
    if (!scheduleMap) return;
    const record = scheduleMap.get(normalizedToolKey) || null;
    const timerId = Number(record?.timerId);
    if (Number.isFinite(timerId) && timerId > 0) {
      try { clearTimeout(timerId); } catch (_) {}
    }
    scheduleMap.delete(normalizedToolKey);
    if (scheduleMap.size <= 0) {
      deleteResponseActivityAutoCollapseScheduleOwner(owner);
    }
  }

  function clearAllResponseActivityToolAutoCollapseSchedules(messageWrapperDiv, options = {}) {
    const { owner, scheduleMap } = getResponseActivityAutoCollapseScheduleContext(messageWrapperDiv, false, options);
    if (!scheduleMap) return;
    scheduleMap.forEach((record) => {
      const timerId = Number(record?.timerId);
      if (Number.isFinite(timerId) && timerId > 0) {
        try { clearTimeout(timerId); } catch (_) {}
      }
    });
    scheduleMap.clear();
    deleteResponseActivityAutoCollapseScheduleOwner(owner);
  }

  function scheduleResponseActivityToolAutoCollapse(messageWrapperDiv, toolKey, deadlineAtMs, options = {}) {
    const normalizedToolKey = String(toolKey || '').trim();
    const normalizedDeadlineAtMs = Number(deadlineAtMs);
    if (!messageWrapperDiv || !normalizedToolKey || !Number.isFinite(normalizedDeadlineAtMs) || normalizedDeadlineAtMs < 0) {
      return;
    }

    const { owner, scheduleMap } = getResponseActivityAutoCollapseScheduleContext(messageWrapperDiv, true, options);
    if (!owner || !scheduleMap) return;
    const ownerMessageId = owner.messageId || '';
    const existingRecord = scheduleMap?.get(normalizedToolKey) || null;
    if (existingRecord?.deadlineAtMs === normalizedDeadlineAtMs && Number(existingRecord?.timerId) > 0) {
      return;
    }
    clearResponseActivityToolAutoCollapseSchedule(messageWrapperDiv, normalizedToolKey, {
      messageId: ownerMessageId
    });

    const delayMs = Math.max(0, normalizedDeadlineAtMs - Date.now());
    const timerId = setTimeout(() => {
      const liveMessageWrapperDiv = resolveLiveMessageElement(ownerMessageId, messageWrapperDiv);
      const liveTimelineRoot = liveMessageWrapperDiv?.querySelector?.('.response-activity-timeline') || null;
      const liveToolItem = findResponseActivityToolItemByKey(liveTimelineRoot, normalizedToolKey);
      const liveDomDeadlineAtMs = readResponseActivityToolAutoCollapseDeadlineFromItem(liveToolItem);
      const { scheduleMap: liveScheduleMap } = getResponseActivityAutoCollapseScheduleContext(
        messageWrapperDiv,
        false,
        { messageId: ownerMessageId }
      );
      const liveRecord = liveScheduleMap?.get(normalizedToolKey) || null;
      const liveRecordDeadlineAtMs = Number(liveRecord?.deadlineAtMs);
      const hasMatchingLiveRecord = Number.isFinite(liveRecordDeadlineAtMs)
        && liveRecordDeadlineAtMs === normalizedDeadlineAtMs;
      const hasMatchingLiveDomDeadline = Number.isFinite(liveDomDeadlineAtMs)
        && liveDomDeadlineAtMs === normalizedDeadlineAtMs;
      if (!hasMatchingLiveRecord && !hasMatchingLiveDomDeadline) return;

      if (liveScheduleMap) {
        liveScheduleMap.set(normalizedToolKey, {
          deadlineAtMs: normalizedDeadlineAtMs,
          timerId: null
        });
      }
      if (!liveMessageWrapperDiv) {
        return;
      }

      markResponseActivityToolAutoCollapsedInDom(liveMessageWrapperDiv, normalizedToolKey);

      const messageId = normalizeMessageId(
        ownerMessageId
        || liveMessageWrapperDiv.getAttribute?.('data-message-id')
        || ''
      );
      if (!messageId) return;
      syncAssistantMessageMetadata(messageId, null, {
        fallbackElement: liveMessageWrapperDiv
      });
    }, delayMs);

    scheduleMap.set(normalizedToolKey, {
      deadlineAtMs: normalizedDeadlineAtMs,
      timerId
    });
  }

  function restoreResponseActivityDatasetState(messageWrapperDiv, timelineRoot) {
    const stored = getResponseActivityStoredUiState(messageWrapperDiv);
    if (!stored || !timelineRoot?.dataset) return stored;

    if (!String(timelineRoot.dataset.panelManualState || '').trim() && stored.panelManualState) {
      timelineRoot.dataset.panelManualState = stored.panelManualState;
    }
    if (!String(timelineRoot.dataset.panelExpanded || '').trim() && stored.panelExpanded) {
      timelineRoot.dataset.panelExpanded = stored.panelExpanded;
    }
    if (!String(timelineRoot.dataset.panelPeek || '').trim() && stored.panelPeek) {
      timelineRoot.dataset.panelPeek = stored.panelPeek;
    }
    if (!String(timelineRoot.dataset.panelAutoLifecycleInitialized || '').trim() && stored.panelAutoLifecycleInitialized) {
      timelineRoot.dataset.panelAutoLifecycleInitialized = stored.panelAutoLifecycleInitialized;
    }
    if (!String(timelineRoot.dataset.panelAutoCollapsedAfterFinish || '').trim() && stored.panelAutoCollapsedAfterFinish) {
      timelineRoot.dataset.panelAutoCollapsedAfterFinish = stored.panelAutoCollapsedAfterFinish;
    }
    if (readManuallyExpandedResponseActivityToolKeys(timelineRoot).size <= 0 && stored.manualExpandedToolKeys.length > 0) {
      writeManuallyExpandedResponseActivityToolKeys(timelineRoot, new Set(stored.manualExpandedToolKeys));
    }
    if (readManuallyCollapsedResponseActivityToolKeys(timelineRoot).size <= 0 && stored.manualCollapsedToolKeys.length > 0) {
      writeManuallyCollapsedResponseActivityToolKeys(timelineRoot, new Set(stored.manualCollapsedToolKeys));
    }
    if (readAutoCollapsedResponseActivityToolKeys(timelineRoot).size <= 0 && stored.autoCollapsedToolKeys.length > 0) {
      writeAutoCollapsedResponseActivityToolKeys(timelineRoot, new Set(stored.autoCollapsedToolKeys));
    }
    return stored;
  }

  function restoreResponseActivityToolTransientUiState(toolItem, toolState) {
    if (!toolItem || !toolState || typeof toolState !== 'object') return;

    const argumentsBlock = toolItem.querySelector('.response-activity-tool-arguments');
    if (argumentsBlock && toolState.argumentsExpanded === true) {
      argumentsBlock.classList.add('is-fully-expanded');
    }
    if (argumentsBlock && Number.isFinite(toolState.argumentsScrollTop) && toolState.argumentsScrollTop > 0) {
      argumentsBlock.scrollTop = toolState.argumentsScrollTop;
    }

    const codeBlock = toolItem.querySelector('.response-activity-tool-code');
    if (codeBlock && toolState.codeExpanded === true) {
      codeBlock.classList.add('is-fully-expanded');
    }
    if (codeBlock && Number.isFinite(toolState.codeScrollTop) && toolState.codeScrollTop > 0) {
      codeBlock.scrollTop = toolState.codeScrollTop;
    }

    const outputBlock = toolItem.querySelector('.response-activity-tool-output');
    if (outputBlock && toolState.outputExpanded === true) {
      outputBlock.classList.add('is-fully-expanded');
    }
    if (outputBlock && Number.isFinite(toolState.outputScrollTop) && toolState.outputScrollTop > 0) {
      outputBlock.scrollTop = toolState.outputScrollTop;
    }

    if (toolState.sourcesOpen === true) {
      toolItem.querySelectorAll('.response-activity-tool-sources').forEach((detailsEl) => {
        detailsEl.open = true;
      });
    }
  }

  function setupResponseActivityExpandableTextBlock(block) {
    if (!block || block.dataset?.expandableBound === 'true') return;
    block.dataset.expandableBound = 'true';
    block.tabIndex = 0;
    block.title = '点击展开/收起完整内容';
    block.classList.add('response-activity-tool-text-block');

    const toggleExpanded = () => {
      runWithStableToggleScroll(block, () => {
        block.classList.toggle('is-fully-expanded');
      });
    };

    block.addEventListener('click', () => {
      toggleExpanded();
    });
    block.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggleExpanded();
    });
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

  function buildResponseActivityToolEntrySnapshot(entry, index, isThinkingRuntimeActive) {
    const key = getResponseActivityEntrySnapshotKey(entry, index);
    const renderSearchQueriesInline = isResponseActivitySearchQueryEntry(entry);
    const searchQueryLines = renderSearchQueriesInline ? getResponseActivityToolQueryLines(entry) : [];
    const hasDetails = hasResponseActivityToolDetails(entry);
    const isInProgress = isThinkingRuntimeActive && isResponseActivityEntryInProgress(entry);
    const hasOutput = hasResponsesToolOutputBody(entry?.output);
    const shouldAutoRemainExpanded = isInProgress || (!hasOutput && isThinkingRuntimeActive);
    const primaryParts = renderSearchQueriesInline
      ? null
      : buildResponseToolCallPrimaryParts(entry, { isInProgress });
    const secondaryLines = getResponseActivityToolSecondaryLines(entry);
    const argumentsText = (typeof entry.arguments === 'string' && entry.arguments.trim())
      ? formatResponseToolCallArguments(entry.arguments)
      : '';
    const outputText = formatResponseToolCallOutput(entry.output) || '';
    const outputImages = extractResponseToolCallOutputImages(entry.output);
    const prefersInlineImagePreview = shouldPreferResponseActivityToolInlineImagePreview(entry, outputImages);
    const statusLabel = getResponseActivityStatusLabel(entry.status);
    const jsMeta = isResponseActivityJsRuntimeEntry(entry) ? getResponseActivityJsRuntimeMeta(entry) : null;
    const normalizedSources = Array.isArray(entry.sources)
      ? entry.sources.map((source) => ({
        title: source?.title || '',
        domain: source?.domain || '',
        url: source?.url || ''
      }))
      : [];

    return {
      key,
      entryKind: 'tool',
      entry,
      hasDetails,
      isInProgress,
      hasOutput,
      shouldAutoRemainExpanded,
      prefersInlineImagePreview,
      preferCollapsedPreview: prefersInlineImagePreview && !isInProgress,
      renderSearchQueriesInline,
      searchQueryLines,
      primaryParts,
      secondaryLines,
      argumentsText,
      outputText,
      outputImages,
      statusLabel,
      jsMeta,
      sources: normalizedSources,
      summarySignature: JSON.stringify({
        renderSearchQueriesInline,
        searchQueryLines,
        primaryParts,
        statusLabel,
        hasDetails,
        prefersInlineImagePreview
      }),
      bodySignature: JSON.stringify({
        prefersInlineImagePreview,
        secondaryLines,
        argumentsText,
        outputText,
        outputImageSignatures: outputImages.map((image) => image.signature),
        sources: normalizedSources,
        jsMeta
      }),
      inlinePreviewSignature: JSON.stringify({
        prefersInlineImagePreview,
        outputImageSignatures: outputImages.map((image) => image.signature)
      })
    };
  }

  function buildResponseActivityEntrySnapshot(entry, index, processMathAndMarkdownFn, isThinkingRuntimeActive) {
    const key = getResponseActivityEntrySnapshotKey(entry, index);
    if (entry.kind === 'reasoning_summary' || entry.kind === 'commentary' || entry.kind === 'steer') {
      const rawText = (typeof entry.text === 'string') ? entry.text : '';
      const normalizedText = entry.kind === 'reasoning_summary'
        ? normalizeResponsesReasoningText(rawText)
        : rawText.trim();
      const renderedHtml = processMathAndMarkdownFn(normalizedText);
      return {
        key,
        entryKind: 'narrative',
        narrativeKind: entry.kind,
        narrativeStatus: String(entry?.status || '').trim().toLowerCase(),
        narrativeCount: Number.isFinite(Number(entry?.count))
          ? Math.max(0, Math.floor(Number(entry.count)))
          : 0,
        markdown: buildMarkdownSurfaceSnapshot(normalizedText, renderedHtml),
        signature: JSON.stringify({
          renderedHtml,
          narrativeKind: entry.kind,
          narrativeStatus: String(entry?.status || '').trim().toLowerCase(),
          narrativeCount: Number.isFinite(Number(entry?.count))
            ? Math.max(0, Math.floor(Number(entry.count)))
            : 0
        })
      };
    }
    return buildResponseActivityToolEntrySnapshot(entry, index, isThinkingRuntimeActive);
  }

  function getResponseActivitySteerStatusLabel(snapshot) {
    const status = String(snapshot?.narrativeStatus || '').trim().toLowerCase();
    if (status === 'completed' || status === 'accepted') return '已并入当前轮';
    if (status === 'queued') return '未吸收，已转为队列';
    if (status === 'paused') return '未吸收，已暂停';
    return '待提交到当前轮';
  }

  function buildResponseActivitySnapshot(node, timeline, processMathAndMarkdownFn, isThinkingRuntimeActive) {
    const panelSummary = buildResponseActivityPanelSummary(node, timeline, {
      isThinkingInProgress: isThinkingRuntimeActive
    });
    const entries = timeline.map((entry, index) => buildResponseActivityEntrySnapshot(
      entry,
      index,
      processMathAndMarkdownFn,
      isThinkingRuntimeActive
    ));
    const entryByKey = {};
    entries.forEach((entrySnapshot) => {
      entryByKey[entrySnapshot.key] = entrySnapshot;
    });
    return {
      panelSummary,
      entries,
      entryByKey
    };
  }

  function setResponseActivityPanelExpandedState(timelineRoot, expanded) {
    if (!(timelineRoot instanceof HTMLElement)) return;
    const nextExpanded = expanded === true;
    const isInProgress = timelineRoot.classList.contains('is-streaming');
    const panelToggle = timelineRoot.querySelector(':scope > .response-activity-panel-toggle');
    timelineRoot.dataset.panelManualState = nextExpanded ? 'expanded' : 'collapsed';
    timelineRoot.dataset.panelExpanded = nextExpanded ? 'true' : 'false';
    timelineRoot.classList.toggle('is-expanded', nextExpanded);
    const nextPeek = isInProgress && !nextExpanded;
    timelineRoot.dataset.panelPeek = nextPeek ? 'true' : 'false';
    timelineRoot.classList.toggle('is-peek', nextPeek);
    panelToggle?.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
  }

  function ensureResponseActivityPanelShell(messageWrapperDiv) {
    let timelineRoot = messageWrapperDiv.querySelector('.response-activity-timeline');
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

    let panelToggle = timelineRoot.querySelector(':scope > .response-activity-panel-toggle');
    if (!panelToggle) {
      panelToggle = document.createElement('button');
      panelToggle.className = 'response-activity-panel-toggle';
      panelToggle.setAttribute('type', 'button');
      timelineRoot.appendChild(panelToggle);
    }

    let panelCopy = panelToggle.querySelector(':scope > .response-activity-panel-copy');
    if (!panelCopy) {
      panelCopy = document.createElement('span');
      panelCopy.className = 'response-activity-panel-copy';
      panelToggle.appendChild(panelCopy);
    }

    let panelTitle = panelCopy.querySelector(':scope > .response-activity-panel-title');
    if (!panelTitle) {
      panelTitle = document.createElement('span');
      panelTitle.className = 'response-activity-panel-title';
      panelCopy.appendChild(panelTitle);
    }

    let panelMeta = panelCopy.querySelector(':scope > .response-activity-panel-meta');
    let panelChevron = panelToggle.querySelector(':scope > .response-activity-panel-chevron');
    if (!panelChevron) {
      panelChevron = document.createElement('i');
      panelChevron.className = 'fa-solid fa-chevron-right response-activity-panel-chevron';
      panelToggle.appendChild(panelChevron);
    }

    if (!panelToggle.dataset.listenerAdded) {
      panelToggle.addEventListener('click', () => {
        runWithStableToggleScroll(timelineRoot, () => {
          const nextExpanded = timelineRoot.dataset.panelExpanded !== 'true';
          setResponseActivityPanelExpandedState(timelineRoot, nextExpanded);
        });
      });
      panelToggle.dataset.listenerAdded = 'true';
    }

    let panelBody = timelineRoot.querySelector(':scope > .response-activity-panel-body');
    if (!panelBody) {
      panelBody = document.createElement('div');
      panelBody.className = 'response-activity-panel-body';
      timelineRoot.appendChild(panelBody);
    }

    let panelBodyInner = panelBody.querySelector(':scope > .response-activity-panel-body-inner');
    if (!panelBodyInner) {
      panelBodyInner = document.createElement('div');
      panelBodyInner.className = 'response-activity-panel-body-inner';
      panelBody.appendChild(panelBodyInner);
    }

    let panelStatus = timelineRoot.querySelector(':scope > .response-activity-panel-status');

    return {
      timelineRoot,
      panelToggle,
      panelCopy,
      panelTitle,
      panelMeta,
      panelChevron,
      panelBody,
      panelBodyInner,
      panelStatus
    };
  }

  function ensureResponseActivityPanelStatusSurface(timelineRoot) {
    if (!timelineRoot) return null;
    let surface = timelineRoot.querySelector(':scope > .response-activity-panel-status');
    if (surface) return surface;

    surface = document.createElement('div');
    surface.className = 'response-activity-panel-status';

    const spinner = document.createElement('span');
    spinner.className = 'response-activity-panel-status__spinner';
    spinner.setAttribute('aria-hidden', 'true');
    surface.appendChild(spinner);

    const text = document.createElement('span');
    text.className = 'response-activity-panel-status__text';
    surface.appendChild(text);

    if (!surface.dataset.listenerAdded) {
      const collapsePanelFromStatusSurface = (event) => {
        if (surface.dataset.collapsible !== 'true') return;
        const timelineRoot = surface.closest('.response-activity-timeline');
        if (!(timelineRoot instanceof HTMLElement) || timelineRoot.dataset.panelExpanded !== 'true') return;
        event.preventDefault();
        event.stopPropagation();
        runWithStableToggleScroll(timelineRoot, () => {
          setResponseActivityPanelExpandedState(timelineRoot, false);
        });
      };
      surface.addEventListener('click', collapsePanelFromStatusSurface);
      surface.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        collapsePanelFromStatusSurface(event);
      });
      surface.dataset.listenerAdded = 'true';
    }

    timelineRoot.appendChild(surface);
    return surface;
  }

  function syncResponseActivityPanelStatus(shell, messageId, messageWrapperDiv, runtimeSnapshot, isThinkingRuntimeActive, panelSummary = null) {
    if (!shell?.timelineRoot || !messageWrapperDiv) return false;
    const runtimeStatus = String(runtimeSnapshot?.activeTurn?.status || '').trim().toLowerCase();
    const activeStatus = (isThinkingRuntimeActive && runtimeStatus && !['idle', 'completed', 'aborted', 'error'].includes(runtimeStatus))
      ? normalizeAssistantPreResponseStatus(runtimeSnapshot?.activeTurn?.preResponseStatus || null)
      : null;
    const status = resolveResponseActivityPanelStatusState({
      activeStatus,
      completedDurationLabel: panelSummary?.durationLabel || ''
    });
    const existingSurface = shell.panelStatus
      || shell.timelineRoot.querySelector(':scope > .response-activity-panel-status');

    if (!status) {
      existingSurface?.remove?.();
      shell.panelStatus = null;
      return false;
    }

    const surface = existingSurface || ensureResponseActivityPanelStatusSurface(shell.timelineRoot);
    if (!surface) return false;
    shell.panelStatus = surface;
    const textElement = surface.querySelector('.response-activity-panel-status__text');
    if (textElement) {
      textElement.textContent = status.text;
    } else {
      surface.textContent = status.text;
    }
    surface.classList.toggle('response-activity-panel-status--spinnerless', status.showSpinner === false);
    surface.classList.toggle('is-collapsible', status.collapsible === true);
    surface.setAttribute('data-stage', status.stage || '');
    surface.setAttribute('data-note', status.note || '');
    surface.dataset.collapsible = status.collapsible === true ? 'true' : 'false';
    if (status.collapsible === true) {
      surface.setAttribute('role', 'button');
      surface.tabIndex = 0;
      surface.setAttribute('aria-label', '收起思考记录');
      surface.title = '点击收起思考记录';
    } else {
      surface.removeAttribute('role');
      surface.removeAttribute('tabindex');
      surface.removeAttribute('aria-label');
      surface.removeAttribute('title');
    }
    return true;
  }

  function reconcileResponseActivityPanelHeader(shell, panelSummary, options = {}) {
    const {
      timelineRoot,
      panelToggle,
      panelCopy,
      panelTitle,
      panelChevron
    } = shell;
    const panelManualState = String(timelineRoot.dataset.panelManualState || '').trim().toLowerCase();
    const panelModeState = resolveResponseActivityPanelModeState({
      manualState: panelManualState,
      lifecycleInitialized: timelineRoot.dataset.panelAutoLifecycleInitialized === 'true',
      autoCollapsedAfterFinish:
        timelineRoot.dataset.panelAutoCollapsedAfterFinish === 'true'
        || timelineRoot.dataset.panelAutoCollapsedAfterAnswerStart === 'true',
      isInProgress: panelSummary.isInProgress
    });
    let panelExpanded = panelModeState.expanded;
    const panelPeek = panelModeState.peek;
    timelineRoot.dataset.panelAutoLifecycleInitialized = panelModeState.lifecycleInitialized ? 'true' : 'false';
    if (panelModeState.autoCollapsedAfterFinish) {
      timelineRoot.dataset.panelAutoCollapsedAfterFinish = 'true';
    } else {
      delete timelineRoot.dataset.panelAutoCollapsedAfterFinish;
    }
    if (panelModeState.clearManualState) {
      delete timelineRoot.dataset.panelManualState;
    }
    delete timelineRoot.dataset.panelAutoCollapsedAfterAnswerStart;

    const applyPanelExpandedState = () => {
      timelineRoot.dataset.panelExpanded = panelExpanded ? 'true' : 'false';
      timelineRoot.dataset.panelPeek = panelPeek ? 'true' : 'false';
      timelineRoot.classList.toggle('is-expanded', panelExpanded);
      timelineRoot.classList.toggle('is-peek', panelPeek);
      timelineRoot.classList.toggle('is-streaming', !!panelSummary.isInProgress);
      panelToggle.setAttribute('aria-expanded', panelExpanded ? 'true' : 'false');
    };
    // 这里只同步自动生命周期状态，不介入外层聊天容器的滚动补偿。
    // 用户手动点击标题栏时，点击处理器已经单独做了稳定锚点保护；
    // 自动的 peek / collapse 变化若再去改外层 scrollTop，会把整条消息带着漂移。
    applyPanelExpandedState();

    if (panelTitle.textContent !== panelSummary.title) {
      panelTitle.textContent = panelSummary.title;
    }

    let panelMeta = shell.panelMeta;
    if (panelSummary.metaText) {
      if (!panelMeta) {
        panelMeta = document.createElement('span');
        panelMeta.className = 'response-activity-panel-meta';
        panelCopy.appendChild(panelMeta);
        shell.panelMeta = panelMeta;
      }
      if (panelMeta.textContent !== panelSummary.metaText) {
        panelMeta.textContent = panelSummary.metaText;
      }
    } else if (panelMeta) {
      panelMeta.remove();
      shell.panelMeta = null;
    }

    if (!panelChevron.parentNode) {
      panelToggle.appendChild(panelChevron);
    }

    return {
      expanded: panelExpanded,
      peek: panelPeek
    };
  }

  function renderResponseActivityToolSummaryChildren(summary, snapshot) {
    const children = [];

    const kind = document.createElement('span');
    kind.className = 'response-activity-tool-kind';
    kind.textContent = getResponseToolCallTypeLabel(snapshot.entry);
    children.push(kind);

    if (snapshot.renderSearchQueriesInline) {
      const queryStack = document.createElement('span');
      queryStack.className = 'response-activity-tool-query-stack';
      snapshot.searchQueryLines.forEach((query) => {
        const queryLine = document.createElement('span');
        queryLine.className = 'response-activity-tool-query-line';
        queryLine.textContent = query;
        queryStack.appendChild(queryLine);
      });
      children.push(queryStack);
    } else {
      const primary = document.createElement('span');
      primary.className = 'response-activity-tool-primary';
      const primaryParts = snapshot.primaryParts || {};

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

      if (primaryParts.meta) {
        const meta = document.createElement('span');
        meta.className = 'response-activity-tool-meta';
        meta.textContent = primaryParts.meta;
        primary.appendChild(meta);
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

      children.push(primary);
    }

    if (snapshot.hasDetails) {
      const toggleIndicator = document.createElement('span');
      toggleIndicator.className = 'response-activity-tool-toggle-indicator';
      if (snapshot.prefersInlineImagePreview) {
        const toggleLabel = document.createElement('span');
        toggleLabel.className = 'response-activity-tool-toggle-label';
        toggleLabel.textContent = snapshot.expanded ? '收起详情' : '详情';
        toggleIndicator.appendChild(toggleLabel);
      }
      const chevron = document.createElement('i');
      chevron.className = 'fa-solid fa-chevron-right response-activity-tool-chevron';
      toggleIndicator.appendChild(chevron);
      children.push(toggleIndicator);
    }

    summary.replaceChildren(...children);
  }

  function ensureResponseActivityToolSummary(item, snapshot, timelineRoot) {
    const expectedTag = snapshot.hasDetails ? 'BUTTON' : 'DIV';
    let summary = item.querySelector(':scope > .response-activity-tool-summary');
    if (!summary || summary.tagName !== expectedTag) {
      if (summary) summary.remove();
      summary = document.createElement(snapshot.hasDetails ? 'button' : 'div');
      summary.className = 'response-activity-tool-summary';
      if (snapshot.renderSearchQueriesInline) {
        summary.classList.add('response-activity-tool-summary--query-stack');
      }
      if (snapshot.hasDetails) {
        summary.setAttribute('type', 'button');
        summary.addEventListener('click', () => {
          runWithStableToggleScroll(item, () => {
            const toolKey = String(item.dataset.responseActivityToolKey || '').trim();
            if (!toolKey) return;
            const messageWrapperDiv = item.closest('.message');
            const nextManualExpandedKeys = readManuallyExpandedResponseActivityToolKeys(timelineRoot);
            const nextManualCollapsedKeys = readManuallyCollapsedResponseActivityToolKeys(timelineRoot);
            const expanded = !item.classList.contains('is-expanded');
            clearResponseActivityToolAutoCollapseSchedule(messageWrapperDiv, toolKey);
            if (expanded) {
              nextManualExpandedKeys.add(toolKey);
              nextManualCollapsedKeys.delete(toolKey);
            } else {
              nextManualCollapsedKeys.add(toolKey);
              nextManualExpandedKeys.delete(toolKey);
            }
            writeManuallyExpandedResponseActivityToolKeys(timelineRoot, nextManualExpandedKeys);
            writeManuallyCollapsedResponseActivityToolKeys(timelineRoot, nextManualCollapsedKeys);
            setResponseActivityToolExpandedState(item, expanded);
          });
        });
      }
      item.insertBefore(summary, item.firstChild);
    }
    summary.classList.toggle('response-activity-tool-summary--query-stack', snapshot.renderSearchQueriesInline);
    if (snapshot.hasDetails) {
      summary.setAttribute('type', 'button');
    } else {
      summary.removeAttribute('type');
    }
    summary.setAttribute('aria-expanded', snapshot.expanded ? 'true' : 'false');
    return summary;
  }

  function renderResponseActivityToolBodyContent(toolBodyInner, snapshot) {
    const renderOptions = {
      suppressOutputImages: snapshot.prefersInlineImagePreview === true
    };
    if (isResponseActivityJsRuntimeEntry(snapshot.entry)) {
      renderResponseActivityJsRuntimeBody(toolBodyInner, snapshot.entry, snapshot, renderOptions);
      return;
    }
    renderResponseActivityGenericToolBody(toolBodyInner, snapshot.entry, snapshot, renderOptions);
  }

  function reconcileResponseActivityToolInlinePreview(item, snapshot, previousSnapshot, toolBody = null) {
    const shouldRenderPreview = snapshot.prefersInlineImagePreview === true
      && normalizeResponseActivityToolOutputImages(snapshot.outputImages).length > 0;
    let previewRoot = item.querySelector(':scope > .response-activity-tool-inline-preview');
    if (!shouldRenderPreview) {
      if (previewRoot) previewRoot.remove();
      return;
    }

    if (!previewRoot) {
      previewRoot = document.createElement('div');
      previewRoot.className = 'response-activity-tool-inline-preview';
    }

    const anchor = (toolBody && toolBody.parentNode === item) ? toolBody : null;
    if (previewRoot.parentNode !== item) {
      item.insertBefore(previewRoot, anchor);
    } else if (anchor && previewRoot.nextSibling !== anchor) {
      item.insertBefore(previewRoot, anchor);
    }

    if (!previousSnapshot || previousSnapshot.inlinePreviewSignature !== snapshot.inlinePreviewSignature) {
      previewRoot.replaceChildren();
      const imageList = buildResponseActivityToolImageList(snapshot.outputImages);
      if (imageList) {
        previewRoot.appendChild(imageList);
      }
    }
  }

  function reconcileResponseActivityNarrativeEntry(item, snapshot, previousSnapshot) {
    const isSteerEntry = snapshot.narrativeKind === 'steer';
    item.className = isSteerEntry
      ? 'response-activity-entry response-activity-entry--reasoning response-activity-entry--steer'
      : 'response-activity-entry response-activity-entry--reasoning';
    let summary = item.querySelector(':scope > .response-activity-entry-summary');
    if (isSteerEntry) {
      if (!summary) {
        summary = document.createElement('div');
        summary.className = 'response-activity-entry-summary response-activity-entry-summary--steer';
        item.insertBefore(summary, item.firstChild);
      }
      let label = summary.querySelector(':scope > .response-activity-entry-label');
      if (!label) {
        label = document.createElement('span');
        label.className = 'response-activity-entry-label response-activity-entry-label--steer';
        summary.appendChild(label);
      }
      let title = summary.querySelector(':scope > .response-activity-entry-title');
      if (!title) {
        title = document.createElement('span');
        title.className = 'response-activity-entry-title response-activity-entry-title--steer';
        summary.appendChild(title);
      }
      label.replaceChildren();
      const icon = document.createElement('i');
      icon.className = 'fa-solid fa-forward-step response-activity-entry-label-icon';
      icon.setAttribute('aria-hidden', 'true');
      label.appendChild(icon);
      const labelText = document.createElement('span');
      labelText.textContent = snapshot.narrativeCount > 1
        ? `转向 ×${snapshot.narrativeCount}`
        : '转向';
      label.appendChild(labelText);
      title.textContent = getResponseActivitySteerStatusLabel(snapshot);
    } else if (summary) {
      summary.remove();
    }
    let content = item.querySelector(':scope > .response-activity-content--reasoning');
    if (!content) {
      content = document.createElement('div');
      content.className = 'response-activity-content response-activity-content--reasoning';
      item.appendChild(content);
    }
    content.classList.toggle('response-activity-content--steer', isSteerEntry);

    reconcileRenderedSurfaceBlocks(
      content,
      snapshot.markdown,
      previousSnapshot?.markdown || {
        blockSignatures: buildRenderedSurfaceBlocksFromDom(content).map((block) => block.signature)
      },
      { afterInsert: (element) => enhanceMarkdownContent(element) }
    );
  }

  function reconcileResponseActivityToolEntry(item, snapshot, previousSnapshot, timelineRoot, preservedToolState) {
    item.className = 'response-activity-entry response-activity-entry--tool';
    item.dataset.responseActivityToolKey = snapshot.key;
    // 工具详情的自动展开/自动收起只改工具项自身状态。
    // 外层聊天滚动应只由“新 assistant 消息进入视口”驱动，
    // 不能被工具详情块的内部生命周期牵着走。

    const summary = ensureResponseActivityToolSummary(item, snapshot, timelineRoot);
    if (!previousSnapshot || previousSnapshot.summarySignature !== snapshot.summarySignature || previousSnapshot.hasDetails !== snapshot.hasDetails || previousSnapshot.expanded !== snapshot.expanded) {
      renderResponseActivityToolSummaryChildren(summary, snapshot);
    }

    let toolBody = item.querySelector(':scope > .response-activity-tool-body');
    reconcileResponseActivityToolInlinePreview(item, snapshot, previousSnapshot, toolBody);
    let toolBodyInner = toolBody?.querySelector(':scope > .response-activity-tool-body-inner') || null;
    if (!snapshot.hasDetails) {
      if (toolBody) toolBody.remove();
      return;
    }

    if (!toolBody) {
      toolBody = document.createElement('div');
      toolBody.className = 'response-activity-tool-body';
      toolBodyInner = document.createElement('div');
      toolBodyInner.className = 'response-activity-tool-body-inner';
      toolBody.appendChild(toolBodyInner);
      item.appendChild(toolBody);
    } else if (!toolBodyInner) {
      toolBodyInner = document.createElement('div');
      toolBodyInner.className = 'response-activity-tool-body-inner';
      toolBody.appendChild(toolBodyInner);
    }
    reconcileResponseActivityToolInlinePreview(item, snapshot, previousSnapshot, toolBody);
    setResponseActivityToolExpandedState(item, snapshot.expanded);

    if (!previousSnapshot || previousSnapshot.bodySignature !== snapshot.bodySignature || previousSnapshot.hasDetails !== snapshot.hasDetails) {
      const currentToolState = captureResponseActivityToolTransientUiState(item) || preservedToolState || null;
      toolBodyInner.replaceChildren();
      renderResponseActivityToolBodyContent(toolBodyInner, snapshot);
      enhanceMarkdownContent(item);
      if (currentToolState) {
        restoreResponseActivityToolTransientUiState(item, currentToolState);
      }
    } else if (preservedToolState) {
      restoreResponseActivityToolTransientUiState(item, preservedToolState);
    }
  }

  function removeResponseActivityTimelineDisplay(messageWrapperDiv, options = {}) {
    const timelineRoot = messageWrapperDiv?.querySelector?.('.response-activity-timeline');
    if (timelineRoot) {
      captureResponseActivityTransientUiState(messageWrapperDiv, timelineRoot);
      timelineRoot.remove();
    }
    if (options?.preserveAutoCollapseSchedules !== true) {
      clearAllResponseActivityToolAutoCollapseSchedules(messageWrapperDiv);
    }
    resetAssistantSurfaceSnapshot(messageWrapperDiv, 'responseActivity');
  }

  function setupResponseActivityTimelineDisplay(messageWrapperDiv, node, rawTimeline, processMathAndMarkdownFn, options = {}) {
    if (!messageWrapperDiv) return false;
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const timeline = Array.isArray(rawTimeline)
      ? rawTimeline.filter(entry => entry && typeof entry === 'object' && typeof entry.kind === 'string')
      : [];
    const surfaceSnapshots = getAssistantSurfaceSnapshots(messageWrapperDiv);
    let timelineRoot = messageWrapperDiv.querySelector('.response-activity-timeline');

    if (timeline.length === 0) {
      if (timelineRoot) timelineRoot.remove();
      clearAllResponseActivityToolAutoCollapseSchedules(messageWrapperDiv);
      surfaceSnapshots.responseActivity = null;
      return false;
    }

    const isThinkingRuntimeActive = isResponseActivityThinkingRuntimeActive(
      messageWrapperDiv,
      normalizedOptions.runtimeSnapshot || null,
      node
    );
    const nextSnapshot = buildResponseActivitySnapshot(node, timeline, processMathAndMarkdownFn, isThinkingRuntimeActive);
    const shell = ensureResponseActivityPanelShell(messageWrapperDiv);
    timelineRoot = shell.timelineRoot;
    const shouldStickPanelBodyToBottom = isThinkingRuntimeActive && isScrollableElementNearBottom(shell.panelBodyInner);
    const previousUiState = captureResponseActivityTransientUiState(messageWrapperDiv, timelineRoot);
    restoreResponseActivityDatasetState(messageWrapperDiv, timelineRoot);
    const panelMode = reconcileResponseActivityPanelHeader(shell, nextSnapshot.panelSummary);
    const resolvedMessageId = String(
      node?.id
      || messageWrapperDiv.getAttribute?.('data-message-id')
      || ''
    ).trim();

    const manualExpandedToolKeys = readManuallyExpandedResponseActivityToolKeys(timelineRoot);
    const manualCollapsedToolKeys = readManuallyCollapsedResponseActivityToolKeys(timelineRoot);
    const autoCollapsedToolKeys = readAutoCollapsedResponseActivityToolKeys(timelineRoot);
    const visibleToolKeys = new Set();
    nextSnapshot.entries.forEach((entrySnapshot) => {
      if (entrySnapshot.entryKind !== 'tool' || !entrySnapshot.hasDetails) return;
      visibleToolKeys.add(entrySnapshot.key);
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
        clearResponseActivityToolAutoCollapseSchedule(messageWrapperDiv, key);
        autoCollapsedToolKeys.delete(key);
      }
    });
    writeManuallyExpandedResponseActivityToolKeys(timelineRoot, manualExpandedToolKeys);
    writeManuallyCollapsedResponseActivityToolKeys(timelineRoot, manualCollapsedToolKeys);
    writeAutoCollapsedResponseActivityToolKeys(timelineRoot, autoCollapsedToolKeys);

    const panelBodyInner = shell.panelBodyInner;
    const existingItemsByKey = new Map(
      Array.from(panelBodyInner.querySelectorAll(':scope > .response-activity-entry'))
        .map((item) => [String(item.dataset.responseActivityEntryKey || '').trim(), item])
        .filter(([key]) => !!key)
    );
    const previousByKey = surfaceSnapshots.responseActivity?.entryByKey || {};
    const nextByKey = nextSnapshot.entryByKey || {};
    let cursor = panelBodyInner.firstChild;

    nextSnapshot.entries.forEach((entrySnapshot) => {
      const existingItem = existingItemsByKey.get(entrySnapshot.key) || null;
      if (entrySnapshot.entryKind === 'tool' && entrySnapshot.hasDetails) {
        const manualState = manualExpandedToolKeys.has(entrySnapshot.key)
          ? 'expanded'
          : (manualCollapsedToolKeys.has(entrySnapshot.key) ? 'collapsed' : '');
        const expansionState = resolveResponseActivityToolExpansionState({
          manualState,
          shouldAutoRemainExpanded: entrySnapshot.shouldAutoRemainExpanded,
          preferCollapsedPreview: entrySnapshot.preferCollapsedPreview,
          autoCollapsed: autoCollapsedToolKeys.has(entrySnapshot.key),
          pendingAutoCollapseDeadlineAtMs:
            readResponseActivityToolAutoCollapseDeadline(messageWrapperDiv, entrySnapshot.key)
            ?? readResponseActivityToolAutoCollapseDeadlineFromItem(existingItem)
        });

        entrySnapshot.expanded = expansionState.expanded;
        entrySnapshot.autoCollapseDeadlineAtMs = expansionState.pendingAutoCollapseDeadlineAtMs;
        if (expansionState.autoCollapsed) {
          autoCollapsedToolKeys.add(entrySnapshot.key);
        } else {
          autoCollapsedToolKeys.delete(entrySnapshot.key);
        }
        if (expansionState.pendingAutoCollapseDeadlineAtMs != null) {
          scheduleResponseActivityToolAutoCollapse(
            messageWrapperDiv,
            entrySnapshot.key,
            expansionState.pendingAutoCollapseDeadlineAtMs
          );
        } else {
          clearResponseActivityToolAutoCollapseSchedule(messageWrapperDiv, entrySnapshot.key);
        }
      } else {
        clearResponseActivityToolAutoCollapseSchedule(messageWrapperDiv, entrySnapshot.key);
        entrySnapshot.expanded = false;
      }

      let item = existingItem;
      if (!item) {
        item = document.createElement('div');
      }
      item.dataset.responseActivityEntryKey = entrySnapshot.key;
      if (item !== cursor) {
        panelBodyInner.insertBefore(item, cursor || null);
      }

      const previousEntrySnapshot = previousByKey[entrySnapshot.key] || null;
      if (entrySnapshot.entryKind === 'narrative') {
        reconcileResponseActivityNarrativeEntry(item, entrySnapshot, previousEntrySnapshot);
      } else {
        reconcileResponseActivityToolEntry(
          item,
          entrySnapshot,
          previousEntrySnapshot,
          timelineRoot,
          previousUiState?.toolUiByKey?.[entrySnapshot.key] || null
        );
      }

      if (entrySnapshot.entryKind === 'tool' && entrySnapshot.hasDetails) {
        writeResponseActivityToolAutoCollapseDeadlineToItem(item, entrySnapshot.autoCollapseDeadlineAtMs);
      } else {
        writeResponseActivityToolAutoCollapseDeadlineToItem(item, null);
      }

      cursor = item.nextSibling;
    });

    Array.from(panelBodyInner.querySelectorAll(':scope > .response-activity-entry')).forEach((item) => {
      const key = String(item.dataset.responseActivityEntryKey || '').trim();
      if (!key || nextByKey[key]) return;
      item.remove();
    });

    syncResponseActivityPanelStatus(
      shell,
      resolvedMessageId,
      messageWrapperDiv,
      normalizedOptions.runtimeSnapshot || null,
      isThinkingRuntimeActive,
      nextSnapshot.panelSummary
    );

    writeAutoCollapsedResponseActivityToolKeys(timelineRoot, autoCollapsedToolKeys);
    captureResponseActivityTransientUiState(messageWrapperDiv, timelineRoot);
    surfaceSnapshots.responseActivity = nextSnapshot;

    if (isThinkingRuntimeActive && (panelMode?.peek || shouldStickPanelBodyToBottom)) {
      requestAnimationFrame(() => {
        const livePanelBodyInner = shell.panelBodyInner;
        if (!livePanelBodyInner || !messageWrapperDiv.isConnected) return;
        if (!timelineRoot.classList.contains('is-streaming')) return;
        scrollScrollableElementToBottom(livePanelBodyInner);
      });
    }

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
  function buildLegacyToolCallSnapshot(record, index) {
    const key = getLegacyToolCallSnapshotKey(record, index);
    const normalizedRecord = (record && typeof record === 'object') ? record : {};
    return {
      key,
      record: normalizedRecord,
      signature: JSON.stringify({
        type: normalizedRecord.type || '',
        primary: buildResponseToolCallPrimaryText(normalizedRecord),
        status: normalizedRecord.status || '',
        arguments: normalizedRecord.arguments || '',
        url: normalizedRecord.url || '',
        queries: Array.isArray(normalizedRecord.queries) ? normalizedRecord.queries : [],
        sources: Array.isArray(normalizedRecord.sources) ? normalizedRecord.sources : []
      })
    };
  }

  function renderLegacyToolCallItemContent(item, snapshot) {
    if (!item || !snapshot) return;
    const record = snapshot.record || {};
    item.replaceChildren();

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
  }

  function setupResponseToolCallsDisplay(messageWrapperDiv, rawToolCalls) {
    if (!messageWrapperDiv) return;
    const surfaceSnapshots = getAssistantSurfaceSnapshots(messageWrapperDiv);
    let toolCallsRoot = messageWrapperDiv.querySelector('.response-tool-calls');
    const toolCalls = Array.isArray(rawToolCalls)
      ? rawToolCalls.filter(item => item && typeof item === 'object')
      : [];

    if (toolCalls.length === 0) {
      if (toolCallsRoot) toolCallsRoot.remove();
      surfaceSnapshots.legacyToolCalls = null;
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
    bindStableToggleDetails(toolCallsRoot, toolCallsRoot);

    let list = toolCallsRoot.querySelector('.response-tool-call-list');
    if (!list) {
      list = document.createElement('div');
      list.className = 'response-tool-call-list';
      toolCallsRoot.appendChild(list);
    }
    const previousSnapshot = surfaceSnapshots.legacyToolCalls || null;
    const previousByKey = previousSnapshot?.byKey || {};
    const existingItemsByKey = new Map(
      Array.from(list.querySelectorAll(':scope > .response-tool-call-item'))
        .map((item) => [String(item.dataset.responseToolCallKey || '').trim(), item])
        .filter(([key]) => !!key)
    );
    const nextSnapshots = toolCalls.map((record, index) => buildLegacyToolCallSnapshot(record, index));
    const nextByKey = {};

    nextSnapshots.forEach((snapshot) => {
      nextByKey[snapshot.key] = snapshot;
    });

    let cursor = list.firstChild;
    nextSnapshots.forEach((snapshot) => {
      let item = existingItemsByKey.get(snapshot.key) || null;
      if (!item) {
        item = document.createElement('div');
        item.className = 'response-tool-call-item';
        item.dataset.responseToolCallKey = snapshot.key;
      }
      if (item !== cursor) {
        list.insertBefore(item, cursor || null);
      } else {
        cursor = cursor?.nextSibling || null;
      }
      if (!previousByKey[snapshot.key] || previousByKey[snapshot.key].signature !== snapshot.signature) {
        renderLegacyToolCallItemContent(item, snapshot);
      }
      if (item === cursor) {
        cursor = cursor?.nextSibling || null;
      } else {
        cursor = item.nextSibling;
      }
    });

    Array.from(list.querySelectorAll(':scope > .response-tool-call-item')).forEach((item) => {
      const key = String(item.dataset.responseToolCallKey || '').trim();
      if (!key || nextByKey[key]) return;
      item.remove();
    });

    toolCallsRoot.open = previousOpen;
    surfaceSnapshots.legacyToolCalls = {
      byKey: nextByKey
    };
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
    const surfaceSnapshots = getAssistantSurfaceSnapshots(messageWrapperDiv);

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
    const footerInlineSeparator = settingsManager?.getSetting?.('aiFooterInlineSeparator');
    const footerTooltipTemplate = settingsManager?.getSetting?.('aiFooterTooltipTemplate');
    const renderData = buildApiFooterRenderData(nodeLike, {
      allConfigs,
      template: footerTemplate,
      inlineSeparator: footerInlineSeparator,
      tooltipTemplate: footerTooltipTemplate
    });
    const previousSnapshot = surfaceSnapshots.footer || null;
    if (!previousSnapshot || previousSnapshot.text !== renderData.text) {
      footer.textContent = renderData.text;
    }
    if (!previousSnapshot || previousSnapshot.title !== renderData.title) {
      footer.title = renderData.title;
    }
    surfaceSnapshots.footer = {
      text: renderData.text,
      title: renderData.title
    };
    return true;
  }

  function resolveAssistantPreResponseStatus(messageId, messageWrapperDiv, runtimeSnapshot) {
    const normalizedStatus = normalizeAssistantPreResponseStatus(runtimeSnapshot?.activeTurn?.preResponseStatus || null);
    if (!normalizedStatus || !messageWrapperDiv) return null;

    const runtimeStatus = String(runtimeSnapshot?.activeTurn?.status || '').trim().toLowerCase();
    if (!runtimeStatus || ['idle', 'completed', 'aborted', 'error'].includes(runtimeStatus)) {
      return null;
    }

    const boundAssistantMessageId = String(runtimeSnapshot?.activeTurn?.boundAssistantMessageId || '').trim();
    const normalizedMessageId = String(
      messageId
      || messageWrapperDiv.getAttribute?.('data-message-id')
      || ''
    ).trim();

    if (boundAssistantMessageId) {
      return boundAssistantMessageId === normalizedMessageId ? normalizedStatus : null;
    }

    if (
      messageWrapperDiv.classList.contains('loading-message')
      || messageWrapperDiv.classList.contains('updating')
    ) {
      return normalizedStatus;
    }

    return null;
  }

  function ensureAssistantPreResponseStatusSurface(messageWrapperDiv) {
    if (!messageWrapperDiv) return null;
    let surface = messageWrapperDiv.querySelector('.assistant-pre-response-status');
    if (surface) return surface;

    surface = document.createElement('div');
    surface.className = 'assistant-pre-response-status';

    const spinner = document.createElement('span');
    spinner.className = 'assistant-pre-response-status__spinner';
    spinner.setAttribute('aria-hidden', 'true');
    surface.appendChild(spinner);

    const text = document.createElement('span');
    text.className = 'assistant-pre-response-status__text';
    surface.appendChild(text);

    const anchor = messageWrapperDiv.firstElementChild || null;
    if (anchor) {
      messageWrapperDiv.insertBefore(surface, anchor);
    } else {
      messageWrapperDiv.appendChild(surface);
    }
    return surface;
  }

  function syncAssistantPreResponseStatus(messageId, messageWrapperDiv, runtimeSnapshot) {
    if (!messageWrapperDiv) return false;
    const status = resolveAssistantPreResponseStatus(messageId, messageWrapperDiv, runtimeSnapshot);
    if (!status) {
      removeAssistantPreResponseStatusSurface(messageWrapperDiv);
      return false;
    }

    const existingSurface = messageWrapperDiv.querySelector('.assistant-pre-response-status');
    const surface = existingSurface || ensureAssistantPreResponseStatusSurface(messageWrapperDiv);
    if (!surface) return false;
    const textElement = surface.querySelector('.assistant-pre-response-status__text');
    if (textElement) {
      textElement.textContent = status.text;
    } else {
      surface.textContent = status.text;
    }
    surface.classList.toggle('assistant-pre-response-status--spinnerless', status.showSpinner === false);
    surface.setAttribute('data-stage', status.stage || '');
    surface.setAttribute('data-note', status.note || '');
    messageWrapperDiv.classList.add('assistant-pre-response');
    messageWrapperDiv.dataset.preResponseStage = status.stage || '';
    return true;
  }

  /**
   * 在“思考时间线”接管展示时，移除独立的预正文状态条。
   *
   * 这里故意只清 DOM 展示，不碰 runtimeSnapshot：
   * - runtime 里的 preResponseStatus 仍然要继续作为响应活动面板底部状态行的数据源；
   * - 否则会出现“思考记录里状态闪一下就消失”的回归。
   *
   * @param {HTMLElement|null} messageWrapperDiv
   */
  function removeAssistantPreResponseStatusSurface(messageWrapperDiv) {
    if (!messageWrapperDiv) return;
    messageWrapperDiv.classList.remove('assistant-pre-response');
    delete messageWrapperDiv.dataset.preResponseStage;
    messageWrapperDiv.querySelectorAll('.assistant-pre-response-status').forEach((statusEl) => statusEl.remove());
  }

  function normalizeResponsesLocalCompactionStatus(status) {
    if (!status || typeof status !== 'object' || Array.isArray(status)) return null;
    const normalizeInt = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : null;
    };
    const state = String(status.state || '').trim().toLowerCase();
    if (!state) return null;
    return {
      state,
      phase: String(status.phase || '').trim().toLowerCase(),
      attempt: normalizeInt(status.attempt),
      totalAttempts: normalizeInt(status.totalAttempts),
      requestBytes: normalizeInt(status.requestBytes),
      inputCount: normalizeInt(status.inputCount),
      toolCount: normalizeInt(status.toolCount),
      responseStatus: normalizeInt(status.responseStatus),
      responseBytes: normalizeInt(status.responseBytes),
      compactedOutputTokens: normalizeInt(status.compactedOutputTokens),
      outputCount: normalizeInt(status.outputCount),
      errorMessage: (typeof status.errorMessage === 'string' && status.errorMessage.trim())
        ? status.errorMessage.trim()
        : '',
      updatedAt: normalizeInt(status.updatedAt)
    };
  }

  function formatCompactStatusBytes(bytes) {
    const parsed = Number(bytes);
    if (!Number.isFinite(parsed) || parsed <= 0) return '';
    if (parsed >= 1024 * 1024) {
      return `${(parsed / (1024 * 1024)).toFixed(parsed >= 10 * 1024 * 1024 ? 0 : 1)}MB`;
    }
    if (parsed >= 1024) {
      return `${(parsed / 1024).toFixed(parsed >= 10 * 1024 ? 0 : 1)}KB`;
    }
    return `${Math.trunc(parsed)}B`;
  }

  function formatCompactStatusTokens(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return '';
    if (parsed < 1000) return `${Math.trunc(parsed)}`;
    const units = [
      { base: 1e9, suffix: 'b' },
      { base: 1e6, suffix: 'm' },
      { base: 1e3, suffix: 'k' }
    ];
    const unit = units.find(item => parsed >= item.base) || units[units.length - 1];
    const scaled = parsed / unit.base;
    const digits = scaled >= 100 ? 0 : (scaled >= 10 ? 1 : 2);
    const text = scaled
      .toFixed(digits)
      .replace(/(\.\d*?)0+$/g, '$1')
      .replace(/\.$/g, '');
    return `${text}${unit.suffix}`;
  }

  function truncateCompactStatusText(text, maxLength = 120) {
    const normalized = (typeof text === 'string') ? text.trim().replace(/\s+/g, ' ') : '';
    if (!normalized) return '';
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  }

  function buildResponsesLocalCompactionPresentation(node) {
    const status = normalizeResponsesLocalCompactionStatus(node?.responsesLocalCompactionStatus);
    const promptTokensBefore = (() => {
      const raw = Number(node?.contextCompactionMarker?.promptTokensBefore);
      return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : null;
    })();
    const hasSuccessfulMarker = !!(node?.contextCompactionMarker
      && Array.isArray(node?.response_input_items)
      && node.response_input_items.length > 0);
    const state = status?.state || (hasSuccessfulMarker ? 'success' : '');
    if (!state) return null;

    const metaParts = [];
    const flowArrow = '→';
    if (state === 'success') {
      const compactedOutputTokens = status?.compactedOutputTokens || null;
      const tokenBeforeLabel = formatCompactStatusTokens(promptTokensBefore);
      const tokenAfterLabel = formatCompactStatusTokens(compactedOutputTokens);
      if (tokenBeforeLabel && tokenAfterLabel) {
        metaParts.push(`上下文 ${tokenBeforeLabel} ${flowArrow} ${tokenAfterLabel} tokens`);
      } else if (tokenBeforeLabel) {
        metaParts.push(`上下文 ${tokenBeforeLabel} tokens`);
      } else if (tokenAfterLabel) {
        metaParts.push(`压缩响应 ${tokenAfterLabel} tokens`);
      }

      const requestBytesLabel = formatCompactStatusBytes(status?.requestBytes);
      const responseBytesLabel = formatCompactStatusBytes(status?.responseBytes);
      if (requestBytesLabel && responseBytesLabel) {
        metaParts.push(`载荷 ${requestBytesLabel} ${flowArrow} ${responseBytesLabel}`);
      } else if (requestBytesLabel) {
        metaParts.push(`载荷 ${requestBytesLabel}`);
      } else if (responseBytesLabel) {
        metaParts.push(`载荷 ${responseBytesLabel}`);
      }

      if (status?.outputCount) metaParts.push(`${status.outputCount}个output items`);
    } else {
      if (status?.attempt) {
        const attemptLabel = status?.totalAttempts
          ? `第 ${status.attempt}/${status.totalAttempts} 次`
          : `第 ${status.attempt} 次`;
        metaParts.push(attemptLabel);
      }
      if (status?.requestBytes) metaParts.push(`载荷 ${formatCompactStatusBytes(status.requestBytes)}`);
      if (status?.inputCount) metaParts.push(`${status.inputCount}条输入`);
      if (status?.responseBytes) metaParts.push(`响应 ${formatCompactStatusBytes(status.responseBytes)}`);
      if (status?.outputCount) metaParts.push(`${status.outputCount}个output items`);
      if (state === 'error' && status?.responseStatus) metaParts.push(`HTTP ${status.responseStatus}`);
    }

    let title = '上下文已压缩';
    let iconClass = 'fa-box-archive';
    let stateClass = 'success';

    if (state === 'pending') {
      stateClass = 'pending';
      iconClass = 'fa-arrows-rotate';
      title = '正在压缩';
    } else if (state === 'error') {
      stateClass = 'error';
      iconClass = 'fa-circle-exclamation';
      title = '压缩请求失败';
    }

    const fallbackMeta = (() => {
      if (stateClass === 'pending') {
        if (status?.phase === 'retrying') {
          return status?.errorMessage
            ? `准备重试 · ${truncateCompactStatusText(status.errorMessage, 88)}`
            : '准备重试';
        }
        if (status?.phase === 'sending') {
          return '请求已发出，等待 compact 响应';
        }
        return '正在构建 compact 载荷';
      }
      if (stateClass === 'error') {
        return truncateCompactStatusText(status?.errorMessage || '未收到有效 compact 响应');
      }
      return '后续轮次将复用压缩后的历史';
    })();

    return {
      state: stateClass,
      title,
      iconClass,
      meta: metaParts.length > 0
        ? `${metaParts.join(' · ')}${stateClass === 'error' && status?.errorMessage ? ` · ${truncateCompactStatusText(status.errorMessage)}` : ''}`
        : fallbackMeta
    };
  }

  function syncResponsesLocalCompactionDisplay(messageWrapperDiv, node) {
    if (!messageWrapperDiv) return false;
    const presentation = buildResponsesLocalCompactionPresentation(node);
    const existingBanner = messageWrapperDiv.querySelector('.context-compaction-divider');
    const messageId = messageWrapperDiv.getAttribute('data-message-id') || '';

    if (!presentation) {
      messageWrapperDiv.classList.remove('context-compaction-message');
      delete messageWrapperDiv.dataset.compactionState;
      if (existingBanner) existingBanner.remove();
      return false;
    }

    messageWrapperDiv.classList.add('context-compaction-message');
    messageWrapperDiv.dataset.compactionState = presentation.state;
    messageWrapperDiv.classList.remove('updating');
    messageWrapperDiv.classList.remove('assistant-pre-response');
    messageWrapperDiv.classList.toggle('error-message', presentation.state === 'error');

    let banner = existingBanner;
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'context-compaction-divider';
      banner.innerHTML = `
        <div class="context-compaction-divider__row">
          <span class="context-compaction-divider__line" aria-hidden="true"></span>
          <div class="context-compaction-divider__pill">
            <i class="context-compaction-divider__icon fa-solid" aria-hidden="true"></i>
            <span class="context-compaction-divider__label"></span>
            <span class="context-compaction-divider__actions" hidden>
              <button class="context-compaction-divider__action context-compaction-divider__action--cancel" type="button" title="取消压缩" aria-label="取消压缩">
                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
              </button>
              <button class="context-compaction-divider__action context-compaction-divider__action--retry" type="button" title="重试压缩" aria-label="重试压缩">
                <i class="fa-solid fa-rotate-right" aria-hidden="true"></i>
              </button>
              <button class="context-compaction-divider__action context-compaction-divider__action--confirm" type="button" title="确认并关闭" aria-label="确认并关闭">
                <i class="fa-solid fa-check" aria-hidden="true"></i>
              </button>
            </span>
          </div>
          <span class="context-compaction-divider__line" aria-hidden="true"></span>
        </div>
        <div class="context-compaction-divider__meta"></div>
      `;
      const textContent = messageWrapperDiv.querySelector('.text-content');
      if (textContent) {
        messageWrapperDiv.insertBefore(banner, textContent);
      } else {
        messageWrapperDiv.appendChild(banner);
      }
    }

    banner.className = `context-compaction-divider is-${presentation.state}`;
    const actions = banner.querySelector('.context-compaction-divider__actions');
    const cancelButton = banner.querySelector('.context-compaction-divider__action--cancel');
    const retryButton = banner.querySelector('.context-compaction-divider__action--retry');
    const confirmButton = banner.querySelector('.context-compaction-divider__action--confirm');
    const icon = banner.querySelector('.context-compaction-divider__icon');
    const label = banner.querySelector('.context-compaction-divider__label');
    const meta = banner.querySelector('.context-compaction-divider__meta');
    if (icon) {
      icon.className = `context-compaction-divider__icon fa-solid ${presentation.iconClass}`;
    }
    if (label) {
      label.textContent = presentation.title;
    }
    if (meta) {
      meta.textContent = presentation.meta || '';
      meta.hidden = !presentation.meta;
    }
    if (actions) {
      const showCancel = presentation.state === 'pending';
      const showFailureActions = presentation.state === 'error';
      actions.hidden = !(showCancel || showFailureActions);
      if (cancelButton) cancelButton.hidden = !showCancel;
      if (retryButton) retryButton.hidden = !showFailureActions;
      if (confirmButton) confirmButton.hidden = !showFailureActions;
    }

    const bindAction = (button, actionName, handler) => {
      if (!button || button.dataset.boundAction === actionName) return;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!messageId) return;
        try {
          handler(messageId);
        } catch (error) {
          console.warn(`compact 分隔线动作执行失败: ${actionName}`, error);
        }
      });
      button.dataset.boundAction = actionName;
    };

    bindAction(cancelButton, 'cancel', (targetMessageId) => {
      void services.messageSender?.cancelResponsesLocalCompaction?.(targetMessageId);
    });
    bindAction(retryButton, 'retry', (targetMessageId) => {
      void services.messageSender?.retryResponsesLocalCompaction?.(targetMessageId);
    });
    bindAction(confirmButton, 'confirm', (targetMessageId) => {
      void services.messageSender?.dismissResponsesLocalCompaction?.(targetMessageId);
    });
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
    const messageWrapperDiv = resolveLiveMessageElement(messageId, options?.fallbackElement || null);
    const node = (nodeLike && typeof nodeLike === 'object')
      ? nodeLike
      : (messageId ? chatHistoryManager.chatHistory.messages.find(msg => msg.id === messageId) : null);
    const runtimeSnapshot = options?.runtimeSnapshot || null;
    if (!messageWrapperDiv) return false;
    const role = String(node?.role || '').toLowerCase();
    const isAssistantLike = role === 'assistant'
      || role === 'ai'
      || ((!node) && (
        messageWrapperDiv.classList.contains('ai-message')
        || messageWrapperDiv.classList.contains('loading-message')
      ));
    if (!isAssistantLike) return false;
    try { messageWrapperDiv.removeAttribute('title'); } catch (_) {}
    const hasPreResponseStatus = syncAssistantPreResponseStatus(messageId, messageWrapperDiv, runtimeSnapshot);
    const responseTimeline = node ? getAssistantActivityTimeline(node) : [];

    if (!node) {
      if (hasPreResponseStatus) {
        messageVirtualizer.scheduleUpdate(resolveMessageListContainer(messageWrapperDiv));
      }
      return hasPreResponseStatus;
    }

    if (hasPreResponseStatus && responseTimeline.length === 0) {
      removeResponseActivityTimelineDisplay(messageWrapperDiv, {
        preserveAutoCollapseSchedules: true
      });
      setupThoughtsDisplay(messageWrapperDiv, null, processMathAndMarkdown);
      setupResponseToolCallsDisplay(messageWrapperDiv, null);
      syncResponsesLocalCompactionDisplay(messageWrapperDiv, null);
      messageVirtualizer.scheduleUpdate(resolveMessageListContainer(messageWrapperDiv));
      return true;
    }

    if (responseTimeline.length > 0) {
      // 一旦进入 response_activity 时间线展示，就只保留面板底部的状态行，
      // 不再让顶部独立状态条与之重复显示。
      removeAssistantPreResponseStatusSurface(messageWrapperDiv);
    }

    const hasCompactionDisplay = syncResponsesLocalCompactionDisplay(messageWrapperDiv, node);
    if (hasCompactionDisplay) {
      removeResponseActivityTimelineDisplay(messageWrapperDiv, {
        preserveAutoCollapseSchedules: true
      });
      setupThoughtsDisplay(messageWrapperDiv, null, processMathAndMarkdown);
      setupResponseToolCallsDisplay(messageWrapperDiv, null);
      messageVirtualizer.scheduleUpdate(resolveMessageListContainer(messageWrapperDiv));
      return true;
    }

    if (responseTimeline.length > 0) {
      setupThoughtsDisplay(messageWrapperDiv, null, processMathAndMarkdown);
      setupResponseToolCallsDisplay(messageWrapperDiv, null);
      setupResponseActivityTimelineDisplay(
        messageWrapperDiv,
        node,
        responseTimeline,
        processMathAndMarkdown,
        { runtimeSnapshot }
      );
    } else {
      removeResponseActivityTimelineDisplay(messageWrapperDiv, {
        preserveAutoCollapseSchedules:
          isResponseActivityTurnRuntimeActive(messageWrapperDiv)
          || !!messageWrapperDiv.querySelector('.response-activity-timeline')
      });
      setupThoughtsDisplay(messageWrapperDiv, null, processMathAndMarkdown);
      setupResponseToolCallsDisplay(messageWrapperDiv, null);
    }
    // metadata 同步阶段只允许刷新 assistant 自身附加展示，
    // 绝不能顺手改外层聊天容器的 scrollTop。
    // 否则 reasoning / tool timeline 的高度波动会把整个对话列表错误地滚动到旧消息。
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
    const runtimeSnapshot = normalizedOptions.runtimeSnapshot || null;

    if (Object.prototype.hasOwnProperty.call(normalizedOptions, 'content')) {
      updateAIMessage(
        messageId,
        normalizedOptions.content || '',
        normalizedOptions.thoughtsRaw,
        {
          fallbackNode: node || null,
          runtimeSnapshot,
          suppressMissingNodeWarning: normalizedOptions.suppressMissingNodeWarning === true
        }
      );
      node = (messageId ? chatHistoryManager.chatHistory.messages.find(msg => msg.id === messageId) : null) || node;
    }

    const messageWrapperDiv = resolveLiveMessageElement(messageId, fallbackElement);
    if (messageWrapperDiv?.dataset) {
      const runtimeStatus = String(normalizedOptions.runtimeSnapshot?.activeTurn?.status || '').trim().toLowerCase();
      const boundAssistantMessageId = String(normalizedOptions.runtimeSnapshot?.activeTurn?.boundAssistantMessageId || '').trim();
      if (runtimeStatus && boundAssistantMessageId && boundAssistantMessageId === String(messageId || '').trim()) {
        messageWrapperDiv.dataset.responseRuntimeStatus = runtimeStatus;
        const thinkingRuntimeActive = !['idle', 'completed', 'aborted', 'error'].includes(runtimeStatus)
          && normalizedOptions.runtimeSnapshot?.activeTurn?.hasVisibleAnswerStarted !== true;
        messageWrapperDiv.dataset.responseThinkingRuntimeActive = thinkingRuntimeActive ? 'true' : 'false';
      } else {
        delete messageWrapperDiv.dataset.responseRuntimeStatus;
        delete messageWrapperDiv.dataset.responseThinkingRuntimeActive;
      }
    }

    let syncedAny = false;
    if (messageWrapperDiv && node) {
      syncedAny = syncAssistantMessageMetadata(messageId, node, {
        fallbackElement: messageWrapperDiv,
        runtimeSnapshot
      }) || syncedAny;
      syncedAny = renderAssistantApiFooter(messageWrapperDiv, node) || syncedAny;
    }
    return syncedAny;
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

    return renderAiMessageDom(messageDiv, node, safeAnswerContent, resolvedThoughts, {
      runtimeSnapshot: updateOptions.runtimeSnapshot || null
    });
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

  function normalizeHighlightClassName(value) {
    return String(value || '')
      .split(/\s+/)
      .map(token => token.trim())
      .filter(token => token && token !== 'hljs')
      .sort()
      .join(' ');
  }

  function resolveDeclaredHighlightLanguage(block) {
    if (!block?.classList) return '';
    const tokens = Array.from(block.classList.values())
      .map(token => String(token || '').trim())
      .filter(Boolean);
    const languageToken = tokens.find((token) => (
      token.startsWith('language-') || token.startsWith('lang-')
    )) || '';
    if (!languageToken) return '';
    return languageToken
      .replace(/^language-/, '')
      .replace(/^lang-/, '')
      .trim()
      .toLowerCase();
  }

  function markCodeBlockHighlightState(block, signature, state) {
    if (!block?.dataset) return;
    block.dataset.cerebrHighlightSignature = signature;
    block.dataset.cerebrHighlightState = state;
  }

  function enhanceCodeHighlightBlocks(rootElement) {
    if (!rootElement || typeof rootElement.querySelectorAll !== 'function') return;
    rootElement.querySelectorAll('pre code').forEach((block) => {
      if (block.closest('.mermaid-diagram__source')) return;
      try {
        if (typeof hljs === 'undefined' || typeof hljs.highlightElement !== 'function') return;

        const normalizedClassName = normalizeHighlightClassName(block.getAttribute('class') || '');
        const sourceText = typeof block.textContent === 'string' ? block.textContent : '';
        if (!sourceText.trim()) return;

        const nextSignature = `${normalizedClassName}::${sourceText}`;
        const currentSignature = String(block.dataset.cerebrHighlightSignature || '').trim();
        const currentState = String(block.dataset.cerebrHighlightState || '').trim().toLowerCase();
        if (
          currentSignature === nextSignature
          && ['done', 'rendered', 'unsupported'].includes(currentState)
        ) {
          return;
        }

        // renderMarkdownSafe 已经在字符串阶段完成过一次 fenced code 高亮。
        // 若当前 code 内已经存在 hljs token span，只补充容器 class 和我们的幂等标记，
        // 不再重复调用 highlight.js，避免长对话重载时对同一块代码反复走高亮热点。
        if (block.querySelector('[class*="hljs-"]')) {
          block.classList.add('hljs');
          markCodeBlockHighlightState(block, nextSignature, 'rendered');
          return;
        }

        const declaredLanguage = resolveDeclaredHighlightLanguage(block);
        if (declaredLanguage && !hljs.getLanguage(declaredLanguage)) {
          // 彻底绕开 highlight.js 的 unknown-language warning。
          // 只记录“这个语言当前不支持”，后续同签名内容直接跳过，不再刷屏。
          markCodeBlockHighlightState(block, nextSignature, 'unsupported');
          return;
        }

        block.textContent = sourceText;
        block.classList.remove('hljs');
        delete block.dataset.highlighted;
        hljs.highlightElement(block);
        markCodeBlockHighlightState(block, nextSignature, 'done');
      } catch (_) {}
    });
  }

  function shouldCollapseLongCodeBlocks() {
    return settingsManager?.getSetting?.('collapseLongCodeBlocks') === true;
  }

  function resolveMarkdownCodeBlockLanguage(wrapper, block) {
    const wrapperLanguage = String(wrapper?.dataset?.codeLanguage || '').trim().toLowerCase();
    if (wrapperLanguage) return wrapperLanguage;
    return resolveDeclaredHighlightLanguage(block) || 'text';
  }

  function updateMarkdownCodeBlockToggleButton(button, expanded) {
    if (!(button instanceof HTMLElement)) return;
    const icon = button.querySelector('.cerebr-markdown-code-block__action-icon');
    const label = button.querySelector('.cerebr-markdown-code-block__action-label');
    if (icon) {
      icon.className = expanded
        ? 'fa-solid fa-chevron-up cerebr-markdown-code-block__action-icon'
        : 'fa-solid fa-chevron-down cerebr-markdown-code-block__action-icon';
      icon.setAttribute('aria-hidden', 'true');
    }
    if (label) {
      label.textContent = expanded ? '收起' : '展开';
    } else {
      button.textContent = expanded ? '收起' : '展开';
    }
    button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    button.setAttribute('title', `${expanded ? '收起' : '展开'}代码块`);
    button.setAttribute('aria-label', `${expanded ? '收起' : '展开'}代码块`);
  }

  function measureMarkdownCodeBlockOverflow(wrapper, body) {
    if (!(wrapper instanceof HTMLElement) || !(body instanceof HTMLElement)) return false;
    const wasExpanded = wrapper.classList.contains('is-expanded');
    const hadCollapsibleClass = wrapper.classList.contains('is-collapsible');
    if (wasExpanded) {
      wrapper.classList.remove('is-expanded');
    }
    if (!hadCollapsibleClass) {
      wrapper.classList.add('is-collapsible');
    }
    const isOverflowing = (body.scrollHeight - body.clientHeight) > 1;
    if (!hadCollapsibleClass) {
      wrapper.classList.remove('is-collapsible');
    }
    if (wasExpanded) {
      wrapper.classList.add('is-expanded');
    }
    return isOverflowing;
  }

  function syncMarkdownCodeBlockChrome(wrapper) {
    if (!(wrapper instanceof HTMLElement)) return;
    const body = wrapper.querySelector(':scope > .cerebr-markdown-code-block__body');
    const toggleButton = wrapper.querySelector('.cerebr-markdown-code-block__toggle');
    if (!(body instanceof HTMLElement) || !(toggleButton instanceof HTMLElement)) return;

    const collapseEnabled = shouldCollapseLongCodeBlocks();
    const isOverflowing = collapseEnabled ? measureMarkdownCodeBlockOverflow(wrapper, body) : false;
    const canCollapse = collapseEnabled && isOverflowing;
    wrapper.classList.toggle('is-collapsible', canCollapse);

    if (!canCollapse) {
      wrapper.dataset.expanded = 'false';
      wrapper.classList.remove('is-expanded');
      toggleButton.hidden = true;
      updateMarkdownCodeBlockToggleButton(toggleButton, false);
      return;
    }

    const expanded = wrapper.dataset.expanded === 'true';
    wrapper.classList.toggle('is-expanded', expanded);
    toggleButton.hidden = false;
    updateMarkdownCodeBlockToggleButton(toggleButton, expanded);
  }

  function scheduleMarkdownCodeBlockSync(wrapper, attempt = 0) {
    scheduleAfterLayout(() => {
      if (!(wrapper instanceof HTMLElement)) return;
      if (!wrapper.isConnected) {
        if (attempt < 4) {
          scheduleMarkdownCodeBlockSync(wrapper, attempt + 1);
        }
        return;
      }
      syncMarkdownCodeBlockChrome(wrapper);
    });
  }

  function createMarkdownCodeBlockActionButton({
    className = '',
    iconClass = '',
    label = '',
    title = ''
  } = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `cerebr-markdown-code-block__action ${className}`.trim();
    button.setAttribute('title', title || label || '');
    button.setAttribute('aria-label', title || label || '');

    const icon = document.createElement('i');
    icon.className = `${iconClass} cerebr-markdown-code-block__action-icon`.trim();
    icon.setAttribute('aria-hidden', 'true');
    button.appendChild(icon);

    const text = document.createElement('span');
    text.className = 'cerebr-markdown-code-block__action-label';
    text.textContent = label;
    button.appendChild(text);
    return button;
  }

  function ensureMarkdownCodeBlockChrome(wrapper) {
    if (!(wrapper instanceof HTMLElement)) return;
    let pre = wrapper.querySelector(':scope > pre');
    if (!(pre instanceof HTMLElement)) {
      pre = wrapper.querySelector('pre');
    }
    const codeBlock = wrapper.querySelector('pre code');
    if (!(pre instanceof HTMLElement) || !(codeBlock instanceof HTMLElement)) return;

    let languageLabel = wrapper.querySelector(':scope > .cerebr-markdown-code-block__header .cerebr-markdown-code-block__language');
    let body = wrapper.querySelector(':scope > .cerebr-markdown-code-block__body');
    let copyButton = wrapper.querySelector('.cerebr-markdown-code-block__copy');
    let toggleButton = wrapper.querySelector('.cerebr-markdown-code-block__toggle');

    if (wrapper.dataset.codeChromeBound !== 'true') {
      const header = document.createElement('div');
      header.className = 'cerebr-markdown-code-block__header';

      languageLabel = document.createElement('span');
      languageLabel.className = 'cerebr-markdown-code-block__language';
      header.appendChild(languageLabel);

      const actions = document.createElement('div');
      actions.className = 'cerebr-markdown-code-block__actions';

      copyButton = createMarkdownCodeBlockActionButton({
        className: 'cerebr-markdown-code-block__copy',
        iconClass: 'fa-regular fa-copy',
        label: '复制',
        title: '复制代码'
      });
      copyButton.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const sourceText = typeof codeBlock.textContent === 'string' ? codeBlock.textContent : '';
        if (!sourceText || !navigator.clipboard?.writeText) return;
        try {
          await navigator.clipboard.writeText(sourceText);
          const icon = copyButton.querySelector('.cerebr-markdown-code-block__action-icon');
          const label = copyButton.querySelector('.cerebr-markdown-code-block__action-label');
          if (icon) {
            icon.className = 'fa-solid fa-check cerebr-markdown-code-block__action-icon';
          }
          if (label) {
            label.textContent = '已复制';
          }
          window.setTimeout(() => {
            if (!(copyButton instanceof HTMLElement) || !copyButton.isConnected) return;
            const resetIcon = copyButton.querySelector('.cerebr-markdown-code-block__action-icon');
            const resetLabel = copyButton.querySelector('.cerebr-markdown-code-block__action-label');
            if (resetIcon) {
              resetIcon.className = 'fa-regular fa-copy cerebr-markdown-code-block__action-icon';
            }
            if (resetLabel) {
              resetLabel.textContent = '复制';
            }
          }, 1200);
        } catch (_) {}
      });
      actions.appendChild(copyButton);

      toggleButton = createMarkdownCodeBlockActionButton({
        className: 'cerebr-markdown-code-block__toggle',
        iconClass: 'fa-solid fa-chevron-down',
        label: '展开',
        title: '展开代码块'
      });
      toggleButton.hidden = true;
      toggleButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const nextExpanded = wrapper.dataset.expanded !== 'true';
        runWithStableToggleScroll(toggleButton, () => {
          wrapper.dataset.expanded = nextExpanded ? 'true' : 'false';
          wrapper.classList.toggle('is-expanded', nextExpanded);
          updateMarkdownCodeBlockToggleButton(toggleButton, nextExpanded);
        });
      });
      actions.appendChild(toggleButton);

      header.appendChild(actions);
      wrapper.insertBefore(header, pre);

      body = document.createElement('div');
      body.className = 'cerebr-markdown-code-block__body';
      wrapper.appendChild(body);
      body.appendChild(pre);

      wrapper.dataset.codeChromeBound = 'true';
    }

    const language = resolveMarkdownCodeBlockLanguage(wrapper, codeBlock);
    if (languageLabel instanceof HTMLElement) {
      languageLabel.textContent = language;
    }
    scheduleMarkdownCodeBlockSync(wrapper);
  }

  function enhanceRenderedMarkdownCodeBlocks(rootElement) {
    if (!rootElement || typeof rootElement.querySelectorAll !== 'function') return;
    rootElement.querySelectorAll('.cerebr-markdown-code-block').forEach((wrapper) => {
      ensureMarkdownCodeBlockChrome(wrapper);
    });
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
    rootElement.querySelectorAll('details.folded-message').forEach((detailsElement) => {
      bindStableToggleDetails(detailsElement, detailsElement);
    });

    enhanceCodeHighlightBlocks(rootElement);
    enhanceRenderedMarkdownCodeBlocks(rootElement);

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
      rerenderUserMessagesForDisplaySettings();
    });
  } catch (error) {
    console.warn('订阅 enableDollarMath 设置变化失败:', error);
  }

  try {
    services.settingsManager?.subscribe?.('renderMarkdownForUserMessages', () => {
      rerenderUserMessagesForDisplaySettings();
    });
  } catch (error) {
    console.warn('订阅 renderMarkdownForUserMessages 设置变化失败:', error);
  }

  try {
    services.settingsManager?.subscribe?.('collapseLongCodeBlocks', () => {
      document.querySelectorAll('.cerebr-markdown-code-block').forEach((wrapper) => {
        scheduleMarkdownCodeBlockSync(wrapper);
      });
    });
  } catch (error) {
    console.warn('订阅 collapseLongCodeBlocks 设置变化失败:', error);
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
  installConversationDocumentChangeListener();
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
    clearResponseActivityUiState,
    renderAssistantApiFooter,
    processMathAndMarkdown,
    enhanceMarkdownContent,
    decorateMarkdownLinks,
    getPromptTypeFromContent,
    extractSystemContent
  };
}
