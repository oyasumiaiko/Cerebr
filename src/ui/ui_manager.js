import { deriveAutoScrollFollowState } from '../utils/auto_scroll_follow_state.js';
import {
  getDocumentZoomFactor,
  getElementLayoutRect,
  getElementLayoutSize,
  getLayoutViewportSize
} from '../utils/coordinate_space.js';

/**
 * UI管理模块
 * 负责管理用户界面元素的交互，如设置菜单、面板切换、输入处理等
 */

/**
 * 创建UI管理器
 * @param {Object} appContext - 应用程序上下文对象
 * @param {HTMLElement} appContext.dom.messageInput - 消息输入框元素
 * @param {HTMLElement} appContext.dom.settingsButton - 设置按钮元素
 * @param {HTMLElement} appContext.dom.settingsMenu - 设置菜单元素
 * @param {HTMLElement} appContext.dom.chatContainer - 聊天容器元素
 * @param {HTMLElement} appContext.dom.sendButton - 发送按钮元素
 * @param {HTMLElement} appContext.dom.inputContainer - 输入容器元素
 * @param {HTMLElement} appContext.dom.composerAccessoryRegion - 输入框上方的 accessory 区域
 * @param {HTMLElement} appContext.dom.scrollToBottomButton - 回到底部按钮元素
 * @param {HTMLElement} appContext.dom.promptSettings - 提示词设置面板元素
 * @param {HTMLElement} appContext.dom.collapseButton - 收起按钮元素
 * @param {Object} appContext.services.chatHistoryUI - 聊天历史UI对象
 * @param {Object} appContext.services.imageHandler - 图片处理器对象
 * @param {Function} appContext.services.messageSender.setShouldAutoScroll - 设置是否自动滚动的函数
 * @param {Function} appContext.services.apiManager.renderFavoriteApis - 渲染收藏API列表的函数
 * @returns {Object} UI管理器实例
 */
