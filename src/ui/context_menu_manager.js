import { serializeSelectionTextWithMath } from '../utils/math_selection_text.js';
import {
  getDocumentZoomFactor,
  getElementLayoutRect,
  getElementLayoutSize,
  getLayoutViewportSize,
  resolveFixedOverlayPositionFromClientPoint,
  toLayoutPixels
} from '../utils/coordinate_space.js';

/**
 * 上下文菜单管理模块
 * 负责处理消息和代码块的右键菜单功能
 */

/**
 * 创建上下文菜单管理器
 * @param {Object} appContext - 应用程序上下文对象
 * @param {HTMLElement} appContext.dom.contextMenu - 上下文菜单元素
 * @param {HTMLElement} appContext.dom.copyMessageButton - 复制消息按钮
 * @param {HTMLElement} appContext.dom.copyCodeButton - 复制代码按钮
 * @param {HTMLElement} appContext.dom.stopUpdateButton - 停止更新按钮
 * @param {HTMLElement} appContext.dom.regenerateButton - 重新生成按钮
 * @param {HTMLElement} appContext.dom.deleteMessageButton - 删除消息按钮
 * @param {HTMLElement} appContext.dom.clearChatContextButton - 清空聊天按钮
 * @param {HTMLElement} appContext.dom.chatContainer - 聊天容器元素
 * @param {Function} appContext.services.messageSender.abortCurrentRequest - 中止当前请求函数
 * @param {Function} appContext.services.chatHistoryUI.deleteMessageFromUIAndHistory - 删除消息内容函数
 * @param {Function} appContext.services.chatHistoryUI.clearChatHistory - 清空聊天历史函数
 * @param {Function} appContext.services.messageSender.sendMessage - 发送消息函数
 * @param {Object} appContext.services.chatHistoryManager.chatHistory - 聊天历史数据对象
 * @param {HTMLElement} appContext.dom.forkConversationButton - 创建分支对话按钮
 * @param {Function} appContext.services.chatHistoryUI.createForkConversation - 创建分支对话函数
 * @param {HTMLElement} appContext.dom.screenshotMenu - 截图子菜单入口按钮
 * @param {HTMLElement} appContext.dom.downloadAsImageButton - 下载消息截图按钮
 * @param {HTMLElement} appContext.dom.selectForImageButton - 将消息加入长截图选择的按钮
 * @returns {Object} 上下文菜单管理器实例
 */
