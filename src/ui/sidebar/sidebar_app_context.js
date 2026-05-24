/**
 * 构建侧边栏 appContext 以及与 DOM/工具相关的辅助函数。
 * 将原本集中在 sidebar.js 中的初始化逻辑拆分出来，
 * 便于后续进一步分离服务初始化与事件绑定责任。
 */
import { createSidebarJsSandboxRuntime } from './js_sandbox_runtime.js';
import {
  JS_RUNTIME_ENV_BOUND_HOST_PAGE,
  resolvePageToolEnvironment
} from '../../agent_tools/shared/page_tool_environment.js';
import {
  REQUEST_USER_INPUT_OTHER_OPTION_VALUE,
  buildRequestUserInputAnswerMap,
  buildRequestUserInputSkipPayload,
  shouldAutoCompleteRequestUserInput
} from '../../utils/request_user_input_interaction.js';
import {
  VIRTUAL_FILE_TARGET_KIND_CONVERSATION_DOCUMENT,
  buildConversationDocumentActionPayloadFromVirtualFileAction,
  buildSkillRegistryFileActionPayloadFromVirtualFileAction,
  executeConversationDocumentAction,
  normalizeVirtualFileResultFromSkillRegistryAction,
  normalizeVirtualFileToolArguments
} from '../../agent_tools/virtual_file_io/index.js';
import {
  getDocumentZoomFactor,
  toLayoutPixels
} from '../../utils/coordinate_space.js';

const JS_RUNTIME_STATUS_TIMEOUT_MS = 5000;
const JS_RUNTIME_FRAME_SNAPSHOT_TIMEOUT_MS = 5000;
const JS_RUNTIME_EXECUTION_TIMEOUT_MS = 30000;
const SKILL_REGISTRY_TIMEOUT_MS = 10000;

function resolveSidebarInstanceIdFromLocation() {
  try {
    const currentUrl = new URL(window.location.href);
    const fromSearch = currentUrl.searchParams.get('instanceId');
    if (typeof fromSearch === 'string' && fromSearch.trim()) {
      return fromSearch.trim();
    }
    const hashQuery = currentUrl.hash.startsWith('#') ? currentUrl.hash.slice(1) : '';
    const hashParams = new URLSearchParams(hashQuery);
    const fromHash = hashParams.get('instanceId');
    if (typeof fromHash === 'string' && fromHash.trim()) {
      return fromHash.trim();
    }
  } catch (_) {}
  return '';
}

