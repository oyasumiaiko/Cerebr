/**
 * 构建侧边栏 appContext 以及与 DOM/工具相关的辅助函数。
 * 将原本集中在 sidebar.js 中的初始化逻辑拆分出来，
 * 便于后续进一步分离服务初始化与事件绑定责任。
 */
import { createSidebarJsSandboxRuntime } from './js_sandbox_runtime.js';
import {
  JS_RUNTIME_ENV_BOUND_HOST_PAGE,
  resolvePageToolEnvironment
} from '../../agent_tools/page_tool_environment.js';

const JS_RUNTIME_STATUS_TIMEOUT_MS = 5000;
const JS_RUNTIME_FRAME_SNAPSHOT_TIMEOUT_MS = 5000;
const JS_RUNTIME_EXECUTION_TIMEOUT_MS = 30000;

function raceWithTimeout(promise, timeoutMs, timeoutMessage) {
  const normalizedTimeout = Number.isFinite(Number(timeoutMs)) ? Math.max(1, Math.trunc(Number(timeoutMs))) : 0;
  if (!normalizedTimeout) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      window.setTimeout(() => {
        reject(new Error(timeoutMessage || '操作超时'));
      }, normalizedTimeout);
    })
  ]);
}

/**
 * 创建侧边栏 appContext 基础结构。
 * @param {boolean} isStandalone - 当前是否处于独立页面模式。
 * @returns {Object} appContext - 含 DOM 引用、状态、服务占位与工具集的上下文。
 */
export function createSidebarAppContext(isStandalone) {
  const apiSettingsToggle = document.getElementById('api-settings-toggle');
  const preferencesSettingsToggle = document.getElementById('preferences-settings-toggle');
  const inputApiSwitcher = document.getElementById('input-api-switcher');

  const dom = {
    chatLayout: document.getElementById('chat-layout'),
    chatContainer: document.getElementById('chat-container'),
    threadPanel: document.getElementById('thread-panel'),
    threadContainer: document.getElementById('thread-container'),
    threadSplitter: document.getElementById('thread-splitter'),
    threadResizeEdgeLeft: document.getElementById('thread-resize-edge-left'),
    threadResizeEdgeRight: document.getElementById('thread-resize-edge-right'),
    messageInput: document.getElementById('message-input'),
    inputApiSwitcher,
    inputApiCurrent: inputApiSwitcher?.querySelector('.input-api-current') || null,
    inputApiList: inputApiSwitcher?.querySelector('.input-api-list') || null,
    contextMenu: document.getElementById('context-menu'),
    copyMessageButton: document.getElementById('copy-message'),
    stopUpdateButton: document.getElementById('stop-update'),
    clearChatContextButton: document.getElementById('clear-chat-context'),
    settingsButton: document.getElementById('settings-button'),
    settingsMenu: document.getElementById('settings-menu'),
    escSettingsMenu: document.getElementById('esc-settings-menu'),
    themeSwitch: document.getElementById('theme-switch'),
    themeSelect: document.getElementById('theme-select'),
    settingsRandomBackground: document.getElementById('settings-random-background'),
    sidebarWidth: document.getElementById('sidebar-width'),
    fontSize: document.getElementById('font-size'),
    widthValue: document.getElementById('width-value'),
    fontSizeValue: document.getElementById('font-size-value'),
    collapseButton: document.getElementById('collapse-button'),
    fullscreenToggle: document.getElementById('fullscreen-toggle'),
    dockModeToggle: document.getElementById('dock-mode-toggle'),
    sendButton: document.getElementById('send-button'),
    sendChatHistorySwitch: document.getElementById('send-chat-history-switch'),
    copyCodeButton: document.getElementById('copy-code'),
    imageContainer: document.getElementById('image-container'),
    promptSettingsToggle: document.getElementById('prompt-settings-toggle'),
    preferencesSettingsToggle,
    promptSettingsPanel: document.getElementById('prompt-settings'),
    inputContainer: document.getElementById('input-container'),
    composerAccessoryRegion: document.getElementById('composer-accessory-region'),
    regenerateButton: document.getElementById('regenerate-message'),
    autoScrollSwitch: document.getElementById('auto-scroll-switch'),
    autoRetrySwitch: document.getElementById('auto-retry-switch'),
    scaleFactor: document.getElementById('scale-factor'),
    scaleValue: document.getElementById('scale-value'),
    chatHistoryMenuItem: document.getElementById('chat-history-menu'),
    deleteMessageButton: document.getElementById('delete-message'),
    quickSummary: document.getElementById('quick-summary'),
    clearChat: document.getElementById('clear-chat'),
    debugTreeButton: document.getElementById('debug-chat-tree-btn'),
    screenshotButton: document.getElementById('screenshot-button'),
    sidebarPositionSwitch: document.getElementById('sidebar-position-switch'),
    forkConversationButton: document.getElementById('fork-conversation'),
    copyAsImageButton: document.getElementById('copy-as-image'),
    emptyStateHistory: document.getElementById('empty-state-history'),
    emptyStateSummary: document.getElementById('empty-state-summary'),
    emptyStateTempMode: document.getElementById('empty-state-temp-mode'),
    emptyStateLoadUrl: document.getElementById('empty-state-load-url'),
    emptyStatePageContent: document.getElementById('empty-state-page-content'),
    emptyStateRandomBackground: document.getElementById('empty-state-random-background'),
    statusDot: document.getElementById('status-dot'),
    stopAtTopSwitch: document.getElementById('stop-at-top-switch'),
    repomixButton: document.getElementById('empty-state-repomix'),
    apiSettingsPanel: document.getElementById('api-settings'),
    apiSettingsToggle,
    apiSettingsText: apiSettingsToggle?.querySelector('span') || null,
    apiSettingsBackButton: document.querySelector('#api-settings .back-button'),
    connectionSourcesList: document.getElementById('connection-sources-list'),
    connectionSourceAddButton: document.getElementById('connection-source-add'),
    apiCardsContainer: document.querySelector('#api-settings .api-cards'),
    apiSettingsAddButton: document.getElementById('api-add-config'),
    slashCommandHints: document.getElementById('slash-command-hints'),
    slashCommandHintsHeader: document.querySelector('#slash-command-hints .slash-command-hints-header'),
    slashCommandHintsList: document.querySelector('#slash-command-hints .slash-command-hints-list'),
    previewModal: document.querySelector('.image-preview-modal'),
    previewImage: document.querySelector('.image-preview-modal img'),
    previewCloseButton: document.querySelector('.image-preview-modal .image-preview-close'),
    promptSettingsBackButton: document.querySelector('#prompt-settings .back-button'),
    resetPromptsButton: document.getElementById('reset-prompts'),
    savePromptsButton: document.getElementById('save-prompts'),
    selectionPrompt: document.getElementById('selection-prompt'),
    systemPrompt: document.getElementById('system-prompt'),
    summaryPrompt: document.getElementById('summary-prompt'),
    queryPrompt: document.getElementById('query-prompt'),
    urlRulesPrompt: document.getElementById('urlRules-prompt'),
    urlRulesList: document.getElementById('url-rules-list'),
    showThoughtProcessSwitch: document.getElementById('show-thought-process-switch'),
    resetSettingsButton: document.getElementById('reset-settings-button'),
    settingsBackButton: document.querySelector('#settings-menu .back-button'),
    openStandalonePage: document.getElementById('open-standalone-page'),
    modeIndicator: document.getElementById('mode-indicator')
  };

  return {
    dom,
    services: {},
    state: {
      isStandalone,
      isFullscreen: false,
      isComposing: false,
      pageInfo: isStandalone ? { url: '', title: '独立聊天', standalone: true } : null,
      memoryManagement: {
        IDLE_CLEANUP_INTERVAL: 5 * 60 * 1000,
        FORCED_CLEANUP_INTERVAL: 30 * 60 * 1000,
        USER_IDLE_THRESHOLD: 3 * 60 * 1000,
        lastUserActivity: Date.now(),
        isEnabled: true
      }
    },
    utils: {}
  };
}

