import { normalizeStoredMessageContent, splitStoredMessageContent } from '../utils/message_content.js';
import { queueStorageSet } from '../utils/storage_write_queue_bridge.js';
import { buildApiFooterRenderData } from '../utils/api_footer_template.js';

function normalizeComposerQuoteSourceText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .trim();
}

/**
 * 把划词内容转换成输入框里的 Markdown 引用前缀。
 *
 * 说明：
 * - 每一行都显式加 `> `，避免多行划词只有首行被引用；
 * - 只裁掉选区整体首尾空白，不改写行内缩进，便于引用代码片段或表格文本；
 * - 返回空字符串表示没有可插入内容，调用方应保持输入框不变。
 *
 * @param {string} selectionText
 * @returns {string}
 */
export function buildSelectionComposerQuote(selectionText) {
  const normalizedSelection = normalizeComposerQuoteSourceText(selectionText);
  if (!normalizedSelection) return '';
  return normalizedSelection
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * 把划词引用插入到输入框开头。
 *
 * 用户预期的发送形态是：
 * > 选中并引用的内容
 * 用户继续输入的内容
 *
 * 因此这里不用额外的引用预览 UI，也不把引用做成隐藏元数据，而是直接写入 composer 文本。
 *
 * @param {string} currentText
 * @param {string} selectionText
 * @returns {string}
 */
export function prependSelectionQuoteToComposerText(currentText, selectionText) {
  const quoteText = buildSelectionComposerQuote(selectionText);
  if (!quoteText) return String(currentText ?? '');
  const normalizedCurrentText = String(currentText ?? '')
    .replace(/\r\n?/g, '\n')
    .trimStart();
  // Chrome contenteditable 在 `textContent` 末尾只有一个 `\n` 时，会把随后输入的文字插回同一行。
  // 空 composer 需要写入两个尾随换行：第一个是最终发送文本里的换行，第二个只负责把光标稳定锚到下一行。
  return normalizedCurrentText ? `${quoteText}\n${normalizedCurrentText}` : `${quoteText}\n\n`;
}

/**
 * 划词线程管理器
 *
 * 负责：
 * - 侧栏消息的划词识别与线程元数据管理
 * - 线程高亮渲染与预览气泡
 * - 线程模式的进入/退出状态管理（具体布局与发送在上层接入）
 */

export function createSelectionThreadManager(appContext) {
  const { dom, services, utils } = appContext;
  const chatContainer = dom.chatContainer;
  const chatLayout = dom.chatLayout;
  const threadPanel = dom.threadPanel;
  const threadContainer = dom.threadContainer;
  const threadSplitter = dom.threadSplitter;
  const threadResizeEdgeLeft = dom.threadResizeEdgeLeft;
  const threadResizeEdgeRight = dom.threadResizeEdgeRight;
  const chatHistoryManager = services.chatHistoryManager;
  const chatHistoryUI = services.chatHistoryUI;
  const messageProcessor = services.messageProcessor;
  const messageSender = services.messageSender;
  const settingsManager = services.settingsManager;
  const promptSettingsManager = services.promptSettingsManager;
  const imageHandler = services.imageHandler;
  const apiManager = services.apiManager;
  const showNotification = utils?.showNotification;

  const state = {
    activeThreadId: null,
    activeAnchorMessageId: null,
    activeSelectionText: '',
    pendingSelection: null,
    bubblePinned: false,
    bubbleType: 'hidden',
    bubbleHovered: false,
    highlightHovered: false,
    bannerHovered: false,
    bannerTopEdgeActive: false,
    bannerScrollAtTop: true,
    bubbleHideTimer: null,
    bubbleHideAnimationTimer: null,
    selectionCollapseTimer: null,
    bubbleClickHandler: null,
    bubbleActionHandlers: new Map(),
    threadLayoutLeft: null,
    threadLayoutRight: null,
    threadLayoutRatio: 0.5,
    threadLayoutCustomized: false
  };

  const threadPanelHome = {
    parent: threadPanel?.parentNode || null,
    nextSibling: threadPanel?.nextSibling || null
  };

  let layoutObserver = null;

  let bubbleEl = null;
  let bubbleHeaderEl = null;
  let bubbleTitleEl = null;
  let bubbleContentEl = null;
  let bubbleContentTextEl = null;
  let bubbleContentIconEl = null;

  let threadBannerEl = null;
  let threadBannerTextEl = null;
  const THREAD_BANNER_TOP_EDGE_PX = 80;
  let threadScrollListenerBound = false;
  let threadBannerPeekTimer = null;
  const THREAD_RESIZE_MIN_COLUMN_WIDTH = 240;
  const THREAD_RESIZE_EDGE_PADDING = 30;
  const FULLSCREEN_RESIZE_MIN_WIDTH = 500;
  const THREAD_LAYOUT_STORAGE_KEY = 'thread_layout_prefs';
  const THREAD_LAYOUT_SYNC_MIN_INTERVAL_MS = 15000;
  const THREAD_LAYOUT_SYNC_DEBOUNCE_MS = 800;
  const THREAD_ANCHOR_VIEWPORT_CENTER = 0.5;
  let threadLayoutPrefsPromise = null;
  const threadLayoutSyncState = {
    timer: null,
    lastSyncAt: 0,
    lastSignature: '',
    pendingPayload: null,
    pendingSignature: ''
  };
  const threadResizeState = {
    active: false,
    mode: '',
    startX: 0,
    startLeft: 0,
    startTotal: 0,
    ratio: 0.5
  };
  const fullscreenResizeState = {
    active: false,
    edge: '',
    startX: 0,
    startWidth: 0,
    currentWidth: 0,
    pointerScale: 1
  };
  const resizeHandleElements = [
    threadSplitter,
    threadResizeEdgeLeft,
    threadResizeEdgeRight
  ].filter(Boolean);

  function clearThreadBannerPeekTimer() {
    if (!threadBannerPeekTimer) return;
    clearTimeout(threadBannerPeekTimer);
    threadBannerPeekTimer = null;
  }

  function updateThreadBannerPeek() {
    if (!threadBannerEl) return;
    if (!state.activeThreadId) return;
    clearThreadBannerPeekTimer();
    if (state.bannerScrollAtTop) {
      threadBannerEl.classList.remove('thread-selection-banner--peek');
      threadBannerEl.classList.remove('thread-selection-banner--peek-visible');
      threadBannerEl.classList.remove('thread-selection-banner--peek-hidden');
      return;
    }
    const shouldPeek = !!(state.bannerHovered || state.bannerTopEdgeActive);
    if (shouldPeek) {
      if (!threadBannerEl.classList.contains('thread-selection-banner--peek')) {
        threadBannerEl.classList.add('thread-selection-banner--peek');
        threadBannerEl.classList.add('thread-selection-banner--peek-hidden');
        threadBannerEl.classList.remove('thread-selection-banner--peek-visible');
        requestAnimationFrame(() => {
          if (!threadBannerEl || !state.activeThreadId) return;
          if (state.bannerScrollAtTop) return;
          if (!(state.bannerHovered || state.bannerTopEdgeActive)) return;
          threadBannerEl.classList.add('thread-selection-banner--peek-visible');
          threadBannerEl.classList.remove('thread-selection-banner--peek-hidden');
        });
        return;
      }
      threadBannerEl.classList.add('thread-selection-banner--peek-visible');
      threadBannerEl.classList.remove('thread-selection-banner--peek-hidden');
      return;
    }
    if (threadBannerEl.classList.contains('thread-selection-banner--peek')) {
      threadBannerEl.classList.remove('thread-selection-banner--peek-visible');
      threadBannerEl.classList.add('thread-selection-banner--peek-hidden');
      threadBannerPeekTimer = window.setTimeout(() => {
        threadBannerPeekTimer = null;
        if (!threadBannerEl) return;
        threadBannerEl.classList.remove('thread-selection-banner--peek');
        threadBannerEl.classList.remove('thread-selection-banner--peek-hidden');
      }, 180);
      return;
    }
    threadBannerEl.classList.remove('thread-selection-banner--peek');
    threadBannerEl.classList.remove('thread-selection-banner--peek-visible');
    threadBannerEl.classList.remove('thread-selection-banner--peek-hidden');
  }

  function handleThreadBannerMouseEnter() {
    state.bannerHovered = true;
    updateThreadBannerPeek();
  }

  function handleThreadBannerMouseLeave() {
    state.bannerHovered = false;
    updateThreadBannerPeek();
  }

  function getThreadBannerTopEdgeThreshold() {
    let extra = 0;
    if (threadBannerEl) {
      const bannerStyle = window.getComputedStyle(threadBannerEl);
      const marginTop = parseFloat(bannerStyle.marginTop) || 0;
      extra += marginTop;
    }
    if (threadContainer) {
      const containerStyle = window.getComputedStyle(threadContainer);
      const paddingTop = parseFloat(containerStyle.paddingTop) || 0;
      const gap = parseFloat(containerStyle.rowGap || containerStyle.gap) || 0;
      extra += paddingTop + gap;
    }
    return THREAD_BANNER_TOP_EDGE_PX + extra;
  }

  function handleTopEdgeMouseMove(event) {
    if (!state.activeThreadId || !threadBannerEl) return;
    if (!threadContainer) return;
    const pointerX = Number(event?.clientX);
    const pointerY = Number(event?.clientY);
    if (!Number.isFinite(pointerX) || !Number.isFinite(pointerY)) return;

    const containerRect = threadContainer.getBoundingClientRect();
    const threshold = getThreadBannerTopEdgeThreshold();
    // 仅在“线程列表容器”顶部附近触发 peek，避免鼠标到屏幕顶端任意位置都误触发。
    const withinHorizontal = pointerX >= containerRect.left && pointerX <= containerRect.right;
    const relativeY = pointerY - containerRect.top;
    const nearTop = withinHorizontal && relativeY >= -2 && relativeY <= threshold;
    if (nearTop === state.bannerTopEdgeActive) return;
    state.bannerTopEdgeActive = nearTop;
    updateThreadBannerPeek();
  }

  function updateThreadBannerScrollState() {
    if (!threadContainer) return;
    const atTop = (threadContainer.scrollTop || 0) <= 4;
    if (atTop === state.bannerScrollAtTop) return;
    state.bannerScrollAtTop = atTop;
    updateThreadBannerPeek();
  }

  function handleThreadContainerScroll() {
    updateThreadBannerScrollState();
  }

  function ensureBubble() {
    if (bubbleEl) return;
    bubbleEl = document.createElement('div');
    bubbleEl.className = 'selection-thread-bubble';
    bubbleEl.style.display = 'none';

    bubbleHeaderEl = document.createElement('div');
    bubbleHeaderEl.className = 'selection-thread-bubble__header';

    bubbleTitleEl = document.createElement('div');
    bubbleTitleEl.className = 'selection-thread-bubble__title';
    bubbleHeaderEl.appendChild(bubbleTitleEl);

    bubbleContentEl = document.createElement('div');
    bubbleContentEl.className = 'selection-thread-bubble__content';
    bubbleContentTextEl = document.createElement('div');
    bubbleContentTextEl.className = 'selection-thread-bubble__content-text';
    bubbleContentIconEl = document.createElement('div');
    bubbleContentIconEl.className = 'selection-thread-bubble__content-icon';
    bubbleHeaderEl.appendChild(bubbleContentIconEl);
    bubbleContentEl.appendChild(bubbleContentTextEl);

    bubbleEl.appendChild(bubbleHeaderEl);
    bubbleEl.appendChild(bubbleContentEl);
    bubbleEl.addEventListener('mouseenter', handleBubbleMouseEnter);
    bubbleEl.addEventListener('mouseleave', handleBubbleMouseLeave);
    bubbleEl.addEventListener('click', handleBubbleClick, true);
    const host = chatContainer || document.body;
    // 气泡挂在聊天滚动容器内，确保随消息滚动而移动，同时不打断“最后一条消息”的底部间距。
    if (host.firstChild) {
      host.insertBefore(bubbleEl, host.firstChild);
    } else {
      host.appendChild(bubbleEl);
    }
  }

  function handleBubbleMouseEnter() {
    state.bubbleHovered = true;
    clearBubbleHideTimer();
    clearSelectionCollapseTimer();
  }

  function handleBubbleMouseLeave() {
    state.bubbleHovered = false;
    scheduleBubbleHide();
    if (state.bubbleType === 'selection') {
      scheduleSelectionCollapseHide();
    }
  }

  function handleBubbleClick(event) {
    if (event && bubbleEl) {
      const actionButton = event.target?.closest?.('.selection-thread-bubble__icon-button');
      const actionId = actionButton?.dataset?.actionId || '';
      if (actionId && state.bubbleActionHandlers?.has(actionId)) {
        event.preventDefault();
        event.stopPropagation();
        const handler = state.bubbleActionHandlers.get(actionId);
        if (typeof handler === 'function') {
          handler();
        }
        return;
      }
    }
    if (typeof state.bubbleClickHandler !== 'function') return;
    event.preventDefault();
    event.stopPropagation();
    state.bubbleClickHandler();
  }

  function clearBubbleHideTimer() {
    if (!state.bubbleHideTimer) return;
    clearTimeout(state.bubbleHideTimer);
    state.bubbleHideTimer = null;
  }

  function clearBubbleHideAnimationTimer() {
    if (!state.bubbleHideAnimationTimer) return;
    clearTimeout(state.bubbleHideAnimationTimer);
    state.bubbleHideAnimationTimer = null;
  }

  function clearSelectionCollapseTimer() {
    if (!state.selectionCollapseTimer) return;
    clearTimeout(state.selectionCollapseTimer);
    state.selectionCollapseTimer = null;
  }

  function scheduleBubbleHide(delay = 220) {
    if (!bubbleEl || bubbleEl.style.display === 'none') return;
    if (state.bubblePinned) return;
    clearBubbleHideTimer();
    // 鼠标从高亮移动到气泡会经过空白区域，留出缓冲时间避免误关闭预览。
    state.bubbleHideTimer = window.setTimeout(() => {
      if (state.bubblePinned || state.bubbleHovered || state.highlightHovered) return;
      hideBubble();
    }, delay);
  }

  function scheduleSelectionCollapseHide(delay = 160) {
    if (!bubbleEl || bubbleEl.style.display === 'none') return;
    if (state.bubbleType !== 'selection') return;
    clearSelectionCollapseTimer();
    // 取消选中后延迟关闭，避免鼠标转移到气泡时被立即隐藏。
    state.selectionCollapseTimer = window.setTimeout(() => {
      state.selectionCollapseTimer = null;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      if (state.bubbleHovered || state.highlightHovered) return;
      hideBubble(true);
    }, delay);
  }

  function showBubbleAtRect(rect, options = {}) {
    ensureBubble();
    if (!bubbleEl) return;

    const {
      title = '',
      content = '',
      contentHtml = '',
      contentItems = null,
      iconClass = '',
      iconButtons = null,
      onClick = null,
      onItemClick = null,
      pinned = false,
      type = 'preview',
      variant = ''
    } = options;

    bubbleTitleEl.textContent = title;
    bubbleTitleEl.style.display = title ? 'block' : 'none';
    const hasItems = Array.isArray(contentItems) && contentItems.length > 0;
    const hasContent = hasItems || !!contentHtml || !!content;
    if (hasItems) {
      bubbleContentTextEl.innerHTML = '';
      const list = document.createElement('div');
      list.className = 'selection-thread-bubble__preview-list';
      contentItems.forEach((item) => {
        const itemId = item?.messageId || item?.threadId || '';
        if (!item || !itemId) return;
        const entry = document.createElement('div');
        entry.className = 'selection-thread-bubble__preview-item';
        if (item.messageId) {
          entry.dataset.messageId = item.messageId;
        }
        if (item.threadId) {
          entry.dataset.threadId = item.threadId;
        }
        entry.setAttribute('role', 'button');
        entry.setAttribute('tabindex', '0');
        if (item.role === 'user') {
          entry.classList.add('selection-thread-bubble__preview-item--user');
        } else if (item.role === 'assistant') {
          entry.classList.add('selection-thread-bubble__preview-item--assistant');
        } else if (item.role) {
          entry.classList.add('selection-thread-bubble__preview-item--system');
        }
        if (item.variant) {
          entry.classList.add(`selection-thread-bubble__preview-item--${item.variant}`);
        }

        const contentBox = document.createElement('div');
        contentBox.className = 'selection-thread-bubble__preview-content';
        renderPreviewMarkdownToElement(contentBox, item.text || '');

        entry.appendChild(contentBox);
        entry.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (typeof onItemClick === 'function') {
            onItemClick(item);
          }
        });
        entry.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          if (typeof onItemClick === 'function') {
            onItemClick(item);
          }
        });
        list.appendChild(entry);
      });
      bubbleContentTextEl.appendChild(list);
      bubbleContentTextEl.style.display = 'block';
    } else if (contentHtml) {
      bubbleContentTextEl.innerHTML = contentHtml;
      bubbleContentTextEl.style.display = hasContent ? 'block' : 'none';
    } else {
      bubbleContentTextEl.textContent = content;
      bubbleContentTextEl.style.display = hasContent ? 'block' : 'none';
    }

    state.bubbleActionHandlers?.clear?.();
    if (Array.isArray(iconButtons) && iconButtons.length) {
      bubbleContentIconEl.innerHTML = '';
      iconButtons.forEach((button, index) => {
        if (!button || !button.iconClass) return;
        const iconButton = document.createElement('button');
        iconButton.type = 'button';
        iconButton.className = `selection-thread-bubble__icon-button${button.className ? ` ${button.className}` : ''}`;
        if (button.title) iconButton.title = button.title;
        const actionId = `bubble_action_${Date.now()}_${index}`;
        iconButton.dataset.actionId = actionId;
        if (typeof button.onClick === 'function') {
          state.bubbleActionHandlers.set(actionId, button.onClick);
        }
        if (button.disabled) {
          iconButton.disabled = true;
          iconButton.classList.add('is-disabled');
        }
        const icon = document.createElement('i');
        icon.className = button.iconClass;
        iconButton.appendChild(icon);
        bubbleContentIconEl.appendChild(iconButton);
      });
      if (iconClass) {
        const icon = document.createElement('i');
        icon.className = `${iconClass} selection-thread-bubble__icon-static`;
        bubbleContentIconEl.appendChild(icon);
      }
      bubbleContentIconEl.style.display = bubbleContentIconEl.childElementCount ? 'flex' : 'none';
    } else if (iconClass) {
      bubbleContentIconEl.innerHTML = '';
      const icon = document.createElement('i');
      icon.className = iconClass;
      bubbleContentIconEl.appendChild(icon);
      bubbleContentIconEl.style.display = 'flex';
    } else {
      bubbleContentIconEl.innerHTML = '';
      bubbleContentIconEl.style.display = 'none';
    }

    bubbleContentEl.style.display = hasContent ? '' : 'none';
    const hasHeaderActions = bubbleContentIconEl.childElementCount > 0;
    bubbleHeaderEl.style.display = (title || hasHeaderActions) ? 'flex' : 'none';

    state.bubbleClickHandler = typeof onClick === 'function' ? onClick : null;
    bubbleEl.classList.toggle('selection-thread-bubble--action', !!state.bubbleClickHandler);
    if (variant) {
      bubbleEl.dataset.variant = variant;
    } else {
      delete bubbleEl.dataset.variant;
    }
    if (state.bubbleClickHandler) {
      bubbleEl.setAttribute('role', 'button');
      bubbleEl.setAttribute('tabindex', '0');
    } else {
      bubbleEl.removeAttribute('role');
      bubbleEl.removeAttribute('tabindex');
    }

    bubbleEl.style.display = 'block';
    bubbleEl.dataset.visible = 'true';
    bubbleEl.dataset.type = type;
    clearBubbleHideAnimationTimer();
    bubbleEl.classList.remove('selection-thread-bubble--hiding');
    bubbleEl.classList.remove('selection-thread-bubble--visible');
    if (type === 'preview') {
      applyPreviewBubbleWidth();
    } else {
      bubbleEl.style.width = '';
      bubbleEl.style.maxWidth = '';
    }
    state.bubblePinned = !!pinned;
    state.bubbleType = type;
    state.bubbleHovered = false;
    clearBubbleHideTimer();

    positionBubble(rect);
    window.requestAnimationFrame(() => {
      if (!bubbleEl || bubbleEl.style.display === 'none') return;
      bubbleEl.classList.add('selection-thread-bubble--visible');
    });
  }

  function applyPreviewBubbleWidth() {
    if (!bubbleEl) return;
    const host = chatContainer;
    if (!host) {
      bubbleEl.style.width = '';
      bubbleEl.style.maxWidth = '';
      return;
    }
    const style = window.getComputedStyle(host);
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingRight = parseFloat(style.paddingRight) || 0;
    const contentWidth = host.clientWidth - paddingLeft - paddingRight;
    if (!Number.isFinite(contentWidth) || contentWidth <= 0) {
      bubbleEl.style.width = '';
      bubbleEl.style.maxWidth = '';
      return;
    }
    const targetWidth = Math.round(contentWidth * 0.7);
    bubbleEl.style.width = `${targetWidth}px`;
    bubbleEl.style.maxWidth = `${targetWidth}px`;
  }

  function positionBubble(rect) {
    if (!bubbleEl || !rect) return;
    const padding = 12;
    // 说明：把 viewport 坐标换算为滚动容器的内容坐标（包含 scrollTop/Left），
    // 这样气泡定位随内容滚动，不再“固定在屏幕上”。
    const host = chatContainer || document.body;
    const hostRect = host.getBoundingClientRect ? host.getBoundingClientRect() : { left: 0, top: 0 };
    const scrollLeft = Number.isFinite(host.scrollLeft) ? host.scrollLeft : 0;
    const scrollTop = Number.isFinite(host.scrollTop) ? host.scrollTop : 0;
    const hostWidth = Number.isFinite(host.clientWidth) ? host.clientWidth : window.innerWidth;
    const hostHeight = Number.isFinite(host.clientHeight) ? host.clientHeight : window.innerHeight;

    const bubbleRect = bubbleEl.getBoundingClientRect();
    const anchorCenterX = rect.left - hostRect.left + scrollLeft + rect.width / 2;
    const anchorTop = rect.top - hostRect.top + scrollTop;
    const anchorBottom = rect.bottom - hostRect.top + scrollTop;
    let left = anchorCenterX - bubbleRect.width / 2;
    let top = anchorTop - bubbleRect.height - 10;
    let placement = 'top';

    const visibleTop = scrollTop + padding;
    const visibleBottom = scrollTop + hostHeight - padding;
    if (top < visibleTop) {
      top = anchorBottom + 10;
      placement = 'bottom';
    }

    const minLeft = scrollLeft + padding;
    const maxLeft = scrollLeft + hostWidth - bubbleRect.width - padding;
    if (Number.isFinite(minLeft) && Number.isFinite(maxLeft)) {
      left = Math.max(minLeft, Math.min(left, maxLeft));
    }

    bubbleEl.style.left = `${Math.round(left)}px`;
    bubbleEl.style.top = `${Math.round(top)}px`;
    bubbleEl.dataset.placement = placement;
  }

  function hideBubble(force = false) {
    if (!bubbleEl) return;
    if (!force && state.bubblePinned) return;
    clearSelectionCollapseTimer();
    clearBubbleHideTimer();
    clearBubbleHideAnimationTimer();
    bubbleEl.dataset.visible = 'false';
    bubbleEl.classList.remove('selection-thread-bubble--visible');
    bubbleEl.classList.add('selection-thread-bubble--hiding');
    bubbleEl.classList.remove('selection-thread-bubble--action');
    state.bubblePinned = false;
    state.bubbleType = 'hidden';
    state.bubbleHovered = false;
    state.highlightHovered = false;
    state.bubbleClickHandler = null;
    state.bubbleActionHandlers?.clear?.();
    const hideDelay = 120;
    state.bubbleHideAnimationTimer = window.setTimeout(() => {
      if (!bubbleEl) return;
      bubbleEl.style.display = 'none';
      bubbleEl.classList.remove('selection-thread-bubble--hiding');
      delete bubbleEl.dataset.variant;
      delete bubbleEl.dataset.placement;
      state.bubbleHideAnimationTimer = null;
    }, hideDelay);
  }

  function isFullscreenLayout() {
    return !!document.documentElement?.classList?.contains('fullscreen-mode');
  }

  function updateThreadPanelTitle(selectionText) {
    const safeText = typeof selectionText === 'string' ? selectionText.trim() : '';
    if (threadBannerTextEl) {
      threadBannerTextEl.textContent = safeText;
    }
    if (threadBannerEl) {
      threadBannerEl.title = safeText || '';
    }
  }

  function resetHiddenMessages() {
    if (!chatContainer) return;
    chatContainer.querySelectorAll('.thread-hidden-message').forEach((node) => {
      node.classList.remove('thread-hidden-message');
    });
  }

  function hideMessagesAfterAnchor(anchorElement) {
    if (!chatContainer || !anchorElement) return;
    let hideFollowing = false;
    const messages = chatContainer.querySelectorAll('.message');
    messages.forEach((message) => {
      if (message === anchorElement) {
        hideFollowing = true;
        return;
      }
      if (hideFollowing) {
        message.classList.add('thread-hidden-message');
      } else {
        message.classList.remove('thread-hidden-message');
      }
    });
  }

  function moveThreadPanelHome() {
    if (!threadPanel) return;
    threadPanel.classList.remove('thread-panel-inline');
    threadPanel.setAttribute('aria-hidden', 'false');
    const parent = threadPanelHome.parent || chatLayout;
    if (!parent) return;
    const expectedNextSibling = (threadPanelHome.nextSibling && threadPanelHome.nextSibling.parentNode === parent)
      ? threadPanelHome.nextSibling
      : null;
    // 仅在位置确实变化时再移动节点，避免无意义 DOM 重排导致线程面板滚动位置抖动。
    const alreadyAtHome = threadPanel.parentNode === parent
      && (
        (expectedNextSibling && threadPanel.nextSibling === expectedNextSibling)
        || (!expectedNextSibling && threadPanel === parent.lastElementChild)
      );
    if (alreadyAtHome) return;
    if (expectedNextSibling) {
      parent.insertBefore(threadPanel, expectedNextSibling);
    } else {
      parent.appendChild(threadPanel);
    }
  }

  function moveThreadPanelInline(anchorElement) {
    if (!threadPanel || !chatContainer || !anchorElement) return;
    threadPanel.classList.add('thread-panel-inline');
    threadPanel.setAttribute('aria-hidden', 'false');
    const expectedNextSibling = anchorElement.nextSibling;
    // 线程面板已经在锚点后方时不再重复插入，避免设置切换时滚动条意外回跳。
    const alreadyInline = threadPanel.parentNode === chatContainer
      && (
        (expectedNextSibling && threadPanel === expectedNextSibling)
        || (!expectedNextSibling && threadPanel === chatContainer.lastElementChild)
      );
    if (alreadyInline) return;
    if (expectedNextSibling) {
      chatContainer.insertBefore(threadPanel, expectedNextSibling);
    } else {
      chatContainer.appendChild(threadPanel);
    }
  }

  function applyThreadLayout() {
    // 线程模式布局策略：
    // - 全屏：线程面板固定在右侧，不隐藏主消息；
    // - 侧栏：线程面板插入锚点之后，并隐藏锚点之后的主消息。
    if (!threadPanel) return;
    const anchorNode = state.activeAnchorMessageId
      ? chatHistoryManager?.chatHistory?.messages?.find(m => m.id === state.activeAnchorMessageId)
      : null;
    const anchorElement = anchorNode ? getMessageElementFromNode(anchorNode) : null;

    if (isFullscreenLayout()) {
      resetHiddenMessages();
      moveThreadPanelHome();
      syncThreadLayoutWidths();
      return;
    }

    if (anchorElement) {
      hideMessagesAfterAnchor(anchorElement);
      moveThreadPanelInline(anchorElement);
    } else {
      resetHiddenMessages();
      moveThreadPanelHome();
    }
  }

  function normalizePath(value) {
    return (value || '').replace(/\\/g, '/');
  }

  function isDirectImageUrl(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return false;
    return /^(file:\/\/|https?:|data:|blob:|chrome-extension:|moz-extension:)/i.test(text);
  }

  function normalizeImageUrlCandidate(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return '';
    if (!/^file:\/\//i.test(text)) return text;
    const lowered = text.toLowerCase();
    const markers = ['data:image/', 'https://', 'http://', 'blob:', 'chrome-extension://', 'moz-extension://'];
    let markerIndex = -1;
    for (const marker of markers) {
      const idx = lowered.indexOf(marker);
      if (idx > 0 && (markerIndex === -1 || idx < markerIndex)) {
        markerIndex = idx;
      }
    }
    if (markerIndex > 0) {
      return text.slice(markerIndex);
    }
    return text;
  }

  async function loadDownloadRoot() {
    if (loadDownloadRoot.cached) return loadDownloadRoot.cached;
    try {
      if (!chrome?.storage?.local?.get) return null;
      const res = await chrome.storage.local.get(['image_download_root']);
      const root = res?.image_download_root;
      if (root && typeof root === 'string') {
        loadDownloadRoot.cached = normalizePath(root).replace(/\/+$/, '') + '/';
        return loadDownloadRoot.cached;
      }
    } catch (_) {}
    return null;
  }

  function buildFileUrlFromRelative(relPath, rootPath) {
    if (!relPath) return null;
    const raw = normalizeImageUrlCandidate(relPath);
    if (!raw) return null;
    if (isDirectImageUrl(raw)) return raw;
    const normalizedRaw = normalizePath(raw).trim();
    if (!normalizedRaw) return null;
    if (/^[A-Za-z]:\//.test(normalizedRaw)) {
      return `file:///${normalizedRaw}`;
    }
    if (normalizedRaw.startsWith('/')) {
      return `file://${normalizedRaw}`;
    }
    const root = normalizePath(rootPath || '');
    const rel = normalizedRaw.replace(/^\/+/, '');
    if (!root) return rel;
    const full = `${root}${rel}`;
    let normalized = normalizePath(full);
    if (/^[A-Za-z]:\//.test(normalized)) {
      normalized = '/' + normalized;
    } else if (!normalized.startsWith('/')) {
      normalized = '/' + normalized;
    }
    return `file://${normalized}`;
  }

  async function resolveImageUrlForDisplay(imageUrlObj) {
    if (!imageUrlObj) return '';
    const rawUrl = normalizeImageUrlCandidate(imageUrlObj.url);
    const rawPath = normalizeImageUrlCandidate(imageUrlObj.path);
    if (isDirectImageUrl(rawUrl)) return rawUrl;
    if (isDirectImageUrl(rawPath)) return rawPath;
    const relPath = rawPath || rawUrl;
    if (relPath) {
      const root = await loadDownloadRoot();
      const fileUrl = root ? buildFileUrlFromRelative(relPath, root) : null;
      return fileUrl || relPath;
    }
    return rawUrl || rawPath || '';
  }

  function extractInlineImgSrcs(html) {
    const set = new Set();
    if (typeof html !== 'string' || !html.includes('<img')) return set;
    const re = /<img\b[^>]*\bsrc\s*=\s*(['"])(.*?)\1/gi;
    let m = null;
    while ((m = re.exec(html)) !== null) {
      const src = m[2] || '';
      if (src) set.add(src);
    }
    return set;
  }

  function renderApiFooterForNode(messageElem, node) {
    if (!messageElem || !node || node.role !== 'assistant') return;
    const footer = messageElem.querySelector('.api-footer') || (() => {
      const f = document.createElement('div');
      f.className = 'api-footer';
      messageElem.appendChild(f);
      return f;
    })();

    const allConfigs = apiManager?.getAllConfigs?.() || [];
    const footerTemplate = settingsManager?.getSetting?.('aiFooterTemplate');
    const footerInlineSeparator = settingsManager?.getSetting?.('aiFooterInlineSeparator');
    const footerTooltipTemplate = settingsManager?.getSetting?.('aiFooterTooltipTemplate');
    const renderData = buildApiFooterRenderData(node, {
      allConfigs,
      template: footerTemplate,
      inlineSeparator: footerInlineSeparator,
      tooltipTemplate: footerTooltipTemplate
    });
    footer.textContent = renderData.text;
    footer.title = renderData.title;
  }

  function collectThreadChain(annotation) {
    // 通过 parentId 从最后一条回溯到 root，保证线程消息顺序可控
    if (!annotation?.rootMessageId) return [];
    const rootId = annotation.rootMessageId;
    const lastId = annotation.lastMessageId || rootId;
    const chain = [];
    let currentId = lastId;

    while (currentId) {
      const node = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === currentId);
      if (!node) break;
      chain.unshift(node);
      if (currentId === rootId) break;
      currentId = node.parentId;
    }

    if (chain.length && chain[0].id !== rootId) {
      const rootNode = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === rootId);
      if (rootNode) chain.unshift(rootNode);
    }
    return chain;
  }

  function stripHtmlToText(html) {
    if (typeof html !== 'string' || !html) return '';
    const container = document.createElement('div');
    container.innerHTML = html;
    return (container.textContent || '').trim();
  }

  function summarizePreviewText(text, maxLength = 80) {
    const safe = (typeof text === 'string' ? text : '').replace(/\s+/g, ' ').trim();
    if (!safe) return '';
    if (safe.length <= maxLength) return safe;
    return `${safe.slice(0, maxLength)}…`;
  }

  function renderPreviewMarkdownToElement(target, text) {
    if (!target) return;
    const content = typeof text === 'string' ? text : '';
    if (messageProcessor?.processMathAndMarkdown) {
      target.innerHTML = messageProcessor.processMathAndMarkdown(content);
      messageProcessor.enhanceMarkdownContent?.(target, { forceMermaid: true, updateLayout: false });
    } else {
      target.textContent = content;
    }
  }

  function extractPlainTextFromContent(content) {
    const normalized = normalizeStoredMessageContent(content);
    if (Array.isArray(normalized)) {
      const { text } = splitStoredMessageContent(normalized);
      return summarizePreviewText(stripHtmlToText(text || ''));
    }
    return summarizePreviewText(stripHtmlToText(normalized || ''));
  }

  function formatRelativeTimeFallback(date) {
    const now = new Date();
    const diff = now - date;
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return `${seconds}秒前`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    return `${days}天前`;
  }

  function formatRelativeTimeWithHistoryLogic(date) {
    const formatter = (chatHistoryUI && typeof chatHistoryUI.formatRelativeTime === 'function')
      ? chatHistoryUI.formatRelativeTime
      : formatRelativeTimeFallback;
    try {
      return formatter(date);
    } catch (_) {
      return formatRelativeTimeFallback(date);
    }
  }

  function formatThreadRelativeTimeSpan(annotation, chain = []) {
    const validChain = Array.isArray(chain) && chain.length ? chain : collectThreadChain(annotation);
    const timestamps = validChain
      .map(node => Number(node?.timestamp))
      .filter(ts => Number.isFinite(ts) && ts > 0);
    const fallbackTs = Number(annotation?.createdAt) || 0;
    const startTs = timestamps.length ? Math.min(...timestamps) : fallbackTs;
    const endTs = timestamps.length ? Math.max(...timestamps) : fallbackTs;
    if (!startTs && !endTs) return '';
    const startDate = new Date(startTs || endTs);
    const endDate = new Date(endTs || startTs);
    const startText = formatRelativeTimeWithHistoryLogic(startDate);
    const endText = formatRelativeTimeWithHistoryLogic(endDate);
    return startText === endText ? startText : `${startText} - ${endText}`;
  }

  function getThreadActivityTimestamp(annotation) {
    if (!annotation) return 0;
    const candidateId = annotation.lastMessageId || annotation.rootMessageId || '';
    const node = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === candidateId);
    if (node && Number.isFinite(node.timestamp)) {
      return node.timestamp;
    }
    return Number(annotation.createdAt || 0) || 0;
  }

  function sortThreadsByActivity(threads) {
    if (!Array.isArray(threads)) return [];
    return threads.slice().sort((a, b) => getThreadActivityTimestamp(b) - getThreadActivityTimestamp(a));
  }

  function buildThreadSummaryItems(threads) {
    if (!Array.isArray(threads) || !threads.length) return [];
    const sorted = sortThreadsByActivity(threads);
    return sorted.map((annotation) => {
      const chain = collectThreadChain(annotation)
        .filter(node => !node?.threadHiddenSelection);
      const count = chain.length;
      const timeSpan = formatThreadRelativeTimeSpan(annotation, chain);
      let lastUserText = '';
      for (let i = chain.length - 1; i >= 0; i--) {
        const node = chain[i];
        if (node?.role === 'user') {
          lastUserText = extractPlainTextFromContent(node.content);
          break;
        }
      }
      if (!lastUserText) {
        lastUserText = '(暂无用户提问)';
      }
      const summaryParts = [`共 ${count} 条`];
      if (timeSpan) {
        summaryParts.push(timeSpan);
      }
      summaryParts.push(lastUserText);
      return {
        threadId: annotation.id,
        variant: 'thread',
        text: summaryParts.join(' · ')
      };
    });
  }

  function buildThreadPreviewLines(threadId, maxItems = 3) {
    const info = findThreadById(threadId);
    if (!info || !info.annotation) return [];
    const chain = collectThreadChain(info.annotation)
      .filter(node => !node?.threadHiddenSelection);
    if (!chain.length) return [];

    const sliced = chain.slice(-Math.max(1, maxItems));
    return sliced.map((node) => {
      const roleLabel = node.role === 'assistant' ? 'AI' : '用户';
      const text = extractPlainTextFromContent(node.content);
      return text ? `${roleLabel}: ${text}` : `${roleLabel}: (空)`;
    });
  }

  function buildThreadPreviewItems(threadId) {
    const info = findThreadById(threadId);
    if (!info || !info.annotation) return [];
    const chain = collectThreadChain(info.annotation)
      .filter(node => !node?.threadHiddenSelection);
    if (!chain.length) return [];

    return chain.map((node) => {
      const normalized = normalizeStoredMessageContent(node.content);
      let text = '';
      if (Array.isArray(normalized)) {
        const { text: extractedText } = splitStoredMessageContent(normalized);
        text = extractedText || '';
      } else {
        text = normalized || '';
      }
      const safeText = typeof text === 'string' ? text : '';
      return {
        messageId: node.id,
        role: node.role || '',
        text: safeText.trim() ? safeText : '(空)'
      };
    });
  }

  function parseThreadIdsFromHighlight(target) {
    if (!target) return [];
    const raw = target.dataset.threadIds || target.dataset.threadId || '';
    return raw.split(',').map(item => item.trim()).filter(Boolean);
  }

  function syncActiveThreadHighlightState() {
    if (!chatContainer) return;
    const activeThreadId = state.activeThreadId || '';
    const highlights = chatContainer.querySelectorAll('.thread-highlight');
    highlights.forEach((node) => {
      const threadIds = parseThreadIdsFromHighlight(node);
      const isActive = !!(activeThreadId && threadIds.includes(activeThreadId));
      node.classList.toggle('thread-highlight--active-thread', isActive);
    });
  }

  function buildSelectionInfoFromHighlight(target) {
    const selectionText = target?.dataset?.selectionText || target?.textContent || '';
    const matchIndex = Number.isFinite(Number(target?.dataset?.matchIndex))
      ? Number(target.dataset.matchIndex)
      : null;
    const selectionStartOffset = Number.isFinite(Number(target?.dataset?.selectionStartOffset))
      ? Number(target.dataset.selectionStartOffset)
      : null;
    const selectionEndOffset = Number.isFinite(Number(target?.dataset?.selectionEndOffset))
      ? Number(target.dataset.selectionEndOffset)
      : null;
    return {
      selectionText,
      matchIndex,
      selectionStartOffset,
      selectionEndOffset
    };
  }

  function pickPrimaryThread(threads) {
    const sorted = sortThreadsByActivity(threads);
    return sorted[0] || null;
  }

  function renderThreadSelectionBanner(selectionText) {
    if (!threadContainer) return;
    const banner = document.createElement('div');
    banner.className = 'thread-selection-banner';
    banner.title = (selectionText || '').trim();

    const header = document.createElement('div');
    header.className = 'thread-selection-banner__header';

    const leftActions = document.createElement('div');
    leftActions.className = 'thread-selection-banner__actions thread-selection-banner__actions--left';

    const label = document.createElement('div');
    label.className = 'thread-selection-banner__label';
    label.textContent = '划词内容';

    const actions = document.createElement('div');
    actions.className = 'thread-selection-banner__actions thread-selection-banner__actions--right';

    const confirmButton = document.createElement('button');
    confirmButton.className = 'thread-selection-banner__button thread-selection-banner__button--confirm';
    confirmButton.setAttribute('type', 'button');
    confirmButton.innerHTML = '<i class="fa-solid fa-check"></i>';
    confirmButton.setAttribute('aria-label', '确认删除线程');
    confirmButton.title = '确认删除线程';
    confirmButton.style.display = 'none';

    const deleteButton = document.createElement('button');
    deleteButton.className = 'thread-selection-banner__button thread-selection-banner__button--delete';
    deleteButton.setAttribute('type', 'button');
    deleteButton.innerHTML = '<i class="fa-solid fa-trash"></i>';
    deleteButton.setAttribute('aria-label', '删除线程');
    deleteButton.title = '删除线程';
    const resetDeleteConfirm = () => {
      confirmButton.style.display = 'none';
      deleteButton.innerHTML = '<i class="fa-solid fa-trash"></i>';
      deleteButton.title = '删除线程';
      deleteButton.dataset.confirmArmed = 'false';
    };
    // 两段式确认：先点击“删除”露出左侧确认按钮，再移动鼠标点击确认按钮执行删除。
    deleteButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const isArmed = deleteButton.dataset.confirmArmed === 'true';
      if (isArmed) {
        resetDeleteConfirm();
        return;
      }
      deleteButton.dataset.confirmArmed = 'true';
      deleteButton.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      deleteButton.title = '取消删除';
      confirmButton.style.display = 'inline-flex';
    });

    confirmButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      resetDeleteConfirm();
      deleteActiveThread();
    });

    const exitButton = document.createElement('button');
    exitButton.className = 'thread-selection-banner__button thread-selection-banner__button--exit';
    exitButton.setAttribute('type', 'button');
    exitButton.innerHTML = '<i class="fa-solid fa-arrow-left"></i>';
    exitButton.setAttribute('aria-label', '退出线程');
    exitButton.title = '退出线程';
    exitButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      resetDeleteConfirm();
      exitThread();
    });

    leftActions.appendChild(exitButton);
    actions.appendChild(confirmButton);
    actions.appendChild(deleteButton);

    header.appendChild(leftActions);
    header.appendChild(label);
    header.appendChild(actions);

    const text = document.createElement('div');
    text.className = 'thread-selection-banner__text';
    text.textContent = (selectionText || '').trim();

    banner.appendChild(header);
    banner.appendChild(text);
    threadContainer.appendChild(banner);

    threadBannerEl = banner;
    threadBannerTextEl = text;
    state.bannerHovered = false;
    state.bannerTopEdgeActive = false;
    state.bannerScrollAtTop = true;
    banner.addEventListener('mouseenter', handleThreadBannerMouseEnter);
    banner.addEventListener('mouseleave', handleThreadBannerMouseLeave);
    if (!threadScrollListenerBound && threadContainer) {
      threadContainer.addEventListener('scroll', handleThreadContainerScroll, { passive: true });
      threadScrollListenerBound = true;
    }
    updateThreadBannerScrollState();
    updateThreadBannerPeek();
  }

  async function renderThreadMessages(threadId, options = {}) {
    // 将线程链路渲染到线程面板，仅用于展示，不写回历史
    if (!threadContainer || !messageProcessor) return;
    if (state.activeThreadId !== threadId) return;
    const focusMessageId = options?.focusMessageId || '';
    threadContainer.classList.add('thread-container--static');
    threadContainer.innerHTML = '';
    const info = findThreadById(threadId);
    if (!info || !info.annotation) return;

    const chain = collectThreadChain(info.annotation)
      .filter(node => !node?.threadHiddenSelection);
    renderThreadSelectionBanner(info.annotation?.selectionText || '');
    if (!chain.length) return;

    const fragment = document.createDocumentFragment();
    for (const node of chain) {
      if (state.activeThreadId !== threadId) return;
      const role = node.role === 'assistant' ? 'ai' : node.role;
      const normalizedContent = normalizeStoredMessageContent(node.content);
      const thoughtsToDisplay = node.thoughtsRaw || null;
      let messageElem = null;

      if (Array.isArray(normalizedContent)) {
        const { text, images } = splitStoredMessageContent(normalizedContent);
        let combinedContent = text || '';
        const displayUrls = [];

        for (const imageUrlObj of images) {
          const resolved = await resolveImageUrlForDisplay(imageUrlObj);
          const fallback = imageUrlObj?.url || imageUrlObj?.path || '';
          const url = (resolved || fallback || '').trim();
          if (url) displayUrls.push(url);
        }

        const uniqueDisplayUrls = Array.from(new Set(displayUrls));
        if (role === 'ai') {
          const existingSrcs = extractInlineImgSrcs(combinedContent);
          const inlineHtml = uniqueDisplayUrls
            .filter((u) => u && !existingSrcs.has(u))
            .map((u) => {
              const safeUrl = String(u).replace(/"/g, '&quot;');
              return `\n<img class="ai-inline-image" src="${safeUrl}" alt="加载的图片" />\n`;
            })
            .join('');
          combinedContent = combinedContent + inlineHtml;
          messageElem = messageProcessor.appendMessage(
            combinedContent,
            role,
            true,
            fragment,
            null,
            thoughtsToDisplay,
            null,
            null,
            { container: threadContainer }
          );
        } else {
          const legacyImagesContainer = document.createElement('div');
          uniqueDisplayUrls.forEach((u) => {
            const imageTag = imageHandler?.createImageTag ? imageHandler.createImageTag(u, null) : null;
            if (imageTag) legacyImagesContainer.appendChild(imageTag);
          });
          const imagesHTML = legacyImagesContainer.innerHTML;
          messageElem = messageProcessor.appendMessage(
            combinedContent,
            role,
            true,
            fragment,
            imagesHTML,
            thoughtsToDisplay,
            null,
            null,
            { container: threadContainer }
          );
        }
      } else {
        messageElem = messageProcessor.appendMessage(
          normalizedContent,
          role,
          true,
          fragment,
          null,
          thoughtsToDisplay,
          null,
          null,
          { container: threadContainer }
        );
      }

      if (messageElem) {
        messageElem.classList.remove('batch-load');
        messageElem.classList.add('thread-jump-skip-animation');
        messageElem.setAttribute('data-message-id', node.id);
        renderApiFooterForNode(messageElem, node);
      }
    }

    threadContainer.appendChild(fragment);
    if (focusMessageId) {
      requestAnimationFrame(() => {
        scrollThreadMessageIntoView(focusMessageId);
      });
    }
  }

  function getMessageElementFromNode(node) {
    if (!node) return null;
    const messageId = node.id || '';
    if (!messageId) return null;
    const selector = buildMessageSelector(messageId);
    if (!selector) return null;
    return chatContainer?.querySelector(selector) || null;
  }

  function buildMessageSelector(messageId) {
    const raw = (messageId == null) ? '' : String(messageId);
    if (!raw) return '';
    try {
      if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        return `.message[data-message-id="${CSS.escape(raw)}"]`;
      }
    } catch (_) {}
    const safeId = raw.replace(/["\\]/g, '\\$&');
    return `.message[data-message-id="${safeId}"]`;
  }

  function ensureThreadAnnotations(node) {
    if (!node) return [];
    if (!Array.isArray(node.threadAnnotations)) {
      node.threadAnnotations = [];
    }
    return node.threadAnnotations;
  }

  function removeThreadAnnotationFromAnchor(anchorNode, threadId) {
    if (!anchorNode || !threadId) return false;
    if (!Array.isArray(anchorNode.threadAnnotations)) return false;
    const beforeCount = anchorNode.threadAnnotations.length;
    anchorNode.threadAnnotations = anchorNode.threadAnnotations.filter(item => item?.id !== threadId);
    return anchorNode.threadAnnotations.length !== beforeCount;
  }

  function buildThreadId() {
    return `thread_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // 过滤 Markdown 预处理插入的零宽字符，避免划词索引与渲染文本错位。
  const ZERO_WIDTH_REGEX = /[\u200B\u200C\u200D\uFEFF]/g;
  const ZERO_WIDTH_CHARS = new Set(['\u200B', '\u200C', '\u200D', '\uFEFF']);

  // 仅移除零宽字符，不做 trim，保证长度与索引可预测。
  function stripZeroWidth(text) {
    if (typeof text !== 'string') return '';
    return text.replace(ZERO_WIDTH_REGEX, '');
  }

  // 划词文本统一规范化：移除零宽字符并去除首尾空白，便于匹配。
  function normalizeSelectionText(text) {
    return stripZeroWidth(text).trim();
  }

  // 构建“可见文本”到原始文本的索引映射，便于恢复 DOM Range。
  function buildNormalizedTextMap(text) {
    if (!text) return { normalizedText: '', indexMap: [] };
    const normalizedChars = [];
    const indexMap = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ZERO_WIDTH_CHARS.has(ch)) continue;
      indexMap.push(i);
      normalizedChars.push(ch);
    }
    return { normalizedText: normalizedChars.join(''), indexMap };
  }

  // 将规范化后的索引映射回原始文本索引，失败时返回 null。
  function mapNormalizedIndexToOriginal(indexMap, normalizedIndex) {
    if (!Array.isArray(indexMap)) return null;
    if (!Number.isFinite(normalizedIndex)) return null;
    if (normalizedIndex < 0 || normalizedIndex >= indexMap.length) return null;
    return indexMap[normalizedIndex];
  }

  function findThreadById(threadId) {
    if (!threadId) return null;
    const messages = chatHistoryManager?.chatHistory?.messages || [];
    for (const msg of messages) {
      const annotations = Array.isArray(msg?.threadAnnotations) ? msg.threadAnnotations : [];
      const found = annotations.find(item => item?.id === threadId);
      if (found) {
        return { anchorMessageId: msg.id, annotation: found };
      }
    }
    return null;
  }

  function refreshThreadOverviewDrawerSafely() {
    const refresh = chatHistoryUI?.refreshActiveConversationThreadOverviewDrawer;
    if (typeof refresh !== 'function') return;
    try {
      refresh();
    } catch (error) {
      console.warn('[selection_thread_manager] 刷新线程总览失败:', error);
    }
  }

  function findThreadBySelection(anchorNode, selectionText, matchIndex = null, selectionStartOffset = null) {
    const threads = findThreadsBySelection(anchorNode, selectionText, matchIndex, selectionStartOffset);
    return threads.length ? threads[0] : null;
  }

  function findThreadsBySelection(anchorNode, selectionText, matchIndex = null, selectionStartOffset = null) {
    if (!anchorNode || !selectionText) return [];
    const annotations = Array.isArray(anchorNode.threadAnnotations) ? anchorNode.threadAnnotations : [];
    const normalizedText = normalizeSelectionText(selectionText);
    if (!normalizedText) return [];

    if (Number.isFinite(selectionStartOffset)) {
      const targetOffset = Math.max(0, selectionStartOffset);
      const byOffset = annotations.filter(item => (
        normalizeSelectionText(item?.selectionText || '') === normalizedText
        && Number.isFinite(item?.selectionStartOffset)
        && item.selectionStartOffset === targetOffset
      ));
      if (byOffset.length) return byOffset;
    }

    if (matchIndex == null) {
      return annotations.filter(item => normalizeSelectionText(item?.selectionText || '') === normalizedText);
    }
    return annotations.filter(item => (
      normalizeSelectionText(item?.selectionText || '') === normalizedText
      && item?.matchIndex === matchIndex
    ));
  }

  function createThreadAnnotation(anchorNode, info) {
    if (!anchorNode || !info || !info.selectionText) return null;
    const normalizedSelectionText = normalizeSelectionText(info.selectionText);
    if (!normalizedSelectionText) return null;
    const annotations = ensureThreadAnnotations(anchorNode);
    const threadId = buildThreadId();
    const selectionStartOffset = Number.isFinite(info.selectionStartOffset)
      ? Math.max(0, info.selectionStartOffset)
      : null;
    const selectionEndOffset = Number.isFinite(info.selectionEndOffset)
      ? Math.max(0, info.selectionEndOffset)
      : null;
    const payload = {
      id: threadId,
      anchorMessageId: anchorNode.id,
      selectionText: normalizedSelectionText,
      matchIndex: Number.isFinite(info.matchIndex) ? info.matchIndex : 0,
      // 记录选区在“规范化文本”中的偏移，兜底用于复杂格式/多节点文本的定位。
      selectionStartOffset,
      selectionEndOffset,
      createdAt: Date.now(),
      rootMessageId: null,
      lastMessageId: null
    };
    annotations.push(payload);
    return payload;
  }

  /**
   * 修复/补齐线程注解的根节点与末尾节点，避免删除/重生成后链路断裂。
   * 规则：
   * - rootMessageId 缺失时优先使用 threadHiddenSelection 标记的节点；
   * - lastMessageId 缺失或不可达时，选取“线程内无后继”的最新节点。
   *
   * @param {string} threadId
   * @returns {Object|null} 返回修复后的 annotation（同一引用），失败则返回 null
   */
  function repairThreadAnnotation(threadId) {
    if (!threadId) return null;
    const info = findThreadById(threadId);
    if (!info || !info.annotation) return null;

    const annotation = info.annotation;
    const nodes = chatHistoryManager?.chatHistory?.messages || [];
    if (!nodes.length) return annotation;

    const findNode = (id) => nodes.find(n => n.id === id) || null;
    const hasNode = (id) => !!(id && findNode(id));

    const rawRootId = annotation.rootMessageId;
    let resolvedRootId = hasNode(rawRootId) ? rawRootId : null;
    const threadNodes = nodes.filter((node) => {
      if (!node) return false;
      if (node.threadId === threadId) return true;
      if (rawRootId && node.threadRootId === rawRootId) return true;
      if (resolvedRootId && node.threadRootId === resolvedRootId) return true;
      return false;
    });

    if (!resolvedRootId) {
      const hiddenRoot = threadNodes.find(n => n.threadHiddenSelection);
      if (hiddenRoot) {
        resolvedRootId = hiddenRoot.id;
      } else if (threadNodes.length) {
        const oldest = threadNodes.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))[0];
        resolvedRootId = oldest?.id || null;
      }
    }

    if (resolvedRootId && resolvedRootId !== annotation.rootMessageId) {
      annotation.rootMessageId = resolvedRootId;
    }

    const threadIdSet = new Set(threadNodes.map(n => n.id));
    if (resolvedRootId) threadIdSet.add(resolvedRootId);

    const isReachableFromRoot = (startId) => {
      if (!resolvedRootId || !startId) return false;
      const visited = new Set();
      let currentId = startId;
      while (currentId) {
        if (currentId === resolvedRootId) return true;
        if (visited.has(currentId)) break;
        visited.add(currentId);
        const currentNode = findNode(currentId);
        currentId = currentNode?.parentId || null;
      }
      return false;
    };

    const lastNode = hasNode(annotation.lastMessageId) ? findNode(annotation.lastMessageId) : null;
    const lastValid = !!(lastNode && threadIdSet.has(lastNode.id) && isReachableFromRoot(lastNode.id));
    if (!lastValid) {
      const leafCandidates = threadNodes.filter((node) => {
        const children = Array.isArray(node.children) ? node.children : [];
        return !children.some(childId => threadIdSet.has(childId));
      });
      if (leafCandidates.length) {
        const latest = leafCandidates.slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
        annotation.lastMessageId = latest?.id || resolvedRootId || null;
      } else {
        annotation.lastMessageId = resolvedRootId || null;
      }
    }

    return annotation;
  }

  function getSelectionInfoFromRange(range, messageElement) {
    if (!range || !messageElement) return null;
    const textContainer = messageElement.querySelector('.text-content');
    if (!textContainer || !textContainer.contains(range.startContainer) || !textContainer.contains(range.endContainer)) {
      return null;
    }

    const rawText = range.toString();
    const selectionText = normalizeSelectionText(rawText || '');
    if (!selectionText) return null;

    let startOffset = 0;
    try {
      const preRange = document.createRange();
      preRange.selectNodeContents(textContainer);
      preRange.setEnd(range.startContainer, range.startOffset);
      startOffset = stripZeroWidth(preRange.toString()).length;
    } catch (_) {
      startOffset = 0;
    }

    const fullText = textContainer.textContent || '';
    const normalizedFullText = stripZeroWidth(fullText);
    const matchIndex = findClosestOccurrenceIndex(normalizedFullText, selectionText, startOffset);
    const selectionStartOffset = Math.max(0, startOffset);
    const selectionEndOffset = selectionStartOffset + selectionText.length;

    return {
      selectionText,
      matchIndex,
      selectionStartOffset,
      selectionEndOffset,
      fullTextLength: normalizedFullText.length
    };
  }

  function findClosestOccurrenceIndex(fullText, selectionText, startOffset) {
    if (!fullText || !selectionText) return 0;
    const positions = [];
    let pos = fullText.indexOf(selectionText);
    while (pos >= 0) {
      positions.push(pos);
      pos = fullText.indexOf(selectionText, pos + selectionText.length);
    }
    if (!positions.length) return 0;

    let bestIndex = 0;
    let bestDistance = Number.MAX_SAFE_INTEGER;
    positions.forEach((p, idx) => {
      const distance = Math.abs(p - startOffset);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = idx;
      }
    });
    return bestIndex;
  }

  function unwrapThreadHighlights(container) {
    if (!container) return;
    const highlights = container.querySelectorAll('.thread-highlight');
    highlights.forEach((el) => {
      const text = document.createTextNode(el.textContent || '');
      el.replaceWith(text);
    });
  }

  function findNthOccurrence(fullText, selectionText, matchIndex) {
    if (!fullText || !selectionText) return -1;
    const targetIndex = Math.max(0, Number(matchIndex) || 0);
    let count = 0;
    let pos = fullText.indexOf(selectionText);
    while (pos >= 0) {
      if (count === targetIndex) return pos;
      count += 1;
      pos = fullText.indexOf(selectionText, pos + selectionText.length);
    }
    return -1;
  }

  function resolveRangeFromIndices(container, startIndex, endIndex) {
    if (!container || startIndex < 0 || endIndex <= startIndex) return null;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node || !node.nodeValue) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest('.thread-highlight')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let currentIndex = 0;
    let startNode = null;
    let startOffset = 0;
    let endNode = null;
    let endOffset = 0;

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.nodeValue || '';
      const nextIndex = currentIndex + text.length;

      if (!startNode && startIndex >= currentIndex && startIndex <= nextIndex) {
        startNode = node;
        startOffset = startIndex - currentIndex;
      }
      if (!endNode && endIndex >= currentIndex && endIndex <= nextIndex) {
        endNode = node;
        endOffset = endIndex - currentIndex;
        break;
      }
      currentIndex = nextIndex;
    }

    if (!startNode || !endNode) return null;
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  }

  function wrapRangeWithSpan(range, span) {
    if (!range || !span) return false;
    try {
      range.surroundContents(span);
      return true;
    } catch (error) {
      const node = range.startContainer;
      if (node && node === range.endContainer && node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue || '';
        const start = range.startOffset;
        const end = range.endOffset;
        const before = document.createTextNode(text.slice(0, start));
        const middle = document.createTextNode(text.slice(start, end));
        const after = document.createTextNode(text.slice(end));
        span.appendChild(middle);
        const parent = node.parentNode;
        if (!parent) return false;
        parent.insertBefore(before, node);
        parent.insertBefore(span, node);
        parent.insertBefore(after, node);
        parent.removeChild(node);
        return true;
      }
    }
    // 多节点/复杂结构 fallback：逐个文本节点包裹，避免 <strong>/<em> 等分割导致 surroundContents 失败。
    try {
      // 跳过表格/列表容器中的空白文本节点，避免插入无效节点导致布局错乱。
      const HIGHLIGHT_SKIP_PARENTS = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'COLGROUP', 'COL', 'UL', 'OL', 'DL']);
      const shouldSkipNode = (node) => {
        if (!node || !node.nodeValue) return true;
        const parent = node.parentElement;
        if (!parent) return true;
        if (HIGHLIGHT_SKIP_PARENTS.has(parent.tagName)) return true;
        const trimmed = stripZeroWidth(node.nodeValue).trim();
        return !trimmed;
      };
      const textNodes = [];
      const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node || !node.nodeValue) return NodeFilter.FILTER_REJECT;
          if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
          if (node.parentElement?.closest('.thread-highlight')) return NodeFilter.FILTER_REJECT;
          if (shouldSkipNode(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });

      while (walker.nextNode()) {
        textNodes.push(walker.currentNode);
      }

      if (!textNodes.length) return false;

      const wrapTextNodeRange = (targetNode, startOffset, endOffset, template) => {
        const text = targetNode.nodeValue || '';
        const safeStart = Math.max(0, Math.min(startOffset, text.length));
        const safeEnd = Math.max(safeStart, Math.min(endOffset, text.length));
        if (safeEnd <= safeStart) return false;
        const before = document.createTextNode(text.slice(0, safeStart));
        const middle = document.createTextNode(text.slice(safeStart, safeEnd));
        const after = document.createTextNode(text.slice(safeEnd));
        const parent = targetNode.parentNode;
        if (!parent || (parent.tagName && HIGHLIGHT_SKIP_PARENTS.has(parent.tagName))) return false;
        template.appendChild(middle);
        parent.insertBefore(before, targetNode);
        parent.insertBefore(template, targetNode);
        parent.insertBefore(after, targetNode);
        parent.removeChild(targetNode);
        return true;
      };

      let wrappedAny = false;
      textNodes.forEach((node, index) => {
        const isStart = node === range.startContainer;
        const isEnd = node === range.endContainer;
        const startOffset = isStart ? range.startOffset : 0;
        const endOffset = isEnd ? range.endOffset : (node.nodeValue || '').length;
        if (startOffset === 0 && endOffset === 0) return;
        const spanClone = span.cloneNode(false);
        const didWrap = wrapTextNodeRange(node, startOffset, endOffset, spanClone);
        if (didWrap) wrappedAny = true;
      });

      return wrappedAny;
    } catch (_) {}
    return false;
  }

  function scrollThreadMessageIntoView(messageId) {
    if (!threadContainer || !messageId) return;
    const selector = buildMessageSelector(messageId);
    const target = selector ? threadContainer.querySelector(selector) : null;
    if (!target) return;
    const applyScroll = () => {
      if (!threadContainer || !target) return;
      const containerRect = threadContainer.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const style = window.getComputedStyle(threadContainer);
      const paddingTop = parseFloat(style.paddingTop) || 0;
      const delta = targetRect.top - containerRect.top;
      const rawTop = threadContainer.scrollTop + delta - paddingTop;
      const maxTop = Math.max(0, threadContainer.scrollHeight - threadContainer.clientHeight);
      const nextTop = Math.max(0, Math.min(rawTop, maxTop));
      threadContainer.scrollTo({ top: nextTop, behavior: 'auto' });
    };

    applyScroll();
    requestAnimationFrame(applyScroll);

    const refreshAfterImages = () => applyScroll();
    const images = target.querySelectorAll('img');
    if (images.length) {
      let pending = 0;
      images.forEach((img) => {
        if (img.complete) return;
        pending += 1;
        const onDone = () => {
          pending -= 1;
          if (pending <= 0) {
            refreshAfterImages();
          }
        };
        img.addEventListener('load', onDone, { once: true });
        img.addEventListener('error', onDone, { once: true });
      });
    }

    target.classList.remove('thread-jump-highlight');
    void target.offsetWidth;
    target.classList.add('thread-jump-highlight');
    setTimeout(() => target.classList.remove('thread-jump-highlight'), 500);
  }

  function buildAnnotationHighlightRanges(textContainer, annotations) {
    if (!textContainer || !annotations.length) return [];
    const fullText = textContainer.textContent || '';
    const { normalizedText, indexMap } = buildNormalizedTextMap(fullText);
    if (!normalizedText) return [];
    // 同一选区允许多个线程，按起止位置分组，避免重复包裹导致嵌套高亮。
    const grouped = new Map();

    annotations.forEach((annotation) => {
      const selectionText = normalizeSelectionText(annotation?.selectionText || '');
      if (!selectionText) return;
      const matchIndex = Number.isFinite(annotation.matchIndex) ? annotation.matchIndex : 0;
      const hasOffsets = Number.isFinite(annotation.selectionStartOffset)
        && Number.isFinite(annotation.selectionEndOffset)
        && annotation.selectionEndOffset > annotation.selectionStartOffset;
      let startPos = hasOffsets ? Math.max(0, annotation.selectionStartOffset) : -1;
      let endPos = hasOffsets
        ? Math.max(0, annotation.selectionEndOffset)
        : -1;

      if (!hasOffsets || endPos <= startPos || startPos >= normalizedText.length) {
        startPos = findNthOccurrence(normalizedText, selectionText, matchIndex);
        if (startPos < 0) return;
        endPos = startPos + selectionText.length;
      }

      if (endPos > normalizedText.length) {
        endPos = Math.min(normalizedText.length, endPos);
        if (endPos <= startPos) return;
      }

      const mappedStart = mapNormalizedIndexToOriginal(indexMap, startPos);
      const mappedEnd = mapNormalizedIndexToOriginal(indexMap, endPos - 1);
      if (!Number.isFinite(mappedStart) || !Number.isFinite(mappedEnd)) return;
      if (mappedEnd + 1 <= mappedStart) return;
      const key = `${mappedStart}:${mappedEnd + 1}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          startPos: mappedStart,
          endPos: mappedEnd + 1,
          annotations: []
        });
      }
      grouped.get(key).annotations.push(annotation);
    });

    return Array.from(grouped.values());
  }

  function applyHighlightRange(textContainer, rangeGroup) {
    if (!textContainer || !rangeGroup) return;
    const { annotations, startPos, endPos } = rangeGroup;
    if (!Array.isArray(annotations) || !annotations.length) return;
    if (startPos < 0 || endPos <= startPos) return;
    const range = resolveRangeFromIndices(textContainer, startPos, endPos);
    if (!range) return;

    const span = document.createElement('span');
    span.className = 'thread-highlight';
    const primary = annotations[0];
    const threadIds = annotations.map(item => item?.id).filter(Boolean);
    if (threadIds.length) {
      span.dataset.threadIds = threadIds.join(',');
      span.dataset.threadId = threadIds[0];
      span.dataset.threadCount = String(threadIds.length);
    }
    span.dataset.threadAnchorId = primary?.anchorMessageId || '';
    span.dataset.selectionText = primary?.selectionText || '';
    if (Number.isFinite(primary?.matchIndex)) {
      span.dataset.matchIndex = String(primary.matchIndex);
    }
    if (Number.isFinite(primary?.selectionStartOffset)) {
      span.dataset.selectionStartOffset = String(primary.selectionStartOffset);
    }
    if (Number.isFinite(primary?.selectionEndOffset)) {
      span.dataset.selectionEndOffset = String(primary.selectionEndOffset);
    }

    wrapRangeWithSpan(range, span);
  }

  function decorateMessageElement(messageElement, messageNode) {
    if (!messageElement || !messageNode) return;
    const annotations = Array.isArray(messageNode.threadAnnotations)
      ? messageNode.threadAnnotations
      : [];

    const textContainer = messageElement.querySelector('.text-content');
    if (!textContainer) return;

    unwrapThreadHighlights(textContainer);
    if (!annotations.length) return;
    const ranges = buildAnnotationHighlightRanges(textContainer, annotations);
    // 从后往前包裹高亮，避免前面的高亮拆分文本节点后导致索引偏移。
    ranges.sort((a, b) => b.startPos - a.startPos);
    ranges.forEach((rangeGroup) => {
      applyHighlightRange(textContainer, rangeGroup);
    });
    syncActiveThreadHighlightState();
  }

  function clearSelectionRanges() {
    try {
      const selection = window.getSelection();
      selection?.removeAllRanges();
    } catch (_) {}
  }

  function runSelectionPromptInThread(anchorNode, selectionInfo, messageElement, existingThread, options = {}) {
    const selectionText = (selectionInfo?.selectionText || '').trim();
    if (!selectionText) {
      showNotification?.({ message: '选中内容为空，无法发送划词方式1', type: 'warning' });
      return false;
    }

    if (!promptSettingsManager?.getPrompts) {
      showNotification?.({ message: '未找到划词方式1配置', type: 'warning' });
      return false;
    }

    const prompts = promptSettingsManager.getPrompts();
    const selectionPromptText = (prompts?.query?.prompt || '').trim();
    if (!selectionPromptText) {
      showNotification?.({ message: '尚未配置划词方式1，请在设置中补充', type: 'warning' });
      return false;
    }

    if (!messageSender?.sendMessage) {
      showNotification?.({ message: '发送器未就绪，暂时无法发送', type: 'warning' });
      return false;
    }

    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const forceCreateNewThread = !!normalizedOptions.forceCreateNewThread;
    // 说明：在“已有高亮片段”上点击解释按钮时，按产品预期应创建新线程而非追加到旧线程。
    let targetThread = forceCreateNewThread ? null : existingThread;
    if (!targetThread) {
      const created = createThreadAnnotation(anchorNode, selectionInfo);
      if (!created) {
        showNotification?.({ message: '创建划词对话失败', type: 'warning' });
        return false;
      }
      decorateMessageElement(messageElement, anchorNode);
      refreshThreadOverviewDrawerSafely();
      targetThread = created;
    }

    // 进入线程后，用划词方式1自动发送一条消息（效果等同于手动使用划词方式1）。
    enterThread(targetThread.id);
    const userMessageText = selectionPromptText.replace('<SELECTION>', selectionText);
    const apiPref = (prompts.query?.model || '').trim();
    const apiParam = apiPref || 'follow_current';
    messageSender.sendMessage({
      originalMessageText: userMessageText,
      specificPromptType: 'query',
      promptMeta: { selectionText },
      api: apiParam
    });
    return true;
  }

  function createThreadFromSelection(anchorNode, selectionInfo, messageElement) {
    if (!anchorNode || !selectionInfo) return null;
    const created = createThreadAnnotation(anchorNode, selectionInfo);
    if (!created) {
      showNotification?.({ message: '创建划词对话失败', type: 'warning' });
      return null;
    }
    if (messageElement) {
      decorateMessageElement(messageElement, anchorNode);
    }
    refreshThreadOverviewDrawerSafely();
    enterThread(created.id);
    return created;
  }

  function prependSelectionQuoteToComposer(selectionText) {
    const inputController = services.inputController;
    if (
      !inputController
      || typeof inputController.getInputText !== 'function'
      || typeof inputController.setInputText !== 'function'
    ) {
      showNotification?.({ message: '输入框未就绪，暂时无法引用划词内容', type: 'warning' });
      return false;
    }

    const quoteText = buildSelectionComposerQuote(selectionText);
    if (!quoteText) {
      showNotification?.({ message: '选中内容为空，无法引用到输入框', type: 'warning' });
      return false;
    }

    const currentText = inputController.getInputText();
    const nextText = prependSelectionQuoteToComposerText(currentText, selectionText);
    inputController.setInputText(nextText);
    try {
      dom.messageInput?.dispatchEvent?.(new Event('input', { bubbles: true }));
    } catch (_) {}
    inputController.focusToEnd?.();
    services.uiManager?.resetInputHeight?.();
    services.uiManager?.updateSendButtonState?.();
    showNotification?.({ message: '已引用到输入框', type: 'success', duration: 1400 });
    return true;
  }

  function cloneMessageValue(value) {
    if (value == null) return value;
    try {
      return structuredClone(value);
    } catch (_) {}
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {}
    return value;
  }

  function copyThreadMessageFields(source, target) {
    if (!source || !target) return;
    const skipKeys = new Set([
      'id',
      'parentId',
      'children',
      'role',
      'content',
      'timestamp'
    ]);
    Object.keys(source).forEach((key) => {
      if (skipKeys.has(key)) return;
      if (key.startsWith('thread')) return;
      target[key] = cloneMessageValue(source[key]);
    });
  }

  // 复制线程消息用于“分支线程”，避免直接复用旧节点导致线程串线。
  function cloneThreadMessageNode(sourceNode, parentId, threadMeta) {
    if (!sourceNode || !chatHistoryManager?.addMessageToTreeWithOptions) return null;
    const content = cloneMessageValue(normalizeStoredMessageContent(sourceNode.content));
    const node = chatHistoryManager.addMessageToTreeWithOptions(
      sourceNode.role,
      content,
      parentId || null,
      { preserveCurrentNode: true }
    );
    if (!node) return null;
    copyThreadMessageFields(sourceNode, node);
    node.threadId = threadMeta.threadId;
    node.threadAnchorId = threadMeta.anchorMessageId;
    node.threadSelectionText = threadMeta.selectionText || '';
    node.threadRootId = threadMeta.rootMessageId || null;
    node.threadHiddenSelection = false;
    return node;
  }

  // 从指定节点向上回溯到线程根节点，构建“根 -> 目标节点”的链路。
  function buildThreadChainToNode(targetNode, annotation) {
    if (!targetNode) return [];
    const nodes = chatHistoryManager?.chatHistory?.messages || [];
    const findNode = (id) => nodes.find(m => m.id === id) || null;
    const rootId = annotation?.rootMessageId || '';
    const threadId = annotation?.id || '';
    const chain = [];
    let current = targetNode;
    const visited = new Set();

    while (current) {
      chain.unshift(current);
      if (rootId && current.id === rootId) break;
      if (current.threadHiddenSelection) break;
      if (visited.has(current.id)) break;
      visited.add(current.id);
      const parent = current.parentId ? findNode(current.parentId) : null;
      if (!parent) break;
      if (threadId && parent.threadId && parent.threadId !== threadId) break;
      if (threadId && !parent.threadId) break;
      current = parent;
    }

    if (rootId && chain.length && chain[0].id !== rootId) {
      const rootNode = findNode(rootId);
      if (rootNode) chain.unshift(rootNode);
    }
    return chain;
  }

  // 从线程锚点回溯主链，构建“主链根 -> 锚点消息”的有序链路。
  function buildMainChainToAnchor(anchorNode) {
    if (!anchorNode) return [];
    const nodes = chatHistoryManager?.chatHistory?.messages || [];
    const findNode = (id) => nodes.find(m => m.id === id) || null;
    const chain = [];
    let current = anchorNode;
    const visited = new Set();

    while (current) {
      if (!current.threadId && !current.threadHiddenSelection) {
        chain.unshift(current);
      }
      if (visited.has(current.id)) break;
      visited.add(current.id);
      const parent = current.parentId ? findNode(current.parentId) : null;
      if (!parent) break;
      if (parent.threadId || parent.threadHiddenSelection) break;
      current = parent;
    }

    return chain;
  }

  async function forkThreadFromMessage(messageId) {
    if (!messageId) return null;
    const nodes = chatHistoryManager?.chatHistory?.messages || [];
    const targetNode = nodes.find(node => node.id === messageId);
    if (!targetNode) {
      showNotification?.({ message: '未找到要分支的线程消息', type: 'warning' });
      return null;
    }

    const sourceThreadId = targetNode.threadId || state.activeThreadId;
    if (!sourceThreadId) {
      showNotification?.({ message: '当前消息不属于划词线程', type: 'warning' });
      return null;
    }

    const sourceInfo = findThreadById(sourceThreadId);
    const sourceAnnotation = repairThreadAnnotation(sourceThreadId) || sourceInfo?.annotation || null;
    if (!sourceInfo || !sourceAnnotation) {
      showNotification?.({ message: '未找到原线程信息，无法分支', type: 'warning' });
      return null;
    }

    const anchorNode = nodes.find(node => node.id === sourceInfo.anchorMessageId) || null;
    if (!anchorNode) {
      showNotification?.({ message: '未找到线程锚点消息，无法分支', type: 'warning' });
      return null;
    }

    const selectionText = normalizeSelectionText(sourceAnnotation.selectionText || state.activeSelectionText || '');
    if (!selectionText) {
      showNotification?.({ message: '线程选中内容缺失，无法分支', type: 'warning' });
      return null;
    }

    const selectionInfo = {
      selectionText,
      matchIndex: Number.isFinite(sourceAnnotation.matchIndex) ? sourceAnnotation.matchIndex : 0,
      selectionStartOffset: Number.isFinite(sourceAnnotation.selectionStartOffset)
        ? sourceAnnotation.selectionStartOffset
        : null,
      selectionEndOffset: Number.isFinite(sourceAnnotation.selectionEndOffset)
        ? sourceAnnotation.selectionEndOffset
        : null
    };

    const created = createThreadAnnotation(anchorNode, selectionInfo);
    if (!created) {
      showNotification?.({ message: '创建分支线程失败', type: 'warning' });
      return null;
    }

    // 创建新的隐藏引用节点作为线程根，避免影响主对话 currentNode。
    const rootContent = selectionText ? `> ${selectionText}` : '>';
    const rootNode = chatHistoryManager.addMessageToTreeWithOptions(
      'user',
      rootContent,
      anchorNode.id,
      { preserveCurrentNode: true }
    );

    if (!rootNode) {
      removeThreadAnnotationFromAnchor(anchorNode, created.id);
      showNotification?.({ message: '创建分支线程根节点失败', type: 'warning' });
      return null;
    }

    rootNode.threadId = created.id;
    rootNode.threadAnchorId = anchorNode.id;
    rootNode.threadSelectionText = created.selectionText || selectionText;
    rootNode.threadHiddenSelection = true;
    rootNode.threadMatchIndex = Number.isFinite(created.matchIndex) ? created.matchIndex : 0;
    created.rootMessageId = rootNode.id;
    created.lastMessageId = rootNode.id;

    const sourceChain = buildThreadChainToNode(targetNode, sourceAnnotation);
    if (!sourceChain.length) {
      chatHistoryManager?.deleteMessage?.(rootNode.id);
      removeThreadAnnotationFromAnchor(anchorNode, created.id);
      showNotification?.({ message: '分支线程失败：未找到原线程链路', type: 'warning' });
      return null;
    }

    const visibleChain = sourceChain.filter(node => !node?.threadHiddenSelection);
    let parentId = rootNode.id;
    for (const node of visibleChain) {
      const cloned = cloneThreadMessageNode(node, parentId, {
        threadId: created.id,
        anchorMessageId: anchorNode.id,
        selectionText: created.selectionText || selectionText,
        rootMessageId: rootNode.id
      });
      if (!cloned) break;
      parentId = cloned.id;
      created.lastMessageId = cloned.id;
    }

    const anchorElement = getMessageElementFromNode(anchorNode);
    if (anchorElement) {
      decorateMessageElement(anchorElement, anchorNode);
    }
    refreshThreadOverviewDrawerSafely();

    if (chatHistoryUI?.saveCurrentConversation) {
      const savePromise = chatHistoryUI.saveCurrentConversation(true);
      if (savePromise?.catch) savePromise.catch(() => {});
    }

    await enterThread(created.id, { focusMessageId: created.lastMessageId });
    showNotification?.({ message: '已创建分支线程', type: 'info' });
    return created;
  }

  async function flattenThreadToMainConversation(messageId) {
    if (!messageId) return null;
    const nodes = chatHistoryManager?.chatHistory?.messages || [];
    const targetNode = nodes.find(node => node.id === messageId);
    if (!targetNode) {
      showNotification?.({ message: '未找到要展平的线程消息', type: 'warning' });
      return null;
    }

    const sourceThreadId = targetNode.threadId || state.activeThreadId;
    if (!sourceThreadId) {
      showNotification?.({ message: '当前消息不属于划词线程', type: 'warning' });
      return null;
    }

    const sourceInfo = findThreadById(sourceThreadId);
    const sourceAnnotation = repairThreadAnnotation(sourceThreadId) || sourceInfo?.annotation || null;
    if (!sourceInfo || !sourceAnnotation) {
      showNotification?.({ message: '未找到原线程信息，无法展平', type: 'warning' });
      return null;
    }

    const anchorNode = nodes.find(node => node.id === sourceInfo.anchorMessageId) || null;
    if (!anchorNode) {
      showNotification?.({ message: '未找到线程锚点消息，无法展平', type: 'warning' });
      return null;
    }

    const mainChain = buildMainChainToAnchor(anchorNode);
    if (!mainChain.length) {
      showNotification?.({ message: '未找到主聊天父级链路，无法展平', type: 'warning' });
      return null;
    }

    const threadVisibleChain = buildThreadChainToNode(targetNode, sourceAnnotation)
      .filter(node => !node?.threadHiddenSelection);
    if (!threadVisibleChain.length) {
      showNotification?.({ message: '未找到线程聊天链路，无法展平', type: 'warning' });
      return null;
    }

    const flattenedSourceChain = [];
    const seenIds = new Set();
    for (const node of [...mainChain, ...threadVisibleChain]) {
      if (!node?.id || seenIds.has(node.id)) continue;
      seenIds.add(node.id);
      flattenedSourceChain.push(node);
    }
    if (!flattenedSourceChain.length) {
      showNotification?.({ message: '线程展平失败：链路为空', type: 'warning' });
      return null;
    }

    if (!chatHistoryUI?.createForkConversation) {
      showNotification?.({ message: '创建展平主聊天失败：历史模块未就绪', type: 'warning' });
      return null;
    }

    await chatHistoryUI.createForkConversation(targetNode.id, {
      sourceChain: flattenedSourceChain,
      stripThreadMetadata: true,
      successMessage: '已创建展平主聊天'
    });
    return {
      anchorMessageId: anchorNode.id,
      targetMessageId: targetNode.id,
      messageCount: flattenedSourceChain.length
    };
  }

  function showSelectionBubble(selectionInfo, messageElement, range) {
    if (!selectionInfo || !messageElement || !range) return;
    const rect = range.getBoundingClientRect();
    const messageId = messageElement.getAttribute('data-message-id') || '';
    if (!messageId) return;

    const anchorNode = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === messageId);
    if (!anchorNode) return;

    const matchingThreads = findThreadsBySelection(
      anchorNode,
      selectionInfo.selectionText,
      selectionInfo.matchIndex,
      selectionInfo.selectionStartOffset
    );
    const primaryThread = pickPrimaryThread(matchingThreads);
    state.pendingSelection = {
      messageId,
      selectionText: selectionInfo.selectionText,
      matchIndex: selectionInfo.matchIndex
    };

    const hasMultipleThreads = matchingThreads.length > 1;
    const previewItems = hasMultipleThreads
      ? buildThreadSummaryItems(matchingThreads)
      : (primaryThread ? buildThreadPreviewItems(primaryThread.id) : []);
    const previewText = selectionInfo.selectionText;

    showBubbleAtRect(rect, {
      title: matchingThreads.length ? '划词对话' : '',
      content: previewText,
      contentItems: previewItems,
      iconButtons: [
        {
          iconClass: 'fa-solid fa-paper-plane',
          title: '使用划词方式1发送',
          onClick: () => {
            const didSend = runSelectionPromptInThread(
              anchorNode,
              selectionInfo,
              messageElement,
              primaryThread,
              { forceCreateNewThread: matchingThreads.length > 0 }
            );
            if (didSend) {
              hideBubble(true);
              clearSelectionRanges();
            }
          }
        },
        {
          iconClass: 'fa-solid fa-plus',
          title: '新建划词对话',
          onClick: () => {
            const created = createThreadFromSelection(anchorNode, selectionInfo, messageElement);
            if (created) {
              hideBubble(true);
              clearSelectionRanges();
            }
          }
        },
        {
          iconClass: 'fa-solid fa-quote-left',
          title: '引用到输入框',
          onClick: () => {
            clearSelectionRanges();
            const inserted = prependSelectionQuoteToComposer(selectionInfo.selectionText);
            if (inserted) {
              hideBubble(true);
            }
          }
        }
      ],
      onClick: hasMultipleThreads ? null : () => {
        if (primaryThread) {
          enterThread(primaryThread.id);
        } else {
          const created = createThreadFromSelection(anchorNode, selectionInfo, messageElement);
          if (!created) return;
        }
        hideBubble(true);
        clearSelectionRanges();
      },
      onItemClick: (item) => {
        if (item?.threadId) {
          enterThread(item.threadId);
          hideBubble(true);
          clearSelectionRanges();
          return;
        }
        if (item?.messageId && primaryThread) {
          enterThread(primaryThread.id, { focusMessageId: item.messageId });
          hideBubble(true);
          clearSelectionRanges();
        }
      },
      pinned: true,
      type: 'selection'
    });
  }

  function showPreviewBubbleForHighlight(target, options = {}) {
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const threadIds = parseThreadIdsFromHighlight(target);
    const threadInfos = threadIds
      .map(id => findThreadById(id))
      .filter(info => info?.annotation);
    const threads = threadInfos.map(info => info.annotation);
    const primaryThread = pickPrimaryThread(threads);
    const selectionText = target.dataset.selectionText || target.textContent || '';
    const hasMultipleThreads = threads.length > 1;
    const previewItems = hasMultipleThreads
      ? buildThreadSummaryItems(threads)
      : (primaryThread ? buildThreadPreviewItems(primaryThread.id) : []);
    const fallbackText = selectionText ? `“${selectionText}”` : '';
    const fallbackHtml = fallbackText
      ? (messageProcessor?.processMathAndMarkdown?.(fallbackText) || fallbackText)
      : '';
    const anchorMessageId = target.dataset.threadAnchorId || '';
    const anchorNode = anchorMessageId
      ? chatHistoryManager?.chatHistory?.messages?.find(m => m.id === anchorMessageId)
      : null;
    const anchorElement = anchorNode ? getMessageElementFromNode(anchorNode) : null;
    const selectionInfo = buildSelectionInfoFromHighlight(target);

    showBubbleAtRect(rect, {
      title: threads.length ? '划词对话' : '划词对话预览',
      content: fallbackText,
      contentHtml: previewItems.length ? '' : fallbackHtml,
      contentItems: previewItems,
      iconButtons: [
        {
          iconClass: 'fa-solid fa-paper-plane',
          title: '使用划词方式1发送',
          onClick: () => {
            if (!anchorNode || !selectionInfo.selectionText) return;
            const didSend = runSelectionPromptInThread(
              anchorNode,
              selectionInfo,
              anchorElement,
              primaryThread,
              { forceCreateNewThread: threads.length > 0 }
            );
            if (didSend) {
              hideBubble(true);
              clearSelectionRanges();
            }
          }
        },
        {
          iconClass: 'fa-solid fa-plus',
          title: '新建划词对话',
          onClick: () => {
            if (!anchorNode || !selectionInfo.selectionText) return;
            const created = createThreadFromSelection(anchorNode, selectionInfo, anchorElement);
            if (created) {
              hideBubble(true);
              clearSelectionRanges();
            }
          }
        },
        {
          iconClass: 'fa-solid fa-quote-left',
          title: '引用到输入框',
          onClick: () => {
            if (!selectionInfo.selectionText) return;
            clearSelectionRanges();
            const inserted = prependSelectionQuoteToComposer(selectionInfo.selectionText);
            if (inserted) {
              hideBubble(true);
            }
          }
        }
      ],
      onItemClick: (item) => {
        if (item?.threadId) {
          enterThread(item.threadId);
          hideBubble(true);
          return;
        }
        if (item?.messageId && primaryThread) {
          enterThread(primaryThread.id, { focusMessageId: item.messageId });
          hideBubble(true);
        }
      },
      pinned: !!options.pinned,
      type: 'preview'
    });
  }

  function findHighlightElementForThread(anchorElement, threadId) {
    if (!anchorElement || !threadId) return null;
    const highlightNodes = anchorElement.querySelectorAll('.thread-highlight');
    for (const node of highlightNodes) {
      const threadIds = parseThreadIdsFromHighlight(node);
      if (threadIds.includes(threadId)) {
        return node;
      }
    }
    return null;
  }

  function resolveMainChatThreadAnchorTarget(threadId, anchorMessageId) {
    if (!chatContainer || !anchorMessageId) return;
    const selector = buildMessageSelector(anchorMessageId);
    const anchorElement = selector ? chatContainer.querySelector(selector) : null;
    if (!anchorElement) return null;
    const targetElement = findHighlightElementForThread(anchorElement, threadId) || anchorElement;
    return { anchorElement, targetElement };
  }

  function captureMainChatAnchorViewportSnapshot(threadId, anchorMessageId) {
    const resolved = resolveMainChatThreadAnchorTarget(threadId, anchorMessageId);
    if (!resolved?.targetElement || !chatContainer) return null;
    const containerRect = chatContainer.getBoundingClientRect();
    const targetRect = resolved.targetElement.getBoundingClientRect();
    const containerHeight = containerRect.height || chatContainer.clientHeight || 0;
    if (!(containerHeight > 0)) return null;

    // 仅在锚点当前可见时才保持“视口百分位”，避免离屏元素导致不合理跳转。
    const isVisible = targetRect.bottom > containerRect.top && targetRect.top < containerRect.bottom;
    if (!isVisible) return null;
    const targetOffset = targetRect.top - containerRect.top;
    return {
      viewportPercent: clampNumber(targetOffset / containerHeight, 0, 1)
    };
  }

  function scrollMainChatToThreadAnchor(threadId, anchorMessageId, options = {}) {
    const resolved = resolveMainChatThreadAnchorTarget(threadId, anchorMessageId);
    if (!resolved?.anchorElement || !resolved?.targetElement || !chatContainer) return;
    const { anchorElement, targetElement } = resolved;
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const preferredPercent = Number.isFinite(normalizedOptions.preferredViewportPercent)
      ? clampNumber(normalizedOptions.preferredViewportPercent, 0, 1)
      : THREAD_ANCHOR_VIEWPORT_CENTER;

    // 进入线程时让左侧主聊天尽量对齐到“线程对应的高亮位置”，找不到高亮时回退到锚点消息。
    const applyScroll = () => {
      if (!chatContainer || !targetElement) return;
      const containerRect = chatContainer.getBoundingClientRect();
      const targetRect = targetElement.getBoundingClientRect();
      const delta = targetRect.top - containerRect.top;
      const baseScrollTop = Number.isFinite(chatContainer.scrollTop) ? chatContainer.scrollTop : 0;
      const rawTop = (() => {
        const containerHeight = containerRect.height || chatContainer.clientHeight || 0;
        const desiredOffset = containerHeight * preferredPercent;
        return baseScrollTop + delta - desiredOffset;
      })();
      const maxTop = Math.max(0, chatContainer.scrollHeight - chatContainer.clientHeight);
      const nextTop = Math.max(0, Math.min(rawTop, maxTop));
      chatContainer.scrollTo({ top: nextTop, behavior: 'auto' });
    };

    applyScroll();
    requestAnimationFrame(applyScroll);

    const images = anchorElement.querySelectorAll('img');
    if (images.length) {
      let pending = 0;
      images.forEach((img) => {
        if (img.complete) return;
        pending += 1;
        const onDone = () => {
          pending -= 1;
          if (pending <= 0) {
            applyScroll();
          }
        };
        img.addEventListener('load', onDone, { once: true });
        img.addEventListener('error', onDone, { once: true });
      });
    }
  }

  async function enterThread(threadId, options = {}) {
    const info = findThreadById(threadId);
    if (!info) {
      showNotification?.({ message: '未找到对应的划词对话', type: 'warning' });
      return false;
    }
    const anchorViewportSnapshot = captureMainChatAnchorViewportSnapshot(threadId, info.anchorMessageId);
    state.activeThreadId = threadId;
    state.activeAnchorMessageId = info.anchorMessageId;
    state.activeSelectionText = info.annotation?.selectionText || '';
    syncActiveThreadHighlightState();
    document.body.classList.add('thread-mode-active');
    updateThreadPanelTitle(state.activeSelectionText);
    applyThreadLayout();
    // 仅当高亮锚点当前不在可视区域时才执行“居中跳转”；已在屏内则保持用户当前视角不动。
    if (!anchorViewportSnapshot) {
      scrollMainChatToThreadAnchor(threadId, info.anchorMessageId, {
        preferredViewportPercent: THREAD_ANCHOR_VIEWPORT_CENTER
      });
    }
    await renderThreadMessages(threadId, options);
    return true;
  }

  function removeThreadMessageElements(messageId) {
    if (!messageId) return;
    const selector = buildMessageSelector(messageId);
    if (!selector) return;
    document.querySelectorAll(selector).forEach((node) => {
      node.remove();
    });
  }

  async function deleteThreadById(threadId) {
    if (!threadId) return;
    const info = findThreadById(threadId);
    if (!info || !info.annotation) {
      showNotification?.({ message: '未找到要删除的划词对话', type: 'warning' });
      refreshThreadOverviewDrawerSafely();
      return;
    }

    const anchorNode = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === info.anchorMessageId) || null;
    const chain = collectThreadChain(info.annotation)
      .filter(node => node?.threadId === threadId || node?.threadRootId === info.annotation?.rootMessageId);

    // 先从线程末端开始删除，避免父子关系被提前改写导致链路错乱。
    chain.slice().reverse().forEach((node) => {
      removeThreadMessageElements(node.id);
      chatHistoryManager?.deleteMessage?.(node.id);
    });

    if (anchorNode) {
      removeThreadAnnotationFromAnchor(anchorNode, threadId);
    }

    const anchorElement = anchorNode ? getMessageElementFromNode(anchorNode) : null;
    if (anchorElement && anchorNode) {
      decorateMessageElement(anchorElement, anchorNode);
    }

    if (state.activeThreadId === threadId) {
      exitThread({ skipDraftCleanup: true });
    }

    if (chatHistoryUI?.saveCurrentConversation) {
      await chatHistoryUI.saveCurrentConversation(true);
    }

    refreshThreadOverviewDrawerSafely();
    showNotification?.({ message: '已删除划词对话', type: 'info' });
  }

  async function deleteActiveThread() {
    const threadId = state.activeThreadId;
    if (!threadId) return;
    await deleteThreadById(threadId);
  }

  function cleanupDraftThreadIfNeeded(threadId) {
    const info = findThreadById(threadId);
    if (!info || !info.annotation) return false;
    if (info.annotation?.rootMessageId) return false;

    const anchorNode = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === info.anchorMessageId) || null;
    if (!anchorNode) return false;
    const removed = removeThreadAnnotationFromAnchor(anchorNode, threadId);
    if (!removed) return false;

    const anchorElement = getMessageElementFromNode(anchorNode);
    if (anchorElement) {
      decorateMessageElement(anchorElement, anchorNode);
    }

    if (chatHistoryUI?.saveCurrentConversation) {
      // 无实际对话内容的临时线程，退出时自动清理并保存，避免堆积空线程。
      const savePromise = chatHistoryUI.saveCurrentConversation(true);
      if (savePromise?.catch) {
        savePromise.catch(() => {});
      }
    }
    refreshThreadOverviewDrawerSafely();
    return true;
  }

  function exitThread(options = {}) {
    const {
      skipDraftCleanup = false,
      preserveAnchorViewport = true
    } = options || {};
    stopThreadResize();
    stopFullscreenWidthResize();
    clearThreadBannerPeekTimer();
    const currentThreadId = state.activeThreadId;
    const currentAnchorMessageId = state.activeAnchorMessageId;
    // 在线程面板收起前抓取锚点在主聊天视口中的垂直百分位，用于退出后重定位。
    const anchorViewportSnapshot = (preserveAnchorViewport && currentThreadId && currentAnchorMessageId)
      ? captureMainChatAnchorViewportSnapshot(currentThreadId, currentAnchorMessageId)
      : null;
    if (!skipDraftCleanup && currentThreadId) {
      cleanupDraftThreadIfNeeded(currentThreadId);
    }
    state.bannerHovered = false;
    state.bannerTopEdgeActive = false;
    state.bannerScrollAtTop = true;
    state.activeThreadId = null;
    state.activeAnchorMessageId = null;
    state.activeSelectionText = '';
    syncActiveThreadHighlightState();
    document.body.classList.remove('thread-mode-active');
    if (threadPanel) threadPanel.setAttribute('aria-hidden', 'true');
    if (threadContainer) threadContainer.innerHTML = '';
    threadBannerEl = null;
    threadBannerTextEl = null;
    updateThreadPanelTitle('');
    resetHiddenMessages();
    moveThreadPanelHome();
    if (anchorViewportSnapshot?.viewportPercent != null && currentThreadId && currentAnchorMessageId) {
      scrollMainChatToThreadAnchor(currentThreadId, currentAnchorMessageId, {
        preferredViewportPercent: anchorViewportSnapshot.viewportPercent
      });
    }
  }

  function resetForClearChat() {
    // 清空聊天时同时重置线程与气泡状态，避免残留 UI 影响后续划词。
    hideBubble(true);
    clearBubbleHideAnimationTimer();
    clearSelectionRanges();
    state.pendingSelection = null;
    exitThread({ skipDraftCleanup: true, preserveAnchorViewport: false });
    if (bubbleEl) {
      bubbleEl.remove();
      bubbleEl = null;
      bubbleHeaderEl = null;
      bubbleTitleEl = null;
      bubbleContentEl = null;
      bubbleContentTextEl = null;
      bubbleContentIconEl = null;
    }
  }

  function clampNumber(value, min, max) {
    if (!Number.isFinite(value)) return Number.isFinite(min) ? min : 0;
    if (Number.isFinite(min) && value < min) return min;
    if (Number.isFinite(max) && value > max) return max;
    return value;
  }

  function parsePixelValue(rawValue) {
    if (!rawValue) return NaN;
    const parsed = parseFloat(rawValue);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function getRootCssPixelVar(name) {
    if (!document.documentElement) return NaN;
    return parsePixelValue(getComputedStyle(document.documentElement).getPropertyValue(name));
  }

  function getViewportWidth() {
    const cssWidth = getRootCssPixelVar('--cerebr-viewport-width');
    if (Number.isFinite(cssWidth) && cssWidth > 0) return cssWidth;
    const fallback = document.documentElement?.clientWidth || window.innerWidth || 0;
    return Number.isFinite(fallback) ? fallback : 0;
  }

  function getFullscreenWidthBounds() {
    const externalBounds = settingsManager?.getFullscreenWidthBounds?.();
    if (externalBounds && Number.isFinite(externalBounds.min) && Number.isFinite(externalBounds.max)) {
      return {
        min: externalBounds.min,
        max: Math.max(externalBounds.min, externalBounds.max)
      };
    }
    const viewportWidth = Math.floor(getViewportWidth());
    const viewportLimitedMax = viewportWidth - 30;
    const min = FULLSCREEN_RESIZE_MIN_WIDTH;
    const max = Number.isFinite(viewportLimitedMax) && viewportLimitedMax > 0
      ? Math.max(min, viewportLimitedMax)
      : min;
    return { min, max };
  }

  function clampFullscreenWidth(value) {
    if (settingsManager?.clampFullscreenWidth) {
      return settingsManager.clampFullscreenWidth(value);
    }
    const { min, max } = getFullscreenWidthBounds();
    return Math.round(clampNumber(Number(value), min, max));
  }

  function getCurrentFullscreenWidth() {
    const configuredWidth = Number(settingsManager?.getSetting?.('fullscreenWidth'));
    if (Number.isFinite(configuredWidth) && configuredWidth > 0) {
      return clampFullscreenWidth(configuredWidth);
    }
    const fallback = getDefaultThreadColumnWidth();
    return clampFullscreenWidth(fallback);
  }

  function applyFullscreenWidthPreview(width) {
    const safeWidth = clampFullscreenWidth(width);
    if (settingsManager?.previewFullscreenWidth) {
      settingsManager.previewFullscreenWidth(safeWidth);
    } else {
      settingsManager?.setFullscreenWidth?.(safeWidth);
    }
    return safeWidth;
  }

  function commitFullscreenWidth(width) {
    const safeWidth = clampFullscreenWidth(width);
    settingsManager?.setFullscreenWidth?.(safeWidth);
    return safeWidth;
  }

  function getDefaultThreadColumnWidth() {
    const cssWidth = getRootCssPixelVar('--cerebr-fullscreen-width');
    if (Number.isFinite(cssWidth) && cssWidth > 0) return cssWidth;
    return 800;
  }

  function getThreadLayoutWidths() {
    const storedLeft = state.threadLayoutCustomized && Number.isFinite(state.threadLayoutLeft)
      ? state.threadLayoutLeft
      : getRootCssPixelVar('--cerebr-thread-left-width');
    const storedRight = state.threadLayoutCustomized && Number.isFinite(state.threadLayoutRight)
      ? state.threadLayoutRight
      : getRootCssPixelVar('--cerebr-thread-right-width');
    const fallback = getDefaultThreadColumnWidth();
    const left = Number.isFinite(storedLeft) && storedLeft > 0 ? storedLeft : fallback;
    const right = Number.isFinite(storedRight) && storedRight > 0 ? storedRight : fallback;
    return { left, right };
  }

  function getThreadLayoutMaxWidth() {
    // 预留两侧基础边距，避免拖到刚好贴边导致视觉拥挤。
    const viewportWidth = getViewportWidth();
    if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return Infinity;
    return Math.max(THREAD_RESIZE_MIN_COLUMN_WIDTH * 2, viewportWidth - THREAD_RESIZE_EDGE_PADDING);
  }

  function clampThreadSplitRatio(totalWidth, ratio) {
    if (!Number.isFinite(totalWidth) || totalWidth <= 0) return 0.5;
    const minRatio = Math.min(0.5, THREAD_RESIZE_MIN_COLUMN_WIDTH / totalWidth);
    const maxRatio = 1 - minRatio;
    return clampNumber(ratio, minRatio, maxRatio);
  }

  function normalizeThreadLayoutWidths(leftWidth, rightWidth) {
    const fallback = getDefaultThreadColumnWidth();
    let left = Number.isFinite(leftWidth) ? leftWidth : fallback;
    let right = Number.isFinite(rightWidth) ? rightWidth : fallback;
    if (left <= 0) left = fallback;
    if (right <= 0) right = fallback;

    const minTotal = THREAD_RESIZE_MIN_COLUMN_WIDTH * 2;
    const maxTotal = getThreadLayoutMaxWidth();
    const total = clampNumber(left + right, minTotal, maxTotal);
    let ratio = (left + right) > 0 ? left / (left + right) : 0.5;
    if (!Number.isFinite(ratio) || ratio <= 0) ratio = 0.5;
    ratio = clampThreadSplitRatio(total, ratio);

    let safeLeft = Math.round(total * ratio);
    let safeRight = Math.round(total - safeLeft);
    if (safeLeft < THREAD_RESIZE_MIN_COLUMN_WIDTH) {
      safeLeft = THREAD_RESIZE_MIN_COLUMN_WIDTH;
      safeRight = total - safeLeft;
    }
    if (safeRight < THREAD_RESIZE_MIN_COLUMN_WIDTH) {
      safeRight = THREAD_RESIZE_MIN_COLUMN_WIDTH;
      safeLeft = total - safeRight;
    }
    return { left: safeLeft, right: safeRight, ratio };
  }

  function applyThreadLayoutCssWidths(leftWidth, rightWidth) {
    if (!document.documentElement) return;
    const total = leftWidth + rightWidth;
    document.documentElement.style.setProperty('--cerebr-thread-left-width', `${leftWidth}px`);
    document.documentElement.style.setProperty('--cerebr-thread-right-width', `${rightWidth}px`);
    document.documentElement.style.setProperty('--cerebr-thread-total-width', `${total}px`);
  }

  function applyThreadLayoutWidths(leftWidth, rightWidth) {
    if (!document.documentElement) return;
    const total = leftWidth + rightWidth;
    state.threadLayoutLeft = leftWidth;
    state.threadLayoutRight = rightWidth;
    state.threadLayoutRatio = total > 0 ? leftWidth / total : 0.5;
    applyThreadLayoutCssWidths(leftWidth, rightWidth);
  }

  function normalizeThreadLayoutPrefs(rawPrefs) {
    if (!rawPrefs || typeof rawPrefs !== 'object') return null;
    const left = Number(rawPrefs.left);
    const right = Number(rawPrefs.right);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
    const ratio = Number(rawPrefs.ratio);
    const updatedAt = Number(rawPrefs.updatedAt);
    return {
      left,
      right,
      ratio: Number.isFinite(ratio) ? ratio : null,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0
    };
  }

  function getThreadLayoutSignature(payload) {
    if (!payload) return '';
    return `${payload.left}:${payload.right}`;
  }

  function buildThreadLayoutPayload() {
    const left = Number(state.threadLayoutLeft);
    const right = Number(state.threadLayoutRight);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
    return {
      left,
      right,
      ratio: state.threadLayoutRatio,
      updatedAt: Date.now()
    };
  }

  function writeThreadLayoutLocal(payload) {
    if (!payload || !chrome?.storage?.local?.set) return;
    chrome.storage.local.set({ [THREAD_LAYOUT_STORAGE_KEY]: payload }).catch(() => {});
  }

  async function readThreadLayoutPrefsFromStorage(storageArea) {
    if (!storageArea?.get) return null;
    try {
      const res = await storageArea.get([THREAD_LAYOUT_STORAGE_KEY]);
      return normalizeThreadLayoutPrefs(res?.[THREAD_LAYOUT_STORAGE_KEY]);
    } catch (_) {
      return null;
    }
  }

  function pickLatestThreadLayoutPrefs(localPrefs, syncPrefs) {
    if (localPrefs && syncPrefs) {
      const localUpdatedAt = localPrefs.updatedAt || 0;
      const syncUpdatedAt = syncPrefs.updatedAt || 0;
      return syncUpdatedAt > localUpdatedAt ? syncPrefs : localPrefs;
    }
    return localPrefs || syncPrefs || null;
  }

  function applyThreadLayoutPrefs(prefs) {
    if (!prefs) return;
    const fallback = getDefaultThreadColumnWidth();
    const rawLeft = Number(prefs.left);
    const rawRight = Number(prefs.right);
    const left = Number.isFinite(rawLeft) && rawLeft > 0 ? rawLeft : fallback;
    const right = Number.isFinite(rawRight) && rawRight > 0 ? rawRight : fallback;
    const total = left + right;
    state.threadLayoutCustomized = true;
    state.threadLayoutLeft = left;
    state.threadLayoutRight = right;
    state.threadLayoutRatio = total > 0 ? left / total : 0.5;
    if (isThreadResizeEnabled()) {
      const normalized = normalizeThreadLayoutWidths(left, right);
      state.threadLayoutRatio = normalized.ratio;
      applyThreadLayoutCssWidths(normalized.left, normalized.right);
    }
  }

  async function loadThreadLayoutPrefs() {
    if (threadLayoutPrefsPromise) return threadLayoutPrefsPromise;
    const localPromise = readThreadLayoutPrefsFromStorage(chrome?.storage?.local);
    const syncPromise = readThreadLayoutPrefsFromStorage(chrome?.storage?.sync);
    threadLayoutPrefsPromise = Promise.all([localPromise, syncPromise])
      .then(([localPrefs, syncPrefs]) => {
        const picked = pickLatestThreadLayoutPrefs(localPrefs, syncPrefs);
        // sync 更新更晚时，顺便回写 local，保持单机启动更快。
        if (picked && picked === syncPrefs) {
          writeThreadLayoutLocal(picked);
        }
        return picked;
      })
      .catch(() => null);
    return threadLayoutPrefsPromise;
  }

  function scheduleThreadLayoutSync(payload) {
    if (!payload || !chrome?.storage?.sync?.set) return;
    const signature = getThreadLayoutSignature(payload);
    if (signature && signature === threadLayoutSyncState.lastSignature && !threadLayoutSyncState.pendingPayload) {
      return;
    }
    threadLayoutSyncState.pendingPayload = payload;
    threadLayoutSyncState.pendingSignature = signature;
    if (threadLayoutSyncState.timer) {
      clearTimeout(threadLayoutSyncState.timer);
    }
    const now = Date.now();
    const earliest = threadLayoutSyncState.lastSyncAt + THREAD_LAYOUT_SYNC_MIN_INTERVAL_MS;
    const delay = Math.max(THREAD_LAYOUT_SYNC_DEBOUNCE_MS, earliest - now);
    threadLayoutSyncState.timer = window.setTimeout(flushThreadLayoutSync, delay);
  }

  async function flushThreadLayoutSync() {
    threadLayoutSyncState.timer = null;
    const pending = threadLayoutSyncState.pendingPayload;
    if (!pending || !chrome?.storage?.sync?.set) return;
    const now = Date.now();
    const earliest = threadLayoutSyncState.lastSyncAt + THREAD_LAYOUT_SYNC_MIN_INTERVAL_MS;
    if (now < earliest) {
      scheduleThreadLayoutSync(pending);
      return;
    }
    try {
      await queueStorageSet('sync', { [THREAD_LAYOUT_STORAGE_KEY]: pending }, { flush: 'now' });
      threadLayoutSyncState.lastSyncAt = Date.now();
      threadLayoutSyncState.lastSignature = threadLayoutSyncState.pendingSignature || getThreadLayoutSignature(pending);
      threadLayoutSyncState.pendingPayload = null;
      threadLayoutSyncState.pendingSignature = '';
    } catch (error) {
      console.warn('保存线程分栏宽度失败（将稍后重试）:', error);
      scheduleThreadLayoutSync(pending);
    }
  }

  async function persistThreadLayoutPrefs() {
    // 仅保存用户实际拖动后的布局，避免覆盖默认值。
    if (!state.threadLayoutCustomized) return;
    const payload = buildThreadLayoutPayload();
    if (!payload) return;
    // 本地先落盘，确保不会因为 sync 配额导致保存失败。
    writeThreadLayoutLocal(payload);
    // sync 写入采用节流+去抖，避免高频触发配额错误。
    scheduleThreadLayoutSync(payload);
  }

  function syncThreadLayoutWidths() {
    if (!isFullscreenLayout() || !state.activeThreadId) return;
    const { left, right } = getThreadLayoutWidths();
    const normalized = normalizeThreadLayoutWidths(left, right);
    state.threadLayoutRatio = normalized.ratio;
    if (!state.threadLayoutCustomized) return;
    applyThreadLayoutCssWidths(normalized.left, normalized.right);
  }

  function isThreadResizeEnabled() {
    return !!state.activeThreadId && isFullscreenLayout();
  }

  function isFullscreenWidthResizeEnabled() {
    return !state.activeThreadId && isFullscreenLayout();
  }

  function getFullscreenResizePointerScale() {
    // In embedded mode fullscreenWidth uses physical-pixel semantics while clientX delta is CSS pixels.
    // Multiply by DPR so drag distance and visible width change stay consistent under DPI scaling.
    const dpr = Number(window.devicePixelRatio);
    const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    const isStandaloneMode = !!appContext?.state?.isStandalone;
    return isStandaloneMode ? 1 : safeDpr;
  }

  function handleFullscreenWidthResizeMove(event) {
    if (!fullscreenResizeState.active) return;
    const delta = (event?.clientX ?? 0) - fullscreenResizeState.startX;
    const direction = fullscreenResizeState.edge === 'edge-right' ? 1 : -1;
    const pointerScale = (Number.isFinite(fullscreenResizeState.pointerScale) && fullscreenResizeState.pointerScale > 0)
      ? fullscreenResizeState.pointerScale
      : getFullscreenResizePointerScale();
    const logicalDelta = delta * pointerScale;
    const nextWidth = fullscreenResizeState.startWidth + logicalDelta * 2 * direction;
    const clampedWidth = applyFullscreenWidthPreview(nextWidth);
    fullscreenResizeState.currentWidth = clampedWidth;
  }

  function stopFullscreenWidthResize() {
    if (!fullscreenResizeState.active) return;
    const finalWidth = clampFullscreenWidth(
      fullscreenResizeState.currentWidth || fullscreenResizeState.startWidth
    );
    fullscreenResizeState.active = false;
    fullscreenResizeState.edge = '';
    fullscreenResizeState.pointerScale = 1;
    document.body.classList.remove('fullscreen-width-resize-active');
    document.removeEventListener('mousemove', handleFullscreenWidthResizeMove);
    document.removeEventListener('mouseup', stopFullscreenWidthResize);
    window.removeEventListener('blur', stopFullscreenWidthResize);
    clearResizeHandleHover();
    commitFullscreenWidth(finalWidth);
  }

  function startFullscreenWidthResize(event, edge) {
    if (!event || !isFullscreenWidthResizeEnabled()) return;
    event.preventDefault();
    event.stopPropagation();

    const startWidth = getCurrentFullscreenWidth();
    fullscreenResizeState.active = true;
    fullscreenResizeState.edge = edge;
    fullscreenResizeState.startX = event.clientX;
    fullscreenResizeState.startWidth = startWidth;
    fullscreenResizeState.currentWidth = startWidth;
    fullscreenResizeState.pointerScale = getFullscreenResizePointerScale();

    applyFullscreenWidthPreview(startWidth);
    document.body.classList.add('fullscreen-width-resize-active');
    document.addEventListener('mousemove', handleFullscreenWidthResizeMove);
    document.addEventListener('mouseup', stopFullscreenWidthResize);
    window.addEventListener('blur', stopFullscreenWidthResize);
  }

  function handleThreadResizeMove(event) {
    // 拖动中线只改左右比例；拖动两侧边缘则等比调整总宽度并保持居中。
    if (!threadResizeState.active) return;
    const delta = (event?.clientX ?? 0) - threadResizeState.startX;
    if (threadResizeState.mode === 'split') {
      const total = threadResizeState.startTotal;
      let left = threadResizeState.startLeft + delta;
      left = clampNumber(left, THREAD_RESIZE_MIN_COLUMN_WIDTH, total - THREAD_RESIZE_MIN_COLUMN_WIDTH);
      const right = total - left;
      applyThreadLayoutWidths(left, right);
      return;
    }

    const direction = threadResizeState.mode === 'edge-right' ? 1 : -1;
    const minTotal = THREAD_RESIZE_MIN_COLUMN_WIDTH * 2;
    const maxTotal = getThreadLayoutMaxWidth();
    const total = clampNumber(threadResizeState.startTotal + delta * 2 * direction, minTotal, maxTotal);
    const ratio = clampThreadSplitRatio(total, threadResizeState.ratio);
    const left = Math.round(total * ratio);
    const right = Math.round(total - left);
    applyThreadLayoutWidths(left, right);
  }

  function stopThreadResize() {
    if (!threadResizeState.active) return;
    threadResizeState.active = false;
    threadResizeState.mode = '';
    document.body.classList.remove('thread-resize-active');
    document.removeEventListener('mousemove', handleThreadResizeMove);
    document.removeEventListener('mouseup', stopThreadResize);
    window.removeEventListener('blur', stopThreadResize);
    clearResizeHandleHover();
    persistThreadLayoutPrefs();
  }

  function startThreadResize(event, mode) {
    if (!event || !isThreadResizeEnabled()) return;
    event.preventDefault();
    event.stopPropagation();
    state.threadLayoutCustomized = true;
    const { left, right } = getThreadLayoutWidths();
    const normalized = normalizeThreadLayoutWidths(left, right);
    const total = normalized.left + normalized.right;
    threadResizeState.active = true;
    threadResizeState.mode = mode;
    threadResizeState.startX = event.clientX;
    threadResizeState.startLeft = normalized.left;
    threadResizeState.startTotal = total;
    threadResizeState.ratio = normalized.ratio;
    applyThreadLayoutWidths(normalized.left, normalized.right);
    document.body.classList.add('thread-resize-active');
    document.addEventListener('mousemove', handleThreadResizeMove);
    document.addEventListener('mouseup', stopThreadResize);
    window.addEventListener('blur', stopThreadResize);
  }

  function isPointInRect(clientX, clientY, rect) {
    return !!rect
      && rect.width > 0
      && rect.height > 0
      && clientX >= rect.left
      && clientX <= rect.right
      && clientY >= rect.top
      && clientY <= rect.bottom;
  }

  function clearResizeHandleHover() {
    resizeHandleElements.forEach((el) => el.classList.remove('resize-hit-hover'));
    document.body?.classList?.remove('resize-hit-hover');
  }

  function resolveResizeHandleHit(clientX, clientY) {
    if (!isFullscreenLayout()) return null;

    if (isThreadResizeEnabled()) {
      const candidates = [
        { element: threadSplitter, kind: 'thread', mode: 'split' },
        { element: threadResizeEdgeLeft, kind: 'thread', mode: 'edge-left' },
        { element: threadResizeEdgeRight, kind: 'thread', mode: 'edge-right' }
      ];
      return candidates.find((item) => (
        item.element && isPointInRect(clientX, clientY, item.element.getBoundingClientRect())
      )) || null;
    }

    if (isFullscreenWidthResizeEnabled()) {
      const candidates = [
        { element: threadResizeEdgeLeft, kind: 'fullscreen', mode: 'edge-left' },
        { element: threadResizeEdgeRight, kind: 'fullscreen', mode: 'edge-right' }
      ];
      return candidates.find((item) => (
        item.element && isPointInRect(clientX, clientY, item.element.getBoundingClientRect())
      )) || null;
    }

    return null;
  }

  function updateResizeHandleHoverFromPoint(clientX, clientY) {
    if (threadResizeState.active || fullscreenResizeState.active) return;
    const hit = resolveResizeHandleHit(clientX, clientY);
    resizeHandleElements.forEach((el) => {
      el.classList.toggle('resize-hit-hover', !!hit && el === hit.element);
    });
    document.body?.classList?.toggle('resize-hit-hover', !!hit);
  }

  function handleResizeHandleMouseMove(event) {
    updateResizeHandleHoverFromPoint(event.clientX, event.clientY);
  }

  function handleResizeHandleMouseDown(event) {
    if (event.button !== 0) return;
    const hit = resolveResizeHandleHit(event.clientX, event.clientY);
    if (!hit) return;
    clearResizeHandleHover();
    if (hit.kind === 'thread') {
      startThreadResize(event, hit.mode);
      return;
    }
    startFullscreenWidthResize(event, hit.mode);
  }

  function handleResizeHandleMouseLeave() {
    clearResizeHandleHover();
  }

  function bindThreadResizeHandles() {
    if (!threadSplitter || !threadResizeEdgeLeft || !threadResizeEdgeRight) return;
    threadSplitter.addEventListener('mousedown', (event) => {
      if (!isThreadResizeEnabled()) return;
      startThreadResize(event, 'split');
    });
    threadResizeEdgeLeft.addEventListener('mousedown', (event) => {
      if (isThreadResizeEnabled()) {
        startThreadResize(event, 'edge-left');
        return;
      }
      startFullscreenWidthResize(event, 'edge-left');
    });
    threadResizeEdgeRight.addEventListener('mousedown', (event) => {
      if (isThreadResizeEnabled()) {
        startThreadResize(event, 'edge-right');
        return;
      }
      startFullscreenWidthResize(event, 'edge-right');
    });
    document.addEventListener('mousemove', handleResizeHandleMouseMove, true);
    document.addEventListener('mousedown', handleResizeHandleMouseDown, true);
    document.addEventListener('mouseleave', handleResizeHandleMouseLeave, true);
  }

  function handleThreadResizeViewportChange() {
    if (isThreadResizeEnabled()) {
      syncThreadLayoutWidths();
    }
    if (isFullscreenWidthResizeEnabled()) {
      const currentWidth = getCurrentFullscreenWidth();
      applyFullscreenWidthPreview(currentWidth);
      if (fullscreenResizeState.active) {
        fullscreenResizeState.startWidth = currentWidth;
        fullscreenResizeState.currentWidth = currentWidth;
        fullscreenResizeState.pointerScale = getFullscreenResizePointerScale();
      }
    }
  }

  function isThreadModeActive() {
    return !!state.activeThreadId;
  }

  function handleSelectionMouseUp(event) {
    if (event && bubbleEl && bubbleEl.contains(event.target)) {
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      if (state.bubbleType === 'selection') {
        scheduleSelectionCollapseHide();
      } else if (!state.bubblePinned) {
        hideBubble();
      }
      return;
    }

    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (!range) return;

    const startEl = range.startContainer?.parentElement || range.startContainer;
    const endEl = range.endContainer?.parentElement || range.endContainer;
    const startMessage = startEl?.closest?.('.message');
    const endMessage = endEl?.closest?.('.message');

    if (!startMessage || startMessage !== endMessage) {
      hideBubble(true);
      return;
    }

    if (threadPanel && threadPanel.contains(startMessage)) {
      hideBubble(true);
      return;
    }

    if (startMessage.classList.contains('loading-message')) {
      hideBubble(true);
      return;
    }

    const selectionInfo = getSelectionInfoFromRange(range, startMessage);
    if (!selectionInfo) {
      hideBubble(true);
      return;
    }

    showSelectionBubble(selectionInfo, startMessage, range);
  }

  function handleSelectionChange() {
    if (!bubbleEl || bubbleEl.style.display === 'none') return;
    if (state.bubbleType !== 'selection') return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      clearSelectionCollapseTimer();
      return;
    }
    if (state.bubbleHovered || state.highlightHovered) return;
    scheduleSelectionCollapseHide();
  }

  function handleHighlightMouseOver(event) {
    const target = event.target.closest('.thread-highlight');
    if (!target || state.bubblePinned) return;
    state.highlightHovered = true;
    clearBubbleHideTimer();
    showPreviewBubbleForHighlight(target);
  }

  function handleHighlightMouseOut(event) {
    const target = event.target.closest('.thread-highlight');
    if (!target) return;
    if (state.bubblePinned) return;
    state.highlightHovered = false;
    if (bubbleEl && event.relatedTarget && bubbleEl.contains(event.relatedTarget)) return;
    scheduleBubbleHide();
  }

  function handleHighlightClick(event) {
    const target = event.target.closest('.thread-highlight');
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    const threadIds = parseThreadIdsFromHighlight(target);
    const threadInfos = threadIds
      .map(id => findThreadById(id))
      .filter(info => info?.annotation);
    const primaryThread = pickPrimaryThread(threadInfos.map(info => info.annotation));
    const threadId = primaryThread?.id || threadIds[0] || '';
    if (!threadId) return;
    hideBubble(true);
    // 多线程高亮点击时优先进入“最近活跃”的线程，避免点击无反馈。
    if (state.activeThreadId && state.activeThreadId === threadId) {
      exitThread();
      return;
    }
    enterThread(threadId);
  }

  function handleDocumentClick(event) {
    if (!bubbleEl || bubbleEl.style.display === 'none') return;
    if (bubbleEl.contains(event.target)) return;
    if (event.target.closest('.thread-highlight')) return;
    if (state.bubbleType === 'selection') {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
    }
    hideBubble(true);
  }

  function handleDocumentContextMenu() {
    if (!bubbleEl || bubbleEl.style.display === 'none') return;
    hideBubble(true);
  }

  function bindHighlightEvents(container) {
    if (!container) return;
    container.addEventListener('mouseover', handleHighlightMouseOver);
    container.addEventListener('mouseout', handleHighlightMouseOut);
    container.addEventListener('click', handleHighlightClick);
  }

  function init() {
    if (!chatContainer) return;
    document.addEventListener('mouseup', handleSelectionMouseUp);
    document.addEventListener('selectionchange', handleSelectionChange);
    document.addEventListener('click', handleDocumentClick);
    document.addEventListener('contextmenu', handleDocumentContextMenu);
    document.addEventListener('mousemove', handleTopEdgeMouseMove);
    bindHighlightEvents(chatContainer);
    bindThreadResizeHandles();
    window.addEventListener('resize', handleThreadResizeViewportChange);
    loadThreadLayoutPrefs().then((prefs) => {
      if (!prefs) return;
      applyThreadLayoutPrefs(prefs);
      if (state.activeThreadId) {
        syncThreadLayoutWidths();
      }
    });
    if (threadPanel) {
      threadPanel.setAttribute('aria-hidden', 'true');
    }
    if (document.documentElement) {
      let lastFullscreenLayoutState = isFullscreenLayout();
      layoutObserver = new MutationObserver(() => {
        const currentFullscreenLayoutState = isFullscreenLayout();
        // 仅在“全屏状态”变化时重排线程布局，避免主题等无关 class 变更触发滚动回顶。
        if (currentFullscreenLayoutState === lastFullscreenLayoutState) return;
        lastFullscreenLayoutState = currentFullscreenLayoutState;
        if (!currentFullscreenLayoutState) {
          clearResizeHandleHover();
        }
        if (state.activeThreadId) {
          applyThreadLayout();
        }
      });
      layoutObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    }
  }

  return {
    init,
    decorateMessageElement,
    forkThreadFromMessage,
    flattenThreadToMainConversation,
    enterThread,
    exitThread,
    resetForClearChat,
    isThreadModeActive,
    getActiveThreadId: () => state.activeThreadId,
    getActiveAnchorMessageId: () => state.activeAnchorMessageId,
    getActiveSelectionText: () => state.activeSelectionText,
    findThreadById,
    repairThreadAnnotation
  };
}