export function createUIManager(appContext) {
  // 解构配置选项
  const {
    dom,
    services,
    // utils // For showNotification, scrollToBottom if needed directly
  } = appContext;

  // DOM elements from appContext.dom
  const messageInput = dom.messageInput;
  // settingsButton and settingsMenu are for the main settings panel, managed by settingsManager
  // const settingsButton = dom.settingsToggle; // Use settingsToggle for consistency
  // const settingsMenu = dom.settingsPanel;    // Use settingsPanel
  const chatContainer = dom.chatContainer;
  const threadContainer = dom.threadContainer;
  const sendButton = dom.sendButton;
  const inputContainer = dom.inputContainer;
  const composerAccessoryRegion = dom.composerAccessoryRegion;
  const collapseButton = dom.collapseButton;
  const imageContainer = dom.imageContainer; // Added for updateSendButtonState
  const scrollToBottomButton = dom.scrollToBottomButton;
  // other DOM elements like sidebar, topBar, imagePreviewModal etc. can be accessed via dom if needed

  // Services from appContext.services
  const chatHistoryUI = services.chatHistoryUI; // For closing its panel
  const imageHandler = services.imageHandler;
  const messageSender = services.messageSender; // For setShouldAutoScroll
  const apiManager = services.apiManager; // For renderFavoriteApis
  const settingsManager = services.settingsManager; // 预留：后续需要时再使用

  let settingsMenuTimeout = null; // Timeout for hover-based closing
  const externalAltWheelStateUpdaters = new Set();
  let scrollToBottomButtonVisibilityRaf = 0;
  let scrollToBottomMutationObserver = null;
  let scrollToBottomResizeObserver = null;
  let scrollToBottomBodyAttrObserver = null;
  const SETTINGS_MENU_VIEWPORT_MARGIN_PX = 8;
  const SETTINGS_MENU_CLOSE_DELAY_MS = 220;
  const SETTINGS_MENU_SAFE_ZONE_PADDING_PX = 16;
  const SCROLL_TO_BOTTOM_BUTTON_THRESHOLD_PX = 48;
  let lastPointerClientX = null;
  let lastPointerClientY = null;

  function clampToRange(value, min, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return min;
    if (!Number.isFinite(max) || max < min) return min;
    return Math.min(max, Math.max(min, numeric));
  }

  /**
   * 将“...”菜单提升到 body 下，避免受输入框层叠上下文与 backdrop-filter 影响。
   */
  function ensureSettingsMenuPortal() {
    if (!dom.settingsMenu || !document.body) return;
    if (dom.settingsMenu.parentElement === document.body) return;
    document.body.appendChild(dom.settingsMenu);
  }

  /**
   * 以按钮为锚点计算浮层菜单位置，避免在窗口边缘被裁剪。
   */
  function positionSettingsMenu() {
    if (!dom.settingsMenu || !dom.settingsButton) return;
    const zoomFactor = getDocumentZoomFactor();
    const buttonRect = getElementLayoutRect(dom.settingsButton, { zoomFactor });
    const buttonTop = buttonRect.top;
    const buttonRight = buttonRect.right;
    const menu = dom.settingsMenu;
    const viewport = getLayoutViewportSize({ zoomFactor });
    const menuSize = getElementLayoutSize(menu, { zoomFactor });
    const viewportWidth = Math.max(1, viewport.width);
    const viewportHeight = Math.max(1, viewport.height);
    const menuWidth = Math.max(1, menuSize.width || 1);
    const menuHeight = Math.max(1, menuSize.height || 1);

    const leftMin = SETTINGS_MENU_VIEWPORT_MARGIN_PX;
    const leftMax = viewportWidth - menuWidth - SETTINGS_MENU_VIEWPORT_MARGIN_PX;
    const topMin = SETTINGS_MENU_VIEWPORT_MARGIN_PX;
    const topMax = viewportHeight - menuHeight - SETTINGS_MENU_VIEWPORT_MARGIN_PX;

    // 与旧布局保持一致：右侧对齐按钮并留 8px 缝隙，默认显示在按钮上方。
    const preferredLeft = buttonRight - SETTINGS_MENU_VIEWPORT_MARGIN_PX - menuWidth;
    const preferredTop = buttonTop - menuHeight - SETTINGS_MENU_VIEWPORT_MARGIN_PX;
    const left = clampToRange(preferredLeft, leftMin, leftMax);
    const top = clampToRange(preferredTop, topMin, topMax);

    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function isPointInsideRect(x, y, rect, padding = 0) {
    if (!rect) return false;
    return x >= (rect.left - padding)
      && x <= (rect.right + padding)
      && y >= (rect.top - padding)
      && y <= (rect.bottom + padding);
  }

  /**
   * hover 关闭保护区：
   * - 包含按钮、菜单本体；
   * - 额外包含二者之间的“连线走廊”，用于替代过去的伪元素桥接层。
   */
  function isPointerWithinSettingsMenuSafeZone() {
    if (!dom.settingsMenu || !dom.settingsButton) return false;
    if (!Number.isFinite(lastPointerClientX) || !Number.isFinite(lastPointerClientY)) return false;
    const x = lastPointerClientX;
    const y = lastPointerClientY;
    const menuRect = dom.settingsMenu.getBoundingClientRect();
    const buttonRect = dom.settingsButton.getBoundingClientRect();

    if (isPointInsideRect(x, y, menuRect, 2) || isPointInsideRect(x, y, buttonRect, 2)) {
      return true;
    }

    const pad = SETTINGS_MENU_SAFE_ZONE_PADDING_PX;
    const corridorLeft = Math.min(menuRect.left, buttonRect.left) - pad;
    const corridorRight = Math.max(menuRect.right, buttonRect.right) + pad;
    const menuIsAboveButton = menuRect.bottom <= buttonRect.top;
    const menuIsBelowButton = buttonRect.bottom <= menuRect.top;

    if (menuIsAboveButton || menuIsBelowButton) {
      const corridorTop = (menuIsAboveButton ? menuRect.bottom : buttonRect.bottom) - pad;
      const corridorBottom = (menuIsAboveButton ? buttonRect.top : menuRect.top) + pad;
      return x >= corridorLeft && x <= corridorRight && y >= corridorTop && y <= corridorBottom;
    }

    const unionTop = Math.min(menuRect.top, buttonRect.top) - pad;
    const unionBottom = Math.max(menuRect.bottom, buttonRect.bottom) + pad;
    return x >= corridorLeft && x <= corridorRight && y >= unionTop && y <= unionBottom;
  }

  /**
   * 自动调整文本框高度
   * @param {HTMLElement} textarea - 文本输入元素
   */
  function adjustTextareaHeight(textarea) {
    textarea.style.height = 'auto';
    const maxHeight = 200;
    const scrollHeight = textarea.scrollHeight;
    textarea.style.height = Math.min(scrollHeight, maxHeight) + 'px';
    textarea.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
  }

  /**
   * 重置输入框高度
   * 在发送消息后调用此方法重置输入框高度
   */
  function resetInputHeight() {
    if (messageInput) {
      adjustTextareaHeight(messageInput);
    }
  }

  /**
   * 更新发送按钮状态
   */
  function updateSendButtonState() {
    const hasText = messageInput.textContent.trim();
    const hasImage = dom.imageContainer?.querySelector('.image-tag');
    const hasInput = !!hasText || !!hasImage;
    sendButton.disabled = !hasInput;
    if (inputContainer) {
      inputContainer.classList.toggle('has-input', hasInput);
    }
  }

  function resolveScrollToBottomTargetContainer() {
    // 线程模式下用户正在阅读右侧 thread 容器，此时按钮应服务当前可见线程，而不是强行跳主聊天区。
    if (threadContainer && document.body.classList.contains('thread-mode-active')) {
      return threadContainer;
    }
    return chatContainer;
  }

  function computeDistanceToContainerBottom(container) {
    if (!(container instanceof HTMLElement)) return 0;
    return Math.max(
      0,
      (container.scrollHeight || 0) - (container.scrollTop || 0) - (container.clientHeight || 0)
    );
  }

  function setScrollToBottomButtonVisible(visible) {
    if (!scrollToBottomButton) return;
    const shouldShow = !!visible;
    scrollToBottomButton.classList.toggle('is-visible', shouldShow);
    scrollToBottomButton.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
    scrollToBottomButton.tabIndex = shouldShow ? 0 : -1;
  }

  function updateScrollToBottomButtonVisibility() {
    if (!scrollToBottomButton || !composerAccessoryRegion) return;

    const targetContainer = resolveScrollToBottomTargetContainer();
    const hasOverflow = !!targetContainer && ((targetContainer.scrollHeight || 0) - (targetContainer.clientHeight || 0)) > 1;
    const hasMessages = !!targetContainer?.querySelector('.message');
    const distanceToBottom = targetContainer ? computeDistanceToContainerBottom(targetContainer) : 0;
    const shouldShow = hasMessages && hasOverflow && distanceToBottom > SCROLL_TO_BOTTOM_BUTTON_THRESHOLD_PX;

    setScrollToBottomButtonVisible(shouldShow);
  }

  function scheduleScrollToBottomButtonVisibilityUpdate() {
    if (!scrollToBottomButton || scrollToBottomButtonVisibilityRaf) return;
    scrollToBottomButtonVisibilityRaf = requestAnimationFrame(() => {
      scrollToBottomButtonVisibilityRaf = 0;
      updateScrollToBottomButtonVisibility();
    });
  }

  function setupScrollToBottomButton() {
    if (!scrollToBottomButton || !composerAccessoryRegion) return;

    setScrollToBottomButtonVisible(false);

    const scrollTargetToBottom = () => {
      const targetContainer = resolveScrollToBottomTargetContainer();
      if (!(targetContainer instanceof HTMLElement)) return;

      // 语义说明：
      // - 这个按钮是“显式跳到最底部”，因此这里不复用 stopAtTop 语义，而是总是滚到真实底部；
      // - 若全局 autoScroll 开关仍开启，则顺手恢复 shouldAutoScroll，让后续流式输出继续跟随最新内容；
      // - 若用户在设置里明确关掉 autoScroll，这里只做一次性跳转，不悄悄改写其偏好。
      if (settingsManager?.getSetting?.('autoScroll') !== false) {
        messageSender.setShouldAutoScroll(true);
      }

      targetContainer.scrollTo({
        top: Math.max(0, targetContainer.scrollHeight || 0),
        behavior: 'smooth'
      });
      scheduleScrollToBottomButtonVisibilityUpdate();
      window.setTimeout(scheduleScrollToBottomButtonVisibilityUpdate, 220);
    };

    scrollToBottomButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      scrollTargetToBottom();
    });

    const handleContainerScroll = () => {
      scheduleScrollToBottomButtonVisibilityUpdate();
    };
    chatContainer?.addEventListener('scroll', handleContainerScroll, { passive: true });
    threadContainer?.addEventListener('scroll', handleContainerScroll, { passive: true });

    const handleContainerLoad = () => {
      scheduleScrollToBottomButtonVisibilityUpdate();
    };
    chatContainer?.addEventListener('load', handleContainerLoad, true);
    threadContainer?.addEventListener('load', handleContainerLoad, true);

    scrollToBottomMutationObserver = new MutationObserver(() => {
      scheduleScrollToBottomButtonVisibilityUpdate();
    });
    if (chatContainer) {
      scrollToBottomMutationObserver.observe(chatContainer, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'style']
      });
    }
    if (threadContainer && threadContainer !== chatContainer) {
      scrollToBottomMutationObserver.observe(threadContainer, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'style']
      });
    }

    try {
      scrollToBottomResizeObserver = new ResizeObserver(() => {
        scheduleScrollToBottomButtonVisibilityUpdate();
      });
      if (chatContainer) scrollToBottomResizeObserver.observe(chatContainer);
      if (threadContainer && threadContainer !== chatContainer) scrollToBottomResizeObserver.observe(threadContainer);
      if (composerAccessoryRegion) scrollToBottomResizeObserver.observe(composerAccessoryRegion);
    } catch (_) {}

    if (document.body) {
      scrollToBottomBodyAttrObserver = new MutationObserver(() => {
        scheduleScrollToBottomButtonVisibilityUpdate();
      });
      scrollToBottomBodyAttrObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'style']
      });
    }

    window.addEventListener('resize', scheduleScrollToBottomButtonVisibilityUpdate, { passive: true });
    scheduleScrollToBottomButtonVisibilityUpdate();
  }

  /**
   * 设置菜单开关函数
   * @param {boolean|undefined} show - 是否显示菜单，不传则切换状态
   */
  function toggleSettingsMenu(show) {
    if (!appContext.dom.settingsMenu) {
        console.error("settingsMenu DOM element is not defined in appContext.dom");
        return;
    }

    ensureSettingsMenuPortal();

    if (show === undefined) {
      appContext.dom.settingsMenu.classList.toggle('visible');
    } else {
      if (show) {
        appContext.dom.settingsMenu.classList.add('visible');
      } else {
        appContext.dom.settingsMenu.classList.remove('visible');
      }
    }

    if (!appContext.dom.settingsMenu.classList.contains('visible')) {
      clearTimeout(settingsMenuTimeout);
      settingsMenuTimeout = null;
      return;
    }

    if (appContext.dom.settingsMenu.classList.contains('visible')) {
      positionSettingsMenu();
      apiManager.renderFavoriteApis();
      requestAnimationFrame(() => positionSettingsMenu());
    }
  }

  /**
   * 关闭互斥面板函数
   */
  function closeExclusivePanels() {
    // 说明：
    // - “提示词设置 / API 设置”已并入聊天记录面板的标签页，不再作为独立遮罩层管理；
    // - 因此互斥面板只剩下聊天记录面板本身（设置菜单不参与互斥）。
    if (chatHistoryUI?.closeChatHistoryPanel) {
      chatHistoryUI.closeChatHistoryPanel();
    } else {
      const chatPanel = document.getElementById('chat-history-panel');
      if (chatPanel && chatPanel.classList.contains('visible')) {
        chatPanel.classList.remove('visible');
        chatPanel.style.display = 'none';
      }
    }
  }

  /**
   * 设置输入相关事件监听器
   */
  function setupInputEventListeners() {
    // 监听输入框变化
    messageInput.addEventListener('input', function () {
      adjustTextareaHeight(this);
      updateSendButtonState();

      // 处理 placeholder 的显示
      if (this.textContent.trim() === '') {
        // 如果内容空且没有图片标签，清空内容以显示 placeholder
        while (this.firstChild) {
          this.removeChild(this.firstChild);
        }
      }
    });

    messageInput.addEventListener('focus', () => {
      if (inputContainer) {
        inputContainer.classList.add('has-focus');
      }
    });

    messageInput.addEventListener('blur', () => {
      if (!inputContainer) return;
      inputContainer.classList.remove('has-focus');
    });

    // 片粘贴功能
    messageInput.addEventListener('paste', async (e) => {

      const items = Array.from(e.clipboardData.items);
      const imageItem = items.find(item => item.type.startsWith('image/'));

      if (imageItem) {
        // 处理图片粘贴
        const file = imageItem.getAsFile();
        const reader = new FileReader();
        reader.onload = async () => {
          imageHandler.addImageToContainer(reader.result, file.name);
        };
        reader.readAsDataURL(file);
      }
      // 粘贴后调整输入框高度
      adjustTextareaHeight(this);
    });

    // 修改拖放处理
    messageInput.addEventListener('drop', (e) => imageHandler.handleImageDrop(e, messageInput));
    chatContainer.addEventListener('drop', (e) => imageHandler.handleImageDrop(e, chatContainer));
  }

  /**
   * 设置设置菜单事件监听器
   */
  function setupSettingsMenuEventListeners() {
    // Hover behavior for settings menu
    if (dom.settingsButton && dom.settingsMenu) {
        ensureSettingsMenuPortal();

        window.addEventListener('pointermove', (event) => {
          lastPointerClientX = Number(event.clientX);
          lastPointerClientY = Number(event.clientY);
        }, { passive: true });

        const openSettingsMenu = () => {
            clearTimeout(settingsMenuTimeout);
            settingsMenuTimeout = null;
            // 设置菜单不参与互斥：打开它不应关闭其他面板
            dom.settingsMenu.classList.add('visible');
            positionSettingsMenu();
            apiManager.renderFavoriteApis();
            requestAnimationFrame(() => positionSettingsMenu());
        };

        
        appContext.dom.promptSettingsToggle.addEventListener('click', async (e) => {
          e.stopPropagation();

          const chatHistoryUI = services.chatHistoryUI;
          const targetTab = 'prompt-settings';

          const isPanelOpen = !!chatHistoryUI?.isChatHistoryPanelOpen?.();
          const activeTab = chatHistoryUI?.getActiveTabName?.();

          // 行为对齐旧交互：
          // - 若已在“提示词设置”标签页，再点一次则关闭面板；
          // - 否则打开聊天记录面板并跳转到对应标签页。
          if (isPanelOpen && activeTab === targetTab) {
            closeExclusivePanels();
            return;
          }

          if (!isPanelOpen) {
            closeExclusivePanels();
            await chatHistoryUI?.showChatHistoryPanel?.(targetTab);
          } else {
            await chatHistoryUI?.activateTab?.(targetTab);
          }

        });

        if (appContext.dom.preferencesSettingsToggle) {
          appContext.dom.preferencesSettingsToggle.addEventListener('click', async (e) => {
            e.stopPropagation();

            const chatHistoryUI = services.chatHistoryUI;
            const targetTab = 'settings';

            const isPanelOpen = !!chatHistoryUI?.isChatHistoryPanelOpen?.();
            const activeTab = chatHistoryUI?.getActiveTabName?.();

            // 行为对齐旧交互：
            // - 若已在“偏好设置”标签页，再点一次则关闭面板；
            // - 否则打开聊天记录面板并跳转到对应标签页。
            if (isPanelOpen && activeTab === targetTab) {
              closeExclusivePanels();
              return;
            }

            if (!isPanelOpen) {
              closeExclusivePanels();
              await chatHistoryUI?.showChatHistoryPanel?.(targetTab);
            } else {
              await chatHistoryUI?.activateTab?.(targetTab);
            }
          });
        }

        const scheduleCloseSettingsMenu = () => {
            clearTimeout(settingsMenuTimeout);
            settingsMenuTimeout = setTimeout(() => {
                settingsMenuTimeout = null;
                if (!dom.settingsMenu.classList.contains('visible')) return;
                // 鼠标位于“按钮↔菜单”走廊时继续保留，避免移动到菜单过程中闪退。
                if (isPointerWithinSettingsMenuSafeZone()) {
                  scheduleCloseSettingsMenu();
                  return;
                }
                dom.settingsMenu.classList.remove('visible');
            }, SETTINGS_MENU_CLOSE_DELAY_MS);
        };

        dom.settingsButton.addEventListener('mouseenter', openSettingsMenu);
        dom.settingsButton.addEventListener('mouseleave', scheduleCloseSettingsMenu);

        dom.settingsMenu.addEventListener('mouseenter', () => {
            clearTimeout(settingsMenuTimeout); // Mouse entered menu, cancel scheduled close
        });
        dom.settingsMenu.addEventListener('mouseleave', () => {
            scheduleCloseSettingsMenu();
        });

        // 视口尺寸变化时同步重新定位，避免浮层漂移到屏幕外。
        window.addEventListener('resize', () => {
          if (!dom.settingsMenu.classList.contains('visible')) return;
          positionSettingsMenu();
        });

        // Keep this: 阻止菜单内部点击事件冒泡，防止触发外部的关闭逻辑
        dom.settingsMenu.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }

    // The global document click listener is in sidebar.js for closing by clicking outside.

    // 不再在输入框获得焦点时强制关闭其他面板，避免与面板互斥逻辑产生冲突
  }

  /**
   * 添加消息容器事件监听器（主消息与线程消息共用）
   * @param {HTMLElement} container - 消息滚动容器
   */
  function setupScrollableContainerEventListeners(container) {
    const AUTO_SCROLL_THRESHOLD = 100;
    const ALT_SCROLL_MULTIPLIER = 5; // 固定 5 倍滚动速度，避免动态加速带来的不可控跳跃；如需调节手感只改这里。
    const ALT_SCROLL_ANIMATION_MS = 110; // Alt+滚轮平滑动画时长（ms），兼顾 120Hz 下的顺滑与响应速度。

    const clampNumber = (value, min, max) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return min;
      return Math.min(max, Math.max(min, numeric));
    };

    const createAltScrollState = (initialTarget = null) => ({
      target: initialTarget,
      raf: null,
      startAt: 0,
      fromTop: 0,
      fromLeft: 0,
      toTop: 0,
      toLeft: 0
    });

    // 抽象同一套 Alt 滚动引擎，主聊天与浮层仅传入不同 target。
    const mainAltScrollState = createAltScrollState(container);
    const nestedAltScrollState = createAltScrollState(null);
    let lastObservedScrollTop = Math.max(0, Number(container?.scrollTop) || 0);

    const stopAltScrollState = (state, options = {}) => {
      if (!state) return;
      const { clearTarget = false } = options;
      if (state.raf) {
        cancelAnimationFrame(state.raf);
        state.raf = null;
      }
      state.startAt = 0;
      const target = state.target;
      if (target) {
        const currentTop = Math.max(0, target.scrollTop || 0);
        const currentLeft = Math.max(0, target.scrollLeft || 0);
        state.fromTop = currentTop;
        state.fromLeft = currentLeft;
        state.toTop = currentTop;
        state.toLeft = currentLeft;
      }
      if (clearTarget) {
        state.target = null;
      }
    };

    const runAltScrollStateFrame = (state, timestamp) => {
      const target = state?.target;
      if (!state?.raf || !target) return;
      if (!state.startAt) state.startAt = timestamp;
      const elapsed = timestamp - state.startAt;
      const progress = clampNumber(elapsed / ALT_SCROLL_ANIMATION_MS, 0, 1);
      // 使用缓出曲线，起步快、收尾稳，避免“黏滞感”。
      const eased = 1 - Math.pow(1 - progress, 3);
      const nextTop = state.fromTop + (state.toTop - state.fromTop) * eased;
      const nextLeft = state.fromLeft + (state.toLeft - state.fromLeft) * eased;
      target.scrollTop = nextTop;
      target.scrollLeft = nextLeft;

      if (progress >= 1 || (Math.abs(state.toTop - nextTop) < 0.5 && Math.abs(state.toLeft - nextLeft) < 0.5)) {
        target.scrollTop = state.toTop;
        target.scrollLeft = state.toLeft;
        state.raf = null;
        state.startAt = 0;
        state.fromTop = state.toTop;
        state.fromLeft = state.toLeft;
        return;
      }

      state.raf = requestAnimationFrame((nextTs) => runAltScrollStateFrame(state, nextTs));
    };

    const animateAltScrollStateBy = (state, target, deltaY, deltaX) => {
      if (!state || !target) return 0;
      if (state.target !== target) {
        stopAltScrollState(state);
        state.target = target;
      } else if (!state.target) {
        state.target = target;
      }

      const currentTop = Math.max(0, target.scrollTop || 0);
      const currentLeft = Math.max(0, target.scrollLeft || 0);
      const maxTop = Math.max(0, (target.scrollHeight || 0) - (target.clientHeight || 0));
      const maxLeft = Math.max(0, (target.scrollWidth || 0) - (target.clientWidth || 0));
      // 连续滚轮时以“当前计划终点”为基准累加，避免动画进行中丢输入。
      const baseTop = state.raf ? state.toTop : currentTop;
      const baseLeft = state.raf ? state.toLeft : currentLeft;
      const targetTop = clampNumber(baseTop + (Number.isFinite(deltaY) ? deltaY : 0), 0, maxTop);
      const targetLeft = clampNumber(baseLeft + (Number.isFinite(deltaX) ? deltaX : 0), 0, maxLeft);

      state.fromTop = currentTop;
      state.fromLeft = currentLeft;
      state.toTop = targetTop;
      state.toLeft = targetLeft;
      state.startAt = 0;
      if (!state.raf) {
        state.raf = requestAnimationFrame((nextTs) => runAltScrollStateFrame(state, nextTs));
      }
      return targetTop;
    };

    const stopMainAltScrollAnimation = () => stopAltScrollState(mainAltScrollState);
    const stopNestedAltScrollAnimation = () => stopAltScrollState(nestedAltScrollState, { clearTarget: true });
    const animateMainAltScrollBy = (deltaY, deltaX) => (
      animateAltScrollStateBy(mainAltScrollState, container, deltaY, deltaX)
    );
    const animateNestedAltScrollBy = (target, deltaY, deltaX) => (
      animateAltScrollStateBy(nestedAltScrollState, target, deltaY, deltaX)
    );

    /**
     * 将滚轮事件的 delta 值统一转换为像素单位
     * @param {number} value - 原始 delta 数值
     * @param {number} mode - deltaMode 常量
     * @param {HTMLElement} [targetElement=container] - 目标滚动容器
     * @returns {number} 像素值
     */
    const normalizeWheelDelta = (value, mode, targetElement = container) => {
      if (!value) return 0;
      if (mode === 1) { // DOM_DELTA_LINE
        const computedStyle = window.getComputedStyle(targetElement);
        const lineHeight = parseFloat(computedStyle.lineHeight);
        if (Number.isFinite(lineHeight)) {
          return value * lineHeight;
        }
        const fontSize = parseFloat(computedStyle.fontSize) || 16;
        return value * fontSize * 1.2;
      }
      if (mode === 2) { // DOM_DELTA_PAGE
        return value * targetElement.clientHeight;
      }
      return value;
    };

    const resolveAltWheelNestedScrollable = (eventTarget) => {
      if (!eventTarget || typeof eventTarget.closest !== 'function') return null;
      // 仅在划词气泡内启用该分流，避免影响主聊天区常规 Alt+滚轮行为。
      const bubbleHost = eventTarget.closest('.selection-thread-bubble');
      if (!bubbleHost) return null;
      let current = eventTarget instanceof Element ? eventTarget : eventTarget?.parentElement;
      while (current && current !== container) {
        const style = window.getComputedStyle(current);
        const overflowY = (style.overflowY || '').toLowerCase();
        const allowsScroll = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
        const canScroll = (current.scrollHeight - current.clientHeight) > 1;
        if (allowsScroll && canScroll) {
          return current;
        }
        current = current.parentElement;
      }
      return null;
    };

    const handleRegularWheel = (e) => {
      if (e.altKey) return;
      // 普通滚轮路径保持 passive，避免容器长期处于“滚动阻塞”状态。
      if (mainAltScrollState.raf) {
        stopMainAltScrollAnimation();
      }
      if (nestedAltScrollState.raf) {
        stopNestedAltScrollAnimation();
      }

      const effectiveDeltaY = e.deltaY;
      if (effectiveDeltaY < 0) {
        messageSender.setShouldAutoScroll(false);
        return;
      }
      if (effectiveDeltaY > 0) {
        const effectiveScrollTop = Math.max(0, container.scrollTop || 0);
        const distanceFromBottom = container.scrollHeight - effectiveScrollTop - container.clientHeight;
        if (
          settingsManager?.getSetting?.('autoScroll') !== false
          && distanceFromBottom < AUTO_SCROLL_THRESHOLD
        ) {
          messageSender.setShouldAutoScroll(true);
        }
      }
    };

    const handleAltAcceleratedWheel = (e) => {
      if (!e.altKey) return;

      const nestedScrollable = resolveAltWheelNestedScrollable(e.target);
      if (nestedScrollable) {
        // 在气泡预览内按 Alt+滚轮时，优先滚动气泡内部，不让主聊天容器抢滚动。
        e.preventDefault();
        const acceleratedDeltaY = normalizeWheelDelta(e.deltaY, e.deltaMode, nestedScrollable) * ALT_SCROLL_MULTIPLIER;
        const acceleratedDeltaX = normalizeWheelDelta(e.deltaX, e.deltaMode, nestedScrollable) * ALT_SCROLL_MULTIPLIER;
        animateNestedAltScrollBy(nestedScrollable, acceleratedDeltaY, acceleratedDeltaX);
        if (mainAltScrollState.raf) {
          stopMainAltScrollAnimation();
        }
        messageSender.setShouldAutoScroll(false);
        return;
      }

      e.preventDefault();
      const acceleratedDeltaY = normalizeWheelDelta(e.deltaY, e.deltaMode) * ALT_SCROLL_MULTIPLIER;
      const acceleratedDeltaX = normalizeWheelDelta(e.deltaX, e.deltaMode) * ALT_SCROLL_MULTIPLIER;

      stopNestedAltScrollAnimation();
      const projectedScrollTop = animateMainAltScrollBy(acceleratedDeltaY, acceleratedDeltaX);
      const effectiveDeltaY = acceleratedDeltaY || 0;

      if (effectiveDeltaY < 0) {
        messageSender.setShouldAutoScroll(false);
        return;
      }

      if (effectiveDeltaY > 0) {
        const distanceFromBottom = container.scrollHeight - projectedScrollTop - container.clientHeight;
        if (distanceFromBottom < AUTO_SCROLL_THRESHOLD) {
          messageSender.setShouldAutoScroll(true);
        } else {
          messageSender.setShouldAutoScroll(false);
        }
      }
    };

    let altWheelCaptureEnabled = false;
    let localAltKeyPressed = false;
    let externalAltKeyPressed = false;
    const enableAltWheelCapture = () => {
      if (altWheelCaptureEnabled) return;
      container.addEventListener('wheel', handleAltAcceleratedWheel, { passive: false });
      altWheelCaptureEnabled = true;
    };
    const disableAltWheelCapture = () => {
      if (!altWheelCaptureEnabled) return;
      container.removeEventListener('wheel', handleAltAcceleratedWheel, { passive: false });
      altWheelCaptureEnabled = false;
    };
    const syncAltWheelCaptureState = () => {
      if (localAltKeyPressed || externalAltKeyPressed) {
        enableAltWheelCapture();
        return;
      }
      disableAltWheelCapture();
    };
    const setExternalAltKeyPressedForContainer = (isPressed) => {
      externalAltKeyPressed = !!isPressed;
      syncAltWheelCaptureState();
    };
    externalAltWheelStateUpdaters.add(setExternalAltKeyPressedForContainer);

    const handleWindowKeyDownForAltWheel = (event) => {
      if (event.key === 'Alt') {
        localAltKeyPressed = true;
        syncAltWheelCaptureState();
      }
    };
    const handleWindowKeyUpForAltWheel = (event) => {
      if (event.key === 'Alt') {
        localAltKeyPressed = false;
        syncAltWheelCaptureState();
      }
    };
    const handleWindowBlurForAltWheel = () => {
      localAltKeyPressed = false;
      syncAltWheelCaptureState();
    };

    /**
     * 统一根据真实滚动位置回写 shouldAutoScroll。
     *
     * 说明：
     * - wheel/mousedown 只能覆盖一部分用户交互；
     * - 真正决定“用户是否打断自动跟随”的，还是容器 scrollTop 的方向变化；
     * - 因此这里把“上滚即停、回到底部即恢复”落在 scroll 事件上，
     *   让滚轮、拖动滚动条、触控板惯性滚动都走同一条规则。
     */
    const handleContainerScrollAutoFollowState = () => {
      const currentTop = Math.max(0, Number(container.scrollTop) || 0);
      const distanceFromBottom = Math.max(
        0,
        (Number(container.scrollHeight) || 0) - currentTop - (Number(container.clientHeight) || 0)
      );
      const nextShouldAutoScroll = deriveAutoScrollFollowState({
        previousTop: lastObservedScrollTop,
        currentTop,
        distanceFromBottom,
        threshold: AUTO_SCROLL_THRESHOLD,
        autoScrollEnabled: settingsManager?.getSetting?.('autoScroll') !== false,
        currentShouldAutoScroll: messageSender?.getShouldAutoScroll?.() === true
      });
      messageSender.setShouldAutoScroll(nextShouldAutoScroll);
      lastObservedScrollTop = currentTop;
    };

    // 默认滚动路径始终 passive，仅在 Alt 按下时临时启用非被动监听。
    container.addEventListener('wheel', handleRegularWheel, { passive: true });
    container.addEventListener('scroll', handleContainerScrollAutoFollowState, { passive: true });
    window.addEventListener('keydown', handleWindowKeyDownForAltWheel, { passive: true });
    window.addEventListener('keyup', handleWindowKeyUpForAltWheel, { passive: true });
    window.addEventListener('blur', handleWindowBlurForAltWheel, { passive: true });

    container.addEventListener('mousedown', (e) => {
      stopMainAltScrollAnimation();
      stopNestedAltScrollAnimation();
      if (e.offsetX < container.clientWidth) { 
         messageSender.setShouldAutoScroll(false);
      }
    });

    // Prevent default image click behavior in chat
    container.addEventListener('click', (e) => {
      if (e.target.tagName === 'IMG' && e.target.closest('.message-content__ai_message_content_img')) {
        e.preventDefault(); // 阻止图片链接跳转等默认行为
        // e.stopPropagation(); // 暂时移除，观察是否解决了自动滚动问题。如果需要阻止其他冒泡行为，可以再加回来。
        // 可以考虑在这里添加其他图片交互，如新标签页打开
        // window.open(e.target.src, '_blank');
      }
    });
  }

  /**
   * 添加聊天容器事件监听器
   */
  function setupChatContainerEventListeners() {
    // 移除外层条件检查，如果 chatContainer 或 messageSender 无效，将直接报错
    setupScrollableContainerEventListeners(chatContainer);
    if (threadContainer) {
      setupScrollableContainerEventListeners(threadContainer);
    }
  }

  /**
   * 设置焦点相关事件监听器
   */
  function setupFocusEventListeners() {
    // 监听输入框的焦点状态
    messageInput.addEventListener('focus', () => {
      // 输入框获得焦点，阻止事件冒泡
      messageInput.addEventListener('click', (e) => e.stopPropagation());
    });

    messageInput.addEventListener('blur', () => {
      // 输入框失去焦点时，移除点击事件监听
      messageInput.removeEventListener('click', (e) => e.stopPropagation());
    });
  }

  /**
   * 初始化UI管理器
   */
  function init() {
    setupInputEventListeners();
    setupSettingsMenuEventListeners();
    setupChatContainerEventListeners();
    setupScrollToBottomButton();
    setupFocusEventListeners();
    
    // 初始更新发送按钮状态
    updateSendButtonState();
  }

  // 公开的API
  return {
    init,
    adjustTextareaHeight,
    updateSendButtonState,
    toggleSettingsMenu,
    closeExclusivePanels,
    resetInputHeight,
    // 父页面 Alt 状态通过 postMessage 同步到这里后，统一广播给主聊天区与线程区，
    // 从而实现“无论当前焦点在哪，只要在侧栏上滚轮就能加速”。
    setExternalAltKeyPressed(isPressed) {
      for (const updateState of externalAltWheelStateUpdaters) {
        updateState(isPressed);
      }
    }
  };
} 