/**
 * 向 appContext 注入常用工具函数。
 * @param {Object} appContext - 侧边栏上下文对象。
 */
/**
 * 将常用的工具/便捷函数挂载到 appContext.utils，供其他模块复用。
 * @param {ReturnType<typeof createSidebarAppContext>} appContext - 已初始化的上下文。
 */
export function registerSidebarUtilities(appContext) {
  const jsSandboxRuntime = createSidebarJsSandboxRuntime({
    ownerWindow: window,
    ownerDocument: document
  });

  function resolveCurrentPageToolEnvironment(options = {}) {
    const explicitTemporaryMode = (typeof options?.isTemporaryMode === 'boolean')
      ? options.isTemporaryMode
      : appContext.services.messageSender?.getTemporaryModeState?.() === true;
    return resolvePageToolEnvironment({
      isStandalone: appContext.state.isStandalone,
      isTemporaryMode: explicitTemporaryMode
    });
  }

  appContext.utils.resolveCurrentPageToolEnvironment = resolveCurrentPageToolEnvironment;

  async function resolveBoundSidebarTargetTabId() {
    if (appContext.state.isStandalone) return null;

    const fromResolver = await appContext.services.conversationPresence?.resolveSelfTabId?.();
    if (Number.isFinite(Number(fromResolver))) {
      return Math.trunc(Number(fromResolver));
    }

    const cached = appContext.services.conversationPresence?.getSelfTabId?.();
    if (Number.isFinite(Number(cached))) {
      return Math.trunc(Number(cached));
    }

    return null;
  }

  appContext.utils.resolveBoundSidebarTargetTabId = resolveBoundSidebarTargetTabId;

  const getDocumentZoomFactor = () => {
    const root = document.documentElement;
    if (!root) return 1;
    const inlineZoom = Number.parseFloat(root.style.zoom || '');
    if (Number.isFinite(inlineZoom) && inlineZoom > 0) return inlineZoom;
    const computedZoom = Number.parseFloat(window.getComputedStyle(root).zoom || '');
    if (Number.isFinite(computedZoom) && computedZoom > 0) return computedZoom;
    return 1;
  };

  const toLayoutPixels = (value, zoomFactor = getDocumentZoomFactor()) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) return numeric;
    return numeric / zoomFactor;
  };

  function updateInputContainerHeightVar() {
    const input = appContext.dom.inputContainer || document.getElementById('input-container');
    const root = document.documentElement;
    if (input && root) {
      const rect = input.getBoundingClientRect();
      const zoomFactor = getDocumentZoomFactor();
      root.style.setProperty('--input-container-height', `${Math.ceil(toLayoutPixels(rect.height, zoomFactor))}px`);
    }
  }

  appContext.utils.updateInputContainerHeightVar = updateInputContainerHeightVar;

  /**
   * 统一获取“输入框上方辅助区”节点。
   *
   * 设计约束：
   * - queue / steer / request_user_input 都应挂到这里；
   * - 这样输入区的辅助信息有固定视线落点，不会再散落到页面顶部或全屏 modal；
   * - 若极端情况下该节点尚未挂好，则退回整个 input container，至少保证功能不中断。
   */
  const getComposerAccessoryRegion = () => {
    return appContext.dom.composerAccessoryRegion
      || document.getElementById('composer-accessory-region')
      || appContext.dom.inputContainer
      || null;
  };

  const refreshComposerAccessoryLayout = () => {
    window.requestAnimationFrame(() => {
      appContext.utils.updateInputContainerHeightVar?.();
    });
  };

  let activeRequestUserInputSession = null;

  // 统一生成输入框 placeholder 文案，避免各处硬编码导致切换覆盖不一致。
  appContext.utils.buildMessageInputPlaceholder = (currentConfig, options = {}) => {
    const rawName = currentConfig?.displayName || currentConfig?.modelName || currentConfig?.baseUrl || '';
    const fallbackName = (typeof rawName === 'string') ? rawName.trim() : '';
    const apiName = fallbackName;
    // 偏好设置开关：是否在 placeholder 中显示模型名（默认开启）。
    const showModelName = appContext.services.settingsManager?.getSetting?.('showModelNameInPlaceholder') !== false;
    const shouldShowName = showModelName;
    const baseText = (shouldShowName && apiName)
      ? `给 ${apiName} 发送消息...`
      : '输入消息...';
    if (options?.isTemporaryMode) {
      return `纯对话模式，${baseText}`;
    }
    return baseText;
  };

  // 统一更新输入框 placeholder，供设置/模式切换等场景复用。
  appContext.utils.updateMessageInputPlaceholder = () => {
    const input = appContext.dom?.messageInput;
    if (!input) return;
    const apiInfo = appContext.services.chatHistoryUI?.resolveActiveConversationApiConfig?.();
    const currentConfig = apiInfo?.displayConfig || appContext.services.apiManager?.getSelectedConfig?.() || null;
    const isTemporaryMode = appContext.services.messageSender?.getTemporaryModeState?.() === true;
    const placeholder = appContext.utils.buildMessageInputPlaceholder
      ? appContext.utils.buildMessageInputPlaceholder(currentConfig, { isTemporaryMode })
      : (isTemporaryMode ? '纯对话模式，输入消息...' : '输入消息...');
    input.setAttribute('placeholder', placeholder);
  };

  appContext.utils.scrollToBottom = (targetContainer = null) => {
    const settingsManager = appContext.services.settingsManager;
    const messageSender = appContext.services.messageSender;
    const chatContainer = targetContainer || appContext.dom.chatContainer;

    if (!chatContainer) return;

    if (settingsManager?.getSetting('autoScroll') === false) return;
    if (!messageSender?.getShouldAutoScroll()) return;

    requestAnimationFrame(() => {
      const stopAtTop = settingsManager?.getSetting('stopAtTop') === true;
      let top = chatContainer.scrollHeight;
      const aiMessages = chatContainer.querySelectorAll('.message.ai-message');
      if (aiMessages.length > 0) {
        const latestAiMessage = aiMessages[aiMessages.length - 1];
        const rect = latestAiMessage.getBoundingClientRect();
        const zoomFactor = getDocumentZoomFactor();
        const messageHeight = toLayoutPixels(rect.height, zoomFactor);
        if (stopAtTop) {
          top = latestAiMessage.offsetTop - 8;
          messageSender.setShouldAutoScroll(false);
        } else {
          const computedStyle = window.getComputedStyle(latestAiMessage);
          const marginBottom = parseInt(computedStyle.marginBottom, 10);
          top = latestAiMessage.offsetTop + messageHeight - marginBottom;
        }
      }
      chatContainer.scrollTo({ top, behavior: 'smooth' });
    });
  };

  // 统一确认对话框（是/否），返回 Promise<boolean>
  appContext.utils.showConfirm = (options = {}) => {
    const {
      message = '确认操作？',
      description = '',
      confirmText = '确定',
      cancelText = '取消',
      type = 'warning' // info | warning | error
    } = options;

    return new Promise((resolve) => {
      // 背景遮罩
      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';

      // 对话框
      const dialog = document.createElement('div');
      dialog.className = `confirm-dialog confirm-${type}`;

      const msgEl = document.createElement('div');
      msgEl.className = 'confirm-title';
      msgEl.textContent = message;
      dialog.appendChild(msgEl);

      if (description) {
        const descEl = document.createElement('div');
        descEl.className = 'confirm-desc';
        descEl.textContent = description;
        dialog.appendChild(descEl);
      }

      const actions = document.createElement('div');
      actions.className = 'confirm-actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-secondary';
      cancelBtn.textContent = cancelText;

      const okBtn = document.createElement('button');
      okBtn.className = 'btn btn-primary';
      okBtn.textContent = confirmText;

      actions.appendChild(cancelBtn);
      actions.appendChild(okBtn);
      dialog.appendChild(actions);

      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      const cleanUp = () => {
        overlay.classList.add('fade-out');
        setTimeout(() => overlay.remove(), 200);
      };

      const onCancel = () => { try { cleanUp(); } finally { resolve(false); } };
      const onConfirm = () => { try { cleanUp(); } finally { resolve(true); } };

      cancelBtn.addEventListener('click', onCancel);
      okBtn.addEventListener('click', onConfirm);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) onCancel(); });
      document.addEventListener('keydown', function onKey(e) {
        if (!document.body.contains(overlay)) { document.removeEventListener('keydown', onKey); return; }
        if (e.key === 'Escape') onCancel();
        if (e.key === 'Enter') onConfirm();
      });
    });
  };

  /**
   * 在输入框上方的统一辅助区内展示 request_user_input 面板，并等待用户选择“继续”或“跳过”。
   *
   * 设计取向：
   * - 不再使用全屏 modal，避免把本来只是“补充信息”的动作放大成强制阻塞交互；
   * - 与 queue / steer 预览共用同一块 composer 上方辅助区，形成稳定的视线落点；
   * - “继续生成”允许带着部分答案甚至空答案继续，真正的“强制回答”交给模型自行决定，不由 UI 粗暴代劳。
   *
   * @param {{questions?: Array<{id:string, header:string, question:string, options?: Array<{label:string, description:string}>}>}} [options]
   * @returns {Promise<{cancelled:boolean, answers:Record<string, {answers:string[]}>}>}
   */
  appContext.utils.showRequestUserInput = (options = {}) => {
    const questions = Array.isArray(options.questions) ? options.questions : [];
    const host = getComposerAccessoryRegion();

    if (!host) {
      return Promise.reject(new Error('当前界面尚未初始化输入框辅助区。'));
    }

    if (activeRequestUserInputSession?.finish) {
      activeRequestUserInputSession.finish({ cancelled: true, answers: {} });
    }

    document.querySelectorAll('.composer-request-panel').forEach((node) => node.remove());

    return new Promise((resolve) => {
      const panel = document.createElement('section');
      panel.className = 'composer-request-panel';
      panel.setAttribute('role', 'group');
      panel.setAttribute('aria-label', '模型补充提问');

      const header = document.createElement('div');
      header.className = 'composer-request-header';

      const headerMain = document.createElement('div');
      headerMain.className = 'composer-request-header-main';

      const badge = document.createElement('span');
      badge.className = 'composer-request-badge';
      badge.textContent = 'request_user_input';
      headerMain.appendChild(badge);

      const headerCopy = document.createElement('div');
      headerCopy.className = 'composer-request-header-copy';

      const titleEl = document.createElement('div');
      titleEl.className = 'composer-request-title';
      titleEl.textContent = '模型想补充确认一点信息';
      headerCopy.appendChild(titleEl);

      const descEl = document.createElement('div');
      descEl.className = 'composer-request-subtitle';
      descEl.textContent = '你可以直接回答，也可以跳过；这轮生成会在你决定后继续。';
      headerCopy.appendChild(descEl);

      headerMain.appendChild(headerCopy);
      header.appendChild(headerMain);

      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.className = 'composer-request-dismiss';
      dismissBtn.textContent = '跳过';
      dismissBtn.setAttribute('aria-label', '跳过本次补充提问');
      header.appendChild(dismissBtn);

      panel.appendChild(header);

      const questionsEl = document.createElement('div');
      questionsEl.className = 'composer-request-list';
      panel.appendChild(questionsEl);

      const controlEntries = [];

      function buildAnswerMap() {
        const answers = {};
        controlEntries.forEach((entry) => {
          const answer = entry.getAnswer();
          if (!answer) return;
          answers[entry.question.id] = { answers: [answer] };
        });
        return answers;
      }

      function updatePanelState() {
        const answerMap = buildAnswerMap();
        const answeredCount = Object.keys(answerMap).length;
        const unansweredCount = Math.max(questions.length - answeredCount, 0);

        statusEl.dataset.state = answeredCount > 0 ? 'ready' : 'idle';
        if (answeredCount <= 0) {
          statusEl.textContent = '不想回答也没关系，可以直接继续或跳过。';
        } else if (unansweredCount > 0) {
          statusEl.textContent = `已回答 ${answeredCount}/${questions.length} 个问题；未回答的问题会被视为跳过。`;
        } else {
          statusEl.textContent = '答案会作为本地工具结果回传给模型，并继续当前生成。';
        }
      }

      questions.forEach((question, questionIndex) => {
        const itemEl = document.createElement('section');
        itemEl.className = 'composer-request-question';

        const itemHeader = document.createElement('div');
        itemHeader.className = 'composer-request-question-header';

        const itemBadge = document.createElement('span');
        itemBadge.className = 'composer-request-question-badge';
        itemBadge.textContent = question.header || `问题 ${questionIndex + 1}`;
        itemHeader.appendChild(itemBadge);

        const itemIndex = document.createElement('span');
        itemIndex.className = 'composer-request-question-index';
        itemIndex.textContent = `${questionIndex + 1}/${questions.length}`;
        itemHeader.appendChild(itemIndex);

        itemEl.appendChild(itemHeader);

        const promptEl = document.createElement('div');
        promptEl.className = 'composer-request-question-prompt';
        promptEl.textContent = question.question || '';
        itemEl.appendChild(promptEl);

        const optionsEl = document.createElement('div');
        optionsEl.className = 'composer-request-options';
        itemEl.appendChild(optionsEl);

        const groupName = `composer-request-${Date.now()}-${questionIndex}-${Math.random().toString(36).slice(2, 8)}`;
        const optionList = [
          ...(Array.isArray(question.options) ? question.options : []),
          {
            label: '其他',
            description: '如果这些都不合适，可以自己补充答案。',
            __other: true
          }
        ];

        let firstRadio = null;
        let otherRadio = null;

        const otherWrap = document.createElement('div');
        otherWrap.className = 'composer-request-other-wrap';

        const otherInput = document.createElement('input');
        otherInput.type = 'text';
        otherInput.className = 'settings-text-input composer-request-other-input';
        otherInput.placeholder = '补充你自己的答案';
        otherInput.disabled = true;
        otherWrap.appendChild(otherInput);

        const getSelectedRadio = () => optionsEl.querySelector(`input[name="${groupName}"]:checked`);
        const syncOtherInputState = () => {
          const isOtherSelected = otherRadio?.checked === true;
          otherInput.disabled = !isOtherSelected;
          otherWrap.classList.toggle('is-active', isOtherSelected);
          if (!isOtherSelected) return;
          requestAnimationFrame(() => {
            otherInput.focus();
            otherInput.select();
          });
        };

        optionList.forEach((option, optionIndex) => {
          const optionLabel = document.createElement('label');
          optionLabel.className = 'composer-request-option';

          const radio = document.createElement('input');
          radio.type = 'radio';
          radio.className = 'composer-request-option-input';
          radio.name = groupName;
          radio.value = option.__other ? '__other__' : (option.label || '');

          if (!firstRadio) firstRadio = radio;
          if (option.__other) otherRadio = radio;

          radio.addEventListener('change', () => {
            syncOtherInputState();
            updatePanelState();
          });

          const optionIndexEl = document.createElement('span');
          optionIndexEl.className = 'composer-request-option-index';
          optionIndexEl.textContent = `${optionIndex + 1}.`;

          const body = document.createElement('div');
          body.className = 'composer-request-option-body';

          const optionTitle = document.createElement('div');
          optionTitle.className = 'composer-request-option-title';
          optionTitle.textContent = option.label || '';
          body.appendChild(optionTitle);

          const optionDesc = document.createElement('div');
          optionDesc.className = 'composer-request-option-desc';
          optionDesc.textContent = option.description || '';
          body.appendChild(optionDesc);

          optionLabel.appendChild(radio);
          optionLabel.appendChild(optionIndexEl);
          optionLabel.appendChild(body);
          optionsEl.appendChild(optionLabel);
        });

        otherInput.addEventListener('input', () => updatePanelState());
        itemEl.appendChild(otherWrap);

        questionsEl.appendChild(itemEl);

        controlEntries.push({
          question,
          focusFirst() {
            firstRadio?.focus();
          },
          getAnswer() {
            const selectedRadio = getSelectedRadio();
            if (!selectedRadio) return '';
            if (selectedRadio.value === '__other__') {
              return otherInput.value.trim();
            }
            return String(selectedRadio.value || '').trim();
          }
        });
      });

      const footer = document.createElement('div');
      footer.className = 'composer-request-footer';

      const statusWrap = document.createElement('div');
      statusWrap.className = 'composer-request-status-wrap';

      const statusEl = document.createElement('div');
      statusEl.className = 'composer-request-status';
      statusWrap.appendChild(statusEl);

      const shortcutEl = document.createElement('div');
      shortcutEl.className = 'composer-request-shortcut';
      shortcutEl.textContent = 'Esc 跳过，Ctrl/Cmd + Enter 继续。';
      statusWrap.appendChild(shortcutEl);

      footer.appendChild(statusWrap);

      const actions = document.createElement('div');
      actions.className = 'composer-request-actions';

      const skipBtn = document.createElement('button');
      skipBtn.type = 'button';
      skipBtn.className = 'composer-request-button composer-request-button--ghost';
      skipBtn.textContent = '先跳过';
      actions.appendChild(skipBtn);

      const submitBtn = document.createElement('button');
      submitBtn.type = 'button';
      submitBtn.className = 'composer-request-button composer-request-button--primary';
      submitBtn.textContent = '继续生成';
      actions.appendChild(submitBtn);

      footer.appendChild(actions);
      panel.appendChild(footer);

      let settled = false;
      let removeKeyListener = null;

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        if (activeRequestUserInputSession?.panel === panel) {
          activeRequestUserInputSession = null;
        }
        if (typeof removeKeyListener === 'function') {
          removeKeyListener();
          removeKeyListener = null;
        }
        panel.remove();
        refreshComposerAccessoryLayout();
        resolve(payload);
      };

      const onSkip = () => finish({ cancelled: true, answers: {} });
      const onSubmit = () => {
        const answers = buildAnswerMap();
        finish({
          cancelled: Object.keys(answers).length <= 0,
          answers
        });
      };

      dismissBtn.addEventListener('click', onSkip);
      skipBtn.addEventListener('click', onSkip);
      submitBtn.addEventListener('click', onSubmit);

      const onKeyDown = (event) => {
        if (!panel.isConnected) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onSkip();
          return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          onSubmit();
        }
      };
      document.addEventListener('keydown', onKeyDown, true);
      removeKeyListener = () => document.removeEventListener('keydown', onKeyDown, true);

      activeRequestUserInputSession = { panel, finish };
      host.insertBefore(panel, host.firstChild || null);
      refreshComposerAccessoryLayout();
      updatePanelState();
      controlEntries[0]?.focusFirst?.();
      panel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  };

  // 多步骤进度条工具：等分整体进度，支持每步子进度
  appContext.utils.createStepProgress = (config = {}) => {
    const steps = Array.isArray(config.steps) ? config.steps.slice() : [];
    const type = config.type || 'info';
    const total = Math.max(steps.length, 1);
    let index = 0; // 当前步索引
    let subDone = 0;
    let subTotal = 1;

    const formatMessage = (customMessage) => (customMessage || steps[index] || '');

    const toast = appContext.utils.showNotification({
      message: formatMessage(config.message),
      type,
      showProgress: true,
      progress: 0,
      progressMode: 'determinate',
      autoClose: false,
      duration: 0
    });
    // 简化：仅显示当前步骤文案，不显示历史列表

    const calcProgress = () => {
      const stepBase = index / total;
      const stepSpan = 1 / total;
      const frac = Math.max(0, Math.min(1, subTotal ? (subDone / subTotal) : 0));
      return Math.max(0, Math.min(1, stepBase + frac * stepSpan));
    };

    const api = {
      toast,
      setStep(i, message) {
        index = Math.max(0, Math.min(total - 1, Number(i) || 0));
        subDone = 0; subTotal = 1;
        toast.update({ message: formatMessage(message), progress: calcProgress(), progressMode: 'determinate' });
        return api;
      },
      updateSub(done, totalSub, message) {
        if (typeof message === 'string') toast.update({ message: formatMessage(message) });
        subDone = Math.max(0, Number(done) || 0);
        subTotal = Math.max(1, Number(totalSub) || 1);
        toast.update({ progress: calcProgress(), progressMode: 'determinate' });
        return api;
      },
      next(message) {
        index = Math.min(index + 1, total - 1);
        subDone = 0; subTotal = 1;
        toast.update({ message: formatMessage(message), progress: calcProgress(), progressMode: 'determinate' });
        return api;
      },
      complete(message, succeed = true) {
        toast.update({ message: message || '完成', type: succeed ? 'success' : 'error', progress: 1, autoClose: true, duration: 1800 });
        return api;
      }
    };

    // 初始化第 1 步显示
    api.setStep(0, steps[0] || config.message || '');
    return api;
  };

  appContext.utils.closeExclusivePanels = () => {
    return appContext.services.uiManager?.closeExclusivePanels();
  };

  appContext.utils.deleteMessageContent = async (messageElement) => {
    if (!messageElement) return;
    const messageId = messageElement.getAttribute('data-message-id');

    const contextMenuManager = appContext.services.contextMenuManager;
    const messageSender = appContext.services.messageSender;

    if (!messageId) {
      messageElement.remove();
      console.warn('删除消息：占位或临时消息缺少ID，已直接移除');
      contextMenuManager?.hideContextMenu();
      return;
    }
    await messageSender?.requestConversationMessageDeletion?.({ messageId });
    contextMenuManager?.hideContextMenu();
  };

  /**
   * 在页面底部展示轻量提示，同时支持自动消失动画。
   * @param {string} message - 展示文案。
   * @param {number} [duration=2000] - 持续毫秒数。
   */
  appContext.utils.showNotification = (input, legacyDuration) => {
    // 规范通知类型：统一为 'info' | 'warning' | 'error'，兼容 legacy 'success' -> 'info', 'warn' -> 'warning'
    const normalizeType = (t) => {
      if (!t) return 'info';
      const map = { success: 'info', warn: 'warning' };
      const mapped = map[t] || t;
      return (mapped === 'info' || mapped === 'warning' || mapped === 'error') ? mapped : 'info';
    };
    const normalizeOptions = (value, fallbackDuration) => {
      if (typeof value === 'string') {
        const options = { message: value };
        if (typeof fallbackDuration === 'number') options.duration = fallbackDuration;
        return options;
      }
      if (value && typeof value === 'object') {
        return { ...value };
      }
      return { message: '' };
    };

    /** @type {{ message:string, duration?:number, type?:'info'|'warning'|'error'|'success'|'warn', autoClose?:boolean, showProgress?:boolean, progress?:number|null, progressMode?:'determinate'|'indeterminate', onClose?:()=>void, description?:string }} */
    const config = normalizeOptions(input, legacyDuration);
    const {
      message = '',
      description = '',
      type = 'info',
      onClose = null
    } = config;
    let { duration = 2000, autoClose = true, showProgress = false, progress = null, progressMode = 'determinate' } = config;

    if (typeof duration !== 'number' || duration <= 0) {
      duration = 2000;
    }

    if (progress !== null && typeof progress === 'number') {
      showProgress = true;
    }
    if (progressMode === 'indeterminate') {
      showProgress = true;
    }

    let container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    const initialType = normalizeType(type);
    toast.className = `notification notification--${initialType}`;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    const content = document.createElement('div');
    content.className = 'notification__content';
    content.textContent = message;
    toast.appendChild(content);

    let descriptionEl = null;
    if (description) {
      descriptionEl = document.createElement('div');
      descriptionEl.className = 'notification__description';
      descriptionEl.textContent = description;
      toast.appendChild(descriptionEl);
    }

    let progressContainer = null;
    let progressBar = null;

    const ensureProgressElements = () => {
      if (progressContainer) return;
      progressContainer = document.createElement('div');
      progressContainer.className = 'notification__progress';
      progressBar = document.createElement('div');
      progressBar.className = 'notification__progress-bar';
      progressContainer.appendChild(progressBar);
      toast.appendChild(progressContainer);
    };

    const applyProgress = (value, mode = progressMode) => {
      if (!showProgress || value === null || value === undefined) {
        if (progressContainer) {
          progressContainer.remove();
          progressContainer = null;
          progressBar = null;
        }
        toast.classList.remove('notification--has-progress');
        return;
      }

      ensureProgressElements();
      toast.classList.add('notification--has-progress');
      progressBar.classList.remove('notification__progress-bar--indeterminate');

      if (mode === 'indeterminate') {
        progressBar.style.width = '50%';
        progressBar.classList.add('notification__progress-bar--indeterminate');
      } else {
        const clamped = Math.max(0, Math.min(1, Number(value)));
        progressBar.style.width = `${clamped * 100}%`;
      }
    };

    if (showProgress) {
      applyProgress(progress ?? 0, progressMode);
    }

    container.appendChild(toast);

    const state = {
      closed: false,
      autoClose,
      duration,
      type: initialType,
      closeTimer: null,
      progressMode,
      onClose
    };

    const scheduleClose = () => {
      if (!state.autoClose || state.closed) return;
      if (state.closeTimer) clearTimeout(state.closeTimer);
      state.closeTimer = setTimeout(() => handle.close(), state.duration);
    };

    const clearCloseTimer = () => {
      if (state.closeTimer) {
        clearTimeout(state.closeTimer);
        state.closeTimer = null;
      }
    };

    if (state.autoClose) {
      scheduleClose();
    }

    const handle = {
      element: toast,
      update(updateOptions = {}) {
        if (state.closed) return handle;

        if (typeof updateOptions.message === 'string') {
          content.textContent = updateOptions.message;
        }

        if (typeof updateOptions.description === 'string') {
          if (!descriptionEl) {
            descriptionEl = document.createElement('div');
            descriptionEl.className = 'notification__description';
            toast.insertBefore(descriptionEl, progressContainer);
          }
          descriptionEl.textContent = updateOptions.description;
        } else if (updateOptions.description === null && descriptionEl) {
          descriptionEl.remove();
          descriptionEl = null;
        }

        if (updateOptions.type) {
          const nextType = normalizeType(updateOptions.type);
          toast.classList.remove(`notification--${state.type}`);
          state.type = nextType;
          toast.classList.add(`notification--${state.type}`);
        }

        if (typeof updateOptions.autoClose === 'boolean') {
          state.autoClose = updateOptions.autoClose;
          if (!state.autoClose) {
            clearCloseTimer();
          } else {
            scheduleClose();
          }
        }

        if (typeof updateOptions.duration === 'number' && updateOptions.duration > 0) {
          state.duration = updateOptions.duration;
          if (state.autoClose) {
            scheduleClose();
          }
        }

        if (updateOptions.progressMode) {
          state.progressMode = updateOptions.progressMode;
        }

        if (updateOptions.showProgress !== undefined) {
          showProgress = !!updateOptions.showProgress;
          if (!showProgress) {
            applyProgress(null);
          }
        }

        if (updateOptions.progress !== undefined) {
          progress = updateOptions.progress;
          if (typeof progress === 'number' && !showProgress) {
            showProgress = true;
          }
          if (progress === null) {
            showProgress = false;
          }
          if (showProgress) {
            applyProgress(progress, state.progressMode);
          } else {
            applyProgress(null, state.progressMode);
          }
        } else if (showProgress && updateOptions.progressMode) {
          applyProgress(progress ?? 0, state.progressMode);
        }

        if (state.autoClose && updateOptions.progress === 1 && updateOptions.autoClose !== false) {
          scheduleClose();
        }

        return handle;
      },
      close(immediate = false) {
        if (state.closed) return;
        state.closed = true;
        clearCloseTimer();
        toast.classList.add('fade-out');
        const remove = () => {
          toast.remove();
          if (typeof state.onClose === 'function') {
            try { state.onClose(); } catch (err) { console.error('通知关闭回调异常:', err); }
          }
        };
        if (immediate) {
          remove();
        } else {
          setTimeout(remove, 480);
        }
      }
    };

    return handle;
  };

  appContext.utils.requestScreenshot = () => {
    if (appContext.state.isStandalone) {
      // 警告：独立页面不支持截图
      appContext.utils.showNotification({ message: '独立聊天页面不支持网页截图', type: 'warning' });
      return;
    }
    window.parent.postMessage({ type: 'CAPTURE_SCREENSHOT' }, '*');
  };

  /**
   * 获取当前 JS Runtime 可用性。
   * 供后续工具层与调试入口统一复用。
   */
  appContext.utils.getJsRuntimeStatus = async () => {
    const pageToolEnvironment = resolveCurrentPageToolEnvironment();
    if (pageToolEnvironment.jsRuntimeEnvironment !== JS_RUNTIME_ENV_BOUND_HOST_PAGE) {
      const status = await jsSandboxRuntime.getAvailability();
      return {
        success: true,
        status
      };
    }
    if (!chrome?.runtime?.sendMessage) {
      return {
        success: false,
        error: '当前环境不支持 chrome.runtime.sendMessage'
      };
    }
    try {
      return await raceWithTimeout(
        chrome.runtime.sendMessage({ type: 'GET_JS_RUNTIME_STATUS' }),
        JS_RUNTIME_STATUS_TIMEOUT_MS,
        '获取 JS Runtime 状态超时'
      );
    } catch (error) {
      return {
        success: false,
        error: error?.message || '获取 JS Runtime 状态失败'
      };
    }
  };

  /**
   * 获取当前侧栏所绑定网页标签页的 frame 快照。
   * 主要用于在发起 Responses 请求前，把 frameId/url/title 注入模型上下文。
   */
  appContext.utils.getJsRuntimeFrames = async (options = {}) => {
    const runtimeEnvironment = (typeof options?.runtimeEnvironment === 'string' && options.runtimeEnvironment)
      ? options.runtimeEnvironment
      : resolveCurrentPageToolEnvironment().jsRuntimeEnvironment;
    if (runtimeEnvironment !== JS_RUNTIME_ENV_BOUND_HOST_PAGE) {
      try {
        const result = await jsSandboxRuntime.listFrames();
        return {
          success: true,
          ...result
        };
      } catch (error) {
        return {
          success: false,
          error: error?.message || '获取隔离 JS Sandbox frame 快照失败'
        };
      }
    }
    if (!chrome?.runtime?.sendMessage) {
      return {
        success: false,
        error: '当前环境不支持 chrome.runtime.sendMessage'
      };
    }
    try {
      const targetTabId = await resolveBoundSidebarTargetTabId();
      if (!Number.isFinite(targetTabId)) {
        return {
          success: false,
          error: '当前侧栏尚未解析出稳定的宿主标签页，暂时无法读取 JS Runtime frame 快照。'
        };
      }
      return await raceWithTimeout(
        chrome.runtime.sendMessage({ type: 'GET_JS_RUNTIME_FRAMES', tabId: targetTabId }),
        JS_RUNTIME_FRAME_SNAPSHOT_TIMEOUT_MS,
        '获取 JS Runtime frame 快照超时'
      );
    } catch (error) {
      return {
        success: false,
        error: error?.message || '获取 JS Runtime frame 快照失败'
      };
    }
  };

  /**
   * 在当前侧栏所绑定的网页标签页里执行一段基于 userScripts 的 JS 代码。
   * 第一阶段先提供给调试入口与后续工具层使用，不额外引入复杂 UI。
   *
   * @param {string} code - 作为 async IIFE 函数体执行的代码片段，可直接使用 await / return
   * @param {Object} [options]
   * @returns {Promise<Object>}
   */
  appContext.utils.executeJsRuntime = async (code, options = {}) => {
    const runtimeEnvironment = (typeof options?.runtimeEnvironment === 'string' && options.runtimeEnvironment)
      ? options.runtimeEnvironment
      : resolveCurrentPageToolEnvironment().jsRuntimeEnvironment;
    if (runtimeEnvironment !== JS_RUNTIME_ENV_BOUND_HOST_PAGE) {
      try {
        const result = await jsSandboxRuntime.execute({
          code: (typeof code === 'string') ? code : ''
        });
        return {
          success: true,
          tabId: null,
          ...result
        };
      } catch (error) {
        return {
          success: false,
          error: error?.message || '执行隔离 JS Sandbox 失败'
        };
      }
    }
    if (!chrome?.runtime?.sendMessage) {
      return {
        success: false,
        error: '当前环境不支持 chrome.runtime.sendMessage'
      };
    }
    try {
      const targetTabId = await resolveBoundSidebarTargetTabId();
      if (!Number.isFinite(targetTabId)) {
        return {
          success: false,
          error: '当前侧栏尚未解析出稳定的宿主标签页，暂时无法执行 JS Runtime。'
        };
      }
      return await raceWithTimeout(
        chrome.runtime.sendMessage({
          type: 'EXECUTE_JS_RUNTIME',
          tabId: targetTabId,
          code: (typeof code === 'string') ? code : '',
          frameIds: Array.isArray(options?.frameIds) ? options.frameIds : null,
          injectImmediately: options?.injectImmediately === true
        }),
        JS_RUNTIME_EXECUTION_TIMEOUT_MS,
        '执行 JS Runtime 超时'
      );
    } catch (error) {
      return {
        success: false,
        error: error?.message || '执行 JS Runtime 失败'
      };
    }
  };

  appContext.utils.addImageToContainer = (imageData, fileName) => {
    const imageTag = appContext.services.imageHandler.createImageTag(imageData, fileName);
    appContext.dom.imageContainer.appendChild(imageTag);
    appContext.dom.messageInput.dispatchEvent(new Event('input'));
  };
}