function resolveSidebarIsPrimaryFromLocation() {
  try {
    const currentUrl = new URL(window.location.href);
    const fromSearch = currentUrl.searchParams.get('isPrimary');
    if (typeof fromSearch === 'string') {
      return fromSearch === '1' || fromSearch.toLowerCase() === 'true';
    }
    const hashQuery = currentUrl.hash.startsWith('#') ? currentUrl.hash.slice(1) : '';
    const hashParams = new URLSearchParams(hashQuery);
    const fromHash = hashParams.get('isPrimary');
    if (typeof fromHash === 'string') {
      return fromHash === '1' || fromHash.toLowerCase() === 'true';
    }
  } catch (_) {}
  return false;
}

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
    documentButton: document.getElementById('document-button'),
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
    copyCodeButton: document.getElementById('copy-code'),
    imageContainer: document.getElementById('image-container'),
    promptSettingsToggle: document.getElementById('prompt-settings-toggle'),
    preferencesSettingsToggle,
    promptSettingsPanel: document.getElementById('prompt-settings'),
    inputContainer: document.getElementById('input-container'),
    composerAccessoryRegion: document.getElementById('composer-accessory-region'),
    scrollToBottomAnchor: document.getElementById('scroll-to-bottom-anchor'),
    scrollToBottomButton: document.getElementById('scroll-to-bottom-button'),
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
    addSidebarButton: document.getElementById('add-sidebar-button'),
    sidebarPositionSwitch: document.getElementById('sidebar-position-switch'),
    forkConversationButton: document.getElementById('fork-conversation'),
    screenshotMenu: document.getElementById('message-screenshot-menu'),
    copyAsImageButton: document.getElementById('copy-as-image'),
    selectForImageButton: document.getElementById('select-for-image'),
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
      sidebarInstanceId: resolveSidebarInstanceIdFromLocation(),
      isPrimarySidebar: resolveSidebarIsPrimaryFromLocation(),
      isFullscreen: false,
      hostEmbedScale: 1,
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
    const pageInfo = appContext.state.pageInfo && typeof appContext.state.pageInfo === 'object'
      ? appContext.state.pageInfo
      : {};
    const contentType = typeof pageInfo.contentType === 'string' ? pageInfo.contentType.trim().toLowerCase() : '';
    const pageUrl = typeof pageInfo.url === 'string' ? pageInfo.url.trim().toLowerCase() : '';
    const isPdfPage = options?.isPdfPage === true
      || pageInfo.isPdf === true
      || pageInfo.is_pdf === true
      || contentType === 'application/pdf'
      || pageUrl.includes('.pdf');
    return resolvePageToolEnvironment({
      isStandalone: appContext.state.isStandalone,
      isTemporaryMode: explicitTemporaryMode,
      isPdfPage
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
  appContext.utils.getComposerAccessoryRegion = getComposerAccessoryRegion;

  const refreshComposerAccessoryLayout = () => {
    window.requestAnimationFrame(() => {
      appContext.utils.updateInputContainerHeightVar?.();
    });
  };
  appContext.utils.refreshComposerAccessoryLayout = refreshComposerAccessoryLayout;

  const REQUEST_USER_INPUT_DRAFT_SESSION_KEY = '__draft__';
  let activeRequestUserInputSession = null;
  const requestUserInputSessionsByConversationKey = new Map();

  function normalizeRequestUserInputConversationKey(value) {
    const normalized = (typeof value === 'string') ? value.trim() : '';
    return normalized || REQUEST_USER_INPUT_DRAFT_SESSION_KEY;
  }

  function resolveCurrentRequestUserInputConversationKey() {
    const conversationId = appContext.services.chatHistoryUI?.getCurrentConversationId?.()
      || appContext.services.messageSender?.getCurrentConversationId?.()
      || '';
    return normalizeRequestUserInputConversationKey(conversationId);
  }

  function removeConversationScopedComposerPreviewDom() {
    document.querySelectorAll('.conversation-send-queue-preview').forEach((node) => node.remove());
  }

  function unmountRequestUserInputSession(session) {
    if (!session || typeof session !== 'object') return;
    if (activeRequestUserInputSession === session) {
      activeRequestUserInputSession = null;
    }
    if (session.panel?.isConnected) {
      session.panel.remove();
    }
  }

  function mountRequestUserInputSession(session) {
    const host = getComposerAccessoryRegion();
    if (!host || !session?.panel) return false;

    document.querySelectorAll('.composer-request-panel').forEach((node) => {
      if (node !== session.panel) node.remove();
    });

    if (session.panel.parentElement !== host) {
      host.insertBefore(session.panel, host.firstChild || null);
    } else if (host.firstChild !== session.panel) {
      host.insertBefore(session.panel, host.firstChild || null);
    }

    activeRequestUserInputSession = session;
    refreshComposerAccessoryLayout();
    if (typeof session.focusCurrentQuestionControl === 'function') {
      session.focusCurrentQuestionControl();
    } else {
      window.requestAnimationFrame(() => session.panel.focus({ preventScroll: true }));
    }
    session.panel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
  }

  /**
   * 清理“仅属于当前显示会话”的 composer 辅助区 UI。
   *
   * 说明：
   * - 切换到别的会话时，旧会话的提问抽屉和 queue / steer 预览不应继续挂在当前输入框上；
   * - 但未回答的 request_user_input 默认只做“卸载 UI”，不自动 skip，这样回到原会话还能恢复；
   * - queue / steer 预览属于可重绘 UI，切换后直接删 DOM，交给新会话上下文重新渲染即可。
   */
  appContext.utils.resetConversationScopedComposerState = (options = {}) => {
    const preservePendingRequestUserInput = options?.preservePendingRequestUserInput !== false;

    if (activeRequestUserInputSession) {
      if (preservePendingRequestUserInput) {
        unmountRequestUserInputSession(activeRequestUserInputSession);
      } else {
        activeRequestUserInputSession.finish?.({ cancelled: true, answers: {} });
      }
    }

    document.querySelectorAll('.composer-request-panel').forEach((node) => {
      if (activeRequestUserInputSession?.panel === node) return;
      node.remove();
    });
    appContext.utils.hideSlashCommandHints?.();
    removeConversationScopedComposerPreviewDom();
    refreshComposerAccessoryLayout();
  };

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
   * 在输入框上方的统一辅助区内展示 request_user_input 面板，并等待用户回答或跳过。
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
    const conversationKey = resolveCurrentRequestUserInputConversationKey();
    const existingSession = requestUserInputSessionsByConversationKey.get(conversationKey) || null;

    if (!host) {
      return Promise.reject(new Error('当前界面尚未初始化输入框辅助区。'));
    }

    appContext.utils.hideSlashCommandHints?.();

    if (activeRequestUserInputSession && activeRequestUserInputSession !== existingSession) {
      unmountRequestUserInputSession(activeRequestUserInputSession);
    }

    if (existingSession) {
      mountRequestUserInputSession(existingSession);
      return existingSession.promise;
    }

    let session = null;
    const promise = new Promise((resolve) => {
      const panel = document.createElement('section');
      panel.className = 'composer-accessory-drawer composer-request-panel';
      panel.setAttribute('role', 'group');
      panel.setAttribute('aria-label', '模型补充提问');
      panel.tabIndex = -1;

      const stageEl = document.createElement('div');
      stageEl.className = 'composer-request-stage';
      panel.appendChild(stageEl);

      /**
       * 每个问题只维护一个极小状态：
       * - `selectedOptionValue`：普通选项直接保存 label；Other 用保留常量作为标记；
       * - `freeformText`：只在选择 Other 时真正参与结果生成，但切回普通选项后仍保留，便于来回修改。
       */
      const questionStates = questions.map(() => ({
        selectedOptionValue: '',
        freeformText: ''
      }));
      let questionIndex = 0;
      let currentRegularOptionButtons = [];
      let currentOtherInput = null;
      let pendingFocusTarget = 'first-option';

      const clampQuestionIndex = (value) => {
        const numeric = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0;
        return Math.min(Math.max(numeric, 0), Math.max(questions.length - 1, 0));
      };

      const getQuestionState = (index) => {
        const normalizedIndex = clampQuestionIndex(index);
        const existing = questionStates[normalizedIndex] || { selectedOptionValue: '', freeformText: '' };
        const normalized = {
          selectedOptionValue: typeof existing.selectedOptionValue === 'string' ? existing.selectedOptionValue : '',
          freeformText: typeof existing.freeformText === 'string' ? existing.freeformText : ''
        };
        questionStates[normalizedIndex] = normalized;
        return normalized;
      };

      const patchQuestionState = (index, patch = {}) => {
        const current = getQuestionState(index);
        questionStates[clampQuestionIndex(index)] = {
          selectedOptionValue: typeof patch.selectedOptionValue === 'string'
            ? patch.selectedOptionValue
            : current.selectedOptionValue,
          freeformText: typeof patch.freeformText === 'string'
            ? patch.freeformText
            : current.freeformText
        };
        return questionStates[clampQuestionIndex(index)];
      };

      const buildAnswerMap = () => {
        return buildRequestUserInputAnswerMap(questions, questionStates);
      };

      const focusCurrentQuestionControl = () => {
        window.requestAnimationFrame(() => {
          if (!panel.isConnected) return;
          if (pendingFocusTarget === 'other-input' && currentOtherInput) {
            currentOtherInput.focus();
            currentOtherInput.select();
            return;
          }
          if (currentRegularOptionButtons[0]) {
            currentRegularOptionButtons[0].focus();
            return;
          }
          if (currentOtherInput) {
            currentOtherInput.focus();
            return;
          }
          panel.focus();
        });
      };

      const goToQuestion = (nextIndex, focusTarget = 'first-option') => {
        questionIndex = clampQuestionIndex(nextIndex);
        pendingFocusTarget = focusTarget;
        renderCurrentQuestion();
      };

      const setCurrentQuestionToOtherMode = ({ focusInput = true } = {}) => {
        patchQuestionState(questionIndex, { selectedOptionValue: REQUEST_USER_INPUT_OTHER_OPTION_VALUE });
        pendingFocusTarget = focusInput ? 'other-input' : 'panel';
        renderCurrentQuestion();
      };

      const handleRegularOptionSelection = (optionValue) => {
        patchQuestionState(questionIndex, { selectedOptionValue: String(optionValue || '') });
        if (shouldAutoCompleteRequestUserInput(questionIndex, questions, questionStates)) {
          finish({
            cancelled: false,
            answers: buildAnswerMap()
          });
          return;
        }
        if (questionIndex < questions.length - 1) {
          goToQuestion(questionIndex + 1, 'first-option');
          return;
        }
        pendingFocusTarget = 'panel';
        renderCurrentQuestion();
      };

      const handlePrimaryAction = () => {
        if (questionIndex < questions.length - 1) {
          goToQuestion(questionIndex + 1, 'first-option');
          return;
        }
        const answers = buildAnswerMap();
        finish({
          cancelled: Object.keys(answers).length <= 0,
          answers
        });
      };

      function renderCurrentQuestion() {
        const currentQuestion = questions[questionIndex] || questions[0] || null;
        if (!currentQuestion) {
          stageEl.textContent = '';
          return;
        }

        const currentState = getQuestionState(questionIndex);
        const regularOptions = Array.isArray(currentQuestion.options) ? currentQuestion.options : [];
        const otherPlaceholder = '其他';

        stageEl.textContent = '';
        currentRegularOptionButtons = [];
        currentOtherInput = null;

        const questionEl = document.createElement('section');
        questionEl.className = 'composer-accessory-drawer-surface composer-request-question';

        const questionHeader = document.createElement('div');
        questionHeader.className = 'composer-request-question-header';

        const questionBadge = document.createElement('span');
        questionBadge.className = 'composer-request-question-badge';
        questionBadge.textContent = currentQuestion.header || `问题 ${questionIndex + 1}`;
        questionHeader.appendChild(questionBadge);

        const questionNav = document.createElement('div');
        questionNav.className = 'composer-request-question-nav';

        const prevBtn = document.createElement('button');
        prevBtn.type = 'button';
        prevBtn.className = 'composer-request-nav-button';
        prevBtn.textContent = '‹';
        prevBtn.disabled = questionIndex <= 0;
        prevBtn.setAttribute('aria-label', '上一题');
        prevBtn.addEventListener('click', () => goToQuestion(questionIndex - 1, 'first-option'));
        questionNav.appendChild(prevBtn);

        const progressEl = document.createElement('span');
        progressEl.className = 'composer-request-nav-progress';
        progressEl.textContent = `${questionIndex + 1}/${questions.length}`;
        questionNav.appendChild(progressEl);

        const nextBtn = document.createElement('button');
        nextBtn.type = 'button';
        nextBtn.className = 'composer-request-nav-button';
        nextBtn.textContent = '›';
        nextBtn.disabled = questionIndex >= questions.length - 1;
        nextBtn.setAttribute('aria-label', '下一题');
        nextBtn.addEventListener('click', () => goToQuestion(questionIndex + 1, 'first-option'));
        questionNav.appendChild(nextBtn);

        const dismissBtn = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.className = 'composer-request-dismiss';
        dismissBtn.textContent = '跳过';
        dismissBtn.setAttribute('aria-label', '跳过本次补充提问');
        dismissBtn.addEventListener('click', onSkip);
        questionNav.appendChild(dismissBtn);

        questionHeader.appendChild(questionNav);
        questionEl.appendChild(questionHeader);

        const promptEl = document.createElement('div');
        promptEl.className = 'composer-request-question-prompt';
        promptEl.textContent = currentQuestion.question || '';
        questionEl.appendChild(promptEl);

        const optionsEl = document.createElement('div');
        optionsEl.className = 'composer-request-options';

        regularOptions.forEach((option, optionIndex) => {
          const optionButton = document.createElement('button');
          optionButton.type = 'button';
          optionButton.className = 'composer-request-option';
          optionButton.setAttribute('aria-label', option.label || '');
          if (currentState.selectedOptionValue === option.label) {
            optionButton.classList.add('composer-request-option--selected');
          }
          optionButton.addEventListener('click', () => {
            handleRegularOptionSelection(option.label || '');
          });

          const optionIndexEl = document.createElement('span');
          optionIndexEl.className = 'composer-request-option-index';
          optionIndexEl.textContent = `${optionIndex + 1}.`;
          optionButton.appendChild(optionIndexEl);

          const optionBody = document.createElement('div');
          optionBody.className = 'composer-request-option-body';

          const optionTitle = document.createElement('div');
          optionTitle.className = 'composer-request-option-title';
          optionTitle.textContent = option.label || '';
          optionBody.appendChild(optionTitle);

          if (option.description) {
            const optionDesc = document.createElement('div');
            optionDesc.className = 'composer-request-option-desc';
            optionDesc.textContent = option.description;
            optionBody.appendChild(optionDesc);
          }

          optionButton.appendChild(optionBody);
          optionsEl.appendChild(optionButton);
          currentRegularOptionButtons.push(optionButton);
        });

        const otherRow = document.createElement('label');
        otherRow.className = 'composer-request-inline-freeform';
        const otherSelected = currentState.selectedOptionValue === REQUEST_USER_INPUT_OTHER_OPTION_VALUE;
        if (otherSelected) {
          otherRow.classList.add('composer-request-inline-freeform--selected');
        }
        otherRow.addEventListener('mousedown', (event) => {
          if (event.target === currentOtherInput) return;
          event.preventDefault();
          setCurrentQuestionToOtherMode({ focusInput: true });
        });

        const otherIndexEl = document.createElement('span');
        otherIndexEl.className = 'composer-request-inline-freeform-index';
        otherIndexEl.textContent = `${regularOptions.length + 1}.`;
        otherRow.appendChild(otherIndexEl);

        const otherInput = document.createElement('textarea');
        otherInput.className = 'settings-text-input composer-request-inline-freeform-input';
        otherInput.placeholder = otherPlaceholder;
        otherInput.rows = 1;
        otherInput.value = currentState.freeformText || '';
        const syncOtherInputHeight = () => {
          // 允许 Shift+Enter 多行输入，同时把高度自动贴合内容，避免出现局促的内部滚动条。
          otherInput.style.height = 'auto';
          otherInput.style.height = `${Math.max(otherInput.scrollHeight, 0)}px`;
        };
        otherInput.addEventListener('focus', () => {
          if (getQuestionState(questionIndex).selectedOptionValue !== REQUEST_USER_INPUT_OTHER_OPTION_VALUE) {
            setCurrentQuestionToOtherMode({ focusInput: true });
            return;
          }
        });
        otherInput.addEventListener('input', () => {
          patchQuestionState(questionIndex, {
            selectedOptionValue: REQUEST_USER_INPUT_OTHER_OPTION_VALUE,
            freeformText: otherInput.value
          });
          if (!otherRow.classList.contains('composer-request-inline-freeform--selected')) {
            otherRow.classList.add('composer-request-inline-freeform--selected');
          }
          syncOtherInputHeight();
        });
        otherInput.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            handlePrimaryAction();
          }
        });
        otherRow.appendChild(otherInput);
        syncOtherInputHeight();
        currentOtherInput = otherInput;
        optionsEl.appendChild(otherRow);

        questionEl.appendChild(optionsEl);
        stageEl.appendChild(questionEl);
        focusCurrentQuestionControl();
      }

      let settled = false;
      session = {
        conversationKey,
        panel,
        questions,
        focusCurrentQuestionControl,
        finish: null,
        promise: null
      };

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        requestUserInputSessionsByConversationKey.delete(conversationKey);
        if (activeRequestUserInputSession === session) {
          activeRequestUserInputSession = null;
        }
        const finalize = () => {
          panel.remove();
          refreshComposerAccessoryLayout();
          resolve(payload);
        };
        if (!panel.isConnected) {
          finalize();
          return;
        }
        panel.classList.add('is-closing');
        window.setTimeout(finalize, 150);
      };
      session.finish = finish;

      const onSkip = () => finish(buildRequestUserInputSkipPayload());

      requestUserInputSessionsByConversationKey.set(conversationKey, session);
      activeRequestUserInputSession = session;
      host.insertBefore(panel, host.firstChild || null);
      document.querySelectorAll('.composer-request-panel').forEach((node) => {
        if (node !== panel) node.remove();
      });
      refreshComposerAccessoryLayout();
      renderCurrentQuestion();
      window.requestAnimationFrame(() => panel.focus({ preventScroll: true }));
      panel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });

    if (session) {
      session.promise = promise;
    }
    return promise;
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
    const chatHistoryManager = appContext.services.chatHistoryManager;
    const historyNode = messageId
      ? (chatHistoryManager?.chatHistory?.messages || []).find((node) => node?.id === messageId) || null
      : null;
    const isResponsesLocalCompactionMessage = !!(
      messageElement.classList.contains('context-compaction-message')
      || historyNode?.contextCompactionMarker
      || historyNode?.responsesLocalCompactionStatus
    );
    const compactionState = String(
      historyNode?.responsesLocalCompactionStatus?.state
      || messageElement.dataset?.compactionState
      || ''
    ).trim().toLowerCase();
    const isPreResponseMessage = messageElement.classList.contains('assistant-pre-response')
      || messageElement.classList.contains('loading-message');
    const hasAbortableRequest = !!messageSender?.hasAbortableRequest?.(messageElement);

    if (isResponsesLocalCompactionMessage && compactionState === 'pending' && messageId) {
      // 删除一个正在运行的 compact marker 必须先中止对应请求。
      // 否则请求完成后会因为目标节点已不存在而重新追加一个 compact marker，
      // 用户看到的效果就不再是“这次压缩当作没发生”。
      await messageSender?.cancelResponsesLocalCompaction?.(messageId);
      contextMenuManager?.hideContextMenu();
      return;
    }

    if (isPreResponseMessage && hasAbortableRequest) {
      messageSender.abortCurrentRequest?.(messageElement);
      if (!messageId) {
        messageElement.remove();
        contextMenuManager?.hideContextMenu();
        return;
      }
      await messageSender?.requestConversationMessageDeletion?.({ messageId });
      contextMenuManager?.hideContextMenu();
      return;
    }

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
   * 获取当前会话可见的技能摘要。
   *
   * 设计目标：
   * - 给隐藏 `skill_context` 提供轻量摘要来源；
   * - 不返回源码或详细 usage，保持渐进式披露；
   * - 宿主页模式下返回“内置指导 skill + 当前 URL 命中的页面 skill”；
   * - 独立页/无稳定宿主页时至少返回内置指导 skill，而不是整组清空。
   */
  appContext.utils.getMatchingSkillSummaries = async (options = {}) => {
    if (!chrome?.runtime?.sendMessage) {
      return {
        success: false,
        error: '当前环境不支持 chrome.runtime.sendMessage'
      };
    }
    try {
      const pageToolEnvironment = (options?.pageToolEnvironment && typeof options.pageToolEnvironment === 'object')
        ? options.pageToolEnvironment
        : resolveCurrentPageToolEnvironment();
      const isolateFromHostPage = pageToolEnvironment?.exposeHostPageTools !== true;
      const targetTabId = pageToolEnvironment.jsRuntimeEnvironment === JS_RUNTIME_ENV_BOUND_HOST_PAGE
        ? await resolveBoundSidebarTargetTabId()
        : null;
      return await raceWithTimeout(
        chrome.runtime.sendMessage({
          type: 'GET_MATCHING_SKILL_SUMMARIES',
          tabId: targetTabId,
          isolateFromHostPage
        }),
        SKILL_REGISTRY_TIMEOUT_MS,
        '读取当前页面匹配的技能摘要超时'
      );
    } catch (error) {
      return {
        success: false,
        error: error?.message || '读取当前页面匹配的技能摘要失败'
      };
    }
  };

  /**
   * 统一执行扩展侧 skill_registry 动作。
   *
   * 说明：
   * - 所有真正会改 registry / 动态 userScripts 的动作都交给 background；
   * - sidebar 只负责把当前绑定 tabId 一并传过去，供 refresh 当前文档使用。
   */
  appContext.utils.executeSkillRegistryAction = async (payload = {}) => {
    if (!chrome?.runtime?.sendMessage) {
      return {
        success: false,
        error: '当前环境不支持 chrome.runtime.sendMessage'
      };
    }
    try {
      const pageToolEnvironment = resolveCurrentPageToolEnvironment();
      const isolateFromHostPage = pageToolEnvironment?.exposeHostPageTools !== true;
      const targetTabId = isolateFromHostPage
        ? null
        : await resolveBoundSidebarTargetTabId();
      return await raceWithTimeout(
        chrome.runtime.sendMessage({
          type: 'SKILL_REGISTRY_ACTION',
          tabId: Number.isFinite(targetTabId) ? targetTabId : null,
          isolateFromHostPage,
          payload: (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {}
        }),
        SKILL_REGISTRY_TIMEOUT_MS,
        '执行 skill_registry 操作超时'
      );
    } catch (error) {
      return {
        success: false,
        error: error?.message || '执行 skill_registry 操作失败'
      };
    }
  };

  appContext.utils.executeVirtualFileAction = async (action, payload = {}) => {
    try {
      const normalizedArgs = normalizeVirtualFileToolArguments(action, payload, {
        defaultTargetKind: VIRTUAL_FILE_TARGET_KIND_CONVERSATION_DOCUMENT
      });

      if (normalizedArgs.target.kind === VIRTUAL_FILE_TARGET_KIND_CONVERSATION_DOCUMENT) {
        const conversationId = appContext.services.chatHistoryUI?.getCurrentConversationId?.();
        if (!conversationId) {
          return {
            ok: false,
            error: {
              message: '当前对话尚未持久化，暂时无法访问 workspace 文件。',
              name: 'ConversationDocumentUnavailableError',
              stack: ''
            }
          };
        }
        return await executeConversationDocumentAction(
          action,
          buildConversationDocumentActionPayloadFromVirtualFileAction(action, normalizedArgs),
          { conversationId }
        );
      }

      const skillResult = await appContext.utils.executeSkillRegistryAction(
        buildSkillRegistryFileActionPayloadFromVirtualFileAction(action, normalizedArgs)
      );
      if (skillResult?.success === true) {
        const output = { ...skillResult };
        delete output.success;
        return normalizeVirtualFileResultFromSkillRegistryAction(action, output, normalizedArgs);
      }
      return {
        ok: false,
        target: normalizedArgs.target,
        error: {
          message: (typeof skillResult?.error === 'string' && skillResult.error.trim())
            ? skillResult.error.trim()
            : '执行虚拟文件操作失败。',
          name: 'VirtualFileActionError',
          stack: ''
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          message: error?.message || '执行虚拟文件操作失败。',
          name: error?.name || 'VirtualFileActionError',
          stack: typeof error?.stack === 'string' ? error.stack : ''
        }
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
    const createAbortError = () => {
      const error = new Error('执行 JS Runtime 已取消。');
      error.name = 'AbortError';
      return error;
    };
    const timeoutMs = (() => {
      const raw = options?.timeoutMs;
      if (raw === null || typeof raw === 'undefined') return JS_RUNTIME_EXECUTION_TIMEOUT_MS;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : JS_RUNTIME_EXECUTION_TIMEOUT_MS;
    })();
    const signal = (options?.signal && typeof options.signal === 'object')
      ? options.signal
      : null;
    const runtimeEnvironment = (typeof options?.runtimeEnvironment === 'string' && options.runtimeEnvironment)
      ? options.runtimeEnvironment
      : resolveCurrentPageToolEnvironment().jsRuntimeEnvironment;
    if (runtimeEnvironment !== JS_RUNTIME_ENV_BOUND_HOST_PAGE) {
      try {
        const result = await jsSandboxRuntime.execute({
          code: (typeof code === 'string') ? code : '',
          timeoutMs,
          signal
        });
        return {
          success: true,
          tabId: null,
          ...result
        };
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw error;
        }
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
      if (signal?.aborted) {
        throw createAbortError();
      }
      const executionId = `jsrt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const executeRequest = {
          type: 'EXECUTE_JS_RUNTIME',
          tabId: targetTabId,
          code: (typeof code === 'string') ? code : '',
          executionId,
          timeoutMs,
          frameIds: Array.isArray(options?.frameIds) ? options.frameIds : null,
          injectImmediately: options?.injectImmediately === true
        };
      const executePromise = chrome.runtime.sendMessage(executeRequest);
      if (!signal) {
        return await raceWithTimeout(
          executePromise,
          timeoutMs,
          '执行 JS Runtime 超时'
        );
      }

      let cleanedUp = false;
      let abortListener = null;
      const cleanupAbortListener = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (abortListener) {
          try { signal.removeEventListener?.('abort', abortListener); } catch (_) {}
        }
      };
      const handleAbort = () => {
        cleanupAbortListener();
        chrome.runtime.sendMessage({
          type: 'ABORT_JS_RUNTIME',
          tabId: targetTabId,
          executionId,
          frameIds: Array.isArray(options?.frameIds) ? options.frameIds : null
        }).catch(() => null);
      };
      const abortPromise = new Promise((_, reject) => {
        abortListener = () => {
          handleAbort();
          reject(createAbortError());
        };
        if (signal.aborted) {
          abortListener();
          return;
        }
        try { signal.addEventListener?.('abort', abortListener, { once: true }); } catch (_) {}
      });

      return await raceWithTimeout(
        Promise.race([executePromise, abortPromise]).finally(cleanupAbortListener),
        timeoutMs,
        '执行 JS Runtime 超时'
      );
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw error;
      }
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
