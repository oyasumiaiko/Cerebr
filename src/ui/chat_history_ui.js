/**
 * 聊天历史界面管理模块 - 负责聊天历史的UI展示、交互和持久化
 * @module ChatHistoryUI
 */

import { 
  getAllConversationMetadata, 
  getAllConversations, 
  getConversationMetadataByIds,
  getConversationMetadataPageByEndTimeDesc,
  listConversationMetadataByUrlCandidates,
  putConversation, 
  deleteConversation, 
  getConversationById,
  getConversationsByIds,
  getDatabaseStats
} from '../storage/indexeddb_helper.js';
import { storageService } from '../utils/storage_service.js';
import { queueStorageSet } from '../utils/storage_write_queue_bridge.js';
import { extractThinkingFromText, mergeThoughts } from '../utils/thoughts_parser.js';
import { generateCandidateUrls } from '../utils/url_candidates.js';
import { buildConversationSummaryFromMessages } from '../utils/conversation_title.js';
import { normalizeStoredMessageContent, splitStoredMessageContent } from '../utils/message_content.js';
import { buildApiFooterRenderData } from '../utils/api_footer_template.js';
import { normalizeResponsesPromptCacheKey } from '../utils/responses_prompt_cache.js';
import { findPendingRequestUserInputFromConversationMessages } from '../utils/request_user_input_resume.js';
import {
  EXTENSION_STATE_BACKUP_DOMAIN_API,
  EXTENSION_STATE_BACKUP_DOMAIN_MISC,
  buildExtensionStateBackupFilename,
  createExtensionStateBackupSnapshot,
  parseExtensionStateBackupSnapshot,
  restoreExtensionStateBackupSnapshot
} from '../utils/extension_state_backup.js';
import {
  buildChatHistorySearchPlan as buildChatHistorySearchPlanShared,
  buildChatHistoryTextPlan as buildChatHistoryTextPlanShared,
  buildMetaSearchText as buildMetaSearchTextShared,
  compareMessageDateRange as compareMessageDateRangeShared,
  compareNumericRange as compareNumericRangeShared,
  computeConversationMessageStats as computeConversationMessageStatsShared,
  evaluateChatHistoryFilters as evaluateChatHistoryFiltersShared,
  evaluateMetaTextMatch as evaluateMetaTextMatchShared,
  extractMessagePlainText as extractMessagePlainTextShared,
  extractPlainTextFromMessageContent as extractPlainTextFromMessageContentShared,
  parseRelativeDateRange as parseRelativeDateRangeShared,
  parseSearchDateRange as parseSearchDateRangeShared,
  parseSearchFilterToken as parseSearchFilterTokenShared,
  parseSearchOperatorValue as parseSearchOperatorValueShared,
  resolveSearchScope as resolveSearchScopeShared,
  scanConversationMessagesForSearch as scanConversationMessagesForSearchShared
} from '../utils/chat_history_search_shared.js';
import {
  normalizeConversationApiLock,
  mergeConversationApiLockState,
  mergeConversationSaveMetadataState
} from './conversation_state_merge.js';
import {
  copyConversationDocuments,
  listConversationDocuments,
  replaceConversationDocuments
} from '../storage/conversation_document_store.js';
import { copyLocalFileMounts } from '../storage/local_file_mount_store.js';
import {
  CHAT_HISTORY_PANEL_LAYOUT_MODE_FULLSCREEN,
  CHAT_HISTORY_PANEL_LAYOUT_MODE_SIDEBAR,
  buildChatHistoryPanelStoredLayout,
  normalizeChatHistoryPanelStoredLayout,
  readChatHistoryPanelLayoutEntry,
  resolveChatHistoryPanelInteractionScale
} from '../utils/chat_history_panel_layout.js';

/**
 * 创建聊天历史UI管理器
 * @param {Object} appContext - 应用程序上下文对象
 * @param {HTMLElement} appContext.dom.chatContainer - 聊天容器元素
 * @param {HTMLElement} appContext.dom.messageInput - 主聊天输入框元素
 * @param {Function} appContext.services.messageProcessor.appendMessage - 添加消息的函数
 * @param {Object} appContext.services.chatHistoryManager.chatHistory - 聊天历史管理器实例
 * @param {Function} appContext.services.chatHistoryManager.clearHistory - 清空聊天历史的函数
 * @param {Function} appContext.services.promptSettingsManager.getPrompts - 获取提示词配置的函数
 * @param {Function} appContext.services.imageHandler.createImageTag - 创建图片标签的函数
 * @param {Function} appContext.services.chatHistoryManager.getCurrentConversationChain - 获取当前会话链的函数
 * @returns {Object} 聊天历史UI管理API
 */
export function createChatHistoryUI(appContext) {
  const {
    dom,
    services,
    state,
    utils
  } = appContext;

  // Destructure dependencies from appContext
  const chatLayout = dom.chatLayout;
  const chatContainer = dom.chatContainer;
  const threadContainer = dom.threadContainer;
  const chatInputElement = dom.messageInput; 
  const appendMessage = services.messageProcessor.appendMessage;
  const settingsManager = services.settingsManager;
  
  // 修改: 直接使用 services.chatHistoryManager.chatHistory 访问数据对象
  // const chatHistory = services.chatHistoryManager.chatHistory; 
  // 修改: 直接使用 services.chatHistoryManager.clearHistory 访问清空函数
  // const clearHistory = services.chatHistoryManager.clearHistory;
  
  const promptSettingsManager = services.promptSettingsManager; 
  const createImageTag = services.imageHandler.createImageTag;
  // 修改: 直接使用 services.chatHistoryManager.getCurrentConversationChain 访问获取会话链函数
  // const getCurrentConversationChain = services.chatHistoryManager.getCurrentConversationChain;
  const showNotification = utils.showNotification;
  const conversationPresence = services.conversationPresence;

  // 线程总览抽屉状态：用于“主聊天顶部悬浮入口 + 点击展开/收起”的交互。
  const THREAD_OVERVIEW_TOP_TRIGGER_PX = 20;
  let threadOverviewDrawer = null;
  let threadOverviewDrawerHandle = null;
  let threadOverviewDrawerHandleIcon = null;
  let threadOverviewDrawerPanel = null;
  let threadOverviewHasContent = false;
  let threadOverviewExpanded = false;
  let threadOverviewPinned = false;
  let threadOverviewHandleHovered = false;
  let threadOverviewHandleVisible = false;
  let threadOverviewDrawerEventsBound = false;
  let threadOverviewDrawerResizeObserver = null;
  let threadOverviewDrawerLayoutObserver = null;

  let currentConversationId = null;
  // 记录上次关闭面板时的标签名，Esc 重新打开时优先恢复；首次加载为空则回退到“history”。
  let lastClosedTabName = null;
  // 记录聊天记录面板最近一次关闭的时间戳，用于 ESC 超时后回退到默认“聊天记录”标签。
  let lastClosedAt = 0;
  // 记录聊天记录列表的滚动位置，关闭面板后 1 分钟内可恢复，避免用户频繁切换丢失阅读位置。
  const HISTORY_PANEL_SCROLL_RESTORE_TTL = 60 * 1000;
  let historyPanelScrollSnapshot = {
    scrollTop: 0,
    capturedAt: 0,
    filter: '',
    urlMode: '',
    branchMode: ''
  };
  // let currentPageInfo = null; // Replaced by appContext.state.pageInfo or parameter to updatePageInfo
  
  // 内存管理设置 - 始终启用
  let activeConversation = null;       // 当前活动的会话对象
  let maxLoadedConversations = 5;      // 最大加载到内存的会话数
  let loadedConversations = new Map(); // 已加载到内存的会话缓存
  
  // 缓存数据库统计信息
  let cachedDbStats = null;
  let lastStatsUpdateTime = 0;
  const STATS_CACHE_DURATION = 5 * 60 * 1000; // 5分钟更新一次统计数据

  // --- 元数据缓存（UI层） ---
  let metaCache = { data: null, time: 0, promise: null };
  // 说明：默认列表使用 paged 模式，不会预先拉取全量元数据；一旦用户输入“全文搜索”，就必须拿到全量元数据。
  // 为避免“输入停下后卡一秒才开始显示搜索进度”，这里把 TTL 设长一些，并对并发请求做去重。
  const META_CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存元数据（有显式 invalidateMetadataCache 兜底）
  // --- 数据趋势缓存（图表） ---
  const TREND_STATS_TTL = 5 * 60 * 1000; // 5分钟缓存趋势统计（会在清理/更新后失效）
  let trendStatsCache = { data: null, time: 0, promise: null };
  // skill 查看器：缓存列表 / 详情 / 文件包，并把 UI 控制引用放在一处，避免在多个事件处理器之间散落状态。
  const skillViewerState = {
    initialized: false,
    filterText: '',
    selectedName: '',
    summaries: [],
    detailByName: new Map(),
    sourceByName: new Map(),
    refreshPromise: null,
    requestSeq: 0,
    refs: {
      searchInput: null,
      countText: null,
      listContainer: null,
      detailContainer: null,
      refreshButton: null
    }
  };

  const galleryCache = {
    items: [],
    loaded: false,
    lastLoadTs: 0,
    loadingPromise: null,
    runId: null,
    scanState: null,
    cleanupTimer: null,
    inactiveAt: 0,
    scrollTop: 0,
    scrollRestorePending: false,
    selectMode: false,
    selectedKeys: new Set(),
    thumbSize: 92,
    layoutMode: 'grid',
    paused: false // 非活动标签时暂停相册加载，避免后台持续扫描
  };
  const GALLERY_RENDER_BATCH_SIZE = 120;
  const GALLERY_META_PAGE_SIZE = 80;
  const GALLERY_INACTIVE_CLEANUP_MS = 15 * 60 * 1000;
  const GALLERY_THUMB_MIN_EDGE = 96;
  const GALLERY_THUMB_MAX_EDGE = 280;
  const GALLERY_THUMB_MIN_PREVIEW_EDGE = 160;
  const GALLERY_THUMB_QUALITY = 0.82;
  const GALLERY_THUMB_CONCURRENCY = 3;
  const GALLERY_THUMB_PREFETCH_VIEWPORTS = 2;
  const GALLERY_RENDER_PREFETCH_VIEWPORTS = 2;
  const GALLERY_THUMB_SIZE_DEFAULT = 92;
  const GALLERY_THUMB_SIZE_MIN = 72;
  const GALLERY_THUMB_SIZE_MAX = 160;
  const GALLERY_THUMB_SIZE_STEP = 4;
  const GALLERY_FIT_GAP = 2;
  const GALLERY_FIT_ROW_MIN_SCALE = 0.65;
  const GALLERY_FIT_ROW_MAX_SCALE = 1.35;
  const GALLERY_ITEM_DOUBLE_CLICK_DELAY_MS = 240;
  const galleryThumbQueue = { active: 0, pending: [], scheduled: false };
  // 使用 Worker + OffscreenCanvas 生成缩略图，降低主线程解码/绘制的阻塞。
  const galleryThumbWorkerPool = {
    available: typeof Worker === 'function' && typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function',
    workers: null,
    pending: new Map(),
    seq: 0,
    nextIndex: 0,
    fileUrlSupported: null,
    fileUrlFailures: 0
  };

  // --- 会话固定 API（用于“对话级别”的模型锁定）---
  let activeConversationApiLock = null;

  function buildConversationApiLockFromConfig(config) {
    return normalizeConversationApiLock(config);
  }

  function isSameConversationApiLock(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.id === b.id
      && a.connectionSourceId === b.connectionSourceId
      && a.displayName === b.displayName
      && a.modelName === b.modelName
      && a.baseUrl === b.baseUrl
      && a.connectionType === b.connectionType;
  }

  function normalizeApiConnectionType(value) {
    const normalized = (typeof value === 'string') ? value.trim().toLowerCase() : '';
    if (normalized === 'gemini') return 'gemini';
    if (normalized === 'openai_responses') return 'openai_responses';
    if (normalized === 'openai') return 'openai';
    return '';
  }

  function getApiConfigConnectionType(config) {
    const explicit = normalizeApiConnectionType(config?.connectionType);
    if (explicit) return explicit;
    const baseUrl = typeof config?.baseUrl === 'string' ? config.baseUrl.trim().toLowerCase() : '';
    if (baseUrl === 'genai' || baseUrl.includes('generativelanguage.googleapis.com')) return 'gemini';
    if (/(^|\/)responses(?:\/[^/?#]+)?\/?$/.test(baseUrl)) return 'openai_responses';
    return 'openai';
  }

  function hasValidApiKey(apiKey) {
    if (Array.isArray(apiKey)) {
      return apiKey.some(key => typeof key === 'string' && key.trim());
    }
    if (typeof apiKey === 'string') return apiKey.trim().length > 0;
    return false;
  }

  // 对话锁定 API 解析时，允许“本地 key 文件路径”作为合法凭证来源。
  function hasValidApiKeyFilePath(apiKeyFilePath) {
    return (typeof apiKeyFilePath === 'string') && apiKeyFilePath.trim().length > 0;
  }

  function hasUsableApiCredential(config) {
    if (!config || typeof config !== 'object') return false;
    if (hasValidApiKey(config.apiKey) || hasValidApiKeyFilePath(config.apiKeyFilePath)) {
      return true;
    }
    // 允许所有连接方式在 key 留空时走“免 key”请求（例如本地反代统一鉴权）。
    return true;
  }

  function hasValidApiBaseUrl(config) {
    const connectionType = getApiConfigConnectionType(config);
    const baseUrl = typeof config?.baseUrl === 'string' ? config.baseUrl.trim() : '';
    if (connectionType === 'gemini' || baseUrl.toLowerCase() === 'genai') return true;
    return baseUrl.length > 0;
  }

  function resolveApiConfigFromLock(lock) {
    if (!lock || !services.apiManager?.resolveApiParam) return null;
    const lockConnectionType = normalizeApiConnectionType(lock.connectionType);
    const isLockConnectionTypeMatched = (config) => {
      if (!lockConnectionType) return true;
      return getApiConfigConnectionType(config) === lockConnectionType;
    };
    if (lock.connectionSourceId) {
      const sourceCandidates = services.apiManager?.getAllConfigs?.() || [];
      const resolvedBySource = sourceCandidates.find((config) => {
        if (!config || config.connectionSourceId !== lock.connectionSourceId) return false;
        if (lock.modelName && (config.modelName || '').trim() !== lock.modelName) return false;
        return true;
      }) || null;
      if (isLockConnectionTypeMatched(resolvedBySource) && hasValidApiBaseUrl(resolvedBySource) && hasUsableApiCredential(resolvedBySource)) {
        return resolvedBySource;
      }
    }
    // 若锁定信息包含 id，则必须按 id 命中配置，避免误用其它同名/同基址配置
    if (lock.id) {
      const resolvedById = services.apiManager.resolveApiParam({ id: lock.id });
      if (isLockConnectionTypeMatched(resolvedById) && hasValidApiBaseUrl(resolvedById) && hasUsableApiCredential(resolvedById)) {
        return resolvedById;
      }
      return null;
    }

    let resolved = null;
    if (!resolved && lock.displayName) {
      resolved = services.apiManager.resolveApiParam(lock.displayName);
      if (resolved && !isLockConnectionTypeMatched(resolved)) resolved = null;
    }
    if (!resolved && lock.modelName) {
      resolved = services.apiManager.resolveApiParam(lock.modelName);
      if (resolved && !isLockConnectionTypeMatched(resolved)) resolved = null;
    }
    if (!resolved && lock.baseUrl && lock.modelName) {
      resolved = services.apiManager.resolveApiParam({
        baseUrl: lock.baseUrl,
        modelName: lock.modelName,
        ...(lockConnectionType ? { connectionType: lockConnectionType } : {})
      });
    }
    if (!isLockConnectionTypeMatched(resolved) || !hasValidApiBaseUrl(resolved) || !hasUsableApiCredential(resolved)) return null;
    return resolved;
  }

  // 返回当前会话的“固定 API + 实际显示配置”，供输入框/发送逻辑复用
  function resolveActiveConversationApiConfig() {
    const lock = normalizeConversationApiLock(activeConversationApiLock || activeConversation?.apiLock);
    const hasLock = !!lock;
    const lockConfig = hasLock ? resolveApiConfigFromLock(lock) : null;
    const isLockValid = !!lockConfig;
    const selectedConfig = services.apiManager?.getSelectedConfig?.() || null;
    const displayConfig = isLockValid ? lockConfig : selectedConfig;
    return {
      lock,
      hasLock,
      lockConfig,
      isLockValid,
      selectedConfig,
      displayConfig
    };
  }

  function emitConversationApiContextChanged() {
    try {
      document.dispatchEvent(new CustomEvent('CONVERSATION_API_CONTEXT_CHANGED'));
    } catch (_) {}
  }

  function createEmptySearchCache() {
    return {
      query: '',
      normalized: '',
      key: '',
      contextKey: '',
      results: null,
      matchMap: new Map(),
      timestamp: 0,
      meta: null
    };
  }
  let searchCache = createEmptySearchCache();
  const SEARCH_CACHE_TTL = 3 * 60 * 1000;
  const SEARCH_CACHE_MAX_ENTRIES = 20;
  const SEARCH_RESULT_SNIPPET_PREVIEW_LIMIT = 4;
  const SEARCH_RESULT_SNIPPET_CONTEXT_LENGTH = 24;
  let searchCacheStore = new Map();

  function pruneSearchCacheStore() {
    const now = Date.now();
    for (const [key, entry] of searchCacheStore.entries()) {
      if (!entry || !entry.timestamp || (now - entry.timestamp) > SEARCH_CACHE_TTL) {
        searchCacheStore.delete(key);
      }
    }
    while (searchCacheStore.size > SEARCH_CACHE_MAX_ENTRIES) {
      const oldestKey = searchCacheStore.keys().next().value;
      if (!oldestKey) break;
      searchCacheStore.delete(oldestKey);
    }
  }

  function getSearchCacheEntry(cacheKey) {
    if (!cacheKey) return null;
    pruneSearchCacheStore();
    const entry = searchCacheStore.get(cacheKey);
    if (!entry) return null;
    const now = Date.now();
    if (!entry.timestamp || now - entry.timestamp > SEARCH_CACHE_TTL) {
      searchCacheStore.delete(cacheKey);
      return null;
    }
    searchCacheStore.delete(cacheKey);
    entry.lastAccess = now;
    searchCacheStore.set(cacheKey, entry);
    return entry;
  }

  function setSearchCacheEntry(entry) {
    if (!entry || !entry.key) return;
    const now = Date.now();
    entry.timestamp = entry.timestamp || now;
    entry.lastAccess = now;
    searchCacheStore.delete(entry.key);
    searchCacheStore.set(entry.key, entry);
    pruneSearchCacheStore();
  }

  function invalidateGalleryCache() {
    if (galleryCache.cleanupTimer) {
      clearTimeout(galleryCache.cleanupTimer);
      galleryCache.cleanupTimer = null;
    }
    if (Array.isArray(galleryCache.items)) {
      galleryCache.items.length = 0;
    } else {
      galleryCache.items = [];
    }
    galleryCache.loaded = false;
    galleryCache.lastLoadTs = 0;
    galleryCache.loadingPromise = null;
    galleryCache.runId = null;
    galleryCache.scanState = null;
    galleryCache.inactiveAt = 0;
    galleryCache.paused = false;
    galleryCache.scrollTop = 0;
    galleryCache.scrollRestorePending = false;
    galleryCache.selectMode = false;
    if (galleryCache.selectedKeys instanceof Set) {
      galleryCache.selectedKeys.clear();
    } else {
      galleryCache.selectedKeys = new Set();
    }
    if (galleryThumbQueue.pending.length) {
      galleryThumbQueue.pending.length = 0;
    }
    try {
      const panel = document.getElementById('chat-history-panel');
      if (panel) {
        const galleryContent = panel.querySelector('.history-tab-content[data-tab="gallery"]');
        if (galleryContent) {
          clearGallerySelectionUI(galleryContent);
          if (galleryContent._galleryObserver) {
            galleryContent._galleryObserver.disconnect();
            galleryContent._galleryObserver = null;
          }
          if (galleryContent._galleryLazyObserver) {
            galleryContent._galleryLazyObserver.disconnect();
            galleryContent._galleryLazyObserver = null;
          }
          if (galleryContent._galleryFitLayoutRaf) {
            if (typeof cancelAnimationFrame === 'function') {
              cancelAnimationFrame(galleryContent._galleryFitLayoutRaf);
            }
            galleryContent._galleryFitLayoutRaf = null;
          }
          if (galleryContent._galleryFitResizeObserver) {
            try {
              galleryContent._galleryFitResizeObserver.disconnect();
            } catch (_) {}
            galleryContent._galleryFitResizeObserver = null;
          }
          if (galleryContent._galleryGroupMap instanceof Map) {
            galleryContent._galleryGroupMap.clear();
          }
          galleryContent._galleryGroupMap = null;
          revokeGalleryThumbUrls(galleryContent);
          galleryContent.dataset.rendered = '';
          const panelVisible = panel.classList.contains('visible');
          if (!panelVisible || !galleryContent.classList.contains('active')) {
            galleryContent.innerHTML = '';
          }
        }
      }
    } catch (_) {}
  }

  function invalidateSearchCache() {
    searchCache = createEmptySearchCache();
    searchCacheStore = new Map();
    try {
      const panel = document.getElementById('chat-history-panel');
      if (panel) removeSearchSummary(panel);
    } catch (_) {}
  }

  function resetGallerySelectionState() {
    galleryCache.selectMode = false;
    if (galleryCache.selectedKeys instanceof Set) {
      galleryCache.selectedKeys.clear();
    } else {
      galleryCache.selectedKeys = new Set();
    }
  }

  function clearGallerySelectionUI(container) {
    if (!container) return;
    container.dataset.gallerySelectMode = '';
    const domByKey = container._galleryDomByKey;
    if (domByKey instanceof Map) {
      domByKey.forEach((item) => {
        if (item?.classList) item.classList.remove('is-selected');
      });
      return;
    }
    try {
      container.querySelectorAll('.gallery-item.is-selected').forEach((item) => {
        item.classList.remove('is-selected');
      });
    } catch (_) {}
  }

  function normalizeGalleryRel(p) {
    return normalizePath(p || '').replace(/^\/+/, '').toLowerCase();
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

  function resolveImageUrlForGallery(imageUrlObj, downloadRoot) {
    if (!imageUrlObj) return '';
    const rawUrl = normalizeImageUrlCandidate(imageUrlObj.url);
    const relPath = normalizeImageUrlCandidate(imageUrlObj.path);
    if (isDirectImageUrl(rawUrl)) return rawUrl;
    if (isDirectImageUrl(relPath)) return relPath;
    if (relPath) {
      const fileUrl = downloadRoot ? buildFileUrlFromRelative(relPath, downloadRoot) : null;
      return fileUrl || relPath;
    }
    if (rawUrl) {
      const fileUrl = downloadRoot ? buildFileUrlFromRelative(rawUrl, downloadRoot) : null;
      return fileUrl || rawUrl;
    }
    return '';
  }

  function buildGalleryImageKey(imageUrlObj, resolvedUrl) {
    // 优先用相对路径做去重，避免分支对话重复图片反复出现
    const rawPath = typeof imageUrlObj?.path === 'string' ? imageUrlObj.path.trim() : '';
    if (rawPath) return `rel:${normalizeGalleryRel(rawPath)}`;
    const rawUrl = typeof imageUrlObj?.url === 'string' ? imageUrlObj.url.trim() : '';
    if (rawUrl.startsWith('file://')) {
      const rel = fileUrlToRelative(rawUrl);
      if (rel) return `rel:${normalizeGalleryRel(rel)}`;
    }
    if (resolvedUrl && resolvedUrl.startsWith('file://')) {
      const rel = fileUrlToRelative(resolvedUrl);
      if (rel) return `rel:${normalizeGalleryRel(rel)}`;
    }
    const fallback = rawUrl || resolvedUrl || '';
    return fallback ? `url:${fallback}` : '';
  }

  function restoreGalleryScrollIfNeeded(container) {
    if (!container || !galleryCache.scrollRestorePending) return;
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
    if (maxScroll <= 0) return;
    if (galleryCache.scrollTop <= maxScroll) {
      container.scrollTop = galleryCache.scrollTop;
      galleryCache.scrollRestorePending = false;
    }
  }

  function setupGalleryScrollTracking(container) {
    if (!container) return;
    if (container._galleryScrollListener) return;
    container._galleryScrollListener = () => {
      galleryCache.scrollTop = container.scrollTop;
    };
    container.addEventListener('scroll', container._galleryScrollListener, { passive: true });
  }

  function cancelGalleryCleanupTimer() {
    if (galleryCache.cleanupTimer) {
      clearTimeout(galleryCache.cleanupTimer);
      galleryCache.cleanupTimer = null;
    }
  }

  function clearGalleryCacheAfterInactive(panel) {
    const now = Date.now();
    const panelActive = panel && panel.classList.contains('visible');
    const activeTab = panelActive ? panel.querySelector('.history-tab.active')?.dataset?.tab : null;
    if (panelActive && activeTab === 'gallery') {
      galleryCache.inactiveAt = 0;
      return;
    }
    if (galleryCache.inactiveAt && (now - galleryCache.inactiveAt < GALLERY_INACTIVE_CLEANUP_MS)) {
      return;
    }
    invalidateGalleryCache();
  }

  function scheduleGalleryCleanup(panel) {
    cancelGalleryCleanupTimer();
    galleryCache.inactiveAt = Date.now();
    galleryCache.cleanupTimer = setTimeout(() => {
      const panelNow = panel || document.getElementById('chat-history-panel');
      clearGalleryCacheAfterInactive(panelNow);
    }, GALLERY_INACTIVE_CLEANUP_MS);
  }

  function markGalleryInactive(panel) {
    galleryCache.paused = true;
    const galleryContent = panel?.querySelector('.history-tab-content[data-tab="gallery"]');
    if (galleryContent) {
      galleryCache.scrollTop = galleryContent.scrollTop;
      clearGallerySelectionUI(galleryContent);
    }
    resetGallerySelectionState();
    scheduleGalleryCleanup(panel);
  }

  function markGalleryActive(panel, container) {
    cancelGalleryCleanupTimer();
    galleryCache.inactiveAt = 0;
    galleryCache.paused = false;
    if (container) {
      setupGalleryScrollTracking(container);
      if (galleryCache.scrollTop > 0) {
        galleryCache.scrollRestorePending = true;
        requestAnimationFrame(() => restoreGalleryScrollIfNeeded(container));
      }
    }
    scheduleGalleryThumbDrain();
  }

  function scheduleGalleryThumbDrain() {
    if (galleryThumbQueue.scheduled) return;
    galleryThumbQueue.scheduled = true;
    const run = () => {
      galleryThumbQueue.scheduled = false;
      drainGalleryThumbQueue();
    };
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: 240 });
    } else {
      setTimeout(run, 0);
    }
  }

  function drainGalleryThumbQueue() {
    if (galleryCache.paused) return;
    while (galleryThumbQueue.active < GALLERY_THUMB_CONCURRENCY && galleryThumbQueue.pending.length > 0) {
      const item = galleryThumbQueue.pending.shift();
      if (!item) break;
      galleryThumbQueue.active += 1;
      Promise.resolve()
        .then(item.task)
        .catch(() => null)
        .finally(() => {
          galleryThumbQueue.active = Math.max(0, galleryThumbQueue.active - 1);
          if (typeof item.resolve === 'function') item.resolve();
          drainGalleryThumbQueue();
        });
    }
  }

  function enqueueGalleryThumbTask(task) {
    if (typeof task !== 'function') return Promise.resolve();
    return new Promise((resolve) => {
      galleryThumbQueue.pending.push({ task, resolve });
      scheduleGalleryThumbDrain();
    });
  }

  function getGalleryThumbTargetSpec(img) {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const base = Math.round((img?.clientWidth || GALLERY_THUMB_MIN_EDGE) * dpr);
    return {
      maxEdge: Math.max(GALLERY_THUMB_MIN_EDGE, Math.min(GALLERY_THUMB_MAX_EDGE, base || GALLERY_THUMB_MIN_EDGE)),
      // 保证缩略图短边不小于指定像素，避免横/竖图过糊。
      minEdge: Math.max(1, Math.round(GALLERY_THUMB_MIN_PREVIEW_EDGE * dpr))
    };
  }

  function getGalleryThumbRootMargin(container) {
    // 按“可视高度 * 预加载倍数”计算像素值，确保提前加载进入视口前的缩略图。
    const height = Math.max(1, Number(container?.clientHeight) || Number(window?.innerHeight) || 800);
    const margin = Math.max(200, Math.round(height * GALLERY_THUMB_PREFETCH_VIEWPORTS));
    return `${margin}px 0px`;
  }

  function getGalleryRenderRootMargin(container) {
    // 提前渲染更多 DOM，避免滚动到底部时才生成占位图。
    const height = Math.max(1, Number(container?.clientHeight) || Number(window?.innerHeight) || 800);
    const margin = Math.max(240, Math.round(height * GALLERY_RENDER_PREFETCH_VIEWPORTS));
    return `${margin}px 0px`;
  }

  function setGalleryItemAspectRatio(item, ratio) {
    if (!item) return null;
    const raw = Number(ratio);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const clamped = Math.min(4, Math.max(0.25, raw));
    const prev = Number(item.dataset.aspectRatio || 0);
    if (Number.isFinite(prev) && Math.abs(prev - clamped) < 0.01) return clamped;
    item.dataset.aspectRatio = clamped.toFixed(4);
    return clamped;
  }

  function getGalleryItemAspectRatio(item) {
    if (!item) return 1;
    const cached = Number(item.dataset.aspectRatio || 0);
    if (Number.isFinite(cached) && cached > 0) return cached;
    const img = item.querySelector('img');
    const width = Number(img?.naturalWidth || 0);
    const height = Number(img?.naturalHeight || 0);
    if (width > 0 && height > 0) {
      return Math.min(4, Math.max(0.25, width / height));
    }
    return 1;
  }

  function flattenGalleryGroupGrid(groupGrid) {
    if (!groupGrid) return;
    const items = Array.from(groupGrid.querySelectorAll('.gallery-item'));
    if (!items.length) {
      groupGrid.innerHTML = '';
      return;
    }
    const frag = document.createDocumentFragment();
    items.forEach((item) => {
      item.style.width = '';
      item.style.height = '';
      item.style.flex = '';
      frag.appendChild(item);
    });
    groupGrid.innerHTML = '';
    groupGrid.appendChild(frag);
  }

  function layoutGalleryGroupFit(groupGrid) {
    if (!groupGrid) return;
    const items = Array.from(groupGrid.querySelectorAll('.gallery-item'));
    if (!items.length) return;
    const containerWidth = Math.max(0, groupGrid.clientWidth);
    if (!containerWidth) return;

    // 按目标高度累加宽度，超过容器宽度后回算行高，实现“铺满”效果。
    const targetHeight = Math.max(1, Math.round(Number(galleryCache.thumbSize) || GALLERY_THUMB_SIZE_DEFAULT));
    const minHeight = Math.max(1, Math.round(targetHeight * GALLERY_FIT_ROW_MIN_SCALE));
    const maxHeight = Math.max(minHeight, Math.round(targetHeight * GALLERY_FIT_ROW_MAX_SCALE));
    const gap = GALLERY_FIT_GAP;

    const frag = document.createDocumentFragment();
    let rowItems = [];
    let rowRatio = 0;

    const flushRow = (row, height, { justify = true } = {}) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'gallery-fit-row';
      const safeHeight = Math.max(1, Math.round(height));
      const availableWidth = Math.max(1, containerWidth - gap * Math.max(0, row.length - 1));
      const widths = row.map((entry) => Math.max(1, Math.round(entry.ratio * safeHeight)));
      if (justify && row.length > 0) {
        const used = widths.reduce((sum, value) => sum + value, 0);
        const diff = availableWidth - used;
        if (Math.abs(diff) >= 1) {
          widths[widths.length - 1] = Math.max(1, widths[widths.length - 1] + diff);
        }
      }
      row.forEach((entry, index) => {
        const width = widths[index];
        entry.item.style.width = `${width}px`;
        entry.item.style.height = `${safeHeight}px`;
        entry.item.style.flex = '0 0 auto';
        rowEl.appendChild(entry.item);
      });
      frag.appendChild(rowEl);
    };

    for (const item of items) {
      const ratio = getGalleryItemAspectRatio(item);
      rowItems.push({ item, ratio });
      rowRatio += ratio;
      const rowWidthAtTarget = rowRatio * targetHeight + gap * Math.max(0, rowItems.length - 1);
      if (rowWidthAtTarget >= containerWidth && rowItems.length > 0) {
        let rowHeight = (containerWidth - gap * Math.max(0, rowItems.length - 1)) / rowRatio;
        if (rowHeight < minHeight && rowItems.length > 1) {
          const last = rowItems.pop();
          rowRatio -= last.ratio;
          rowHeight = rowRatio > 0
            ? (containerWidth - gap * Math.max(0, rowItems.length - 1)) / rowRatio
            : targetHeight;
          flushRow(rowItems, Math.max(minHeight, Math.min(maxHeight, rowHeight)), { justify: true });
          rowItems = [last];
          rowRatio = last.ratio;
        } else {
          flushRow(rowItems, Math.max(minHeight, Math.min(maxHeight, rowHeight)), { justify: true });
          rowItems = [];
          rowRatio = 0;
        }
      }
    }

    if (rowItems.length) {
      const availableWidth = containerWidth - gap * Math.max(0, rowItems.length - 1);
      let rowHeight = rowRatio > 0 ? (availableWidth / rowRatio) : targetHeight;
      rowHeight = Math.min(targetHeight, rowHeight);
      flushRow(rowItems, rowHeight, { justify: false });
    }

    groupGrid.innerHTML = '';
    groupGrid.appendChild(frag);
  }

  function applyGalleryFitLayout(container, targetGrids = null) {
    if (!container) return;
    const list = Array.isArray(targetGrids)
      ? targetGrids.filter(Boolean)
      : (targetGrids ? [targetGrids] : null);
    if (list && list.length) {
      list.forEach((grid) => layoutGalleryGroupFit(grid));
      return;
    }
    const grids = container.querySelectorAll('.gallery-group-grid');
    grids.forEach((grid) => layoutGalleryGroupFit(grid));
  }

  function scheduleGalleryFitLayout(container, options = {}) {
    if (!container || galleryCache.layoutMode !== 'fit') return;
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const force = !!normalizedOptions.force;
    const targetGrids = normalizedOptions.targetGrids || normalizedOptions.targetGrid || null;
    const targetList = Array.isArray(targetGrids)
      ? targetGrids.filter(Boolean)
      : (targetGrids ? [targetGrids] : null);

    if (targetList && targetList.length && !force) {
      // 只标记当前新增的分组，避免旧分组反复重排导致闪烁。
      if (!container._galleryFitDirtyGrids) {
        container._galleryFitDirtyGrids = new Set();
      }
      targetList.forEach((grid) => container._galleryFitDirtyGrids.add(grid));
    } else if (force && container._galleryFitDirtyGrids) {
      container._galleryFitDirtyGrids.clear();
    }

    if (container._galleryFitLayoutRaf) {
      if (!force) return;
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(container._galleryFitLayoutRaf);
      }
      container._galleryFitLayoutRaf = null;
    }
    if (typeof requestAnimationFrame !== 'function') {
      applyGalleryFitLayout(container);
      return;
    }
    container._galleryFitLayoutRaf = requestAnimationFrame(() => {
      container._galleryFitLayoutRaf = null;
      if (!container.isConnected) return;
      if (galleryCache.layoutMode !== 'fit') return;
      let grids = null;
      if (!force && container._galleryFitDirtyGrids && container._galleryFitDirtyGrids.size) {
        grids = Array.from(container._galleryFitDirtyGrids);
        container._galleryFitDirtyGrids.clear();
      }
      applyGalleryFitLayout(container, grids);
    });
  }

  function setupGalleryFitResizeObserver(container) {
    if (!container || container._galleryFitResizeObserver) return;
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => {
      scheduleGalleryFitLayout(container, { force: true });
    });
    observer.observe(container);
    container._galleryFitResizeObserver = observer;
  }

  function teardownGalleryFitResizeObserver(container) {
    if (!container || !container._galleryFitResizeObserver) return;
    try {
      container._galleryFitResizeObserver.disconnect();
    } catch (_) {}
    container._galleryFitResizeObserver = null;
  }

  function isGifImageReference(imageUrlObj, resolvedUrl) {
    const mime = String(imageUrlObj?.mimeType || imageUrlObj?.mime_type || '').toLowerCase();
    if (mime.includes('gif')) return true;
    const candidates = [imageUrlObj?.path, imageUrlObj?.url, resolvedUrl].filter(Boolean);
    return candidates.some((value) => {
      const lower = String(value).toLowerCase();
      if (lower.startsWith('data:image/gif')) return true;
      const clean = lower.split('#')[0].split('?')[0];
      return clean.endsWith('.gif');
    });
  }

  function revokeGalleryThumbUrls(container) {
    if (!container) return;
    try {
      const imgs = container.querySelectorAll('img[data-thumb-url]');
      imgs.forEach((img) => {
        const url = img?.dataset?.thumbUrl || '';
        if (url && url.startsWith('blob:')) {
          URL.revokeObjectURL(url);
        }
      });
    } catch (_) {}
  }

  function getGalleryThumbWorkerCount() {
    const cores = Number((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4);
    const half = Math.max(1, Math.floor(cores / 2));
    return Math.max(1, Math.min(4, Math.min(GALLERY_THUMB_CONCURRENCY, half)));
  }

  function shouldUseGalleryThumbWorker(sourceUrl) {
    if (!galleryThumbWorkerPool.available) return false;
    if (!sourceUrl) return false;
    if (galleryThumbWorkerPool.fileUrlSupported === false && sourceUrl.startsWith('file://')) return false;
    return true;
  }

  function trackGalleryThumbWorkerFileResult(url, ok, error) {
    if (!url || !url.startsWith('file://')) return;
    if (ok) {
      galleryThumbWorkerPool.fileUrlSupported = true;
      galleryThumbWorkerPool.fileUrlFailures = 0;
      return;
    }
    if (error === 'fetch') {
      galleryThumbWorkerPool.fileUrlFailures += 1;
      if (galleryThumbWorkerPool.fileUrlFailures >= 3 && galleryThumbWorkerPool.fileUrlSupported !== true) {
        galleryThumbWorkerPool.fileUrlSupported = false;
      }
    }
  }

  function markGalleryThumbWorkerUnavailable() {
    if (!galleryThumbWorkerPool.available) return;
    galleryThumbWorkerPool.available = false;
    if (Array.isArray(galleryThumbWorkerPool.workers)) {
      galleryThumbWorkerPool.workers.forEach((worker) => {
        try {
          worker.terminate();
        } catch (_) {}
      });
    }
    galleryThumbWorkerPool.workers = null;
    if (galleryThumbWorkerPool.pending.size) {
      galleryThumbWorkerPool.pending.forEach((pending) => {
        pending.resolve({ blob: null, error: 'worker_failed' });
      });
      galleryThumbWorkerPool.pending.clear();
    }
  }

  function handleGalleryThumbWorkerMessage(event) {
    const data = event?.data || {};
    const id = data.id;
    if (!id) return;
    const pending = galleryThumbWorkerPool.pending.get(id);
    if (!pending) return;
    galleryThumbWorkerPool.pending.delete(id);
    if (!data.ok) {
      trackGalleryThumbWorkerFileResult(pending.url, false, data.error);
      if (data.error === 'unsupported') {
        markGalleryThumbWorkerUnavailable();
      }
      pending.resolve({ blob: null, error: data.error || 'unknown', status: data.status || 0 });
      return;
    }
    trackGalleryThumbWorkerFileResult(pending.url, true);
    const buffer = data.buffer;
    const mime = data.mime || 'image/jpeg';
    const blob = buffer ? new Blob([buffer], { type: mime }) : null;
    pending.resolve({ blob, error: null });
  }

  function handleGalleryThumbWorkerError() {
    markGalleryThumbWorkerUnavailable();
  }

  function ensureGalleryThumbWorkers() {
    if (!galleryThumbWorkerPool.available) return null;
    if (Array.isArray(galleryThumbWorkerPool.workers) && galleryThumbWorkerPool.workers.length) {
      return galleryThumbWorkerPool.workers;
    }
    const count = getGalleryThumbWorkerCount();
    if (count <= 0) {
      galleryThumbWorkerPool.available = false;
      return null;
    }
    try {
      const workerUrl = new URL('./workers/gallery_thumb_worker.js', import.meta.url);
      const workers = [];
      for (let i = 0; i < count; i++) {
        const worker = new Worker(workerUrl);
        worker.onmessage = handleGalleryThumbWorkerMessage;
        worker.onerror = handleGalleryThumbWorkerError;
        workers.push(worker);
      }
      galleryThumbWorkerPool.workers = workers;
      return workers;
    } catch (_) {
      galleryThumbWorkerPool.available = false;
      return null;
    }
  }

  function requestGalleryThumbFromWorker(sourceUrl, targetSpec) {
    if (!sourceUrl) return Promise.resolve({ blob: null, error: 'invalid' });
    const size = Number(targetSpec?.maxEdge || 0);
    const minEdge = Number(targetSpec?.minEdge || 0);
    if (!size && !minEdge) return Promise.resolve({ blob: null, error: 'invalid' });
    const workers = ensureGalleryThumbWorkers();
    if (!workers || !workers.length) return Promise.resolve({ blob: null, error: 'unavailable' });
    return new Promise((resolve) => {
      const id = ++galleryThumbWorkerPool.seq;
      const worker = workers[galleryThumbWorkerPool.nextIndex % workers.length];
      galleryThumbWorkerPool.nextIndex = (galleryThumbWorkerPool.nextIndex + 1) % workers.length;
      galleryThumbWorkerPool.pending.set(id, { resolve, url: sourceUrl });
      try {
        worker.postMessage({
          id,
          url: sourceUrl,
          size,
          minEdge,
          quality: GALLERY_THUMB_QUALITY
        });
      } catch (_) {
        galleryThumbWorkerPool.pending.delete(id);
        resolve({ blob: null, error: 'post' });
      }
    });
  }

  function canvasToBlobSafe(canvas, type, quality) {
    return new Promise((resolve) => {
      try {
        if (canvas && typeof canvas.convertToBlob === 'function') {
          canvas.convertToBlob({ type, quality }).then(resolve).catch(() => resolve(null));
          return;
        }
        if (!canvas || typeof canvas.toBlob !== 'function') {
          resolve(null);
          return;
        }
        canvas.toBlob((blob) => resolve(blob || null), type, quality);
      } catch (_) {
        resolve(null);
      }
    });
  }

  async function generateGalleryThumbUrl(sourceUrl, targetSpec) {
    if (!sourceUrl) return null;
    if (shouldUseGalleryThumbWorker(sourceUrl)) {
      const result = await requestGalleryThumbFromWorker(sourceUrl, targetSpec);
      if (result?.blob) {
        return URL.createObjectURL(result.blob);
      }
    }
    return generateGalleryThumbUrlOnMain(sourceUrl, targetSpec);
  }

  async function generateGalleryThumbUrlOnMain(sourceUrl, targetSpec) {
    if (!sourceUrl) return null;
    try {
      const maxEdge = Number(targetSpec?.maxEdge || 0);
      const minEdge = Number(targetSpec?.minEdge || 0);
      if (!maxEdge && !minEdge) return null;
      const img = await new Promise((resolve) => {
        const image = new Image();
        image.decoding = 'async';
        image.crossOrigin = 'anonymous';
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = sourceUrl;
      });
      if (!img || !img.naturalWidth || !img.naturalHeight) return null;

      const maxSide = Math.max(img.naturalWidth, img.naturalHeight);
      const minSide = Math.min(img.naturalWidth, img.naturalHeight);
      const scaleByMax = maxEdge > 0 && maxSide > 0 ? (maxEdge / maxSide) : 0;
      const scaleByMin = minEdge > 0 && minSide > 0 ? (minEdge / minSide) : 0;
      const scale = Math.max(scaleByMax, scaleByMin, 0);
      if (!Number.isFinite(scale) || scale <= 0) return null;
      const targetWidth = Math.max(1, Math.round(img.naturalWidth * scale));
      const targetHeight = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

      const blob = await canvasToBlobSafe(canvas, 'image/jpeg', GALLERY_THUMB_QUALITY);
      if (!blob) return null;
      return URL.createObjectURL(blob);
    } catch (_) {
      return null;
    }
  }

  function invalidateTrendStatsCache() {
    trendStatsCache.data = null;
    trendStatsCache.time = 0;
    trendStatsCache.promise = null;
  }

  function invalidateMetadataCache(options = {}) {
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const skipGallery = !!normalizedOptions.skipGallery;
    metaCache.data = null;
    metaCache.time = 0;
    metaCache.promise = null;
    if (!skipGallery) invalidateGalleryCache();
    invalidateSearchCache();
    invalidateTrendStatsCache();
  }

  /**
   * 归一化单条消息的思考内容：提取 <think> 段落到 thoughtsRaw，避免正文携带隐藏思考。
   * @param {Object} msg - 聊天消息对象
   * @returns {Object} 处理后的消息对象
   */
  function normalizeThinkingForMessage(msg) {
    if (!msg) return msg;
    if (typeof msg.content === 'string') {
      const thinkExtraction = extractThinkingFromText(msg.content);
      if (thinkExtraction.thoughtText) {
        msg.thoughtsRaw = mergeThoughts(msg.thoughtsRaw, thinkExtraction.thoughtText);
        msg.content = thinkExtraction.cleanText;
      }
    }
    return msg;
  }

  /**
   * 批量移除推理签名（thoughtSignature / thoughtSignatureSource），避免落库或备份体积膨胀
   * @param {Array<any>} messages
   * @returns {{ changed: boolean, removedMessages: number }}
   */
  function removeThoughtSignatureFromMessages(messages) {
    const list = Array.isArray(messages) ? messages : [];
    let changed = false;
    let removedMessages = 0;
    for (const msg of list) {
      if (!msg || typeof msg !== 'object') continue;
      const hasSignature = msg.thoughtSignature !== undefined || msg.thoughtSignatureSource !== undefined;
      if (msg.thoughtSignature !== undefined) {
        delete msg.thoughtSignature;
        changed = true;
      }
      if (msg.thoughtSignatureSource !== undefined) {
        delete msg.thoughtSignatureSource;
        changed = true;
      }
      if (hasSignature) removedMessages += 1;
    }
    return { changed, removedMessages };
  }

  async function getAllConversationMetadataWithCache(forceUpdate = false) {
    const stale = forceUpdate || !metaCache.data || (Date.now() - metaCache.time > META_CACHE_TTL);
    if (!stale) return metaCache.data;

    // 并发去重：同一时间只允许一次“全量元数据”加载，避免打开面板预热 + 输入搜索同时触发两次全量扫描。
    if (metaCache.promise) {
      try {
        return await metaCache.promise;
      } catch (_) {
        // 若之前的 promise 失败，则允许继续走下面的重新加载逻辑。
      }
    }

    metaCache.promise = (async () => {
      const data = await getAllConversationMetadata();
      metaCache.data = data;
      metaCache.time = Date.now();
      return data;
    })();

    try {
      return await metaCache.promise;
    } finally {
      metaCache.promise = null;
    }
  }

  function scheduleConversationMetadataWarmup(panel) {
    // 说明：
    // - 默认历史列表走 paged 模式，首屏速度快，但“第一次全文搜索”需要全量元数据；
    // - 这里用 idle/延迟的方式预热元数据，降低用户输入后的启动延迟。
    try {
      if (!panel || !panel.classList.contains('visible')) return;
    } catch (_) {
      return;
    }

    // 已有缓存/正在加载则不重复预热
    if (metaCache.data || metaCache.promise) return;

    const runWarmup = async () => {
      try {
        await getAllConversationMetadataWithCache(false);
      } catch (_) {}
    };

    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => {
        try {
          if (!panel.classList.contains('visible')) return;
        } catch (_) {
          return;
        }
        if (metaCache.data || metaCache.promise) return;
        runWarmup();
      }, { timeout: 1200 });
    } else {
      setTimeout(() => {
        try {
          if (!panel.classList.contains('visible')) return;
        } catch (_) {
          return;
        }
        if (metaCache.data || metaCache.promise) return;
        runWarmup();
      }, 600);
    }
  }

  // --- 任务令牌（运行ID）用于取消过期的加载流程 ---
  function createRunId() {
    return `run_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }

  // --- 面板样式注入 & 骨架屏与哨兵 ---
  let historyStylesInjected = false;
  function ensurePanelStylesInjected() {
    if (historyStylesInjected) return;
    const style = document.createElement('style');
    style.id = 'chat-history-enhanced-styles';
    style.textContent = `
#chat-history-list {
  content-visibility: auto;
  contain-intrinsic-size: 1000px 600px;
}
.skeleton-item {
  padding: 6px 0;
  border-bottom: 1px solid var(--cerebr-border-color);
  animation: skeletonPulse 1.2s ease-in-out infinite;
}
.skeleton-title, .skeleton-sub, .skeleton-group-label {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--cerebr-control-bg) 72%, transparent) 25%,
    color-mix(in srgb, var(--cerebr-control-bg-hover) 88%, transparent) 37%,
    color-mix(in srgb, var(--cerebr-control-bg) 72%, transparent) 63%
  );
  background-size: 400% 100%;
  border-radius: 6px;
}
.skeleton-title { height: 14px; width: 72%; margin-bottom: 8px; }
.skeleton-sub { height: 11px; width: 52%; }
.skeleton-group-label { height: 12px; width: 120px; margin: 10px 0 6px; opacity: 0.85; }
@keyframes skeletonPulse {
  0% { opacity: .7 }
  50% { opacity: 1 }
  100% { opacity: .7 }
}
.end-sentinel { height: 1px; width: 100%; }

/* --- 分支会话树状视图（仅影响历史面板）---
 * 说明：
 * - 树状视图只在“无筛选”时启用树排序；这里仅提供缩进与引导线的视觉样式；
 * - 缩进层级由 JS 写入 --branch-depth（见 createConversationItemElement）。
 */
#chat-history-panel[data-branch-view-mode="tree"] .chat-history-item {
  --branch-depth: 0;
}

#chat-history-panel[data-branch-view-mode="tree"] .chat-history-item.branch-tree-child {
  position: relative;
  padding-left: calc((var(--branch-depth) * 14px) + 8px);
}

#chat-history-panel[data-branch-view-mode="tree"] .chat-history-item.branch-tree-child::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: calc(var(--branch-depth) * 14px);
  background-image: repeating-linear-gradient(
    to right,
    color-mix(in srgb, var(--cerebr-border-color) 45%, transparent) 0,
    color-mix(in srgb, var(--cerebr-border-color) 45%, transparent) 1px,
    transparent 1px,
    transparent 14px
  );
  pointer-events: none;
  opacity: 0.7;
}

#chat-history-panel[data-branch-view-mode="tree"] .chat-history-item.branch-tree-child::after {
  content: '↳';
  position: absolute;
  left: calc((var(--branch-depth) * 14px) - 10px);
  top: 7px;
  font-size: 12px;
  line-height: 1;
  color: var(--cerebr-text-color);
  opacity: 0.65;
  pointer-events: none;
}

/* 非树状模式下：对“分支会话”给一个轻量提示（不改结构，只提示有父会话） */
#chat-history-panel .chat-history-item.forked-conversation .summary::before {
  content: '↳ ';
  opacity: 0.65;
  font-weight: normal;
}
#chat-history-panel[data-branch-view-mode="tree"] .chat-history-item.forked-conversation .summary::before {
  content: '';
}
#chat-history-panel .chat-history-item.forked-orphan .summary::before {
  content: '↳? ';
}
`;
    document.head.appendChild(style);
    historyStylesInjected = true;
  }

  function renderSkeleton(container, count = 10) {
    const frag = document.createDocumentFragment();
    // 根据可视高度估算骨架条数，让占位更接近真实列表长度
    const approxItemHeight = 44;
    const viewHeight = container?.clientHeight || 0;
    const targetCount = Math.max(count, viewHeight ? Math.ceil(viewHeight / approxItemHeight) : count);
    const label = document.createElement('div');
    label.className = 'skeleton-group-label';
    frag.appendChild(label);
    for (let i = 0; i < targetCount; i++) {
      const sk = document.createElement('div');
      sk.className = 'skeleton-item';
      sk.innerHTML = '<div class="skeleton-title"></div><div class="skeleton-sub"></div>';
      frag.appendChild(sk);
    }
    container.appendChild(frag);
  }

  function removeSkeleton(container) {
    container.querySelectorAll('.skeleton-item, .skeleton-group-label').forEach(n => n.remove());
  }

  function ensureEndSentinel(container) {
    let sentinel = container.querySelector('.end-sentinel');
    if (!sentinel) {
      sentinel = document.createElement('div');
      sentinel.className = 'end-sentinel';
      container.appendChild(sentinel);
    }
    return sentinel;
  }

  function setupEndSentinelObserver(panel, container, onIntersect, runId) {
    if (panel._ioObserver) {
      panel._ioObserver.disconnect();
    }
    const sentinel = ensureEndSentinel(container);
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry || !entry.isIntersecting) return;
      if (panel.dataset.runId !== runId) return;
      onIntersect();
    }, { root: container, rootMargin: '0px 0px 1000px 0px', threshold: 0.01 });
    observer.observe(sentinel);
    panel._ioObserver = observer;
  }

  function cleanupHistoryPanel(panel) {
    try {
      const listContainer = panel.querySelector('#chat-history-list');
      if (listContainer && listContainer._scrollListener) {
        listContainer.removeEventListener('scroll', listContainer._scrollListener);
        listContainer._scrollListener = null;
      }
      const galleryContent = panel.querySelector('.history-tab-content[data-tab="gallery"]');
      if (galleryContent && galleryContent._galleryScrollListener) {
        galleryContent.removeEventListener('scroll', galleryContent._galleryScrollListener);
        galleryContent._galleryScrollListener = null;
      }
      if (galleryContent && galleryContent._galleryFitLayoutRaf) {
        if (typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(galleryContent._galleryFitLayoutRaf);
        }
        galleryContent._galleryFitLayoutRaf = null;
      }
      if (galleryContent && galleryContent._galleryFitResizeObserver) {
        try {
          galleryContent._galleryFitResizeObserver.disconnect();
        } catch (_) {}
        galleryContent._galleryFitResizeObserver = null;
      }
      if (panel._ioObserver) {
        panel._ioObserver.disconnect();
        panel._ioObserver = null;
      }
      const menu = document.getElementById('chat-history-context-menu');
      if (menu) menu.remove();
      panel.dataset.runId = '';
    } catch (e) {
      console.warn('清理面板异常:', e);
    }
  }

  // --- Infinite Scroll/Batch Rendering State ---
  const BATCH_SIZE = 100; // 每批加载的项目数
  // 默认视图性能优化：首次只取“置顶 + 最近 50 条（非置顶）”，后续按需再分页追加
  const INITIAL_UNPINNED_LOAD_LIMIT = 50;
  const PAGED_UNPINNED_LOAD_SIZE = 100;
  // 搜索框输入防抖（越小越敏捷，但会更频繁触发全文扫描；runId 取消机制会兜底避免旧任务污染 UI）
  const HISTORY_SEARCH_DEBOUNCE_MS = 80;
  let currentDisplayItems = []; // 当前筛选和排序后的所有项目
  let currentlyRenderedCount = 0; // 已渲染的项目数量
  let isLoadingMoreItems = false; // 防止并发加载的标志
  let currentGroupLabelForBatchRender = null; // 跨批次跟踪“分组 key”（默认按日期；URL 模式按匹配等级）
  let currentPinnedItemsCountInDisplay = 0; // 当前显示列表中“置顶分段”包含的条目数（树状模式下是“树级置顶”，可能包含未置顶的祖先节点）

  // --- 置顶功能相关 ---
  const PINNED_STORAGE_KEY = 'pinnedConversationIds';

  /**
   * 获取已置顶的对话ID列表
   * @returns {Promise<string[]>} 置顶ID数组
   */
  async function getPinnedIds() {
    try {
      const result = await chrome.storage.sync.get([PINNED_STORAGE_KEY]);
      return result[PINNED_STORAGE_KEY] || [];
    } catch (error) {
      console.error('获取置顶 ID 失败:', error);
      return [];
    }
  }

  /**
   * 保存置顶对话ID列表
   * @param {string[]} ids - 要保存的置顶ID数组
   * @returns {Promise<void>}
   */
  async function setPinnedIds(ids) {
    try {
      await queueStorageSet('sync', { [PINNED_STORAGE_KEY]: ids }, { flush: 'now' });
    } catch (error) {
      console.error('保存置顶 ID 失败:', error);
    }
  }

  /**
   * 置顶一个对话
   * @param {string} id - 要置顶的对话ID
   * @returns {Promise<void>}
   */
  async function pinConversation(id) {
    const pinnedIds = await getPinnedIds();
    if (!pinnedIds.includes(id)) {
      pinnedIds.push(id);
      await setPinnedIds(pinnedIds);
    }
  }

  /**
   * 取消置顶一个对话
   * @param {string} id - 要取消置顶的对话ID
   * @returns {Promise<void>}
   */
  async function unpinConversation(id) {
    let pinnedIds = await getPinnedIds();
    if (pinnedIds.includes(id)) {
      pinnedIds = pinnedIds.filter(pinnedId => pinnedId !== id);
      await setPinnedIds(pinnedIds);
    }
  }
  // --- 置顶功能结束 ---

  /**
   * 删除会话记录并同步清理缓存、状态
   * @param {string} conversationId - 要删除的会话ID
   * @returns {Promise<void>}
   */
  async function deleteConversationRecord(conversationId) {
    if (!conversationId) return;
    const restoreOptions = getHistoryListScrollRestoreOptions();
    try {
      await deleteConversation(conversationId);
    } catch (error) {
      console.error('删除会话记录失败:', error);
    }

    try {
      await unpinConversation(conversationId);
    } catch (error) {
      console.error('取消会话置顶失败:', error);
    }

    if (loadedConversations.has(conversationId)) {
      loadedConversations.delete(conversationId);
    }
    if (activeConversation?.id === conversationId) {
      activeConversation = null;
      activeConversationApiLock = null;
    }

    if (currentConversationId === conversationId) {
      currentConversationId = null;
      services.messageSender.setCurrentConversationId(null);
      services.selectionThreadManager?.resetForClearChat?.();
      services.chatHistoryManager.clearHistory();
      chatContainer.innerHTML = '';
      clearThreadOverviewDrawer();
      emitConversationApiContextChanged();
    }

    invalidateMetadataCache();
    const removedInView = removeHistoryListItemFromView(conversationId);
    if (!removedInView) {
      refreshChatHistory(restoreOptions);
    }
  }

  /**
   * 提取消息的纯文本内容
   * @param {Object} msg - 消息对象
   * @returns {string} 纯文本内容
   */
  function extractPlainTextFromMessageContent(content) {
    return extractPlainTextFromMessageContentShared(content);
  }

  function extractMessagePlainText(msg) {
    return extractMessagePlainTextShared(msg, { includeHiddenThreadSelection: true });
  }

  /**
   * 纯函数：统计会话的消息数量结构（主对话/线程）。
   * @param {Array<Object>} messages
   * @returns {{totalCount:number, mainMessageCount:number, threadMessageCount:number, threadCount:number}}
   */
  function computeConversationMessageStats(messages) {
    return computeConversationMessageStatsShared(messages);
  }

  function applyConversationMessageStats(conversation) {
    if (!conversation || !Array.isArray(conversation.messages)) return null;
    const stats = computeConversationMessageStats(conversation.messages);
    conversation.messageCount = stats.totalCount;
    conversation.mainMessageCount = stats.mainMessageCount;
    conversation.threadMessageCount = stats.threadMessageCount;
    conversation.threadCount = stats.threadCount;
    return stats;
  }

  function resolveSearchScope(textPlan) {
    return resolveSearchScopeShared(textPlan);
  }

  /**
   * 创建“全文搜索取消检查器”。
   *
   * 说明：
   * - 搜索是长任务；用户每次输入都会触发新一轮 runId；
   * - 旧任务必须尽快退出，否则会造成无谓的 IndexedDB 读取与 UI 抖动。
   *
   * @param {HTMLElement} panel
   * @param {string} runId
   * @returns {() => boolean} 返回 true 表示本轮任务已取消
   */
  function createSearchCancelledChecker(panel, runId) {
    return () => panel?.dataset?.runId !== runId;
  }

  function countRegexMatches(sourceText, regex) {
    if (!sourceText || !regex) return 0;
    let count = 0;
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(sourceText)) !== null) {
      count += 1;
      if (match[0].length === 0) regex.lastIndex += 1;
    }
    return count;
  }

  /**
   * 全文搜索（阶段1）：仅扫描 conversations 记录内联 messages 的文本内容。
   *
   * 返回值约定：
   * - matched=true：matchInfo 已包含 excerpts，可直接使用；
   * - matched=false：表示内联文本未命中。
   *
   * @param {Object} conversation
   * @param {{positiveLower:string[], negativeLower:string[], highlightLower:string[], hasPositive:boolean, hasNegative:boolean}} textPlan
   * @param {string[]|null} remainingTerms - 元数据命中后仍需匹配的正向关键词（小写）
   * @param {() => boolean} isCancelled
   * @returns {{ cancelled: boolean, matched: boolean, blocked: boolean, matchInfo: {messageId:string|null, excerpts:Array<Object>, reason:string, totalHitCount:number, matchedMessageCount:number}, remainingTerms: string[] }}
   */
  function scanConversationInlineMessagesForMatch(conversation, textPlan, remainingTerms, isCancelled) {
    const sharedResult = scanConversationMessagesForSearchShared(
      conversation,
      textPlan,
      remainingTerms,
      {
        includeHiddenThreadSelection: true,
        isCancelled
      }
    );
    const sharedMatchInfo = sharedResult?.matchInfo || {};
    const highlightTerms = Array.isArray(textPlan?.highlightLower) ? textPlan.highlightLower : [];
    const matchInfo = {
      messageId: sharedMatchInfo.messageId || null,
      excerpts: [],
      reason: sharedMatchInfo.reason || 'message',
      totalHitCount: Number(sharedMatchInfo.totalHitCount) || 0,
      matchedMessageCount: Number(sharedMatchInfo.matchedMessageCount) || 0
    };

    for (const item of Array.isArray(sharedMatchInfo.matchedMessages) ? sharedMatchInfo.matchedMessages : []) {
      const preview = buildMessagePreviewExcerpt(item?.plainText || '', highlightTerms, SEARCH_RESULT_SNIPPET_CONTEXT_LENGTH);
      if (!preview) continue;
      preview.messageId = item?.messageId || null;
      preview.messageIndex = Number.isFinite(Number(item?.rawMessageIndex))
        ? Number(item.rawMessageIndex)
        : matchInfo.excerpts.length;
      preview.hitCount = Math.max(0, Number(item?.hitCount || 0));
      matchInfo.excerpts.push(preview);
    }

    sortSearchSnippetExcerptsByCoverage(matchInfo.excerpts, highlightTerms);
    if (matchInfo.excerpts[0]?.messageId) {
      matchInfo.messageId = matchInfo.excerpts[0].messageId;
    }

    return {
      cancelled: sharedResult?.cancelled === true,
      matched: sharedResult?.matched === true,
      blocked: sharedResult?.blocked === true,
      matchInfo,
      remainingTerms: Array.isArray(sharedResult?.remainingTerms) ? sharedResult.remainingTerms : []
    };
  }

  /**
   * 全文搜索：按需从 IndexedDB 读取会话并扫描消息内容，返回匹配信息。
   *
   * 设计目标（关键性能点）：
   * - 不污染 UI 的会话缓存（loadedConversations），避免搜索过程导致缓存暴涨/刷屏日志；
   * - 只读取 conversations 表（loadFullContent=false），避免额外的读取开销；
   * - 仅扫描内联消息文本。
   *
   * @param {string} conversationId
   * @param {{positiveLower:string[], negativeLower:string[], highlightLower:string[], hasPositive:boolean, hasNegative:boolean}} textPlan
   * @param {HTMLElement} panel - 用于 runId 取消判断
   * @param {string} runId
   * @param {string[]|null} [remainingTerms=null] - 若已在元数据中匹配过，传入剩余需要匹配的正向词
   * @returns {Promise<{messageId:string|null, excerpts:Array<Object>, reason:string, totalHitCount:number, matchedMessageCount:number}|null>}
   */
  async function scanConversationForTextMatch(conversationId, textPlan, panel, runId, remainingTerms = null) {
    if (!conversationId) return null;

    let conversation = null;
    try {
      // 重要：这里显式禁止加载重资源内容，避免把图片等大对象拉进内存。
      conversation = await getConversationById(conversationId, false);
    } catch (error) {
      console.error(`搜索会话 ${conversationId} 失败:`, error);
      return null;
    }

    if (!conversation || !Array.isArray(conversation.messages)) return null;
    const isCancelled = createSearchCancelledChecker(panel, runId);
    if (isCancelled()) return null;

    // 阶段1：扫描 conversations 记录内的消息文本
    const positiveTerms = Array.isArray(remainingTerms)
      ? remainingTerms
      : (Array.isArray(textPlan?.positiveLower) ? textPlan.positiveLower : []);
    const inlineScan = scanConversationInlineMessagesForMatch(conversation, textPlan, positiveTerms, isCancelled);
    if (inlineScan.cancelled) return null;
    if (inlineScan.blocked) return null;
    if (inlineScan.matched) return inlineScan.matchInfo;
    return null;
  }

  function escapeRegExp(rawValue) {
    return String(rawValue || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function normalizeHighlightTermEntries(highlightTerms) {
    const normalized = normalizeSearchTerms(highlightTerms);
    const entries = [];
    for (let i = 0; i < normalized.raw.length; i += 1) {
      const raw = normalized.raw[i];
      const lower = normalized.lower[i];
      if (!raw || !lower) continue;
      entries.push({ raw, lower });
    }
    return entries;
  }

  function buildHighlightRegexFromEntries(entries) {
    const normalizedEntries = Array.isArray(entries) ? entries : [];
    if (!normalizedEntries.length) return null;
    const pattern = normalizedEntries
      .slice()
      // 优先匹配更长关键词，避免 "api" 抢先吞掉 "api key" 造成颜色映射错位。
      .sort((a, b) => b.lower.length - a.lower.length || a.lower.localeCompare(b.lower))
      .map(entry => escapeRegExp(entry.raw))
      .join('|');
    if (!pattern) return null;
    try {
      return new RegExp(pattern, 'gi');
    } catch (_) {
      return null;
    }
  }

  function buildHighlightRegex(highlightTerms) {
    const entries = normalizeHighlightTermEntries(highlightTerms);
    return buildHighlightRegexFromEntries(entries);
  }

  function buildHighlightSegments(sourceText, highlightTerms) {
    if (!sourceText) return null;
    const entries = normalizeHighlightTermEntries(highlightTerms);
    if (!entries.length) return null;
    const regex = buildHighlightRegexFromEntries(entries);
    if (!regex) return null;
    const termLowerSet = new Set(entries.map(entry => entry.lower));
    const segments = [];
    let lastIndex = 0;
    let match;
    while ((match = regex.exec(sourceText)) !== null) {
      const matchIndex = match.index;
      if (matchIndex > lastIndex) {
        segments.push({ type: 'text', value: sourceText.slice(lastIndex, matchIndex) });
      }
      const matchedText = match[0];
      const matchedLower = matchedText.toLowerCase();
      segments.push({
        type: 'mark',
        value: matchedText,
        termLower: termLowerSet.has(matchedLower) ? matchedLower : ''
      });
      lastIndex = matchIndex + matchedText.length;
      if (matchedText.length === 0) regex.lastIndex += 1;
    }
    if (!segments.length) return null;
    if (lastIndex < sourceText.length) {
      segments.push({ type: 'text', value: sourceText.slice(lastIndex) });
    }
    return segments;
  }

  function collectHighlightContextRanges(sourceText, highlightTerms, contextLength = SEARCH_RESULT_SNIPPET_CONTEXT_LENGTH) {
    if (!sourceText) return [];
    const terms = (Array.isArray(highlightTerms) ? highlightTerms : [])
      .map(term => (typeof term === 'string' ? term.trim() : ''))
      .filter(Boolean);
    if (!terms.length) return [];

    const lowerText = sourceText.toLowerCase();
    const ranges = [];
    const seen = new Set();

    terms.forEach((rawTerm) => {
      const termLower = rawTerm.toLowerCase();
      if (seen.has(termLower)) return;
      seen.add(termLower);
      let fromIndex = 0;
      while (fromIndex < lowerText.length) {
        const index = lowerText.indexOf(termLower, fromIndex);
        if (index === -1) break;
        const start = Math.max(0, index - contextLength);
        const end = Math.min(sourceText.length, index + termLower.length + contextLength);
        ranges.push({ start, end });
        fromIndex = index + Math.max(1, termLower.length);
      }
    });

    if (!ranges.length) return [];

    ranges.sort((a, b) => a.start - b.start);
    const mergeGap = Math.max(6, Math.floor(contextLength / 2));
    const collapsed = [];
    for (const range of ranges) {
      if (!collapsed.length) {
        collapsed.push({ start: range.start, end: range.end });
        continue;
      }
      const last = collapsed[collapsed.length - 1];
      if (range.start <= last.end + mergeGap) {
        last.end = Math.max(last.end, range.end);
      } else {
        collapsed.push({ start: range.start, end: range.end });
      }
    }

    return collapsed;
  }

  function countMatchedHighlightTerms(sourceText, highlightTerms) {
    if (!sourceText) return 0;
    const lowerText = sourceText.toLowerCase();
    const seen = new Set();
    let matchedCount = 0;

    for (const term of Array.isArray(highlightTerms) ? highlightTerms : []) {
      const lowerTerm = typeof term === 'string' ? term.trim().toLowerCase() : '';
      if (!lowerTerm || seen.has(lowerTerm)) continue;
      seen.add(lowerTerm);
      if (lowerText.includes(lowerTerm)) {
        matchedCount += 1;
      }
    }

    return matchedCount;
  }

  function sortSearchSnippetExcerptsByCoverage(excerpts, highlightTerms) {
    const list = Array.isArray(excerpts) ? excerpts : [];
    if (list.length <= 1) return list;

    const uniqueTerms = new Set();
    for (const term of Array.isArray(highlightTerms) ? highlightTerms : []) {
      const lowerTerm = typeof term === 'string' ? term.trim().toLowerCase() : '';
      if (lowerTerm) uniqueTerms.add(lowerTerm);
    }
    if (uniqueTerms.size <= 1) return list;

    list.sort((left, right) => {
      const coverageDelta = Math.max(0, Number(right?.matchedTermCount || 0)) - Math.max(0, Number(left?.matchedTermCount || 0));
      if (coverageDelta !== 0) return coverageDelta;

      const hitDelta = Math.max(0, Number(right?.hitCount || 0)) - Math.max(0, Number(left?.hitCount || 0));
      if (hitDelta !== 0) return hitDelta;

      return Math.max(0, Number(left?.messageIndex || 0)) - Math.max(0, Number(right?.messageIndex || 0));
    });

    return list;
  }

  /**
   * 基于单条消息内全部命中位置生成一行预览。
   * 规则：
   * - 每个命中点保留固定上下文；
   * - 彼此靠近的片段自动合并；
   * - 距离较远的部分拆成多个正文片段，并在片段边缘做渐隐，避免插入额外占位字符。
   */
  function buildMessagePreviewExcerpt(sourceText, highlightTerms, contextLength = SEARCH_RESULT_SNIPPET_CONTEXT_LENGTH) {
    const ranges = collectHighlightContextRanges(sourceText, highlightTerms, contextLength);
    if (!ranges.length) return null;

    const parts = [];

    for (let index = 0; index < ranges.length; index += 1) {
      const range = ranges[index];
      const snippetPart = sourceText.slice(range.start, range.end).trim();
      if (!snippetPart) continue;
      parts.push({
        segments: buildHighlightSegments(snippetPart, highlightTerms)
          || [{ type: 'text', value: snippetPart }],
        fadeStart: index > 0 || range.start > 0,
        fadeEnd: index < (ranges.length - 1) || range.end < sourceText.length
      });
    }
    if (!parts.length) return null;

    return {
      parts,
      matchedTermCount: countMatchedHighlightTerms(sourceText, highlightTerms)
    };
  }

  function appendHighlightSegments(container, segments, keywordColorByLower = null) {
    if (!container || !Array.isArray(segments)) return;
    segments.forEach((segment) => {
      if (segment.type === 'mark') {
        const markEl = document.createElement('mark');
        markEl.textContent = segment.value;
        const termLower = typeof segment.termLower === 'string' ? segment.termLower : '';
        const keywordColor = (
          keywordColorByLower
          && termLower
          && typeof keywordColorByLower[termLower] === 'string'
        )
          ? keywordColorByLower[termLower]
          : '';
        if (keywordColor) {
          markEl.style.setProperty('--search-keyword-color', keywordColor);
        }
        container.appendChild(markEl);
      } else {
        container.appendChild(document.createTextNode(segment.value));
      }
    });
  }

  /**
   * 保存或更新当前对话至持久存储
   * @param {boolean} [isUpdate=false] - 是否为更新操作
   * @param {{ preserveExistingApiLock?: boolean, updateActiveState?: boolean, chatHistoryOverride?: { messages?: Array<any>, conversationRevision?: number, promptCacheKey?: string }, conversationId?: string, apiLockOverride?: any }} [options] - 额外保存选项
   *   - preserveExistingApiLock: 当内存态未携带 apiLock 时，是否回退继承已存储会话中的 apiLock（默认 true）
   *   - updateActiveState: 是否同步更新当前激活会话状态（默认 true，后台保存可设为 false）
   *   - chatHistoryOverride: 指定要保存的历史快照（用于后台会话写库）
   *   - conversationId: 指定保存目标会话 ID（用于后台会话写库）
   *   - apiLockOverride: 指定本次保存使用的会话 API 锁快照（用于避免混入当前激活会话的锁）
   * @returns {Promise<Object|null>} 返回保存后的会话对象；无可保存消息时返回 null
   */
  async function saveCurrentConversation(isUpdate = false, options = {}) {
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const preserveExistingApiLock = normalizedOptions.preserveExistingApiLock !== false;
    const updateActiveState = normalizedOptions.updateActiveState !== false;
    const overrideChatHistory = (normalizedOptions.chatHistoryOverride && typeof normalizedOptions.chatHistoryOverride === 'object')
      ? normalizedOptions.chatHistoryOverride
      : null;
    const overrideConversationId = (typeof normalizedOptions.conversationId === 'string')
      ? normalizedOptions.conversationId.trim()
      : '';
    const targetConversationId = overrideConversationId || currentConversationId || '';
    const hasApiLockOverride = Object.prototype.hasOwnProperty.call(normalizedOptions, 'apiLockOverride');

    const chatHistory = overrideChatHistory || services.chatHistoryManager.chatHistory;
    const rawMessages = Array.isArray(chatHistory?.messages) ? chatHistory.messages : [];
    const conversationRevision = Number.isFinite(Number(chatHistory?.conversationRevision))
      ? Math.max(0, Math.floor(Number(chatHistory.conversationRevision)))
      : 0;
    const promptCacheKey = normalizeResponsesPromptCacheKey(chatHistory?.promptCacheKey);
    if (rawMessages.length === 0) {
      if (targetConversationId) {
        const documents = await listConversationDocuments(targetConversationId).catch(() => []);
        if (Array.isArray(documents) && documents.length > 0) {
          const now = Date.now();
          const pageTitle = (typeof state.pageInfo?.title === 'string' && state.pageInfo.title.trim())
            ? state.pageInfo.title.trim()
            : '未命名对话';
          const pageUrl = (typeof state.pageInfo?.url === 'string') ? state.pageInfo.url.trim() : '';
          const existingConversation = (activeConversation?.id === targetConversationId)
            ? activeConversation
            : await getConversationById(targetConversationId).catch(() => null);
          const conversation = {
            id: targetConversationId,
            url: existingConversation?.url || pageUrl,
            title: existingConversation?.title || pageTitle,
            startTime: Number(existingConversation?.startTime) || now,
            endTime: now,
            messages: [],
            conversationRevision,
            summary: existingConversation?.summary || pageTitle,
            messageCount: 0,
            mainMessageCount: 0,
            threadMessageCount: 0,
            threadCount: 0
          };
          if (existingConversation?.apiLock) {
            conversation.apiLock = existingConversation.apiLock;
          }
          await putConversation(conversation);
          invalidateMetadataCache();
          if (updateActiveState) {
            currentConversationId = conversation.id;
            activeConversation = conversation;
          }
          updateConversationInCache(conversation);
          return conversation;
        }
      }
      // 仅在“当前激活会话”的更新路径下执行删除，避免后台保存误删其它会话。
      if (isUpdate && updateActiveState && targetConversationId) {
        await deleteConversationRecord(targetConversationId);
      }
      return null;
    }
    // 说明：后续的落盘流程会把 dataURL 转换为本地路径，为避免污染实时对话树，
    // 这里先深拷贝一份消息列表，仅在副本上做持久化处理。
    const cloneMessageSafely = (msg) => {
      try {
        return structuredClone(msg);
      } catch (_) {
        return JSON.parse(JSON.stringify(msg));
      }
    };
    const messagesCopy = rawMessages.map(cloneMessageSafely);

    // 保存前确保 <think> 段落已转为 thoughtsRaw，避免思考内容混入正文
    messagesCopy.forEach(normalizeThinkingForMessage);
    for (const msg of messagesCopy) {
      try {
        msg.content = normalizeStoredMessageContent(msg.content);
      } catch (_) {}
    }
    // 保存前先将消息中的 dataURL/远程图片落盘（仅操作副本），防止 base64 继续写入 IndexedDB
    try {
      for (const msg of messagesCopy) {
        await repairImagesInMessage(msg);
      }
    } catch (e) {
      console.warn('保存会话时落盘图片失败，已跳过部分图片:', e);
    }
    // Gemini grounding 已下线：保存前移除历史遗留字段，避免继续落盘无效元数据。
    try {
      for (const msg of messagesCopy) {
        stripGroundingMetadataFromMessage(msg);
      }
    } catch (e) {
      console.warn('保存会话时清理引用元数据失败，已跳过:', e);
    }
    const timestamps = messagesCopy.map(msg => msg.timestamp);
    const startTime = Math.min(...timestamps);
    const endTime = Math.max(...timestamps);

    /**
     * 纯函数：解析“会话来源页”的元数据（仅 url/title）。
     *
     * 设计背景：
     * - 在 AI 生成过程中，用户可能会切换到其它标签页，sidebar 的 state.pageInfo 会实时变更；
     * - 若首次落盘会话时直接读取 state.pageInfo，则会出现“会话内容来自 A，但 URL/标题却被写成 B”的错觉；
     * - 更符合直觉的规则是：以首条用户消息发出时所在页面为准。
     *
     * 实现策略：
     * - 首选首条用户消息节点上冻结的 pageMeta（见 core/message_processor.js）；
     * - 若不存在（兼容旧数据/异常路径），回退到当前 state.pageInfo。
     *
     * @param {Array<any>} messages
     * @param {any} fallbackPageInfo
     * @returns {{url: string, title: string, source: 'first_user_message'|'state_pageInfo'}}
     */
    const resolveConversationStartPageMeta = (messages, fallbackPageInfo) => {
      const list = Array.isArray(messages) ? messages : [];
      const firstUser = list.find(m => String(m?.role || '').toLowerCase() === 'user') || null;

      const fromNode = firstUser?.pageMeta || null;
      const urlFromNode = typeof fromNode?.url === 'string' ? fromNode.url.trim() : '';
      const titleFromNode = typeof fromNode?.title === 'string' ? fromNode.title.trim() : '';
      if (urlFromNode || titleFromNode) {
        return { url: urlFromNode, title: titleFromNode, source: 'first_user_message' };
      }

      const urlFallback = typeof fallbackPageInfo?.url === 'string' ? fallbackPageInfo.url.trim() : '';
      const titleFallback = typeof fallbackPageInfo?.title === 'string' ? fallbackPageInfo.title.trim() : '';
      return { url: urlFallback, title: titleFallback, source: 'state_pageInfo' };
    };

    const startPageMeta = resolveConversationStartPageMeta(messagesCopy, state.pageInfo);

    // 对话摘要（对话列表显示的标题）：
    // - 优先使用发送时写入到消息节点的 promptType/promptMeta（避免基于字符串/正则猜测）；
    // - 对于 selection/query：标题为「[划词解释] + 划词内容」；
    // - 对于 summary：标题使用固定标签；
    // - 其它情况回退为第一条用户消息的摘要。
    //
    // 重要：summary/promptType === 'summary' 时会拼接页面标题，因此这里必须使用“会话起始页”的 title，
    //      而不是 state.pageInfo（它可能在生成过程中被切到其它标签页）。
    const promptsConfig = promptSettingsManager.getPrompts();
    const summary = buildConversationSummaryFromMessages(messagesCopy, {
      promptsConfig,
      pageTitle: startPageMeta.title || '',
      maxLength: 160
    });

    // 会话元数据合并前置输入：
    // - startPageMeta/summary 代表当前内存态计算结果；
    // - existingConversationSnapshot/summaryFromExistingTitle 代表已存储态补充信息。
    let summaryFromExistingTitle = '';
    // 会话固定 API：先快照“内存态”，后续与“已存储态”通过纯函数合并。
    const memoryApiLockSnapshot = hasApiLockOverride
      ? normalizeConversationApiLock(normalizedOptions.apiLockOverride)
      : normalizeConversationApiLock(activeConversationApiLock || activeConversation?.apiLock);
    let existingConversationSnapshot = null;

    // 如果是更新操作并且已存在记录，则固定使用首次保存的 url 和 title
    if (isUpdate && targetConversationId) {
      try {
        // 使用false参数，不加载完整内容，只获取元数据
        const existingConversation = await getConversationById(targetConversationId, false);
        if (existingConversation) {
          existingConversationSnapshot = existingConversation;
          // 若用户未手动改名，且该会话已有固定 title，则用固定 title 重算摘要（避免用到“当前标签页标题”）
          if (!existingConversation.summary && existingConversation.title) {
            summaryFromExistingTitle = buildConversationSummaryFromMessages(messagesCopy, {
              promptsConfig,
              pageTitle: existingConversation.title || '',
              maxLength: 160
            });
          }
        }
      } catch (error) {
        console.error("获取会话记录失败:", error);
      }
    } else {
      console.log(
        `首次保存会话，使用${startPageMeta.source === 'first_user_message' ? '首条用户消息的页面快照' : '当前页面信息'}: ` +
        `URL=${startPageMeta.url || ''}, 标题=${startPageMeta.title || ''}`
      );
    }

    const metadataMerge = mergeConversationSaveMetadataState({
      isUpdate,
      startPageMeta,
      startPageMetaSource: startPageMeta.source,
      summaryCandidate: summary,
      existingConversation: existingConversationSnapshot,
      summaryFromExistingTitle
    });
    const {
      urlToSave,
      titleToSave,
      summaryToSave,
      summarySourceToSave,
      parentConversationIdToSave,
      forkedFromMessageIdToSave
    } = metadataMerge;

    // 统一 API 锁定合并规则：
    // - memory 优先；
    // - preserveExistingApiLock=true 时可回退 stored；
    // - 否则输出 null（显式清锁）。
    const apiLockMerge = mergeConversationApiLockState({
      memoryApiLock: memoryApiLockSnapshot,
      storedApiLock: existingConversationSnapshot?.apiLock,
      preserveExistingApiLock
    });
    const apiLockToSave = apiLockMerge.apiLock;

    const generateConversationId = () => `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const messageStats = computeConversationMessageStats(messagesCopy);
    const conversation = {
      id: isUpdate ? (targetConversationId || generateConversationId()) : generateConversationId(),
      url: urlToSave,
      title: titleToSave,
      startTime,
      endTime,
      messages: messagesCopy,
      conversationRevision,
      summary: summaryToSave,
      messageCount: messageStats.totalCount,
      mainMessageCount: messageStats.mainMessageCount,
      threadMessageCount: messageStats.threadMessageCount,
      threadCount: messageStats.threadCount
    };
    if (promptCacheKey) {
      conversation.promptCacheKey = promptCacheKey;
    }
    if (summarySourceToSave) {
      conversation.summarySource = summarySourceToSave;
    }
    if (parentConversationIdToSave) {
      conversation.parentConversationId = parentConversationIdToSave;
    }
    if (forkedFromMessageIdToSave) {
      conversation.forkedFromMessageId = forkedFromMessageIdToSave;
    }
    if (apiLockToSave) {
      conversation.apiLock = apiLockToSave;
    }

    // 使用 IndexedDB 存储对话记录
    await putConversation(conversation);
    invalidateMetadataCache();
    
    // 根据调用方意图决定是否同步“当前激活会话”上下文。
    if (updateActiveState) {
      currentConversationId = conversation.id;
      activeConversation = conversation;
      activeConversationApiLock = apiLockToSave;
    }
    
    // 更新内存缓存
    updateConversationInCache(conversation);
    
    return conversation;
  }

  async function ensureCurrentConversationId(options = {}) {
    const existingId = (typeof currentConversationId === 'string') ? currentConversationId.trim() : '';
    if (existingId) {
      return existingId;
    }

    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const now = Date.now();
    const newConversationId = `conv_${now}_${Math.random().toString(36).substr(2, 9)}`;
    const pageTitle = (typeof state.pageInfo?.title === 'string' && state.pageInfo.title.trim())
      ? state.pageInfo.title.trim()
      : '未命名对话';
    const pageUrl = (typeof state.pageInfo?.url === 'string') ? state.pageInfo.url.trim() : '';
    const summary = (typeof normalizedOptions.summary === 'string' && normalizedOptions.summary.trim())
      ? normalizedOptions.summary.trim()
      : pageTitle;
    const conversation = {
      id: newConversationId,
      url: pageUrl,
      title: pageTitle,
      startTime: now,
      endTime: now,
      messages: [],
      conversationRevision: 0,
      summary,
      messageCount: 0,
      mainMessageCount: 0,
      threadMessageCount: 0,
      threadCount: 0
    };

    await putConversation(conversation);
    invalidateMetadataCache();
    currentConversationId = newConversationId;
    activeConversation = conversation;
    updateConversationInCache(conversation);
    try {
      services.messageSender?.setCurrentConversationId?.(newConversationId);
    } catch (_) {}
    return newConversationId;
  }

  /**
   * 更新会话缓存
   * @param {Object} conversation - 会话对象
   */
  function updateConversationInCache(conversation) {
    if (!conversation || !conversation.id) return;

    // 说明：这里的缓存用于“快速打开最近使用的会话”，因此应当是一个真正的 LRU。
    // 旧实现仅“释放消息内容”但依然把所有会话对象留在 Map 中，导致：
    // 1) 搜索/遍历时缓存无限增长（Map 永远 > maxLoadedConversations）；
    // 2) 每次插入都触发“释放会话内存”日志刷屏；
    // 3) JS 堆仍保留大量 message 元对象，实际内存收益有限。
    //
    // 新策略：只保留最近使用的 N 条“完整会话对象”引用，超出上限直接淘汰（让 GC 回收）。
    // activeConversation（正在聊天/刚打开）尽量不淘汰。
    if (loadedConversations.has(conversation.id)) {
      loadedConversations.delete(conversation.id);
    }
    loadedConversations.set(conversation.id, conversation);

    const maxKeep = Math.max(1, Number(maxLoadedConversations) || 1);
    if (loadedConversations.size <= maxKeep) return;

    const activeId = activeConversation?.id || null;
    for (const id of loadedConversations.keys()) {
      if (loadedConversations.size <= maxKeep) break;
      if (activeId && id === activeId) continue;
      loadedConversations.delete(id);
    }

    // 极端兜底：如果 maxKeep 太小（例如被误设为 0）导致仍超限，则允许淘汰最旧项。
    while (loadedConversations.size > maxKeep) {
      const oldestId = loadedConversations.keys().next().value;
      if (!oldestId) break;
      loadedConversations.delete(oldestId);
    }
  }

  /**
   * 从缓存获取会话，如果不在缓存中则从数据库加载
   * @param {string} conversationId - 会话ID 
   * @param {boolean} [forceReload=false] - 是否强制从数据库重新加载
   * @returns {Promise<Object>} 会话对象
   */
  async function getConversationFromCacheOrLoad(conversationId, forceReload = false) {
    if (!conversationId) return null;

    if (forceReload || !loadedConversations.has(conversationId)) {
      // 从数据库加载并更新缓存（用于点击打开/恢复会话）
      const conversation = await getConversationById(conversationId, true);
      if (conversation) updateConversationInCache(conversation);
      return conversation || null;
    }

    const cached = loadedConversations.get(conversationId) || null;
    if (cached) updateConversationInCache(cached); // touch -> LRU
    return cached;
  }

  function cloneConversationSnapshot(conversation) {
    if (!conversation || typeof conversation !== 'object') return null;
    try {
      return structuredClone(conversation);
    } catch (_) {
      try {
        return JSON.parse(JSON.stringify(conversation));
      } catch (_) {
        return null;
      }
    }
  }

  /**
   * 获取指定会话的“可安全后台修改”的快照副本。
   *
   * 设计说明：
   * - 后台自动续发需要读到某个会话的最新历史，但不能直接原地修改 loadedConversations 中的缓存对象；
   * - 因此这里返回深拷贝，调用方可在副本上追加消息、增量写库，不会污染当前 UI 正在使用的内存对象；
   * - 真正持久化时仍通过 saveCurrentConversation/updateConversationInCache 回写正式缓存。
   *
   * @param {string} conversationId
   * @param {boolean} [forceReload=false]
   * @returns {Promise<Object|null>}
   */
  async function getConversationSnapshotById(conversationId, forceReload = false) {
    const conversation = await getConversationFromCacheOrLoad(conversationId, forceReload);
    return cloneConversationSnapshot(conversation);
  }

  function getActiveConversationSummary() {
    return (typeof activeConversation?.summary === 'string') ? activeConversation.summary : '';
  }

  /**
   * 获取历史列表当前滚动位置（用于刷新后恢复）。
   * @returns {{keepExistingList: boolean, restoreScrollTop: number}|null}
   */
  function getHistoryListScrollRestoreOptions() {
    const panel = document.getElementById('chat-history-panel');
    if (!panel || !panel.classList.contains('visible')) return null;
    const listContainer = panel.querySelector('#chat-history-list');
    if (!listContainer) return null;
    return {
      keepExistingList: true,
      restoreScrollTop: listContainer.scrollTop
    };
  }

  /**
   * 获取历史列表面板与容器（仅在面板可见时返回）。
   * @returns {{panel: HTMLElement, listContainer: HTMLElement}|null}
   */
  function getHistoryListContext() {
    const panel = document.getElementById('chat-history-panel');
    if (!panel || !panel.classList.contains('visible')) return null;
    const listContainer = panel.querySelector('#chat-history-list');
    if (!listContainer) return null;
    return { panel, listContainer };
  }

  /**
   * 根据搜索文本构建关键词高亮计划。
   * @param {string} filterText
   * @returns {{terms:string[], termsLower:string[], hasTerms:boolean, keywordColorByLower:Record<string,string>, keywordEntries:Array<{term:string, termLower:string, color:string}>}}
   */
  function buildHistoryHighlightPlanByFilterText(filterText) {
    const searchPlan = buildChatHistorySearchPlan(filterText || '');
    const textPlan = buildChatHistoryTextPlan(searchPlan);
    return buildKeywordHighlightPlan(textPlan.highlightRaw, textPlan.highlightLower);
  }

  /**
   * 根据当前搜索条件生成用于摘要高亮的计划。
   * @param {HTMLElement} panel
   * @returns {{terms:string[], termsLower:string[], hasTerms:boolean, keywordColorByLower:Record<string,string>, keywordEntries:Array<{term:string, termLower:string, color:string}>}}
   */
  function buildHistoryHighlightPlan(panel) {
    const filterInput = panel.querySelector('.filter-container input[type="text"]');
    const filterText = filterInput ? filterInput.value : '';
    return buildHistoryHighlightPlanByFilterText(filterText);
  }

  /**
   * 更新当前列表缓存（currentDisplayItems）的摘要，避免后续渲染使用旧值。
   * @param {string} conversationId
   * @param {string} summary
   */
  function updateConversationSummaryInDisplayCache(conversationId, summary) {
    const id = (typeof conversationId === 'string') ? conversationId.trim() : '';
    if (!id || !Array.isArray(currentDisplayItems)) return;
    for (const item of currentDisplayItems) {
      if (item?.id === id) {
        item.summary = summary;
        break;
      }
    }
  }

  /**
   * 仅更新当前已渲染列表中的摘要文本，避免整页刷新导致滚动跳动。
   * @param {string} conversationId
   * @param {string} summary
   * @returns {boolean} 是否成功更新到视图
   */
  function updateHistoryListItemSummary(conversationId, summary) {
    const id = (typeof conversationId === 'string') ? conversationId.trim() : '';
    if (!id) return false;
    const ctx = getHistoryListContext();
    if (!ctx) return false;
    const { panel, listContainer } = ctx;
    const item = listContainer.querySelector(`.chat-history-item[data-id="${id}"]`);
    if (!item) return false;
    const summaryDiv = item.querySelector('.summary');
    if (!summaryDiv) return false;

    const displaySummary = summary || '无摘要';
    const highlightPlan = buildHistoryHighlightPlan(panel);
    const highlightTerms = Array.isArray(highlightPlan.termsLower) && highlightPlan.termsLower.length
      ? highlightPlan.termsLower
      : (Array.isArray(highlightPlan.terms) ? highlightPlan.terms : []);
    const keywordColorByLower = (highlightPlan && typeof highlightPlan.keywordColorByLower === 'object')
      ? highlightPlan.keywordColorByLower
      : null;
    const hasHighlightTerms = highlightTerms.length > 0;
    if (hasHighlightTerms && displaySummary) {
      try {
        const segments = buildHighlightSegments(displaySummary, highlightTerms);
        if (segments && segments.length) {
          summaryDiv.textContent = '';
          appendHighlightSegments(summaryDiv, segments, keywordColorByLower);
        } else {
          summaryDiv.textContent = displaySummary;
        }
      } catch (e) {
        console.error('更新摘要高亮时发生错误:', e);
        summaryDiv.textContent = displaySummary;
      }
    } else {
      summaryDiv.textContent = displaySummary;
    }
    return true;
  }

  function getActiveConversationApiLock() {
    return normalizeConversationApiLock(activeConversationApiLock || activeConversation?.apiLock);
  }

  async function setConversationApiLock(conversationId, apiConfig) {
    const normalizedId = (typeof conversationId === 'string') ? conversationId.trim() : '';
    const targetId = normalizedId || currentConversationId || activeConversation?.id || '';
    if (!targetId) {
      showNotification?.({ message: '当前没有可固定的对话', type: 'warning', duration: 2000 });
      return { ok: false, reason: 'no_active_conversation' };
    }

    let resolvedConfig = null;
    if (apiConfig && typeof apiConfig === 'object') {
      resolvedConfig = apiConfig;
    } else if (typeof apiConfig === 'string' && services.apiManager?.resolveApiParam) {
      const key = apiConfig.trim();
      if (key && key.toLowerCase() !== 'follow_current' && key.toLowerCase() !== 'selected') {
        resolvedConfig = services.apiManager.resolveApiParam(key);
      }
    }

    const hasInputConfig = !!resolvedConfig;
    const nextLock = hasInputConfig ? buildConversationApiLockFromConfig(resolvedConfig) : null;
    const shouldClear = !nextLock;

    if (hasInputConfig && !nextLock) {
      showNotification?.({ message: '未找到可用的 API 配置', type: 'warning', duration: 2000 });
      return { ok: false, reason: 'invalid_api_config' };
    }

    const isActiveTarget = (activeConversation?.id === targetId) || (currentConversationId === targetId);
    if (isActiveTarget && Array.isArray(services.chatHistoryManager?.chatHistory?.messages)
      && services.chatHistoryManager.chatHistory.messages.length > 0) {
      activeConversationApiLock = nextLock;
      if (activeConversation) {
        if (shouldClear) delete activeConversation.apiLock;
        else activeConversation.apiLock = nextLock;
      }
      await saveCurrentConversation(true, { preserveExistingApiLock: false });
    } else {
      const conversation = await getConversationFromCacheOrLoad(targetId);
      if (!conversation) {
        showNotification?.({ message: '找不到对应的对话记录', type: 'warning', duration: 2000 });
        return { ok: false, reason: 'not_found' };
      }

      const prevLock = normalizeConversationApiLock(conversation.apiLock);
      if (isSameConversationApiLock(prevLock, nextLock)) {
        return { ok: true, lock: prevLock, unchanged: true };
      }

      if (shouldClear) {
        delete conversation.apiLock;
      } else {
        conversation.apiLock = nextLock;
      }

      await putConversation(conversation);
      invalidateMetadataCache();
      updateConversationInCache(conversation);
    }

    if (isChatHistoryPanelOpen()) {
      refreshChatHistory(getHistoryListScrollRestoreOptions());
    }

    emitConversationApiContextChanged();

    const label = resolvedConfig?.displayName || resolvedConfig?.modelName || resolvedConfig?.baseUrl || 'API';
    if (shouldClear) {
      showNotification?.({ message: '已取消固定，跟随当前 API', duration: 1800 });
    } else {
      showNotification?.({ message: `已固定该对话：${label}`, duration: 1800 });
    }

    return { ok: true, lock: nextLock };
  }

  /**
   * 清理没有对应会话条目的分组标题，避免删除后出现空分组。
   * @param {HTMLElement} listContainer
   */
  function cleanupEmptyHistoryGroupHeaders(listContainer) {
    if (!listContainer) return;
    const nodes = Array.from(listContainer.children);
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (!node?.classList?.contains('chat-history-group-header')) continue;
      if (node.classList.contains('pinned-header')) continue;
      let hasItem = false;
      for (let j = i + 1; j < nodes.length; j += 1) {
        const next = nodes[j];
        if (!next?.classList) continue;
        if (next.classList.contains('chat-history-group-header')) break;
        if (next.classList.contains('chat-history-item')) {
          hasItem = true;
          break;
        }
      }
      if (!hasItem) node.remove();
    }
  }

  /**
   * 从当前列表视图移除指定会话条目（若需要结构重排则返回 false 以触发全量刷新）。
   * @param {string} conversationId
   * @returns {boolean} 是否完成局部删除
   */
  function removeHistoryListItemFromView(conversationId) {
    const id = (typeof conversationId === 'string') ? conversationId.trim() : '';
    if (!id) return false;
    const ctx = getHistoryListContext();
    if (!ctx) return true; // 面板不可见时无需刷新
    const { panel, listContainer } = ctx;

    const isTreeMode = panel.dataset.branchViewMode === 'tree';
    if (isTreeMode) {
      const hasChildren = Array.isArray(currentDisplayItems)
        && currentDisplayItems.some(item => item?.parentConversationId === id);
      if (hasChildren) return false;
    }

    const item = listContainer.querySelector(`.chat-history-item[data-id="${id}"]`);
    if (item) {
      item.remove();
    }

    if (Array.isArray(currentDisplayItems) && currentDisplayItems.length > 0) {
      const beforeLen = currentDisplayItems.length;
      currentDisplayItems = currentDisplayItems.filter(entry => entry?.id !== id);
      if (beforeLen !== currentDisplayItems.length) {
        if (panel?._historyDataSource?.loadedIdSet) {
          panel._historyDataSource.loadedIdSet.delete(id);
        }
      }
    }

    currentPinnedItemsCountInDisplay = listContainer.querySelectorAll('.chat-history-item.pinned').length;
    if (currentPinnedItemsCountInDisplay === 0) {
      const pinnedHeader = listContainer.querySelector('.chat-history-group-header.pinned-header');
      if (pinnedHeader) pinnedHeader.remove();
      listContainer.classList.remove('pinned-collapsed');
      delete panel.dataset.pinnedCollapsed;
    }

    cleanupEmptyHistoryGroupHeaders(listContainer);

    const itemCount = listContainer.querySelectorAll('.chat-history-item').length;
    currentlyRenderedCount = itemCount;
    if (itemCount === 0) {
      listContainer.querySelectorAll('.chat-history-group-header').forEach((n) => n.remove());
      const filterInput = panel.querySelector('.filter-container input[type="text"]');
      const filterText = filterInput ? filterInput.value : '';
      const searchPlan = buildChatHistorySearchPlan(filterText);
      const textPlan = buildChatHistoryTextPlan(searchPlan);
      const hasActiveQuery = (Array.isArray(searchPlan.filters) && searchPlan.filters.length > 0)
        || textPlan.hasPositive
        || textPlan.hasNegative;
      const emptyMsg = document.createElement('div');
      emptyMsg.textContent = hasActiveQuery ? '没有匹配的聊天记录' : '暂无聊天记录';
      listContainer.appendChild(emptyMsg);
    }

    return true;
  }

  /**
   * 更新会话摘要（对话列表标题），并尽量避免覆盖用户手动重命名的结果。
   * - 如果提供 expectedSummary，则仅在“当前摘要一致”时才写入；
   * - 如果提供 summarySource，则同步更新摘要来源标记；
   * - 支持 skipIfManual：遇到手动命名时直接跳过。
   *
   * @param {string} conversationId
   * @param {string} summary
   * @param {{expectedSummary?: string|null, summarySource?: string|null, skipIfManual?: boolean}} [options]
   * @returns {Promise<{ok: boolean, reason?: string, summary?: string}>}
   */
  async function updateConversationSummary(conversationId, summary, options = {}) {
    const normalizedId = (typeof conversationId === 'string') ? conversationId.trim() : '';
    const nextSummary = (typeof summary === 'string') ? summary.trim() : '';
    if (!normalizedId) return { ok: false, reason: 'missing_id' };
    if (!nextSummary) return { ok: false, reason: 'empty_summary' };

    const conversation = await getConversationFromCacheOrLoad(normalizedId);
    if (!conversation) return { ok: false, reason: 'not_found' };

    const currentSummary = (typeof conversation.summary === 'string') ? conversation.summary : '';
    const expectedSummary = (typeof options.expectedSummary === 'string')
      ? options.expectedSummary
      : null;
    const summarySource = (typeof options.summarySource === 'string' && options.summarySource.trim())
      ? options.summarySource.trim()
      : null;
    const skipIfManual = !!options.skipIfManual;
    const currentSummarySource = (typeof conversation.summarySource === 'string')
      ? conversation.summarySource
      : '';
    if (skipIfManual && currentSummarySource === 'manual') {
      return { ok: false, reason: 'summary_manual' };
    }
    if (expectedSummary !== null && expectedSummary !== currentSummary) {
      return { ok: false, reason: 'summary_changed' };
    }

    conversation.summary = nextSummary;
    if (summarySource) {
      conversation.summarySource = summarySource;
    }
    if (activeConversation?.id === normalizedId) {
      activeConversation.summary = nextSummary;
      if (summarySource) {
        activeConversation.summarySource = summarySource;
      }
    }
    await putConversation(conversation);
    updateConversationInCache(conversation);
    invalidateMetadataCache();
    updateConversationSummaryInDisplayCache(normalizedId, nextSummary);
    const updatedInView = updateHistoryListItemSummary(normalizedId, nextSummary);
    if (!updatedInView) {
      refreshChatHistory(getHistoryListScrollRestoreOptions());
    }
    return { ok: true, summary: nextSummary };
  }

  /**
   * 自动生成指定会话的标题（不处理分支）。
   * @param {string} conversationId
   */
  async function autoGenerateConversationTitleForConversation(conversationId) {
    const targetId = (typeof conversationId === 'string') ? conversationId.trim() : '';
    if (!targetId) return;

    const messageSender = services.messageSender;
    if (!messageSender?.generateConversationTitleForMessages) {
      showNotification?.({ message: '当前版本不支持自动生成标题', type: 'warning', duration: 2200 });
      return;
    }

    const conversation = await getConversationById(targetId, true);
    if (!conversation) {
      showNotification?.({ message: '未找到该对话', type: 'warning', duration: 2000 });
      return;
    }

    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    if (messages.length === 0) {
      showNotification?.({ message: '该对话没有消息，无法生成标题', type: 'warning', duration: 2000 });
      return;
    }

    showNotification?.({ message: '开始生成标题...', duration: 1400 });
    const expectedSummary = (typeof conversation.summary === 'string') ? conversation.summary : '';
    const result = await messageSender.generateConversationTitleForMessages({
      conversationId: conversation.id,
      messages
    });

    if (!result?.ok) {
      const errorMap = {
        missing_prompt: '请先在设置中填写“对话标题提示词”',
        missing_api: '请先在设置中选择可用的标题生成 API',
        missing_services: '标题生成服务未就绪，请刷新后重试'
      };
      const fallback = result?.reason === 'in_progress' ? '标题生成进行中，请稍后再试' : '生成标题失败';
      showNotification?.({
        message: errorMap[result?.reason] || fallback,
        type: 'warning',
        duration: 2200
      });
      return;
    }

    const updateResult = await updateConversationSummary(conversation.id, result.title, {
      expectedSummary,
      summarySource: 'auto'
    });
    if (updateResult.ok) {
      showNotification?.({ message: '标题已更新', duration: 1800 });
      return;
    }

    const reasonText = updateResult.reason === 'summary_manual'
      ? '该对话已手动重命名，已跳过'
      : updateResult.reason === 'summary_changed'
        ? '标题已被修改，已跳过'
        : '更新标题失败';
    showNotification?.({ message: reasonText, type: 'warning', duration: 2200 });
  }

  function normalizeThreadIdentifier(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function summarizeThreadOverviewText(text, maxLength = 72) {
    const normalized = typeof text === 'string'
      ? text.replace(/\s+/g, ' ').trim()
      : '';
    if (!normalized) return '';
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength)}…`;
  }

  /**
   * 从会话消息中提取“线程总览”数据：
   * - 优先以锚点消息上的 threadAnnotations 为准；
   * - 再用线程消息（threadId/threadRootId）补齐计数、活跃时间和焦点消息。
   *
   * 这样可以覆盖“注解存在但线程消息尚少”与“历史数据缺字段”的混合场景。
   *
   * @param {Object} conversation
   * @returns {Array<Object>}
   */
  function collectConversationThreadOverviewItems(conversation) {
    const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
    if (!messages.length) return [];

    const threadMap = new Map();
    const threadIdByRootId = new Map();
    const messageMap = new Map();

    const ensureThreadEntry = (threadId) => {
      if (!threadId) return null;
      if (!threadMap.has(threadId)) {
        threadMap.set(threadId, {
          threadId,
          anchorMessageId: '',
          rootMessageId: '',
          firstMessageId: '',
          lastMessageId: '',
          latestMessageId: '',
          focusMessageId: '',
          selectionText: '',
          previewText: '',
          createdAt: 0,
          latestTimestamp: 0,
          messageCount: 0,
          visibleMessageCount: 0
        });
      }
      return threadMap.get(threadId);
    };

    for (const message of messages) {
      const messageId = normalizeThreadIdentifier(message?.id);
      if (messageId) {
        messageMap.set(messageId, message);
      }
      const annotations = Array.isArray(message?.threadAnnotations) ? message.threadAnnotations : [];
      for (const annotation of annotations) {
        const threadId = normalizeThreadIdentifier(annotation?.id);
        if (!threadId) continue;
        const entry = ensureThreadEntry(threadId);
        if (!entry) continue;

        if (!entry.anchorMessageId && messageId) {
          entry.anchorMessageId = messageId;
        }

        const selectionText = summarizeThreadOverviewText(annotation?.selectionText || '');
        if (!entry.selectionText && selectionText) {
          entry.selectionText = selectionText;
        }

        const rootMessageId = normalizeThreadIdentifier(annotation?.rootMessageId);
        if (!entry.rootMessageId && rootMessageId) {
          entry.rootMessageId = rootMessageId;
        }
        if (rootMessageId && !threadIdByRootId.has(rootMessageId)) {
          threadIdByRootId.set(rootMessageId, threadId);
        }

        const lastMessageId = normalizeThreadIdentifier(annotation?.lastMessageId);
        if (!entry.lastMessageId && lastMessageId) {
          entry.lastMessageId = lastMessageId;
        }

        const createdAt = Number(annotation?.createdAt);
        if (Number.isFinite(createdAt) && createdAt > 0) {
          entry.createdAt = Math.max(entry.createdAt, createdAt);
        }
      }
    }

    const resolveThreadIdFromMessage = (message) => {
      const directThreadId = normalizeThreadIdentifier(message?.threadId);
      if (directThreadId) return directThreadId;

      const rootMessageId = normalizeThreadIdentifier(message?.threadRootId);
      if (rootMessageId && threadIdByRootId.has(rootMessageId)) {
        return threadIdByRootId.get(rootMessageId) || '';
      }

      const anchorMessageId = normalizeThreadIdentifier(message?.threadAnchorId);
      if (!anchorMessageId) return '';
      const anchorNode = messageMap.get(anchorMessageId);
      const annotations = Array.isArray(anchorNode?.threadAnnotations) ? anchorNode.threadAnnotations : [];
      if (!annotations.length) return '';

      if (rootMessageId) {
        const matched = annotations.find(item => (
          normalizeThreadIdentifier(item?.rootMessageId) === rootMessageId
          && normalizeThreadIdentifier(item?.id)
        ));
        if (matched?.id) {
          return normalizeThreadIdentifier(matched.id);
        }
      }

      if (annotations.length === 1) {
        return normalizeThreadIdentifier(annotations[0]?.id);
      }

      return '';
    };

    for (const message of messages) {
      const threadId = resolveThreadIdFromMessage(message);
      if (!threadId) continue;
      const entry = ensureThreadEntry(threadId);
      if (!entry) continue;

      const messageId = normalizeThreadIdentifier(message?.id);
      const anchorMessageId = normalizeThreadIdentifier(message?.threadAnchorId);
      const isHiddenSelection = !!message?.threadHiddenSelection;
      const timestamp = resolveConversationMessageTimestamp(message);
      const messagePlainText = summarizeThreadOverviewText(extractMessagePlainText(message), 56);

      entry.messageCount += 1;
      if (!isHiddenSelection) {
        entry.visibleMessageCount += 1;
      }

      if (messageId && !entry.firstMessageId) {
        entry.firstMessageId = messageId;
      }
      if (messageId) {
        entry.lastMessageId = messageId;
      }
      if (!entry.anchorMessageId && anchorMessageId) {
        entry.anchorMessageId = anchorMessageId;
      }

      const rootMessageId = normalizeThreadIdentifier(message?.threadRootId);
      if (!entry.rootMessageId && rootMessageId) {
        entry.rootMessageId = rootMessageId;
      }
      if (rootMessageId && !threadIdByRootId.has(rootMessageId)) {
        threadIdByRootId.set(rootMessageId, threadId);
      }

      if (!entry.selectionText) {
        const selectionText = summarizeThreadOverviewText(message?.threadSelectionText || '');
        if (selectionText) {
          entry.selectionText = selectionText;
        }
      }

      if (!isHiddenSelection && messagePlainText) {
        entry.previewText = messagePlainText;
      }

      if (timestamp > entry.latestTimestamp) {
        entry.latestTimestamp = timestamp;
        if (messageId) {
          entry.latestMessageId = messageId;
          if (!isHiddenSelection) {
            entry.focusMessageId = messageId;
          }
        }
        if (!isHiddenSelection && messagePlainText) {
          entry.previewText = messagePlainText;
        }
      }

      if (!entry.focusMessageId && messageId && !isHiddenSelection) {
        entry.focusMessageId = messageId;
      }
    }

    const sortedItems = Array.from(threadMap.values())
      .filter(item => item.messageCount > 0 || item.selectionText || item.previewText || item.rootMessageId)
      .sort((a, b) => {
        const aTs = Number(a.latestTimestamp) || Number(a.createdAt) || 0;
        const bTs = Number(b.latestTimestamp) || Number(b.createdAt) || 0;
        if (aTs !== bTs) return bTs - aTs;
        return (a.threadId || '').localeCompare(b.threadId || '');
      });

    return sortedItems
      .map((item, index) => {
        const displayMessageCount = item.visibleMessageCount > 0
          ? item.visibleMessageCount
          : item.messageCount;
        const anchorNode = item.anchorMessageId ? messageMap.get(item.anchorMessageId) : null;
        const anchorPreviewText = summarizeThreadOverviewText(extractMessagePlainText(anchorNode), 50);
        return {
          ...item,
          order: index + 1,
          displayMessageCount,
          displayText: item.selectionText || item.previewText || '（暂无划词文本）',
          focusMessageId: item.focusMessageId || item.latestMessageId || item.lastMessageId || item.rootMessageId || '',
          anchorPreviewText
        };
      })
      .filter(item => Number(item.displayMessageCount) > 0);
  }

  function buildThreadOverviewSummaryLine(item) {
    const countText = `共 ${Number(item?.displayMessageCount || 0)} 条`;
    const activityTimestamp = Number(item?.latestTimestamp) || Number(item?.createdAt) || 0;
    const activityText = activityTimestamp > 0
      ? formatRelativeTime(new Date(activityTimestamp))
      : '暂无活动';
    const quoteText = summarizeThreadOverviewText(
      item?.selectionText || item?.displayText || '',
      36
    ) || '（暂无划词引用）';
    return `${countText} · ${activityText} · 「${quoteText}」`;
  }

  function createConversationThreadOverviewElement(conversation) {
    const items = collectConversationThreadOverviewItems(conversation);
    if (!items.length) return null;

    const wrapper = document.createElement('section');
    wrapper.className = 'conversation-thread-overview';
    wrapper.setAttribute('aria-label', '对话线程总览');

    const header = document.createElement('div');
    header.className = 'conversation-thread-overview__header';

    const title = document.createElement('div');
    title.className = 'conversation-thread-overview__title';
    title.textContent = '对话线程';

    const count = document.createElement('div');
    count.className = 'conversation-thread-overview__count';
    count.textContent = `共 ${items.length} 个`;

    header.appendChild(title);
    header.appendChild(count);

    const list = document.createElement('div');
    list.className = 'conversation-thread-overview__list';

    const groupedItems = [];
    const groupIndexByAnchor = new Map();
    for (const item of items) {
      const key = item.anchorMessageId || '__ungrouped__';
      if (!groupIndexByAnchor.has(key)) {
        groupIndexByAnchor.set(key, groupedItems.length);
        groupedItems.push({
          key,
          anchorPreviewText: item.anchorPreviewText || '',
          items: []
        });
      }
      groupedItems[groupIndexByAnchor.get(key)].items.push(item);
    }

    groupedItems.forEach((group, groupOffset) => {
      const groupSection = document.createElement('div');
      groupSection.className = 'conversation-thread-overview__group';

      const groupHeader = document.createElement('div');
      groupHeader.className = 'conversation-thread-overview__group-header';
      const groupLabel = group.anchorPreviewText || '关联消息';
      groupHeader.textContent = `${groupLabel} · ${group.items.length} 个线程`;
      groupHeader.title = groupLabel;
      groupSection.appendChild(groupHeader);

      for (const item of group.items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'conversation-thread-overview__item conversation-thread-overview__item--single-line';
        button.dataset.threadId = item.threadId;
        if (item.focusMessageId) {
          button.dataset.focusMessageId = item.focusMessageId;
        }
        const summaryLine = buildThreadOverviewSummaryLine(item);
        button.textContent = summaryLine;
        button.title = summaryLine;

        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const targetThreadId = button.dataset.threadId || '';
          if (!targetThreadId) return;
          const focusMessageId = button.dataset.focusMessageId || '';
          const enterThread = services.selectionThreadManager?.enterThread;
          if (typeof enterThread !== 'function') return;
          Promise.resolve(enterThread(targetThreadId, focusMessageId ? { focusMessageId } : {}))
            .then((entered) => {
              if (entered === false) {
                // 线程可能已被其它入口删除，点击失败时即时刷新总览，移除失效条目。
                refreshActiveConversationThreadOverviewDrawer();
              }
            })
            .catch((error) => {
              console.warn('[chat_history_ui] 线程总览跳转失败', error);
              showNotification?.({ message: '线程打开失败，请稍后重试', type: 'warning', duration: 1800 });
            });
        });

        groupSection.appendChild(button);
      }

      list.appendChild(groupSection);
    });

    wrapper.appendChild(header);
    wrapper.appendChild(list);
    return wrapper;
  }

  function syncThreadOverviewDrawerGeometry() {
    if (!threadOverviewDrawer || !chatLayout || !chatContainer) return;
    const layoutRect = chatLayout.getBoundingClientRect();
    const chatRect = chatContainer.getBoundingClientRect();
    if (!layoutRect.width || !chatRect.width) return;

    const centerX = (chatRect.left - layoutRect.left) + (chatRect.width / 2);
    const targetWidth = Math.max(320, Math.min(760, Math.max(0, chatRect.width - 26)));
    const drawerLeft = centerX;
    const drawerWidth = targetWidth;

    threadOverviewDrawer.style.setProperty('--thread-overview-drawer-left', `${drawerLeft}px`);
    threadOverviewDrawer.style.setProperty('--thread-overview-drawer-width', `${drawerWidth}px`);
  }

  function syncThreadOverviewDrawerState() {
    if (!threadOverviewDrawer || !threadOverviewDrawerHandle || !threadOverviewDrawerPanel) return;
    const hasContent = !!threadOverviewHasContent;
    const isOpen = hasContent && threadOverviewExpanded;
    const isPinned = hasContent && threadOverviewPinned && isOpen;
    const showHandle = hasContent && (threadOverviewHandleVisible || isOpen);

    threadOverviewDrawer.classList.toggle('is-available', hasContent);
    threadOverviewDrawer.classList.toggle('is-open', isOpen);
    threadOverviewDrawer.classList.toggle('is-pinned', isPinned);
    threadOverviewDrawer.classList.toggle('is-handle-visible', showHandle);
    threadOverviewDrawer.setAttribute('aria-hidden', hasContent ? 'false' : 'true');

    const nextAction = !hasContent
      ? 'none'
      : (isPinned
        ? (threadOverviewHandleHovered ? 'collapse' : 'pinned')
        : (isOpen ? 'pin' : 'expand'));
    const actionMeta = nextAction === 'collapse'
      ? { label: '收起线程抽屉', iconClass: 'fa-solid fa-chevron-up' }
      : (nextAction === 'pinned'
        ? { label: '已固定（悬停后点击可收起）', iconClass: 'fa-solid fa-thumbtack' }
        : (nextAction === 'pin'
          ? { label: '固定线程抽屉', iconClass: 'fa-solid fa-thumbtack' }
          : { label: '展开并固定线程抽屉', iconClass: 'fa-solid fa-chevron-down' }));
    if (!threadOverviewDrawerHandleIcon) {
      threadOverviewDrawerHandleIcon = threadOverviewDrawerHandle.querySelector('i');
    }
    if (threadOverviewDrawerHandleIcon) {
      threadOverviewDrawerHandleIcon.className = `${actionMeta.iconClass} conversation-thread-overview-drawer__handle-icon`;
    }
    threadOverviewDrawerHandle.dataset.action = nextAction;
    threadOverviewDrawerHandle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    threadOverviewDrawerHandle.setAttribute('aria-label', actionMeta.label);
    threadOverviewDrawerHandle.title = actionMeta.label;
    threadOverviewDrawerPanel.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
  }

  function setThreadOverviewHandleVisible(visible) {
    const nextVisible = !!visible && threadOverviewHasContent;
    if (threadOverviewHandleVisible === nextVisible) return;
    threadOverviewHandleVisible = nextVisible;
    syncThreadOverviewDrawerGeometry();
    syncThreadOverviewDrawerState();
  }

  function setThreadOverviewExpanded(expanded, options = {}) {
    const nextExpanded = !!expanded && threadOverviewHasContent;
    if (threadOverviewExpanded === nextExpanded) return;
    const keepHandleVisible = options?.keepHandleVisible === true;
    threadOverviewExpanded = nextExpanded;
    if (!threadOverviewExpanded && !keepHandleVisible) {
      threadOverviewHandleVisible = false;
    }
    syncThreadOverviewDrawerGeometry();
    syncThreadOverviewDrawerState();
  }

  function shouldShowThreadOverviewHandleAt(clientX, clientY) {
    if (!chatContainer || !threadOverviewHasContent) return false;
    const rect = chatContainer.getBoundingClientRect();
    const inHorizontalRange = clientX >= rect.left && clientX <= rect.right;
    if (!inHorizontalRange) return false;
    const relativeTop = clientY - rect.top;
    return relativeTop >= -2 && relativeTop <= THREAD_OVERVIEW_TOP_TRIGGER_PX;
  }

  function bindThreadOverviewDrawerEventsOnce() {
    if (threadOverviewDrawerEventsBound || !chatContainer) return;
    threadOverviewDrawerEventsBound = true;

    // 仅在鼠标靠近主聊天顶部时显示“下拉标记”，避免常驻占位影响阅读。
    chatContainer.addEventListener('mousemove', (event) => {
      if (!threadOverviewHasContent) return;
      if (threadOverviewPinned) {
        setThreadOverviewHandleVisible(true);
        return;
      }
      if (threadOverviewExpanded) {
        setThreadOverviewHandleVisible(true);
        return;
      }
      const shouldShow = shouldShowThreadOverviewHandleAt(event.clientX, event.clientY);
      setThreadOverviewHandleVisible(shouldShow);
    }, { passive: true });

    chatContainer.addEventListener('mouseleave', () => {
      if (threadOverviewPinned || threadOverviewExpanded) return;
      setThreadOverviewHandleVisible(false);
    });

    chatContainer.addEventListener('scroll', () => {
      if (threadOverviewPinned || threadOverviewExpanded) return;
      setThreadOverviewHandleVisible(false);
    }, { passive: true });

    window.addEventListener('resize', () => {
      syncThreadOverviewDrawerGeometry();
    }, { passive: true });

    if (typeof ResizeObserver === 'function' && !threadOverviewDrawerResizeObserver) {
      threadOverviewDrawerResizeObserver = new ResizeObserver(() => {
        syncThreadOverviewDrawerGeometry();
      });
      if (chatLayout) {
        threadOverviewDrawerResizeObserver.observe(chatLayout);
      }
      threadOverviewDrawerResizeObserver.observe(chatContainer);
    }

    if (typeof MutationObserver === 'function' && !threadOverviewDrawerLayoutObserver) {
      threadOverviewDrawerLayoutObserver = new MutationObserver(() => {
        // 线程模式切换会通过 body class 改变聊天列宽度，这里补一次几何同步避免位置漂移。
        syncThreadOverviewDrawerGeometry();
      });
      threadOverviewDrawerLayoutObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['class']
      });
    }
  }

  function ensureThreadOverviewDrawer() {
    if (!chatLayout) return null;
    if (threadOverviewDrawer && threadOverviewDrawer.isConnected) return threadOverviewDrawer;

    const drawer = document.createElement('div');
    drawer.className = 'conversation-thread-overview-drawer';
    drawer.setAttribute('aria-hidden', 'true');

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'conversation-thread-overview-drawer__handle';
    const handleIcon = document.createElement('i');
    handleIcon.className = 'fa-solid fa-chevron-down conversation-thread-overview-drawer__handle-icon';
    handleIcon.setAttribute('aria-hidden', 'true');
    handle.appendChild(handleIcon);
    handle.setAttribute('aria-label', '展开线程抽屉');
    handle.setAttribute('aria-expanded', 'false');
    handle.title = '展开线程抽屉';
    handle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!threadOverviewHasContent) return;
      if (threadOverviewPinned) {
        threadOverviewPinned = false;
        threadOverviewHandleVisible = true;
        setThreadOverviewExpanded(false, { keepHandleVisible: true });
        syncThreadOverviewDrawerGeometry();
        syncThreadOverviewDrawerState();
        return;
      }
      threadOverviewPinned = true;
      threadOverviewHandleVisible = true;
      setThreadOverviewExpanded(true, { keepHandleVisible: true });
      syncThreadOverviewDrawerGeometry();
      syncThreadOverviewDrawerState();
    });
    handle.addEventListener('mouseenter', () => {
      threadOverviewHandleHovered = true;
      syncThreadOverviewDrawerState();
      if (!threadOverviewHasContent) return;
      setThreadOverviewHandleVisible(true);
      if (threadOverviewPinned) return;
      setThreadOverviewExpanded(true, { keepHandleVisible: true });
    });
    handle.addEventListener('mouseleave', () => {
      threadOverviewHandleHovered = false;
      syncThreadOverviewDrawerState();
      if (threadOverviewPinned || threadOverviewExpanded) return;
      setThreadOverviewHandleVisible(false);
    });

    const panel = document.createElement('div');
    panel.className = 'conversation-thread-overview-drawer__panel';
    panel.setAttribute('aria-hidden', 'true');

    drawer.appendChild(handle);
    drawer.appendChild(panel);
    chatLayout.appendChild(drawer);

    // 悬停展开：鼠标离开整个抽屉区域时自动收起（仅对未固定状态生效）。
    drawer.addEventListener('mouseleave', () => {
      threadOverviewHandleHovered = false;
      syncThreadOverviewDrawerState();
      if (!threadOverviewHasContent || threadOverviewPinned) return;
      setThreadOverviewExpanded(false);
      setThreadOverviewHandleVisible(false);
    });

    threadOverviewDrawer = drawer;
    threadOverviewDrawerHandle = handle;
    threadOverviewDrawerHandleIcon = handleIcon;
    threadOverviewDrawerPanel = panel;

    bindThreadOverviewDrawerEventsOnce();
    syncThreadOverviewDrawerGeometry();
    syncThreadOverviewDrawerState();
    requestAnimationFrame(() => syncThreadOverviewDrawerGeometry());
    return drawer;
  }

  function clearThreadOverviewDrawer() {
    threadOverviewHasContent = false;
    threadOverviewExpanded = false;
    threadOverviewPinned = false;
    threadOverviewHandleHovered = false;
    threadOverviewHandleVisible = false;
    if (threadOverviewDrawerPanel) {
      threadOverviewDrawerPanel.innerHTML = '';
    }
    syncThreadOverviewDrawerState();
  }

  function renderConversationThreadOverviewDrawer(conversation) {
    ensureThreadOverviewDrawer();
    if (!threadOverviewDrawerPanel) return;

    const overviewElement = createConversationThreadOverviewElement(conversation);
    if (!overviewElement) {
      clearThreadOverviewDrawer();
      return;
    }

    threadOverviewDrawerPanel.innerHTML = '';
    threadOverviewDrawerPanel.appendChild(overviewElement);
    threadOverviewHasContent = true;
    if (threadOverviewPinned) {
      threadOverviewExpanded = true;
      threadOverviewHandleVisible = true;
    } else if (threadOverviewExpanded) {
      threadOverviewHandleVisible = true;
    } else {
      threadOverviewHandleVisible = false;
    }
    syncThreadOverviewDrawerGeometry();
    syncThreadOverviewDrawerState();
  }

  function refreshActiveConversationThreadOverviewDrawer() {
    const activeMessages = Array.isArray(services.chatHistoryManager?.chatHistory?.messages)
      ? services.chatHistoryManager.chatHistory.messages
      : [];
    if (!activeMessages.length) {
      clearThreadOverviewDrawer();
      return;
    }

    const baseConversation = (activeConversation && typeof activeConversation === 'object')
      ? activeConversation
      : {};
    // 线程总览只依赖当前会话内存态，避免读取旧缓存导致删除后残留。
    renderConversationThreadOverviewDrawer({
      ...baseConversation,
      id: currentConversationId || baseConversation.id || '',
      messages: activeMessages
    });
  }

  function renderApiFooterForMessageElement(messageElem, msg, options = {}) {
    if (!messageElem || !msg) return;
    const normalizedRole = String(options.role ?? msg.role ?? '').toLowerCase();
    const isAiMessage = normalizedRole === 'assistant' || normalizedRole === 'ai';
    if (!isAiMessage) return;

    const footer = messageElem.querySelector('.api-footer') || (() => {
      const element = document.createElement('div');
      element.className = 'api-footer';
      messageElem.appendChild(element);
      return element;
    })();

    const allConfigs = Array.isArray(options.allConfigs)
      ? options.allConfigs
      : (services.apiManager.getAllConfigs?.() || []);
    const footerTemplate = (typeof options.template === 'string')
      ? options.template
      : settingsManager?.getSetting?.('aiFooterTemplate');
    const footerInlineSeparator = (typeof options.inlineSeparator === 'string')
      ? options.inlineSeparator
      : settingsManager?.getSetting?.('aiFooterInlineSeparator');
    const footerTooltipTemplate = (typeof options.tooltipTemplate === 'string')
      ? options.tooltipTemplate
      : settingsManager?.getSetting?.('aiFooterTooltipTemplate');
    const renderData = buildApiFooterRenderData(msg, {
      allConfigs,
      template: footerTemplate,
      inlineSeparator: footerInlineSeparator,
      tooltipTemplate: footerTooltipTemplate
    });
    footer.textContent = renderData.text;
    footer.title = renderData.title;
  }

  function refreshVisibleAiMessageFooters() {
    const historyMessages = Array.isArray(services.chatHistoryManager?.chatHistory?.messages)
      ? services.chatHistoryManager.chatHistory.messages
      : [];
    if (!historyMessages.length) return;
    const nodeById = new Map(historyMessages.map(node => [node?.id, node]));
    const allConfigs = services.apiManager.getAllConfigs?.() || [];
    const footerTemplate = settingsManager?.getSetting?.('aiFooterTemplate');
    const footerInlineSeparator = settingsManager?.getSetting?.('aiFooterInlineSeparator');
    const footerTooltipTemplate = settingsManager?.getSetting?.('aiFooterTooltipTemplate');
    const containers = [chatContainer, threadContainer].filter(Boolean);

    containers.forEach((container) => {
      const messageElements = container.querySelectorAll('.message.ai-message[data-message-id]');
      messageElements.forEach((messageElem) => {
        const messageId = messageElem.getAttribute('data-message-id') || '';
        const node = nodeById.get(messageId);
        if (!node) return;
        renderApiFooterForMessageElement(messageElem, node, {
          role: 'ai',
          allConfigs,
          template: footerTemplate,
          inlineSeparator: footerInlineSeparator,
          tooltipTemplate: footerTooltipTemplate
        });
      });
    });
  }

  const refreshFooterOnSettingChanged = () => {
    try {
      refreshVisibleAiMessageFooters();
    } catch (_) {}
  };
  settingsManager?.subscribe?.('aiFooterTemplate', refreshFooterOnSettingChanged);
  settingsManager?.subscribe?.('aiFooterInlineSeparator', refreshFooterOnSettingChanged);
  settingsManager?.subscribe?.('aiFooterTooltipTemplate', refreshFooterOnSettingChanged);

  /**
   * 加载选中的对话记录到当前聊天窗口
   * @param {Object} conversation - 对话记录对象
   */
  async function loadConversationIntoChat(conversation, options = {}) {
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const skipMessageAnimation = !!normalizedOptions.skipMessageAnimation;
    const skipScrollToBottom = !!normalizedOptions.skipScrollToBottom;
    utils.resetConversationScopedComposerState?.({ preservePendingRequestUserInput: true });
    // 切换/打开会话时确保线程状态同步关闭，避免残留线程面板。
    services.selectionThreadManager?.resetForClearChat?.();
    // 如果传入的是简化版会话对象（可能只有id），则加载完整版
    let fullConversation = conversation;
    if (!conversation.messages || conversation.messages.length === 0) {
      fullConversation = await getConversationFromCacheOrLoad(conversation.id);
    }
    
    // 设置为当前活动会话
    activeConversation = fullConversation;
    activeConversationApiLock = normalizeConversationApiLock(fullConversation?.apiLock);
    
    // 清空当前聊天容器
    chatContainer.innerHTML = '';
    renderConversationThreadOverviewDrawer(fullConversation);

    // 性能优化：
    // - 预热下载根目录缓存：避免首次遇到图片时触发 chrome.storage.local 读取造成额外卡顿；
    // - 使用 DocumentFragment 批量插入 DOM，减少大量 appendChild 带来的反复回流/重绘；
    // - 注意：messageProcessor.appendMessage 在传入 fragment 时会给消息加上 batch-load class（用于动画）。
    //   “继续本页对话”属于快速恢复场景，这里移除 batch-load，确保视觉行为与之前一致。
    try { await loadDownloadRoot(); } catch (_) {}
    const fragment = document.createDocumentFragment();

    const extractInlineImgSrcs = (html) => {
      const set = new Set();
      if (typeof html !== 'string' || !html.includes('<img')) return set;
      const re = /<img\b[^>]*\bsrc\s*=\s*(['"])(.*?)\1/gi;
      let m = null;
      while ((m = re.exec(html)) !== null) {
        const src = m[2] || '';
        if (src) set.add(src);
      }
      return set;
    };
    const footerTemplate = settingsManager?.getSetting?.('aiFooterTemplate');
    const footerTooltipTemplate = settingsManager?.getSetting?.('aiFooterTooltipTemplate');
    const apiConfigsSnapshot = services.apiManager.getAllConfigs?.() || [];

    // 遍历对话中的每条消息并显示
    for (const msg of fullConversation.messages) {
      if (msg?.threadId || msg?.threadHiddenSelection) {
        continue;
      }
      normalizeThinkingForMessage(msg);
      const role = msg.role.toLowerCase() === 'assistant' ? 'ai' : msg.role;
      let messageElem = null;
      const thoughtsToDisplay = msg.thoughtsRaw || null; // 获取思考过程文本

      msg.content = normalizeStoredMessageContent(msg.content);

      if (Array.isArray(msg.content)) {
        const { text, images } = splitStoredMessageContent(msg.content);
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
          messageElem = appendMessage(combinedContent, role, true, fragment, null, thoughtsToDisplay);
        } else {
          const legacyImagesContainer = document.createElement('div');
          uniqueDisplayUrls.forEach((u) => {
            const imageTag = createImageTag(u, null);
            legacyImagesContainer.appendChild(imageTag);
          });
          const imagesHTML = legacyImagesContainer.innerHTML;
          messageElem = appendMessage(combinedContent, role, true, fragment, imagesHTML, thoughtsToDisplay);
        }
      } else {
        // 调用 appendMessage 时传递 thoughtsToDisplay
        messageElem = appendMessage(msg.content, role, true, fragment, null, thoughtsToDisplay);
      }

      if (messageElem && messageElem.classList) {
        messageElem.classList.remove('batch-load');
        if (skipMessageAnimation) {
          // 历史跳转场景禁用入场动画，避免定位消息时出现“先空白后出现”的延迟感
          messageElem.classList.add('skip-appear-animation');
        }
      }
      messageElem.setAttribute('data-message-id', msg.id);
      try {
        services.messageProcessor?.syncAssistantMessageView?.(msg.id, {
          node: msg,
          fallbackElement: messageElem
        });
      } catch (_) {}
      try {
        services.messageProcessor?.syncUserContextualInputDebugView?.(msg.id, {
          node: msg,
          fallbackElement: messageElem
        });
      } catch (_) {}
      // 兼容旧路径：若上面的统一 renderer 不可用，再回退到历史 footer 渲染函数。
      try {
        if (typeof services.messageProcessor?.syncAssistantMessageView !== 'function') {
          renderApiFooterForMessageElement(messageElem, msg, {
            role,
            allConfigs: apiConfigsSnapshot,
            template: footerTemplate,
            tooltipTemplate: footerTooltipTemplate
          });
        }
      } catch (_) {}

      // 划词线程：根据历史节点补回高亮
      try {
        services.selectionThreadManager?.decorateMessageElement?.(messageElem, msg);
      } catch (_) {}
    }

    // 批量插入：一次性提交到 DOM，显著降低大对话恢复时的卡顿/延迟
    chatContainer.appendChild(fragment);
    // 恢复加载的对话历史到聊天管理器
    // 修改: 使用 services.chatHistoryManager.chatHistory 访问数据对象
    services.chatHistoryManager.chatHistory.messages = fullConversation.messages.slice();
    services.chatHistoryManager.chatHistory.root = fullConversation.messages.length > 0 ? fullConversation.messages[0].id : null;
    const lastMainMessage = [...fullConversation.messages].reverse().find(m => !m?.threadId && !m?.threadHiddenSelection) || null;
    services.chatHistoryManager.chatHistory.currentNode = lastMainMessage
      ? lastMainMessage.id
      : (fullConversation.messages.length > 0 ? fullConversation.messages[fullConversation.messages.length - 1].id : null);
    services.chatHistoryManager.chatHistory.conversationRevision = Number.isFinite(Number(fullConversation?.conversationRevision))
      ? Math.max(0, Math.floor(Number(fullConversation.conversationRevision)))
      : 0;
    services.chatHistoryManager.chatHistory.promptCacheKey = normalizeResponsesPromptCacheKey(fullConversation?.promptCacheKey);
    // 保存加载的对话记录ID，用于后续更新操作
    currentConversationId = fullConversation.id;
    
    // 通知消息发送器当前会话ID已更新
    services.messageSender.setCurrentConversationId(currentConversationId);
    emitConversationApiContextChanged();

    if (!skipScrollToBottom) {
      const jumped = await jumpToLatestConversationMessage(fullConversation);
      if (!jumped) {
        // 兜底：若无法定位最新消息，则回退到主聊天区最后一条 AI 消息。
        requestAnimationFrame(() => {
          const aiMessages = chatContainer.querySelectorAll('.message.ai-message');
          if (aiMessages.length > 0) {
            const latestAiMessage = aiMessages[aiMessages.length - 1];
            const rect = latestAiMessage.getBoundingClientRect();
            const computedStyle = window.getComputedStyle(latestAiMessage);
            const marginBottom = parseInt(computedStyle.marginBottom, 10);
            const scrollTop = latestAiMessage.offsetTop + rect.height - marginBottom;
            chatContainer.scrollTo({
              top: scrollTop,
              behavior: 'instant'
            });
          }
        });
      }
    }

    const pendingRequestUserInput = findPendingRequestUserInputFromConversationMessages(fullConversation.messages);
    if (pendingRequestUserInput?.questions?.length > 0 && typeof utils.showRequestUserInput === 'function') {
      window.requestAnimationFrame(() => {
        utils.showRequestUserInput({ questions: pendingRequestUserInput.questions }).catch((error) => {
          console.warn('恢复未完成 request_user_input 面板失败:', error);
        });
      });
    }
  }

  function scrollMessageElementToTop(messageEl, options = {}) {
    if (!chatContainer || !messageEl) return;
    const highlightClass = options.highlightClass || '';
    const highlightDuration = Number.isFinite(options.highlightDuration) ? options.highlightDuration : 500;
    const applyScroll = () => {
      const containerRect = chatContainer.getBoundingClientRect();
      const targetRect = messageEl.getBoundingClientRect();
      const style = window.getComputedStyle(chatContainer);
      const paddingTop = parseFloat(style.paddingTop) || 0;
      const delta = targetRect.top - containerRect.top;
      const rawTop = chatContainer.scrollTop + delta - paddingTop;
      const maxTop = Math.max(0, chatContainer.scrollHeight - chatContainer.clientHeight);
      const nextTop = Math.max(0, Math.min(rawTop, maxTop));
      chatContainer.scrollTo({ top: nextTop, behavior: 'auto' });
    };

    applyScroll();
    requestAnimationFrame(applyScroll);

    const images = messageEl.querySelectorAll('img');
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

    if (highlightClass) {
      messageEl.classList.remove(highlightClass);
      void messageEl.offsetWidth;
      messageEl.classList.add(highlightClass);
      setTimeout(() => messageEl.classList.remove(highlightClass), highlightDuration);
    }
  }

  function jumpToMessageById(messageId, options = {}) {
    if (!messageId) return;
    const tryJump = () => {
      const rawId = String(messageId);
      let safeId = rawId;
      try {
        if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
          safeId = CSS.escape(rawId);
        }
      } catch (_) {
        safeId = rawId.replace(/["\\]/g, '\\$&');
      }
      const target = chatContainer.querySelector(`.message[data-message-id="${safeId}"]`);
      if (!target) return false;
      scrollMessageElementToTop(target, options);
      return true;
    };
    if (tryJump()) return;
    requestAnimationFrame(() => {
      tryJump();
    });
  }

  function highlightMessageInChat(messageId) {
    jumpToMessageById(messageId, { highlightClass: 'search-highlight', highlightDuration: 500 });
  }

  function removeSearchSummary(panel) {
    if (!panel) return;
    const summary = panel.querySelector('.search-result-summary');
    if (summary && summary.parentNode) {
      summary.remove();
    }
  }

  function renderSearchSummary(panel, info = {}) {
    if (!panel) return;
    const filterContainer = panel.querySelector('.filter-container');
    if (!filterContainer) return;

    const queryText = (info.query || '').trim();
    const scannedCount = Math.max(0, Number(info.scannedCount || 0));
    const resultCount = Math.max(0, Number(info.resultCount || 0));
    const excerptCount = Math.max(0, Number(info.excerptCount || 0));
    const durationMs = typeof info.durationMs === 'number' ? info.durationMs : null;
    const reused = !!info.reused;
    const highlightPlan = (info.highlightPlan && typeof info.highlightPlan === 'object')
      ? info.highlightPlan
      : buildHistoryHighlightPlanByFilterText(queryText);
    const keywordEntries = Array.isArray(highlightPlan?.keywordEntries) ? highlightPlan.keywordEntries : [];

    let summary = panel.querySelector('.search-result-summary');
    if (!summary) {
      summary = document.createElement('div');
      summary.className = 'search-result-summary';
      filterContainer.insertAdjacentElement('afterend', summary);
    }

    let durationText = '';
    if (durationMs !== null) {
      if (durationMs >= 1000) {
        const seconds = durationMs / 1000;
        durationText = `${seconds.toFixed(seconds >= 10 ? 1 : 2)}秒`;
      } else {
        durationText = `${Math.max(1, Math.round(durationMs))}毫秒`;
      }
    }

    const metaParts = [];
    if (scannedCount) metaParts.push(`遍历 ${scannedCount} 条会话`);
    metaParts.push(`匹配 ${resultCount} 条聊天记录`);
    if (excerptCount) metaParts.push(`提取 ${excerptCount} 条消息预览`);
    if (durationText) metaParts.push(`耗时 ${durationText}`);
    if (reused) metaParts.push('缓存结果');

    // 搜索词已在输入框中可见，这里不重复回显原始查询文本，避免信息冗余。
    const summaryTitle = '搜索结果';
    summary.textContent = '';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'summary-title';
    titleSpan.textContent = summaryTitle;
    if (queryText && keywordEntries.length) {
      // 在“搜索详情”同一行直接展示关键词颜色映射，避免额外一行 token 造成遮挡与布局抖动。
      const keywordWrap = document.createElement('span');
      keywordWrap.className = 'summary-keyword-inline-wrap';
      keywordEntries.forEach((entry) => {
        const chip = document.createElement('span');
        chip.className = 'search-keyword-chip summary-keyword-inline';
        const chipColor = entry?.color || '';
        if (chipColor) {
          chip.style.setProperty('--keyword-chip-color', chipColor);
        }
        chip.title = `关键词：${entry?.term || ''}`;

        const dot = document.createElement('span');
        dot.className = 'search-keyword-chip-dot';
        if (chipColor) {
          dot.style.backgroundColor = chipColor;
        }

        const text = document.createElement('span');
        text.className = 'search-keyword-chip-text';
        text.textContent = entry?.term || '';

        chip.appendChild(dot);
        chip.appendChild(text);
        keywordWrap.appendChild(chip);
      });
      titleSpan.appendChild(keywordWrap);
    }
    const metaSpan = document.createElement('span');
    metaSpan.className = 'summary-meta';
    metaSpan.textContent = metaParts.join(' · ');
    summary.appendChild(titleSpan);
    summary.appendChild(metaSpan);
  }
  /**
   * Clear current chat view and reset active conversation pointer.
   *
   * By default this does NOT abort in-flight streaming requests.
   * Use abortActiveRequests=true only for explicit stop semantics.
   *
   * @param {{ abortActiveRequests?: boolean }} [options]
   * @returns {Promise<void>}
   */
  async function clearChatHistory(options = {}) {
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const abortActiveRequests = normalizedOptions.abortActiveRequests === true;
    if (abortActiveRequests) {
      services.messageSender.abortCurrentRequest();
    }
    utils.resetConversationScopedComposerState?.({ preservePendingRequestUserInput: true });
    // Keep clear-chat lightweight: do not trigger an extra save here.
    services.selectionThreadManager?.resetForClearChat?.();
    // 清空聊天容器和内存中的聊天记录
    chatContainer.innerHTML = '';
    clearThreadOverviewDrawer();
    // 修改: 直接调用 services.chatHistoryManager.clearHistory()
    services.chatHistoryManager.clearHistory();
    // 重置当前会话ID，确保下次发送新消息创建新会话
    currentConversationId = null;
    activeConversation = null;
    activeConversationApiLock = null;
    
    // 通知消息发送器当前会话ID已重置
    services.messageSender.setCurrentConversationId(null);
    emitConversationApiContextChanged();
  }

  /**
   * 格式化相对时间字符串
   * @param {Date} date - 日期对象
   * @returns {string} 相对时间描述，例如 "5分钟前"、"2小时前"、"3天前"
   */
  function formatRelativeTime(date) {
    const now = new Date();
    const diff = now - date; // 毫秒差
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return `${seconds}秒前`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    return `${days}天前`;
  }

  function extractTimestampFromMessageId(messageId) {
    if (typeof messageId !== 'string' || !messageId) return null;
    const match = messageId.match(/(?:^|_)(\d{10,13})(?:_|$)/);
    if (!match) return null;
    const raw = Number(match[1]);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    // 兼容秒级与毫秒级时间戳。
    return raw < 1e12 ? raw * 1000 : raw;
  }

  function getGalleryMessageTimestamp(message, conversation) {
    const ts = Number(message?.timestamp);
    if (Number.isFinite(ts) && ts > 0) return ts;
    const idTs = extractTimestampFromMessageId(message?.id);
    if (Number.isFinite(idTs) && idTs > 0) return idTs;
    const convStart = Number(conversation?.startTime);
    if (Number.isFinite(convStart) && convStart > 0) return convStart;
    return Date.now();
  }

  function getGalleryMonthKey(timestamp) {
    const ts = Number(timestamp);
    const date = Number.isFinite(ts) ? new Date(ts) : new Date();
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    return `${year}-${String(month).padStart(2, '0')}`;
  }

  function formatGalleryMonthLabel(timestamp) {
    const ts = Number(timestamp);
    const date = Number.isFinite(ts) ? new Date(ts) : new Date();
    return `${date.getFullYear()}年${date.getMonth() + 1}月`;
  }

  /**
   * 根据日期生成分组标签
   * @param {Date} date - 日期对象
   * @returns {string} 分组标签，如 "今天"、"昨天"、"本周"、"上周"、"本月" 或 "YYYY年M月"
   */
  function getGroupLabel(date) {
    const now = new Date();
    if (date.toDateString() === now.toDateString()) return "今天";
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return "昨天";
    // 以星期一为一周起点
    const day = now.getDay(); // 0代表星期日
    const diffToMonday = (day === 0 ? 6 : day - 1);
    const monday = new Date(now);
    monday.setDate(now.getDate() - diffToMonday);
    if (date >= monday) return "本周";
    const lastMonday = new Date(monday);
    lastMonday.setDate(monday.getDate() - 7);
    if (date >= lastMonday) return "上周";
    if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) {
      return "本月";
    }
    return `${date.getFullYear()}年${date.getMonth() + 1}月`;
  }

  /**
   * 检查聊天历史面板是否打开
   * @returns {boolean} 面板是否打开
   */
  function isChatHistoryPanelOpen() {
    const panel = document.getElementById('chat-history-panel');
    if (panel && panel.classList.contains('visible')) {
      return true;
    }
    return false;
  }

  /**
   * 统一关闭聊天记录面板的函数
   */
  function closeChatHistoryPanel() {
    const panel = document.getElementById('chat-history-panel');
    if (panel && panel.classList.contains('visible')) {
      persistChatHistoryPanelLayout(panel);
      if (typeof panel._cancelDragMove === 'function') {
        panel._cancelDragMove();
      }
      if (typeof panel._cancelResizeMove === 'function') {
        panel._cancelResizeMove();
      }
      const activeTabName = panel.querySelector('.history-tab.active')?.dataset?.tab;
      lastClosedTabName = activeTabName || lastClosedTabName || 'history';
      lastClosedAt = Date.now();
      if (activeTabName === 'history') {
        const listContainer = panel.querySelector('#chat-history-list');
        if (listContainer) {
          historyPanelScrollSnapshot = {
            scrollTop: listContainer.scrollTop,
            capturedAt: Date.now(),
            filter: panel.dataset.currentFilter || '',
            urlMode: panel.dataset.urlFilterMode || '',
            branchMode: panel.dataset.branchViewMode || ''
          };
        }
      }
      // 关闭面板时一并关闭 hover 预览 tooltip，避免遗留浮层
      hideChatHistoryPreviewTooltip();
      markGalleryInactive(panel);
      panel.classList.remove('visible');
      panel.addEventListener('transitionend', function handler(e) {
        if (e.propertyName === 'opacity' && !panel.classList.contains('visible')) {
          panel.style.display = 'none';
          cleanupHistoryPanel(panel);
          // 尝试将焦点设置回主输入框
          chatInputElement?.focus();
          panel.removeEventListener('transitionend', handler);
        }
      });
    }
  }

  /**
   * 切换聊天历史面板的显示状态
   */
  function toggleChatHistoryPanel() {
    if (isChatHistoryPanelOpen()) {
      closeChatHistoryPanel();
    } else {
      showChatHistoryPanel();
    }
  }

  /**
   * 统一输入弹窗（替代 window.prompt）。
   *
   * 设计目标：
   * - 避免浏览器原生 prompt 的样式割裂与交互受限；
   * - 统一支持单行/多行输入，便于后续复用于重命名、标签编辑、导入 JSON 等场景；
   * - 保持最小依赖：纯 DOM 构建，不引入额外框架。
   *
   * @param {Object} options
   * @param {string} [options.title='输入']
   * @param {string} [options.message='']
   * @param {string} [options.defaultValue='']
   * @param {string} [options.placeholder='']
   * @param {string} [options.confirmText='确定']
   * @param {string} [options.cancelText='取消']
   * @param {boolean} [options.multiline=false]
   * @param {number} [options.rows=6]
   * @param {(value: string) => { ok: boolean, message?: string } | null} [options.validate]
   * @returns {Promise<string|null>} 用户确认返回输入文本；取消返回 null。
   */
  function openUnifiedInputDialog(options = {}) {
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const title = typeof normalizedOptions.title === 'string' && normalizedOptions.title.trim()
      ? normalizedOptions.title.trim()
      : '输入';
    const message = typeof normalizedOptions.message === 'string' ? normalizedOptions.message : '';
    const defaultValue = typeof normalizedOptions.defaultValue === 'string' ? normalizedOptions.defaultValue : '';
    const placeholder = typeof normalizedOptions.placeholder === 'string' ? normalizedOptions.placeholder : '';
    const confirmText = typeof normalizedOptions.confirmText === 'string' && normalizedOptions.confirmText.trim()
      ? normalizedOptions.confirmText.trim()
      : '确定';
    const cancelText = typeof normalizedOptions.cancelText === 'string' && normalizedOptions.cancelText.trim()
      ? normalizedOptions.cancelText.trim()
      : '取消';
    const multiline = normalizedOptions.multiline === true;
    const rows = Math.max(2, Number(normalizedOptions.rows) || 6);
    const validate = typeof normalizedOptions.validate === 'function'
      ? normalizedOptions.validate
      : null;

    return new Promise((resolve) => {
      const root = document.createElement('div');
      root.className = 'cerebr-input-dialog-mask';

      const panel = document.createElement('div');
      panel.className = 'cerebr-input-dialog';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      panel.setAttribute('aria-label', title);
      root.appendChild(panel);

      const titleEl = document.createElement('div');
      titleEl.className = 'cerebr-input-dialog-title';
      titleEl.textContent = title;
      panel.appendChild(titleEl);

      if (message.trim()) {
        const messageEl = document.createElement('div');
        messageEl.className = 'cerebr-input-dialog-message';
        messageEl.textContent = message;
        panel.appendChild(messageEl);
      }

      const inputEl = multiline
        ? document.createElement('textarea')
        : document.createElement('input');
      inputEl.className = 'cerebr-input-dialog-control';
      if (!multiline) {
        inputEl.type = 'text';
      } else {
        inputEl.rows = rows;
      }
      inputEl.value = defaultValue;
      inputEl.placeholder = placeholder;
      panel.appendChild(inputEl);

      const validationHint = document.createElement('div');
      validationHint.className = 'cerebr-input-dialog-validation';
      validationHint.hidden = true;
      panel.appendChild(validationHint);

      const actions = document.createElement('div');
      actions.className = 'cerebr-input-dialog-actions';
      panel.appendChild(actions);

      const cancelButton = document.createElement('button');
      cancelButton.type = 'button';
      cancelButton.className = 'cerebr-input-dialog-button cerebr-input-dialog-button--cancel';
      cancelButton.textContent = cancelText;
      actions.appendChild(cancelButton);

      const confirmButton = document.createElement('button');
      confirmButton.type = 'button';
      confirmButton.className = 'cerebr-input-dialog-button cerebr-input-dialog-button--confirm';
      confirmButton.textContent = confirmText;
      actions.appendChild(confirmButton);

      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', handleKeydown, true);
        if (root.parentElement) root.remove();
      };

      const finish = (value) => {
        cleanup();
        resolve(value);
      };

      const showValidation = (hintText) => {
        const nextText = typeof hintText === 'string' ? hintText.trim() : '';
        if (!nextText) {
          validationHint.hidden = true;
          validationHint.textContent = '';
          inputEl.classList.remove('is-invalid');
          return;
        }
        validationHint.hidden = false;
        validationHint.textContent = nextText;
        inputEl.classList.add('is-invalid');
      };

      const attemptConfirm = () => {
        const value = String(inputEl.value || '');
        if (validate) {
          const result = validate(value);
          if (result && result.ok === false) {
            showValidation(result.message || '输入无效，请检查后重试');
            return;
          }
        }
        showValidation('');
        finish(value);
      };

      const handleKeydown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          // 拦截 Esc，避免透传到底层面板/菜单导致“关闭两层 UI”的连锁行为。
          event.stopPropagation();
          finish(null);
          return;
        }
        if (event.key === 'Enter' && !multiline) {
          event.preventDefault();
          event.stopPropagation();
          attemptConfirm();
        }
      };

      cancelButton.addEventListener('click', () => finish(null));
      confirmButton.addEventListener('click', attemptConfirm);
      root.addEventListener('mousedown', (event) => {
        // 屏蔽事件冒泡，防止外层文档级 click/mousedown 监听器误判为“点击空白处”而关闭其它菜单。
        event.stopPropagation();
        if (event.target === root) {
          finish(null);
        }
      });
      root.addEventListener('click', (event) => {
        event.stopPropagation();
      });
      document.addEventListener('keydown', handleKeydown, true);
      document.body.appendChild(root);

      requestAnimationFrame(() => {
        try {
          inputEl.focus();
          if (typeof inputEl.select === 'function') inputEl.select();
        } catch (_) {}
      });
    });
  }

  /**
   * 显示聊天记录面板的右键菜单
   * @param {MouseEvent} e - 右键事件
   * @param {string} conversationId - 对话记录ID
   * @param {string} [conversationUrl=''] - 对话记录关联的网页 URL（若调用方已知则传入，避免额外读取数据库）
   */
  async function showChatHistoryItemContextMenu(e, conversationId, conversationUrl = '') {
    e.preventDefault();

    /**
     * 将会话记录中的 URL 规范化为可打开链接。
     *
     * 说明：
     * - 历史会话的 url 字段由页面信息写入，可能为空、含空格，或为不可直接打开的协议；
     * - 这里保持与既有逻辑一致：仅允许 http(s) 链接，避免误打开不受支持/不安全的协议。
     *
     * @param {unknown} rawUrl
     * @returns {string} 可打开的 URL（不可用则返回空字符串）
     */
    function normalizeOpenableUrl(rawUrl) {
      if (typeof rawUrl !== 'string') return '';
      const trimmed = rawUrl.trim();
      if (!trimmed) return '';
      if (!/^https?:\/\//i.test(trimmed)) return '';
      return trimmed;
    }

    /**
     * 打开 URL（优先使用 chrome.tabs.create，避免在侧边栏/独立页中被 window.open 的弹窗策略影响）。
     * @param {string} url
     * @returns {Promise<boolean>} 是否成功触发打开动作
     */
    async function openUrlInNewTab(url) {
      const safeUrl = normalizeOpenableUrl(url);
      if (!safeUrl) return false;
      try {
        // 注意：这里必须先用 typeof 判断，避免在非扩展环境下直接引用 chrome 变量导致 ReferenceError。
        if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
          await chrome.tabs.create({ url: safeUrl });
          return true;
        }
      } catch (error) {
        console.warn('使用 chrome.tabs.create 打开链接失败，将回退到 window.open:', error);
      }
      try {
        window.open(safeUrl, '_blank', 'noopener');
        return true;
      } catch (error) {
        console.error('使用 window.open 打开链接失败:', error);
        return false;
      }
    }

    /**
     * 让右键菜单尽量完整显示在视口内（避免靠近边缘时菜单被裁切导致“看起来像没功能”）。
     * @param {HTMLElement} menu
     * @param {number} x
     * @param {number} y
     */
    function clampMenuToViewport(menu, x, y) {
      const margin = 6;
      const menuWidth = menu.offsetWidth || 0;
      const menuHeight = menu.offsetHeight || 0;
      const maxLeft = Math.max(margin, window.innerWidth - menuWidth - margin);
      const maxTop = Math.max(margin, window.innerHeight - menuHeight - margin);
      const left = Math.min(Math.max(margin, x), maxLeft);
      const top = Math.min(Math.max(margin, y), maxTop);
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    }

    // 如果已存在菜单，则删除
    const existingMenu = document.getElementById('chat-history-context-menu');
    if (existingMenu) {
      if (typeof existingMenu.__closeMenu === 'function') {
        existingMenu.__closeMenu();
      } else {
        existingMenu.remove();
      }
    }
    // 创建菜单容器
    const menu = document.createElement('div');
    menu.id = 'chat-history-context-menu';
    // 先按点击位置放置（随后在 append 后再做一次“视口内修正”）
    menu.style.top = e.clientY + 'px';
    menu.style.left = e.clientX + 'px';
    // 添加 CSS 类，设置其他样式
    menu.classList.add('chat-history-context-menu');
    const menuCleanupCallbacks = [];
    let menuClosed = false;
    // 防抖：用于忽略长按删除释放后紧随其后的“外部点击关闭菜单”。
    let ignoreMenuAutoCloseUntil = 0;
    const closeMenu = () => {
      if (menuClosed) return;
      menuClosed = true;
      while (menuCleanupCallbacks.length) {
        const cleanup = menuCleanupCallbacks.pop();
        try { cleanup?.(); } catch (_) {}
      }
      if (menu.parentElement) {
        menu.remove();
      }
      try { delete menu.__closeMenu; } catch (_) {}
    };
    menu.__closeMenu = closeMenu;

    // 右键菜单行为对齐 Windows：在选项上“释放鼠标按键”时触发。
    // 说明：左键与右键都在 pointerup 时触发，不依赖原生 click（click 需要 down/up 同元素）。
    const HISTORY_MENU_ACTION_SELECTOR = '.chat-history-context-menu-option';
    const HISTORY_MENU_ACTIVATE_EVENT = 'menuactivate';
    const resolveHistoryMenuOptionOnRelease = (event) => {
      if (!event) return null;
      const hasCoordinates = typeof event.clientX === 'number' && typeof event.clientY === 'number';
      if (hasCoordinates && typeof document.elementFromPoint === 'function') {
        const releasePointElement = document.elementFromPoint(event.clientX, event.clientY);
        return releasePointElement instanceof Element
          ? releasePointElement.closest(HISTORY_MENU_ACTION_SELECTOR)
          : null;
      }
      return event.target instanceof Element
        ? event.target.closest(HISTORY_MENU_ACTION_SELECTOR)
        : null;
    };
    const dispatchHistoryMenuActivateOnRelease = (event) => {
      if (!event) return;
      const button = Number(event.button);
      if (button !== 0 && button !== 2) return;
      const option = resolveHistoryMenuOptionOnRelease(event);
      if (!option) return;
      if (option.dataset?.triggerMode === 'hold') {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      option.dispatchEvent(new CustomEvent(HISTORY_MENU_ACTIVATE_EVENT, {
        bubbles: true,
        cancelable: true,
        detail: {
          sourceEvent: event,
          button
        }
      }));
    };
    const preventNativeHistoryMenuClick = (event) => {
      const option = event.target instanceof Element
        ? event.target.closest(HISTORY_MENU_ACTION_SELECTOR)
        : null;
      if (!option) return;
      // 所有动作都走 menuactivate，避免 click 语义导致“按下 A、松开 B 不触发 B”。
      event.preventDefault();
      event.stopPropagation();
    };
    const preventNativeContextMenuOnHistoryOption = (event) => {
      const option = event.target instanceof Element
        ? event.target.closest(HISTORY_MENU_ACTION_SELECTOR)
        : null;
      if (!option) return;
      event.preventDefault();
    };
    menu.addEventListener('pointerup', dispatchHistoryMenuActivateOnRelease);
    menu.addEventListener('click', preventNativeHistoryMenuClick, true);
    menu.addEventListener('contextmenu', preventNativeContextMenuOnHistoryOption);
    menuCleanupCallbacks.push(() => menu.removeEventListener('pointerup', dispatchHistoryMenuActivateOnRelease));
    menuCleanupCallbacks.push(() => menu.removeEventListener('click', preventNativeHistoryMenuClick, true));
    menuCleanupCallbacks.push(() => menu.removeEventListener('contextmenu', preventNativeContextMenuOnHistoryOption));

    const appendMenuSeparator = () => {
      const separator = document.createElement('div');
      separator.className = 'chat-history-context-menu-separator';
      separator.setAttribute('role', 'separator');
      menu.appendChild(separator);
    };

    // --- 添加 置顶/取消置顶 选项 ---
    const pinnedIds = await getPinnedIds();
    const isPinned = pinnedIds.includes(conversationId);
    const pinToggleOption = document.createElement('div');
    pinToggleOption.textContent = isPinned ? '取消置顶' : '置顶';
    pinToggleOption.classList.add('chat-history-context-menu-option');
    pinToggleOption.addEventListener(HISTORY_MENU_ACTIVATE_EVENT, async (e) => {
      e.stopPropagation(); // <--- 添加阻止冒泡
      if (isPinned) {
        await unpinConversation(conversationId);
      } else {
        await pinConversation(conversationId);
      }
      closeMenu();
      refreshChatHistory(); // 刷新列表以显示更新后的顺序
    });
    menu.appendChild(pinToggleOption); // 添加到菜单顶部
    // --- 置顶/取消置顶 选项结束 ---

    // 重命名选项
    const renameOption = document.createElement('div');
    renameOption.textContent = '重命名对话';
    renameOption.classList.add('chat-history-context-menu-option');
    renameOption.addEventListener(HISTORY_MENU_ACTIVATE_EVENT, async (e) => {
      e.stopPropagation(); // <--- 添加阻止冒泡
      closeMenu(); // 先关闭菜单
      try {
        const conversation = await getConversationFromCacheOrLoad(conversationId);
        if (conversation) {
          const newName = await openUnifiedInputDialog({
            title: '重命名对话',
            message: '请输入新的对话名称',
            defaultValue: conversation.summary || '',
            placeholder: '例如：调试认证流程',
            validate: (value) => {
              if (!String(value || '').trim()) {
                return { ok: false, message: '名称不能为空' };
              }
              return { ok: true };
            }
          });
          if (newName !== null && newName.trim() !== '') { // 确保用户输入了内容且没有取消
            // 保留 summary/selection 对话的方括号前缀：即便用户删掉，也会在保存时补回。
            const trimmedName = newName.trim();
            const firstUser = Array.isArray(conversation.messages)
              ? conversation.messages.find(msg => (msg?.role || '').toLowerCase() === 'user')
              : null;
            const promptType = typeof firstUser?.promptType === 'string' ? firstUser.promptType : '';
            let prefixTag = '';
            if (promptType === 'summary') prefixTag = '[总结]';
            else if (promptType === 'selection' || promptType === 'query') prefixTag = '[划词解释]';
            if (!prefixTag && typeof conversation.summary === 'string') {
              const summaryTrimmed = conversation.summary.trim();
              if (summaryTrimmed.startsWith('[总结]')) prefixTag = '[总结]';
              else if (summaryTrimmed.startsWith('[划词解释]')) prefixTag = '[划词解释]';
            }
            let finalName = trimmedName;
            if (prefixTag) {
              if (trimmedName.startsWith(prefixTag)) {
                const rest = trimmedName.slice(prefixTag.length).trim();
                finalName = rest ? `${prefixTag} ${rest}` : prefixTag;
              } else {
                finalName = `${prefixTag} ${trimmedName}`.trim();
              }
            }
            const result = await updateConversationSummary(conversation.id, finalName, {
              summarySource: 'manual'
            });
            if (result.ok) {
              showNotification({ message: '对话已重命名', duration: 1800 });
            } else {
              showNotification({ message: '重命名失败，请重试', type: 'error', duration: 2200 });
            }
          }
        }
      } catch (error) {
        console.error('重命名对话失败:', error);
        // 可选：添加失败提示
        showNotification({ message: '重命名失败，请重试', type: 'error', duration: 2200 });
      }
    });
    menu.appendChild(renameOption); // 添加重命名选项

    // 自动生成标题选项（紧随“重命名对话”之后，便于连续进行标题相关操作）
    const autoTitleOption = document.createElement('div');
    autoTitleOption.textContent = '自动生成标题';
    autoTitleOption.classList.add('chat-history-context-menu-option');
    autoTitleOption.addEventListener(HISTORY_MENU_ACTIVATE_EVENT, async (e) => {
      e.stopPropagation();
      closeMenu();
      try {
        await autoGenerateConversationTitleForConversation(conversationId);
      } catch (error) {
        console.error('自动生成标题失败:', error);
        showNotification?.({ message: '自动生成标题失败，请重试', type: 'error', duration: 2200 });
      }
    });
    menu.appendChild(autoTitleOption);
    appendMenuSeparator();

    // 固定 API / 取消固定
    let apiLockSnapshot = null;
    try {
      const displayItem = Array.isArray(currentDisplayItems)
        ? currentDisplayItems.find(item => item?.id === conversationId)
        : null;
      apiLockSnapshot = normalizeConversationApiLock(displayItem?.apiLock);
      if (!apiLockSnapshot) {
        const convForLock = await getConversationFromCacheOrLoad(conversationId);
        apiLockSnapshot = normalizeConversationApiLock(convForLock?.apiLock);
      }
    } catch (_) {
      apiLockSnapshot = null;
    }
    const hasApiLock = !!apiLockSnapshot;
    const apiLockOption = document.createElement('div');
    apiLockOption.textContent = hasApiLock ? '取消固定 API' : '固定当前 API';
    apiLockOption.classList.add('chat-history-context-menu-option');
    apiLockOption.addEventListener(HISTORY_MENU_ACTIVATE_EVENT, async (e) => {
      e.stopPropagation();
      closeMenu();
      if (hasApiLock) {
        await setConversationApiLock(conversationId, null);
        return;
      }
      const currentConfig = services.apiManager?.getSelectedConfig?.() || null;
      if (!currentConfig) {
        showNotification?.({ message: '当前没有可用的 API 配置', type: 'warning', duration: 2000 });
        return;
      }
      await setConversationApiLock(conversationId, currentConfig);
    });
    menu.appendChild(apiLockOption);

    // 打开对话页面（会话关联 URL）选项
    const openUrlOption = document.createElement('div');
    openUrlOption.textContent = '打开对话页面';
    openUrlOption.classList.add('chat-history-context-menu-option');
    openUrlOption.addEventListener(HISTORY_MENU_ACTIVATE_EVENT, async (event) => {
      event.stopPropagation();
      closeMenu();
      try {
        // 优先使用列表元数据携带的 URL（无需读库）；若缺失再回退读取会话详情。
        let urlToOpen = normalizeOpenableUrl(conversationUrl);
        if (!urlToOpen) {
          const conversation = await getConversationFromCacheOrLoad(conversationId);
          urlToOpen = normalizeOpenableUrl(conversation?.url);
        }

        if (!urlToOpen) {
          showNotification({ message: '该对话没有关联 URL', duration: 2200 });
          return;
        }

        const opened = await openUrlInNewTab(urlToOpen);
        if (!opened) {
          showNotification({ message: '无法打开链接，请检查浏览器设置', type: 'error', duration: 2200 });
        }
      } catch (error) {
        console.error('获取对话页面 URL 失败:', error);
        showNotification({ message: '无法打开对话页面，请重试', type: 'error', duration: 2200 });
      }
    });
    menu.appendChild(openUrlOption);
    appendMenuSeparator();

    // 复制聊天记录选项
    const copyOption = document.createElement('div');
    copyOption.textContent = '以 JSON 格式复制';
    copyOption.classList.add('chat-history-context-menu-option');

    copyOption.addEventListener(HISTORY_MENU_ACTIVATE_EVENT, async (e) => {
      e.stopPropagation(); // <--- 添加阻止冒泡
      try {
        // 获取完整会话内容
        const conversation = await getConversationFromCacheOrLoad(conversationId);
        if (conversation) {
          // 创建用于复制的格式化数据
          const copyData = {
            id: conversation.id,
            title: conversation.title || '',
            url: conversation.url || '',
            startTime: new Date(conversation.startTime).toLocaleString(),
            endTime: new Date(conversation.endTime).toLocaleString(),
            messages: conversation.messages.map(msg => ({
              role: msg.role,
              content: msg.content,
              timestamp: new Date(msg.timestamp).toLocaleString()
            }))
          };
          
          // 转换为格式化的 JSON 字符串
          const jsonStr = JSON.stringify(copyData, null, 2);
          
          // 复制到剪贴板
          await navigator.clipboard.writeText(jsonStr);
          
          showNotification({ message: '聊天记录已复制到剪贴板', duration: 2000 });
        }
      } catch (error) {
        console.error('复制聊天记录失败:', error);
        // 显示错误提示
        showNotification({ message: '复制失败，请重试', type: 'error', duration: 2200 });
      }
      closeMenu();
    });

    // 删除选项
    const deleteOption = document.createElement('div');
    deleteOption.textContent = '删除聊天记录';
    deleteOption.classList.add('chat-history-context-menu-option', 'chat-history-context-menu-option--danger');
    deleteOption.dataset.triggerMode = 'hold';
    const DELETE_HOLD_DURATION_SECONDS = 0.72;
    let deleteHoldPointerId = null;
    let deleteHoldStartedAt = 0;
    let deleteHoldProgress = 0;
    let deleteHoldReady = false;
    let deleteHoldRafId = null;
    let deletePointerInsideOption = true;
    let deletingConversation = false;

    const setDeleteHoldProgress = (progress) => {
      const normalized = Math.min(1, Math.max(0, Number(progress) || 0));
      deleteHoldProgress = normalized;
      deleteOption.style.setProperty('--delete-hold-progress', normalized.toFixed(4));
    };

    const syncDeleteOptionHoldState = (state) => {
      const normalizedState = (typeof state === 'string' && state) ? state : 'idle';
      deleteOption.dataset.holdState = normalizedState;
      deleteOption.classList.toggle('is-holding', normalizedState === 'holding');
      deleteOption.classList.toggle('is-hold-ready', normalizedState === 'ready');
      deleteOption.classList.toggle('is-hold-armed', normalizedState === 'armed');
      const showOutsideHint = (normalizedState === 'holding' || normalizedState === 'ready') && !deletePointerInsideOption;
      deleteOption.classList.toggle('is-hold-pointer-outside', showOutsideHint);
      if (normalizedState === 'holding') {
        deleteOption.title = showOutsideHint
          ? '保持按住，并移回按钮内后松开'
          : '继续按住，填满红色进度后松开即可删除';
      } else if (normalizedState === 'ready') {
        deleteOption.title = showOutsideHint
          ? '进度已完成：请移回按钮内再松开'
          : '松开确认删除';
      } else if (normalizedState === 'armed') {
        deleteOption.title = '正在删除聊天记录...';
      } else {
        deleteOption.title = '按住删除按钮，进度满后在按钮内松开确认';
      }
    };
    setDeleteHoldProgress(0);
    syncDeleteOptionHoldState('idle');

    const isPointerInsideDeleteOption = (event) => {
      if (!event || !deleteOption || typeof event.clientX !== 'number' || typeof event.clientY !== 'number') {
        return true;
      }
      const rect = deleteOption.getBoundingClientRect();
      return event.clientX >= rect.left
        && event.clientX <= rect.right
        && event.clientY >= rect.top
        && event.clientY <= rect.bottom;
    };

    const stopDeleteHoldAnimation = () => {
      if (deleteHoldRafId === null) return;
      cancelAnimationFrame(deleteHoldRafId);
      deleteHoldRafId = null;
    };

    const resetDeleteHoldState = (state = 'idle') => {
      stopDeleteHoldAnimation();
      deleteHoldPointerId = null;
      deleteHoldStartedAt = 0;
      deleteHoldReady = false;
      deletePointerInsideOption = true;
      setDeleteHoldProgress(0);
      syncDeleteOptionHoldState(state);
    };

    const updateDeleteHoldProgressFrame = (now) => {
      if (deletingConversation) return;
      if (deleteHoldPointerId === null || deleteHoldStartedAt <= 0) return;
      const elapsedSeconds = Math.max(0, (Number(now) - deleteHoldStartedAt) / 1000);
      const progress = elapsedSeconds / DELETE_HOLD_DURATION_SECONDS;
      setDeleteHoldProgress(progress);
      if (progress >= 1) {
        deleteHoldReady = true;
        syncDeleteOptionHoldState('ready');
        stopDeleteHoldAnimation();
        return;
      }
      deleteHoldRafId = requestAnimationFrame(updateDeleteHoldProgressFrame);
    };

    const triggerDeleteConversation = async () => {
      if (deletingConversation) return;
      deletingConversation = true;
      setDeleteHoldProgress(1);
      syncDeleteOptionHoldState('armed');
      try {
        await deleteConversationRecord(conversationId);
      } finally {
        closeMenu();
      }
    };

    const startDeleteLongPress = (event) => {
      if (!event || deletingConversation) return;
      const button = Number(event.button);
      // 允许左键/右键长按触发删除。
      if (button !== 0 && button !== 2) return;
      event.preventDefault();
      event.stopPropagation();

      const pointerId = Number.isFinite(event.pointerId) ? event.pointerId : null;
      deleteHoldPointerId = pointerId;
      deleteHoldStartedAt = performance.now();
      deleteHoldReady = false;
      deletePointerInsideOption = true;
      setDeleteHoldProgress(0);
      syncDeleteOptionHoldState('holding');

      try {
        if (pointerId !== null && typeof deleteOption.setPointerCapture === 'function') {
          deleteOption.setPointerCapture(pointerId);
        }
      } catch (_) {}

      stopDeleteHoldAnimation();
      deleteHoldRafId = requestAnimationFrame(updateDeleteHoldProgressFrame);
    };

    const updateDeletePointerInsideState = (event) => {
      if (!event) return;
      if (deleteHoldPointerId !== null && Number.isFinite(event.pointerId) && event.pointerId !== deleteHoldPointerId) {
        return;
      }
      deletePointerInsideOption = isPointerInsideDeleteOption(event);
      if (deleteHoldReady) {
        syncDeleteOptionHoldState('ready');
      } else if (deleteHoldPointerId !== null) {
        syncDeleteOptionHoldState('holding');
      }
    };

    const onDeletePointerDown = (event) => startDeleteLongPress(event);
    const onDeletePointerMove = (event) => {
      if (deletingConversation) return;
      if (deleteHoldPointerId === null) return;
      updateDeletePointerInsideState(event);
    };
    const onDeletePointerUp = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (deletingConversation) return;
      if (deleteHoldPointerId !== null && Number.isFinite(event.pointerId) && event.pointerId !== deleteHoldPointerId) {
        return;
      }
      updateDeletePointerInsideState(event);
      ignoreMenuAutoCloseUntil = Date.now() + 220;

      if (deleteHoldReady && deletePointerInsideOption) {
        void triggerDeleteConversation();
        return;
      }
      resetDeleteHoldState('idle');
    };
    const onDeletePointerCancel = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (deleteHoldPointerId !== null && Number.isFinite(event.pointerId) && event.pointerId !== deleteHoldPointerId) {
        return;
      }
      ignoreMenuAutoCloseUntil = Date.now() + 160;
      resetDeleteHoldState('idle');
    };
    const onDeleteLostPointerCapture = () => {
      if (deletingConversation) return;
      if (deleteHoldPointerId === null) return;
      resetDeleteHoldState('idle');
    };
    const onDeleteContextMenu = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const onDeleteClick = (event) => {
      // 删除动作由长按触发，click 仅拦截默认行为，避免误删或触发外层关闭逻辑。
      event.preventDefault();
      event.stopPropagation();
    };

    deleteOption.addEventListener('pointerdown', onDeletePointerDown);
    deleteOption.addEventListener('pointermove', onDeletePointerMove);
    deleteOption.addEventListener('pointerup', onDeletePointerUp);
    deleteOption.addEventListener('pointercancel', onDeletePointerCancel);
    deleteOption.addEventListener('lostpointercapture', onDeleteLostPointerCapture);
    deleteOption.addEventListener('contextmenu', onDeleteContextMenu);
    deleteOption.addEventListener('click', onDeleteClick);
    menuCleanupCallbacks.push(() => resetDeleteHoldState('idle'));
    menuCleanupCallbacks.push(() => deleteOption.removeEventListener('pointerdown', onDeletePointerDown));
    menuCleanupCallbacks.push(() => deleteOption.removeEventListener('pointermove', onDeletePointerMove));
    menuCleanupCallbacks.push(() => deleteOption.removeEventListener('pointerup', onDeletePointerUp));
    menuCleanupCallbacks.push(() => deleteOption.removeEventListener('pointercancel', onDeletePointerCancel));
    menuCleanupCallbacks.push(() => deleteOption.removeEventListener('lostpointercapture', onDeleteLostPointerCapture));
    menuCleanupCallbacks.push(() => deleteOption.removeEventListener('contextmenu', onDeleteContextMenu));
    menuCleanupCallbacks.push(() => deleteOption.removeEventListener('click', onDeleteClick));

    menu.appendChild(copyOption);
    appendMenuSeparator();
    menu.appendChild(deleteOption);
    document.body.appendChild(menu);
    // append 后才能拿到菜单宽高，因此在这里做“视口内修正”
    try {
      clampMenuToViewport(menu, e.clientX, e.clientY);
    } catch (_) {}

    // 点击其他地方时移除菜单
    const onDocClick = () => {
      if (Date.now() < ignoreMenuAutoCloseUntil) {
        return;
      }
      closeMenu();
    };
    document.addEventListener('click', onDocClick);
    menuCleanupCallbacks.push(() => document.removeEventListener('click', onDocClick));
  }

  /**
   * Computes the scrollTop value based on whether the filter has changed.
   * @param {string} previousFilter - The previous filter keyword.
   * @param {string} currentFilter - The current filter keyword.
   * @param {number} currentScrollTop - The current scrollTop value.
   * @returns {number} Returns 0 if the filter has changed, otherwise returns currentScrollTop.
  */
  function computeScrollTop(previousFilter, currentFilter, currentScrollTop) {
    return previousFilter === currentFilter ? currentScrollTop : 0;
  }

  const CHAT_HISTORY_SEARCH_FILTER_KEYS = new Map([
    ['url', 'url'],
    ['count', 'count'],
    ['msg', 'count'],
    ['msgs', 'count'],
    ['messages', 'count'],
    ['messagecount', 'count'],
    ['条数', 'count'],
    ['消息数', 'count'],
    ['date', 'date'],
    ['msgdate', 'date'],
    ['msgtime', 'date'],
    ['消息日期', 'date'],
    ['消息时间', 'date'],
    ['start', 'date'],
    ['begin', 'date'],
    ['from', 'date'],
    ['开始', 'date'],
    ['end', 'date'],
    ['to', 'date'],
    ['结束', 'date'],
    ['scope', 'scope'],
    ['范围', 'scope']
  ]);

  const CHAT_HISTORY_SEARCH_SCOPE_VALUES = new Map([
    ['message', 'message'],
    ['msg', 'message'],
    ['messages', 'message'],
    ['消息', 'message'],
    ['session', 'session'],
    ['conversation', 'session'],
    ['conv', 'session'],
    ['会话', 'session']
  ]);

  function tokenizeSearchQuery(rawInput) {
    const input = typeof rawInput === 'string' ? rawInput : '';
    const tokens = [];
    let buffer = '';
    let inQuotes = false;
    let escapeNext = false;

    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (escapeNext) {
        buffer += ch;
        escapeNext = false;
        continue;
      }
      if (ch === '\\') {
        escapeNext = true;
        continue;
      }
      if (ch === '"') {
        inQuotes = !inQuotes;
        continue;
      }
      if (!inQuotes && /\s/.test(ch)) {
        if (buffer) {
          tokens.push(buffer);
          buffer = '';
        }
        continue;
      }
      buffer += ch;
    }

    if (buffer) tokens.push(buffer);
    return tokens;
  }

  function normalizeSearchTerms(rawTerms) {
    const raw = [];
    const lower = [];
    const seen = new Set();
    (Array.isArray(rawTerms) ? rawTerms : []).forEach((term) => {
      const trimmed = typeof term === 'string' ? term.trim() : '';
      if (!trimmed) return;
      const lowered = trimmed.toLowerCase();
      if (seen.has(lowered)) return;
      seen.add(lowered);
      raw.push(trimmed);
      lower.push(lowered);
    });
    return { raw, lower };
  }

  /**
   * 归一化“关键词高亮计划”中的词条，确保：
   * - 展示文本与 lower key 一一对应；
   * - 去重规则基于 lower（大小写不敏感）；
   * - 顺序保持用户输入顺序，便于颜色与 token 展示稳定。
   *
   * @param {string[]} rawTerms
   * @param {string[]} lowerTerms
   * @returns {Array<{term:string, termLower:string}>}
   */
  function normalizeKeywordHighlightTerms(rawTerms, lowerTerms) {
    const normalizedRaw = Array.isArray(rawTerms) ? rawTerms : [];
    const normalizedLower = Array.isArray(lowerTerms) ? lowerTerms : [];
    const maxLength = Math.max(normalizedRaw.length, normalizedLower.length);
    const entries = [];
    const seen = new Set();
    for (let i = 0; i < maxLength; i += 1) {
      const termRaw = typeof normalizedRaw[i] === 'string' ? normalizedRaw[i].trim() : '';
      const termLowerFromInput = typeof normalizedLower[i] === 'string'
        ? normalizedLower[i].trim().toLowerCase()
        : '';
      const termLower = termLowerFromInput || (termRaw ? termRaw.toLowerCase() : '');
      const term = termRaw || termLower;
      if (!termLower || !term) continue;
      if (seen.has(termLower)) continue;
      seen.add(termLower);
      entries.push({ term, termLower });
    }
    return entries;
  }

  /**
   * 轻量哈希：用于把“查询词 + 关键词”映射到稳定色相，保证：
   * - 同一次查询内颜色稳定；
   * - 查询词不变时刷新列表颜色不跳变；
   * - 不依赖外部随机源，便于复现问题。
   *
   * @param {string} input
   * @returns {number}
   */
  function hashStringToUint32(input) {
    const text = typeof input === 'string' ? input : String(input || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  /**
   * 为每个 lower 关键词生成“不同且稳定”的高亮背景色。
   * 设计要点：
   * - 使用黄金角步进分散色相，降低相邻关键词颜色撞车概率；
   * - 用词条哈希做轻微抖动，让不同查询下色彩分布更自然；
   * - 输出带透明度的 HSL，兼容亮/暗主题并保留正文可读性。
   *
   * @param {string[]} termsLower
   * @param {string} [seedText='']
   * @returns {Record<string, string>}
   */
  function buildKeywordHighlightColorByLower(termsLower, seedText = '') {
    const normalized = normalizeSearchTerms(termsLower);
    const list = normalized.lower;
    const colorMap = Object.create(null);
    if (!list.length) return colorMap;
    const seed = typeof seedText === 'string' ? seedText : '';
    const seedHash = hashStringToUint32(`${seed}::${list.join('|')}`);
    const baseHue = seedHash % 360;
    const GOLDEN_ANGLE = 137.508;
    list.forEach((termLower, index) => {
      const termHash = hashStringToUint32(`${seed}::${termLower}::${index}`);
      const hueJitter = (termHash % 19) - 9;
      const hue = (baseHue + (index * GOLDEN_ANGLE) + hueJitter + 3600) % 360;
      const saturation = 72 + (termHash % 10);
      const lightness = 52 + ((termHash >>> 8) % 10);
      const alpha = 0.36 + (((termHash >>> 16) % 16) / 100);
      colorMap[termLower] = `hsl(${Math.round(hue)} ${saturation}% ${lightness}% / ${alpha.toFixed(2)})`;
    });
    return colorMap;
  }

  /**
   * 构建统一高亮计划（关键词、lower 索引、颜色映射、可展示 token）。
   *
   * @param {string[]} rawTerms
   * @param {string[]} lowerTerms
   * @param {string} [seedText='']
   * @returns {{terms:string[], termsLower:string[], hasTerms:boolean, keywordColorByLower:Record<string,string>, keywordEntries:Array<{term:string, termLower:string, color:string}>}}
   */
  function buildKeywordHighlightPlan(rawTerms, lowerTerms, seedText = '') {
    const entries = normalizeKeywordHighlightTerms(rawTerms, lowerTerms);
    if (!entries.length) {
      return {
        terms: [],
        termsLower: [],
        hasTerms: false,
        keywordColorByLower: Object.create(null),
        keywordEntries: []
      };
    }
    const terms = entries.map(entry => entry.term);
    const termsLower = entries.map(entry => entry.termLower);
    const keywordColorByLower = buildKeywordHighlightColorByLower(termsLower, seedText);
    const keywordEntries = entries.map(entry => ({
      term: entry.term,
      termLower: entry.termLower,
      color: keywordColorByLower[entry.termLower] || ''
    }));
    return {
      terms,
      termsLower,
      hasTerms: termsLower.length > 0,
      keywordColorByLower,
      keywordEntries
    };
  }

  function parseSearchOperatorValue(rawValue) {
    return parseSearchOperatorValueShared(rawValue);
  }

  function parseRelativeDateRange(rawValue) {
    return parseRelativeDateRangeShared(rawValue);
  }

  function parseSearchDateRange(rawValue) {
    return parseSearchDateRangeShared(rawValue);
  }

  function parseSearchFilterToken(rawToken) {
    return parseSearchFilterTokenShared(rawToken);
  }

  function buildChatHistorySearchPlan(rawFilter) {
    return buildChatHistorySearchPlanShared(rawFilter);
  }

  function buildChatHistorySearchCacheContextKey(urlFilterMode, currentUrl) {
    if (!urlFilterMode) return 'all';
    const normalizedUrl = (typeof currentUrl === 'string' ? currentUrl.trim().toLowerCase() : '');
    return `url:${normalizedUrl}`;
  }

  function buildChatHistorySearchCacheKey(plan, urlFilterMode, currentUrl) {
    const contextKey = buildChatHistorySearchCacheContextKey(urlFilterMode, currentUrl);
    const normalized = plan?.normalized || '';
    return `${contextKey}::${normalized}`;
  }

  function compareNumericRange(value, operator, rangeStart, rangeEnd) {
    return compareNumericRangeShared(value, operator, rangeStart, rangeEnd);
  }

  function compareMessageDateRange(startTime, endTime, operator, rangeStart, rangeEnd) {
    return compareMessageDateRangeShared(startTime, endTime, operator, rangeStart, rangeEnd);
  }

  function evaluateChatHistoryFilters(meta, filters) {
    return evaluateChatHistoryFiltersShared(meta, filters);
  }

  function buildChatHistoryTextPlan(searchPlan) {
    return buildChatHistoryTextPlanShared(searchPlan);
  }

  function buildMetaSearchText(meta) {
    return buildMetaSearchTextShared(meta);
  }

  function evaluateMetaTextMatch(metaText, textPlan) {
    return evaluateMetaTextMatchShared(metaText, textPlan);
  }

  /**
   * 纯函数：把“会话列表”按 parentConversationId 展开为可渲染的树状顺序。
   *
   * 设计目标：
   * - UI 侧只关心“渲染顺序 + 缩进层级”；不在这里写 DOM；
   * - 同级排序尽量稳定：置顶优先，其次按“子树最新 endTime”倒序（这样某个分支有新消息时，整棵树会被整体抬到更靠前的位置）；
   * - URL 匹配模式下优先按 urlMatchLevel（等级相同再按“子树最新 endTime”排序）；
   * - 允许父会话缺失（被删除/未加载）：子会话会作为顶层节点展示，并标记为 orphan。
   *
   * @param {Array<Object>} conversations
   * @param {string[]} pinnedIds
   * @returns {{items: Array<Object>, pinnedCountInDisplay: number}} 新数组：每项会附加 __branchDepth/__branchParentSummary/__branchIsOrphan/__treeSortEndTime 等 UI 字段
   */
  function buildConversationBranchTreeDisplayList(conversations, pinnedIds) {
    const list = Array.isArray(conversations) ? conversations.filter(Boolean) : [];
    const pinnedList = Array.isArray(pinnedIds) ? pinnedIds.filter(Boolean) : [];
    const pinnedIndexMap = new Map(pinnedList.map((id, idx) => [id, idx]));

    const idToConv = new Map();
    for (const conv of list) {
      const id = typeof conv?.id === 'string' ? conv.id : '';
      if (!id) continue;
      if (!idToConv.has(id)) {
        idToConv.set(id, conv);
      }
    }

    // parentId -> childConv[]
    const childrenMap = new Map();
    const rootIds = [];

    for (const [id, conv] of idToConv.entries()) {
      const rawParent = typeof conv?.parentConversationId === 'string' ? conv.parentConversationId.trim() : '';
      const parentId = rawParent && rawParent !== id ? rawParent : '';
      if (parentId && idToConv.has(parentId)) {
        if (!childrenMap.has(parentId)) childrenMap.set(parentId, []);
        childrenMap.get(parentId).push(conv);
      } else {
        rootIds.push(id);
      }
    }

    // 计算“子树最新 endTime”（整棵树排序的关键）
    // 说明：
    // - endTime 本身代表单条会话的最新消息时间；
    // - 当 parentConversationId 存在时，用户更关心“整棵树最近有没有更新”，而不是根节点本身是否更新；
    // - 因此同级排序以“子树 max(endTime)”为准：只要某个分支更新，根节点就会被整体抬到更靠前的位置。
    const subtreeLatestEndTimeCache = new Map();
    const subtreeComputeStack = new Set();
    const getOwnEndTime = (conv) => (Number(conv?.endTime) || 0);

    const getSubtreeLatestEndTime = (conversationId) => {
      const id = typeof conversationId === 'string' ? conversationId : '';
      if (!id) return 0;
      if (subtreeLatestEndTimeCache.has(id)) return subtreeLatestEndTimeCache.get(id);

      // 兜底：防止坏数据导致环（A->B->A）造成无限递归
      if (subtreeComputeStack.has(id)) {
        const fallback = getOwnEndTime(idToConv.get(id));
        subtreeLatestEndTimeCache.set(id, fallback);
        return fallback;
      }

      subtreeComputeStack.add(id);
      const conv = idToConv.get(id);
      let latest = getOwnEndTime(conv);

      const children = childrenMap.get(id) || [];
      for (const child of children) {
        const childId = typeof child?.id === 'string' ? child.id : '';
        if (!childId) continue;
        const childLatest = getSubtreeLatestEndTime(childId);
        if (childLatest > latest) latest = childLatest;
      }

      subtreeComputeStack.delete(id);
      subtreeLatestEndTimeCache.set(id, latest);
      return latest;
    };

    const safeUrlLevel = (conv) => {
      const raw = conv?.urlMatchLevel;
      return Number.isFinite(Number(raw)) ? Number(raw) : null;
    };

    const compareByDisplayPriority = (a, b) => {
      if (!a || !b) return 0;
      const aId = a.id;
      const bId = b.id;
      const aPinned = pinnedIndexMap.has(aId);
      const bPinned = pinnedIndexMap.has(bId);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      if (aPinned && bPinned) {
        return (pinnedIndexMap.get(aId) ?? 0) - (pinnedIndexMap.get(bId) ?? 0);
      }

      // URL 筛选模式：更严格的匹配等级优先
      const aLevel = safeUrlLevel(a);
      const bLevel = safeUrlLevel(b);
      if (aLevel !== null || bLevel !== null) {
        const av = aLevel === null ? Number.POSITIVE_INFINITY : aLevel;
        const bv = bLevel === null ? Number.POSITIVE_INFINITY : bLevel;
        if (av !== bv) return av - bv;
      }

      // 关键：按“子树最新 endTime”排序，使得树内任一分支更新都会带动整棵树的顺序更新。
      const aTreeEnd = getSubtreeLatestEndTime(aId);
      const bTreeEnd = getSubtreeLatestEndTime(bId);
      if (aTreeEnd !== bTreeEnd) return bTreeEnd - aTreeEnd;

      // 次级兜底：若两者子树最新时间相同，则回退到自身 endTime/startTime 做稳定排序。
      const aEnd = getOwnEndTime(a);
      const bEnd = getOwnEndTime(b);
      if (aEnd !== bEnd) return bEnd - aEnd;

      const aStart = Number(a?.startTime) || 0;
      const bStart = Number(b?.startTime) || 0;
      if (aStart !== bStart) return bStart - aStart;

      const aSummary = String(a?.summary || '');
      const bSummary = String(b?.summary || '');
      return aSummary.localeCompare(bSummary);
    };

    // 树状视图下仍要显示“已置顶”分段，但 pinnedIds 是“会话级”而不是“树级”。
    // 为了避免同一棵树被拆开/重复渲染，这里把“置顶”提升到树级：只要树内任意会话被置顶，就把整棵树放到置顶分段。
    const rootResolveCache = new Map();
    const resolveRootId = (conversationId) => {
      const inputId = typeof conversationId === 'string' ? conversationId : '';
      if (!inputId || !idToConv.has(inputId)) return '';
      if (rootResolveCache.has(inputId)) return rootResolveCache.get(inputId);

      const localVisited = new Set();
      let currentId = inputId;
      while (true) {
        if (localVisited.has(currentId)) {
          // 兜底：出现环时，将其视为“自成一棵树”，避免无限追溯
          currentId = inputId;
          break;
        }
        localVisited.add(currentId);

        const conv = idToConv.get(currentId);
        const rawParent = typeof conv?.parentConversationId === 'string' ? conv.parentConversationId.trim() : '';
        const parentId = rawParent && rawParent !== currentId ? rawParent : '';
        if (!parentId || !idToConv.has(parentId)) break;
        currentId = parentId;
      }

      rootResolveCache.set(inputId, currentId);
      return currentId;
    };

    const pinnedRootIdSet = new Set();
    const rootToMinPinnedIndex = new Map();
    for (let idx = 0; idx < pinnedList.length; idx++) {
      const pinnedId = pinnedList[idx];
      if (!idToConv.has(pinnedId)) continue;
      const rootId = resolveRootId(pinnedId);
      if (!rootId) continue;
      pinnedRootIdSet.add(rootId);
      const currentMin = rootToMinPinnedIndex.get(rootId);
      if (currentMin === undefined || idx < currentMin) {
        rootToMinPinnedIndex.set(rootId, idx);
      }
    }

    // 对 children 做一次排序，保证渲染稳定
    for (const [parentId, children] of childrenMap.entries()) {
      children.sort(compareByDisplayPriority);
      childrenMap.set(parentId, children);
    }

    const ordered = [];
    const visited = new Set();

    const walk = (conv, depth, resolvedParentId, treeSortEndTime) => {
      if (!conv || !conv.id) return;
      if (visited.has(conv.id)) return;
      visited.add(conv.id);

      const rawParent = typeof conv?.parentConversationId === 'string' ? conv.parentConversationId.trim() : '';
      const parentId = rawParent && rawParent !== conv.id ? rawParent : '';
      const parentExists = !!(parentId && idToConv.has(parentId));
      const parentSummary = parentExists ? String(idToConv.get(parentId)?.summary || '') : '';

      ordered.push({
        ...conv,
        __branchDepth: Math.max(0, Number(depth) || 0),
        __branchResolvedParentId: resolvedParentId || null,
        __branchParentSummary: parentSummary,
        __branchIsOrphan: !!(parentId && !parentExists),
        // 树状 + 时间分组需要“整棵树的排序时间”：
        // - 分组标题只在根节点处插入，但子节点需要携带同一个 key，避免跨批次渲染时重复插入标题；
        // - treeSortEndTime 取“子树最新 endTime（max）”，这样树内任意分支更新都会带动整棵树的顺序与分组。
        __treeSortEndTime: Number(treeSortEndTime) || 0
      });

      const children = childrenMap.get(conv.id) || [];
      for (const child of children) {
        walk(child, (Number(depth) || 0) + 1, conv.id, treeSortEndTime);
      }
    };

    const pinnedRootIds = Array.from(pinnedRootIdSet).sort((aId, bId) => {
      const ai = rootToMinPinnedIndex.get(aId) ?? Number.POSITIVE_INFINITY;
      const bi = rootToMinPinnedIndex.get(bId) ?? Number.POSITIVE_INFINITY;
      if (ai !== bi) return ai - bi;
      return compareByDisplayPriority(idToConv.get(aId), idToConv.get(bId));
    });

    const unpinnedRootIds = rootIds
      .filter((id) => !pinnedRootIdSet.has(id))
      .sort((aId, bId) => compareByDisplayPriority(idToConv.get(aId), idToConv.get(bId)));

    for (const rootId of pinnedRootIds) {
      const treeEndTime = getSubtreeLatestEndTime(rootId);
      walk(idToConv.get(rootId), 0, null, treeEndTime);
    }
    const pinnedCountInDisplay = ordered.length;

    for (const rootId of unpinnedRootIds) {
      const treeEndTime = getSubtreeLatestEndTime(rootId);
      walk(idToConv.get(rootId), 0, null, treeEndTime);
    }

    // 兜底：处理环/异常数据导致未被遍历到的节点
    for (const conv of idToConv.values()) {
      if (!visited.has(conv.id)) {
        const treeEndTime = getSubtreeLatestEndTime(conv.id);
        walk(conv, 0, null, treeEndTime);
      }
    }

    return { items: ordered, pinnedCountInDisplay };
  }

  /**
   * 加载聊天历史记录列表
   * @param {HTMLElement} panel - 聊天历史面板元素
   * @param {string} filterText - 过滤文本
   * @param {{keepExistingList?: boolean, restoreScrollTop?: number|null}|null} [options=null] - 可选：是否在刷新时保留旧列表，等待新数据准备好后再替换
   */
  async function loadConversationHistories(panel, filterText, options = null) {
    // 生成本次加载的 runId 并标记到面板，用于取消过期任务
    ensurePanelStylesInjected();
    const effectiveOptions = (options && typeof options === 'object') ? options : {};
    const restoreScrollTop = Number.isFinite(effectiveOptions.restoreScrollTop)
      ? Math.max(0, Number(effectiveOptions.restoreScrollTop))
      : null;
    let restoreScrollPending = Number.isFinite(restoreScrollTop) && restoreScrollTop > 0;
    const runId = createRunId();
    panel.dataset.currentFilter = filterText;
    panel.dataset.runId = runId;
    const searchPlan = buildChatHistorySearchPlan(filterText);
    const textPlan = buildChatHistoryTextPlan(searchPlan);
    const highlightPlan = buildKeywordHighlightPlan(textPlan.highlightRaw, textPlan.highlightLower);
    const emptyHighlightPlan = {
      terms: [],
      termsLower: [],
      hasTerms: false,
      keywordColorByLower: Object.create(null),
      keywordEntries: []
    };
    const normalizedFilter = searchPlan.normalized;
    panel.dataset.normalizedFilter = normalizedFilter;

    const listContainer = panel.querySelector('#chat-history-list');
    if (!listContainer) return;

    const setSearchProgressVisible = (indicator, visible) => {
      if (!indicator) return;
      indicator.classList.toggle('is-visible', visible);
      indicator.dataset.visible = visible ? '1' : '0';
    };

    const resetListContent = (options = {}) => {
      const keepIndicator = options.keepIndicator !== false;
      const indicator = keepIndicator ? listContainer.querySelector('.search-loading-indicator') : null;
      Array.from(listContainer.children).forEach((child) => {
        if (indicator && child === indicator) return;
        child.remove();
      });
    };

    const ensureBaseIndicator = () => {
      let indicator = null;
      try {
        indicator = panel.querySelector('.search-loading-indicator');
      } catch (_) {
        indicator = null;
      }
      if (indicator) {
        if (indicator.parentNode !== listContainer) {
          indicator.remove();
          listContainer.insertBefore(indicator, listContainer.firstChild);
        }
        return indicator;
      }
      indicator = document.createElement('div');
      indicator.className = 'search-loading-indicator';
      indicator.dataset.visible = '0';
      listContainer.insertBefore(indicator, listContainer.firstChild);
      return indicator;
    };

    ensureBaseIndicator();

    const applyScrollRestore = () => {
      if (!restoreScrollPending || restoreScrollTop == null) return;
      const maxScroll = Math.max(0, listContainer.scrollHeight - listContainer.clientHeight);
      const targetTop = Math.min(restoreScrollTop, maxScroll);
      listContainer.scrollTop = targetTop;
      if (maxScroll >= restoreScrollTop) {
        restoreScrollPending = false;
      }
    };

    const hasExistingItems = !!listContainer.querySelector('.chat-history-item');
    // 说明：允许在“重新打开面板”或“筛选变化”时先复用旧列表，减少空白等待；等新数据就绪后再整体替换。
    let deferListReset = false;
    if (hasExistingItems) {
      deferListReset = true;
    } else {
      // 无可复用内容时，显示骨架屏给到视觉反馈
      resetListContent();
      listContainer.scrollTop = 0;
      renderSkeleton(listContainer, 8);
    }

    // 清理上一轮搜索残留的进度条（避免在新一轮加载时出现“旧进度”闪烁）
    try {
      const baseIndicator = ensureBaseIndicator();
      setSearchProgressVisible(baseIndicator, false);
      panel.querySelectorAll('.search-loading-indicator').forEach((n) => {
        if (n !== baseIndicator) n.remove();
      });
    } catch (_) {}

    const upsertSearchProgressIndicator = () => ensureBaseIndicator();

    const getSearchProgressState = () => {
      if (!panel._searchProgressState) {
        panel._searchProgressState = { percent: 0, updatedAt: 0 };
      }
      return panel._searchProgressState;
    };

    const ensureSearchProgressParts = (indicator) => {
      if (!indicator) return null;
      if (indicator._progressParts) return indicator._progressParts;
      indicator.innerHTML = '';
      const progress = document.createElement('div');
      progress.className = 'search-progress';
      const barEl = document.createElement('div');
      barEl.className = 'search-progress-bar';
      const fillEl = document.createElement('div');
      fillEl.className = 'search-progress-fill';
      barEl.appendChild(fillEl);
      progress.appendChild(barEl);
      indicator.appendChild(progress);
      indicator._progressParts = { fillEl };
      return indicator._progressParts;
    };

    const setSearchProgressStage = (indicator, text) => {
      if (!indicator) return;
      const parts = ensureSearchProgressParts(indicator);
      if (!parts) return;
      const state = getSearchProgressState();
      const now = Date.now();
      const reuse = state.updatedAt && (now - state.updatedAt < 900);
      const basePercent = reuse ? Math.max(8, Math.min(state.percent || 0, 18)) : 0;
      parts.fillEl.style.width = `${basePercent}%`;
      state.percent = basePercent;
      state.updatedAt = now;
      setSearchProgressVisible(indicator, true);
    };

    const hasFilterRules = Array.isArray(searchPlan.filters) && searchPlan.filters.length > 0;
    const hasTextQuery = textPlan.hasPositive || textPlan.hasNegative;
    const hasActiveQuery = hasFilterRules || hasTextQuery;
    const resolvedScope = resolveSearchScope(textPlan);
    const shouldUseMetaMatch = resolvedScope === 'session';

    const urlFilterMode = panel.dataset.urlFilterMode === 'currentUrl';
    const currentUrl = urlFilterMode ? (state.pageInfo?.url || '').trim() : '';
    const searchCacheContextKey = buildChatHistorySearchCacheContextKey(urlFilterMode, currentUrl);
    const searchCacheKey = buildChatHistorySearchCacheKey(searchPlan, urlFilterMode, currentUrl);
    panel.dataset.searchCacheKey = searchCacheKey;
    const cachedEntry = hasTextQuery ? getSearchCacheEntry(searchCacheKey) : null;
    if (cachedEntry) searchCache = cachedEntry;
    const canReuseSearchCache = hasTextQuery
      && cachedEntry
      && Array.isArray(cachedEntry.results);

    // 树状视图：只在“无筛选”场景下改变排序（否则会干扰全文搜索/筛选的直觉）
    const isBranchTreeView = panel.dataset.branchViewMode === 'tree';
    const shouldTreeOrder = isBranchTreeView && !hasActiveQuery;
    // 树状视图首次打开时可能需要全量元数据；若缓存未就绪，则先走“最近记录分页”快速渲染，
    // 同时后台预热元数据，待就绪后再刷新为树状排序，降低打开时的等待感。
    // 说明：metaCache 有 TTL，过期时也视为“未就绪”，避免打开面板再次卡顿。
    const isMetaCacheReady = !!metaCache.data && (Date.now() - metaCache.time <= META_CACHE_TTL);
    const shouldWarmupTree = shouldTreeOrder && !urlFilterMode && !isMetaCacheReady;
    const shouldTreeOrderForThisRun = shouldTreeOrder && !shouldWarmupTree;
    let treeWarmupPromise = null;

    if (shouldWarmupTree) {
      treeWarmupPromise = getAllConversationMetadataWithCache(false).catch(() => null);
      const warmupIndicator = upsertSearchProgressIndicator();
      setSearchProgressStage(warmupIndicator, '正在构建树状列表…（先显示最近记录）');
    }

    const pinnedIds = await getPinnedIds();
    // 任务可能已被新一轮加载替换
    if (panel.dataset.runId !== runId) return;

    // 记录本轮“列表数据源模式”，供 renderMoreItems 继续分页追加
    // - paged：默认视图（置顶 + 最近 N 条），后续按需加载更多
    // - full：全文搜索/消息数筛选等，需要全量元数据
    // - url：按当前页面 URL 前缀快速筛选
    panel._historyDataSource = { mode: 'full' };

    let baseHistories = null;

    if (urlFilterMode) {
      const currentUrl = (state.pageInfo?.url || '').trim();
      if (!currentUrl) {
        // 无 URL 时退回普通模式（按钮理论上会 disabled，这里再做一次防御）
        panel.dataset.urlFilterMode = '';
      } else {
        panel._historyDataSource = { mode: 'url', currentUrl };
        const candidateUrls = generateCandidateUrls(currentUrl);
        baseHistories = await listConversationMetadataByUrlCandidates(candidateUrls);
        if (panel.dataset.runId !== runId) return;
      }
    }

    // 默认视图（无输入筛选）走“快速分页”：
    // - 首次：置顶 + 最近 50（非置顶）
    // - 后续：滚动到底部再继续加载更多（renderMoreItems 内部触发）
    if (!baseHistories && !hasActiveQuery && !shouldTreeOrderForThisRun) {
      panel._historyDataSource = { mode: 'paged', cursor: null, hasMore: false, pageSize: PAGED_UNPINNED_LOAD_SIZE };
      removeSearchSummary(panel);

      const pinnedMetas = await getConversationMetadataByIds(pinnedIds);
      if (panel.dataset.runId !== runId) return;

      const firstPage = await getConversationMetadataPageByEndTimeDesc({
        limit: INITIAL_UNPINNED_LOAD_LIMIT,
        cursor: null,
        excludeIds: pinnedIds
      });
      if (panel.dataset.runId !== runId) return;

      panel._historyDataSource.cursor = firstPage.cursor;
      panel._historyDataSource.hasMore = firstPage.hasMore;

      baseHistories = [...pinnedMetas, ...(firstPage.items || [])];
    }

    // 需要“全量元数据”的场景：消息数筛选 / 全文搜索
    if (!baseHistories) {
      panel._historyDataSource = { mode: 'full' };

      // 说明：全文搜索需要先拿到“全量会话元数据列表”作为候选池，这一步在会话很多时可能需要 0.5~2s。
      // 旧实现会等“元数据加载完成后”才插入进度条，导致用户感觉“停顿了一秒啥也没干”。
      // 这里提前显示“准备阶段”，让用户能立刻看到反馈。
      const isFullTextSearch = hasTextQuery;

      if (canReuseSearchCache) {
        baseHistories = searchCache.results.slice();
      } else {
        let warmupIndicator = null;
        if (isFullTextSearch) {
          warmupIndicator = upsertSearchProgressIndicator();
          setSearchProgressStage(warmupIndicator, '正在准备搜索…（加载会话列表）');
        }

        baseHistories = await getAllConversationMetadataWithCache();
        if (panel.dataset.runId !== runId) {
          setSearchProgressVisible(warmupIndicator, false);
          return;
        }
      }
    }

    const applyMetaFilters = (list) => {
      const items = Array.isArray(list) ? list : [];
      if (!hasFilterRules) return items;
      return items.filter((meta) => evaluateChatHistoryFilters(meta, searchPlan.filters));
    };

    let sourceHistories = [];
    let effectiveHighlightPlan = highlightPlan;

    if (panel._historyDataSource.mode === 'paged') {
      // 默认分页列表不做额外筛选（filterText 本身为空）
      sourceHistories = baseHistories;
      effectiveHighlightPlan = emptyHighlightPlan;
      removeSearchSummary(panel);
    } else {
      const allHistoriesMeta = baseHistories;

      if (!hasActiveQuery) {
        sourceHistories = allHistoriesMeta;
        effectiveHighlightPlan = emptyHighlightPlan;
        removeSearchSummary(panel);
      } else if (!hasTextQuery) {
        sourceHistories = applyMetaFilters(allHistoriesMeta);
        effectiveHighlightPlan = emptyHighlightPlan;
        removeSearchSummary(panel);
      } else if (canReuseSearchCache) {
        sourceHistories = searchCache.results.slice();
        const meta = searchCache.meta || {};
        renderSearchSummary(panel, {
          query: filterText,
          normalized: searchCache.normalized,
          durationMs: meta.durationMs,
          resultCount: meta.resultCount ?? sourceHistories.length,
          excerptCount: meta.excerptCount,
          scannedCount: meta.scannedCount,
          reused: true,
          highlightPlan
        });
      } else {
        removeSearchSummary(panel);
        const searchStartTime = performance.now();
        const matchedEntries = [];
        const matchInfoMap = new Map();
        // 连续输入优化：若本次查询是“上次查询的前缀扩展”，则只需要在上次结果集合里继续筛即可。
        // 典型场景：用户从 "http" 继续输入到 "https://..."，无需每次都从全量会话重扫。
        const previousNormalized = (typeof searchCache?.normalized === 'string') ? searchCache.normalized : '';
        const canReusePrefixCache = (
          !!previousNormalized &&
          previousNormalized !== normalizedFilter &&
          normalizedFilter.startsWith(previousNormalized) &&
          Array.isArray(searchCache?.results) &&
          searchCache.contextKey === searchCacheContextKey
        );

        const candidateMetas = applyMetaFilters(canReusePrefixCache ? searchCache.results.slice() : allHistoriesMeta);
        const totalItems = candidateMetas.length;
        let nextIndex = 0;
        let processedCount = 0;
        let lastProgressUpdate = 0;
        let lastProgressUpdateTime = 0;
        let cancelled = false;

        // 在列表容器顶部插入搜索进度指示器
        const searchProgressIndicator = upsertSearchProgressIndicator();

        const PROGRESS_UPDATE_INTERVAL = 10;
        const PROGRESS_UPDATE_MIN_INTERVAL = 120;
        // 批量读取会话后，每个 worker 的“单次工作量”更大；并发过高反而可能造成 IndexedDB 竞争与 UI 抖动。
        const CONCURRENCY = Math.min(4, Math.max(2, navigator?.hardwareConcurrency ? Math.floor(navigator.hardwareConcurrency / 2) : 4));
        const SEARCH_SCAN_BATCH_SIZE = 12;
        let lastYieldTime = performance.now();
        const isCancelled = createSearchCancelledChecker(panel, runId);

        const updateProgress = (force = false) => {
          const now = performance.now();
          if (!force) {
            if (processedCount - lastProgressUpdate < PROGRESS_UPDATE_INTERVAL) return;
            if (now - lastProgressUpdateTime < PROGRESS_UPDATE_MIN_INTERVAL) return;
          }
          lastProgressUpdate = processedCount;
          lastProgressUpdateTime = now;
          const percentComplete = totalItems === 0 ? 100 : Math.round((processedCount / totalItems) * 100);
          const parts = ensureSearchProgressParts(searchProgressIndicator);
          if (!parts) return;
          const state = getSearchProgressState();
          const nextPercent = Math.max(state.percent || 0, percentComplete);
          parts.fillEl.style.width = `${nextPercent}%`;
          state.percent = nextPercent;
          state.updatedAt = Date.now();
          setSearchProgressVisible(searchProgressIndicator, true);
        };

        updateProgress(true);

        const workers = Array.from({ length: CONCURRENCY }).map(async () => {
          while (true) {
            const batchStart = nextIndex;
            nextIndex += SEARCH_SCAN_BATCH_SIZE;
            if (batchStart >= totalItems || cancelled) break;

            if (isCancelled()) {
              cancelled = true;
              break;
            }

            const batchEnd = Math.min(totalItems, batchStart + SEARCH_SCAN_BATCH_SIZE);
            const batchMetas = candidateMetas.slice(batchStart, batchEnd);
            const batchToScan = [];

            // 1) 先在“元数据字段”上做快速命中（无需读 messages）
            for (let offset = 0; offset < batchMetas.length; offset++) {
              const historyMeta = batchMetas[offset];
              if (!historyMeta?.id) {
                processedCount++;
                updateProgress();
                continue;
              }
              if (isCancelled()) {
                cancelled = true;
                break;
              }

              if (!shouldUseMetaMatch) {
                batchToScan.push({ index: batchStart + offset, meta: historyMeta, remainingTerms: null });
                continue;
              }

              const metaText = buildMetaSearchText(historyMeta);
              const metaResult = evaluateMetaTextMatch(metaText, textPlan);
              if (metaResult.blocked) {
                processedCount++;
                updateProgress();
                continue;
              }

              const remainingTerms = Array.from(metaResult.remaining || []);
              const needsMessageScan = textPlan.hasNegative || remainingTerms.length > 0;

              if (!needsMessageScan) {
                matchedEntries.push({ index: batchStart + offset, data: historyMeta });
                matchInfoMap.set(historyMeta.id, {
                  messageId: null,
                  excerpts: [],
                  reason: 'meta',
                  totalHitCount: 0,
                  matchedMessageCount: 0
                });
                processedCount++;
                updateProgress();
              } else {
                batchToScan.push({ index: batchStart + offset, meta: historyMeta, remainingTerms });
              }
            }

            if (cancelled) break;

            // 2) 未命中元数据的条目：批量读取会话并扫描 messages（减少 transaction 次数）
            if (batchToScan.length > 0) {
              const idsToLoad = batchToScan.map((item) => item.meta.id).filter(Boolean);
              let conversations = [];
              try {
                conversations = await getConversationsByIds(idsToLoad, false);
              } catch (error) {
                console.error('批量加载会话失败（全文搜索）:', error);
                conversations = [];
              }

              if (isCancelled()) {
                cancelled = true;
                break;
              }

              const conversationById = new Map();
              for (const conv of conversations) {
                if (conv?.id) conversationById.set(conv.id, conv);
              }

              for (const item of batchToScan) {
                if (isCancelled()) {
                  cancelled = true;
                  break;
                }

                const conv = conversationById.get(item.meta.id);
                if (!conv || !Array.isArray(conv.messages)) {
                  processedCount++;
                  updateProgress();
                  continue;
                }

                const inlineScan = scanConversationInlineMessagesForMatch(
                  conv,
                  textPlan,
                  item.remainingTerms,
                  isCancelled
                );
                if (inlineScan.cancelled) {
                  cancelled = true;
                  break;
                }
                if (inlineScan.blocked) {
                  processedCount++;
                  updateProgress();
                  continue;
                }

                if (inlineScan.matched) {
                  matchInfoMap.set(item.meta.id, inlineScan.matchInfo);
                  matchedEntries.push({ index: item.index, data: item.meta });
                }

                processedCount++;
                updateProgress();

                // 让出主线程给 UI（进度条/滚动/输入），避免长时间占用导致卡顿。
                const now = performance.now();
                if (now - lastYieldTime >= 16) {
                  lastYieldTime = now;
                  await new Promise(resolve => setTimeout(resolve, 0));
                }
              }

              if (cancelled) break;
            }

            // 让出主线程给 UI（进度条/滚动/输入），避免长时间占用导致卡顿。
            // 注意：不必每条都 setTimeout(0)，否则会明显拖慢搜索；这里按时间片让出即可。
            const now = performance.now();
            if (now - lastYieldTime >= 16) {
              lastYieldTime = now;
              await new Promise(resolve => setTimeout(resolve, 0));
            }
          }
        });

        await Promise.all(workers);

        if (panel.dataset.runId !== runId || cancelled) {
          setSearchProgressVisible(searchProgressIndicator, false);
          return;
        }

        updateProgress(true);
        setSearchProgressVisible(searchProgressIndicator, false);

        matchedEntries.sort((a, b) => a.index - b.index);
        const finalResults = matchedEntries.map(entry => entry.data);
        const durationMs = performance.now() - searchStartTime;
        const excerptCount = Array.from(matchInfoMap.values()).reduce((acc, info) => acc + (Array.isArray(info?.excerpts) ? info.excerpts.length : 0), 0);
        const scannedCount = Math.min(processedCount, totalItems);
        const nextSearchCache = {
          query: filterText,
          normalized: normalizedFilter,
          key: searchCacheKey,
          contextKey: searchCacheContextKey,
          results: finalResults.slice(),
          matchMap: matchInfoMap,
          timestamp: Date.now(),
          meta: {
            durationMs,
            resultCount: finalResults.length,
            excerptCount,
            scannedCount
          }
        };
        setSearchCacheEntry(nextSearchCache);
        searchCache = nextSearchCache;
        sourceHistories = nextSearchCache.results.slice();
        renderSearchSummary(panel, {
          query: filterText,
          normalized: normalizedFilter,
          durationMs,
          resultCount: finalResults.length,
          excerptCount,
          scannedCount,
          reused: canReusePrefixCache,
          highlightPlan
        });
      }
    }

    let pinnedItems = [];
    let unpinnedItems = [];
    let isTreeOrderingActive = false;
    let displayPinnedIds = pinnedIds;
    if (panel?._historyDataSource?.mode === 'url') {
      // URL 本页筛选模式下不展示置顶会话，避免“全局置顶”干扰本页视图。
      displayPinnedIds = [];
      if (Array.isArray(sourceHistories) && pinnedIds.length) {
        const pinnedSet = new Set(pinnedIds);
        sourceHistories = sourceHistories.filter((item) => !pinnedSet.has(item?.id));
      }
    }

    if (shouldTreeOrderForThisRun) {
      // 树状排序：
      // - 保持父子关系连续展示；
      // - “置顶”提升为树级（树内任一会话被置顶，则整棵树进入置顶分段），避免同一棵树被拆开/重复渲染；
      // - 时间分组同样按树级（基于子树最新 endTime），保证分组标题不会把父子节点拆开。
      isTreeOrderingActive = true;
      const treeDisplay = buildConversationBranchTreeDisplayList(sourceHistories, displayPinnedIds);
      currentDisplayItems = treeDisplay.items;
      // 注意：树状模式下“置顶”以“整棵树”为单位，因此 pinnedCountInDisplay 可能包含未置顶的根/祖先节点。
      currentPinnedItemsCountInDisplay = Math.max(0, Number(treeDisplay.pinnedCountInDisplay) || 0);
    } else {
      const pinnedIndexMap = new Map(displayPinnedIds.map((id, index) => [id, index]));
      sourceHistories.forEach(hist => {
        if (displayPinnedIds.includes(hist.id)) {
          pinnedItems.push(hist);
        } else {
          unpinnedItems.push(hist);
        }
      });

      pinnedItems.sort((a, b) => (pinnedIndexMap.get(a.id) ?? Infinity) - (pinnedIndexMap.get(b.id) ?? Infinity));
      if (panel?._historyDataSource?.mode === 'url') {
        // URL 快速筛选模式：更严格的匹配等级优先，等级相同再按最近对话排序
        unpinnedItems.sort((a, b) => {
          const aLevel = Number.isFinite(Number(a?.urlMatchLevel)) ? Number(a.urlMatchLevel) : Number.POSITIVE_INFINITY;
          const bLevel = Number.isFinite(Number(b?.urlMatchLevel)) ? Number(b.urlMatchLevel) : Number.POSITIVE_INFINITY;
          if (aLevel !== bLevel) return aLevel - bLevel;
          return (Number(b?.endTime) || 0) - (Number(a?.endTime) || 0);
        });
      } else {
        unpinnedItems.sort((a, b) => (Number(b?.endTime) || 0) - (Number(a?.endTime) || 0));
      }

      currentDisplayItems = [...pinnedItems, ...unpinnedItems];
      currentPinnedItemsCountInDisplay = pinnedItems.length;
    }

    if (panel?._historyDataSource?.mode === 'paged') {
      // 用于后续分页追加时去重（极端情况下避免重复插入同一会话）
      panel._historyDataSource.loadedIdSet = new Set(currentDisplayItems.map((item) => item?.id).filter(Boolean));
    }

    setSearchProgressVisible(listContainer.querySelector('.search-loading-indicator'), false);

    const hasSkeleton = !!listContainer.querySelector('.skeleton-item');
    if (currentDisplayItems.length === 0) {
      resetListContent();
      listContainer.scrollTop = 0;
      deferListReset = false;
      const emptyMsg = document.createElement('div');
      if (hasActiveQuery) {
        emptyMsg.textContent = '没有匹配的聊天记录';
      } else {
        emptyMsg.textContent = '暂无聊天记录';
      }
      listContainer.appendChild(emptyMsg);
      return;
    }

    if (deferListReset || hasSkeleton) {
      // 说明：保留旧列表直到新结果准备就绪，再一次性替换，减少打开时的空白感。
      resetListContent();
      listContainer.scrollTop = 0;
      deferListReset = false;
    }

    currentlyRenderedCount = 0;
    currentGroupLabelForBatchRender = null;
    isLoadingMoreItems = false;

    if (currentPinnedItemsCountInDisplay > 0) {
      removeSkeleton(listContainer);
      const pinnedHeader = document.createElement('div');
      pinnedHeader.className = 'chat-history-group-header pinned-header';
      pinnedHeader.textContent = '已置顶';
      pinnedHeader.setAttribute('role', 'button');
      pinnedHeader.setAttribute('tabindex', '0');
      // 置顶区默认折叠，点击标题切换展开状态（状态保存在面板 dataset 中）
      const applyPinnedCollapseState = (collapsed) => {
        listContainer.classList.toggle('pinned-collapsed', collapsed);
        pinnedHeader.dataset.collapsed = collapsed ? 'true' : 'false';
        pinnedHeader.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        pinnedHeader.title = collapsed ? '点击展开置顶聊天' : '点击折叠置顶聊天';
      };
      const initialPinnedCollapsed = panel.dataset.pinnedCollapsed !== 'false';
      panel.dataset.pinnedCollapsed = initialPinnedCollapsed ? 'true' : 'false';
      applyPinnedCollapseState(initialPinnedCollapsed);
      const togglePinnedCollapse = () => {
        const nextCollapsed = !listContainer.classList.contains('pinned-collapsed');
        panel.dataset.pinnedCollapsed = nextCollapsed ? 'true' : 'false';
        applyPinnedCollapseState(nextCollapsed);
      };
      pinnedHeader.addEventListener('click', togglePinnedCollapse);
      pinnedHeader.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        togglePinnedCollapse();
      });
      listContainer.appendChild(pinnedHeader);
    } else {
      listContainer.classList.remove('pinned-collapsed');
      delete panel.dataset.pinnedCollapsed;
    }

    // 首次加载批次
    await renderMoreItems(listContainer, displayPinnedIds, effectiveHighlightPlan, panel.dataset.currentFilter, runId);
    applyScrollRestore();

    // 使用 IntersectionObserver 进行后续批次加载
    setupEndSentinelObserver(panel, listContainer, async () => {
      if (panel.dataset.runId !== runId) return;
      await renderMoreItems(listContainer, displayPinnedIds, effectiveHighlightPlan, panel.dataset.currentFilter, runId);
    }, runId);

    // Fallback：滚动监听，兼容拖动滚动条与键盘 End 场景
    if (listContainer._scrollListener) {
      listContainer.removeEventListener('scroll', listContainer._scrollListener);
    }
    listContainer._scrollListener = async () => {
      // 滚动列表时隐藏 hover 预览 tooltip（避免位置错乱/误遮挡）
      hideChatHistoryPreviewTooltip();
      const panelNow = listContainer.closest('#chat-history-panel');
      if (!panelNow) return;
      if (panelNow.dataset.runId !== runId) return;
      if (!isLoadingMoreItems && (listContainer.scrollTop + listContainer.clientHeight >= listContainer.scrollHeight - 48)) {
        await renderMoreItems(listContainer, displayPinnedIds, effectiveHighlightPlan, panel.dataset.currentFilter, runId);
      }
    };
    listContainer.addEventListener('scroll', listContainer._scrollListener);

    // 如果内容高度不足以填满视口，自动继续加载直至填满
    requestAnimationFrame(async () => {
      const panelNow = listContainer.closest('#chat-history-panel');
      if (!panelNow || panelNow.dataset.runId !== runId) return;
      const targetBottom = restoreScrollPending && restoreScrollTop != null
        ? restoreScrollTop + listContainer.clientHeight
        : 0;
      while (true) {
        const needsFillViewport = listContainer.scrollHeight <= listContainer.clientHeight
          && (currentlyRenderedCount < currentDisplayItems.length);
        const needsReachRestoreTarget = restoreScrollPending
          && listContainer.scrollHeight < targetBottom
          && (currentlyRenderedCount < currentDisplayItems.length
            || (panelNow._historyDataSource?.mode === 'paged' && panelNow._historyDataSource?.hasMore));
        if (!needsFillViewport && !needsReachRestoreTarget) break;
        const beforeCount = currentlyRenderedCount;
        await renderMoreItems(listContainer, displayPinnedIds, effectiveHighlightPlan, panel.dataset.currentFilter, runId);
        await new Promise(r => setTimeout(r, 0));
        if (beforeCount === currentlyRenderedCount) {
          const dataSource = panelNow._historyDataSource;
          const canLoadMorePaged = dataSource?.mode === 'paged' && dataSource?.hasMore;
          const canRenderMoreItems = currentlyRenderedCount < currentDisplayItems.length || canLoadMorePaged;
          if (!canRenderMoreItems) {
            restoreScrollPending = false;
            break;
          }
          // 说明：可能有并发渲染正在进行，稍作等待后继续检查。
          await new Promise(r => setTimeout(r, 30));
          applyScrollRestore();
          continue;
        }
        applyScrollRestore();
      }
      applyScrollRestore();
    });

    if (shouldWarmupTree && treeWarmupPromise) {
      treeWarmupPromise.then(() => {
        if (panel.dataset.runId !== runId) return;
        if (!panel.classList.contains('visible')) return;
        if (panel.dataset.branchViewMode !== 'tree') return;
        if ((panel.dataset.currentFilter || '').trim()) return;
        if (panel.dataset.urlFilterMode === 'currentUrl') return;
        if (!metaCache.data) return;
        // 说明：树状元数据准备就绪后，保持旧列表可见，快速刷新为树状排序。
        loadConversationHistories(panel, panel.dataset.currentFilter || '', { keepExistingList: true });
      });
    }
  }
  
  /**
   * 逐步渲染会话列表项到指定容器。此函数被 renderMoreItems 调用。
   * @param {Object} conv - 会话对象（可以是元数据或完整对象）
   * @param {string} filterText - 过滤文本 (仅用于文本高亮)
   * @param {boolean} isPinned - 该项是否是置顶项
   * @returns {HTMLElement} 创建的会话项元素
   */

  // ==========================================================================
  //  聊天记录列表：标注“正在生成 / 后台已完成 / 已打开”状态并提供跨标签页跳转
  // ==========================================================================

  let streamingConversationUnsubscribe = null;

  function getStreamingConversationIdSet() {
    const ids = services.messageSender?.getStreamingConversationIds?.();
    if (!Array.isArray(ids) || ids.length === 0) return new Set();
    const normalizedIds = ids
      .map((id) => (typeof id === 'string' ? id.trim() : ''))
      .filter(Boolean);
    return new Set(normalizedIds);
  }

  function getBackgroundCompletedConversationIdSet() {
    const ids = services.messageSender?.getBackgroundCompletedConversationIds?.();
    if (!Array.isArray(ids) || ids.length === 0) return new Set();
    const normalizedIds = ids
      .map((id) => (typeof id === 'string' ? id.trim() : ''))
      .filter(Boolean);
    return new Set(normalizedIds);
  }

  function refreshConversationItemStatusBadgeWrap(item) {
    if (!item) return;
    const statusWrap = item.querySelector('.info-status-badges');
    if (!statusWrap) return;

    const hasVisibleBadge = Array.from(statusWrap.children).some((child) => {
      if (!(child instanceof HTMLElement)) return false;
      return !child.hidden;
    });
    statusWrap.hidden = !hasVisibleBadge;
    statusWrap.setAttribute('aria-hidden', hasVisibleBadge ? 'false' : 'true');
  }

  function updateConversationItemStreamingUi(item, conversationId, streamingIdSet = null) {
    if (!item) return;
    const normalizedId = (typeof conversationId === 'string' && conversationId.trim()) ? conversationId.trim() : '';
    if (!normalizedId) return;
    const streamingWrap = item.querySelector('.info-streaming-wrap');
    if (!streamingWrap) return;

    const effectiveIdSet = (streamingIdSet instanceof Set) ? streamingIdSet : getStreamingConversationIdSet();
    const isStreaming = effectiveIdSet.has(normalizedId);
    item.classList.toggle('is-streaming', isStreaming);
    streamingWrap.hidden = !isStreaming;
    streamingWrap.setAttribute('aria-hidden', isStreaming ? 'false' : 'true');
    refreshConversationItemStatusBadgeWrap(item);
  }

  function updateConversationItemBackgroundCompletionUi(
    item,
    conversationId,
    completedIdSet = null,
    streamingIdSet = null
  ) {
    if (!item) return;
    const normalizedId = (typeof conversationId === 'string' && conversationId.trim()) ? conversationId.trim() : '';
    if (!normalizedId) return;
    const completionWrap = item.querySelector('.info-background-complete-wrap');
    if (!completionWrap) return;

    const effectiveCompletedSet = (completedIdSet instanceof Set)
      ? completedIdSet
      : getBackgroundCompletedConversationIdSet();
    const effectiveStreamingSet = (streamingIdSet instanceof Set)
      ? streamingIdSet
      : getStreamingConversationIdSet();
    const isStreaming = effectiveStreamingSet.has(normalizedId);
    const isBackgroundCompleted = effectiveCompletedSet.has(normalizedId);
    const shouldShow = isBackgroundCompleted && !isStreaming;

    completionWrap.hidden = !shouldShow;
    completionWrap.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
    refreshConversationItemStatusBadgeWrap(item);
  }

  function refreshStreamingUiIfPanelVisible() {
    try {
      const panel = document.getElementById('chat-history-panel');
      if (!panel || !panel.classList.contains('visible')) return;
      const list = panel.querySelector('#chat-history-list');
      if (!list) return;
      const streamingIdSet = getStreamingConversationIdSet();
      const completedIdSet = getBackgroundCompletedConversationIdSet();
      list.querySelectorAll('.chat-history-item').forEach((item) => {
        const id = item.getAttribute('data-id') || '';
        if (!id) return;
        updateConversationItemStreamingUi(item, id, streamingIdSet);
        updateConversationItemBackgroundCompletionUi(item, id, completedIdSet, streamingIdSet);
      });
    } catch (_) {}
  }

  function ensureStreamingConversationUiSubscription() {
    if (streamingConversationUnsubscribe) return;
    const sender = services.messageSender;
    if (!sender?.subscribeStreamingConversationState) return;
    streamingConversationUnsubscribe = sender.subscribeStreamingConversationState(() => {
      refreshStreamingUiIfPanelVisible();
    });
  }

  function buildOpenTabsTooltipText(tabs, selfTabId) {
    const list = Array.isArray(tabs) ? tabs : [];
    if (list.length === 0) return '';

    const normalizedSelfTabId = Number.isFinite(Number(selfTabId)) ? Number(selfTabId) : null;
    const lines = [`该会话已在 ${list.length} 个标签页打开`];

    const maxLines = Math.min(6, list.length);
    for (let i = 0; i < maxLines; i++) {
      const t = list[i] || {};
      const tabId = Number.isFinite(Number(t.tabId)) ? Number(t.tabId) : null;
      const title = typeof t.title === 'string' ? t.title.trim() : '';
      const url = typeof t.url === 'string' ? t.url.trim() : '';
      const isSelf = normalizedSelfTabId !== null && tabId !== null && tabId === normalizedSelfTabId;
      const prefix = isSelf ? '当前' : '其它';
      const main = title || url || (tabId !== null ? `tab ${tabId}` : 'tab');
      lines.push(`${prefix}：${main}`);
      if (title && url && url !== title) lines.push(url);
    }
    if (list.length > maxLines) lines.push(`… 还有 ${list.length - maxLines} 个标签页`);
    return lines.join('\n');
  }

  function buildOtherOpenTabsTooltipText(otherTabs) {
    const list = Array.isArray(otherTabs) ? otherTabs : [];
    if (list.length === 0) return '';

    const lines = [`已在 ${list.length} 个其他标签页打开`];
    const maxLines = Math.min(6, list.length);
    for (let i = 0; i < maxLines; i++) {
      const t = list[i] || {};
      const tabId = Number.isFinite(Number(t.tabId)) ? Number(t.tabId) : null;
      const title = typeof t.title === 'string' ? t.title.trim() : '';
      const url = typeof t.url === 'string' ? t.url.trim() : '';
      const main = title || url || (tabId !== null ? `tab ${tabId}` : 'tab');
      lines.push(`其它：${main}`);
      if (title && url && url !== title) lines.push(url);
    }
    if (list.length > maxLines) lines.push(`… 还有 ${list.length - maxLines} 个标签页`);
    return lines.join('\n');
  }

  function getConversationOpenTabsState(conversationId) {
    if (!conversationPresence?.getConversationTabs) return { tabs: [], selfTabId: null, otherTabs: [] };
    const tabs = conversationPresence.getConversationTabs(conversationId) || [];
    const selfTabId = conversationPresence.getSelfTabId?.() ?? null;
    const normalizedSelfTabId = Number.isFinite(Number(selfTabId)) ? Number(selfTabId) : null;
    const otherTabs = (normalizedSelfTabId !== null)
      ? tabs.filter((t) => Number.isFinite(Number(t?.tabId)) && Number(t.tabId) !== normalizedSelfTabId)
      : tabs;
    return { tabs, selfTabId: normalizedSelfTabId, otherTabs };
  }

  function updateConversationItemOpenTabUi(item, conversationId) {
    if (!item || !conversationId) return;
    const openWrap = item.querySelector('.info-open-wrap');
    const openCurrentBadge = item.querySelector('.info-open-state-current');
    const openElsewhereBadge = item.querySelector('.info-open-state-elsewhere');
    if (!openWrap || !openCurrentBadge || !openElsewhereBadge) return;

    const { tabs, selfTabId, otherTabs } = getConversationOpenTabsState(conversationId);
    const isOpen = tabs.length > 0;
    const isOpenElsewhere = otherTabs.length > 0;
    const isOpenInCurrentTab = selfTabId !== null
      && tabs.some((tab) => Number.isFinite(Number(tab?.tabId)) && Number(tab.tabId) === selfTabId);

    if (!isOpen) {
      openWrap.hidden = true;
      openWrap.setAttribute('aria-hidden', 'true');
      openCurrentBadge.hidden = true;
      openCurrentBadge.setAttribute('aria-hidden', 'true');
      openCurrentBadge.title = '';
      openCurrentBadge.dataset.openStateKey = '';
      openCurrentBadge.setAttribute('aria-disabled', 'true');
      openElsewhereBadge.hidden = true;
      openElsewhereBadge.setAttribute('aria-hidden', 'true');
      openElsewhereBadge.classList.remove('is-jumpable');
      openElsewhereBadge.title = '';
      openElsewhereBadge.dataset.openStateKey = '';
      openElsewhereBadge.setAttribute('aria-disabled', 'true');
      refreshConversationItemStatusBadgeWrap(item);
      return;
    }

    const tooltip = buildOpenTabsTooltipText(tabs, selfTabId);
    const otherTabsTooltip = buildOtherOpenTabsTooltipText(otherTabs);
    const nextElsewhereTitle = isOpenElsewhere
      ? (otherTabsTooltip ? `${otherTabsTooltip}\n\n点击跳转到已打开的标签页` : '点击跳转到已打开的标签页')
      : '';
    const nextCurrentTitle = isOpenInCurrentTab
      ? (tooltip || '该会话已在当前标签页打开')
      : '';

    const updateBadgeTooltip = (badge, key, title) => {
      if (!badge) return;
      if (badge.dataset.openStateKey !== key) {
        badge.dataset.openStateKey = key;
        badge.title = title;
      } else if (badge.title !== title) {
        badge.title = title;
      }
    };

    openCurrentBadge.hidden = !isOpenInCurrentTab;
    openCurrentBadge.setAttribute('aria-hidden', isOpenInCurrentTab ? 'false' : 'true');
    if (isOpenInCurrentTab) {
      updateBadgeTooltip(
        openCurrentBadge,
        `current:${tabs.length}:${isOpenElsewhere ? 1 : 0}`,
        nextCurrentTitle
      );
    } else {
      openCurrentBadge.title = '';
      openCurrentBadge.dataset.openStateKey = '';
    }
    openCurrentBadge.setAttribute('aria-disabled', 'true');

    openElsewhereBadge.hidden = !isOpenElsewhere;
    openElsewhereBadge.setAttribute('aria-hidden', isOpenElsewhere ? 'false' : 'true');
    openElsewhereBadge.classList.toggle('is-jumpable', isOpenElsewhere);
    if (isOpenElsewhere) {
      updateBadgeTooltip(
        openElsewhereBadge,
        `elsewhere:${otherTabs.length}:${isOpenInCurrentTab ? 1 : 0}`,
        nextElsewhereTitle
      );
    } else {
      openElsewhereBadge.title = '';
      openElsewhereBadge.dataset.openStateKey = '';
    }
    openElsewhereBadge.setAttribute('aria-disabled', isOpenElsewhere ? 'false' : 'true');

    const hasAnyOpenBadge = isOpenInCurrentTab || isOpenElsewhere;
    openWrap.hidden = !hasAnyOpenBadge;
    openWrap.setAttribute('aria-hidden', hasAnyOpenBadge ? 'false' : 'true');
    refreshConversationItemStatusBadgeWrap(item);
  }

  function refreshOpenTabUiIfPanelVisible() {
    try {
      const panel = document.getElementById('chat-history-panel');
      if (!panel || !panel.classList.contains('visible')) return;
      const list = panel.querySelector('#chat-history-list');
      if (!list) return;
      list.querySelectorAll('.chat-history-item').forEach((item) => {
        const id = item.getAttribute('data-id') || '';
        if (id) updateConversationItemOpenTabUi(item, id);
      });
    } catch (_) {}
  }

  // 订阅存在性快照更新：仅在聊天记录面板可见时增量更新右侧标记
  if (conversationPresence?.subscribe) {
    conversationPresence.subscribe(() => refreshOpenTabUiIfPanelVisible());
  }

  // ==========================================================================
  //  聊天记录条目预览 tooltip（首两条 + 尾两条）
  //
  // 设计目标：
  // - 用自绘 tooltip 替换浏览器原生 title（原生 tooltip 难以排版/无法显示消息预览）；
  // - 仅在用户“按住 Ctrl”时展示预览，避免日常浏览时被预览框遮挡；
  // - 按住 Ctrl 后立即读取鼠标下方会话（无 300ms 延迟），并跟随鼠标显示在右下/右上；
  // - 避免性能问题：只在会话切换时按需读取会话，并对结果做短 TTL 缓存与并发去重。
  //
  // 注意：
  // - tooltip 使用 fixed 定位并挂到 body，避免被 #chat-history-panel/#chat-history-list 的 overflow 裁剪；
  // - tooltip 不可交互（pointer-events: none），只作为“视觉预览”。
  // ==========================================================================

  const CONVERSATION_PREVIEW_CACHE_TTL = 2 * 60 * 1000; // 2分钟：足够应对频繁 hover，同时避免长期过期数据
  const conversationPreviewCache = new Map(); // id -> { time:number, data:any|null, promise:Promise|null }

  let chatHistoryPreviewTooltipEl = null;
  let activePreviewConversationId = null;
  let activePreviewAnchorEl = null;
  let previewTooltipHideTimer = null;
  let altPreviewActive = false;
  let altPreviewHandlersBound = false;
  let altPreviewRafId = 0;
  let altPreviewLastPoint = { x: 0, y: 0 };

  function ensureChatHistoryPreviewTooltip() {
    if (chatHistoryPreviewTooltipEl) return chatHistoryPreviewTooltipEl;

    const tooltip = document.createElement('div');
    tooltip.id = 'chat-history-preview-tooltip';
    tooltip.className = 'chat-history-preview-tooltip';
    tooltip.dataset.visible = '0';
    tooltip.dataset.placement = 'right';

    const header = document.createElement('div');
    header.className = 'preview-header';

    const titleEl = document.createElement('div');
    titleEl.className = 'preview-title';
    const metaEl = document.createElement('div');
    metaEl.className = 'preview-meta';
    const subMetaEl = document.createElement('div');
    subMetaEl.className = 'preview-submeta';

    header.appendChild(titleEl);
    header.appendChild(metaEl);
    header.appendChild(subMetaEl);

    const messagesEl = document.createElement('div');
    messagesEl.className = 'preview-messages';

    tooltip.appendChild(header);
    tooltip.appendChild(messagesEl);

    // 将节点挂到 body：避免被滚动容器裁剪
    document.body.appendChild(tooltip);

    // 将内部引用挂到 DOM 上，减少重复 querySelector
    tooltip._parts = { titleEl, metaEl, subMetaEl, messagesEl };

    chatHistoryPreviewTooltipEl = tooltip;
    return tooltip;
  }

  function hideChatHistoryPreviewTooltip() {
    const tooltip = chatHistoryPreviewTooltipEl;
    if (!tooltip) return;
    tooltip.dataset.visible = '0';
    activePreviewConversationId = null;
    activePreviewAnchorEl = null;
  }

  function cancelHideChatHistoryPreviewTooltip() {
    if (!previewTooltipHideTimer) return;
    clearTimeout(previewTooltipHideTimer);
    previewTooltipHideTimer = null;
  }

  function scheduleHideChatHistoryPreviewTooltip(delayMs = 80) {
    cancelHideChatHistoryPreviewTooltip();
    previewTooltipHideTimer = setTimeout(() => {
      previewTooltipHideTimer = null;
      hideChatHistoryPreviewTooltip();
    }, Math.max(0, Number(delayMs) || 0));
  }

  function normalizeChatHistoryPreviewText(text) {
    const raw = typeof text === 'string' ? text : String(text || '');
    // 1) 先把常见的 <img> 标签替换为 [图片]，避免预览里出现长属性字符串
    let out = raw.replace(/<img\b[^>]*>/gi, '[图片]');
    // 2) 再粗略移除其它 HTML 标签（历史里可能混入由图片处理器生成的 HTML 片段）
    out = out.replace(/<[^>]+>/g, ' ');
    // 3) 合并空白并裁剪
    out = out.replace(/\s+/g, ' ').trim();

    // 空文本兜底
    if (!out) return '';

    const maxLen = 140;
    if (out.length > maxLen) {
      out = out.slice(0, maxLen - 1).trimEnd() + '…';
    }
    return out;
  }

  function normalizeChatHistoryPreviewRole(role) {
    const raw = typeof role === 'string' ? role : String(role || '');
    const lower = raw.trim().toLowerCase();
    if (lower === 'assistant' || lower === 'ai') return { roleClass: 'ai', roleLabel: 'AI' };
    if (lower === 'user') return { roleClass: 'user', roleLabel: '你' };
    if (lower === 'system') return { roleClass: 'system', roleLabel: '系统' };
    return { roleClass: 'system', roleLabel: raw.trim() || '消息' };
  }

  function buildPreviewMessageModel(msg, resolvedContent) {
    const roleInfo = normalizeChatHistoryPreviewRole(msg?.role);
    const plain = extractPlainTextFromMessageContent(resolvedContent);
    const previewText = normalizeChatHistoryPreviewText(plain) || '[空消息]';
    return {
      kind: 'message',
      roleClass: roleInfo.roleClass,
      roleLabel: roleInfo.roleLabel,
      text: previewText
    };
  }

  function computeConversationPreviewMessageList(messages) {
    const list = Array.isArray(messages) ? messages.filter(Boolean) : [];
    const total = list.length;
    if (total === 0) return { totalCount: 0, selected: [], hasGap: false };

    if (total <= 4) {
      return { totalCount: total, selected: list.slice(0), hasGap: false };
    }

    return {
      totalCount: total,
      selected: [list[0], list[1], list[total - 2], list[total - 1]].filter(Boolean),
      hasGap: true
    };
  }

  async function getConversationPreviewData(conversationId) {
    const id = typeof conversationId === 'string' ? conversationId.trim() : '';
    if (!id) return { totalCount: 0, items: [] };

    const cached = conversationPreviewCache.get(id) || null;
    const now = Date.now();
    const isFresh = cached?.data && (now - (cached.time || 0) <= CONVERSATION_PREVIEW_CACHE_TTL);
    if (isFresh) return cached.data;

    if (cached?.promise) {
      try { return await cached.promise; } catch (_) {}
    }

    const promise = (async () => {
      // 1) 优先从内存缓存读取（若该会话近期被打开过，可避免额外的 IndexedDB 开销）
      let messages = null;
      try {
        if (activeConversation?.id === id && Array.isArray(activeConversation?.messages)) {
          messages = activeConversation.messages;
        } else if (loadedConversations?.has?.(id)) {
          const inMem = loadedConversations.get(id);
          if (Array.isArray(inMem?.messages)) messages = inMem.messages;
        }
      } catch (_) {}

      // 2) 内存没有则从 IndexedDB 取“轻量会话”
      if (!messages) {
        try {
          const conv = await getConversationById(id, false);
          messages = Array.isArray(conv?.messages) ? conv.messages : [];
        } catch (_) {
          messages = [];
        }
      }

      const { totalCount, selected, hasGap } = computeConversationPreviewMessageList(messages);
      if (selected.length === 0) return { totalCount, items: [] };

      const items = [];
      const firstTwo = selected.slice(0, Math.min(2, selected.length));
      const lastTwo = selected.slice(Math.max(0, selected.length - 2));

      const resolveContent = (msg) => {
        if (!msg) return '';
        if (msg.content !== undefined && msg.content !== null) return msg.content;
        return '';
      };

      firstTwo.forEach((msg) => items.push(buildPreviewMessageModel(msg, resolveContent(msg))));
      if (hasGap) items.push({ kind: 'gap' });
      // 避免与 firstTwo 重复（当总消息数 <= 2 时不会出现 gap；但这里仍做防御）
      lastTwo.forEach((msg) => {
        if (firstTwo.includes(msg)) return;
        items.push(buildPreviewMessageModel(msg, resolveContent(msg)));
      });

      return { totalCount, items };
    })();

    conversationPreviewCache.set(id, { time: now, data: null, promise });
    try {
      const data = await promise;
      conversationPreviewCache.set(id, { time: Date.now(), data, promise: null });
      return data;
    } catch (error) {
      conversationPreviewCache.set(id, { time: Date.now(), data: null, promise: null });
      throw error;
    }
  }

  function renderChatHistoryPreviewTooltip(tooltip, meta, previewData) {
    if (!tooltip?._parts) return;
    const { titleEl, metaEl, subMetaEl, messagesEl } = tooltip._parts;

    titleEl.textContent = (meta?.title || '').trim() || '聊天预览';
    metaEl.textContent = (meta?.meta || '').trim();
    const subMetaText = (meta?.submeta || '').trim();
    subMetaEl.textContent = subMetaText;
    subMetaEl.style.display = subMetaText ? '' : 'none';

    messagesEl.textContent = '';
    const items = Array.isArray(previewData?.items) ? previewData.items : [];
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'preview-loading';
      empty.textContent = '暂无消息';
      messagesEl.appendChild(empty);
      return;
    }

    items.forEach((it) => {
      if (it?.kind === 'gap') {
        const gap = document.createElement('div');
        gap.className = 'preview-ellipsis';
        gap.textContent = '…';
        messagesEl.appendChild(gap);
        return;
      }

      const row = document.createElement('div');
      row.className = `preview-message ${it?.roleClass || 'system'}`;

      const role = document.createElement('span');
      role.className = 'preview-role';
      role.textContent = it?.roleLabel || '';

      const text = document.createElement('span');
      text.className = 'preview-text';
      text.textContent = it?.text || '';

      row.appendChild(role);
      row.appendChild(text);
      messagesEl.appendChild(row);
    });
  }

  function positionChatHistoryPreviewTooltip(tooltip, anchorEl) {
    if (!tooltip || !anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const gap = 12;
    const padding = 10;
    const viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;

    const tooltipW = tooltip.offsetWidth || 0;
    const tooltipH = tooltip.offsetHeight || 0;

    // 默认放右侧，若超出屏幕则放左侧
    let placement = 'right';
    let left = rect.right + gap;
    if (left + tooltipW + padding > viewportW) {
      placement = 'left';
      left = rect.left - gap - tooltipW;
    }
    left = Math.min(viewportW - tooltipW - padding, Math.max(padding, left));

    // 顶部对齐（更稳定），必要时向上挪以避免溢出
    let top = rect.top;
    top = Math.min(viewportH - tooltipH - padding, Math.max(padding, top));

    // 箭头尽量对齐到 anchor 的垂直中心
    const anchorCenterY = rect.top + rect.height / 2;
    const arrowTop = Math.min(Math.max(12, anchorCenterY - top - 5), Math.max(12, tooltipH - 18));
    tooltip.style.setProperty('--arrow-top', `${Math.round(arrowTop)}px`);

    tooltip.dataset.placement = placement;
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
  }

  function positionChatHistoryPreviewTooltipByPoint(tooltip, point) {
    if (!tooltip || !point) return;
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    const gap = 12;
    const padding = 10;
    const viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;

    const tooltipW = tooltip.offsetWidth || 0;
    const tooltipH = tooltip.offsetHeight || 0;

    // 期望位置：鼠标右侧；若空间不足则放左侧，避免出屏
    let placement = 'right';
    let left = x + gap;
    if (left + tooltipW + padding > viewportW) {
      placement = 'left';
      left = x - gap - tooltipW;
    }
    left = Math.min(viewportW - tooltipW - padding, Math.max(padding, left));

    // 期望位置：鼠标右下；若下方空间不足则放右上
    let top = y + gap;
    if (top + tooltipH + padding > viewportH) {
      top = y - gap - tooltipH;
    }
    top = Math.min(viewportH - tooltipH - padding, Math.max(padding, top));

    // 箭头尽量对齐到鼠标的垂直位置
    const arrowTop = Math.min(Math.max(12, y - top - 5), Math.max(12, tooltipH - 18));
    tooltip.style.setProperty('--arrow-top', `${Math.round(arrowTop)}px`);

    tooltip.dataset.placement = placement;
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
  }

  function showChatHistoryPreviewTooltip(anchorEl, meta) {
    cancelHideChatHistoryPreviewTooltip();

    const tooltip = ensureChatHistoryPreviewTooltip();
    activePreviewConversationId = meta?.conversationId || null;
    activePreviewAnchorEl = anchorEl || null;

    tooltip.dataset.visible = '1';
    tooltip.dataset.placement = 'right';

    if (tooltip?._parts) {
      const { titleEl, metaEl, subMetaEl, messagesEl } = tooltip._parts;
      titleEl.textContent = (meta?.title || '').trim() || '聊天预览';
      metaEl.textContent = (meta?.meta || '').trim();
      const subMetaText = (meta?.submeta || '').trim();
      subMetaEl.textContent = subMetaText;
      subMetaEl.style.display = subMetaText ? '' : 'none';
      messagesEl.textContent = '';
      const loading = document.createElement('div');
      loading.className = 'preview-loading';
      loading.textContent = '正在加载预览...';
      messagesEl.appendChild(loading);
    }

    positionChatHistoryPreviewTooltip(tooltip, anchorEl);

    const requestId = activePreviewConversationId;
    if (!requestId) return;

    getConversationPreviewData(requestId)
      .then((data) => {
        if (activePreviewConversationId !== requestId) return;
        renderChatHistoryPreviewTooltip(tooltip, meta, data);
        positionChatHistoryPreviewTooltip(tooltip, anchorEl);
      })
      .catch(() => {
        if (activePreviewConversationId !== requestId) return;
        if (tooltip?._parts) {
          const { messagesEl } = tooltip._parts;
          messagesEl.textContent = '';
          const err = document.createElement('div');
          err.className = 'preview-loading';
          err.textContent = '加载预览失败';
          messagesEl.appendChild(err);
        }
        positionChatHistoryPreviewTooltip(tooltip, anchorEl);
      });
  }

  function showChatHistoryPreviewTooltipAtPoint(anchorEl, meta, point) {
    cancelHideChatHistoryPreviewTooltip();

    const tooltip = ensureChatHistoryPreviewTooltip();
    activePreviewConversationId = meta?.conversationId || null;
    activePreviewAnchorEl = anchorEl || null;

    tooltip.dataset.visible = '1';
    tooltip.dataset.placement = 'right';

    if (tooltip?._parts) {
      const { titleEl, metaEl, subMetaEl, messagesEl } = tooltip._parts;
      titleEl.textContent = (meta?.title || '').trim() || '聊天预览';
      metaEl.textContent = (meta?.meta || '').trim();
      const subMetaText = (meta?.submeta || '').trim();
      subMetaEl.textContent = subMetaText;
      subMetaEl.style.display = subMetaText ? '' : 'none';
      messagesEl.textContent = '';
      const loading = document.createElement('div');
      loading.className = 'preview-loading';
      loading.textContent = '正在加载预览...';
      messagesEl.appendChild(loading);
    }

    positionChatHistoryPreviewTooltipByPoint(tooltip, point);

    const requestId = activePreviewConversationId;
    if (!requestId) return;

    getConversationPreviewData(requestId)
      .then((data) => {
        if (activePreviewConversationId !== requestId) return;
        renderChatHistoryPreviewTooltip(tooltip, meta, data);
        // 内容渲染后高度可能变化：使用“最后一次鼠标位置”重新定位，避免抖动/跳动
        positionChatHistoryPreviewTooltipByPoint(tooltip, altPreviewLastPoint);
      })
      .catch(() => {
        if (activePreviewConversationId !== requestId) return;
        if (tooltip?._parts) {
          const { messagesEl } = tooltip._parts;
          messagesEl.textContent = '';
          const err = document.createElement('div');
          err.className = 'preview-loading';
          err.textContent = '加载预览失败';
          messagesEl.appendChild(err);
        }
        positionChatHistoryPreviewTooltipByPoint(tooltip, altPreviewLastPoint);
      });
  }

  function resolveChatHistoryItemFromPoint(x, y) {
    const pointX = Number(x);
    const pointY = Number(y);
    if (!Number.isFinite(pointX) || !Number.isFinite(pointY)) return null;

    let el = null;
    try {
      el = document.elementFromPoint(pointX, pointY);
    } catch (_) {
      el = null;
    }
    if (!el || typeof el.closest !== 'function') return null;

    const item = el.closest('.chat-history-item');
    if (!item) return null;

    const panel = document.getElementById('chat-history-panel');
    if (!panel || !panel.classList.contains('visible')) return null;
    if (!panel.contains(item)) return null;
    return item;
  }

  function updateAltPreviewAtPoint(point) {
    if (!altPreviewActive) return;
    if (!point) return;

    const panel = document.getElementById('chat-history-panel');
    if (!panel || !panel.classList.contains('visible')) {
      hideChatHistoryPreviewTooltip();
      return;
    }

    const item = resolveChatHistoryItemFromPoint(point.x, point.y);
    if (!item) {
      hideChatHistoryPreviewTooltip();
      return;
    }

    const hoverMeta = item._previewHoverMeta || null;
    const conversationId = hoverMeta?.conversationId || (item.getAttribute('data-id') || '');
    if (!conversationId) {
      hideChatHistoryPreviewTooltip();
      return;
    }

    // 仅当“鼠标下方会话发生变化”时才触发读取；否则只更新位置，避免拖慢鼠标移动。
    const tooltip = ensureChatHistoryPreviewTooltip();
    const shouldReload = activePreviewConversationId !== conversationId || tooltip.dataset.visible !== '1';
    if (shouldReload) {
      showChatHistoryPreviewTooltipAtPoint(item, hoverMeta || { conversationId }, point);
    } else {
      positionChatHistoryPreviewTooltipByPoint(tooltip, point);
    }
  }

  function scheduleAltPreviewUpdate(point) {
    altPreviewLastPoint = point || altPreviewLastPoint;
    if (!altPreviewActive) return;
    if (altPreviewRafId) return;
    altPreviewRafId = requestAnimationFrame(() => {
      altPreviewRafId = 0;
      updateAltPreviewAtPoint(altPreviewLastPoint);
    });
  }

  function bindAltPreviewHandlersOnce() {
    if (altPreviewHandlersBound) return;
    altPreviewHandlersBound = true;

    // 记录鼠标位置：Ctrl 按下时可立即定位到“鼠标下方的会话”
    document.addEventListener('mousemove', (e) => {
      altPreviewLastPoint = { x: e.clientX, y: e.clientY };
      if (!altPreviewActive) return;
      scheduleAltPreviewUpdate(altPreviewLastPoint);
    }, { passive: true });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Control') return;
      if (altPreviewActive) return;
      altPreviewActive = true;
      // 立即更新一次：不需要任何 hover 延迟
      scheduleAltPreviewUpdate(altPreviewLastPoint);
    });

    document.addEventListener('keyup', (e) => {
      if (e.key !== 'Control') return;
      altPreviewActive = false;
      hideChatHistoryPreviewTooltip();
    });

    window.addEventListener('blur', () => {
      altPreviewActive = false;
      hideChatHistoryPreviewTooltip();
    });
  }

  bindAltPreviewHandlersOnce();

  function getSearchMatchInfoForConversation(conversationId) {
    if (!conversationId) return null;
    try {
      const panelNode = document.getElementById('chat-history-panel');
      const activeSearchCacheKey = panelNode?.dataset.searchCacheKey || '';
      if (!activeSearchCacheKey) return null;
      const entry = getSearchCacheEntry(activeSearchCacheKey);
      if (!entry || !entry.matchMap) return null;
      return entry.matchMap.get(conversationId) || null;
    } catch (_) {
      return null;
    }
  }

  function getSearchSnippetExpandedConversationIds(panel) {
    const panelNode = panel || document.getElementById('chat-history-panel');
    if (!panelNode) return new Set();
    if (!(panelNode._searchSnippetExpandedByCache instanceof Map)) {
      panelNode._searchSnippetExpandedByCache = new Map();
    }
    const cacheKey = panelNode.dataset.searchCacheKey || panelNode.dataset.normalizedFilter || '__default__';
    let idSet = panelNode._searchSnippetExpandedByCache.get(cacheKey);
    if (!(idSet instanceof Set)) {
      idSet = new Set();
      panelNode._searchSnippetExpandedByCache.set(cacheKey, idSet);
    }
    return idSet;
  }

  function isSearchSnippetExpanded(panel, conversationId) {
    if (!conversationId) return false;
    return getSearchSnippetExpandedConversationIds(panel).has(conversationId);
  }

  function setSearchSnippetExpanded(panel, conversationId, expanded) {
    if (!conversationId) return;
    const idSet = getSearchSnippetExpandedConversationIds(panel);
    if (expanded) {
      idSet.add(conversationId);
    } else {
      idSet.delete(conversationId);
    }
  }

  function buildSearchSnippetPreviewExcerpts(excerpts, previewLimit = SEARCH_RESULT_SNIPPET_PREVIEW_LIMIT) {
    const list = Array.isArray(excerpts) ? excerpts : [];
    if (!list.length || previewLimit <= 0) return [];
    return list.slice(0, previewLimit);
  }

  function createSearchSnippetLineElement(excerpt, conversationId, keywordColorByLower) {
    if (!excerpt) return null;
    const line = document.createElement('div');
    line.className = 'highlight-snippet-line';
    const content = document.createElement('div');
    content.className = 'highlight-snippet-line-content';
    const parts = Array.isArray(excerpt.parts) && excerpt.parts.length
      ? excerpt.parts
      : (Array.isArray(excerpt.segments) && excerpt.segments.length
        ? [{
            segments: excerpt.segments,
            fadeStart: !!excerpt.prefixEllipsis,
            fadeEnd: !!excerpt.suffixEllipsis
          }]
        : []);
    for (const part of parts) {
      if (!part || !Array.isArray(part.segments) || part.segments.length === 0) continue;
      const fragment = document.createElement('span');
      fragment.className = 'highlight-snippet-fragment';
      if (part.fadeStart) fragment.classList.add('is-faded-start');
      if (part.fadeEnd) fragment.classList.add('is-faded-end');
      appendHighlightSegments(fragment, part.segments, keywordColorByLower);
      content.appendChild(fragment);
    }
    if (!content.childNodes.length) return null;
    line.appendChild(content);

    bindSearchSnippetLineJump(line, conversationId, excerpt.messageId || '');
    return line;
  }

  function buildFallbackSearchSnippetData(messages, highlightTerms) {
    const list = Array.isArray(messages) ? messages : [];
    const excerpts = [];
    const matchedMessageKeySet = new Set();
    let totalHitCount = 0;
    const highlightRegex = buildHighlightRegex(highlightTerms);

    for (let index = 0; index < list.length; index += 1) {
      const msg = list[index];
      const plainText = extractMessagePlainText(msg);
      if (!plainText || !highlightRegex) continue;
      const hitCount = countRegexMatches(plainText, highlightRegex);
      if (hitCount <= 0) continue;
      totalHitCount += hitCount;
      matchedMessageKeySet.add(msg?.id || `__message_${index}`);
      const preview = buildMessagePreviewExcerpt(plainText, highlightTerms, SEARCH_RESULT_SNIPPET_CONTEXT_LENGTH);
      if (!preview) continue;
      preview.messageId = msg?.id || '';
      preview.messageIndex = index;
      preview.hitCount = hitCount;
      excerpts.push(preview);
    }

    sortSearchSnippetExcerptsByCoverage(excerpts, highlightTerms);

    return {
      excerpts,
      totalHitCount,
      matchedMessageCount: matchedMessageKeySet.size
    };
  }

  function resolveThreadInfoFromMessage(conversation, messageId) {
    if (!conversation || !messageId) return null;
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    if (!messages.length) return null;
    const target = messages.find(msg => msg?.id === messageId) || null;
    if (!target) return null;

    const threadIdRaw = typeof target.threadId === 'string' ? target.threadId.trim() : '';
    const rootId = typeof target.threadRootId === 'string' ? target.threadRootId.trim() : '';
    const anchorId = typeof target.threadAnchorId === 'string' ? target.threadAnchorId.trim() : '';
    const isThreadCandidate = !!(threadIdRaw || target.threadHiddenSelection || rootId || anchorId);
    if (!isThreadCandidate) return null;

    const resolveFromAnnotations = (annotations, rootMessageId) => {
      if (!Array.isArray(annotations) || !annotations.length) return '';
      if (rootMessageId) {
        const matched = annotations.find(item => item?.rootMessageId === rootMessageId);
        if (matched?.id) return matched.id;
      }
      return '';
    };

    let threadId = threadIdRaw;
    if (!threadId && anchorId) {
      const anchor = messages.find(msg => msg?.id === anchorId) || null;
      threadId = resolveFromAnnotations(anchor?.threadAnnotations, rootId);
    }
    if (!threadId && rootId) {
      for (const msg of messages) {
        threadId = resolveFromAnnotations(msg?.threadAnnotations, rootId);
        if (threadId) break;
      }
    }
    if (!threadId) return null;

    let focusMessageId = messageId;
    if (target.threadHiddenSelection) {
      const fallback = messages.find(msg => msg?.threadId === threadId && !msg?.threadHiddenSelection) || null;
      if (fallback?.id) focusMessageId = fallback.id;
    }

    return { threadId, focusMessageId };
  }

  function resolveConversationMessageTimestamp(message) {
    const ts = Number(message?.timestamp);
    if (Number.isFinite(ts) && ts > 0) return ts;
    const idTs = extractTimestampFromMessageId(message?.id);
    if (Number.isFinite(idTs) && idTs > 0) return idTs;
    return 0;
  }

  function resolveLatestVisibleConversationMessage(conversation) {
    const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
    if (!messages.length) return null;
    let latestMessage = null;
    let latestTimestamp = -1;
    let latestIndex = -1;
    for (let index = 0; index < messages.length; index++) {
      const msg = messages[index];
      if (!msg?.id || msg?.threadHiddenSelection) continue;
      const ts = resolveConversationMessageTimestamp(msg);
      if (!latestMessage || ts > latestTimestamp || (ts === latestTimestamp && index > latestIndex)) {
        latestMessage = msg;
        latestTimestamp = ts;
        latestIndex = index;
      }
    }
    return latestMessage;
  }

  async function jumpToLatestConversationMessage(conversation) {
    const latestMessage = resolveLatestVisibleConversationMessage(conversation);
    if (!latestMessage?.id) return false;
    const threadInfo = resolveThreadInfoFromMessage(conversation, latestMessage.id);
    if (threadInfo?.threadId && services.selectionThreadManager?.enterThread) {
      await services.selectionThreadManager.enterThread(threadInfo.threadId, {
        focusMessageId: threadInfo.focusMessageId || latestMessage.id
      });
      return true;
    }
    jumpToMessageById(latestMessage.id);
    return true;
  }

  async function openConversationFromSearchResult(conversationId, messageId) {
    hideChatHistoryPreviewTooltip();
    const conversation = await getConversationFromCacheOrLoad(conversationId);
    if (!conversation) return;
    const threadInfo = messageId ? resolveThreadInfoFromMessage(conversation, messageId) : null;
    await loadConversationIntoChat(conversation, {
      skipMessageAnimation: !!messageId,
      skipScrollToBottom: !!messageId
    });
    if (messageId) {
      if (threadInfo?.threadId && services.selectionThreadManager?.enterThread) {
        await services.selectionThreadManager.enterThread(threadInfo.threadId, {
          focusMessageId: threadInfo.focusMessageId || messageId
        });
      } else {
        highlightMessageInChat(messageId);
      }
    }
  }

  function bindSearchSnippetLineJump(line, conversationId, messageId) {
    if (!line || !messageId) return;
    line.dataset.messageId = messageId;
    line.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openConversationFromSearchResult(conversationId, messageId);
    });
  }

  function resolveConversationApiLockInfo(rawLock) {
    const lock = normalizeConversationApiLock(rawLock);
    if (!lock) return null;
    const configs = services.apiManager?.getAllConfigs?.() || [];
    const lockConnectionType = normalizeApiConnectionType(lock.connectionType);
    const matchConnectionType = (config) => {
      if (!lockConnectionType) return true;
      return getApiConfigConnectionType(config) === lockConnectionType;
    };
    let matched = null;
    if (lock.connectionSourceId) {
      matched = configs.find(c => c.connectionSourceId === lock.connectionSourceId && matchConnectionType(c)) || null;
    }
    if (!matched && lock.id) {
      matched = configs.find(c => c.id === lock.id) || null;
    } else {
      if (!matched && lock.displayName) {
        matched = configs.find(c =>
          (c.displayName || '').trim() === lock.displayName
          && matchConnectionType(c)
        ) || null;
      }
      if (!matched && lock.modelName) {
        matched = configs.find(c =>
          (c.modelName || '').trim() === lock.modelName
          && matchConnectionType(c)
        ) || null;
      }
      if (!matched && lock.baseUrl && lock.modelName) {
        matched = configs.find(c =>
          c.baseUrl === lock.baseUrl
          && c.modelName === lock.modelName
          && matchConnectionType(c)
        ) || null;
      }
    }

    const label = matched?.displayName
      || matched?.modelName
      || lock.displayName
      || lock.modelName
      || lock.baseUrl
      || '已固定';
    const isValid = !!matched;
    const title = isValid
      ? `固定 API: ${label}`
      : `固定 API: ${label}\n（配置已失效，发送时将回退到当前 API）`;
    return { label, isValid, title };
  }

  function resolveConversationListSummary(conversation) {
    const rawSummary = (typeof conversation?.summary === 'string') ? conversation.summary.trim() : '';
    const summarySource = (typeof conversation?.summarySource === 'string') ? conversation.summarySource.trim() : '';
    const title = (typeof conversation?.title === 'string') ? conversation.title.trim() : '';
    const isSummaryTag = rawSummary.startsWith('[总结]');
    // 非手动标题下，summary 列表标题与元数据 title 同步，避免出现“预览元数据正确、列表标题滞后”的错位。
    if (isSummaryTag && summarySource !== 'manual') {
      return title ? `[总结] ${title}` : '[总结]';
    }
    return rawSummary || '无摘要';
  }

  function createConversationItemElement(conv, highlightPlan, isPinned, panel = null) {
    const item = document.createElement('div');
    item.className = 'chat-history-item';
    item.setAttribute('data-id', conv.id);
    if (isPinned) {
      item.classList.add('pinned');
    }

    // --- 分支树状显示（UI 专用字段，来自 buildConversationBranchTreeDisplayList）---
    const branchDepth = Number.isFinite(Number(conv?.__branchDepth)) ? Number(conv.__branchDepth) : 0;
    const declaredParentId = typeof conv?.parentConversationId === 'string' ? conv.parentConversationId.trim() : '';
    const isForkConversation = !!declaredParentId;
    const isOrphanFork = !!conv?.__branchIsOrphan;

    if (branchDepth > 0) {
      item.classList.add('branch-tree-child');
      item.style.setProperty('--branch-depth', String(branchDepth));
    }
    if (isForkConversation) {
      item.classList.add('forked-conversation');
      // 便于未来做“跳转父会话”等交互：把 parentId 放到 DOM dataset
      try { item.dataset.parentConversationId = declaredParentId; } catch (_) {}
    }
    if (isOrphanFork) {
      item.classList.add('forked-orphan');
    }

    const summaryDiv = document.createElement('div');
    summaryDiv.className = 'summary';
    const displaySummary = resolveConversationListSummary(conv);
    const highlightTerms = Array.isArray(highlightPlan?.termsLower) && highlightPlan.termsLower.length
      ? highlightPlan.termsLower
      : (Array.isArray(highlightPlan?.terms) ? highlightPlan.terms : []);
    const keywordColorByLower = (highlightPlan && typeof highlightPlan.keywordColorByLower === 'object')
      ? highlightPlan.keywordColorByLower
      : null;
    const hasHighlightTerms = highlightTerms.length > 0;
    if (hasHighlightTerms && displaySummary) {
      try {
        const segments = buildHighlightSegments(displaySummary, highlightTerms);
        if (segments && segments.length) {
          summaryDiv.textContent = '';
          appendHighlightSegments(summaryDiv, segments, keywordColorByLower);
        } else {
          summaryDiv.textContent = displaySummary;
        }
      } catch (e) {
        console.error("高亮摘要时发生错误:", e);
        summaryDiv.textContent = displaySummary;
      }
    } else {
      summaryDiv.textContent = displaySummary;
    }

    const searchMatchInfo = getSearchMatchInfoForConversation(conv.id);

    const infoDiv = document.createElement('div');
    infoDiv.className = 'info';
    const convDate = new Date(conv.startTime);
    const endTime = new Date(conv.endTime);
    const relativeTime = formatRelativeTime(convDate);
    const relativeEndTime = formatRelativeTime(endTime);
    const domain = getDisplayUrl(conv.url);
    const chatTimeSpan = relativeTime === relativeEndTime ? relativeTime : `${relativeTime} - ${relativeEndTime}`;
    const totalCount = Number.isFinite(Number(conv?.messageCount)) ? Number(conv.messageCount) : 0;
    const mainCount = Number.isFinite(Number(conv?.mainMessageCount))
      ? Number(conv.mainMessageCount)
      : Math.max(0, totalCount);
    const threadMessageCount = Number.isFinite(Number(conv?.threadMessageCount))
      ? Number(conv.threadMessageCount)
      : Math.max(0, totalCount - mainCount);
    const threadCount = Number.isFinite(Number(conv?.threadCount)) ? Number(conv.threadCount) : 0;
    const hasThreads = threadCount !== 0 || threadMessageCount !== 0;
    const apiLockInfo = resolveConversationApiLockInfo(conv?.apiLock);
    const statsMetaParts = [`消息 ${totalCount}`];
    if (hasThreads) {
      const threadMetaParts = [];
      if (threadCount !== 0) {
        threadMetaParts.push(`线程 ${threadCount}`);
      }
      if (threadMessageCount !== 0) {
        threadMetaParts.push(`消息${threadMessageCount}`);
      }
      statsMetaParts.push(threadMetaParts.join(' '));
    }
    const displayInfos = `${chatTimeSpan} · ${statsMetaParts.join(' ')} · ${domain}`;
    const infoContent = document.createElement('span');
    infoContent.className = 'info-content';
    const statsWrap = document.createElement('span');
    statsWrap.className = 'conversation-stats';
    const appendStat = (iconClass, value, label) => {
      const stat = document.createElement('span');
      stat.className = 'conversation-stat';
      stat.title = label;
      const icon = document.createElement('i');
      icon.className = `fa-solid fa-fw ${iconClass}`;
      icon.setAttribute('aria-hidden', 'true');
      const count = document.createElement('span');
      count.className = 'conversation-stat-count';
      count.textContent = String(value);
      stat.appendChild(icon);
      stat.appendChild(count);
      statsWrap.appendChild(stat);
    };
    appendStat('fa-comments', totalCount, `消息 ${totalCount}`);
    if (hasThreads) {
      const threadStat = document.createElement('span');
      threadStat.className = 'conversation-stat conversation-stat-thread';
      const threadTitleParts = [];
      if (threadCount !== 0) {
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-fw fa-code-branch';
        icon.setAttribute('aria-hidden', 'true');
        const count = document.createElement('span');
        count.className = 'conversation-stat-count';
        count.textContent = String(threadCount);
        threadStat.appendChild(icon);
        threadStat.appendChild(count);
        threadTitleParts.push(`线程 ${threadCount}`);
      }
      if (threadMessageCount !== 0) {
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-fw fa-comment-dots';
        icon.setAttribute('aria-hidden', 'true');
        const count = document.createElement('span');
        count.className = 'conversation-stat-count';
        count.textContent = String(threadMessageCount);
        threadStat.appendChild(icon);
        threadStat.appendChild(count);
        threadTitleParts.push(`消息${threadMessageCount}`);
      }
      threadStat.title = threadTitleParts.join(' ');
      statsWrap.appendChild(threadStat);
    }
    const createInfoSpan = (className, text) => {
      const span = document.createElement('span');
      if (className) {
        span.className = className;
      }
      span.textContent = text;
      return span;
    };
    const createSeparator = () => createInfoSpan('info-separator', '·');
    infoContent.appendChild(createInfoSpan('info-time', chatTimeSpan));
    infoContent.appendChild(createSeparator());
    infoContent.appendChild(statsWrap);
    if (apiLockInfo) {
      const apiLockSpan = document.createElement('span');
      apiLockSpan.className = 'info-api-lock';
      if (!apiLockInfo.isValid) {
        apiLockSpan.classList.add('info-api-lock--invalid');
      }
      const lockIcon = document.createElement('i');
      lockIcon.className = 'fa-solid fa-lock';
      lockIcon.setAttribute('aria-hidden', 'true');
      const lockText = document.createElement('span');
      lockText.textContent = apiLockInfo.label;
      apiLockSpan.appendChild(lockIcon);
      apiLockSpan.appendChild(lockText);
      apiLockSpan.title = apiLockInfo.title;
      infoContent.appendChild(createSeparator());
      infoContent.appendChild(apiLockSpan);
    }
    infoContent.appendChild(createSeparator());
    infoContent.appendChild(createInfoSpan('info-domain', domain));

    const statusBadges = document.createElement('span');
    statusBadges.className = 'info-status-badges';
    statusBadges.hidden = true;
    statusBadges.setAttribute('aria-hidden', 'true');

    const streamingWrap = document.createElement('span');
    streamingWrap.className = 'info-streaming-wrap';
    streamingWrap.hidden = true;
    streamingWrap.setAttribute('aria-hidden', 'true');
    const streamingBadge = createInfoSpan('info-streaming', '生成中');
    streamingBadge.title = '该会话正在流式生成';
    streamingWrap.appendChild(streamingBadge);
    statusBadges.appendChild(streamingWrap);

    const backgroundCompleteWrap = document.createElement('span');
    backgroundCompleteWrap.className = 'info-background-complete-wrap';
    backgroundCompleteWrap.hidden = true;
    backgroundCompleteWrap.setAttribute('aria-hidden', 'true');
    const backgroundCompleteBadge = createInfoSpan('info-background-complete', '已完成');
    backgroundCompleteBadge.title = '该会话已在后台生成完成';
    backgroundCompleteWrap.appendChild(backgroundCompleteBadge);
    statusBadges.appendChild(backgroundCompleteWrap);

    const openWrap = document.createElement('span');
    openWrap.className = 'info-open-wrap';
    openWrap.hidden = true;
    openWrap.setAttribute('aria-hidden', 'true');
    const openCurrentBadge = createInfoSpan(
      'info-open-state info-open-state-current is-open-current',
      '当前打开'
    );
    openCurrentBadge.hidden = true;
    openCurrentBadge.setAttribute('aria-hidden', 'true');
    openCurrentBadge.dataset.openStateKey = '';
    openCurrentBadge.setAttribute('aria-label', '该会话已在当前标签页打开');
    openCurrentBadge.setAttribute('aria-disabled', 'true');
    openWrap.appendChild(openCurrentBadge);

    const openElsewhereBadge = createInfoSpan(
      'info-open-state info-open-state-elsewhere is-open-elsewhere',
      '已打开'
    );
    openElsewhereBadge.hidden = true;
    openElsewhereBadge.setAttribute('aria-hidden', 'true');
    openElsewhereBadge.dataset.openStateKey = '';
    openElsewhereBadge.setAttribute('role', 'button');
    openElsewhereBadge.setAttribute('aria-label', '该会话已在其它标签页打开');
    openElsewhereBadge.setAttribute('aria-disabled', 'true');
    openWrap.appendChild(openElsewhereBadge);
    statusBadges.appendChild(openWrap);

    infoContent.appendChild(statusBadges);

    // URL 快速筛选模式下，为每条会话标注“匹配等级”，便于用户理解来源范围
    // - 等级越小越严格（越接近当前页面 URL）
    // - 鼠标悬停可查看匹配前缀
    const hasUrlMatchLevel = Number.isFinite(Number(conv?.urlMatchLevel));
    if (hasUrlMatchLevel) {
      const level = Number(conv.urlMatchLevel);
      const prefix = typeof conv?.urlMatchPrefix === 'string' ? conv.urlMatchPrefix : '';
      const badge = document.createElement('span');
      badge.className = `url-match-badge url-match-level-${level}`;
      badge.textContent = `L${level}`;
      badge.title = prefix
        ? `URL 匹配等级 L${level}（越小越精确）\n匹配前缀: ${prefix}`
        : `URL 匹配等级 L${level}（越小越精确）`;
      infoDiv.appendChild(badge);
      infoDiv.appendChild(infoContent);
    } else {
      infoDiv.appendChild(infoContent);
    }
    // 说明：
    // - 过去通过 item.title 触发浏览器原生 tooltip（展示时间/URL 等）；
    // - 现在改为 hover 自绘 tooltip，展示消息预览，因此这里不再设置 title，避免原生 tooltip 与自绘 tooltip 冲突。

    const mainDiv = document.createElement('div');
    mainDiv.className = 'chat-history-item-main';
    mainDiv.appendChild(summaryDiv);
    mainDiv.appendChild(infoDiv);

    item.appendChild(mainDiv);
    // “已打开”状态徽标：放在信息行末尾，保持与“生成中”一致的视觉风格。
    openElsewhereBadge.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!conversationPresence?.focusConversation) return;
      if (openElsewhereBadge.dataset.busy === '1') return;

      // 只有当“其它标签页”确实存在时才跳转（避免跳回当前标签页造成困惑）
      const { otherTabs } = getConversationOpenTabsState(conv.id);
      if (!Array.isArray(otherTabs) || otherTabs.length === 0) return;

      try {
        openElsewhereBadge.dataset.busy = '1';
        const selfTabId = conversationPresence.getSelfTabId?.() ?? null;
        const result = await conversationPresence.focusConversation(conv.id, { excludeTabId: selfTabId });
        if (result?.status === 'ok') {
          // 保持 ESC 面板打开，方便跳转后继续在当前标签页查看/操作历史列表。
          return;
        }
        if (result?.status && result.status !== 'not_found') {
          showNotification?.({ message: '跳转失败', type: 'error', duration: 1800 });
        }
      } finally {
        openElsewhereBadge.dataset.busy = '';
      }
    });

    // 预览 tooltip 元信息：供 Ctrl 预览模式使用（按住 Ctrl 才展示）
    const hoverMeta = {
      conversationId: conv.id,
      title: displaySummary,
      meta: displayInfos,
      submeta: [conv?.title, conv?.url].map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean).join(' · ')
    };
    // Ctrl 预览模式：把元信息挂到 DOM 节点上，供全局的 Ctrl+MouseMove 快速读取。
    // 说明：不再使用“纯 hover + 延迟”的方式触发，避免日常浏览时预览框频繁弹出遮挡内容。
    item._previewHoverMeta = hoverMeta;

    const renderSearchSnippetBlock = (snippetData) => {
      if (!snippetData || !Array.isArray(snippetData.excerpts) || snippetData.excerpts.length === 0) return false;
      const allExcerpts = snippetData.excerpts;
      const expanded = isSearchSnippetExpanded(panel, conv.id);
      const previewExcerpts = buildSearchSnippetPreviewExcerpts(allExcerpts);
      const visibleExcerpts = expanded ? allExcerpts : previewExcerpts;
      const snippetDiv = document.createElement('div');
      snippetDiv.className = 'highlight-snippet';

      visibleExcerpts.forEach((excerpt) => {
        const line = createSearchSnippetLineElement(excerpt, conv.id, keywordColorByLower);
        if (line) snippetDiv.appendChild(line);
      });

      const totalSnippetCount = allExcerpts.length;
      const totalHitCount = Math.max(0, Number(snippetData.totalHitCount || 0));
      const matchedMessageCount = Math.max(0, Number(snippetData.matchedMessageCount || 0));
      const hasMoreToToggle = totalSnippetCount > previewExcerpts.length;
      const shouldShowMeta = totalHitCount > 0 || matchedMessageCount > 0 || hasMoreToToggle;
      if (shouldShowMeta) {
        const actions = document.createElement('div');
        actions.className = 'highlight-snippet-actions';

        const meta = document.createElement('span');
        meta.className = 'highlight-snippet-meta';
        const metaParts = [];
        if (totalHitCount > 0) metaParts.push(`命中 ${totalHitCount} 处`);
        if (matchedMessageCount > 0) metaParts.push(`分布于 ${matchedMessageCount} 条消息`);
        meta.textContent = metaParts.join(' · ');
        actions.appendChild(meta);

        if (hasMoreToToggle) {
          const toggleSnippetExpansion = (event) => {
            event.preventDefault();
            event.stopPropagation();
            setSearchSnippetExpanded(panel, conv.id, !expanded);
            item.replaceWith(createConversationItemElement(conv, highlightPlan, isPinned, panel));
          };

          actions.classList.add('is-toggleable');
          actions.setAttribute('role', 'button');
          actions.setAttribute('tabindex', '0');
          actions.setAttribute('aria-expanded', expanded ? 'true' : 'false');
          actions.addEventListener('click', toggleSnippetExpansion);
          actions.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            toggleSnippetExpansion(event);
          });

          const separator = document.createElement('span');
          separator.className = 'highlight-snippet-meta-separator';
          separator.textContent = '·';
          actions.appendChild(separator);

          const toggleText = document.createElement('span');
          toggleText.className = 'highlight-snippet-toggle';
          toggleText.textContent = expanded ? '收起' : '展开全部';
          actions.appendChild(toggleText);
        }

        snippetDiv.appendChild(actions);
      }

      mainDiv.appendChild(snippetDiv);
      return true;
    };

    let snippetRendered = false;
    if (hasHighlightTerms && searchMatchInfo && Array.isArray(searchMatchInfo.excerpts) && searchMatchInfo.excerpts.length) {
      snippetRendered = renderSearchSnippetBlock({
        excerpts: searchMatchInfo.excerpts,
        totalHitCount: searchMatchInfo.totalHitCount,
        matchedMessageCount: searchMatchInfo.matchedMessageCount
      });
    }

    if (!snippetRendered && hasHighlightTerms && conv.messages && Array.isArray(conv.messages)) {
      snippetRendered = renderSearchSnippetBlock(buildFallbackSearchSnippetData(conv.messages, highlightTerms));
    }

    const openConversationByItemHeader = async () => {
      const matchInfo = getSearchMatchInfoForConversation(conv.id);
      const jumpMessageId = matchInfo?.messageId || null;
      await openConversationFromSearchResult(conv.id, jumpMessageId);
    };
    summaryDiv.addEventListener('click', openConversationByItemHeader);
    infoDiv.addEventListener('click', openConversationByItemHeader);
    
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showChatHistoryItemContextMenu(e, conv.id, conv.url);
    });

    // 根据最新快照更新右侧“已打开/跳转”标记
    ensureStreamingConversationUiSubscription();
    updateConversationItemStreamingUi(item, conv.id);
    updateConversationItemBackgroundCompletionUi(item, conv.id);
    updateConversationItemOpenTabUi(item, conv.id);

    return item;
  }

  /**
   * 默认分页模式下，从 IndexedDB 继续按 endTime 倒序加载下一页“轻量元数据”。
   *
   * 设计要点：
   * - 只在 mode==='paged' 且已渲染到当前已加载数据末尾时触发；
   * - 仅追加“非置顶”会话（置顶会话已在首屏批量读取并固定在顶部）。
   *
   * @param {HTMLElement|null} panel
   * @param {string[]} pinnedIds
   * @param {string} currentPanelFilter
   * @param {string} currentRunId
   * @returns {Promise<boolean>} 是否成功追加了新条目
   */
  async function appendNextUnpinnedPageForPagedMode(panel, pinnedIds, currentPanelFilter, currentRunId) {
    const dataSource = panel?._historyDataSource;
    if (!dataSource || dataSource.mode !== 'paged' || !dataSource.hasMore) return false;

    // 若期间用户切换筛选条件/触发新的加载流程，则直接放弃本次追加，避免旧数据污染
    if (!panel || panel.dataset.currentFilter !== currentPanelFilter || panel.dataset.runId !== currentRunId) {
      return false;
    }

    const limit = Math.max(1, Number(dataSource.pageSize) || PAGED_UNPINNED_LOAD_SIZE);

    let page = null;
    try {
      page = await getConversationMetadataPageByEndTimeDesc({
        limit,
        cursor: dataSource.cursor || null,
        excludeIds: pinnedIds
      });
    } catch (error) {
      console.error('分页加载聊天记录失败:', error);
      dataSource.hasMore = false;
      return false;
    }

    if (panel.dataset.currentFilter !== currentPanelFilter || panel.dataset.runId !== currentRunId) {
      return false;
    }

    const items = Array.isArray(page?.items) ? page.items : [];
    dataSource.cursor = page?.cursor || null;
    dataSource.hasMore = !!page?.hasMore;

    if (items.length === 0) {
      dataSource.hasMore = false;
      return false;
    }

    if (!(dataSource.loadedIdSet instanceof Set)) {
      dataSource.loadedIdSet = new Set(currentDisplayItems.map((item) => item?.id).filter(Boolean));
    }

    let appended = false;
    for (const item of items) {
      if (!item || !item.id) continue;
      if (dataSource.loadedIdSet.has(item.id)) continue;
      dataSource.loadedIdSet.add(item.id);
      currentDisplayItems.push(item);
      appended = true;
    }

    // 极端兜底：若没有任何新增条目，避免 hasMore 一直为 true 导致空转
    if (!appended) {
      dataSource.hasMore = false;
    }

    return appended;
  }

  /**
   * 渲染下一批聊天记录项。
   * @param {HTMLElement} listContainer - 列表容器元素
   * @param {string[]} pinnedIds - 当前置顶的ID列表
   * @param {{terms:string[], termsLower:string[], hasTerms:boolean, keywordColorByLower?:Record<string,string>, keywordEntries?:Array<{term:string, termLower:string, color:string}>}} highlightPlan - 用于文本高亮的关键词计划
   * @param {string} currentPanelFilter - 调用此函数时面板当前的过滤条件，用于一致性检查
   */
  async function renderMoreItems(listContainer, pinnedIds, highlightPlan, currentPanelFilter, currentRunId) {
    if (isLoadingMoreItems) {
      return;
    }
    isLoadingMoreItems = true;

    const panel = listContainer.closest('#chat-history-panel');
    if (panel && (panel.dataset.currentFilter !== currentPanelFilter || panel.dataset.runId !== currentRunId)) {
      isLoadingMoreItems = false;
      return;
    }
    // 树状视图（且无筛选）时：
    // - 仍然按时间分组，但分组依据改为“整棵树的最新 endTime（max）”，并且只会在树根节点处插入一次；
    // - 这样既保留树状父子连续展示，也保留用户熟悉的“今天/昨天/本周...”分组体验。
    const isBranchTreeOrderingActive = !!(
      panel &&
      panel.dataset.branchViewMode === 'tree' &&
      !(panel.dataset.currentFilter || '').trim()
    );

    // 若已渲染到当前已加载数据末尾：在 paged 模式下尝试继续从 DB 追加下一页
    if (currentlyRenderedCount >= currentDisplayItems.length) {
      const appended = await appendNextUnpinnedPageForPagedMode(panel, pinnedIds, currentPanelFilter, currentRunId);
      if (!appended || currentlyRenderedCount >= currentDisplayItems.length) {
        isLoadingMoreItems = false;
        return;
      }
    }

    const fragment = document.createDocumentFragment();
    let itemsRenderedInThisCall = 0;

    for (let i = 0; (currentlyRenderedCount + i) < currentDisplayItems.length && i < BATCH_SIZE; i++) {
      const convIndex = currentlyRenderedCount + i;
      const conv = currentDisplayItems[convIndex];
      const isConvPinned = pinnedIds.includes(conv.id);
      const isInPinnedSection = convIndex < currentPinnedItemsCountInDisplay;

      if (!isInPinnedSection) {
        const isFirstUnpinnedAfterPinnedBlock = (convIndex === currentPinnedItemsCountInDisplay);

        let groupKey = '';
        let groupText = '';
        let groupTitle = '';

        if (panel?._historyDataSource?.mode === 'url') {
          const level = Number.isFinite(Number(conv?.urlMatchLevel)) ? Number(conv.urlMatchLevel) : null;
          const prefix = typeof conv?.urlMatchPrefix === 'string' ? conv.urlMatchPrefix : '';
          groupKey = `urlMatchLevel:${level == null ? 'unknown' : level}`;
          if (level == null) {
            groupText = 'URL 匹配';
            groupTitle = prefix ? `URL 前缀匹配\n匹配前缀: ${prefix}` : 'URL 前缀匹配';
          } else {
            groupText = `匹配 L${level}`;
            groupTitle = prefix
              ? `URL 匹配等级：L${level}（越小越精确）\n匹配前缀: ${prefix}`
              : `URL 匹配等级：L${level}（越小越精确）`;
          }
        } else {
          // 默认按 endTime 分组；树状模式下改用“整棵树的排序时间”（来自 buildConversationBranchTreeDisplayList 的 __treeSortEndTime）。
          const groupTime = isBranchTreeOrderingActive
            ? (Number(conv?.__treeSortEndTime) || Number(conv?.endTime) || 0)
            : (Number(conv?.endTime) || 0);
          const convDate = groupTime ? new Date(groupTime) : new Date();
          const groupLabel = getGroupLabel(convDate);
          groupKey = groupLabel;
          groupText = groupLabel;
        }

        if (isFirstUnpinnedAfterPinnedBlock || currentGroupLabelForBatchRender !== groupKey) {
          const groupHeader = document.createElement('div');
          groupHeader.className = 'chat-history-group-header';
          groupHeader.textContent = groupText;
          if (groupTitle) groupHeader.title = groupTitle;
          fragment.appendChild(groupHeader);
          currentGroupLabelForBatchRender = groupKey;
        }
      }

      const itemElement = createConversationItemElement(conv, highlightPlan, isConvPinned, panel);
      fragment.appendChild(itemElement);
      itemsRenderedInThisCall++;
    }

    if (currentlyRenderedCount === 0) {
      removeSkeleton(listContainer);
    }

    listContainer.appendChild(fragment);
    // 确保哨兵始终位于列表末尾，兼容拖动滚动条和键盘 End 触发加载
    {
      const sentinel = ensureEndSentinel(listContainer);
      if (sentinel && sentinel.parentElement === listContainer) {
        listContainer.appendChild(sentinel);
      }
    }
    currentlyRenderedCount += itemsRenderedInThisCall;
    isLoadingMoreItems = false;

    if (itemsRenderedInThisCall > 0) {
      requestAnimationFrame(() => {
        const panelNow = listContainer.closest('#chat-history-panel');
        if (!panelNow) return;
        if (panelNow.dataset.currentFilter !== currentPanelFilter || panelNow.dataset.runId !== currentRunId) return;
        const ds = panelNow._historyDataSource;
        const mayHaveMore = ds && ds.mode === 'paged' && ds.hasMore;
        if (listContainer.scrollHeight <= listContainer.clientHeight && (currentlyRenderedCount < currentDisplayItems.length || mayHaveMore)) {
          renderMoreItems(listContainer, pinnedIds, highlightPlan, currentPanelFilter, currentRunId);
        }
      });
    }
  }

  async function loadGalleryImages(forceRefresh = false, options = {}) {
    const normalizedOptions = (options && typeof options === 'object') ? options : {};
    const onBatch = typeof normalizedOptions.onBatch === 'function' ? normalizedOptions.onBatch : null;
    const onProgress = typeof normalizedOptions.onProgress === 'function' ? normalizedOptions.onProgress : null;
    const shouldCancel = typeof normalizedOptions.shouldCancel === 'function' ? normalizedOptions.shouldCancel : () => false;
    const runId = normalizedOptions.runId || createRunId();

    if (!forceRefresh && galleryCache.loaded) {
      if (onBatch) onBatch(galleryCache.items, { done: true, fromCache: true });
      return galleryCache.items;
    }

    if (galleryCache.loadingPromise && !forceRefresh && !onBatch) {
      return galleryCache.loadingPromise;
    }

    galleryCache.runId = runId;

    const runPromise = (async () => {
      if (forceRefresh) {
        if (Array.isArray(galleryCache.items)) {
          galleryCache.items.length = 0;
        } else {
          galleryCache.items = [];
        }
        galleryCache.loaded = false;
        galleryCache.lastLoadTs = 0;
        galleryCache.scanState = null;
      }

      const images = galleryCache.items;
      if (!galleryCache.scanState) {
        // 相册流式扫描状态：去重统计 + 删除索引，用于后续重复计数与批量删除
        galleryCache.scanState = {
          cursor: null,
          hasMore: true,
          seenKeys: new Set(),
          scannedConversations: 0,
          itemByKey: new Map(),
          dupCountByKey: new Map(),
          convIdsByKey: new Map(),
          deletedKeys: new Set(),
          pendingDupKeys: new Set()
        };
      }
      const scanState = galleryCache.scanState;
      const seenKeys = scanState.seenKeys instanceof Set ? scanState.seenKeys : new Set();
      scanState.seenKeys = seenKeys;
      const itemByKey = scanState.itemByKey instanceof Map ? scanState.itemByKey : new Map();
      scanState.itemByKey = itemByKey;
      const dupCountByKey = scanState.dupCountByKey instanceof Map ? scanState.dupCountByKey : new Map();
      scanState.dupCountByKey = dupCountByKey;
      const convIdsByKey = scanState.convIdsByKey instanceof Map ? scanState.convIdsByKey : new Map();
      scanState.convIdsByKey = convIdsByKey;
      const deletedKeys = scanState.deletedKeys instanceof Set ? scanState.deletedKeys : new Set();
      scanState.deletedKeys = deletedKeys;
      const pendingDupKeys = scanState.pendingDupKeys instanceof Set ? scanState.pendingDupKeys : new Set();
      scanState.pendingDupKeys = pendingDupKeys;

      if (seenKeys.size === 0 && images.length) {
        images.forEach((item) => {
          const key = item?.dedupeKey || (item?.url ? `url:${item.url}` : '');
          if (key) seenKeys.add(key);
        });
      }
      if (itemByKey.size === 0 && images.length) {
        images.forEach((item) => {
          if (!item?.dedupeKey) return;
          itemByKey.set(item.dedupeKey, item);
          const current = Math.max(1, Number(item.dupCount) || 1);
          dupCountByKey.set(item.dedupeKey, current);
        });
      }
      let downloadRoot = null;
      try {
        downloadRoot = await loadDownloadRoot();
      } catch (_) {}

      const yieldToMain = () => new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => resolve());
        } else {
          setTimeout(resolve, 0);
        }
      });

      const flushBatch = (() => {
        let buffer = [];
        return (records = null, meta = null) => {
          if (Array.isArray(records) && records.length) {
            buffer.push(...records);
          }
          const shouldFlush = buffer.length >= 24 || (!!meta && meta.force) || (!records && buffer.length);
          if (shouldFlush && onBatch) {
            const payload = buffer;
            buffer = [];
            onBatch(payload, meta || {});
          }
        };
      })();

      let cursor = scanState.cursor || null;
      let hasMore = scanState.hasMore !== false;
      let scannedConversations = scanState.scannedConversations || 0;
      // 分页流式扫描：边读边产出，避免一次性“收集图片”阻塞 UI
      while (hasMore) {
        if (shouldCancel() || galleryCache.runId !== runId) {
          return images;
        }

        let page = null;
        try {
          page = await getConversationMetadataPageByEndTimeDesc({
            limit: Math.max(1, Number(normalizedOptions.pageSize) || GALLERY_META_PAGE_SIZE),
            cursor
          });
        } catch (error) {
          console.error('流式读取相册元数据失败:', error);
          break;
        }

        const metas = Array.isArray(page?.items) ? page.items : [];
        cursor = page?.cursor || null;
        hasMore = !!page?.hasMore;
        scanState.cursor = cursor;
        scanState.hasMore = hasMore;

        if (!metas.length) {
          hasMore = false;
          scanState.hasMore = false;
          break;
        }

        for (const meta of metas) {
          if (shouldCancel() || galleryCache.runId !== runId) {
            return images;
          }
          const conv = await getConversationById(meta.id, true);
          scannedConversations += 1;
          scanState.scannedConversations = scannedConversations;
          if (!conv || !Array.isArray(conv.messages)) {
            if (scannedConversations % 4 === 0) {
              flushBatch();
              await yieldToMain();
            }
            continue;
          }

          const convDomain = getDisplayUrl(conv.url);
          for (let m = conv.messages.length - 1; m >= 0; m--) {
            const msg = conv.messages[m];
            const timestamp = getGalleryMessageTimestamp(msg, conv);
            const normalizedContent = normalizeStoredMessageContent(msg?.content);
            if (!Array.isArray(normalizedContent)) continue;

            const imageParts = [];
            for (let idx = 0; idx < normalizedContent.length; idx++) {
              const part = normalizedContent[idx];
              if (!part || part.type !== 'image_url' || !part.image_url) continue;
              imageParts.push({ imageUrl: part.image_url, partIndex: idx });
            }
            if (!imageParts.length) continue;

            const records = [];
            const orderedParts = imageParts.slice().sort((a, b) => a.partIndex - b.partIndex);
            for (const part of orderedParts) {
              const resolvedUrl = resolveImageUrlForGallery(part.imageUrl, downloadRoot);
              if (!resolvedUrl) continue;
              const dedupeKey = buildGalleryImageKey(part.imageUrl, resolvedUrl);
              if (!dedupeKey || deletedKeys.has(dedupeKey)) continue;
              const convIds = convIdsByKey.get(dedupeKey) || new Set();
              convIds.add(conv.id);
              convIdsByKey.set(dedupeKey, convIds);
              const nextCount = (dupCountByKey.get(dedupeKey) || 0) + 1;
              dupCountByKey.set(dedupeKey, nextCount);
              if (seenKeys.has(dedupeKey)) {
                const existed = itemByKey.get(dedupeKey);
                if (existed) {
                  existed.dupCount = nextCount;
                  pendingDupKeys.add(dedupeKey);
                }
                continue;
              }
              seenKeys.add(dedupeKey);
              const record = {
                conversationId: conv.id,
                messageId: msg.id,
                messageKey: `${conv.id || 'conv'}_${msg.id || m}`,
                url: resolvedUrl,
                timestamp,
                summary: conv.summary || '',
                title: conv.title || '',
                domain: convDomain || '未知来源',
                dedupeKey,
                dupCount: nextCount
              };
              itemByKey.set(dedupeKey, record);
              records.push(record);
            }

            if (records.length) {
              images.push(...records);
              flushBatch(records);
            }
          }

          if (scannedConversations % 4 === 0) {
            flushBatch();
            await yieldToMain();
          }
        }

        flushBatch();
        if (onProgress) {
          onProgress({ scannedConversations, imageCount: images.length, hasMore });
        }
        await yieldToMain();
      }

      flushBatch(null, { force: true, done: true });
      galleryCache.loaded = !scanState.hasMore;
      galleryCache.lastLoadTs = Date.now();
      return images;
    })();

    galleryCache.loadingPromise = runPromise;
    try {
      return await runPromise;
    } finally {
      if (galleryCache.loadingPromise === runPromise) {
        galleryCache.loadingPromise = null;
      }
    }
  }

  function applyGalleryDeletionToCache(deletedKeys) {
    const keySet = deletedKeys instanceof Set
      ? deletedKeys
      : new Set(Array.isArray(deletedKeys) ? deletedKeys.filter(Boolean) : []);
    if (!keySet.size) return;
    if (Array.isArray(galleryCache.items)) {
      // 保持数组引用不变，避免渲染流程持有旧引用导致追加错乱
      const nextItems = galleryCache.items.filter(item => !keySet.has(item?.dedupeKey));
      galleryCache.items.length = 0;
      galleryCache.items.push(...nextItems);
    } else {
      galleryCache.items = [];
    }
    if (galleryCache.selectedKeys instanceof Set) {
      keySet.forEach((key) => galleryCache.selectedKeys.delete(key));
    }
    const scanState = galleryCache.scanState;
    if (scanState) {
      if (scanState.deletedKeys instanceof Set) {
        keySet.forEach((key) => scanState.deletedKeys.add(key));
      } else {
        scanState.deletedKeys = new Set(keySet);
      }
      if (scanState.itemByKey instanceof Map) {
        keySet.forEach((key) => scanState.itemByKey.delete(key));
      }
      if (scanState.dupCountByKey instanceof Map) {
        keySet.forEach((key) => scanState.dupCountByKey.delete(key));
      }
      if (scanState.convIdsByKey instanceof Map) {
        keySet.forEach((key) => scanState.convIdsByKey.delete(key));
      }
      if (scanState.pendingDupKeys instanceof Set) {
        keySet.forEach((key) => scanState.pendingDupKeys.delete(key));
      }
    }
  }

  function cleanupEmptyGalleryGroups(container) {
    if (!container) return;
    try {
      container.querySelectorAll('.gallery-group').forEach((group) => {
        const grid = group.querySelector('.gallery-group-grid');
        const hasItem = grid && grid.querySelector('.gallery-item');
        if (!hasItem) {
          group.remove();
        }
      });
    } catch (_) {}
  }

  function removeGalleryItemsFromDom(container, deletedKeys) {
    if (!container) return 0;
    const keySet = deletedKeys instanceof Set
      ? deletedKeys
      : new Set(Array.isArray(deletedKeys) ? deletedKeys.filter(Boolean) : []);
    if (!keySet.size) return 0;
    let removed = 0;
    const domByKey = container._galleryDomByKey;
    if (domByKey instanceof Map) {
      keySet.forEach((key) => {
        const item = domByKey.get(key);
        if (item?.remove) {
          item.remove();
          removed += 1;
        }
        domByKey.delete(key);
      });
      cleanupEmptyGalleryGroups(container);
      return removed;
    }
    try {
      container.querySelectorAll('.gallery-item[data-dedupe-key]').forEach((item) => {
        if (keySet.has(item.dataset.dedupeKey)) {
          item.remove();
          removed += 1;
        }
      });
    } catch (_) {}
    cleanupEmptyGalleryGroups(container);
    return removed;
  }

  async function deleteGalleryImagesByKeys(rawKeys = []) {
    const keys = Array.isArray(rawKeys) ? rawKeys.filter(Boolean) : [];
    const uniqueKeys = Array.from(new Set(keys));
    const deletedKeys = new Set(uniqueKeys);
    if (!deletedKeys.size) {
      return { deletedKeys, updatedConversations: 0, removedImages: 0, scannedConversations: 0 };
    }

    const scanState = galleryCache.scanState;
    const convIdsByKey = scanState?.convIdsByKey instanceof Map ? scanState.convIdsByKey : new Map();
    const targetConvIds = new Set();
    deletedKeys.forEach((key) => {
      const ids = convIdsByKey.get(key);
      if (ids instanceof Set) {
        ids.forEach((id) => targetConvIds.add(id));
      }
    });

    if (!targetConvIds.size) {
      return { deletedKeys, updatedConversations: 0, removedImages: 0, scannedConversations: 0 };
    }

    // 说明：这里按“去重键”删图，确保重复引用在同一次删除里一并移除。
    const sp = utils.createStepProgress({ steps: ['定位会话', '删除图片', '完成'], type: 'warning' });
    sp.setStep(0);
    sp.next('删除图片');

    let downloadRoot = null;
    try {
      downloadRoot = await loadDownloadRoot();
    } catch (_) {}

    let updatedConversations = 0;
    let removedImages = 0;
    let processed = 0;
    const total = targetConvIds.size || 1;

    for (const convId of targetConvIds) {
      processed += 1;
      const conv = await getConversationById(convId, true);
      if (!conv || !Array.isArray(conv.messages)) {
        try {
          sp.updateSub(processed, total, `删除图片 (${processed}/${total})`);
        } catch (_) {}
        continue;
      }
      let convChanged = false;
      for (const msg of conv.messages) {
        if (!Array.isArray(msg.content)) continue;
        let removedInMessage = 0;
        const nextParts = [];
        for (const part of msg.content) {
          if (part?.type === 'image_url' && part.image_url) {
            const resolvedUrl = resolveImageUrlForGallery(part.image_url, downloadRoot);
            const key = buildGalleryImageKey(part.image_url, resolvedUrl);
            if (key && deletedKeys.has(key)) {
              removedInMessage += 1;
              continue;
            }
          }
          nextParts.push(part);
        }
        if (removedInMessage > 0) {
          msg.content = normalizeStoredMessageContent(nextParts);
          removedImages += removedInMessage;
          convChanged = true;
        }
      }

      if (convChanged) {
        applyConversationMessageStats(conv);
        await putConversation(conv);
        updateConversationInCache(conv);
        if (activeConversation?.id === conv.id) activeConversation = conv;
        updatedConversations += 1;
      }

      try {
        sp.updateSub(processed, total, `删除图片 (${processed}/${total})`);
      } catch (_) {}
    }

    sp.complete('完成', true);
    invalidateMetadataCache({ skipGallery: true });
    return {
      deletedKeys,
      updatedConversations,
      removedImages,
      scannedConversations: targetConvIds.size
    };
  }

  async function renderGalleryTab(container, { forceRefresh = false } = {}) {
    if (!container) return;
    if (!forceRefresh && container.dataset.rendered === 'true') {
      return;
    }
    if (container._rendering) {
      return container._rendering;
    }
    container.dataset.rendered = '';
    container.innerHTML = '';

    const renderPromise = (async () => {
      const runId = createRunId();
      container.dataset.galleryRunId = runId;
      const isGalleryActive = () => {
        const panel = container.closest('#chat-history-panel');
        return !!(panel && panel.classList.contains('visible') && container.classList.contains('active'));
      };
      const shouldCancel = () => container.dataset.galleryRunId !== runId || !isGalleryActive();
      revokeGalleryThumbUrls(container);
      container.innerHTML = '';

      if (container._galleryObserver) {
        container._galleryObserver.disconnect();
        container._galleryObserver = null;
      }
      if (container._galleryLazyObserver) {
        container._galleryLazyObserver.disconnect();
        container._galleryLazyObserver = null;
      }
      setupGalleryScrollTracking(container);

      const selectedKeys = galleryCache.selectedKeys instanceof Set ? galleryCache.selectedKeys : new Set();
      galleryCache.selectedKeys = selectedKeys;
      const domByKey = new Map();
      container._galleryDomByKey = domByKey;

      const toolbar = document.createElement('div');
      toolbar.className = 'gallery-toolbar';
      const toolbarLeft = document.createElement('div');
      toolbarLeft.className = 'gallery-toolbar-left';
      const toolbarRight = document.createElement('div');
      toolbarRight.className = 'gallery-toolbar-right';

      const selectToggleBtn = document.createElement('button');
      selectToggleBtn.className = 'gallery-toolbar-btn gallery-select-toggle';
      selectToggleBtn.textContent = '多选删除';

      const selectionCount = document.createElement('span');
      selectionCount.className = 'gallery-select-count';

      const currentThumbSize = Math.max(
        GALLERY_THUMB_SIZE_MIN,
        Math.min(GALLERY_THUMB_SIZE_MAX, Number(galleryCache.thumbSize) || GALLERY_THUMB_SIZE_DEFAULT)
      );
      galleryCache.thumbSize = currentThumbSize;
      container.style.setProperty('--gallery-thumb-size', `${currentThumbSize}px`);
      const layoutMode = galleryCache.layoutMode === 'fit' ? 'fit' : 'grid';
      galleryCache.layoutMode = layoutMode;
      container.dataset.galleryLayout = layoutMode;

      const sizeControl = document.createElement('div');
      sizeControl.className = 'gallery-size-control';
      const sizeLabel = document.createElement('span');
      sizeLabel.textContent = '缩略图';
      const sizeSlider = document.createElement('input');
      sizeSlider.className = 'gallery-size-slider';
      sizeSlider.type = 'range';
      sizeSlider.min = String(GALLERY_THUMB_SIZE_MIN);
      sizeSlider.max = String(GALLERY_THUMB_SIZE_MAX);
      sizeSlider.step = String(GALLERY_THUMB_SIZE_STEP);
      sizeSlider.value = String(currentThumbSize);
      const sizeValue = document.createElement('span');
      sizeValue.className = 'gallery-size-value';
      sizeValue.textContent = `${currentThumbSize}px`;
      sizeControl.appendChild(sizeLabel);
      sizeControl.appendChild(sizeSlider);
      sizeControl.appendChild(sizeValue);

      const layoutToggleBtn = document.createElement('button');
      layoutToggleBtn.className = 'gallery-toolbar-btn gallery-layout-toggle';

      const deleteButton = document.createElement('button');
      deleteButton.className = 'gallery-toolbar-btn gallery-delete-btn';
      deleteButton.textContent = '删除选中';

      toolbarLeft.appendChild(selectToggleBtn);
      toolbarLeft.appendChild(selectionCount);
      toolbarRight.appendChild(sizeControl);
      toolbarRight.appendChild(layoutToggleBtn);
      toolbarRight.appendChild(deleteButton);
      toolbar.appendChild(toolbarLeft);
      toolbar.appendChild(toolbarRight);
      container.appendChild(toolbar);

      const status = document.createElement('div');
      status.className = 'gallery-stream-status';
      status.textContent = '正在扫描图片…';
      container.appendChild(status);
      container._galleryStatusEl = status;

      const grid = document.createElement('div');
      grid.className = 'gallery-grid';
      const sentinel = document.createElement('div');
      sentinel.className = 'gallery-sentinel';
      sentinel.textContent = '加载更多…';
      grid.appendChild(sentinel);
      container.appendChild(grid);

      const images = galleryCache.items;
      let renderedCount = 0;
      let renderScheduled = false;
      let scanDone = false;
      let deletionInProgress = false;
      const monthGroupMap = new Map();
      container._galleryGroupMap = monthGroupMap;

      const applyThumbSize = (value) => {
        const nextSize = Math.max(GALLERY_THUMB_SIZE_MIN, Math.min(GALLERY_THUMB_SIZE_MAX, Number(value) || GALLERY_THUMB_SIZE_DEFAULT));
        if (nextSize === galleryCache.thumbSize) return;
        galleryCache.thumbSize = nextSize;
        // 仅调整显示尺寸，不触发缩略图重新生成。
        container.style.setProperty('--gallery-thumb-size', `${nextSize}px`);
        sizeValue.textContent = `${nextSize}px`;
        if (galleryCache.layoutMode === 'fit') {
          scheduleGalleryFitLayout(container, { force: true });
        }
      };

      const applyLayoutMode = (force = false) => {
        if (galleryCache.layoutMode === 'fit') {
          setupGalleryFitResizeObserver(container);
          scheduleGalleryFitLayout(container, { force });
          return;
        }
        teardownGalleryFitResizeObserver(container);
        const groups = container.querySelectorAll('.gallery-group-grid');
        groups.forEach((group) => flattenGalleryGroupGrid(group));
      };

      const updateLayoutToggle = () => {
        const mode = galleryCache.layoutMode === 'fit' ? 'fit' : 'grid';
        galleryCache.layoutMode = mode;
        container.dataset.galleryLayout = mode;
        if (mode === 'fit') {
          layoutToggleBtn.textContent = '自适应';
          layoutToggleBtn.title = '切换为方形网格';
        } else {
          layoutToggleBtn.textContent = '方形';
          layoutToggleBtn.title = '切换为自适应铺满';
        }
        applyLayoutMode(true);
      };

      sizeSlider.addEventListener('input', () => {
        applyThumbSize(sizeSlider.value);
      });
      layoutToggleBtn.addEventListener('click', () => {
        galleryCache.layoutMode = galleryCache.layoutMode === 'fit' ? 'grid' : 'fit';
        updateLayoutToggle();
      });
      updateLayoutToggle();

      const getOrCreateGalleryGroup = (record) => {
        const key = getGalleryMonthKey(record?.timestamp);
        if (!key) return null;
        let group = monthGroupMap.get(key);
        if (group) return group;
        const groupEl = document.createElement('div');
        groupEl.className = 'gallery-group';
        groupEl.dataset.monthKey = key;
        const label = document.createElement('div');
        label.className = 'gallery-group-label';
        label.textContent = formatGalleryMonthLabel(record?.timestamp);
        const groupGrid = document.createElement('div');
        groupGrid.className = 'gallery-group-grid';
        groupEl.appendChild(label);
        groupEl.appendChild(groupGrid);
        // 按月份倒序插入分组，避免流式扫描导致月份标签错位。
        let insertBefore = sentinel;
        const groups = Array.from(grid.querySelectorAll('.gallery-group'));
        for (const existing of groups) {
          const existingKey = existing.dataset.monthKey || '';
          if (existingKey && existingKey < key) {
            insertBefore = existing;
            break;
          }
        }
        grid.insertBefore(groupEl, insertBefore);
        group = { key, element: groupEl, grid: groupGrid };
        monthGroupMap.set(key, group);
        return group;
      };

      const updateSelectionCount = () => {
        const count = selectedKeys.size;
        selectionCount.textContent = `已选 ${count}`;
        deleteButton.disabled = !galleryCache.selectMode || count === 0 || deletionInProgress;
      };

      const updateSelectionStyles = () => {
        const enabled = galleryCache.selectMode;
        domByKey.forEach((item, key) => {
          if (!item?.classList) return;
          if (!enabled) {
            item.classList.remove('is-selected');
            return;
          }
          item.classList.toggle('is-selected', selectedKeys.has(key));
        });
      };

      const setSelectMode = (enabled, { clearSelection = false } = {}) => {
        galleryCache.selectMode = !!enabled;
        container.dataset.gallerySelectMode = galleryCache.selectMode ? 'true' : '';
        selectToggleBtn.textContent = galleryCache.selectMode ? '退出多选' : '多选删除';
        selectionCount.style.display = galleryCache.selectMode ? '' : 'none';
        deleteButton.style.display = galleryCache.selectMode ? '' : 'none';
        if (!galleryCache.selectMode && clearSelection) {
          selectedKeys.clear();
        }
        updateSelectionCount();
        updateSelectionStyles();
      };

      const updateGalleryDupBadge = (item, record) => {
        if (!item) return;
        const count = Math.max(1, Number(record?.dupCount) || 1);
        let badge = item._galleryDupBadge;
        if (!badge) {
          badge = document.createElement('div');
          badge.className = 'gallery-dup-badge';
          item._galleryDupBadge = badge;
          item.appendChild(badge);
        }
        if (count > 1) {
          badge.textContent = `x${count}`;
          badge.style.display = 'flex';
        } else {
          badge.textContent = '';
          badge.style.display = 'none';
        }
      };

      const flushDupBadgeUpdates = () => {
        const scanState = galleryCache.scanState;
        if (!scanState || !(scanState.pendingDupKeys instanceof Set)) return;
        if (!scanState.pendingDupKeys.size) return;
        const keys = Array.from(scanState.pendingDupKeys);
        scanState.pendingDupKeys.clear();
        keys.forEach((key) => {
          const item = domByKey.get(key);
          const record = scanState.itemByKey?.get(key);
          if (item && record) updateGalleryDupBadge(item, record);
        });
      };

      const toggleSelectionForItem = (record, item) => {
        if (!record?.dedupeKey) return;
        const key = record.dedupeKey;
        if (selectedKeys.has(key)) {
          selectedKeys.delete(key);
        } else {
          selectedKeys.add(key);
        }
        if (item?.classList) {
          item.classList.toggle('is-selected', selectedKeys.has(key));
        }
        updateSelectionCount();
      };

      const updateStatus = () => {
        if (!status) return;
        if (scanDone) {
          if (images.length) {
            status.className = 'gallery-stream-status';
            status.textContent = `已加载 ${images.length} 张图片`;
          } else {
            status.className = 'gallery-empty';
            status.textContent = '暂无可展示的图片';
          }
        } else if (images.length) {
          status.className = 'gallery-stream-status';
          status.textContent = `正在扫描图片… 已加载 ${images.length} 张`;
        } else {
          status.className = 'gallery-stream-status';
          status.textContent = '正在扫描图片…';
        }
        if (scanDone && images.length === 0) {
          grid.style.display = 'none';
        } else if (images.length > 0) {
          grid.style.display = '';
        }
      };

      const handleDeleteSelected = async () => {
        if (!selectedKeys.size || deletionInProgress) return;
        const count = selectedKeys.size;
        const confirmed = window.confirm(`确定删除已选 ${count} 张图片的所有重复项？该操作会从相关对话中移除图片引用。`);
        if (!confirmed) return;
        deletionInProgress = true;
        selectToggleBtn.disabled = true;
        deleteButton.disabled = true;
        try {
          const result = await deleteGalleryImagesByKeys(Array.from(selectedKeys));
          if (result?.removedImages > 0 && result?.deletedKeys?.size) {
            applyGalleryDeletionToCache(result.deletedKeys);
            const removedCount = removeGalleryItemsFromDom(container, result.deletedKeys);
            if (removedCount > 0) {
              // 删除已渲染节点后同步修正 renderedCount，避免后续批量追加错位
              renderedCount = Math.max(0, renderedCount - removedCount);
            }
            selectedKeys.clear();
            updateSelectionCount();
            updateSelectionStyles();
            updateStatus();
            if (galleryCache.layoutMode === 'fit') {
              scheduleGalleryFitLayout(container, { force: true });
            }
            try {
              showNotification({
                message: `已删除 ${result.removedImages} 处图片引用`,
                duration: 2200
              });
            } catch (_) {}
          } else {
            try {
              showNotification({ message: '未找到可删除的图片', type: 'warning', duration: 2000 });
            } catch (_) {}
          }
        } catch (error) {
          console.error('删除图片失败:', error);
          try {
            showNotification({ message: '删除图片失败', type: 'error', description: String(error?.message || error) });
          } catch (_) {}
        } finally {
          deletionInProgress = false;
          selectToggleBtn.disabled = false;
          updateSelectionCount();
        }
      };

      selectToggleBtn.addEventListener('click', () => {
        const next = !galleryCache.selectMode;
        setSelectMode(next, { clearSelection: !next });
      });
      deleteButton.addEventListener('click', handleDeleteSelected);
      setSelectMode(!!galleryCache.selectMode, { clearSelection: !galleryCache.selectMode });

      const placeholderSrc = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
      const ensureThumbLoaded = (img) => {
        if (!img || !img.dataset) return;
        if (img.dataset.thumbState === 'loading' || img.dataset.thumbState === 'loaded') return;
        const sourceUrl = img.dataset.src || '';
        if (!sourceUrl) return;
        if (img.dataset.thumbFallback === 'origin') {
          img.dataset.thumbState = 'loaded';
          img.dataset.thumbKind = 'origin';
          img.src = sourceUrl;
          return;
        }

        const token = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        img.dataset.thumbToken = token;
        img.dataset.thumbState = 'loading';

        enqueueGalleryThumbTask(async () => {
          if (!img.isConnected || img.dataset.thumbToken !== token) return;
          const targetSpec = getGalleryThumbTargetSpec(img);
          const thumbUrl = await generateGalleryThumbUrl(sourceUrl, targetSpec);
          if (!img.isConnected || img.dataset.thumbToken !== token) {
            if (thumbUrl && thumbUrl.startsWith('blob:')) {
              URL.revokeObjectURL(thumbUrl);
            }
            return;
          }
          if (thumbUrl) {
            const oldThumb = img.dataset.thumbUrl;
            if (oldThumb && oldThumb.startsWith('blob:')) {
              URL.revokeObjectURL(oldThumb);
            }
            img.dataset.thumbUrl = thumbUrl;
            img.dataset.thumbKind = 'thumb';
            img.src = thumbUrl;
          } else {
            // 生成缩略图失败时回退到原图（少量兜底场景）
            img.dataset.thumbFallback = 'origin';
            img.dataset.thumbKind = 'origin';
            img.src = sourceUrl;
          }
          img.dataset.thumbState = 'loaded';
        });
      };

      // 仅在接近可视区域时生成缩略图，生成后在本次会话内保留，避免反复读取原图
      const lazyObserver = null;
      container._galleryLazyObserver = null;

      const appendBatch = () => {
        const nextCount = Math.min(renderedCount + GALLERY_RENDER_BATCH_SIZE, images.length);
        if (nextCount <= renderedCount) return;
        const touchedGrids = new Set();
        for (let i = renderedCount; i < nextCount; i++) {
          const record = images[i];
          const group = getOrCreateGalleryGroup(record);
          const targetGrid = group?.grid || grid;
          if (targetGrid) touchedGrids.add(targetGrid);
          const item = document.createElement('div');
          item.className = 'gallery-item';
          if (record.messageKey) {
            item.dataset.messageKey = record.messageKey;
          }
          if (record.dedupeKey) {
            item.dataset.dedupeKey = record.dedupeKey;
            domByKey.set(record.dedupeKey, item);
          }
          setGalleryItemAspectRatio(item, record?.aspectRatio);

          const img = document.createElement('img');
          img.loading = 'lazy';
          img.decoding = 'async';
          img.dataset.src = record.url;
          img.dataset.thumbState = 'idle';
          img.addEventListener('load', () => {
            if (!img.dataset.thumbKind) return;
            const ratio = (img.naturalWidth && img.naturalHeight)
              ? (img.naturalWidth / img.naturalHeight)
              : 0;
            const nextRatio = setGalleryItemAspectRatio(item, ratio);
            if (nextRatio && record) {
              record.aspectRatio = nextRatio;
            }
            if (galleryCache.layoutMode === 'fit') {
              scheduleGalleryFitLayout(container, { targetGrid: item.closest('.gallery-group-grid') });
            }
          });
          img.src = placeholderSrc;
          ensureThumbLoaded(img);
          img.alt = record.summary || record.title || record.domain || '聊天图片';
          item.appendChild(img);

          const overlay = document.createElement('div');
          overlay.className = 'gallery-overlay';
          const overlayText = document.createElement('div');
          overlayText.className = 'gallery-overlay-text';
          overlayText.textContent = `${formatRelativeTime(new Date(record.timestamp || Date.now()))} · ${record.domain || '未知来源'}`;
          overlay.appendChild(overlayText);
          item.appendChild(overlay);

          const selectIndicator = document.createElement('div');
          selectIndicator.className = 'gallery-select-indicator';
          const selectIcon = document.createElement('i');
          selectIcon.className = 'far fa-check';
          selectIndicator.appendChild(selectIcon);
          item.appendChild(selectIndicator);

          updateGalleryDupBadge(item, record);
          if (galleryCache.selectMode && record.dedupeKey && selectedKeys.has(record.dedupeKey)) {
            item.classList.add('is-selected');
          }

          const openGalleryMessage = async () => {
            const conversation = await getConversationFromCacheOrLoad(record.conversationId);
            if (!conversation) return;
            await loadConversationIntoChat(conversation, {
              skipMessageAnimation: true,
              skipScrollToBottom: true
            });
            jumpToMessageById(record.messageId, { highlightClass: 'gallery-highlight', highlightDuration: 1600 });
          };

          const openGalleryPreview = () => {
            const preview = services?.imageHandler?.showImagePreview;
            if (typeof preview === 'function' && record?.url) {
              preview(record.url);
              return true;
            }
            return false;
          };

          item.addEventListener('click', () => {
            if (galleryCache.selectMode) {
              toggleSelectionForItem(record, item);
              return;
            }
            if (item._galleryClickTimer) {
              clearTimeout(item._galleryClickTimer);
              item._galleryClickTimer = null;
            }
            item._galleryClickTimer = setTimeout(() => {
              item._galleryClickTimer = null;
              try {
                openGalleryPreview();
              } catch (error) {
                console.error('打开图片预览失败:', error);
              }
            }, GALLERY_ITEM_DOUBLE_CLICK_DELAY_MS);
          });

          item.addEventListener('dblclick', async () => {
            if (galleryCache.selectMode) return;
            if (item._galleryClickTimer) {
              clearTimeout(item._galleryClickTimer);
              item._galleryClickTimer = null;
            }
            try {
              await openGalleryMessage();
            } catch (error) {
              console.error('打开图片所属对话失败:', error);
            }
          });

          item.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            if (galleryCache.selectMode) return;
            try {
              window.open(record.url, '_blank', 'noopener');
            } catch (_) {}
          });

          targetGrid.appendChild(item);
        }
        renderedCount = nextCount;
        if (galleryCache.layoutMode === 'fit') {
          scheduleGalleryFitLayout(container, { targetGrids: Array.from(touchedGrids) });
        }
        if (grid.style.display === 'none') {
          grid.style.display = '';
        }
        if (scanDone && renderedCount >= images.length) {
          if (container._galleryObserver) {
            container._galleryObserver.disconnect();
            container._galleryObserver = null;
          }
          if (sentinel.parentNode) {
            sentinel.remove();
          }
        }
      };

      const scheduleAppend = () => {
        if (renderScheduled) return;
        renderScheduled = true;
        requestAnimationFrame(() => {
          renderScheduled = false;
          if (shouldCancel()) return;
          appendBatch();
          flushDupBadgeUpdates();
          restoreGalleryScrollIfNeeded(container);
          if (container.scrollHeight <= container.clientHeight && renderedCount < images.length) {
            scheduleAppend();
          }
        });
      };

      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          scheduleAppend();
        }
      }, {
        root: container,
        rootMargin: getGalleryRenderRootMargin(container)
      });
      observer.observe(sentinel);
      container._galleryObserver = observer;

      updateStatus();
      scheduleAppend();

      await loadGalleryImages(forceRefresh, {
        runId,
        shouldCancel,
        onBatch: () => {
          if (shouldCancel()) return;
          updateStatus();
          scheduleAppend();
          flushDupBadgeUpdates();
        },
        onProgress: () => {
          if (shouldCancel()) return;
          updateStatus();
          flushDupBadgeUpdates();
          restoreGalleryScrollIfNeeded(container);
        }
      });

      if (shouldCancel()) return;
      scanDone = true;
      updateStatus();
      if (!images.length) {
        status.textContent = '暂无可展示的图片';
        status.className = 'gallery-empty';
        grid.style.display = 'none';
      } else {
        status.className = 'gallery-stream-status';
        status.textContent = `已加载 ${images.length} 张图片`;
        grid.style.display = '';
        appendBatch();
        restoreGalleryScrollIfNeeded(container);
      }
      container.dataset.rendered = 'true';
    })().catch((error) => {
      console.error('加载图片相册失败:', error);
      invalidateGalleryCache();
      container.innerHTML = '';
      const errorDiv = document.createElement('div');
      errorDiv.className = 'gallery-error';
      errorDiv.textContent = '加载图片失败，请稍后重试';
      container.appendChild(errorDiv);
    }).finally(() => {
      container._rendering = null;
    });

    container._rendering = renderPromise;
    return renderPromise;
  }

  /**
   * 获取数据库统计信息，优先使用缓存
   * @param {boolean} [forceUpdate=false] - 是否强制更新
   * @returns {Promise<Object>} 数据库统计信息
   */
  async function getDbStatsWithCache(forceUpdate = false) {
    const now = Date.now();
    if (forceUpdate || !cachedDbStats || (now - lastStatsUpdateTime > STATS_CACHE_DURATION)) {
      cachedDbStats = await getDatabaseStats();
      lastStatsUpdateTime = now;
    }
    return cachedDbStats;
  }
  
  /**
   * 渲染数据库统计信息面板
   * @param {Object} stats - 数据库统计数据
   * @returns {HTMLElement} 统计信息面板元素
   */
  function renderStatsPanel(stats) {
    const statsPanel = document.createElement('div');
    statsPanel.className = 'db-stats-panel';
    
    // 添加标题
    const header = document.createElement('div');
    header.className = 'db-stats-header';
    header.innerHTML = `
      <span class="db-stats-title">数据统计</span>
      <span class="db-stats-refresh" title="刷新统计数据">
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <path d="M23 4v6h-6"></path>
          <path d="M1 20v-6h6"></path>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"></path>
          <path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
        </svg>
      </span>
    `;
    
    // 点击刷新按钮刷新统计数据
    const refreshBtn = header.querySelector('.db-stats-refresh');
    refreshBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const updatedStats = await getDbStatsWithCache(true);
      
      // 查找父级面板并更新
      const parentPanel = document.getElementById('chat-history-panel');
      if (parentPanel) {
        const oldStatsPanel = parentPanel.querySelector('.db-stats-panel');
        if (oldStatsPanel) {
          const newStatsPanel = renderStatsPanel(updatedStats);
          oldStatsPanel.replaceWith(newStatsPanel);
        }
      }
    });
    
    statsPanel.appendChild(header);
    
    // 创建内容区域 - 使用卡片布局
    const statsContent = document.createElement('div');
    statsContent.className = 'db-stats-content';
    
    // 第一行卡片：存储概览
    const overviewCard = document.createElement('div');
    overviewCard.className = 'db-stats-card overview-card';
    overviewCard.innerHTML = `
      <div class="db-stats-card-header">存储概览</div>
      <div class="db-stats-metrics">
        <div class="db-stats-metric">
          <div class="db-stats-metric-value highlight">${stats.totalSizeFormatted}</div>
          <div class="db-stats-metric-label">总存储大小</div>
        </div>
        <div class="db-stats-metric">
          <div class="db-stats-metric-value">${stats.totalTextSizeFormatted}</div>
          <div class="db-stats-metric-label">文本数据</div>
        </div>
        <div class="db-stats-metric">
          <div class="db-stats-metric-value">${stats.totalImageSizeFormatted}</div>
          <div class="db-stats-metric-label">图片数据</div>
        </div>
        <div class="db-stats-metric">
          <div class="db-stats-metric-value">${stats.totalMetaSizeFormatted || '0 B'}</div>
          <div class="db-stats-metric-label">元数据</div>
        </div>
      </div>
    `;

    const metaCard = document.createElement('div');
    metaCard.className = 'db-stats-card meta-card';
    const metaItems = Array.isArray(stats.metaTopItems) ? stats.metaTopItems : [];
    const metaListHtml = metaItems.length
      ? `<ul class="db-stats-meta-list">${metaItems.map(item => (
          `<li><span class="meta-key">${item.key}</span><span class="meta-value">${item.sizeFormatted}</span></li>`
        )).join('')}</ul>`
      : '<div class="db-stats-empty"><div class="db-stats-empty-text">暂无元数据统计</div></div>';
    metaCard.innerHTML = `
      <div class="db-stats-card-header">元数据构成 Top 5</div>
      ${metaListHtml}
    `;
    
    // 第二行卡片：聊天统计
    const chatStatsCard = document.createElement('div');
    chatStatsCard.className = 'db-stats-card chat-stats-card';
    chatStatsCard.innerHTML = `
      <div class="db-stats-card-header">聊天统计</div>
      <div class="db-stats-metrics">
        <div class="db-stats-metric">
          <div class="db-stats-metric-value">${stats.conversationsCount}</div>
          <div class="db-stats-metric-label">会话总数</div>
        </div>
        <div class="db-stats-metric">
          <div class="db-stats-metric-value">${stats.messagesCount}</div>
          <div class="db-stats-metric-label">消息总数</div>
        </div>
        <div class="db-stats-metric">
          <div class="db-stats-metric-value">${stats.imageMessagesCount}</div>
          <div class="db-stats-metric-label">图片消息</div>
        </div>
      </div>
    `;

    // 新增卡片：均值统计
    const avgStatsCard = document.createElement('div');
    avgStatsCard.className = 'db-stats-card avg-stats-card';
    avgStatsCard.innerHTML = `
      <div class="db-stats-card-header">均值统计</div>
      <div class="db-stats-metrics">
        <div class="db-stats-metric">
          <div class="db-stats-metric-value">${(stats.avgMessagesPerConversation || 0).toFixed(2)}</div>
          <div class="db-stats-metric-label">平均每会话消息数</div>
        </div>
        <div class="db-stats-metric">
          <div class="db-stats-metric-value">${stats.avgTextBytesPerMessageFormatted || '0 B'}</div>
          <div class="db-stats-metric-label">平均每条文本大小</div>
        </div>
      </div>
    `;
    
    // 第三行卡片：时间跨度
    const timeCard = document.createElement('div');
    timeCard.className = 'db-stats-card time-card';
    
    let timeContent = '<div class="db-stats-card-header">时间跨度</div>';
    
    if (stats.oldestMessageDate && stats.newestMessageDate) {
      const formatDate = (date) => {
        return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      };
      
      timeContent += `
        <div class="db-stats-metrics timeline">
          <div class="db-stats-metric">
            <div class="db-stats-metric-value">${formatDate(stats.oldestMessageDate)}</div>
            <div class="db-stats-metric-label">最早消息</div>
          </div>
          <div class="db-stats-metric time-span">
            <div class="db-stats-metric-value">${stats.timeSpanDays} 天</div>
            <div class="db-stats-metric-label">总时长</div>
          </div>
          <div class="db-stats-metric">
            <div class="db-stats-metric-value">${formatDate(stats.newestMessageDate)}</div>
            <div class="db-stats-metric-label">最新消息</div>
          </div>
        </div>
      `;
    } else {
      timeContent += `
        <div class="db-stats-empty">
          <div class="db-stats-empty-text">暂无消息数据</div>
        </div>
      `;
    }
    
    timeCard.innerHTML = timeContent;
    
    // 新增卡片：Top 域名（最多 10 个）
    const domainsCard = document.createElement('div');
    domainsCard.className = 'db-stats-card domains-card';
    const topDomains = Array.isArray(stats.topDomains) ? stats.topDomains : [];
    const domainsListHtml = topDomains.length
      ? `<ul class="domain-list">${topDomains.map(d => `<li><span class="domain">${d.domain}</span><span class="count">${d.count}</span></li>`).join('')}</ul>`
      : '<div class="db-stats-empty"><div class="db-stats-empty-text">暂无域名统计</div></div>';
    domainsCard.innerHTML = `
      <div class="db-stats-card-header">来源域名 Top 10</div>
      ${domainsListHtml}
    `;

    // 第四行卡片：技术信息
    const techCard = document.createElement('div');
    techCard.className = 'db-stats-card tech-card';
    techCard.innerHTML = `
      <div class="db-stats-card-header">技术指标</div>
      <div class="db-stats-metrics tech-metrics">
        <div class="db-stats-metric">
          <div class="db-stats-metric-value">${stats.largestMessageSizeFormatted}</div>
          <div class="db-stats-metric-label">最大消息</div>
        </div>
        <div class="db-stats-metric">
          <div class="db-stats-metric-value">${loadedConversations.size}</div>
          <div class="db-stats-metric-label">内存缓存数</div>
        </div>
      </div>
    `;
    
    // 添加所有卡片到内容区域
    statsContent.appendChild(overviewCard);
    statsContent.appendChild(metaCard);
    statsContent.appendChild(chatStatsCard);
    statsContent.appendChild(avgStatsCard);
    statsContent.appendChild(domainsCard);
    statsContent.appendChild(timeCard);
    statsContent.appendChild(techCard);
    
    // 添加饼图显示数据比例
    if ((stats.totalTextSize + (stats.totalMetaSize || 0) > 0) || stats.totalImageSize > 0) {
      const chartContainer = document.createElement('div');
      chartContainer.className = 'db-stats-chart-container';
      
      const textAndMetaSize = (stats.totalTextSize || 0) + (stats.totalMetaSize || 0);
      const totalSize = textAndMetaSize + (stats.totalImageSize || 0);
      const textPercentage = totalSize > 0 ? Math.round((textAndMetaSize / totalSize) * 100) : 0;
      const imagePercentage = 100 - textPercentage;
      
      chartContainer.innerHTML = `
        <div class="db-stats-chart">
          <svg viewBox="0 0 36 36" class="circular-chart">
            <path class="circle-bg" d="M18 2.0845
              a 15.9155 15.9155 0 0 1 0 31.831
              a 15.9155 15.9155 0 0 1 0 -31.831"></path>
            <path class="circle image-data" stroke-dasharray="${imagePercentage}, 100" d="M18 2.0845
              a 15.9155 15.9155 0 0 1 0 31.831
              a 15.9155 15.9155 0 0 1 0 -31.831"></path>
            <path class="circle text-data" stroke-dasharray="${textPercentage}, 100" stroke-dashoffset="-${imagePercentage}" d="M18 2.0845
              a 15.9155 15.9155 0 0 1 0 31.831
              a 15.9155 15.9155 0 0 1 0 -31.831"></path>
            <text x="18" y="20.35" class="percentage">${textPercentage}%</text>
          </svg>
          <div class="chart-legend">
            <div class="legend-item">
              <span class="legend-color text-color"></span>
              <span class="legend-label">文本 (${textPercentage}%)</span>
            </div>
            <div class="legend-item">
              <span class="legend-color image-color"></span>
              <span class="legend-label">图片 (${imagePercentage}%)</span>
            </div>
          </div>
        </div>
      `;
      
      statsContent.appendChild(chartContainer);
    }
    
    statsPanel.appendChild(statsContent);
    
    // 添加更新时间戳
    const footer = document.createElement('div');
    footer.className = 'db-stats-footer';
    footer.innerHTML = `
      <div class="db-stats-update-time">
        最后更新: ${new Date(lastStatsUpdateTime).toLocaleTimeString()}
      </div>
    `;
    statsPanel.appendChild(footer);
    
    return statsPanel;
  }

  function renderStatsEntry(targetContent, trendSection) {
    const entry = document.createElement('div');
    entry.className = 'db-stats-entry';

    const title = document.createElement('div');
    title.className = 'db-stats-entry-title';
    title.textContent = '数据统计';

    const desc = document.createElement('div');
    desc.className = 'db-stats-entry-desc';
    desc.textContent = '点击“开始统计”后将扫描全部会话，可能需要一些时间。';

    const actions = document.createElement('div');
    actions.className = 'db-stats-entry-actions';

    const startBtn = document.createElement('button');
    startBtn.className = 'db-stats-entry-button';
    startBtn.textContent = '开始统计';
    actions.appendChild(startBtn);

    const status = document.createElement('div');
    status.className = 'db-stats-entry-status';

    entry.appendChild(title);
    entry.appendChild(desc);
    entry.appendChild(actions);
    entry.appendChild(status);

    const runStats = async () => {
      if (entry.dataset.loading === 'true') return;
      entry.dataset.loading = 'true';
      startBtn.disabled = true;
      startBtn.textContent = '统计中...';
      status.textContent = '';
      status.classList.remove('is-error');

      try {
        const statsData = await getDbStatsWithCache();
        const statsPanel = renderStatsPanel(statsData);
        entry.remove();
        if (trendSection && trendSection.parentNode === targetContent) {
          targetContent.insertBefore(statsPanel, trendSection);
        } else {
          targetContent.appendChild(statsPanel);
        }
      } catch (error) {
        console.error('加载统计数据失败:', error);
        delete entry.dataset.loading;
        startBtn.disabled = false;
        startBtn.textContent = '开始统计';
        status.textContent = '统计失败，请稍后重试';
        status.classList.add('is-error');
      }
    };

    startBtn.addEventListener('click', runStats);

    return entry;
  }

  function renderStatsTrendSection() {
    const trendSection = document.createElement('div');
    trendSection.className = 'backup-section stats-trend-section';

    const trendTitle = document.createElement('div');
    trendTitle.className = 'backup-panel-subtitle';
    trendTitle.textContent = '数据趋势';
    trendSection.appendChild(trendTitle);

    const trendControls = document.createElement('div');
    trendControls.className = 'backup-trend-controls';

    const trendMetricControl = document.createElement('div');
    trendMetricControl.className = 'backup-trend-control';
    const trendMetricLabel = document.createElement('label');
    trendMetricLabel.textContent = '指标';
    const trendMetricSelect = document.createElement('select');
    TREND_METRIC_OPTIONS.forEach((item) => {
      const opt = document.createElement('option');
      opt.value = item.value;
      opt.textContent = item.label;
      trendMetricSelect.appendChild(opt);
    });
    trendMetricSelect.value = 'totalBytes';
    trendMetricControl.appendChild(trendMetricLabel);
    trendMetricControl.appendChild(trendMetricSelect);

    const trendGranularityControl = document.createElement('div');
    trendGranularityControl.className = 'backup-trend-control';
    const trendGranularityLabel = document.createElement('label');
    trendGranularityLabel.textContent = '维度';
    const trendGranularitySelect = document.createElement('select');
    TREND_GRANULARITY_OPTIONS.forEach((item) => {
      const opt = document.createElement('option');
      opt.value = item.value;
      opt.textContent = item.label;
      trendGranularitySelect.appendChild(opt);
    });
    trendGranularitySelect.value = 'month';
    trendGranularityControl.appendChild(trendGranularityLabel);
    trendGranularityControl.appendChild(trendGranularitySelect);

    const trendRefreshBtn = document.createElement('button');
    trendRefreshBtn.className = 'backup-button backup-trend-action-button';
    trendRefreshBtn.textContent = '生成图表';

    trendControls.appendChild(trendMetricControl);
    trendControls.appendChild(trendGranularityControl);
    trendControls.appendChild(trendRefreshBtn);
    trendSection.appendChild(trendControls);

    const trendChart = document.createElement('div');
    trendChart.className = 'backup-trend';
    trendChart.innerHTML = '<div class="backup-trend-empty">点击“生成图表”以查看趋势</div>';
    trendSection.appendChild(trendChart);

    const trendHint = document.createElement('div');
    trendHint.className = 'backup-panel-hint';
    trendHint.textContent = '按对话最后更新时间汇总；总数据量=文本+图片+元数据。首次生成会扫描全部会话，切换维度无需重新扫描。';
    trendSection.appendChild(trendHint);

    const renderTrendIfReady = () => {
      if (!trendStatsCache.data) return;
      renderTrendChart(trendChart, trendStatsCache.data, {
        metric: trendMetricSelect.value,
        granularity: trendGranularitySelect.value
      });
    };

    trendMetricSelect.addEventListener('change', () => {
      renderTrendIfReady();
    });

    trendGranularitySelect.addEventListener('change', () => {
      renderTrendIfReady();
    });

    trendRefreshBtn.addEventListener('click', async () => {
      const originalText = trendRefreshBtn.textContent;
      trendRefreshBtn.disabled = true;
      trendRefreshBtn.textContent = '生成中...';
      try {
        const data = await getTrendStatsCached(true);
        renderTrendChart(trendChart, data, {
          metric: trendMetricSelect.value,
          granularity: trendGranularitySelect.value
        });
        showNotification?.({
          message: '趋势图已更新',
          type: 'success',
          duration: 2200
        });
      } catch (error) {
        console.error('生成趋势图失败:', error);
        showNotification?.({
          message: '生成趋势图失败',
          description: String(error?.message || error),
          type: 'error',
          duration: 3200
        });
      } finally {
        trendRefreshBtn.disabled = false;
        trendRefreshBtn.textContent = originalText;
      }
    });

    const trendCacheFresh = trendStatsCache.data && (Date.now() - trendStatsCache.time <= TREND_STATS_TTL);
    if (trendCacheFresh) {
      renderTrendIfReady();
    }

    return trendSection;
  }

  function ensureEscSettingsMenuMounted(panel) {
    if (!panel) return null;
    const settingsContent = panel.querySelector('.history-tab-content[data-tab="settings"]');
    if (!settingsContent) return null;

    let escSettingsMenu = settingsContent.querySelector('#esc-settings-menu');
    if (!escSettingsMenu) {
      escSettingsMenu = dom.escSettingsMenu || document.createElement('div');
      escSettingsMenu.id = 'esc-settings-menu';
      escSettingsMenu.classList.add('esc-settings-menu');
    }
    if (escSettingsMenu.parentElement !== settingsContent) {
      settingsContent.appendChild(escSettingsMenu);
    }
    dom.escSettingsMenu = escSettingsMenu;
    return escSettingsMenu;
  }

  function ensureSettingsTabInitialized(panel) {
    const settingsContent = panel?.querySelector('.history-tab-content[data-tab="settings"]');
    if (!settingsContent) return;

    const escSettingsMenu = ensureEscSettingsMenuMounted(panel);
    if (!escSettingsMenu) return;
    if (settingsContent.dataset.lazyReady === '1' && escSettingsMenu.childElementCount > 0) return;

    // 延迟到用户真正切换到“偏好设置”时再渲染，避免 Esc 首次打开时同步构建大量设置控件。
    services.settingsManager?.refreshSettingsContainers?.();
    settingsContent.dataset.lazyReady = escSettingsMenu.childElementCount > 0 ? '1' : '0';
  }

  function ensureStatsTabInitialized(panel) {
    const statsContent = panel?.querySelector('.history-tab-content[data-tab="stats"]');
    if (!statsContent) return;
    if (statsContent.dataset.lazyReady === '1') return;

    // 兼容旧 DOM：若内容已存在则直接标记，避免重复插入。
    if (statsContent.childElementCount > 0) {
      statsContent.dataset.lazyReady = '1';
      return;
    }

    const statsTrendSection = renderStatsTrendSection();
    const statsEntry = renderStatsEntry(statsContent, statsTrendSection);
    statsContent.appendChild(statsEntry);
    statsContent.appendChild(statsTrendSection);
    statsContent.dataset.lazyReady = '1';
  }

  function ensureBackupTabInitialized(panel) {
    const backupSettingsContent = panel?.querySelector('.history-tab-content[data-tab="backup-settings"]');
    if (!backupSettingsContent) return;
    if (backupSettingsContent.dataset.lazyReady === '1') return;

    // 兼容旧 DOM：若内容已存在则直接标记，避免重复插入。
    if (backupSettingsContent.childElementCount > 0) {
      backupSettingsContent.dataset.lazyReady = '1';
      return;
    }

    backupSettingsContent.appendChild(renderBackupSettingsPanelDownloadsOnly());
    backupSettingsContent.dataset.lazyReady = '1';
  }

  function getSkillViewerRefs() {
    return skillViewerState.refs;
  }

  function renderSkillViewerEmptyState(container, title, description) {
    if (!container) return;
    container.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'skill-detail-empty';

    const emptyTitle = document.createElement('div');
    emptyTitle.className = 'skill-detail-empty-title';
    emptyTitle.textContent = title;
    empty.appendChild(emptyTitle);

    if (description) {
      const emptyDesc = document.createElement('div');
      emptyDesc.className = 'skill-detail-empty-desc';
      emptyDesc.textContent = description;
      empty.appendChild(emptyDesc);
    }

    container.appendChild(empty);
  }

  async function executeSkillViewerAction(payload) {
    if (typeof utils?.executeSkillRegistryAction !== 'function') {
      throw new Error('当前界面没有可用的 skill 注册表入口。');
    }
    const result = await utils.executeSkillRegistryAction(payload);
    if (result?.success === true) {
      const output = { ...result };
      delete output.success;
      return output;
    }
    throw new Error((typeof result?.error === 'string' && result.error.trim())
      ? result.error.trim()
      : 'skill 操作失败。');
  }

  async function executeSkillViewerFileAction(action, payload) {
    if (typeof utils?.executeVirtualFileAction !== 'function') {
      throw new Error('当前界面没有可用的虚拟文件入口。');
    }
    const result = await utils.executeVirtualFileAction(action, payload);
    if (result?.ok === true) {
      return result;
    }
    throw new Error((typeof result?.error?.message === 'string' && result.error.message.trim())
      ? result.error.message.trim()
      : 'skill 文件操作失败。');
  }

  function buildSkillDetailFromViewerParts(summary, instructionFile, fileIndex) {
    if (!summary) return null;
    const instructionPath = String(summary?.instruction?.path || 'SKILL.md').trim() || 'SKILL.md';
    const files = Array.isArray(fileIndex?.files) ? fileIndex.files : [];
    const instruction = instructionFile?.file || {};
    return {
      ...summary,
      instruction: {
        path: instructionPath,
        content: typeof instruction.content === 'string' ? instruction.content : '',
        content_read: instruction.content_read || null,
        ...(typeof instruction.numbered_content === 'string'
          ? { numbered_content: instruction.numbered_content }
          : {})
      },
      files: {
        total_count: Number.isFinite(Number(fileIndex?.total_files)) ? Number(fileIndex.total_files) : files.length,
        returned_file_count: Number.isFinite(Number(fileIndex?.returned_file_count)) ? Number(fileIndex.returned_file_count) : files.length,
        files
      }
    };
  }

  function getFilteredSkillSummaries() {
    const keyword = String(skillViewerState.filterText || '').trim().toLowerCase();
    if (!keyword) return [...skillViewerState.summaries];
    return skillViewerState.summaries.filter((skill) => {
      const displayName = String(skill?.interface?.display_name || '').toLowerCase();
      const shortDescription = String(skill?.interface?.short_description || '').toLowerCase();
      const description = String(skill?.description || '').toLowerCase();
      const name = String(skill?.name || '').toLowerCase();
      return (
        name.includes(keyword)
        || displayName.includes(keyword)
        || shortDescription.includes(keyword)
        || description.includes(keyword)
      );
    });
  }

  function renderSkillSummaryList() {
    const { listContainer, countText } = getSkillViewerRefs();
    if (!listContainer) return;

    const filteredSummaries = getFilteredSkillSummaries();
    if (countText) {
      countText.textContent = `${filteredSummaries.length} / ${skillViewerState.summaries.length}`;
    }

    listContainer.innerHTML = '';
    if (filteredSummaries.length <= 0) {
      const empty = document.createElement('div');
      empty.className = 'skill-list-empty';
      empty.textContent = skillViewerState.summaries.length > 0
        ? '当前筛选条件下没有匹配的技能'
        : '当前还没有已注册的技能';
      listContainer.appendChild(empty);
      return;
    }

    filteredSummaries.forEach((skill) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'skill-list-item';
      if (skill.name === skillViewerState.selectedName) {
        item.classList.add('active');
      }
      item.dataset.skillName = skill.name;

      const titleRow = document.createElement('div');
      titleRow.className = 'skill-list-item-title-row';

      const title = document.createElement('div');
      title.className = 'skill-list-item-title';
      title.textContent = skill.interface?.display_name || skill.name;
      titleRow.appendChild(title);

      const status = document.createElement('span');
      if (skill.builtin === true) {
        status.className = 'skill-status-pill is-builtin';
        status.textContent = '内置';
      } else {
        status.className = `skill-status-pill${skill.enabled === true ? ' is-enabled' : ' is-disabled'}`;
        status.textContent = skill.enabled === true ? '启用' : '停用';
      }
      titleRow.appendChild(status);

      const meta = document.createElement('div');
      meta.className = 'skill-list-item-meta';
      meta.textContent = `${skill.name} · r${skill.revision || 1}`;

      const desc = document.createElement('div');
      desc.className = 'skill-list-item-desc';
      desc.textContent = skill.interface?.short_description || skill.description || '';

      item.appendChild(titleRow);
      item.appendChild(meta);
      item.appendChild(desc);
      item.addEventListener('click', async () => {
        skillViewerState.selectedName = skill.name;
        renderSkillSummaryList();
        await loadSkillDetailIntoViewer(skill.name, { forceReload: false, resetSourceView: false });
      });
      listContainer.appendChild(item);
    });
  }

  function createSkillMetaRow(label, value) {
    const row = document.createElement('div');
    row.className = 'skill-meta-row';

    const key = document.createElement('div');
    key.className = 'skill-meta-key';
    key.textContent = label;
    row.appendChild(key);

    const val = document.createElement('div');
    val.className = 'skill-meta-value';
    val.textContent = value || '—';
    row.appendChild(val);
    return row;
  }

  function createSkillChipList(title, values) {
    const section = document.createElement('div');
    section.className = 'skill-section';

    const heading = document.createElement('div');
    heading.className = 'skill-section-title';
    heading.textContent = title;
    section.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'skill-chip-list';

    (Array.isArray(values) ? values : []).forEach((value) => {
      const chip = document.createElement('code');
      chip.className = 'skill-chip';
      chip.textContent = String(value || '');
      list.appendChild(chip);
    });

    section.appendChild(list);
    return section;
  }

  function createSkillTextSection(title, text) {
    const section = document.createElement('div');
    section.className = 'skill-section';

    const heading = document.createElement('div');
    heading.className = 'skill-section-title';
    heading.textContent = title;
    section.appendChild(heading);

    const content = document.createElement('pre');
    content.className = 'skill-text-block';
    content.textContent = text || '—';
    section.appendChild(content);
    return section;
  }

  async function loadSkillSourceIntoViewer(skillName) {
    const { detailContainer } = getSkillViewerRefs();
    if (!detailContainer) return;
    try {
      let sourcePayload = skillViewerState.sourceByName.get(skillName) || null;
      if (!sourcePayload) {
        const fileIndex = await executeSkillViewerFileAction('list_files', {
          target: { kind: 'skill', name: skillName }
        });
        const indexFiles = Array.isArray(fileIndex?.files) ? fileIndex.files : [];
        const files = [];
        for (const file of indexFiles) {
          const fileResult = await executeSkillViewerFileAction('read_file', {
            target: { kind: 'skill', name: skillName },
            file_path: file.path
          });
          files.push({
            ...file,
            ...(fileResult?.file || {})
          });
        }
        sourcePayload = {
          target: { kind: 'skill', name: skillName },
          total_files: fileIndex?.total_files || files.length,
          returned_file_count: fileIndex?.returned_file_count || files.length,
          files
        };
        if (sourcePayload) {
          skillViewerState.sourceByName.set(skillName, sourcePayload);
        }
      }

      const existing = detailContainer.querySelector('.skill-source-section');
      if (existing) {
        existing.remove();
      }

      const sourceSection = document.createElement('div');
      sourceSection.className = 'skill-section skill-source-section';

      const heading = document.createElement('div');
      heading.className = 'skill-section-title';
      heading.textContent = '文件包';
      sourceSection.appendChild(heading);

      const sourceFiles = Array.isArray(sourcePayload?.files) ? sourcePayload.files : [];
      if (sourceFiles.length <= 0) {
        const empty = document.createElement('div');
        empty.className = 'skill-detail-empty-desc';
        empty.textContent = '这个技能当前没有可显示的文件。';
        sourceSection.appendChild(empty);
      } else {
        sourceFiles.forEach((file) => {
          const fileSection = document.createElement('div');
          fileSection.className = 'skill-source-file';

          const fileHeader = document.createElement('div');
          fileHeader.className = 'skill-source-file-header';

          const filePath = document.createElement('code');
          filePath.className = 'skill-source-file-path';
          filePath.textContent = file.path || '';
          fileHeader.appendChild(filePath);

          const kindTag = document.createElement('span');
          kindTag.className = 'skill-source-file-entry';
          kindTag.textContent = file.kind || 'file';
          fileHeader.appendChild(kindTag);

          if (file.is_instruction === true) {
            const instructionTag = document.createElement('span');
            instructionTag.className = 'skill-source-file-entry';
            instructionTag.textContent = 'SKILL';
            fileHeader.appendChild(instructionTag);
          }

          if (file.is_runtime_entry === true) {
            const entryTag = document.createElement('span');
            entryTag.className = 'skill-source-file-entry';
            entryTag.textContent = 'runtime-entry';
            fileHeader.appendChild(entryTag);
          }

          fileSection.appendChild(fileHeader);

          const sourceBlock = document.createElement('pre');
          sourceBlock.className = 'skill-code-block';
          const code = document.createElement('code');
          code.textContent = file.content || '';
          sourceBlock.appendChild(code);
          fileSection.appendChild(sourceBlock);
          sourceSection.appendChild(fileSection);

          if (window.hljs?.highlightElement) {
            try {
              window.hljs.highlightElement(code);
            } catch (_) {}
          }
        });
      }

      detailContainer.appendChild(sourceSection);
    } catch (error) {
      console.error('读取技能源码失败:', error);
      showNotification?.({
        message: '读取技能源码失败',
        description: String(error?.message || error),
        type: 'error',
        duration: 3200
      });
    }
  }

  function renderSkillDetail(skillDetail) {
    const { detailContainer } = getSkillViewerRefs();
    if (!detailContainer) return;

    if (!skillDetail) {
      renderSkillViewerEmptyState(detailContainer, '没有可显示的详情', '请选择左侧列表中的一个技能。');
      return;
    }

    detailContainer.innerHTML = '';

    const hero = document.createElement('div');
    hero.className = 'skill-detail-hero';

    const heroText = document.createElement('div');
    heroText.className = 'skill-detail-hero-text';

    const title = document.createElement('h3');
    title.className = 'skill-detail-title';
    title.textContent = skillDetail.interface?.display_name || skillDetail.name;
    heroText.appendChild(title);

    const subtitle = document.createElement('div');
    subtitle.className = 'skill-detail-subtitle';
    subtitle.textContent = skillDetail.interface?.short_description || skillDetail.description || '';
    heroText.appendChild(subtitle);

    hero.appendChild(heroText);

    const heroActions = document.createElement('div');
    heroActions.className = 'skill-detail-actions';

    const sourceBtn = document.createElement('button');
    sourceBtn.type = 'button';
    sourceBtn.className = 'skill-action-button';
    sourceBtn.textContent = skillViewerState.sourceByName.has(skillDetail.name) ? '重新查看文件包' : '加载文件包';
    sourceBtn.addEventListener('click', () => {
      void loadSkillSourceIntoViewer(skillDetail.name);
    });
    heroActions.appendChild(sourceBtn);

    const remountBtn = document.createElement('button');
    remountBtn.type = 'button';
    remountBtn.className = 'skill-action-button';
    remountBtn.textContent = '在当前页重挂载';
    remountBtn.disabled = state.isStandalone === true || skillDetail.builtin === true;
    remountBtn.title = skillDetail.builtin === true
      ? '内置指导 skill 不会挂载到网页 runtime，它只提供创建和修改技能的方法与模板。'
      : (state.isStandalone === true
          ? '独立聊天页面没有绑定宿主页，无法执行当前页重挂载。'
          : '把当前选中的技能重新挂载到绑定网页。');
    remountBtn.addEventListener('click', async () => {
      try {
        remountBtn.disabled = true;
        const result = await executeSkillViewerAction({
          action: 'mount_on_current_page',
          skill_name: skillDetail.name
        });
        const activeSkills = Array.isArray(result?.active_skills)
          ? result.active_skills.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
          : (Array.isArray(result?.value?.active_skills)
            ? result.value.active_skills.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
            : []);
        if (result?.ok !== true || result?.mounted_on_current_page !== true) {
          throw new Error((typeof result?.error?.message === 'string' && result.error.message.trim())
            ? result.error.message.trim()
            : '当前页 skill 挂载失败。');
        }
        showNotification?.({
          message: '当前页 skill 已挂载',
          description: activeSkills.length > 0
            ? `当前实际已挂载：${activeSkills.join(', ')}`
            : '当前页没有任何已挂载的 page runtime skill。',
          type: 'success',
          duration: 2400
        });
      } catch (error) {
        console.error('当前页 skill 挂载失败:', error);
        showNotification?.({
          message: '当前页 skill 挂载失败',
          description: String(error?.message || error),
          type: 'error',
          duration: 3200
        });
      } finally {
        remountBtn.disabled = state.isStandalone === true || skillDetail.builtin === true;
      }
    });
    heroActions.appendChild(remountBtn);

    hero.appendChild(heroActions);
    detailContainer.appendChild(hero);

    const metaGrid = document.createElement('div');
    metaGrid.className = 'skill-meta-grid';
    metaGrid.appendChild(createSkillMetaRow('类型', skillDetail.builtin === true ? '内置指导 skill' : '页面 runtime skill'));
    metaGrid.appendChild(createSkillMetaRow('稳定 Key', skillDetail.name));
    metaGrid.appendChild(createSkillMetaRow('状态', skillDetail.builtin === true ? '只读 / 始终可用' : (skillDetail.enabled === true ? '启用' : '停用')));
    metaGrid.appendChild(createSkillMetaRow('Revision', `r${skillDetail.revision || 1}`));
    metaGrid.appendChild(createSkillMetaRow('创建时间', skillDetail.created_at || ''));
    metaGrid.appendChild(createSkillMetaRow('更新时间', skillDetail.updated_at || ''));
    metaGrid.appendChild(createSkillMetaRow('默认提示', skillDetail.interface?.default_prompt || ''));
    metaGrid.appendChild(createSkillMetaRow('SKILL.md', skillDetail.instruction?.path || ''));
    metaGrid.appendChild(createSkillMetaRow('Runtime 入口', skillDetail.runtime?.entry_path || ''));
    metaGrid.appendChild(createSkillMetaRow('文件总数', String(skillDetail.files?.total_count || 0)));
    detailContainer.appendChild(metaGrid);

    detailContainer.appendChild(createSkillChipList('@match', skillDetail.match));
    detailContainer.appendChild(createSkillChipList(
      '文件树',
      Array.isArray(skillDetail.files?.files)
        ? skillDetail.files.files.map((file) => {
            const tags = [];
            if (file.kind) tags.push(file.kind);
            if (file.is_instruction === true) tags.push('SKILL');
            if (file.is_runtime_entry === true) tags.push('runtime-entry');
            return tags.length > 0 ? `${file.path} [${tags.join(', ')}]` : file.path;
          })
        : []
    ));
    detailContainer.appendChild(createSkillTextSection('SKILL.md', skillDetail.instruction?.content || ''));
  }

  async function loadSkillDetailIntoViewer(skillName, options = {}) {
    if (!skillName) return;
    const seq = ++skillViewerState.requestSeq;
    try {
      let detail = skillViewerState.detailByName.get(skillName) || null;
      if (!detail || options?.forceReload === true) {
        const summary = skillViewerState.summaries.find((item) => item?.name === skillName) || null;
        if (!summary) {
          throw new Error(`skill ${skillName} 不存在。`);
        }
        const fileIndex = await executeSkillViewerFileAction('list_files', {
          target: { kind: 'skill', name: skillName }
        });
        const instructionFile = await executeSkillViewerFileAction('read_file', {
          target: { kind: 'skill', name: skillName },
          file_path: summary?.instruction?.path || 'SKILL.md'
        });
        detail = buildSkillDetailFromViewerParts(summary, instructionFile, fileIndex);
        if (detail) {
          skillViewerState.detailByName.set(skillName, detail);
        }
      }
      if (seq !== skillViewerState.requestSeq) return;
      if (options?.resetSourceView === true) {
        skillViewerState.sourceByName.delete(skillName);
      }
      renderSkillDetail(detail);
    } catch (error) {
      if (seq !== skillViewerState.requestSeq) return;
      console.error('读取技能详情失败:', error);
      renderSkillViewerEmptyState(
        getSkillViewerRefs().detailContainer,
        '读取技能详情失败',
        String(error?.message || error)
      );
    }
  }

  async function refreshSkillViewerPanel(panel, options = {}) {
    if (skillViewerState.refreshPromise) {
      await skillViewerState.refreshPromise;
      return;
    }

    skillViewerState.refreshPromise = (async () => {
      const { refreshButton, detailContainer } = getSkillViewerRefs();
      const originalText = refreshButton?.textContent || '刷新';
      if (refreshButton) {
        refreshButton.disabled = true;
        refreshButton.textContent = '刷新中...';
      }

      try {
        const result = await executeSkillViewerAction({
          action: 'list',
          include_all_sites: true
        });
        skillViewerState.summaries = Array.isArray(result?.skills) ? result.skills : [];

        const filtered = getFilteredSkillSummaries();
        if (!filtered.some((item) => item.name === skillViewerState.selectedName)) {
          skillViewerState.selectedName = filtered[0]?.name || '';
        }

        renderSkillSummaryList();

        if (skillViewerState.selectedName) {
          await loadSkillDetailIntoViewer(skillViewerState.selectedName, {
            forceReload: options?.forceReloadDetail === true,
            resetSourceView: options?.forceReloadDetail === true
          });
        } else {
          renderSkillViewerEmptyState(
            detailContainer,
            '还没有技能',
            '当前注册表里还没有任何已创建的技能。'
          );
        }
      } catch (error) {
        console.error('刷新技能查看器失败:', error);
        renderSkillSummaryList();
        renderSkillViewerEmptyState(
          detailContainer,
          '读取技能列表失败',
          String(error?.message || error)
        );
      } finally {
        if (refreshButton) {
          refreshButton.disabled = false;
          refreshButton.textContent = originalText;
        }
      }
    })();

    try {
      await skillViewerState.refreshPromise;
    } finally {
      skillViewerState.refreshPromise = null;
    }
  }

  function renderSkillViewerPanel() {
    const container = document.createElement('div');
    container.className = 'skill-viewer';

    const toolbar = document.createElement('div');
    toolbar.className = 'skill-viewer-toolbar';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'skill-viewer-title-wrap';
    const title = document.createElement('div');
    title.className = 'skill-viewer-title';
    title.textContent = 'Skill 管理';
    titleWrap.appendChild(title);
    const subtitle = document.createElement('div');
    subtitle.className = 'skill-viewer-subtitle';
    subtitle.textContent = '查看当前扩展里已注册的浏览器 Skill，点列表查看详情；源码按需加载。';
    titleWrap.appendChild(subtitle);
    toolbar.appendChild(titleWrap);

    const toolbarActions = document.createElement('div');
    toolbarActions.className = 'skill-viewer-toolbar-actions';

    const count = document.createElement('span');
    count.className = 'skill-viewer-count';
    count.textContent = '0 / 0';
    toolbarActions.appendChild(count);

    const refreshButton = document.createElement('button');
    refreshButton.type = 'button';
    refreshButton.className = 'skill-action-button';
    refreshButton.textContent = '刷新';
    refreshButton.addEventListener('click', () => {
      void refreshSkillViewerPanel(null, { forceReloadDetail: true });
    });
    toolbarActions.appendChild(refreshButton);

    toolbar.appendChild(toolbarActions);
    container.appendChild(toolbar);

    const body = document.createElement('div');
    body.className = 'skill-viewer-body';

    const listPane = document.createElement('div');
    listPane.className = 'skill-viewer-pane skill-viewer-pane-list';

    const searchWrap = document.createElement('div');
    searchWrap.className = 'skill-search-wrap';
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'skill-search-input';
    searchInput.placeholder = '筛选技能名称或说明';
    searchInput.addEventListener('input', () => {
      skillViewerState.filterText = searchInput.value || '';
      renderSkillSummaryList();
      const filtered = getFilteredSkillSummaries();
      if (filtered.length > 0 && !filtered.some((item) => item.name === skillViewerState.selectedName)) {
        skillViewerState.selectedName = filtered[0].name;
        renderSkillSummaryList();
        void loadSkillDetailIntoViewer(filtered[0].name, { forceReload: false, resetSourceView: false });
      } else if (filtered.length <= 0) {
        renderSkillViewerEmptyState(
          getSkillViewerRefs().detailContainer,
          '没有匹配的技能',
          '调整左侧筛选条件，或刷新列表后重试。'
        );
      }
    });
    searchWrap.appendChild(searchInput);
    listPane.appendChild(searchWrap);

    const listContainer = document.createElement('div');
    listContainer.className = 'skill-list';
    listPane.appendChild(listContainer);
    body.appendChild(listPane);

    const detailPane = document.createElement('div');
    detailPane.className = 'skill-viewer-pane skill-viewer-pane-detail';
    body.appendChild(detailPane);

    container.appendChild(body);

    skillViewerState.refs = {
      searchInput,
      countText: count,
      listContainer,
      detailContainer: detailPane,
      refreshButton
    };

    renderSkillSummaryList();
    renderSkillViewerEmptyState(detailPane, '选择一个技能', '左侧列表展示当前已注册的技能。点击某条记录即可查看详细说明。');
    return container;
  }

  async function ensureSkillsTabInitialized(panel) {
    const skillContent = panel?.querySelector('.history-tab-content[data-tab="skills"]');
    if (!skillContent) return;

    if (skillContent.dataset.lazyReady !== '1') {
      skillContent.innerHTML = '';
      skillContent.appendChild(renderSkillViewerPanel());
      skillContent.dataset.lazyReady = '1';
      skillViewerState.initialized = true;
    }

    await refreshSkillViewerPanel(panel, { forceReloadDetail: true });
  }

  /**
   * 确保 Esc 聊天历史面板中存在“Skill 管理”标签与内容容器。
   * 这样即便当前面板是在旧代码路径下创建的，也能在后续打开时补齐新 tab。
   */
  function ensureSkillsTabDom(panel) {
    const tabBar = panel?.querySelector('.history-tab-bar');
    const tabContents = panel?.querySelector('.history-tab-contents');
    if (!tabBar || !tabContents) return;

    const moveNodeAfter = (parent, node, anchor) => {
      if (!parent || !node) return;
      if (!anchor || anchor.parentElement !== parent) {
        if (node.parentElement !== parent || parent.lastElementChild !== node) {
          parent.appendChild(node);
        }
        return;
      }
      const nextSibling = anchor.nextElementSibling;
      if (nextSibling === node) return;
      if (!nextSibling) {
        parent.appendChild(node);
        return;
      }
      parent.insertBefore(node, nextSibling);
    };

    let skillsTab = tabBar.querySelector('.history-tab[data-tab="skills"]');
    if (!skillsTab) {
      skillsTab = document.createElement('div');
      skillsTab.className = 'history-tab';
      skillsTab.textContent = 'Skill 管理';
      skillsTab.dataset.tab = 'skills';
    }
    skillsTab.textContent = 'Skill 管理';
    moveNodeAfter(
      tabBar,
      skillsTab,
      tabBar.querySelector('.history-tab[data-tab="prompt-settings"]')
        || tabBar.querySelector('.history-tab[data-tab="history"]')
    );

    let skillContent = tabContents.querySelector('.history-tab-content[data-tab="skills"]');
    if (!skillContent) {
      skillContent = document.createElement('div');
      skillContent.className = 'history-tab-content';
      skillContent.dataset.tab = 'skills';
      skillContent.dataset.lazyReady = '0';
    }
    moveNodeAfter(
      tabContents,
      skillContent,
      tabContents.querySelector('.history-tab-content[data-tab="prompt-settings"]')
        || tabContents.querySelector('.history-tab-content[data-tab="history"]')
    );
  }

  /**
   * 显示聊天记录面板
   */
  async function activateChatHistoryTab(panel, tabName) {
    if (!panel) return;

    const tabBar = panel.querySelector('.history-tab-bar');
    const tabContents = panel.querySelector('.history-tab-contents');
    if (!tabBar || !tabContents) return;

    const safeTabName = (typeof tabName === 'string' && tabName.trim()) ? tabName.trim() : 'history';
    const targetTabEl = tabBar.querySelector(`.history-tab[data-tab="${safeTabName}"]`)
      || tabBar.querySelector('.history-tab[data-tab="history"]')
      || tabBar.querySelector('.history-tab');
    if (!targetTabEl) return;

    const prevActiveTabName = tabBar.querySelector('.history-tab.active')?.dataset?.tab || '';
    const resolvedTabName = targetTabEl.dataset.tab || 'history';
    const targetContent = tabContents.querySelector(`.history-tab-content[data-tab="${resolvedTabName}"]`);

    tabBar.querySelectorAll('.history-tab').forEach(tab => tab.classList.remove('active'));
    tabContents.querySelectorAll('.history-tab-content').forEach(content => content.classList.remove('active'));

    targetTabEl.classList.add('active');
    if (targetContent) {
      targetContent.classList.add('active');
    }

    if (prevActiveTabName === 'gallery' && resolvedTabName !== 'gallery') {
      markGalleryInactive(panel);
    }

    if (resolvedTabName === 'history') {
      const filterInput = panel.querySelector('.filter-container input[type="text"]');
      requestAnimationFrame(() => filterInput?.focus());
      return;
    }

    if (resolvedTabName === 'gallery') {
      markGalleryActive(panel, targetContent);
      if (targetContent) await renderGalleryTab(targetContent);
      return;
    }

    if (resolvedTabName === 'settings') {
      ensureSettingsTabInitialized(panel);
      return;
    }

    if (resolvedTabName === 'stats') {
      ensureStatsTabInitialized(panel);
      return;
    }

    if (resolvedTabName === 'skills') {
      await ensureSkillsTabInitialized(panel);
      return;
    }

    if (resolvedTabName === 'backup-settings') {
      ensureBackupTabInitialized(panel);
      return;
    }

    if (resolvedTabName === 'api-settings') {
      try {
        // 说明：保持与旧逻辑一致——进入 API 设置时刷新一次配置并重新渲染卡片。
        await services.apiManager?.loadAPIConfigs?.();
        services.apiManager?.renderAPICards?.();
        services.apiManager?.renderFavoriteApis?.();
      } catch (e) {
        console.error('切换到 API 设置标签失败:', e);
      }
      return;
    }

    if (resolvedTabName === 'prompt-settings') {
      try {
        // 说明：提示词面板内部本身带有 storage 监听；这里刷新一次，确保跨标签页修改后立即可见。
        await services.promptSettingsManager?.loadPromptSettings?.();
      } catch (e) {
        console.error('切换到提示词设置标签失败:', e);
      }
      return;
    }
  }

  function getActiveChatHistoryTabName() {
    const panel = document.getElementById('chat-history-panel');
    return panel?.querySelector('.history-tab.active')?.dataset?.tab || null;
  }

  function getLastClosedChatHistoryTabName() {
    return lastClosedTabName;
  }

  function getLastClosedChatHistoryAt() {
    return lastClosedAt;
  }


  const CHAT_HISTORY_PANEL_PIN_DATASET_KEY = 'outsideClickPinned';
  const CHAT_HISTORY_PANEL_PIN_ATTRIBUTE = 'data-outside-click-pinned';
  const CHAT_HISTORY_PANEL_PIN_BUTTON_CLASS = 'chat-history-panel-pin-btn';
  const CHAT_HISTORY_PANEL_PIN_BUTTON_HTML = '<i class="far fa-thumbtack"></i>';
  const CHAT_HISTORY_PANEL_LAYOUT_STORAGE_KEY = 'cerebr.chat_history_panel_layout_v2';
  const CHAT_HISTORY_PANEL_LEGACY_FULLSCREEN_LAYOUT_STORAGE_KEY = 'cerebr.chat_history_panel_fullscreen_layout_v1';

  function isChatHistoryPanelPinned() {
    const panel = document.getElementById('chat-history-panel');
    return !!(panel && panel.dataset[CHAT_HISTORY_PANEL_PIN_DATASET_KEY] === '1');
  }

  function applyChatHistoryPanelPinState(panel, pinButton, pinned) {
    if (!panel || !pinButton) return;
    panel.dataset[CHAT_HISTORY_PANEL_PIN_DATASET_KEY] = pinned ? '1' : '0';
    pinButton.classList.toggle('is-active', pinned);
    pinButton.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    pinButton.title = pinned
      ? 'Esc 菜单已固定：点击外部不会关闭'
      : '固定 Esc 菜单：点击外部时不自动关闭';
    pinButton.setAttribute('aria-label', pinButton.title);
  }

  function ensureChatHistoryPanelPinButton(panel) {
    if (!panel) return null;
    const headerActions = panel.querySelector('.panel-header .header-actions');
    if (!headerActions) return null;

    let pinButton = headerActions.querySelector(`.${CHAT_HISTORY_PANEL_PIN_BUTTON_CLASS}`);
    if (!pinButton) {
      pinButton = document.createElement('button');
      pinButton.type = 'button';
      pinButton.className = CHAT_HISTORY_PANEL_PIN_BUTTON_CLASS;
      pinButton.innerHTML = CHAT_HISTORY_PANEL_PIN_BUTTON_HTML;
      pinButton.addEventListener('click', (event) => {
        event.stopPropagation();
        const nextPinned = panel.dataset[CHAT_HISTORY_PANEL_PIN_DATASET_KEY] !== '1';
        applyChatHistoryPanelPinState(panel, pinButton, nextPinned);
      });
      headerActions.appendChild(pinButton);
    }

    const firstAction = headerActions.firstElementChild;
    if (firstAction && firstAction !== pinButton) {
      headerActions.insertBefore(pinButton, firstAction);
    }

    const pinned = panel.dataset[CHAT_HISTORY_PANEL_PIN_DATASET_KEY] === '1';
    applyChatHistoryPanelPinState(panel, pinButton, pinned);
    return pinButton;
  }

  // Esc 面板在拖动/缩放时使用的一组约束常量。
  const CHAT_HISTORY_PANEL_DRAG_MARGIN_PX = 8;
  const CHAT_HISTORY_PANEL_RESIZE_MARGIN_PX = 8;
  const CHAT_HISTORY_PANEL_MIN_WIDTH_PX = 480;
  const CHAT_HISTORY_PANEL_MIN_HEIGHT_PX = 360;

  function isChatHistoryPanelFullscreenLayout() {
    return !!(state?.isFullscreen || document.documentElement.classList.contains('fullscreen-mode'));
  }

  function getChatHistoryPanelLayoutMode() {
    return isChatHistoryPanelFullscreenLayout()
      ? CHAT_HISTORY_PANEL_LAYOUT_MODE_FULLSCREEN
      : CHAT_HISTORY_PANEL_LAYOUT_MODE_SIDEBAR;
  }

  function getChatHistoryPanelDocumentZoomFactor() {
    const root = document.documentElement;
    if (!root) return 1;
    const inlineZoom = Number.parseFloat(root.style.zoom || '');
    if (Number.isFinite(inlineZoom) && inlineZoom > 0) return inlineZoom;
    const computedZoom = Number.parseFloat(window.getComputedStyle(root).zoom || '');
    if (Number.isFinite(computedZoom) && computedZoom > 0) return computedZoom;
    return 1;
  }

  function getChatHistoryPanelHostEmbedScale() {
    if (state?.isStandalone || document.documentElement.classList.contains('standalone-mode')) {
      return 1;
    }
    const syncedScale = Number(state?.hostEmbedScale);
    if (Number.isFinite(syncedScale) && syncedScale > 0) {
      return syncedScale;
    }
    const configuredScaleFactor = Number(settingsManager?.getSetting?.('scaleFactor'));
    const dpr = Number(window.devicePixelRatio);
    if (Number.isFinite(configuredScaleFactor) && configuredScaleFactor > 0 && Number.isFinite(dpr) && dpr > 0) {
      return configuredScaleFactor / dpr;
    }
    return 1;
  }

  function getChatHistoryPanelInteractionZoomFactor() {
    return resolveChatHistoryPanelInteractionScale({
      documentZoomFactor: getChatHistoryPanelDocumentZoomFactor(),
      hostEmbedScale: getChatHistoryPanelHostEmbedScale()
    });
  }

  function toChatHistoryPanelLayoutPixels(value, zoomFactor = getChatHistoryPanelInteractionZoomFactor()) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) return numeric;
    return numeric / zoomFactor;
  }

  // 读取 Esc 面板布局快照；优先读取新版分模式存储，并兼容旧版 fullscreen-only 数据。
  function readChatHistoryPanelLayoutSnapshot() {
    try {
      const rawValue = window?.localStorage?.getItem(CHAT_HISTORY_PANEL_LAYOUT_STORAGE_KEY);
      if (rawValue) {
        return normalizeChatHistoryPanelStoredLayout(JSON.parse(rawValue));
      }
    } catch (_) {}
    try {
      const legacyRawValue = window?.localStorage?.getItem(CHAT_HISTORY_PANEL_LEGACY_FULLSCREEN_LAYOUT_STORAGE_KEY);
      if (legacyRawValue) {
        return normalizeChatHistoryPanelStoredLayout(JSON.parse(legacyRawValue));
      }
    } catch (_) {}
    return null;
  }

  // 持久化当前 Esc 面板布局到 localStorage。
  // fullscreen 模式保存位置与尺寸；侧栏模式只保存尺寸，打开时仍保持经典居中。
  function persistChatHistoryPanelLayout(panel) {
    if (!panel) return;
    try {
      const rect = panel.getBoundingClientRect();
      if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return;

      const layoutMode = getChatHistoryPanelLayoutMode();
      const isFullscreenLayout = layoutMode === CHAT_HISTORY_PANEL_LAYOUT_MODE_FULLSCREEN;
      const dragPositioned = panel.dataset.dragPositioned === '1';
      const sizeCustomized = panel.dataset.sizeCustomized === '1';
      const fallbackLeft = Number.isFinite(rect.left) ? rect.left : null;
      const fallbackTop = Number.isFinite(rect.top) ? rect.top : null;
      const styleLeft = Number.parseFloat(panel.style.left);
      const styleTop = Number.parseFloat(panel.style.top);
      const left = dragPositioned
        ? (Number.isFinite(styleLeft) ? styleLeft : fallbackLeft)
        : fallbackLeft;
      const top = dragPositioned
        ? (Number.isFinite(styleTop) ? styleTop : fallbackTop)
        : fallbackTop;
      const width = Number.parseFloat(panel.style.width) || panel.offsetWidth || rect.width;
      const height = Number.parseFloat(panel.style.height) || panel.offsetHeight || rect.height;

      const payload = buildChatHistoryPanelStoredLayout({
        existingLayout: readChatHistoryPanelLayoutSnapshot(),
        mode: layoutMode,
        entry: {
          width: Math.round(width),
          height: Math.round(height),
          left: isFullscreenLayout && Number.isFinite(left) ? Math.round(left) : null,
          top: isFullscreenLayout && Number.isFinite(top) ? Math.round(top) : null,
          dragPositioned: isFullscreenLayout ? dragPositioned : false,
          sizeCustomized,
          updatedAt: Date.now()
        }
      });
      window.localStorage.setItem(CHAT_HISTORY_PANEL_LAYOUT_STORAGE_KEY, JSON.stringify(payload));
    } catch (_) {}
  }

  // 打开 Esc 面板或切换布局模式时恢复当前模式对应的保存结果。
  function restoreChatHistoryPanelLayout(panel) {
    if (!panel) return;
    const savedLayout = readChatHistoryPanelLayoutSnapshot();
    if (!savedLayout) {
      resetChatHistoryPanelCustomSize(panel);
      resetChatHistoryPanelCenterPosition(panel);
      panel.dataset.layoutMode = getChatHistoryPanelLayoutMode();
      return;
    }

    const layoutMode = getChatHistoryPanelLayoutMode();
    const saved = readChatHistoryPanelLayoutEntry(savedLayout, layoutMode);
    if (!saved) {
      resetChatHistoryPanelCustomSize(panel);
      resetChatHistoryPanelCenterPosition(panel);
      panel.dataset.layoutMode = layoutMode;
      return;
    }

    const hasCustomSize = saved.sizeCustomized === true
      && Number.isFinite(Number(saved.width))
      && Number.isFinite(Number(saved.height));
    if (hasCustomSize) {
      panel.style.width = `${Math.round(Number(saved.width))}px`;
      panel.style.height = `${Math.round(Number(saved.height))}px`;
      panel.dataset.sizeCustomized = '1';
    } else {
      resetChatHistoryPanelCustomSize(panel);
    }

    const hasCustomPosition = layoutMode === CHAT_HISTORY_PANEL_LAYOUT_MODE_FULLSCREEN
      && saved.dragPositioned === true
      && Number.isFinite(Number(saved.left))
      && Number.isFinite(Number(saved.top));
    if (hasCustomPosition) {
      panel.style.left = `${Math.round(Number(saved.left))}px`;
      panel.style.top = `${Math.round(Number(saved.top))}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.margin = '0';
      panel.dataset.dragPositioned = '1';
    } else {
      resetChatHistoryPanelCenterPosition(panel);
    }

    panel.dataset.layoutMode = layoutMode;
    clampChatHistoryPanelSize(panel);
    clampChatHistoryPanelPosition(panel);
  }

  function resetChatHistoryPanelCenterPosition(panel) {
    if (!panel) return;
    panel.dataset.dragPositioned = '0';
    panel.style.left = '';
    panel.style.top = '';
    panel.style.right = '';
    panel.style.bottom = '';
    panel.style.margin = '';
  }

  function resetChatHistoryPanelCustomSize(panel) {
    if (!panel) return;
    panel.dataset.sizeCustomized = '0';
    panel.style.width = '';
    panel.style.height = '';
  }

  function clampChatHistoryPanelPosition(panel, nextLeft = null, nextTop = null) {
    if (!panel || panel.dataset.dragPositioned !== '1') return;
    const rect = panel.getBoundingClientRect();
    if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return;

    const minLeft = CHAT_HISTORY_PANEL_DRAG_MARGIN_PX;
    const minTop = CHAT_HISTORY_PANEL_DRAG_MARGIN_PX;
    const maxLeft = Math.max(minLeft, window.innerWidth - rect.width - CHAT_HISTORY_PANEL_DRAG_MARGIN_PX);
    const maxTop = Math.max(minTop, window.innerHeight - rect.height - CHAT_HISTORY_PANEL_DRAG_MARGIN_PX);
    const rawLeft = Number.isFinite(nextLeft) ? Number(nextLeft) : Number.parseFloat(panel.style.left);
    const rawTop = Number.isFinite(nextTop) ? Number(nextTop) : Number.parseFloat(panel.style.top);
    if (!Number.isFinite(rawLeft) || !Number.isFinite(rawTop)) return;

    const clampedLeft = Math.min(Math.max(rawLeft, minLeft), maxLeft);
    const clampedTop = Math.min(Math.max(rawTop, minTop), maxTop);
    panel.style.left = `${Math.round(clampedLeft)}px`;
    panel.style.top = `${Math.round(clampedTop)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.margin = '0';
  }

  function clampChatHistoryPanelSize(panel, nextWidth = null, nextHeight = null) {
    if (!panel) return;
    const hasCustomSize = panel.dataset.sizeCustomized === '1';
    const hasInputSize = Number.isFinite(nextWidth) || Number.isFinite(nextHeight);
    if (!hasCustomSize && !hasInputSize) return;

    const rect = panel.getBoundingClientRect();
    if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return;

    const isFullscreenLayout = isChatHistoryPanelFullscreenLayout();
    const reservedBottomSpace = isFullscreenLayout
      ? CHAT_HISTORY_PANEL_RESIZE_MARGIN_PX
      : 60 + CHAT_HISTORY_PANEL_RESIZE_MARGIN_PX;
    const maxWidth = Math.max(
      CHAT_HISTORY_PANEL_MIN_WIDTH_PX,
      window.innerWidth - CHAT_HISTORY_PANEL_RESIZE_MARGIN_PX * 2
    );
    const maxHeight = Math.max(
      CHAT_HISTORY_PANEL_MIN_HEIGHT_PX,
      window.innerHeight - CHAT_HISTORY_PANEL_RESIZE_MARGIN_PX - reservedBottomSpace
    );

    const rawWidth = Number.isFinite(nextWidth) ? Number(nextWidth) : rect.width;
    const rawHeight = Number.isFinite(nextHeight) ? Number(nextHeight) : rect.height;
    if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight)) return;

    const clampedWidth = Math.min(Math.max(rawWidth, CHAT_HISTORY_PANEL_MIN_WIDTH_PX), maxWidth);
    const clampedHeight = Math.min(Math.max(rawHeight, CHAT_HISTORY_PANEL_MIN_HEIGHT_PX), maxHeight);

    panel.style.width = `${Math.round(clampedWidth)}px`;
    panel.style.height = `${Math.round(clampedHeight)}px`;
  }

  function syncChatHistoryPanelLayoutMode(panel) {
    if (!panel) return;
    panel.dataset.layoutMode = getChatHistoryPanelLayoutMode();
    if (isChatHistoryPanelFullscreenLayout()) {
      clampChatHistoryPanelPosition(panel);
      return;
    }
    // 侧栏模式下保持默认居中（允许改尺寸，但不允许拖动位移）。
    if (typeof panel._cancelDragMove === 'function') {
      panel._cancelDragMove();
    }
    resetChatHistoryPanelCenterPosition(panel);
  }

  function setupChatHistoryPanelDrag(panel, header) {
    if (!panel || !header || header.dataset.dragReady === '1') return;
    header.dataset.dragReady = '1';

    const isDragIgnoredTarget = (target) => {
      if (!(target instanceof Element)) return false;
      return !!target.closest('button, input, textarea, select, option, a, [role="button"], .header-actions, .switch-container');
    };

    let dragSession = null;

    const removeDragListeners = () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerEnd);
      document.removeEventListener('pointercancel', handlePointerEnd);
      window.removeEventListener('blur', handlePointerEnd);
    };

    const clearDraggingState = () => {
      removeDragListeners();
      dragSession = null;
      panel.classList.remove('chat-history-panel-dragging');
      document.body.classList.remove('chat-history-panel-dragging');
    };

    const handlePointerMove = (event) => {
      if (!dragSession || event.pointerId !== dragSession.pointerId) return;
      const deltaX = toChatHistoryPanelLayoutPixels(
        event.clientX - dragSession.startClientX,
        dragSession.zoomFactor
      );
      const deltaY = toChatHistoryPanelLayoutPixels(
        event.clientY - dragSession.startClientY,
        dragSession.zoomFactor
      );
      const nextLeft = dragSession.startLeft + deltaX;
      const nextTop = dragSession.startTop + deltaY;
      clampChatHistoryPanelPosition(panel, nextLeft, nextTop);
      event.preventDefault();
    };

    const handlePointerEnd = (event) => {
      if (!dragSession) return;
      if (event?.pointerId != null && event.pointerId !== dragSession.pointerId) return;
      persistChatHistoryPanelLayout(panel);
      clearDraggingState();
    };

    header.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (isDragIgnoredTarget(event.target)) return;
      if (!isChatHistoryPanelFullscreenLayout()) return;

      // 仅在全屏模式允许拖动位移：把当前布局位置固化为 left/top 后再拖拽。
      const rect = panel.getBoundingClientRect();
      panel.style.left = `${Math.round(rect.left)}px`;
      panel.style.top = `${Math.round(rect.top)}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.margin = '0';
      panel.dataset.dragPositioned = '1';
      const zoomFactor = getChatHistoryPanelInteractionZoomFactor();

      dragSession = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startLeft: Number.parseFloat(panel.style.left) || rect.left,
        startTop: Number.parseFloat(panel.style.top) || rect.top,
        zoomFactor
      };
      panel.classList.add('chat-history-panel-dragging');
      document.body.classList.add('chat-history-panel-dragging');

      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerEnd);
      document.addEventListener('pointercancel', handlePointerEnd);
      window.addEventListener('blur', handlePointerEnd);
      event.preventDefault();
    });

    // 面板关闭/ESC 强制关闭时，允许外部直接调用以清理拖拽会话。
    panel._cancelDragMove = clearDraggingState;
  }

  function setupChatHistoryPanelResize(panel) {
    if (!panel || panel.dataset.resizeReady === '1') return;
    panel.dataset.resizeReady = '1';

    let resizeHandle = panel.querySelector('.chat-history-panel-resize-handle');
    if (!resizeHandle) {
      resizeHandle = document.createElement('button');
      resizeHandle.type = 'button';
      resizeHandle.className = 'chat-history-panel-resize-handle';
      resizeHandle.title = '拖动调整窗口大小';
      resizeHandle.setAttribute('aria-label', '拖动调整窗口大小');
      panel.appendChild(resizeHandle);
    }

    let resizeSession = null;

    const removeResizeListeners = () => {
      document.removeEventListener('pointermove', handleResizePointerMove);
      document.removeEventListener('pointerup', handleResizePointerEnd);
      document.removeEventListener('pointercancel', handleResizePointerEnd);
      window.removeEventListener('blur', handleResizePointerEnd);
    };

    const clearResizingState = () => {
      removeResizeListeners();
      resizeSession = null;
      panel.classList.remove('chat-history-panel-resizing');
      document.body.classList.remove('chat-history-panel-resizing');
    };

    const handleResizePointerMove = (event) => {
      if (!resizeSession || event.pointerId !== resizeSession.pointerId) return;
      const deltaX = toChatHistoryPanelLayoutPixels(
        event.clientX - resizeSession.startClientX,
        resizeSession.zoomFactor
      );
      const deltaY = toChatHistoryPanelLayoutPixels(
        event.clientY - resizeSession.startClientY,
        resizeSession.zoomFactor
      );
      const nextWidth = resizeSession.startWidth + deltaX;
      const nextHeight = resizeSession.startHeight + deltaY;
      clampChatHistoryPanelSize(panel, nextWidth, nextHeight);
      clampChatHistoryPanelPosition(panel);
      panel.dataset.sizeCustomized = '1';
      event.preventDefault();
    };

    const handleResizePointerEnd = (event) => {
      if (!resizeSession) return;
      if (event?.pointerId != null && event.pointerId !== resizeSession.pointerId) return;
      persistChatHistoryPanelLayout(panel);
      clearResizingState();
    };

    resizeHandle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const rect = panel.getBoundingClientRect();
      const zoomFactor = getChatHistoryPanelInteractionZoomFactor();
      resizeSession = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startWidth: Number.parseFloat(panel.style.width) || panel.offsetWidth || rect.width,
        startHeight: Number.parseFloat(panel.style.height) || panel.offsetHeight || rect.height,
        zoomFactor
      };
      panel.classList.add('chat-history-panel-resizing');
      document.body.classList.add('chat-history-panel-resizing');

      document.addEventListener('pointermove', handleResizePointerMove);
      document.addEventListener('pointerup', handleResizePointerEnd);
      document.addEventListener('pointercancel', handleResizePointerEnd);
      window.addEventListener('blur', handleResizePointerEnd);
      event.preventDefault();
    });

    // 面板关闭/ESC 强制关闭时，允许外部直接调用以清理缩放会话。
    panel._cancelResizeMove = clearResizingState;

    if (!panel._layoutSyncObserver) {
      const root = document.documentElement;
      const observer = new MutationObserver(() => {
        if (!panel.classList.contains('visible')) return;
        const nextLayoutMode = getChatHistoryPanelLayoutMode();
        const previousLayoutMode = panel.dataset.layoutMode || '';
        if (nextLayoutMode !== previousLayoutMode) {
          restoreChatHistoryPanelLayout(panel);
        }
        syncChatHistoryPanelLayoutMode(panel);
        clampChatHistoryPanelSize(panel);
      });
      observer.observe(root, { attributes: true, attributeFilter: ['class'] });
      panel._layoutSyncObserver = observer;
    }

    if (!panel._resizeViewportListenerBound) {
      panel._resizeViewportListenerBound = true;
      window.addEventListener('resize', () => {
        if (!panel.classList.contains('visible')) return;
        clampChatHistoryPanelSize(panel);
        syncChatHistoryPanelLayoutMode(panel);
        persistChatHistoryPanelLayout(panel);
      });
    }
  }

  async function showChatHistoryPanel(initialTab = 'history') {
    ensurePanelStylesInjected();
    let panel = document.getElementById('chat-history-panel');
    let filterInput; // 在外部声明 filterInput 以便在函数末尾访问
    const ensureSearchSyntaxHelp = (container) => {
      if (!container || container.querySelector('.search-syntax-btn')) return;
      const syntaxButton = document.createElement('button');
      syntaxButton.type = 'button';
      syntaxButton.className = 'search-syntax-btn';
      syntaxButton.textContent = '?';
      syntaxButton.title = '搜索语法说明';
      syntaxButton.setAttribute('aria-label', '搜索语法说明');

      const syntaxPopover = document.createElement('div');
      syntaxPopover.className = 'search-syntax-popover';
      syntaxPopover.dataset.visible = '0';
      syntaxPopover.innerHTML = `
        <div class="search-syntax-title">搜索语法</div>
        <ul>
          <li>空格：AND（同时包含）</li>
          <li>!关键词：NOT（排除）</li>
          <li>"短语"：完整短语匹配</li>
          <li>url:xxx：按 URL 筛选</li>
          <li>count:>10：按消息条数筛选</li>
          <li>date:&lt;5d / date:&lt;1m：最近 5 天/1 个月（d/w/m/y）</li>
          <li>date:&gt;20250402：晚于指定日期</li>
          <li>scope:message：仅检索消息内容（默认会话）</li>
        </ul>
      `;

      let isVisible = false;
      let hideTimer = null;
      const setVisible = (visible) => {
        if (isVisible === visible) return;
        isVisible = visible;
        syntaxPopover.dataset.visible = visible ? '1' : '0';
        if (visible) {
          document.addEventListener('keydown', handleDocKeydown);
        } else {
          document.removeEventListener('keydown', handleDocKeydown);
        }
      };

      const handleDocKeydown = (event) => {
        if (event.key === 'Escape') setVisible(false);
      };

      const scheduleHide = () => {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          setVisible(false);
        }, 120);
      };

      const cancelHide = () => {
        if (!hideTimer) return;
        clearTimeout(hideTimer);
        hideTimer = null;
      };

      syntaxButton.addEventListener('mouseenter', () => {
        cancelHide();
        setVisible(true);
      });
      syntaxButton.addEventListener('mouseleave', scheduleHide);
      syntaxButton.addEventListener('focus', () => {
        cancelHide();
        setVisible(true);
      });
      syntaxButton.addEventListener('blur', () => {
        scheduleHide();
      });

      syntaxPopover.addEventListener('mouseenter', () => {
        cancelHide();
        setVisible(true);
      });
      syntaxPopover.addEventListener('mouseleave', scheduleHide);

      container.appendChild(syntaxButton);
      container.appendChild(syntaxPopover);
    };

    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'chat-history-panel';

      // 默认不启用“树状”视图：
      // - 需求背景：打开聊天记录窗口时保持平铺列表，避免首次加载就进行树状排序与额外预热。
      // - 一致性：关闭树状模式用 data-branch-view-mode="" 表示，便于与用户手动切换状态一致。
      panel.dataset.branchViewMode = '';
      panel.dataset[CHAT_HISTORY_PANEL_PIN_DATASET_KEY] = '0';

      // 添加标题栏
      const header = document.createElement('div');
      header.className = 'panel-header';

      const title = document.createElement('span');
      title.textContent = '聊天记录';
      title.className = 'panel-title';

      // 创建按钮容器
      const headerActions = document.createElement('div');
      headerActions.className = 'header-actions';

      const refreshButton = document.createElement('button');
      refreshButton.title = '刷新';
      refreshButton.setAttribute('aria-label', '刷新');
      refreshButton.innerHTML = '<i class="far fa-redo"></i>';
      refreshButton.addEventListener('click', refreshChatHistory);

      const closeBtn = document.createElement('button');
      closeBtn.title = '关闭';
      closeBtn.setAttribute('aria-label', '关闭');
      closeBtn.innerHTML = '<i class="far fa-times"></i>';
      closeBtn.addEventListener('click', () => { closeChatHistoryPanel(); });

      headerActions.appendChild(refreshButton);
      headerActions.appendChild(closeBtn);

      header.appendChild(title);
      header.appendChild(headerActions);
      panel.appendChild(header);
      ensureChatHistoryPanelPinButton(panel);
      setupChatHistoryPanelDrag(panel, header);
      setupChatHistoryPanelResize(panel);

      // 创建标签切换栏
      const tabBar = document.createElement('div');
      tabBar.className = 'history-tab-bar';
      
      const historyTab = document.createElement('div');
      historyTab.className = 'history-tab active';
      historyTab.textContent = '聊天记录';
      historyTab.dataset.tab = 'history';

      const promptTab = document.createElement('div');
      promptTab.className = 'history-tab';
      promptTab.textContent = '提示词设置';
      promptTab.dataset.tab = 'prompt-settings';

      const skillsTab = document.createElement('div');
      skillsTab.className = 'history-tab';
      skillsTab.textContent = 'Skill 管理';
      skillsTab.dataset.tab = 'skills';

      const apiTab = document.createElement('div');
      apiTab.className = 'history-tab';
      apiTab.textContent = 'API 设置';
      apiTab.dataset.tab = 'api-settings';
      
      const settingsTab = document.createElement('div');
      settingsTab.className = 'history-tab';
      settingsTab.textContent = '偏好设置';
      settingsTab.dataset.tab = 'settings';

      const galleryTab = document.createElement('div');
      galleryTab.className = 'history-tab';
      galleryTab.textContent = '图片相册';
      galleryTab.dataset.tab = 'gallery';
      
      const statsTab = document.createElement('div');
      statsTab.className = 'history-tab';
      statsTab.textContent = '数据统计';
      statsTab.dataset.tab = 'stats';

      const backupTab = document.createElement('div');
      backupTab.className = 'history-tab';
      backupTab.textContent = '备份与恢复';
      backupTab.dataset.tab = 'backup-settings';
      
      tabBar.appendChild(historyTab);
      tabBar.appendChild(promptTab);
      tabBar.appendChild(skillsTab);
      tabBar.appendChild(apiTab);
      tabBar.appendChild(settingsTab);
      tabBar.appendChild(galleryTab);
      tabBar.appendChild(statsTab);
      tabBar.appendChild(backupTab);
      panel.appendChild(tabBar);
      
      // 创建标签内容区域
      const tabContents = document.createElement('div');
      tabContents.className = 'history-tab-contents';
      
      // 聊天记录标签内容
      const historyContent = document.createElement('div');
      historyContent.className = 'history-tab-content active';
      historyContent.dataset.tab = 'history';
      
      // 域名筛选输入框
      const filterContainer = document.createElement('div');
      filterContainer.className = 'filter-container';
      filterInput = document.createElement('input');
      filterInput.type = 'text';
      filterInput.placeholder = '搜索（URL+消息）：空格=AND，!否定，url:xxx，count:>10，date:<5d';
      
      // 改为输入防抖实时搜索，且输入法构词期间不触发
      let filterDebounceTimer = null;
      let isComposingFilter = false;
      const triggerSearch = () => loadConversationHistories(panel, filterInput.value);
      const onFilterInput = () => {
        if (isComposingFilter) return;
        // 若输入值与当前已加载筛选一致，则无需重复触发（例如输入法 compositionend 后紧跟的 input 事件）
        if (panel.dataset.currentFilter === filterInput.value) return;
        if (filterDebounceTimer) clearTimeout(filterDebounceTimer);
        filterDebounceTimer = setTimeout(triggerSearch, HISTORY_SEARCH_DEBOUNCE_MS);
      };
      filterInput.addEventListener('input', onFilterInput);
      filterInput.addEventListener('compositionstart', () => { isComposingFilter = true; });
      filterInput.addEventListener('compositionend', () => {
        isComposingFilter = false;
        if (filterDebounceTimer) clearTimeout(filterDebounceTimer);
        triggerSearch();
      });
      // Enter：立即触发一次搜索，适合“输入完成后快速确认”场景
      filterInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        if (isComposingFilter) return;
        if (filterDebounceTimer) clearTimeout(filterDebounceTimer);
        triggerSearch();
      });
      filterContainer.appendChild(filterInput);
      
      // 新增清除按钮，放在搜索框右边
      const clearButton = document.createElement('button');
      clearButton.textContent = '清除';
      clearButton.className = 'clear-filter-btn';
      clearButton.style.marginLeft = '5px';
      clearButton.addEventListener('click', () => {
        filterInput.value = '';
        // 清除后也立即加载结果
        loadConversationHistories(panel, ''); 
        // 清除后将焦点设置回输入框
        filterInput.focus(); 
      });
      filterContainer.appendChild(clearButton);

      // 当前 URL 快速筛选按钮：只显示与当前页面 URL 相关的历史会话（按前缀匹配分级）
      const urlFilterButton = document.createElement('button');
      urlFilterButton.textContent = '本页';
      // 说明：额外加 role class，避免未来同容器内出现多个“类似按钮”时 querySelector 误选
      urlFilterButton.className = 'url-filter-btn url-filter-toggle';
      urlFilterButton.style.marginLeft = '5px';

      const updateFilterInputPlaceholder = () => {
        if (!filterInput) return;
        const isUrlMode = panel.dataset.urlFilterMode === 'currentUrl';
        const isTreeMode = panel.dataset.branchViewMode === 'tree';
        const base = isUrlMode
          ? '本页会话搜索：空格=AND，!否定，count:>10，date:<5d'
          : '搜索（URL+消息）：空格=AND，!否定，url:xxx，count:>10，date:<5d';
        // 树状视图本身只在“无筛选”时改变排序；这里仅提示用户当前处于该模式
        filterInput.placeholder = isTreeMode ? `${base}（树状）` : base;
      };

      const updateUrlFilterButtonState = () => {
        const currentUrl = state.pageInfo?.url;
        const hasUrl = !!(currentUrl && typeof currentUrl === 'string' && currentUrl.trim());
        urlFilterButton.disabled = !hasUrl;
        urlFilterButton.title = hasUrl
          ? '快速筛选出与当前页面 URL 相关的历史会话（按 URL 前缀分级匹配）'
          : '未能获取当前页面 URL，无法启用“本页”筛选';
        urlFilterButton.classList.toggle('active', panel.dataset.urlFilterMode === 'currentUrl');
        updateFilterInputPlaceholder();
      };

      urlFilterButton.addEventListener('click', () => {
        const currentUrl = state.pageInfo?.url;
        const hasUrl = !!(currentUrl && typeof currentUrl === 'string' && currentUrl.trim());
        if (!hasUrl) return;
        const nextActive = panel.dataset.urlFilterMode !== 'currentUrl';
        panel.dataset.urlFilterMode = nextActive ? 'currentUrl' : '';
        updateUrlFilterButtonState();
        loadConversationHistories(panel, filterInput ? filterInput.value : '');
        filterInput?.focus();
      });

      updateUrlFilterButtonState();
      filterContainer.appendChild(urlFilterButton);

      // 分支树状视图开关：按 parentConversationId 以缩进方式展示“分支会话”结构
      const branchTreeButton = document.createElement('button');
      branchTreeButton.textContent = '树状';
      branchTreeButton.className = 'url-filter-btn branch-tree-btn';
      branchTreeButton.style.marginLeft = '5px';
      branchTreeButton.title = '树状显示分支对话（需要读取全部会话元数据，列表加载可能比默认模式稍慢）';

      const updateBranchTreeButtonState = () => {
        const active = panel.dataset.branchViewMode === 'tree';
        branchTreeButton.classList.toggle('active', active);
        updateFilterInputPlaceholder();
      };

      branchTreeButton.addEventListener('click', () => {
        const nextActive = panel.dataset.branchViewMode !== 'tree';
        panel.dataset.branchViewMode = nextActive ? 'tree' : '';
        updateBranchTreeButtonState();
        loadConversationHistories(panel, filterInput ? filterInput.value : '');
        filterInput?.focus();
      });

      updateBranchTreeButtonState();
      filterContainer.appendChild(branchTreeButton);
      // TODO(search-qa): 在搜索窗口增加“对当前搜索结果提问”入口（例如按钮）。
      // 实现步骤（后续实现时按此流程落地）：
      // 1) 基于 panel.dataset.searchCacheKey 读取当前搜索缓存，获取 results 与 matchMap；
      // 2) 从当前命中的会话中抽取 excerpts / 命中消息文本，做去重与长度裁剪后组装上下文；
      // 3) 用户点击“提问”入口后，将上述上下文附加到一次新提问请求中，并提示“基于当前搜索结果回答”；
      // 4) 当搜索词为空或命中数为 0 时禁用该入口，避免发送空上下文。
      ensureSearchSyntaxHelp(filterContainer);
      
      historyContent.appendChild(filterContainer);

      // 列表容器
      const listContainer = document.createElement('div');
      listContainer.id = 'chat-history-list';
      historyContent.appendChild(listContainer);

      // 设置标签内容（承载更多开关/设置项）
      const settingsContent = document.createElement('div');
      settingsContent.className = 'history-tab-content settings-tab-content';
      settingsContent.dataset.tab = 'settings';
      settingsContent.dataset.lazyReady = '0';
      const escSettingsMenu = dom.escSettingsMenu || document.createElement('div');
      escSettingsMenu.id = 'esc-settings-menu';
      escSettingsMenu.classList.add('esc-settings-menu');
      settingsContent.appendChild(escSettingsMenu);
      dom.escSettingsMenu = escSettingsMenu;

      // 提示词设置标签内容（复用 sidebar.html 中的 DOM）
      const promptSettingsContent = dom.promptSettingsPanel;
      if (promptSettingsContent) {
        promptSettingsContent.classList.add('history-tab-content');
        promptSettingsContent.dataset.tab = 'prompt-settings';
        // 旧样式通过 .visible 控制显示；嵌入标签页后统一由 .active 控制。
        promptSettingsContent.classList.remove('visible');
      }

      const skillContent = document.createElement('div');
      skillContent.className = 'history-tab-content';
      skillContent.dataset.tab = 'skills';
      skillContent.dataset.lazyReady = '0';

      // API 设置标签内容（复用 sidebar.html 中的 DOM）
      const apiSettingsContent = dom.apiSettingsPanel;
      if (apiSettingsContent) {
        apiSettingsContent.classList.add('history-tab-content');
        apiSettingsContent.dataset.tab = 'api-settings';
        apiSettingsContent.classList.remove('visible');
      }
      
      // 图片相册标签内容
      const galleryContent = document.createElement('div');
      galleryContent.className = 'history-tab-content';
      galleryContent.dataset.tab = 'gallery';
      
      // 统计数据标签内容
      const statsContent = document.createElement('div');
      statsContent.className = 'history-tab-content stats-tab-content';
      statsContent.dataset.tab = 'stats';
      statsContent.dataset.lazyReady = '0';
      
      // 备份与恢复标签内容
      const backupSettingsContent = document.createElement('div');
      backupSettingsContent.className = 'history-tab-content';
      backupSettingsContent.dataset.tab = 'backup-settings';
      backupSettingsContent.dataset.lazyReady = '0';

      // 添加标签内容到容器
      tabContents.appendChild(historyContent);
      if (promptSettingsContent) tabContents.appendChild(promptSettingsContent);
      tabContents.appendChild(skillContent);
      if (apiSettingsContent) tabContents.appendChild(apiSettingsContent);
      tabContents.appendChild(settingsContent);
      tabContents.appendChild(galleryContent);
      tabContents.appendChild(statsContent);
      tabContents.appendChild(backupSettingsContent);
      panel.appendChild(tabContents);
      ensureSkillsTabDom(panel);
      
      // 设置标签切换事件（异步以支持 await 刷新）
      tabBar.addEventListener('click', async (e) => {
        if (!e.target.classList.contains('history-tab')) return;
        await activateChatHistoryTab(panel, e.target.dataset.tab);
      });
      
      document.body.appendChild(panel);
    } else {
      // 兼容旧 DOM：如果历史面板是由旧版本创建出来的（没有 data-branch-view-mode），
      // 则补上默认值（关闭树状），以符合“打开时默认平铺”的行为。
      // 注意：不要用 `if (!panel.dataset.branchViewMode)` 判断，因为用户关闭树状模式时值为 ''（也属于 falsy）。
      if (!panel.hasAttribute('data-branch-view-mode')) {
        panel.dataset.branchViewMode = '';
      }
      if (!panel.hasAttribute(CHAT_HISTORY_PANEL_PIN_ATTRIBUTE)) {
        panel.dataset[CHAT_HISTORY_PANEL_PIN_DATASET_KEY] = '0';
      }
      ensureChatHistoryPanelPinButton(panel);

      // 如果面板已存在，获取 filterInput 引用
      filterInput = panel.querySelector('.filter-container input[type="text"]');
      const existingEscSettingsMenu = panel.querySelector('#esc-settings-menu');
      if (existingEscSettingsMenu) {
        dom.escSettingsMenu = existingEscSettingsMenu;
      }
      const existingHeader = panel.querySelector('.panel-header');
      if (existingHeader) {
        setupChatHistoryPanelDrag(panel, existingHeader);
      }
      setupChatHistoryPanelResize(panel);
      const filterContainer = panel.querySelector('.filter-container');
      ensureSearchSyntaxHelp(filterContainer);
      ensureSkillsTabDom(panel);
      // 迁移兼容：历史版本曾在搜索框下渲染关键词图例，这里统一移除，改为搜索摘要行内展示。
      panel.querySelector('.search-keyword-legend')?.remove();
      const urlFilterButton = panel.querySelector('.filter-container .url-filter-btn.url-filter-toggle');
      const branchTreeButton = panel.querySelector('.filter-container .branch-tree-btn');
      if (urlFilterButton) {
        const currentUrl = state.pageInfo?.url;
        const hasUrl = !!(currentUrl && typeof currentUrl === 'string' && currentUrl.trim());
        urlFilterButton.disabled = !hasUrl;
        urlFilterButton.title = hasUrl
          ? '快速筛选出与当前页面 URL 相关的历史会话（按 URL 前缀分级匹配）'
          : '未能获取当前页面 URL，无法启用“本页”筛选';
        urlFilterButton.classList.toggle('active', panel.dataset.urlFilterMode === 'currentUrl');
      }
      if (branchTreeButton) {
        branchTreeButton.classList.toggle('active', panel.dataset.branchViewMode === 'tree');
      }
      if (filterInput) {
        const isUrlMode = panel.dataset.urlFilterMode === 'currentUrl';
        const isTreeMode = panel.dataset.branchViewMode === 'tree';
        const base = isUrlMode
          ? '本页会话搜索：空格=AND，!否定，count:>10，date:<5d'
          : '搜索（URL+消息）：空格=AND，!否定，url:xxx，count:>10，date:<5d';
        filterInput.placeholder = isTreeMode ? `${base}（树状）` : base;
      }
    }
    
    // 使用已有的筛选值加载历史记录
    const currentFilter = filterInput ? filterInput.value : '';
    // 说明：若面板已有列表则先复用，待新数据就绪后再替换，降低打开等待感。
    const snapshot = historyPanelScrollSnapshot;
    const canRestoreScroll = !!(snapshot
      && snapshot.capturedAt
      && (Date.now() - snapshot.capturedAt <= HISTORY_PANEL_SCROLL_RESTORE_TTL)
      && (snapshot.filter || '') === (currentFilter || '')
      && (snapshot.urlMode || '') === (panel.dataset.urlFilterMode || '')
      && (snapshot.branchMode || '') === (panel.dataset.branchViewMode || '')
    );
    const restoreScrollTop = canRestoreScroll ? snapshot.scrollTop : null;
    panel.style.display = 'flex';
    restoreChatHistoryPanelLayout(panel);
    syncChatHistoryPanelLayoutMode(panel);
    clampChatHistoryPanelSize(panel);
    void panel.offsetWidth;  
    panel.classList.add('visible');
    syncChatHistoryPanelLayoutMode(panel);

    loadConversationHistories(panel, currentFilter, {
      keepExistingList: true,
      restoreScrollTop
    });

    // 刷新一次“会话-标签页存在性”快照，确保右侧“已打开/跳转”标记尽快准确
    try { conversationPresence?.refreshOpenConversations?.(); } catch (_) {}

    // 切换到目标标签（同步更新 active 类；耗时渲染逻辑异步执行）
    // 说明：这里不 await，避免打开面板被 “图片/统计/API加载” 阻塞。
    void activateChatHistoryTab(panel, initialTab);

    // 预热全量元数据（idle），降低“首次全文搜索”的启动延迟
    scheduleConversationMetadataWarmup(panel);
    
    // --- 修改开始：打开面板后聚焦到 filterInput ---
    // 确保在 'history' 标签页激活时聚焦
    const activeTab = panel.querySelector('.history-tab.active');
    if (activeTab && activeTab.dataset.tab === 'history') {
      requestAnimationFrame(() => {
        filterInput?.focus();
        filterInput?.select(); // 可选：选中输入框内容方便修改
      });
    }
    // --- 修改结束 ---
  }

  /**
   * 刷新聊天记录面板
   */
  function refreshChatHistory(options = null) {
    invalidateGalleryCache();
    const panel = document.getElementById('chat-history-panel');
    if (panel && panel.classList.contains('visible')) { // 仅当面板可见时刷新
      const filterInput = panel.querySelector('input[type="text"]');
      const effectiveOptions = (options && typeof options === 'object') ? options : {};
      const restoreScrollTop = Number.isFinite(effectiveOptions.restoreScrollTop)
        ? Math.max(0, Number(effectiveOptions.restoreScrollTop))
        : null;
      loadConversationHistories(panel, filterInput ? filterInput.value : '', {
        keepExistingList: !!effectiveOptions.keepExistingList,
        restoreScrollTop
      });
      try { conversationPresence?.refreshOpenConversations?.(); } catch (_) {}
      const galleryContent = panel.querySelector('.history-tab-content[data-tab="gallery"]');
      const activeTabName = panel.querySelector('.history-tab.active')?.dataset.tab;
      if (galleryContent) {
        galleryContent.dataset.rendered = '';
        if (activeTabName === 'gallery') {
          renderGalleryTab(galleryContent, { forceRefresh: true });
        } else {
          galleryContent.innerHTML = '';
        }
      }
    }
  }

  // 自动备份锁（跨标签页）
  const AUTO_BACKUP_LOCK_KEY = 'auto_backup_lock';
  const INSTANCE_ID = `ab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  async function acquireAutoBackupLock(ttlMs = 2 * 60 * 1000) {
    try {
      const wrap = await chrome.storage.local.get([AUTO_BACKUP_LOCK_KEY]);
      const lock = wrap[AUTO_BACKUP_LOCK_KEY];
      const now = Date.now();
      if (lock && lock.expiresAt && lock.expiresAt > now) return false;
      const newLock = { owner: INSTANCE_ID, expiresAt: now + ttlMs };
      await chrome.storage.local.set({ [AUTO_BACKUP_LOCK_KEY]: newLock });
      const confirmWrap = await chrome.storage.local.get([AUTO_BACKUP_LOCK_KEY]);
      return confirmWrap[AUTO_BACKUP_LOCK_KEY]?.owner === INSTANCE_ID;
    } catch (e) { return false; }
  }
  async function releaseAutoBackupLock() {
    try {
      const wrap = await chrome.storage.local.get([AUTO_BACKUP_LOCK_KEY]);
      if (wrap[AUTO_BACKUP_LOCK_KEY]?.owner === INSTANCE_ID) {
        await chrome.storage.local.remove([AUTO_BACKUP_LOCK_KEY]);
      }
    } catch (_) {}
  }

  /**
   * 备份所有对话记录
   * @returns {Promise<void>}
   */
  async function backupConversations(opts = {}) {
    try {
      // 步进进度（等分）
      const steps = ['读取偏好', '分析会话', '流式导出', '保存文件', '更新备份时间', '完成'];

      // 读取备份偏好（仅下载方案）
      const prefs = await loadBackupPreferencesDownloadsOnly();
      const seqBase = Number(prefs.incSequence) || 0;
      const mode = opts.mode || 'full';
      const isAuto = !!opts.auto;
      const resetIncremental = !!opts.resetIncremental;
      const doIncremental = mode === 'incremental';
      // 现在 IndexedDB 不再存储图片 base64，默认备份包含图片引用；仅当显式传入 excludeImages 时才剥离图片片段
      const excludeImages = (opts.excludeImages !== undefined) ? !!opts.excludeImages : false;
      const doCompress = (opts.compress !== undefined) ? !!opts.compress : (prefs.compressDefault !== false);
      const stripMeta = !!opts.stripMeta;
      const sp = utils.createStepProgress({ steps, type: 'info' });
      sp.setStep(0); // 读取偏好

      // 读取上次备份时间
      const LAST_BACKUP_TIME_KEY = 'chat_last_backup_time';
      let lastBackupAt = 0;
      try {
        const local = await chrome.storage.local.get([LAST_BACKUP_TIME_KEY]);
        lastBackupAt = Number(local[LAST_BACKUP_TIME_KEY]) || 0;
      } catch (_) {}
      sp.next('分析会话');

      // 准备需要导出的会话元数据（轻量），避免一次性加载完整内容
      const metas = await getAllConversationMetadata();
      let exportMetas = metas;
      if (doIncremental && lastBackupAt > 0) {
        exportMetas = metas.filter(m => (Number(m?.endTime) || 0) > lastBackupAt);
      }
      const total = exportMetas.length;
      sp.updateSub(0, Math.max(1, total), `待导出 ${total} 条`);

      sp.next('流式导出');
      let usedStripFallback = false;
      let maxEndTime = lastBackupAt;

      const buildStreamBackup = async (forceExcludeImages, forceStripMeta, hintMessage) => {
        let processed = 0;
        maxEndTime = lastBackupAt;
        if (hintMessage) {
          sp.updateSub(0, Math.max(1, total), hintMessage);
        }

        const iterator = (async function* () {
          for (const meta of exportMetas) {
            const full = await getConversationById(meta.id, true);
            processed += 1;
            sp.updateSub(processed, Math.max(1, total), `导出会话 (${processed}/${total})`);
            if (!full) continue;
            const cleaned = prepareConversationForBackup(full, {
              excludeImages: forceExcludeImages,
              stripMeta: forceStripMeta,
              keepImageRefs: false
            });
            const documents = await listConversationDocuments(meta.id);
            if (documents.length > 0) {
              cleaned.documents = documents.map((doc) => ({
                path: doc.path,
                content: doc.content,
                updated_at: doc.updated_at
              }));
            }
            const endTime = Number(cleaned?.endTime) || Number(meta?.endTime) || 0;
            if (endTime > maxEndTime) maxEndTime = endTime;
            yield cleaned;
          }
        })();

        return await buildBackupBlob(iterator, doCompress, { allowStripFallback: false });
      };

      let blobResult;
      try {
        blobResult = await buildStreamBackup(excludeImages, stripMeta);
      } catch (error) {
        if (!excludeImages) {
          console.warn('备份流式构建失败，尝试移除图片后重试:', error);
          usedStripFallback = true;
          blobResult = await buildStreamBackup(true, stripMeta, '备份过大，移除图片后重试');
        } else {
          throw error;
        }
      }

      const { blob } = blobResult;
      const seqForName = doIncremental ? (seqBase + 1) : undefined;
      const effectiveExcludeImages = excludeImages || usedStripFallback;
      const filename = buildBackupFilename({
        mode: doIncremental ? 'incremental' : 'full',
        excludeImages: effectiveExcludeImages,
        doCompress,
        seq: seqForName,
        stripMeta
      });
      sp.next('保存文件');

      // 仅使用下载API或<a download>保存
      await triggerBlobDownload(blob, filename);
      if (usedStripFallback && !excludeImages) {
        try {
          showNotification({
            message: '备份体积过大，已自动移除图片后完成备份',
            type: 'warning',
            duration: 3600
          });
        } catch (_) {}
      }

      // 记录本次备份时间（使用数据中最大 endTime 避免时间漂移）
      sp.next('更新备份时间');
      let backupReferenceTime = Math.max(Number(maxEndTime) || 0, Number(lastBackupAt) || 0);
      if (!backupReferenceTime) backupReferenceTime = Date.now();
      try {
        const toSave = { [LAST_BACKUP_TIME_KEY]: backupReferenceTime };
        await chrome.storage.local.set(toSave);
      } catch (_) {}
      try {
        const completedAt = Date.now();
        const checkpoint = Math.max(completedAt, backupReferenceTime);
        if (doIncremental) {
          await saveBackupPreferencesDownloadsOnly({
            lastIncrementalBackupAt: checkpoint,
            incSequence: seqBase + 1
          });
        } else {
          const updates = {
            lastFullBackupAt: checkpoint
          };
          if (resetIncremental) {
            updates.lastFullResetBackupAt = checkpoint;
            updates.lastIncrementalBackupAt = checkpoint;
            updates.incSequence = 0;
          }
          await saveBackupPreferencesDownloadsOnly(updates);
        }
      } catch (_) {}
      sp.next('完成');
      sp.complete('备份完成', true);
    } catch (error) {
      console.error('备份失败:', error);
      try { showNotification({ message: '备份失败', type: 'error', description: String(error?.message || error) }); } catch (_) {}
    }
  }

  function buildBackupFilename({ mode, excludeImages, doCompress, seq, stripMeta }) {
    const ts = new Date();
    const pad = (n, w) => String(n).padStart(w, '0');
    const nameTs = `${ts.getFullYear()}${pad(ts.getMonth() + 1, 2)}${pad(ts.getDate(), 2)}_${pad(ts.getHours(), 2)}${pad(ts.getMinutes(), 2)}${pad(ts.getSeconds(), 2)}`;
    const suffix = doCompress ? '.json.gz' : '.json';
    if (mode === 'incremental') {
      const s = pad(Math.max(1, Number(seq || 1)), 3);
      return `chat_backup_inc_${nameTs}+${s}${excludeImages ? '_noimg' : ''}${stripMeta ? '_nometa' : ''}${suffix}`;
    }
    return `chat_backup_full_${nameTs}${excludeImages ? '_noimg' : ''}${stripMeta ? '_nometa' : ''}${suffix}`;
  }

  /**
   * 从备份文件恢复对话记录（支持多选与合并去重）
   */
  function restoreConversations() {
    // 创建一个 file input 元素用于选择文件
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true; // 支持多选
    // 同时支持 .json 与 .json.gz
    input.accept = '.json,application/json,.gz,application/gzip';
    input.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files || files.length === 0) return;
      try {
        // 步进进度：读取文件、解析合并、确认覆盖、写入会话、刷新界面、完成
        const steps = ['读取文件', '解析与合并', '确认覆盖', '写入会话', '刷新界面', '完成'];
        const sp = utils.createStepProgress({ steps, type: 'info' });
        sp.setStep(0);

        // 读取并解析所有选中的备份文件
        const allConversations = [];
        for (const file of files) {
          try {
            const text = await readBackupFileAsText(file);
            const data = JSON.parse(text);
            const arr = normalizeBackupArray(data);
            if (!arr) {
              console.warn('备份文件格式不正确（忽略此文件）:', file.name);
              continue;
            }
            allConversations.push(...arr);
          } catch (err) {
            console.error('解析备份文件失败（忽略此文件）:', file.name, err);
          }
          sp.updateSub(allConversations.length, allConversations.length, `读取文件 (${Math.min(allConversations.length, 1)}/${files.length})`);
        }
        if (allConversations.length === 0) {
          showNotification({ message: '未从所选文件读取到有效会话', type: 'warning' });
          return;
        }
        sp.next('解析与合并');
        const originalTotal = allConversations.length;
        const mergedConversations = mergeConversationsById(allConversations);
        const mergedCount = mergedConversations.length;
        sp.next('确认覆盖');
        const overwrite = await appContext.utils.showConfirm({
          message: '是否覆盖已有会话（同 ID）？',
          description: '选择“确定”会覆盖同 ID 的已有会话；选择“取消”仅导入新增会话。',
          confirmText: '确定',
          cancelText: '取消',
          type: 'warning'
        });
        let countAdded = 0;
        let countOverwritten = 0;
        let countSkipped = 0;
        sp.next('写入会话');
        const total = mergedConversations.length;
        // 逐条写入：存在且不覆盖则跳过，存在且覆盖则替换
        for (const conv of mergedConversations) {
          try {
            const hasDocumentSnapshot = Array.isArray(conv?.documents);
            const documentSnapshot = hasDocumentSnapshot
              ? conv.documents.map((doc) => ({
                  path: doc?.path,
                  content: doc?.content,
                  updated_at: doc?.updated_at
                }))
              : [];
            const { documents: _ignoredDocuments, ...conversationToStore } = conv || {};
            // 恢复时移除推理签名，避免无意义占用空间
            try { removeThoughtSignatureFromMessages(conversationToStore?.messages); } catch (_) {}
            const existing = await getConversationById(conversationToStore.id, false);
            if (!existing) {
              await putConversation(conversationToStore);
              if (hasDocumentSnapshot) {
                await replaceConversationDocuments(conversationToStore.id, documentSnapshot);
              }
              countAdded++;
            } else if (overwrite) {
              await putConversation(conversationToStore);
              if (hasDocumentSnapshot) {
                await replaceConversationDocuments(conversationToStore.id, documentSnapshot);
              }
              countOverwritten++;
            } else {
              countSkipped++;
            }
          } catch (error) {
            console.error(`恢复对话 ${conv?.id || '-'} 时出错:`, error);
          }
          const done = countAdded + countOverwritten + countSkipped;
          sp.updateSub(done, total, `写入会话 (${done}/${total})`);
        }
        sp.next('刷新界面');
        showNotification({
          message: '恢复完成',
          description: `合并：${originalTotal} → ${mergedCount}；新增 ${countAdded}，覆盖 ${countOverwritten}，跳过 ${countSkipped}`,
          type: 'success',
          duration: 3000
        });
        // 刷新聊天记录面板
        invalidateMetadataCache();
        refreshChatHistory();
        sp.next('完成');
        sp.complete('恢复完成', true);
      } catch (error) {
        console.error('读取备份文件失败:', error);
        showNotification({ message: '读取备份文件失败', type: 'error', description: '请检查文件格式' });
      }
    });
    input.click();
  }

  /**
   * 兼容不同导出格式，将对象归一为会话数组
   * @param {any} data
   * @returns {Array<Object>|null}
   */
  function normalizeBackupArray(data) {
    if (!data) return null;
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.items)) return data.items;
    return null;
  }

  /**
   * 将多文件中的会话按 id 合并去重，冲突优先选择 endTime 更新的记录；
   * 若 endTime 相同，选择消息数更多的记录
   * @param {Array<Object>} conversations
   * @returns {Array<Object>}
   */
  function mergeConversationsById(conversations) {
    const map = new Map();
    (conversations || []).forEach((c) => {
      const id = c && c.id;
      if (!id) return;
      const prev = map.get(id);
      if (!prev) {
        map.set(id, c);
      } else {
        const endPrev = Number(prev.endTime) || 0;
        const endCur = Number(c.endTime) || 0;
        if (endCur > endPrev) {
          map.set(id, c);
        } else if (endCur === endPrev) {
          const countPrev = (Array.isArray(prev.messages) ? prev.messages.length : (prev.messageCount || 0)) || 0;
          const countCur = (Array.isArray(c.messages) ? c.messages.length : (c.messageCount || 0)) || 0;
          if (countCur > countPrev) map.set(id, c);
        }
      }
    });
    return Array.from(map.values());
  }

  // ==== 图片重扫与本地化（用于清理最近会话中的 base64） ====
  const DATA_URL_REGEX = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+=*/gi;

  /**
   * 工具：将会话中的图片内容移除，仅保留文本以减小备份体积
   * @param {Object} conversation
   * @returns {Object}
   */
  function stripDataUrlsFromString(text) {
    if (typeof text !== 'string') return { text, removed: 0 };
    let removed = 0;
    const cleaned = text.replace(DATA_URL_REGEX, () => {
      removed += 1;
      return '';
    });
    return { text: cleaned, removed };
  }

  /**
   * 备份时剥离图片内容：默认移除图片片段，仅保留文本；可选保留图片引用（path/hash）
   * @param {Object} conversation
   * @param {{keepImageRefs?: boolean}} options
   * @returns {Object}
   */
  function stripImagesFromConversation(conversation, options = {}) {
    const keepImageRefs = !!options.keepImageRefs;
    if (!conversation || typeof conversation !== 'object') return conversation;
    try {
      const cloned = { ...conversation };
      if (Array.isArray(conversation.messages)) {
        cloned.messages = conversation.messages.map((msg) => {
          const next = { ...msg };
          // 默认只保留文本片段；keepImageRefs=true 时保留轻量级图片引用（path/hash）
          if (Array.isArray(msg.content)) {
            const textChunks = [];
            const imageParts = [];
            for (const part of msg.content) {
              if (!part) continue;
              if (part.type === 'text' && typeof part.text === 'string') {
                const cleaned = stripDataUrlsFromString(part.text);
                if (cleaned.text) textChunks.push(cleaned.text);
              } else if (part.type === 'image_url' && keepImageRefs) {
                // 保留轻量级图片引用，避免恢复后丢失路径；始终丢弃 data: 链接
                const img = part.image_url || {};
                const minimal = { type: 'image_url', image_url: {} };
                const nonDataPath = (img.path && !String(img.path).startsWith('data:')) ? img.path : null;
                const nonDataUrl = (img.url && !String(img.url).startsWith('data:')) ? img.url : null;
                if (nonDataPath) minimal.image_url.path = nonDataPath;
                else if (nonDataUrl) minimal.image_url.path = nonDataUrl;
                if (!minimal.image_url.path) {
                  // 完全跳过 dataURL 以避免膨胀
                  continue;
                }
                if (img.hash) minimal.image_url.hash = img.hash;
                if (img.mimeType || img.mime_type) {
                  minimal.image_url.mime_type = img.mimeType || img.mime_type;
                }
                imageParts.push(minimal);
              }
            }
            if (keepImageRefs && imageParts.length > 0) {
              const mergedText = textChunks.join('');
              if (mergedText.trim()) {
                imageParts.push({ type: 'text', text: mergedText });
              }
              next.content = imageParts;
            } else {
              next.content = textChunks.join('');
            }
          } else if (typeof msg.content === 'string') {
            const cleaned = stripDataUrlsFromString(msg.content);
            next.content = cleaned.text;
          }
          return next;
        });
      }
      return cloned;
    } catch (_) {
      return conversation;
    }
  }

  /**
   * 备份前清理图片字段：移除 dataURL，统一使用 path，缺少路径则丢弃该图片片段
   * @param {Object} conversation
   * @returns {Object}
   */
  function sanitizeConversationImages(conversation) {
    if (!conversation || typeof conversation !== 'object') return conversation;
    try {
      const cloned = { ...conversation };
      if (Array.isArray(conversation.messages)) {
        cloned.messages = conversation.messages.map((msg) => {
          const next = { ...msg };
          if (Array.isArray(msg.content)) {
            const parts = [];
            for (const part of msg.content) {
              if (!part) continue;
              if (part.type === 'text' && typeof part.text === 'string') {
                const cleaned = stripDataUrlsFromString(part.text);
                parts.push({ type: 'text', text: cleaned.text });
              } else if (part.type === 'image_url' && part.image_url) {
                const img = { ...part.image_url };
                const nonDataPath = (img.path && !String(img.path).startsWith('data:')) ? img.path : null;
                const nonDataUrl = (img.url && !String(img.url).startsWith('data:')) ? img.url : null;
                const path = nonDataPath || nonDataUrl;
                if (!path) {
                  // 丢弃 dataURL/空路径的图片，避免撑爆备份
                  continue;
                }
                const minimal = { type: 'image_url', image_url: { path } };
                if (img.hash) minimal.image_url.hash = img.hash;
                if (img.mimeType || img.mime_type) minimal.image_url.mime_type = img.mimeType || img.mime_type;
                parts.push(minimal);
              }
            }
            next.content = parts.length > 0 ? parts : '';
          } else if (typeof msg.content === 'string') {
            const cleaned = stripDataUrlsFromString(msg.content);
            next.content = cleaned.text;
          }
          return next;
        });
      }
      return cloned;
    } catch (_) {
      return conversation;
    }
  }

  /**
   * 调试：扫描数据库中残留的 dataURL（文本或图片字段），避免意外膨胀
   * @param {number} sampleLimit 样本上限
   * @returns {Promise<{conversations:number,messages:number,dataUrlCount:number,samples:Array}>}
   */
  async function scanDataUrlsInDb(sampleLimit = 20) {
    const conversations = await getAllConversations(true);
    let msgCount = 0;
    let dataUrlCount = 0;
    const samples = [];

    const pushSample = (convId, msgId, field, value) => {
      if (samples.length >= sampleLimit) return;
      samples.push({
        conversationId: convId,
        messageId: msgId,
        field,
        preview: (value || '').slice(0, 160)
      });
    };

    for (const conv of conversations) {
      if (!Array.isArray(conv?.messages)) continue;
      for (const msg of conv.messages) {
        msgCount += 1;
        const convId = conv.id || '';
        const msgId = msg.id || '';

        // 字符串内容
        if (typeof msg.content === 'string') {
          const matches = msg.content.match(DATA_URL_REGEX);
          if (matches && matches.length) {
            dataUrlCount += matches.length;
            pushSample(convId, msgId, 'content(string)', matches[0]);
          }
        }

        // 结构化内容
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (!part) continue;
            if (part.type === 'text' && typeof part.text === 'string') {
              const matches = part.text.match(DATA_URL_REGEX);
              if (matches && matches.length) {
                dataUrlCount += matches.length;
                pushSample(convId, msgId, 'text', matches[0]);
              }
            } else if (part.type === 'image_url' && part.image_url) {
              const img = part.image_url;
              if (img.path && String(img.path).startsWith('data:')) {
                dataUrlCount += 1;
                pushSample(convId, msgId, 'image_url.path', img.path);
              } else if (img.url && String(img.url).startsWith('data:')) {
                dataUrlCount += 1;
                pushSample(convId, msgId, 'image_url.url', img.url);
              }
            }
          }
        }
      }
    }

    return {
      conversations: conversations.length,
      messages: msgCount,
      dataUrlCount,
      samples
    };
  }

  const BACKUP_META_FIELDS = [
    'thoughtsRaw',
    'thoughtSignature',
    'thoughtSignatureSource',
    'reasoning_content',
    'response_activity_timeline',
    'response_reasoning_summary',
    'tool_calls',
    'response_tool_calls',
    'groundingMetadata',
    'preprocessOriginalText',
    'preprocessRenderedText'
  ];

  /**
   * 备份时可选移除体积较大的元数据字段，避免“非图片数据”撑爆备份体积
   * @param {Object} conversation
   * @returns {Object}
   */
  function stripBackupMetaFromConversation(conversation) {
    if (!conversation || typeof conversation !== 'object') return conversation;
    try {
      const cloned = { ...conversation };
      if (Array.isArray(conversation.messages)) {
        cloned.messages = conversation.messages.map((msg) => {
          if (!msg || typeof msg !== 'object') return msg;
          const next = { ...msg };
          for (const key of BACKUP_META_FIELDS) {
            if (key in next) delete next[key];
          }
          return next;
        });
      }
      return cloned;
    } catch (_) {
      return conversation;
    }
  }

  function prepareConversationForBackup(conversation, options = {}) {
    const excludeImages = !!options.excludeImages;
    const stripMeta = !!options.stripMeta;
    const keepImageRefs = !!options.keepImageRefs;
    let cleaned = excludeImages
      ? stripImagesFromConversation(conversation, { keepImageRefs })
      : sanitizeConversationImages(conversation);
    // 备份始终移除推理签名，避免不必要的体积膨胀
    try {
      removeThoughtSignatureFromMessages(cleaned?.messages);
    } catch (_) {}
    if (stripMeta) {
      cleaned = stripBackupMetaFromConversation(cleaned);
    }
    return cleaned;
  }

  function getAsyncIterator(source) {
    if (!source) return null;
    if (typeof source[Symbol.asyncIterator] === 'function') return source[Symbol.asyncIterator]();
    if (typeof source.next === 'function') return source;
    return null;
  }

  // 说明：流式拼接 JSON 数组，避免一次性 JSON.stringify 撑爆内存。
  function createJsonArrayStreamFromIterator(iterator) {
    const encoder = new TextEncoder();
    let started = false;
    let isFirst = true;
    let finished = false;

    return new ReadableStream({
      async pull(controller) {
        try {
          if (!started) {
            controller.enqueue(encoder.encode('['));
            started = true;
          }
          if (finished) return;
          const { value, done } = await iterator.next();
          if (done) {
            controller.enqueue(encoder.encode(']'));
            controller.close();
            finished = true;
            return;
          }
          if (!isFirst) controller.enqueue(encoder.encode(','));
          isFirst = false;
          controller.enqueue(encoder.encode(JSON.stringify(value)));
        } catch (err) {
          controller.error(err);
        }
      },
      async cancel() {
        if (typeof iterator.return === 'function') {
          try { await iterator.return(); } catch (_) {}
        }
      }
    });
  }

  async function buildBackupBlobFromIterator(iterator, compress) {
    if (typeof ReadableStream === 'undefined' || typeof TextEncoder === 'undefined') {
      throw new Error('当前环境不支持流式备份');
    }
    const jsonStream = createJsonArrayStreamFromIterator(iterator);
    if (compress && typeof CompressionStream !== 'undefined') {
      const gzipStream = jsonStream.pipeThrough(new CompressionStream('gzip'));
      const gzipBlob = await new Response(gzipStream).blob();
      return new Blob([gzipBlob], { type: 'application/gzip' });
    }
    const plainBlob = await new Response(jsonStream).blob();
    return new Blob([plainBlob], { type: 'application/json' });
  }

  /**
   * 工具：构建备份 Blob（可选 gzip），在超大数据时自动剥离图片兜底
   * 使用浏览器原生 CompressionStream('gzip')，无需额外依赖
   * @param {any|AsyncIterable<any>} data
   * @param {boolean} compress
   * @param {{allowStripFallback?: boolean}} options
   * @returns {Promise<{blob: Blob, usedStripFallback: boolean}>}
   */
  async function buildBackupBlob(data, compress = true, options = {}) {
    const { allowStripFallback = false, stripImagesOnFallback = false } = options || {};
    const asyncIterator = getAsyncIterator(data);
    if (asyncIterator) {
      const blob = await buildBackupBlobFromIterator(asyncIterator, compress);
      return { blob, usedStripFallback: false };
    }
    let jsonStr = '';
    let usedStripFallback = false;
    let dataForStringify = data;

    try {
      jsonStr = JSON.stringify(dataForStringify);
    } catch (error) {
      const isRangeError = (error instanceof RangeError) || /invalid string length/i.test(error?.message || '');
      if (!allowStripFallback || !isRangeError) {
        throw error;
      }
      console.warn('备份数据过大，尝试移除图片后重试:', error);
      dataForStringify = Array.isArray(data)
        ? data.map((conv) => stripImagesFromConversation(conv, { keepImageRefs: !stripImagesOnFallback }))
        : stripImagesFromConversation(data, { keepImageRefs: !stripImagesOnFallback });
      try {
        jsonStr = JSON.stringify(dataForStringify);
        usedStripFallback = true;
      } catch (e) {
        // 二次仍失败时，改用流式构造 JSON 以规避超大字符串限制
        console.warn('备份数据仍然过大，改用流式构造 JSON:', e);
        const iterator = (async function* () {
          const list = Array.isArray(dataForStringify) ? dataForStringify : [dataForStringify];
          for (const item of list) yield item;
        })();
        return { blob: await buildBackupBlobFromIterator(iterator, compress), usedStripFallback: true };
      }
    }

    if (compress && typeof CompressionStream !== 'undefined') {
      try {
        const enc = new TextEncoder();
        const inputStream = new Blob([enc.encode(jsonStr)]).stream();
        const gzipStream = inputStream.pipeThrough(new CompressionStream('gzip'));
        const gzipBlob = await new Response(gzipStream).blob();
        return { blob: new Blob([gzipBlob], { type: 'application/gzip' }), usedStripFallback };
      } catch (e) {
        console.warn('压缩失败，回退至原始 JSON:', e);
        return { blob: new Blob([jsonStr], { type: 'application/json' }), usedStripFallback };
      }
    }
    return { blob: new Blob([jsonStr], { type: 'application/json' }), usedStripFallback };
  }

  async function triggerBlobDownload(blob, filename) {
    // 尝试使用 chrome.downloads 以便指定子目录（如 Cerebr/），失败再回退为 <a download>
    const useDownloadsApi = !!(chrome && chrome.downloads && chrome.downloads.download);
    if (useDownloadsApi) {
      try {
        const url = URL.createObjectURL(blob);
        const target = `Cerebr/${filename}`; // 保存到下载目录下的 Cerebr 子文件夹
        await new Promise((resolve, reject) => {
          chrome.downloads.download({ url, filename: target, saveAs: false }, (id) => {
            if (chrome.runtime.lastError || !id) {
              try { URL.revokeObjectURL(url); } catch (_) {}
              reject(chrome.runtime.lastError || new Error('downloads.download failed'));
            } else {
              // 稍后撤销 URL，避免泄漏
              setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 60 * 1000);
              resolve(id);
            }
          });
        });
        return;
      } catch (_) { /* 回退到 <a download> */ }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const base64FileCache = new Map(); // hash(base64) -> file://...
  const remoteFileCache = new Map();  // remoteUrl -> file://...
  const IMAGE_HASH_CACHE_KEY = 'image_hash_cache_v1';
  const DOWNLOAD_ROOT_KEY = 'image_download_root';
  let base64CacheLoaded = false;
  let downloadRootCache = null;

  async function loadBase64Cache() {
    if (base64CacheLoaded) return;
    try {
      const wrap = await chrome.storage.local.get([IMAGE_HASH_CACHE_KEY]);
      const cacheObj = wrap[IMAGE_HASH_CACHE_KEY] || {};
      Object.entries(cacheObj).forEach(([hash, url]) => base64FileCache.set(hash, url));
    } catch (e) {
      console.warn('加载图片哈希缓存失败:', e);
    } finally {
      base64CacheLoaded = true;
    }
  }

  async function persistBase64Cache() {
    try {
      const obj = {};
      base64FileCache.forEach((url, hash) => { obj[hash] = url; });
      await chrome.storage.local.set({ [IMAGE_HASH_CACHE_KEY]: obj });
    } catch (e) {
      console.warn('保存图片哈希缓存失败:', e);
    }
  }

  function getImageRoleFolder(role) {
    const r = String(role || '').toLowerCase();
    if (r === 'assistant' || r === 'ai') return 'AI';
    return 'User';
  }

  function guessExtFromMime(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
    if (m.includes('webp')) return 'webp';
    if (m.includes('gif')) return 'gif';
    if (m.includes('bmp')) return 'bmp';
    return 'png';
  }

  function guessExtFromUrl(url) {
    try {
      const parsed = new URL(url);
      const pathname = parsed.pathname || '';
      const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
      if (match && match[1]) return match[1].toLowerCase();
    } catch (_) {}
    return null;
  }

  function normalizeFileUrl(filePath) {
    let normalizedPath = filePath.replace(/\\/g, '/');
    if (/^[A-Za-z]:\//.test(normalizedPath)) {
      normalizedPath = '/' + normalizedPath;
    }
    return `file://${normalizedPath}`;
  }

  function parseDataUrl(dataUrl) {
    if (typeof dataUrl !== 'string') return null;
    if (!dataUrl.startsWith('data:image/')) return null;
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;
    const mimeType = match[1] || 'image/png';
    const base64Data = match[2] || '';
    return { mimeType, base64Data, ext: guessExtFromMime(mimeType) };
  }

  function extractHashFromFileUrl(fileUrl) {
    try {
      if (typeof fileUrl !== 'string' || !fileUrl.startsWith('file://')) return null;
      let path = decodeURIComponent(fileUrl.replace(/^file:\/\//, ''));
      if (/^[A-Za-z]:\//.test(path)) path = path.replace(/^\//, '');
      const base = (path.split(/[\\/]/).pop() || '').split('.').slice(0, -1).join('') || '';
      // 仅当文件名本身是纯十六进制串时才认定为哈希，避免日期_随机名被误判
      const candidate = base.match(/^[a-fA-F0-9]{16,64}$/);
      return candidate ? candidate[0].toLowerCase() : null;
    } catch (_) {
      return null;
    }
  }

  function normalizePath(p) {
    return (p || '').replace(/\\/g, '/');
  }

  async function loadDownloadRoot() {
    if (downloadRootCache) return downloadRootCache;
    try {
      const res = await chrome.storage.local.get([DOWNLOAD_ROOT_KEY]);
      const root = res[DOWNLOAD_ROOT_KEY];
      if (root && typeof root === 'string') {
        downloadRootCache = normalizePath(root).replace(/\/+$/, '') + '/';
        return downloadRootCache;
      }
    } catch (_) {}
    return null;
  }

  async function saveDownloadRoot(rootPath) {
    if (!rootPath) return;
    downloadRootCache = normalizePath(rootPath).replace(/\/+$/, '') + '/';
    try {
      await chrome.storage.local.set({ [DOWNLOAD_ROOT_KEY]: downloadRootCache });
    } catch (_) {}
  }

  async function setDownloadRootManual(rootPath) {
    if (!rootPath || typeof rootPath !== 'string') return;
    await saveDownloadRoot(rootPath);
  }

  function deriveRootFromAbsolute(absPath, relPath) {
    const abs = normalizePath(absPath);
    const rel = normalizePath(relPath || '');
    const idx = rel ? abs.lastIndexOf(rel) : -1;
    if (idx >= 0) {
      return abs.slice(0, idx);
    }
    // 尝试按 Images/ 分割
    const marker = '/Images/';
    const markerIdx = abs.indexOf(marker);
    if (markerIdx >= 0) {
      return abs.slice(0, markerIdx + 1); // 保留前导 /
    }
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
    const root = normalizePath(rootPath || downloadRootCache || '');
    const rel = normalizedRaw.replace(/^\/+/, '');
    if (!root) {
      return rel; // 无根路径时返回相对路径，避免生成 file:///Images/...
    }
    const full = `${root}${rel}`;
    let normalized = normalizePath(full);
    if (/^[A-Za-z]:\//.test(normalized)) {
      normalized = '/' + normalized;
    } else if (!normalized.startsWith('/')) {
      normalized = '/' + normalized;
    }
    return `file://${normalized}`;
  }

  function fileUrlToRelative(fileUrl) {
    try {
      if (typeof fileUrl !== 'string' || !fileUrl.startsWith('file://')) return null;
      let path = decodeURIComponent(fileUrl.replace(/^file:\/\//, ''));
      if (/^[A-Za-z]:\//.test(path)) path = path.replace(/^\//, '');
      const normalized = normalizePath(path);
      const root = downloadRootCache;
      if (root && normalized.startsWith(normalizePath(root))) {
        return normalized.slice(normalizePath(root).length);
      }
      const marker = '/Images/';
      const idx = normalized.indexOf(marker);
      if (idx >= 0) {
        const rel = normalized.slice(idx + 1); // 保留 Images/ 开头
        // 若未缓存根目录，则推断并保存
        if (!downloadRootCache) {
          const derivedRoot = normalized.slice(0, idx + 1);
          saveDownloadRoot(derivedRoot);
        }
        return rel;
      }
      return null;
    } catch (_) {
      return null;
    }
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
      // 如果没有 root，返回相对路径以避免生成错误的 file:///Images/...，需要用户手动设置根路径
      const fileUrl = root ? buildFileUrlFromRelative(relPath, root) : null;
      return fileUrl || relPath;
    }
    return rawUrl || rawPath || '';
  }

  function formatTimestampForPath(ts) {
    const d = new Date(ts || Date.now());
    const pad2 = (n) => String(n).padStart(2, '0');
    const monthFolder = `${d.getFullYear()}_${pad2(d.getMonth() + 1)}`;
    const dateStr = [
      d.getFullYear(),
      pad2(d.getMonth() + 1),
      pad2(d.getDate()),
      pad2(d.getHours()),
      pad2(d.getMinutes()),
      pad2(d.getSeconds())
    ].join('');
    return { monthFolder, dateStr };
  }

  async function computeBase64Hash(base64Data) {
    try {
      const data = new TextEncoder().encode(base64Data);
      const digest = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      console.warn('计算图片哈希失败，回退为长度标记:', e);
      return `len_${base64Data.length}`;
    }
  }

  async function waitForDownloadFile(downloadId, timeoutMs = 30000) {
    const start = Date.now();
    return await new Promise((resolve, reject) => {
      const tick = () => {
        try {
          chrome.downloads.search({ id: downloadId }, (items) => {
            const lastError = chrome.runtime?.lastError;
            if (lastError) return reject(new Error(lastError.message));
            const item = items && items[0];
            if (!item) return reject(new Error('找不到下载任务'));
            if (item.state === 'complete' && item.filename) return resolve(item.filename);
            if (item.state === 'interrupted') return reject(new Error(item.error || '下载被中断'));
            if (Date.now() - start > timeoutMs) return reject(new Error('下载超时'));
            setTimeout(tick, 400);
          });
        } catch (e) {
          reject(e);
        }
      };
      tick();
    });
  }

  async function saveImageContentToLocal({ base64Data, mimeType, roleFolder, timestamp }) {
    try {
      if (!chrome?.downloads?.download) return { fileUrl: null, relPath: null, hash: null };
      const ext = guessExtFromMime(mimeType) || 'png';
      const { dateStr } = formatTimestampForPath(timestamp);
      const fullHash = await computeBase64Hash(base64Data);
      const hash16 = toHash16(fullHash);
      const baseName = `${dateStr}_${hash16 || Math.random().toString(36).slice(2, 8)}`;
      const relPath = `Images/${roleFolder}/${dateStr.slice(0,4)}/${dateStr.slice(4,6)}/${dateStr.slice(6,8)}/${baseName}.${ext}`;

      // 优先尝试使用“预期文件路径”读取：若已存在同名文件则直接复用，避免重复下载
      try {
        const root = await loadDownloadRoot();
        const expectedFileUrl = root ? buildFileUrlFromRelative(relPath, root) : null;
        if (expectedFileUrl) {
          const resp = await fetch(expectedFileUrl);
          if (resp.ok) {
            return { fileUrl: expectedFileUrl, relPath, hash: fullHash };
          }
        }
      } catch (checkErr) {
        console.warn('检测既有图片文件失败，将继续下载流程:', checkErr);
      }

      const normalizedDataUrl = `data:${mimeType};base64,${base64Data}`;
      const filename = `Cerebr/${relPath}`;
      const downloadId = await new Promise((resolve, reject) => {
        chrome.downloads.download(
          { url: normalizedDataUrl, filename, conflictAction: 'overwrite', saveAs: false },
          (id) => {
            const lastError = chrome.runtime?.lastError;
            if (lastError || typeof id !== 'number') {
              reject(new Error(lastError?.message || '下载失败'));
            } else {
              resolve(id);
            }
          }
        );
      });
      const filePath = await waitForDownloadFile(downloadId);
      if (filePath) {
        const root = deriveRootFromAbsolute(filePath, relPath);
        if (root) await saveDownloadRoot(root);
      }
      return {
        fileUrl: filePath ? normalizeFileUrl(filePath) : null,
        relPath,
        hash: fullHash
      };
    } catch (error) {
      console.error('保存图片失败:', error);
      return { fileUrl: null, relPath: null, hash: null };
    }
  }

  async function saveDataUrlToLocalFile(dataUrl, roleFolder, preferredName, options = {}) {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return { fileUrl: null, relPath: null, hash: null };
    return await saveImageContentToLocal({
      base64Data: parsed.base64Data,
      mimeType: parsed.mimeType,
      roleFolder,
      timestamp: options.timestamp
    });
  }

  function toHash16(fullHash) {
    if (!fullHash || typeof fullHash !== 'string') return '';
    return fullHash.slice(0, 16);
  }

  async function blobToBase64(blob) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result || '';
        const str = typeof result === 'string' ? result : '';
        const base64 = str.split(',').pop() || '';
        resolve(base64);
      };
      reader.onerror = (e) => reject(e);
      reader.readAsDataURL(blob);
    });
  }

  async function getOrSaveDataUrlToLocalFile(dataUrl, roleFolder, options = {}) {
    // 不再根据哈希跳过保存，始终保存一份
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) return { fileUrl: null, relPath: null, hash: null };
    return await saveImageContentToLocal({
      base64Data: parsed.base64Data,
      mimeType: parsed.mimeType,
      roleFolder,
      timestamp: options.timestamp
    });
  }

  async function saveRemoteImageToLocalFile(remoteUrl, roleFolder, options = {}) {
    try {
      const resp = await fetch(remoteUrl);
      if (!resp.ok) return { fileUrl: null, relPath: null, hash: null };
      const blob = await resp.blob();
      const base64 = await blobToBase64(blob);
      const mimeType = blob.type || `image/${guessExtFromUrl(remoteUrl) || 'png'}`;
      return await saveImageContentToLocal({
        base64Data: base64,
        mimeType,
        roleFolder,
        timestamp: options.timestamp
      });
    } catch (error) {
      console.warn('下载远程图片失败，已跳过:', remoteUrl, error);
      return { fileUrl: null, relPath: null, hash: null };
    }
  }

  async function getOrSaveRemoteImage(remoteUrl, roleFolder, options = {}) {
    // 不再基于文件名去重，始终保存
    return await saveRemoteImageToLocalFile(remoteUrl, roleFolder, options);
  }

  async function replaceDataUrlsInText(text, roleFolder, options = {}) {
    if (typeof text !== 'string') return { text, changed: false, found: 0, converted: 0, failed: 0 };
    let output = text;
    let changed = false;
    let found = 0;
    let converted = 0;
    let failed = 0;
    const matches = [...text.matchAll(DATA_URL_REGEX)];
    for (const m of matches) {
      found += 1;
      const dataUrl = m[0];
      const saved = await getOrSaveDataUrlToLocalFile(dataUrl, roleFolder, options);
      const replacement = saved?.relPath || saved?.fileUrl;
      if (replacement) {
        output = output.replace(dataUrl, replacement);
        converted += 1;
        changed = true;
      } else {
        failed += 1;
      }
    }
    return { text: output, changed, found, converted, failed };
  }

  async function repairImagesInMessage(msg) {
    await loadDownloadRoot();
    const roleFolder = getImageRoleFolder(msg?.role);
    const ts = Number(msg?.timestamp) || Date.now();
    let changed = false;
    let found = 0;
    let converted = 0;
    let failed = 0;

    if (Array.isArray(msg?.content)) {
      for (const part of msg.content) {
        if (part?.type === 'image_url' && part.image_url) {
          const img = part.image_url;
          const rawUrl = typeof img.url === 'string' ? img.url : '';
          const rawPath = typeof img.path === 'string' ? img.path : '';

          // 统一处理 dataURL：既可能存在于 url，也可能误存于 path
          const dataUrl = rawUrl.startsWith('data:image/')
            ? rawUrl
            : (rawPath.startsWith('data:image/') ? rawPath : '');
          if (dataUrl) {
            found += 1;
            const saved = await getOrSaveDataUrlToLocalFile(dataUrl, roleFolder, { timestamp: ts });
            if (saved?.relPath || saved?.fileUrl) {
              if (saved.hash) img.hash = saved.hash;
              if (saved.relPath) {
                img.path = saved.relPath;
                delete img.url;
              } else if (saved.fileUrl) {
                img.url = saved.fileUrl;
                if (rawPath.startsWith('data:image/')) delete img.path;
              }
              converted += 1;
              changed = true;
            } else {
              failed += 1;
            }
            part.image_url = img;
            continue;
          }

          // 将 http/https 远程图片也落盘，避免后续备份重复拉取
          const remoteUrl = rawUrl.startsWith('http')
            ? rawUrl
            : (!rawUrl && rawPath.startsWith('http') ? rawPath : '');
          if (remoteUrl) {
            const saved = await getOrSaveRemoteImage(remoteUrl, roleFolder, { timestamp: ts });
            if (saved?.relPath || saved?.fileUrl) {
              if (saved.hash) img.hash = saved.hash;
              if (saved.relPath) {
                img.path = saved.relPath;
                delete img.url;
              } else if (saved.fileUrl) {
                img.url = saved.fileUrl;
                if (!rawUrl && rawPath.startsWith('http')) delete img.path;
              }
              converted += 1;
              changed = true;
            }
            part.image_url = img;
            continue;
          }

          // 已有本地文件但缺少哈希/相对路径时尝试补写
          const fileUrl = rawUrl.startsWith('file://')
            ? rawUrl
            : (!rawUrl && rawPath.startsWith('file://') ? rawPath : '');
          if (fileUrl) {
            if (!img.hash) {
              const h = extractHashFromFileUrl(fileUrl);
              if (h) {
                img.hash = h;
                changed = true;
              }
            }
            if (!img.path || img.path.startsWith('file://')) {
              const rel = fileUrlToRelative(fileUrl);
              if (rel) {
                img.path = rel;
                delete img.url;
                changed = true;
              }
            }
            part.image_url = img;
            continue;
          }
        } else if (part?.type === 'text' && typeof part.text === 'string') {
          const res = await replaceDataUrlsInText(part.text, roleFolder, { timestamp: ts });
          if (res.changed) {
            part.text = res.text;
            changed = true;
          }
          found += res.found;
          converted += res.converted;
          failed += res.failed;
        }
      }
    } else if (typeof msg?.content === 'string') {
      const res = await replaceDataUrlsInText(msg.content, roleFolder, { timestamp: ts });
      if (res.changed) {
        msg.content = res.text;
        changed = true;
      }
      found += res.found;
      converted += res.converted;
      failed += res.failed;
    }

    return { changed, found, converted, failed };
  }

  // ==== legacy 引用元数据（groundingMetadata）清理 ====
  /**
   * 纯函数：移除消息节点上的 legacy groundingMetadata 字段。
   * 说明：Gemini grounding 能力已下线，保留该字段只会增加存储体积与迁移负担。
   *
   * @param {any} message
   * @returns {boolean} 是否发生变更
   */
  function stripGroundingMetadataFromMessage(message) {
    if (!message || typeof message !== 'object') return false;
    if (!Object.prototype.hasOwnProperty.call(message, 'groundingMetadata')) return false;
    delete message.groundingMetadata;
    return true;
  }

  /**
   * 批量清理会话中的图片引用：
   * - 扫描所有消息，将 dataURL/base64 落盘并替换为本地路径；
   * - 可选清理 image_url.url 与 image_url.path 的冗余字段；
   * - 逐条写回会话，避免一次性加载全部会话导致内存暴涨。
   *
   * @param {Array<{id:string}>} metas
   * @param {ReturnType<typeof utils.createStepProgress>} sp
   * @param {{ progressLabel?: string, cleanImageUrls?: boolean }} options
   * @returns {Promise<{updatedConversations:number, base64Found:number, convertedImages:number, failedConversions:number, removedUrl:number, addedPath:number}>}
   */
  async function cleanImagesByMetas(metas, sp, options = {}) {
    const list = Array.isArray(metas) ? metas : [];
    const total = list.length || 1;
    const progressLabel = options.progressLabel || '处理图片';
    const cleanImageUrls = options.cleanImageUrls !== false;
    const now = Date.now();

    let updated = 0;
    let totalFound = 0;
    let totalConverted = 0;
    let totalFailed = 0;
    let removedUrl = 0;
    let addedPath = 0;

    for (let i = 0; i < list.length; i++) {
      const conv = await getConversationById(list[i].id, true);
      let convChanged = false;
      if (conv && Array.isArray(conv.messages)) {
        for (const msg of conv.messages) {
          const res = await repairImagesInMessage(msg);
          totalFound += res.found;
          totalConverted += res.converted;
          totalFailed += res.failed;
          if (res.changed) convChanged = true;
        }
        if (cleanImageUrls) {
          const cleaned = cleanImageUrlFieldsInConversation(conv);
          if (cleaned.changed) {
            convChanged = true;
            removedUrl += cleaned.removedUrl;
            addedPath += cleaned.addedPath;
          }
        }
      }

      if (convChanged && conv) {
        applyConversationMessageStats(conv);
        conv.endTime = Number(conv.endTime) || conv.endTime || now;
        await putConversation(conv);
        updateConversationInCache(conv);
        if (activeConversation?.id === conv.id) {
          activeConversation = conv;
        }
        updated += 1;
      }
      try {
        sp?.updateSub?.(i + 1, total, `${progressLabel} (${i + 1}/${total})`);
      } catch (_) {}
    }

    return {
      updatedConversations: updated,
      base64Found: totalFound,
      convertedImages: totalConverted,
      failedConversions: totalFailed,
      removedUrl,
      addedPath
    };
  }

  async function repairRecentImages(options = {}) {
    const days = Math.max(1, Number(options.days || 7));
    const now = Date.now();
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const sp = utils.createStepProgress({ steps: ['加载会话', '处理图片', '完成'], type: 'info' });
    sp.setStep(0);

    const metas = await getAllConversationMetadata();
    const recentMetas = (metas || []).filter((m) => Number(m?.endTime) >= cutoff);
    sp.next('处理图片');
    const result = await cleanImagesByMetas(recentMetas, sp, { progressLabel: '处理图片', cleanImageUrls: false });

    sp.complete('处理完成', true);
    invalidateMetadataCache();
    return {
      scannedConversations: recentMetas.length,
      updatedConversations: result.updatedConversations,
      base64Found: result.base64Found,
      convertedImages: result.convertedImages,
      failedConversions: result.failedConversions
    };
  }

  /**
   * 全量清理历史会话中的图片 base64/dataURL：
   * - 逐条会话迁移图片到本地文件（下载目录）并替换引用；
   * - 清理 image_url.url 冗余字段；
   * - 不再包含分离存储清理步骤。
   *
   * 注意：此操作会触发大量本地文件写入，耗时取决于图片数量与磁盘性能。
   */
  async function cleanAllImageDataUrlsInDb() {
    await loadDownloadRoot();
    const sp = utils.createStepProgress({ steps: ['加载会话', '处理图片', '完成'], type: 'info' });
    sp.setStep(0);

    const metas = await getAllConversationMetadata();
    sp.next('处理图片');
    const result = await cleanImagesByMetas(metas, sp, { progressLabel: '处理图片', cleanImageUrls: true });

    sp.complete('完成', true);
    invalidateMetadataCache();
    return {
      scannedConversations: metas.length,
      updatedConversations: result.updatedConversations,
      base64Found: result.base64Found,
      convertedImages: result.convertedImages,
      failedConversions: result.failedConversions,
      removedUrl: result.removedUrl,
      addedPath: result.addedPath
    };
  }

  /**
   * 清理历史会话中的 legacy 引用元数据（groundingMetadata）。
   * 说明：该字段已停止使用，此操作会批量移除它以降低存储体积与序列化开销。
   */
  async function removeGroundingMetadataInDb() {
    const sp = utils.createStepProgress({ steps: ['加载会话', '清理元数据', '完成'], type: 'info' });
    sp.setStep(0);

    const metas = await getAllConversationMetadata();
    const total = metas.length || 1;
    sp.next('清理元数据');

    let updatedConversations = 0;
    let updatedMessages = 0;

    for (let i = 0; i < metas.length; i++) {
      const conv = await getConversationById(metas[i].id, true);
      let convChanged = false;

      if (conv && Array.isArray(conv.messages)) {
        for (const msg of conv.messages) {
          if (stripGroundingMetadataFromMessage(msg)) {
            convChanged = true;
            updatedMessages += 1;
          }
        }
      }

      if (convChanged && conv) {
        applyConversationMessageStats(conv);
        await putConversation(conv);
        updateConversationInCache(conv);
        if (activeConversation?.id === conv.id) activeConversation = conv;
        updatedConversations += 1;
      }
      try {
        sp?.updateSub?.(i + 1, total, `清理元数据 (${i + 1}/${total})`);
      } catch (_) {}
    }

    sp.complete('完成', true);
    invalidateMetadataCache();
    return {
      scannedConversations: metas.length,
      updatedConversations,
      updatedMessages
    };
  }

  const SIGNATURE_CLEANUP_THRESHOLDS = [90, 60, 30, 14, 7];
  const DAY_MS = 24 * 60 * 60 * 1000;
  const META_STRING_FIELDS = [
    'thoughtsRaw',
    'thoughtSignature',
    'thoughtSignatureSource',
    'reasoning_content',
    'response_reasoning_summary',
    'preprocessOriginalText',
    'preprocessRenderedText',
    'threadSelectionText',
    'pageRuntimeContextSignature',
    'environmentContextSignature'
  ];
  const META_JSON_FIELDS = [
    'response_activity_timeline',
    'tool_calls',
    'response_tool_calls',
    'promptMeta',
    'pageMeta',
    'contextual_input_items_before',
    'contextualInputDebug'
  ];
  const TREND_METRIC_OPTIONS = [
    { value: 'totalBytes', label: '总数据量', type: 'bytes' },
    { value: 'textBytes', label: '文本数据量', type: 'bytes' },
    { value: 'messageCount', label: '消息数量', type: 'count' },
    { value: 'conversationCount', label: '对话数量', type: 'count' }
  ];
  const TREND_GRANULARITY_OPTIONS = [
    { value: 'month', label: '按月' },
    { value: 'week', label: '按周' },
    { value: 'day', label: '按天' }
  ];

  function createEmptyTrendTotals() {
    return {
      totalBytes: 0,
      textBytes: 0,
      messageCount: 0,
      conversationCount: 0
    };
  }

  function mergeTrendTotals(target, source) {
    if (!target || !source) return;
    target.totalBytes += Number(source.totalBytes) || 0;
    target.textBytes += Number(source.textBytes) || 0;
    target.messageCount += Number(source.messageCount) || 0;
    target.conversationCount += Number(source.conversationCount) || 0;
  }

  function calcJsonBytes(value, encoder) {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'string') return encoder.encode(value).length;
    try {
      return encoder.encode(JSON.stringify(value)).length;
    } catch (_) {
      return 0;
    }
  }

  function calcMessageMetaBytes(msg, encoder) {
    if (!msg || typeof msg !== 'object') return 0;
    let size = 0;
    for (const key of META_STRING_FIELDS) {
      const value = msg[key];
      if (typeof value === 'string' && value) {
        size += encoder.encode(value).length;
      }
    }
    for (const key of META_JSON_FIELDS) {
      const value = msg[key];
      if (value) size += calcJsonBytes(value, encoder);
    }
    return size;
  }

  function isImageDataUrl(value) {
    if (typeof value !== 'string') return false;
    return value.trim().toLowerCase().startsWith('data:image/');
  }

  function estimateBase64SizeFromDataUrl(dataUrl) {
    if (typeof dataUrl !== 'string' || !dataUrl) return 0;
    const commaIndex = dataUrl.indexOf(',');
    const base64 = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
    return Math.round((base64.length * 3) / 4);
  }

  function measureImageUrlBytes(imageUrl, encoder) {
    if (!imageUrl || typeof imageUrl !== 'object') {
      return { textSize: 0, imageSize: 0 };
    }
    let textSize = 0;
    let imageSize = 0;
    const url = (typeof imageUrl.url === 'string') ? imageUrl.url : '';
    const path = (typeof imageUrl.path === 'string') ? imageUrl.path : '';
    if (url) {
      if (isImageDataUrl(url)) {
        imageSize += estimateBase64SizeFromDataUrl(url);
      } else {
        textSize += encoder.encode(url).length;
      }
    }
    if (path && path !== url) {
      if (isImageDataUrl(path)) {
        imageSize += estimateBase64SizeFromDataUrl(path);
      } else {
        textSize += encoder.encode(path).length;
      }
    }
    return { textSize, imageSize };
  }

  function measureMessageContentBytes(content, encoder) {
    let textBytes = 0;
    let imageBytes = 0;
    if (typeof content === 'string') {
      textBytes += encoder.encode(content).length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part) continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          textBytes += encoder.encode(part.text).length;
        } else if (part.type === 'image_url' && part.image_url) {
          const sizes = measureImageUrlBytes(part.image_url, encoder);
          textBytes += sizes.textSize;
          imageBytes += sizes.imageSize;
        }
      }
    }
    return { textBytes, imageBytes };
  }

  // 统计单条会话中“文本/总量/消息数”体积，用于趋势图汇总
  function measureConversationTotals(conversation, encoder) {
    const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
    let textBytes = 0;
    let imageBytes = 0;
    let metaBytes = 0;
    for (const msg of messages) {
      const contentSizes = measureMessageContentBytes(msg?.content, encoder);
      textBytes += contentSizes.textBytes;
      imageBytes += contentSizes.imageBytes;
      metaBytes += calcMessageMetaBytes(msg, encoder);
    }
    return {
      totalBytes: textBytes + imageBytes + metaBytes,
      textBytes,
      messageCount: messages.length,
      conversationCount: conversation ? 1 : 0
    };
  }

  function formatByteSize(bytes) {
    const value = Number(bytes) || 0;
    if (value === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    const size = value / Math.pow(1024, index);
    return `${size.toFixed(2)} ${units[index]}`;
  }

  function getByteUnitInfo(bytes) {
    const value = Number(bytes) || 0;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    if (value <= 0) {
      return { index: 0, base: 1, unit: units[0] };
    }
    const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    return { index, base: Math.pow(1024, index), unit: units[index] };
  }

  function formatByteSizeWithUnit(bytes, unitInfo, decimals = 2) {
    const info = unitInfo || getByteUnitInfo(bytes);
    const value = Number(bytes) || 0;
    if (value === 0) return `0 ${info.unit}`;
    const size = value / info.base;
    return `${size.toFixed(decimals)} ${info.unit}`;
  }

  function formatTrendValue(metric, value) {
    if (metric?.type === 'bytes') return formatByteSize(value);
    return Number(value || 0).toLocaleString();
  }

  function getTrendMetricOption(metricValue) {
    return TREND_METRIC_OPTIONS.find(item => item.value === metricValue) || TREND_METRIC_OPTIONS[0];
  }

  function getTrendGranularityOption(granularityValue) {
    return TREND_GRANULARITY_OPTIONS.find(item => item.value === granularityValue) || TREND_GRANULARITY_OPTIONS[0];
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function formatDateKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function formatMonthKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
  }

  function formatFullDateLabel(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function formatShortDateLabel(date, includeYear) {
    if (includeYear) return formatFullDateLabel(date);
    return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function formatMonthLabel(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
  }

  function getBucketStartDate(ts, granularity) {
    const date = new Date(Number(ts) || 0);
    date.setHours(0, 0, 0, 0);
    if (granularity === 'month') {
      date.setDate(1);
    } else if (granularity === 'week') {
      const offset = (date.getDay() + 6) % 7;
      date.setDate(date.getDate() - offset);
    }
    return date;
  }

  function accumulateTrendBucket(map, ts, totals, granularity) {
    const start = getBucketStartDate(ts, granularity);
    const key = granularity === 'month' ? formatMonthKey(start) : formatDateKey(start);
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { key, startTime: start.getTime(), totals: createEmptyTrendTotals() };
      map.set(key, bucket);
    }
    mergeTrendTotals(bucket.totals, totals);
  }

  function buildTrendLabelInfo(date, granularity, includeYear) {
    if (granularity === 'month') {
      const label = formatMonthLabel(date);
      return { label, fullLabel: label };
    }
    if (granularity === 'week') {
      const end = new Date(date.getTime());
      end.setDate(end.getDate() + 6);
      return {
        label: formatShortDateLabel(date, includeYear),
        fullLabel: `周 ${formatFullDateLabel(date)} ~ ${formatFullDateLabel(end)}`
      };
    }
    return {
      label: formatShortDateLabel(date, includeYear),
      fullLabel: formatFullDateLabel(date)
    };
  }

  function buildTrendBuckets(map, granularity) {
    const items = Array.from(map.values()).sort((a, b) => a.startTime - b.startTime);
    if (items.length === 0) return [];
    const minDate = new Date(items[0].startTime);
    const maxDate = new Date(items[items.length - 1].startTime);
    const includeYear = minDate.getFullYear() !== maxDate.getFullYear();
    const mapByKey = new Map(items.map(item => [item.key, item]));
    const buckets = [];
    const cursor = new Date(minDate.getTime());

    while (cursor.getTime() <= maxDate.getTime()) {
      const key = granularity === 'month' ? formatMonthKey(cursor) : formatDateKey(cursor);
      const existing = mapByKey.get(key);
      const totals = existing ? existing.totals : createEmptyTrendTotals();
      const labelInfo = buildTrendLabelInfo(cursor, granularity, includeYear);
      buckets.push({
        key,
        startTime: cursor.getTime(),
        totals,
        label: labelInfo.label,
        fullLabel: labelInfo.fullLabel
      });

      if (granularity === 'month') {
        cursor.setMonth(cursor.getMonth() + 1);
      } else if (granularity === 'week') {
        cursor.setDate(cursor.getDate() + 7);
      } else {
        cursor.setDate(cursor.getDate() + 1);
      }
    }
    return buckets;
  }

  function computeTrendLabelStep(count) {
    if (count <= 12) return 1;
    if (count <= 24) return 2;
    if (count <= 60) return 4;
    if (count <= 120) return 7;
    return 14;
  }

  // 让纵轴刻度对齐到常用“整/半/四分之一”等数值
  function getNiceStep(rawStep) {
    if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
    const exponent = Math.floor(Math.log10(rawStep));
    const base = Math.pow(10, exponent);
    const fraction = rawStep / base;
    let niceFraction = 1;
    if (fraction <= 1) {
      niceFraction = 1;
    } else if (fraction <= 2) {
      niceFraction = 2;
    } else if (fraction <= 2.5) {
      niceFraction = 2.5;
    } else if (fraction <= 5) {
      niceFraction = 5;
    } else {
      niceFraction = 10;
    }
    return niceFraction * base;
  }

  function getStepDecimals(step) {
    if (!Number.isFinite(step) || step <= 0) return 0;
    const text = step.toString();
    if (text.includes('e-')) {
      const exp = Number(text.split('e-')[1]);
      return Number.isFinite(exp) ? Math.min(exp, 6) : 0;
    }
    const dotIndex = text.indexOf('.');
    if (dotIndex < 0) return 0;
    return Math.min(text.length - dotIndex - 1, 6);
  }

  function buildTrendTicks(maxValue, targetTickCount = 4) {
    if (!Number.isFinite(maxValue) || maxValue <= 0) {
      return {
        maxValue: 0,
        step: 0,
        ticks: [
          { value: 0, ratio: 0 },
          { value: 0, ratio: 1 }
        ]
      };
    }
    const rawStep = maxValue / Math.max(1, targetTickCount);
    const step = getNiceStep(rawStep);
    const tickCount = Math.max(1, Math.ceil(maxValue / step));
    const niceMax = step * tickCount;
    const ticks = [];
    for (let i = 0; i <= tickCount; i++) {
      const value = step * i;
      ticks.push({ value, ratio: niceMax > 0 ? value / niceMax : 0 });
    }
    return { maxValue: niceMax, step, ticks };
  }

  function bindTrendWheelScroll(targetEl) {
    if (!targetEl) return;
    const chartEl = targetEl.querySelector('.backup-trend-chart');
    const plotArea = targetEl.querySelector('.backup-trend-plot-area');
    if (!chartEl || !plotArea) return;
    chartEl.addEventListener('wheel', (event) => {
      if (plotArea.scrollWidth <= plotArea.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      plotArea.scrollLeft += delta;
      event.preventDefault();
    }, { passive: false });
  }

  async function computeTrendStats() {
    const sp = utils.createStepProgress({ steps: ['加载元数据', '扫描会话', '汇总数据', '完成'], type: 'info' });
    sp.setStep(0);

    const metas = await getAllConversationMetadataWithCache(false);
    const encoder = new TextEncoder();
    const total = metas.length || 1;
    const bucketMaps = {
      month: new Map(),
      week: new Map(),
      day: new Map()
    };
    let scanned = 0;
    let missingEndTime = 0;

    sp.next('扫描会话');
    for (const meta of metas) {
      scanned += 1;
      if (scanned % 20 === 0 || scanned === total) {
        sp.updateSub(scanned, total, `扫描会话 (${scanned}/${total})`);
      }
      const id = meta?.id;
      if (!id) continue;
      const endTime = Number(meta?.endTime) || Number(meta?.startTime) || 0;
      if (!endTime) {
        missingEndTime += 1;
        continue;
      }
      const conv = await getConversationById(id, true);
      if (!conv) continue;
      const totals = measureConversationTotals(conv, encoder);
      accumulateTrendBucket(bucketMaps.month, endTime, totals, 'month');
      accumulateTrendBucket(bucketMaps.week, endTime, totals, 'week');
      accumulateTrendBucket(bucketMaps.day, endTime, totals, 'day');
    }

    sp.next('汇总数据');
    const buckets = {
      month: buildTrendBuckets(bucketMaps.month, 'month'),
      week: buildTrendBuckets(bucketMaps.week, 'week'),
      day: buildTrendBuckets(bucketMaps.day, 'day')
    };
    sp.next('完成');
    sp.complete('完成', true);

    return {
      buckets,
      scannedConversations: metas.length,
      missingEndTime,
      updatedAt: Date.now()
    };
  }

  async function getTrendStatsCached(forceUpdate = false) {
    const stale = forceUpdate || !trendStatsCache.data || (Date.now() - trendStatsCache.time > TREND_STATS_TTL);
    if (!stale) return trendStatsCache.data;
    if (trendStatsCache.promise) {
      try {
        return await trendStatsCache.promise;
      } catch (_) {
        // 若上一次失败，继续走新的计算逻辑
      }
    }
    trendStatsCache.promise = (async () => {
      const data = await computeTrendStats();
      trendStatsCache.data = data;
      trendStatsCache.time = Date.now();
      return data;
    })();
    try {
      return await trendStatsCache.promise;
    } finally {
      trendStatsCache.promise = null;
    }
  }

  function renderTrendChart(targetEl, data, options = {}) {
    if (!targetEl) return;
    if (!data?.buckets) {
      targetEl.innerHTML = '<div class="backup-trend-empty">点击“生成图表”以查看趋势</div>';
      return;
    }

    const metric = getTrendMetricOption(options.metric);
    const granularity = getTrendGranularityOption(options.granularity);
    const buckets = data.buckets?.[granularity.value] || [];

    if (!buckets.length) {
      targetEl.innerHTML = '<div class="backup-trend-empty">暂无可展示的数据</div>';
      return;
    }

    const values = buckets.map(bucket => Number(bucket.totals?.[metric.value]) || 0);
    const maxValue = values.length ? Math.max(...values) : 0;
    const labelStep = computeTrendLabelStep(buckets.length);
    let ticks = [];
    let axisMaxValue = 0;
    let axisFormatter = (value) => formatTrendValue(metric, value);
    if (metric.type === 'bytes') {
      const unitInfo = getByteUnitInfo(maxValue);
      const tickInfo = buildTrendTicks(maxValue / unitInfo.base, 4);
      const axisDecimals = getStepDecimals(tickInfo.step);
      axisMaxValue = tickInfo.maxValue * unitInfo.base;
      ticks = tickInfo.ticks.map((tick) => ({
        ratio: tick.ratio,
        value: tick.value * unitInfo.base
      }));
      axisFormatter = (value) => formatByteSizeWithUnit(value, unitInfo, axisDecimals);
    } else {
      const tickInfo = buildTrendTicks(maxValue, 4);
      ticks = tickInfo.ticks;
      axisMaxValue = tickInfo.maxValue;
    }
    const axisHtml = ticks.map((tick) => {
      const percent = (tick.ratio * 100).toFixed(2);
      return `
        <div class="backup-trend-axis-tick" style="--tick-percent:${percent};">
          ${axisFormatter(tick.value)}
        </div>
      `;
    }).join('');
    const gridHtml = ticks.map((tick) => (
      `<div class="backup-trend-grid-line" style="--tick-percent:${(tick.ratio * 100).toFixed(2)};"></div>`
    )).join('');
    const barsHtml = buckets.map((bucket) => {
      const value = Number(bucket.totals?.[metric.value]) || 0;
      const percent = axisMaxValue > 0 ? (value / axisMaxValue) * 100 : 0;
      const formattedValue = formatTrendValue(metric, value);
      const title = `${bucket.fullLabel} · ${metric.label} ${formattedValue}`;
      return `
        <div class="backup-trend-bar" title="${title}" style="--bar-percent:${percent.toFixed(2)};">
          <div class="backup-trend-bar-track">
            <div class="backup-trend-bar-fill"></div>
          </div>
        </div>
      `;
    }).join('');
    const labelsHtml = buckets.map((bucket, index) => {
      const label = index % labelStep === 0 ? bucket.label : '';
      return `<div class="backup-trend-label">${label ? label : ''}</div>`;
    }).join('');

    const totalValue = values.reduce((sum, v) => sum + v, 0);
    const summaryParts = [];
    if (buckets.length) {
      const rangeStart = new Date(buckets[0].startTime);
      const rangeEnd = new Date(buckets[buckets.length - 1].startTime);
      const rangeText = granularity.value === 'month'
        ? `${buckets[0].label} ~ ${buckets[buckets.length - 1].label}`
        : `${formatFullDateLabel(rangeStart)} ~ ${formatFullDateLabel(rangeEnd)}`;
      summaryParts.push(`范围 ${rangeText}`);
    }
    summaryParts.push(`总计(${metric.label}) ${formatTrendValue(metric, totalValue)}`);
    if (data.scannedConversations !== undefined) summaryParts.push(`扫描 ${data.scannedConversations} 会话`);
    if (data.missingEndTime) summaryParts.push(`缺少时间 ${data.missingEndTime}`);
    if (data.updatedAt) summaryParts.push(`更新时间 ${new Date(data.updatedAt).toLocaleString()}`);

    targetEl.innerHTML = `
      <div class="backup-trend-chart">
        <div class="backup-trend-plot">
          <div class="backup-trend-axis">${axisHtml}</div>
          <div class="backup-trend-plot-area" data-granularity="${granularity.value}">
            <div class="backup-trend-grid">${gridHtml}</div>
            <div class="backup-trend-bars">${barsHtml}</div>
            <div class="backup-trend-labels">${labelsHtml}</div>
          </div>
        </div>
        <div class="backup-trend-summary">${summaryParts.join(' · ')}</div>
      </div>
    `;
    bindTrendWheelScroll(targetEl);
  }

  /**
   * 清理历史中的推理签名（thoughtSignature / thoughtSignatureSource），可按时间与置顶过滤
   * @param {{minAgeDays?:number, excludePinned?:boolean}} options
   */
  async function removeThoughtSignatureInDb(options = {}) {
    const minAgeDays = Math.max(0, Number(options.minAgeDays || 0));
    const excludePinned = options.excludePinned !== false;
    const sp = utils.createStepProgress({ steps: ['加载会话', '清理签名', '完成'], type: 'info' });
    sp.setStep(0);

    const metas = await getAllConversationMetadata();
    const pinnedIds = excludePinned ? new Set(await getPinnedIds()) : new Set();
    const now = Date.now();
    const cutoff = minAgeDays > 0 ? (now - minAgeDays * DAY_MS) : null;
    const targetMetas = [];
    let skippedPinned = 0;
    let skippedRecent = 0;
    let missingEndTime = 0;

    for (const meta of metas) {
      const id = meta?.id;
      if (!id) continue;
      if (excludePinned && pinnedIds.has(id)) {
        skippedPinned += 1;
        continue;
      }
      const endTime = Number(meta?.endTime) || Number(meta?.startTime) || 0;
      if (!endTime) {
        missingEndTime += 1;
        continue;
      }
      if (cutoff && endTime >= cutoff) {
        skippedRecent += 1;
        continue;
      }
      targetMetas.push(meta);
    }
    const total = targetMetas.length || 1;
    sp.next('清理签名');

    let updatedConversations = 0;
    let updatedMessages = 0;

    for (let i = 0; i < targetMetas.length; i++) {
      const conv = await getConversationById(targetMetas[i].id, true);
      let convChanged = false;

      if (conv && Array.isArray(conv.messages)) {
        const result = removeThoughtSignatureFromMessages(conv.messages);
        if (result.changed) {
          updatedMessages += Number(result.removedMessages) || 0;
          convChanged = true;
        }
      }

      if (convChanged && conv) {
        applyConversationMessageStats(conv);
        await putConversation(conv);
        updateConversationInCache(conv);
        if (activeConversation?.id === conv.id) activeConversation = conv;
        updatedConversations += 1;
      }
      try {
        sp?.updateSub?.(i + 1, total, `清理签名 (${i + 1}/${total})`);
      } catch (_) {}
    }

    sp.complete('完成', true);
    invalidateMetadataCache();
    return {
      scannedConversations: metas.length,
      targetConversations: targetMetas.length,
      skippedPinned,
      skippedRecent,
      missingEndTime,
      updatedConversations,
      updatedMessages
    };
  }

  /**
   * 重新按 YYYY/MM/DD/HHMMSS_hash16 命名保存图片并更新路径/哈希
   * @param {{days?:number}} options
   */
  async function resaveImagesWithNewScheme(options = {}) {
    await loadDownloadRoot();
    const days = Math.max(1, Number(options.days || 365));
    const now = Date.now();
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const sp = utils.createStepProgress({ steps: ['加载会话', '重新保存', '完成'], type: 'info' });
    sp.setStep(0);

    const metas = await getAllConversationMetadata();
    const recentMetas = (metas || []).filter((m) => Number(m?.endTime) >= cutoff);
    const total = recentMetas.length || 1;
    let updated = 0;

    sp.next('重新保存');
    console.info('[resaveImagesWithNewScheme] start', { metas: metas.length, filtered: recentMetas.length, days });
    for (let i = 0; i < recentMetas.length; i++) {
      const conv = await getConversationById(recentMetas[i].id, true);
      let convChanged = false;
      if (conv && Array.isArray(conv.messages)) {
        for (const msg of conv.messages) {
          if (!Array.isArray(msg.content)) continue;
          const ts = Number(msg?.timestamp) || Number(conv?.endTime) || Date.now();
          for (const part of msg.content) {
            if (part?.type !== 'image_url') continue;
            const raw = part.image_url?.path || part.image_url?.url || '';
            if (!raw) continue;
            try {
              let fileUrl = raw;
              if (!fileUrl.startsWith('http') && !fileUrl.startsWith('data:') && !fileUrl.startsWith('file://')) {
                const root = await loadDownloadRoot();
                fileUrl = root ? buildFileUrlFromRelative(raw, root) : null;
              }
              const resolved = await resolveToFileUrlForResave(fileUrl);
              if (!resolved) continue;
              const resp = await fetch(resolved);
              if (!resp.ok) continue;
              const blob = await resp.blob();
              const base64 = await blobToBase64(blob);
              const mimeType = blob.type || 'image/png';
              const saved = await saveImageContentToLocal({
                base64Data: base64,
                mimeType,
                roleFolder: getImageRoleFolder(msg.role),
                timestamp: ts
              });
              if (saved?.relPath) {
                part.image_url.path = saved.relPath;
                part.image_url.url = saved.relPath;
                if (saved.hash) part.image_url.hash = saved.hash;
                convChanged = true;
                console.info('[resaveImagesWithNewScheme] resaved', { convId: conv.id, msgId: msg.id, relPath: saved.relPath });
              }
            } catch (e) {
              console.warn('[resaveImagesWithNewScheme] skip image', { convId: conv.id, msgId: msg.id, raw, error: e?.message || e });
            }
          }
        }
      }
      if (convChanged) {
        await putConversation(conv);
        updateConversationInCache(conv);
        if (activeConversation?.id === conv.id) activeConversation = conv;
        updated += 1;
      }
      sp.updateSub(i + 1, total, `重新保存 (${i + 1}/${total})`);
    }
    sp.complete('完成', true);
    invalidateMetadataCache();
    const result = { updatedConversations: updated, scanned: recentMetas.length };
    console.info('[resaveImagesWithNewScheme] done', result);
    return result;
  }

  async function resolveToFileUrlForResave(rawUrl) {
    if (!rawUrl) return null;
    if (rawUrl.startsWith('file://') || rawUrl.startsWith('data:') || rawUrl.startsWith('http')) return rawUrl;
    const root = await loadDownloadRoot();
    return root ? buildFileUrlFromRelative(rawUrl, root) : null;
  }

  /**
   * 将现有消息中的 file:// 图片引用迁移为相对路径（Images/...），同时补写哈希（仅纯十六进制文件名）
   * @returns {Promise<{updated:number, scanned:number}>}
   */
  async function migrateImagePathsToRelative() {
    await loadDownloadRoot();
    const sp = utils.createStepProgress({ steps: ['加载会话', '迁移路径', '完成'], type: 'info' });
    sp.setStep(0);

    const metas = await getAllConversationMetadata();
    const total = metas.length || 1;
    let updated = 0;

    sp.next('迁移路径');
    for (let i = 0; i < metas.length; i++) {
      const conv = await getConversationById(metas[i].id, true);
      let convChanged = false;
      if (conv && Array.isArray(conv.messages)) {
        for (const msg of conv.messages) {
          if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part?.type === 'image_url' && part.image_url?.url && !part.image_url?.path) {
                const rel = fileUrlToRelative(part.image_url.url);
                if (rel) {
                  part.image_url.path = rel;
                  part.image_url.url = rel;
                  const h = extractHashFromFileUrl(part.image_url.url);
                  if (h) part.image_url.hash = h;
                  convChanged = true;
                }
              }
            }
          }
        }
      }
      if (convChanged) {
        await putConversation(conv);
        updateConversationInCache(conv);
        if (activeConversation?.id === conv.id) activeConversation = conv;
        updated += 1;
      }
      sp.updateSub(i + 1, total, `迁移路径 (${i + 1}/${total})`);
    }

    sp.complete('完成', true);
    invalidateMetadataCache();
    return { updated, scanned: metas.length };
  }

  /**
   * 检查 image_url.path 与 image_url.url 的一致性，统计差异并给出示例
   * @param {number} [sampleLimit=20]
   * @returns {Promise<{total:number, same:number, mismatch:number, pathOnly:number, urlOnly:number, samples:Array<Object>, urlOnlySamples:Array<Object>}>}
   */
  async function checkImagePathUrlMismatch(sampleLimit = 20) {
    const metas = await getAllConversationMetadata();
    let total = 0;
    let same = 0;
    let mismatch = 0;
    let pathOnly = 0;
    let urlOnly = 0;
    const samples = [];
    const urlOnlySamples = [];

    const normalizeRel = (p) => normalizePath(p || '').replace(/^\/+/, '');
    const normalizeUrl = (u) => {
      if (!u) return '';
      if (u.startsWith('file://')) {
        let p = decodeURIComponent(u.replace(/^file:\/\//, ''));
        if (/^[A-Za-z]:\//.test(p)) p = p.replace(/^\//, '');
        return normalizeRel(p);
      }
      return normalizeRel(u);
    };

    for (const meta of metas) {
      const conv = await getConversationById(meta.id, true);
      if (!conv || !Array.isArray(conv.messages)) continue;
      for (const msg of conv.messages) {
        if (!Array.isArray(msg.content)) continue;
        for (const part of msg.content) {
          if (part?.type !== 'image_url') continue;
          total += 1;
          const rawPath = part.image_url?.path || '';
          const rawUrl = part.image_url?.url || '';
          const normPath = normalizeRel(rawPath);
          const normUrl = normalizeUrl(rawUrl);
          if (normPath && normUrl) {
            if (normUrl.endsWith(normPath)) {
              same += 1;
            } else {
              mismatch += 1;
              if (samples.length < sampleLimit) {
                samples.push({
                  conversationId: conv.id,
                  messageId: msg.id,
                  path: rawPath,
                  url: rawUrl
                });
              }
            }
          } else if (normPath && !normUrl) {
            pathOnly += 1;
          } else if (!normPath && normUrl) {
            urlOnly += 1;
            if (urlOnlySamples.length < sampleLimit) {
              urlOnlySamples.push({
                conversationId: conv.id,
                messageId: msg.id,
                url: rawUrl
              });
            }
          }
        }
      }
    }

    return { total, same, mismatch, pathOnly, urlOnly, samples, urlOnlySamples };
  }

  /**
   * 清理单条会话中的 image_url 字段冗余：
   * - 尝试将 file:// 或相对 url 补写为 path，确保持久化字段统一；
   * - 若 path 已存在且 url 等价，则移除 url，避免重复占用存储空间。
   *
   * 注意：
   * - 这里直接在传入对象上原地修改，避免在超大数据集上额外拷贝导致内存暴涨；
   * - 调用方负责在必要时执行 putConversation 持久化。
   *
   * @param {Object} conversation
   * @returns {{ changed: boolean, removedUrl: number, addedPath: number }}
   */
  function cleanImageUrlFieldsInConversation(conversation) {
    let changed = false;
    let removedUrl = 0;
    let addedPath = 0;
    const normalizeRel = (p) => normalizePath(p || '').replace(/^\/+/, '');
    if (!conversation || !Array.isArray(conversation.messages)) {
      return { changed, removedUrl, addedPath };
    }

    for (const msg of conversation.messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const part of msg.content) {
        if (part?.type !== 'image_url') continue;
        const img = part.image_url || {};
        const rawUrl = typeof img.url === 'string' ? img.url : '';
        const rawPath = typeof img.path === 'string' ? img.path : '';
        const isDataUrl = rawUrl.startsWith('data:') || rawPath.startsWith('data:');
        let relPath = normalizeRel(rawPath);

        if (rawPath.startsWith('file://')) {
          const relFromFile = fileUrlToRelative(rawPath);
          if (relFromFile) {
            img.path = relFromFile;
            relPath = normalizeRel(relFromFile);
            addedPath += 1;
            changed = true;
          }
        }

        if (!relPath && rawUrl && !isDataUrl) {
          const derived = rawUrl.startsWith('file://')
            ? fileUrlToRelative(rawUrl)
            : normalizeRel(rawUrl);
          if (derived) {
            img.path = derived;
            relPath = derived;
            addedPath += 1;
            changed = true;
          }
        }

        if (relPath && rawUrl && !isDataUrl) {
          const normUrl = rawUrl.startsWith('file://')
            ? normalizeRel(fileUrlToRelative(rawUrl) || '')
            : normalizeRel(rawUrl);
          if (!normUrl || normUrl.endsWith(relPath)) {
            delete img.url;
            removedUrl += 1;
            changed = true;
          }
        }

        part.image_url = img;
      }
    }

    return { changed, removedUrl, addedPath };
  }

  /**
   * 清理 image_url 中重复的 url 字段：
   * - 尝试从 file:// 或相对 url 补全 path
   * - 若 path 存在且 url 相同则移除 url
   */
  async function cleanImageUrlFields() {
    await loadDownloadRoot();
    const metas = await getAllConversationMetadata();
    let updated = 0;
    let removedUrl = 0;
    let addedPath = 0;

    for (const meta of metas) {
      const conv = await getConversationById(meta.id, true);
      let convChanged = false;
      if (!conv || !Array.isArray(conv.messages)) continue;

      const cleaned = cleanImageUrlFieldsInConversation(conv);
      if (cleaned.changed) {
        convChanged = true;
        removedUrl += cleaned.removedUrl;
        addedPath += cleaned.addedPath;
      }

      if (convChanged) {
        await putConversation(conv);
        updateConversationInCache(conv);
        if (activeConversation?.id === conv.id) activeConversation = conv;
        updated += 1;
      }
    }

    invalidateMetadataCache();
    return { updatedConversations: updated, removedUrl, addedPath };
  }

  /**
   * 工具：读取备份文件文本，支持 .json 及 .json.gz
   * @param {File} file
   * @returns {Promise<string>}
   */
  async function readBackupFileAsText(file) {
    // gzip 场景
    if (/\.gz$/i.test(file.name)) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('当前环境不支持解压 .gz 文件，请导入 .json 备份');
      }
      const ds = new DecompressionStream('gzip');
      const decompressed = file.stream().pipeThrough(ds);
      return await new Response(decompressed).text();
    }
    // 常规 JSON
    return await file.text();
  }

  // ==== 仅下载方案的备份偏好 ====
  const BACKUP_PREFS_KEY = 'chat_backup_prefs';
  async function loadBackupPreferencesDownloadsOnly() {
    const defaults = {
      incrementalDefault: true,
      excludeImagesDefault: false,
      compressDefault: true,
      autoBackupEnabled: false,
      autoBackupIntervalMin: 60,
      autoBackupMode: 'hourly', // 'hourly' | 'daily'
      autoBackupHourlyHours: 1, // 每N小时
      autoBackupDailyTime: '02:00', // 每天固定时间 HH:MM
      lastIncrementalBackupAt: 0,
      lastFullBackupAt: 0,
      lastFullResetBackupAt: 0,
      incSequence: 0
    };
    const prefs = await storageService.getJSON(BACKUP_PREFS_KEY, defaults, { area: 'sync' });
    return { ...defaults, ...prefs };
  }
  async function saveBackupPreferencesDownloadsOnly(prefs) {
    const current = await loadBackupPreferencesDownloadsOnly();
    const merged = { ...current, ...prefs };
    await storageService.setJSON(BACKUP_PREFS_KEY, merged, { area: 'sync' });
    return merged;
  }

  function getExtensionStateDomainLabel(domain) {
    return domain === EXTENSION_STATE_BACKUP_DOMAIN_API ? 'API 状态' : '杂项设置';
  }

  function summarizeExtensionStateRestoreResult(result) {
    if (!result || typeof result !== 'object') return '未返回写回摘要';
    const parts = [];

    const appendAreaSummary = (groupLabel, groupValue) => {
      if (!groupValue || typeof groupValue !== 'object') return;
      for (const [areaName, areaResult] of Object.entries(groupValue)) {
        const removed = Array.isArray(areaResult?.removedKeys) ? areaResult.removedKeys.length : 0;
        const written = Array.isArray(areaResult?.writtenKeys) ? areaResult.writtenKeys.length : 0;
        parts.push(`${groupLabel}.${areaName} 删除 ${removed} 项 / 写入 ${written} 项`);
      }
    };

    appendAreaSummary('chrome.storage', result.chromeStorage);
    appendAreaSummary('window', result.windowStorage);
    return parts.join('；') || '未写入任何条目';
  }

  async function confirmExtensionStateRestore(domain) {
    const label = getExtensionStateDomainLabel(domain);
    const confirmFn = appContext?.utils?.showConfirm;
    if (typeof confirmFn === 'function') {
      return await confirmFn({
        message: `确认恢复${label}？`,
        description: `将覆盖当前扩展的${label}（仅 sync/local/localStorage，不包含聊天记录 / IndexedDB），恢复完成后会自动刷新侧栏。`,
        confirmText: '开始恢复',
        cancelText: '取消',
        type: 'warning'
      });
    }
    return window.confirm(`将覆盖当前扩展的${label}（不包含聊天记录 / IndexedDB），恢复完成后会自动刷新侧栏，是否继续？`);
  }

  async function exportExtensionStateBackup(domain) {
    const label = getExtensionStateDomainLabel(domain);
    const steps = ['读取扩展存储', '构建备份文件', '保存文件', '完成'];
    const sp = utils.createStepProgress({ steps, type: 'info' });
    sp.setStep(0);

    try {
      const snapshot = await createExtensionStateBackupSnapshot({ domain });
      sp.next('构建备份文件');

      const prefs = await loadBackupPreferencesDownloadsOnly();
      const preferredCompress = prefs.compressDefault !== false;
      const { blob } = await buildBackupBlob(snapshot, preferredCompress);
      const isCompressed = blob.type === 'application/gzip';
      const filename = buildExtensionStateBackupFilename({ domain, compress: isCompressed });

      sp.next('保存文件');
      await triggerBlobDownload(blob, filename);
      sp.next('完成');
      sp.complete(`${label}备份完成`, true);
    } catch (error) {
      console.error(`导出${label}备份失败:`, error);
      sp.fail?.(`${label}备份失败`);
      showNotification?.({
        message: `${label}备份失败`,
        description: String(error?.message || error),
        type: 'error',
        duration: 3200
      });
    }
  }

  async function restoreExtensionStateBackup(domain) {
    const label = getExtensionStateDomainLabel(domain);
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.gz,application/json,application/gzip';
    input.multiple = false;

    input.addEventListener('change', async () => {
      const file = input.files?.[0] || null;
      if (!file) return;

      const steps = ['读取文件', '校验备份', '写回存储', '刷新侧栏'];
      const sp = utils.createStepProgress({ steps, type: 'warning' });
      sp.setStep(0);

      try {
        const text = await readBackupFileAsText(file);
        sp.next('校验备份');

        const parsed = JSON.parse(text);
        const snapshot = parseExtensionStateBackupSnapshot(parsed, { expectedDomain: domain });
        const confirmed = await confirmExtensionStateRestore(domain);
        if (!confirmed) {
          sp.complete('已取消恢复', true);
          return;
        }

        sp.next('写回存储');
        const restoreResult = await restoreExtensionStateBackupSnapshot(snapshot, { expectedDomain: domain });
        const summary = summarizeExtensionStateRestoreResult(restoreResult);

        sp.next('刷新侧栏');
        sp.complete(`${label}恢复完成，准备刷新`, true);
        showNotification?.({
          message: `${label}恢复完成`,
          description: summary,
          type: 'success',
          duration: 2600
        });

        setTimeout(() => {
          try {
            window.location.reload();
          } catch (_) {}
        }, 180);
      } catch (error) {
        console.error(`恢复${label}备份失败:`, error);
        sp.fail?.(`${label}恢复失败`);
        showNotification?.({
          message: `${label}恢复失败`,
          description: String(error?.message || error),
          type: 'error',
          duration: 3600
        });
      }
    }, { once: true });

    input.click();
  }

  // 已移除目录授权/直写方案，统一使用下载 API

  // ==== UI：在聊天记录面板添加“备份与恢复”标签页 ====
  // 在渲染面板的逻辑中（创建 tabs 处）插入一个设置页
  function renderBackupSettingsPanelDownloadsOnly() {
    const container = document.createElement('div');
    container.className = 'backup-settings-panel';

    const makeRow = (extraClass = '') => {
      const row = document.createElement('div');
      row.className = 'backup-form-row' + (extraClass ? ' ' + extraClass : '');
      return row;
    };

    const quickSection = document.createElement('div');
    quickSection.className = 'backup-section';

    const quickTitle = document.createElement('div');
    quickTitle.className = 'backup-panel-title';
    quickTitle.textContent = '快捷操作';
    quickSection.appendChild(quickTitle);

    const quickButtons = document.createElement('div');
    quickButtons.className = 'backup-button-group';

    const quickBackupBtn = document.createElement('button');
    quickBackupBtn.className = 'backup-button';
    quickBackupBtn.textContent = '立即备份';
    quickButtons.appendChild(quickBackupBtn);

    const importButton = document.createElement('button');
    importButton.className = 'backup-button';
    importButton.textContent = '从剪贴板导入';
    importButton.title = '从剪贴板导入一条新的聊天记录';
    quickButtons.appendChild(importButton);

    const restoreButton = document.createElement('button');
    restoreButton.className = 'backup-button';
    restoreButton.textContent = '从备份恢复';
    quickButtons.appendChild(restoreButton);

    quickSection.appendChild(quickButtons);
    container.appendChild(quickSection);

    const manualSection = document.createElement('div');
    manualSection.className = 'backup-section';

    const manualTitle = document.createElement('div');
    manualTitle.className = 'backup-panel-subtitle';
    manualTitle.textContent = '备份方式';
    manualSection.appendChild(manualTitle);

    const manualButtons = document.createElement('div');
    manualButtons.className = 'backup-button-group';

    const fullIncludeBtn = document.createElement('button');
    fullIncludeBtn.className = 'backup-button';
    fullIncludeBtn.textContent = '全量备份（包含图片）';
    manualButtons.appendChild(fullIncludeBtn);

    const slimBtn = document.createElement('button');
    slimBtn.className = 'backup-button';
    slimBtn.textContent = '精简备份（不含图片）';
    manualButtons.appendChild(slimBtn);

    const fullResetBtn = document.createElement('button');
    fullResetBtn.className = 'backup-button';
    fullResetBtn.textContent = '全量备份并重置增量';
    manualButtons.appendChild(fullResetBtn);

    manualSection.appendChild(manualButtons);

    const rowZip = document.createElement('div');
    rowZip.className = 'switch-row backup-form-row';
    const switchZip = document.createElement('label');
    switchZip.className = 'switch';
    const cbZip = document.createElement('input');
    cbZip.type = 'checkbox';
    const sliderZip = document.createElement('span');
    sliderZip.className = 'slider';
    switchZip.appendChild(cbZip);
    switchZip.appendChild(sliderZip);
    const zipText = document.createElement('span');
    zipText.className = 'switch-text';
    zipText.textContent = '默认压缩为 .json.gz（不支持则回退 .json）';
    rowZip.appendChild(zipText);
    rowZip.appendChild(switchZip);
    manualSection.appendChild(rowZip);

    const manualHint = document.createElement('div');
    manualHint.className = 'backup-panel-hint';
    manualHint.textContent = '备份将保存到 “下载/Cerebr/” 子目录。';
    manualSection.appendChild(manualHint);

    const manualHintMeta = document.createElement('div');
    manualHintMeta.className = 'backup-panel-hint';
    manualHintMeta.textContent = '精简备份仅移除图片，思考/引用等元数据会保留。';
    manualSection.appendChild(manualHintMeta);

    container.appendChild(manualSection);

    const extensionStateSection = document.createElement('div');
    extensionStateSection.className = 'backup-section';

    const extensionStateTitle = document.createElement('div');
    extensionStateTitle.className = 'backup-panel-subtitle';
    extensionStateTitle.textContent = '扩展状态备份';
    extensionStateSection.appendChild(extensionStateTitle);

    const extensionStateApiButtons = document.createElement('div');
    extensionStateApiButtons.className = 'backup-button-group';

    const exportApiStateBtn = document.createElement('button');
    exportApiStateBtn.className = 'backup-button';
    exportApiStateBtn.textContent = '导出 API 状态';
    extensionStateApiButtons.appendChild(exportApiStateBtn);

    const restoreApiStateBtn = document.createElement('button');
    restoreApiStateBtn.className = 'backup-button';
    restoreApiStateBtn.textContent = '恢复 API 状态';
    extensionStateApiButtons.appendChild(restoreApiStateBtn);

    extensionStateSection.appendChild(extensionStateApiButtons);

    const extensionStateMiscButtons = document.createElement('div');
    extensionStateMiscButtons.className = 'backup-button-group';

    const exportMiscStateBtn = document.createElement('button');
    exportMiscStateBtn.className = 'backup-button';
    exportMiscStateBtn.textContent = '导出杂项设置';
    extensionStateMiscButtons.appendChild(exportMiscStateBtn);

    const restoreMiscStateBtn = document.createElement('button');
    restoreMiscStateBtn.className = 'backup-button';
    restoreMiscStateBtn.textContent = '恢复杂项设置';
    extensionStateMiscButtons.appendChild(restoreMiscStateBtn);

    extensionStateSection.appendChild(extensionStateMiscButtons);

    const extensionStateHint = document.createElement('div');
    extensionStateHint.className = 'backup-panel-hint';
    extensionStateHint.textContent = '透明备份 chrome.storage.sync / chrome.storage.local / 扩展页 localStorage；不包含聊天记录 / IndexedDB。';
    extensionStateSection.appendChild(extensionStateHint);

    const extensionStateHintRestore = document.createElement('div');
    extensionStateHintRestore.className = 'backup-panel-hint';
    extensionStateHintRestore.textContent = '恢复时只覆盖目标域：API 状态不会覆盖杂项设置，杂项设置也不会覆盖 API 状态。';
    extensionStateSection.appendChild(extensionStateHintRestore);

    container.appendChild(extensionStateSection);

    const cleanupSection = document.createElement('div');
    cleanupSection.className = 'backup-section';

    const cleanupTitle = document.createElement('div');
    cleanupTitle.className = 'backup-panel-subtitle';
    cleanupTitle.textContent = '存储清理';
    cleanupSection.appendChild(cleanupTitle);

    const cleanupButtons = document.createElement('div');
    cleanupButtons.className = 'backup-button-group';

    const cleanupBtn = document.createElement('button');
    cleanupBtn.className = 'backup-button';
    cleanupBtn.textContent = '清理图片存储（迁移 base64）';
    cleanupButtons.appendChild(cleanupBtn);


    const compactMetaBtn = document.createElement('button');
    compactMetaBtn.className = 'backup-button';
    compactMetaBtn.textContent = '清理引用元数据（legacy）';
    cleanupButtons.appendChild(compactMetaBtn);

    cleanupSection.appendChild(cleanupButtons);

    const cleanupHint = document.createElement('div');
    cleanupHint.className = 'backup-panel-hint';
    cleanupHint.textContent = '将历史会话中的 dataURL/base64 图片迁移到本地文件并清理残留，耗时较长。';
    cleanupSection.appendChild(cleanupHint);


    const compactMetaHint = document.createElement('div');
    compactMetaHint.className = 'backup-panel-hint';
    compactMetaHint.textContent = '移除历史会话中的 groundingMetadata 遗留字段，不影响正文与思考显示。';
    cleanupSection.appendChild(compactMetaHint);

    const signatureSection = document.createElement('div');
    signatureSection.className = 'backup-section';

    const signatureTitle = document.createElement('div');
    signatureTitle.className = 'backup-panel-subtitle';
    signatureTitle.textContent = '推理签名清理';
    signatureSection.appendChild(signatureTitle);

    const signatureRow = makeRow('backup-form-row--select');
    const signatureLabel = document.createElement('label');
    signatureLabel.className = 'backup-form-label';
    signatureLabel.textContent = '清理阈值';
    const signatureSelect = document.createElement('select');
    SIGNATURE_CLEANUP_THRESHOLDS.forEach((days) => {
      const opt = document.createElement('option');
      opt.value = String(days);
      opt.textContent = `${days}天前未更新`;
      signatureSelect.appendChild(opt);
    });
    signatureSelect.value = '30';
    signatureRow.appendChild(signatureLabel);
    signatureRow.appendChild(signatureSelect);
    signatureSection.appendChild(signatureRow);

    const signatureButtons = document.createElement('div');
    signatureButtons.className = 'backup-button-group';

    const signatureCleanupBtn = document.createElement('button');
    signatureCleanupBtn.className = 'backup-button';
    signatureCleanupBtn.textContent = '清理旧对话签名';
    signatureButtons.appendChild(signatureCleanupBtn);

    signatureSection.appendChild(signatureButtons);

    const signatureHint = document.createElement('div');
    signatureHint.className = 'backup-panel-hint';
    signatureHint.textContent = '仅移除 thoughtSignature/thoughtSignatureSource；排除置顶会话。';
    signatureSection.appendChild(signatureHint);

    const incrementalSection = document.createElement('div');
    incrementalSection.className = 'backup-section';

    const incrementalTitle = document.createElement('div');
    incrementalTitle.className = 'backup-panel-subtitle';
    incrementalTitle.textContent = '增量备份管理';
    incrementalSection.appendChild(incrementalTitle);

    const rowAuto = document.createElement('div');
    rowAuto.className = 'switch-row backup-form-row';
    const switchAuto = document.createElement('label');
    switchAuto.className = 'switch';
    const cbAuto = document.createElement('input');
    cbAuto.type = 'checkbox';
    const sliderAuto = document.createElement('span');
    sliderAuto.className = 'slider';
    switchAuto.appendChild(cbAuto);
    switchAuto.appendChild(sliderAuto);
    const autoText = document.createElement('span');
    autoText.className = 'switch-text';
    autoText.textContent = '启用自动增量备份';
    rowAuto.appendChild(autoText);
    rowAuto.appendChild(switchAuto);
    incrementalSection.appendChild(rowAuto);

    const scheduleRow = makeRow('backup-form-row--select');
    const scheduleLabel = document.createElement('label');
    scheduleLabel.className = 'backup-form-label';
    scheduleLabel.textContent = '调度模式';
    const scheduleSelect = document.createElement('select');
    const optHourly = document.createElement('option');
    optHourly.value = 'hourly';
    optHourly.textContent = '每N小时';
    const optDaily = document.createElement('option');
    optDaily.value = 'daily';
    optDaily.textContent = '每天固定时间';
    scheduleSelect.appendChild(optHourly);
    scheduleSelect.appendChild(optDaily);
    scheduleRow.appendChild(scheduleLabel);
    scheduleRow.appendChild(scheduleSelect);
    incrementalSection.appendChild(scheduleRow);

    const hourlyRow = makeRow('backup-form-row--inline');
    const hourlyLabel = document.createElement('label');
    hourlyLabel.className = 'backup-form-label';
    hourlyLabel.textContent = '间隔（小时）';
    const hourlyInput = document.createElement('input');
    hourlyInput.type = 'number';
    hourlyInput.min = '1';
    hourlyInput.step = '1';
    hourlyRow.appendChild(hourlyLabel);
    hourlyRow.appendChild(hourlyInput);
    incrementalSection.appendChild(hourlyRow);

    const dailyRow = makeRow('backup-form-row--inline');
    const dailyLabel = document.createElement('label');
    dailyLabel.className = 'backup-form-label';
    dailyLabel.textContent = '时间（每天）';
    const dailyInput = document.createElement('input');
    dailyInput.type = 'time';
    dailyRow.appendChild(dailyLabel);
    dailyRow.appendChild(dailyInput);
    incrementalSection.appendChild(dailyRow);

    const infoList = document.createElement('div');
    infoList.className = 'backup-info-list';
    incrementalSection.appendChild(infoList);

    const createInfoItem = (label) => {
      const item = document.createElement('div');
      item.className = 'backup-info-item';
      const labelEl = document.createElement('span');
      labelEl.className = 'backup-info-label';
      labelEl.textContent = label;
      const valueEl = document.createElement('span');
      valueEl.className = 'backup-info-value';
      valueEl.textContent = '加载中...';
      item.appendChild(labelEl);
      item.appendChild(valueEl);
      infoList.appendChild(item);
      return valueEl;
    };

    const fullResetInfoValue = createInfoItem('上次全量并重置：');
    const lastIncrementalInfoValue = createInfoItem('上次增量备份：');
    const nextIncrementalInfoValue = createInfoItem('下次预计增量：');

    container.appendChild(incrementalSection);
    container.appendChild(cleanupSection);
    container.appendChild(signatureSection);

    const fmt = (t) => t ? new Date(t).toLocaleString() : '从未';
    const computeNextTs = (prefs) => {
      if (!prefs.autoBackupEnabled) return null;
      const now = Date.now();
      if ((prefs.autoBackupMode || 'hourly') === 'daily') {
        const parts = String(prefs.autoBackupDailyTime || '02:00').split(':');
        const hh = parseInt(parts[0], 10) || 0;
        const mm = parseInt(parts[1], 10) || 0;
        const today = new Date();
        today.setHours(hh, mm, 0, 0);
        const todayTs = today.getTime();
        if (now < todayTs) return todayTs;
        return todayTs + 24 * 60 * 60 * 1000;
      }
      const hours = Math.max(1, Number(prefs.autoBackupHourlyHours || 1));
      const last = Number(prefs.lastIncrementalBackupAt || 0);
      const intervalMs = hours * 60 * 60 * 1000;
      return last ? (last + intervalMs) : (now + intervalMs);
    };

    const applyPreferencesToUI = (prefs) => {
      cbZip.checked = prefs.compressDefault !== false;
      const autoEnabled = !!prefs.autoBackupEnabled;
      cbAuto.checked = autoEnabled;
      scheduleSelect.value = prefs.autoBackupMode || 'hourly';
      hourlyInput.value = String(prefs.autoBackupHourlyHours || 1);
      dailyInput.value = prefs.autoBackupDailyTime || '02:00';
      hourlyRow.style.display = scheduleSelect.value == 'hourly' ? 'flex' : 'none';
      dailyRow.style.display = scheduleSelect.value == 'daily' ? 'flex' : 'none';
      scheduleSelect.disabled = !autoEnabled;
      hourlyInput.disabled = !autoEnabled;
      dailyInput.disabled = !autoEnabled;
      fullResetInfoValue.textContent = fmt(prefs.lastFullResetBackupAt);
      lastIncrementalInfoValue.textContent = fmt(prefs.lastIncrementalBackupAt);
      if (autoEnabled) {
        const nextTs = computeNextTs(prefs);
        nextIncrementalInfoValue.textContent = nextTs ? new Date(nextTs).toLocaleString() : '计算中...';
      } else {
        nextIncrementalInfoValue.textContent = '计划未启用';
      }
    };

    const refreshPreferences = async () => {
      try {
        const saved = await loadBackupPreferencesDownloadsOnly();
        applyPreferencesToUI(saved);
      } catch (error) {
        fullResetInfoValue.textContent = '加载失败';
        lastIncrementalInfoValue.textContent = '加载失败';
        nextIncrementalInfoValue.textContent = '加载失败';
      }
    };

    cbZip.addEventListener('change', async () => {
      const updated = await saveBackupPreferencesDownloadsOnly({ compressDefault: !!cbZip.checked });
      applyPreferencesToUI(updated);
    });
    cbAuto.addEventListener('change', async () => {
      const updated = await saveBackupPreferencesDownloadsOnly({ autoBackupEnabled: !!cbAuto.checked });
      applyPreferencesToUI(updated);
      restartAutoBackupScheduler?.();
    });
    scheduleSelect.addEventListener('change', async () => {
      const mode = scheduleSelect.value === 'daily' ? 'daily' : 'hourly';
      hourlyRow.style.display = mode === 'hourly' ? 'flex' : 'none';
      dailyRow.style.display = mode === 'daily' ? 'flex' : 'none';
      const updated = await saveBackupPreferencesDownloadsOnly({ autoBackupMode: mode });
      applyPreferencesToUI(updated);
      restartAutoBackupScheduler?.();
    });

    hourlyInput.addEventListener('change', async () => {
      const value = Math.max(1, Number(hourlyInput.value) || 1);
      hourlyInput.value = String(value);
      const updated = await saveBackupPreferencesDownloadsOnly({ autoBackupHourlyHours: value });
      applyPreferencesToUI(updated);
      restartAutoBackupScheduler?.();
    });

    dailyInput.addEventListener('change', async () => {
      const timeValue = dailyInput.value || '02:00';
      const updated = await saveBackupPreferencesDownloadsOnly({ autoBackupDailyTime: timeValue });
      applyPreferencesToUI(updated);
      restartAutoBackupScheduler?.();
    });

    const runManualBackup = async (extraOptions = {}) => {
      await backupConversations({ mode: 'full', ...extraOptions });
      await refreshPreferences();
      restartAutoBackupScheduler?.();
    };

    quickBackupBtn.addEventListener('click', async () => {
      await runManualBackup();
    });

    importButton.addEventListener('click', () => {
      importConversationFromClipboard();
    });

    restoreButton.addEventListener('click', () => {
      restoreConversations();
    });

    fullIncludeBtn.addEventListener('click', async () => {
      await runManualBackup({ excludeImages: false });
    });

    slimBtn.addEventListener('click', async () => {
      await runManualBackup({ excludeImages: true });
    });

    fullResetBtn.addEventListener('click', async () => {
      await runManualBackup({ excludeImages: false, resetIncremental: true });
    });

    exportApiStateBtn.addEventListener('click', async () => {
      await exportExtensionStateBackup(EXTENSION_STATE_BACKUP_DOMAIN_API);
    });

    restoreApiStateBtn.addEventListener('click', async () => {
      await restoreExtensionStateBackup(EXTENSION_STATE_BACKUP_DOMAIN_API);
    });

    exportMiscStateBtn.addEventListener('click', async () => {
      await exportExtensionStateBackup(EXTENSION_STATE_BACKUP_DOMAIN_MISC);
    });

    restoreMiscStateBtn.addEventListener('click', async () => {
      await restoreExtensionStateBackup(EXTENSION_STATE_BACKUP_DOMAIN_MISC);
    });

    cleanupBtn.addEventListener('click', async () => {
      const confirmFn = appContext?.utils?.showConfirm;
      let confirmed = true;
      if (typeof confirmFn === 'function') {
        confirmed = await confirmFn({
          message: '确认清理图片存储？',
          description: '该操作会扫描全部会话，将 dataURL/base64 图片迁移到本地文件，并清理冗余字段；耗时较长。',
          confirmText: '开始清理',
          cancelText: '取消',
          type: 'warning'
        });
      } else {
        confirmed = window.confirm('将扫描全部会话并清理 dataURL/base64 图片，耗时较长，是否继续？');
      }
      if (!confirmed) return;

      const originalText = cleanupBtn.textContent;
      cleanupBtn.disabled = true;
      cleanupBtn.textContent = '清理中...';
      try {
        const result = await cleanAllImageDataUrlsInDb();
        const summary = [
          `扫描 ${result.scannedConversations} 会话`,
          `更新 ${result.updatedConversations} 会话`,
          `发现 base64 ${result.base64Found}`,
          `迁移 ${result.convertedImages}`,
          `失败 ${result.failedConversions}`
        ].join('；');
        showNotification?.({
          message: '图片清理完成',
          description: summary,
          type: result.failedConversions > 0 ? 'warning' : 'success',
          duration: 4200
        });
      } catch (error) {
        console.error('图片清理失败:', error);
        showNotification?.({
          message: '图片清理失败',
          description: String(error?.message || error),
          type: 'error',
          duration: 3200
        });
      } finally {
        cleanupBtn.disabled = false;
        cleanupBtn.textContent = originalText;
      }
    });

    compactMetaBtn.addEventListener('click', async () => {
      const confirmFn = appContext?.utils?.showConfirm;
      let confirmed = true;
      if (typeof confirmFn === 'function') {
        confirmed = await confirmFn({
          message: '确认清理 legacy 引用元数据？',
          description: '该操作会删除 groundingMetadata 字段，用于清理历史遗留数据。',
          confirmText: '开始清理',
          cancelText: '取消',
          type: 'warning'
        });
      } else {
        confirmed = window.confirm('将清理 groundingMetadata 遗留字段，是否继续？');
      }
      if (!confirmed) return;

      const originalText = compactMetaBtn.textContent;
      compactMetaBtn.disabled = true;
      compactMetaBtn.textContent = '清理中...';
      try {
        const result = await removeGroundingMetadataInDb();
        const summary = [
          `扫描 ${result.scannedConversations} 会话`,
          `更新 ${result.updatedConversations} 会话`,
          `更新 ${result.updatedMessages} 消息`
        ].join('；');
        showNotification?.({
          message: '引用元数据清理完成',
          description: summary,
          type: 'success',
          duration: 4200
        });
      } catch (error) {
        console.error('清理引用元数据失败:', error);
        showNotification?.({
          message: '清理引用元数据失败',
          description: String(error?.message || error),
          type: 'error',
          duration: 3200
        });
      } finally {
        compactMetaBtn.disabled = false;
        compactMetaBtn.textContent = originalText;
      }
    });

    signatureCleanupBtn.addEventListener('click', async () => {
      const days = Math.max(1, Number(signatureSelect.value) || 30);
      const confirmFn = appContext?.utils?.showConfirm;
      let confirmed = true;
      if (typeof confirmFn === 'function') {
        confirmed = await confirmFn({
          message: `确认清理 ${days} 天前的推理签名？`,
          description: `将清理 >=${days} 天未更新且未置顶对话的 thoughtSignature/thoughtSignatureSource。`,
          confirmText: '开始清理',
          cancelText: '取消',
          type: 'warning'
        });
      } else {
        confirmed = window.confirm(`将清理 >=${days} 天未更新且未置顶对话的 thoughtSignature/thoughtSignatureSource，是否继续？`);
      }
      if (!confirmed) return;

      const originalText = signatureCleanupBtn.textContent;
      signatureCleanupBtn.disabled = true;
      signatureCleanupBtn.textContent = '清理中...';
      try {
        const result = await removeThoughtSignatureInDb({ minAgeDays: days, excludePinned: true });
        const summary = [
          `扫描 ${result.scannedConversations} 会话`,
          `目标 ${result.targetConversations} 会话`,
          `更新 ${result.updatedConversations} 会话`,
          `更新 ${result.updatedMessages} 消息`,
          result.skippedPinned ? `排除置顶 ${result.skippedPinned}` : null,
          result.skippedRecent ? `排除近${days}天 ${result.skippedRecent}` : null,
          result.missingEndTime ? `缺少时间 ${result.missingEndTime}` : null
        ].filter(Boolean).join('；');
        showNotification?.({
          message: '推理签名清理完成',
          description: summary,
          type: 'success',
          duration: 4200
        });
      } catch (error) {
        console.error('清理推理签名失败:', error);
        showNotification?.({
          message: '清理推理签名失败',
          description: String(error?.message || error),
          type: 'error',
          duration: 3200
        });
      } finally {
        signatureCleanupBtn.disabled = false;
        signatureCleanupBtn.textContent = originalText;
      }
    });

    refreshPreferences();

    return container;
  }

  // 已移除目录选择与顶层写入弹窗逻辑

  /**
   * 更新当前页面信息
   * @param {Object} newPageInfo - 新的页面信息对象
   */
  function updatePageInfo(newPageInfo) {
    // currentPageInfo = newPageInfo; // Local variable removed
    state.pageInfo = newPageInfo; // Update the shared state in appContext
    console.log('ChatHistoryUI: 页面信息已更新', state.pageInfo);
  }
  
  /**
   * 清理内存缓存
   */
  function clearMemoryCache() {
    // 保留当前活动会话
    const activeId = activeConversation?.id;
    const activeConv = activeId ? loadedConversations.get(activeId) : null;
    
    // 清空缓存
    loadedConversations.clear();
    
    // 恢复当前活动会话到缓存
    if (activeId && activeConv) {
      loadedConversations.set(activeId, activeConv);
    }
    
    // console.log('内存缓存已清理');
  }

  /**
   * 移除 JSON 中末尾的多余逗号（仅处理字符串外的结构符号）。
   * 说明：用户从脚本中复制 request.json 时，常见尾逗号会导致 JSON.parse 失败。
   * @param {string} source
   * @returns {string}
   */
  function stripTrailingCommasForJson(source) {
    if (typeof source !== 'string' || !source) return '';
    let result = '';
    let inString = false;
    let escaping = false;

    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (inString) {
        result += ch;
        if (escaping) {
          escaping = false;
          continue;
        }
        if (ch === '\\') {
          escaping = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        result += ch;
        continue;
      }

      if (ch === ',') {
        let j = i + 1;
        while (j < source.length && /\s/.test(source[j])) j++;
        if (source[j] === '}' || source[j] === ']') {
          continue;
        }
      }

      result += ch;
    }

    return result;
  }

  /**
   * 从 shell heredoc 文本中提取 JSON（例如 cat << EOF ... EOF）。
   * @param {string} text
   * @returns {string|null}
   */
  function extractJsonFromHereDoc(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    const normalized = text.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const markerMatch = line.match(/<<-?\s*(['"]?)([^\s'"]+)\1/);
      if (!markerMatch) continue;

      const marker = markerMatch[2];
      if (!marker) continue;

      let endIndex = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === marker) {
          endIndex = j;
          break;
        }
      }
      if (endIndex === -1) continue;

      const candidate = lines.slice(i + 1, endIndex).join('\n').trim();
      if (candidate) return candidate;
    }

    return null;
  }

  /**
   * 解析导入文本：支持直接 JSON 与 shell 脚本内嵌 JSON 两种模式。
   * @param {string} rawText
   * @returns {{ ok: true, data: any } | { ok: false, error: Error|null }}
   */
  function parseImportedConversationRawText(rawText) {
    const candidates = [];
    if (typeof rawText === 'string' && rawText.trim()) {
      candidates.push(rawText.trim());
      const hereDocBody = extractJsonFromHereDoc(rawText);
      if (hereDocBody && hereDocBody !== rawText.trim()) {
        candidates.push(hereDocBody);
      }
    }

    let lastError = null;
    for (const candidate of candidates) {
      try {
        return { ok: true, data: JSON.parse(candidate) };
      } catch (error) {
        lastError = error;
      }

      const sanitized = stripTrailingCommasForJson(candidate);
      if (!sanitized || sanitized === candidate) continue;
      try {
        return { ok: true, data: JSON.parse(sanitized) };
      } catch (error) {
        lastError = error;
      }
    }

    return { ok: false, error: lastError };
  }

  /**
   * 提取 Gemini contents[].parts[].text 文本数组。
   * @param {Array<any>} parts
   * @returns {string[]}
   */
  function extractTextParts(parts) {
    if (!Array.isArray(parts) || parts.length === 0) return [];
    const texts = [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (typeof part.text === 'string') {
        texts.push(part.text);
      } else if (part.text !== undefined && part.text !== null) {
        texts.push(String(part.text));
      }
    }
    return texts;
  }

  /**
   * 将解析后的对象转换为统一消息结构。
   * @param {any} parsed
   * @returns {Array<{sender: 'user'|'ai', content: string, thoughtsRaw: string|null}>}
   */
  function buildImportEntries(parsed) {
    // 兼容旧格式：["用户消息","AI消息"]，默认从用户开始交替。
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(item => typeof item === 'string')) {
      const result = [];
      let isUserTurn = true;
      for (const item of parsed) {
        const content = String(item);
        if (!content.trim()) {
          isUserTurn = !isUserTurn;
          continue;
        }
        result.push({
          sender: isUserTurn ? 'user' : 'ai',
          content,
          thoughtsRaw: null
        });
        isUserTurn = !isUserTurn;
      }
      return result;
    }

    // 新格式：Gemini 请求体对象，优先读取 contents 字段。
    const contents = Array.isArray(parsed?.contents)
      ? parsed.contents
      : (Array.isArray(parsed) ? parsed : null);
    if (!Array.isArray(contents) || contents.length === 0) return [];

    const result = [];
    for (const message of contents) {
      if (!message || typeof message !== 'object') continue;
      const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
      const partTexts = extractTextParts(message.parts);
      if (!partTexts.length) continue;

      if (role === 'user') {
        const content = partTexts.join('\n\n');
        if (!content.trim()) continue;
        result.push({ sender: 'user', content, thoughtsRaw: null });
        continue;
      }

      if (role === 'model' || role === 'assistant') {
        const thoughtsRaw = partTexts.length >= 2 ? partTexts[0] : null;
        const content = (partTexts.length >= 2 ? partTexts.slice(1) : partTexts).join('\n\n');
        if (!content.trim() && !thoughtsRaw?.trim()) continue;
        result.push({
          sender: 'ai',
          content,
          thoughtsRaw: thoughtsRaw?.trim() ? thoughtsRaw : null
        });
      }
    }

    return result;
  }

  /**
   * 从剪贴板导入一条新的聊天记录。
   * 支持：
   * 1) 旧格式字符串数组 JSON：["第一条用户消息","第一条AI回复"]
   * 2) Gemini 请求体 JSON（含 contents/parts）
   * 3) 含 cat << EOF ... EOF 的 shell 脚本文本（自动提取 request.json）
   */
  async function importConversationFromClipboard() {
    const showNotificationSafe = typeof showNotification === 'function' ? showNotification : null;

    // 由于 Permissions Policy 限制，直接调用 Clipboard API 可能被阻止，这里改为让用户手动粘贴文本
    const hint = '支持粘贴字符串数组 JSON 或 Gemini request.json（可直接粘贴含 cat << EOF 的脚本）';
    let rawText = await openUnifiedInputDialog({
      title: '从剪贴板导入',
      message: hint,
      defaultValue: '',
      placeholder: '[\"第一条用户消息\",\"第一条AI回复\"] 或 {\"contents\":[...]}',
      confirmText: '导入',
      multiline: true,
      rows: 12
    });

    if (rawText === null) {
      // 用户取消，不视为错误
      return;
    }

    rawText = (rawText || '').trim();
    if (!rawText) {
      showNotificationSafe?.({
        message: '未输入任何内容，已取消导入',
        type: 'warning',
        duration: 2000
      });
      return;
    }

    const parsedResult = parseImportedConversationRawText(rawText);
    if (!parsedResult.ok) {
      console.error('解析导入内容失败:', parsedResult.error);
      showNotificationSafe?.({
        message: '内容解析失败，请确认为有效 JSON 或包含 request.json 的脚本片段',
        type: 'error',
        duration: 3200
      });
      return;
    }

    const importEntries = buildImportEntries(parsedResult.data);
    if (!importEntries.length) {
      showNotificationSafe?.({
        message: '未识别到可导入消息。请提供字符串数组或包含 contents 的 Gemini 请求体',
        type: 'warning',
        duration: 3600
      });
      return;
    }

    try {
      // 先清空当前会话（内部会自动保存已有内容）
      await clearChatHistory();

      for (const entry of importEntries) {
        appendMessage(entry.content, entry.sender, false, null, null, entry.thoughtsRaw, null);
      }

      // 保存为新的持久化会话，使用当前页面信息作为元数据
      await saveCurrentConversation(false);

      // 通知消息发送器当前会话 ID 已更新，后续继续聊天时可以接在导入记录之后
      if (currentConversationId) {
        services.messageSender.setCurrentConversationId(currentConversationId);
      }

      showNotificationSafe?.({
        message: '已从剪贴板导入一条新的聊天记录',
        type: 'success',
        duration: 2200
      });

      // 关闭历史面板，让用户直接回到聊天界面
      closeChatHistoryPanel();
    } catch (error) {
      console.error('导入聊天记录失败:', error);
      showNotificationSafe?.({
        message: '导入聊天记录失败，请检查内容或稍后重试',
        type: 'error',
        duration: 3200
      });
    }
  }

  // ---- 自动备份调度 ----
  let autoBackupTimerId = null;
  async function autoBackupTick() {
    try {
      const prefs = await loadBackupPreferencesDownloadsOnly();
      if (!prefs.autoBackupEnabled) return;
      const now = Date.now();
      const last = Number(prefs.lastIncrementalBackupAt || 0);
      let due = false;
      if ((prefs.autoBackupMode || 'hourly') === 'daily') {
        const [hh, mm] = String(prefs.autoBackupDailyTime || '02:00').split(':').map(x => parseInt(x, 10) || 0);
        const today = new Date(); today.setHours(hh, mm, 0, 0);
        const todayTs = today.getTime();
        const yesterdayTs = todayTs - 24 * 60 * 60 * 1000;
        if (now >= todayTs && last < todayTs) due = true;
        else if (now < todayTs && last < yesterdayTs) due = true;
      } else {
        const hours = Math.max(1, Number(prefs.autoBackupHourlyHours || 1));
        const intervalMs = hours * 60 * 60 * 1000;
        due = last <= 0 ? (now >= intervalMs) : (now >= (last + intervalMs));
      }
      if (!due) return;
      const locked = await acquireAutoBackupLock(2 * 60 * 1000);
      if (!locked) return;
      try {
        await backupConversations({ mode: 'incremental', auto: true });
      } finally {
        await releaseAutoBackupLock();
      }
    } catch (_) {}
  }

  function startAutoBackupScheduler() {
    if (autoBackupTimerId) clearInterval(autoBackupTimerId);
    autoBackupTimerId = setInterval(autoBackupTick, 60 * 1000);
  }
  function stopAutoBackupScheduler() {
    if (autoBackupTimerId) { clearInterval(autoBackupTimerId); autoBackupTimerId = null; }
  }
  function restartAutoBackupScheduler() { stopAutoBackupScheduler(); startAutoBackupScheduler(); }

  // 启动自动备份调度器
  startAutoBackupScheduler();

  // 添加URL处理函数
  function getDisplayUrl(url) {
    try {
      if (!url) return '未知来源'; // 处理 null 或 undefined URL
      if (url.startsWith('file:///')) {
        // 解码URL并获取文件名
        const decodedUrl = decodeURIComponent(url);
        return decodedUrl.split(/[\/]/).pop() || '本地文件'; // 兼容 Windows 和 Unix 路径     
      }
      // 非file协议，返回域名
      const urlObj = new URL(url);
      if (!urlObj.hostname) return url; // 如果 hostname 为空，则返回原始 URL
      return urlObj.hostname.replace(/^www\./i, '');
    } catch (error) {
      console.warn('解析 URL 失败:', url, error); // 使用 warn 级别，因为它不一定是严重错误
      return url || '无效URL'; // 返回原始 URL 或提示
    }
  }

  /**
   * 创建分支对话
   * @param {string} targetMessageId - 目标消息ID，将截取从开始到该消息的对话
   * @param {{sourceChain?: Array<Object>, stripThreadMetadata?: boolean, successMessage?: string}} [options]
   * @returns {Promise<void>}
   */
  async function createForkConversation(targetMessageId, options = {}) {
    if (!services.chatHistoryManager.chatHistory || !services.chatHistoryManager.chatHistory.messages || services.chatHistoryManager.chatHistory.messages.length === 0) {
      console.error('创建分支对话失败: 没有可用的聊天历史');
      return;
    }

    try {
      // 先保存当前会话以确保所有更改都已保存
      await saveCurrentConversation(true);
      // 记录分支来源（保存后 currentConversationId 必然存在）
      const parentConversationId = currentConversationId || null;

      // 查找目标消息
      const targetMessage = services.chatHistoryManager.chatHistory.messages.find(msg => msg.id === targetMessageId);
      if (!targetMessage) {
        console.error('创建分支对话失败: 找不到目标消息');
        return;
      }

      const normalizedOptions = (options && typeof options === 'object') ? options : {};
      const customSourceChain = Array.isArray(normalizedOptions.sourceChain)
        ? normalizedOptions.sourceChain.filter(msg => msg && typeof msg.id === 'string' && msg.id)
        : null;
      const stripThreadMetadata = normalizedOptions.stripThreadMetadata === true;
      const successMessage = (typeof normalizedOptions.successMessage === 'string' && normalizedOptions.successMessage.trim())
        ? normalizedOptions.successMessage.trim()
        : '已创建分支对话';

      // 获取目标分支链：默认取当前主链，也支持由外部显式传入“自定义链路”（如线程展平）。
      const sourceChain = (customSourceChain && customSourceChain.length > 0)
        ? customSourceChain
        : services.chatHistoryManager.getCurrentConversationChain();

      const targetIndex = sourceChain.findIndex(msg => msg.id === targetMessageId);
      if (targetIndex === -1) {
        console.error('创建分支对话失败: 目标消息不在可分支链路中');
        return;
      }
      const selectedChain = sourceChain.slice(0, targetIndex + 1);
      if (!selectedChain.length) {
        console.error('创建分支对话失败: 可分支链路为空');
        return;
      }
      
      // 优先使用当前的页面信息，如果不存在，则尝试从原始对话获取（如果已保存）
      let pageInfo = appContext.state.pageInfo ? { ...appContext.state.pageInfo } : null;
      if (!pageInfo && currentConversationId) {
        const originalConversation = await getConversationFromCacheOrLoad(currentConversationId, false); // false: 不要强制重新加载完整内容
        if (originalConversation && originalConversation.url) {
          pageInfo = {
            url: originalConversation.url,
            title: originalConversation.title
          };
        }
      }
      
      // 创建新的ChatHistory对象
      const newChatHistory = {
        messages: [],
        root: null,
        currentNode: null,
        conversationRevision: 0,
        promptCacheKey: ''
      };

      // 说明：避免复用旧节点引用，确保分支会话内容独立。
      const cloneSafely = (obj) => {
        try { return structuredClone(obj); } catch (_) {}
        try { return JSON.parse(JSON.stringify(obj)); } catch (_) {}
        return obj;
      };

      const resolveMessageContent = async (msg) => {
        if (!msg) return '';
        if (msg.content !== undefined && msg.content !== null) return cloneSafely(msg.content);
        if (msg.content === null) return '';
        return '';
      };

      const stripThreadFieldsForMainConversation = (messageNode) => {
        if (!messageNode || typeof messageNode !== 'object') return;
        const threadFieldKeys = [
          'threadId',
          'threadAnchorId',
          'threadSelectionText',
          'threadRootId',
          'threadHiddenSelection',
          'threadMatchIndex',
          'threadAnnotations'
        ];
        threadFieldKeys.forEach((key) => {
          if (key in messageNode) {
            delete messageNode[key];
          }
        });
      };

      const generateForkMessageId = () => `fork_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // 复制截取的消息到新的ChatHistory
      let previousId = null;
      for (let i = 0; i < selectedChain.length; i++) {
        const originalMsg = selectedChain[i];
        const resolvedContent = await resolveMessageContent(originalMsg);
        const newMsg = {
          ...cloneSafely(originalMsg), // 深拷贝（尽量不共享引用，避免后续修改污染原会话）
          id: generateForkMessageId(),
          parentId: previousId,
          children: [],
          content: normalizeStoredMessageContent(resolvedContent)
        };
        if (stripThreadMetadata) {
          stripThreadFieldsForMainConversation(newMsg);
        }
        if (previousId) {
          const parentMsg = newChatHistory.messages.find(m => m.id === previousId);
          if (parentMsg) {
            parentMsg.children.push(newMsg.id);
          }
        }
        
        if (i === 0) {
          newChatHistory.root = newMsg.id;
        }
        
        if (i === selectedChain.length - 1) {
          newChatHistory.currentNode = newMsg.id;
        }
        
        previousId = newMsg.id;
        newChatHistory.messages.push(newMsg);
      }
      
      // 生成新的会话ID
      const newConversationId = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // 计算开始和结束时间
      const timestamps = newChatHistory.messages
        .map(msg => Number(msg.timestamp))
        .filter(ts => Number.isFinite(ts));
      const fallbackTime = Date.now();
      const startTime = timestamps.length ? Math.min(...timestamps) : fallbackTime;
      const endTime = timestamps.length ? Math.max(...timestamps) : fallbackTime;
      
      // 分支对话摘要：
      // - 优先使用父对话“现有标题 + (分支)”；
      // - 若父对话没有标题，再回退到“指令类型驱动”的摘要规则；
      // - 避免重复追加分支后缀。
      const branchSuffix = ' (分支)';
      const normalizeBranchSummary = (raw) => {
        const text = (typeof raw === 'string') ? raw.trim() : '';
        if (!text) return '';
        return text.endsWith(branchSuffix) ? text : `${text}${branchSuffix}`;
      };
      let parentSummary = '';
      let parentConversationSnapshot = null;
      if (parentConversationId && activeConversation?.id === parentConversationId) {
        parentConversationSnapshot = activeConversation;
        parentSummary = (typeof activeConversation.summary === 'string') ? activeConversation.summary.trim() : '';
      }
      if (!parentSummary && parentConversationId) {
        try {
          const parentConversation = await getConversationFromCacheOrLoad(parentConversationId, false);
          if (parentConversation) {
            parentConversationSnapshot = parentConversation;
          }
          parentSummary = (typeof parentConversation?.summary === 'string') ? parentConversation.summary.trim() : '';
        } catch (_) {
          parentSummary = '';
        }
      }
      let summary = normalizeBranchSummary(parentSummary);
      if (!summary) {
        const promptsConfig = promptSettingsManager.getPrompts();
        const baseSummary = buildConversationSummaryFromMessages(newChatHistory.messages, {
          promptsConfig,
          pageTitle: pageInfo?.title || '',
          maxLength: 160
        });
        summary = baseSummary ? `${baseSummary}${branchSuffix}` : '分支对话';
      }
      // 分支会话也复用统一合并规则，避免父会话锁定在不同入口下出现不一致行为。
      const branchApiLockMerge = mergeConversationApiLockState({
        memoryApiLock: normalizeConversationApiLock(activeConversationApiLock || activeConversation?.apiLock),
        storedApiLock: parentConversationSnapshot?.apiLock,
        preserveExistingApiLock: true
      });
      const apiLockToSave = branchApiLockMerge.apiLock;
      
      // 创建新的会话对象
      const newConversation = {
        id: newConversationId,
        messages: newChatHistory.messages,
        summary: summary,
        summarySource: 'default',
        startTime: startTime,
        endTime: endTime,
        conversationRevision: 0,
        title: pageInfo?.title || '',
        url: pageInfo?.url || '',
        // --- 分支元信息（用于“历史面板树状显示”）---
        // 设计说明：
        // - 分支对话本质上是“从某个会话的某条消息处截断并复制出一个新会话”；
        // - 这里显式记录父会话 ID + 分支点消息 ID，避免后续只能靠正则/内容猜测；
        // - 允许父会话被删除：UI 侧渲染树时可将其作为“孤儿分支”顶层展示。
        parentConversationId,
        forkedFromMessageId: targetMessageId || null,
        currentNode: newChatHistory.currentNode,
        root: newChatHistory.root
      };
      if (apiLockToSave) {
        newConversation.apiLock = apiLockToSave;
      }
      
      // 保存新会话到数据库
      await putConversation(newConversation);
      if (parentConversationId) {
        await copyConversationDocuments(parentConversationId, newConversationId);
        await copyLocalFileMounts(parentConversationId, newConversationId);
      }
      invalidateMetadataCache();
      
      // 清空当前会话并加载新创建的会话
      services.chatHistoryManager.chatHistory.messages = [];
      services.chatHistoryManager.chatHistory.root = null;
      services.chatHistoryManager.chatHistory.currentNode = null;
      services.chatHistoryManager.chatHistory.conversationRevision = 0;
      services.chatHistoryManager.chatHistory.promptCacheKey = '';
      
      // 清空聊天容器
      chatContainer.innerHTML = '';
      
      // 加载新创建的会话
      await loadConversationIntoChat(newConversation);
      
      // 更新当前会话ID
      currentConversationId = newConversationId;
      
      // 通知消息发送器更新当前会话ID
      services.messageSender.setCurrentConversationId(newConversationId);
      
      console.log('成功创建分支对话:', newConversationId);
      
      // 提示用户操作成功
      showNotification({ message: successMessage, duration: 2000 });
      
    } catch (error) {
      console.error('创建分支对话失败:', error);
    }
  }

  return {
    saveCurrentConversation,
    loadConversationIntoChat,
    clearChatHistory,
    showChatHistoryPanel,
    activateTab: async (tabName) => {
      const panel = document.getElementById('chat-history-panel');
      if (!panel) return;
      await activateChatHistoryTab(panel, tabName);
    },
    getActiveTabName: getActiveChatHistoryTabName,
    getLastClosedTabName: getLastClosedChatHistoryTabName,
    getLastClosedAt: getLastClosedChatHistoryAt,
    closeChatHistoryPanel,
    toggleChatHistoryPanel,
    isChatHistoryPanelOpen,
    isChatHistoryPanelPinned,
    backupConversations,
    restoreConversations, 
    refreshChatHistory,
    refreshActiveConversationThreadOverviewDrawer,
    updatePageInfo,
    getCurrentConversationId: () => currentConversationId,
    ensureCurrentConversationId,
    getActiveConversationApiLock,
    resolveActiveConversationApiConfig,
    setConversationApiLock,
    getActiveConversationSummary,
    updateConversationSummary,
    clearMemoryCache,
    getConversationSnapshotById,
    formatRelativeTime,
    createForkConversation,
    restartAutoBackupScheduler,
    repairRecentImages,
    migrateImagePathsToRelative,
    resaveImagesWithNewScheme,
    setDownloadRootManual,
    checkImagePathUrlMismatch,
    cleanImageUrlFields,
    scanDataUrlsInDb
  };
}