/**
 * 根据独立页面模式对界面进行调整。
 * @param {Object} appContext - 侧边栏上下文对象。
 */
/**
 * 根据是否处于独立页面模式，调整界面元素的显隐与样式。
 * @param {ReturnType<typeof createSidebarAppContext>} appContext - 侧边栏上下文。
 */
export function applyStandaloneAdjustments(appContext) {
  if (!appContext.state.isStandalone) {
    return;
  }

  document.body.classList.add('standalone-mode');
  const root = document.documentElement;
  root.classList.add('standalone-mode');
  // 独立页面沿用统一的「全屏模式」布局：使用“全屏内容宽度”控制居中内容列宽度
  root.classList.add('fullscreen-mode');
  // 宽度相关 CSS 变量通常由 settings_manager 负责写入（并包含缩放校正）。
  // 这里仅做兜底：当初始化异常导致变量未写入时，再根据当前设置补一次。
  try {
    const alreadyApplied = (root.style.getPropertyValue('--cerebr-fullscreen-width') || '').trim();
    if (!alreadyApplied) {
      const settingsManager = appContext.services.settingsManager;
      const configuredFullscreenWidth = settingsManager?.getSetting?.('fullscreenWidth');
      const fallbackSidebarWidth = settingsManager?.getSetting?.('sidebarWidth');
      const configuredScaleFactor = settingsManager?.getSetting?.('scaleFactor');

      const fullscreenWidth = (typeof configuredFullscreenWidth === 'number' && !Number.isNaN(configuredFullscreenWidth))
        ? configuredFullscreenWidth
        : ((typeof fallbackSidebarWidth === 'number' && !Number.isNaN(fallbackSidebarWidth)) ? fallbackSidebarWidth : 800);

      const scaleFactor = (typeof configuredScaleFactor === 'number' && !Number.isNaN(configuredScaleFactor) && configuredScaleFactor > 0)
        ? configuredScaleFactor
        : 1;

      const dpr = Number(window.devicePixelRatio);
      const baseScale = (Number.isFinite(dpr) && dpr > 0) ? 1 / dpr : 1;
      // 独立页面会应用 DPR 缩放，这里同步校正全屏宽度，避免布局缩放后偏移
      const correctionScale = scaleFactor * baseScale;
      root.style.setProperty('--cerebr-fullscreen-width', `${fullscreenWidth / (correctionScale || 1)}px`);
    }
  } catch (e) {
    // 回退：在极端情况下保持可用布局，而不是让页面崩溃
    console.warn('应用独立页面宽度兜底设置失败（忽略）:', e);
  }

  const standaloneInfo = { url: '', title: '独立聊天', standalone: true };
  appContext.state.pageInfo = standaloneInfo;
  window.cerebr.pageInfo = standaloneInfo;

  const elementsToHide = [
    appContext.dom.collapseButton,
    appContext.dom.statusDot,
    appContext.dom.screenshotButton,
    appContext.dom.fullscreenToggle,
    appContext.dom.quickSummary,
    appContext.dom.emptyStateSummary,
    appContext.dom.emptyStateLoadUrl,
    appContext.dom.emptyStatePageContent,
    appContext.dom.emptyStateTempMode,
    appContext.dom.repomixButton
  ];

  elementsToHide.forEach((el) => {
    if (el) {
      el.style.display = 'none';
    }
  });

  if (appContext.dom.openStandalonePage) {
    appContext.dom.openStandalonePage.style.display = 'none';
  }

  const widthSlider = document.getElementById('sidebar-width');
  const positionToggle = document.getElementById('sidebar-position-switch');
  positionToggle?.closest('.menu-item')?.classList.add('standalone-hidden');
}
