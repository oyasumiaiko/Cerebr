/**
 * 消息发送和处理模块
 * 
 * 负责管理消息的构建、发送和处理响应的整个生命周期。
 * 这个模块是应用程序的核心部分，处理从用户输入到AI响应显示的完整流程。
 */
import { composeMessages } from './message_composer.js';
import { renderUserMessageTemplateWithInjection, applyRenderedTextToMessageContent } from './message_preprocessor.js';
import { extractThinkingFromText, mergeStreamingThoughts, mergeThoughts } from '../utils/thoughts_parser.js';
import { mergeResponsesReasoningText, normalizeResponsesReasoningText } from '../utils/responses_activity_reasoning.js';
import { cloneResponsesInputItems, mergeResponsesInputItems } from '../utils/responses_input_items.js';
import {
  applyResponsesCompactInstructionsOverride,
  buildResponsesLocalCompactionMarker,
  findLatestAssistantPromptTokenEntry,
  parseResponsesCompactResponseText,
  summarizeResponsesCompactRequestBody
} from '../utils/responses_local_compaction.js';
import {
  RESPONSES_COMPACT_CODEX_GPT_5_4_BASE_INSTRUCTIONS
} from '../utils/responses_compact_codex_instructions.js';
import { createAdaptiveUpdateThrottler } from '../utils/adaptive_update_throttler.js';
import { extractPlainTextFromContent } from '../utils/conversation_title.js';
import { deleteMessageFromChatHistory } from './chat_history_manager.js';
import {
  resolveResponseHandlingMode,
  resolveReceivedResponseHandlingMode,
  planStreamingRenderTransition
} from './response_flow_state.js';
import {
  splitPendingSteersByTurnIds,
  buildRestoredQueueJobsFromPendingSteers,
  resolvePendingSteerRestoreDisposition
} from './conversation_pending_steer.js';
import {
  buildAttemptSteerTargetIdentity,
  buildPendingSteerMatchOptionsForAttempt
} from '../utils/conversation_steer_identity.js';
import { attemptBelongsToConversationQueue } from '../utils/conversation_attempt_membership.js';
import { selectLatestRunningAttemptForCurrentConversation } from '../utils/conversation_active_attempt_selector.js';
import { serializeSelectionTextWithMath } from '../utils/math_selection_text.js';
import { normalizeApiUsageMeta, normalizeApiTimingMeta } from '../utils/api_footer_template.js';
import {
  normalizeResponsesPromptCacheKey,
  buildDefaultResponsesPromptCacheKey,
  resolveDefaultResponsesPromptCacheRetention
} from '../utils/responses_prompt_cache.js';
import {
  canReplaceRetryOrRegenerateInPlace,
  shouldReuseTransientRegeneratePlaceholder
} from '../utils/regenerate_retry_target.js';
import {
  buildResponsesJsRuntimeToolOutputContentItems,
  buildResponsesPageContentToolOutputContentItems,
  buildResponsesPdfContentToolOutputContentItems,
  buildResponsesHistorySearchToolOutputContentItems,
  buildResponsesHistoryReadToolOutputContentItems,
  buildResponsesAskableModelsToolOutputContentItems,
  buildResponsesAskOtherAiToolOutputContentItems,
  buildResponsesRequestUserInputToolOutputContentItems,
  buildResponsesGenericXmlToolOutputContentItems
} from '../agent_tools/responses_tool_output.js';
import {
  ensureResponsesReplayOutputItemsIncludeFunctionCalls
} from '../utils/responses_follow_up.js';
import {
  PDF_CONTENT_READ_TOOL_NAME,
  buildPdfContentReadFunctionToolDefinition
} from '../agent_tools/pdf_content_read_tool.js';
import {
  WEBPAGE_SCREENSHOT_TOOL_NAME,
  buildWebpageScreenshotFunctionToolDefinition
} from '../agent_tools/webpage_screenshot_tool.js';
import {
  buildConversationReferenceSnapshot,
  executeHistoryReadTool,
  executeHistorySearchTool
} from '../agent_tools/chat_history_tool.js';
import {
  ASK_OTHER_AI_TOOL_NAME,
  LIST_ASKABLE_MODELS_TOOL_NAME,
  buildAskOtherAiCatalog,
  buildAskOtherAiFunctionToolDefinition,
  buildAskOtherAiUserMessage,
  buildListAskableModelsFunctionToolDefinition,
  normalizeAskOtherAiArguments
} from '../agent_tools/ask_other_ai_tool.js';
import {
  REQUEST_USER_INPUT_TOOL_NAME,
  buildRequestUserInputFunctionToolDefinition,
  buildRequestUserInputResult,
  normalizeRequestUserInputArguments
} from '../agent_tools/request_user_input_tool.js';
import {
  MICRO_SKILL_READ_MAX_CHARS,
  MICRO_SKILL_REGISTRY_TOOL_NAME,
  buildMicroSkillRegistryFunctionToolDefinition
} from '../agent_tools/micro_skill_registry_tool.js';
import {
  JS_RUNTIME_ENV_BOUND_HOST_PAGE,
  JS_RUNTIME_ENV_ISOLATED_SANDBOX,
  resolvePageToolEnvironment
} from '../agent_tools/page_tool_environment.js';
import {
  createAssistantPreResponseStatus,
  deriveAssistantPreResponseStatusFromLocalStage,
  deriveAssistantPreResponseStatusFromRequestEvent,
  deriveAssistantPreResponseStatusFromResponsesSse,
  normalizeAssistantPreResponseStatus
} from '../utils/assistant_pre_response_status.js';
import {
  buildPageRuntimeContextPayload,
  resolvePageRuntimeContextAttachment
} from '../utils/page_runtime_context.js';
import {
  buildMicroSkillContextPayload,
  resolveMicroSkillContextAttachment
} from '../utils/micro_skill_context.js';
import {
  buildEnvironmentContextPayload,
  resolveEnvironmentContextAttachment
} from '../utils/environment_context.js';
import {
  getResponsesActivityTimelineEntryKey,
  getResponsesToolCallRecordKey
} from '../utils/responses_activity_keys.js';
import {
  getAllConversationMetadata,
  getConversationById,
  getConversationsByIds
} from '../storage/indexeddb_helper.js';

const RESPONSES_JS_RUNTIME_TOOL_NAME = 'js_runtime_execute';
const RESPONSES_PAGE_CONTENT_TOOL_NAME = 'page_content_read';
const RESPONSES_PDF_CONTENT_TOOL_NAME = PDF_CONTENT_READ_TOOL_NAME;
const RESPONSES_WEBPAGE_SCREENSHOT_TOOL_NAME = WEBPAGE_SCREENSHOT_TOOL_NAME;
const RESPONSES_HISTORY_SEARCH_TOOL_NAME = 'history_search';
const RESPONSES_HISTORY_READ_TOOL_NAME = 'history_read';
const RESPONSES_REQUEST_USER_INPUT_TOOL_NAME = REQUEST_USER_INPUT_TOOL_NAME;
const RESPONSES_LIST_ASKABLE_MODELS_TOOL_NAME = LIST_ASKABLE_MODELS_TOOL_NAME;
const RESPONSES_ASK_OTHER_AI_TOOL_NAME = ASK_OTHER_AI_TOOL_NAME;
const RESPONSES_MICRO_SKILL_REGISTRY_TOOL_NAME = MICRO_SKILL_REGISTRY_TOOL_NAME;
const RESPONSES_LEGACY_JS_RUNTIME_SCRIPT_REGISTRY_TOOL_NAME = 'js_runtime_script_registry';
const RESPONSES_LOCAL_COMPACTION_MARKER_TEXT = '已压缩上下文（基于上一轮上下文大小）';
const RESPONSES_LOCAL_COMPACTION_PENDING_TEXT = '上下文压缩中';
const RESPONSES_LOCAL_COMPACTION_ERROR_TEXT = '上下文压缩失败';
const RESPONSES_LOCAL_COMPACTION_TOTAL_ATTEMPTS = 5;
const RESPONSES_LOCAL_COMPACTION_RETRY_DELAY_MS = 450;

/**
 * 创建消息发送器
 * @param {Function} options.getPrompts - 获取提示词设置的函数
 * @param {Object} options.uiManager - UI管理器实例
 * @returns {Object} 消息发送器实例
 */
export function createMessageSender(appContext) {
  // 从选项中提取所需依赖
  const {
    dom,
    services,
    utils,
    state
  } = appContext;

  const apiManager = services.apiManager;
  const messageProcessor = services.messageProcessor;
  const conversationRuntimeStore = services.conversationRuntimeStore;
  const imageHandler = services.imageHandler;
  const chatHistoryUI = services.chatHistoryUI;
  const chatHistoryManager = services.chatHistoryManager;
  const inputController = services.inputController;
  const getCurrentConversationChain = chatHistoryManager.getCurrentConversationChain;
  const chatContainer = dom.chatContainer;
  const threadContainer = dom.threadContainer;
  const inputContainer = dom.inputContainer;
  const messageInput = dom.messageInput; // 保持兼容：占位符/样式仍可直接操作
  const imageContainer = dom.imageContainer; // 将逐步迁移到 inputController
  const scrollToBottom = utils.scrollToBottom;
  const settingsManager = services.settingsManager;
  const promptSettingsManager = services.promptSettingsManager;
  const showNotification = utils.showNotification;
  const responsesLocalCompactionRuns = new Map();

  /**
   * 将 API 返回的 inlineData 图片保存到本地下载目录，并返回可用于 <img src> 的本地文件链接。
   * 
   * 设计目标：
   * - 只在 sidebar 扩展页环境下调用，依赖 chrome.downloads 权限；
   * - 下载失败时回退为 null，由调用方决定是否继续使用 base64 dataURL；
   * - 返回的链接统一为 file:// 协议，便于后续预览与历史记录中复用。
   *
   * 注意：
   * - 这里不会在 IndexedDB 中保存 base64 字符串，只在内存中临时构造 dataURL 交给下载接口。
   *
   * @param {string} mimeType - 图片 MIME 类型，例如 "image/png"
   * @param {string} base64Data - 图片的 Base64 字符串，不包含 data: 前缀
   * @returns {Promise<string|null>} - 成功时返回 file:// 开头的本地文件 URL，失败时返回 null
   */
  async function saveInlineImageToLocalFile(mimeType, base64Data) {
    try {
      if (!mimeType || !base64Data || !chrome?.downloads?.download) {
        // 在无法访问下载 API 时直接放弃本地文件方案，交由上层使用 dataURL 回退
        return null;
      }

      const safeMime = String(mimeType || '').toLowerCase();
      let ext = 'png';
      if (safeMime === 'image/jpeg' || safeMime === 'image/jpg') ext = 'jpg';
      else if (safeMime === 'image/webp') ext = 'webp';
      else if (safeMime === 'image/gif') ext = 'gif';
      else if (safeMime === 'image/png') ext = 'png';
      else if (safeMime.startsWith('image/')) {
        ext = safeMime.split('/')[1] || 'png';
      }

      // 统一存放到下载目录下的 Cerebr/Images 子目录，便于用户管理
      const now = new Date();
      const pad2 = (n) => String(n).padStart(2, '0');
      const timestamp = [
        now.getFullYear(),
        pad2(now.getMonth() + 1),
        pad2(now.getDate()),
        pad2(now.getHours()),
        pad2(now.getMinutes()),
        pad2(now.getSeconds())
      ].join('');
      const random = Math.random().toString(36).slice(2, 8);
      const baseName = `cerebr_${timestamp}_${random}`;
      const filename = `Cerebr/Images/${baseName}.${ext}`;

      const dataUrl = `data:${safeMime};base64,${base64Data}`;

      // 第一步：触发浏览器下载
      const downloadId = await new Promise((resolve, reject) => {
        try {
          chrome.downloads.download(
            {
              url: dataUrl,
              filename,
              conflictAction: 'uniquify',
              saveAs: false
            },
            (id) => {
              const lastError = chrome.runtime?.lastError;
              if (lastError || typeof id !== 'number') {
                console.error('保存内联图片到本地失败(download):', lastError);
                reject(new Error(lastError?.message || 'downloads.download 失败'));
              } else {
                resolve(id);
              }
            }
          );
        } catch (e) {
          console.error('调用 chrome.downloads.download 异常:', e);
          reject(e);
        }
      });

      // 第二步：轮询等待下载完成，拿到实际文件路径
      const filePath = await new Promise((resolve, reject) => {
        const timeoutMs = 30000;
        const start = Date.now();

        function check() {
          try {
            chrome.downloads.search({ id: downloadId }, (items) => {
              const lastError = chrome.runtime?.lastError;
              if (lastError) {
                reject(new Error(lastError.message));
                return;
              }
              const item = items && items[0];
              if (!item) {
                reject(new Error('找不到下载任务'));
                return;
              }
              if (item.state === 'complete' && item.filename) {
                resolve(item.filename);
                return;
              }
              if (item.state === 'interrupted') {
                reject(new Error(item.error || '下载被中断'));
                return;
              }
              if (Date.now() - start > timeoutMs) {
                reject(new Error('等待图片下载完成超时'));
                return;
              }
              setTimeout(check, 500);
            });
          } catch (e) {
            reject(e);
          }
        }

        check();
      });

      if (!filePath || typeof filePath !== 'string') {
        return null;
      }

      // 将本地绝对路径转换为标准的 file:// URL
      let normalizedPath = filePath.replace(/\\/g, '/');
      if (/^[A-Za-z]:\//.test(normalizedPath)) {
        // Windows 路径: C:/Users/... 需要前置一个斜杠 -> /C:/Users/...
        normalizedPath = '/' + normalizedPath;
      }
      const fileUrl = `file://${normalizedPath}`;
      return fileUrl;
    } catch (error) {
      console.error('保存内联图片到本地失败:', error);
      return null;
    }
  }

  // 私有状态
  let isProcessingMessage = false;
  let shouldAutoScroll = true;
  /**
   * 当前所有进行中的请求尝试集合（支持并发请求）
   * key 为内部 attemptId，value 为尝试状态对象：
   * { id, controller, manualAbort, finished, loadingMessage, aiMessageId }
   *
   * 设计说明：
   * - 之前只维护单一 activeAttempt，无法区分不同请求生命周期；
   * - 现在将每一次请求视为独立 attempt，便于实现“按消息粒度的停止生成 / 自动重试”。
   */
  const activeAttempts = new Map();
  // 对外暴露“哪些会话正在流式生成”，供 ESC 聊天记录面板做实时标记。
  const streamingConversationListeners = new Set();
  const backgroundCompletedConversationIds = new Set();
  let lastStreamingConversationStateKey = '';
  let isTemporaryMode = false;
  let pageContent = null;
  let shouldSendChatHistory = true;
  let autoRetryEnabled = false;
  // 同一会话内若已有流式/自动重试任务，后续发送默认进入该会话的 FIFO 队列。
  // 设计目标：
  // - 仅约束“当前会话”的串行发送，不影响其它会话后台继续生成；
  // - 队列按会话隔离，避免不同会话的消息互相串线；
  // - 关闭该开关后，恢复为“中断当前会话生成并立即发送下一条”。
  let queueCurrentConversationMessages = true;
  const conversationSendQueues = new Map();
  const conversationQueueDrainLocks = new Set();
  const conversationQueueWakeTimers = new Map();
  const pendingConversationMutations = new Map();
  let draftConversationQueueSerial = 0;
  let activeDraftConversationQueueKey = `__draft_queue_${draftConversationQueueSerial}`;
  let queuedConversationTaskSerial = 0;
  let pendingConversationSteerSerial = 0;
  let activeQueuePreviewDragState = null;
  // 固定 API 失效提示的去重窗口，避免连续发送刷屏
  let lastInvalidApiLockNotice = { conversationId: '', at: 0 };
  // 流式标记：若当前数据流进入 <think> 段落，则持续写入思考块直到遇到 </think>
  let isInStreamingThoughtBlock = false;
  // 自动重试配置：指数退避，最多 5 次
  const MAX_AUTO_RETRY_ATTEMPTS = 5;
  const AUTO_RETRY_BASE_DELAY_MS = 500;
  const AUTO_RETRY_MAX_DELAY_MS = 8000;
  // 流式写库节流：避免每个 token 都触发一次 IndexedDB 写入。
  const STREAM_DRAFT_SAVE_INTERVAL_MS = 1200;
  const CONVERSATION_JOB_KINDS = new Set(['append_user_message', 'regenerate_assistant_turn']);
  const CONVERSATION_JOB_STATUSES = new Set([
    'queued',
    'running',
    'delayed_retry',
    'paused',
    'stale',
    'failed',
    'completed',
    'canceled'
  ]);

  // 临时模式状态不再写入 sessionStorage，改由父页面在内存里同步，避免 F5 刷新仍保留旧状态。

  function collectStreamingConversationIds() {
    if (!activeAttempts.size && !conversationSendQueues.size) return [];
    const ids = new Set();
    for (const attempt of activeAttempts.values()) {
      if (!attempt || attempt.finished) continue;
      const boundId = normalizeConversationId(attempt.boundConversationId);
      if (!boundId) continue;
      ids.add(boundId);
    }
    for (const [queueKey, queueJobs] of conversationSendQueues.entries()) {
      const jobs = Array.isArray(queueJobs) ? queueJobs : [];
      const hasDelayedRetry = jobs.some((job) => normalizeConversationQueuedTask(job).status === 'delayed_retry');
      if (!hasDelayedRetry) continue;
      const boundId = normalizeConversationId(queueKey);
      if (!boundId || boundId.startsWith('__draft_queue_')) continue;
      ids.add(boundId);
    }
    return Array.from(ids).sort();
  }

  function collectBackgroundCompletedConversationIds() {
    if (!backgroundCompletedConversationIds.size) return [];
    return Array.from(backgroundCompletedConversationIds).sort();
  }

  function getStreamingConversationIds() {
    return collectStreamingConversationIds();
  }

  function getBackgroundCompletedConversationIds() {
    return collectBackgroundCompletedConversationIds();
  }

  function clearBackgroundCompletedConversationMarker(conversationId) {
    const normalizedId = normalizeConversationId(conversationId);
    if (!normalizedId) return false;
    const removed = backgroundCompletedConversationIds.delete(normalizedId);
    if (removed) {
      notifyStreamingConversationStateChanged();
    }
    return removed;
  }

  function notifyStreamingConversationStateChanged() {
    const streamingIds = collectStreamingConversationIds();
    const completedIds = collectBackgroundCompletedConversationIds();
    const nextKey = `s:${streamingIds.join('|')}#c:${completedIds.join('|')}`;
    if (nextKey === lastStreamingConversationStateKey) return;
    lastStreamingConversationStateKey = nextKey;
    if (!streamingConversationListeners.size) return;
    for (const listener of streamingConversationListeners) {
      try {
        listener(streamingIds, completedIds);
      } catch (error) {
        console.warn('streamingConversation listener 执行失败:', error);
      }
    }
  }

  function subscribeStreamingConversationState(listener) {
    if (typeof listener !== 'function') return () => {};
    streamingConversationListeners.add(listener);
    try {
      listener(collectStreamingConversationIds(), collectBackgroundCompletedConversationIds());
    } catch (error) {
      console.warn('streamingConversation listener 初始化失败:', error);
    }
    return () => {
      streamingConversationListeners.delete(listener);
    };
  }

  function getRuntimeConversationKey(conversationId) {
    return resolveConversationQueueKey(conversationId);
  }

  function getAttemptRuntimeConversationKey(attemptState, fallbackConversationId = '') {
    const explicitRuntimeKey = (typeof attemptState?.runtimeConversationKey === 'string' && attemptState.runtimeConversationKey.trim())
      ? attemptState.runtimeConversationKey.trim()
      : '';
    if (explicitRuntimeKey) return explicitRuntimeKey;

    const boundConversationId = normalizeConversationId(attemptState?.boundConversationId);
    if (boundConversationId) return getRuntimeConversationKey(boundConversationId);

    const normalizedFallbackConversationId = normalizeConversationId(fallbackConversationId);
    if (normalizedFallbackConversationId) return getRuntimeConversationKey(normalizedFallbackConversationId);

    const activeConversationId = normalizeConversationId(currentConversationId)
      || normalizeConversationId(chatHistoryUI?.getCurrentConversationId?.());
    if (activeConversationId) return getRuntimeConversationKey(activeConversationId);

    return getActiveDraftConversationQueueKey();
  }

  function getAttemptRuntimeSnapshot(attemptState, fallbackConversationId = '') {
    if (!conversationRuntimeStore?.getConversationRuntimeState) return null;
    const runtimeConversationKey = getAttemptRuntimeConversationKey(attemptState, fallbackConversationId);
    if (!runtimeConversationKey) return null;
    return conversationRuntimeStore.getConversationRuntimeState(runtimeConversationKey);
  }

  function updateConversationRuntimeStateByKey(runtimeConversationKey, recipe) {
    const normalizedRuntimeKey = (typeof runtimeConversationKey === 'string' && runtimeConversationKey.trim())
      ? runtimeConversationKey.trim()
      : '';
    if (!normalizedRuntimeKey || !conversationRuntimeStore?.updateConversationRuntimeState) return null;
    return conversationRuntimeStore.updateConversationRuntimeState(normalizedRuntimeKey, recipe);
  }

  function updateAttemptRuntimeState(attemptState, recipe, options = {}) {
    if (!attemptState || !conversationRuntimeStore?.updateConversationRuntimeState) return null;
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const runtimeConversationKey = getAttemptRuntimeConversationKey(
      attemptState,
      normalizedOptions.conversationId || ''
    );
    if (!runtimeConversationKey) return null;
    attemptState.runtimeConversationKey = runtimeConversationKey;
    return updateConversationRuntimeStateByKey(runtimeConversationKey, recipe);
  }

  function hasMeaningfulRuntimeSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    if (String(snapshot?.activeTurn?.status || '').trim().toLowerCase() !== 'idle') return true;
    if (snapshot?.activeTurn?.attemptId || snapshot?.activeTurn?.jobId || snapshot?.activeTurn?.boundAssistantMessageId) return true;
    if (snapshot?.activeTurn?.preResponseStatus && typeof snapshot.activeTurn.preResponseStatus === 'object') return true;
    if (Array.isArray(snapshot?.responses?.accumulatedInputItems) && snapshot.responses.accumulatedInputItems.length > 0) return true;
    if (Array.isArray(snapshot?.responses?.accumulatedTimeline) && snapshot.responses.accumulatedTimeline.length > 0) return true;
    if (snapshot?.responses?.assistantPhase || snapshot?.responses?.lastResponseId) return true;
    if (Array.isArray(snapshot?.queue?.jobs) && snapshot.queue.jobs.length > 0) return true;
    if (snapshot?.queue?.isFlushing || snapshot?.queue?.pausedHeadId || snapshot?.queue?.pendingMutation) return true;
    if (Array.isArray(snapshot?.steer?.pendingSteers) && snapshot.steer.pendingSteers.length > 0) return true;
    if (snapshot?.steer?.targetTurnId || snapshot?.steer?.targetTurnStartedAtMs) return true;
    return false;
  }

  function migrateConversationRuntimeState(fromConversationId, toConversationId) {
    if (!conversationRuntimeStore?.getConversationRuntimeState || !conversationRuntimeStore?.clearConversationRuntimeState) {
      return false;
    }
    const fromRuntimeKey = getRuntimeConversationKey(fromConversationId);
    const toRuntimeKey = getRuntimeConversationKey(toConversationId);
    if (!fromRuntimeKey || !toRuntimeKey || fromRuntimeKey === toRuntimeKey) return false;

    const snapshot = conversationRuntimeStore.getConversationRuntimeState(fromRuntimeKey);
    if (!hasMeaningfulRuntimeSnapshot(snapshot)) {
      return false;
    }

    updateConversationRuntimeStateByKey(toRuntimeKey, (draft) => {
      draft.activeTurn = cloneDataSafely(snapshot.activeTurn) || draft.activeTurn;
      draft.responses = cloneDataSafely(snapshot.responses) || draft.responses;
      draft.steer = cloneDataSafely(snapshot.steer) || draft.steer;
    });
    conversationRuntimeStore.clearConversationRuntimeState(fromRuntimeKey);
    return true;
  }

  function syncConversationQueueRuntime(queueKey) {
    const runtimeConversationKey = getRuntimeConversationKey(queueKey);
    if (!runtimeConversationKey) return null;
    const queueItems = getConversationSendQueue(runtimeConversationKey)
      .filter((job) => !isConversationJobTerminal(job))
      .map(job => cloneDataSafely(job));
    const pausedHeadId = (queueItems[0] && (isConversationJobUserPaused(queueItems[0]) || isConversationJobBlockedByConfirmation(queueItems[0])))
      ? queueItems[0].id
      : null;
    return updateConversationRuntimeStateByKey(runtimeConversationKey, (draft) => {
      draft.queue.jobs = queueItems;
      draft.queue.isFlushing = conversationQueueDrainLocks.has(runtimeConversationKey);
      draft.queue.pausedHeadId = pausedHeadId;
      draft.queue.pendingMutation = summarizePendingConversationMutation(runtimeConversationKey);
    });
  }

  function syncAttemptResponsesRuntimeState(attemptState, meta = {}) {
    if (!attemptState) return null;
    const normalizedMeta = (meta && typeof meta === 'object') ? meta : {};
    const nextTimeline = Array.isArray(normalizedMeta.timeline)
      ? cloneResponsesActivityTimeline(normalizedMeta.timeline)
      : (Array.isArray(attemptState.responsesToolLoopAccumulatedTimeline)
        ? cloneResponsesActivityTimeline(attemptState.responsesToolLoopAccumulatedTimeline)
        : []);
    const nextInputItems = Array.isArray(normalizedMeta.inputItems)
      ? cloneResponsesReplayOutputItems(normalizedMeta.inputItems)
      : (Array.isArray(attemptState.responsesToolLoopAccumulatedInputItems)
        ? cloneResponsesReplayOutputItems(attemptState.responsesToolLoopAccumulatedInputItems)
        : []);
    const nextAssistantPhase = Object.prototype.hasOwnProperty.call(normalizedMeta, 'assistantPhase')
      ? (normalizedMeta.assistantPhase || null)
      : (attemptState.responsesToolLoopAssistantPhase || null);
    const nextResponseId = Object.prototype.hasOwnProperty.call(normalizedMeta, 'responseId')
      ? (normalizedMeta.responseId || null)
      : (attemptState.responsesToolLoopLastResponseId || null);

    attemptState.responsesToolLoopAccumulatedTimeline = nextTimeline.length > 0 ? nextTimeline : null;
    attemptState.responsesToolLoopAccumulatedInputItems = nextInputItems.length > 0 ? nextInputItems : null;
    attemptState.responsesToolLoopAssistantPhase = nextAssistantPhase;
    attemptState.responsesToolLoopLastResponseId = nextResponseId;

    return updateAttemptRuntimeState(attemptState, (draft) => {
      draft.responses.accumulatedTimeline = nextTimeline;
      draft.responses.accumulatedInputItems = nextInputItems;
      draft.responses.assistantPhase = nextAssistantPhase;
      draft.responses.lastResponseId = nextResponseId;
    });
  }

  function syncAttemptAssistantView(messageId, options = {}) {
    if (!messageId || typeof messageProcessor?.syncAssistantMessageView !== 'function') return false;
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const attemptState = normalizedOptions.attemptState || null;
    const node = (normalizedOptions.node && typeof normalizedOptions.node === 'object')
      ? normalizedOptions.node
      : resolveAttemptAiNode(attemptState, messageId);
    const runtimeSnapshot = normalizedOptions.runtimeSnapshot
      || getAttemptRuntimeSnapshot(attemptState, normalizedOptions.conversationId || '');
    const viewOptions = {
      node: node || null,
      runtimeSnapshot,
      fallbackElement: normalizedOptions.fallbackElement || null,
      suppressMissingNodeWarning: normalizedOptions.suppressMissingNodeWarning === true
    };
    if (Object.prototype.hasOwnProperty.call(normalizedOptions, 'content')) {
      viewOptions.content = normalizedOptions.content;
    }
    if (Object.prototype.hasOwnProperty.call(normalizedOptions, 'thoughtsRaw')) {
      viewOptions.thoughtsRaw = normalizedOptions.thoughtsRaw;
    }
    return !!messageProcessor.syncAssistantMessageView(messageId, viewOptions);
  }

  function updateAttemptBoundConversationId(attemptState, nextConversationId) {
    if (!attemptState) return;
    const normalizedNext = normalizeConversationId(nextConversationId);
    const normalizedCurrent = normalizeConversationId(attemptState.boundConversationId);
    if (normalizedCurrent === normalizedNext) return;
    const previousRuntimeConversationKey = getAttemptRuntimeConversationKey(attemptState, normalizedCurrent || '');
    if (normalizedNext) {
      backgroundCompletedConversationIds.delete(normalizedNext);
    }
    attemptState.boundConversationId = normalizedNext;
    const nextRuntimeConversationKey = getAttemptRuntimeConversationKey(attemptState, normalizedNext || '');
    if (
      previousRuntimeConversationKey
      && nextRuntimeConversationKey
      && previousRuntimeConversationKey !== nextRuntimeConversationKey
    ) {
      migrateConversationRuntimeState(previousRuntimeConversationKey, nextRuntimeConversationKey);
    }
    attemptState.runtimeConversationKey = nextRuntimeConversationKey || previousRuntimeConversationKey || null;
    notifyStreamingConversationStateChanged();
  }

  function getAutoRetryDelayMs(attemptIndex = 0) {
    const normalizedAttempt = Math.max(0, attemptIndex);
    const rawDelay = AUTO_RETRY_BASE_DELAY_MS * Math.pow(2, normalizedAttempt);
    return Math.min(AUTO_RETRY_MAX_DELAY_MS, Math.round(rawDelay));
  }

  /**
   * 将“自动重试”设置值规范化为布尔值。
   *
   * 兼容场景：
   * - 正常 UI 勾选写入的 boolean；
   * - 旧版本/外部导入可能写入的字符串（"true"/"1"/"on"）或数字（1/0）。
   *
   * 返回 null 表示“无法识别”，调用方应保持当前内存态不变，避免误覆盖。
   *
   * @param {any} value
   * @returns {boolean|null}
   */
  function normalizeAutoRetrySetting(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return null;
      return value !== 0;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (!normalized) return null;
      if (['true', '1', 'on', 'yes', 'y'].includes(normalized)) return true;
      if (['false', '0', 'off', 'no', 'n'].includes(normalized)) return false;
    }
    return null;
  }

  /**
   * 纯函数：从“模板替换后的完整提示词”中提取 <SELECTION> 对应的原文。
   *
   * 设计背景：
   * - 对话标题/摘要需要展示“划词内容”，但过去的实现依赖模板前缀/正则去猜测，用户一旦把模板写成以
   *   `<SELECTION>` 开头（前缀为空）就会出现误判（例如对所有对话都打上同一个标签）。
   * - 这里不再依赖“前缀必须非空”的假设，而是严格基于模板的 prefix/suffix 定位被替换的那一段。
   *
   * 约束与兜底：
   * - 只负责字符串定位与裁剪，不做任何业务判断；
   * - 如果模板不包含 `<SELECTION>` 或定位失败，返回空字符串，由上层决定如何回退。
   *
   * @param {string} renderedPrompt - 实际发送给模型的完整用户消息（已将 <SELECTION> 替换为选中文本）
   * @param {string} templatePrompt - 提示词模板（包含 <SELECTION> 占位符）
   * @returns {string} 提取到的选中文本（可能为空字符串）
   */
  function extractSelectionTextFromRenderedPrompt(renderedPrompt, templatePrompt) {
    if (typeof renderedPrompt !== 'string' || typeof templatePrompt !== 'string') return '';
    const placeholder = '<SELECTION>';
    const parts = templatePrompt.split(placeholder);
    if (parts.length < 2) return '';

    const prefix = parts[0] || '';
    const suffix = parts[1] || '';

    let startIndex = 0;
    if (prefix) {
      const prefixIndex = renderedPrompt.indexOf(prefix);
      if (prefixIndex === -1) return '';
      startIndex = prefixIndex + prefix.length;
    }

    let endIndex = renderedPrompt.length;
    if (suffix) {
      const suffixIndex = renderedPrompt.lastIndexOf(suffix);
      if (suffixIndex !== -1 && suffixIndex >= startIndex) {
        endIndex = suffixIndex;
      }
    }

    return renderedPrompt.slice(startIndex, endIndex).trim();
  }

  /**
   * 纯函数：构造要写入“用户消息节点”的 promptMeta。
   *
   * 设计目标：
   * - promptType 是“当时的指令类型”的权威来源；promptMeta 只保存“标题/摘要”等需要的最小信息；
   * - selection/query 优先使用调用方显式传入的 selectionText；缺失时再基于模板做一次确定性的提取；
   * - 不在这里做任何“正则猜测”，避免逻辑分散且在用户自定义提示词时失效。
   *
   * @param {Object} args
   * @param {string} args.promptType
   * @param {Object|null} args.promptMeta
   * @param {string} args.messageText
   * @param {Object} args.promptsConfig
   * @returns {Object|null}
   */
  function buildPromptMetaForHistory({ promptType, promptMeta, messageText, promptsConfig }) {
    const safeType = typeof promptType === 'string' ? promptType : 'none';
    const safeMeta = (promptMeta && typeof promptMeta === 'object') ? promptMeta : null;
    const result = safeMeta ? { ...safeMeta } : {};

    if (safeType === 'selection' || safeType === 'query') {
      let selectionText = typeof safeMeta?.selectionText === 'string' ? safeMeta.selectionText.trim() : '';
      if (!selectionText) {
        const template = safeType === 'selection'
          ? (promptsConfig?.selection?.prompt || '')
          : (promptsConfig?.query?.prompt || '');
        selectionText = extractSelectionTextFromRenderedPrompt(messageText || '', template);
      }
      if (selectionText) {
        result.selectionText = selectionText;
      }
    }

    return Object.keys(result).length > 0 ? result : null;
  }

  /**
   * 解析预处理模板的输入基准文本，避免“已渲染文本”再次被套模板。
   * @param {Object} args
   * @param {string} args.messageText
   * @param {boolean} args.regenerateMode
   * @param {string|null} args.messageId
   * @returns {string}
   */
  function resolvePreprocessBaseText({ messageText, regenerateMode, messageId }) {
    if (!regenerateMode || !messageId) return messageText;
    const node = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === messageId);
    if (!node) return messageText;

    const originalText = (typeof node.preprocessOriginalText === 'string') ? node.preprocessOriginalText : '';
    const renderedText = (typeof node.preprocessRenderedText === 'string') ? node.preprocessRenderedText : '';
    if (originalText && renderedText && renderedText === messageText) {
      return originalText;
    }
    return messageText;
  }

  /**
   * 将预处理后的文本应用到“最后一条 user 消息”，用于只影响发送不改历史。
   * @param {Array} messages
   * @param {string} renderedText
   * @returns {Array}
   */
  function applyPreprocessedTextToMessages(messages, renderedText) {
    if (!Array.isArray(messages) || typeof renderedText !== 'string') return messages;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (!msg || msg.role !== 'user') continue;
      const next = { ...msg, content: applyRenderedTextToMessageContent(msg.content, renderedText) };
      const cloned = messages.slice();
      cloned[i] = next;
      return cloned;
    }
    return messages;
  }

  /**
   * 清理用户文本中的系统注入块，避免将 {{system}}...{{end_system}} 记录到历史。
   * @param {string} text
   * @returns {string}
   */
  function stripInjectedSystemBlocks(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/{{system}}[\s\S]*?{{end_system}}/g, '');
  }

  function normalizeInjectedRole(role) {
    const normalized = String(role || '').trim().toLowerCase();
    if (normalized === 'assistant' || normalized === 'ai' || normalized === 'model') return 'assistant';
    if (normalized === 'user' || normalized === 'system') return normalized;
    return null;
  }

  /**
   * 规范化模板注入消息（仅用于请求载荷，不写入历史）。
   * @param {Array<{role: string, content: string}>} injectedMessages
   * @returns {Array<{role: 'user'|'assistant'|'system', content: string}>}
   */
  function normalizeInjectedMessages(injectedMessages) {
    if (!Array.isArray(injectedMessages)) return [];
    const results = [];
    for (const item of injectedMessages) {
      if (!item) continue;
      const role = normalizeInjectedRole(item.role);
      if (!role) continue;
      let content = (typeof item.content === 'string') ? item.content : '';
      if (!content.trim()) continue;
      if (role === 'user') {
        const { baseText } = extractTrailingControlMarkers(content);
        content = baseText;
      }
      results.push({ role, content });
    }
    return results;
  }

  function extractImagePartsFromMessageContent(content) {
    if (!Array.isArray(content)) return [];
    return content
      .filter(part => part && part.type === 'image_url' && part.image_url)
      .map((part) => {
        const imageUrl = (part.image_url && typeof part.image_url === 'object')
          ? { ...part.image_url }
          : part.image_url;
        return { type: 'image_url', image_url: imageUrl };
      });
  }

  /**
   * 将注入消息插入到“最后一条 user 消息”之后，或在需要时替换最后一条 user。
   * @param {Array} messages
   * @param {Array<{role: string, content: string}>} injectedMessages
   * @param {{ replaceLastUser?: boolean }} [options]
   * @returns {Array}
   */
  function applyInjectedMessages(messages, injectedMessages, options = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    const normalized = normalizeInjectedMessages(injectedMessages);
    if (normalized.length === 0) return messages;
    const replaceLastUser = options?.replaceLastUser === true;
    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === 'user') {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex === -1) {
      return messages.concat(normalized);
    }
    if (replaceLastUser) {
      const lastUserMessage = messages[lastUserIndex];
      const preservedImageParts = extractImagePartsFromMessageContent(lastUserMessage?.content);
      const preservedImageMessage = preservedImageParts.length > 0
        ? { role: 'user', content: preservedImageParts }
        : null;
      return [
        ...messages.slice(0, lastUserIndex),
        ...(preservedImageMessage ? [preservedImageMessage] : []),
        ...normalized,
        ...messages.slice(lastUserIndex + 1)
      ];
    }

    // 当模板只注入 system/assistant、但不替换原始 user 时：
    // - system 应该放到当前 user 之前，作为补充指令；
    // - assistant / 其他注入消息放到当前 user 之后，作为附加上下文；
    // 这样既不会吞掉真实请求上下文，也能保持“system 优先、user 仍是当前问题”的整体语义。
    const leadingSystemMessages = normalized.filter((item) => item?.role === 'system');
    const trailingMessages = normalized.filter((item) => item?.role !== 'system');
    return [
      ...messages.slice(0, lastUserIndex),
      ...leadingSystemMessages,
      messages[lastUserIndex],
      ...trailingMessages,
      ...messages.slice(lastUserIndex + 1)
    ];
  }

  // 对话标题生成：避免重复触发同一会话的标题请求
  const conversationTitleRequests = new Set();

  function normalizeConversationTitleText(rawText) {
    const input = (typeof rawText === 'string') ? rawText.trim() : '';
    if (!input) return '';
    let text = input;

    // 兼容模型返回 JSON：优先读取 title 字段
    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed.title === 'string') {
          text = parsed.title;
        }
      } catch (_) {}
    }

    const firstLine = text.split(/\r?\n/).find(line => line.trim()) || '';
    let cleaned = firstLine.trim();
    cleaned = cleaned.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
    cleaned = cleaned.replace(/^(标题|Title)[:：]\s*/i, '');
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    const maxLength = 160;
    if (cleaned.length > maxLength) cleaned = cleaned.slice(0, maxLength);
    return cleaned;
  }

  function normalizeApiConnectionType(value) {
    const normalized = (typeof value === 'string') ? value.trim().toLowerCase() : '';
    if (normalized === 'gemini') return 'gemini';
    if (normalized === 'openai_responses') return 'openai_responses';
    if (normalized === 'openai') return 'openai';
    return '';
  }

  function isGeminiApiConfig(config) {
    const connectionType = normalizeApiConnectionType(config?.connectionType);
    if (connectionType) return connectionType === 'gemini';
    const baseUrl = (typeof config?.baseUrl === 'string') ? config.baseUrl.trim().toLowerCase() : '';
    return baseUrl === 'genai' || baseUrl.includes('generativelanguage.googleapis.com');
  }

  function isGeminiApiResponse(response, config) {
    const explicitType = normalizeApiConnectionType(config?.connectionType);
    if (explicitType === 'gemini') return true;
    if (explicitType === 'openai' || explicitType === 'openai_responses') return false;
    if (isGeminiApiConfig(config)) return true;
    const url = (typeof response?.url === 'string') ? response.url.toLowerCase() : '';
    return url.includes('generativelanguage.googleapis.com') && !url.includes('openai');
  }

  function normalizeApiPathForEndpointDetection(rawUrl) {
    const value = (typeof rawUrl === 'string') ? rawUrl.trim() : '';
    if (!value) return '';
    try {
      return (new URL(value).pathname || '').toLowerCase();
    } catch (_) {
      return value.split('?')[0].split('#')[0].toLowerCase();
    }
  }

  function isResponsesApiPath(pathname) {
    const path = (typeof pathname === 'string') ? pathname.trim().toLowerCase() : '';
    if (!path) return false;
    return /(^|\/)responses(?:\/[^/?#]+)?\/?$/.test(path);
  }

  function isOpenAIResponsesApiConfig(config) {
    const explicitType = normalizeApiConnectionType(config?.connectionType);
    if (explicitType === 'openai_responses') return true;
    if (explicitType === 'gemini') return false;
    if (isGeminiApiConfig(config)) return false;
    return isResponsesApiPath(normalizeApiPathForEndpointDetection(config?.baseUrl));
  }

  function isOpenAIResponsesApiResponse(response, config) {
    if (isOpenAIResponsesApiConfig(config)) return true;
    return isResponsesApiPath(normalizeApiPathForEndpointDetection(response?.url));
  }

  function isOpenAIResponsesPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (String(payload?.object || '').toLowerCase() === 'response') return true;
    if (Array.isArray(payload?.output)) return true;
    if (typeof payload?.output_text === 'string' || Array.isArray(payload?.output_text)) return true;
    return false;
  }

  function readResponsesOutputTextField(payload) {
    const outputText = payload?.output_text;
    if (typeof outputText === 'string') return outputText;
    if (!Array.isArray(outputText)) return '';
    return outputText.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item.text === 'string') return item.text;
      return '';
    }).join('');
  }

  /**
   * 递归裁剪 Responses 元数据里的空值，避免把“空数组/空对象/空字符串”落进历史记录。
   * @param {any} value
   * @returns {any}
   */
  function compactResponsesMetaValue(value) {
    if (value == null) return undefined;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed ? trimmed : undefined;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === 'boolean') {
      return value;
    }
    if (Array.isArray(value)) {
      const compactedItems = value
        .map(item => compactResponsesMetaValue(item))
        .filter(item => typeof item !== 'undefined');
      return compactedItems.length > 0 ? compactedItems : undefined;
    }
    if (typeof value === 'object') {
      const compactedObject = {};
      Object.entries(value).forEach(([key, childValue]) => {
        const compactedChild = compactResponsesMetaValue(childValue);
        if (typeof compactedChild !== 'undefined') {
          compactedObject[key] = compactedChild;
        }
      });
      return Object.keys(compactedObject).length > 0 ? compactedObject : undefined;
    }
    return undefined;
  }

  /**
   * 规范化 Responses 工具返回里的 sources 条目，只保留 UI / 持久化真正会用到的轻量字段。
   * @param {any} source
   * @returns {Object|null}
   */
  function normalizeResponsesToolCallSource(source) {
    if (!source || typeof source !== 'object') return null;
    const normalized = compactResponsesMetaValue({
      type: source.type,
      title: source.title || source.name || '',
      url: source.url || '',
      domain: source.domain || source.hostname || '',
      provider: source.provider || ''
    });
    return (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) ? normalized : null;
  }

  function cloneResponsesActivityTimeline(timeline) {
    if (!Array.isArray(timeline) || timeline.length === 0) return [];
    try {
      return JSON.parse(JSON.stringify(timeline));
    } catch (_) {
      return timeline.map((entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        return {
          ...entry,
          queries: Array.isArray(entry.queries) ? [...entry.queries] : entry.queries,
          sources: Array.isArray(entry.sources)
            ? entry.sources.map((source) => (source && typeof source === 'object' ? { ...source } : source))
            : entry.sources
        };
      });
    }
  }

  function normalizeResponsesMessagePhase(value) {
    return (typeof value === 'string') ? value.trim().toLowerCase() : '';
  }

  function isResponsesCommentaryPhase(value) {
    return normalizeResponsesMessagePhase(value) === 'commentary';
  }

  function normalizeResponsesCommentaryText(rawText) {
    return String(rawText || '')
      .replace(/\r\n?/g, '\n')
      .trim();
  }

  function extractResponsesMessageTextParts(item, options = {}) {
    const {
      excludeReasoning = false
    } = options || {};
    const parts = [];
    const contentParts = Array.isArray(item?.content) ? item.content : [];
    contentParts.forEach((part) => {
      if (!part || typeof part !== 'object') return;
      const partType = String(part.type || '').toLowerCase();
      if (partType === 'refusal') return;
      if (excludeReasoning && partType.includes('reasoning')) return;
      if (typeof part.text === 'string' && part.text) {
        parts.push(part.text);
        return;
      }
      if (typeof part.output_text === 'string' && part.output_text) {
        parts.push(part.output_text);
      }
    });
    return parts;
  }

  function extractResponsesMessageVisibleText(item, options = {}) {
    return extractResponsesMessageTextParts(item, options).join('');
  }

  function createResponsesCommentaryTimelineEntry(text, options = {}) {
    const content = normalizeResponsesCommentaryText(text);
    if (!content) return null;
    return normalizeResponsesActivityTimelineEntry({
      kind: 'commentary',
      id: options.id || 'commentary',
      status: options.status || '',
      phase: options.phase || 'commentary',
      text: content
    });
  }

  function preferResponsesCommentaryTimeline(timeline) {
    const normalizedList = Array.isArray(timeline) ? timeline : [];
    const hasCommentary = normalizedList.some(entry => entry?.kind === 'commentary');
    if (!hasCommentary) return normalizedList;
    return normalizedList.filter(entry => entry?.kind !== 'reasoning_summary');
  }

  function normalizeResponsesActivityTimelineEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const kind = (typeof entry.kind === 'string') ? entry.kind.trim().toLowerCase() : '';
    if (kind === 'commentary') {
      const text = normalizeResponsesCommentaryText((typeof entry.text === 'string') ? entry.text : '');
      if (!text) return null;
      const normalized = {
        kind: 'commentary',
        text
      };
      const id = (typeof entry.id === 'string' && entry.id.trim()) ? entry.id.trim() : '';
      const status = (typeof entry.status === 'string' && entry.status.trim()) ? entry.status.trim() : '';
      const phase = normalizeResponsesMessagePhase(entry.phase || 'commentary') || 'commentary';
      if (id) normalized.id = id;
      if (status) normalized.status = status;
      if (phase) normalized.phase = phase;
      return normalized;
    }
    if (kind === 'reasoning_summary') {
      const status = (typeof entry.status === 'string' && entry.status.trim()) ? entry.status.trim() : '';
      const isStreaming = status.toLowerCase() === 'streaming' || status.toLowerCase() === 'in_progress';
      const rawText = (typeof entry.text === 'string') ? entry.text : '';
      const text = isStreaming
        ? rawText.replace(/\r\n?/g, '\n')
        : normalizeResponsesReasoningText(rawText);
      if (!text) return null;
      const normalized = {
        kind: 'reasoning_summary',
        text
      };
      const id = (typeof entry.id === 'string' && entry.id.trim()) ? entry.id.trim() : '';
      if (id) normalized.id = id;
      if (status) normalized.status = status;
      return normalized;
    }
    if (kind === 'tool_call') {
      const normalized = compactResponsesMetaValue({
        ...entry,
        kind: 'tool_call'
      });
      return (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) ? normalized : null;
    }
    return null;
  }

  function createResponsesReasoningTimelineEntry(text, options = {}) {
    const content = (typeof text === 'string') ? text : '';
    if (!content) return null;
    return normalizeResponsesActivityTimelineEntry({
      kind: 'reasoning_summary',
      id: options.id || 'reasoning_summary',
      status: options.status || '',
      text: content
    });
  }

  /**
   * 把 Responses output item 归一化为适合 IndexedDB/界面展示的“工具调用记录”。
   * 说明：
   * - 不直接存整条原始 item，避免把大量无用字段和空值一起带进历史；
   * - 这里优先覆盖 web_search_call / function_call，其余 *_call 类型保留最小公共字段。
   * @param {any} item
   * @returns {Object|null}
   */
  function normalizeResponsesToolCallRecord(item) {
    if (!item || typeof item !== 'object') return null;
    const type = String(item.type || '').trim().toLowerCase();
    if (!type || (!type.endsWith('_call') && type !== 'function_call')) return null;

    const callId = (typeof item.call_id === 'string' && item.call_id)
      ? item.call_id
      : '';
    const itemId = (typeof item.item_id === 'string' && item.item_id)
      ? item.item_id
      : ((typeof item.id === 'string' && item.id) ? item.id : '');
    const id = (type === 'function_call')
      ? (itemId || callId || '')
      : (callId || itemId || '');
    const status = (typeof item.status === 'string') ? item.status : '';

    if (type === 'function_call') {
      const normalized = compactResponsesMetaValue({
        type,
        id,
        item_id: itemId || '',
        call_id: callId || '',
        status,
        name: item.name || '',
        arguments: item.arguments || ''
      });
      return (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) ? normalized : null;
    }

    if (type === 'web_search_call') {
      const action = (item.action && typeof item.action === 'object' && !Array.isArray(item.action))
        ? item.action
        : {};
      const query = (typeof action.query === 'string') ? action.query : '';
      const queries = Array.isArray(action.queries)
        ? action.queries.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim())
        : [];
      const sources = Array.isArray(action.sources)
        ? action.sources
          .map(source => normalizeResponsesToolCallSource(source))
          .filter(Boolean)
        : [];

      const normalized = compactResponsesMetaValue({
        type,
        id,
        status,
        action_type: action.type || '',
        query,
        queries,
        url: action.url || action.page_url || '',
        title: action.title || action.page_title || '',
        pattern: action.pattern || action.find || action.find_text || '',
        sources
      });
      return (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) ? normalized : null;
    }

    const normalized = compactResponsesMetaValue({
      type,
      id,
      status,
      name: item.name || '',
      arguments: item.arguments || ''
    });
    return (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) ? normalized : null;
  }

  function createResponsesToolTimelineEntry(record, options = {}) {
    if (!record || typeof record !== 'object') return null;
    const entry = compactResponsesMetaValue({
      kind: 'tool_call',
      ...record,
      status: options.status || record.status || ''
    });
    return (entry && typeof entry === 'object' && !Array.isArray(entry)) ? entry : null;
  }

  function mergeResponsesActivityTimeline(existingTimeline, incomingTimeline) {
    const merged = Array.isArray(existingTimeline)
      ? existingTimeline
        .map(entry => normalizeResponsesActivityTimelineEntry(entry))
        .filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry))
      : [];
    const keyToIndex = new Map();
    merged.forEach((entry, index) => {
      keyToIndex.set(getResponsesActivityTimelineEntryKey(entry, index), index);
    });

    (Array.isArray(incomingTimeline) ? incomingTimeline : []).forEach((entry, index) => {
      const normalized = normalizeResponsesActivityTimelineEntry(entry);
      if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return;
      const key = getResponsesActivityTimelineEntryKey(normalized, index);
      if (keyToIndex.has(key)) {
        const existingIndex = keyToIndex.get(key);
        const previous = merged[existingIndex] || {};
        if (normalized.kind === 'reasoning_summary' || normalized.kind === 'commentary') {
          const mergedText = mergeResponsesNarrativeEntryText(previous, normalized);
          merged[existingIndex] = normalizeResponsesActivityTimelineEntry({
            ...previous,
            ...normalized,
            text: mergedText
          });
        } else {
          merged[existingIndex] = normalizeResponsesActivityTimelineEntry({
            ...previous,
            ...normalized,
            arguments: mergeResponsesToolArguments(previous, normalized),
            sources: (Array.isArray(normalized.sources) && normalized.sources.length > 0)
              ? normalized.sources
              : previous.sources
          });
        }
      } else {
        keyToIndex.set(key, merged.length);
        merged.push(normalized);
      }
    });

    return preferResponsesCommentaryTimeline(merged);
  }

  function upsertResponsesReasoningTimeline(existingTimeline, payload, text, options = {}) {
    const entry = createResponsesReasoningTimelineEntry(text, {
      id: payload?.item_id || payload?.id || options.id || 'reasoning_summary',
      status: options.status || payload?.status || ''
    });
    if (!entry) return Array.isArray(existingTimeline) ? existingTimeline : [];
    return mergeResponsesActivityTimeline(existingTimeline, [entry]);
  }

  function upsertResponsesCommentaryTimeline(existingTimeline, payload, text, options = {}) {
    const entry = createResponsesCommentaryTimelineEntry(text, {
      id: payload?.item_id || payload?.id || options.id || 'commentary',
      status: options.status || payload?.status || '',
      phase: options.phase || payload?.phase || 'commentary'
    });
    if (!entry) return Array.isArray(existingTimeline) ? existingTimeline : [];
    return mergeResponsesActivityTimeline(existingTimeline, [entry]);
  }

  function upsertResponsesToolTimeline(existingTimeline, record, options = {}) {
    const entry = createResponsesToolTimelineEntry(record, options);
    if (!entry) return Array.isArray(existingTimeline) ? existingTimeline : [];
    return mergeResponsesActivityTimeline(existingTimeline, [entry]);
  }

  function normalizeResponsesReasoningTimelineEntry(item, fallbackIndex = 0) {
    if (!item || typeof item !== 'object') return null;
    let text = '';
    if (Array.isArray(item.summary)) {
      text = item.summary
        .map(section => (typeof section?.text === 'string' ? section.text : ''))
        .filter(Boolean)
        .join('\n\n');
    }
    if (!text && typeof item.summary_text === 'string') {
      text = item.summary_text;
    }
    if (!text && typeof item.text === 'string') {
      text = item.text;
    }
    return createResponsesReasoningTimelineEntry(text, {
      id: item.id || item.item_id || `reasoning_${fallbackIndex}`,
      status: item.status || 'completed'
    });
  }

  function getResponsesReasoningSummaryFromTimeline(timeline) {
    if (!Array.isArray(timeline) || timeline.length === 0) return '';
    return timeline
      .filter(entry => entry?.kind === 'reasoning_summary' && typeof entry?.text === 'string' && entry.text.trim())
      .map(entry => entry.text.trim())
      .join('\n\n')
      .trim();
  }

  function isResponsesActivityEntryInProgress(entry) {
    const status = String(entry?.status || '').trim().toLowerCase();
    return status === 'streaming' || status === 'in_progress';
  }

  function isResponsesActivityEntryCompleted(entry) {
    const status = String(entry?.status || '').trim().toLowerCase();
    return status === 'completed' || status === 'done';
  }

  function mergeResponsesNarrativeEntryText(previous, normalized) {
    const prev = (typeof previous?.text === 'string') ? previous.text : '';
    const next = (typeof normalized?.text === 'string') ? normalized.text : '';
    if (!prev) return next;
    if (!next) return prev;

    if (normalized.kind === 'reasoning_summary') {
      return isResponsesActivityEntryCompleted(normalized)
        ? next
        : mergeStreamingThoughts(prev, next);
    }

    if (normalized.kind === 'commentary') {
      return isResponsesActivityEntryCompleted(normalized)
        ? next
        : normalizeResponsesCommentaryText(mergeStreamingThoughts(prev, next));
    }

    return next;
  }

  function mergeResponsesToolArguments(previous, normalized) {
    const prev = (typeof previous?.arguments === 'string') ? previous.arguments : '';
    const next = (typeof normalized?.arguments === 'string') ? normalized.arguments : '';
    if (!prev) return next;
    if (!next) return prev;

    if (isResponsesActivityEntryCompleted(normalized)) {
      if (next.startsWith(prev) || next.includes(prev) || next.length >= prev.length) {
        return next;
      }
      if (prev.includes(next)) {
        return prev;
      }
    }

    return mergeStreamingThoughts(prev, next);
  }

  /**
   * 合并 Responses 可见正文分片。
   *
   * 背景：
   * - `response.output_text.delta` 是增量；
   * - `response.output_text.done` / `response.output_item.done` / `response.completed`
   *   往往会再给一次“完整正文”。
   *
   * 目标：
   * - 流式阶段继续做增量拼接；
   * - done/completed 阶段如果拿到的是完整文本，则直接覆盖草稿，
   *   避免出现“streaming 一份 + done 再来一份”的双份正文。
   */
  function mergeResponsesOutputTextPartText(previous, incoming, options = {}) {
    const prev = (typeof previous === 'string') ? previous : '';
    const next = (typeof incoming === 'string') ? incoming : '';
    if (!prev) return next;
    if (!next) return prev;

    if (options.isCompleted) {
      if (next === prev) return prev;
      if (next.startsWith(prev) || next.includes(prev) || next.length >= prev.length) {
        return next;
      }
      if (prev.includes(next)) {
        return prev;
      }
    }

    return mergeStreamingThoughts(prev, next);
  }

  function normalizeResponsesOutputTextOrder(value, fallback = Number.MAX_SAFE_INTEGER) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  /**
   * 将单个 Responses 正文分片写入状态表。
   * key 使用 `item_id + content_index`，从而支持：
   * - 同一 message item 的 delta -> done 覆盖；
   * - 多个 content part / 多个 output item 的稳定合并。
   */
  function upsertResponsesOutputTextPartState(stateMap, payload, text, options = {}) {
    if (!(stateMap instanceof Map)) return false;
    const nextText = (typeof text === 'string') ? text : '';
    if (!nextText) return false;

    const outputIndex = normalizeResponsesOutputTextOrder(
      payload?.output_index,
      normalizeResponsesOutputTextOrder(options.outputIndexFallback, Number.MAX_SAFE_INTEGER)
    );
    const contentIndex = normalizeResponsesOutputTextOrder(
      payload?.content_index,
      normalizeResponsesOutputTextOrder(options.contentIndexFallback, 0)
    );
    const itemId = (typeof payload?.item_id === 'string' && payload.item_id)
      || (typeof payload?.output_item_id === 'string' && payload.output_item_id)
      || (typeof payload?.id === 'string' && payload.id)
      || '';
    const key = itemId
      ? `${itemId}:${contentIndex}`
      : `${outputIndex}:${contentIndex}`;
    const previous = stateMap.get(key);
    const status = options.status || payload?.status || '';
    const mergedText = mergeResponsesOutputTextPartText(previous?.text || '', nextText, {
      isCompleted: isResponsesActivityEntryCompleted({ status })
    });

    stateMap.set(key, {
      key,
      itemId: itemId || null,
      outputIndex,
      contentIndex,
      order: previous?.order ?? stateMap.size,
      status,
      text: mergedText
    });
    return true;
  }

  /**
   * 当某个 item 后续被确认是 commentary 时，把之前误归入正文的分片移除。
   * 这可兜住“output_text.delta 先到、phase 映射后到”的事件乱序场景。
   */
  function removeResponsesOutputTextPartsForItem(stateMap, itemId) {
    if (!(stateMap instanceof Map)) return false;
    const normalizedItemId = (typeof itemId === 'string') ? itemId.trim() : '';
    if (!normalizedItemId) return false;

    let removedAny = false;
    Array.from(stateMap.keys()).forEach((key) => {
      if (!key.startsWith(`${normalizedItemId}:`)) return;
      stateMap.delete(key);
      removedAny = true;
    });
    return removedAny;
  }

  /**
   * 从 Responses message item 中提取“可见正文”分片并写入状态表。
   * 仅处理非 commentary 的可见文本，reasoning / refusal 不计入正文。
   */
  function upsertResponsesOutputTextPartsFromMessageItem(stateMap, item, options = {}) {
    if (!(stateMap instanceof Map) || !item || typeof item !== 'object') return false;
    const itemPhase = normalizeResponsesMessagePhase(item.phase);
    if (isResponsesCommentaryPhase(itemPhase)) {
      return removeResponsesOutputTextPartsForItem(stateMap, item.id || item.item_id || '');
    }

    const contentParts = Array.isArray(item.content) ? item.content : [];
    let wroteAny = false;
    contentParts.forEach((part, index) => {
      if (!part || typeof part !== 'object') return;
      const partType = String(part.type || '').toLowerCase();
      if (partType === 'refusal' || partType.includes('reasoning')) return;
      const partText = (typeof part.text === 'string')
        ? part.text
        : ((typeof part.output_text === 'string') ? part.output_text : '');
      if (!partText) return;

      wroteAny = upsertResponsesOutputTextPartState(
        stateMap,
        {
          item_id: item.id || item.item_id || '',
          output_index: options.outputIndexFallback,
          content_index: index,
          status: item.status || options.status || ''
        },
        partText,
        {
          status: options.status || item.status || 'completed',
          outputIndexFallback: options.outputIndexFallback,
          contentIndexFallback: index
        }
      ) || wroteAny;
    });
    return wroteAny;
  }

  /**
   * 从完整 Responses payload 中回填正文状态。
   * 用于 `response.completed` 这类“给出完整 output 数组”的场景。
   */
  function upsertResponsesOutputTextPartsFromOutputPayload(stateMap, payload, options = {}) {
    if (!(stateMap instanceof Map)) return false;
    const outputItems = Array.isArray(payload?.output) ? payload.output : [];
    let wroteAny = false;
    outputItems.forEach((item, index) => {
      if (!item || typeof item !== 'object') return;
      if (String(item.type || '').toLowerCase() !== 'message') return;
      wroteAny = upsertResponsesOutputTextPartsFromMessageItem(stateMap, item, {
        status: options.status || item.status || 'completed',
        outputIndexFallback: normalizeResponsesOutputTextOrder(item.output_index, index)
      }) || wroteAny;
    });
    return wroteAny;
  }

  function buildResponsesVisibleAnswerFromOutputTextState(stateMap) {
    if (!(stateMap instanceof Map) || stateMap.size === 0) return '';
    return Array.from(stateMap.values())
      .sort((left, right) => {
        const outputDiff = left.outputIndex - right.outputIndex;
        if (outputDiff !== 0) return outputDiff;
        const contentDiff = left.contentIndex - right.contentIndex;
        if (contentDiff !== 0) return contentDiff;
        return left.order - right.order;
      })
      .map(entry => (typeof entry?.text === 'string') ? entry.text : '')
      .join('');
  }

  function isResponsesActivityTimelineInProgress(timeline) {
    return Array.isArray(timeline) && timeline.some((entry) => isResponsesActivityEntryInProgress(entry));
  }

  function getResponsesToolCallsFromTimeline(timeline) {
    if (!Array.isArray(timeline) || timeline.length === 0) return null;
    const toolCalls = timeline
      .filter(entry => entry?.kind === 'tool_call')
      .map((entry) => compactResponsesMetaValue({
        type: entry.type,
        id: entry.id,
        item_id: entry.item_id,
        call_id: entry.call_id,
        status: entry.status,
        action_type: entry.action_type,
        query: entry.query,
        queries: entry.queries,
        url: entry.url,
        title: entry.title,
        pattern: entry.pattern,
        name: entry.name,
        arguments: entry.arguments,
        sources: entry.sources
      }))
      .filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry));
    return toolCalls.length > 0 ? toolCalls : null;
  }

  /**
   * 合并多批 Responses 工具调用记录。
   * 用途：
   * - 流式场景下，`response.output_item.done` / `response.completed` 可能先后到来；
   * - 这里按稳定 key 做覆盖式合并，避免出现重复条目。
   * @param {any} existingRecords
   * @param {any} incomingRecords
   * @returns {Array<Object>}
   */
  function mergeResponsesToolCallRecordLists(existingRecords, incomingRecords) {
    const merged = Array.isArray(existingRecords)
      ? existingRecords
        .map(record => compactResponsesMetaValue(record))
        .filter(record => record && typeof record === 'object' && !Array.isArray(record))
      : [];
    const keyToIndex = new Map();
    merged.forEach((record, index) => {
      keyToIndex.set(getResponsesToolCallRecordKey(record, index), index);
    });

    (Array.isArray(incomingRecords) ? incomingRecords : []).forEach((record, index) => {
      const normalized = compactResponsesMetaValue(record);
      if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return;
      const key = getResponsesToolCallRecordKey(normalized, index);
      if (keyToIndex.has(key)) {
        const existingIndex = keyToIndex.get(key);
        const previous = merged[existingIndex] || {};
        merged[existingIndex] = compactResponsesMetaValue({
          ...previous,
          ...normalized,
          sources: (Array.isArray(normalized.sources) && normalized.sources.length > 0)
            ? normalized.sources
            : previous.sources
        });
      } else {
        keyToIndex.set(key, merged.length);
        merged.push(normalized);
      }
    });

    return merged;
  }

  function extractResponsesActivityTimelineFromOutput(payload) {
    const timeline = [];
    const outputItems = Array.isArray(payload?.output) ? payload.output : [];

    for (let index = 0; index < outputItems.length; index += 1) {
      const item = outputItems[index];
      if (!item || typeof item !== 'object') continue;
      const itemType = String(item.type || '').toLowerCase();

      if (itemType === 'message') {
        const itemPhase = normalizeResponsesMessagePhase(item.phase);
        if (isResponsesCommentaryPhase(itemPhase)) {
          const commentaryEntry = createResponsesCommentaryTimelineEntry(
            extractResponsesMessageVisibleText(item, { excludeReasoning: true }),
            {
              id: item.id || item.item_id || `commentary_${index}`,
              status: item.status || 'completed',
              phase: itemPhase || 'commentary'
            }
          );
          if (commentaryEntry) {
            timeline.push(commentaryEntry);
          }
          continue;
        }
        const contentParts = Array.isArray(item.content) ? item.content : [];
        let messageReasoningText = '';
        contentParts.forEach((part) => {
          if (!part || typeof part !== 'object') return;
          const partType = String(part.type || '').toLowerCase();
          if (!partType.includes('reasoning')) return;
          const text = (typeof part.text === 'string') ? part.text : '';
          if (!text.trim()) return;
          messageReasoningText = mergeThoughts(messageReasoningText, text);
        });
        const messageReasoningEntry = createResponsesReasoningTimelineEntry(messageReasoningText, {
          id: item.id || `message_reasoning_${index}`,
          status: item.status || 'completed'
        });
        if (messageReasoningEntry) {
          timeline.push(messageReasoningEntry);
        }
        continue;
      }

      if (itemType.includes('reasoning')) {
        const reasoningEntry = normalizeResponsesReasoningTimelineEntry(item, index);
        if (reasoningEntry) {
          timeline.push(reasoningEntry);
        }
        continue;
      }

      const toolCallRecord = normalizeResponsesToolCallRecord(item);
      if (toolCallRecord) {
        const toolEntry = createResponsesToolTimelineEntry(toolCallRecord, {
          status: toolCallRecord.status || item.status || 'completed'
        });
        if (toolEntry) {
          timeline.push(toolEntry);
        }
      }
    }

    return preferResponsesCommentaryTimeline(mergeResponsesActivityTimeline([], timeline));
  }

  function mergeResponsesReplayOutputItems(existingItems, incomingItems) {
    return mergeResponsesInputItems(existingItems, incomingItems);
  }

  function cloneResponsesReplayOutputItems(items) {
    return cloneResponsesInputItems(items);
  }

  function extractOpenAIResponsesOutput(payload) {
    const answerParts = [];
    let responseActivityTimeline = [];
    let assistantPhase = '';
    const outputItems = Array.isArray(payload?.output) ? payload.output : [];
    const responseId = (typeof payload?.id === 'string' && payload.id)
      ? payload.id
      : ((typeof payload?.response?.id === 'string' && payload.response.id) ? payload.response.id : null);

    const pushAnswer = (text) => {
      if (typeof text === 'string' && text) answerParts.push(text);
    };

    for (const item of outputItems) {
      if (!item || typeof item !== 'object') continue;
      const itemType = String(item.type || '').toLowerCase();

      if (itemType === 'message') {
        const itemPhase = normalizeResponsesMessagePhase(item.phase);
        if (!isResponsesCommentaryPhase(itemPhase)) {
          if (itemPhase) assistantPhase = itemPhase;
          pushAnswer(extractResponsesMessageVisibleText(item, { excludeReasoning: true }));
        }
        continue;
      }
    }

    responseActivityTimeline = extractResponsesActivityTimelineFromOutput(payload);
    const answerFromOutput = answerParts.join('');
    const answerFromField = readResponsesOutputTextField(payload);
    const answer = answerFromOutput || answerFromField || '';
    return {
      answer,
      responseId,
      responseOutputItems: outputItems.length > 0 ? cloneResponsesReplayOutputItems(outputItems) : null,
      responseActivityTimeline: responseActivityTimeline.length > 0 ? responseActivityTimeline : null,
      reasoningSummary: getResponsesReasoningSummaryFromTimeline(responseActivityTimeline),
      responseToolCalls: getResponsesToolCallsFromTimeline(responseActivityTimeline),
      assistantPhase: assistantPhase || null
    };
  }

  async function extractConversationTitleFromResponse(response, apiConfig) {
    let payload = null;
    try {
      payload = await response.json();
    } catch (e) {
      const fallbackText = await response.text().catch(() => '');
      return fallbackText || '';
    }

    if (payload && payload.error) {
      const msg = payload.error.message || 'API 返回错误';
      throw new Error(msg);
    }

    const isGeminiApi = isGeminiApiResponse(response, apiConfig);
    if (isGeminiApi) {
      const parts = payload?.candidates?.[0]?.content?.parts || [];
      const textParts = parts
        .filter(part => typeof part?.text === 'string' && !part?.thought)
        .map(part => part.text);
      return textParts.join('');
    }

    if (isOpenAIResponsesApiResponse(response, apiConfig) || isOpenAIResponsesPayload(payload)) {
      const extracted = extractOpenAIResponsesOutput(payload);
      return extracted.answer || '';
    }

    const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
    if (typeof choice?.message?.content === 'string') return choice.message.content;
    if (typeof choice?.text === 'string') return choice.text;
    if (typeof payload?.content === 'string') return payload.content;
    return '';
  }

  function truncateTextForTitle(text) {
    const input = (typeof text === 'string') ? text.trim() : '';
    if (!input) return '';
    if (input.length <= 600) return input;
    const head = input.slice(0, 300);
    const tail = input.slice(-300);
    return `[${head}...${tail}]`;
  }

  function formatMessageForTitle(message) {
    if (!message || typeof message.role !== 'string') return '';
    const roleRaw = String(message.role || '').trim().toLowerCase();
    let roleLabel = '消息';
    if (roleRaw === 'user') roleLabel = '用户消息';
    else if (roleRaw === 'assistant' || roleRaw === 'ai' || roleRaw === 'model') roleLabel = 'AI回复';
    else if (roleRaw === 'system') roleLabel = '系统消息';
    else roleLabel = `${message.role}消息`;
    const text = extractPlainTextFromContent(message.content, { imagePlaceholder: '[图片]' });
    const trimmed = truncateTextForTitle(text);
    if (!trimmed) return '';
    return `${roleLabel}：\n${trimmed}`;
  }

  function buildConversationTextForTitle(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return '';
    const formattedMessages = messages
      .map(formatMessageForTitle)
      .filter(Boolean);
    return formattedMessages.join('\n\n').trim();
  }

  function resolvePromptTypeFromMessages(messages) {
    if (!Array.isArray(messages)) return 'none';
    const firstUserMessage = messages.find(m => (m?.role || '').toLowerCase() === 'user') || null;
    return typeof firstUserMessage?.promptType === 'string' ? firstUserMessage.promptType : 'none';
  }

  function resolveTitlePrefixByPromptType(promptType) {
    if (promptType === 'summary') return '[总结]';
    if (promptType === 'selection' || promptType === 'query') return '[划词解释]';
    return '';
  }

  async function requestConversationTitle({ apiConfig, prompt, conversationText }) {
    // 将指令 + 全部消息合并为单条 user 消息，并在开头包含指令，避免模型把 assistant 内容当作续写上下文。
    const combinedUserMessage = [
      prompt,
      '对话内容：',
      conversationText
    ].join('\n\n').trim();
    const messages = [
      { role: 'system', content: prompt },
      { role: 'user', content: combinedUserMessage }
    ];
    const configForTitle = { ...apiConfig, useStreaming: false };
    const requestBody = await apiManager.buildRequest({
      messages,
      config: configForTitle
    });

    const response = await apiManager.sendRequest({
      requestBody,
      config: configForTitle
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(errorText || `API错误 (${response.status})`);
    }

    const rawTitle = await extractConversationTitleFromResponse(response, configForTitle);
    return normalizeConversationTitleText(rawTitle);
  }

  // 复用“自动重试”设置，对标题生成做指数退避重试。
  async function requestConversationTitleWithRetry(params) {
    const maxAttempts = autoRetryEnabled ? MAX_AUTO_RETRY_ATTEMPTS : 1;
    let attemptIndex = 0;
    let lastError = null;
    while (attemptIndex < maxAttempts) {
      try {
        return await requestConversationTitle(params);
      } catch (error) {
        lastError = error;
        const canRetry = autoRetryEnabled && attemptIndex < (maxAttempts - 1);
        if (!canRetry) throw error;
        const delayMs = getAutoRetryDelayMs(attemptIndex);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        attemptIndex += 1;
      }
    }
    throw lastError || new Error('生成对话标题失败');
  }

  // 触发条件：
  // - 仅首条 AI 回复完成后触发（避免多轮对话重复生成）；
  // - 跳过划词线程与重新生成场景；
  // - 写入前校验 expectedSummary，避免覆盖用户手动重命名。
  async function maybeGenerateConversationTitle({ conversationId, attemptState, regenerateMode }) {
    if (!conversationId) return;
    if (regenerateMode) return;
    if (attemptState?.threadContext) return;
    if (!settingsManager?.getSetting || !apiManager) return;
    if (conversationTitleRequests.has(conversationId)) return;

    const enabled = !!settingsManager.getSetting('autoGenerateConversationTitle');
    if (!enabled) return;

    const prompt = (settingsManager.getSetting('conversationTitlePrompt') || '').trim();
    if (!prompt) return;

    const apiPref = settingsManager.getSetting('conversationTitleApi');
    const resolvedApi = (typeof apiManager.resolveApiParam === 'function')
      ? apiManager.resolveApiParam(apiPref)
      : apiManager.getSelectedConfig();
    if (!hasValidApiBaseUrl(resolvedApi?.baseUrl, resolvedApi) || !hasUsableApiCredential(resolvedApi)) return;

    const chain = (typeof chatHistoryManager?.getCurrentConversationChain === 'function')
      ? chatHistoryManager.getCurrentConversationChain()
      : [];
    const historyMessages = chatHistoryManager?.chatHistory?.messages || [];
    const messages = (Array.isArray(chain) && chain.length > 0) ? chain : historyMessages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const promptType = resolvePromptTypeFromMessages(messages);
    if (promptType === 'summary' && !settingsManager.getSetting('autoGenerateTitleForSummary')) return;
    if ((promptType === 'selection' || promptType === 'query') && !settingsManager.getSetting('autoGenerateTitleForSelection')) return;

    const assistantMessages = messages.filter(m => (m?.role || '').toLowerCase() === 'assistant');
    if (assistantMessages.length !== 1) return;

    const conversationText = buildConversationTextForTitle(messages);
    if (!conversationText) return;

    const expectedSummary = chatHistoryUI?.getActiveConversationSummary?.() || '';
    conversationTitleRequests.add(conversationId);
    try {
      const title = await requestConversationTitleWithRetry({
        apiConfig: resolvedApi,
        prompt,
        conversationText
      });
      if (!title) return;
      let finalTitle = title;
      const prefixTag = resolveTitlePrefixByPromptType(promptType);
      if (prefixTag && !finalTitle.startsWith(prefixTag)) {
        finalTitle = `${prefixTag} ${finalTitle}`.trim();
      }
      await chatHistoryUI?.updateConversationSummary?.(conversationId, finalTitle, {
        expectedSummary,
        summarySource: 'auto',
        skipIfManual: true
      });
    } catch (error) {
      console.warn('生成对话标题失败:', error);
    } finally {
      conversationTitleRequests.delete(conversationId);
    }
  }

  /**
   * 生成指定会话消息列表的标题（供历史右键批量生成复用）
   * @param {{messages?: Array<Object>, conversationId?: string}} options
   * @returns {Promise<{ok: boolean, title?: string, reason?: string, promptType?: string, prefixTag?: string, error?: Error}>}
   */
  async function generateConversationTitleForMessages(options = {}) {
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const messages = Array.isArray(normalizedOptions.messages) ? normalizedOptions.messages : [];
    const conversationId = (typeof normalizedOptions.conversationId === 'string')
      ? normalizedOptions.conversationId.trim()
      : '';
    if (!settingsManager?.getSetting || !apiManager) {
      return { ok: false, reason: 'missing_services' };
    }
    if (messages.length === 0) {
      return { ok: false, reason: 'empty_messages' };
    }

    const prompt = (settingsManager.getSetting('conversationTitlePrompt') || '').trim();
    if (!prompt) {
      return { ok: false, reason: 'missing_prompt' };
    }

    const apiPref = settingsManager.getSetting('conversationTitleApi');
    const resolvedApi = (typeof apiManager.resolveApiParam === 'function')
      ? apiManager.resolveApiParam(apiPref)
      : apiManager.getSelectedConfig();
    if (!hasValidApiBaseUrl(resolvedApi?.baseUrl, resolvedApi) || !hasUsableApiCredential(resolvedApi)) {
      return { ok: false, reason: 'missing_api' };
    }

    const conversationText = buildConversationTextForTitle(messages);
    if (!conversationText) {
      return { ok: false, reason: 'empty_messages' };
    }

    const promptType = resolvePromptTypeFromMessages(messages);
    const prefixTag = resolveTitlePrefixByPromptType(promptType);

    if (conversationId && conversationTitleRequests.has(conversationId)) {
      return { ok: false, reason: 'in_progress' };
    }
    if (conversationId) conversationTitleRequests.add(conversationId);

    try {
      const title = await requestConversationTitleWithRetry({
        apiConfig: resolvedApi,
        prompt,
        conversationText
      });
      if (!title) {
        return { ok: false, reason: 'empty_title' };
      }
      let finalTitle = title;
      if (prefixTag && !finalTitle.startsWith(prefixTag)) {
        finalTitle = `${prefixTag} ${finalTitle}`.trim();
      }
      return {
        ok: true,
        title: finalTitle,
        promptType,
        prefixTag
      };
    } catch (error) {
      return { ok: false, reason: 'error', error };
    } finally {
      if (conversationId) conversationTitleRequests.delete(conversationId);
    }
  }

  /**
   * 解析当前激活的“划词线程上下文”。
   *
   * 设计要点：
   * - 只读取 selectionThreadManager 状态，不主动创建任何历史节点；
   * - 若锚点消息不存在，则认为线程已失效，提示用户并退出线程模式；
   * - 返回值仅用于后续“发送时”逻辑判断。
   *
   * @returns {{threadId: string, anchorMessageId: string, selectionText: string, annotation: Object}|null}
   */
  function resolveActiveThreadContext() {
    const threadManager = services.selectionThreadManager;
    if (!threadManager?.isThreadModeActive?.()) return null;
    const threadId = threadManager.getActiveThreadId?.();
    if (!threadId) return null;
    const info = threadManager.findThreadById?.(threadId);
    if (!info || !info.annotation) return null;
    const anchorMessageId = info.anchorMessageId || threadManager.getActiveAnchorMessageId?.();
    if (!anchorMessageId) return null;

    const anchorNode = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === anchorMessageId);
    if (!anchorNode) {
      if (typeof showNotification === 'function') {
        showNotification({ message: '划词线程锚点已丢失，已退出线程模式', type: 'warning' });
      }
      threadManager.exitThread?.();
      return null;
    }

    return {
      threadId,
      anchorMessageId,
      selectionText: info.annotation?.selectionText || threadManager.getActiveSelectionText?.() || '',
      annotation: info.annotation
    };
  }

  /**
   * 线程消息的历史补丁字段（用于标记“该消息属于某条划词线程”）。
   * @param {Object|null} threadContext
   * @returns {Object|null}
   */
  function buildThreadHistoryPatch(threadContext) {
    if (!threadContext) return null;
    return {
      threadId: threadContext.threadId,
      threadAnchorId: threadContext.anchorMessageId,
      threadSelectionText: threadContext.selectionText || '',
      threadRootId: threadContext.annotation?.rootMessageId || null
    };
  }

  /**
   * 确保线程根节点存在（隐藏的“> 选中文本”用户消息）。
   * @param {Object} threadContext
   * @returns {string|null} rootMessageId
   */
  function ensureThreadRootMessage(threadContext) {
    if (!threadContext || !threadContext.annotation) return null;
    if (threadContext.annotation.rootMessageId) {
      threadContext.rootMessageId = threadContext.annotation.rootMessageId;
      return threadContext.annotation.rootMessageId;
    }

    const selectionText = threadContext.selectionText || '';
    const content = selectionText ? `> ${selectionText}` : '>';
    const node = chatHistoryManager.addMessageToTreeWithOptions(
      'user',
      content,
      threadContext.anchorMessageId,
      { preserveCurrentNode: true }
    );

    if (!node) return null;
    node.threadId = threadContext.threadId;
    node.threadAnchorId = threadContext.anchorMessageId;
    node.threadSelectionText = threadContext.selectionText || '';
    node.threadHiddenSelection = true;
    node.threadMatchIndex = Number.isFinite(threadContext.annotation.matchIndex)
      ? threadContext.annotation.matchIndex
      : 0;

    threadContext.annotation.rootMessageId = node.id;
    threadContext.annotation.lastMessageId = node.id;
    threadContext.rootMessageId = node.id;
    threadContext.lastMessageId = node.id;
    return node.id;
  }

  /**
   * 更新线程的最新消息 ID（用于拼接上下文/恢复线程）。
   * @param {Object|null} threadContext
   * @param {string|null} messageId
   */
  function updateThreadLastMessage(threadContext, messageId) {
    if (!threadContext || !threadContext.annotation || !messageId) return;
    threadContext.annotation.lastMessageId = messageId;
    threadContext.lastMessageId = messageId;
  }

  /**
   * 构造“主链 + 线程链”的上下文序列。
   * - 主链：从根到锚点消息；
   * - 线程链：从隐藏选中文本到线程最新消息。
   *
   * @param {Object|null} threadContext
   * @param {string|null} [lastMessageIdOverride]
   * @returns {Array<Object>}
   */
  function buildThreadConversationChain(threadContext, lastMessageIdOverride = null) {
    if (!threadContext) return getCurrentConversationChain();
    const nodes = chatHistoryManager?.chatHistory?.messages || [];
    const findNode = (id) => nodes.find(m => m.id === id) || null;

    const mainChain = [];
    let currentId = threadContext.anchorMessageId;
    while (currentId) {
      const node = findNode(currentId);
      if (!node) break;
      mainChain.unshift(node);
      currentId = node.parentId;
    }

    const rootId = threadContext.annotation?.rootMessageId || null;
    const lastId = lastMessageIdOverride || threadContext.annotation?.lastMessageId || rootId;
    const threadChain = [];
    if (rootId && lastId) {
      let threadCurrentId = lastId;
      while (threadCurrentId) {
        const node = findNode(threadCurrentId);
        if (!node) break;
        threadChain.unshift(node);
        if (threadCurrentId === rootId) break;
        threadCurrentId = node.parentId;
      }
      if (threadChain.length && threadChain[0].id !== rootId) {
        const rootNode = findNode(rootId);
        if (rootNode) threadChain.unshift(rootNode);
      }
    }

    return mainChain.concat(threadChain);
  }

  /**
   * 线程滚动容器解析：
   * - 侧栏内联模式：线程容器嵌套在 chatContainer，应滚动 chatContainer；
   * - 全屏双栏模式：线程容器独立滚动。
   *
   * @param {Object|null} threadContext
   * @returns {HTMLElement|null}
   */
  function resolveThreadScrollContainer(threadContext) {
    const container = threadContext?.container || null;
    if (!container) return null;
    const isNested = typeof container.closest === 'function'
      ? !!container.closest('#chat-container')
      : false;
    return isNested ? chatContainer : container;
  }

  // 判断“当前 UI 是否正在展示该线程”，用于避免跨线程渲染互相污染。
  function isThreadUiActive(threadContext) {
    if (!threadContext) return false;
    const threadManager = services.selectionThreadManager;
    if (!threadManager?.isThreadModeActive?.()) return false;
    const activeThreadId = threadManager.getActiveThreadId?.();
    return !!(activeThreadId && activeThreadId === threadContext.threadId);
  }

  // 仅当线程 UI 可见且匹配时，返回可滚动容器；否则返回 null。
  function resolveThreadUiContainer(threadContext) {
    if (!threadContext) return null;
    if (!isThreadUiActive(threadContext)) return null;
    return resolveThreadScrollContainer(threadContext);
  }

  // 统一解析“AI 回复的历史父节点”：
  // - 线程模式：沿用线程上下文指定的 parentId；
  // - 普通模式：优先使用本次请求锁定的 parentMessageIdForAi，再回退到当前会话指针。
  function resolveHistoryParentIdForAi(threadContext, attemptState) {
    if (threadContext) {
      return threadContext.parentMessageIdForAi
        || threadContext.lastMessageId
        || threadContext.rootMessageId
        || threadContext.anchorMessageId
        || null;
    }
    const explicit = (typeof attemptState?.parentMessageIdForAi === 'string')
      ? attemptState.parentMessageIdForAi.trim()
      : '';
    if (explicit) return explicit;
    return chatHistoryManager.chatHistory.currentNode || null;
  }

  function normalizeConversationId(value) {
    return (typeof value === 'string' && value.trim()) ? value.trim() : '';
  }

  /**
   * 当前“未落盘新会话”的临时队列键。
   *
   * 为什么需要它：
   * - 首条消息刚发出时，会话 ID 可能尚未写入 IndexedDB；
   * - 这时用户继续发送，仍然需要把消息排到“同一个未落盘会话”的队列里；
   * - 待真实 conversationId 确定后，再把该临时队列迁移到正式会话键。
   *
   * 说明：
   * - 这里只在当前标签页内使用，不会跨标签共享；
   * - 一旦显式切换到“新建空白会话”，会重新生成新的 draft key，避免残留队列复用到下一段新会话。
   */
  function getActiveDraftConversationQueueKey() {
    return activeDraftConversationQueueKey;
  }

  function rotateActiveDraftConversationQueueKey() {
    draftConversationQueueSerial += 1;
    activeDraftConversationQueueKey = `__draft_queue_${draftConversationQueueSerial}`;
    return activeDraftConversationQueueKey;
  }

  function resolveConversationQueueKey(conversationId) {
    const normalizedId = normalizeConversationId(conversationId);
    return normalizedId || getActiveDraftConversationQueueKey();
  }

  function getCurrentActiveConversationQueueKey() {
    const activeId = normalizeConversationId(currentConversationId)
      || normalizeConversationId(chatHistoryUI?.getCurrentConversationId?.());
    const preferredAttempt = selectLatestRunningAttemptForCurrentConversation(
      Array.from(activeAttempts.values()),
      activeId
    );
    if (preferredAttempt) {
      const attemptQueueKey = getAttemptRuntimeConversationKey(preferredAttempt, activeId || '');
      if (attemptQueueKey) return attemptQueueKey;
    }
    return resolveConversationQueueKey(activeId);
  }

  function normalizeConversationHistoryRevision(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return 0;
    return Math.floor(numeric);
  }

  function resolveConversationHistoryRevision(conversationId = '', overrideValue = undefined) {
    if (overrideValue !== undefined) {
      return normalizeConversationHistoryRevision(overrideValue);
    }
    const normalizedConversationId = normalizeConversationId(conversationId);
    const activeConversationId = normalizeConversationId(currentConversationId)
      || normalizeConversationId(chatHistoryUI?.getCurrentConversationId?.());
    if (!normalizedConversationId || normalizedConversationId === activeConversationId) {
      return normalizeConversationHistoryRevision(
        chatHistoryManager?.getConversationRevision?.()
          ?? chatHistoryManager?.chatHistory?.conversationRevision
      );
    }
    return 0;
  }

  function buildDefaultConversationJobRetryPolicy(kind) {
    const normalizedKind = CONVERSATION_JOB_KINDS.has(kind) ? kind : 'append_user_message';
    return {
      enabled: normalizedKind === 'append_user_message',
      maxAttempts: MAX_AUTO_RETRY_ATTEMPTS,
      baseDelayMs: AUTO_RETRY_BASE_DELAY_MS,
      maxDelayMs: AUTO_RETRY_MAX_DELAY_MS
    };
  }

  function normalizeConversationJobRetryPolicy(kind, rawPolicy) {
    const defaults = buildDefaultConversationJobRetryPolicy(kind);
    const policy = (rawPolicy && typeof rawPolicy === 'object') ? rawPolicy : {};
    return {
      enabled: policy.enabled === true ? true : defaults.enabled,
      maxAttempts: Number.isFinite(Number(policy.maxAttempts))
        ? Math.max(1, Math.floor(Number(policy.maxAttempts)))
        : defaults.maxAttempts,
      baseDelayMs: Number.isFinite(Number(policy.baseDelayMs))
        ? Math.max(0, Math.floor(Number(policy.baseDelayMs)))
        : defaults.baseDelayMs,
      maxDelayMs: Number.isFinite(Number(policy.maxDelayMs))
        ? Math.max(0, Math.floor(Number(policy.maxDelayMs)))
        : defaults.maxDelayMs
    };
  }

  function isConversationJobTerminal(job) {
    return job?.status === 'completed' || job?.status === 'canceled';
  }

  function isConversationJobUserPaused(job) {
    return job?.status === 'paused' || job?.paused === true;
  }

  function isConversationJobWaitingForRetry(job) {
    return job?.status === 'delayed_retry';
  }

  function isConversationJobBlockedByConfirmation(job) {
    return job?.status === 'stale' || job?.status === 'failed';
  }

  function createQueuedConversationTaskId() {
    queuedConversationTaskSerial += 1;
    return `conversation_job_${Date.now()}_${queuedConversationTaskSerial}`;
  }

  function createPendingConversationSteerId() {
    pendingConversationSteerSerial += 1;
    return `conversation_steer_${Date.now()}_${pendingConversationSteerSerial}`;
  }

  function normalizeConversationQueuedTask(queuedTask) {
    const normalizedTask = (queuedTask && typeof queuedTask === 'object')
      ? queuedTask
      : {};

    if (!normalizedTask.id) {
      normalizedTask.id = createQueuedConversationTaskId();
    }
    normalizedTask.kind = CONVERSATION_JOB_KINDS.has(normalizedTask.kind)
      ? normalizedTask.kind
      : (normalizedTask.options?.regenerateMode ? 'regenerate_assistant_turn' : 'append_user_message');
    normalizedTask.status = CONVERSATION_JOB_STATUSES.has(normalizedTask.status)
      ? normalizedTask.status
      : 'queued';
    normalizedTask.payload = (normalizedTask.payload && typeof normalizedTask.payload === 'object')
      ? normalizedTask.payload
      : ((normalizedTask.options && typeof normalizedTask.options === 'object')
        ? normalizedTask.options
        : {});
    normalizedTask.options = normalizedTask.payload;
    normalizedTask.conversationId = normalizeConversationId(
      normalizedTask.conversationId || normalizedTask.payload?.conversationIdOverride || ''
    );
    normalizedTask.conversationRevisionAtEnqueue = normalizeConversationHistoryRevision(
      normalizedTask.conversationRevisionAtEnqueue
    );
    normalizedTask.anchorMessageId = normalizeConversationId(
      normalizedTask.anchorMessageId || normalizedTask.payload?.messageId || ''
    );
    normalizedTask.targetAiMessageId = normalizeConversationId(
      normalizedTask.targetAiMessageId || normalizedTask.payload?.targetAiMessageId || ''
    );
    normalizedTask.retryPolicy = normalizeConversationJobRetryPolicy(normalizedTask.kind, normalizedTask.retryPolicy);
    normalizedTask.retryCount = Number.isFinite(Number(normalizedTask.retryCount))
      ? Math.max(0, Math.floor(Number(normalizedTask.retryCount)))
      : 0;
    normalizedTask.availableAt = Number.isFinite(Number(normalizedTask.availableAt))
      ? Number(normalizedTask.availableAt)
      : null;
    normalizedTask.staleReason = (typeof normalizedTask.staleReason === 'string' && normalizedTask.staleReason.trim())
      ? normalizedTask.staleReason.trim()
      : null;
    normalizedTask.failureMessage = (typeof normalizedTask.failureMessage === 'string' && normalizedTask.failureMessage.trim())
      ? normalizedTask.failureMessage.trim()
      : null;
    normalizedTask.paused = (
      normalizedTask.paused === true
      || normalizedTask.status === 'paused'
      || normalizedTask.status === 'stale'
      || normalizedTask.status === 'failed'
    );
    normalizedTask.queuedAt = Number.isFinite(normalizedTask.queuedAt)
      ? normalizedTask.queuedAt
      : Date.now();
    normalizedTask.createdAt = Number.isFinite(normalizedTask.createdAt)
      ? normalizedTask.createdAt
      : normalizedTask.queuedAt;
    if (normalizedTask.status === 'delayed_retry' && normalizedTask.availableAt == null) {
      normalizedTask.availableAt = Date.now();
    }
    if (normalizedTask.status === 'paused' && !normalizedTask.paused) {
      normalizedTask.paused = true;
    }
    if (isConversationJobBlockedByConfirmation(normalizedTask)) {
      normalizedTask.paused = true;
    }

    return normalizedTask;
  }

  function normalizePendingConversationSteer(rawSteer) {
    const normalizedSteer = (rawSteer && typeof rawSteer === 'object')
      ? rawSteer
      : {};
    if (!normalizedSteer.id) {
      normalizedSteer.id = createPendingConversationSteerId();
    }
    normalizedSteer.createdAt = Number.isFinite(Number(normalizedSteer.createdAt))
      ? Number(normalizedSteer.createdAt)
      : Date.now();
    normalizedSteer.payload = (normalizedSteer.payload && typeof normalizedSteer.payload === 'object')
      ? normalizedSteer.payload
      : {};
    normalizedSteer.responseInputItem = (normalizedSteer.responseInputItem && typeof normalizedSteer.responseInputItem === 'object')
      ? cloneDataSafely(normalizedSteer.responseInputItem)
      : null;
    normalizedSteer.textPreview = (typeof normalizedSteer.textPreview === 'string')
      ? normalizedSteer.textPreview.trim()
      : '';
    normalizedSteer.rawText = (typeof normalizedSteer.rawText === 'string')
      ? normalizedSteer.rawText
      : '';
    normalizedSteer.imageCount = Number.isFinite(Number(normalizedSteer.imageCount))
      ? Math.max(0, Math.floor(Number(normalizedSteer.imageCount)))
      : 0;
    normalizedSteer.hasScreenshot = normalizedSteer.hasScreenshot === true;
    normalizedSteer.targetTurnId = normalizeConversationId(normalizedSteer.targetTurnId || '');
    normalizedSteer.targetTurnStartedAtMs = Number.isFinite(Number(normalizedSteer.targetTurnStartedAtMs))
      ? Number(normalizedSteer.targetTurnStartedAtMs)
      : null;
    return normalizedSteer;
  }

  function buildResponsesUserMessageInputItemFromPayload(payload) {
    const normalizedPayload = (payload && typeof payload === 'object') ? payload : {};
    const text = (typeof normalizedPayload.originalMessageText === 'string')
      ? normalizedPayload.originalMessageText
      : '';
    const images = extractQueuedInputImages(normalizedPayload.inputImagesHtmlSnapshot || '');
    const contentParts = [];
    images.forEach((image) => {
      const imageUrl = (image.imageData || image.previewSrc || '').trim();
      if (!imageUrl) return;
      contentParts.push({
        type: 'input_image',
        image_url: imageUrl
      });
    });
    if (text) {
      contentParts.push({ type: 'input_text', text });
    }
    if (contentParts.length <= 0) return null;
    if (contentParts.length === 1 && contentParts[0].type === 'input_text') {
      return {
        type: 'message',
        role: 'user',
        content: contentParts[0].text
      };
    }
    return {
      type: 'message',
      role: 'user',
      content: contentParts
    };
  }

  function summarizePendingConversationMutation(queueKey) {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    const pendingList = pendingConversationMutations.get(normalizedQueueKey);
    if (!Array.isArray(pendingList) || pendingList.length === 0) return null;
    const lastMutation = pendingList[pendingList.length - 1] || null;
    const kind = (typeof lastMutation?.type === 'string' && lastMutation.type.trim())
      ? lastMutation.type.trim()
      : 'history_mutation';
    const count = pendingList.length;
    const label = kind === 'regenerate_message'
      ? '重新生成'
      : (kind === 'delete_message' ? '删除消息' : '编辑消息');
    return {
      count,
      kind,
      description: count > 1
        ? `当前生成结束后将依次应用 ${count} 个历史修改`
        : `当前生成结束后将应用：${label}`,
      createdAt: Number.isFinite(Number(lastMutation?.createdAt))
        ? Number(lastMutation.createdAt)
        : Date.now()
    };
  }

  function clearConversationQueueWakeTimer(queueKey) {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    const timerId = conversationQueueWakeTimers.get(normalizedQueueKey);
    if (timerId) {
      clearTimeout(timerId);
      conversationQueueWakeTimers.delete(normalizedQueueKey);
    }
  }

  function scheduleConversationQueueWakeTimer(queueKey) {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    clearConversationQueueWakeTimer(normalizedQueueKey);
    const queue = getConversationSendQueue(normalizedQueueKey);
    const nextWakeAt = queue
      .filter((task) => task.status === 'delayed_retry' && !task.paused && Number.isFinite(task.availableAt))
      .map((task) => Number(task.availableAt))
      .sort((a, b) => a - b)[0];
    if (!Number.isFinite(nextWakeAt)) return;
    const delayMs = Math.max(0, nextWakeAt - Date.now());
    const timerId = setTimeout(() => {
      conversationQueueWakeTimers.delete(normalizedQueueKey);
      void flushConversationSendQueue(normalizedQueueKey);
    }, delayMs);
    conversationQueueWakeTimers.set(normalizedQueueKey, timerId);
  }

  function refreshConversationQueueState(queueKey) {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    syncConversationQueueRuntime(normalizedQueueKey);
    refreshCurrentConversationQueuedSendPreview();
    scheduleConversationQueueWakeTimer(normalizedQueueKey);
  }

  function normalizeConversationSendQueueTasks(queue) {
    if (!Array.isArray(queue)) return [];
    queue.forEach((task, index) => {
      queue[index] = normalizeConversationQueuedTask(task);
    });
    return queue;
  }

  function getConversationSendQueue(queueKey) {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    const queue = conversationSendQueues.get(normalizedQueueKey);
    return Array.isArray(queue) ? normalizeConversationSendQueueTasks(queue) : [];
  }

  function ensureConversationSendQueue(queueKey) {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    const existing = conversationSendQueues.get(normalizedQueueKey);
    if (Array.isArray(existing)) return normalizeConversationSendQueueTasks(existing);
    const created = [];
    conversationSendQueues.set(normalizedQueueKey, created);
    refreshConversationQueueState(normalizedQueueKey);
    return created;
  }

  function findQueuedConversationTaskIndex(queueKey, taskId) {
    if (!taskId) return -1;
    const queue = getConversationSendQueue(queueKey);
    return queue.findIndex((task) => task?.id === taskId);
  }

  function getQueuedConversationTask(queueKey, taskId) {
    const queue = getConversationSendQueue(queueKey);
    return queue.find((task) => task?.id === taskId) || null;
  }

  function enqueueConversationSend(queueKey, queuedTask, options = {}) {
    const queue = ensureConversationSendQueue(queueKey);
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const nextTask = normalizeConversationQueuedTask(queuedTask);
    if (normalizedOptions.atFront) {
      queue.unshift(nextTask);
    } else {
      queue.push(nextTask);
    }
    refreshConversationQueueState(queueKey);
    return queue.length;
  }

  function removeConversationQueuedTask(queueKey, taskId) {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    const queue = getConversationSendQueue(normalizedQueueKey);
    const index = findQueuedConversationTaskIndex(normalizedQueueKey, taskId);
    if (index < 0) return null;

    const [removedTask] = queue.splice(index, 1);
    if (queue.length === 0) {
      conversationSendQueues.delete(normalizedQueueKey);
    }
    refreshConversationQueueState(normalizedQueueKey);
    return removedTask || null;
  }

  function upsertConversationQueuedTask(queueKey, queuedTask) {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    const queue = ensureConversationSendQueue(normalizedQueueKey);
    const nextTask = normalizeConversationQueuedTask(queuedTask);
    const existingIndex = findQueuedConversationTaskIndex(normalizedQueueKey, nextTask.id);
    if (existingIndex >= 0) {
      queue.splice(existingIndex, 1, nextTask);
    } else {
      queue.push(nextTask);
    }
    refreshConversationQueueState(normalizedQueueKey);
    return nextTask;
  }

  function setConversationQueuedTaskPaused(queueKey, taskId, paused) {
    const task = getQueuedConversationTask(queueKey, taskId);
    if (!task) return null;
    if (task.status === 'stale' || task.status === 'failed') return task;
    if (paused === true) {
      task.paused = true;
      task.status = 'paused';
    } else {
      task.paused = false;
      task.status = (task.availableAt != null && task.availableAt > Date.now())
        ? 'delayed_retry'
        : 'queued';
    }
    refreshConversationQueueState(queueKey);
    return task;
  }

  function reorderConversationQueuedTask(queueKey, sourceTaskId, targetTaskId, placement = 'before') {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    const queue = getConversationSendQueue(normalizedQueueKey);
    const sourceIndex = findQueuedConversationTaskIndex(normalizedQueueKey, sourceTaskId);
    const targetIndex = findQueuedConversationTaskIndex(normalizedQueueKey, targetTaskId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return false;

    const [movedTask] = queue.splice(sourceIndex, 1);
    let insertIndex = targetIndex;
    if (sourceIndex < targetIndex) insertIndex -= 1;
    if (placement === 'after') insertIndex += 1;
    insertIndex = Math.max(0, Math.min(insertIndex, queue.length));
    queue.splice(insertIndex, 0, movedTask);
    refreshConversationQueueState(normalizedQueueKey);
    return true;
  }

  function hasQueuedMessagesForConversation(queueKey) {
    return getConversationSendQueue(queueKey).some((task) => !isConversationJobTerminal(task));
  }

  /**
   * 解析排队项里的图片快照，抽取出“可恢复回输入框”的图片描述。
   *
   * 为什么不直接把 queue 里冻结的 HTML 整段塞回 imageContainer：
   * - 原始 HTML 里包含删除按钮等旧 DOM，直接回填会丢失 createImageTag 绑定的事件；
   * - 恢复到输入框时，我们需要重新生成“活的图片标签”，确保预览/删除/截图识别都正常工作；
   * - 同时队列预览本身也只应该消费一份只读、干净的数据描述。
   *
   * @param {string} imagesHtml
   * @returns {Array<{imageData: string, fileName: string, previewSrc: string, previewAlt: string}>}
   */
  function extractQueuedInputImages(imagesHtml) {
    if (typeof imagesHtml !== 'string' || !imagesHtml.includes('<img')) return [];

    const scratch = document.createElement('div');
    scratch.innerHTML = imagesHtml;

    const imageTags = Array.from(scratch.querySelectorAll('.image-tag'));
    const nodes = imageTags.length > 0
      ? imageTags
      : Array.from(scratch.querySelectorAll('img'));

    return nodes.map((node, index) => {
      const tag = node?.classList?.contains('image-tag') ? node : null;
      const img = tag ? tag.querySelector('img') : node;
      const imageData = (tag?.getAttribute('data-image') || img?.getAttribute('src') || '').trim();
      const fileName = (tag?.getAttribute('title') || img?.getAttribute('alt') || '').trim();
      const previewSrc = (img?.getAttribute('src') || imageData).trim();
      const previewAlt = fileName || `queued-image-${index + 1}`;
      return {
        imageData,
        fileName,
        previewSrc,
        previewAlt
      };
    }).filter((image) => !!(image.imageData || image.previewSrc));
  }

  /**
   * 解析排队项里的图片快照，抽取成安全、只读的缩略图数据。
   *
   * @param {string} imagesHtml
   * @returns {Array<{src: string, alt: string}>}
   */
  function extractQueuedPreviewImages(imagesHtml) {
    return extractQueuedInputImages(imagesHtml)
      .map((image) => ({
        src: image.previewSrc || image.imageData,
        alt: image.previewAlt || ''
      }))
      .filter((image) => !!image.src);
  }

  /**
   * 将内部 queue task 规整成 UI 可直接消费的只读预览数据。
   *
   * 这样做的好处：
   * - 队列 UI 与真正发送逻辑解耦；
   * - 后续如果 queue task 结构演进，只需维护这一处映射；
   * - 也方便统一处理“文本为空但其实是图片消息 / regenerate 请求”的占位文案。
   *
   * @param {{id?: string, paused?: boolean, options?: Object, queuedAt?: number}|null|undefined} queuedTask
   * @returns {{
   *   id: string,
   *   text: string,
   *   rawText: string,
   *   imageCount: number,
   *   images: Array<{src: string, alt: string}>,
   *   hasScreenshot: boolean,
   *   regenerateMode: boolean,
   *   paused: boolean
   * }}
   */
  function buildQueuedTaskPreview(queuedTask) {
    const normalizedTask = normalizeConversationQueuedTask(queuedTask);
    const payload = normalizedTask.payload || {};
    const rawText = (typeof payload.originalMessageText === 'string')
      ? payload.originalMessageText
      : '';
    const normalizedText = rawText.trim();
    const images = extractQueuedPreviewImages(payload.inputImagesHtmlSnapshot || '');
    const imageCount = images.length;
    const hasScreenshot = !!(
      payload.inputHasScreenshotSnapshot
      || images.some((img) => (img.alt || '').trim() === 'page-screenshot.png')
    );
    const regenerateMode = normalizedTask.kind === 'regenerate_assistant_turn';

    let fallbackText = '（排队中的消息）';
    if (regenerateMode) {
      fallbackText = '（排队中的重新生成请求）';
    } else if (hasScreenshot) {
      fallbackText = imageCount > 0 ? '（排队中的截图消息）' : '（排队中的截图请求）';
    } else if (imageCount > 0) {
      fallbackText = '（排队中的图片消息）';
    }

    const statusLabelMap = {
      queued: '排队中',
      running: '发送中',
      delayed_retry: '等待重试',
      paused: '已暂停',
      stale: '待确认',
      failed: '失败',
      completed: '已完成',
      canceled: '已取消'
    };
    const staleReasonTextMap = {
      history_mutated: '历史已修改'
    };
    const staleReasonText = staleReasonTextMap[normalizedTask.staleReason]
      || normalizedTask.staleReason
      || '';

    return {
      id: normalizedTask.id,
      kind: normalizedTask.kind,
      status: normalizedTask.status,
      statusLabel: statusLabelMap[normalizedTask.status] || normalizedTask.status || '排队中',
      text: normalizedText || fallbackText,
      rawText,
      imageCount,
      images,
      hasScreenshot,
      regenerateMode,
      paused: normalizedTask.paused === true,
      staleReasonText,
      failureMessage: normalizedTask.failureMessage || '',
      canPauseToggle: normalizedTask.status === 'queued'
        || normalizedTask.status === 'paused'
        || normalizedTask.status === 'delayed_retry',
      canContinue: normalizedTask.status === 'stale' || normalizedTask.status === 'failed',
      canDrag: normalizedTask.status === 'queued'
        || normalizedTask.status === 'paused'
        || normalizedTask.status === 'delayed_retry'
    };
  }

  function buildPendingSteerPreview(pendingSteer) {
    const normalizedSteer = normalizePendingConversationSteer(pendingSteer);
    const text = (normalizedSteer.textPreview || '').trim();
    const fallbackText = normalizedSteer.imageCount > 0
      ? '（等待吸收的转向图片消息）'
      : '（等待吸收的转向消息）';
    return {
      id: normalizedSteer.id,
      text: text || fallbackText,
      imageCount: normalizedSteer.imageCount,
      hasScreenshot: normalizedSteer.hasScreenshot
    };
  }

  function getConversationQueuedSendPreviewMountPoint() {
    const composerAccessoryRegion = document.getElementById('composer-accessory-region');
    if (composerAccessoryRegion) {
      return {
        host: composerAccessoryRegion,
        // 辅助区内部采用自然堆叠顺序：request_user_input 在前，queue / steer 预览追加到后面。
        anchor: null
      };
    }

    if (inputContainer) {
      return {
        host: inputContainer,
        // 预览插在图片区 / 文本输入行之前，形成“紧贴输入框上缘”的队列托盘。
        anchor: imageContainer || inputContainer.firstElementChild || null
      };
    }

    return {
      host: chatContainer || null,
      anchor: chatContainer?.firstElementChild || null
    };
  }

  function getConversationQueuedSendPreviewContainer() {
    const { host } = getConversationQueuedSendPreviewMountPoint();
    if (!host) {
      return document.querySelector('.conversation-send-queue-preview');
    }

    return Array.from(host.children || []).find((child) => (
      child?.classList?.contains('conversation-send-queue-preview')
    )) || null;
  }

  function ensureConversationQueuedSendPreviewContainer() {
    const { host, anchor } = getConversationQueuedSendPreviewMountPoint();
    if (!host) return null;

    let container = getConversationQueuedSendPreviewContainer();
    if (!container) {
      container = document.createElement('section');
      container.className = 'conversation-send-queue-preview';
      container.setAttribute('aria-live', 'polite');
      container.setAttribute('aria-label', '当前会话待发送消息队列');
    }

    // 兼容旧实现：若容器曾被插到聊天滚动区顶部或输入区外部，这里统一迁回输入框附近。
    document.querySelectorAll('.conversation-send-queue-preview').forEach((node) => {
      if (node !== container) node.remove();
    });

    const shouldAppendToTail = !anchor || anchor === container;
    if (container.parentElement !== host) {
      if (shouldAppendToTail) {
        host.appendChild(container);
      } else {
        host.insertBefore(container, anchor);
      }
    } else if (!shouldAppendToTail && container.nextElementSibling !== anchor) {
      host.insertBefore(container, anchor);
    } else if (shouldAppendToTail && host.lastElementChild !== container) {
      host.appendChild(container);
    }

    return container;
  }

  function clearConversationQueuePreviewDragClasses(scope = null) {
    const root = scope || getConversationQueuedSendPreviewContainer();
    if (!root) return;
    root.querySelectorAll('.conversation-send-queue-preview__item').forEach((item) => {
      item.classList.remove(
        'conversation-send-queue-preview__item--dragging',
        'conversation-send-queue-preview__item--drop-before',
        'conversation-send-queue-preview__item--drop-after'
      );
      item.removeAttribute('data-drop-placement');
    });
  }

  function resolveConversationQueueDropPlacement(event, itemElement) {
    const rect = itemElement?.getBoundingClientRect?.();
    if (!rect) return 'before';
    const offsetY = event.clientY - rect.top;
    return offsetY >= (rect.height / 2) ? 'after' : 'before';
  }

  function restoreQueuedTaskToComposer(task) {
    const normalizedTask = normalizeConversationQueuedTask(task);
    clearInputs();

    const nextText = typeof normalizedTask.payload?.originalMessageText === 'string'
      ? normalizedTask.payload.originalMessageText
      : '';
    inputController?.setInputText?.(nextText);
    if (!inputController?.setInputText && messageInput) {
      messageInput.textContent = nextText;
    }

    try {
      if (imageContainer) imageContainer.innerHTML = '';
      const queuedImages = extractQueuedInputImages(normalizedTask.payload?.inputImagesHtmlSnapshot || '');
      const fragment = document.createDocumentFragment();
      queuedImages.forEach((image) => {
        const imageTag = imageHandler?.createImageTag?.(
          image.imageData || image.previewSrc,
          image.fileName || ''
        );
        if (imageTag) {
          fragment.appendChild(imageTag);
        }
      });
      if (imageContainer) {
        imageContainer.appendChild(fragment);
      }
    } catch (error) {
      console.warn('恢复排队消息图片到输入框失败:', error);
    }

    try { messageInput?.dispatchEvent?.(new Event('input')); } catch (_) {}
    try { appContext.services.uiManager?.resetInputHeight?.(); } catch (_) {}
    try { appContext.services.uiManager?.updateSendButtonState?.(); } catch (_) {}
    inputController?.focusToEnd?.();
  }

  async function continueQueuedConversationTask(queueKey, taskId) {
    const existingTask = getQueuedConversationTask(queueKey, taskId);
    if (!existingTask) return null;
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    const nextTask = normalizeConversationQueuedTask({
      ...cloneDataSafely(existingTask),
      id: createQueuedConversationTaskId(),
      status: 'queued',
      paused: false,
      retryCount: 0,
      availableAt: null,
      staleReason: null,
      failureMessage: null,
      conversationRevisionAtEnqueue: resolveConversationHistoryRevision(normalizedQueueKey),
      queuedAt: Date.now(),
      createdAt: Date.now()
    });
    removeConversationQueuedTask(normalizedQueueKey, taskId);
    const hasPendingWork = hasPendingWorkForConversationQueue(normalizedQueueKey);
    const hasQueuedMessages = hasQueuedMessagesForConversation(normalizedQueueKey);
    if (!hasPendingWork && !hasQueuedMessages) {
      return executeConversationQueueJob(normalizedQueueKey, nextTask);
    }
    enqueueConversationSend(normalizedQueueKey, nextTask);
    scheduleConversationQueueFlush(normalizedQueueKey);
    return { ok: true, queued: true };
  }

  function handleQueuePreviewEdit(queueKey, taskId) {
    const removedTask = removeConversationQueuedTask(queueKey, taskId);
    if (!removedTask) return;
    restoreQueuedTaskToComposer(removedTask);
    scheduleConversationQueueFlush(queueKey);
  }

  async function handleQueuePreviewContinue(queueKey, taskId) {
    await continueQueuedConversationTask(queueKey, taskId);
  }

  function handleQueuePreviewTogglePaused(queueKey, taskId) {
    const task = getQueuedConversationTask(queueKey, taskId);
    if (!task) return;
    setConversationQueuedTaskPaused(queueKey, taskId, !(task.paused === true));
    scheduleConversationQueueFlush(queueKey);
  }

  function handleQueuePreviewRemove(queueKey, taskId) {
    const removedTask = removeConversationQueuedTask(queueKey, taskId);
    if (!removedTask) return;
    scheduleConversationQueueFlush(queueKey);
  }

  function createQueuePreviewActionButton(label, className, title, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `conversation-send-queue-preview__action ${className}`.trim();
    button.textContent = label;
    button.title = title || label;
    button.setAttribute('aria-label', title || label);
    if (typeof onClick === 'function') {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      });
    }
    return button;
  }

  function buildQueuePreviewImages(images) {
    if (!Array.isArray(images) || images.length === 0) return null;
    const imageWrap = document.createElement('div');
    imageWrap.className = 'conversation-send-queue-preview__images';

    images.slice(0, 3).forEach((image, imageIndex) => {
      const thumb = document.createElement('img');
      thumb.className = 'conversation-send-queue-preview__image';
      thumb.src = image.src;
      thumb.alt = image.alt || `queued-image-${imageIndex + 1}`;
      thumb.loading = 'lazy';
      imageWrap.appendChild(thumb);
    });

    if (images.length > 3) {
      const more = document.createElement('span');
      more.className = 'conversation-send-queue-preview__more';
      more.textContent = `+${images.length - 3}`;
      imageWrap.appendChild(more);
    }

    return imageWrap;
  }

  function bindQueuePreviewDragEvents(item, handle, queueKey, taskId, list) {
    if (!item || !handle) return;
    handle.draggable = true;
    handle.addEventListener('click', (event) => event.stopPropagation());
    handle.addEventListener('mousedown', (event) => event.stopPropagation());

    handle.addEventListener('dragstart', (event) => {
      activeQueuePreviewDragState = {
        queueKey: resolveConversationQueueKey(queueKey),
        taskId
      };
      item.classList.add('conversation-send-queue-preview__item--dragging');
      try {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', taskId);
      } catch (_) {}
    });

    item.addEventListener('dragover', (event) => {
      if (!activeQueuePreviewDragState || activeQueuePreviewDragState.taskId === taskId) return;
      if (activeQueuePreviewDragState.queueKey !== resolveConversationQueueKey(queueKey)) return;
      event.preventDefault();
      const placement = resolveConversationQueueDropPlacement(event, item);
      clearConversationQueuePreviewDragClasses(list);
      item.classList.add(`conversation-send-queue-preview__item--drop-${placement}`);
      item.setAttribute('data-drop-placement', placement);
    });

    item.addEventListener('dragleave', (event) => {
      const nextTarget = event.relatedTarget;
      if (nextTarget && item.contains(nextTarget)) return;
      item.classList.remove(
        'conversation-send-queue-preview__item--drop-before',
        'conversation-send-queue-preview__item--drop-after'
      );
      item.removeAttribute('data-drop-placement');
    });

    item.addEventListener('drop', (event) => {
      if (!activeQueuePreviewDragState || activeQueuePreviewDragState.taskId === taskId) return;
      if (activeQueuePreviewDragState.queueKey !== resolveConversationQueueKey(queueKey)) return;
      event.preventDefault();
      const placement = item.getAttribute('data-drop-placement')
        || resolveConversationQueueDropPlacement(event, item);
      const changed = reorderConversationQueuedTask(
        queueKey,
        activeQueuePreviewDragState.taskId,
        taskId,
        placement
      );
      activeQueuePreviewDragState = null;
      clearConversationQueuePreviewDragClasses(list);
      if (changed) {
        scheduleConversationQueueFlush(queueKey);
      }
    });

    handle.addEventListener('dragend', () => {
      activeQueuePreviewDragState = null;
      clearConversationQueuePreviewDragClasses(list);
    });
  }

  /**
   * 刷新“当前会话待发送队列”的输入框上方预览。
   *
   * 交互目标：
   * - 队列项应紧贴输入框，给用户明确的“已进入待发送队列”反馈；
   * - 多条消息按 FIFO 从上到下排列，越早排队的越靠上；
   * - 只展示当前激活会话的 queue，避免不同会话串 UI。
   */
  function refreshCurrentConversationQueuedSendPreview() {
    const existingContainer = getConversationQueuedSendPreviewContainer();
    const activeQueueKey = getCurrentActiveConversationQueueKey();
    const runtimeSnapshot = conversationRuntimeStore?.getConversationRuntimeState?.(activeQueueKey) || null;
    const runtimeQueueSnapshot = runtimeSnapshot?.queue || null;
    const queue = Array.isArray(runtimeQueueSnapshot?.jobs)
      ? runtimeQueueSnapshot.jobs.map((job) => normalizeConversationQueuedTask(job))
      : getConversationSendQueue(activeQueueKey);
    const pendingMutation = runtimeQueueSnapshot?.pendingMutation || summarizePendingConversationMutation(activeQueueKey);
    const pendingSteers = Array.isArray(runtimeSnapshot?.steer?.pendingSteers)
      ? runtimeSnapshot.steer.pendingSteers.map((steer) => buildPendingSteerPreview(steer))
      : [];

    if ((!Array.isArray(queue) || queue.length === 0) && !pendingMutation && pendingSteers.length === 0) {
      existingContainer?.remove();
      return;
    }

    const container = ensureConversationQueuedSendPreviewContainer();
    if (!container) return;

    container.textContent = '';

    const list = document.createElement('div');
    list.className = 'conversation-send-queue-preview__list';
    container.setAttribute('aria-label', `当前会话待发送消息队列，共 ${queue.length} 条`);

    if (pendingMutation) {
      const pendingNotice = document.createElement('div');
      pendingNotice.className = 'conversation-send-queue-preview__pending-mutation';
      pendingNotice.textContent = pendingMutation.description || '当前生成结束后将应用历史修改';
      list.appendChild(pendingNotice);
    }

    pendingSteers.forEach((steer, index) => {
      const pendingSteerNotice = document.createElement('div');
      pendingSteerNotice.className = 'conversation-send-queue-preview__pending-mutation';
      const steerTags = [];
      if (steer.hasScreenshot) steerTags.push('截图');
      if (steer.imageCount > 0) steerTags.push(`${steer.imageCount} 图`);
      const suffix = steerTags.length > 0 ? ` · ${steerTags.join(' · ')}` : '';
      pendingSteerNotice.textContent = `转向 ${index + 1}：${steer.text}${suffix}`;
      list.appendChild(pendingSteerNotice);
    });

    queue.forEach((task, index) => {
      const preview = buildQueuedTaskPreview(task);
      const item = document.createElement('article');
      item.className = 'conversation-send-queue-preview__item';
      item.setAttribute('aria-label', `待发送消息 ${index + 1}`);
      item.setAttribute('data-queue-task-id', preview.id);
      if (preview.paused) {
        item.classList.add('conversation-send-queue-preview__item--paused');
      }
      if (preview.status === 'stale') {
        item.classList.add('conversation-send-queue-preview__item--stale');
      } else if (preview.status === 'failed') {
        item.classList.add('conversation-send-queue-preview__item--failed');
      } else if (preview.status === 'delayed_retry') {
        item.classList.add('conversation-send-queue-preview__item--delayed-retry');
      }

      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'conversation-send-queue-preview__drag-handle';
      handle.title = '拖动调整顺序';
      handle.setAttribute('aria-label', `拖动调整第 ${index + 1} 条排队消息顺序`);
      handle.disabled = !preview.canDrag;
      const handleIcon = document.createElement('span');
      handleIcon.className = 'drag-handle-icon';
      handle.appendChild(handleIcon);

      const body = document.createElement('div');
      body.className = 'conversation-send-queue-preview__body';

      const summary = document.createElement('div');
      summary.className = 'conversation-send-queue-preview__summary';

      const orderChip = document.createElement('span');
      orderChip.className = 'conversation-send-queue-preview__chip conversation-send-queue-preview__chip--order';
      orderChip.textContent = `#${index + 1}`;
      summary.appendChild(orderChip);

      const statusChip = document.createElement('span');
      statusChip.className = 'conversation-send-queue-preview__chip conversation-send-queue-preview__chip--status';
      statusChip.textContent = preview.statusLabel;
      summary.appendChild(statusChip);

      if (preview.regenerateMode) {
        const regenerateChip = document.createElement('span');
        regenerateChip.className = 'conversation-send-queue-preview__chip';
        regenerateChip.textContent = '重新生成';
        summary.appendChild(regenerateChip);
      }

      if (preview.staleReasonText) {
        const staleChip = document.createElement('span');
        staleChip.className = 'conversation-send-queue-preview__chip conversation-send-queue-preview__chip--paused';
        staleChip.textContent = preview.staleReasonText;
        summary.appendChild(staleChip);
      }

      if (preview.hasScreenshot) {
        const screenshotChip = document.createElement('span');
        screenshotChip.className = 'conversation-send-queue-preview__chip';
        screenshotChip.textContent = '截图';
        summary.appendChild(screenshotChip);
      }

      if (preview.imageCount > 0) {
        const imageChip = document.createElement('span');
        imageChip.className = 'conversation-send-queue-preview__chip';
        imageChip.textContent = `${preview.imageCount} 图`;
        summary.appendChild(imageChip);
      }

      const text = document.createElement('div');
      text.className = 'conversation-send-queue-preview__text';
      text.textContent = preview.text;
      text.title = preview.failureMessage
        ? `${preview.rawText || preview.text}\n${preview.failureMessage}`
        : (preview.rawText || preview.text);
      summary.appendChild(text);

      const images = buildQueuePreviewImages(preview.images);
      if (images) summary.appendChild(images);

      body.appendChild(summary);

      const actions = document.createElement('div');
      actions.className = 'conversation-send-queue-preview__actions';
      if (preview.canContinue) {
        actions.appendChild(createQueuePreviewActionButton(
          '继续',
          'conversation-send-queue-preview__action--pause',
          '基于当前最新历史，重新创建一条新的发送任务',
          () => { void handleQueuePreviewContinue(activeQueueKey, preview.id); }
        ));
      }
      actions.appendChild(createQueuePreviewActionButton(
        '修改',
        'conversation-send-queue-preview__action--edit',
        '移出队列并放回输入框',
        () => handleQueuePreviewEdit(activeQueueKey, preview.id)
      ));
      if (preview.canPauseToggle) {
        actions.appendChild(createQueuePreviewActionButton(
          preview.paused ? '继续' : '暂停',
          'conversation-send-queue-preview__action--pause',
          preview.paused ? '取消暂停，允许轮到时自动发送' : '暂停自动发送，轮到时保留在队列中',
          () => handleQueuePreviewTogglePaused(activeQueueKey, preview.id)
        ));
      }
      actions.appendChild(createQueuePreviewActionButton(
        '移除',
        'conversation-send-queue-preview__action--remove',
        '从队列中删除这条消息',
        () => handleQueuePreviewRemove(activeQueueKey, preview.id)
      ));

      item.appendChild(handle);
      item.appendChild(body);
      item.appendChild(actions);
      if (preview.canDrag) {
        bindQueuePreviewDragEvents(item, handle, activeQueueKey, preview.id, list);
      }
      list.appendChild(item);
    });

    container.appendChild(list);
  }

  function cloneDataSafely(value) {
    if (value == null) return value ?? null;
    try {
      return structuredClone(value);
    } catch (_) {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch (_) {
        return value;
      }
    }
  }

  function getLastMainConversationNode(messages) {
    const list = Array.isArray(messages) ? messages : [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const node = list[i];
      if (!node || node.threadId || node.threadHiddenSelection) continue;
      return node;
    }
    return null;
  }

  function buildMainConversationChainFromMessages(messages) {
    const list = Array.isArray(messages) ? messages : [];
    if (list.length === 0) return [];

    const tailNode = getLastMainConversationNode(list);
    if (!tailNode?.id) {
      return list.filter((node) => node && !node.threadId && !node.threadHiddenSelection);
    }

    const nodeById = new Map();
    list.forEach((node) => {
      if (node?.id) nodeById.set(node.id, node);
    });

    const chain = [];
    const seen = new Set();
    let currentId = tailNode.id;
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const node = nodeById.get(currentId);
      if (!node) break;
      if (!node.threadId && !node.threadHiddenSelection) {
        chain.unshift(node);
      }
      currentId = typeof node.parentId === 'string' ? node.parentId.trim() : '';
    }

    return chain.length > 0
      ? chain
      : list.filter((node) => node && !node.threadId && !node.threadHiddenSelection);
  }

  function getDetachedConversationParentMessageId(historyMessagesRef) {
    return getLastMainConversationNode(historyMessagesRef)?.id || null;
  }

  /**
   * 统一解析本次发送/compact 看到的会话链。
   *
   * 这样可以让：
   * - 正常发送；
   * - 发送前 auto compact；
   * - 手动 `/compact`
   * 共享同一套“主链 / 线程链 / detached 快照”选择逻辑。
   *
   * @param {Object} options
   * @returns {Array<Object>}
   */
  function resolveConversationChainForAttempt(options = {}) {
    const {
      attemptState = null,
      conversationSnapshot = null,
      activeThreadContext = null,
      regenerateMode = false,
      messageId = null,
      sendChatHistoryFlag = shouldSendChatHistory
    } = options;

    let conversationChain = null;
    if (Array.isArray(conversationSnapshot) && conversationSnapshot.length > 0) {
      conversationChain = conversationSnapshot;
    } else if (activeThreadContext) {
      const threadChainOverride = (regenerateMode && messageId) ? messageId : null;
      conversationChain = buildThreadConversationChain(activeThreadContext, threadChainOverride);
    } else if (isAttemptUsingDetachedMainConversationHistory(attemptState)) {
      conversationChain = buildMainConversationChainFromMessages(attemptState?.historyMessagesRef || []);
    } else {
      conversationChain = getCurrentConversationChain();
    }

    if (
      !activeThreadContext
      && sendChatHistoryFlag
      && Array.isArray(conversationChain)
      && conversationChain.length <= 1
    ) {
      const historyMessages = isAttemptUsingDetachedMainConversationHistory(attemptState)
        ? (attemptState?.historyMessagesRef || [])
        : (chatHistoryManager?.chatHistory?.messages || []);
      if (historyMessages.length > conversationChain.length) {
        const fallback = historyMessages.filter((node) => !node?.threadId && !node?.threadHiddenSelection);
        if (fallback.length > conversationChain.length) {
          conversationChain = fallback;
        }
      }
    }

    return Array.isArray(conversationChain) ? conversationChain : [];
  }

  function moveConversationSendQueue(fromQueueKey, toQueueKey) {
    const normalizedFromKey = resolveConversationQueueKey(fromQueueKey);
    const normalizedToKey = resolveConversationQueueKey(toQueueKey);
    if (!normalizedFromKey || !normalizedToKey || normalizedFromKey === normalizedToKey) return;

    const fromQueue = conversationSendQueues.get(normalizedFromKey);
    const fromMutations = pendingConversationMutations.get(normalizedFromKey);
    if (!Array.isArray(fromQueue) || fromQueue.length === 0) {
      conversationSendQueues.delete(normalizedFromKey);
      if (Array.isArray(fromMutations) && fromMutations.length > 0) {
        pendingConversationMutations.set(normalizedToKey, [
          ...(pendingConversationMutations.get(normalizedToKey) || []),
          ...fromMutations
        ]);
        pendingConversationMutations.delete(normalizedFromKey);
      }
      clearConversationQueueWakeTimer(normalizedFromKey);
      refreshConversationQueueState(normalizedFromKey);
      refreshConversationQueueState(normalizedToKey);
      return;
    }

    const targetQueue = ensureConversationSendQueue(normalizedToKey);
    targetQueue.push(...fromQueue.map((task) => normalizeConversationQueuedTask({
      ...cloneDataSafely(task),
      conversationId: normalizeConversationId(normalizedToKey) || normalizeConversationId(task?.conversationId)
    })));
    conversationSendQueues.delete(normalizedFromKey);
    if (Array.isArray(fromMutations) && fromMutations.length > 0) {
      pendingConversationMutations.set(normalizedToKey, [
        ...(pendingConversationMutations.get(normalizedToKey) || []),
        ...fromMutations
      ]);
      pendingConversationMutations.delete(normalizedFromKey);
    }
    clearConversationQueueWakeTimer(normalizedFromKey);
    refreshConversationQueueState(normalizedFromKey);
    refreshConversationQueueState(normalizedToKey);
  }

  function isConversationQueueKeyActive(queueKey) {
    return getCurrentActiveConversationQueueKey() === resolveConversationQueueKey(queueKey);
  }

  function doesAttemptBelongToConversationQueueKey(attemptState, queueKey) {
    return attemptBelongsToConversationQueue(attemptState, resolveConversationQueueKey(queueKey));
  }

  function hasPendingWorkForConversationQueue(queueKey) {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    if (conversationQueueDrainLocks.has(normalizedQueueKey)) return true;

    for (const attemptState of activeAttempts.values()) {
      if (doesAttemptBelongToConversationQueueKey(attemptState, normalizedQueueKey)) {
        return true;
      }
    }

    return false;
  }

  function scheduleConversationQueueFlush(queueKey, options = {}) {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    if (!normalizedQueueKey) return;
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const delayMs = Number.isFinite(normalizedOptions.delayMs)
      ? Math.max(0, normalizedOptions.delayMs)
      : 0;

    setTimeout(() => {
      void flushConversationSendQueue(normalizedQueueKey);
    }, delayMs);
  }

  async function executeConversationQueueJob(queueKey, queuedTask) {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    const nextTask = normalizeConversationQueuedTask(queuedTask);
    if (!normalizedQueueKey || !nextTask || !nextTask.payload) {
      return { ok: false, error: new Error('invalid_queue_job') };
    }

    conversationQueueDrainLocks.add(normalizedQueueKey);
    refreshConversationQueueState(normalizedQueueKey);
    notifyStreamingConversationStateChanged();

    try {
      let dispatchOptions = {
        ...nextTask.payload,
        __conversationJobId: nextTask.id,
        __conversationJobKind: nextTask.kind,
        __conversationQueueKey: normalizedQueueKey,
        __conversationRevisionAtStart: nextTask.conversationRevisionAtEnqueue,
        __conversationRetryPolicy: cloneDataSafely(nextTask.retryPolicy),
        __autoRetryAttempt: nextTask.retryCount
      };
      const queueConversationId = normalizeConversationId(normalizedQueueKey);
      const shouldDispatchInBackground = !!(queueConversationId && !isConversationQueueKeyActive(normalizedQueueKey));
      if (shouldDispatchInBackground) {
        const conversationSnapshot = await chatHistoryUI?.getConversationSnapshotById?.(queueConversationId);
        if (!conversationSnapshot || !Array.isArray(conversationSnapshot.messages)) {
          throw new Error(`后台续发失败：找不到会话 ${queueConversationId} 的历史快照`);
        }
        dispatchOptions = {
          ...dispatchOptions,
          conversationIdOverride: queueConversationId,
          historyMessagesSnapshot: cloneDataSafely(conversationSnapshot.messages) || [],
          conversationRevisionSnapshot: normalizeConversationHistoryRevision(conversationSnapshot.conversationRevision),
          conversationApiLockSnapshot: cloneDataSafely(
            dispatchOptions?.conversationApiLockSnapshot ?? conversationSnapshot.apiLock ?? null
          )
        };
      }

      const result = await sendMessageCore(dispatchOptions);
      await applyPendingConversationMutationsIfIdle(normalizedQueueKey);
      if (result?.ok !== true && !result?.retryScheduled && !result?.aborted) {
        upsertConversationQueuedTask(normalizedQueueKey, {
          ...nextTask,
          status: 'failed',
          paused: true,
          availableAt: null,
          failureMessage: (typeof result?.error?.message === 'string' && result.error.message.trim())
            ? result.error.message.trim()
            : nextTask.failureMessage
        });
      }
      return result;
    } catch (error) {
      console.error('处理会话发送队列失败:', error);
      upsertConversationQueuedTask(normalizedQueueKey, {
        ...nextTask,
        status: 'failed',
        paused: true,
        availableAt: null,
        failureMessage: (typeof error?.message === 'string' && error.message.trim())
          ? error.message.trim()
          : nextTask.failureMessage
      });
      return { ok: false, error };
    } finally {
      conversationQueueDrainLocks.delete(normalizedQueueKey);
      refreshConversationQueueState(normalizedQueueKey);
      notifyStreamingConversationStateChanged();
      if (hasQueuedMessagesForConversation(normalizedQueueKey)) {
        scheduleConversationQueueFlush(normalizedQueueKey);
      }
    }
  }

  /**
   * 启动指定会话队列中的下一条消息。
   *
   * 设计说明：
   * - 前台会话直接复用当前 UI / 内存态；
   * - 后台会话会先加载该会话的历史快照，再在 detached history 上继续发送；
   * - 全程不切换当前可见对话，因此用户可以切到别的会话，原会话仍在后台按 FIFO 自动续发。
   */
  async function flushConversationSendQueue(queueKey) {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    if (!normalizedQueueKey) return false;
    if (conversationQueueDrainLocks.has(normalizedQueueKey)) return false;
    if (hasPendingWorkForConversationQueue(normalizedQueueKey)) return false;

    const queue = normalizeConversationSendQueueTasks(conversationSendQueues.get(normalizedQueueKey));
    if (!Array.isArray(queue) || queue.length === 0) {
      conversationSendQueues.delete(normalizedQueueKey);
      refreshConversationQueueState(normalizedQueueKey);
      return false;
    }

    while (queue.length > 0 && isConversationJobTerminal(queue[0])) {
      queue.shift();
    }
    if (queue.length === 0) {
      conversationSendQueues.delete(normalizedQueueKey);
      refreshConversationQueueState(normalizedQueueKey);
      return false;
    }

    const frontTask = normalizeConversationQueuedTask(queue[0]);
    if (frontTask.status === 'delayed_retry' && !frontTask.paused) {
      if (frontTask.availableAt != null && frontTask.availableAt > Date.now()) {
        refreshConversationQueueState(normalizedQueueKey);
        return false;
      }
      frontTask.status = 'queued';
      frontTask.availableAt = null;
    }
    if (frontTask.paused || frontTask.status === 'paused' || frontTask.status === 'stale' || frontTask.status === 'failed') {
      refreshConversationQueueState(normalizedQueueKey);
      return false;
    }

    const nextTask = normalizeConversationQueuedTask(queue.shift());
    if (queue.length === 0) {
      conversationSendQueues.delete(normalizedQueueKey);
    }
    refreshConversationQueueState(normalizedQueueKey);
    if (!nextTask || !nextTask.payload) {
      if (hasQueuedMessagesForConversation(normalizedQueueKey)) {
        scheduleConversationQueueFlush(normalizedQueueKey);
      }
      return false;
    }
    return !!(await executeConversationQueueJob(normalizedQueueKey, nextTask));
  }

  async function waitForConversationQueueIdle(queueKey, timeoutMs = 3000) {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    const safeTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 3000;
    const startAt = Date.now();

    while (hasPendingWorkForConversationQueue(normalizedQueueKey)) {
      if ((Date.now() - startAt) >= safeTimeoutMs) break;
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  }

  function abortRequestsForConversationQueue(queueKey, options = {}) {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    if (!normalizedQueueKey) return false;

    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const suppressQueueFlush = normalizedOptions.suppressQueueFlush === true;
    let abortedAny = false;

    for (const attemptState of activeAttempts.values()) {
      if (!doesAttemptBelongToConversationQueueKey(attemptState, normalizedQueueKey)) continue;
      attemptState.manualAbort = true;
      try { attemptState.controller?.abort(); } catch (error) { console.error('中止会话内请求失败:', error); }
      abortedAny = true;
    }

    const queue = getConversationSendQueue(normalizedQueueKey);
    let queueChanged = false;
    queue.forEach((task, index) => {
      const normalizedTask = normalizeConversationQueuedTask(task);
      if (normalizedTask.status !== 'delayed_retry') return;
      queue[index] = normalizeConversationQueuedTask({
        ...normalizedTask,
        status: 'canceled',
        paused: false,
        availableAt: null,
        staleReason: 'aborted'
      });
      queueChanged = true;
      abortedAny = true;
    });
    if (queueChanged) {
      while (queue.length > 0 && isConversationJobTerminal(queue[0])) {
        queue.shift();
      }
      if (queue.length === 0) {
        conversationSendQueues.delete(normalizedQueueKey);
      }
      refreshConversationQueueState(normalizedQueueKey);
    }

    if (!suppressQueueFlush && hasQueuedMessagesForConversation(normalizedQueueKey)) {
      scheduleConversationQueueFlush(normalizedQueueKey);
    }

    return abortedAny;
  }

  function updateCurrentConversationContext(id) {
    const previousConversationId = normalizeConversationId(currentConversationId);
    const previousQueueKey = previousConversationId || getActiveDraftConversationQueueKey();
    const nextConversationId = normalizeConversationId(id);

    if (!previousConversationId && nextConversationId) {
      moveConversationSendQueue(previousQueueKey, nextConversationId);
      migrateConversationRuntimeState(previousQueueKey, nextConversationId);
    } else if (previousConversationId && !nextConversationId) {
      rotateActiveDraftConversationQueueKey();
    }

    currentConversationId = nextConversationId || null;
    clearBackgroundCompletedConversationMarker(nextConversationId);
    refreshCurrentConversationQueuedSendPreview();

    try {
      services.conversationPresence?.setActiveConversationId?.(currentConversationId);
    } catch (_) {}

    refreshConversationQueueState(nextConversationId || getActiveDraftConversationQueueKey());
    scheduleConversationQueueFlush(nextConversationId || getActiveDraftConversationQueueKey());
  }


  function resolveAbortTarget(target) {
    const isElementTarget = target && typeof target === 'object' && target.nodeType === 1;
    const targetElement = isElementTarget ? target : null;
    const targetId = typeof target === 'string'
      ? target
      : (isElementTarget ? target.getAttribute('data-message-id') : null);
    return {
      targetElement,
      normalizedTargetId: normalizeConversationId(targetId)
    };
  }

  function doesAttemptMatchAbortTarget(attempt, targetElement, normalizedTargetId) {
    if (!attempt || attempt.finished) return false;
    const attemptAiId = normalizeConversationId(attempt?.aiMessageId);
    const attemptParentMessageId = normalizeConversationId(attempt?.parentMessageIdForAi)
      || normalizeConversationId(attempt?.threadContext?.parentMessageIdForAi);
    const matchesById = !!(
      normalizedTargetId
      && (attemptAiId === normalizedTargetId || attemptParentMessageId === normalizedTargetId)
    );
    const matchesByLoading = !!(targetElement && attempt.loadingMessage === targetElement);
    return matchesById || matchesByLoading;
  }

  function doesQueuedTaskMatchAbortTarget(task, normalizedTargetId) {
    if (!task || !normalizedTargetId) return false;
    const taskAiId = normalizeConversationId(task?.targetAiMessageId);
    const taskParentId = normalizeConversationId(task?.anchorMessageId);
    return taskAiId === normalizedTargetId || taskParentId === normalizedTargetId;
  }

  function hasAbortableRequest(target = null) {
    const hasDelayedRetryJob = Array.from(conversationSendQueues.values()).some((queue) => (
      Array.isArray(queue) && queue.some((task) => normalizeConversationQueuedTask(task).status === 'delayed_retry')
    ));
    if (!activeAttempts.size && !hasDelayedRetryJob) return false;
    if (!target) return activeAttempts.size > 0 || hasDelayedRetryJob;

    const { targetElement, normalizedTargetId } = resolveAbortTarget(target);
    if (!targetElement && !normalizedTargetId) {
      return activeAttempts.size > 0 || hasDelayedRetryJob;
    }

    for (const attempt of activeAttempts.values()) {
      if (doesAttemptMatchAbortTarget(attempt, targetElement, normalizedTargetId)) {
        return true;
      }
    }
    for (const queue of conversationSendQueues.values()) {
      const hasMatchingRetryJob = (Array.isArray(queue) ? queue : []).some((task) => {
        const normalizedTask = normalizeConversationQueuedTask(task);
        return normalizedTask.status === 'delayed_retry'
          && doesQueuedTaskMatchAbortTarget(normalizedTask, normalizedTargetId);
      });
      if (hasMatchingRetryJob) {
        return true;
      }
    }
    return false;
  }

  function resolveAttemptMessageNode(attemptState, messageId) {
    const normalizedId = normalizeConversationId(messageId);
    if (!normalizedId) return null;

    const activeNode = chatHistoryManager?.chatHistory?.messages?.find?.(m => m.id === normalizedId) || null;
    if (activeNode) return activeNode;

    const fallbackList = Array.isArray(attemptState?.historyMessagesRef)
      ? attemptState.historyMessagesRef
      : [];
    return fallbackList.find(m => m.id === normalizedId) || null;
  }

  function resolveAttemptAiNode(attemptState, messageId) {
    return resolveAttemptMessageNode(attemptState, messageId);
  }

  function isConversationIdCurrentlyActive(conversationId) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (!normalizedConversationId) return true;
    const activeConversationId = normalizeConversationId(currentConversationId)
      || normalizeConversationId(chatHistoryUI?.getCurrentConversationId?.());
    return !!(normalizedConversationId && activeConversationId && normalizedConversationId === activeConversationId);
  }

  function findVisibleMessageElementById(messageId) {
    const safeMessageId = escapeMessageIdForSelector(messageId);
    if (!safeMessageId) return null;
    const selector = `.message[data-message-id="${safeMessageId}"]`;
    return chatContainer.querySelector(selector)
      || (threadContainer ? threadContainer.querySelector(selector) : null)
      || null;
  }

  /**
   * 解析“本次 regenerate / retry 真正要复用的 AI 目标消息”。
   *
   * 为什么要集中做这一层：
   * - 旧逻辑在不同阶段分别各自查 history / DOM，容易出现“开始发送时没认出目标，因此额外创建 loading 占位；
   *   但原始待替换消息其实还在”的分裂状态；
   * - 把目标解析统一后，开始发送、报错回写、手动重试三个阶段都能围绕同一目标工作。
   *
   * @param {{ attemptState?: Object|null, targetAiMessageId?: string|null }} options
   * @returns {{
   *   targetAiMessageId: string|null,
   *   targetNode: Object|null,
   *   targetElement: HTMLElement|null,
   *   canReplaceInPlace: boolean
   * }}
   */
  function resolveRetryOrRegenerateTargetBinding(options = {}) {
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const targetAiMessageId = normalizeConversationId(normalizedOptions.targetAiMessageId);
    if (!targetAiMessageId) {
      return {
        targetAiMessageId: null,
        targetNode: null,
        targetElement: null,
        canReplaceInPlace: false
      };
    }

    const candidateNode = resolveAttemptAiNode(normalizedOptions.attemptState || null, targetAiMessageId);
    const role = String(candidateNode?.role || '').trim().toLowerCase();
    const targetNode = (role === 'assistant' || role === 'ai') ? candidateNode : null;

    const candidateElement = findVisibleMessageElementById(targetAiMessageId);
    const targetElement = candidateElement instanceof HTMLElement ? candidateElement : null;

    return {
      targetAiMessageId,
      targetNode,
      targetElement,
      canReplaceInPlace: canReplaceRetryOrRegenerateInPlace({
        targetAiMessageId,
        hasTargetNode: !!targetNode,
        hasTargetElement: !!targetElement
      })
    };
  }

  /**
   * 查找“某条用户消息后方、可被 regenerate 复用”的临时 AI 占位气泡。
   *
   * 典型来源：
   * - 首 token 前失败时留下的无 message-id 错误提示；
   * - 带重试按钮的临时错误消息；
   * - 某些还未成功晋升为正式 AI 历史节点的 loading 占位。
   *
   * 设计约束：
   * - 只检查“该用户消息后的第一条 AI 消息”，不跨越到更后面的其它 AI；
   * - 一旦第一条 AI 已经有稳定 message-id，说明它是正式历史节点，不应被当作临时占位复用。
   *
   * @param {{ userMessageId?: string|null }} options
   * @returns {HTMLElement|null}
   */
  function resolveTransientRegeneratePlaceholder(options = {}) {
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const userMessageId = normalizeConversationId(normalizedOptions.userMessageId);
    if (!userMessageId) return null;

    const userElement = findVisibleMessageElementById(userMessageId);
    if (!(userElement instanceof HTMLElement)) return null;

    let cursor = userElement.nextElementSibling;
    while (cursor) {
      if (!(cursor instanceof HTMLElement)) {
        cursor = cursor.nextElementSibling;
        continue;
      }
      if (!cursor.classList?.contains('message')) {
        cursor = cursor.nextElementSibling;
        continue;
      }
      if (cursor.classList.contains('user-message')) {
        return null;
      }
      if (!cursor.classList.contains('ai-message')) {
        return null;
      }

      const boundMessageId = normalizeConversationId(cursor.getAttribute('data-message-id') || '');
      const reusable = shouldReuseTransientRegeneratePlaceholder({
        isAiMessage: true,
        hasBoundMessageId: !!boundMessageId,
        isErrorMessage: cursor.classList.contains('error-message'),
        isLoadingMessage: cursor.classList.contains('loading-message'),
        hasRetryActions: !!cursor.querySelector('.error-retry-actions')
      });
      return reusable ? cursor : null;
    }

    return null;
  }

  /**
   * 查找“某条用户消息后面的第一条 AI 消息”，用于 regenerate 的最终兜底。
   *
   * 适用场景：
   * - 编辑用户消息后立刻重新生成时，当前上下文里的 targetAiMessageId 可能暂时丢失；
   * - 但从用户消息在当前 DOM 的可见顺序看，“它后面的第一条 AI”仍然就是要被替换的目标。
   *
   * 这里不区分正式 AI 与临时错误占位，交给调用方按是否有 bound message-id 决定：
   * - 有 message-id：走“原地替换正式 AI”；
   * - 无 message-id：走“复用临时错误/加载占位”。
   *
   * @param {{ userMessageId?: string|null }} options
   * @returns {{ element: HTMLElement|null, targetAiMessageId: string|null }}
   */
  function resolveAdjacentRegenerateTargetCandidate(options = {}) {
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const userMessageId = normalizeConversationId(normalizedOptions.userMessageId);
    if (!userMessageId) {
      return { element: null, targetAiMessageId: null };
    }

    const userElement = findVisibleMessageElementById(userMessageId);
    if (!(userElement instanceof HTMLElement)) {
      return { element: null, targetAiMessageId: null };
    }

    let cursor = userElement.nextElementSibling;
    while (cursor) {
      if (!(cursor instanceof HTMLElement)) {
        cursor = cursor.nextElementSibling;
        continue;
      }
      if (!cursor.classList?.contains('message')) {
        cursor = cursor.nextElementSibling;
        continue;
      }
      if (cursor.classList.contains('user-message')) {
        return { element: null, targetAiMessageId: null };
      }
      if (!cursor.classList.contains('ai-message')) {
        return { element: null, targetAiMessageId: null };
      }
      const boundMessageId = normalizeConversationId(cursor.getAttribute('data-message-id') || '');
      return {
        element: cursor,
        targetAiMessageId: boundMessageId || null
      };
    }

    return { element: null, targetAiMessageId: null };
  }

  function captureMessageElementImageDescriptors(messageElement) {
    if (!messageElement) return [];
    return Array.from(messageElement.querySelectorAll('.image-content .image-tag'))
      .map((tag) => {
        const base64Data = tag.getAttribute('data-image') || tag.querySelector('img')?.src || '';
        const fileName = tag.getAttribute('title') || tag.querySelector('img')?.getAttribute('alt') || '';
        if (!base64Data) return null;
        return { url: base64Data, fileName };
      })
      .filter(Boolean);
  }

  async function loadConversationMutationContext(conversationId) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (!normalizedConversationId || isConversationIdCurrentlyActive(normalizedConversationId)) {
      return {
        conversationId: normalizedConversationId,
        isActive: true,
        chatHistory: chatHistoryManager.chatHistory
      };
    }
    const snapshot = await chatHistoryUI?.getConversationSnapshotById?.(normalizedConversationId);
    if (!snapshot || !Array.isArray(snapshot.messages)) {
      throw new Error(`找不到会话 ${normalizedConversationId} 的历史快照`);
    }
    snapshot.conversationRevision = normalizeConversationHistoryRevision(snapshot.conversationRevision);
    return {
      conversationId: normalizedConversationId,
      isActive: false,
      chatHistory: snapshot
    };
  }

  async function saveConversationMutationContext(context) {
    if (!context?.chatHistory || typeof chatHistoryUI?.saveCurrentConversation !== 'function') return null;
    const normalizedConversationId = normalizeConversationId(context.conversationId);
    const shouldUpdateActiveState = context.isActive !== false;
    return chatHistoryUI.saveCurrentConversation(!!normalizedConversationId, {
      conversationId: normalizedConversationId || undefined,
      chatHistoryOverride: {
        messages: context.chatHistory.messages,
        conversationRevision: normalizeConversationHistoryRevision(context.chatHistory.conversationRevision)
      },
      updateActiveState: shouldUpdateActiveState,
      preserveExistingApiLock: true
    });
  }

  function updateVisibleMessageElementForEdit(messageId, newText, imageDescriptors, role) {
    const messageElement = findVisibleMessageElementById(messageId);
    if (!messageElement) return;

    try {
      let imageContainerEl = messageElement.querySelector('.image-content');
      if (Array.isArray(imageDescriptors) && imageDescriptors.length > 0) {
        if (!imageContainerEl) {
          imageContainerEl = document.createElement('div');
          imageContainerEl.className = 'image-content';
          const textDiv = messageElement.querySelector('.text-content');
          if (textDiv && textDiv.parentNode === messageElement) {
            messageElement.insertBefore(imageContainerEl, textDiv);
          } else {
            messageElement.prepend(imageContainerEl);
          }
        }
        imageContainerEl.innerHTML = '';
        const fragment = document.createDocumentFragment();
        imageDescriptors.forEach((image) => {
          const imageTag = imageHandler?.createImageTag?.(image.url, image.fileName || '');
          if (imageTag) fragment.appendChild(imageTag);
        });
        imageContainerEl.appendChild(fragment);
      } else if (imageContainerEl) {
        imageContainerEl.remove();
      }
    } catch (error) {
      console.warn('同步编辑后的图片 DOM 失败:', error);
    }

    const textDiv = messageElement.querySelector('.text-content');
    if (textDiv) {
      if (String(role || '').toLowerCase() === 'user') {
        textDiv.innerText = newText;
      } else {
        const processed = messageProcessor.processMathAndMarkdown(newText);
        textDiv.innerHTML = processed;
        messageProcessor.enhanceMarkdownContent?.(textDiv, { forceMermaid: true });
      }
    }
    messageElement.setAttribute('data-original-text', newText);
  }

  function hasRunningAttemptForConversationQueue(queueKey) {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    for (const attemptState of activeAttempts.values()) {
      if (doesAttemptBelongToConversationQueueKey(attemptState, normalizedQueueKey)) {
        return true;
      }
    }
    return false;
  }

  function getLatestRunningAttemptForConversationQueue(queueKey) {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    let latestAttempt = null;
    for (const attemptState of activeAttempts.values()) {
      if (!doesAttemptBelongToConversationQueueKey(attemptState, normalizedQueueKey)) continue;
      if (!latestAttempt) {
        latestAttempt = attemptState;
        continue;
      }
      const currentStartedAt = Number(attemptState?.startedAt) || 0;
      const latestStartedAt = Number(latestAttempt?.startedAt) || 0;
      if (currentStartedAt >= latestStartedAt) {
        latestAttempt = attemptState;
      }
    }
    return latestAttempt;
  }

  function getLatestRunningAttemptForCurrentConversationUi() {
    const activeId = normalizeConversationId(currentConversationId)
      || normalizeConversationId(chatHistoryUI?.getCurrentConversationId?.());
    return selectLatestRunningAttemptForCurrentConversation(
      Array.from(activeAttempts.values()),
      activeId
    );
  }

  function setConversationSteerRuntime(queueKey, steerStatePatch = {}) {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    if (!normalizedQueueKey) return null;
    const patch = (steerStatePatch && typeof steerStatePatch === 'object') ? steerStatePatch : {};
    const snapshot = updateConversationRuntimeStateByKey(normalizedQueueKey, (draft) => {
      draft.steer.pendingSteers = Array.isArray(patch.pendingSteers)
        ? patch.pendingSteers.map((steer) => normalizePendingConversationSteer(steer))
        : [];
      draft.steer.targetTurnId = (typeof patch.targetTurnId === 'string' && patch.targetTurnId.trim())
        ? patch.targetTurnId.trim()
        : null;
      draft.steer.targetTurnStartedAtMs = Number.isFinite(Number(patch.targetTurnStartedAtMs))
        ? Number(patch.targetTurnStartedAtMs)
        : null;
    });
    refreshCurrentConversationQueuedSendPreview();
    return snapshot;
  }

  function getConversationPendingSteers(queueKey) {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    if (!normalizedQueueKey || !conversationRuntimeStore?.getConversationRuntimeState) return [];
    const snapshot = conversationRuntimeStore.getConversationRuntimeState(normalizedQueueKey);
    return Array.isArray(snapshot?.steer?.pendingSteers)
      ? snapshot.steer.pendingSteers.map((steer) => normalizePendingConversationSteer(steer))
      : [];
  }

  function getAttemptSteerTargetIdentity(attemptState) {
    return buildAttemptSteerTargetIdentity(attemptState);
  }

  function removeConversationPendingSteersByIds(queueKey, steerIds, targetAttempt = null) {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    const steerIdSet = new Set(
      Array.isArray(steerIds)
        ? steerIds
          .map((id) => (typeof id === 'string' ? id.trim() : ''))
          .filter(Boolean)
        : []
    );
    if (!normalizedQueueKey || steerIdSet.size <= 0) return getConversationPendingSteers(normalizedQueueKey);

    if (targetAttempt && !targetAttempt.finished && Array.isArray(targetAttempt.pendingSteers)) {
      targetAttempt.pendingSteers = targetAttempt.pendingSteers
        .map((steer) => normalizePendingConversationSteer(steer))
        .filter((steer) => !steerIdSet.has(String(steer?.id || '').trim()));
    }

    const existing = getConversationPendingSteers(normalizedQueueKey);
    const remaining = existing.filter((steer) => !steerIdSet.has(String(steer?.id || '').trim()));
    const latestRemaining = remaining[remaining.length - 1] || null;
    setConversationSteerRuntime(normalizedQueueKey, {
      pendingSteers: remaining,
      targetTurnId: latestRemaining?.targetTurnId || null,
      targetTurnStartedAtMs: latestRemaining?.targetTurnStartedAtMs ?? null
    });
    return remaining;
  }

  function getConversationPendingSteersForAttempt(attemptState) {
    if (!attemptState) return [];
    const { turnIds, turnStartedAtMs } = buildPendingSteerMatchOptionsForAttempt(attemptState);
    const localPendingSteers = Array.isArray(attemptState.pendingSteers)
      ? attemptState.pendingSteers.map((steer) => normalizePendingConversationSteer(steer))
      : [];
    if (localPendingSteers.length > 0) {
      return splitPendingSteersByTurnIds(localPendingSteers, {
        turnIds,
        turnStartedAtMs
      }).matched.map((steer) => normalizePendingConversationSteer(steer));
    }

    const runtimeConversationKey = getAttemptRuntimeConversationKey(attemptState);
    const pendingSteers = getConversationPendingSteers(runtimeConversationKey);
    if (pendingSteers.length <= 0) return [];
    return splitPendingSteersByTurnIds(pendingSteers, {
      turnIds,
      turnStartedAtMs
    }).matched.map((steer) => normalizePendingConversationSteer(steer));
  }

  function appendConversationPendingSteer(queueKey, pendingSteer, targetAttempt = null) {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    const targetIdentity = getAttemptSteerTargetIdentity(targetAttempt);
    const normalizedSteer = normalizePendingConversationSteer({
      ...(pendingSteer && typeof pendingSteer === 'object' ? pendingSteer : {}),
      targetTurnId: targetIdentity.turnId || pendingSteer?.targetTurnId || null,
      targetTurnStartedAtMs: targetIdentity.turnStartedAtMs ?? pendingSteer?.targetTurnStartedAtMs ?? null
    });
    if (targetAttempt && !targetAttempt.finished) {
      const existingLocalPendingSteers = Array.isArray(targetAttempt.pendingSteers)
        ? targetAttempt.pendingSteers.map((steer) => normalizePendingConversationSteer(steer))
        : [];
      targetAttempt.pendingSteers = existingLocalPendingSteers.concat([normalizedSteer]);
    }
    const existing = getConversationPendingSteers(normalizedQueueKey);
    return setConversationSteerRuntime(normalizedQueueKey, {
      pendingSteers: existing.concat([normalizedSteer]),
      targetTurnId: normalizedSteer.targetTurnId || null,
      targetTurnStartedAtMs: normalizedSteer.targetTurnStartedAtMs ?? Date.now()
    });
  }

  function markConversationQueuedJobsStale(queueKey, conversationRevision) {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    const nextRevision = normalizeConversationHistoryRevision(conversationRevision);
    const queue = getConversationSendQueue(normalizedQueueKey);
    let changed = false;
    queue.forEach((task, index) => {
      const normalizedTask = normalizeConversationQueuedTask(task);
      if (isConversationJobTerminal(normalizedTask) || normalizedTask.status === 'running') return;
      if (normalizedTask.conversationRevisionAtEnqueue >= nextRevision) return;
      if (normalizedTask.status === 'stale' && normalizedTask.staleReason === 'history_mutated') return;
      queue[index] = normalizeConversationQueuedTask({
        ...normalizedTask,
        status: 'stale',
        paused: true,
        availableAt: null,
        staleReason: 'history_mutated'
      });
      changed = true;
    });
    if (changed) {
      refreshConversationQueueState(normalizedQueueKey);
    }
    return changed;
  }

  /**
   * 标准 steer：把新的用户输入挂到当前 in-flight turn 的 pending steers 上。
   *
   * 关键语义（对齐 Codex）：
   * - 不新开 turn；
   * - 不先 interrupt；
   * - 不碰当前 queue；
   * - 只在当前 active turn 的下一个安全边界被吸收。
   */
  async function requestConversationSteer({ queueKey, pendingSteer, targetAttempt = null } = {}) {
    const normalizedSteer = normalizePendingConversationSteer(pendingSteer);
    if (!normalizedSteer?.responseInputItem) {
      return { ok: false, error: new Error('invalid_pending_steer') };
    }

    const resolvedTargetAttempt = targetAttempt
      || getLatestRunningAttemptForConversationQueue(resolveConversationQueueKey(queueKey));
    if (!resolvedTargetAttempt) {
      return { ok: false, reason: 'no_active_turn', error: new Error('当前没有可转向的生成') };
    }
    if (resolvedTargetAttempt.supportsStandardSteer !== true) {
      return { ok: false, reason: 'unsupported_turn_transport', error: new Error('当前连接源不支持标准 steer') };
    }

    const runtimeConversationKey = getAttemptRuntimeConversationKey(
      resolvedTargetAttempt,
      resolveConversationQueueKey(queueKey)
    );
    if (!runtimeConversationKey) {
      return { ok: false, reason: 'invalid_target_attempt', error: new Error('无法解析当前生成所属会话') };
    }

    appendConversationPendingSteer(runtimeConversationKey, normalizedSteer, resolvedTargetAttempt);
    return {
      ok: true,
      pending: true,
      targetTurnId: getAttemptSteerTargetIdentity(resolvedTargetAttempt).turnId,
      pendingCount: getConversationPendingSteers(runtimeConversationKey).length
    };
  }

  function restorePendingSteersForAttemptAsQueueFollowUps(attemptState) {
    if (!attemptState) return [];
    const runtimeConversationKey = getAttemptRuntimeConversationKey(attemptState);
    const pendingSteers = getConversationPendingSteersForAttempt(attemptState);
    if (pendingSteers.length <= 0) return [];

    removeConversationPendingSteersByIds(
      runtimeConversationKey,
      pendingSteers.map((steer) => steer.id),
      attemptState
    );

    const restoreDisposition = resolvePendingSteerRestoreDisposition(
      attemptState.completedSuccessfully
        ? 'completed'
        : (attemptState.manualAbort ? 'interrupted' : 'error')
    );
    const restoredJobs = buildRestoredQueueJobsFromPendingSteers(pendingSteers, {
      createJobId: createQueuedConversationTaskId,
      conversationId: normalizeConversationId(attemptState.boundConversationId) || normalizeConversationId(runtimeConversationKey),
      conversationRevisionAtEnqueue: attemptState.historyConversationRevision,
      retryPolicy: buildDefaultConversationJobRetryPolicy('append_user_message'),
      status: restoreDisposition.status,
      failureMessage: restoreDisposition.failureMessage,
      createdAt: Date.now()
    }).map((job) => normalizeConversationQueuedTask(job));

    for (let index = restoredJobs.length - 1; index >= 0; index -= 1) {
      enqueueConversationSend(runtimeConversationKey, restoredJobs[index], { atFront: true });
    }

    if (restoreDisposition.status === 'queued') {
      scheduleConversationQueueFlush(runtimeConversationKey);
    }
    return restoredJobs;
  }

  async function dispatchConversationJob(queueKey, queuedTask, options = {}) {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const nextTask = normalizeConversationQueuedTask(queuedTask);
    const hasPendingWork = hasPendingWorkForConversationQueue(normalizedQueueKey);
    const hasQueuedMessages = hasQueuedMessagesForConversation(normalizedQueueKey);
    const canBypassQueuedMessages = normalizedOptions.ignoreQueuedMessages === true;
    if (!hasPendingWork && (!hasQueuedMessages || canBypassQueuedMessages) && normalizedOptions.forceQueue !== true) {
      return executeConversationQueueJob(normalizedQueueKey, nextTask);
    }
    enqueueConversationSend(normalizedQueueKey, nextTask, { atFront: normalizedOptions.atFront === true });
    scheduleConversationQueueFlush(normalizedQueueKey);
    return { ok: true, queued: true, queueLength: getConversationSendQueue(normalizedQueueKey).length };
  }

  function enqueuePendingConversationMutation(queueKey, descriptor) {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    const pendingList = pendingConversationMutations.get(normalizedQueueKey) || [];
    pendingList.push({
      ...descriptor,
      createdAt: Number.isFinite(Number(descriptor?.createdAt)) ? Number(descriptor.createdAt) : Date.now()
    });
    pendingConversationMutations.set(normalizedQueueKey, pendingList);
    refreshConversationQueueState(normalizedQueueKey);
  }

  async function applyPendingConversationMutationsIfIdle(queueKey) {
    const normalizedQueueKey = resolveConversationQueueKey(queueKey);
    if (hasRunningAttemptForConversationQueue(normalizedQueueKey)) return false;
    const pendingList = pendingConversationMutations.get(normalizedQueueKey);
    if (!Array.isArray(pendingList) || pendingList.length === 0) return false;
    pendingConversationMutations.delete(normalizedQueueKey);
    refreshConversationQueueState(normalizedQueueKey);
    for (const mutation of pendingList) {
      try {
        await mutation.apply?.(normalizedQueueKey);
      } catch (error) {
        console.error('应用挂起的历史修改失败:', error);
      }
    }
    refreshConversationQueueState(normalizedQueueKey);
    return true;
  }

  async function requestConversationHistoryEdit({ messageId, newText, messageElement = null, conversationId = '' } = {}) {
    const normalizedMessageId = normalizeConversationId(messageId);
    if (!normalizedMessageId) return { ok: false, reason: 'missing_message_id' };
    const targetConversationId = normalizeConversationId(conversationId)
      || normalizeConversationId(currentConversationId)
      || normalizeConversationId(chatHistoryUI?.getCurrentConversationId?.());
    const targetQueueKey = resolveConversationQueueKey(targetConversationId);
    const imageDescriptors = captureMessageElementImageDescriptors(messageElement);
    const descriptor = {
      type: 'edit_message',
      createdAt: Date.now(),
      apply: async (effectiveQueueKey = targetQueueKey) => {
        const effectiveConversationId = normalizeConversationId(effectiveQueueKey) || targetConversationId;
        const context = await loadConversationMutationContext(effectiveConversationId);
        const node = Array.isArray(context.chatHistory?.messages)
          ? context.chatHistory.messages.find((item) => item?.id === normalizedMessageId)
          : null;
        if (!node) {
          throw new Error('未找到待编辑的消息节点');
        }
        const hasText = typeof newText === 'string' && newText.trim() !== '';
        const normalizedImages = Array.isArray(imageDescriptors) ? imageDescriptors : [];
        if (Array.isArray(node.content)) {
          const nextParts = normalizedImages.map((image) => ({
            type: 'image_url',
            image_url: { url: image.url }
          }));
          if (hasText) {
            nextParts.push({ type: 'text', text: newText });
          }
          node.content = nextParts;
        } else if (normalizedImages.length > 0) {
          node.content = hasText
            ? [
              ...normalizedImages.map((image) => ({ type: 'image_url', image_url: { url: image.url } })),
              { type: 'text', text: newText }
            ]
            : normalizedImages.map((image) => ({ type: 'image_url', image_url: { url: image.url } }));
        } else {
          node.content = newText;
        }
        node.outboundContent = cloneDataSafely(node.content);
        context.chatHistory.conversationRevision = normalizeConversationHistoryRevision(context.chatHistory.conversationRevision) + 1;
        markConversationQueuedJobsStale(effectiveQueueKey, context.chatHistory.conversationRevision);
        await saveConversationMutationContext(context);
        if (context.isActive) {
          updateVisibleMessageElementForEdit(normalizedMessageId, newText, normalizedImages, node.role);
        }
      }
    };

    if (hasRunningAttemptForConversationQueue(targetQueueKey)) {
      enqueuePendingConversationMutation(targetQueueKey, descriptor);
      showNotification?.({ message: '当前仍在生成，本次编辑将在结束后自动应用', type: 'info', duration: 1800 });
      return { ok: true, deferred: true };
    }
    await descriptor.apply();
    return { ok: true, deferred: false };
  }

  async function requestConversationMessageDeletion({ messageId, conversationId = '' } = {}) {
    const normalizedMessageId = normalizeConversationId(messageId);
    if (!normalizedMessageId) return { ok: false, reason: 'missing_message_id' };
    const targetConversationId = normalizeConversationId(conversationId)
      || normalizeConversationId(currentConversationId)
      || normalizeConversationId(chatHistoryUI?.getCurrentConversationId?.());
    const targetQueueKey = resolveConversationQueueKey(targetConversationId);
    const descriptor = {
      type: 'delete_message',
      createdAt: Date.now(),
      apply: async (effectiveQueueKey = targetQueueKey) => {
        const effectiveConversationId = normalizeConversationId(effectiveQueueKey) || targetConversationId;
        const context = await loadConversationMutationContext(effectiveConversationId);
        const node = Array.isArray(context.chatHistory?.messages)
          ? context.chatHistory.messages.find((item) => item?.id === normalizedMessageId)
          : null;
        const threadId = node?.threadId || null;
        const deleted = deleteMessageFromChatHistory(context.chatHistory, normalizedMessageId);
        if (!deleted) {
          throw new Error('未找到待删除的消息节点');
        }
        context.chatHistory.conversationRevision = normalizeConversationHistoryRevision(context.chatHistory.conversationRevision) + 1;
        markConversationQueuedJobsStale(effectiveQueueKey, context.chatHistory.conversationRevision);
        await saveConversationMutationContext(context);
        if (context.isActive) {
          findVisibleMessageElementById(normalizedMessageId)?.remove();
          if (threadId) {
            services.selectionThreadManager?.repairThreadAnnotation?.(threadId);
          }
        }
      }
    };

    if (hasRunningAttemptForConversationQueue(targetQueueKey)) {
      enqueuePendingConversationMutation(targetQueueKey, descriptor);
      showNotification?.({ message: '当前仍在生成，本次删除将在结束后自动应用', type: 'info', duration: 1800 });
      return { ok: true, deferred: true };
    }
    await descriptor.apply();
    return { ok: true, deferred: false };
  }

  async function requestRegenerateMessage(options = {}) {
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const targetConversationId = normalizeConversationId(normalizedOptions.conversationId)
      || normalizeConversationId(currentConversationId)
      || normalizeConversationId(chatHistoryUI?.getCurrentConversationId?.());
    const targetQueueKey = resolveConversationQueueKey(targetConversationId);
    const descriptor = {
      type: 'regenerate_message',
      createdAt: Date.now(),
      apply: async (effectiveQueueKey = targetQueueKey) => {
        const effectiveConversationId = normalizeConversationId(effectiveQueueKey) || targetConversationId;
        const context = await loadConversationMutationContext(effectiveConversationId);
        const nextRevision = normalizeConversationHistoryRevision(context.chatHistory?.conversationRevision) + 1;
        context.chatHistory.conversationRevision = nextRevision;
        await saveConversationMutationContext(context);
        markConversationQueuedJobsStale(effectiveQueueKey, nextRevision);
        const regenerateJob = normalizeConversationQueuedTask({
          kind: 'regenerate_assistant_turn',
          status: 'queued',
          paused: false,
          conversationId: effectiveConversationId,
          conversationRevisionAtEnqueue: nextRevision,
          anchorMessageId: normalizedOptions.messageId || '',
          targetAiMessageId: normalizedOptions.targetAiMessageId || '',
          payload: {
            originalMessageText: normalizedOptions.originalMessageText,
            regenerateMode: true,
            messageId: normalizedOptions.messageId,
            targetAiMessageId: normalizedOptions.targetAiMessageId || null,
            api: normalizedOptions.api ?? null,
            resolvedApiConfig: normalizedOptions.resolvedApiConfig ?? null,
            specificPromptType: normalizedOptions.specificPromptType ?? null,
            promptMeta: normalizedOptions.promptMeta ?? null
          }
        });
        await dispatchConversationJob(effectiveQueueKey, regenerateJob, {
          atFront: true,
          ignoreQueuedMessages: true
        });
      }
    };

    if (hasRunningAttemptForConversationQueue(targetQueueKey)) {
      enqueuePendingConversationMutation(targetQueueKey, descriptor);
      showNotification?.({ message: '当前仍在生成，本次重新生成将在结束后自动应用', type: 'info', duration: 1800 });
      return { ok: true, deferred: true };
    }
    await descriptor.apply();
    return { ok: true, deferred: false };
  }

  function bindAttemptAiMessage(attemptState, messageId, explicitNode = null) {
    if (!attemptState) return;
    const normalizedId = normalizeConversationId(messageId);
    if (!normalizedId) return;
    attemptState.aiMessageId = normalizedId;
    attemptState.aiMessageNode = explicitNode || resolveAttemptAiNode(attemptState, normalizedId) || null;
    updateAttemptRuntimeState(attemptState, (draft) => {
      draft.activeTurn.boundAssistantMessageId = normalizedId;
    });
  }

  function isAttemptMainConversationActive(attemptState) {
    const boundId = normalizeConversationId(attemptState?.boundConversationId);
    if (!boundId) return true;
    const activeId = normalizeConversationId(currentConversationId)
      || normalizeConversationId(chatHistoryUI?.getCurrentConversationId?.());
    return !!(activeId && activeId === boundId);
  }

  function captureAttemptConversationContext(attemptState) {
    if (!attemptState) return;
    if (!Array.isArray(attemptState.historyMessagesRef)) {
      attemptState.historyMessagesRef = chatHistoryManager?.chatHistory?.messages || [];
    }
    if (!normalizeConversationId(attemptState.boundConversationId)) {
      const fromSenderState = normalizeConversationId(currentConversationId);
      const fromHistoryUi = normalizeConversationId(chatHistoryUI?.getCurrentConversationId?.());
      updateAttemptBoundConversationId(attemptState, fromSenderState || fromHistoryUi || '');
    }
    if (attemptState.boundApiLock === undefined) {
      attemptState.boundApiLock = chatHistoryUI?.getActiveConversationApiLock?.() || null;
    }
    if (!attemptState.runtimeConversationKey) {
      attemptState.runtimeConversationKey = getAttemptRuntimeConversationKey(attemptState);
    }
    if (!Number.isFinite(Number(attemptState.historyConversationRevision))) {
      attemptState.historyConversationRevision = resolveConversationHistoryRevision(
        attemptState.boundConversationId,
        attemptState.historyConversationRevision
      );
    }
    if (!normalizeResponsesPromptCacheKey(attemptState.historyPromptCacheKey)) {
      attemptState.historyPromptCacheKey = normalizeResponsesPromptCacheKey(
        chatHistoryManager?.getConversationPromptCacheKey?.()
          || chatHistoryManager?.chatHistory?.promptCacheKey
      );
    }
  }

  function isAttemptUsingDetachedMainConversationHistory(attemptState) {
    const historyMessages = Array.isArray(attemptState?.historyMessagesRef)
      ? attemptState.historyMessagesRef
      : null;
    if (!historyMessages) return false;
    const activeHistoryMessages = chatHistoryManager?.chatHistory?.messages || [];
    return !attemptState?.threadContext && historyMessages !== activeHistoryMessages;
  }

  async function persistAttemptConversationSnapshot(attemptState, options = {}) {
    if (!attemptState || typeof chatHistoryUI?.saveCurrentConversation !== 'function') return null;
    captureAttemptConversationContext(attemptState);

    const historyMessages = Array.isArray(attemptState.historyMessagesRef)
      ? attemptState.historyMessagesRef
      : null;
    if (!historyMessages || historyMessages.length === 0) return null;

    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const force = !!normalizedOptions.force;

    const now = Date.now();
    if (!force && Number.isFinite(attemptState.lastPersistAt)) {
      const elapsed = now - attemptState.lastPersistAt;
      if (elapsed >= 0 && elapsed < STREAM_DRAFT_SAVE_INTERVAL_MS) {
        return null;
      }
    }

    if (attemptState.persistInFlight) {
      if (force) {
        attemptState.pendingForcedPersist = true;
      } else {
        attemptState.pendingPersist = true;
      }
      return attemptState.persistPromise || null;
    }

    attemptState.persistInFlight = true;
    attemptState.persistPromise = (async () => {
      const boundId = normalizeConversationId(attemptState.boundConversationId);
      const activeId = normalizeConversationId(chatHistoryUI?.getCurrentConversationId?.());
      const shouldActivate = isAttemptMainConversationActive(attemptState);

      const savedConversation = await chatHistoryUI.saveCurrentConversation(!!boundId, {
        conversationId: boundId || undefined,
        chatHistoryOverride: {
          messages: historyMessages,
          conversationRevision: normalizeConversationHistoryRevision(attemptState.historyConversationRevision),
          promptCacheKey: normalizeResponsesPromptCacheKey(attemptState.historyPromptCacheKey)
        },
        // 若当前界面已切到其它会话，只做后台落库，不反向抢占 UI 当前会话。
        updateActiveState: shouldActivate,
        preserveExistingApiLock: true,
        apiLockOverride: attemptState.boundApiLock
      });

      const savedId = normalizeConversationId(savedConversation?.id)
        || boundId
        || (shouldActivate ? activeId : '');
      if (savedConversation) {
        attemptState.historyConversationRevision = normalizeConversationHistoryRevision(
          savedConversation.conversationRevision
        );
        attemptState.historyPromptCacheKey = normalizeResponsesPromptCacheKey(
          savedConversation?.promptCacheKey || attemptState.historyPromptCacheKey
        );
      }
      if (savedId) {
        updateAttemptBoundConversationId(attemptState, savedId);
        if (shouldActivate) {
          updateCurrentConversationContext(savedId);
        }
      }
      attemptState.lastPersistAt = Date.now();
      return savedConversation || null;
    })()
      .catch((error) => {
        console.warn('后台保存会话草稿失败:', error);
        return null;
      })
      .finally(() => {
        attemptState.persistInFlight = false;
        attemptState.persistPromise = null;
        const shouldForceNext = !!attemptState.pendingForcedPersist;
        const shouldPersistNext = shouldForceNext || !!attemptState.pendingPersist;
        attemptState.pendingForcedPersist = false;
        attemptState.pendingPersist = false;
        if (shouldPersistNext) {
          setTimeout(() => {
            void persistAttemptConversationSnapshot(attemptState, { force: shouldForceNext });
          }, 0);
        }
      });

    return attemptState.persistPromise;
  }

  function createAssistantHistoryNodeForDetachedList(payload) {
    const {
      content,
      thoughts,
      historyParentId,
      historyPatch,
      historyMessagesRef
    } = payload || {};
    const targetMessages = Array.isArray(historyMessagesRef) ? historyMessagesRef : null;
    if (!targetMessages) return null;

    const processedContent = imageHandler.processImageTags(content || '', null);
    const node = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      role: 'assistant',
      content: processedContent,
      parentId: historyParentId || null,
      children: [],
      timestamp: Date.now(),
      thoughtsRaw: null,
      thoughtSignature: null,
      thoughtSignatureSource: null,
      reasoning_content: null,
      tool_calls: null,
      phase: null,
      response_activity_timeline: null,
      response_activity_duration_ms: null,
      response_input_items: null,
      apiUuid: null,
      apiDisplayName: '',
      apiModelId: '',
      apiUsage: null,
      responseTiming: null,
      hasInlineImages: false,
      promptType: null,
      promptMeta: null,
      preprocessOriginalText: null,
      preprocessRenderedText: null,
      outboundContent: null,
      contextual_input_items_before: null,
      pageRuntimeContextSignature: null,
      environmentContextSignature: null,
      contextCompactionMarker: null,
      responsesLocalCompactionStatus: null,
      pageMeta: null
    };

    targetMessages.push(node);
    if (historyParentId) {
      const parentNode = targetMessages.find(m => m && m.id === historyParentId);
      if (parentNode) {
        if (!Array.isArray(parentNode.children)) {
          parentNode.children = [];
        }
        parentNode.children.push(node.id);
      }
    }
    if (thoughts !== undefined) {
      node.thoughtsRaw = thoughts;
    }
    if (historyPatch && typeof historyPatch === 'object') {
      Object.assign(node, historyPatch);
    }
    node.hasInlineImages = Array.isArray(processedContent) && processedContent.some(p => p?.type === 'image_url');
    return node;
  }

  function createUserHistoryNodeForDetachedList(payload) {
    const {
      content,
      imagesHTML,
      historyParentId,
      historyPatch,
      meta,
      historyMessagesRef,
      pageMeta = null
    } = payload || {};
    const targetMessages = Array.isArray(historyMessagesRef) ? historyMessagesRef : null;
    if (!targetMessages) return null;

    const processedContent = imageHandler.processImageTags(content || '', imagesHTML || '');
    const node = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      role: 'user',
      content: processedContent,
      parentId: historyParentId || null,
      children: [],
      timestamp: Date.now(),
      thoughtsRaw: null,
      thoughtSignature: null,
      thoughtSignatureSource: null,
      reasoning_content: null,
      tool_calls: null,
      phase: null,
      response_activity_timeline: null,
      response_activity_duration_ms: null,
      response_input_items: null,
      apiUuid: null,
      apiDisplayName: '',
      apiModelId: '',
      apiUsage: null,
      hasInlineImages: false,
      promptType: null,
      promptMeta: null,
      preprocessOriginalText: null,
      preprocessRenderedText: null,
      contextual_input_items_before: null,
      pageRuntimeContextSignature: null,
      environmentContextSignature: null,
      contextCompactionMarker: null,
      pageMeta: null
    };

    targetMessages.push(node);
    if (historyParentId) {
      const parentNode = targetMessages.find((item) => item && item.id === historyParentId);
      if (parentNode) {
        if (!Array.isArray(parentNode.children)) {
          parentNode.children = [];
        }
        parentNode.children.push(node.id);
      }
    }

    if (meta && typeof meta === 'object') {
      if (typeof meta.promptType === 'string') {
        node.promptType = meta.promptType;
      }
      if (meta.promptMeta && typeof meta.promptMeta === 'object') {
        node.promptMeta = meta.promptMeta;
      }
    }

    if (historyPatch && typeof historyPatch === 'object') {
      Object.assign(node, historyPatch);
    }

    const hasOtherUserMessage = targetMessages.some(
      (item) => item && item.id !== node.id && String(item.role || '').toLowerCase() === 'user'
    );
    if (!hasOtherUserMessage && pageMeta && typeof pageMeta === 'object') {
      const url = typeof pageMeta.url === 'string' ? pageMeta.url.trim() : '';
      const title = typeof pageMeta.title === 'string' ? pageMeta.title.trim() : '';
      if (url || title) {
        node.pageMeta = { url, title };
      }
    }

    node.hasInlineImages = Array.isArray(processedContent) && processedContent.some((part) => part?.type === 'image_url');
    return node;
  }

  function buildResponsesLocalCompactionHistoryPatch(options = {}) {
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    return {
      response_input_items: cloneResponsesInputItems(normalizedOptions.compactOutput || []),
      contextCompactionMarker: buildResponsesLocalCompactionMarker({
        sourceAssistantMessageId: normalizedOptions.sourceAssistantMessageId || null,
        promptTokensBefore: normalizedOptions.promptTokensBefore,
        compactedAt: normalizedOptions.compactedAt
      }),
      responsesLocalCompactionStatus: buildResponsesLocalCompactionStatus({
        state: 'success',
        phase: 'completed',
        attempt: normalizedOptions.attempt,
        totalAttempts: normalizedOptions.totalAttempts,
        requestBytes: normalizedOptions.requestBytes,
        inputCount: normalizedOptions.inputCount,
        toolCount: normalizedOptions.toolCount,
        responseStatus: normalizedOptions.responseStatus,
        responseBytes: normalizedOptions.responseBytes,
        outputCount: Array.isArray(normalizedOptions.compactOutput)
          ? normalizedOptions.compactOutput.length
          : normalizedOptions.outputCount
      })
    };
  }

  function buildResponsesLocalCompactionStatus(options = {}) {
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const normalizeNullableInt = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : null;
    };
    const normalizeState = (value) => {
      const normalized = String(value || '').trim().toLowerCase();
      if (normalized === 'success' || normalized === 'error' || normalized === 'pending') {
        return normalized;
      }
      return 'pending';
    };
    const normalizePhase = (value, fallbackState) => {
      const normalized = String(value || '').trim().toLowerCase();
      if (normalized) return normalized;
      if (fallbackState === 'success') return 'completed';
      if (fallbackState === 'error') return 'failed';
      return 'preparing';
    };

    const stateValue = normalizeState(normalizedOptions.state);
    const errorMessage = (typeof normalizedOptions.errorMessage === 'string' && normalizedOptions.errorMessage.trim())
      ? normalizedOptions.errorMessage.trim()
      : null;

    return {
      state: stateValue,
      phase: normalizePhase(normalizedOptions.phase, stateValue),
      attempt: normalizeNullableInt(normalizedOptions.attempt),
      totalAttempts: normalizeNullableInt(normalizedOptions.totalAttempts),
      requestBytes: normalizeNullableInt(normalizedOptions.requestBytes),
      inputCount: normalizeNullableInt(normalizedOptions.inputCount),
      toolCount: normalizeNullableInt(normalizedOptions.toolCount),
      responseStatus: normalizeNullableInt(normalizedOptions.responseStatus),
      responseBytes: normalizeNullableInt(normalizedOptions.responseBytes),
      outputCount: normalizeNullableInt(normalizedOptions.outputCount),
      errorMessage,
      updatedAt: normalizeNullableInt(normalizedOptions.updatedAt) || Date.now()
    };
  }

  function buildResponsesLocalCompactionStatusHistoryPatch(options = {}) {
    return {
      responsesLocalCompactionStatus: buildResponsesLocalCompactionStatus(options)
    };
  }

  function isResponsesLocalCompactionAbortError(error) {
    if (!error) return false;
    if (error?.name === 'AbortError') return true;
    const message = String(error?.message || '').trim().toLowerCase();
    return message.includes('aborted') || message.includes('中止');
  }

  function delayResponsesLocalCompactionRetry(signal, timeoutMs = RESPONSES_LOCAL_COMPACTION_RETRY_DELAY_MS) {
    const waitMs = Number.isFinite(Number(timeoutMs)) ? Math.max(0, Math.trunc(Number(timeoutMs))) : 0;
    if (!waitMs) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timerId = setTimeout(() => {
        cleanup();
        resolve();
      }, waitMs);
      const onAbort = () => {
        cleanup();
        const abortError = new Error('Compact 请求已取消');
        abortError.name = 'AbortError';
        reject(abortError);
      };
      const cleanup = () => {
        clearTimeout(timerId);
        try { signal?.removeEventListener?.('abort', onAbort); } catch (_) {}
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try { signal?.addEventListener?.('abort', onAbort, { once: true }); } catch (_) {}
    });
  }

  function clearResponsesLocalCompactionRun(targetMessageId) {
    const normalizedMessageId = (typeof targetMessageId === 'string' || typeof targetMessageId === 'number')
      ? String(targetMessageId).trim()
      : '';
    if (!normalizedMessageId) return;
    responsesLocalCompactionRuns.delete(normalizedMessageId);
  }

  function updateResponsesLocalCompactionStatusNode({
    targetMessageId,
    activeThreadContext = null,
    historyMessagesRef = null,
    text = RESPONSES_LOCAL_COMPACTION_PENDING_TEXT,
    statusPatch = null
  } = {}) {
    if (!targetMessageId) return null;
    return updateResponsesLocalCompactionMessage({
      targetMessageId,
      text,
      historyPatch: statusPatch ? buildResponsesLocalCompactionStatusHistoryPatch(statusPatch) : null,
      activeThreadContext,
      historyMessagesRef
    });
  }

  function findAssistantHistoryNodeForCompactionMessage(messageId, historyMessagesRef = null) {
    const normalizedMessageId = (typeof messageId === 'string' || typeof messageId === 'number')
      ? String(messageId).trim()
      : '';
    if (!normalizedMessageId) return null;
    const targetMessages = Array.isArray(historyMessagesRef)
      ? historyMessagesRef
      : chatHistoryManager?.chatHistory?.messages;
    if (!Array.isArray(targetMessages)) return null;
    return targetMessages.find((node) => node && node.id === normalizedMessageId) || null;
  }

  function updateResponsesLocalCompactionMessage(payload = {}) {
    const normalizedPayload = (payload && typeof payload === 'object') ? payload : {};
    const targetMessageId = (typeof normalizedPayload.targetMessageId === 'string')
      ? normalizedPayload.targetMessageId.trim()
      : '';
    if (!targetMessageId) {
      return appendResponsesLocalCompactionMarker(normalizedPayload);
    }

    const markerText = (typeof normalizedPayload.text === 'string' && normalizedPayload.text.trim())
      ? normalizedPayload.text.trim()
      : RESPONSES_LOCAL_COMPACTION_MARKER_TEXT;
    const historyPatch = (normalizedPayload.historyPatch && typeof normalizedPayload.historyPatch === 'object')
      ? normalizedPayload.historyPatch
      : null;
    const historyMessagesRef = Array.isArray(normalizedPayload.historyMessagesRef)
      ? normalizedPayload.historyMessagesRef
      : null;
    const node = findAssistantHistoryNodeForCompactionMessage(targetMessageId, historyMessagesRef);
    if (!node) {
      return appendResponsesLocalCompactionMarker({
        ...normalizedPayload,
        text: markerText
      });
    }

    node.content = imageHandler.processImageTags(markerText, null);
    node.thoughtsRaw = null;
    node.hasInlineImages = false;
    if (historyPatch) {
      Object.assign(node, historyPatch);
    }

    if (!historyMessagesRef) {
      const fallbackElement = resolveMessageElementForSender(targetMessageId);
      messageProcessor.syncAssistantMessageView(targetMessageId, {
        node,
        content: markerText,
        thoughtsRaw: null,
        fallbackElement,
        suppressMissingNodeWarning: true
      });
    }

    return {
      messageId: targetMessageId,
      node,
      element: resolveMessageElementForSender(targetMessageId)
    };
  }

  function appendResponsesLocalCompactionMarker(payload = {}) {
    const normalizedPayload = (payload && typeof payload === 'object') ? payload : {};
    const historyPatch = (normalizedPayload.historyPatch && typeof normalizedPayload.historyPatch === 'object')
      ? normalizedPayload.historyPatch
      : null;
    if (!historyPatch) return { messageId: '', node: null, element: null };

    const markerText = (typeof normalizedPayload.text === 'string' && normalizedPayload.text.trim())
      ? normalizedPayload.text.trim()
      : RESPONSES_LOCAL_COMPACTION_MARKER_TEXT;
    const activeThreadContext = normalizedPayload.activeThreadContext || null;
    const historyMessagesRef = Array.isArray(normalizedPayload.historyMessagesRef)
      ? normalizedPayload.historyMessagesRef
      : null;

    if (activeThreadContext) {
      const threadRootId = ensureThreadRootMessage(activeThreadContext);
      const historyParentId = activeThreadContext.annotation?.lastMessageId || threadRootId || null;
      const threadHistoryPatch = buildThreadHistoryPatch(activeThreadContext);
      const mergedHistoryPatch = threadHistoryPatch
        ? { ...threadHistoryPatch, ...historyPatch }
        : historyPatch;
      const markerDiv = messageProcessor.appendMessage(
        markerText,
        'ai',
        false,
        null,
        null,
        null,
        null,
        null,
        {
          container: activeThreadContext.container,
          historyParentId,
          preserveCurrentNode: true,
          historyPatch: mergedHistoryPatch
        }
      );
      const markerId = markerDiv?.getAttribute?.('data-message-id') || '';
      if (markerId) {
        updateThreadLastMessage(activeThreadContext, markerId);
      }
      return { messageId: markerId, node: null, element: markerDiv || null };
    }

    if (historyMessagesRef) {
      const node = createAssistantHistoryNodeForDetachedList({
        content: markerText,
        thoughts: null,
        historyParentId: getDetachedConversationParentMessageId(historyMessagesRef),
        historyPatch,
        historyMessagesRef
      });
      return { messageId: node?.id || '', node: node || null, element: null };
    }

    const markerDiv = messageProcessor.appendMessage(
      markerText,
      'ai',
      false,
      null,
      null,
      null,
      null,
      null,
      { historyPatch }
    );
    return {
      messageId: markerDiv?.getAttribute?.('data-message-id') || '',
      node: null,
      element: markerDiv || null
    };
  }

  async function buildResponsesLocalCompactionRequestBody({
    usedApiConfig,
    conversationChain,
    sendChatHistoryFlag
  }) {
    const compactMessages = composeMessages({
      prompts: promptSettingsManager.getPrompts(),
      injectedSystemMessages: [],
      pageContent: null,
      imageContainsScreenshot: false,
      omitDefaultSystemPrompt: false,
      currentPromptType: 'none',
      regenerateMode: false,
      messageId: null,
      conversationChain: Array.isArray(conversationChain) ? conversationChain : [],
      sendChatHistory: !!sendChatHistoryFlag,
      maxHistory: usedApiConfig?.maxChatHistory ?? 500,
      maxUserHistory: usedApiConfig?.maxChatHistoryUser,
      maxAssistantHistory: usedApiConfig?.maxChatHistoryAssistant
    });

    const baseRequestBody = await apiManager.buildRequest({
      messages: compactMessages,
      config: usedApiConfig
    });
    const compactRequestBody = applyResponsesCompactInstructionsOverride(
      baseRequestBody,
      RESPONSES_COMPACT_CODEX_GPT_5_4_BASE_INSTRUCTIONS
    );

    return prepareResponsesRequestBodyForCustomTools(
      compactRequestBody,
      usedApiConfig,
      resolveResponsesPageToolEnvironment()
    );
  }

  async function executeResponsesLocalCompaction(payload = {}) {
    const normalizedPayload = (payload && typeof payload === 'object') ? payload : {};
    const usedApiConfig = normalizedPayload.usedApiConfig || null;
    if (!isOpenAIResponsesApiConfig(usedApiConfig)) {
      throw new Error('当前配置不是 Responses API，无法执行本地 compact。');
    }

    const conversationChain = Array.isArray(normalizedPayload.conversationChain)
      ? normalizedPayload.conversationChain
      : [];
    const compactRequestBody = await buildResponsesLocalCompactionRequestBody({
      usedApiConfig,
      conversationChain,
      sendChatHistoryFlag: normalizedPayload.sendChatHistoryFlag !== false
    });
    const compactRequestSummary = summarizeResponsesCompactRequestBody(compactRequestBody);
    if (typeof normalizedPayload.onStatusUpdate === 'function') {
      normalizedPayload.onStatusUpdate({
        state: 'pending',
        phase: 'sending',
        requestBytes: compactRequestSummary?.serializedBytes,
        inputCount: compactRequestSummary?.inputCount,
        toolCount: compactRequestSummary?.toolCount
      });
    }
    const compactResponse = await apiManager.sendResponsesCompactRequest({
      requestBody: compactRequestBody,
      config: usedApiConfig,
      signal: normalizedPayload.signal
    });
    if (!compactResponse.ok) {
      const errorText = await compactResponse.text().catch(() => '');
      throw new Error(errorText || `Compact 请求失败 (${compactResponse.status})`);
    }

    const compactResponseText = await compactResponse.text().catch(() => '');
    const compactPayload = parseResponsesCompactResponseText(compactResponseText, {
      status: compactResponse.status,
      contentLength: compactResponse.headers?.get?.('content-length') || '',
      requestSummary: compactRequestSummary
    });
    if (compactPayload?.error) {
      throw new Error(compactPayload.error?.message || 'Compact 接口返回错误');
    }

    const compactOutput = cloneResponsesInputItems(
      Array.isArray(compactPayload?.output) ? compactPayload.output : []
    );
    if (compactOutput.length <= 0) {
      throw new Error('Compact 响应未返回可重放的 output。');
    }

    const historyPatch = buildResponsesLocalCompactionHistoryPatch({
      compactOutput,
      sourceAssistantMessageId: normalizedPayload.sourceAssistantMessageId || null,
      promptTokensBefore: normalizedPayload.promptTokensBefore,
      compactedAt: Date.now(),
      attempt: normalizedPayload.attempt,
      totalAttempts: normalizedPayload.totalAttempts,
      requestBytes: compactRequestSummary?.serializedBytes,
      inputCount: compactRequestSummary?.inputCount,
      toolCount: compactRequestSummary?.toolCount,
      responseStatus: compactResponse.status,
      responseBytes: (new TextEncoder()).encode(compactResponseText).length,
      outputCount: compactOutput.length
    });
    const markerResult = updateResponsesLocalCompactionMessage({
      targetMessageId: normalizedPayload.targetMessageId || '',
      text: RESPONSES_LOCAL_COMPACTION_MARKER_TEXT,
      historyPatch,
      activeThreadContext: normalizedPayload.activeThreadContext || null,
      historyMessagesRef: normalizedPayload.historyMessagesRef || null
    });

    return {
      compactOutput,
      historyPatch,
      markerMessageId: markerResult.messageId || '',
      markerNode: markerResult.node || null,
      markerElement: markerResult.element || null
    };
  }

  function resolveResponsesLocalCompactionInvocationContext() {
    const conversationApiInfo = (typeof chatHistoryUI?.resolveActiveConversationApiConfig === 'function')
      ? chatHistoryUI.resolveActiveConversationApiConfig()
      : null;
    const usedApiConfig = conversationApiInfo?.lockConfig || apiManager.getSelectedConfig();
    if (!validateApiConfig(usedApiConfig)) {
      throw new Error('当前没有可用的 API 配置。');
    }
    if (!isOpenAIResponsesApiConfig(usedApiConfig)) {
      throw new Error('当前配置不是 Responses API，无法执行 /compact。');
    }

    const activeThreadContext = resolveActiveThreadContext();
    const conversationChain = resolveConversationChainForAttempt({
      attemptState: null,
      conversationSnapshot: null,
      activeThreadContext,
      regenerateMode: false,
      messageId: null,
      sendChatHistoryFlag: shouldSendChatHistory
    });
    const latestAssistantEntry = findLatestAssistantPromptTokenEntry(conversationChain);

    return {
      usedApiConfig,
      activeThreadContext,
      conversationChain,
      sourceAssistantMessageId: latestAssistantEntry?.node?.id || null,
      promptTokensBefore: latestAssistantEntry?.promptTokens ?? null
    };
  }

  async function persistResponsesLocalCompactionConversation() {
    const savedConversation = await chatHistoryUI?.saveCurrentConversation?.(true, {
      preserveExistingApiLock: true
    });
    const savedConversationId = normalizeConversationId(savedConversation?.id);
    if (savedConversationId) {
      updateCurrentConversationContext(savedConversationId);
    }
    return savedConversation || null;
  }

  async function dismissResponsesLocalCompaction(targetMessageId) {
    const normalizedMessageId = normalizeConversationId(targetMessageId);
    if (!normalizedMessageId) return false;
    const existingRun = responsesLocalCompactionRuns.get(normalizedMessageId);
    if (existingRun?.controller && existingRun.controller.signal.aborted !== true) {
      try { existingRun.controller.abort(); } catch (_) {}
    }
    clearResponsesLocalCompactionRun(normalizedMessageId);
    try {
      await requestConversationMessageDeletion({ messageId: normalizedMessageId });
      return true;
    } catch (error) {
      console.error('删除 compact 状态节点失败:', error);
      return false;
    }
  }

  async function cancelResponsesLocalCompaction(targetMessageId) {
    const normalizedMessageId = normalizeConversationId(targetMessageId);
    if (!normalizedMessageId) return false;
    const run = responsesLocalCompactionRuns.get(normalizedMessageId);
    if (run?.controller && run.controller.signal.aborted !== true) {
      try { run.controller.abort(); } catch (_) {}
    }
    return dismissResponsesLocalCompaction(normalizedMessageId);
  }

  async function runResponsesLocalCompactionWithRetries({
    targetMessageId,
    clearComposer = false
  } = {}) {
    const normalizedTargetMessageId = normalizeConversationId(targetMessageId);
    if (!normalizedTargetMessageId) {
      return { ok: false, error: 'missing_target_message_id' };
    }
    if (responsesLocalCompactionRuns.has(normalizedTargetMessageId)) {
      return { ok: false, error: 'already_running' };
    }

    const controller = new AbortController();
    const runContext = {
      controller,
      totalAttempts: RESPONSES_LOCAL_COMPACTION_TOTAL_ATTEMPTS
    };
    responsesLocalCompactionRuns.set(normalizedTargetMessageId, runContext);

    if (clearComposer) {
      clearInputs();
      inputController?.focusToEnd?.();
    }

    let lastError = null;

    try {
      for (let attempt = 1; attempt <= RESPONSES_LOCAL_COMPACTION_TOTAL_ATTEMPTS; attempt += 1) {
        runContext.attempt = attempt;
        const invocationContext = resolveResponsesLocalCompactionInvocationContext();
        updateResponsesLocalCompactionStatusNode({
          targetMessageId: normalizedTargetMessageId,
          activeThreadContext: invocationContext.activeThreadContext,
          text: RESPONSES_LOCAL_COMPACTION_PENDING_TEXT,
          statusPatch: {
            state: 'pending',
            phase: attempt > 1 ? 'retrying' : 'preparing',
            attempt,
            totalAttempts: RESPONSES_LOCAL_COMPACTION_TOTAL_ATTEMPTS,
            errorMessage: attempt > 1 ? (lastError?.message || '') : ''
          }
        });
        scrollToBottom(invocationContext.activeThreadContext?.container || chatContainer);

        try {
          const result = await executeResponsesLocalCompaction({
            usedApiConfig: invocationContext.usedApiConfig,
            conversationChain: invocationContext.conversationChain,
            sendChatHistoryFlag: true,
            activeThreadContext: invocationContext.activeThreadContext,
            historyMessagesRef: null,
            sourceAssistantMessageId: invocationContext.sourceAssistantMessageId,
            promptTokensBefore: invocationContext.promptTokensBefore,
            targetMessageId: normalizedTargetMessageId,
            signal: controller.signal,
            attempt,
            totalAttempts: RESPONSES_LOCAL_COMPACTION_TOTAL_ATTEMPTS,
            onStatusUpdate: (statusPatch) => {
              updateResponsesLocalCompactionStatusNode({
                targetMessageId: normalizedTargetMessageId,
                activeThreadContext: invocationContext.activeThreadContext,
                text: RESPONSES_LOCAL_COMPACTION_PENDING_TEXT,
                statusPatch: {
                  ...statusPatch,
                  state: 'pending',
                  attempt,
                  totalAttempts: RESPONSES_LOCAL_COMPACTION_TOTAL_ATTEMPTS,
                  errorMessage: attempt > 1 ? (lastError?.message || '') : ''
                }
              });
            }
          });
          await persistResponsesLocalCompactionConversation();
          return { ok: true, result };
        } catch (error) {
          if (controller.signal.aborted || isResponsesLocalCompactionAbortError(error)) {
            return { ok: false, cancelled: true };
          }
          lastError = error instanceof Error ? error : new Error(String(error || '上下文压缩失败'));

          if (attempt < RESPONSES_LOCAL_COMPACTION_TOTAL_ATTEMPTS) {
            updateResponsesLocalCompactionStatusNode({
              targetMessageId: normalizedTargetMessageId,
              activeThreadContext: invocationContext.activeThreadContext,
              text: RESPONSES_LOCAL_COMPACTION_PENDING_TEXT,
              statusPatch: {
                state: 'pending',
                phase: 'retrying',
                attempt: attempt + 1,
                totalAttempts: RESPONSES_LOCAL_COMPACTION_TOTAL_ATTEMPTS,
                requestBytes: null,
                inputCount: null,
                toolCount: null,
                responseStatus: null,
                responseBytes: null,
                outputCount: null,
                errorMessage: lastError.message
              }
            });
            await delayResponsesLocalCompactionRetry(controller.signal);
            continue;
          }

          updateResponsesLocalCompactionStatusNode({
            targetMessageId: normalizedTargetMessageId,
            activeThreadContext: invocationContext.activeThreadContext,
            text: RESPONSES_LOCAL_COMPACTION_ERROR_TEXT,
            statusPatch: {
              state: 'error',
              phase: 'failed',
              attempt,
              totalAttempts: RESPONSES_LOCAL_COMPACTION_TOTAL_ATTEMPTS,
              errorMessage: lastError.message
            }
          });
          return { ok: false, error: lastError.message };
        }
      }
    } finally {
      clearResponsesLocalCompactionRun(normalizedTargetMessageId);
    }

    return { ok: false, error: lastError?.message || '上下文压缩失败' };
  }

  async function retryResponsesLocalCompaction(targetMessageId) {
    const normalizedTargetMessageId = normalizeConversationId(targetMessageId);
    if (!normalizedTargetMessageId) return { ok: false, error: 'missing_target_message_id' };
    if (activeAttempts.size > 0) {
      showNotification?.({ message: '当前有进行中的请求，请等待结束后再重试压缩', type: 'warning' });
      return { ok: false, error: 'request_in_progress' };
    }
    return runResponsesLocalCompactionWithRetries({
      targetMessageId: normalizedTargetMessageId,
      clearComposer: false
    });
  }

  // 线程后台生成时仅写入历史（不渲染 DOM），避免与当前线程视图串线。
  function createThreadAiMessageHistoryOnly(payload) {
    const {
      content,
      thoughts,
      historyParentId,
      historyPatch,
      historyMessagesRef = null,
      preserveCurrentNode = true
    } = payload || {};
    if (!historyParentId) return null;

    const activeHistoryMessages = chatHistoryManager?.chatHistory?.messages || [];
    const shouldUseActiveHistory = !historyMessagesRef || historyMessagesRef === activeHistoryMessages;
    if (!shouldUseActiveHistory) {
      return createAssistantHistoryNodeForDetachedList({
        content,
        thoughts,
        historyParentId,
        historyPatch,
        historyMessagesRef
      });
    }

    const processedContent = imageHandler.processImageTags(content || '', null);
    const addWithOptions = typeof chatHistoryManager.addMessageToTreeWithOptions === 'function';
    const node = addWithOptions
      ? chatHistoryManager.addMessageToTreeWithOptions(
          'assistant',
          processedContent,
          historyParentId,
          { preserveCurrentNode: !!preserveCurrentNode }
        )
      : chatHistoryManager.addMessageToTree('assistant', processedContent, historyParentId);
    if (!node) return null;
    if (thoughts !== undefined) node.thoughtsRaw = thoughts;
    if (historyPatch && typeof historyPatch === 'object') {
      Object.assign(node, historyPatch);
    }
    node.hasInlineImages = Array.isArray(processedContent) && processedContent.some(p => p?.type === 'image_url');
    return node;
  }

  function renderAttemptPreResponseStatus(loadingMessage, attemptState = null) {
    const liveElement = resolveLiveLoadingStatusElement(loadingMessage, attemptState);
    if (!liveElement) return;
    const runtimeSnapshot = attemptState ? getAttemptRuntimeSnapshot(attemptState) : null;
    if (typeof messageProcessor?.syncAssistantMessageMetadata === 'function') {
      messageProcessor.syncAssistantMessageMetadata(
        liveElement.getAttribute?.('data-message-id') || null,
        { role: 'assistant' },
        {
          fallbackElement: liveElement,
          runtimeSnapshot
        }
      );
    }
  }

  /**
   * 将可能为空的时间戳字段安全规范化为 number|null。
   *
   * 注意：
   * - 不能直接写 `Number.isFinite(Number(value))`，因为 `Number(null) === 0`；
   * - 这里把 null / undefined / 空字符串都视为“尚未设置”，避免把 epoch 误当成有效时间。
   *
   * @param {any} value
   * @returns {number|null}
   */
  function normalizeOptionalTimestamp(value) {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  /**
   * 获取当前仍然有效的“状态文案承载节点”。
   *
   * 说明：
   * - 重新生成时，旧 AI 消息 DOM 可能在编辑/保存后被同 id 的新节点替换；
   * - 因此不能长期信任早先捕获的 HTMLElement，必须优先按稳定 message-id 回查当前可见节点。
   *
   * @param {HTMLElement|null} loadingMessage
   * @param {{ aiMessageId?: string|null }} [attemptState]
   * @returns {HTMLElement|null}
   */
  function resolveLiveLoadingStatusElement(loadingMessage, attemptState = null) {
    const boundMessageId = normalizeConversationId(attemptState?.aiMessageId)
      || normalizeConversationId(loadingMessage?.getAttribute?.('data-message-id') || '');
    if (boundMessageId) {
      const liveElement = findVisibleMessageElementById(boundMessageId);
      if (liveElement instanceof HTMLElement && liveElement.parentNode) {
        return liveElement;
      }
    }
    return (loadingMessage instanceof HTMLElement && loadingMessage.parentNode)
      ? loadingMessage
      : null;
  }

  function clearAttemptPreResponseStatus(attemptState, loadingMessage = null) {
    if (!attemptState || typeof attemptState !== 'object') return;
    clearAttemptLoadingStatusPulse(attemptState);
    attemptState.pendingLoadingStatusText = '';
    attemptState.pendingLoadingStatusMeta = null;
    updateAttemptRuntimeState(attemptState, (draft) => {
      draft.activeTurn.preResponseStatus = null;
    });
    renderAttemptPreResponseStatus(loadingMessage || attemptState.loadingMessage || null, attemptState);
  }

  function syncAttemptPreResponseStatusFromLocalStage(loadingMessage, attemptState = null, stage = '', data = {}) {
    const normalizedStatus = deriveAssistantPreResponseStatusFromLocalStage(stage, data);
    if (!normalizedStatus) return;
    syncAttemptLoadingStatus(loadingMessage, attemptState, normalizedStatus.text, {
      stage: normalizedStatus.stage,
      note: normalizedStatus.note || '',
      showSpinner: normalizedStatus.showSpinner
    });
  }

  /**
   * 更新“正文出现前”的统一状态。
   *
   * 关键约束：
   * - 状态文案不再写进 assistant 正文节点；
   * - DOM 与历史节点都通过 runtimeSnapshot 投影同一份状态；
   * - 这样重试、原地替换、切会话重渲染时都不会再把状态文本误当成正式回答。
   */
  function syncAttemptLoadingStatus(loadingMessage, attemptState = null, text = '', meta = null) {
    const normalizedMeta = (meta && typeof meta === 'object') ? meta : {};
    const normalizedStatus = normalizeAssistantPreResponseStatus({
      text,
      stage: normalizedMeta.stage || '',
      note: normalizedMeta.note || '',
      showSpinner: normalizedMeta.showSpinner
    }) || createAssistantPreResponseStatus(text, normalizedMeta.stage || '', {
      note: normalizedMeta.note || '',
      showSpinner: normalizedMeta.showSpinner
    });
    if (!normalizedStatus) return;

    if (attemptState && typeof attemptState === 'object') {
      attemptState.pendingLoadingStatusText = normalizedStatus.text;
      attemptState.pendingLoadingStatusMeta = {
        stage: normalizedStatus.stage,
        note: normalizedStatus.note || '',
        showSpinner: normalizedStatus.showSpinner === true
      };
      updateAttemptRuntimeState(attemptState, (draft) => {
        draft.activeTurn.preResponseStatus = {
          text: normalizedStatus.text,
          stage: normalizedStatus.stage,
          note: normalizedStatus.note || '',
          showSpinner: normalizedStatus.showSpinner === true
        };
      });
      ensureAttemptLoadingStatusPulse(attemptState, loadingMessage || null);
    }

    renderAttemptPreResponseStatus(loadingMessage, attemptState);
  }

  /**
   * 清理“请求前状态文案”的短周期同步器。
   *
   * 设计目的：
   * - 编辑用户消息后重试会触发会话局部重渲染，原地替换的 AI 气泡可能在短时间内被旧 DOM/新 DOM 来回替换；
   * - SSE 的 response.created / in_progress 往往来得很早，如果只依赖单次事件写入，状态文案可能正好打到失效节点上；
   * - 这里用一个极短生命周期的 pulse，在首个可见正文出现前持续把“当前状态文案”压到目标 AI 气泡上。
   *
   * 这样我们不需要依赖某个单一时刻“恰好命中正确 DOM”，而是把状态同步变成确定性的过程。
   *
   * @param {Object|null} attemptState
   */
  function clearAttemptLoadingStatusPulse(attemptState) {
    if (!attemptState || typeof attemptState !== 'object') return;
    const timerId = Number(attemptState.loadingStatusPulseTimerId);
    if (Number.isFinite(timerId) && timerId > 0) {
      try { clearTimeout(timerId); } catch (_) {}
    }
    attemptState.loadingStatusPulseTimerId = null;
    attemptState.loadingStatusPulseActive = false;
  }

  /**
   * 在首个正文出现前，持续把 attempt.pendingLoadingStatusText 同步到当前可见 AI 气泡。
   *
   * @param {Object|null} attemptState
   * @param {HTMLElement|null} loadingMessage
   */
  function ensureAttemptLoadingStatusPulse(attemptState, loadingMessage = null) {
    if (!attemptState || typeof attemptState !== 'object') return;
    if (attemptState.loadingStatusPulseActive === true) return;

    const tick = () => {
      attemptState.loadingStatusPulseTimerId = null;
      if (!attemptState || typeof attemptState !== 'object') return;
      if (attemptState.finished || normalizeOptionalTimestamp(attemptState.firstVisibleOutputAtMs) != null) {
        clearAttemptLoadingStatusPulse(attemptState);
        return;
      }

      const text = (typeof attemptState.pendingLoadingStatusText === 'string')
        ? attemptState.pendingLoadingStatusText
        : '';
      if (!text) {
        clearAttemptLoadingStatusPulse(attemptState);
        return;
      }

      renderAttemptPreResponseStatus(loadingMessage || attemptState.loadingMessage || null, attemptState);

      attemptState.loadingStatusPulseActive = true;
      attemptState.loadingStatusPulseTimerId = setTimeout(tick, 80);
    };

    attemptState.loadingStatusPulseActive = true;
    attemptState.loadingStatusPulseTimerId = setTimeout(tick, 0);
  }

  /**
   * 判定当前 assistant 是否已经出现任何“用户可见内容”。
   *
   * 范围：
   * - 正文答案；
   * - 思考文本；
   * - Responses 的 reasoning / commentary / tool timeline。
   *
   * 一旦这些任意一种已经开始可见，就不应该继续显示“等待首个 token”之类的纯占位状态。
   *
   * @param {{answer?: string, thoughts?: string, responseActivityTimeline?: Array<any>}} input
   * @returns {boolean}
   */
  function hasVisibleAssistantOutput(input = {}) {
    if (typeof input?.answer === 'string' && input.answer.trim() !== '') {
      return true;
    }
    if (typeof input?.thoughts === 'string' && input.thoughts.trim() !== '') {
      return true;
    }
    return Array.isArray(input?.responseActivityTimeline) && input.responseActivityTimeline.length > 0;
  }

  /**
   * 将 apiManager.sendRequest 的“结构化阶段事件”映射为对用户可见的文案。
   * 目的：把“正在发送请求...”细分为更贴近真实网络生命周期的多个阶段，提升透明度。
   *
   * 注意：Fetch API 不提供精确上传进度，因此这里的“上传/等待”只表示所处阶段，而非字节级进度。
   *
   * @param {HTMLElement|null} loadingMessage
   * @returns {(evt: {stage: string, [key: string]: any}) => void}
   */
  function createRequestStatusHandler(loadingMessageOrResolver, attemptState = null) {
    const resolveTarget = (typeof loadingMessageOrResolver === 'function')
      ? loadingMessageOrResolver
      : () => loadingMessageOrResolver;
    return (evt) => {
      const loadingMessage = resolveTarget();
      if (!evt || typeof evt !== 'object') return;
      if (normalizeOptionalTimestamp(attemptState?.firstVisibleOutputAtMs) != null) return;
      const normalizedStatus = deriveAssistantPreResponseStatusFromRequestEvent(evt);
      if (!normalizedStatus) return;
      syncAttemptLoadingStatus(loadingMessage, attemptState, normalizedStatus.text, {
        stage: normalizedStatus.stage,
        note: normalizedStatus.note || '',
        showSpinner: normalizedStatus.showSpinner
      });
    };
  }

  //TODO:
  //对于通过<think>标签传输的思考过程 只匹配开头的think标签到第一个<think/>结尾的部分作为思考过程，后续传输文本里如果再出现think就视为正文

  /**
   * 将流式增量按 <think> 标签拆分到思考块与正文块。
   * 若已进入思考模式，则持续写入直到遇到闭合标签。
   * @param {string} delta - 本次增量文本
   * @param {boolean} forceThought - 是否优先视为思考文本（例如 part.thought=true）
   * @returns {{answerDelta: string, thoughtDelta: string}}
   */
  function splitDeltaByThinkTags(delta, forceThought = false) {
    if (typeof delta !== 'string' || delta.length === 0) {
      return { answerDelta: '', thoughtDelta: '' };
    }

    let answerDelta = '';
    let thoughtDelta = '';
    let remaining = delta;

    while (remaining.length > 0) {
      if (isInStreamingThoughtBlock) {
        const closeIdx = remaining.indexOf('</think>');
        if (closeIdx === -1) {
          thoughtDelta += remaining;
          remaining = '';
          continue;
        }
        thoughtDelta += remaining.slice(0, closeIdx);
        remaining = remaining.slice(closeIdx + 8);
        isInStreamingThoughtBlock = false;
        continue;
      }

      const openIdx = remaining.indexOf('<think>');
      if (openIdx === -1) {
        if (forceThought) {
          thoughtDelta += remaining;
        } else {
          answerDelta += remaining;
        }
        remaining = '';
        continue;
      }

      // 先写入开标签前的内容
      if (openIdx > 0) {
        const before = remaining.slice(0, openIdx);
        if (forceThought) {
          thoughtDelta += before;
        } else {
          answerDelta += before;
        }
      }

      // 跳过 <think> 标签
      remaining = remaining.slice(openIdx + 7);

      const closeIdx = remaining.indexOf('</think>');
      if (closeIdx === -1) {
        // 没有闭合标签，进入思考模式，剩余内容全部写入思考摘要
        thoughtDelta += remaining;
        remaining = '';
        isInStreamingThoughtBlock = true;
        continue;
      }

      // 有闭合标签，截取其中内容写入思考摘要
      thoughtDelta += remaining.slice(0, closeIdx);
      remaining = remaining.slice(closeIdx + 8);
    }

    return { answerDelta, thoughtDelta };
  }
  let currentConversationId = null;

  /**
   * 检测 Gemini 返回中「HTTP 200 但因安全原因被拦截」的场景，并给出统一的错误消息
   *
   * 典型表现为：
   * - 顶层 HTTP 状态码是 200（sendRequest 不会把它视为错误）
   * - candidates[0].finishReason 为 IMAGE_SAFETY / SAFETY 等安全相关值
   *   或 promptFeedback.blockReason 为 SAFETY
   * - 且本帧 / 本事件中没有任何可用的 text 正文内容
   *
   * 这类情况在用户看来是“200 返回错误”，需要抛出 Error 让 sendMessage 的自动重试逻辑接管。
   * 注意：为了避免影响正常有输出但以 SAFETY 结束的情况，这里要求「当前帧没有正文」且
   *       流式场景下前面也没有输出过内容（hasExistingContent=false）才视为错误。
   *
   * @param {Object} json - Gemini 返回的 JSON 对象（整帧或 SSE 事件数据）
   * @param {Object} [options]
   * @param {boolean} [options.hasExistingContent=false] - 对于流式场景，标记之前是否已经输出过正文
   * @returns {{blocked: boolean, message: string}|null}
   */
  function detectGeminiSafetyBlock(json, options = {}) {
    const hasExistingContent = !!options.hasExistingContent;
    if (!json || typeof json !== 'object') return null;

    const candidates = Array.isArray(json.candidates) ? json.candidates : [];
    const candidate = candidates[0] || null;

    const finishReason = candidate?.finishReason || candidate?.finish_reason || null;
    const finishMessage = candidate?.finishMessage || candidate?.finish_message || null;

    const parts = candidate?.content?.parts || [];
    const hasTextContent = Array.isArray(parts) && parts.some(
      (part) => typeof part?.text === 'string' && part.text.trim() !== ''
    );

    const promptFeedback = json.promptFeedback || json.prompt_feedback || null;
    const promptBlockReason = promptFeedback?.blockReason || promptFeedback?.block_reason || null;
    const promptBlockMessage = promptFeedback?.blockReasonMessage || promptFeedback?.block_reason_message || null;

    const reasonStr = [finishReason, promptBlockReason]
      .filter(Boolean)
      .map(String)
      .join(', ');
    const isSafetyReason = /(SAFETY|IMAGE_SAFETY|PROHIBITED_CONTENT)/i.test(reasonStr);

    // 没有命中安全相关原因，或当前/之前已经有正文输出，则不视为“200 返回错误”
    if (!isSafetyReason || hasTextContent || hasExistingContent) {
      return null;
    }

    const message =
      finishMessage ||
      promptBlockMessage ||
      'Gemini 返回安全拦截结果（HTTP 200），未包含可用内容，请稍后重试。';

    return { blocked: true, message };
  }

  // 取消内部自动重试和定时器逻辑：由外部消费返回值并决定是否重试

  /**
   * 获取是否应该自动滚动
   * @returns {boolean} 是否应该自动滚动
   */
  function getShouldAutoScroll() {
    return shouldAutoScroll;
  }

  /**
   * 设置是否应该自动滚动
   * @param {boolean} value - 是否应该自动滚动
   */
  function setShouldAutoScroll(value) {
    shouldAutoScroll = value;
  }

  /**
   * 清空消息输入框和图片容器
   * @private
   */
  function clearInputs() {
    try {
      if (inputController) {
        inputController.clear();
      } else {
        messageInput.innerHTML = '';
        imageContainer.innerHTML = '';
        appContext.services.uiManager.resetInputHeight();
      }
      try { appContext.services.uiManager?.updateSendButtonState?.(); } catch (_) {}
    } catch (error) {
      console.error('清空消息输入框和图片容器失败:', error);
    }
  }

  /**
   * 解析用户输入中的斜杠命令。
   *
   * 设计约定：
   * - 仅当首个非空字符为 "/" 时，才视为斜杠命令；
   * - 以 "//" 开头表示转义（发送普通文本，保留一个 "/"）；
   * - 输入 "/" 或 "/?" 视为帮助命令。
   *
   * @param {string} rawText
   * @returns {{ type: 'command', name: string, args: string[], raw: string, argsText: string } | { type: 'escape', text: string } | null}
   */
  function parseSlashCommand(rawText) {
    if (typeof rawText !== 'string') return null;
    const trimmed = rawText.trimStart();
    if (!trimmed.startsWith('/')) return null;

    if (trimmed.startsWith('//')) {
      // 双斜杠转义：保留一个 "/"，其余交由正常发送流程处理
      return { type: 'escape', text: trimmed.slice(1) };
    }

    const body = trimmed.slice(1).trim();
    if (!body) {
      return { type: 'command', name: 'help', args: [], raw: trimmed, argsText: '' };
    }

    const parts = body.split(/\s+/);
    const name = (parts.shift() || '').toLowerCase();
    const args = parts;
    return {
      type: 'command',
      name: name || 'help',
      args,
      raw: trimmed,
      argsText: args.join(' ')
    };
  }

  // 斜杠命令定义（基础版）
  const slashCommandRegistry = [
    {
      name: 'help',
      aliases: ['?','commands'],
      usage: '/help',
      description: '显示可用斜杠命令',
      handler: async () => {
        if (typeof showNotification === 'function') {
          showNotification({ message: '输入 / 即可在输入框上方查看斜杠命令', type: 'info' });
        }
      },
      requiresArgs: false
    },
    {
      name: 'clear',
      aliases: ['cls'],
      usage: '/clear',
      description: '清空当前对话',
      handler: async () => {
        await chatHistoryUI?.clearChatHistory?.();
        if (typeof showNotification === 'function') {
          showNotification('已清空当前对话');
        }
      },
      requiresArgs: false
    },
    {
      name: 'stop',
      aliases: ['abort'],
      usage: '/stop',
      description: '停止当前生成',
      handler: async () => {
        const stopped = abortCurrentRequest();
        if (typeof showNotification === 'function') {
          showNotification(stopped ? '已停止生成' : '当前没有进行中的请求');
        }
      },
      requiresArgs: false
    },
    {
      name: 'compact',
      aliases: ['cmp'],
      usage: '/compact',
      description: '手动压缩当前 Responses 上下文',
      handler: async () => {
        if (activeAttempts.size > 0) {
          if (typeof showNotification === 'function') {
            showNotification({ message: '当前有进行中的请求，请等待结束后再执行 /compact', type: 'warning' });
          }
          return { ok: false, keepInput: true };
        }

        const conversationApiInfo = (typeof chatHistoryUI?.resolveActiveConversationApiConfig === 'function')
          ? chatHistoryUI.resolveActiveConversationApiConfig()
          : null;
        const usedApiConfig = conversationApiInfo?.lockConfig || apiManager.getSelectedConfig();
        if (!validateApiConfig(usedApiConfig)) {
          return { ok: false, keepInput: true };
        }
        if (!isOpenAIResponsesApiConfig(usedApiConfig)) {
          if (typeof showNotification === 'function') {
            showNotification({ message: '当前配置不是 Responses API，无法执行 /compact', type: 'warning' });
          }
          return { ok: false, keepInput: true };
        }

        const activeThreadContext = resolveActiveThreadContext();
        const pendingMarkerResult = appendResponsesLocalCompactionMarker({
          text: RESPONSES_LOCAL_COMPACTION_PENDING_TEXT,
          historyPatch: buildResponsesLocalCompactionStatusHistoryPatch({
            state: 'pending',
            phase: 'preparing',
            attempt: 1,
            totalAttempts: RESPONSES_LOCAL_COMPACTION_TOTAL_ATTEMPTS
          }),
          activeThreadContext,
          historyMessagesRef: null
        });
        return runResponsesLocalCompactionWithRetries({
          targetMessageId: pendingMarkerResult?.messageId || '',
          clearComposer: true
        });
      },
      requiresArgs: false
    },
    {
      name: 'temp',
      aliases: ['tmp'],
      usage: '/temp [on|off|toggle]',
      description: '切换/设置纯对话模式（关闭宿主页工具，JS 改用隔离沙箱）',
      handler: async ({ args }) => {
        const mode = (args[0] || '').toLowerCase();
        if (!mode || mode === 'toggle') {
          toggleTemporaryMode();
        } else if (mode === 'on') {
          enterTemporaryMode();
        } else if (mode === 'off') {
          exitTemporaryMode();
        } else {
          if (typeof showNotification === 'function') {
            showNotification('用法：/temp [on|off|toggle]');
          }
          return { ok: false, keepInput: true };
        }
        if (typeof showNotification === 'function') {
          const status = getTemporaryModeState() ? '已进入纯对话模式' : '已退出纯对话模式';
          showNotification(status);
        }
        return { ok: true };
      },
      requiresArgs: false,
      getArgSuggestions: ({ keyword }) => {
        const candidates = ['on', 'off', 'toggle'];
        const lower = String(keyword || '').toLowerCase();
        return candidates
          .filter(item => !lower || item.startsWith(lower))
          .map(item => ({
            value: item,
            label: item,
            description: item === 'toggle'
              ? '切换模式'
              : (item === 'on'
                ? '进入纯对话模式（关闭宿主页工具）'
                : '退出纯对话模式（恢复宿主页工具）')
          }));
      }
    },
    {
      name: 'model',
      aliases: ['m', 'api'],
      usage: '/model <模型名称>',
      description: '切换模型/API 配置',
      requiresArgs: true,
      getArgSuggestions: ({ keyword }) => {
        const allConfigs = (apiManager.getAllConfigs && apiManager.getAllConfigs()) || [];
        const normalizedKeyword = String(keyword || '').trim().toLowerCase();
        const currentConfig = apiManager.getSelectedConfig?.() || null;
        const currentId = currentConfig?.id || null;

        const buildText = (config, index) => {
          const displayName = config.displayName || '';
          const modelName = config.modelName || '';
          const baseUrl = config.baseUrl || '';
          const title = displayName || modelName || baseUrl || `配置 ${index + 1}`;
          const preferDisplayAsValue = displayName && !/\s/.test(displayName);
          const value = preferDisplayAsValue
            ? displayName
            : (modelName || config.id || baseUrl || String(index + 1));
          const detailParts = [];
          if (modelName && modelName !== title) detailParts.push(modelName);
          if (baseUrl) detailParts.push(baseUrl);
          if (config.id && config.id === currentId) detailParts.push('当前');
          return {
            value,
            label: title,
            description: detailParts.join(' · ')
          };
        };

        const items = allConfigs.map(buildText);
        if (!normalizedKeyword) return items;

        const match = (item) => {
          const haystack = `${item.label} ${item.value} ${item.description}`.toLowerCase();
          return haystack.includes(normalizedKeyword);
        };

        return items.filter(match);
      },
      handler: async ({ args, argsText }) => {
        const keywordRaw = (argsText || '').trim();
        if (!keywordRaw) {
          if (typeof showNotification === 'function') {
            showNotification({ message: '用法：/model <模型名称>', type: 'warning' });
          }
          return { ok: false, keepInput: true };
        }

        const allConfigs = (apiManager.getAllConfigs && apiManager.getAllConfigs()) || [];
        if (allConfigs.length === 0) {
          if (typeof showNotification === 'function') {
            showNotification({ message: '未找到可用的 API 配置', type: 'warning' });
          }
          return { ok: false, keepInput: true };
        }

        const keyword = keywordRaw.toLowerCase();
        let targetIndex = -1;

        // 0) 纯数字：视为 1-based 索引
        if (/^\d+$/.test(keyword)) {
          const parsedIndex = parseInt(keyword, 10) - 1;
          if (Number.isFinite(parsedIndex) && parsedIndex >= 0 && parsedIndex < allConfigs.length) {
            targetIndex = parsedIndex;
          }
        }

        // 1) 尝试使用内置解析（支持 id / displayName / modelName 等）
        if (targetIndex < 0 && typeof apiManager.resolveApiParam === 'function') {
          try {
            const resolved = apiManager.resolveApiParam(keywordRaw);
            if (resolved) {
              targetIndex = allConfigs.findIndex(cfg => cfg.id && resolved.id && cfg.id === resolved.id);
            }
          } catch (_) {}
        }

        // 2) 精确匹配（displayName / modelName / baseUrl / id）
        if (targetIndex < 0) {
          targetIndex = allConfigs.findIndex((cfg) => {
            const candidates = [cfg.displayName, cfg.modelName, cfg.baseUrl, cfg.id]
              .filter(Boolean)
              .map(val => String(val).toLowerCase());
            return candidates.includes(keyword);
          });
        }

        // 3) 模糊匹配：仅当唯一命中时才采用
        if (targetIndex < 0) {
          const fuzzyMatches = allConfigs
            .map((cfg, index) => ({
              index,
              haystack: `${cfg.displayName || ''} ${cfg.modelName || ''} ${cfg.baseUrl || ''} ${cfg.id || ''}`.toLowerCase()
            }))
            .filter(item => item.haystack.includes(keyword));
          if (fuzzyMatches.length === 1) {
            targetIndex = fuzzyMatches[0].index;
          }
        }

        if (targetIndex < 0) {
          if (typeof showNotification === 'function') {
            showNotification({ message: `未找到匹配的模型：${keywordRaw}`, type: 'warning' });
          }
          return { ok: false, keepInput: true };
        }

        const success = apiManager.setSelectedIndex?.(targetIndex);
        const picked = allConfigs[targetIndex];
        if (success === false) {
          if (typeof showNotification === 'function') {
            showNotification({ message: '切换模型失败，请稍后重试', type: 'error' });
          }
          return { ok: false, keepInput: true };
        }

        if (typeof showNotification === 'function') {
          const display = picked?.displayName || picked?.modelName || picked?.baseUrl || '已切换模型';
          showNotification(`已切换到 ${display}`);
        }
        return { ok: true };
      }
    },
    {
      name: 'summary',
      aliases: ['sum'],
      usage: '/summary',
      description: '快速总结当前页面',
      handler: async () => {
        if (state?.isStandalone) {
          if (typeof showNotification === 'function') {
            showNotification({ message: '独立聊天页面不支持网页总结', type: 'warning' });
          }
          return { ok: false, keepInput: true };
        }
        await performQuickSummary();
        return { ok: true };
      },
      requiresArgs: false
    },
    {
      name: 'history',
      aliases: ['hist'],
      usage: '/history',
      description: '打开聊天记录面板',
      handler: async () => {
        try {
          services.uiManager?.closeExclusivePanels?.();
          await chatHistoryUI?.showChatHistoryPanel?.('history');
        } catch (_) {}
      },
      requiresArgs: false
    }
  ];

  /**
   * 对外暴露的“命令元信息列表”，用于 UI 提示展示。
   * 注意：这里不暴露 handler，避免 UI 误调用业务逻辑。
   * @returns {Array<{name: string, usage: string, description: string, aliases: string[]}>}
   */
  function getSlashCommandList() {
    return slashCommandRegistry.map((item) => ({
      name: item.name,
      usage: item.usage,
      description: item.description,
      aliases: Array.isArray(item.aliases) ? item.aliases.slice() : []
    }));
  }

  /**
   * 解析输入文本，生成“用于 UI 展示”的斜杠命令提示列表。
   * @param {string} rawText
   * @returns {{ isActive: boolean, keyword: string, commands: Array<{name: string, usage: string, description: string, aliases: string[]}> }}
   */
  function getSlashCommandHints(rawText) {
    const trimmed = (typeof rawText === 'string' ? rawText : '').trimStart();
    if (!trimmed.startsWith('/')) {
      return { isActive: false, keyword: '', commands: [], items: [] };
    }
    if (trimmed.startsWith('//')) {
      return { isActive: false, keyword: '', commands: [], items: [] };
    }

    const body = trimmed.slice(1);
    const hasTrailingSpace = /\s$/.test(body);
    const normalizedBody = body.trim();
    const tokens = normalizedBody ? normalizedBody.split(/\s+/) : [];
    const commandToken = tokens[0] || '';
    const argsTokens = tokens.slice(1);
    const commandKeyword = commandToken.toLowerCase();

    const registry = slashCommandRegistry.slice();
    const allCommands = getSlashCommandList();

    if (!commandKeyword) {
      return { isActive: true, keyword: '', commands: allCommands, items: buildHintItemsFromCommands(registry, '') };
    }

    const matchedCommands = registry.filter((item) => {
      if (!item || !item.name) return false;
      if (item.name.startsWith(commandKeyword)) return true;
      return Array.isArray(item.aliases) && item.aliases.some(alias => alias.startsWith(commandKeyword));
    });

    const matchedPublic = allCommands.filter((item) => {
      if (!item || !item.name) return false;
      if (item.name.startsWith(commandKeyword)) return true;
      return Array.isArray(item.aliases) && item.aliases.some(alias => alias.startsWith(commandKeyword));
    });

    const primaryCommand = (() => {
      const exactByName = matchedCommands.find(item => item.name === commandKeyword);
      if (exactByName) return exactByName;
      const exactByAlias = matchedCommands.find(item => Array.isArray(item.aliases) && item.aliases.includes(commandKeyword));
      if (exactByAlias) return exactByAlias;
      if (matchedCommands.length === 1) return matchedCommands[0];
      return null;
    })();

    const items = buildHintItemsFromCommands(matchedCommands, commandKeyword);

    const shouldShowArgs = !!primaryCommand
      && typeof primaryCommand.getArgSuggestions === 'function'
      && (
        argsTokens.length > 0
        || hasTrailingSpace
        || (matchedCommands.length === 1 && commandKeyword.length > 0)
      );

    if (shouldShowArgs) {
      const argKeyword = hasTrailingSpace ? '' : (argsTokens[argsTokens.length - 1] || '');
      const argSuggestions = primaryCommand.getArgSuggestions({
        keyword: argKeyword,
        args: argsTokens,
        command: primaryCommand
      }) || [];

      argSuggestions.forEach((arg) => {
        const value = typeof arg?.value === 'string' ? arg.value : '';
        const label = typeof arg?.label === 'string' ? arg.label : value;
        const description = typeof arg?.description === 'string' ? arg.description : '';
        if (!value && !label) return;
        items.push({
          key: `${primaryCommand.name}::${value || label}`,
          kind: 'argument',
          label,
          description,
          usage: `/${primaryCommand.name} ${value || label}`,
          applyText: `/${primaryCommand.name} ${value || label}`,
          executeOnEnter: true
        });
      });
    }

    return {
      isActive: true,
      keyword: commandKeyword,
      commands: matchedPublic,
      items,
      context: {
        commandToken,
        argsTokens,
        primaryCommand: primaryCommand?.name || ''
      }
    };
  }

  /**
   * 将命令列表映射为提示项列表（用于 UI 渲染）。
   * @param {Array<Object>} commands
   * @param {string} keyword
   * @returns {Array<Object>}
   */
  function buildHintItemsFromCommands(commands, keyword) {
    return (commands || []).map((cmd) => {
      const requiresArgs = !!cmd?.requiresArgs;
      return {
        key: `cmd::${cmd.name}`,
        kind: 'command',
        label: `/${cmd.name}`,
        description: cmd.description || '',
        usage: cmd.usage || '',
        applyText: requiresArgs ? `/${cmd.name} ` : `/${cmd.name}`,
        executeOnEnter: !requiresArgs
      };
    });
  }

  /**
   * 解析并执行斜杠命令（仅在用户直接输入时调用）。
   * @param {string} rawText
   * @param {{ hasImages: boolean }} options
   * @returns {Promise<{ handled: boolean, overrideText?: string, keepInput?: boolean }>}
   */
  async function runSlashCommandIfMatched(rawText, options = {}) {
    const parsed = parseSlashCommand(rawText);
    if (!parsed) return { handled: false };

    if (parsed.type === 'escape') {
      return { handled: false, overrideText: parsed.text };
    }

    if (options.hasImages) {
      if (typeof showNotification === 'function') {
        showNotification({ message: '斜杠命令暂不支持图片，请先移除图片', type: 'warning' });
      }
      return { handled: true, keepInput: true };
    }

    const normalized = parsed.name || '';
    const command = slashCommandRegistry.find((item) => {
      if (!item || !item.name) return false;
      if (item.name === normalized) return true;
      return Array.isArray(item.aliases) && item.aliases.includes(normalized);
    });

    if (!command) {
      if (typeof showNotification === 'function') {
        showNotification({ message: `未知命令：/${normalized}，输入 /help 查看`, type: 'warning' });
      }
      return { handled: true, keepInput: true };
    }

    const result = await command.handler({
      args: parsed.args || [],
      raw: parsed.raw,
      argsText: parsed.argsText || ''
    });

    if (result && result.keepInput) {
      return { handled: true, keepInput: true };
    }

    return { handled: true };
  }

  function escapeMessageIdForSelector(id) {
    const raw = (id == null) ? '' : String(id);
    if (!raw) return '';
    try {
      if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        return CSS.escape(raw);
      }
    } catch (_) {}
    // 极简回退：避免引号/反斜杠破坏 attribute selector（messageId 目前是 msg_...，通常不会走到这里）
    return raw.replace(/["\\]/g, '\\$&');
  }

  function resolveMessageElementForSender(messageId) {
    const safeMessageId = escapeMessageIdForSelector(messageId);
    const selector = safeMessageId ? `.message[data-message-id="${safeMessageId}"]` : '';
    if (!selector) return null;
    return chatContainer?.querySelector(selector)
      || (threadContainer ? threadContainer.querySelector(selector) : null)
      || null;
  }

  /**
   * 读取当前滚动视口内“最靠上的可见消息元素”（阅读锚点）。
   *
   * 用途：当用户正在阅读对话中部/顶部时，如果我们更新了其上方某条消息（例如“重新生成”导致该消息变长），
   * 浏览器会因为内容高度变化而让视口中的内容整体下移/上移，造成“跳一下”的体验。
   * 这里通过锁定“当前屏幕上第一条可见消息”的 top 位置来抵消这种跳动。
   *
   * 性能：使用二分查找在 chatContainer.children 中定位第一个 bottom > scrollTop 的元素，避免每次遍历全部消息。
   *
   * @param {HTMLElement} container - chatContainer
   * @returns {HTMLElement|null}
   */
  function findFirstVisibleMessageElement(container) {
    if (!container) return null;
    const children = container.children;
    const total = children ? children.length : 0;
    if (!total) return null;

    const viewportTop = container.scrollTop || 0;
    const EPS = 1; // 允许 1px 误差，避免边界抖动

    let low = 0;
    let high = total - 1;
    let firstIdx = total;

    // 找到第一个满足：elementBottom > viewportTop 的元素
    while (low <= high) {
      const mid = (low + high) >> 1;
      const el = children[mid];
      const bottom = (el?.offsetTop || 0) + (el?.offsetHeight || 0);
      if (bottom <= viewportTop + EPS) {
        low = mid + 1;
      } else {
        firstIdx = mid;
        high = mid - 1;
      }
    }

    // 从 firstIdx 起向后找第一个 .message（chatContainer 理论上只包含 .message，这里做健壮性处理）
    for (let i = firstIdx; i < total; i += 1) {
      const el = children[i];
      if (el && el.classList && el.classList.contains('message')) return el;
    }
    return null;
  }

  /**
   * 仅在“重新生成（原地替换指定 AI 消息）且目标消息位于当前阅读位置上方”时，捕获阅读锚点。
   *
   * 捕获内容：锚点 messageId + 锚点 top 相对于容器视口的偏移（offsetTop - scrollTop）。
   * 后续在 DOM 更新后，通过调整 scrollTop 把该偏移恢复，从而保持用户阅读位置不跳动。
   *
   * @param {HTMLElement} container
   * @param {string|null} targetMessageId - 正在被更新的目标 AI 消息ID
   * @param {Object|null} attemptState - 当前请求 attempt
   * @returns {{ anchorId: string, anchorOffset: number } | null}
   */
  function captureReadingAnchorForRegenerate(container, targetMessageId, attemptState) {
    if (!attemptState || attemptState.preserveReadingPosition !== true) return null;
    if (!targetMessageId || targetMessageId !== attemptState.preserveTargetMessageId) return null;

    const safeTargetId = escapeMessageIdForSelector(targetMessageId);
    const targetEl = container.querySelector(`.message[data-message-id="${safeTargetId}"]`);
    if (!targetEl) return null;

    const viewportTop = container.scrollTop || 0;
    const viewportBottom = viewportTop + (container.clientHeight || 0);
    const targetTop = targetEl.offsetTop || 0;
    const targetBottom = targetTop + (targetEl.offsetHeight || 0);
    const isTargetVisible = targetBottom > viewportTop && targetTop < viewportBottom;
    // 仅在目标消息“出现在当前视口内”时锁定阅读位置，避免视口外消息被反复“吸住”在顶部。
    if (!isTargetVisible) return null;

    const anchorEl = findFirstVisibleMessageElement(container);
    if (!anchorEl) return null;

    const anchorId = anchorEl.getAttribute('data-message-id') || '';
    if (!anchorId) return null;

    // 只有当“目标消息在锚点之前”（也就是目标位于用户阅读位置上方）时才需要补偿滚动
    try {
      if (anchorEl === targetEl) return null;
      const pos = targetEl.compareDocumentPosition(anchorEl);
      const isTargetAboveAnchor = !!(pos & Node.DOCUMENT_POSITION_FOLLOWING);
      if (!isTargetAboveAnchor) return null;
    } catch (_) {
      return null;
    }

    return {
      anchorId,
      anchorOffset: (anchorEl.offsetTop || 0) - (container.scrollTop || 0)
    };
  }

  /**
   * 恢复阅读锚点位置：让锚点消息的 top 坐标保持不变，避免视图跳动。
   * @param {HTMLElement} container
   * @param {{ anchorId: string, anchorOffset: number } | null} anchorInfo
   */
  function restoreReadingAnchor(container, anchorInfo) {
    if (!container || !anchorInfo) return;
    const anchorId = anchorInfo.anchorId || '';
    if (!anchorId) return;

    const safeAnchorId = escapeMessageIdForSelector(anchorId);
    const anchorEl = container.querySelector(`.message[data-message-id="${safeAnchorId}"]`);
    if (!anchorEl) return;

    const currentOffset = (anchorEl.offsetTop || 0) - (container.scrollTop || 0);
    const delta = currentOffset - (Number(anchorInfo.anchorOffset) || 0);
    if (!Number.isFinite(delta) || Math.abs(delta) < 0.5) return;

    // 关键：补偿 scrollTop，使锚点消息回到原来的像素位置
    container.scrollTop = (container.scrollTop || 0) + delta;
  }


  // 重新生成时清理用户手动折叠标记，确保新的思考过程按默认规则自动展开/折叠。
  function resetThoughtsToggleStateForRegenerate(targetElement) {
    if (!targetElement) return;
    const thoughtsContent = targetElement.querySelector('.thoughts-content');
    if (!thoughtsContent) return;
    if (thoughtsContent.dataset && thoughtsContent.dataset.userToggled) {
      delete thoughtsContent.dataset.userToggled;
    }
    if (thoughtsContent.dataset) {
      delete thoughtsContent.dataset.manualState;
      delete thoughtsContent.dataset.autoLifecycleInitialized;
      delete thoughtsContent.dataset.autoCollapsedAfterAnswerStart;
      delete thoughtsContent.dataset.autoCollapsedAfterFinish;
    }
  }

  function resetResponsesActivityToggleStateForRegenerate(targetElement) {
    if (!targetElement) return;
    const timelineRoot = targetElement.querySelector('.response-activity-timeline');
    try {
      services?.messageProcessor?.clearResponseActivityUiState?.(targetElement);
    } catch (_) {}
    if (!timelineRoot || !timelineRoot.dataset) return;
    delete timelineRoot.dataset.panelUserToggled;
    delete timelineRoot.dataset.panelManualState;
    delete timelineRoot.dataset.panelExpanded;
    delete timelineRoot.dataset.panelPeek;
    delete timelineRoot.dataset.panelAutoLifecycleInitialized;
    delete timelineRoot.dataset.panelAutoCollapsedAfterAnswerStart;
    delete timelineRoot.dataset.panelAutoCollapsedAfterFinish;
    delete timelineRoot.dataset.expandedToolKeys;
    delete timelineRoot.dataset.collapsedInProgressToolKeys;
    delete timelineRoot.dataset.manualExpandedToolKeys;
    delete timelineRoot.dataset.manualCollapsedToolKeys;
    delete timelineRoot.dataset.autoCollapsedToolKeys;
  }

  function applyResponsesActivityTimelineToNode(node, timeline) {
    if (!node || typeof node !== 'object') return false;
    const normalizedTimeline = mergeResponsesActivityTimeline([], timeline);
    if (normalizedTimeline.length > 0) {
      node.response_activity_timeline = cloneResponsesActivityTimeline(normalizedTimeline);
      if (!isResponsesActivityTimelineInProgress(normalizedTimeline)) {
        const startedAt = Number(node.timestamp) || 0;
        if (startedAt > 0) {
          node.response_activity_duration_ms = Math.max(0, Date.now() - startedAt);
        }
      } else {
        delete node.response_activity_duration_ms;
      }
    } else {
      delete node.response_activity_timeline;
      delete node.response_activity_duration_ms;
    }
    delete node.response_reasoning_summary;
    delete node.response_tool_calls;
    node.thoughtsRaw = null;
    return true;
  }

  /**
   * 把“后续可直接重放进 Responses input 的历史 item”写回消息节点。
   *
   * 设计说明：
   * - 这不是展示字段，而是 transport/history 字段；
   * - 目标是让后续 turn 能像 Codex 一样直接重放本 turn 的 tool call / tool output / assistant item；
   * - 字段里保存的内容已经过轻量清洗，避免携带仅对单次响应有效的 `id` / `status`。
   *
   * @param {Object|null} node
   * @param {Array<Object>|null|undefined} items
   * @returns {boolean}
   */
  function applyResponsesInputItemsToNode(node, items) {
    if (!node || typeof node !== 'object') return false;
    const normalizedItems = cloneResponsesReplayOutputItems(items);
    if (normalizedItems.length > 0) {
      node.response_input_items = normalizedItems;
    } else {
      delete node.response_input_items;
    }
    return true;
  }

  function applyResponsesAssistantPhaseToNode(node, phase) {
    if (!node || typeof node !== 'object') return false;
    const normalizedPhase = normalizeResponsesMessagePhase(phase);
    if (normalizedPhase) {
      node.phase = normalizedPhase;
    } else {
      delete node.phase;
    }
    return true;
  }

  /**
   * 将 Responses 相关的“模型可见历史元信息”统一写回消息节点。
   *
   * 这里把展示时间线、assistant phase、可重放 input item 分开存储：
   * - timeline / phase 主要服务 UI；
   * - inputItems 主要服务后续 turn 的 prompt 重放；
   * - 三者虽然来自同一条 Responses turn，但职责不同，拆开更利于未来继续对齐 Codex 的 queue / steer。
   *
   * @param {Object|null} node
   * @param {{timeline?:Array<Object>|null, phase?:string|null, inputItems?:Array<Object>|null}} meta
   * @returns {boolean}
   */
  function applyResponsesMetadataToNode(node, meta = {}) {
    if (!node || typeof node !== 'object') return false;
    applyResponsesActivityTimelineToNode(node, meta.timeline);
    applyResponsesAssistantPhaseToNode(node, meta.phase);
    applyResponsesInputItemsToNode(node, meta.inputItems);
    return true;
  }

  /**
   * 重新生成（原地替换）时清空旧的“推理签名/推理字段”。
   *
   * 设计说明：
   * - 推理签名与“该条 assistant 的回答/推理内容”绑定；
   * - 当我们开始把新的生成结果写回到旧消息时，旧签名将不再匹配；
   * - 若本次响应未返回新签名，就必须保持为空，否则后续把历史回传给上游时会触发
   *   “signature required / invalid signature” 等校验错误；
   * - 这里同时清理 OpenAI 兼容字段（reasoning_content/tool_calls）以及 Responses 元信息
   *   （response_activity_timeline/response_reasoning_summary/response_tool_calls/response_input_items），
   *   避免旧内容残留导致语义错配。
   *
   * 注意：只在“原地替换的重新生成”场景触发；普通追加新消息不需要清理。
   *
   * @param {string|null} messageId
   * @param {Object|null} attemptState
   * @returns {boolean} 是否发生了清空
   */
  function clearBoundSignatureForRegenerate(messageId, attemptState) {
    const id = (typeof messageId === 'string' && messageId.trim()) ? messageId.trim() : '';
    if (!id) return false;
    if (!attemptState || attemptState.preserveTargetMessageId !== id) return false;

    try {
      const node = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === id) || null;
      if (!node || node.role !== 'assistant') return false;

      node.thoughtSignature = null;
      node.thoughtSignatureSource = null;
      node.reasoning_content = null;
      node.tool_calls = null;
      delete node.phase;
      delete node.response_activity_timeline;
      delete node.response_activity_duration_ms;
      delete node.response_reasoning_summary;
      delete node.response_tool_calls;
      delete node.response_input_items;
      // 原地替换时清空旧的 token 用量，避免本次请求未回传 usage 时显示陈旧数据。
      node.apiUsage = null;
      const safeMessageId = escapeMessageIdForSelector(id);
      const selector = safeMessageId ? `.message[data-message-id="${safeMessageId}"]` : '';
      const element = selector
        ? (chatContainer.querySelector(selector)
          || (threadContext?.container ? threadContext.container.querySelector(selector) : null))
        : null;
      if (element) {
        syncAttemptAssistantView(id, {
          attemptState,
          node,
          fallbackElement: element
        });
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function attachManualRetryAction(messageElement, retryFn) {
    if (!messageElement || typeof retryFn !== 'function') return;
    if (messageElement.querySelector('.error-retry-actions')) return;

    /**
     * 规范化消息 DOM，确保状态文本写入 `.text-content`，避免直接覆写根节点导致结构残留。
     * @param {HTMLElement|null} element
     * @returns {HTMLElement|null}
     */
    const ensureMessageTextContainer = (element) => {
      if (!element) return null;
      try {
        const rootTextNodes = Array.from(element.childNodes || []).filter(node => node && node.nodeType === 3);
        rootTextNodes.forEach((node) => node.remove());
      } catch (_) {}
      let textContentDiv = element.querySelector('.text-content');
      if (textContentDiv) return textContentDiv;
      textContentDiv = document.createElement('div');
      textContentDiv.classList.add('text-content');
      const thoughtsDiv = element.querySelector('.thoughts-content');
      const apiFooter = element.querySelector('.api-footer');
      if (thoughtsDiv && thoughtsDiv.nextSibling) {
        element.insertBefore(textContentDiv, thoughtsDiv.nextSibling);
      } else if (apiFooter && apiFooter.parentNode === element) {
        element.insertBefore(textContentDiv, apiFooter);
      } else {
        element.appendChild(textContentDiv);
      }
      return textContentDiv;
    };

    /**
     * 设置消息状态文本，并按需清理错误态残留元素。
     * @param {HTMLElement|null} element
     * @param {string} text
     * @param {{clearRetryActions?: boolean, clearThoughts?: boolean, clearTitle?: boolean}} [options]
     */
    const setMessageStatusText = (element, text, options = {}) => {
      if (!element) return;
      const normalizedOptions = (options && typeof options === 'object') ? options : {};
      const safeText = (typeof text === 'string') ? text : String(text ?? '');

      if (normalizedOptions.clearRetryActions) {
        try {
          element.querySelectorAll('.error-retry-actions').forEach((actionEl) => actionEl.remove());
        } catch (_) {}
      }
      if (normalizedOptions.clearThoughts) {
        try {
          element.querySelectorAll('.thoughts-content').forEach((thoughtsEl) => thoughtsEl.remove());
        } catch (_) {}
        try {
          element.querySelectorAll('.response-activity-timeline, .response-tool-calls').forEach((panelEl) => panelEl.remove());
        } catch (_) {}
      }

      const textContentDiv = ensureMessageTextContainer(element);
      if (textContentDiv) {
        textContentDiv.textContent = safeText;
      } else {
        element.textContent = safeText;
      }
      element.setAttribute('data-original-text', safeText);

      if (normalizedOptions.clearTitle) {
        try { element.removeAttribute('title'); } catch (_) {}
      }
    };

    /**
     * 清理错误态样式与重试按钮，避免重试后遗留红字/旧操作区。
     * @param {HTMLElement|null} element
     */
    const resetErrorUiState = (element) => {
      if (!element) return;
      try {
        element.classList.remove('assistant-pre-response');
        element.classList.remove('error-message');
        element.classList.remove('loading-message');
        element.classList.remove('regenerating');
      } catch (_) {}
      try {
        element.querySelectorAll('.assistant-pre-response-status').forEach((statusEl) => statusEl.remove());
      } catch (_) {}
      try {
        element.querySelectorAll('.error-retry-actions').forEach((actionEl) => actionEl.remove());
      } catch (_) {}
    };

    const actions = document.createElement('div');
    actions.className = 'error-retry-actions';

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'error-retry-btn';
    retryBtn.textContent = '重试';
    retryBtn.title = '重新发送本次请求';
    retryBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (retryBtn.disabled) return;
      const boundMessageId = (messageElement.getAttribute('data-message-id') || '').trim();
      const retryTargetAiMessageId = normalizeConversationId(retryFn?.__targetAiMessageId || '');
      const retryTargetElement = retryTargetAiMessageId
        ? findVisibleMessageElementById(retryTargetAiMessageId)
        : null;
      const reuseElement = boundMessageId
        ? messageElement
        : (retryTargetElement || null);
      const reuseMessageId = (reuseElement?.getAttribute?.('data-message-id') || '').trim();
      const isEphemeralErrorMessage = !boundMessageId;
      const shouldReuseErrorBubble = !!reuseElement && !!reuseMessageId;
      const originalErrorText = (reuseElement?.getAttribute?.('data-original-text')
        || messageElement.getAttribute('data-original-text')
        || messageElement.querySelector('.text-content')?.textContent
        || ''
      ).trim();
      let retryResult = null;
      retryBtn.disabled = true;
      const originalText = retryBtn.textContent;
      retryBtn.textContent = '重试中...';
      if (shouldReuseErrorBubble) {
        // 有 message-id 的错误消息可被后续请求原地复用，因此在原节点上切换到“重试中”状态。
        resetErrorUiState(reuseElement);
        setMessageStatusText(reuseElement, '正在重试...', {
          clearRetryActions: true,
          clearThoughts: true,
          clearTitle: true
        });
        reuseElement.classList.add('loading-message');
        reuseElement.classList.add('updating');
        try {
          messageProcessor?.syncAssistantMessageMetadata?.(
            reuseMessageId || null,
            { role: 'assistant' },
            {
              fallbackElement: reuseElement,
              runtimeSnapshot: {
                activeTurn: {
                  status: 'streaming',
                  boundAssistantMessageId: reuseMessageId || null,
                  preResponseStatus: createAssistantPreResponseStatus('正在准备请求...', 'manual_retry')
                }
              }
            }
          );
        } catch (_) {}
        if (messageElement !== reuseElement) {
          resetErrorUiState(messageElement);
          if (messageElement.isConnected) {
            messageElement.remove();
          }
        }
      } else {
        // 无 message-id 的错误占位无法被 sendMessageCore 复用。
        // 这里先移除该占位，避免与后续新建的 loading 占位并存，导致“重试时出现两条消息”。
        resetErrorUiState(messageElement);
        if (messageElement.isConnected) {
          messageElement.remove();
        }
      }
      try {
        retryResult = await retryFn();
      } catch (error) {
        console.error('手动重试执行失败:', error);
      } finally {
        // 无 message-id 的错误占位不会被后续请求复用，重试结束后移除，避免残留状态干扰阅读。
        if (isEphemeralErrorMessage && messageElement.isConnected) {
          messageElement.remove();
        }
        // 某些前置校验失败会导致 retryFn 提前返回，此时需要兜底清理“重试中”视觉状态，避免假死残留。
        if (!isEphemeralErrorMessage && messageElement.isConnected) {
          const succeeded = !!(retryResult && retryResult.ok === true);
          if (!succeeded) {
            resetErrorUiState(messageElement);
            setMessageStatusText(messageElement, originalErrorText || '重试失败，请再次尝试。', {
              clearRetryActions: true,
              clearThoughts: true,
              clearTitle: true
            });
            messageElement.classList.add('error-message');
            messageElement.classList.remove('loading-message');
            messageElement.classList.remove('updating');
            messageElement.classList.remove('regenerating');
            attachManualRetryAction(messageElement, retryFn);
          }
        }
        if (retryBtn.isConnected) {
          retryBtn.disabled = false;
          retryBtn.textContent = originalText;
        }
      }
    });

    retryBtn.dataset.retryTargetAiMessageId = normalizeConversationId(retryFn?.__targetAiMessageId || '') || '';

    actions.appendChild(retryBtn);
    messageElement.appendChild(actions);
  }

  /**
   * 验证API配置是否有效
   * @private
   * @returns {boolean} 配置是否有效
   */
  function hasValidApiKey(apiKey) {
    if (Array.isArray(apiKey)) {
      return apiKey.some(key => typeof key === 'string' && key.trim());
    }
    if (typeof apiKey === 'string') return apiKey.trim().length > 0;
    return false;
  }

  // API 凭证既支持“输入框内联 key”，也支持“本地 key 文件路径”。
  function hasValidApiKeyFilePath(apiKeyFilePath) {
    return (typeof apiKeyFilePath === 'string') && apiKeyFilePath.trim().length > 0;
  }

  function hasValidApiBaseUrl(baseUrl, config) {
    if (isGeminiApiConfig(config)) return true;
    return (typeof baseUrl === 'string') && baseUrl.trim().length > 0;
  }

  function hasUsableApiCredential(config) {
    if (!config || typeof config !== 'object') return false;
    if (hasValidApiKey(config.apiKey) || hasValidApiKeyFilePath(config.apiKeyFilePath)) {
      return true;
    }
    // 允许所有连接方式在 key 留空时走“免 key”请求（常见于本地反代/网关注入鉴权）。
    return true;
  }

  function validateApiConfig(config) {
    const target = config || apiManager.getSelectedConfig();
    if (!hasValidApiBaseUrl(target?.baseUrl, target) || !hasUsableApiCredential(target)) {
      messageProcessor.appendMessage('请在设置中完善 API 配置', 'ai', true);
      return false;
    }
    return true;
  }

  // 解析外部 api 参数：对 'follow_current' / 'selected' 视作“无显式覆盖”，让会话锁定继续生效
  function resolveApiParamForSend(apiParam) {
    if (apiParam == null || typeof apiManager?.resolveApiParam !== 'function') return null;
    if (typeof apiParam === 'string') {
      const key = apiParam.trim().toLowerCase();
      if (key === 'follow_current' || key === 'selected') return null;
    }
    try {
      return apiManager.resolveApiParam(apiParam);
    } catch (_) {
      return null;
    }
  }

  async function getPageContentReadResult(rawArgs) {
    try {
      console.log('发送 page_content_read 结果请求');
      const targetTabId = await utils?.resolveBoundSidebarTargetTabId?.();
      return await chrome.runtime.sendMessage({
        type: 'GET_PAGE_CONTENT_READ_RESULT_FROM_SIDEBAR',
        tabId: Number.isFinite(Number(targetTabId)) ? Number(targetTabId) : null,
        args: rawArgs && typeof rawArgs === 'object' ? rawArgs : null
      });
    } catch (error) {
      console.error('获取 page_content_read 结果失败:', error);
      return null;
    }
  }

  async function getPdfContentReadResult(rawArgs) {
    try {
      console.log('发送 pdf_content_read 结果请求');
      const targetTabId = await utils?.resolveBoundSidebarTargetTabId?.();
      return await chrome.runtime.sendMessage({
        type: 'GET_PDF_CONTENT_READ_RESULT_FROM_SIDEBAR',
        tabId: Number.isFinite(Number(targetTabId)) ? Number(targetTabId) : null,
        args: rawArgs && typeof rawArgs === 'object' ? rawArgs : null
      });
    } catch (error) {
      console.error('获取 pdf_content_read 结果失败:', error);
      return null;
    }
  }

  async function getWebpageScreenshotResult(rawArgs) {
    try {
      console.log('发送 webpage_screenshot 结果请求');
      const targetTabId = await utils?.resolveBoundSidebarTargetTabId?.();
      return await chrome.runtime.sendMessage({
        type: 'GET_WEBPAGE_SCREENSHOT_RESULT_FROM_SIDEBAR',
        tabId: Number.isFinite(Number(targetTabId)) ? Number(targetTabId) : null,
        args: rawArgs && typeof rawArgs === 'object' ? rawArgs : null
      });
    } catch (error) {
      console.error('获取 webpage_screenshot 结果失败:', error);
      return null;
    }
  }

  /**
   * 在重新生成开始前重置既有 AI 消息的基础时序/usage 元信息。
   *
   * 说明：
   * - 这里是 sendMessageCore 早期阶段可调用的轻量版本，不依赖 handleStreamResponse 内部局部 helper；
   * - 只负责把旧的 startedAt / usage / duration 清空到“本轮重新开始”的状态；
   * - 更完整的首帧/完成时序仍由后续流式或非流式处理链路覆盖。
   *
   * @param {string|null} messageId
   * @param {Object|null} attemptState
   * @param {HTMLElement|null} [fallbackElement]
   */
  function resetAssistantResponseMetaForRegenerateStart(messageId, attemptState, fallbackElement = null) {
    const id = normalizeConversationId(messageId);
    if (!id) return;
    const startedAtMs = Number.isFinite(Number(attemptState?.startedAt))
      ? Number(attemptState.startedAt)
      : Date.now();
    const node = resolveAttemptAiNode(attemptState, id)
      || chatHistoryManager?.chatHistory?.messages?.find?.((item) => item?.id === id)
      || null;
    if (node) {
      node.timestamp = startedAtMs;
      node.apiUsage = null;
      node.responseTiming = {
        startedAtMs,
        firstVisibleOutputAtMs: null,
        completedAtMs: null,
        generationDurationMs: null,
        thinkingDurationMs: null,
        outputDurationMs: null
      };
      delete node.response_activity_duration_ms;
    }
    const element = (fallbackElement instanceof HTMLElement)
      ? fallbackElement
      : findVisibleMessageElementById(id);
    syncAttemptAssistantView(id, {
      attemptState,
      node,
      fallbackElement: element || null,
      suppressMissingNodeWarning: true
    });
  }

  /**
   * 获取当前侧栏绑定网页标签页的 JS Runtime frame 快照。
   * 这里的目标不是让模型再额外调用发现工具，而是在请求发出前把 frame_id 提示直接塞进隐藏上下文。
   *
   * @returns {Promise<Array<{frameId:number, documentId:string|null, url:string, title:string, isTop:boolean}>|null>}
   */
  async function getJsRuntimeFrameSnapshot(runtimeEnvironment = JS_RUNTIME_ENV_BOUND_HOST_PAGE) {
    if (typeof utils?.getJsRuntimeFrames !== 'function') return null;
    try {
      const response = await utils.getJsRuntimeFrames({ runtimeEnvironment });
      if (response?.success !== true || !Array.isArray(response?.frames)) {
        return null;
      }
      const frames = response.frames
        .map((item) => ({
          frameId: Number(item?.frameId),
          documentId: (typeof item?.documentId === 'string' && item.documentId) ? item.documentId : null,
          url: (typeof item?.url === 'string') ? item.url : '',
          title: (typeof item?.title === 'string') ? item.title : '',
          isTop: item?.isTop === true || Number(item?.frameId) === 0
        }))
        .filter(item => Number.isFinite(item.frameId))
        .sort((a, b) => {
          if (a.isTop !== b.isTop) return a.isTop ? -1 : 1;
          return a.frameId - b.frameId;
        });
      return frames.length > 0 ? frames : null;
    } catch (error) {
      console.warn('获取 JS Runtime frame 快照失败（忽略，上下文将不注入 frame 列表）:', error);
      return null;
    }
  }

  function buildCurrentPageMetaSnapshot() {
    const url = typeof state?.pageInfo?.url === 'string' ? state.pageInfo.url.trim() : '';
    const title = typeof state?.pageInfo?.title === 'string' ? state.pageInfo.title.trim() : '';
    if (!url && !title) return null;
    return { url, title };
  }

  /**
   * 获取“当前这轮工具链”使用的聊天记录绝对编号快照。
   *
   * 为什么这里要做快照缓存：
   * - `history_search` 返回的是外部数字编号，不暴露内部 conversationId/messageId；
   * - 若同一轮里先 search 再 read，而我们每次都重新按全库生成编号，
   *   则在会话新增/删除/时间更新后可能造成 conv_ref 漂移；
   * - 因此这里把“本轮工具链看到的聊天记录编号”冻结在第一次调用时，
   *   保证同一 assistant turn 内 search/read 引用稳定。
   *
   * @param {Object|null} attemptState
   * @returns {Promise<ReturnType<typeof buildConversationReferenceSnapshot>>}
   */
  async function getHistoryToolSnapshot(attemptState = null) {
    if (attemptState?.historyToolSnapshot) {
      return attemptState.historyToolSnapshot;
    }
    if (attemptState?.historyToolSnapshotPromise) {
      return attemptState.historyToolSnapshotPromise;
    }

    const loadPromise = (async () => {
      const metas = await getAllConversationMetadata();
      const snapshot = buildConversationReferenceSnapshot(metas);
      if (attemptState && typeof attemptState === 'object') {
        attemptState.historyToolSnapshot = snapshot;
      }
      return snapshot;
    })();

    if (attemptState && typeof attemptState === 'object') {
      attemptState.historyToolSnapshotPromise = loadPromise;
    }

    try {
      return await loadPromise;
    } finally {
      if (attemptState && typeof attemptState === 'object') {
        delete attemptState.historyToolSnapshotPromise;
      }
    }
  }

  /**
   * 从当前会话链里找到“本轮真实参与请求的最后一条 user 节点”。
   *
   * 说明：
   * - 普通发送：它就是刚刚新增的用户消息；
   * - regenerate：它是被重新回答的那条 assistant 之前的最后一条 user；
   * - 标准 steer / tool follow-up 不会走这里，因为它们不生成新的顶层 request user turn。
   *
   * @param {Array<any>} conversationChain
   * @returns {any|null}
   */
  function findLatestUserNodeInConversationChain(conversationChain) {
    const chain = Array.isArray(conversationChain) ? conversationChain : [];
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const node = chain[i];
      if (String(node?.role || '').trim().toLowerCase() !== 'user') continue;
      return node;
    }
    return null;
  }

  /**
   * 查找在当前目标 user 节点之前最近一次生效的某类隐藏上下文签名。
   *
   * @param {Array<any>} chain
   * @param {number} targetIndex
   * @param {string} fieldName
   * @returns {string}
   */
  function findPreviousEffectiveUserContextSignature(chain, targetIndex, fieldName) {
    const field = (typeof fieldName === 'string') ? fieldName.trim() : '';
    if (!field) return '';
    for (let index = targetIndex - 1; index >= 0; index -= 1) {
      const node = chain[index];
      if (String(node?.role || '').trim().toLowerCase() !== 'user') continue;
      const signature = (typeof node?.[field] === 'string') ? node[field] : '';
      if (!signature) continue;
      return signature;
    }
    return '';
  }

  /**
   * 将“页面运行环境 / 通用环境”的隐藏 contextual items 写到目标 user 节点上。
   *
   * 它不会污染用户正文，而是挂到独立字段：
   * - `contextual_input_items_before`
   * - `pageRuntimeContextSignature`
   * - `environmentContextSignature`
   *
   * 同时采用“只有变化时才追加”的策略：
   * - 若与更早一次已生效的签名一致，则当前节点保持为空；
   * - 这样后续请求既能让模型看到最新环境，又不会每轮重复插入相同前缀。
   *
   * @param {{
   *   conversationChain?: Array<any>,
   *   targetUserNode?: any,
   *   pageRuntimeContextPayload?: Object|null,
   *   microSkillContextPayload?: Object|null,
   *   environmentContextPayload?: Object|null
   * }} options
   * @returns {boolean}
   */
  function syncUserContextualInputsForConversationTurn(options = {}) {
    const chain = Array.isArray(options?.conversationChain) ? options.conversationChain : [];
    const targetUserNode = options?.targetUserNode || null;
    if (!targetUserNode || String(targetUserNode?.role || '').trim().toLowerCase() !== 'user') {
      return false;
    }

    const payload = (options?.pageRuntimeContextPayload && typeof options.pageRuntimeContextPayload === 'object')
      ? options.pageRuntimeContextPayload
      : null;
    const environmentContextPayload = (options?.environmentContextPayload && typeof options.environmentContextPayload === 'object')
      ? options.environmentContextPayload
      : null;
    const microSkillContextPayload = (options?.microSkillContextPayload && typeof options.microSkillContextPayload === 'object')
      ? options.microSkillContextPayload
      : null;

    const targetIndex = chain.findIndex((node) => node && node.id === targetUserNode.id);
    const pageAttachment = resolvePageRuntimeContextAttachment({
      payload,
      previousEffectiveSignature: findPreviousEffectiveUserContextSignature(
        chain,
        targetIndex,
        'pageRuntimeContextSignature'
      )
    });
    const environmentAttachment = resolveEnvironmentContextAttachment({
      payload: environmentContextPayload,
      previousEffectiveSignature: findPreviousEffectiveUserContextSignature(
        chain,
        targetIndex,
        'environmentContextSignature'
      )
    });
    const microSkillAttachment = resolveMicroSkillContextAttachment({
      payload: microSkillContextPayload,
      previousEffectiveSignature: findPreviousEffectiveUserContextSignature(
        chain,
        targetIndex,
        'microSkillContextSignature'
      )
    });

    const contextualItems = [];
    if (Array.isArray(environmentAttachment.inputItems) && environmentAttachment.inputItems.length > 0) {
      contextualItems.push(...environmentAttachment.inputItems);
    }
    if (Array.isArray(pageAttachment.inputItems) && pageAttachment.inputItems.length > 0) {
      contextualItems.push(...pageAttachment.inputItems);
    }
    if (Array.isArray(microSkillAttachment.inputItems) && microSkillAttachment.inputItems.length > 0) {
      contextualItems.push(...microSkillAttachment.inputItems);
    }

    targetUserNode.contextual_input_items_before = contextualItems.length > 0
      ? cloneResponsesInputItems(contextualItems)
      : null;
    targetUserNode.pageRuntimeContextSignature = pageAttachment.signature || null;
    targetUserNode.environmentContextSignature = environmentAttachment.signature || null;
    targetUserNode.microSkillContextSignature = microSkillAttachment.signature || null;
    return true;
  }

  /**
   * 提取“最后一条 user 消息”的发送正文。
   *
   * @param {Array<Object>} messages
   * @returns {string|Array<any>|null}
   */
  function getLatestUserMessageContent(messages) {
    const list = Array.isArray(messages) ? messages : [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const item = list[i];
      if (String(item?.role || '').trim().toLowerCase() !== 'user') continue;
      return cloneDataSafely(item?.content);
    }
    return null;
  }

  /**
   * 比较两个值是否在“可 JSON 化数据”意义上相等。
   *
   * @param {any} left
   * @param {any} right
   * @returns {boolean}
   */
  function isDeepEqual(left, right) {
    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch (_) {
      return left === right;
    }
  }

  /**
   * 将“本次实际发送给模型的 user 正文”写回历史节点。
   *
   * 说明：
   * - node.content 继续代表 UI 中展示给用户看的原始内容；
   * - node.outboundContent 代表真正发给模型的稳定正文快照；
   * - 这样下一轮 composeMessages 才能精确重放前一轮的 prompt 前缀。
   *
   * @param {{attemptState?: Object|null, userMessageId?: string|null, detachedUserMessageNode?: Object|null, outboundContent?: any}} options
   * @returns {boolean}
   */
  function syncHistoryUserOutboundContent(options = {}) {
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const userMessageId = normalizeConversationId(normalizedOptions.userMessageId);
    const outboundContent = cloneDataSafely(normalizedOptions.outboundContent);
    const candidateNode = userMessageId
      ? resolveAttemptMessageNode(normalizedOptions.attemptState, userMessageId)
      : (normalizedOptions.detachedUserMessageNode || null);
    const node = candidateNode && String(candidateNode.role || '').toLowerCase() === 'user'
      ? candidateNode
      : null;
    if (!node) return false;

    if (outboundContent == null || isDeepEqual(node.content, outboundContent)) {
      node.outboundContent = null;
      return true;
    }
    node.outboundContent = outboundContent;
    return true;
  }

  /**
   * 解析当前会话应该使用的稳定 prompt_cache_key。
   *
   * @param {{requestBody?: Object|null, usedApiConfig?: Object|null, attemptState?: Object|null, conversationIdHint?: string, runtimeConversationKeyHint?: string}} options
   * @returns {string}
   */
  function resolveAutoResponsesPromptCacheKey(options = {}) {
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const requestBody = (normalizedOptions.requestBody && typeof normalizedOptions.requestBody === 'object')
      ? normalizedOptions.requestBody
      : null;
    const explicitKey = normalizeResponsesPromptCacheKey(
      requestBody?.prompt_cache_key
        || normalizedOptions.usedApiConfig?.responsesApiSettings?.prompt_cache_key
    );
    if (explicitKey) {
      return explicitKey;
    }

    const attemptState = normalizedOptions.attemptState || null;
    const existingKey = normalizeResponsesPromptCacheKey(
      attemptState?.historyPromptCacheKey
        || chatHistoryManager?.getConversationPromptCacheKey?.()
        || chatHistoryManager?.chatHistory?.promptCacheKey
    );
    if (existingKey) {
      if (attemptState) attemptState.historyPromptCacheKey = existingKey;
      if (typeof chatHistoryManager?.setConversationPromptCacheKey === 'function') {
        chatHistoryManager.setConversationPromptCacheKey(existingKey);
      } else if (chatHistoryManager?.chatHistory) {
        chatHistoryManager.chatHistory.promptCacheKey = existingKey;
      }
      return existingKey;
    }

    const normalizedConversationId = normalizeConversationId(normalizedOptions.conversationIdHint)
      || normalizeConversationId(attemptState?.boundConversationId)
      || normalizeConversationId(currentConversationId)
      || normalizeConversationId(chatHistoryUI?.getCurrentConversationId?.());
    const draftConversationKey = (typeof normalizedOptions.runtimeConversationKeyHint === 'string'
      && normalizedOptions.runtimeConversationKeyHint.trim())
      ? normalizedOptions.runtimeConversationKeyHint.trim()
      : (attemptState?.runtimeConversationKey || getCurrentActiveConversationQueueKey());
    const generatedKey = buildDefaultResponsesPromptCacheKey({
      conversationId: normalizedConversationId,
      draftConversationKey
    });
    if (!generatedKey) return '';

    if (attemptState) attemptState.historyPromptCacheKey = generatedKey;
    if (typeof chatHistoryManager?.setConversationPromptCacheKey === 'function') {
      chatHistoryManager.setConversationPromptCacheKey(generatedKey);
    } else if (chatHistoryManager?.chatHistory) {
      chatHistoryManager.chatHistory.promptCacheKey = generatedKey;
    }
    return generatedKey;
  }

  function GetInputContainer() {
    return document.getElementById('input-container');
  }

  // 根据当前 API 与模式刷新输入框 placeholder，避免被模式切换覆盖成固定文案。
  function updateMessageInputPlaceholder() {
    if (!messageInput) return;
    const apiInfo = (typeof chatHistoryUI?.resolveActiveConversationApiConfig === 'function')
      ? chatHistoryUI.resolveActiveConversationApiConfig()
      : null;
    const currentConfig = apiInfo?.displayConfig || apiManager?.getSelectedConfig?.() || null;
    const buildPlaceholder = utils?.buildMessageInputPlaceholder;
    const placeholder = (typeof buildPlaceholder === 'function')
      ? buildPlaceholder(currentConfig, { isTemporaryMode })
      : (isTemporaryMode ? '纯对话模式，输入消息...' : '输入消息...');
    messageInput.setAttribute('placeholder', placeholder);
  }

  /**
   * 解析“当前这轮请求”的页面工具暴露状态。
   *
   * 这里专门把模式判断收口成一个 helper，避免：
   * - 某些地方只看 `isStandalone`；
   * - 某些地方只看 `isTemporaryMode`；
   * - 最终导致工具描述、工具暴露、真实执行环境三者不一致。
   *
   * @param {Object|null} [attemptState]
   * @returns {ReturnType<typeof resolvePageToolEnvironment>}
   */
  function resolveResponsesPageToolEnvironment(attemptState = null) {
    if (attemptState?.pageToolEnvironment && typeof attemptState.pageToolEnvironment === 'object') {
      return attemptState.pageToolEnvironment;
    }
    return resolvePageToolEnvironment({
      isStandalone: state?.isStandalone === true,
      isTemporaryMode
    });
  }

  /**
   * 进入纯对话模式。
   *
   * 语义说明：
   * - 不再向模型暴露宿主页增强工具；
   * - `page_content_read` 对新请求隐藏；
   * - `js_runtime_execute` 对新请求切换到侧栏内部隔离沙箱；
   * - 不影响当前已经发出的请求契约，当前 request/turn 仍按开始时快照执行。
   * @public
   */
  function enterTemporaryMode() {
    isTemporaryMode = true;
    GetInputContainer().classList.add('temporary-mode');
    document.body.classList.add('temporary-mode');
    updateMessageInputPlaceholder();
    try {
      document.dispatchEvent(new CustomEvent('TEMP_MODE_CHANGED', { detail: { isOn: true } }));
    } catch (_) {}
  }

  /**
   * 退出纯对话模式，恢复宿主页增强工具暴露。
   * @public
   */
  function exitTemporaryMode() {
    isTemporaryMode = false;
    GetInputContainer().classList.remove('temporary-mode');
    document.body.classList.remove('temporary-mode');
    updateMessageInputPlaceholder();
    try {
      document.dispatchEvent(new CustomEvent('TEMP_MODE_CHANGED', { detail: { isOn: false } }));
    } catch (_) {}
  }


  /**
   * 构造给 Responses API 使用的 js_runtime_execute 自定义函数工具定义。
   *
   * 说明：
   * - 这是模型“看到”的工具面；
   * - 模型在代码体里可以直接 `await` / `return`；
   * - 不额外注入扩展对象；
   * - 返回值会被序列化为文本片段回传给模型：对象/数组默认 JSON 化，超长输出会自动截断。
   *
   * @param {ReturnType<typeof resolvePageToolEnvironment>} pageToolEnvironment
   * @returns {Object}
   */
  function buildResponsesJsRuntimeFunctionToolDefinition(pageToolEnvironment = resolveResponsesPageToolEnvironment()) {
    const descriptionLines = [
      '在浏览器脚本环境中执行一次性 JavaScript。',
      'code 字段会作为 async 函数体运行，可直接使用 await 和 return。',
      '若需要跨多次调用复用状态，请显式把对象或值挂到 globalThis；同一页面环境未刷新时，后续 IIFE 可继续读取这些 globalThis 字段。',
      '除非能确定当前页面是单页应用且不会销毁当前运行环境，否则禁止刷新页面或导航到其他网址；这会直接中断当前宿主页里的会话执行。',
      '可访问当前执行环境的 DOM / Web API，不要假设能直接访问页面主世界里的自定义 JS 对象。',
      'console.log/info/warn/error/debug 的输出会被捕获并一并回传，可用于调试或分步观察。',
      '若需要回传大量长字符串或多行文本，优先使用 console.log 输出；为避免长字符串作为 return 值时变成 JSON 字符串表现，return 更适合简洁结果值。',
      '工具返回结果采用 XML 分块文本：通常包含 <metadata>、<return_value>、<console_logs>、<error>；多 frame 时还可能包含 <frame_results>。',
      '其中 metadata 是小型 JSON，其余正文块是纯文本；过长块会自动截断。请尽量返回紧凑、可序列化的小结果。'
    ];
    const frameDescription = '可选的 frame ID 数组。省略、传空数组或 null 时，默认在顶层 frame 执行；若当前请求附带 page_runtime_context，可从中读取可用 frame_id。';
    return {
      type: 'function',
      name: RESPONSES_JS_RUNTIME_TOOL_NAME,
      description: descriptionLines.join(' '),
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: {
            type: 'string',
            description: '要执行的 JavaScript 代码片段。它会作为 async 函数体执行，可直接使用 await、return 和 console.log/info/warn/error/debug。若需要回传大量长字符串或多行文本，优先使用 console.log 输出；return 更适合简洁结果值。'
          },
          frame_ids: {
            type: ['array', 'null'],
            description: frameDescription,
            items: {
              type: 'integer'
            }
          }
        },
        required: ['code', 'frame_ids']
      }
    };
  }

  /**
   * 构造给 Responses API 使用的 page_content_read 自定义函数工具定义。
   *
   * 这个工具的定位非常克制：
   * - 只返回“当前网页 + 可访问 iframe”的预提取纯文本；
   * - 文本会做逐行 trim 与空白折叠，更适合快速通读；
   * - 不承诺 DOM 级结构、选择器级定位或属性提取；
   * - 若当前页面是 PDF 且需要按章节 / 片段读取，请优先改用 pdf_content_read；
   * - 若模型需要 DOM 级结构化读取，请优先改用 js_runtime_execute。
   *
   * @returns {Object}
   */
  function buildResponsesPageContentFunctionToolDefinition() {
    const properties = {
      skip_chars: {
        type: ['integer', 'null'],
        description: '可选。要跳过的字符数，用于读取指定偏移后的连续片段。省略时默认从头开始。'
      },
      max_chars: {
        type: ['integer', 'null'],
        description: '可选。读取的连续字符长度。默认 10000，最大 50000。若与 skip_chars 一起提供，则返回从 skip_chars 开始的连续片段；若两者都省略，则返回默认从开头开始的截断预览。'
      }
    };
    return {
      type: 'function',
      name: RESPONSES_PAGE_CONTENT_TOOL_NAME,
      description: [
        '快速读取当前侧栏绑定网页标签页的预提取文本内容。',
        '它会返回页面正文与可访问 iframe 文本的预包装读取结果，并对多行做 trim 与空白折叠，更适合一次快速通读页面内容。',
        '若用户在对话开头说“这个”或未明确指代对象，默认指当前网页环境上下文，请先调用本工具读取页面再回答。',
        '这不是 DOM 结构化提取工具；若当前页面是 PDF 且需要按章节 / 片段读取，请优先使用 pdf_content_read；若需要按元素、选择器、属性进行结构化定位与提取，请优先使用 js_runtime_execute。',
        '默认返回从开头开始的 10000 字符预览，最大单次读取 50000 字符；正文若被截断，会在正文末尾附带统一的截断提示。也可通过 skip_chars 与 max_chars 读取指定连续片段。'
      ].join(' '),
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties,
        required: Object.keys(properties)
      }
    };
  }

  /**
   * 列出当前允许被“向其他 AI 提问”工具使用的目标模型目录。
   *
   * 这把工具只做目录发现与使用须知说明：
   * - 不直接发起任何模型调用；
   * - 返回的 config_id 可直接用于 ask_other_ai；
   * - 是否包含当前配置完全由用户勾选决定，这里不额外替用户做裁剪。
   *
   * @returns {Object}
   */
  /**
   * 构造给 Responses API 使用的 history_search 自定义函数工具定义。
   *
   * 设计说明：
   * - 它面向“已保存聊天记录”的全文检索；
   * - 复用当前 UI 的 query 语法，避免模型侧和 UI 侧出现两套搜索规则；
   * - 返回的是会话级结果 + 命中位置索引，不直接倾倒整段聊天正文；
   * - 若模型需要继续看全文，应再调用 history_read。
   *
   * @returns {Object}
   */
  function buildResponsesHistorySearchFunctionToolDefinition() {
    const properties = {
      text_all: {
        type: ['array', 'null'],
        description: '可选。正文里必须同时出现的词或短语列表（AND 关系）。每一项都按完整字符串匹配，可直接填写短语。',
        items: { type: 'string' }
      },
      text_not: {
        type: ['array', 'null'],
        description: '可选。正文里不得出现的词或短语列表。',
        items: { type: 'string' }
      },
      url_contains: {
        type: ['string', 'null'],
        description: '可选。只返回 URL 中包含该子串的会话。'
      },
      current_page_only: {
        type: ['boolean', 'null'],
        description: '可选。true 时只返回与当前页面 URL 前缀匹配的会话。'
      },
      min_message_count: {
        type: ['integer', 'null'],
        description: '可选。只返回消息条数不少于该值的会话。'
      },
      max_message_count: {
        type: ['integer', 'null'],
        description: '可选。只返回消息条数不多于该值的会话。'
      },
      date_from: {
        type: ['string', 'null'],
        description: '可选。只返回结束时间不早于该时间点的会话。支持 YYYY-MM-DD、YYYYMMDD、10位秒时间戳、13位毫秒时间戳。'
      },
      date_to: {
        type: ['string', 'null'],
        description: '可选。只返回开始时间不晚于该时间点的会话。支持 YYYY-MM-DD、YYYYMMDD、10位秒时间戳、13位毫秒时间戳。'
      },
      recent_within: {
        type: ['string', 'null'],
        description: '可选。只返回最近一段时间内有活动的会话，例如 5d、1w、1m、1y。'
      },
      scope: {
        type: ['string', 'null'],
        description: '可选。message 表示每个正向词必须在同一条消息内同时命中；session 表示同一会话内不同消息共同满足也算命中。'
      },
      result_mode: {
        type: ['string', 'null'],
        description: '可选。matches 返回元数据 + 命中摘要；metadata_only 只返回会话元数据列表，适合结合 recent_within 之类条件做最近对话清单。'
      },
      max_results: {
        type: ['integer', 'null'],
        description: '可选。最多返回多少条命中会话，默认 20。'
      }
    };
    return {
      type: 'function',
      name: RESPONSES_HISTORY_SEARCH_TOOL_NAME,
      description: [
        '搜索已保存的聊天记录。',
        '默认搜索全库会话，包含主线与线程消息，结果按最近会话优先返回。',
        '它只搜索用户可见聊天正文，不搜索 tool output、hidden contextual items、footer 元数据或 replay items。',
        '若只想列出当前页面相关会话，可传 current_page_only=true',
        '返回的每条结果都会带会话元数据，例如创建时间、最近时间、消息条数、线程数量等。',
        'result_mode=matches 时返回会话级结果与命中位置：主线命中使用 msg_index，线程命中使用 thread_ref + thread_msg_index；result_mode=metadata_only 时只返回元数据列表。',
        'conv_ref 是当前聊天记录快照中的 1-based 会话编号，最新会话编号最大；若要继续读取正文窗口，请使用 history_read。'
      ].join(' '),
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties,
        required: Object.keys(properties)
      }
    };
  }

  /**
   * 构造给 Responses API 使用的 history_read 自定义函数工具定义。
   *
   * 设计说明：
   * - 它只负责“按窗口读取聊天正文”，不负责搜索；
   * - 主线与线程分开编号，不做拍平；
   * - 读取范围使用 1-based 闭区间 start/end，与搜索结果返回的索引一致。
   *
   * @returns {Object}
   */
  function buildResponsesHistoryReadFunctionToolDefinition() {
    const properties = {
      conv_ref: {
        type: 'integer',
        description: '必填。会话外部编号，1-based，最新会话编号最大。建议先通过 history_search 获取。'
      },
      start: {
        type: 'integer',
        description: '必填。读取窗口起点，1-based，闭区间。'
      },
      end: {
        type: 'integer',
        description: '必填。读取窗口终点，1-based，闭区间。'
      },
      thread_ref: {
        type: ['integer', 'null'],
        description: '可选。若提供，则读取该线程内的 thread_msg_index 窗口；不传则读取主线消息窗口。'
      },
      read_full_messages: {
        type: ['boolean', 'null'],
        description: '可选。true 时不对单条消息正文应用默认 5000 字符截断；不传或 false 时，每条消息正文最多返回 5000 字符，并在正文末尾附统一的截断提示。'
      }
    };
    return {
      type: 'function',
      name: RESPONSES_HISTORY_READ_TOOL_NAME,
      description: [
        '按窗口读取单个已保存会话的聊天正文。',
        '传入 conv_ref 与 1-based 闭区间 start/end；默认读取主线消息 msg_index。',
        '若要读取线程消息，则额外传入 thread_ref，此时读取该线程内的 thread_msg_index 窗口。',
        '它只返回用户可见聊天正文，不返回内部 tool output、hidden contextual items 或 replay items。',
        '默认每条消息正文最多返回 5000 字符；若确实需要完整正文，可显式传 read_full_messages=true。'
      ].join(' '),
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties,
        required: Object.keys(properties)
      }
    };
  }

  /**
   * 返回当前这次发送应该暴露给 Responses API 的自定义函数工具列表。
   *
   * 当前工具暴露规则：
   * - 仅在 Responses API 场景下注入；
   * - `page_content_read` 只在“宿主页增强模式”下注入；
   * - `js_runtime_execute` 始终可以注入，但会根据当前模式切换到：
   *   1. 宿主页 JS 环境；
   *   2. 或侧栏内部隔离 sandbox。
   *
   * @param {Object|null|undefined} usedApiConfig
   * @param {ReturnType<typeof resolvePageToolEnvironment>} pageToolEnvironment
   * @returns {Array<Object>}
   */
  function getResponsesCustomFunctionTools(usedApiConfig, pageToolEnvironment = resolveResponsesPageToolEnvironment()) {
    if (!isOpenAIResponsesApiConfig(usedApiConfig)) return [];
    const tools = [
      buildMicroSkillRegistryFunctionToolDefinition(),
      buildRequestUserInputFunctionToolDefinition(),
      buildListAskableModelsFunctionToolDefinition(),
      buildAskOtherAiFunctionToolDefinition(),
      buildResponsesHistorySearchFunctionToolDefinition(),
      buildResponsesHistoryReadFunctionToolDefinition()
    ];
    if (pageToolEnvironment?.exposePageContentTool) {
      tools.push(buildWebpageScreenshotFunctionToolDefinition());
      tools.push(buildPdfContentReadFunctionToolDefinition());
      tools.push(buildResponsesPageContentFunctionToolDefinition());
    }
    if (typeof utils?.executeJsRuntime === 'function') {
      tools.unshift(buildResponsesJsRuntimeFunctionToolDefinition(pageToolEnvironment));
    }
    return tools;
  }

  /**
   * 把自定义函数工具合并进 Responses API requestBody.tools。
   *
   * 合并规则：
   * - 普通内置工具仍按 type 去重；
   * - function 工具按 type + name 去重；
   * - 若同名 function 已存在，则以当前客户端定义覆盖，确保参数契约稳定。
   *
   * @param {Array<any>} existingTools
   * @param {Array<any>} customTools
   * @returns {Array<Object>}
   */
  function mergeResponsesRequestTools(existingTools, customTools) {
    const merged = Array.isArray(existingTools)
      ? existingTools
        .filter(item => item && typeof item === 'object' && !Array.isArray(item))
        .map(item => cloneDataSafely(item))
      : [];

    for (const tool of Array.isArray(customTools) ? customTools : []) {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) continue;
      const toolType = (typeof tool.type === 'string') ? tool.type.trim() : '';
      const toolName = (typeof tool.name === 'string') ? tool.name.trim() : '';
      if (!toolType) continue;

      const existingIndex = merged.findIndex((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
        const itemType = (typeof item.type === 'string') ? item.type.trim() : '';
        if (itemType !== toolType) return false;
        if (toolType === 'function') {
          return ((typeof item.name === 'string') ? item.name.trim() : '') === toolName;
        }
        return true;
      });

      if (existingIndex >= 0) {
        merged[existingIndex] = cloneDataSafely(tool);
      } else {
        merged.push(cloneDataSafely(tool));
      }
    }

    return merged;
  }

  /**
   * 在真正发请求前，把当前客户端支持的自定义 function tools 注入 Responses 请求体。
   *
   * @param {Object} requestBody
   * @param {Object|null|undefined} usedApiConfig
   * @returns {Object}
   */
  function prepareResponsesRequestBodyForCustomTools(
    requestBody,
    usedApiConfig,
    pageToolEnvironment = resolveResponsesPageToolEnvironment()
  ) {
    if (!isOpenAIResponsesApiConfig(usedApiConfig)) return requestBody;
    const customTools = getResponsesCustomFunctionTools(usedApiConfig, pageToolEnvironment);
    if (!Array.isArray(customTools) || customTools.length <= 0) return requestBody;

    const nextBody = cloneDataSafely(requestBody) || {};
    nextBody.tools = mergeResponsesRequestTools(nextBody.tools, customTools);
    return nextBody;
  }

  /**
   * 计算“新一轮 Responses 返回里新增的工具调用”。
   *
   * 背景：
   * - 我们在同一个 assistant 消息里展示多轮 function_call -> function_call_output follow-up；
   * - 节点上的 response_activity_timeline 需要跨 hop 累积；
   * - 但真正要执行的只应该是“当前 hop 新出现的 function_call”，不能把上一轮已执行过的再跑一次。
   *
   * @param {Array<Object>|null|undefined} previousTimeline
   * @param {Array<Object>|null|undefined} nextTimeline
   * @returns {Array<Object>}
   */
  function getNewResponsesToolCalls(previousTimeline, nextTimeline) {
    const previousCalls = getResponsesToolCallsFromTimeline(previousTimeline);
    const nextCalls = getResponsesToolCallsFromTimeline(nextTimeline);
    if (!Array.isArray(nextCalls) || nextCalls.length <= 0) return [];
    if (!Array.isArray(previousCalls) || previousCalls.length <= 0) return nextCalls;

    const previousKeys = new Set(
      previousCalls.map((record, index) => getResponsesToolCallRecordKey(record, index))
    );

    return nextCalls.filter((record, index) => {
      return !previousKeys.has(getResponsesToolCallRecordKey(record, index));
    });
  }

  /**
   * 将本地工具执行异常压成稳定结构，便于作为 function_call_output 返回给模型。
   *
   * @param {any} error
   * @returns {{message:string, name:string, stack:string}}
   */
  function normalizeResponsesCustomToolError(error) {
    return {
      message: (typeof error?.message === 'string' && error.message.trim())
        ? error.message.trim()
        : String(error || '未知工具错误'),
      name: (typeof error?.name === 'string' && error.name.trim())
        ? error.name.trim()
        : 'Error',
      stack: (typeof error?.stack === 'string') ? error.stack : ''
    };
  }

  /**
   * 序列化普通 function_call_output 的 output 字段。
   *
   * 统一走 XML 分块文本：
   * - metadata 用小 JSON；
   * - 其它正文块用纯文本；
   * - 超过统一上限时按字符数做中间截断。
   *
   * @param {any} value
   * @returns {Array<{type:'input_text', text:string}>}
   */
  function serializeResponsesFunctionToolOutput(value) {
    try {
      return buildResponsesGenericXmlToolOutputContentItems('tool_result', value);
    } catch (error) {
      return buildResponsesGenericXmlToolOutputContentItems('tool_result', {
        ok: false,
        error: normalizeResponsesCustomToolError(error)
      });
    }
  }

  function serializeResponsesMicroSkillRegistryFunctionToolOutput(value) {
    try {
      return buildResponsesGenericXmlToolOutputContentItems('micro_skill_registry_result', value, {
        blockTruncation: {
          maxChars: MICRO_SKILL_READ_MAX_CHARS,
          mode: 'tail'
        }
      });
    } catch (error) {
      return buildResponsesGenericXmlToolOutputContentItems('micro_skill_registry_result', {
        ok: false,
        error: normalizeResponsesCustomToolError(error)
      }, {
        blockTruncation: {
          maxChars: MICRO_SKILL_READ_MAX_CHARS,
          mode: 'tail'
        }
      });
    }
  }

  function serializeResponsesJsRuntimeFunctionToolOutput(value) {
    try {
      return buildResponsesJsRuntimeToolOutputContentItems(value);
    } catch (error) {
      return buildResponsesGenericXmlToolOutputContentItems('js_runtime_result', {
        ok: false,
        error: normalizeResponsesCustomToolError(error)
      });
    }
  }

  function serializeResponsesPageContentFunctionToolOutput(value) {
    try {
      return buildResponsesPageContentToolOutputContentItems(value);
    } catch (error) {
      return buildResponsesGenericXmlToolOutputContentItems('page_content_read_result', {
        ok: false,
        error: normalizeResponsesCustomToolError(error)
      });
    }
  }

  function serializeResponsesPdfContentFunctionToolOutput(value) {
    try {
      return buildResponsesPdfContentToolOutputContentItems(value);
    } catch (error) {
      return buildResponsesGenericXmlToolOutputContentItems('pdf_content_read_result', {
        ok: false,
        error: normalizeResponsesCustomToolError(error)
      });
    }
  }

  function serializeResponsesWebpageScreenshotFunctionToolOutput(value) {
    const normalized = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
    const imageUrl = (typeof normalized.image_url === 'string') ? normalized.image_url.trim() : '';
    const detail = (normalized.detail === 'original') ? 'original' : null;

    if (normalized.ok === true && imageUrl) {
      const item = {
        type: 'input_image',
        image_url: imageUrl
      };
      if (detail) {
        item.detail = detail;
      }
      return [item];
    }

    return buildResponsesGenericXmlToolOutputContentItems('webpage_screenshot_result', {
      ok: false,
      error: normalized.error || {
        message: '网页截图工具未返回可用图片。',
        name: 'WebpageScreenshotUnavailableError'
      }
    });
  }

  function serializeResponsesHistorySearchFunctionToolOutput(value) {
    try {
      return buildResponsesHistorySearchToolOutputContentItems(value);
    } catch (error) {
      return buildResponsesGenericXmlToolOutputContentItems('history_search_result', {
        ok: false,
        error: normalizeResponsesCustomToolError(error)
      });
    }
  }

  function serializeResponsesHistoryReadFunctionToolOutput(value) {
    try {
      return buildResponsesHistoryReadToolOutputContentItems(value);
    } catch (error) {
      return buildResponsesGenericXmlToolOutputContentItems('history_read_result', {
        ok: false,
        error: normalizeResponsesCustomToolError(error)
      });
    }
  }

  function serializeResponsesListAskableModelsFunctionToolOutput(value) {
    try {
      return buildResponsesAskableModelsToolOutputContentItems(value);
    } catch (error) {
      return buildResponsesGenericXmlToolOutputContentItems('list_askable_models_result', {
        ok: false,
        error: normalizeResponsesCustomToolError(error)
      });
    }
  }

  function serializeResponsesAskOtherAiFunctionToolOutput(value) {
    try {
      return buildResponsesAskOtherAiToolOutputContentItems(value);
    } catch (error) {
      return buildResponsesGenericXmlToolOutputContentItems('ask_other_ai_result', {
        ok: false,
        error: normalizeResponsesCustomToolError(error)
      });
    }
  }

  function serializeResponsesRequestUserInputFunctionToolOutput(value) {
    try {
      return buildResponsesRequestUserInputToolOutputContentItems(value);
    } catch (error) {
      return buildResponsesGenericXmlToolOutputContentItems('request_user_input_result', {
        ok: false,
        error: normalizeResponsesCustomToolError(error)
      });
    }
  }

  function compactResponsesJsRuntimeResult(rawResult) {
    const normalized = (rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult))
      ? cloneDataSafely(rawResult)
      : { ok: false, value: null, logs: [], items: [], error: null };
    return {
      ok: normalized?.ok === true,
      tabId: Number.isFinite(Number(normalized?.tabId)) ? Number(normalized.tabId) : null,
      value: cloneDataSafely(normalized?.value ?? null),
      logs: Array.isArray(normalized?.logs)
        ? cloneDataSafely(normalized.logs)
        : [],
      items: Array.isArray(normalized?.items)
        ? cloneDataSafely(normalized.items)
        : [],
      error: normalized?.error ? cloneDataSafely(normalized.error) : null
    };
  }

  /**
   * 规范化 js_runtime_execute 的参数。
   *
   * @param {any} rawArgs
   * @returns {{code:string, frameIds:number[]|null}}
   */
  function normalizeResponsesJsRuntimeToolArguments(rawArgs) {
    const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs))
      ? rawArgs
      : {};
    const code = (typeof args.code === 'string') ? args.code : '';
    if (!code.trim()) {
      throw new Error('js_runtime_execute 参数错误：code 不能为空。');
    }

    const frameIds = Array.isArray(args.frame_ids)
      ? args.frame_ids
        .map(value => Number(value))
        .filter(value => Number.isFinite(value))
        .map(value => Math.trunc(value))
      : null;

    return {
      code,
      frameIds: (Array.isArray(frameIds) && frameIds.length > 0) ? frameIds : null
    };
  }

  /**
   * 执行 js_runtime_execute 并返回稳定结果对象。
   *
   * @param {any} rawArgs
   * @returns {Promise<Object>}
   */
  async function executeResponsesJsRuntimeFunction(rawArgs, options = {}) {
    if (typeof utils?.executeJsRuntime !== 'function') {
      return {
        ok: false,
        value: null,
        items: [],
        error: {
          message: '当前客户端没有可用的 JS Runtime 执行入口。',
          name: 'UnavailableError',
          stack: ''
        }
      };
    }

    try {
      const normalizedArgs = normalizeResponsesJsRuntimeToolArguments(rawArgs);
      const runtimeEnvironment = (typeof options?.runtimeEnvironment === 'string' && options.runtimeEnvironment)
        ? options.runtimeEnvironment
        : resolveResponsesPageToolEnvironment(options?.attemptState).jsRuntimeEnvironment;
      const result = await utils.executeJsRuntime(normalizedArgs.code, {
        frameIds: normalizedArgs.frameIds,
        runtimeEnvironment
      });

      if (!result || result.success !== true) {
        return compactResponsesJsRuntimeResult({
          ok: false,
          tabId: Number.isFinite(Number(result?.tabId)) ? Number(result.tabId) : null,
          value: null,
          logs: Array.isArray(result?.logs) ? cloneDataSafely(result.logs) : [],
          items: Array.isArray(result?.items) ? cloneDataSafely(result.items) : [],
          error: {
            message: (typeof result?.error === 'string' && result.error.trim())
              ? result.error.trim()
              : 'JS Runtime 执行失败',
            name: 'RuntimeExecutionError',
            stack: ''
          }
        });
      }

      return compactResponsesJsRuntimeResult({
        ok: result.ok === true,
        tabId: Number.isFinite(Number(result?.tabId)) ? Number(result.tabId) : null,
        value: result?.value ?? null,
        logs: Array.isArray(result?.logs) ? cloneDataSafely(result.logs) : [],
        items: Array.isArray(result?.items) ? cloneDataSafely(result.items) : [],
        error: null
      });
    } catch (error) {
      return compactResponsesJsRuntimeResult({
        ok: false,
        value: null,
        items: [],
        error: normalizeResponsesCustomToolError(error)
      });
    }
  }

  /**
   * 执行 page_content_read 并返回稳定结果对象。
   *
   * 它读取的是当前页面“已抽取文本”的快速阅读视图：
   * - 包含页面正文与可访问 iframe 文本；
   * - 文本会做轻量归一化；
   * - 不适合作 DOM 级结构化提取。
   *
   * @param {any} rawArgs
   * @returns {Promise<Object>}
   */
  async function executeResponsesPageContentFunction(rawArgs) {
    try {
      const result = await getPageContentReadResult(rawArgs);
      return result || {
        ok: false,
        error: {
          message: '未能从当前网页读取 page_content_read 结果。',
          name: 'PageContentReadUnavailableError'
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: normalizeResponsesCustomToolError(error)
      };
    }
  }

  /**
   * 执行 pdf_content_read 并返回结构化 PDF 读取结果。
   *
   * 说明：
   * - 默认返回章节索引；
   * - 支持按章节分片或按整篇顺序分片；
   * - 若当前页面不是 PDF，会返回明确错误，避免模型误把 HTML 当 PDF 读。
   *
   * @param {any} rawArgs
   * @returns {Promise<Object>}
   */
  async function executeResponsesPdfContentFunction(rawArgs) {
    try {
      const result = await getPdfContentReadResult(rawArgs);
      return result || {
        ok: false,
        error: {
          message: '未能从当前网页读取 pdf_content_read 结果。',
          name: 'PdfContentReadUnavailableError'
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: normalizeResponsesCustomToolError(error)
      };
    }
  }

  /**
   * 执行网页截图工具并返回给模型可直接消费的图片结果。
   *
   * 说明：
   * - 截图来源固定为当前侧栏绑定网页的可见区域；
   * - content script 负责隐藏侧边栏，避免把对话 UI 自己拍进去；
   * - 默认返回压缩后的 prompt 图片，`detail: original` 时保留原始分辨率；
   * - 两条路径都会统一输出 JPEG，避免上层再按 MIME 分叉。
   *
   * @param {any} rawArgs
   * @returns {Promise<Object>}
   */
  async function executeResponsesWebpageScreenshotFunction(rawArgs) {
    try {
      const result = await getWebpageScreenshotResult(rawArgs);
      return result || {
        ok: false,
        error: {
          message: '未能从当前网页获取 webpage_screenshot 结果。',
          name: 'WebpageScreenshotUnavailableError'
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: normalizeResponsesCustomToolError(error)
      };
    }
  }

  /**
   * 执行 history_search。
   *
   * 读取范围：
   * - 仅搜索已保存聊天记录；
   * - 默认只搜索“用户可见正文”，不碰内部协议痕迹；
   * - 同一轮 assistant 工具链内复用同一份 conv_ref 快照。
   *
   * @param {any} rawArgs
   * @param {{attemptState?:Object|null}} [options]
   * @returns {Promise<Object>}
   */
  async function executeResponsesHistorySearchFunction(rawArgs, options = {}) {
    try {
      const snapshot = await getHistoryToolSnapshot(options?.attemptState || null);
      const currentPageMeta = buildCurrentPageMetaSnapshot();
      return await executeHistorySearchTool(rawArgs, {
        snapshot,
        currentPageUrl: currentPageMeta?.url || '',
        loadConversationsByIds: async (ids) => {
          return getConversationsByIds(ids, false);
        }
      });
    } catch (error) {
      return {
        ok: false,
        error: normalizeResponsesCustomToolError(error)
      };
    }
  }

  /**
   * 执行 history_read。
   *
   * @param {any} rawArgs
   * @param {{attemptState?:Object|null}} [options]
   * @returns {Promise<Object>}
   */
  async function executeResponsesHistoryReadFunction(rawArgs, options = {}) {
    try {
      const snapshot = await getHistoryToolSnapshot(options?.attemptState || null);
      return await executeHistoryReadTool(rawArgs, {
        snapshot,
        loadConversationById: async (conversationId) => {
          return getConversationById(conversationId, false);
        }
      });
    } catch (error) {
      return {
        ok: false,
        error: normalizeResponsesCustomToolError(error)
      };
    }
  }

  function extractChatCompletionContentText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item.text === 'string') return item.text;
      if (item && typeof item.content === 'string') return item.content;
      return '';
    }).join('');
  }

  function parseSseEventsFromText(sourceText) {
    const text = (typeof sourceText === 'string') ? sourceText : '';
    if (!text.trim()) return [];
    const normalized = text.replace(/\r\n/g, '\n');
    const chunks = normalized.split(/\n\n+/);
    return chunks.map((chunk) => {
      const lines = chunk.split('\n');
      let event = '';
      const dataLines = [];
      for (const rawLine of lines) {
        const line = String(rawLine || '');
        if (!line) continue;
        if (line.startsWith('event:')) {
          event = line.slice(6).trim();
          continue;
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      return {
        event,
        data: dataLines.join('\n').trim()
      };
    }).filter((item) => item.data);
  }

  function extractGeminiAskOtherAiTextFromPayload(payload) {
    const parts = Array.isArray(payload?.candidates?.[0]?.content?.parts)
      ? payload.candidates[0].content.parts
      : [];
    return parts
      .filter((part) => typeof part?.text === 'string' && !part?.thought)
      .map((part) => part.text)
      .join('');
  }

  function hasUsableResponsesOutputPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (Array.isArray(payload.output) && payload.output.length > 0) return true;
    if (typeof payload.output_text === 'string' && payload.output_text.trim()) return true;
    if (Array.isArray(payload.output_text) && payload.output_text.length > 0) return true;
    return false;
  }

  async function readAskOtherAiResponsePayload(response, targetConfig, requestBody) {
    const requestedMode = resolveResponseHandlingMode({
      apiBase: targetConfig?.baseUrl,
      connectionType: targetConfig?.connectionType,
      geminiUseStreaming: targetConfig?.useStreaming !== false,
      requestBodyStream: requestBody?.stream === true
    });
    const receivedMode = resolveReceivedResponseHandlingMode({
      requestedMode,
      responseContentType: response?.headers?.get?.('content-type') || '',
      hasResponseBody: !!response?.body
    });
    const rawText = await response.text();

    if (receivedMode !== 'stream') {
      try {
        return JSON.parse(rawText);
      } catch (error) {
        throw new Error(rawText || '解析子请求响应失败');
      }
    }

    const events = parseSseEventsFromText(rawText);
    let lastJson = null;
    let latestResponsesPayload = null;
    let accumulatedResponsesText = '';
    let accumulatedChatText = '';
    let accumulatedGeminiText = '';
    let latestUsage = null;

    for (const item of events) {
      if (!item?.data || item.data === '[DONE]') continue;
      try {
        const payload = JSON.parse(item.data);
        lastJson = payload;
        if (payload?.error) {
          throw new Error(payload.error.message || '目标模型返回错误');
        }
        if (isGeminiApiConfig(targetConfig)) {
          const geminiText = extractGeminiAskOtherAiTextFromPayload(payload);
          if (geminiText) {
            accumulatedGeminiText += geminiText;
          }
          if (payload?.usageMetadata || payload?.usage) {
            latestUsage = payload?.usageMetadata || payload?.usage;
          }
          continue;
        }
        if (
          item.event === 'response.completed'
          || String(payload?.type || '').toLowerCase() === 'response.completed'
        ) {
          latestResponsesPayload = payload?.response || payload;
          continue;
        }
        if (isOpenAIResponsesPayload(payload) && hasUsableResponsesOutputPayload(payload)) {
          latestResponsesPayload = payload;
          continue;
        }
        const eventType = (typeof payload?.type === 'string') ? payload.type : '';
        if (eventType === 'response.output_text.delta') {
          const deltaText = (typeof payload?.delta === 'string')
            ? payload.delta
            : ((typeof payload?.text === 'string') ? payload.text : '');
          if (deltaText) {
            accumulatedResponsesText += deltaText;
          }
        } else if ((eventType === 'response.output_text.done') && !accumulatedResponsesText) {
          const doneText = (typeof payload?.delta === 'string')
            ? payload.delta
            : ((typeof payload?.text === 'string') ? payload.text : '');
          if (doneText) {
            accumulatedResponsesText += doneText;
          }
        } else if ((eventType === 'response.output_item.done' || eventType === 'response.output_item.added') && !accumulatedResponsesText) {
          const extracted = extractOpenAIResponsesOutput({ output: [payload?.item].filter(Boolean) });
          if (typeof extracted?.answer === 'string' && extracted.answer) {
            accumulatedResponsesText += extracted.answer;
          }
        }
        const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
        const deltaContent = choice?.delta?.content;
        const deltaText = extractChatCompletionContentText(deltaContent);
        if (deltaText) {
          accumulatedChatText += deltaText;
        }
        if (payload?.usage) {
          latestUsage = payload.usage;
        }
      } catch (_) {
        // 某些兼容端点可能夹带非 JSON 事件；这里忽略掉无法解析的行，继续寻找最终完成事件。
      }
    }

    if (latestResponsesPayload) {
      if (accumulatedResponsesText) {
        const mergedPayload = cloneDataSafely(latestResponsesPayload);
        const currentOutputText = readResponsesOutputTextField(mergedPayload);
        if (!currentOutputText) {
          mergedPayload.output_text = accumulatedResponsesText;
        }
        return mergedPayload;
      }
      return latestResponsesPayload;
    }
    if (accumulatedResponsesText) {
      return {
        object: 'response',
        output_text: accumulatedResponsesText,
        usage: latestUsage
      };
    }
    if (accumulatedGeminiText) {
      return {
        candidates: [
          {
            content: {
              parts: [{ text: accumulatedGeminiText }]
            }
          }
        ],
        usageMetadata: latestUsage
      };
    }
    if (accumulatedChatText) {
      return {
        choices: [
          {
            message: {
              content: accumulatedChatText
            }
          }
        ],
        usage: latestUsage
      };
    }
    if (lastJson) return lastJson;
    throw new Error(rawText || '解析 SSE 子请求响应失败');
  }

  function extractAskOtherAiAnswerFromPayload(payload, targetConfig) {
    if (payload && payload.error) {
      throw new Error(payload.error.message || '目标模型返回错误');
    }

    const usage = normalizeApiUsageMeta(payload?.usage || payload?.response?.usage);
    if (isOpenAIResponsesPayload(payload) || isOpenAIResponsesApiConfig(targetConfig)) {
      const extracted = extractOpenAIResponsesOutput(payload);
      return {
        answer: extracted?.answer || '',
        usage
      };
    }

    if (isGeminiApiConfig(targetConfig)) {
      const parts = Array.isArray(payload?.candidates?.[0]?.content?.parts)
        ? payload.candidates[0].content.parts
        : [];
      const answer = parts
        .filter((part) => typeof part?.text === 'string' && !part?.thought)
        .map((part) => part.text)
        .join('');
      return { answer, usage };
    }

    const firstChoice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
    const answer = extractChatCompletionContentText(firstChoice?.message?.content ?? firstChoice?.text ?? payload?.content ?? '');
    return { answer, usage };
  }

  function sanitizeAskOtherAiRequestBody(requestBody) {
    const sanitized = (requestBody && typeof requestBody === 'object' && !Array.isArray(requestBody))
      ? cloneDataSafely(requestBody)
      : {};
    delete sanitized.tools;
    delete sanitized.tool_choice;
    return sanitized;
  }

  /**
   * ask_other_ai 的目标配置需要做“干净问答”裁剪：
   * - 保留连接/auth/model/基础温度与传输模式；
   * - 去掉额外工具、结构化输出、搜索、上一轮响应续写之类会干扰“独立提问”的复杂配置；
   * - 避免某个用户平时拿来做 search / schema / tool calling 的配置，被 ask_other_ai 直接继承后导致 400。
   *
   * 这里的目标不是“完全复刻该配置的一切行为”，而是“稳定地向那个模型发起一次纯问答请求”。
   *
   * @param {Object|null|undefined} config
   * @returns {Object}
   */
  function buildAskOtherAiSubrequestConfig(config) {
    const source = (config && typeof config === 'object' && !Array.isArray(config))
      ? config
      : {};
    const nextConfig = {
      id: source.id,
      connectionSourceId: source.connectionSourceId || '',
      connectionType: source.connectionType,
      connectionSourceName: source.connectionSourceName || '',
      displayName: source.displayName || '',
      modelName: source.modelName || '',
      baseUrl: source.baseUrl || '',
      apiKey: source.apiKey,
      apiKeyFilePath: source.apiKeyFilePath,
      temperature: Number.isFinite(Number(source.temperature)) ? Number(source.temperature) : 1,
      useStreaming: source.useStreaming !== false
    };

    // 明确丢弃这些“会改变 ask_other_ai 语义”的字段：
    // - customParams: 可能带入额外 provider 特性 / headers / tool 配置；
    // - 自定义系统提示词与用户预处理：ask_other_ai 应只发送显式的 question；
    // - Responses / Gemini 的额外工具与结构化输出配置：避免把一个 search/schema/tool 配置误当成纯问答配置。
    return nextConfig;
  }

  async function executeResponsesListAskableModelsFunction(_rawArgs, options = {}) {
    try {
      const configs = apiManager.getAllConfigs();
      return buildAskOtherAiCatalog(configs);
    } catch (error) {
      return {
        ok: false,
        error: normalizeResponsesCustomToolError(error)
      };
    }
  }

  async function executeResponsesAskOtherAiFunction(rawArgs, options = {}) {
    try {
      const { requests } = normalizeAskOtherAiArguments(rawArgs);
      const allConfigs = apiManager.getAllConfigs();
      const catalog = buildAskOtherAiCatalog(allConfigs);
      const askableConfigIdSet = new Set((catalog.models || []).map((item) => item.config_id));
      const catalogById = new Map((catalog.models || []).map((item) => [item.config_id, item]));
      const answers = [];

      for (let index = 0; index < requests.length; index += 1) {
        const request = requests[index];
        const configId = request.config_id;
        const catalogEntry = catalogById.get(configId) || null;

        if (!askableConfigIdSet.has(configId)) {
          answers.push({
            index: index + 1,
            config_id: configId,
            status: 'error',
            question: request.question,
            answer: '',
            error: `目标 config_id 不存在，或尚未启用“AI提问工具可用”：${configId}`
          });
          continue;
        }

        const targetConfig = apiManager.resolveApiParam({ id: configId });
        if (!targetConfig) {
          answers.push({
            index: index + 1,
            config_id: configId,
            status: 'error',
            question: request.question,
            answer: '',
            error: `无法解析目标模型配置：${configId}`
          });
          continue;
        }

        try {
          const messageContent = buildAskOtherAiUserMessage(request.question);
          const subrequestConfig = buildAskOtherAiSubrequestConfig(targetConfig);
          const targetUseStreaming = subrequestConfig.useStreaming !== false;
          const requestBody = sanitizeAskOtherAiRequestBody(await apiManager.buildRequest({
            messages: [{ role: 'user', content: messageContent }],
            config: {
              ...subrequestConfig,
              useStreaming: targetUseStreaming
            },
            overrides: isGeminiApiConfig(subrequestConfig) ? {} : { stream: targetUseStreaming }
          }));
          const response = await apiManager.sendRequest({
            requestBody,
            config: {
              ...subrequestConfig,
              useStreaming: targetUseStreaming
            }
          });

          if (!response.ok) {
            const errorText = await response.text().catch((error) => {
              const detail = normalizeResponsesCustomToolError(error).message;
              return `读取错误响应失败：${detail}`;
            });
            throw new Error(`HTTP ${response.status}: ${errorText || '目标模型返回错误'}`);
          }

          const payload = await readAskOtherAiResponsePayload(response, subrequestConfig, requestBody);
          const extracted = extractAskOtherAiAnswerFromPayload(payload, subrequestConfig);

          answers.push({
            index: index + 1,
            config_id: configId,
            status: 'ok',
            question: request.question,
            target: {
              display_name: catalogEntry?.display_name || subrequestConfig.displayName || subrequestConfig.modelName || configId,
              model_name: subrequestConfig.modelName || null,
              connection_type: subrequestConfig.connectionType || null,
              connection_source_name: subrequestConfig.connectionSourceName || null
            },
            answer: extracted.answer || '',
            usage: extracted.usage || null
          });
        } catch (error) {
          answers.push({
            index: index + 1,
            config_id: configId,
            status: 'error',
            question: request.question,
            answer: '',
            error: normalizeResponsesCustomToolError(error).message
          });
        }
      }

      return {
        ok: answers.some((item) => item.status === 'ok'),
        total_requests: requests.length,
        success_count: answers.filter((item) => item.status === 'ok').length,
        error_count: answers.filter((item) => item.status !== 'ok').length,
        answers
      };
    } catch (error) {
      return {
        ok: false,
        error: normalizeResponsesCustomToolError(error)
      };
    }
  }

  /**
   * 执行 request_user_input。
   *
   * 交互语义：
   * - 由模型提交结构化问题；
   * - 由当前 sidebar UI 负责展示选项并收集答案；
   * - 答案结果尽量贴近 Codex 当前 `function_call_output.answers` 结构，方便模型理解。
   *
   * @param {any} rawArgs
   * @returns {Promise<Object>}
   */
  async function executeResponsesRequestUserInputFunction(rawArgs) {
    try {
      const { questions } = normalizeRequestUserInputArguments(rawArgs);
      if (typeof utils?.showRequestUserInput !== 'function') {
        throw new Error('当前界面尚未提供 request_user_input 交互能力。');
      }

      const interactionResult = await utils.showRequestUserInput({ questions });
      const result = buildRequestUserInputResult(
        questions,
        interactionResult?.answers || {},
        { cancelled: interactionResult?.cancelled === true }
      );
      return result;
    } catch (error) {
      return {
        ok: false,
        cancelled: false,
        question_count: 0,
        answered_count: 0,
        questions: [],
        answers: {},
        error: normalizeResponsesCustomToolError(error)
      };
    }
  }

  /**
   * 执行扩展侧 JS 脚本注册表工具。
   *
   * 设计说明：
   * - 存储管理完全走扩展侧微型 skill package 层，当前默认落到 IndexedDB；
   * - refresh 仅在显式请求时发生，并复用现有 `utils.executeJsRuntime`；
   * - 默认 runtime 环境跟随当前页面工具模式，除非调用参数显式覆盖。
   *
   * @param {any} rawArgs
   * @param {{attemptState?:any}} [options]
   * @returns {Promise<Object>}
   */
  async function executeResponsesMicroSkillRegistryFunction(rawArgs, options = {}) {
    try {
      if (typeof utils?.executeMicroSkillRegistryAction !== 'function') {
        throw new Error('当前客户端没有可用的 micro_skill_registry 执行入口。');
      }
      const result = await utils.executeMicroSkillRegistryAction(rawArgs);
      if (result?.success === true) {
        const payload = { ...result };
        delete payload.success;
        return payload;
      }
      throw new Error((typeof result?.error === 'string' && result.error.trim())
        ? result.error.trim()
        : 'micro_skill_registry 执行失败。');
    } catch (error) {
      return {
        ok: false,
        value: null,
        items: [],
        error: normalizeResponsesCustomToolError(error)
      };
    }
  }

  /**
   * 执行一个客户端负责落地的 Responses function_call。
   *
   * 当前策略：
   * - 已知函数：返回真正执行结果；
   * - 未知函数：显式回一个错误对象，而不是静默吞掉，方便模型自我修正。
   *
   * @param {Object} toolCallRecord
   * @returns {Promise<{type:'function_call_output', call_id:string, output:Array<Object>}>}
   */
  async function executeResponsesCustomFunctionToolCall(toolCallRecord, options = {}) {
    const callId = (typeof toolCallRecord?.call_id === 'string' && toolCallRecord.call_id.trim())
      ? toolCallRecord.call_id.trim()
      : ((typeof toolCallRecord?.id === 'string') ? toolCallRecord.id.trim() : '');
    const functionName = (typeof toolCallRecord?.name === 'string') ? toolCallRecord.name.trim() : '';
    if (!callId) {
      throw new Error(`Responses function_call 缺少 call_id，无法回传工具结果（${functionName || 'unknown'}）。`);
    }

    let parsedArgs = {};
    const rawArguments = (typeof toolCallRecord?.arguments === 'string') ? toolCallRecord.arguments : '';
    try {
      parsedArgs = rawArguments.trim() ? JSON.parse(rawArguments) : {};
    } catch (error) {
      const normalizedError = normalizeResponsesCustomToolError(error);
      return {
        type: 'function_call_output',
        call_id: callId,
        output: serializeResponsesFunctionToolOutput({
          ok: false,
          value: null,
          items: [],
          error: {
            ...normalizedError,
            message: `函数参数 JSON 解析失败：${normalizedError.message}`
          }
        })
      };
    }

    let outputPayload = null;
    if (functionName === RESPONSES_JS_RUNTIME_TOOL_NAME) {
      outputPayload = await executeResponsesJsRuntimeFunction(parsedArgs, options);
    } else if (
      functionName === RESPONSES_MICRO_SKILL_REGISTRY_TOOL_NAME
      || functionName === RESPONSES_LEGACY_JS_RUNTIME_SCRIPT_REGISTRY_TOOL_NAME
    ) {
      outputPayload = await executeResponsesMicroSkillRegistryFunction(parsedArgs, options);
    } else if (functionName === RESPONSES_REQUEST_USER_INPUT_TOOL_NAME) {
      outputPayload = await executeResponsesRequestUserInputFunction(parsedArgs, options);
    } else if (functionName === RESPONSES_LIST_ASKABLE_MODELS_TOOL_NAME) {
      outputPayload = await executeResponsesListAskableModelsFunction(parsedArgs, options);
    } else if (functionName === RESPONSES_ASK_OTHER_AI_TOOL_NAME) {
      outputPayload = await executeResponsesAskOtherAiFunction(parsedArgs, options);
    } else if (functionName === RESPONSES_PAGE_CONTENT_TOOL_NAME) {
      outputPayload = await executeResponsesPageContentFunction(parsedArgs);
    } else if (functionName === RESPONSES_PDF_CONTENT_TOOL_NAME) {
      outputPayload = await executeResponsesPdfContentFunction(parsedArgs);
    } else if (functionName === RESPONSES_WEBPAGE_SCREENSHOT_TOOL_NAME) {
      outputPayload = await executeResponsesWebpageScreenshotFunction(parsedArgs);
    } else if (functionName === RESPONSES_HISTORY_SEARCH_TOOL_NAME) {
      outputPayload = await executeResponsesHistorySearchFunction(parsedArgs, options);
    } else if (functionName === RESPONSES_HISTORY_READ_TOOL_NAME) {
      outputPayload = await executeResponsesHistoryReadFunction(parsedArgs, options);
    } else {
      outputPayload = {
        ok: false,
        value: null,
        items: [],
        error: {
          message: `当前客户端尚未实现自定义函数 ${functionName || '(unnamed)'}。`,
          name: 'UnsupportedFunctionError',
          stack: ''
        }
      };
    }

    return {
      type: 'function_call_output',
      call_id: callId,
      output:
        functionName === RESPONSES_JS_RUNTIME_TOOL_NAME
            ? serializeResponsesJsRuntimeFunctionToolOutput(outputPayload)
          : (
              functionName === RESPONSES_MICRO_SKILL_REGISTRY_TOOL_NAME
              || functionName === RESPONSES_LEGACY_JS_RUNTIME_SCRIPT_REGISTRY_TOOL_NAME
            )
            ? serializeResponsesMicroSkillRegistryFunctionToolOutput(outputPayload)
          : functionName === RESPONSES_REQUEST_USER_INPUT_TOOL_NAME
            ? serializeResponsesRequestUserInputFunctionToolOutput(outputPayload)
          : functionName === RESPONSES_LIST_ASKABLE_MODELS_TOOL_NAME
            ? serializeResponsesListAskableModelsFunctionToolOutput(outputPayload)
            : functionName === RESPONSES_ASK_OTHER_AI_TOOL_NAME
              ? serializeResponsesAskOtherAiFunctionToolOutput(outputPayload)
          : functionName === RESPONSES_PAGE_CONTENT_TOOL_NAME
            ? serializeResponsesPageContentFunctionToolOutput(outputPayload)
            : functionName === RESPONSES_PDF_CONTENT_TOOL_NAME
              ? serializeResponsesPdfContentFunctionToolOutput(outputPayload)
              : functionName === RESPONSES_WEBPAGE_SCREENSHOT_TOOL_NAME
                ? serializeResponsesWebpageScreenshotFunctionToolOutput(outputPayload)
            : functionName === RESPONSES_HISTORY_SEARCH_TOOL_NAME
              ? serializeResponsesHistorySearchFunctionToolOutput(outputPayload)
              : functionName === RESPONSES_HISTORY_READ_TOOL_NAME
                ? serializeResponsesHistoryReadFunctionToolOutput(outputPayload)
                : serializeResponsesFunctionToolOutput(outputPayload)
    };
  }

  /**
   * 将本地 function_call_output 合并回 response_activity_timeline。
   *
   * 目的：
   * - UI 上我们希望“工具调用条目”同时展示调用参数与执行结果；
   * - 但 Responses 服务端 output item 只会返回 function_call，不会带上本地执行后的 output；
   * - 因此需要在客户端把这段 output 反向写回同一个 tool timeline entry。
   *
   * @param {Array<Object>|null|undefined} timeline
   * @param {Array<Object>|null|undefined} toolCallRecords
   * @param {Array<Object>|null|undefined} functionCallOutputs
   * @returns {Array<Object>}
   */
  function mergeResponsesFunctionOutputsIntoTimeline(timeline, toolCallRecords, functionCallOutputs) {
    let nextTimeline = cloneResponsesActivityTimeline(Array.isArray(timeline) ? timeline : []);

    (Array.isArray(toolCallRecords) ? toolCallRecords : []).forEach((record) => {
      if (!record || typeof record !== 'object') return;
      nextTimeline = upsertResponsesToolTimeline(nextTimeline, {
        ...record,
        status: record.status || 'completed'
      }, {
        status: record.status || 'completed'
      });
    });

    (Array.isArray(functionCallOutputs) ? functionCallOutputs : []).forEach((outputItem) => {
      if (!outputItem || typeof outputItem !== 'object') return;
      const callId = (typeof outputItem.call_id === 'string' && outputItem.call_id.trim())
        ? outputItem.call_id.trim()
        : '';
      if (!callId) return;

      let merged = false;
      nextTimeline = nextTimeline.map((entry) => {
        if (!entry || entry.kind !== 'tool_call') return entry;
        if (String(entry.type || '').trim().toLowerCase() !== 'function_call') return entry;
        if (String(entry.call_id || '').trim() !== callId) return entry;
        merged = true;
        return normalizeResponsesActivityTimelineEntry({
          ...entry,
          status: 'completed',
          output: cloneDataSafely(outputItem.output)
        }) || entry;
      });

      if (merged) return;

      nextTimeline = upsertResponsesToolTimeline(nextTimeline, {
        type: 'function_call',
        call_id: callId,
        status: 'completed',
        output: cloneDataSafely(outputItem.output)
      }, {
        status: 'completed'
      });
    });

    return mergeResponsesActivityTimeline([], nextTimeline);
  }

  function applyResponsesActivityTimelineToAttempt(attemptState, timeline) {
    if (!attemptState) return false;
    const normalizedTimeline = mergeResponsesActivityTimeline([], timeline);
    syncAttemptResponsesRuntimeState(attemptState, { timeline: normalizedTimeline });

    const node = attemptState.aiMessageNode
      || resolveAttemptAiNode(attemptState, attemptState.aiMessageId || '');
    if (!node) return false;

    attemptState.aiMessageNode = node;
    applyResponsesActivityTimelineToNode(node, normalizedTimeline);

    const wrapper = resolveMessageElementForSender(attemptState.aiMessageId || '');
    syncAttemptAssistantView(
      attemptState.aiMessageId || '',
      {
        attemptState,
        node,
        fallbackElement: wrapper || null
      }
    );
    return true;
  }

  function applyResponsesInputItemsToAttempt(attemptState, items) {
    if (!attemptState) return false;
    const normalizedItems = cloneResponsesReplayOutputItems(items);
    syncAttemptResponsesRuntimeState(attemptState, { inputItems: normalizedItems });

    const node = attemptState.aiMessageNode
      || resolveAttemptAiNode(attemptState, attemptState.aiMessageId || '');
    if (!node) return false;

    attemptState.aiMessageNode = node;
    applyResponsesInputItemsToNode(node, normalizedItems);

    const wrapper = resolveMessageElementForSender(attemptState.aiMessageId || '');
    syncAttemptAssistantView(
      attemptState.aiMessageId || '',
      {
        attemptState,
        node,
        fallbackElement: wrapper || null
      }
    );
    return true;
  }

  /**
   * 基于上一轮 requestBody 构造下一轮 Responses follow-up 请求。
   *
   * 这里对齐 Codex 的 HTTP 路线，而不是走“output-only continuation”：
   * - 不使用 `previous_response_id`；
   * - 直接在客户端把“本轮模型输出的 output items + 本地工具输出”追加回 input；
   * - 下一 hop 再把完整 input 重发给 `/responses`。
   *
   * 这样做的好处：
   * - 不依赖服务端保存上一轮响应状态；
   * - 能兼容“不认识 previous_response_id continuation”的 Responses 兼容端点；
   * - 也更接近 Codex 当前 HTTP 路线：本地历史重放，而不是服务端 continuation。
   *
   * @param {Object} previousRequestBody
   * @param {Array<Object>|null|undefined} responseOutputItems
   * @param {Array<Object>} functionCallOutputs
   * @returns {Object}
   */
  function buildResponsesFunctionToolFollowUpRequest(
    previousRequestBody,
    responseOutputItems,
    functionCallOutputs,
    pendingSteerInputItems = []
  ) {
    const nextBody = cloneDataSafely(previousRequestBody) || {};
    const previousInput = Array.isArray(nextBody.input)
      ? nextBody.input.map(item => cloneDataSafely(item))
      : [];
    let replayOutputItems = mergeResponsesReplayOutputItems([], responseOutputItems);

    delete nextBody.previous_response_id;
    nextBody.input = previousInput
      .concat(replayOutputItems.map(item => cloneDataSafely(item)))
      .concat(
        Array.isArray(functionCallOutputs)
          ? functionCallOutputs.map(item => cloneDataSafely(item))
          : []
      );
    if (Array.isArray(pendingSteerInputItems) && pendingSteerInputItems.length > 0) {
      nextBody.input = nextBody.input.concat(
        pendingSteerInputItems.map(item => cloneDataSafely(item)).filter(Boolean)
      );
    }
    return nextBody;
  }

  /**
   * 发送单次 API 请求，并根据“loading 占位是否仍然存在”决定是否展示细粒度状态文案。
   *
   * 注意：
   * - 一旦 loadingMessage 已升级为正式 AI 消息，再写它的 text-content 会污染正文；
   * - 所以 follow-up hop 里若已经出现 AI 消息，这里会自动静默，不再改写占位状态。
   *
   * @param {Object} options
   * @param {Object} options.requestBody
   * @param {Object} options.usedApiConfig
   * @param {AbortSignal} options.signal
   * @param {HTMLElement|null} options.loadingMessage
   * @param {{aiMessageId?:string}|null} options.attemptState
   * @returns {Promise<Response>}
   */
  async function sendApiRequestForAttempt({
    requestBody,
    usedApiConfig,
    signal,
    loadingMessage,
    attemptState
  }) {
    const resolveLoadingStatusTarget = () => resolveLiveLoadingStatusElement(loadingMessage, attemptState);
    const canUpdateLoadingStatus = () => normalizeOptionalTimestamp(attemptState?.firstVisibleOutputAtMs) == null;

    if (canUpdateLoadingStatus()) {
      syncAttemptPreResponseStatusFromLocalStage(
        resolveLoadingStatusTarget() || loadingMessage,
        attemptState,
        'send_request',
        { apiBase: usedApiConfig?.baseUrl || '', modelName: usedApiConfig?.modelName || '' }
      );
    }
    updateAttemptRuntimeState(attemptState, (draft) => {
      draft.activeTurn.status = 'streaming';
    });

    const response = await apiManager.sendRequest({
      requestBody,
      config: usedApiConfig,
      signal,
      onStatus: createRequestStatusHandler(
        () => resolveLoadingStatusTarget() || loadingMessage || null,
        attemptState
      )
    });

    if (!response.ok) {
      if (canUpdateLoadingStatus()) {
        syncAttemptPreResponseStatusFromLocalStage(
          resolveLoadingStatusTarget() || loadingMessage,
          attemptState,
          'read_error_body',
          { httpStatus: response.status, apiBase: usedApiConfig?.baseUrl || '', modelName: usedApiConfig?.modelName || '' }
        );
      }
      const error = await response.text();
      throw new Error(`API错误 (${response.status}): ${error}`);
    }

    {
      const responseHeadersTarget = resolveLoadingStatusTarget() || loadingMessage || null;
      if (responseHeadersTarget && normalizeOptionalTimestamp(attemptState?.firstVisibleOutputAtMs) == null) {
        syncAttemptPreResponseStatusFromLocalStage(
          responseHeadersTarget,
          attemptState,
          'response_headers_received',
          { httpStatus: response.status, apiBase: usedApiConfig?.baseUrl || '', modelName: usedApiConfig?.modelName || '' }
        );
      }
    }

    return response;
  }

  /**
   * 处理一次“Responses 请求 + 本地自定义 function tool follow-up”生命周期。
   *
   * 流程：
   * 1. 发送初始请求；
   * 2. 渲染当前 hop 的模型输出；
   * 3. 若模型返回 function_call，则本地执行；
   * 4. 以“完整 input replay + function_call_output”继续下一 hop；
   * 5. 直到没有新的 function_call 为止。
   *
   * @param {Object} options
   * @param {Object} options.initialRequestBody
   * @param {HTMLElement|null} options.loadingMessage
   * @param {Object} options.usedApiConfig
   * @param {AbortSignal} options.signal
   * @param {Object|null} options.attemptState
   * @returns {Promise<Object|null>}
   */
  async function executeApiRequestLifecycle({
    initialRequestBody,
    loadingMessage,
    usedApiConfig,
    signal,
    attemptState
  }) {
    let currentRequestBody = initialRequestBody;
    let lastHandleResult = null;
    let pendingSteerIdsAwaitingRequestAcceptance = [];
    let pendingSteerInputItemsAwaitingRequestAcceptance = [];

    while (true) {
      const response = await sendApiRequestForAttempt({
        requestBody: currentRequestBody,
        usedApiConfig,
        signal,
        loadingMessage,
        attemptState
      });

      if (pendingSteerIdsAwaitingRequestAcceptance.length > 0) {
        removeConversationPendingSteersByIds(
          getAttemptRuntimeConversationKey(attemptState),
          pendingSteerIdsAwaitingRequestAcceptance,
          attemptState
        );
        if (attemptState && pendingSteerInputItemsAwaitingRequestAcceptance.length > 0) {
          const mergedAcceptedInputItems = mergeResponsesReplayOutputItems(
            attemptState.responsesToolLoopAccumulatedInputItems,
            pendingSteerInputItemsAwaitingRequestAcceptance
          );
          applyResponsesInputItemsToAttempt(attemptState, mergedAcceptedInputItems);
          await persistAttemptConversationSnapshot(attemptState, { force: true });
        }
        pendingSteerIdsAwaitingRequestAcceptance = [];
        pendingSteerInputItemsAwaitingRequestAcceptance = [];
      }

      const requestedResponseHandlingMode = resolveResponseHandlingMode({
        apiBase: usedApiConfig?.baseUrl,
        connectionType: usedApiConfig?.connectionType,
        geminiUseStreaming: usedApiConfig?.useStreaming,
        requestBodyStream: !!(currentRequestBody && currentRequestBody.stream)
      });
      const responseHandlingMode = resolveReceivedResponseHandlingMode({
        requestedMode: requestedResponseHandlingMode,
        responseContentType: response.headers?.get?.('content-type') || '',
        hasResponseBody: !!response.body
      });
      const useStreaming = responseHandlingMode === 'stream';

      lastHandleResult = useStreaming
        ? await handleStreamResponse(response, loadingMessage, usedApiConfig, attemptState)
        : await handleNonStreamResponse(response, loadingMessage, usedApiConfig, attemptState);

      const pendingFunctionCalls = Array.isArray(lastHandleResult?.responseToolCalls)
        ? lastHandleResult.responseToolCalls
          .filter(record => String(record?.type || '').trim().toLowerCase() === 'function_call')
        : [];

      if (pendingFunctionCalls.length <= 0) {
        return lastHandleResult;
      }

      updateAttemptRuntimeState(attemptState, (draft) => {
        draft.activeTurn.status = 'waiting_tool';
      });
      await persistAttemptConversationSnapshot(attemptState, { force: true });

      const functionCallOutputs = [];
      for (const toolCall of pendingFunctionCalls) {
        if (signal?.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        functionCallOutputs.push(await executeResponsesCustomFunctionToolCall(toolCall, {
          attemptState,
          usedApiConfig
        }));
      }
      const replayOutputItemsForFollowUp = ensureResponsesReplayOutputItemsIncludeFunctionCalls(
        lastHandleResult?.responseOutputItems,
        pendingFunctionCalls
      );

      /**
       * 关键语义：标准 steer 应该在“下一个安全边界”被吸收。
       *
       * 对带工具调用的 Responses turn 来说，真正的安全边界不是“模型输出完 function_call item 的那一刻”，
       * 而是“本地工具执行完成、即将发起 follow-up request”这一刻。
       *
       * 这能覆盖两种用户时机：
       * 1. 模型刚发出 function_call 后立刻 steer；
       * 2. 工具执行过程中 steer（例如工具本身要等几秒）。
       *
       * 如果在执行工具前就把 pending steer 提前 drain 掉，第二类 steer 会被错误地延后到再下一轮边界，
       * 表现上就不像 Codex 的真正 steer。
       */
      const pendingSteersForFollowUp = getConversationPendingSteersForAttempt(attemptState);
      const pendingSteerInputItemsForFollowUp = pendingSteersForFollowUp
        .map((steer) => cloneDataSafely(steer?.responseInputItem))
        .filter((item) => item && typeof item === 'object');

      if (attemptState) {
        updateAttemptRuntimeState(attemptState, (draft) => {
          draft.activeTurn.status = 'applying_followup';
        });
        const mergedTimeline = mergeResponsesFunctionOutputsIntoTimeline(
          attemptState.responsesToolLoopAccumulatedTimeline || lastHandleResult?.responseActivityTimeline,
          pendingFunctionCalls,
          functionCallOutputs
        );
        const mergedInputItems = mergeResponsesReplayOutputItems(
          attemptState.responsesToolLoopAccumulatedInputItems,
          replayOutputItemsForFollowUp
        );
        const mergedInputItemsWithOutputs = mergeResponsesReplayOutputItems(
          mergedInputItems,
          functionCallOutputs
        );
        applyResponsesActivityTimelineToAttempt(attemptState, mergedTimeline);
        applyResponsesInputItemsToAttempt(attemptState, mergedInputItemsWithOutputs);
        await persistAttemptConversationSnapshot(attemptState, { force: true });
      }

      currentRequestBody = buildResponsesFunctionToolFollowUpRequest(
        currentRequestBody,
        replayOutputItemsForFollowUp,
        functionCallOutputs,
        pendingSteerInputItemsForFollowUp
      );
      pendingSteerIdsAwaitingRequestAcceptance = pendingSteersForFollowUp
        .map((steer) => String(steer?.id || '').trim())
        .filter(Boolean);
      pendingSteerInputItemsAwaitingRequestAcceptance = pendingSteerInputItemsForFollowUp
        .map((item) => cloneDataSafely(item))
        .filter(Boolean);
    }
  }

  /**
   * Core single-request send logic.
   *
   * 说明：
   * - Public callers should use sendMessage (below);
   * - sendMessageCore 始终只处理“一次对话请求”，方便自动重试逻辑直接复用。
   *
   * @private
   * @param {Object} [options] - 可选参数对象
   * @param {Array<string>} [options.injectedSystemMessages] - 重新生成时保留的系统消息
   * @param {string} [options.specificPromptType] - 指定使用的提示词类型
   * @param {Object|null} [options.promptMeta] - 与提示词类型相关的补充信息（例如 { selectionText }）
   * @param {string} [options.originalMessageText] - 原始消息文本，用于恢复输入框内容
   * @param {string|null} [options.inputImagesHtmlSnapshot] - 入队时冻结的图片 HTML 片段
   * @param {boolean|null} [options.inputHasImagesSnapshot] - 入队时冻结的“是否有图”状态
   * @param {boolean|null} [options.inputHasScreenshotSnapshot] - 入队时冻结的“是否含截图”状态
   * @param {string} [options.conversationIdOverride] - 强制绑定本次发送所属的会话ID（用于后台队列）
   * @param {Array<Object>|null} [options.historyMessagesSnapshot] - 后台队列使用的会话消息快照（完整列表）
   * @param {Object|null} [options.conversationApiLockSnapshot] - 后台发送时沿用的会话 API 锁快照
   * @param {boolean} [options.regenerateMode] - 是否为重新生成模式
   * @param {string} [options.messageId] - 重新生成模式下的消息ID（通常是用户消息的ID）
   * @param {string|null} [options.targetAiMessageId] - 重新生成模式下要“原地替换”的 AI 消息ID（为空则按旧逻辑追加新消息）
   * @param {Object|string} [options.api] - API 选择参数：可为完整配置对象、配置 id/displayName/modelName、'selected'、或 {favoriteIndex}
   * @param {Object} [options.resolvedApiConfig] - 已解析好的 API 配置（优先于 api 参数，完全绕过内部选择策略）
   * @param {boolean} [options.forceSendFullHistory] - 是否强制发送完整历史
   * @param {Object|null} [options.pageContentSnapshot] - 若提供则作为轻量 pageMeta 快照写入历史节点（不再自动读取/注入网页正文）
   * @param {Array<Object>|null} [options.conversationSnapshot] - 若提供则使用该会话历史快照（数组 of nodes）构建消息
   * @param {boolean} [options.omitDefaultSystemPrompt] - 是否跳过“提示词设置”里的默认系统提示词
   * @returns {Promise<{ ok: true, apiConfig: Object } | { ok: false, error: Error, apiConfig: Object, retryHint: Object, retry: (delayMs?: number, override?: Object) => Promise<any> }>} 结果对象（供外部无状态重试）
   */
  async function sendMessageCore(options = {}) {
    // 从options中提取重新生成所需的变量
    const {
      injectedSystemMessages: existingInjectedSystemMessages = [],
      specificPromptType = null,
      promptMeta: externalPromptMeta = null,
      originalMessageText = null,
      inputImagesHtmlSnapshot = null,
      inputHasImagesSnapshot = null,
      inputHasScreenshotSnapshot = null,
      conversationIdOverride = '',
      historyMessagesSnapshot = null,
      conversationApiLockSnapshot = undefined,
      regenerateMode = false,
      messageId = null,
      targetAiMessageId = null,
      forceSendFullHistory = false,
      api = null,
      resolvedApiConfig = null,
      pageContentSnapshot = null,
      conversationSnapshot = null,
      conversationRevisionSnapshot = null,
      omitDefaultSystemPrompt: externalOmitDefaultSystemPrompt = false,
      aspectRatioOverride: externalAspectRatioOverride = null,
      __skipClearInputs = false,
      __conversationJobId = '',
      __conversationJobKind = '',
      __conversationQueueKey = '',
      __conversationRevisionAtStart = null,
      __conversationRetryPolicy = null
    } = options;

    const conversationApiInfo = (typeof chatHistoryUI?.resolveActiveConversationApiConfig === 'function')
      ? chatHistoryUI.resolveActiveConversationApiConfig()
      : null;
    const lockConfig = conversationApiInfo?.lockConfig || null;
    const hasConversationLock = !!conversationApiInfo?.hasLock;
    const isConversationLockValid = !!conversationApiInfo?.isLockValid;

    let preferredApiConfig = null;
    if (api != null) {
      preferredApiConfig = resolveApiParamForSend(api);
    }

    const effectiveConfigCandidate = resolvedApiConfig
      || preferredApiConfig
      || lockConfig
      || apiManager.getSelectedConfig();

    // 验证API配置（优先使用本次有效配置）
    if (!validateApiConfig(effectiveConfigCandidate)) return;

    // 若会话固定 API 已失效且未显式覆盖，提示一次并回退到当前选中配置
    if (hasConversationLock && !isConversationLockValid && !resolvedApiConfig && !preferredApiConfig) {
      const now = Date.now();
      const convId = currentConversationId || chatHistoryUI?.getCurrentConversationId?.() || '';
      const shouldNotify = !lastInvalidApiLockNotice.at
        || lastInvalidApiLockNotice.conversationId !== convId
        || (now - lastInvalidApiLockNotice.at) > 60 * 1000;
      if (shouldNotify && typeof showNotification === 'function') {
        showNotification({ message: '该对话固定的 API 已失效，已改用当前 API', type: 'warning', duration: 2200 });
        lastInvalidApiLockNotice = { conversationId: convId, at: now };
      }
    }

    const autoRetrySetting = settingsManager?.getSetting?.('autoRetry');
    const normalizedAutoRetrySetting = normalizeAutoRetrySetting(autoRetrySetting);
    if (normalizedAutoRetrySetting !== null) {
      autoRetryEnabled = normalizedAutoRetrySetting;
    }

    const autoRetryAttempt = (typeof options.__autoRetryAttempt === 'number' && options.__autoRetryAttempt >= 0)
      ? options.__autoRetryAttempt
      : 0;
    const normalizedConversationJobId = (typeof __conversationJobId === 'string' && __conversationJobId.trim())
      ? __conversationJobId.trim()
      : '';
    const normalizedConversationJobKind = CONVERSATION_JOB_KINDS.has(__conversationJobKind)
      ? __conversationJobKind
      : (regenerateMode ? 'regenerate_assistant_turn' : 'append_user_message');
    const normalizedConversationQueueKey = (typeof __conversationQueueKey === 'string' && __conversationQueueKey.trim())
      ? resolveConversationQueueKey(__conversationQueueKey)
      : getCurrentActiveConversationQueueKey();
    const normalizedConversationRevisionAtStart = normalizeConversationHistoryRevision(__conversationRevisionAtStart);
    const normalizedConversationRetryPolicy = normalizeConversationJobRetryPolicy(
      normalizedConversationJobKind,
      __conversationRetryPolicy
    );
    let aspectRatioOverride = externalAspectRatioOverride || null;

    const snapshotImagesHtml = (typeof inputImagesHtmlSnapshot === 'string')
      ? inputImagesHtmlSnapshot
      : null;
    const resolvedInputImagesHtml = snapshotImagesHtml !== null
      ? snapshotImagesHtml
      : (inputController ? inputController.getImagesHTML() : imageContainer.innerHTML);
    const hasImagesInInput = (typeof inputHasImagesSnapshot === 'boolean')
      ? inputHasImagesSnapshot
      : (snapshotImagesHtml !== null
        ? !!snapshotImagesHtml.trim()
        : (inputController ? inputController.hasImages() : !!imageContainer.querySelector('.image-tag')));
    // 如果是重新生成，使用原始消息文本；否则从输入框获取
    let messageText = (originalMessageText !== null && originalMessageText !== undefined)
      ? originalMessageText
      : (inputController ? inputController.getInputText() : messageInput.textContent);
    const imageContainsScreenshot = (typeof inputHasScreenshotSnapshot === 'boolean')
      ? inputHasScreenshotSnapshot
      : (inputController ? inputController.hasScreenshot() : !!imageContainer.querySelector('img[alt="page-screenshot.png"]'));

    // 输入为空且没有图片时，仍可能由模板生成结构化消息；是否早退需在模板解析后再判断。
    const isEmptyMessageRaw = !messageText && !hasImagesInInput;

    let activeThreadContext = null;
    // 获取当前提示词设置
    const promptsConfig = promptSettingsManager.getPrompts();
    const currentPromptType = specificPromptType || messageProcessor.getPromptTypeFromContent(messageText, promptsConfig);

    const preprocessorConfig = resolvedApiConfig
      || preferredApiConfig
      || lockConfig
      || apiManager.getSelectedConfig();
    const skipUserMessagePreprocess = options.__skipUserMessagePreprocess === true;
    let messageTextForHistory = messageText;
    let preprocessedMessageText = null;
    let shouldApplyPreprocessor = false;
    let preprocessHistoryPatch = null;
    let injectedMessages = [];
    let hasInjectedBlocks = false;
    let injectOnly = false;
    let omitDefaultSystemPrompt = externalOmitDefaultSystemPrompt === true;

    let templateHasContent = false;
    if (skipUserMessagePreprocess) {
      shouldApplyPreprocessor = regenerateMode || !isEmptyMessageRaw;
      preprocessedMessageText = messageText;
      injectedMessages = [];
      hasInjectedBlocks = false;
      templateHasContent = !isEmptyMessageRaw;
    } else {
      const template = (typeof preprocessorConfig?.userMessagePreprocessorTemplate === 'string')
        ? preprocessorConfig.userMessagePreprocessorTemplate
        : '';
      const baseText = resolvePreprocessBaseText({ messageText, regenerateMode, messageId });
      const templateResult = renderUserMessageTemplateWithInjection({ template, inputText: baseText });
      omitDefaultSystemPrompt = omitDefaultSystemPrompt || templateResult.omitDefaultSystemPrompt === true;
      const hasTemplate = templateResult.hasTemplate === true;
      if (hasTemplate) {
        preprocessedMessageText = templateResult.renderedText;
        injectedMessages = templateResult.injectedMessages;
        hasInjectedBlocks = templateResult.hasInjectedBlocks;
        injectOnly = templateResult.injectOnly === true;
        const hasRenderedText = typeof preprocessedMessageText === 'string' && preprocessedMessageText.trim().length > 0;
        const hasInjectedMessages = Array.isArray(injectedMessages) && injectedMessages.length > 0;
        templateHasContent = hasRenderedText || hasInjectedMessages;
        shouldApplyPreprocessor = regenerateMode || !isEmptyMessageRaw || templateHasContent;
        const allowPreprocessHistory = !regenerateMode
          && preprocessorConfig?.userMessagePreprocessorIncludeInHistory
          && !hasInjectedBlocks;
        if (allowPreprocessHistory) {
          messageTextForHistory = preprocessedMessageText;
          preprocessHistoryPatch = {
            preprocessOriginalText: baseText,
            preprocessRenderedText: preprocessedMessageText
          };
        }
      } else {
        shouldApplyPreprocessor = regenerateMode || !isEmptyMessageRaw;
      }
    }

    // 如果输入为空且模板也没有生成任何内容，则直接返回（除非是重新生成或强制发送历史）。
    const isEffectivelyEmpty = isEmptyMessageRaw && !templateHasContent;
    if (isEffectivelyEmpty && !regenerateMode && !forceSendFullHistory) return;

    const threadContextCandidate = resolveActiveThreadContext();
    if (threadContextCandidate && threadContainer) {
      // 重新生成时，仅当目标消息属于当前线程才启用线程上下文
      let shouldUseThreadContext = true;
      if (regenerateMode) {
        const targetId = (typeof targetAiMessageId === 'string' && targetAiMessageId.trim())
          ? targetAiMessageId.trim()
          : (typeof messageId === 'string' && messageId.trim() ? messageId.trim() : '');
        if (targetId) {
          const targetNode = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === targetId) || null;
          shouldUseThreadContext = !!(targetNode && targetNode.threadId === threadContextCandidate.threadId);
        }
      }

      if (shouldUseThreadContext) {
        activeThreadContext = threadContextCandidate;
        activeThreadContext.container = threadContainer;
        // 线程内删除/重生成可能导致 lastMessageId 失效，发送前先修复注解链路。
        const repairedAnnotation = services.selectionThreadManager?.repairThreadAnnotation?.(activeThreadContext.threadId);
        if (repairedAnnotation) {
          activeThreadContext.annotation = repairedAnnotation;
        }
        activeThreadContext.rootMessageId = activeThreadContext.annotation?.rootMessageId || null;
        activeThreadContext.lastMessageId = activeThreadContext.annotation?.lastMessageId || null;
      }
    }

    // 重新生成“指定 AI 消息”的场景：如果提供 targetAiMessageId，则尝试进入“原地替换”模式。
    // 说明：
    // - messageId 仍然表示“对应的用户消息ID”，用于 composeMessages 裁剪上下文；
    // - targetAiMessageId 表示“要被替换内容的 AI 消息ID”，用于把生成结果写回到同一条消息上；
    // - 若校验失败（找不到消息/不是 assistant），会自动回退为旧逻辑：追加一条新的 AI 消息。
    const normalizedTargetAiMessageId = (typeof targetAiMessageId === 'string' && targetAiMessageId.trim())
      ? targetAiMessageId.trim()
      : null;
    let effectiveTargetAiMessageId = normalizedTargetAiMessageId;
    const normalizedRegenerateUserMessageId = (typeof messageId === 'string' && messageId.trim())
      ? messageId.trim()
      : null;
    if (regenerateMode) {
      const abortTargetId = normalizedTargetAiMessageId || normalizedRegenerateUserMessageId;
      if (abortTargetId) {
        abortCurrentRequest(abortTargetId, { strictTarget: true });
      }
    }
    // 提前创建 loadingMessage 配合finally使用
    let loadingMessage;
    let transientRegeneratePlaceholder = null;
    let canUpdateExistingAiMessage = false;
    let inPlaceRegenerateElement = null;
    let conversationChain = null;
    let effectiveApiConfig = null;

    const beginAttempt = () => {
      // 为当前请求创建独立的取消控制器与状态对象
      const startedAt = Date.now();
      const pageToolEnvironment = resolveResponsesPageToolEnvironment();
      const attemptState = {
        id: `attempt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        controller: new AbortController(),
        startedAt,
        firstVisibleOutputAtMs: null,
        manualAbort: false,
        finished: false,
        loadingMessage: null,
        aiMessageId: null,
        aiMessageNode: null,
        historyMessagesRef: null,
        boundConversationId: '',
        boundApiLock: undefined,
        lastPersistAt: 0,
        persistInFlight: false,
        persistPromise: null,
        pendingPersist: false,
        pendingForcedPersist: false,
        responsesToolLoopAccumulatedTimeline: null,
        responsesToolLoopAccumulatedInputItems: null,
        responsesToolLoopAssistantPhase: null,
        responsesToolLoopLastResponseId: null,
        runtimeConversationKey: normalizedConversationQueueKey || getCurrentActiveConversationQueueKey(),
        historyPromptCacheKey: normalizeResponsesPromptCacheKey(
          chatHistoryManager?.getConversationPromptCacheKey?.()
            || chatHistoryManager?.chatHistory?.promptCacheKey
        ),
        completedSuccessfully: false,
        supportsStandardSteer: false,
        conversationJobId: normalizedConversationJobId || null,
        conversationJobKind: normalizedConversationJobKind,
        pageToolEnvironment,
        conversationRevisionAtStart: normalizedConversationRevisionAtStart,
        historyConversationRevision: conversationRevisionSnapshot != null
          ? normalizeConversationHistoryRevision(conversationRevisionSnapshot)
          : normalizedConversationRevisionAtStart,
        retryPolicy: normalizedConversationRetryPolicy,
        pendingSteers: []
      };
      activeAttempts.set(attemptState.id, attemptState);
      updateAttemptRuntimeState(attemptState, (draft) => {
        draft.activeTurn.attemptId = attemptState.id;
        draft.activeTurn.jobId = attemptState.conversationJobId;
        draft.activeTurn.status = 'streaming';
        draft.activeTurn.startedAt = startedAt;
        draft.activeTurn.boundAssistantMessageId = null;
        draft.activeTurn.preResponseStatus = null;
        // 这是真正“正文 answer 已开始可见”的窄信号：
        // - 仅在 answer 文本首次出现后才置为 true；
        // - 不把 reasoning / commentary / tool timeline / 状态占位文案算作正文；
        // - 供 UI 决定何时收起思考面板，避免“正文一出来仍要等整轮结束才收起”。
        draft.activeTurn.hasVisibleAnswerStarted = false;
        draft.activeTurn.writeMode = effectiveTargetAiMessageId ? 'replace' : 'append';
        draft.activeTurn.conversationRevisionAtStart = attemptState.conversationRevisionAtStart;
        draft.responses.accumulatedInputItems = [];
        draft.responses.accumulatedTimeline = [];
        draft.responses.assistantPhase = null;
        draft.responses.lastResponseId = null;
      });
      notifyStreamingConversationStateChanged();

      // 如果这是第一个进行中的请求，开启全局“正在处理”状态与自动滚动
      if (activeAttempts.size === 1) {
        isProcessingMessage = true;
        shouldAutoScroll = true;
        GetInputContainer().classList.add('auto-scroll-glow');
      }

      return attemptState;
    };

	    const finalizeAttempt = (attemptState) => {
	      if (!attemptState || attemptState.finished) return;

	      // 重要：请求结束/失败/中断时，先把最后一帧 UI 更新尽量落地，并清理节流器的定时器。
	      // 否则可能出现“请求已结束但仍在后台更新 DOM”的情况，进一步放大卡顿或触发对已删除节点的更新。
	      try { attemptState.uiUpdateThrottler?.flush?.({ force: true }); } catch (_) {}
	      try { attemptState.uiUpdateThrottler?.cancel?.(); } catch (_) {}
	      try { attemptState.uiUpdateThrottler = null; } catch (_) {}
        clearAttemptPreResponseStatus(attemptState, attemptState.loadingMessage || null);

	      attemptState.finished = true;
      activeAttempts.delete(attemptState.id);
      const restoredPendingSteerJobs = restorePendingSteersForAttemptAsQueueFollowUps(attemptState);
      updateAttemptRuntimeState(attemptState, (draft) => {
        draft.activeTurn.status = attemptState.completedSuccessfully
          ? 'completed'
          : (attemptState.manualAbort ? 'aborted' : 'error');
        draft.activeTurn.preResponseStatus = null;
      });

      if (attemptState.completedSuccessfully) {
        const boundId = normalizeConversationId(attemptState.boundConversationId);
        if (boundId) {
          const finishedInBackground = !isAttemptMainConversationActive(attemptState);
          if (finishedInBackground) {
            backgroundCompletedConversationIds.add(boundId);
          } else {
            backgroundCompletedConversationIds.delete(boundId);
          }
        }
      }
      notifyStreamingConversationStateChanged();

      if (restoredPendingSteerJobs.length > 0 && isAttemptMainConversationActive(attemptState)) {
        showNotification?.({
          message: attemptState.completedSuccessfully
            ? `未被吸收的转向输入已转为 ${restoredPendingSteerJobs.length} 条排队消息`
            : '未被吸收的转向输入已移入队列并暂停',
          type: 'info',
          duration: 2200
        });
      }

      const runtimeConversationKey = getAttemptRuntimeConversationKey(attemptState);
      if (hasQueuedMessagesForConversation(runtimeConversationKey)) {
        scheduleConversationQueueFlush(runtimeConversationKey);
      }

      const hasOtherAttempts = activeAttempts.size > 0;
      if (!hasOtherAttempts) {
        // 所有请求都已结束，恢复静止状态
        isProcessingMessage = false;
        shouldAutoScroll = false;
        GetInputContainer().classList.remove('auto-scroll-glow');
        GetInputContainer().classList.remove('auto-scroll-glow-active');
      }

      // 清理与本次尝试相关的 UI 状态
      if (attemptState.aiMessageId) {
        const safeAiMessageId = escapeMessageIdForSelector(attemptState.aiMessageId);
        const selector = safeAiMessageId ? `.message[data-message-id="${safeAiMessageId}"]` : '';
        const aiEl = selector
          ? (chatContainer.querySelector(selector)
            || (threadContainer ? threadContainer.querySelector(selector) : null))
          : null;
        if (aiEl) {
          aiEl.classList.remove('updating');
          aiEl.classList.remove('regenerating');
        }
      } else if (attemptState.loadingMessage && attemptState.loadingMessage.parentNode) {
        // 尚未产生正式 AI 消息，仅存在 loading 占位
        attemptState.loadingMessage.remove();
      }
      if (attemptState.aiMessageId) {
        // 注意顺序：
        // 1. 先把 DOM 上的 updating/regenerating 视觉状态清掉；
        // 2. 再同步一次 metadata/view。
        // 否则 renderer 会在“旧的 updating class 仍在”时误判为仍处于进行中，
        // 导致思考面板和 response activity 面板无法按完成态自动收起。
        syncAttemptAssistantView(attemptState.aiMessageId, {
          attemptState,
          suppressMissingNodeWarning: true
        });
      }
    };

    let attempt = null;

    try {
      // 开始处理消息：为本次请求注册 attempt，并在必要时开启全局“正在处理”状态
      attempt = beginAttempt();
      if (Array.isArray(historyMessagesSnapshot)) {
        attempt.historyMessagesRef = historyMessagesSnapshot;
      }
      if (conversationRevisionSnapshot != null) {
        attempt.historyConversationRevision = normalizeConversationHistoryRevision(conversationRevisionSnapshot);
      }
      if (conversationIdOverride) {
        updateAttemptBoundConversationId(attempt, conversationIdOverride);
      }
      if (conversationApiLockSnapshot !== undefined) {
        attempt.boundApiLock = cloneDataSafely(conversationApiLockSnapshot);
      }
      // 固定本次请求绑定的会话上下文，后续即使切到其它会话也可继续后台落库。
      captureAttemptConversationContext(attempt);
      const signal = attempt.controller.signal;

      // 如果已有注入的系统消息，则使用它；否则从消息文本中提取
      const injectedSystemMessages = existingInjectedSystemMessages.length > 0 ? 
                                 existingInjectedSystemMessages : [];
                                   
      if (injectedSystemMessages.length === 0) {
        // 提取提示词中注入的系统消息
        const systemMessageRegex = /{{system}}([\s\S]*?){{end_system}}/g;
        messageText = messageText.replace(systemMessageRegex, (match, capture) => {
          injectedSystemMessages.push(capture);
          console.log('捕获注入的系统消息：', injectedSystemMessages);
          return '';
        });
      }

      // 清理历史文本中的系统注入块，避免落库（仅影响显示/历史，不影响注入逻辑）
      messageTextForHistory = stripInjectedSystemBlocks(messageTextForHistory);
      if (preprocessHistoryPatch && typeof preprocessHistoryPatch === 'object') {
        if (typeof preprocessHistoryPatch.preprocessOriginalText === 'string') {
          preprocessHistoryPatch.preprocessOriginalText = stripInjectedSystemBlocks(
            preprocessHistoryPatch.preprocessOriginalText
          );
        }
        if (typeof preprocessHistoryPatch.preprocessRenderedText === 'string') {
          preprocessHistoryPatch.preprocessRenderedText = stripInjectedSystemBlocks(
            preprocessHistoryPatch.preprocessRenderedText
          );
        }
      }

      effectiveApiConfig = resolvedApiConfig
        || preferredApiConfig
        || lockConfig
        || apiManager.getSelectedConfig();
      const sendChatHistoryFlag = shouldSendChatHistory || forceSendFullHistory;

      // 在重新生成模式下，不添加新的用户消息
      let userMessageDiv;
      let detachedUserMessageNode = null;
      const isDetachedMainConversationSend = isAttemptUsingDetachedMainConversationHistory(attempt);
      if (!isEmptyMessageRaw && !regenerateMode) {
        const promptMetaForHistory = buildPromptMetaForHistory({
          promptType: currentPromptType || 'none',
          promptMeta: externalPromptMeta,
          messageText,
          promptsConfig
        });
        const historyMeta = { promptType: currentPromptType || 'none', promptMeta: promptMetaForHistory };

        if (activeThreadContext) {
          // 线程模式：先补齐隐藏的“> 选中文本”节点，再把用户消息挂在其后
          const threadRootId = ensureThreadRootMessage(activeThreadContext);
          if (threadRootId) {
            const historyParentId = activeThreadContext.annotation?.lastMessageId || threadRootId;
            const threadHistoryPatch = buildThreadHistoryPatch(activeThreadContext);
            const historyPatch = (threadHistoryPatch || preprocessHistoryPatch)
              ? { ...(threadHistoryPatch || {}), ...(preprocessHistoryPatch || {}) }
              : null;
            userMessageDiv = messageProcessor.appendMessage(
              messageTextForHistory,
              'user',
              false,
              null,
              resolvedInputImagesHtml,
              null,
              null,
              historyMeta,
              {
                container: activeThreadContext.container,
                historyParentId,
                preserveCurrentNode: true,
                historyPatch
              }
            );

            if (userMessageDiv) {
              const userMessageId = userMessageDiv.getAttribute('data-message-id') || '';
              if (userMessageId) {
                activeThreadContext.userMessageId = userMessageId;
                updateThreadLastMessage(activeThreadContext, userMessageId);
              }
            }
          } else {
            activeThreadContext = null;
          }
        }

        if (!userMessageDiv && isDetachedMainConversationSend) {
          detachedUserMessageNode = createUserHistoryNodeForDetachedList({
            content: messageTextForHistory,
            imagesHTML: resolvedInputImagesHtml,
            historyParentId: getDetachedConversationParentMessageId(attempt?.historyMessagesRef || []),
            historyPatch: preprocessHistoryPatch || null,
            meta: historyMeta,
            historyMessagesRef: attempt?.historyMessagesRef || null,
            pageMeta: pageContentSnapshot || buildCurrentPageMetaSnapshot()
          });
        }

        if (!userMessageDiv && !detachedUserMessageNode) {
          const messageOptions = preprocessHistoryPatch ? { historyPatch: preprocessHistoryPatch } : null;
          userMessageDiv = messageProcessor.appendMessage(
            messageTextForHistory,
            'user',
            false,
            null,
            resolvedInputImagesHtml,
            null,
            null,
            historyMeta,
            messageOptions
          );
        }
      }

      if (activeThreadContext) {
        if (activeThreadContext.userMessageId) {
          activeThreadContext.parentMessageIdForAi = activeThreadContext.userMessageId;
        }
        attempt.threadContext = activeThreadContext;
      } else if (attempt) {
        // 普通对话：锁定本次 AI 回复应挂载的父节点，避免后续链路断裂。
        const regenParentId = (regenerateMode && typeof messageId === 'string') ? messageId.trim() : '';
        const userMessageId = userMessageDiv?.getAttribute?.('data-message-id')
          || detachedUserMessageNode?.id
          || '';
        const fallbackParentId = isDetachedMainConversationSend
          ? getDetachedConversationParentMessageId(attempt?.historyMessagesRef || [])
          : (chatHistoryManager.chatHistory.currentNode || null);
        attempt.parentMessageIdForAi = regenParentId || userMessageId || fallbackParentId;
      }

      // 关键持久化修复：
      // - 用户消息写入后立刻落库，避免“流式尚未完成就关闭页面”导致用户消息丢失；
      // - 同时固定 attempt 的会话/历史引用，供后续后台流式增量写库使用。
      if (attempt) {
        captureAttemptConversationContext(attempt);
      }
      if (!regenerateMode && (userMessageDiv || detachedUserMessageNode)) {
        await persistAttemptConversationSnapshot(attempt, { force: true });
      }

      // 清空输入区域
      if (!regenerateMode && !__skipClearInputs) {
        clearInputs();
      }

      // --- 重新生成：原地替换指定 AI 消息（不新增/不删除其他消息）---
      // 注意：这里只决定“写回目标”，不改变 composeMessages 的裁剪策略；裁剪仍由 messageId（用户消息ID）负责。
      if (regenerateMode && effectiveTargetAiMessageId) {
        try {
          const targetBinding = resolveRetryOrRegenerateTargetBinding({
            attemptState: attempt,
            targetAiMessageId: effectiveTargetAiMessageId
          });
          const node = targetBinding.targetNode;
          const el = targetBinding.targetElement;
          // 允许“仅历史节点存在但 DOM 缺失”的场景继续原地替换，避免线程切换时误追加新消息。
          canUpdateExistingAiMessage = targetBinding.canReplaceInPlace;

          if (canUpdateExistingAiMessage) {
            // 绑定 attempt 到目标 AI 消息，便于“停止更新”按消息粒度工作
            bindAttemptAiMessage(attempt, effectiveTargetAiMessageId, node);
            // 阅读位置锁定：仅对“原地替换”重新生成开启。
            // - preserveTargetMessageId 用于在流式/非流式更新时判断是否需要做滚动补偿；
            // - preserveReadingPosition 用于总开关，避免普通发送/普通更新带来额外开销。
            attempt.preserveReadingPosition = true;
            attempt.preserveTargetMessageId = effectiveTargetAiMessageId;
            resetAssistantResponseMetaForRegenerateStart(effectiveTargetAiMessageId, attempt, el);
            clearBoundSignatureForRegenerate(effectiveTargetAiMessageId, attempt);
            if (el) {
              inPlaceRegenerateElement = el;
              // 若该消息曾进入错误态（红字/重试按钮），开始重试前先清理，避免视觉状态遗留。
              try {
                el.classList.remove('error-message');
                el.classList.remove('loading-message');
                el.querySelectorAll('.error-retry-actions').forEach((actionEl) => actionEl.remove());
              } catch (_) {}
              resetThoughtsToggleStateForRegenerate(el);
              resetResponsesActivityToggleStateForRegenerate(el);
              try {
                el.classList.add('updating');
                el.classList.add('regenerating');
              } catch (_) {}

              // 若目标并非最后一条 AI 消息，关闭自动滚动，避免视角被强行拉到底部
              try {
                const aiScope = (threadContainer && threadContainer.contains(el)) ? threadContainer : chatContainer;
                const aiMessages = aiScope.querySelectorAll('.message.ai-message');
                const lastAi = aiMessages.length > 0 ? aiMessages[aiMessages.length - 1] : null;
                if (lastAi && lastAi !== el) {
                  shouldAutoScroll = false;
                }
              } catch (_) {}
            }
          }
        } catch (e) {
          console.warn('校验 targetAiMessageId 失败，将回退为追加消息:', e);
          canUpdateExistingAiMessage = false;
        }
      }

      if (regenerateMode && !canUpdateExistingAiMessage) {
        const adjacentTarget = resolveAdjacentRegenerateTargetCandidate({
          userMessageId: normalizedRegenerateUserMessageId
        });
        const adjacentElement = adjacentTarget.element instanceof HTMLElement
          ? adjacentTarget.element
          : null;
        const adjacentTargetAiMessageId = normalizeConversationId(adjacentTarget.targetAiMessageId || '');

        if (adjacentElement && adjacentTargetAiMessageId) {
          effectiveTargetAiMessageId = adjacentTargetAiMessageId;
          canUpdateExistingAiMessage = true;
          inPlaceRegenerateElement = adjacentElement;
          bindAttemptAiMessage(attempt, effectiveTargetAiMessageId);
          attempt.preserveReadingPosition = true;
          attempt.preserveTargetMessageId = effectiveTargetAiMessageId;
          resetAssistantResponseMetaForRegenerateStart(effectiveTargetAiMessageId, attempt, adjacentElement);
          clearBoundSignatureForRegenerate(effectiveTargetAiMessageId, attempt);
          try {
            adjacentElement.classList.remove('error-message');
            adjacentElement.classList.remove('loading-message');
            adjacentElement.querySelectorAll('.error-retry-actions').forEach((actionEl) => actionEl.remove());
          } catch (_) {}
          resetThoughtsToggleStateForRegenerate(adjacentElement);
          resetResponsesActivityToggleStateForRegenerate(adjacentElement);
          try {
            adjacentElement.classList.add('updating');
            adjacentElement.classList.add('regenerating');
          } catch (_) {}
          updateAttemptRuntimeState(attempt, (draft) => {
            draft.activeTurn.writeMode = 'replace';
            draft.activeTurn.boundAssistantMessageId = effectiveTargetAiMessageId;
          });
        } else {
          transientRegeneratePlaceholder = resolveTransientRegeneratePlaceholder({
            userMessageId: normalizedRegenerateUserMessageId
          });
        }
      }

      // 添加加载状态消息（仅在“追加新消息”模式下需要占位）
      if (!canUpdateExistingAiMessage) {
        if (transientRegeneratePlaceholder) {
          loadingMessage = transientRegeneratePlaceholder;
          attempt.loadingMessage = loadingMessage;
          try {
            loadingMessage.querySelectorAll('.error-retry-actions').forEach((actionEl) => actionEl.remove());
          } catch (_) {}
          try {
            loadingMessage.querySelectorAll('.thoughts-content').forEach((thoughtsEl) => thoughtsEl.remove());
          } catch (_) {}
          try {
            loadingMessage.querySelectorAll('.response-activity-timeline, .response-tool-calls').forEach((panelEl) => panelEl.remove());
          } catch (_) {}
          let textContentDiv = loadingMessage.querySelector('.text-content');
          if (!textContentDiv) {
            textContentDiv = document.createElement('div');
            textContentDiv.classList.add('text-content');
            loadingMessage.appendChild(textContentDiv);
          }
          textContentDiv.textContent = '';
          loadingMessage.setAttribute('data-original-text', '');
          loadingMessage.removeAttribute('title');
          loadingMessage.classList.remove('error-message');
          loadingMessage.classList.add('loading-message');
          loadingMessage.classList.add('updating');
          loadingMessage.classList.add('regenerating');
        } else {
          const threadUiActive = isThreadUiActive(activeThreadContext);
          const shouldRenderMainConversationDom = isAttemptMainConversationActive(attempt);
          const loadingOptions = activeThreadContext
            ? { container: activeThreadContext.container, skipDom: !threadUiActive }
            : (!shouldRenderMainConversationDom ? { skipDom: true } : null);
          loadingMessage = messageProcessor.appendMessage('', 'ai', true, null, null, null, null, null, loadingOptions);
          attempt.loadingMessage = loadingMessage;
          if (loadingMessage) {
            loadingMessage.classList.add('loading-message');
            // 让“等待回复”占位消息也带有 updating 状态，便于右键菜单显示“停止更新”
            loadingMessage.classList.add('updating');
          }
        }
      } else {
        loadingMessage = inPlaceRegenerateElement
          || (effectiveTargetAiMessageId ? findVisibleMessageElementById(effectiveTargetAiMessageId) : null)
          || null;
        attempt.loadingMessage = loadingMessage;
      }

      if (!regenerateMode && loadingMessage && loadingMessage.parentNode) {
        const loadingScrollContainer = activeThreadContext
          ? resolveThreadUiContainer(activeThreadContext)
          : (isAttemptMainConversationActive(attempt) ? chatContainer : null);
        if (loadingScrollContainer) {
          // 外层聊天容器只在“新 assistant 占位消息进入视口”这一刻触发一次自动滚动：
          // - 默认 stopAtTop=true 时，这里会把最新消息顶边锚到可视区上沿附近；
          // - 随后的思考/工具/正文增量更新都不再反复推动外层列表滚动。
          scrollToBottom(loadingScrollContainer);
        }
      }

      // 更新加载状态：正在构建消息
      syncAttemptPreResponseStatusFromLocalStage(loadingMessage, attempt, 'compose_messages');

      // 构建消息数组（改为纯函数 composer）
      conversationChain = resolveConversationChainForAttempt({
        attemptState: attempt,
        conversationSnapshot,
        activeThreadContext,
        regenerateMode,
        messageId,
        sendChatHistoryFlag
      });
      const configForMaxHistory = effectiveApiConfig
        || apiManager.getSelectedConfig();
      const filteredConversationChain = conversationChain;
      // 获取 API 配置：仅使用外部提供（resolvedApiConfig / api 解析）或当前选中。
      // 这里提前解析，是因为页面运行环境隐藏上下文需要在 composeMessages 之前写回历史节点，
      // 这样本轮请求就能直接使用独立 contextual item，而不是再通过 instructions 临时拼接。
      const config = effectiveApiConfig || apiManager.getSelectedConfig();
      effectiveApiConfig = config;
      if (attempt) {
        attempt.supportsStandardSteer = isOpenAIResponsesApiConfig(config);
      }
      const responsesPageToolEnvironment = resolveResponsesPageToolEnvironment(attempt);
      const shouldPrepareEnvironmentContext = isOpenAIResponsesApiConfig(effectiveApiConfig);
      const shouldPreparePageRuntimeContext = (
        isOpenAIResponsesApiConfig(effectiveApiConfig)
        && typeof utils?.executeJsRuntime === 'function'
      );
      const shouldPrepareMicroSkillContext = (
        isOpenAIResponsesApiConfig(effectiveApiConfig)
        && typeof utils?.getMatchingMicroSkillSummaries === 'function'
      );
      let pageRuntimeContextPayload = null;
      let microSkillContextPayload = null;
      if (shouldPreparePageRuntimeContext) {
        let jsRuntimeFrames = null;
        if (
          typeof utils?.getJsRuntimeFrames === 'function'
          && responsesPageToolEnvironment?.shouldInjectJsRuntimeFrameContext === true
        ) {
          syncAttemptPreResponseStatusFromLocalStage(loadingMessage, attempt, 'get_js_runtime_frames');
          jsRuntimeFrames = await getJsRuntimeFrameSnapshot(
            responsesPageToolEnvironment.jsRuntimeEnvironment
          );
        }
        pageRuntimeContextPayload = buildPageRuntimeContextPayload({
          pageToolEnvironment: responsesPageToolEnvironment,
          pageMeta: buildCurrentPageMetaSnapshot(),
          frames: jsRuntimeFrames
        });
      }
      if (shouldPrepareMicroSkillContext) {
        const microSkillSummaryResult = await utils.getMatchingMicroSkillSummaries();
        microSkillContextPayload = buildMicroSkillContextPayload({
          mode: responsesPageToolEnvironment?.jsRuntimeEnvironment === JS_RUNTIME_ENV_BOUND_HOST_PAGE
            ? 'host_page'
            : 'isolated_sandbox',
          url: microSkillSummaryResult?.success === true ? microSkillSummaryResult.url : '',
          skills: microSkillSummaryResult?.success === true ? microSkillSummaryResult.skills : []
        });
      }
      if (shouldPrepareEnvironmentContext) {
        syncUserContextualInputsForConversationTurn({
          conversationChain: filteredConversationChain,
          targetUserNode: findLatestUserNodeInConversationChain(filteredConversationChain),
          pageRuntimeContextPayload,
          microSkillContextPayload,
          environmentContextPayload: buildEnvironmentContextPayload()
        });
      }

      const messages = composeMessages({
        prompts: promptsConfig,
        injectedSystemMessages,
        pageContent: null,
        imageContainsScreenshot: !!imageContainsScreenshot,
        omitDefaultSystemPrompt,
        currentPromptType,
        regenerateMode,
        messageId,
        conversationChain: filteredConversationChain,
        sendChatHistory: sendChatHistoryFlag,
        // 旧字段：按总条目数裁剪（向后兼容）
        maxHistory: configForMaxHistory?.maxChatHistory ?? 500,
        // 新字段：按角色分别裁剪（超长对话更易控）
        maxUserHistory: configForMaxHistory?.maxChatHistoryUser,
        maxAssistantHistory: configForMaxHistory?.maxChatHistoryAssistant
      });

      // 在真正发给模型前，统一清理所有用户消息末尾的控制标记
      // Strip only ratio markers like [16:9]/[Auto] before model request.
      const sanitizedMessages = messages.map((msg) => {
        if (msg && msg.role === 'user' && typeof msg.content === 'string') {
          const { baseText } = extractTrailingControlMarkers(msg.content);
          if (baseText !== msg.content) {
            return { ...msg, content: baseText };
          }
        }
        return msg;
      });
      const hasInjectedMessages = Array.isArray(injectedMessages) && injectedMessages.length > 0;
      const shouldApplyPreprocessText = shouldApplyPreprocessor
        && typeof preprocessedMessageText === 'string'
        && !injectOnly;
      const preprocessedMessages = shouldApplyPreprocessText
        ? applyPreprocessedTextToMessages(sanitizedMessages, preprocessedMessageText)
        : sanitizedMessages;
      const messagesAfterInjection = hasInjectedMessages
        ? applyInjectedMessages(preprocessedMessages, injectedMessages, { replaceLastUser: injectOnly })
        : preprocessedMessages;
      const finalMessages = messagesAfterInjection;
      const latestUserOutboundContent = getLatestUserMessageContent(finalMessages);

      if (!regenerateMode && (userMessageDiv || detachedUserMessageNode)) {
        const userMessageIdForOutbound = userMessageDiv?.getAttribute?.('data-message-id')
          || detachedUserMessageNode?.id
          || '';
        syncHistoryUserOutboundContent({
          attemptState: attempt,
          userMessageId: userMessageIdForOutbound,
          detachedUserMessageNode,
          outboundContent: latestUserOutboundContent
        });
      }

      // 添加字数统计元素
      if (!regenerateMode) {
        addContentLengthFooter(userMessageDiv, config);
      }

      function addContentLengthFooter(userMessageDiv, config) {
        if (!userMessageDiv) return;
        
        // 创建字数统计元素
        const footer = document.createElement('div');
        footer.classList.add('content-length-footer');
        footer.textContent = `${config.modelName}`;

        // 添加到用户消息下方
        userMessageDiv.appendChild(footer);
      }

      // 更新加载状态：构造请求载荷（此阶段尚未发起网络请求，可能包含图片编码/自定义参数合并等耗时操作）
      syncAttemptPreResponseStatusFromLocalStage(loadingMessage, attempt, 'build_request_body');

      // 解析宽高比控制标记（如果存在），用于单次请求级别的图片配置覆盖
      if (!aspectRatioOverride) {
        const aspectInfo = extractTrailingControlMarkers(
          typeof messageText === 'string' ? messageText : ''
        );
        aspectRatioOverride = aspectInfo.aspectRatio;
      }

      /** 构造 API 请求体（可能包含异步图片加载，例如本地文件转 Base64） */
      const requestOverrides = {};
      // 仅在 Gemini 场景下注入宽高比控制，保留 imageSize 由用户配置或后续默认值决定
      if (aspectRatioOverride && isGeminiApiConfig(config)) {
        requestOverrides.generationConfig = {
          responseModalities: ['IMAGE'],
          imageConfig: {
            aspectRatio: aspectRatioOverride
          }
        };
      }

      const requestBody = await apiManager.buildRequest({
        messages: finalMessages,
        config: config,
        overrides: requestOverrides
      });
      if (isOpenAIResponsesApiConfig(effectiveApiConfig)
        && !normalizeResponsesPromptCacheKey(requestBody?.prompt_cache_key)) {
        const autoPromptCacheKey = resolveAutoResponsesPromptCacheKey({
          requestBody,
          usedApiConfig: effectiveApiConfig,
          attemptState: attempt,
          conversationIdHint: conversationIdOverride || currentConversationId || chatHistoryUI?.getCurrentConversationId?.(),
          runtimeConversationKeyHint: normalizedConversationQueueKey || attempt?.runtimeConversationKey
        });
        if (autoPromptCacheKey) {
          requestBody.prompt_cache_key = autoPromptCacheKey;
        }
      }
      if (isOpenAIResponsesApiConfig(effectiveApiConfig)) {
        const normalizedPromptCacheKey = normalizeResponsesPromptCacheKey(requestBody?.prompt_cache_key);
        const normalizedPromptCacheRetention = resolveDefaultResponsesPromptCacheRetention({
          promptCacheKey: normalizedPromptCacheKey,
          baseUrl: effectiveApiConfig?.baseUrl,
          promptCacheRetention: requestBody?.prompt_cache_retention
            ?? effectiveApiConfig?.responsesApiSettings?.prompt_cache_retention
        });
        if (normalizedPromptCacheRetention) {
          requestBody.prompt_cache_retention = normalizedPromptCacheRetention;
        }
      }
      const preparedRequestBody = prepareResponsesRequestBodyForCustomTools(
        requestBody,
        effectiveApiConfig,
        responsesPageToolEnvironment
      );

      await executeApiRequestLifecycle({
        initialRequestBody: preparedRequestBody,
        loadingMessage,
        usedApiConfig: effectiveApiConfig,
        signal,
        attemptState: attempt
      });

      // 消息处理完成后，强制保存一次最终态。
      // 注意：这里必须使用 attempt 绑定的会话上下文，避免“中途切到其它会话”时写错目标会话。
      const finalConversation = await persistAttemptConversationSnapshot(attempt, { force: true });
      const finalConversationId = normalizeConversationId(finalConversation?.id)
        || normalizeConversationId(attempt?.boundConversationId)
        || normalizeConversationId(chatHistoryUI?.getCurrentConversationId?.());
      if (finalConversationId && isAttemptMainConversationActive(attempt)) {
        updateCurrentConversationContext(finalConversationId);
      }
      if (attempt) {
        attempt.completedSuccessfully = true;
      }

      // 首条 AI 回复后尝试生成对话标题（异步，不阻塞主流程）
      const titleConversationId = finalConversationId || currentConversationId || chatHistoryUI.getCurrentConversationId();
      if (titleConversationId) {
        void maybeGenerateConversationTitle({
          conversationId: titleConversationId,
          attemptState: attempt,
          regenerateMode
        });
      }

    } catch (error) {
      const isAbortError = error?.name === 'AbortError';
      const wasManualAbort = isAbortError && attempt?.manualAbort;

      if (wasManualAbort) {
        // 用户手动停止：仅当仍处于“纯占位”状态时移除 loadingMessage，
        // 若已复用占位并升级为 AI 消息，则保留当前内容，避免直接消失。
        const hasAiMessage = !!attempt?.aiMessageId
          || (!!loadingMessage && loadingMessage.classList?.contains('ai-message'));
        if (!hasAiMessage && loadingMessage && loadingMessage.parentNode) {
          loadingMessage.remove();
        }
        await persistAttemptConversationSnapshot(attempt, { force: true });
        console.log('用户手动停止更新');
        return { ok: false, aborted: true };
      }

      console.error('发送消息失败:', error);

      // 返回一个可供外部使用的“无状态重试提示”对象
      const canReusePreprocessedText = !skipUserMessagePreprocess
        && shouldApplyPreprocessor
        && !hasInjectedBlocks
        && typeof preprocessedMessageText === 'string';
      const retryOriginalMessageText = canReusePreprocessedText
        ? preprocessedMessageText
        : messageText;
      const skipNextPreprocess = skipUserMessagePreprocess || canReusePreprocessedText;

      const retryHint = {
        injectedSystemMessages: existingInjectedSystemMessages,
        specificPromptType,
        promptMeta: externalPromptMeta,
        originalMessageText: retryOriginalMessageText,
        inputImagesHtmlSnapshot,
        inputHasImagesSnapshot,
        inputHasScreenshotSnapshot,
        conversationIdOverride,
        historyMessagesSnapshot,
        conversationRevisionSnapshot: attempt?.historyConversationRevision ?? conversationRevisionSnapshot,
        conversationApiLockSnapshot,
        regenerateMode,
        messageId,
        targetAiMessageId: effectiveTargetAiMessageId,
        forceSendFullHistory,
        pageContentSnapshot: pageContentSnapshot || buildCurrentPageMetaSnapshot(),
        conversationSnapshot: Array.isArray(conversationChain) ? conversationChain : conversationSnapshot,
        omitDefaultSystemPrompt,
        aspectRatioOverride,
        __skipClearInputs: true,
        __skipUserMessagePreprocess: skipNextPreprocess,
        // 透传外部策略决定的API（若有）
        resolvedApiConfig,
        api
      };
      const retry = async (override = {}) => {
        const mergedHint = { ...retryHint, ...override };
        const retryBoundConversationId = normalizeConversationId(attempt?.boundConversationId)
          || normalizeConversationId(currentConversationId)
          || normalizeConversationId(chatHistoryUI?.getCurrentConversationId?.());
        if (normalizedConversationJobId) {
          removeConversationQueuedTask(normalizedConversationQueueKey || retryBoundConversationId, normalizedConversationJobId);
        }
        const nextJob = normalizeConversationQueuedTask({
          id: createQueuedConversationTaskId(),
          kind: normalizedConversationJobKind,
          status: 'queued',
          paused: false,
          conversationId: retryBoundConversationId,
          conversationRevisionAtEnqueue: resolveConversationHistoryRevision(retryBoundConversationId),
          anchorMessageId: normalizeConversationId(mergedHint.messageId),
          targetAiMessageId: normalizeConversationId(mergedHint.targetAiMessageId),
          retryPolicy: normalizedConversationRetryPolicy,
          retryCount: 0,
          payload: mergedHint
        });
        return dispatchConversationJob(
          normalizedConversationQueueKey || retryBoundConversationId,
          nextJob
        );
      };
      retry.__targetAiMessageId = effectiveTargetAiMessageId || '';

      const canAutoRetry = (
        autoRetryEnabled
        && normalizedConversationJobKind === 'append_user_message'
        && normalizedConversationRetryPolicy.enabled
        && autoRetryAttempt < (normalizedConversationRetryPolicy.maxAttempts - 1)
      );
      if (canAutoRetry) {
        if (loadingMessage && loadingMessage.parentNode) {
          loadingMessage.remove();
        }
        const nextAttemptIndex = autoRetryAttempt + 1;
        const delayMs = Math.min(
          normalizedConversationRetryPolicy.maxDelayMs,
          getAutoRetryDelayMs(autoRetryAttempt)
        );
        if (typeof showNotification === 'function') {
          const delayText = delayMs >= 1000
            ? `${(delayMs / 1000).toFixed(delayMs >= 10000 ? 0 : 1)}秒`
            : `${delayMs}毫秒`;
          // 警告：发送失败，进入自动重试
          showNotification({
            message: `发送失败，将在 ${delayText} 后自动重试 (${nextAttemptIndex}/${normalizedConversationRetryPolicy.maxAttempts})`,
            type: 'warning'
          });
        }
        upsertConversationQueuedTask(normalizedConversationQueueKey, {
          id: normalizedConversationJobId || createQueuedConversationTaskId(),
          kind: normalizedConversationJobKind,
          status: 'delayed_retry',
          paused: false,
          conversationId: normalizeConversationId(attempt?.boundConversationId)
            || normalizeConversationId(currentConversationId)
            || normalizeConversationId(chatHistoryUI?.getCurrentConversationId?.()),
          conversationRevisionAtEnqueue: normalizedConversationRevisionAtStart,
          anchorMessageId: normalizeConversationId(messageId),
          targetAiMessageId: effectiveTargetAiMessageId,
          retryPolicy: normalizedConversationRetryPolicy,
          retryCount: nextAttemptIndex,
          availableAt: Date.now() + delayMs,
          failureMessage: (typeof error?.message === 'string' && error.message.trim())
            ? error.message.trim()
            : '',
          payload: {
            ...retryHint,
            __autoRetryAttempt: nextAttemptIndex
          }
        });
        return { ok: false, error, retryScheduled: true };
      }

      const detail = (typeof error?.message === 'string' && error.message.trim().length > 0)
        ? error.message.trim()
        : '发生未知错误';
      const prefix = autoRetryEnabled
        ? `自动重试失败 (${MAX_AUTO_RETRY_ATTEMPTS} 次): `
        : isAbortError
          ? '请求中断: '
          : '发送失败: ';
      const errorMessageText = `${prefix}${detail}`;

      let messageElement = null;
      if (effectiveTargetAiMessageId) {
        const targetBinding = resolveRetryOrRegenerateTargetBinding({
          attemptState: attempt,
          targetAiMessageId: effectiveTargetAiMessageId
        });
        if (targetBinding.targetElement) {
          messageElement = targetBinding.targetElement;
        }
      }
      if (!messageElement && loadingMessage && loadingMessage.parentNode) {
        messageElement = loadingMessage;
      } else if (!messageElement) {
        const errorUiActive = isThreadUiActive(activeThreadContext);
        const errorOptions = activeThreadContext
          ? { container: activeThreadContext.container, skipDom: !errorUiActive }
          : null;
        messageElement = messageProcessor.appendMessage(errorMessageText, 'ai', true, null, null, null, null, null, errorOptions);
      }

      if (messageElement) {
        clearAttemptPreResponseStatus(attempt, messageElement);
        try {
          const rootTextNodes = Array.from(messageElement.childNodes || []).filter(node => node && node.nodeType === 3);
          rootTextNodes.forEach((node) => node.remove());
        } catch (_) {}
        try {
          messageElement.querySelectorAll('.error-retry-actions').forEach((actionEl) => actionEl.remove());
        } catch (_) {}
        try {
          messageElement.querySelectorAll('.assistant-pre-response-status').forEach((statusEl) => statusEl.remove());
        } catch (_) {}
        try {
          messageElement.querySelectorAll('.thoughts-content').forEach((thoughtsEl) => thoughtsEl.remove());
        } catch (_) {}
        try {
          messageElement.querySelectorAll('.response-activity-timeline, .response-tool-calls').forEach((panelEl) => panelEl.remove());
        } catch (_) {}
        let textContentDiv = messageElement.querySelector('.text-content');
        if (!textContentDiv) {
          textContentDiv = document.createElement('div');
          textContentDiv.classList.add('text-content');
          const apiFooter = messageElement.querySelector('.api-footer');
          if (apiFooter && apiFooter.parentNode === messageElement) {
            messageElement.insertBefore(textContentDiv, apiFooter);
          } else {
            messageElement.appendChild(textContentDiv);
          }
        }
        textContentDiv.textContent = errorMessageText;
        messageElement.setAttribute('data-original-text', errorMessageText);
        messageElement.classList.add('error-message');
        messageElement.classList.remove('assistant-pre-response');
        messageElement.classList.remove('loading-message');
        messageElement.classList.remove('updating');
        messageElement.classList.remove('regenerating');
        const errorScrollContainer = activeThreadContext
          ? resolveThreadUiContainer(activeThreadContext)
          : chatContainer;
        if (errorScrollContainer) {
          scrollToBottom(errorScrollContainer);
        }
        attachManualRetryAction(messageElement, retry);

        // 关键修复：当我们把 loading 占位“升级”为错误消息后，避免 finally 阶段再把它当作占位节点删除。
        if (attempt && attempt.loadingMessage === messageElement) {
          attempt.loadingMessage = null;
        }
      }

      if (autoRetryEnabled && typeof showNotification === 'function') {
        // 错误：重试达到上限
        showNotification({
          message: `自动重试失败，已达到最大尝试次数 (${normalizedConversationRetryPolicy.maxAttempts})`,
          type: 'error'
        });
      }

      await persistAttemptConversationSnapshot(attempt, { force: true });
      return { ok: false, error, apiConfig: (effectiveApiConfig || resolvedApiConfig || preferredApiConfig || lockConfig || apiManager.getSelectedConfig()), retryHint, retry };
    } finally {
      finalizeAttempt(attempt);
    }
    // 成功：返回 ok 与实际使用的 api 配置（供外部记录/重试）
    return { ok: true, apiConfig: (effectiveApiConfig || resolvedApiConfig || preferredApiConfig || lockConfig || apiManager.getSelectedConfig()) };
  }

  /**
   * 使用外部解析好的 API 配置发送（完全绕过内部 API 选择策略）
   * @param {Object} params
   * @param {Object} params.apiConfig - 已解析好的 API 配置
   * @param {Array<string>} [params.injectedSystemMessages]
   * @param {string} [params.specificPromptType]
   * @param {string} [params.originalMessageText]
   * @param {boolean} [params.regenerateMode]
   * @param {string} [params.messageId]
   * @param {boolean} [params.forceSendFullHistory]
   * @returns {Promise<void>}
   */
  async function sendWithApiConfig(params) {
    if (!params || !params.apiConfig) {
      console.error('sendWithApiConfig: 缺少 apiConfig');
      return;
    }
    const { apiConfig, ...rest } = params;
    return sendMessage({ ...rest, resolvedApiConfig: apiConfig });
  }

  /**
   * Parse trailing control markers from user text.
   *
   * Current behavior:
   * - Only image aspect-ratio markers are recognized (for example [16:9] / [Auto]);
   * - Legacy [xN] input syntax is no longer supported;
   * - Parsing stops on unknown or duplicate markers to avoid trimming normal text accidentally.
   *
   * @param {string} text
   * @returns {{ baseText: string, aspectRatio: string|null }}
   */
  function extractTrailingControlMarkers(text) {
    let raw = (text || '').trimEnd();
    // Supported image aspect-ratio markers (case-insensitive).
    const SUPPORTED_RATIOS = [
      'Auto',
      '1:1', '9:16', '16:9',
      '3:4', '4:3',
      '3:2', '2:3',
      '5:4', '4:5',
      '21:9'
    ];

    let aspectRatio = null;

    while (true) {
      const match = raw.match(/\[([^\]]+)\]\s*$/i);
      if (!match) break;

      const token = match[1].trim();
      const lower = token.toLowerCase();
      const found = SUPPORTED_RATIOS.find((r) => r.toLowerCase() === lower);
      if (!found || aspectRatio != null) {
        // Unknown or duplicate marker: stop to avoid trimming normal content.
        break;
      }

      aspectRatio = found;
      raw = raw.slice(0, match.index).trimEnd();
    }

    return {
      baseText: raw,
      aspectRatio: aspectRatio || null
    };
  }

  /**
   * 为“排队中的待发送消息”冻结最小必要快照。
   *
   * 为什么这里只冻结输入区与轻量页面来源快照，而不冻结整段会话历史：
   * - 用户要求队列按 FIFO 串行发送，后一条应在前一条回复完成后再基于“最新会话状态”发出；
   * - 因此会话历史必须在真正执行时再读取，才能拿到前一条 AI 回复；
   * - 但输入区文本/图片若不提前冻结，就会在用户继续编辑时被覆盖，甚至误清掉当前草稿。
   */
  async function buildQueuedSendOptions(baseOptions, snapshot = {}) {
    const normalizedBaseOptions = (baseOptions && typeof baseOptions === 'object') ? baseOptions : {};
    const normalizedSnapshot = (snapshot && typeof snapshot === 'object') ? snapshot : {};
    const activeConversationApiInfo = (typeof chatHistoryUI?.resolveActiveConversationApiConfig === 'function')
      ? chatHistoryUI.resolveActiveConversationApiConfig()
      : null;
    const queueResolvedApiConfig = cloneDataSafely(
      normalizedBaseOptions.resolvedApiConfig
      || resolveApiParamForSend(normalizedBaseOptions.api)
      || activeConversationApiInfo?.lockConfig
      || apiManager.getSelectedConfig()
      || null
    );
    const queueConversationApiLockSnapshot = cloneDataSafely(
      chatHistoryUI?.getActiveConversationApiLock?.() || null
    );
    const queueConversationId = normalizeConversationId(currentConversationId)
      || normalizeConversationId(chatHistoryUI?.getCurrentConversationId?.());
    const queuedOptions = {
      ...normalizedBaseOptions,
      originalMessageText: typeof normalizedSnapshot.baseText === 'string'
        ? normalizedSnapshot.baseText
        : (normalizedBaseOptions.originalMessageText ?? ''),
      inputImagesHtmlSnapshot: typeof normalizedSnapshot.imagesHtml === 'string'
        ? normalizedSnapshot.imagesHtml
        : '',
      inputHasImagesSnapshot: !!normalizedSnapshot.hasImages,
      inputHasScreenshotSnapshot: !!normalizedSnapshot.hasScreenshot,
      __skipClearInputs: true,
      resolvedApiConfig: queueResolvedApiConfig || normalizedBaseOptions.resolvedApiConfig || null,
      conversationApiLockSnapshot: queueConversationApiLockSnapshot,
      conversationIdOverride: queueConversationId || normalizedBaseOptions.conversationIdOverride || ''
    };

    if (!queuedOptions.pageContentSnapshot && !isTemporaryMode) {
      queuedOptions.pageContentSnapshot = buildCurrentPageMetaSnapshot();
    }

    return queuedOptions;
  }

  /**
   * 基于当前输入区快照，构建一条“用户追加发送任务”。
   *
   * 这个 helper 的职责是把“发送前冻结输入区快照 + 组装 job 元数据”放到一起，
   * 避免普通 Enter 发送、Ctrl+Enter steer 等路径各自复制一套冻结逻辑。
   *
   * @param {Object} baseOptions
   * @param {{
   *   baseText?: string,
   *   conversationId?: string,
   *   imagesHtmlSnapshot?: string,
   *   hasImagesInInput?: boolean,
   *   hasScreenshotSnapshot?: boolean
   * }} [snapshot]
   * @returns {Promise<Object>}
   */
  async function buildAppendConversationJob(baseOptions, snapshot = {}) {
    const normalizedSnapshot = (snapshot && typeof snapshot === 'object') ? snapshot : {};
    const conversationId = normalizeConversationId(normalizedSnapshot.conversationId)
      || normalizeConversationId(currentConversationId)
      || normalizeConversationId(chatHistoryUI?.getCurrentConversationId?.());
    const imagesHtmlSnapshot = (typeof normalizedSnapshot.imagesHtmlSnapshot === 'string')
      ? normalizedSnapshot.imagesHtmlSnapshot
      : (inputController ? inputController.getImagesHTML() : imageContainer.innerHTML);
    const hasImagesInInput = (typeof normalizedSnapshot.hasImagesInInput === 'boolean')
      ? normalizedSnapshot.hasImagesInInput
      : (inputController ? inputController.hasImages() : !!imageContainer.querySelector('.image-tag'));
    const hasScreenshotSnapshot = (typeof normalizedSnapshot.hasScreenshotSnapshot === 'boolean')
      ? normalizedSnapshot.hasScreenshotSnapshot
      : (inputController
        ? inputController.hasScreenshot()
        : !!imageContainer.querySelector('img[alt="page-screenshot.png"]'));
    const queuedOptions = await buildQueuedSendOptions(baseOptions, {
      baseText: typeof normalizedSnapshot.baseText === 'string'
        ? normalizedSnapshot.baseText
        : (baseOptions?.originalMessageText ?? ''),
      imagesHtml: imagesHtmlSnapshot,
      hasImages: hasImagesInInput,
      hasScreenshot: hasScreenshotSnapshot
    });

    return normalizeConversationQueuedTask({
      kind: 'append_user_message',
      status: 'queued',
      paused: false,
      conversationId,
      conversationRevisionAtEnqueue: resolveConversationHistoryRevision(conversationId),
      anchorMessageId: '',
      targetAiMessageId: '',
      payload: queuedOptions,
      retryPolicy: buildDefaultConversationJobRetryPolicy('append_user_message')
    });
  }

  /**
   * 构建“标准 steer”的待提交输入。
   *
   * 注意这里不是 future turn 的 queue job：
   * - 它不会进入普通 FIFO 队列；
   * - 它只会挂到当前 active turn 的 pending steers 上；
   * - 在下一个安全边界（当前 hop 完成 / tool 结果边界）时，作为同一个 turn 内的新 user input 被吸收。
   */
  async function buildPendingConversationSteer(baseOptions, snapshot = {}) {
    const normalizedSnapshot = (snapshot && typeof snapshot === 'object') ? snapshot : {};
    const imagesHtmlSnapshot = (typeof normalizedSnapshot.imagesHtmlSnapshot === 'string')
      ? normalizedSnapshot.imagesHtmlSnapshot
      : (inputController ? inputController.getImagesHTML() : imageContainer.innerHTML);
    const hasImagesInInput = (typeof normalizedSnapshot.hasImagesInInput === 'boolean')
      ? normalizedSnapshot.hasImagesInInput
      : (inputController ? inputController.hasImages() : !!imageContainer.querySelector('.image-tag'));
    const hasScreenshotSnapshot = (typeof normalizedSnapshot.hasScreenshotSnapshot === 'boolean')
      ? normalizedSnapshot.hasScreenshotSnapshot
      : (inputController
        ? inputController.hasScreenshot()
        : !!imageContainer.querySelector('img[alt="page-screenshot.png"]'));
    const payload = await buildQueuedSendOptions(baseOptions, {
      baseText: typeof normalizedSnapshot.baseText === 'string'
        ? normalizedSnapshot.baseText
        : (baseOptions?.originalMessageText ?? ''),
      imagesHtml: imagesHtmlSnapshot,
      hasImages: hasImagesInInput,
      hasScreenshot: hasScreenshotSnapshot
    });
    const responseInputItem = buildResponsesUserMessageInputItemFromPayload(payload);
    if (!responseInputItem) return null;

    const rawText = (typeof payload.originalMessageText === 'string')
      ? payload.originalMessageText
      : '';
    const previewText = rawText.trim();
    const imageCount = extractQueuedPreviewImages(payload.inputImagesHtmlSnapshot || '').length;

    return normalizePendingConversationSteer({
      id: createPendingConversationSteerId(),
      createdAt: Date.now(),
      payload,
      responseInputItem,
      rawText,
      textPreview: previewText || (imageCount > 0 ? '（转向中的图片消息）' : '（转向中的消息）'),
      imageCount,
      hasScreenshot: payload.inputHasScreenshotSnapshot === true
    });
  }

  /**
   * Public send entry:
   * - Handles slash commands and trailing control markers.
   *
   * @public
   * @param {Object} [options] - See sendMessageCore params.
   * @returns {Promise<any>}
   */
  async function sendMessage(options = {}) {
    const opts = options || {};
    const submissionBehavior = opts.__submissionBehavior === 'steer' ? 'steer' : 'default';

    // Resolve source text with the following precedence:
    // 1) regenerate target node data-original-text;
    // 2) regenerate target node content from chat history;
    // 3) options.originalMessageText;
    // 4) current input text.
    let rawText = '';

    if (opts.regenerateMode && opts.messageId) {
      try {
        const safeMessageId = escapeMessageIdForSelector(opts.messageId);
        const selector = safeMessageId ? `.message[data-message-id="${safeMessageId}"]` : '';
        const targetEl = selector ? chatContainer.querySelector(selector) : null;
        const fromDom = targetEl?.getAttribute('data-original-text');
        if (typeof fromDom === 'string' && fromDom.length > 0) {
          rawText = fromDom;
        } else if (chatHistoryManager?.chatHistory?.messages) {
          const node = chatHistoryManager.chatHistory.messages.find(m => m.id === opts.messageId);
          if (node && typeof node.content === 'string') {
            rawText = node.content;
          }
        }
      } catch (e) {
        console.warn('从当前消息节点读取 originalMessageText 失败:', e);
      }
    }

    if (!rawText) {
      if (opts.originalMessageText !== null && opts.originalMessageText !== undefined) {
        rawText = String(opts.originalMessageText);
      } else {
        try {
          rawText = inputController ? inputController.getInputText() : (messageInput.textContent || '');
        } catch (e) {
          console.warn('读取输入框文本失败:', e);
          rawText = '';
        }
      }
    }

    const hasImagesInInput = inputController
      ? inputController.hasImages()
      : !!imageContainer.querySelector('.image-tag');

    // Slash commands are only handled for normal sends.
    const hasExplicitOriginalText = opts.originalMessageText !== null && opts.originalMessageText !== undefined;
    const shouldCheckSlashCommand = !opts.regenerateMode
      && !opts.forceSendFullHistory
      && !hasExplicitOriginalText
      && opts.__skipSlashCommand !== true;

    if (shouldCheckSlashCommand) {
      const slashResult = await runSlashCommandIfMatched(rawText, { hasImages: hasImagesInInput });
      if (typeof slashResult?.overrideText === 'string') {
        rawText = slashResult.overrideText;
      }
      if (slashResult?.handled) {
        if (!slashResult.keepInput) {
          clearInputs();
          inputController?.focusToEnd?.();
        }
        return { ok: true, type: 'slash_command' };
      }
    }

    const markerInfo = extractTrailingControlMarkers(rawText);
    const baseText = markerInfo.baseText;
    const aspectRatio = markerInfo.aspectRatio;

    const singleOpts = { ...opts };
    if (baseText !== rawText) {
      singleOpts.originalMessageText = baseText;
    }
    if (aspectRatio) {
      singleOpts.aspectRatioOverride = aspectRatio;
    }

    const queueSetting = settingsManager?.getSetting?.('queueCurrentConversationMessages');
    if (typeof queueSetting === 'boolean') {
      queueCurrentConversationMessages = queueSetting;
    }

    const currentConversationQueueKey = getCurrentActiveConversationQueueKey();
    const currentConversationIdForSend = normalizeConversationId(currentConversationId)
      || normalizeConversationId(chatHistoryUI?.getCurrentConversationId?.());
    const hasPendingWorkInCurrentConversation = hasPendingWorkForConversationQueue(currentConversationQueueKey);
    const hasRunningAttemptInCurrentConversation = hasRunningAttemptForConversationQueue(currentConversationQueueKey);
    const hasQueuedMessagesInCurrentConversation = hasQueuedMessagesForConversation(currentConversationQueueKey);
    const canQueueOrInterrupt = !!(
      singleOpts.regenerateMode
      || singleOpts.forceSendFullHistory
      || baseText
      || hasImagesInInput
    );
    const requestedSteer = submissionBehavior === 'steer';
    const targetSteerAttempt = requestedSteer
      ? getLatestRunningAttemptForCurrentConversationUi()
      : null;
    const shouldSendAsSteer = requestedSteer && !!targetSteerAttempt;

    if (singleOpts.regenerateMode) {
      return requestRegenerateMessage({
        originalMessageText: singleOpts.originalMessageText ?? baseText,
        messageId: singleOpts.messageId,
        targetAiMessageId: singleOpts.targetAiMessageId || null,
        api: singleOpts.api ?? null,
        resolvedApiConfig: singleOpts.resolvedApiConfig ?? null,
        specificPromptType: singleOpts.specificPromptType ?? null,
        promptMeta: singleOpts.promptMeta ?? null,
        conversationId: currentConversationIdForSend
      });
    }

    if (requestedSteer && !targetSteerAttempt) {
      showNotification?.({ message: '当前没有可转向的生成', type: 'warning', duration: 1800 });
      return { ok: false, reason: 'no_active_turn' };
    }

    if (requestedSteer && !canQueueOrInterrupt) {
      showNotification?.({ message: '没有可用于转向的内容', type: 'warning', duration: 1800 });
      return { ok: false, reason: 'empty_steer' };
    }

    if (!requestedSteer && (hasPendingWorkInCurrentConversation || hasQueuedMessagesInCurrentConversation) && canQueueOrInterrupt) {
      const shouldEnqueue = hasQueuedMessagesInCurrentConversation || queueCurrentConversationMessages;

      if (!shouldEnqueue) {
        abortRequestsForConversationQueue(currentConversationQueueKey, { suppressQueueFlush: true });
        await waitForConversationQueueIdle(currentConversationQueueKey);
      }
    }

    const imagesHtmlSnapshot = inputController ? inputController.getImagesHTML() : imageContainer.innerHTML;
    const hasScreenshotSnapshot = inputController
      ? inputController.hasScreenshot()
      : !!imageContainer.querySelector('img[alt="page-screenshot.png"]');

    if (shouldSendAsSteer) {
      const pendingSteer = await buildPendingConversationSteer(singleOpts, {
        baseText,
        imagesHtmlSnapshot,
        hasImagesInInput,
        hasScreenshotSnapshot
      });
      if (!pendingSteer) {
        showNotification?.({ message: '当前输入无法构造成标准 steer', type: 'warning', duration: 1800 });
        return { ok: false, reason: 'invalid_pending_steer' };
      }
      const result = await requestConversationSteer({
        queueKey: currentConversationQueueKey,
        pendingSteer,
        targetAttempt: targetSteerAttempt
      });
      if (result?.ok && typeof showNotification === 'function') {
        clearInputs();
        inputController?.focusToEnd?.();
        showNotification({
          message: `已加入当前生成的转向输入（待提交 ${result.pendingCount || 1} 条）`,
          type: 'info',
          duration: 2200
        });
      } else if (result?.error && typeof showNotification === 'function') {
        showNotification({
          message: `转向失败：${result.error.message || '未知错误'}`,
          type: 'warning',
          duration: 2200
        });
      }
      return result;
    }

    const nextJob = await buildAppendConversationJob(singleOpts, {
      baseText,
      conversationId: currentConversationIdForSend,
      imagesHtmlSnapshot,
      hasImagesInInput,
      hasScreenshotSnapshot
    });

    clearInputs();
    inputController?.focusToEnd?.();

    const shouldForceQueue = hasPendingWorkInCurrentConversation || hasQueuedMessagesInCurrentConversation;
    const result = await dispatchConversationJob(currentConversationQueueKey, nextJob, {
      forceQueue: shouldForceQueue
    });
    if (result?.queued && typeof showNotification === 'function') {
      const queueLength = getConversationSendQueue(currentConversationQueueKey)
        .filter((task) => !isConversationJobTerminal(task)).length;
      const waitingCount = Math.max(0, queueLength - 1);
      showNotification({
        message: waitingCount > 0
          ? `已加入发送队列，前方还有 ${waitingCount} 条`
          : '已加入发送队列，当前回复完成后自动发送',
        type: 'info',
        duration: 1800
      });
    }
    return result;
  }

  function sendSteerMessage(options = {}) {
    return sendMessage({
      ...(options && typeof options === 'object' ? options : {}),
      __submissionBehavior: 'steer'
    });
  }

  // Message composition itself is delegated to composeMessages in message_composer.js.

  /**
   * 统一封装 AI 响应 UI 副作用：
   * - API 元信息落库 + footer 渲染；
   * - loading 占位升级为 AI 消息；
   * - 线程/主会话容器解析。
   *
   * 说明：
   * - 该函数刻意聚合副作用，便于流式/非流式共用同一套行为；
   * - 纯状态决策（何时触发哪些副作用）由 response_flow_state.js 负责。
   */
  function createResponseUiBindings({ threadContext, attemptState, loadingMessage, usedApiConfig }) {
    const getUiContainer = () => {
      // 线程场景优先线程容器，普通会话回退到主聊天容器，确保滚动/锚点逻辑统一。
      if (threadContext) return resolveThreadUiContainer(threadContext);
      if (!isAttemptMainConversationActive(attemptState)) return null;
      return chatContainer;
    };

    function applyApiMetaToMessage(messageId, apiConfig, messageDiv) {
      try {
        if (!messageId) return;
        // 先写历史节点，后续无论 DOM 是否可见（线程折叠/虚拟列表）都能保留元信息。
        const node = resolveAttemptAiNode(attemptState, messageId);
        if (node) {
          node.apiUuid = apiConfig?.id || null;
          node.apiDisplayName = apiConfig?.displayName || '';
          node.apiModelId = apiConfig?.modelName || '';
        }
        const safeMessageId = escapeMessageIdForSelector(messageId);
        const selector = safeMessageId ? `.message[data-message-id="${safeMessageId}"]` : '';
        const fallbackEl = selector
          ? (chatContainer.querySelector(selector)
            || (threadContext?.container ? threadContext.container.querySelector(selector) : null))
          : null;
        syncAttemptAssistantView(messageId, {
          attemptState,
          node,
          fallbackElement: messageDiv || fallbackEl || null
        });
      } catch (e) {
        console.warn('记录/渲染API信息失败:', e);
      }
    }

    function applyUsageMetaToMessage(messageId, rawUsage, messageDiv) {
      try {
        if (!messageId) return;
        const usageMeta = normalizeApiUsageMeta(rawUsage);
        if (!usageMeta) return;
        const node = resolveAttemptAiNode(attemptState, messageId);
        if (node) {
          node.apiUsage = usageMeta;
        }
        const safeMessageId = escapeMessageIdForSelector(messageId);
        const selector = safeMessageId ? `.message[data-message-id="${safeMessageId}"]` : '';
        const fallbackEl = selector
          ? (chatContainer.querySelector(selector)
            || (threadContext?.container ? threadContext.container.querySelector(selector) : null))
          : null;
        syncAttemptAssistantView(messageId, {
          attemptState,
          node,
          fallbackElement: messageDiv || fallbackEl || null
        });
      } catch (e) {
        console.warn('记录/渲染API用量失败:', e);
      }
    }

    function applyTimingMetaToMessage(messageId, rawTiming, messageDiv) {
      try {
        if (!messageId) return;
        const timingMeta = normalizeApiTimingMeta(rawTiming);
        if (!timingMeta) return;
        const node = resolveAttemptAiNode(attemptState, messageId);
        if (node) {
          node.responseTiming = timingMeta;
        }
        const safeMessageId = escapeMessageIdForSelector(messageId);
        const selector = safeMessageId ? `.message[data-message-id="${safeMessageId}"]` : '';
        const fallbackEl = selector
          ? (chatContainer.querySelector(selector)
            || (threadContext?.container ? threadContext.container.querySelector(selector) : null))
          : null;
        syncAttemptAssistantView(messageId, {
          attemptState,
          node,
          fallbackElement: messageDiv || fallbackEl || null
        });
      } catch (e) {
        console.warn('记录/渲染响应时序失败:', e);
      }
    }

    function buildAttemptTimingMeta(overrides = {}) {
      const overrideObject = (overrides && typeof overrides === 'object') ? overrides : {};
      const startedAtMs = Number.isFinite(Number(overrideObject.startedAtMs))
        ? Number(overrideObject.startedAtMs)
        : (Number.isFinite(Number(attemptState?.startedAt)) ? Number(attemptState.startedAt) : null);
      const firstVisibleOutputAtMs = normalizeOptionalTimestamp(overrideObject.firstVisibleOutputAtMs)
        ?? normalizeOptionalTimestamp(attemptState?.firstVisibleOutputAtMs);
      const completedAtMs = Number.isFinite(Number(overrideObject.completedAtMs))
        ? Number(overrideObject.completedAtMs)
        : null;
      const generationDurationMs = (startedAtMs != null && completedAtMs != null)
        ? Math.max(0, completedAtMs - startedAtMs)
        : null;
      const outputDurationMs = (firstVisibleOutputAtMs != null && completedAtMs != null && completedAtMs >= firstVisibleOutputAtMs)
        ? Math.max(0, completedAtMs - firstVisibleOutputAtMs)
        : null;
      const fallbackThinkingDurationMs = Number.isFinite(Number(overrideObject.thinkingDurationMs))
        ? Number(overrideObject.thinkingDurationMs)
        : null;
      const thinkingDurationMs = (startedAtMs != null && firstVisibleOutputAtMs != null && firstVisibleOutputAtMs >= startedAtMs)
        ? Math.max(0, firstVisibleOutputAtMs - startedAtMs)
        : fallbackThinkingDurationMs;
      return {
        startedAtMs,
        firstVisibleOutputAtMs,
        completedAtMs,
        generationDurationMs,
        thinkingDurationMs,
        outputDurationMs
      };
    }

    function resetAssistantResponseMetaForAttempt(messageId, messageDiv) {
      try {
        if (!messageId) return;
        const startedAtMs = Number.isFinite(Number(attemptState?.startedAt))
          ? Number(attemptState.startedAt)
          : Date.now();
        const node = resolveAttemptAiNode(attemptState, messageId);
        if (node) {
          node.timestamp = startedAtMs;
          node.apiUsage = null;
          node.responseTiming = buildAttemptTimingMeta({ startedAtMs });
          delete node.response_activity_duration_ms;
        }
        applyTimingMetaToMessage(messageId, { startedAtMs }, messageDiv);
      } catch (e) {
        console.warn('重置响应时序元信息失败:', e);
      }
    }

    function promoteLoadingMessageToAi({ answer, thoughts }) {
      if (!loadingMessage || !loadingMessage.parentNode) return null;
      const shouldRenderDom = !!getUiContainer();
      // 线程 UI 不可见时，不做 DOM 升级，交由“仅历史节点”分支处理，避免无意义渲染。
      if (!shouldRenderDom) return null;
      const threadHistoryPatch = buildThreadHistoryPatch(threadContext);
      const historyParentId = resolveHistoryParentIdForAi(threadContext, attemptState);
      const preserveCurrentNode = !!threadContext;
      let node = null;
      const addWithOptions = typeof chatHistoryManager.addMessageToTreeWithOptions === 'function'
        && (preserveCurrentNode || historyParentId !== chatHistoryManager.chatHistory.currentNode);
      if (addWithOptions) {
        node = chatHistoryManager.addMessageToTreeWithOptions(
          'assistant',
          '',
          historyParentId,
          { preserveCurrentNode }
        );
      } else {
        node = chatHistoryManager.addMessageToTree('assistant', '', historyParentId);
      }
      if (!node) return null;
      if (threadHistoryPatch && typeof threadHistoryPatch === 'object') {
        // 把线程关联字段一次性打到新节点，保持树结构与 UI 渲染来源一致。
        Object.assign(node, threadHistoryPatch);
      }
      if (Number.isFinite(Number(attemptState?.startedAt))) {
        node.timestamp = Number(attemptState.startedAt);
      }
      bindAttemptAiMessage(attemptState, node.id, node);
      loadingMessage.setAttribute('data-message-id', node.id);
      loadingMessage.classList.remove('loading-message');
      try { loadingMessage.classList.add('ai-message'); } catch (_) {}
      loadingMessage.textContent = '';
      loadingMessage.removeAttribute('title');
      syncAttemptAssistantView(node.id, {
        attemptState,
        node,
        fallbackElement: loadingMessage,
        content: answer || '',
        thoughtsRaw: thoughts || '',
        suppressMissingNodeWarning: true
      });
      resetAssistantResponseMetaForAttempt(node.id, loadingMessage);
      applyApiMetaToMessage(node.id, usedApiConfig, loadingMessage);
      updateThreadLastMessage(threadContext, node.id);
      return node.id;
    }

    return {
      getUiContainer,
      applyApiMetaToMessage,
      applyUsageMetaToMessage,
      applyTimingMetaToMessage,
      buildAttemptTimingMeta,
      resetAssistantResponseMetaForAttempt,
      promoteLoadingMessageToAi
    };
  }

  /**
   * Handle streaming response (SSE).
   * @param {Response} response
   * @param {HTMLElement} loadingMessage
   * @param {Object} usedApiConfig
   * @param {Object} attemptState
   * @returns {Promise<{answer:string, responseId:string|null, responseOutputItems:Array<Object>|null, responseInputItems:Array<Object>|null, responseActivityTimeline:Array<Object>|null, responseToolCalls:Array<Object>|null, assistantPhase:string|null, isResponsesApi:boolean}>}
   */
  async function handleStreamResponse(response, loadingMessage, usedApiConfig, attemptState) {
    captureAttemptConversationContext(attemptState);
    const resolveLoadingStatusTarget = () => resolveLiveLoadingStatusElement(loadingMessage, attemptState);
    const canStillUpdateLoadingStatus = () => normalizeOptionalTimestamp(attemptState?.firstVisibleOutputAtMs) == null;
    // 流式场景：此时已拿到响应头，但正文 token 尚未到达。
    // 在首个 token 到达前维持占位消息，并展示“等待首 token”的细粒度状态。
    {
      const streamStartTarget = resolveLoadingStatusTarget() || loadingMessage || null;
      if (streamStartTarget && normalizeOptionalTimestamp(attemptState?.firstVisibleOutputAtMs) == null) {
        syncAttemptPreResponseStatusFromLocalStage(
          streamStartTarget,
          attemptState,
          'stream_wait_first_token',
          { apiBase: usedApiConfig?.baseUrl || '', modelName: usedApiConfig?.modelName || '' }
        );
      }
    }

    const threadContext = attemptState?.threadContext || null;
    const {
      getUiContainer,
      applyApiMetaToMessage,
      applyUsageMetaToMessage,
      applyTimingMetaToMessage,
      buildAttemptTimingMeta,
      resetAssistantResponseMetaForAttempt,
      promoteLoadingMessageToAi
    } = createResponseUiBindings({
      threadContext,
      attemptState,
      loadingMessage,
      usedApiConfig
    });
    const streamRenderState = {
      hasStartedResponse: false,
      hasEverShownAnswerContent: false
    };

    // 将接口错误对象压缩为可读文本，确保“控制台有信息”时聊天框也能看到关键信息。
    function toDisplayableErrorText(raw, maxLen = 500) {
      if (raw == null) return '';
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!trimmed) return '';
        return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}...` : trimmed;
      }
      try {
        const serialized = JSON.stringify(raw);
        if (!serialized) return '';
        return serialized.length > maxLen ? `${serialized.slice(0, maxLen)}...` : serialized;
      } catch (_) {
        const text = String(raw || '').trim();
        if (!text) return '';
        return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
      }
    }

    // 统一构造“可展示给用户”的错误文案，避免仅在控制台可见而聊天框无感知。
    function buildStreamApiErrorMessage(errorPayload, fallback = 'Unknown API error') {
      if (!errorPayload) return fallback;
      if (typeof errorPayload === 'string') {
        const text = errorPayload.trim();
        return text || fallback;
      }

      const messageText = toDisplayableErrorText(
        errorPayload?.message || errorPayload?.error?.message || '',
        600
      );
      const code = errorPayload?.code ?? errorPayload?.error?.code;
      const status = errorPayload?.status ?? errorPayload?.error?.status;
      const type = errorPayload?.type ?? errorPayload?.error?.type;
      const metaParts = [];
      if (code !== undefined && code !== null && String(code).trim() !== '') metaParts.push(`code=${code}`);
      if (status !== undefined && status !== null && String(status).trim() !== '') metaParts.push(`status=${status}`);
      if (type !== undefined && type !== null && String(type).trim() !== '') metaParts.push(`type=${type}`);

      const detail = messageText || toDisplayableErrorText(errorPayload, 600) || fallback;
      if (metaParts.length === 0) return detail;
      return `${detail} (${metaParts.join(', ')})`;
    }

    const reader = response.body.getReader();
    // 累积 AI 的主回答文本（仅文本部分，包含代码块、内联图片等 Markdown/HTML 内容）
    let aiResponse = '';
    // 累积当前流中的思考过程文本（Gemini / OpenAI reasoning）
    let aiThoughtsRaw = '';
    // 每次流式请求开始时重置思考块状态
    isInStreamingThoughtBlock = false;
    // 标记是否为 Gemini 流式接口
    const isGeminiApi = isGeminiApiResponse(response, usedApiConfig);
    const isOpenAIResponsesStream = !isGeminiApi && isOpenAIResponsesApiResponse(response, usedApiConfig);
    // SSE 行缓冲
    let incomingDataBuffer = ''; 
    const decoder = new TextDecoder();
    let currentEventDataLines = []; // 当前事件中的所有 data: 行内容
	    // 记录当前流式响应中最新的 Gemini 思维链签名（Thought Signature）
	    let latestGeminiThoughtSignature = null;

	    // OpenAI 兼容：记录当前流式响应中最新的推理签名（thoughtSignature）。
	    //
	    // 背景：
	    // - 某些 OpenAI 兼容服务会在 SSE chunk 的 `choices[0].delta` 上透传 `thoughtSignature`；
	    // - 该签名用于校验/回传 `reasoning_content`（以及 tool_calls 片段），否则上游可能报 “signature required”；
	    //
	    // 约定：
	    // - `delta.thoughtSignature`：对应 `delta.reasoning_content`（或 `delta.reasoning`）的签名；
	    // - `delta.tool_calls[i].thoughtSignature`：对应工具调用片段的签名；
	    //
	    // 注意：签名必须“原样保存、原样回传”，不要做 trim/格式化。
	    let latestOpenAIThoughtSignature = null;
	    // OpenAI 兼容：累积原始 reasoning_content（用于与 thoughtSignature 配对回传）
	    let latestOpenAIReasoningContent = '';
	    // OpenAI 兼容：累积 tool_calls（流式增量会把 function.arguments 分片输出）
	    let latestOpenAIToolCalls = [];
      // Responses API：按事件顺序保存 reasoning summary / 工具调用的活动时间线。
      const previousResponsesActivityTimeline = Array.isArray(attemptState?.responsesToolLoopAccumulatedTimeline)
        ? cloneResponsesActivityTimeline(attemptState.responsesToolLoopAccumulatedTimeline)
        : [];
      const previousResponsesInputItems = Array.isArray(attemptState?.responsesToolLoopAccumulatedInputItems)
        ? cloneResponsesReplayOutputItems(attemptState.responsesToolLoopAccumulatedInputItems)
        : [];
      let latestResponsesActivityTimeline = cloneResponsesActivityTimeline(previousResponsesActivityTimeline);
      let latestResponsesAssistantPhase = attemptState?.responsesToolLoopAssistantPhase || null;
      let latestResponsesResponseId = attemptState?.responsesToolLoopLastResponseId || null;
      let latestResponsesInputItems = cloneResponsesReplayOutputItems(previousResponsesInputItems);
      let latestResponsesOutputItems = [];
      const latestResponsesOutputItemPhaseById = new Map();
      // Responses API：记录“正文可见文本”的分片状态，避免 delta/done/full item 多次到来时重复拼接。
      const latestResponsesOutputTextState = new Map();
      // OpenAI 兼容：记录末尾 usage 分片（通常出现在 finish_reason=stop 的最后一个 chunk）。
      let latestOpenAIUsage = null;
		    // 当前流对应的 AI 消息 ID：
		    // - 普通发送：首个 token 到达时新建消息并赋值；
		    // - “原地替换”重新生成：sendMessageCore 会预先把 attempt.aiMessageId 设为目标消息ID，这里直接复用。
		    let currentAiMessageId = attemptState?.aiMessageId || null;
        if (currentAiMessageId && !attemptState?.aiMessageNode) {
          attemptState.aiMessageNode = resolveAttemptAiNode(attemptState, currentAiMessageId);
        }
		    // 重新生成（原地替换）：只在“首次写回”时清一次，避免后续 token 更新中重复清空
		    let hasClearedBoundSignatureForRegenerate = false;

	    // 自适应 UI 更新节流器：将多个 token 的高频更新合并为较低频的 DOM 刷新，缓解长消息渲染导致的卡顿。
	    // 说明：这里不改 messageProcessor.updateAIMessage 的“全量重渲染”策略，而是通过“掉帧合并”降低调用频率。
    const uiUpdateThrottler = createAdaptiveUpdateThrottler({
	      run: (payload) => {
	        if (!payload || !payload.messageId) return;
          const boundNode = resolveAttemptAiNode(attemptState, payload.messageId);
          if (boundNode) {
            attemptState.aiMessageNode = boundNode;
            if (Array.isArray(payload.responsesActivityTimeline) || Array.isArray(payload.responsesInputItems)) {
              applyResponsesMetadataToNode(boundNode, {
                timeline: payload.responsesActivityTimeline,
                phase: latestResponsesAssistantPhase,
                inputItems: payload.responsesInputItems
              });
              syncAttemptResponsesRuntimeState(attemptState, {
                timeline: payload.responsesActivityTimeline,
                inputItems: payload.responsesInputItems,
                assistantPhase: latestResponsesAssistantPhase,
                responseId: latestResponsesResponseId || null
              });
            }
          }
	        const regenContainer = getUiContainer();
	        const anchor = regenContainer
	          ? captureReadingAnchorForRegenerate(regenContainer, payload.messageId, attemptState)
	          : null;
	        try {
          syncAttemptAssistantView(payload.messageId, {
            attemptState,
            node: boundNode || attemptState?.aiMessageNode || null,
            content: payload.answer || '',
            thoughtsRaw: payload.thoughts ?? null,
            suppressMissingNodeWarning: true
          });
          void persistAttemptConversationSnapshot(attemptState);
	        } finally {
	          if (regenContainer) {
	            restoreReadingAnchor(regenContainer, anchor);
	          }
	        }
	      },
	      shouldCancel: () => {
	        try { return !!(attemptState?.controller?.signal?.aborted || attemptState?.finished); } catch (_) { return false; }
	      },
	      getContentSize: (payload) => {
	        const answerSize = (typeof payload?.answer === 'string') ? payload.answer.length : 0;
	        const thoughtsSize = (typeof payload?.thoughts === 'string') ? payload.thoughts.length : 0;
            const timelineSize = Array.isArray(payload?.responsesActivityTimeline)
              ? payload.responsesActivityTimeline.reduce((sum, entry) => {
                if (!entry || typeof entry !== 'object') return sum;
                const textSize = (typeof entry.text === 'string') ? entry.text.length : 0;
                const argsSize = (typeof entry.arguments === 'string') ? entry.arguments.length : 0;
                return sum + textSize + argsSize;
              }, 0)
              : 0;
	        return answerSize + thoughtsSize + timelineSize;
	      }
	    });
	    if (attemptState) {
	      attemptState.uiUpdateThrottler = uiUpdateThrottler;
	    }

    function updateLoadingStatusFromResponsesSseEvent(eventType, data) {
      if (!isOpenAIResponsesStream || !canStillUpdateLoadingStatus()) return;
      const nextStatus = deriveAssistantPreResponseStatusFromResponsesSse(eventType, data);
      if (!nextStatus) return;
      syncAttemptLoadingStatus(
        resolveLoadingStatusTarget() || loadingMessage || null,
        attemptState,
        nextStatus.text,
        {
          stage: nextStatus.stage,
          note: nextStatus.note || '',
          showSpinner: nextStatus.showSpinner,
          apiBase: usedApiConfig?.baseUrl || '',
          modelName: usedApiConfig?.modelName || ''
        }
      );
    }

    function syncResponsesActivityPreviewToLoadingMessage() {
      if (!isOpenAIResponsesStream || currentAiMessageId) return;
      const previewTarget = resolveLoadingStatusTarget() || loadingMessage || null;
      if (!previewTarget || typeof messageProcessor?.syncAssistantMessageMetadata !== 'function') return;
      if (!Array.isArray(latestResponsesActivityTimeline) || latestResponsesActivityTimeline.length <= 0) return;

      clearAttemptPreResponseStatus(attemptState, previewTarget);

      try {
        messageProcessor.syncAssistantMessageMetadata(
          null,
          {
            role: 'assistant',
            timestamp: Number.isFinite(Number(attemptState?.startedAt))
              ? Number(attemptState.startedAt)
              : Date.now(),
            response_activity_timeline: cloneResponsesActivityTimeline(latestResponsesActivityTimeline)
          },
          {
            fallbackElement: previewTarget,
            runtimeSnapshot: getAttemptRuntimeSnapshot(attemptState) || null
          }
        );
      } catch (error) {
        console.warn('预渲染 Responses 思考活动到 loadingMessage 失败:', error);
      }
    }

    /**
     * 首帧落地副作用：
     * - 优先原地替换；
     * - 其次复用 loading 占位；
     * - 最后回退为创建新消息。
     */
    const applyFirstChunkRenderSideEffects = () => {
      try { GetInputContainer().classList.add('auto-scroll-glow-active'); } catch (_) {}

      if (currentAiMessageId) {
        // 原地替换：首帧直接更新到既有 AI 消息上（不创建新节点）
        const boundNode = resolveAttemptAiNode(attemptState, currentAiMessageId);
        if (boundNode) {
          attemptState.aiMessageNode = boundNode;
          if (isOpenAIResponsesStream) {
            applyResponsesMetadataToNode(boundNode, {
              timeline: latestResponsesActivityTimeline,
              phase: latestResponsesAssistantPhase,
              inputItems: latestResponsesInputItems
            });
            syncAttemptResponsesRuntimeState(attemptState, {
              timeline: latestResponsesActivityTimeline,
              inputItems: latestResponsesInputItems,
              assistantPhase: latestResponsesAssistantPhase,
              responseId: latestResponsesResponseId || null
            });
          }
        }
        const regenContainer = getUiContainer();
        const anchor = regenContainer
          ? captureReadingAnchorForRegenerate(regenContainer, currentAiMessageId, attemptState)
          : null;
        try {
          syncAttemptAssistantView(currentAiMessageId, {
            attemptState,
            node: boundNode || attemptState?.aiMessageNode || null,
            content: aiResponse,
            thoughtsRaw: isOpenAIResponsesStream ? null : aiThoughtsRaw,
            suppressMissingNodeWarning: true
          });
          if (!hasClearedBoundSignatureForRegenerate) {
            hasClearedBoundSignatureForRegenerate = clearBoundSignatureForRegenerate(currentAiMessageId, attemptState);
          }
          if (isOpenAIResponsesStream && boundNode) {
            applyResponsesMetadataToNode(boundNode, {
              timeline: latestResponsesActivityTimeline,
              phase: latestResponsesAssistantPhase,
              inputItems: latestResponsesInputItems
            });
            syncAttemptAssistantView(currentAiMessageId, {
              attemptState,
              node: boundNode
            });
          }
          applyApiMetaToMessage(currentAiMessageId, usedApiConfig);
        } catch (e) {
          console.warn('原地替换 AI 消息失败，将回退为追加新消息:', e);
          currentAiMessageId = null;
        } finally {
          if (regenContainer) {
            restoreReadingAnchor(regenContainer, anchor);
          }
        }
      }

      if (!currentAiMessageId) {
        // 次优路径：把“正在处理...”占位升级为正式 AI 消息，减少 DOM 抖动与顺序跳跃。
        let promotedId = null;
        if (loadingMessage && loadingMessage.parentNode && getUiContainer()) {
          promotedId = promoteLoadingMessageToAi({
            answer: aiResponse,
            thoughts: isOpenAIResponsesStream ? null : aiThoughtsRaw
          });
        }
        if (promotedId) {
          currentAiMessageId = promotedId;
          bindAttemptAiMessage(attemptState, currentAiMessageId);
          if (isOpenAIResponsesStream) {
            const promotedNode = resolveAttemptAiNode(attemptState, currentAiMessageId);
            if (promotedNode) {
              applyResponsesMetadataToNode(promotedNode, {
                timeline: latestResponsesActivityTimeline,
                phase: latestResponsesAssistantPhase,
                inputItems: latestResponsesInputItems
              });
              syncAttemptResponsesRuntimeState(attemptState, {
                timeline: latestResponsesActivityTimeline,
                inputItems: latestResponsesInputItems,
                assistantPhase: latestResponsesAssistantPhase,
                responseId: latestResponsesResponseId || null
              });
              syncAttemptAssistantView(currentAiMessageId, {
                attemptState,
                node: promotedNode
              });
            }
          }
        }
      }

      if (!currentAiMessageId) {
        // 最终兜底：无法原地替换且无法复用占位时，创建新的 AI 消息节点。
        if (loadingMessage && loadingMessage.parentNode) {
          loadingMessage.remove();
        }
        const threadHistoryPatch = buildThreadHistoryPatch(threadContext);
        const historyParentId = resolveHistoryParentIdForAi(threadContext, attemptState);
        const uiContainer = getUiContainer();
        const shouldRenderDom = !!uiContainer;
        if (!shouldRenderDom) {
          const createdNode = createThreadAiMessageHistoryOnly({
            content: aiResponse,
            thoughts: isOpenAIResponsesStream ? null : aiThoughtsRaw,
            historyParentId,
            historyPatch: threadHistoryPatch,
            historyMessagesRef: attemptState?.historyMessagesRef || null,
            preserveCurrentNode: !!threadContext
          });
          if (createdNode) {
            currentAiMessageId = createdNode.id;
            bindAttemptAiMessage(attemptState, currentAiMessageId, createdNode);
            resetAssistantResponseMetaForAttempt(currentAiMessageId, null);
            if (isOpenAIResponsesStream) {
              applyResponsesMetadataToNode(createdNode, {
                timeline: latestResponsesActivityTimeline,
                phase: latestResponsesAssistantPhase,
                inputItems: latestResponsesInputItems
              });
            }
            applyApiMetaToMessage(currentAiMessageId, usedApiConfig);
            updateThreadLastMessage(threadContext, currentAiMessageId);
          }
        } else {
          const threadOptions = threadContext
            ? {
                container: threadContext.container,
                historyParentId,
                preserveCurrentNode: true,
                historyPatch: threadHistoryPatch
              }
            : null;
          const newAiMessageDiv = messageProcessor.appendMessage(
            aiResponse,
            'ai',
            false,
            null,
            null,
            isOpenAIResponsesStream ? null : aiThoughtsRaw,
            null,
            null,
            threadOptions
          );

          if (newAiMessageDiv) {
            currentAiMessageId = newAiMessageDiv.getAttribute('data-message-id');
            bindAttemptAiMessage(attemptState, currentAiMessageId);
            resetAssistantResponseMetaForAttempt(currentAiMessageId, newAiMessageDiv);
            if (isOpenAIResponsesStream) {
              const createdNode = resolveAttemptAiNode(attemptState, currentAiMessageId);
              if (createdNode) {
                applyResponsesMetadataToNode(createdNode, {
                  timeline: latestResponsesActivityTimeline,
                  phase: latestResponsesAssistantPhase,
                  inputItems: latestResponsesInputItems
                });
                syncAttemptResponsesRuntimeState(attemptState, {
                  timeline: latestResponsesActivityTimeline,
                  inputItems: latestResponsesInputItems,
                  assistantPhase: latestResponsesAssistantPhase,
                  responseId: latestResponsesResponseId || null
                });
                syncAttemptAssistantView(currentAiMessageId, {
                  attemptState,
                  node: createdNode,
                  fallbackElement: newAiMessageDiv
                });
              }
            }
            applyApiMetaToMessage(currentAiMessageId, usedApiConfig, newAiMessageDiv);
            updateThreadLastMessage(threadContext, currentAiMessageId);
          }
        }

        const scrollContainer = getUiContainer();
        if (scrollContainer) {
          // 首帧创建新节点时才主动滚动，后续增量滚动由 updateAIMessage 内部处理。
          scrollToBottom(scrollContainer);
        }
      }

      void persistAttemptConversationSnapshot(attemptState);
    };

    const applyStreamingRenderTransition = ({ hasDelta }) => {
      const hadEverShownAnswerContent = !!streamRenderState.hasEverShownAnswerContent;
      const transition = planStreamingRenderTransition({
        hasDelta,
        hasStartedResponse: streamRenderState.hasStartedResponse,
        hasMessageId: !!currentAiMessageId,
        hasAnswerContent: (typeof aiResponse === 'string') && aiResponse.trim() !== '',
        hasEverShownAnswerContent: streamRenderState.hasEverShownAnswerContent
      });

      streamRenderState.hasStartedResponse = transition.nextState.hasStartedResponse;
      streamRenderState.hasEverShownAnswerContent = transition.nextState.hasEverShownAnswerContent;
      if (streamRenderState.hasEverShownAnswerContent !== hadEverShownAnswerContent) {
        updateAttemptRuntimeState(attemptState, (draft) => {
          // 只跟随“真实 answer 是否已开始出现”的状态机，
          // 不让前面的状态文案 / reasoning summary 抢先触发正文开始信号。
          draft.activeTurn.hasVisibleAnswerStarted = streamRenderState.hasEverShownAnswerContent;
        });
      }

      const shouldCaptureFirstVisibleOutput = (
        normalizeOptionalTimestamp(attemptState?.firstVisibleOutputAtMs) == null
        && hasVisibleAssistantOutput({
          answer: aiResponse,
          thoughts: isOpenAIResponsesStream ? null : aiThoughtsRaw,
          responseActivityTimeline: isOpenAIResponsesStream ? latestResponsesActivityTimeline : null
        })
      );
      if (shouldCaptureFirstVisibleOutput && attemptState) {
        const now = Date.now();
        if (normalizeOptionalTimestamp(attemptState.firstVisibleOutputAtMs) == null) {
          attemptState.firstVisibleOutputAtMs = now;
        }
        clearAttemptPreResponseStatus(attemptState, loadingMessage || null);
        if (currentAiMessageId) {
          applyTimingMetaToMessage(
            currentAiMessageId,
            buildAttemptTimingMeta({ firstVisibleOutputAtMs: attemptState.firstVisibleOutputAtMs }),
            null
          );
        }
      }

      if (transition.action === 'noop') {
        return;
      }
      if (transition.action === 'first_chunk') {
        applyFirstChunkRenderSideEffects();
        return;
      }
      if (transition.action === 'update_existing' && currentAiMessageId) {
        // 高频 token 增量统一走节流器，避免每个分片都触发 Markdown/代码高亮重渲染。
        uiUpdateThrottler.enqueue(
          {
            messageId: currentAiMessageId,
            answer: aiResponse,
            thoughts: isOpenAIResponsesStream ? null : aiThoughtsRaw,
            responsesActivityTimeline: isOpenAIResponsesStream
              ? cloneResponsesActivityTimeline(latestResponsesActivityTimeline)
              : null,
            responsesInputItems: isOpenAIResponsesStream
              ? cloneResponsesReplayOutputItems(latestResponsesInputItems)
              : null
          },
          { force: transition.forceUiUpdate }
        );
      }
    };

	    while (true) {
	      const { done, value } = await reader.read();
	      if (done) {
        // 处理缓冲区中最后一行未以换行结尾的数据
        if (incomingDataBuffer.length > 0) {
          await processLine(incomingDataBuffer);
          incomingDataBuffer = '';
        }
        // 如果还有未处理完的事件行，作为最后一个事件再处理一次
        if (currentEventDataLines.length > 0) {
          await processEvent();
        }
	        break;
	      }

      incomingDataBuffer += decoder.decode(value, { stream: true });

      let lineEndIndex;
      while ((lineEndIndex = incomingDataBuffer.indexOf('\n')) >= 0) {
        const line = incomingDataBuffer.substring(0, lineEndIndex);
        incomingDataBuffer = incomingDataBuffer.substring(lineEndIndex + 1);
	        await processLine(line);
	      }
	    }

	    // 流式响应结束：强制刷新最后一帧，避免尾部 token 被节流合并后未能落到 UI。
	    try { uiUpdateThrottler.flush({ force: true }); } catch (_) {}

	    // 流式响应结束后，将“签名/推理元信息”写入当前 AI 消息节点，并刷新 footer 标记
		    // - Gemini：Thought Signature（part-level thought_signature）
		    // - OpenAI Chat Completions 兼容：thoughtSignature（message-level thoughtSignature + reasoning_content/tool_calls）
        // - Responses API：reasoning summary / output item 工具调用时间线
      if (currentAiMessageId) {
        const nodeForTiming = resolveAttemptAiNode(attemptState, currentAiMessageId);
        const completedAtMs = Date.now();
        const thinkingDurationMs = Number.isFinite(Number(nodeForTiming?.response_activity_duration_ms))
          ? Number(nodeForTiming.response_activity_duration_ms)
          : undefined;
        applyTimingMetaToMessage(
          currentAiMessageId,
          buildAttemptTimingMeta({ completedAtMs, thinkingDurationMs }),
          null
        );
      }
      if (currentAiMessageId && latestOpenAIUsage) {
        applyUsageMetaToMessage(currentAiMessageId, latestOpenAIUsage);
      }
      const hasResponsesMetadata = isOpenAIResponsesStream
        && Array.isArray(latestResponsesActivityTimeline)
        && latestResponsesActivityTimeline.length > 0;
		    if (currentAiMessageId && (latestGeminiThoughtSignature || latestOpenAIThoughtSignature || (Array.isArray(latestOpenAIToolCalls) && latestOpenAIToolCalls.length > 0) || hasResponsesMetadata)) {
		      try {
	        const node = resolveAttemptAiNode(attemptState, currentAiMessageId);
          if (node) {
            attemptState.aiMessageNode = node;
          }
	        if (node) {
	          if (isGeminiApi && latestGeminiThoughtSignature) {
	            // Gemini：在历史节点上记录 Thought Signature，供后续多轮对话回传使用
	            node.thoughtSignature = latestGeminiThoughtSignature;
	            node.thoughtSignatureSource = 'gemini';
	          }

	          if (!isGeminiApi) {
              if (isOpenAIResponsesStream) {
                applyResponsesMetadataToNode(node, {
                  timeline: latestResponsesActivityTimeline,
                  phase: latestResponsesAssistantPhase,
                  inputItems: latestResponsesInputItems
                });
              } else {
	              // OpenAI 兼容：推理签名与推理原文、tool_calls 原样落库，供后续历史消息回传
	              if (latestOpenAIThoughtSignature) {
	                node.thoughtSignature = latestOpenAIThoughtSignature;
	                node.thoughtSignatureSource = 'openai';
	              } else if (Array.isArray(latestOpenAIToolCalls) && latestOpenAIToolCalls.length > 0) {
	                // 仅有 tool_calls 签名/结构时，也标记来源，避免后续误发给 Gemini
	                if (!node.thoughtSignatureSource) node.thoughtSignatureSource = 'openai';
	              }

	              if (typeof latestOpenAIReasoningContent === 'string' && latestOpenAIReasoningContent) {
	                // 与 OpenAI 兼容字段保持一致：使用 reasoning_content 命名，便于 buildRequest 直接透传
	                node.reasoning_content = latestOpenAIReasoningContent;
	              }

	              if (Array.isArray(latestOpenAIToolCalls) && latestOpenAIToolCalls.length > 0) {
	                node.tool_calls = latestOpenAIToolCalls;
	              }
              }
	          }

          const safeMessageId = escapeMessageIdForSelector(currentAiMessageId);
          const selector = safeMessageId ? `.message[data-message-id="${safeMessageId}"]` : '';
	          const el = selector
	            ? (chatContainer.querySelector(selector)
	              || (threadContext?.container ? threadContext.container.querySelector(selector) : null))
	            : null;
	          if (el) {
                syncAttemptAssistantView(currentAiMessageId, {
                  attemptState,
                  node,
                  fallbackElement: el
                });
	          }
	        }
	      } catch (e) {
	        console.warn('记录 AI 元信息失败（流式）:', e);
	      }
	    }

      if (isOpenAIResponsesStream && attemptState) {
        syncAttemptResponsesRuntimeState(attemptState, {
          timeline: latestResponsesActivityTimeline,
          inputItems: latestResponsesInputItems,
          assistantPhase: latestResponsesAssistantPhase || null,
          responseId: latestResponsesResponseId || null
        });
      }

      await persistAttemptConversationSnapshot(attemptState, { force: true });

      return {
        answer: aiResponse || '',
        responseId: latestResponsesResponseId || null,
        responseOutputItems: latestResponsesOutputItems.length > 0
          ? cloneResponsesReplayOutputItems(latestResponsesOutputItems)
          : null,
        responseInputItems: latestResponsesInputItems.length > 0
          ? cloneResponsesReplayOutputItems(latestResponsesInputItems)
          : null,
        responseActivityTimeline: (Array.isArray(latestResponsesActivityTimeline) && latestResponsesActivityTimeline.length > 0)
          ? cloneResponsesActivityTimeline(latestResponsesActivityTimeline)
          : null,
        responseToolCalls: isOpenAIResponsesStream
          ? getNewResponsesToolCalls(previousResponsesActivityTimeline, latestResponsesActivityTimeline)
          : null,
        assistantPhase: latestResponsesAssistantPhase || null,
        isResponsesApi: isOpenAIResponsesStream
      };

    async function processLine(line) {
      // Trim the line to handle potential CR characters as well (e.g. '\r\n')
      const trimmedLine = line.trim();

      if (trimmedLine === '') { // Empty line: dispatch event
        if (currentEventDataLines.length > 0) {
          await processEvent();
        }
      } else if (trimmedLine.startsWith('data:')) {
        // Add content after "data:" (and optional single space) to current event's data lines
        currentEventDataLines.push(trimmedLine.substring(5).trimStart()); 
      } 
      // Ignoring event:, id:, : (comments) as they are not used by current response structures
    }

    async function processEvent() {
      // 将当前事件的多行 data 合并为一个 JSON 字符串
      const fullEventData = currentEventDataLines.join('\n'); 
      currentEventDataLines = []; // 重置，准备下一个事件

      if (fullEventData.trim() === '') return; // 空事件直接跳过

	      // OpenAI 特有的 [DONE] 结束标记
	      if (!isGeminiApi && fullEventData.trim() === '[DONE]') {
	        // 结束标记到达时，尽量立刻落一次最终 UI，避免连接迟迟不关闭导致的“最后几 token 不显示”。
	        try { uiUpdateThrottler.flush({ force: true }); } catch (_) {}
	        return;
	      }

      let jsonData = null;
      try {
        jsonData = JSON.parse(fullEventData);
      } catch (e) {
        console.error('解析SSE事件JSON出错:', e, 'Event data:', `'${fullEventData}'`);
        // 将解析错误转为可读文本后抛出，确保聊天框也能看到与控制台一致的关键报错。
        const parseErrorText = toDisplayableErrorText(e?.message || e, 220) || '未知解析错误';
        const eventPreview = toDisplayableErrorText(fullEventData, 320);
        const readableError = eventPreview
          ? `流式事件解析失败：${parseErrorText}；事件数据片段：${eventPreview}`
          : `流式事件解析失败：${parseErrorText}`;
        throw new Error(readableError);
      }

      if (isGeminiApi) {
        await handleGeminiEvent(jsonData);
      } else {
        handleOpenAIEvent(jsonData);
      }
    }

    /**
     * 处理 Gemini SSE 事件（包括文本、思考过程、代码执行与图片）
     * @param {Object} data - 从SSE事件中解析出的JSON对象
     */
    async function handleGeminiEvent(data) {
      if (data.error) {
        const errorMessage = buildStreamApiErrorMessage(data.error, 'Unknown Gemini error');
        console.error('Gemini API error:', data.error);
        // 不要移除 loadingMessage，让上层的 catch 块来处理错误显示
        const streamApiError = new Error(errorMessage);
        streamApiError.name = 'StreamApiError';
        throw streamApiError;
      }

      // 处理 Gemini 里那类「HTTP 200 但因安全策略被拦截」的特殊情况
      // 流式场景下，如果之前尚未输出任何正文，并且当前事件命中安全拦截，则视为“200 返回错误”，交给自动重试
      const safetyBlock = detectGeminiSafetyBlock(data, {
        hasExistingContent: !!(aiResponse && aiResponse.trim())
      });
      if (safetyBlock && safetyBlock.blocked) {
        console.warn('Gemini 响应被安全策略拦截（流式，HTTP 200）:', safetyBlock.message);
        throw new Error(safetyBlock.message);
      }

      // 本事件的增量内容
      let currentEventAnswerDelta = '';
      let currentEventThoughtsDelta = '';
      const newInlineImages = [];

      if (data.candidates && data.candidates.length > 0) {
        const candidate = data.candidates[0];
        if (candidate.content && Array.isArray(candidate.content.parts)) {
          for (const part of candidate.content.parts) {
            // 0) 捕获 Gemini 3 思维链签名（Thought Signature）：可能出现在最后一个 part，或仅包含签名的空文本 part
            let extractedSignature = null;
            if (typeof part.thought_signature === 'string' && part.thought_signature) {
              extractedSignature = part.thought_signature;
            } else if (typeof part.thoughtSignature === 'string' && part.thoughtSignature) {
              // 兼容驼峰命名的 thoughtSignature
              extractedSignature = part.thoughtSignature;
            } else {
              const extraContent = part.extra_content || part.extraContent;
              const googleMeta = extraContent && (extraContent.google || extraContent.Google);
              if (googleMeta) {
                if (typeof googleMeta.thought_signature === 'string' && googleMeta.thought_signature) {
                  extractedSignature = googleMeta.thought_signature;
                } else if (typeof googleMeta.thoughtSignature === 'string' && googleMeta.thoughtSignature) {
                  extractedSignature = googleMeta.thoughtSignature;
                }
              }
            }
            if (extractedSignature) {
              latestGeminiThoughtSignature = extractedSignature;
            }

            // 1) 普通文本与思考过程
            if (typeof part.text === 'string') {
              const split = splitDeltaByThinkTags(part.text, !!part.thought);
              currentEventAnswerDelta += split.answerDelta;
              currentEventThoughtsDelta += split.thoughtDelta;
              continue;
            }

            // 2) 可执行代码块 - 转为 Markdown 代码块
            if (part.executableCode && typeof part.executableCode.code === 'string') {
              const lang = (part.executableCode.language || 'python').toString().toLowerCase();
              const code = part.executableCode.code;
              currentEventAnswerDelta += `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
              continue;
            }

            // 3) 代码执行结果 - 以代码块形式展示
            if (part.codeExecutionResult && typeof part.codeExecutionResult.output === 'string') {
              const outcome = part.codeExecutionResult.outcome || '';
              const outcomeLabel = outcome ? ` (${outcome})` : '';
              const output = part.codeExecutionResult.output;
              currentEventAnswerDelta += `\n\`\`\`text\n# 代码执行结果${outcomeLabel}\n${output}\n\`\`\`\n`;
              continue;
            }

            // 4) 内联图片数据 - 记录待保存的信息，稍后统一下载为本地文件
            const inline = part.inlineData || part.inline_data;
            if (inline && inline.mimeType && inline.data) {
              if (String(inline.mimeType).startsWith('image/')) {
                newInlineImages.push({
                  mimeType: inline.mimeType,
                  base64Data: inline.data
                });
              }
            }
          }
        }
      }

      // 将本事件中的图片转为内联 img 元素，直接插入到答案增量中
      if (newInlineImages.length > 0) {
        // 对每张图片优先尝试保存为本地文件，失败则回退为 dataURL
        const resolvedUrls = await Promise.all(
          newInlineImages.map(async (img) => {
            const fileUrl = await saveInlineImageToLocalFile(img.mimeType, img.base64Data);
            if (fileUrl) return fileUrl;
            return `data:${img.mimeType};base64,${img.base64Data}`;
          })
        );

        const inlineHtmlChunks = resolvedUrls.map((url) => {
          const safeUrl = (url || '').replace(/"/g, '&quot;');
          const title = '模型生成图片';
          const safeTitle = title.replace(/"/g, '&quot;');
          return `\n<img class="ai-inline-image" src="${safeUrl}" alt="${safeTitle}" />\n`;
        });
        currentEventAnswerDelta += inlineHtmlChunks.join('');
      }

      const hasTextDelta = !!(currentEventAnswerDelta || currentEventThoughtsDelta);

      // 没有任何可见增量内容时直接返回
      if (!hasTextDelta) return;

      // 累积主回答与思考过程
      aiResponse += currentEventAnswerDelta;
      // 思考过程可能是“流式增量”输出：这里必须按增量拼接，避免每个分片都被插入段落分隔导致渲染成大量 <p>。
      aiThoughtsRaw = mergeStreamingThoughts(aiThoughtsRaw, currentEventThoughtsDelta);
      const thinkExtraction = extractThinkingFromText(aiResponse);
      aiResponse = thinkExtraction.cleanText;
      // 注意：在流式场景中，换行/缩进可能以“分片边界的空白字符”出现。
      // mergeThoughts() 内部会对 existing 做 trim()，若在这里每帧都调用，会把这些空白误删，导致换行丢失。
      // 因此仅在确实提取到了新的 <think> 段落时才合并，避免对流式思考内容做多余的预处理。
      if (thinkExtraction.thoughtText) {
        aiThoughtsRaw = mergeThoughts(aiThoughtsRaw, thinkExtraction.thoughtText);
      }

      // Gemini 事件也走统一状态机，避免与 OpenAI 分支出现“首帧/增量”行为偏差。
      applyStreamingRenderTransition({ hasDelta: hasTextDelta });
    }

    /**
     * 处理与OpenAI兼容的API的SSE事件
     * @param {Object} data - 从SSE事件中解析出的JSON对象
     */
    function mergeOpenAIToolCallsDelta(existingCalls, deltaCalls) {
      const existing = Array.isArray(existingCalls) ? existingCalls : [];
      const deltas = Array.isArray(deltaCalls) ? deltaCalls : [];
      if (deltas.length === 0) return existing;

      // 深拷贝一层，避免在高频流式更新中意外共享引用导致历史节点被“半成品”污染
      const nextCalls = existing.map((c) => {
        if (!c || typeof c !== 'object') return c;
        const cloned = { ...c };
        if (c.function && typeof c.function === 'object') {
          cloned.function = { ...c.function };
        }
        return cloned;
      });

      for (const delta of deltas) {
        if (!delta || typeof delta !== 'object') continue;
        const idx = Number.isInteger(delta.index) ? delta.index : nextCalls.length;
        while (nextCalls.length <= idx) {
          nextCalls.push({ id: '', type: 'function', function: { name: '', arguments: '' } });
        }

        const current = nextCalls[idx] && typeof nextCalls[idx] === 'object' ? nextCalls[idx] : {};
        const merged = { ...current };

        if (typeof delta.id === 'string' && delta.id) merged.id = delta.id;
        if (typeof delta.type === 'string' && delta.type) merged.type = delta.type;

        // 工具调用片段的签名（某些代理会要求回传）
        const toolThoughtSignature =
          (typeof delta.thoughtSignature === 'string' && delta.thoughtSignature) ||
          (typeof delta.thought_signature === 'string' && delta.thought_signature) ||
          null;
        if (toolThoughtSignature) merged.thoughtSignature = toolThoughtSignature;

        if (delta.function && typeof delta.function === 'object') {
          const mergedFn = (merged.function && typeof merged.function === 'object')
            ? { ...merged.function }
            : {};

          if (typeof delta.function.name === 'string' && delta.function.name) {
            mergedFn.name = delta.function.name;
          }

          if (typeof delta.function.arguments === 'string' && delta.function.arguments) {
            const prevArgs = (typeof mergedFn.arguments === 'string') ? mergedFn.arguments : '';
            // arguments 是流式分片输出：使用 mergeStreamingThoughts 的“去重拼接”策略做通用合并
            mergedFn.arguments = mergeStreamingThoughts(prevArgs, delta.function.arguments);
          }

          merged.function = mergedFn;
        }

        nextCalls[idx] = merged;
      }

      return nextCalls;
    }

    function handleOpenAIEvent(data) {
      const eventType = (typeof data?.type === 'string') ? data.type : '';

      // 检查 API 返回的错误信息
      if (data.error) {
        const msg = buildStreamApiErrorMessage(data.error, 'Unknown OpenAI error');
        console.error('OpenAI API error:', data.error);
        const streamApiError = new Error(msg);
        streamApiError.name = 'StreamApiError';
        throw streamApiError;
      }
      // 检查 choices 数组中的错误信息（Chat Completions SSE）
      if (data.choices?.[0]?.error) {
        const msg = buildStreamApiErrorMessage(data.choices[0].error, 'Unknown OpenAI model error');
        console.error('OpenAI Model error:', data.choices[0].error);
        const streamApiError = new Error(msg);
        streamApiError.name = 'StreamApiError';
        throw streamApiError;
      }

      // Responses API SSE 事件分支
      if (isOpenAIResponsesStream) {
        updateLoadingStatusFromResponsesSseEvent(eventType, data);
        if (eventType === 'response.error' || eventType === 'error' || eventType === 'response.failed') {
          const payloadError = data?.error || data?.response?.error || data;
          const msg = buildStreamApiErrorMessage(payloadError, 'Unknown OpenAI Responses error');
          console.error('OpenAI Responses API error:', data);
          const streamApiError = new Error(msg);
          streamApiError.name = 'StreamApiError';
          throw streamApiError;
        }

        const usageFromChunk = normalizeApiUsageMeta(data?.usage || data?.response?.usage);
        if (usageFromChunk) {
          latestOpenAIUsage = usageFromChunk;
          if (currentAiMessageId) {
            applyUsageMetaToMessage(currentAiMessageId, usageFromChunk);
          }
        }

        let currentEventAnswerDelta = '';
        let currentEventReasoningDelta = '';
        let hasToolCallsDelta = false;
        let shouldRebuildResponsesVisibleAnswer = false;

        if (eventType === 'response.output_text.delta' || eventType === 'response.output_text.done') {
          const outputItemId = (typeof data?.item_id === 'string' && data.item_id)
            || (typeof data?.output_item_id === 'string' && data.output_item_id)
            || '';
          const outputItemPhase = normalizeResponsesMessagePhase(
            outputItemId ? latestResponsesOutputItemPhaseById.get(outputItemId) : ''
          );
          const outputTextDelta = (typeof data?.delta === 'string')
            ? data.delta
            : ((typeof data?.text === 'string') ? data.text : '');
          if (isResponsesCommentaryPhase(outputItemPhase)) {
            currentEventReasoningDelta = outputTextDelta;
            if (typeof currentEventReasoningDelta === 'string' && currentEventReasoningDelta) {
              latestResponsesActivityTimeline = upsertResponsesCommentaryTimeline(
                latestResponsesActivityTimeline,
                data,
                currentEventReasoningDelta,
                {
                  id: outputItemId || data?.item_id || data?.id || 'commentary',
                  status: eventType.endsWith('.done') ? 'completed' : (data?.status || 'streaming'),
                  phase: outputItemPhase || 'commentary'
                }
              );
            }
          } else {
            shouldRebuildResponsesVisibleAnswer = upsertResponsesOutputTextPartState(
              latestResponsesOutputTextState,
              {
                item_id: outputItemId || data?.item_id || data?.output_item_id || '',
                output_index: data?.output_index,
                content_index: data?.content_index,
                status: eventType.endsWith('.done') ? 'completed' : (data?.status || 'streaming')
              },
              outputTextDelta,
              {
                status: eventType.endsWith('.done') ? 'completed' : (data?.status || 'streaming')
              }
            ) || shouldRebuildResponsesVisibleAnswer;
          }
        } else if (
          eventType === 'response.reasoning_text.delta'
          || eventType === 'response.reasoning_summary_text.delta'
          || eventType === 'response.reasoning_text.done'
          || eventType === 'response.reasoning_summary_text.done'
        ) {
          currentEventReasoningDelta = (typeof data?.delta === 'string')
            ? data.delta
            : ((typeof data?.text === 'string') ? data.text : '');
          if (typeof currentEventReasoningDelta === 'string' && currentEventReasoningDelta) {
            latestResponsesActivityTimeline = upsertResponsesReasoningTimeline(
              latestResponsesActivityTimeline,
              data,
              currentEventReasoningDelta,
              {
                status: eventType.endsWith('.done') ? 'completed' : (data?.status || 'streaming')
              }
            );
          }
        } else if (eventType === 'response.output_item.added' || eventType === 'response.output_item.done') {
          const outputItem = (data?.item && typeof data.item === 'object') ? data.item : null;
          if (outputItem) {
            const outputItemPhase = normalizeResponsesMessagePhase(outputItem.phase);
            const outputItemId = (typeof outputItem.id === 'string' && outputItem.id)
              || (typeof outputItem.item_id === 'string' && outputItem.item_id)
              || '';
            if (outputItemId && outputItem.type === 'message' && outputItemPhase) {
              latestResponsesOutputItemPhaseById.set(outputItemId, outputItemPhase);
            }
            if (outputItem.type === 'message') {
              shouldRebuildResponsesVisibleAnswer = upsertResponsesOutputTextPartsFromMessageItem(
                latestResponsesOutputTextState,
                outputItem,
                {
                  status: eventType === 'response.output_item.done' ? 'completed' : (outputItem.status || data?.status || ''),
                  outputIndexFallback: data?.output_index
                }
              ) || shouldRebuildResponsesVisibleAnswer;
            }
            if (eventType === 'response.output_item.done') {
              latestResponsesOutputItems = mergeResponsesReplayOutputItems(
                latestResponsesOutputItems,
                [outputItem]
              );
            }
            const extractedItem = extractOpenAIResponsesOutput({ output: [outputItem] });
            if (!shouldRebuildResponsesVisibleAnswer && typeof extractedItem.answer === 'string' && extractedItem.answer) {
              currentEventAnswerDelta = extractedItem.answer;
            }
            if (typeof extractedItem.assistantPhase === 'string' && extractedItem.assistantPhase) {
              latestResponsesAssistantPhase = extractedItem.assistantPhase;
            }
            if (Array.isArray(extractedItem.responseActivityTimeline) && extractedItem.responseActivityTimeline.length > 0) {
              latestResponsesActivityTimeline = mergeResponsesActivityTimeline(
                latestResponsesActivityTimeline,
                extractedItem.responseActivityTimeline
              );
              if (typeof extractedItem.reasoningSummary === 'string' && extractedItem.reasoningSummary) {
                currentEventReasoningDelta = extractedItem.reasoningSummary;
              }
            }
            if (Array.isArray(extractedItem.responseToolCalls) && extractedItem.responseToolCalls.length > 0) {
              hasToolCallsDelta = true;
            }
          }
        } else if (eventType === 'response.function_call_arguments.delta' || eventType === 'response.function_call_arguments.done') {
          const functionCallRecord = normalizeResponsesToolCallRecord({
            type: 'function_call',
            item_id: data?.item_id,
            call_id: data?.call_id,
            id: data?.id,
            name: data?.name,
            arguments: (typeof data?.arguments === 'string') ? data.arguments : ((typeof data?.delta === 'string') ? data.delta : ''),
            status: eventType === 'response.function_call_arguments.done' ? 'completed' : (data?.status || 'streaming')
          });
          latestResponsesActivityTimeline = upsertResponsesToolTimeline(
            latestResponsesActivityTimeline,
            functionCallRecord,
            { status: eventType === 'response.function_call_arguments.done' ? 'completed' : (data?.status || 'streaming') }
          );
          hasToolCallsDelta = true;
        } else if (eventType === 'response.completed') {
          const completedPayload = (data?.response && typeof data.response === 'object') ? data.response : data;
          shouldRebuildResponsesVisibleAnswer = upsertResponsesOutputTextPartsFromOutputPayload(
            latestResponsesOutputTextState,
            completedPayload,
            { status: 'completed' }
          ) || shouldRebuildResponsesVisibleAnswer;
          const extracted = extractOpenAIResponsesOutput(completedPayload);
          if (Array.isArray(extracted.responseOutputItems) && extracted.responseOutputItems.length > 0) {
            latestResponsesOutputItems = mergeResponsesReplayOutputItems(
              latestResponsesOutputItems,
              extracted.responseOutputItems
            );
            latestResponsesInputItems = mergeResponsesReplayOutputItems(
              latestResponsesInputItems,
              extracted.responseOutputItems
            );
          }
          if (typeof extracted.responseId === 'string' && extracted.responseId) {
            latestResponsesResponseId = extracted.responseId;
          }
          if (!shouldRebuildResponsesVisibleAnswer && typeof extracted.answer === 'string' && extracted.answer) {
            currentEventAnswerDelta = extracted.answer;
          }
          if (typeof extracted.assistantPhase === 'string' && extracted.assistantPhase) {
            latestResponsesAssistantPhase = extracted.assistantPhase;
          }
          if (Array.isArray(extracted.responseActivityTimeline) && extracted.responseActivityTimeline.length > 0) {
            latestResponsesActivityTimeline = mergeResponsesActivityTimeline(
              latestResponsesActivityTimeline,
              extracted.responseActivityTimeline
            );
            if (typeof extracted.reasoningSummary === 'string' && extracted.reasoningSummary) {
              currentEventReasoningDelta = extracted.reasoningSummary;
            }
          }
          if (Array.isArray(extracted.responseToolCalls) && extracted.responseToolCalls.length > 0) {
            hasToolCallsDelta = true;
          }
        } else if (!eventType && isOpenAIResponsesPayload(data)) {
          shouldRebuildResponsesVisibleAnswer = upsertResponsesOutputTextPartsFromOutputPayload(
            latestResponsesOutputTextState,
            data,
            { status: 'completed' }
          ) || shouldRebuildResponsesVisibleAnswer;
          const extracted = extractOpenAIResponsesOutput(data);
          if (Array.isArray(extracted.responseOutputItems) && extracted.responseOutputItems.length > 0) {
            latestResponsesOutputItems = mergeResponsesReplayOutputItems(
              latestResponsesOutputItems,
              extracted.responseOutputItems
            );
            latestResponsesInputItems = mergeResponsesReplayOutputItems(
              latestResponsesInputItems,
              extracted.responseOutputItems
            );
          }
          if (typeof extracted.responseId === 'string' && extracted.responseId) {
            latestResponsesResponseId = extracted.responseId;
          }
          if (!shouldRebuildResponsesVisibleAnswer && typeof extracted.answer === 'string' && extracted.answer) {
            currentEventAnswerDelta = extracted.answer;
          }
          if (typeof extracted.assistantPhase === 'string' && extracted.assistantPhase) {
            latestResponsesAssistantPhase = extracted.assistantPhase;
          }
          if (Array.isArray(extracted.responseActivityTimeline) && extracted.responseActivityTimeline.length > 0) {
            latestResponsesActivityTimeline = mergeResponsesActivityTimeline(
              latestResponsesActivityTimeline,
              extracted.responseActivityTimeline
            );
            if (typeof extracted.reasoningSummary === 'string' && extracted.reasoningSummary) {
              currentEventReasoningDelta = extracted.reasoningSummary;
            }
          }
          if (Array.isArray(extracted.responseToolCalls) && extracted.responseToolCalls.length > 0) {
            hasToolCallsDelta = true;
          }
        }

        if (shouldRebuildResponsesVisibleAnswer) {
          const rebuiltAnswer = buildResponsesVisibleAnswerFromOutputTextState(latestResponsesOutputTextState);
          const thinkExtraction = extractThinkingFromText(rebuiltAnswer);
          aiResponse = thinkExtraction.cleanText;
        }

        const hasAnyDelta = !!(shouldRebuildResponsesVisibleAnswer || currentEventAnswerDelta || currentEventReasoningDelta || hasToolCallsDelta);
        if (!hasAnyDelta) return;

        syncResponsesActivityPreviewToLoadingMessage();

        if (!shouldRebuildResponsesVisibleAnswer) {
          const split = splitDeltaByThinkTags(String(currentEventAnswerDelta || ''), false);
          aiResponse += split.answerDelta;

          if (split.thoughtDelta) {
            aiThoughtsRaw = mergeStreamingThoughts(aiThoughtsRaw, split.thoughtDelta);
          }

          const thinkExtraction = extractThinkingFromText(aiResponse);
          aiResponse = thinkExtraction.cleanText;
          if (thinkExtraction.thoughtText) {
            aiThoughtsRaw = mergeThoughts(aiThoughtsRaw, thinkExtraction.thoughtText);
          }
        }

        applyStreamingRenderTransition({ hasDelta: hasAnyDelta });
        return;
      }

      // Chat Completions SSE 分支
      const delta = data.choices?.[0]?.delta || {};
      const usageFromChunk = normalizeApiUsageMeta(data?.usage);
      if (usageFromChunk) {
        latestOpenAIUsage = usageFromChunk;
        if (currentAiMessageId) {
          applyUsageMetaToMessage(currentAiMessageId, usageFromChunk);
        }
      }

      // 1) OpenAI 兼容：捕获推理签名（对应 reasoning_content/reasoning）
      const extractedThoughtSignature =
        (typeof delta?.thoughtSignature === 'string' && delta.thoughtSignature) ||
        (typeof delta?.thought_signature === 'string' && delta.thought_signature) ||
        null;
      if (extractedThoughtSignature) {
        latestOpenAIThoughtSignature = extractedThoughtSignature;
      }

      // 2) OpenAI 兼容：捕获 tool_calls（含 thoughtSignature / function.arguments 分片）
      if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
        latestOpenAIToolCalls = mergeOpenAIToolCallsDelta(latestOpenAIToolCalls, delta.tool_calls);
      }

      // 3) 从事件数据中提取内容增量 (delta)
      const currentEventAnswerDelta = delta?.content;
      const currentEventReasoningDelta = delta?.reasoning_content || delta?.reasoning || '';

      // reasoning_content 必须原样累积（用于与 thoughtSignature 配对回传）
      if (typeof currentEventReasoningDelta === 'string' && currentEventReasoningDelta) {
        latestOpenAIReasoningContent = mergeStreamingThoughts(latestOpenAIReasoningContent, currentEventReasoningDelta);
      }

      const hasToolCallsDelta = Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0;
      const hasAnyDelta = !!(currentEventAnswerDelta || currentEventReasoningDelta || hasToolCallsDelta);

      // 只有在有“可展示或结构性”的增量时才继续处理（签名本身可能独立出现：仅保存，不触发 UI 更新）
      if (hasAnyDelta) {
        const split = splitDeltaByThinkTags(String(currentEventAnswerDelta || ''), false);

        // 累积 AI 的完整响应文本
        aiResponse += split.answerDelta;

        // 思考过程同样按“流式增量”合并：
        // - OpenAI 兼容的 reasoning_content：必须保持原样，不做 <think> 标签拆分；
        // - content 内的 <think> 片段：仅用于 UI 展示（不计入 reasoning_content 回传）。
        if (typeof currentEventReasoningDelta === 'string' && currentEventReasoningDelta) {
          aiThoughtsRaw = mergeStreamingThoughts(aiThoughtsRaw, currentEventReasoningDelta);
        } else if (split.thoughtDelta) {
          aiThoughtsRaw = mergeStreamingThoughts(aiThoughtsRaw, split.thoughtDelta);
        }

        const thinkExtraction = extractThinkingFromText(aiResponse);
        aiResponse = thinkExtraction.cleanText;
        // 同 Gemini：避免每帧 mergeThoughts() 触发 trim() 破坏流式思考文本中的换行/空白。
        if (thinkExtraction.thoughtText) {
          aiThoughtsRaw = mergeThoughts(aiThoughtsRaw, thinkExtraction.thoughtText);
        }

        // OpenAI 兼容事件同样复用统一状态机，减少分支重复维护成本。
        applyStreamingRenderTransition({ hasDelta: hasAnyDelta });
      }
    }
  }

  /**
   * 处理API的非流式响应
   * @private
   * @param {Response} response - Fetch API 响应对象
   * @param {HTMLElement} loadingMessage - 加载状态消息元素
   * @param {Object} usedApiConfig - 本次使用的 API 配置
   * @param {{id:string, aiMessageId?:string}|null} attemptState - 当前请求的 attempt 状态对象
   * @returns {Promise<{answer:string, responseId:string|null, responseOutputItems:Array<Object>|null, responseInputItems:Array<Object>|null, responseActivityTimeline:Array<Object>|null, responseToolCalls:Array<Object>|null, assistantPhase:string|null, isResponsesApi:boolean}>}
   */
  async function handleNonStreamResponse(response, loadingMessage, usedApiConfig, attemptState) {
    const resolveLoadingStatusTarget = () => resolveLiveLoadingStatusElement(loadingMessage, attemptState);
    const canUpdateLoadingStatus = () => normalizeOptionalTimestamp(attemptState?.firstVisibleOutputAtMs) == null;
    // 非流式场景：响应头已收到，但需要完整下载/解析 body，可能会明显等待。
    if (canUpdateLoadingStatus()) {
      syncAttemptPreResponseStatusFromLocalStage(
        resolveLoadingStatusTarget() || loadingMessage || null,
        attemptState,
        'non_stream_read_body',
        { apiBase: usedApiConfig?.baseUrl || '', modelName: usedApiConfig?.modelName || '' }
      );
    }

    const threadContext = attemptState?.threadContext || null;
    const {
      getUiContainer,
      applyApiMetaToMessage,
      applyUsageMetaToMessage,
      applyTimingMetaToMessage,
      buildAttemptTimingMeta,
      resetAssistantResponseMetaForAttempt,
      promoteLoadingMessageToAi
    } = createResponseUiBindings({
      threadContext,
      attemptState,
      loadingMessage,
      usedApiConfig
    });

    let answer = '';
    let thoughts = '';
    // 用于承载“推理签名”（Thought Signature / thoughtSignature）：
    // - Gemini：part-level thought_signature（用于回传给 Gemini 维持多轮推理上下文）
    // - OpenAI 兼容：message-level thoughtSignature（用于与 reasoning_content/tool_calls 配对回传，避免 “signature required”）
    let thoughtSignature = null;
    // 签名来源：用于避免跨 API（Gemini/OpenAI 兼容）误回传导致上游报错
    let thoughtSignatureSource = null;
    // OpenAI 兼容：必须原样保存的 reasoning_content（不要与 thoughts 混用，避免 UI 合并逻辑改变文本导致签名失效）
    let reasoningContentRaw = '';
    // OpenAI 兼容：工具调用（若存在则与 thoughtSignature 一并回传）
    let toolCalls = null;
    // Responses API：按顺序保存 reasoning summary / 工具调用活动。
    const previousResponsesActivityTimeline = Array.isArray(attemptState?.responsesToolLoopAccumulatedTimeline)
      ? cloneResponsesActivityTimeline(attemptState.responsesToolLoopAccumulatedTimeline)
      : [];
    const previousResponsesInputItems = Array.isArray(attemptState?.responsesToolLoopAccumulatedInputItems)
      ? cloneResponsesReplayOutputItems(attemptState.responsesToolLoopAccumulatedInputItems)
      : [];
    let responseActivityTimeline = null;
    let responsesAssistantPhase = attemptState?.responsesToolLoopAssistantPhase || null;
    let responsesResponseId = (typeof attemptState?.responsesToolLoopLastResponseId === 'string' && attemptState.responsesToolLoopLastResponseId)
      ? attemptState.responsesToolLoopLastResponseId
      : null;
    let responsesInputItems = cloneResponsesReplayOutputItems(previousResponsesInputItems);
    let responsesOutputItems = null;
    let json = null;
    try {
      json = await response.json();
    } catch (e) {
      const text = await response.text().catch(() => '');
      throw new Error(text || '解析响应失败');
    }
    const responseUsageMeta = normalizeApiUsageMeta(json?.usage || json?.response?.usage);

    // 错误处理（通用）
    if (json && json.error) {
      const msg = json.error.message || 'API 返回错误';
      throw new Error(msg);
    }

    const isGeminiApi = isGeminiApiResponse(response, usedApiConfig);
    const isResponsesApi = !isGeminiApi
      && (isOpenAIResponsesApiResponse(response, usedApiConfig) || isOpenAIResponsesPayload(json));
    const markNonStreamCompletion = (messageId, messageDiv = null) => {
      if (!messageId) return;
      const completedAtMs = Date.now();
      if (normalizeOptionalTimestamp(attemptState?.firstVisibleOutputAtMs) == null) {
        attemptState.firstVisibleOutputAtMs = completedAtMs;
      }
      clearAttemptPreResponseStatus(attemptState, loadingMessage);
      const node = resolveAttemptAiNode(attemptState, messageId);
      const thinkingDurationMs = Number.isFinite(Number(node?.response_activity_duration_ms))
        ? Number(node.response_activity_duration_ms)
        : undefined;
      applyTimingMetaToMessage(
        messageId,
        buildAttemptTimingMeta({
          completedAtMs,
          firstVisibleOutputAtMs: attemptState.firstVisibleOutputAtMs,
          thinkingDurationMs
        }),
        messageDiv
      );
    };
    const finalizeNonStreamResult = () => {
      if (isResponsesApi && attemptState) {
        syncAttemptResponsesRuntimeState(attemptState, {
          timeline: responseActivityTimeline,
          inputItems: responsesInputItems,
          assistantPhase: responsesAssistantPhase || null,
          responseId: responsesResponseId || null
        });
      }
      return {
        answer: answer || '',
        responseId: responsesResponseId || null,
        responseOutputItems: (Array.isArray(responsesOutputItems) && responsesOutputItems.length > 0)
          ? cloneResponsesReplayOutputItems(responsesOutputItems)
          : null,
        responseInputItems: responsesInputItems.length > 0
          ? cloneResponsesReplayOutputItems(responsesInputItems)
          : null,
        responseActivityTimeline: (Array.isArray(responseActivityTimeline) && responseActivityTimeline.length > 0)
          ? cloneResponsesActivityTimeline(responseActivityTimeline)
          : null,
        responseToolCalls: isResponsesApi
          ? getNewResponsesToolCalls(previousResponsesActivityTimeline, responseActivityTimeline)
          : null,
        assistantPhase: responsesAssistantPhase || null,
        isResponsesApi
      };
    };
    if (isGeminiApi) {
      // 优先检测 Gemini 返回的「安全拦截但 HTTP 为 200」场景，交给上层自动重试逻辑处理
      const safetyBlock = detectGeminiSafetyBlock(json, { hasExistingContent: false });
      if (safetyBlock && safetyBlock.blocked) {
        console.warn('Gemini 响应被安全策略拦截（非流式，HTTP 200）:', safetyBlock.message);
        throw new Error(safetyBlock.message);
      }

      // Google GenAI 非流式格式（支持代码执行、内联图片与思维链签名）
      const candidates = Array.isArray(json?.candidates) ? json.candidates : [];
      const candidate = candidates[0] || null;
      const parts = candidate?.content?.parts || [];
      const inlineImages = [];

      for (const part of parts) {
        // 捕获非函数调用场景下的 Thought Signature：通常位于最后一个 part
        let extractedSignature = null;
        if (typeof part?.thought_signature === 'string' && part.thought_signature) {
          extractedSignature = part.thought_signature;
        } else if (typeof part?.thoughtSignature === 'string' && part.thoughtSignature) {
          // 兼容驼峰命名
          extractedSignature = part.thoughtSignature;
        } else {
          const extraContent = part?.extra_content || part?.extraContent;
          const googleMeta = extraContent && (extraContent.google || extraContent.Google);
          if (googleMeta) {
            if (typeof googleMeta.thought_signature === 'string' && googleMeta.thought_signature) {
              extractedSignature = googleMeta.thought_signature;
            } else if (typeof googleMeta.thoughtSignature === 'string' && googleMeta.thoughtSignature) {
              extractedSignature = googleMeta.thoughtSignature;
            }
          }
        }
        if (extractedSignature) {
          thoughtSignature = extractedSignature;
          thoughtSignatureSource = 'gemini';
        }

        if (typeof part?.text === 'string') {
          if (part.thought) thoughts += part.text; else answer += part.text;
          continue;
        }

        // 可执行代码块 -> Markdown 代码块
        if (part.executableCode && typeof part.executableCode.code === 'string') {
          const lang = (part.executableCode.language || 'python').toString().toLowerCase();
          const code = part.executableCode.code;
          answer += `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
          continue;
        }

        // 代码执行结果 -> Markdown 代码块
        if (part.codeExecutionResult && typeof part.codeExecutionResult.output === 'string') {
          const outcome = part.codeExecutionResult.outcome || '';
          const outcomeLabel = outcome ? ` (${outcome})` : '';
          const output = part.codeExecutionResult.output;
          answer += `\n\`\`\`text\n# 代码执行结果${outcomeLabel}\n${output}\n\`\`\`\n`;
          continue;
        }

        // 内联图片 -> 记录待保存的信息，稍后统一下载为本地文件并转为内联 img 元素
        const inline = part.inlineData || part.inline_data;
        if (inline && inline.mimeType && inline.data) {
          if (String(inline.mimeType).startsWith('image/')) {
            inlineImages.push({
              mimeType: inline.mimeType,
              base64Data: inline.data
            });
          }
        }
      }

      if (inlineImages.length > 0) {
        // 逐张图片优先尝试落盘为本地文件，失败时回退为 dataURL
        const resolvedUrls = await Promise.all(
          inlineImages.map(async (img) => {
            const fileUrl = await saveInlineImageToLocalFile(img.mimeType, img.base64Data);
            if (fileUrl) return fileUrl;
            return `data:${img.mimeType};base64,${img.base64Data}`;
          })
        );

        const inlineHtmlChunks = resolvedUrls.map((url) => {
          const safeUrl = (url || '').replace(/"/g, '&quot;');
          const title = '模型生成图片';
          const safeTitle = title.replace(/"/g, '&quot;');
          return `\n<img class="ai-inline-image" src="${safeUrl}" alt="${safeTitle}" />\n`;
        });
        answer += inlineHtmlChunks.join('');
      }
    } else if (isResponsesApi) {
      // OpenAI Responses API 非流式
      const extracted = extractOpenAIResponsesOutput(json);
      if (typeof extracted.answer === 'string') {
        answer = extracted.answer;
      }
      if (Array.isArray(extracted.responseOutputItems) && extracted.responseOutputItems.length > 0) {
        responsesOutputItems = cloneResponsesReplayOutputItems(extracted.responseOutputItems);
        responsesInputItems = mergeResponsesReplayOutputItems(
          responsesInputItems,
          extracted.responseOutputItems
        );
      }
      if (typeof extracted.responseId === 'string' && extracted.responseId) {
        responsesResponseId = extracted.responseId;
      }
      if (Array.isArray(extracted.responseActivityTimeline) && extracted.responseActivityTimeline.length > 0) {
        responseActivityTimeline = mergeResponsesActivityTimeline(
          previousResponsesActivityTimeline,
          extracted.responseActivityTimeline
        );
      } else if (previousResponsesActivityTimeline.length > 0) {
        responseActivityTimeline = cloneResponsesActivityTimeline(previousResponsesActivityTimeline);
      }
      if (typeof extracted.assistantPhase === 'string' && extracted.assistantPhase) {
        responsesAssistantPhase = extracted.assistantPhase;
      }
    } else {
      // OpenAI Chat Completions 兼容 非流式
      const choice = Array.isArray(json?.choices) ? json.choices[0] : null;
      const message = choice?.message || {};
      if (typeof message?.content === 'string') answer = message.content;
      if (typeof message?.reasoning_content === 'string') {
        reasoningContentRaw = message.reasoning_content;
        thoughts = message.reasoning_content;
      } else if (typeof message?.reasoning === 'string') {
        reasoningContentRaw = message.reasoning;
        thoughts = message.reasoning;
      }

      // 捕获 OpenAI 兼容 thoughtSignature（对应 reasoning_content 的签名）
      const extractedThoughtSignature =
        (typeof message?.thoughtSignature === 'string' && message.thoughtSignature) ||
        (typeof message?.thought_signature === 'string' && message.thought_signature) ||
        null;
      if (extractedThoughtSignature) {
        thoughtSignature = extractedThoughtSignature;
        thoughtSignatureSource = 'openai';
      }

      // 捕获 tool_calls（如有），并原样保存（含 tool_calls[i].thoughtSignature）
      if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
        toolCalls = message.tool_calls;
        // 如果没有 message-level thoughtSignature，但 tool_calls 带签名，也应标记来源为 openai
        if (!thoughtSignatureSource) thoughtSignatureSource = 'openai';
      }
    }

    // 额外提取 <think> 包裹的思考摘要，避免混入正文
    // 注意：OpenAI 兼容的 reasoning_content 需要“原样回传”，因此这里仅影响 UI 展示的 thoughts，不修改 reasoningContentRaw。
    if (typeof answer === 'string') {
      const thinkExtraction = extractThinkingFromText(answer);
      answer = thinkExtraction.cleanText;
      thoughts = mergeThoughts(thoughts, thinkExtraction.thoughtText);
    }
    const displayThoughts = isResponsesApi ? null : (thoughts || '');

    // 优先复用 loading 占位，避免占位升级与新建消息交错导致顺序异常
    try { GetInputContainer().classList.add('auto-scroll-glow-active'); } catch (_) {}

    // “原地替换”模式：attemptState.aiMessageId 会在 sendMessageCore 阶段预先绑定到目标消息。
    // 这里优先尝试更新既有 AI 消息；若失败再回退为创建新消息（向后兼容）。
    const existingMessageId = attemptState?.aiMessageId || null;
    if (existingMessageId) {
      try {
        const existingNode = resolveAttemptAiNode(attemptState, existingMessageId);
        const safeMessageId = escapeMessageIdForSelector(existingMessageId);
        const selector = safeMessageId ? `.message[data-message-id="${safeMessageId}"]` : '';
        const existingEl = selector
          ? (chatContainer.querySelector(selector)
            || (threadContext?.container ? threadContext.container.querySelector(selector) : null))
          : null;
        if (existingNode && existingNode.role === 'assistant') {
          const regenContainer = getUiContainer();
          const anchor = regenContainer
            ? captureReadingAnchorForRegenerate(regenContainer, existingMessageId, attemptState)
            : null;
          try {
            if (isResponsesApi) {
              applyResponsesMetadataToNode(existingNode, {
                timeline: responseActivityTimeline,
                phase: responsesAssistantPhase,
                inputItems: responsesInputItems
              });
            }
            syncAttemptAssistantView(existingMessageId, {
              attemptState,
              node: existingNode,
              fallbackElement: existingEl,
              content: answer || '',
              thoughtsRaw: displayThoughts,
              suppressMissingNodeWarning: true
            });
            // 重新生成（原地替换）：一旦开始写回新内容，旧签名就不再匹配，必须先清空
            clearBoundSignatureForRegenerate(existingMessageId, attemptState);
            applyApiMetaToMessage(existingMessageId, usedApiConfig, existingEl);
            applyUsageMetaToMessage(existingMessageId, responseUsageMeta, existingEl);
            markNonStreamCompletion(existingMessageId, existingEl);
            // 在历史节点上记录推理签名，并刷新 footer 标记
            if (thoughtSignature) {
              try {
                existingNode.thoughtSignature = thoughtSignature;
                if (thoughtSignatureSource) existingNode.thoughtSignatureSource = thoughtSignatureSource;
                syncAttemptAssistantView(existingMessageId, {
                  attemptState,
                  node: existingNode,
                  fallbackElement: existingEl
                });
              } catch (e) {
                console.warn('记录推理签名失败（非流式，原地替换）:', e);
              }
            }

            if (!isGeminiApi && isResponsesApi) {
              try {
                applyResponsesMetadataToNode(existingNode, {
                  timeline: responseActivityTimeline,
                  phase: responsesAssistantPhase,
                  inputItems: responsesInputItems
                });
                syncAttemptAssistantView(existingMessageId, {
                  attemptState,
                  node: existingNode,
                  fallbackElement: existingEl
                });
              } catch (e) {
                console.warn('记录 Responses 元信息失败（非流式，原地替换）:', e);
              }
            // OpenAI 兼容：保存 reasoning_content / tool_calls，供下次请求回传（避免签名校验失败）
            } else if (!isGeminiApi) {
              try {
                if (typeof reasoningContentRaw === 'string' && reasoningContentRaw) {
                  existingNode.reasoning_content = reasoningContentRaw;
                }
                if (Array.isArray(toolCalls) && toolCalls.length > 0) {
                  existingNode.tool_calls = toolCalls;
                  // 即使没有 message-level thoughtSignature，只要有 tool_calls（含 tool thoughtSignature），也必须标记来源为 openai，确保后续能回传 tool_calls
                  existingNode.thoughtSignatureSource = 'openai';
                }
              } catch (e) {
                console.warn('记录 OpenAI 兼容推理元信息失败（非流式，原地替换）:', e);
              }
            }
            if (!anchor && regenContainer) {
              scrollToBottom(regenContainer);
            }
            return finalizeNonStreamResult();
          } finally {
            if (regenContainer) {
              restoreReadingAnchor(regenContainer, anchor);
            }
          }
        }
      } catch (e) {
        console.warn('非流式原地替换失败，将回退为创建新消息:', e);
      }
    }

    let promotedId = null;
    if (loadingMessage && loadingMessage.parentNode) {
      promotedId = promoteLoadingMessageToAi({ answer, thoughts: displayThoughts });
    }
    if (promotedId) {
      bindAttemptAiMessage(attemptState, promotedId);
      try {
        const node = resolveAttemptAiNode(attemptState, promotedId);
        applyUsageMetaToMessage(promotedId, responseUsageMeta, loadingMessage);
        markNonStreamCompletion(promotedId, loadingMessage);
        if (node && thoughtSignature) {
          node.thoughtSignature = thoughtSignature;
          if (thoughtSignatureSource) node.thoughtSignatureSource = thoughtSignatureSource;
          syncAttemptAssistantView(promotedId, {
            attemptState,
            node,
            fallbackElement: loadingMessage
          });
        }
        if (!isGeminiApi && isResponsesApi && node) {
          applyResponsesMetadataToNode(node, {
            timeline: responseActivityTimeline,
            phase: responsesAssistantPhase,
            inputItems: responsesInputItems
          });
          syncAttemptAssistantView(promotedId, {
            attemptState,
            node,
            fallbackElement: loadingMessage
          });
        } else if (!isGeminiApi && node) {
          if (typeof reasoningContentRaw === 'string' && reasoningContentRaw) {
            node.reasoning_content = reasoningContentRaw;
          }
          if (Array.isArray(toolCalls) && toolCalls.length > 0) {
            node.tool_calls = toolCalls;
            node.thoughtSignatureSource = 'openai';
          }
        }
      } catch (e) {
        console.warn('记录推理签名失败（非流式，复用占位）:', e);
      }
      return finalizeNonStreamResult();
    }
    if (loadingMessage && loadingMessage.parentNode) loadingMessage.remove();

    // 回退：创建新消息（旧行为）
    const threadHistoryPatch = buildThreadHistoryPatch(threadContext);
    const historyParentId = resolveHistoryParentIdForAi(threadContext, attemptState);
    const shouldRenderDom = threadContext
      ? isThreadUiActive(threadContext)
      : isAttemptMainConversationActive(attemptState);
    if (!shouldRenderDom) {
      const createdNode = createThreadAiMessageHistoryOnly({
        content: answer || '',
        thoughts: displayThoughts,
        historyParentId,
        historyPatch: threadHistoryPatch,
        historyMessagesRef: attemptState?.historyMessagesRef || null,
        preserveCurrentNode: !!threadContext
      });
      if (createdNode) {
        const messageId = createdNode.id;
        // 绑定本次 AI 消息到 attempt，便于按消息粒度中止/清理
        bindAttemptAiMessage(attemptState, messageId, createdNode);
        resetAssistantResponseMetaForAttempt(messageId, null);
        applyApiMetaToMessage(messageId, usedApiConfig);
        applyUsageMetaToMessage(messageId, responseUsageMeta);
        markNonStreamCompletion(messageId, null);
        updateThreadLastMessage(threadContext, messageId);
        if (thoughtSignature) {
          try {
            createdNode.thoughtSignature = thoughtSignature;
            if (thoughtSignatureSource) createdNode.thoughtSignatureSource = thoughtSignatureSource;
            syncAttemptAssistantView(messageId, {
              attemptState,
              node: createdNode
            });
          } catch (e) {
            console.warn('记录推理签名失败（非流式，后台线程）:', e);
          }
        }

        if (!isGeminiApi && isResponsesApi) {
          try {
            applyResponsesMetadataToNode(createdNode, {
              timeline: responseActivityTimeline,
              phase: responsesAssistantPhase,
              inputItems: responsesInputItems
            });
          } catch (e) {
            console.warn('记录 Responses 元信息失败（非流式，后台线程）:', e);
          }
        // OpenAI 兼容：保存 reasoning_content / tool_calls（仅在非 Gemini 场景）
        } else if (!isGeminiApi) {
          try {
            if (typeof reasoningContentRaw === 'string' && reasoningContentRaw) {
              createdNode.reasoning_content = reasoningContentRaw;
            }
            if (Array.isArray(toolCalls) && toolCalls.length > 0) {
              createdNode.tool_calls = toolCalls;
              createdNode.thoughtSignatureSource = 'openai';
            }
          } catch (e) {
            console.warn('记录 OpenAI 兼容推理元信息失败（非流式，后台线程）:', e);
          }
        }
      }
      return finalizeNonStreamResult();
    }

    const threadOptions = threadContext
      ? {
          container: threadContext.container,
          historyParentId,
          preserveCurrentNode: true,
          historyPatch: threadHistoryPatch
        }
      : null;
    const newAiMessageDiv = messageProcessor.appendMessage(
      answer || '',
      'ai',
      false,
      null,
      null,          // 非流式 Gemini 使用内联图片
      displayThoughts,
      null,
      null,
      threadOptions
    );
      if (newAiMessageDiv) {
        const messageId = newAiMessageDiv.getAttribute('data-message-id');
        // 绑定本次 AI 消息到 attempt，便于按消息粒度中止/清理
        bindAttemptAiMessage(attemptState, messageId);
        resetAssistantResponseMetaForAttempt(messageId, newAiMessageDiv);
        applyApiMetaToMessage(messageId, usedApiConfig, newAiMessageDiv);
        applyUsageMetaToMessage(messageId, responseUsageMeta, newAiMessageDiv);
        markNonStreamCompletion(messageId, newAiMessageDiv);
        updateThreadLastMessage(threadContext, messageId);
      // 在历史节点上记录推理签名，供后续多轮对话回传使用，并刷新 footer 标记
      if (thoughtSignature) {
        try {
          const node = resolveAttemptAiNode(attemptState, messageId);
          if (node) {
            node.thoughtSignature = thoughtSignature;
            if (thoughtSignatureSource) node.thoughtSignatureSource = thoughtSignatureSource;
            syncAttemptAssistantView(messageId, {
              attemptState,
              node,
              fallbackElement: newAiMessageDiv
            });
          }
        } catch (e) {
          console.warn('记录推理签名失败（非流式）:', e);
        }
      }

	      if (!isGeminiApi && isResponsesApi) {
	        try {
	          const node = resolveAttemptAiNode(attemptState, messageId);
	          if (node) {
                applyResponsesMetadataToNode(node, {
                  timeline: responseActivityTimeline,
                  phase: responsesAssistantPhase,
                  inputItems: responsesInputItems
                });
                syncAttemptAssistantView(messageId, {
                  attemptState,
                  node,
                  fallbackElement: newAiMessageDiv
                });
	          }
	        } catch (e) {
	          console.warn('记录 Responses 元信息失败（非流式）:', e);
	        }
	      // OpenAI 兼容：保存 reasoning_content / tool_calls（仅在非 Gemini 场景）
	      } else if (!isGeminiApi) {
	        try {
	          const node = resolveAttemptAiNode(attemptState, messageId);
	          if (node) {
	            if (typeof reasoningContentRaw === 'string' && reasoningContentRaw) {
	              node.reasoning_content = reasoningContentRaw;
	            }
	            if (Array.isArray(toolCalls) && toolCalls.length > 0) {
	              node.tool_calls = toolCalls;
	              node.thoughtSignatureSource = 'openai';
	            }
	          }
	        } catch (e) {
	          console.warn('记录 OpenAI 兼容推理元信息失败（非流式）:', e);
	        }
	      }
    }
    const scrollContainer = getUiContainer();
    if (scrollContainer) {
      scrollToBottom(scrollContainer);
    }
    return finalizeNonStreamResult();
  }

  /**
   * 执行快速总结操作
   * @public
   * @param {string} webpageSelection - 网页上选择的文本
   * @param {boolean} forceQuery - 是否强制使用查询模式
   * @returns {Promise<void>}
   */
  async function performQuickSummary(webpageSelection = null, forceQuery = false) {
    const wasTemporaryMode = isTemporaryMode;
    try {
      // 确保提示词设置已加载完成
      await new Promise(resolve => {
        const checkSettings = () => {
          const prompts = promptSettingsManager.getPrompts();
          // 检查提示词设置是否已完全加载
          if (prompts && prompts.summary && prompts.summary.model) {
            resolve();
          } else {
            setTimeout(checkSettings, 100);
          }
        };
        checkSettings();
      });

      // 检查焦点是否在侧栏内
      const isSidebarFocused = document.hasFocus();
      const sidebarSelection = serializeSelectionTextWithMath(window.getSelection(), { trim: true });

      // 获取选中的文本内容
      const selectedText = (isSidebarFocused && sidebarSelection) ?
        sidebarSelection :
        webpageSelection?.trim() || '';

      // 获取页面类型
      // 获取当前提示词设置
      const prompts = promptSettingsManager.getPrompts();

      if (selectedText) {

        // 根据模型名称决定使用哪个提示词
        // forceQuery为true时, 强制使用 'query' 提示词
        const promptType = forceQuery ? 'query' : 'selection';
        const prompt = prompts[promptType].prompt.replace('<SELECTION>', selectedText);

        await sendMessage({
          originalMessageText: prompt,
          specificPromptType: promptType,
          promptMeta: { selectionText: selectedText },
          api: prompts[promptType]?.model
        });
      } else {
        if (wasTemporaryMode) {
          exitTemporaryMode();
        }
        await chatHistoryUI.clearChatHistory();

        const promptType = 'summary';
        messageInput.textContent = prompts[promptType].prompt;
        // 发送消息时指定提示词类型并传入 API 偏好
        await sendMessage({ specificPromptType: promptType, api: prompts[promptType]?.model });
      }
    } catch (error) {
      console.error('获取选中文本失败:', error);
    } finally {
      // 如果之前是临时模式，恢复
      if (wasTemporaryMode) {
        enterTemporaryMode();
      }
    }
  }

  /**
   * 中止当前请求
   * @public
   * @param {HTMLElement|string} [target] - 可选：要中止的目标消息元素或其 data-message-id；缺省时中止所有请求
   * @param {{ strictTarget?: boolean }} [options] - strictTarget=true 时仅中止精确命中的请求，不回退到“最近一次请求”
   */
  function abortCurrentRequest(target, options = {}) {
    if (!activeAttempts.size && !conversationSendQueues.size) return false;

    let abortedAny = false;
    const strictTarget = !!(options && typeof options === 'object' && options.strictTarget);
    const { targetElement, normalizedTargetId } = resolveAbortTarget(target);

    if (targetElement || normalizedTargetId) {
      for (const attempt of activeAttempts.values()) {
        if (!doesAttemptMatchAbortTarget(attempt, targetElement, normalizedTargetId)) continue;
        attempt.manualAbort = true;
        try { attempt.controller?.abort(); } catch (e) { console.error('中止当前请求失败:', e); }
        abortedAny = true;
      }

      for (const [queueKey, queue] of conversationSendQueues.entries()) {
        if (!Array.isArray(queue)) continue;
        let queueChanged = false;
        queue.forEach((task, index) => {
          const normalizedTask = normalizeConversationQueuedTask(task);
          if (normalizedTask.status !== 'delayed_retry') return;
          if (!doesQueuedTaskMatchAbortTarget(normalizedTask, normalizedTargetId)) return;
          queue[index] = normalizeConversationQueuedTask({
            ...normalizedTask,
            status: 'canceled',
            paused: false,
            availableAt: null,
            staleReason: 'aborted'
          });
          queueChanged = true;
          abortedAny = true;
        });
        if (queueChanged) {
          while (queue.length > 0 && isConversationJobTerminal(queue[0])) {
            queue.shift();
          }
          if (queue.length === 0) {
            conversationSendQueues.delete(resolveConversationQueueKey(queueKey));
          }
          refreshConversationQueueState(queueKey);
        }
      }

      if (!abortedAny && !strictTarget) {
        const lastAttempt = Array.from(activeAttempts.values()).slice(-1)[0] || null;
        if (lastAttempt) {
          lastAttempt.manualAbort = true;
          try { lastAttempt.controller?.abort(); } catch (e) { console.error('中止当前请求失败:', e); }
          abortedAny = true;
        } else {
          const allDelayedRetryJobs = Array.from(conversationSendQueues.entries())
            .flatMap(([queueKey, queue]) => (Array.isArray(queue) ? queue.map((task) => ({ queueKey, task })) : []))
            .map(({ queueKey, task }) => ({ queueKey, task: normalizeConversationQueuedTask(task) }))
            .filter(({ task }) => task.status === 'delayed_retry');
          const lastRetryJob = allDelayedRetryJobs[allDelayedRetryJobs.length - 1] || null;
          if (lastRetryJob) {
            removeConversationQueuedTask(lastRetryJob.queueKey, lastRetryJob.task.id);
            abortedAny = true;
          }
        }
      }
    } else {
      for (const attempt of activeAttempts.values()) {
        if (attempt.finished) continue;
        attempt.manualAbort = true;
        try { attempt.controller?.abort(); } catch (e) { console.error('中止当前请求失败:', e); }
        abortedAny = true;
      }

      for (const [queueKey, queue] of conversationSendQueues.entries()) {
        if (!Array.isArray(queue)) continue;
        let queueChanged = false;
        queue.forEach((task, index) => {
          const normalizedTask = normalizeConversationQueuedTask(task);
          if (normalizedTask.status !== 'delayed_retry') return;
          queue[index] = normalizeConversationQueuedTask({
            ...normalizedTask,
            status: 'canceled',
            paused: false,
            availableAt: null,
            staleReason: 'aborted'
          });
          queueChanged = true;
          abortedAny = true;
        });
        if (queueChanged) {
          while (queue.length > 0 && isConversationJobTerminal(queue[0])) {
            queue.shift();
          }
          if (queue.length === 0) {
            conversationSendQueues.delete(resolveConversationQueueKey(queueKey));
          }
          refreshConversationQueueState(queueKey);
        }
      }

      if (abortedAny) {
        isProcessingMessage = false;
        shouldAutoScroll = false;
        try {
          const loadingMessages = chatContainer.querySelectorAll('.loading-message');
          loadingMessages.forEach(el => el.remove());

          const updatingMessages = chatContainer.querySelectorAll('.ai-message.updating, .ai-message.regenerating');
          updatingMessages.forEach(el => {
            el.classList.remove('updating');
            el.classList.remove('regenerating');
          });

          GetInputContainer().classList.remove('auto-scroll-glow');
          GetInputContainer().classList.remove('auto-scroll-glow-active');
        } catch (e) {
          console.error('中止后清理占位消息失败:', e);
        }
      }
    }

    return abortedAny;
  }

  /**
   * 设置是否发送聊天历史
   * @public
   * @param {boolean} value - 是否发送聊天历史
   */
  function setSendChatHistory(value) {
    shouldSendChatHistory = value;
  }

  function setAutoRetry(value) {
    autoRetryEnabled = !!value;
  }

  function setQueueCurrentConversationMessages(value) {
    queueCurrentConversationMessages = value !== false;
  }

  /**
   * 设置当前会话ID
   * @public
   * @param {string} id - 会话ID
   */
  function setCurrentConversationId(id) {
    updateCurrentConversationContext(id);
  }

  /**
   * 获取当前会话ID
   * @public
   * @returns {string|null} 当前会话ID
   */
  function getCurrentConversationId() {
    return currentConversationId;
  }

  /**
   * 获取当前临时模式状态
   * @public
   * @returns {boolean} 是否处于临时模式
   */
  function getTemporaryModeState() {
    return isTemporaryMode;
  }

  function getDebugActiveAttemptsSnapshot() {
    return Array.from(activeAttempts.values()).map((attemptState) => ({
      id: attemptState?.id || '',
      aiMessageId: attemptState?.aiMessageId || '',
      boundConversationId: attemptState?.boundConversationId || '',
      firstVisibleOutputAtMs: normalizeOptionalTimestamp(attemptState?.firstVisibleOutputAtMs),
      pendingLoadingStatusText: (typeof attemptState?.pendingLoadingStatusText === 'string')
        ? attemptState.pendingLoadingStatusText
        : '',
      pendingLoadingStatusStage: (typeof attemptState?.pendingLoadingStatusMeta?.stage === 'string')
        ? attemptState.pendingLoadingStatusMeta.stage
        : '',
      loadingMessageId: normalizeConversationId(attemptState?.loadingMessage?.getAttribute?.('data-message-id') || ''),
      loadingMessageConnected: !!attemptState?.loadingMessage?.isConnected,
      finished: attemptState?.finished === true
    }));
  }

  /**
   * 切换临时模式
   * @public
   */
  function toggleTemporaryMode() {
    if (isTemporaryMode) {
      exitTemporaryMode();
    } else {
      enterTemporaryMode();
    }
  }

  // 公开的API
  return {
    sendMessage,
    sendSteerMessage,
    sendWithApiConfig,
    performQuickSummary,
    generateConversationTitleForMessages,
    abortCurrentRequest,
    enterTemporaryMode,
    exitTemporaryMode,
    toggleTemporaryMode,
    getTemporaryModeState,
    setSendChatHistory,
    setAutoRetry,
    setQueueCurrentConversationMessages,
    setCurrentConversationId,
    getCurrentConversationId,
    requestConversationHistoryEdit,
    requestConversationMessageDeletion,
    requestRegenerateMessage,
    cancelResponsesLocalCompaction,
    retryResponsesLocalCompaction,
    dismissResponsesLocalCompaction,
    getShouldAutoScroll,
    setShouldAutoScroll,
    getSlashCommandList,
    getSlashCommandHints,
    getStreamingConversationIds,
    getBackgroundCompletedConversationIds,
    subscribeStreamingConversationState,
    hasAbortableRequest,
    __debugGetActiveAttemptsSnapshot: getDebugActiveAttemptsSnapshot
  };
} 