export function createContextMenuManager(appContext) {
  // 解构配置选项
  const {
    dom,
    services,
    utils // 新增: 解构 utils
  } = appContext;

  // DOM elements from appContext.dom
  const contextMenu = dom.contextMenu;
  const copyMessageButton = dom.copyMessageButton;
  const copyCodeButton = dom.copyCodeButton;
  const stopUpdateButton = dom.stopUpdateButton;
  const regenerateButton = dom.regenerateButton;
  const deleteMessageButton = dom.deleteMessageButton;
  const clearChatContextButton = dom.clearChatContextButton;
  const chatContainer = dom.chatContainer;
  const threadContainer = dom.threadContainer;
  const forkConversationButton = dom.forkConversationButton;
  const forkConversationArrow = forkConversationButton?.querySelector('.context-menu-item__arrow');
  const screenshotMenu = dom.screenshotMenu || document.getElementById('message-screenshot-menu');
  const downloadAsImageButton = dom.downloadAsImageButton || document.getElementById('download-as-image');
  const selectForImageButton = dom.selectForImageButton || document.getElementById('select-for-image');
  const editMessageButton = document.getElementById('edit-message');
  const insertMessageMenu = document.getElementById('insert-message-menu');
  const insertMessageSubmenu = insertMessageMenu?.querySelector('.context-menu-submenu');
  const insertMessageSubmenuList = insertMessageSubmenu?.querySelector('.context-menu-submenu-list');
  const forkConversationSubmenu = forkConversationButton?.querySelector('.context-menu-submenu');
  const forkConversationSubmenuList = forkConversationSubmenu?.querySelector('.context-menu-submenu-list');
  const screenshotSubmenu = screenshotMenu?.querySelector('.context-menu-submenu');
  const regenerateSubmenu = regenerateButton?.querySelector('.context-menu-submenu');
  const regenerateSubmenuList = regenerateSubmenu?.querySelector('.context-menu-submenu-list');
  const regenerateApiHint = document.getElementById('regenerate-message-api-hint');

  // Services from appContext.services
  const messageSender = services.messageSender;
  const messageProcessor = services.messageProcessor;
  const chatHistoryUI = services.chatHistoryUI;
  const chatHistoryManager = services.chatHistoryManager;
  const chatHistory = chatHistoryManager.chatHistory; // The actual history data object
  const apiManager = services.apiManager;
  const settingsManager = services.settingsManager;

  // Private state
  let currentMessageElement = null;
  let currentMessageContainer = null;
  let currentCodeBlock = null;
  let isEditing = false;
  const SUBMENU_EDGE_GAP_PX = 6;
  const SUBMENU_VIEWPORT_MARGIN_PX = 8;
  const SUBMENU_HIDE_DELAY_MS = 120;
  const INSERT_SUBMENU_PLACEMENT_OPTIONS = Object.freeze({
    anchorSelector: '.context-menu-submenu-item[data-insert-type="both"][data-insert-position="after"]',
    anchorAlign: 'center'
  });
  const FORK_ACTION_THREAD_FLATTEN_MAIN = 'thread-flatten-main';
  let activeContextSubmenu = null;
  let submenuHoverHideTimer = null;

  const MESSAGE_IMAGE_EXPORT_DEFAULTS = {
    widthPx: 0,         // 0 = 跟随消息当前宽度
    fontSizePx: 0,      // 0 = 跟随消息当前字号
    resolutionScale: 1, // 1x = 原始像素比
    paddingPx: 15,
    fontFamilyKey: 'inherit'
  };

  const MESSAGE_IMAGE_EXPORT_FONT_FAMILY_MAP = {
    inherit: '',
    'system-sans': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif',
    serif: '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "Times New Roman", serif',
    monospace: '"JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace'
  };
  const MESSAGE_SCREENSHOT_SELECTION_MODE_CLASS = 'message-screenshot-selection-mode';
  const MESSAGE_SCREENSHOT_SELECTABLE_CLASS = 'message-screenshot-selectable';
  const MESSAGE_SCREENSHOT_SELECTED_CLASS = 'message-screenshot-selected';
  const MESSAGE_SCREENSHOT_VIRTUAL_PIN_MARKER = 'messageScreenshotSelectionVirtualPin';
  const messageScreenshotSelection = {
    active: false,
    container: null,
    selectedIds: new Set(),
    toolbar: null
  };
  let isMessageScreenshotExporting = false;
  let messageScreenshotExportTarget = null;

  function clampNumberInRange(value, min, max, fallback, step = 0) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    const clamped = Math.min(max, Math.max(min, numeric));
    if (step > 0) {
      const stepped = Math.round(clamped / step) * step;
      return Number(stepped.toFixed(2));
    }
    return Math.round(clamped);
  }

  function normalizeExportFontFamilyKey(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'system-sans') return 'system-sans';
    if (normalized === 'serif') return 'serif';
    if (normalized === 'monospace') return 'monospace';
    return 'inherit';
  }

  /**
   * 读取“复制为图片”导出参数。
   * 说明：设置由 settings_manager 做过一次规范化，这里再兜底一次，避免异常值导致截图失败。
   */
  function resolveMessageImageExportOptions() {
    const widthPx = clampNumberInRange(
      settingsManager?.getSetting?.('copyImageWidth'),
      0,
      1600,
      MESSAGE_IMAGE_EXPORT_DEFAULTS.widthPx
    );
    const fontSizePx = clampNumberInRange(
      settingsManager?.getSetting?.('copyImageFontSize'),
      0,
      32,
      MESSAGE_IMAGE_EXPORT_DEFAULTS.fontSizePx
    );
    const resolutionScale = clampNumberInRange(
      settingsManager?.getSetting?.('copyImageScale'),
      1,
      4,
      MESSAGE_IMAGE_EXPORT_DEFAULTS.resolutionScale,
      0.25
    );
    const paddingPx = clampNumberInRange(
      settingsManager?.getSetting?.('copyImagePadding'),
      0,
      64,
      MESSAGE_IMAGE_EXPORT_DEFAULTS.paddingPx
    );
    const fontFamilyKey = normalizeExportFontFamilyKey(
      settingsManager?.getSetting?.('copyImageFontFamily') || MESSAGE_IMAGE_EXPORT_DEFAULTS.fontFamilyKey
    );
    return {
      widthPx,
      fontSizePx,
      resolutionScale,
      paddingPx,
      fontFamilyKey,
      fontFamilyCss: MESSAGE_IMAGE_EXPORT_FONT_FAMILY_MAP[fontFamilyKey] || ''
    };
  }

  function resolveMessageContainer(messageElement) {
    if (!messageElement) return chatContainer;
    if (threadContainer && threadContainer.contains(messageElement)) return threadContainer;
    if (chatContainer && chatContainer.contains(messageElement)) return chatContainer;
    return chatContainer;
  }

  function isResponsesLocalCompactionNode(node) {
    return !!(
      node
      && typeof node === 'object'
      && (
        node.contextCompactionMarker
        || node.responsesLocalCompactionStatus
      )
    );
  }

  function resolveResponsesLocalCompactionMenuState(messageElement) {
    if (!(messageElement instanceof HTMLElement)) {
      return {
        isCompaction: false,
        state: '',
        messageId: '',
        node: null
      };
    }
    const messageId = (messageElement.getAttribute('data-message-id') || '').trim();
    const node = messageId ? findHistoryMessageById(messageId) : null;
    const isCompaction = !!(
      messageElement.classList.contains('context-compaction-message')
      || isResponsesLocalCompactionNode(node)
    );
    if (!isCompaction) {
      return {
        isCompaction: false,
        state: '',
        messageId,
        node
      };
    }

    const statusState = typeof node?.responsesLocalCompactionStatus?.state === 'string'
      ? node.responsesLocalCompactionStatus.state.trim().toLowerCase()
      : '';
    const elementState = typeof messageElement.dataset?.compactionState === 'string'
      ? messageElement.dataset.compactionState.trim().toLowerCase()
      : '';
    const state = statusState || elementState || (node?.contextCompactionMarker ? 'success' : '');
    return {
      isCompaction: true,
      state,
      messageId,
      node
    };
  }

  function isResponsesLocalCompactionMessageElement(messageElement) {
    return resolveResponsesLocalCompactionMenuState(messageElement).isCompaction;
  }

  function getScreenshotSelectionContainers() {
    return [chatContainer, threadContainer].filter((container, index, list) => (
      container && list.indexOf(container) === index
    ));
  }

  function resolveScreenshotMessageId(messageElement) {
    if (!(messageElement instanceof HTMLElement)) return '';
    if (!messageElement.classList.contains('message')) return '';
    if (messageElement.classList.contains('loading-message')) return '';
    if (isResponsesLocalCompactionMessageElement(messageElement)) return '';
    return (messageElement.getAttribute('data-message-id') || '').trim();
  }

  function setContextMenuItemLabel(item, iconClass, label) {
    if (!(item instanceof HTMLElement)) return;
    item.innerHTML = '';
    const icon = document.createElement('i');
    icon.className = iconClass;
    const text = document.createElement('span');
    text.textContent = label;
    item.appendChild(icon);
    item.appendChild(text);
  }

  function setScreenshotMenuLabel(iconClass, label) {
    const labelRoot = screenshotMenu?.querySelector('.context-menu-item__label');
    const icon = labelRoot?.querySelector('i');
    const text = labelRoot?.querySelector('span');
    if (icon) icon.className = iconClass;
    if (text) text.textContent = label;
  }

  function closeAndHideContextSubmenu(menuItem, submenu) {
    if (menuItem instanceof HTMLElement) {
      menuItem.style.display = 'none';
    }
    closeContextSubmenu(submenu, menuItem);
  }

  function applyResponsesLocalCompactionContextMenu(compactionMenuState) {
    if (!compactionMenuState?.isCompaction) return false;

    // compact marker 是一个历史边界，不是可复制/编辑/截图/分支的普通对话内容。
    // 右键菜单只保留能改变该边界自身生命周期的动作，避免把状态分隔线误当成正文消息。
    copyCodeButton.style.display = 'none';
    currentCodeBlock = null;
    copyMessageButton.style.display = 'none';
    if (screenshotMenu) {
      closeAndHideContextSubmenu(screenshotMenu, screenshotSubmenu);
    }
    if (editMessageButton) {
      editMessageButton.style.display = 'none';
    }
    if (regenerateButton) {
      closeAndHideContextSubmenu(regenerateButton, regenerateSubmenu);
    }
    if (insertMessageMenu) {
      closeAndHideContextSubmenu(insertMessageMenu, insertMessageSubmenu);
    }
    if (forkConversationButton) {
      forkConversationButton.classList.remove('disabled');
      closeAndHideContextSubmenu(forkConversationButton, forkConversationSubmenu);
    }
    if (selectForImageButton) {
      selectForImageButton.style.display = 'none';
    }
    const isPending = compactionMenuState.state === 'pending';
    stopUpdateButton.style.display = isPending ? 'flex' : 'none';
    if (isPending) {
      setContextMenuItemLabel(stopUpdateButton, 'far fa-stop', '取消压缩');
    }
    if (deleteMessageButton) {
      deleteMessageButton.style.display = 'flex';
    }
    return true;
  }

  function getActiveScreenshotSelectionContainer(referenceElement = null) {
    if (messageScreenshotSelection.container instanceof HTMLElement) {
      return messageScreenshotSelection.container;
    }
    const referenceContainer = resolveMessageContainer(referenceElement);
    return referenceContainer || chatContainer || threadContainer || null;
  }

  function getOrderedScreenshotSelectionMessageElements(referenceElement = null) {
    const container = getActiveScreenshotSelectionContainer(referenceElement);
    if (!container || messageScreenshotSelection.selectedIds.size === 0) return [];
    return Array.from(container.querySelectorAll('.message[data-message-id]'))
      .filter((messageElement) => {
        const messageId = resolveScreenshotMessageId(messageElement);
        return messageId && messageScreenshotSelection.selectedIds.has(messageId);
      });
  }

  function ensureMessageScreenshotSelectionToolbar() {
    if (messageScreenshotSelection.toolbar instanceof HTMLElement) {
      return messageScreenshotSelection.toolbar;
    }

    const toolbar = document.createElement('div');
    toolbar.className = 'message-screenshot-selection-toolbar';
    toolbar.innerHTML = `
      <span class="message-screenshot-selection-toolbar__count">已选 0 条</span>
      <button class="message-screenshot-selection-toolbar__button message-screenshot-selection-toolbar__button--primary" type="button" data-action="copy" title="复制长截图" aria-label="复制长截图">
        <i class="far fa-images" aria-hidden="true"></i>
        <span>复制</span>
      </button>
      <button class="message-screenshot-selection-toolbar__button" type="button" data-action="download" title="下载长截图" aria-label="下载长截图">
        <i class="fa-solid fa-download" aria-hidden="true"></i>
        <span>下载</span>
      </button>
      <button class="message-screenshot-selection-toolbar__button" type="button" data-action="clear" title="清空选择" aria-label="清空选择">
        <i class="far fa-eraser" aria-hidden="true"></i>
      </button>
      <button class="message-screenshot-selection-toolbar__button" type="button" data-action="exit" title="退出选择" aria-label="退出选择">
        <i class="far fa-times" aria-hidden="true"></i>
      </button>
    `;
    toolbar.addEventListener('click', (event) => {
      const target = event.target instanceof Element
        ? event.target.closest('[data-action]')
        : null;
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      const action = target.getAttribute('data-action');
      if (action === 'copy') {
        copyMessageAsImage();
      } else if (action === 'download') {
        downloadMessageAsImage();
      } else if (action === 'clear') {
        clearMessageScreenshotSelection({ keepMode: true });
      } else if (action === 'exit') {
        exitMessageScreenshotSelectionMode({ clear: true });
      }
    });
    document.body.appendChild(toolbar);
    messageScreenshotSelection.toolbar = toolbar;
    return toolbar;
  }

  function syncScreenshotExportMenuLabels() {
    const selectedCount = messageScreenshotSelection.selectedIds.size;
    if (selectedCount > 0) {
      setScreenshotMenuLabel('far fa-images', `复制已选 ${selectedCount} 条为图片`);
      if (downloadAsImageButton) {
        setContextMenuItemLabel(downloadAsImageButton, 'fa-solid fa-download', `下载已选 ${selectedCount} 条长截图`);
      }
      return;
    }
    setScreenshotMenuLabel('far fa-camera', '截图');
    if (downloadAsImageButton) {
      setContextMenuItemLabel(downloadAsImageButton, 'fa-solid fa-download', '下载当前消息截图');
    }
  }

  function updateMessageScreenshotSelectionToolbar() {
    const toolbar = ensureMessageScreenshotSelectionToolbar();
    const count = messageScreenshotSelection.selectedIds.size;
    toolbar.hidden = !messageScreenshotSelection.active;
    toolbar.querySelector('.message-screenshot-selection-toolbar__count').textContent = `已选 ${count} 条`;
    ['copy', 'download'].forEach((action) => {
      const button = toolbar.querySelector(`[data-action="${action}"]`);
      if (!(button instanceof HTMLButtonElement)) return;
      const isBusy = isMessageScreenshotExporting && messageScreenshotExportTarget === action;
      button.disabled = count === 0 || isMessageScreenshotExporting;
      button.classList.toggle('is-busy', isBusy);
      button.setAttribute('aria-busy', isBusy ? 'true' : 'false');
      const icon = button.querySelector('i');
      if (icon) {
        icon.className = isBusy
          ? 'far fa-spinner'
          : (action === 'copy' ? 'far fa-images' : 'fa-solid fa-download');
      }
      const label = button.querySelector('span');
      if (label) {
        label.textContent = isBusy ? '正在截图...' : (action === 'copy' ? '复制' : '下载');
      }
    });
  }

  function setMessageScreenshotExporting(isExporting, target = null) {
    isMessageScreenshotExporting = !!isExporting;
    messageScreenshotExportTarget = isMessageScreenshotExporting ? target : null;
    updateMessageScreenshotSelectionToolbar();
  }

  function showMessageScreenshotExportNotification(messageElements) {
    const count = Array.isArray(messageElements) ? messageElements.length : 0;
    const isLongScreenshot = count > 1;
    const message = isLongScreenshot
      ? `正在生成长截图（${count} 条消息）...`
      : '正在生成截图...';
    try {
      return utils?.showNotification?.({
        message,
        type: 'info',
        autoClose: false,
        showProgress: true,
        progressMode: 'indeterminate',
        progress: 0
      }) || null;
    } catch (_) {
      return null;
    }
  }

  function updateMessageScreenshotExportNotification(toast, state, detail = {}) {
    if (!toast || typeof toast.update !== 'function') return;
    const count = Number(detail?.count) || 0;
    const isLongScreenshot = count > 1;
    if (state === 'success') {
      const copiedToClipboard = detail?.target === 'clipboard';
      toast.update({
        message: copiedToClipboard ? '截图完成，已复制到剪贴板' : '截图完成，已下载图片',
        description: isLongScreenshot ? `已处理 ${count} 条消息` : '',
        type: 'success',
        showProgress: false,
        progress: null,
        autoClose: true,
        duration: 1800
      });
      return;
    }
    if (state === 'error') {
      toast.update({
        message: '截图失败',
        description: String(detail?.error?.message || detail?.error || ''),
        type: 'error',
        showProgress: false,
        progress: null,
        autoClose: true,
        duration: 2600
      });
    }
  }

  function syncMessageScreenshotSelectionDecorations() {
    const activeContainer = messageScreenshotSelection.container;
    getScreenshotSelectionContainers().forEach((container) => {
      const isActiveContainer = messageScreenshotSelection.active && (!activeContainer || activeContainer === container);
      container.querySelectorAll('.message[data-message-id]').forEach((messageElement) => {
        const messageId = resolveScreenshotMessageId(messageElement);
        const selected = !!(messageId && messageScreenshotSelection.selectedIds.has(messageId));
        messageElement.classList.toggle(MESSAGE_SCREENSHOT_SELECTABLE_CLASS, isActiveContainer);
        messageElement.classList.toggle(MESSAGE_SCREENSHOT_SELECTED_CLASS, selected);
        if (selected) {
          if (messageElement.dataset.virtualPin !== '1') {
            messageElement.dataset[MESSAGE_SCREENSHOT_VIRTUAL_PIN_MARKER] = '1';
          }
          messageElement.dataset.virtualPin = '1';
          messageElement.setAttribute('aria-selected', 'true');
        } else {
          if (messageElement.dataset[MESSAGE_SCREENSHOT_VIRTUAL_PIN_MARKER] === '1') {
            delete messageElement.dataset.virtualPin;
            delete messageElement.dataset[MESSAGE_SCREENSHOT_VIRTUAL_PIN_MARKER];
          }
          messageElement.removeAttribute('aria-selected');
        }
      });
    });
    document.body.classList.toggle(MESSAGE_SCREENSHOT_SELECTION_MODE_CLASS, messageScreenshotSelection.active);
    updateMessageScreenshotSelectionToolbar();
    syncScreenshotExportMenuLabels();
  }

  function enterMessageScreenshotSelectionMode(container, seedMessageElement = null) {
    const nextContainer = container || resolveMessageContainer(seedMessageElement) || chatContainer;
    if (messageScreenshotSelection.container && messageScreenshotSelection.container !== nextContainer) {
      messageScreenshotSelection.selectedIds.clear();
    }
    messageScreenshotSelection.active = true;
    messageScreenshotSelection.container = nextContainer;

    const seedId = resolveScreenshotMessageId(seedMessageElement);
    if (seedId) {
      messageScreenshotSelection.selectedIds.add(seedId);
    }
    syncMessageScreenshotSelectionDecorations();
  }

  function exitMessageScreenshotSelectionMode(options = {}) {
    const shouldClear = options?.clear !== false;
    messageScreenshotSelection.active = false;
    if (shouldClear) {
      messageScreenshotSelection.selectedIds.clear();
      messageScreenshotSelection.container = null;
    }
    syncMessageScreenshotSelectionDecorations();
  }

  function clearMessageScreenshotSelection(options = {}) {
    messageScreenshotSelection.selectedIds.clear();
    if (!options?.keepMode) {
      messageScreenshotSelection.active = false;
      messageScreenshotSelection.container = null;
    }
    syncMessageScreenshotSelectionDecorations();
  }

  function toggleMessageScreenshotSelection(messageElement) {
    const messageId = resolveScreenshotMessageId(messageElement);
    if (!messageId) return;
    const container = resolveMessageContainer(messageElement);
    if (!messageScreenshotSelection.active || messageScreenshotSelection.container !== container) {
      enterMessageScreenshotSelectionMode(container, null);
    }
    if (messageScreenshotSelection.selectedIds.has(messageId)) {
      messageScreenshotSelection.selectedIds.delete(messageId);
    } else {
      messageScreenshotSelection.selectedIds.add(messageId);
    }
    syncMessageScreenshotSelectionDecorations();
  }

  function handleMessageScreenshotSelectionClick(event, container) {
    if (!messageScreenshotSelection.active) return;
    if (!container || messageScreenshotSelection.container !== container) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('a, button, input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"], .context-menu-submenu, #context-menu, .message-screenshot-selection-toolbar')) {
      return;
    }
    const messageElement = target.closest('.message');
    if (!messageElement || !container.contains(messageElement)) return;
    event.preventDefault();
    event.stopPropagation();
    toggleMessageScreenshotSelection(messageElement);
  }

  function findAdjacentMessageElement(baseElement, direction = 'next') {
    if (!baseElement) return null;
    const usePrev = direction === 'previous';
    let cursor = usePrev ? baseElement.previousElementSibling : baseElement.nextElementSibling;
    while (cursor && !(cursor.classList && cursor.classList.contains('message'))) {
      cursor = usePrev ? cursor.previousElementSibling : cursor.nextElementSibling;
    }
    return (cursor instanceof HTMLElement) ? cursor : null;
  }

  function canInsertBeforeMessage(baseElement) {
    if (!baseElement) return false;
    const baseMessageId = baseElement.getAttribute('data-message-id') || '';
    if (!baseMessageId) return false;
    const baseNode = findHistoryMessageById(baseMessageId);
    if (!baseNode) return false;
    const previousVisible = findAdjacentMessageElement(baseElement, 'previous');
    if (previousVisible) return true;
    if (baseNode.parentId) return true;
    return typeof chatHistoryManager?.addMessageToTreeWithOptions === 'function';
  }

  function findHistoryMessageById(messageId) {
    const id = (typeof messageId === 'string') ? messageId.trim() : '';
    if (!id || !chatHistoryManager?.chatHistory?.messages) return null;
    return chatHistoryManager.chatHistory.messages.find(node => node?.id === id) || null;
  }

  /**
   * 在线程容器内，优先使用历史链路解析“重新生成”的目标，避免 DOM 被隐藏/重排时误判。
   * @param {HTMLElement} messageElement
   * @param {HTMLElement|null} container
   * @returns {Object|null}
   */
  function resolveRegenerateTargetFromHistory(messageElement, container) {
    const messageId = messageElement?.getAttribute?.('data-message-id') || '';
    if (!messageId) return null;
    const nodes = chatHistoryManager?.chatHistory?.messages || [];
    const findNode = (id) => nodes.find(n => n.id === id) || null;
    const node = findNode(messageId);
    if (!node) return null;

    const isAi = node.role === 'assistant';
    const isUser = node.role === 'user';
    if (!isAi && !isUser) return null;

    const findParentUser = (startNode) => {
      let current = startNode;
      const visited = new Set();
      while (current) {
        if (current.role === 'user') return current;
        if (visited.has(current.id)) break;
        visited.add(current.id);
        current = current.parentId ? findNode(current.parentId) : null;
      }
      return null;
    };

    const findNextAi = (startNode, threadId) => {
      let current = startNode;
      const visited = new Set();
      while (current) {
        const children = Array.isArray(current.children) ? current.children : [];
        const candidates = children
          .map(id => findNode(id))
          .filter(Boolean)
          .filter(child => !threadId || child.threadId === threadId);
        if (!candidates.length) return null;
        // 线程内默认按时间最早的子节点作为“下一条”
        const next = candidates.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))[0];
        if (!next || visited.has(next.id)) return null;
        if (next.role === 'assistant') return next;
        visited.add(next.id);
        current = next;
      }
      return null;
    };

    const userNode = isUser ? node : findParentUser(node);
    if (!userNode) return null;

    let targetAiNode = isAi ? node : findNextAi(userNode, userNode.threadId || null);
    // 说明：当连续出现多条 user 消息时，重新生成应等价于“最后一条 user -> 下一条 AI”，
    // 这样上下文会覆盖整个连续 user 片段，避免在中途选中时丢掉后续用户消息。
    let effectiveUserNode = userNode;
    if (targetAiNode) {
      const parentUser = findParentUser(targetAiNode);
      if (parentUser) {
        effectiveUserNode = parentUser;
      }
    } else {
      // 没有 AI（例如尚未回复）：沿着最早子链向后，找到连续 user 的最后一条。
      let cursor = userNode;
      let lastUser = userNode;
      const visited = new Set();
      while (cursor) {
        const children = Array.isArray(cursor.children) ? cursor.children : [];
        const candidates = children
          .map(id => findNode(id))
          .filter(Boolean)
          .filter(child => !userNode.threadId || child.threadId === userNode.threadId);
        if (!candidates.length) break;
        const next = candidates.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))[0];
        if (!next || visited.has(next.id)) break;
        if (next.role === 'assistant') break;
        if (next.role === 'user') {
          lastUser = next;
        }
        visited.add(next.id);
        cursor = next;
      }
      effectiveUserNode = lastUser || userNode;
    }

    if (!effectiveUserNode || effectiveUserNode.threadHiddenSelection) return null;

    const userMessageId = effectiveUserNode.id || '';
    if (!userMessageId) return null;

    let userMessageElement = null;
    if (container) {
      const rawId = String(userMessageId);
      let safeId = rawId;
      try {
        if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
          safeId = CSS.escape(rawId);
        }
      } catch (_) {
        safeId = rawId.replace(/["\\]/g, '\\$&');
      }
      userMessageElement = container.querySelector(`.message[data-message-id="${safeId}"]`);
    }

    // 线程内链路可能因编辑/删除造成 children 不完整，这里用 DOM 兜底匹配下一条 AI。
    const findNextAiElement = (startElement) => {
      let cursor = startElement ? startElement.nextElementSibling : null;
      while (cursor) {
        if (cursor.classList?.contains('ai-message')) return cursor;
        cursor = cursor.nextElementSibling;
      }
      return null;
    };

    let targetAiMessageElement = isAi ? messageElement : null;
    if (!targetAiNode && !isAi && userMessageElement && container) {
      const nextAiElement = findNextAiElement(userMessageElement);
      if (nextAiElement) {
        targetAiMessageElement = nextAiElement;
        const fallbackId = nextAiElement.getAttribute('data-message-id') || '';
        if (fallbackId) {
          targetAiNode = findNode(fallbackId);
        }
      }
    }

    const originalMessageText = userMessageElement?.getAttribute?.('data-original-text')
      || (typeof effectiveUserNode.content === 'string' ? effectiveUserNode.content : '');
    const targetAiMessageId = targetAiNode ? targetAiNode.id : (targetAiMessageElement?.getAttribute?.('data-message-id') || null);
    const targetAiMessageIds = targetAiMessageId ? [targetAiMessageId] : [];

    return {
      sourceRole: isAi ? 'assistant' : 'user',
      sourceMessageId: node.id,
      userMessageElement,
      userMessageId,
      originalMessageText,
      targetAiMessageElement,
      targetAiMessageId,
      targetAiMessageIds
    };
  }

  /**
   * 解析“重新生成”的目标：
   * - 若右键/触发点是 AI 消息：重生成该 AI 消息（目标=自身），其对应的用户消息为「向上最近的一条 user」；
   * - 若右键/触发点是用户消息：重生成该用户消息之后的第一条 AI 消息（目标=下一条 AI）。
   *
   * 设计约束：
   * - 必须做到“只替换目标 AI 消息的内容”，不删除/不改动其他消息；
   * - 连续 user 消息视作同一“用户片段”：重生成应等价于“最后一条 user -> 下一条 AI”，
   *   上下文裁剪到该最后 user（messageId=该用户消息ID），以保留同片段内的所有 user 输入。
   *
   * @param {HTMLElement|null} messageElement
   * @returns {{
   *   sourceRole: 'assistant'|'user',
   *   sourceMessageId: string,
   *   userMessageElement: HTMLElement,
   *   userMessageId: string,
   *   originalMessageText: string,
   *   targetAiMessageElement: HTMLElement|null,
   *   targetAiMessageId: string|null,
   *   targetAiMessageIds: Array<string>
   * }|null}
   */
  function resolveRegenerateTarget(messageElement) {
    if (!messageElement || !(messageElement instanceof HTMLElement)) return null;

    const activeContainer = resolveMessageContainer(messageElement);
    if (activeContainer === threadContainer) {
      const threadTarget = resolveRegenerateTargetFromHistory(messageElement, activeContainer);
      if (threadTarget) return threadTarget;
    }

    // loading/error 占位消息不支持作为“目标消息”
    if (messageElement.classList.contains('loading-message')) return null;

    const isAi = messageElement.classList.contains('ai-message');
    const isUser = messageElement.classList.contains('user-message');
    if (!isAi && !isUser) return null;

    const findPrevUser = (start) => {
      let el = start;
      while (el && el.previousElementSibling) {
        el = el.previousElementSibling;
        if (el.classList && el.classList.contains('user-message')) return el;
      }
      return null;
    };

    const findNextAi = (start) => {
      let el = start;
      while (el && el.nextElementSibling) {
        el = el.nextElementSibling;
        if (el.classList && el.classList.contains('ai-message')) return el;
      }
      return null;
    };

    const findLastUserInBlock = (start) => {
      let lastUser = start;
      let cursor = start;
      while (cursor && cursor.nextElementSibling) {
        cursor = cursor.nextElementSibling;
        if (!cursor.classList || !cursor.classList.contains('message')) continue;
        if (cursor.classList.contains('user-message')) {
          lastUser = cursor;
          continue;
        }
        if (cursor.classList.contains('ai-message')) break;
        break;
      }
      return lastUser || start;
    };

    const baseUserElement = isAi ? findPrevUser(messageElement) : messageElement;
    // 说明：连续 user 消息时，把“最后一条 user”视为真正触发重生成的消息。
    const userMessageElement = (!isAi && baseUserElement) ? findLastUserInBlock(baseUserElement) : baseUserElement;
    if (!userMessageElement) return null;

    const userMessageId = userMessageElement.getAttribute('data-message-id') || '';
    const originalMessageText = userMessageElement.getAttribute('data-original-text') || '';

    // 用户消息允许为空（例如纯图片/截图场景），但必须有 messageId 才能裁剪上下文
    if (!userMessageId) return null;

    const targetAiMessageElement = isAi ? messageElement : findNextAi(userMessageElement);
    const targetAiMessageId = targetAiMessageElement
      ? (targetAiMessageElement.getAttribute('data-message-id') || null)
      : null;
    const targetAiMessageIds = targetAiMessageId ? [targetAiMessageId] : [];

    return {
      sourceRole: isAi ? 'assistant' : 'user',
      sourceMessageId: messageElement.getAttribute('data-message-id') || '',
      userMessageElement,
      userMessageId,
      originalMessageText,
      targetAiMessageElement,
      targetAiMessageId,
      targetAiMessageIds
    };
  }

  function getFavoriteApiConfigs() {
    if (!apiManager || typeof apiManager.getAllConfigs !== 'function') return [];
    const configs = apiManager.getAllConfigs();
    if (!Array.isArray(configs)) return [];
    return configs.filter(config => config && config.isFavorite);
  }

  function getFavoriteApiLabel(config, index) {
    const displayName = (typeof config?.displayName === 'string') ? config.displayName.trim() : '';
    if (displayName) return displayName;
    const modelName = (typeof config?.modelName === 'string') ? config.modelName.trim() : '';
    if (modelName) return modelName;
    const baseUrl = (typeof config?.baseUrl === 'string') ? config.baseUrl.trim() : '';
    if (baseUrl) return baseUrl;
    return `收藏 API ${index + 1}`;
  }

  // 将任意 API 配置转换为可展示名称，避免出现空白小字。
  function getApiDisplayName(config) {
    const displayName = (typeof config?.displayName === 'string') ? config.displayName.trim() : '';
    if (displayName) return displayName;
    const modelName = (typeof config?.modelName === 'string') ? config.modelName.trim() : '';
    if (modelName) return modelName;
    const baseUrl = (typeof config?.baseUrl === 'string') ? config.baseUrl.trim() : '';
    if (baseUrl) return baseUrl;
    return 'API';
  }

  function resolveApiConfigFromHistoryNode(node) {
    if (!node || node.role !== 'assistant') return null;
    if (node.apiUuid && apiManager?.resolveApiParam) {
      const resolved = apiManager.resolveApiParam({ id: node.apiUuid });
      if (resolved) return resolved;
    }
    if (node.apiDisplayName && apiManager?.resolveApiParam) {
      const resolved = apiManager.resolveApiParam(node.apiDisplayName);
      if (resolved) return resolved;
    }
    if (node.apiModelId && apiManager?.resolveApiParam) {
      const resolved = apiManager.resolveApiParam(node.apiModelId);
      if (resolved) return resolved;
    }
    return null;
  }

  function getRegenerateTargetAiIds(regenTarget) {
    if (!regenTarget || typeof regenTarget !== 'object') return [];
    if (Array.isArray(regenTarget.targetAiMessageIds) && regenTarget.targetAiMessageIds.length > 0) {
      return regenTarget.targetAiMessageIds
        .map((id) => (typeof id === 'string' ? id.trim() : ''))
        .filter(Boolean);
    }
    const single = (typeof regenTarget.targetAiMessageId === 'string') ? regenTarget.targetAiMessageId.trim() : '';
    return single ? [single] : [];
  }

  function resolveRegenerateTargetApiConfigMap(regenTarget) {
    const configMap = new Map();
    const targetIds = getRegenerateTargetAiIds(regenTarget);
    targetIds.forEach((targetId) => {
      if (!targetId || configMap.has(targetId)) return;
      const node = findHistoryMessageById(targetId);
      const config = resolveApiConfigFromHistoryNode(node);
      if (config) {
        configMap.set(targetId, config);
      }
    });
    return configMap;
  }

  function resolvePromptPreferredApiParam(originalMessageText) {
    let apiParam = 'follow_current';
    try {
      const promptSettingsManager = appContext.services.promptSettingsManager;
      const prompts = (typeof promptSettingsManager?.getPrompts === 'function')
        ? (promptSettingsManager.getPrompts() || {})
        : {};
      const content = (typeof originalMessageText === 'string') ? originalMessageText : '';
      const promptType = (typeof messageProcessor?.getPromptTypeFromContent === 'function')
        ? (messageProcessor.getPromptTypeFromContent(content, prompts) || 'none')
        : 'none';
      const modelPref = (prompts[promptType]?.model || '').trim();
      apiParam = modelPref || 'follow_current';
    } catch (_) {
      apiParam = 'follow_current';
    }
    return apiParam;
  }

  /**
   * 解析“重新生成”使用的 API 参数。
   * - 若传入 apiOverride（如收藏 API/手动指定），优先使用该覆盖值；
   * - 未传覆盖值时，默认跟随当前 API 上下文（当前选中或会话锁定）。
   *
   * @param {Object|null} regenTarget
   * @param {any} [apiOverride=null]
   * @returns {any}
   */
  function resolveRegenerateApiParam(regenTarget, apiOverride = null) {
    if (apiOverride != null) return apiOverride;
    return 'follow_current';
  }

  /**
   * 获取“重新生成”默认将使用的 API 配置，用于右键菜单小字提示。
   * 说明：这里与发送逻辑保持一致——只有当 apiParam 能解析到明确配置时才覆盖。
   *
   * @param {Object|null} regenTarget
   * @returns {Object|null}
   */
  function resolveRegenerateDisplayConfig(regenTarget) {
    const apiParam = resolveRegenerateApiParam(regenTarget, null);
    let overrideConfig = null;
    if (apiParam != null && typeof apiManager?.resolveApiParam === 'function') {
      if (typeof apiParam === 'string' && (apiParam === 'follow_current' || apiParam === 'selected')) {
        overrideConfig = null;
      } else {
        overrideConfig = apiManager.resolveApiParam(apiParam) || null;
      }
    }
    const apiContext = (typeof chatHistoryUI?.resolveActiveConversationApiConfig === 'function')
      ? chatHistoryUI.resolveActiveConversationApiConfig()
      : null;
    const displayConfig = apiContext?.displayConfig || apiManager?.getSelectedConfig?.() || null;
    return overrideConfig || displayConfig;
  }

  function buildRegenerateApiHintLabel(regenTarget) {
    const config = resolveRegenerateDisplayConfig(regenTarget);
    return getApiDisplayName(config);
  }

  function updateRegenerateApiHint(regenTarget) {
    if (!regenerateApiHint) return;
    const label = buildRegenerateApiHintLabel(regenTarget);
    regenerateApiHint.textContent = label;
    regenerateApiHint.title = label;
  }

  function buildApiParamFromSubmenuItem(item) {
    if (!item) return null;
    const apiId = item.dataset.apiId;
    if (apiId) return { id: apiId };
    const favoriteIndex = Number(item.dataset.favoriteIndex);
    if (!Number.isNaN(favoriteIndex)) return { favoriteIndex };
    return null;
  }

  function renderRegenerateSubmenu() {
    if (!regenerateSubmenuList) return;
    regenerateSubmenuList.innerHTML = '';
    const favorites = getFavoriteApiConfigs();
    if (!favorites.length) {
      const emptyItem = document.createElement('div');
      emptyItem.className = 'context-menu-submenu-item is-disabled';
      emptyItem.textContent = '暂无收藏 API';
      emptyItem.dataset.disabled = 'true';
      regenerateSubmenuList.appendChild(emptyItem);
      return;
    }
    favorites.forEach((config, index) => {
      const item = document.createElement('div');
      item.className = 'context-menu-submenu-item';
      item.textContent = getFavoriteApiLabel(config, index);
      if (config?.id) item.dataset.apiId = config.id;
      item.dataset.favoriteIndex = String(index);
      regenerateSubmenuList.appendChild(item);
    });
  }

  function clearSubmenuHideTimer() {
    if (!submenuHoverHideTimer) return;
    clearTimeout(submenuHoverHideTimer);
    submenuHoverHideTimer = null;
  }

  function scheduleSubmenuHide() {
    clearSubmenuHideTimer();
    submenuHoverHideTimer = setTimeout(() => {
      submenuHoverHideTimer = null;
      if (!activeContextSubmenu) return;
      const { menuItem, submenu } = activeContextSubmenu;
      try {
        if ((menuItem && menuItem.matches(':hover')) || (submenu && submenu.matches(':hover'))) {
          scheduleSubmenuHide();
          return;
        }
      } catch (_) {
        // 兜底：若 :hover 检测不可用，则按默认流程关闭子菜单。
      }
      closeActiveContextSubmenu();
    }, SUBMENU_HIDE_DELAY_MS);
  }

  /**
   * 将子菜单提升到 body（portal），确保 backdrop-filter 采样到真实页面背景。
   */
  function ensureSubmenuPortal(submenu) {
    if (!submenu || !document.body) return;
    if (!submenu.classList.contains('context-menu-submenu--portal')) {
      submenu.classList.add('context-menu-submenu--portal');
    }
    if (submenu.parentElement !== document.body) {
      document.body.appendChild(submenu);
    }
  }

  /**
   * 计算子菜单定位。
   * placementOptions 为可选参数：
   * - anchorSelector: 子菜单内用于对齐的锚点选择器；
   * - anchorAlign: 'center' | 'top'，控制锚点与主菜单项的对齐方式。
   */
  function resolveSubmenuPlacement(menuItem, submenu, placementOptions = null) {
    const zoomFactor = getDocumentZoomFactor();
    const menuItemRect = getElementLayoutRect(menuItem, { zoomFactor });
    const submenuRect = getElementLayoutRect(submenu, { zoomFactor });
    const submenuSize = getElementLayoutSize(submenu, { zoomFactor });
    const submenuWidth = Math.max(180, Math.round(submenuSize.width || submenuRect.width || 180));
    const submenuHeight = Math.max(0, Math.round(submenuSize.height || submenuRect.height || 0));
    const viewport = getLayoutViewportSize({ zoomFactor });
    const viewportWidth = viewport.width;
    const viewportHeight = viewport.height;
    const edgeGap = toLayoutPixels(SUBMENU_EDGE_GAP_PX, zoomFactor);
    const viewportMargin = toLayoutPixels(SUBMENU_VIEWPORT_MARGIN_PX, zoomFactor);

    const spaceRight = viewportWidth - menuItemRect.right - edgeGap;
    const spaceLeft = menuItemRect.left - edgeGap;
    const openLeft = spaceRight < submenuWidth && spaceLeft >= submenuWidth;

    let left = openLeft
      ? (menuItemRect.left - submenuWidth - edgeGap)
      : (menuItemRect.right + edgeGap);
    let top = menuItemRect.top;
    const anchorSelector = (typeof placementOptions?.anchorSelector === 'string')
      ? placementOptions.anchorSelector.trim()
      : '';
    if (anchorSelector) {
      const anchorNode = submenu.querySelector(anchorSelector);
      if (anchorNode instanceof HTMLElement) {
        const anchorRect = getElementLayoutRect(anchorNode, { zoomFactor });
        const alignMode = placementOptions?.anchorAlign === 'top' ? 'top' : 'center';
        const menuAnchorY = alignMode === 'top'
          ? menuItemRect.top
          : (menuItemRect.top + menuItemRect.height / 2);
        const submenuAnchorY = alignMode === 'top'
          ? anchorRect.top
          : (anchorRect.top + anchorRect.height / 2);
        top = menuAnchorY - (submenuAnchorY - submenuRect.top);
      }
    }

    const maxLeft = Math.max(viewportMargin, viewportWidth - submenuWidth - viewportMargin);
    const maxTop = Math.max(viewportMargin, viewportHeight - submenuHeight - viewportMargin);
    left = Math.min(maxLeft, Math.max(viewportMargin, left));
    top = Math.min(maxTop, Math.max(viewportMargin, top));

    return { openLeft, left, top };
  }

  function positionContextSubmenu(menuItem, submenu, placementOptions = null) {
    if (!menuItem || !submenu) return;
    ensureSubmenuPortal(submenu);
    const placement = resolveSubmenuPlacement(menuItem, submenu, placementOptions);
    menuItem.classList.toggle('context-menu-item--submenu-left', placement.openLeft);
    submenu.classList.toggle('context-menu-submenu--left', placement.openLeft);
    submenu.style.left = `${Math.round(placement.left)}px`;
    submenu.style.top = `${Math.round(placement.top)}px`;
  }

  function closeContextSubmenu(submenu, menuItem = null) {
    if (menuItem) {
      menuItem.classList.remove('context-menu-item--submenu-left');
    }
    if (submenu) {
      submenu.classList.remove('context-menu-submenu--visible');
      submenu.classList.remove('context-menu-submenu--left');
    }
    if (activeContextSubmenu?.submenu === submenu) {
      activeContextSubmenu = null;
    }
  }

  function closeActiveContextSubmenu() {
    if (!activeContextSubmenu) return;
    const { submenu, menuItem } = activeContextSubmenu;
    activeContextSubmenu = null;
    closeContextSubmenu(submenu, menuItem);
  }

  function openContextSubmenu(menuItem, submenu, placementOptions = null) {
    if (!menuItem || !submenu) return;
    if (menuItem.classList?.contains('disabled')) return;
    if (submenu === forkConversationSubmenu) {
      const hasVisibleForkAction = Array.from(forkConversationSubmenuList?.children || [])
        .some((node) => node instanceof HTMLElement && node.style.display !== 'none');
      if (!hasVisibleForkAction) return;
    }
    clearSubmenuHideTimer();
    if (activeContextSubmenu?.submenu && activeContextSubmenu.submenu !== submenu) {
      closeActiveContextSubmenu();
    }
    positionContextSubmenu(menuItem, submenu, placementOptions);
    submenu.classList.add('context-menu-submenu--visible');
    activeContextSubmenu = { menuItem, submenu, placementOptions };
  }

  function updateSubmenuDirection(menuItem, submenu, placementOptions = null) {
    positionContextSubmenu(menuItem, submenu, placementOptions);
  }

  function isTargetInsideAnyContextSubmenu(target) {
    if (!target || !(target instanceof Element)) return false;
    if (regenerateSubmenu && regenerateSubmenu.contains(target)) return true;
    if (insertMessageSubmenu && insertMessageSubmenu.contains(target)) return true;
    if (forkConversationSubmenu && forkConversationSubmenu.contains(target)) return true;
    if (screenshotSubmenu && screenshotSubmenu.contains(target)) return true;
    return false;
  }

  /**
   * 显示上下文菜单
   * @param {MouseEvent} e - 鼠标事件
   * @param {HTMLElement} messageElement - 消息元素
   */
  function showContextMenu(e, messageElement) {
    e.preventDefault();
    currentMessageElement = messageElement;
    currentMessageContainer = resolveMessageContainer(messageElement);
    const activeContainer = currentMessageContainer || chatContainer;

    clearSubmenuHideTimer();
    closeActiveContextSubmenu();
    ensureSubmenuPortal(regenerateSubmenu);
    ensureSubmenuPortal(insertMessageSubmenu);
    ensureSubmenuPortal(forkConversationSubmenu);
    ensureSubmenuPortal(screenshotSubmenu);

    // 设置菜单位置
    contextMenu.style.display = 'block';
    copyMessageButton.style.display = 'flex';
    if (editMessageButton) editMessageButton.style.display = 'flex';
    if (deleteMessageButton) deleteMessageButton.style.display = 'flex';
    if (downloadAsImageButton) downloadAsImageButton.style.display = 'flex';

    // 获取点击的代码块元素
    const codeBlock = e.target.closest('pre code');
    const compactionMenuState = resolveResponsesLocalCompactionMenuState(messageElement);

    // 根据消息状态显示或隐藏停止更新按钮
    // 除了当前消息为 updating 外，只要有任意 AI 消息处于 updating（包括“正在等待回复”的占位消息），也显示“停止更新”
    const hasUpdating = (container) => !!container?.querySelector?.('.ai-message.updating, .loading-message.updating');
    const anyUpdating = hasUpdating(chatContainer) || hasUpdating(threadContainer);
    const hasAbortableRequest = !!messageSender?.hasAbortableRequest?.(messageElement);
    setContextMenuItemLabel(stopUpdateButton, 'far fa-stop', '停止更新');
    if (messageElement.classList.contains('updating') || anyUpdating || hasAbortableRequest) {
      stopUpdateButton.style.display = 'flex';
    } else {
      stopUpdateButton.style.display = 'none';
    }
    // 停止更新动作由 menuactivate 统一触发，这里不再动态绑定 onclick。

    // 根据是否点击代码块显示或隐藏复制代码按钮
    if (codeBlock) {
      copyCodeButton.style.display = 'flex';
      currentCodeBlock = codeBlock;
    } else {
      copyCodeButton.style.display = 'none';
      currentCodeBlock = null;
    }

    // “重新生成”支持任意消息：根据当前消息解析目标是否可重生成
    const regenTarget = resolveRegenerateTarget(messageElement);
    regenerateButton.style.display = regenTarget ? 'flex' : 'none';
    if (regenTarget) {
      renderRegenerateSubmenu();
      updateSubmenuDirection(regenerateButton, regenerateSubmenu, null);
      updateRegenerateApiHint(regenTarget);
    } else {
      closeContextSubmenu(regenerateSubmenu, regenerateButton);
      if (regenerateApiHint) {
        regenerateApiHint.textContent = '';
        regenerateApiHint.removeAttribute('title');
      }
    }

    // “在此处插入”仅对有 messageId 的正式消息生效
    const canShowInsertOptions = !!(
      messageElement &&
      messageElement.getAttribute('data-message-id') &&
      !messageElement.classList.contains('loading-message')
    );
    if (insertMessageMenu) {
      insertMessageMenu.style.display = canShowInsertOptions ? 'flex' : 'none';
      if (canShowInsertOptions) {
        const canInsertBefore = canInsertBeforeMessage(messageElement);
        if (insertMessageSubmenuList) {
          const beforeItems = insertMessageSubmenuList.querySelectorAll('.context-menu-submenu-item[data-insert-position="before"]');
          beforeItems.forEach((item) => {
            item.dataset.disabled = canInsertBefore ? 'false' : 'true';
            item.classList.toggle('is-disabled', !canInsertBefore);
          });
        }
        updateSubmenuDirection(insertMessageMenu, insertMessageSubmenu, INSERT_SUBMENU_PLACEMENT_OPTIONS);
      } else {
        closeContextSubmenu(insertMessageSubmenu, insertMessageMenu);
      }
    }
    const messageId = messageElement?.getAttribute?.('data-message-id') || '';
    const isLoadingMessage = !!messageElement?.classList?.contains?.('loading-message');
    if (selectForImageButton) {
      const canSelectForImage = !!(messageId && !isLoadingMessage);
      selectForImageButton.style.display = canSelectForImage ? 'flex' : 'none';
      if (canSelectForImage) {
        const isSelected = messageScreenshotSelection.selectedIds.has(messageId);
        setContextMenuItemLabel(
          selectForImageButton,
          isSelected ? 'far fa-square-minus' : 'far fa-square-check',
          isSelected ? '移出长截图' : '选择长截图'
        );
      }
    }
    syncScreenshotExportMenuLabels();
    if (screenshotMenu) {
      screenshotMenu.style.display = 'flex';
      updateSubmenuDirection(screenshotMenu, screenshotSubmenu, null);
    }
    const selectionThreadManager = services.selectionThreadManager;
    let canFork = false;
    if (activeContainer === threadContainer) {
      canFork = !!(
        messageId
        && !isLoadingMessage
        && selectionThreadManager?.isThreadModeActive?.()
        && selectionThreadManager?.forkThreadFromMessage
      );
    } else {
      const messageCount = activeContainer ? activeContainer.querySelectorAll('.message').length : 0;
      canFork = !!(messageId && !isLoadingMessage && messageCount > 1);
    }
    if (forkConversationButton) {
      forkConversationButton.style.display = 'flex';
      forkConversationButton.classList.toggle('disabled', !canFork);
    }

    const flattenActionItem = forkConversationSubmenuList?.querySelector?.(
      `.context-menu-submenu-item[data-fork-action="${FORK_ACTION_THREAD_FLATTEN_MAIN}"]`
    ) || null;
    const isThreadContext = activeContainer === threadContainer;
    if (flattenActionItem) {
      if (isThreadContext) {
        const canFlatten = !!(
          messageId
          && !isLoadingMessage
          && selectionThreadManager?.isThreadModeActive?.()
          && selectionThreadManager?.flattenThreadToMainConversation
        );
        flattenActionItem.style.display = 'flex';
        flattenActionItem.dataset.disabled = canFlatten ? 'false' : 'true';
        flattenActionItem.classList.toggle('is-disabled', !canFlatten);
      } else {
        flattenActionItem.style.display = 'none';
        flattenActionItem.dataset.disabled = 'true';
        flattenActionItem.classList.add('is-disabled');
      }
    }
    if (forkConversationArrow) {
      forkConversationArrow.style.display = isThreadContext ? '' : 'none';
    }
    if (isThreadContext && forkConversationSubmenu) {
      updateSubmenuDirection(forkConversationButton, forkConversationSubmenu, null);
    } else {
      closeContextSubmenu(forkConversationSubmenu, forkConversationButton);
    }

    applyResponsesLocalCompactionContextMenu(compactionMenuState);

    // 右键菜单的最终尺寸取决于上方各菜单项是否显示，因此必须在可见性全部更新后再定位。
    // 独立页会对 html 设置 zoom；这里统一走布局坐标，避免 clientX/clientY 直接写入 left/top 后偏移。
    const menuPlacement = resolveFixedOverlayPositionFromClientPoint(e, contextMenu);
    contextMenu.style.left = `${Math.round(menuPlacement.left)}px`;
    contextMenu.style.top = `${Math.round(menuPlacement.top)}px`;
  }

  /**
   * 隐藏上下文菜单
   */
  function hideContextMenu() {
    contextMenu.style.display = 'none';
    clearSubmenuHideTimer();
    closeActiveContextSubmenu();
    closeContextSubmenu(regenerateSubmenu, regenerateButton);
    closeContextSubmenu(insertMessageSubmenu, insertMessageMenu);
    closeContextSubmenu(forkConversationSubmenu, forkConversationButton);
    closeContextSubmenu(screenshotSubmenu, screenshotMenu);
    currentMessageElement = null;
    currentMessageContainer = null;
  }

  /**
   * 复制消息内容
   */
  function copyMessageContent() {
    const messageElement = currentMessageElement;
    if (!messageElement) return;
    const originalText = messageElement.getAttribute('data-original-text') || '';
    hideContextMenu();
    navigator.clipboard.writeText(originalText).catch(err => {
      console.error('复制失败:', err);
    });
  }

  /**
   * 判断节点是否位于聊天主面板或线程面板中。
   * @param {Node|null} node
   * @returns {boolean}
   */
  function isNodeInsideConversationPanels(node) {
    if (!node) return false;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element) return false;
    if (chatContainer?.contains(element)) return true;
    if (threadContainer?.contains(element)) return true;
    return false;
  }

  /**
   * 判断当前焦点是否位于可编辑控件，避免覆盖输入框/编辑器的原生复制行为。
   * @returns {boolean}
   */
  function isEditableFocusActive() {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return false;
    if (active.isContentEditable) return true;
    if (active.tagName === 'TEXTAREA') return true;
    if (active.tagName !== 'INPUT') return false;
    const inputType = (active.getAttribute('type') || 'text').toLowerCase();
    return [
      'text', 'search', 'url', 'tel', 'email', 'password', 'number'
    ].includes(inputType);
  }

  /**
   * 从 KaTeX 节点提取原始 TeX 源码（来自 annotation）。
   * @param {Element} katexElement
   * @returns {string}
   */
  function extractKaTeXSource(katexElement) {
    if (!(katexElement instanceof Element)) return '';
    const annotation = katexElement.querySelector('annotation[encoding="application/x-tex"]');
    return (annotation?.textContent || '').trim();
  }

  /**
   * 将选区片段中的 KaTeX 渲染结果替换回 TeX 文本，避免复制出“可见层 + MathML 层”的重复内容。
   * @param {DocumentFragment} fragment
   * @returns {boolean} 是否发生了替换
   */
  function replaceKaTeXWithSourceInFragment(fragment) {
    if (!(fragment instanceof DocumentFragment)) return false;
    let replaced = false;

    // 先处理块级公式，避免后续 inline 选择器重复命中。
    const displayNodes = Array.from(fragment.querySelectorAll('.katex-display'));
    displayNodes.forEach((displayNode) => {
      const katexNode = displayNode.querySelector('.katex');
      const source = extractKaTeXSource(katexNode || displayNode);
      if (!source) return;
      displayNode.replaceWith(document.createTextNode(`\\[${source}\\]`));
      replaced = true;
    });

    // 再处理行内公式。
    const inlineNodes = Array.from(fragment.querySelectorAll('.katex'));
    inlineNodes.forEach((katexNode) => {
      if (katexNode.closest('.katex-display')) return;
      const source = extractKaTeXSource(katexNode);
      if (!source) return;
      katexNode.replaceWith(document.createTextNode(`\\(${source}\\)`));
      replaced = true;
    });

    return replaced;
  }

  /**
   * 统一处理“手动选择后 Ctrl/Cmd+C”场景：
   * 当选区包含 KaTeX 时，输出稳定的 TeX 文本，避免出现重复符号与错乱换行。
   * @param {ClipboardEvent} event
   */
  function handleMathSelectionCopy(event) {
    if (!event?.clipboardData) return;
    if (isEditableFocusActive()) return;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    if (!isNodeInsideConversationPanels(selection.anchorNode) && !isNodeInsideConversationPanels(selection.focusNode)) return;

    const range = selection.getRangeAt(0);
    const fragment = range.cloneContents();
    if (!(fragment instanceof DocumentFragment)) return;
    if (!fragment.querySelector('.katex') && !fragment.querySelector('.katex-display')) return;
    if (!replaceKaTeXWithSourceInFragment(fragment)) return;

    const buffer = document.createElement('div');
    buffer.appendChild(fragment);
    const plainText = (buffer.innerText || buffer.textContent || '').replace(/\r\n/g, '\n');
    if (!plainText) return;

    event.preventDefault();
    event.clipboardData.setData('text/plain', plainText);
    const htmlText = buffer.innerHTML || '';
    if (htmlText) {
      event.clipboardData.setData('text/html', htmlText);
    }
  }

  /**
   * 复制代码块内容
   */
  function copyCodeContent() {
    const codeBlock = currentCodeBlock;
    if (!codeBlock) return;
    const codeContent = codeBlock.textContent || '';
    hideContextMenu();
    navigator.clipboard.writeText(codeContent).catch(err => {
      console.error('复制失败:', err);
    });
  }
  /**
   * 重新生成消息
   */
  async function regenerateMessage(targetMessageElement = null, apiOverride = null) {
    // 注意：该函数既会被按钮 click 事件直接调用（参数是 MouseEvent），
    // 也会被 Ctrl+Enter 场景传入“被编辑的消息元素”。这里统一做一次参数归一化。
    const elementArg = (targetMessageElement && targetMessageElement.nodeType === 1)
      ? targetMessageElement
      : null;
    const baseElement = elementArg || currentMessageElement;
    hideContextMenu();
    const regenTarget = resolveRegenerateTarget(baseElement);
    if (!regenTarget) {
      return;
    }

    const {
      userMessageId,
      originalMessageText,
      targetAiMessageId
    } = regenTarget;
    const targetAiMessageIds = getRegenerateTargetAiIds(regenTarget);

    try {
      const apiParam = resolveRegenerateApiParam(regenTarget, apiOverride);

      // 关键：重新生成现在也统一走 sender 内部的 mutation/job 协调器，
      // 避免 running / queue / 历史编辑 叠加时继续出现未定义行为。
      await messageSender.requestRegenerateMessage({
        originalMessageText,
        messageId: userMessageId,
        targetAiMessageId: targetAiMessageId || targetAiMessageIds[0] || null,
        api: apiParam
      });
    } catch (err) {
      console.error('准备重新生成消息时出错:', err);
    }
  }

  /**
   * 在指定消息下方插入一条空白消息。
   *
   * 设计说明：
   * - UI 插入位置以 DOM 为准：插入到基准消息的下方（也就是其后第一条 .message 之前）；
   * - 历史插入以 messageId 为准：使用 chatHistoryManager.insertMessageAfter() 同步维护 parentId/children，
   *   并把新节点插入到 messages 数组的正确位置，保证保存/重载后顺序一致。
   *
   * @param {'ai'|'user'} sender
   * @param {HTMLElement} baseElement
   * @param {{ openEditor?: boolean, skipSave?: boolean }} [options]
   * @returns {Promise<HTMLElement|null>}
   */
  async function insertBlankMessageAfter(sender, baseElement, options = {}) {
    let newMessageDiv = null;
    try {
      if (!baseElement) return null;
      const targetContainer = currentMessageContainer || resolveMessageContainer(baseElement) || chatContainer;
      const afterMessageId = baseElement.getAttribute('data-message-id') || '';
      if (!afterMessageId) return null;
      if (!chatHistoryManager || typeof chatHistoryManager.insertMessageAfter !== 'function') {
        console.warn('insertMessageAfter 不存在，无法插入消息');
        return null;
      }
      if (!messageProcessor || typeof messageProcessor.appendMessage !== 'function') {
        console.warn('messageProcessor.appendMessage 不存在，无法插入消息');
        return null;
      }

      const nextMessageElement = findAdjacentMessageElement(baseElement, 'next');
      const nextMessageId = nextMessageElement
        ? (nextMessageElement.getAttribute('data-message-id') || null)
        : null;

      // 1) 先插入到历史结构中（生成新 messageId）
      const role = (sender === 'ai') ? 'assistant' : 'user';
      const newNode = chatHistoryManager.insertMessageAfter(
        afterMessageId,
        role,
        '',
        { nextMessageId }
      );
      if (!newNode || !newNode.id) return null;

      // 2) 构建消息 DOM（跳过历史写入），再移动到目标位置
      newMessageDiv = messageProcessor.appendMessage('', sender, true, null, null, null, null, null, {
        container: targetContainer
      });
      if (!newMessageDiv) return null;
      newMessageDiv.setAttribute('data-message-id', newNode.id);

      // AI 消息：补一个空的 api-footer，保证样式稳定（与普通 AI 消息一致）
      if (sender === 'ai') {
        const footer = newMessageDiv.querySelector('.api-footer');
        if (!footer) {
          const apiFooter = document.createElement('div');
          apiFooter.className = 'api-footer';
          newMessageDiv.appendChild(apiFooter);
        }
      }

      // 将新消息插到“基准消息的下方”
      if (nextMessageElement && nextMessageElement.parentNode === targetContainer) {
        targetContainer.insertBefore(newMessageDiv, nextMessageElement);
      } else {
        // 没有下一条消息：插到末尾（appendMessage 已经 append 到末尾，这里确保位置正确即可）
        if (newMessageDiv.parentNode !== targetContainer) {
          targetContainer.appendChild(newMessageDiv);
        }
      }

      const shouldOpenEditor = options.openEditor === true;
      if (shouldOpenEditor && !isEditing) {
        try { startInlineEdit(newMessageDiv); } catch (e) { console.error('打开新插入消息的编辑器失败:', e); }
      }
      if (!options.skipSave) {
        await chatHistoryUI.saveCurrentConversation(true);
      }
      return newMessageDiv;
    } catch (e) {
      console.error('插入空白消息失败:', e);
      return null;
    }
  }

  /**
   * 在“当前右键选中的消息”下方插入一条空白消息。
   * @param {'ai'|'user'} sender
   */
  async function insertBlankMessageBelow(sender) {
    const baseElement = currentMessageElement;
    try {
      if (!baseElement) return;
      hideContextMenu();
      await insertBlankMessageAfter(sender, baseElement, { openEditor: true });
    } finally {
      hideContextMenu();
    }
  }

  /**
   * 在指定消息上方插入一条空白消息（支持“第一条消息之前”）。
   *
   * 关键场景：
   * - 若存在可见前驱消息，等价于“在前驱之后插入”；
   * - 若当前是容器首条可见消息，但历史上仍有 parent（例如线程首条可见消息的隐藏 root），
   *   则挂到 parent 后并把 base 作为 next；
   * - 若当前就是会话根消息，则创建新的根节点并把旧根挂到其下。
   */
  async function insertBlankMessageBefore(sender, baseElement, options = {}) {
    let newMessageDiv = null;
    try {
      if (!baseElement) return null;
      const targetContainer = currentMessageContainer || resolveMessageContainer(baseElement) || chatContainer;
      const baseMessageId = baseElement.getAttribute('data-message-id') || '';
      if (!baseMessageId) return null;
      if (!chatHistoryManager || typeof chatHistoryManager.insertMessageAfter !== 'function') {
        console.warn('insertMessageAfter 不存在，无法插入消息');
        return null;
      }
      if (!messageProcessor || typeof messageProcessor.appendMessage !== 'function') {
        console.warn('messageProcessor.appendMessage 不存在，无法插入消息');
        return null;
      }

      const previousMessageElement = findAdjacentMessageElement(baseElement, 'previous');
      if (previousMessageElement) {
        return await insertBlankMessageAfter(sender, previousMessageElement, options);
      }

      const role = (sender === 'ai') ? 'assistant' : 'user';
      const baseNode = findHistoryMessageById(baseMessageId);
      if (!baseNode) return null;

      let newNode = null;
      if (baseNode.parentId) {
        newNode = chatHistoryManager.insertMessageAfter(
          baseNode.parentId,
          role,
          '',
          { nextMessageId: baseMessageId }
        );
      } else {
        if (typeof chatHistoryManager.addMessageToTreeWithOptions !== 'function') {
          console.warn('addMessageToTreeWithOptions 不存在，无法在首条消息前插入');
          return null;
        }
        newNode = chatHistoryManager.addMessageToTreeWithOptions(role, '', null, { preserveCurrentNode: true });
        if (!newNode || !newNode.id) return null;
        const historyMessages = chatHistoryManager?.chatHistory?.messages || [];
        const createdIndex = historyMessages.findIndex((node) => node?.id === newNode.id);
        const baseIndex = historyMessages.findIndex((node) => node?.id === baseMessageId);
        if (createdIndex !== -1) {
          historyMessages.splice(createdIndex, 1);
        }
        historyMessages.splice(baseIndex === -1 ? 0 : baseIndex, 0, newNode);
        newNode.parentId = null;
        newNode.children = [baseMessageId];
        baseNode.parentId = newNode.id;
        if (chatHistoryManager?.chatHistory) {
          chatHistoryManager.chatHistory.root = newNode.id;
        }
      }
      if (!newNode || !newNode.id) return null;

      newMessageDiv = messageProcessor.appendMessage('', sender, true, null, null, null, null, null, {
        container: targetContainer
      });
      if (!newMessageDiv) return null;
      newMessageDiv.setAttribute('data-message-id', newNode.id);

      if (sender === 'ai') {
        const footer = newMessageDiv.querySelector('.api-footer');
        if (!footer) {
          const apiFooter = document.createElement('div');
          apiFooter.className = 'api-footer';
          newMessageDiv.appendChild(apiFooter);
        }
      }

      if (baseElement.parentNode === targetContainer) {
        targetContainer.insertBefore(newMessageDiv, baseElement);
      } else if (newMessageDiv.parentNode !== targetContainer) {
        targetContainer.prepend(newMessageDiv);
      }

      const shouldOpenEditor = options.openEditor === true;
      if (shouldOpenEditor && !isEditing) {
        try { startInlineEdit(newMessageDiv); } catch (e) { console.error('打开新插入消息的编辑器失败:', e); }
      }
      if (!options.skipSave) {
        await chatHistoryUI.saveCurrentConversation(true);
      }
      return newMessageDiv;
    } catch (e) {
      console.error('插入空白消息失败:', e);
      return null;
    }
  }

  /**
   * 在“当前右键选中的消息”上方插入一条空白消息。
   * @param {'ai'|'user'} sender
   */
  async function insertBlankMessageAbove(sender) {
    const baseElement = currentMessageElement;
    try {
      if (!baseElement) return;
      hideContextMenu();
      await insertBlankMessageBefore(sender, baseElement, { openEditor: true });
    } finally {
      hideContextMenu();
    }
  }

  /**
   * 在“当前右键选中的消息”下方依次插入用户消息与 AI 消息，并打开用户消息编辑。
   */
  async function insertCombinedMessagesBelow() {
    let userMessageDiv = null;
    const baseElement = currentMessageElement;
    try {
      if (!baseElement) return;
      hideContextMenu();
      userMessageDiv = await insertBlankMessageAfter('user', baseElement, {
        openEditor: false,
        skipSave: true
      });
      if (!userMessageDiv) return;
      await insertBlankMessageAfter('ai', userMessageDiv, { openEditor: false, skipSave: true });
      if (!isEditing) {
        try { startInlineEdit(userMessageDiv); } catch (e) { console.error('打开新插入用户消息的编辑器失败:', e); }
      }
      await chatHistoryUI.saveCurrentConversation(true);
    } catch (e) {
      console.error('同时插入消息失败:', e);
    } finally {
      hideContextMenu();
    }
  }

  /**
   * 在“当前右键选中的消息”上方依次插入用户消息与 AI 消息，并打开用户消息编辑。
   */
  async function insertCombinedMessagesAbove() {
    let userMessageDiv = null;
    const baseElement = currentMessageElement;
    try {
      if (!baseElement) return;
      hideContextMenu();
      userMessageDiv = await insertBlankMessageBefore('user', baseElement, {
        openEditor: false,
        skipSave: true
      });
      if (!userMessageDiv) return;
      await insertBlankMessageAfter('ai', userMessageDiv, { openEditor: false, skipSave: true });
      if (!isEditing) {
        try { startInlineEdit(userMessageDiv); } catch (e) { console.error('打开新插入用户消息的编辑器失败:', e); }
      }
      await chatHistoryUI.saveCurrentConversation(true);
    } catch (e) {
      console.error('同时插入消息失败:', e);
    } finally {
      hideContextMenu();
    }
  }

  /**
   * 创建分支对话
   * 截取从开始到当前选中消息的对话，创建一个新的会话
   */
  function forkConversation() {
    if (currentMessageElement) {
      const messageId = currentMessageElement.getAttribute('data-message-id');
      if (!messageId) {
        console.error('无法创建分支对话: 缺少必要信息');
        hideContextMenu();
        return;
      }

      const activeContainer = resolveMessageContainer(currentMessageElement);
      if (activeContainer === threadContainer) {
        const selectionThreadManager = services.selectionThreadManager;
        if (!selectionThreadManager?.forkThreadFromMessage) {
          console.error('无法创建分支线程: selectionThreadManager 未就绪');
          hideContextMenu();
          return;
        }
        const task = selectionThreadManager.forkThreadFromMessage(messageId);
        if (task?.catch) {
          task.catch((error) => {
            console.error('创建分支线程失败:', error);
          });
        }
        hideContextMenu();
        return;
      }

      if (!chatHistory || !chatHistory.messages) {
        console.error('无法创建分支对话: 缺少必要信息');
        hideContextMenu();
        return;
      }
      
      // 调用外部提供的创建分支函数
      chatHistoryUI.createForkConversation(messageId);
      hideContextMenu();
    }
  }

  function flattenThreadToMainConversation() {
    if (!currentMessageElement) return;
    const messageId = currentMessageElement.getAttribute('data-message-id');
    if (!messageId) {
      console.error('无法展平线程: 缺少消息 ID');
      hideContextMenu();
      return;
    }
    const activeContainer = resolveMessageContainer(currentMessageElement);
    if (activeContainer !== threadContainer) {
      hideContextMenu();
      return;
    }
    const selectionThreadManager = services.selectionThreadManager;
    if (!selectionThreadManager?.flattenThreadToMainConversation) {
      console.error('无法展平线程: selectionThreadManager 未就绪');
      hideContextMenu();
      return;
    }
    const task = selectionThreadManager.flattenThreadToMainConversation(messageId);
    if (task?.catch) {
      task.catch((error) => {
        console.error('展平线程为主聊天失败:', error);
      });
    }
    hideContextMenu();
  }

  function removeMessageScreenshotSelectionArtifacts(rootNode) {
    if (!(rootNode instanceof HTMLElement)) return;
    const messageNodes = rootNode.matches?.('.message')
      ? [rootNode, ...Array.from(rootNode.querySelectorAll('.message'))]
      : Array.from(rootNode.querySelectorAll('.message'));
    messageNodes.forEach((messageNode) => {
      messageNode.classList.remove(MESSAGE_SCREENSHOT_SELECTABLE_CLASS);
      messageNode.classList.remove(MESSAGE_SCREENSHOT_SELECTED_CLASS);
      messageNode.removeAttribute('aria-selected');
      delete messageNode.dataset[MESSAGE_SCREENSHOT_VIRTUAL_PIN_MARKER];
    });
  }

  function staticizeMessageScreenshotCloneTree(rootNode) {
    if (!(rootNode instanceof HTMLElement)) return;
    const animatedNodes = rootNode.matches?.('.message')
      ? [rootNode, ...Array.from(rootNode.querySelectorAll('.message'))]
      : Array.from(rootNode.querySelectorAll('.message'));
    animatedNodes.forEach((node) => {
      node.classList.remove('message-offscreen-blur-disabled');
      node.style.animation = 'none';
      node.style.transition = 'none';
      node.style.transform = 'none';
      node.style.opacity = '1';
      if (node.dataset?.virtualized === '1') {
        node.classList.remove('message-virtualized');
        delete node.dataset.virtualized;
        delete node.dataset.virtualHeight;
        node.style.height = 'auto';
        node.style.minHeight = '';
        node.style.overflow = 'visible';
      }
    });
  }

  function expandUserMessageScreenshotContent(rootNode) {
    if (!(rootNode instanceof HTMLElement)) return;
    const userMessages = rootNode.matches?.('.user-message')
      ? [rootNode, ...Array.from(rootNode.querySelectorAll('.user-message'))]
      : Array.from(rootNode.querySelectorAll('.user-message'));
    userMessages.forEach((messageNode) => {
      messageNode.querySelectorAll('.text-content').forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        node.style.maxHeight = 'none';
        node.style.height = 'auto';
        node.style.overflow = 'visible';
        node.style.overflowY = 'visible';
      });
    });
  }

  function prepareMessageScreenshotCloneTree(rootNode) {
    if (!(rootNode instanceof HTMLElement)) return;
    removeMessageScreenshotSelectionArtifacts(rootNode);
    staticizeMessageScreenshotCloneTree(rootNode);
    // 截图快照只保留最终对话正文，思考块会造成长图底部大量非对话内容。
    rootNode.querySelectorAll('.thoughts-content').forEach((node) => node.remove());
    expandUserMessageScreenshotContent(rootNode);
  }

  /**
   * 创建“消息截图专用快照”：
   * - 在离屏容器中克隆当前消息，避免直接改动可见 DOM 产生闪烁；
   * - 在克隆节点中移除思考块（包含标题与正文），让布局自然回流；
   * - 返回可供 dom-to-image 捕获的节点与准确尺寸。
   *
   * 设计说明：
   * dom-to-image 的 filter 只会过滤克隆树节点，但默认画布尺寸仍基于传入原节点计算。
   * 如果只用 filter 隐藏 thoughts-content，可能出现“内容没了但高度还在”的底部空白。
   * 通过先构造离屏快照并将其作为捕获根节点，可以从根本上保证高度正确。
   *
   * @param {HTMLElement} messageElement
   * @param {{widthPx?: number, fontSizePx?: number, fontFamilyCss?: string}} [options]
   * @returns {{ node: HTMLElement, width: number, height: number, cleanup: Function }}
   */
  function createMessageScreenshotSnapshot(messageElement, options = {}) {
    const sourceRect = messageElement.getBoundingClientRect();
    const fallbackWidth = Math.max(
      1,
      Math.ceil(sourceRect.width || messageElement.offsetWidth || messageElement.scrollWidth || 1)
    );
    const requestedWidth = Number(options?.widthPx);
    const targetWidth = Number.isFinite(requestedWidth) && requestedWidth > 0
      ? Math.max(1, Math.round(requestedWidth))
      : fallbackWidth;

    const stagingHost = document.createElement('div');
    stagingHost.style.position = 'fixed';
    stagingHost.style.left = '-100000px';
    stagingHost.style.top = '0';
    stagingHost.style.pointerEvents = 'none';
    stagingHost.style.opacity = '0';
    stagingHost.style.zIndex = '-1';
    stagingHost.style.contain = 'layout style paint';
    stagingHost.style.width = `${targetWidth}px`;

    const snapshotNode = messageElement.cloneNode(true);
    if (!(snapshotNode instanceof HTMLElement)) {
      throw new Error('消息截图快照创建失败：克隆节点类型无效');
    }

    // 复制当前消息的可见宽度，避免离屏环境因容器宽度变化导致换行与高度偏差。
    snapshotNode.style.boxSizing = 'border-box';
    snapshotNode.style.width = `${targetWidth}px`;
    snapshotNode.style.maxWidth = `${targetWidth}px`;
    snapshotNode.style.minWidth = `${targetWidth}px`;

    // 截图快照不需要动画与过渡，强制静态化可避免捕获到中间帧。
    snapshotNode.style.animation = 'none';
    snapshotNode.style.transition = 'none';
    snapshotNode.style.transform = 'none';
    snapshotNode.style.opacity = '1';
    if (Number.isFinite(Number(options?.fontSizePx)) && Number(options.fontSizePx) > 0) {
      snapshotNode.style.fontSize = `${Math.round(Number(options.fontSizePx))}px`;
    }
    if (typeof options?.fontFamilyCss === 'string' && options.fontFamilyCss.trim()) {
      snapshotNode.style.fontFamily = options.fontFamilyCss;
    }

    prepareMessageScreenshotCloneTree(snapshotNode);

    stagingHost.appendChild(snapshotNode);
    document.body.appendChild(stagingHost);

    const rect = snapshotNode.getBoundingClientRect();
    const width = Math.max(1, Math.ceil(Math.max(rect.width || 0, snapshotNode.scrollWidth || 0, targetWidth)));
    const height = Math.max(1, Math.ceil(Math.max(rect.height || 0, snapshotNode.scrollHeight || 0)));

    const cleanup = () => {
      if (stagingHost.parentNode) {
        stagingHost.parentNode.removeChild(stagingHost);
      }
    };

    return {
      node: snapshotNode,
      width,
      height,
      cleanup
    };
  }

  function resolveContainerContentWidth(container) {
    if (!(container instanceof HTMLElement)) return 1;
    const style = window.getComputedStyle(container);
    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(style.paddingRight) || 0;
    const fallbackWidth = container.getBoundingClientRect?.().width || container.clientWidth || 1;
    const contentWidth = (container.clientWidth || fallbackWidth) - paddingLeft - paddingRight;
    return Math.max(1, Math.ceil(contentWidth || fallbackWidth || 1));
  }

  function createMessagesScreenshotSnapshot(messageElements, options = {}) {
    const sourceMessages = Array.isArray(messageElements)
      ? messageElements.filter((node) => node instanceof HTMLElement)
      : [];
    if (!sourceMessages.length) {
      throw new Error('消息截图快照创建失败：没有可截图的消息');
    }

    const activeContainer = getActiveScreenshotSelectionContainer(sourceMessages[0]);
    const fallbackWidth = resolveContainerContentWidth(activeContainer);
    const requestedWidth = Number(options?.widthPx);
    const targetWidth = Number.isFinite(requestedWidth) && requestedWidth > 0
      ? Math.max(1, Math.round(requestedWidth))
      : fallbackWidth;

    const stagingHost = document.createElement('div');
    stagingHost.style.position = 'fixed';
    stagingHost.style.left = '-100000px';
    stagingHost.style.top = '0';
    stagingHost.style.pointerEvents = 'none';
    stagingHost.style.opacity = '0';
    stagingHost.style.zIndex = '-1';
    stagingHost.style.contain = 'layout style paint';
    stagingHost.style.width = `${targetWidth}px`;

    const transcriptNode = document.createElement('div');
    transcriptNode.className = 'message-screenshot-transcript';
    transcriptNode.style.boxSizing = 'border-box';
    transcriptNode.style.width = `${targetWidth}px`;
    transcriptNode.style.maxWidth = `${targetWidth}px`;
    transcriptNode.style.minWidth = `${targetWidth}px`;
    if (Number.isFinite(Number(options?.fontSizePx)) && Number(options.fontSizePx) > 0) {
      transcriptNode.style.fontSize = `${Math.round(Number(options.fontSizePx))}px`;
    }
    if (typeof options?.fontFamilyCss === 'string' && options.fontFamilyCss.trim()) {
      transcriptNode.style.fontFamily = options.fontFamilyCss;
    }

    const containerStyle = activeContainer instanceof HTMLElement
      ? window.getComputedStyle(activeContainer)
      : null;
    const gap = containerStyle?.gap || containerStyle?.rowGap || '';
    if (gap && gap !== 'normal') {
      transcriptNode.style.gap = gap;
    }

    sourceMessages.forEach((messageElement) => {
      const snapshotNode = messageElement.cloneNode(true);
      if (!(snapshotNode instanceof HTMLElement)) return;
      snapshotNode.style.boxSizing = 'border-box';
      snapshotNode.style.maxWidth = '100%';
      prepareMessageScreenshotCloneTree(snapshotNode);
      transcriptNode.appendChild(snapshotNode);
    });

    stagingHost.appendChild(transcriptNode);
    document.body.appendChild(stagingHost);

    const rect = transcriptNode.getBoundingClientRect();
    const width = Math.max(1, Math.ceil(Math.max(rect.width || 0, transcriptNode.scrollWidth || 0, targetWidth)));
    const height = Math.max(1, Math.ceil(Math.max(rect.height || 0, transcriptNode.scrollHeight || 0)));

    const cleanup = () => {
      if (stagingHost.parentNode) {
        stagingHost.parentNode.removeChild(stagingHost);
      }
    };

    return {
      node: transcriptNode,
      width,
      height,
      cleanup
    };
  }

  function isTransparentBackgroundColor(colorText) {
    const color = String(colorText || '').trim().toLowerCase();
    if (!color || color === 'transparent') return true;
    if (color === 'rgba(0, 0, 0, 0)') return true;
    return /^rgba\([^)]*,\s*0(?:\.0+)?\)$/.test(color);
  }

  function resolveMessageImageCanvasBackgroundColor(referenceElement) {
    const candidates = [];
    let cursor = referenceElement instanceof HTMLElement ? referenceElement : null;
    while (cursor) {
      candidates.push(cursor);
      cursor = cursor.parentElement;
    }
    candidates.push(document.body, document.documentElement);

    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement)) continue;
      const backgroundColor = window.getComputedStyle(candidate).backgroundColor;
      if (!isTransparentBackgroundColor(backgroundColor)) {
        return backgroundColor;
      }
    }

    const rootBg = window.getComputedStyle(document.documentElement)
      .getPropertyValue('--cerebr-bg-color')
      .trim();
    return rootBg || '#ffffff';
  }

  function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => {
      if (!canvas || typeof canvas.toBlob !== 'function') {
        reject(new Error('当前环境不支持将 Canvas 转换为图片'));
        return;
      }
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Canvas 转换为图片失败'));
        }
      }, 'image/png');
    });
  }

  async function renderMessageScreenshotSnapshotToBlob(snapshot, exportOptions, backgroundReferenceElement) {
    const originalCanvas = await domtoimage.toCanvas(snapshot.node, {
      width: snapshot.width,
      height: snapshot.height,
      scale: exportOptions.resolutionScale
    });

    const padding = Math.max(0, Math.round(exportOptions.paddingPx * exportOptions.resolutionScale));
    const newWidth = originalCanvas.width + 2 * padding;
    const newHeight = originalCanvas.height + 2 * padding;

    const newCanvas = document.createElement('canvas');
    newCanvas.width = newWidth;
    newCanvas.height = newHeight;
    const ctx = newCanvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas 上下文创建失败');
    }

    ctx.fillStyle = resolveMessageImageCanvasBackgroundColor(backgroundReferenceElement);
    ctx.fillRect(0, 0, newWidth, newHeight);
    ctx.drawImage(originalCanvas, padding, padding);

    const imageData = ctx.getImageData(0, 0, newWidth, newHeight);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      data[i + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);

    return canvasToPngBlob(newCanvas);
  }

  async function writeScreenshotBlobToClipboard(blob) {
    await navigator.clipboard.write([
      new ClipboardItem({
        'image/png': blob
      })
    ]);
    return 'clipboard';
  }

  function downloadScreenshotBlob(blob, filenamePrefix = '消息截图') {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filenamePrefix}_${new Date().toISOString().replace(/:/g, '-')}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return 'download';
  }

  async function copyMessageAsImage() {
    const messageElement = currentMessageElement;
    if (isMessageScreenshotExporting) {
      utils?.showNotification?.({ message: '截图正在生成中', type: 'info', duration: 1400 });
      return;
    }
    const selectedMessageElements = getOrderedScreenshotSelectionMessageElements(messageElement);
    const messageElements = selectedMessageElements.length > 0
      ? selectedMessageElements
      : (messageElement ? [messageElement] : []);
    if (!messageElements.length) return;

    let snapshot = null;
    let progressToast = null;
    hideContextMenu();
    setMessageScreenshotExporting(true, 'copy');
    progressToast = showMessageScreenshotExportNotification(messageElements);
    try {
      const exportOptions = resolveMessageImageExportOptions();
      const isMultiMessageExport = messageElements.length > 1;
      snapshot = isMultiMessageExport
        ? createMessagesScreenshotSnapshot(messageElements, exportOptions)
        : createMessageScreenshotSnapshot(messageElements[0], exportOptions);
      const backgroundReference = isMultiMessageExport
        ? getActiveScreenshotSelectionContainer(messageElements[0])
        : messageElements[0];
      const blob = await renderMessageScreenshotSnapshotToBlob(snapshot, exportOptions, backgroundReference);
      const exportResult = await writeScreenshotBlobToClipboard(blob);
      updateMessageScreenshotExportNotification(progressToast, 'success', {
        target: exportResult,
        count: messageElements.length
      });
    } catch (err) {
      console.error('生成图片过程中出错:', err);
      updateMessageScreenshotExportNotification(progressToast, 'error', {
        error: err,
        count: messageElements.length
      });
    } finally {
      if (snapshot?.cleanup) {
        snapshot.cleanup();
      }
      setMessageScreenshotExporting(false);
      syncScreenshotExportMenuLabels();
    }
  }

  async function downloadMessageAsImage() {
    const messageElement = currentMessageElement;
    if (isMessageScreenshotExporting) {
      utils?.showNotification?.({ message: '截图正在生成中', type: 'info', duration: 1400 });
      return;
    }
    const selectedMessageElements = getOrderedScreenshotSelectionMessageElements(messageElement);
    const messageElements = selectedMessageElements.length > 0
      ? selectedMessageElements
      : (messageElement ? [messageElement] : []);
    if (!messageElements.length) return;

    let snapshot = null;
    let progressToast = null;
    hideContextMenu();
    setMessageScreenshotExporting(true, 'download');
    progressToast = showMessageScreenshotExportNotification(messageElements);
    try {
      const exportOptions = resolveMessageImageExportOptions();
      const isMultiMessageExport = messageElements.length > 1;
      snapshot = isMultiMessageExport
        ? createMessagesScreenshotSnapshot(messageElements, exportOptions)
        : createMessageScreenshotSnapshot(messageElements[0], exportOptions);
      const backgroundReference = isMultiMessageExport
        ? getActiveScreenshotSelectionContainer(messageElements[0])
        : messageElements[0];
      const blob = await renderMessageScreenshotSnapshotToBlob(snapshot, exportOptions, backgroundReference);
      const exportResult = downloadScreenshotBlob(
        blob,
        isMultiMessageExport ? '对话长截图' : '消息截图'
      );
      updateMessageScreenshotExportNotification(progressToast, 'success', {
        target: exportResult,
        count: messageElements.length
      });
    } catch (err) {
      console.error('生成图片过程中出错:', err);
      updateMessageScreenshotExportNotification(progressToast, 'error', {
        error: err,
        count: messageElements.length
      });
    } finally {
      if (snapshot?.cleanup) {
        snapshot.cleanup();
      }
      setMessageScreenshotExporting(false);
      syncScreenshotExportMenuLabels();
    }
  }

  /**
   * 设置事件监听器
   */
  function setupEventListeners() {
    // 右键菜单行为对齐 Windows：在菜单项上“释放鼠标按键”时触发。
    // 说明：
    // - 左键与右键都在 pointerup 时触发；
    // - 不依赖浏览器 click（click 要求 down/up 落在同一元素，不符合菜单释放语义）。
    const ACTIONABLE_SELECTOR = '.context-menu-item, .context-menu-submenu-item';
    const MENU_ACTIVATE_EVENT = 'menuactivate';
    const resolveActionTargetOnRelease = (event) => {
      if (!event) return null;
      const hasCoordinates = typeof event.clientX === 'number' && typeof event.clientY === 'number';
      if (hasCoordinates && typeof document.elementFromPoint === 'function') {
        const releasePointElement = document.elementFromPoint(event.clientX, event.clientY);
        return releasePointElement instanceof Element
          ? releasePointElement.closest(ACTIONABLE_SELECTOR)
          : null;
      }
      return event.target instanceof Element
        ? event.target.closest(ACTIONABLE_SELECTOR)
        : null;
    };
    const dispatchMenuActivateOnRelease = (event) => {
      if (!event) return;
      const button = Number(event.button);
      if (button !== 0 && button !== 2) return;
      const target = resolveActionTargetOnRelease(event);
      if (!target) return;
      if (
        target.classList.contains('is-disabled')
        || target.classList.contains('disabled')
        || target.dataset?.disabled === 'true'
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      target.dispatchEvent(new CustomEvent(MENU_ACTIVATE_EVENT, {
        bubbles: true,
        cancelable: true,
        detail: {
          sourceEvent: event,
          button
        }
      }));
    };
    const preventNativeClickOnActionable = (event) => {
      const target = event.target instanceof Element
        ? event.target.closest(ACTIONABLE_SELECTOR)
        : null;
      if (!target) return;
      // 所有菜单动作都走 menuactivate，屏蔽原生 click 避免双触发与“按下/释放同元素”限制。
      event.preventDefault();
      event.stopPropagation();
    };
    const preventNativeContextMenuOnActionable = (event) => {
      const target = event.target instanceof Element
        ? event.target.closest(ACTIONABLE_SELECTOR)
        : null;
      if (!target) return;
      event.preventDefault();
    };

    [contextMenu, regenerateSubmenu, insertMessageSubmenu, forkConversationSubmenu, screenshotSubmenu].forEach((menuLikeEl) => {
      if (!menuLikeEl) return;
      menuLikeEl.addEventListener('pointerup', dispatchMenuActivateOnRelease);
      menuLikeEl.addEventListener('click', preventNativeClickOnActionable, true);
      menuLikeEl.addEventListener('contextmenu', preventNativeContextMenuOnActionable);
    });

    const attachContextMenuListeners = (container) => {
      if (!container) return;
      // 监听消息（用户或 AI）右键点击
      container.addEventListener('contextmenu', (e) => {
        // 检查是否有文本被选中
        const selectedText = serializeSelectionTextWithMath(window.getSelection(), { trim: true });
        
        // 说明：
        // - 有选中文本时，优先保留浏览器默认菜单（复制/查找等）；
        // - Ctrl/Alt 作为“强制默认菜单”的快捷方式。
        if (selectedText || e.ctrlKey || e.altKey) {
          return;
        }
        
        // 允许用户和 AI 消息都触发右键菜单
        const messageElement = e.target.closest('.message');
        if (messageElement && container.contains(messageElement)) {
          e.preventDefault();
          showContextMenu(e, messageElement);
        }
      });

      // 长截图选择模式下，点击消息本身即切换选中状态；链接和按钮仍保留原交互。
      container.addEventListener('click', (e) => {
        handleMessageScreenshotSelectionClick(e, container);
      }, true);

      // 滚动时隐藏菜单
      container.addEventListener('scroll', hideContextMenu);
    };

    attachContextMenuListeners(chatContainer);
    attachContextMenuListeners(threadContainer);

    const bindPortalSubmenuHover = (menuItem, submenu, placementOptions = null) => {
      if (!menuItem || !submenu) return;
      menuItem.addEventListener('mouseenter', () => openContextSubmenu(menuItem, submenu, placementOptions));
      menuItem.addEventListener('focusin', () => openContextSubmenu(menuItem, submenu, placementOptions));
      menuItem.addEventListener('mouseleave', scheduleSubmenuHide);
      submenu.addEventListener('mouseenter', clearSubmenuHideTimer);
      submenu.addEventListener('mouseleave', scheduleSubmenuHide);
    };

    ensureSubmenuPortal(regenerateSubmenu);
    ensureSubmenuPortal(insertMessageSubmenu);
    ensureSubmenuPortal(forkConversationSubmenu);
    ensureSubmenuPortal(screenshotSubmenu);
    bindPortalSubmenuHover(regenerateButton, regenerateSubmenu);
    bindPortalSubmenuHover(insertMessageMenu, insertMessageSubmenu, INSERT_SUBMENU_PLACEMENT_OPTIONS);
    bindPortalSubmenuHover(forkConversationButton, forkConversationSubmenu);
    bindPortalSubmenuHover(screenshotMenu, screenshotSubmenu);

    window.addEventListener('resize', () => {
      if (contextMenu.style.display !== 'block') return;
      if (!activeContextSubmenu?.menuItem || !activeContextSubmenu?.submenu) return;
      positionContextSubmenu(
        activeContextSubmenu.menuItem,
        activeContextSubmenu.submenu,
        activeContextSubmenu.placementOptions || null
      );
    });

    // 按钮点击处理
    copyMessageButton.addEventListener(MENU_ACTIVATE_EVENT, copyMessageContent);
    copyCodeButton.addEventListener(MENU_ACTIVATE_EVENT, copyCodeContent);
    // 重新编辑消息
    editMessageButton.addEventListener(MENU_ACTIVATE_EVENT, () => {
      if (!currentMessageElement || isEditing) return;
      startInlineEdit(currentMessageElement);
      hideContextMenu();
    });
    // 修复：使用 messageSender.abortCurrentRequest()，避免未定义的 abortCurrentRequest 引发错误
    stopUpdateButton.addEventListener(MENU_ACTIVATE_EVENT, () => {
      const compactionMenuState = resolveResponsesLocalCompactionMenuState(currentMessageElement);
      if (compactionMenuState.isCompaction && compactionMenuState.state === 'pending' && compactionMenuState.messageId) {
        void messageSender?.cancelResponsesLocalCompaction?.(compactionMenuState.messageId);
      } else if (messageSender) {
        messageSender.abortCurrentRequest(currentMessageElement);
      }
      hideContextMenu();
    });
    deleteMessageButton.addEventListener(MENU_ACTIVATE_EVENT, () => {
      if (currentMessageElement) {
        utils.deleteMessageContent(currentMessageElement);
      } else {
        console.error('消息元素未找到。');
      }
    });
    regenerateButton.addEventListener(MENU_ACTIVATE_EVENT, (event) => {
      const target = event?.target instanceof Element ? event.target : null;
      if (target && target.closest('.context-menu-submenu')) return;
      regenerateMessage(event);
    });
    if (regenerateSubmenuList) {
      regenerateSubmenuList.addEventListener(MENU_ACTIVATE_EVENT, (event) => {
        const target = event?.target instanceof Element ? event.target : null;
        const item = target ? target.closest('.context-menu-submenu-item') : null;
        if (!item) return;
        event.preventDefault();
        event.stopPropagation();
        if (item.dataset.disabled === 'true') return;
        const apiParam = buildApiParamFromSubmenuItem(item);
        if (!apiParam) return;
        regenerateMessage(null, apiParam);
      });
    }

    if (insertMessageSubmenuList) {
      insertMessageSubmenuList.addEventListener(MENU_ACTIVATE_EVENT, (event) => {
        const target = event?.target instanceof Element ? event.target : null;
        const item = target ? target.closest('.context-menu-submenu-item') : null;
        if (!item) return;
        event.preventDefault();
        event.stopPropagation();
        if (item.dataset.disabled === 'true') return;
        const insertType = item.dataset.insertType;
        const insertPosition = item.dataset.insertPosition === 'before' ? 'before' : 'after';
        if (insertType === 'both') {
          if (insertPosition === 'before') {
            insertCombinedMessagesAbove();
          } else {
            insertCombinedMessagesBelow();
          }
          return;
        }
        if (insertType === 'user') {
          if (insertPosition === 'before') {
            insertBlankMessageAbove('user');
          } else {
            insertBlankMessageBelow('user');
          }
          return;
        }
        if (insertType === 'ai') {
          if (insertPosition === 'before') {
            insertBlankMessageAbove('ai');
          } else {
            insertBlankMessageBelow('ai');
          }
        }
      });
    }

    if (forkConversationSubmenuList) {
      forkConversationSubmenuList.addEventListener(MENU_ACTIVATE_EVENT, (event) => {
        const target = event?.target instanceof Element ? event.target : null;
        const item = target ? target.closest('.context-menu-submenu-item') : null;
        if (!item) return;
        event.preventDefault();
        event.stopPropagation();
        if (item.dataset.disabled === 'true') return;
        const action = item.dataset.forkAction || '';
        if (action === FORK_ACTION_THREAD_FLATTEN_MAIN) {
          flattenThreadToMainConversation();
        }
      });
    }

    clearChatContextButton.addEventListener(MENU_ACTIVATE_EVENT, async () => {
      hideContextMenu();
      await clearChatHistory();
    });
    
    screenshotMenu?.addEventListener(MENU_ACTIVATE_EVENT, (event) => {
      const target = event?.target instanceof Element ? event.target : null;
      if (target && target.closest('.context-menu-submenu')) return;
      copyMessageAsImage();
    });
    if (downloadAsImageButton) {
      downloadAsImageButton.addEventListener(MENU_ACTIVATE_EVENT, downloadMessageAsImage);
    }
    if (selectForImageButton) {
      selectForImageButton.addEventListener(MENU_ACTIVATE_EVENT, () => {
        const messageElement = currentMessageElement;
        hideContextMenu();
        toggleMessageScreenshotSelection(messageElement);
      });
    }

    // 添加创建分支对话按钮点击事件
    if (forkConversationButton) {
      forkConversationButton.addEventListener(MENU_ACTIVATE_EVENT, (event) => {
        const target = event?.target instanceof Element ? event.target : null;
        if (target && target.closest('.context-menu-submenu')) return;
        if (!forkConversationButton.classList.contains('disabled')) {
          forkConversation();
        }
      });
    }

    // 点击其他地方隐藏菜单
    document.addEventListener('click', (e) => {
      const target = e.target;
      if (contextMenu.contains(target) || isTargetInsideAnyContextSubmenu(target)) {
        return;
      }
      hideContextMenu();
    });

    // 修复 KaTeX 选区复制异常：将复制内容标准化为 TeX 文本，避免重复/乱码。
    document.addEventListener('copy', handleMathSelectionCopy);

  }

  /**
   * 开始就地编辑消息
   * @param {HTMLElement} messageElement
   */
  function startInlineEdit(messageElement) {
    const messageId = messageElement.getAttribute('data-message-id');
    if (!messageId) return;
    isEditing = true;
    try { messageElement.classList.add('editing'); } catch (_) {}

    // 定义延迟定位函数：在DOM更新后再滚动，避免初算不准
    const scheduleScrollAfterSetup = () => {
      try {
        const container = resolveMessageContainer(messageElement);
        if (!container || typeof messageElement.offsetTop !== 'number') return;
        requestAnimationFrame(() => {
          const topPadding = 12;
          const messageTop = messageElement.offsetTop;
          const desiredTop = Math.max(0, messageTop - topPadding);
          if (messageTop < container.scrollTop + topPadding) {
            container.scrollTo({ top: desiredTop, behavior: 'smooth' });
          }
        });
      } catch (e) { console.error('滚动消息到可视区域失败:', e); }
    };

    // 定位文本容器
    const textDiv = messageElement.querySelector('.text-content');
    if (!textDiv) { isEditing = false; return; }

    // 原始HTML和纯文本
    const originalHtml = textDiv.innerHTML;
    const originalText = messageElement.getAttribute('data-original-text') || textDiv.textContent || '';
    const imageContainerInMessage = messageElement.querySelector('.image-content');
    const originalImagesHTML = imageContainerInMessage ? imageContainerInMessage.innerHTML : '';
    // 委托删除图片（适配历史DOM中未绑定事件的删除按钮）
    const delegatedDeleteHandler = (e) => {
      const deleteBtn = e.target.closest && e.target.closest('.delete-btn');
      if (!deleteBtn) return;
      e.preventDefault();
      e.stopPropagation();
      const tag = deleteBtn.closest('.image-tag');
      if (tag) tag.remove();
    };

    // 记录变更前的原始消息尺寸（避免后续DOM修改影响测量）
    const originalMsgRect = messageElement.getBoundingClientRect();
    const originalMessageWidth = messageElement.clientWidth || Math.round(originalMsgRect.width) || 0;
    const originalMessageHeight = messageElement.offsetHeight || Math.round(originalMsgRect.height) || 0;

    // 构建编辑器容器
    const editorWrapper = document.createElement('div');
    editorWrapper.className = 'inline-editor-wrapper';

    const textarea = document.createElement('textarea');
    textarea.className = 'inline-editor-textarea';
    textarea.value = originalText;

    const actionBar = document.createElement('div');
    actionBar.className = 'inline-editor-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'inline-editor-save';
    saveBtn.innerHTML = '<i class="far fa-check"></i><span>保存</span>';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'inline-editor-cancel';
    cancelBtn.innerHTML = '<i class="far fa-times"></i><span>取消</span>';

    actionBar.appendChild(saveBtn);
    actionBar.appendChild(cancelBtn);
    editorWrapper.appendChild(textarea);
    editorWrapper.appendChild(actionBar);

    // 替换显示
    textDiv.style.display = 'none';
    messageElement.insertBefore(editorWrapper, textDiv.nextSibling);

    // 使用进入编辑前记录的 .message 尺寸设置编辑器大小（高度将被 CSS 的 min/max 约束）
    const baseWidth = Math.max(0, originalMessageWidth);
    const baseHeight = Math.max(0, originalMessageHeight);

    if (baseHeight > 0) {
      textarea.style.height = baseHeight + 'px';
    }
    textarea.style.overflow = 'auto';
    // 宽度：以原消息宽度为基准，额外增加 2em，并设置最小宽度 10em，上限 100%
    textarea.style.minWidth = '10em';
    if (baseWidth > 0) {
      textarea.style.width = `calc(${baseWidth}px + 2em)`;
    } else {
      textarea.style.width = '';
    }
    textarea.style.maxWidth = '100%';
    textarea.focus();
    // DOM完成后再定位，确保计算准确，并在顶部留出微小空隙
    scheduleScrollAfterSetup();
    // 确保编辑器自身从顶部开始显示，并将光标移动到开头
    setTimeout(() => {
      try {
        textarea.scrollTop = 0;
        if (typeof textarea.setSelectionRange === 'function') {
          textarea.setSelectionRange(0, 0);
        } else {
          textarea.selectionStart = 0;
          textarea.selectionEnd = 0;
        }
      } catch (_) {}
    }, 0);

    // 快捷键：Enter 保存，Shift+Enter 换行，Ctrl+Enter 保存并重新生成，Ctrl+S 保存，Ctrl+Q 取消
    textarea.addEventListener('keydown', async (e) => {
      const key = (e.key || '').toLowerCase();
      if (key === 'enter') {
        if (e.shiftKey) {
          return;
        }
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          const newText = textarea.value;
          await applyInlineEdit(messageElement, messageId, newText);
          cleanup();
          // Ctrl+Enter：
          // - 编辑用户消息：重生成其后的第一条 AI 消息；
          // - 编辑 AI 消息：重生成该条 AI 消息本身。
          await regenerateMessage(messageElement);
        } else {
          saveBtn.click();
        }
      } else if ((e.ctrlKey || e.metaKey) && key === 's') {
        e.preventDefault();
        saveBtn.click();
      } else if ((e.ctrlKey || e.metaKey) && key === 'q') {
        e.preventDefault();
        cancelBtn.click();
      }
    });

    // 允许在编辑时通过粘贴添加图片
    textarea.addEventListener('paste', (e) => {
      try {
        const items = Array.from(e.clipboardData?.items || []);
        const imageItem = items.find(it => it.type && it.type.startsWith('image/'));
        if (!imageItem) return;
        e.preventDefault();
        const file = imageItem.getAsFile();
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          // 确保消息内存在图片容器
          let imgContainer = messageElement.querySelector('.image-content');
          if (!imgContainer) {
            imgContainer = document.createElement('div');
            imgContainer.className = 'image-content';
            messageElement.insertBefore(imgContainer, textDiv); // 放在文本上方
          }
          const tag = appContext.services.imageHandler.createImageTag(reader.result, file.name);
          imgContainer.appendChild(tag);
        };
        reader.readAsDataURL(file);
      } catch (err) {
        console.error('编辑时粘贴图片失败:', err);
      }
    });

    // 绑定事件
    try { messageElement.addEventListener('click', delegatedDeleteHandler); } catch (_) {}
    saveBtn.addEventListener('click', async () => {
      const newText = textarea.value;
      await applyInlineEdit(messageElement, messageId, newText);
      cleanup();
    });
    cancelBtn.addEventListener('click', () => {
      textDiv.style.display = '';
      editorWrapper.remove();
      // 还原图片区域
      try {
        const imgContainer = messageElement.querySelector('.image-content');
        if (imgContainer) {
          imgContainer.innerHTML = originalImagesHTML;
          // 重新绑定预览
          imgContainer.querySelectorAll('img').forEach(img => {
            img.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              appContext.services.imageHandler.showImagePreview(img.src);
            });
          });
        }
      } catch (e) { console.error('恢复图片区域失败:', e); }
      isEditing = false;
      try { messageElement.classList.remove('editing'); } catch (_) {}
      try { messageElement.removeEventListener('click', delegatedDeleteHandler); } catch (_) {}
    });

    function cleanup() {
      textDiv.style.display = '';
      editorWrapper.remove();
      isEditing = false;
      try { messageElement.classList.remove('editing'); } catch (_) {}
      try { messageElement.removeEventListener('click', delegatedDeleteHandler); } catch (_) {}
    }
  }

  function autoResize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(400, textarea.scrollHeight) + 'px';
  }

  /**
   * 应用就地编辑结果：更新UI与历史
   */
  async function applyInlineEdit(messageElement, messageId, newText) {
    try {
      await messageSender.requestConversationHistoryEdit({
        messageId,
        newText,
        messageElement
      });
    } catch (e) {
      console.error('应用编辑结果失败:', e);
    }
  }

  /**
   * 初始化上下文菜单管理器
   */
  function init() {
    setupEventListeners();
  }

  // 公开的API
  return {
    init,
    hideContextMenu,
    showContextMenu,
    copyMessageContent,
    copyCodeContent,
    copyMessageAsImage,
    downloadMessageAsImage,
    enterMessageScreenshotSelectionMode,
    exitMessageScreenshotSelectionMode,
    clearMessageScreenshotSelection,
    regenerateMessage,
    forkConversation,
    getCurrentMessage: () => currentMessageElement
  };
} 
