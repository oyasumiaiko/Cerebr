import {
  buildChatHistorySearchPlan,
  buildChatHistoryTextPlan,
  buildMetaSearchText,
  evaluateChatHistoryFilters,
  evaluateMetaTextMatch,
  extractMessagePlainText,
  isThreadMessageLike,
  scanConversationMessagesForSearch
} from '../utils/chat_history_search_shared.js';
import {
  findBestCandidateUrlPrefixMatch,
  generateCandidateUrls
} from '../utils/url_candidates.js';

export const HISTORY_SEARCH_TOOL_DEFAULT_MAX_RESULTS = 20;
export const HISTORY_SEARCH_TOOL_MAX_RESULTS = 100;
export const HISTORY_SEARCH_EXCERPT_CONTEXT_CHARS = 40;
export const HISTORY_SEARCH_MAX_EXCERPTS = 3;
export const HISTORY_READ_MESSAGE_DEFAULT_MAX_CHARS = 5_000;

function clampPositiveInt(value, fallback, max = Number.POSITIVE_INFINITY) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(Math.trunc(numeric), max));
}

function clampNonNegativeInt(value, fallback, max = Number.POSITIVE_INFINITY) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(Math.trunc(numeric), max));
}

function formatPercent(numerator, denominator) {
  const safeNumerator = Number(numerator);
  const safeDenominator = Number(denominator);
  if (!Number.isFinite(safeNumerator) || !Number.isFinite(safeDenominator) || safeDenominator <= 0) {
    return 0;
  }
  return Number(((safeNumerator / safeDenominator) * 100).toFixed(2));
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
}

function parseFlexibleDatePoint(rawValue) {
  if (rawValue == null) return null;
  const range = buildChatHistorySearchPlan(`date:${String(rawValue).trim()}`).filters.find(item => item?.key === 'date') || null;
  if (!range) return null;
  return {
    start: range.rangeStart,
    end: range.rangeEnd
  };
}

function parseRecentWithin(rawValue) {
  if (rawValue == null) return null;
  const filter = buildChatHistorySearchPlan(`date:<${String(rawValue).trim()}`).filters.find(item => item?.key === 'date') || null;
  if (!filter) return null;
  return filter;
}

function normalizeHistorySearchArguments(rawArgs) {
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs))
    ? rawArgs
    : {};
  const textAll = normalizeStringArray(args.text_all);
  const textNot = normalizeStringArray(args.text_not);
  const urlContains = typeof args.url_contains === 'string' ? args.url_contains.trim() : '';
  const currentPageOnly = args.current_page_only === true;
  const recentWithinRaw = typeof args.recent_within === 'string' ? args.recent_within.trim() : '';
  const scope = (typeof args.scope === 'string' ? args.scope.trim().toLowerCase() : '');
  const resultMode = (typeof args.result_mode === 'string' ? args.result_mode.trim().toLowerCase() : '');
  const minMessageCount = (args.min_message_count == null)
    ? null
    : clampNonNegativeInt(args.min_message_count, 0, Number.MAX_SAFE_INTEGER);
  const maxMessageCount = (args.max_message_count == null)
    ? null
    : clampNonNegativeInt(args.max_message_count, 0, Number.MAX_SAFE_INTEGER);

  const dateFrom = parseFlexibleDatePoint(args.date_from);
  if (args.date_from != null && !dateFrom) {
    throw new Error('history_search 参数错误：date_from 格式无效。');
  }
  const dateTo = parseFlexibleDatePoint(args.date_to);
  if (args.date_to != null && !dateTo) {
    throw new Error('history_search 参数错误：date_to 格式无效。');
  }
  const recentWithin = recentWithinRaw ? parseRecentWithin(recentWithinRaw) : null;
  if (recentWithinRaw && !recentWithin) {
    throw new Error('history_search 参数错误：recent_within 应类似 5d / 1w / 1m / 1y。');
  }

  if (scope && scope !== 'message' && scope !== 'session') {
    throw new Error('history_search 参数错误：scope 只能是 message 或 session。');
  }
  if (resultMode && resultMode !== 'matches' && resultMode !== 'metadata_only') {
    throw new Error('history_search 参数错误：result_mode 只能是 matches 或 metadata_only。');
  }
  if (minMessageCount != null && maxMessageCount != null && minMessageCount > maxMessageCount) {
    throw new Error('history_search 参数错误：min_message_count 不能大于 max_message_count。');
  }

  const hasAnySearchConstraint = (
    textAll.length > 0
    || textNot.length > 0
    || !!urlContains
    || currentPageOnly
    || minMessageCount != null
    || maxMessageCount != null
    || !!dateFrom
    || !!dateTo
    || !!recentWithin
  );
  if (!hasAnySearchConstraint) {
    throw new Error('history_search 参数错误：至少需要提供一个搜索条件。');
  }

  return {
    textAll,
    textNot,
    urlContains,
    currentPageOnly,
    minMessageCount,
    maxMessageCount,
    dateFrom,
    dateTo,
    recentWithin,
    scope: scope || 'session',
    resultMode: resultMode || 'matches',
    maxResults: clampPositiveInt(args.max_results, HISTORY_SEARCH_TOOL_DEFAULT_MAX_RESULTS, HISTORY_SEARCH_TOOL_MAX_RESULTS)
  };
}

function buildHistorySearchPlanFromStructuredArgs(normalizedArgs) {
  const filters = [];
  if (normalizedArgs.urlContains) {
    filters.push({
      key: 'url',
      value: normalizedArgs.urlContains,
      valueLower: normalizedArgs.urlContains.toLowerCase(),
      negated: false
    });
  }
  if (normalizedArgs.minMessageCount != null) {
    filters.push({
      key: 'count',
      operator: '>=',
      rangeStart: normalizedArgs.minMessageCount,
      rangeEnd: normalizedArgs.minMessageCount,
      negated: false
    });
  }
  if (normalizedArgs.maxMessageCount != null) {
    filters.push({
      key: 'count',
      operator: '<=',
      rangeStart: normalizedArgs.maxMessageCount,
      rangeEnd: normalizedArgs.maxMessageCount,
      negated: false
    });
  }
  if (normalizedArgs.dateFrom) {
    filters.push({
      key: 'date',
      operator: '>=',
      rangeStart: normalizedArgs.dateFrom.start,
      rangeEnd: normalizedArgs.dateFrom.end,
      negated: false
    });
  }
  if (normalizedArgs.dateTo) {
    filters.push({
      key: 'date',
      operator: '<=',
      rangeStart: normalizedArgs.dateTo.start,
      rangeEnd: normalizedArgs.dateTo.end,
      negated: false
    });
  }
  if (normalizedArgs.recentWithin) {
    filters.push({
      key: 'date',
      operator: normalizedArgs.recentWithin.operator,
      rangeStart: normalizedArgs.recentWithin.rangeStart,
      rangeEnd: normalizedArgs.recentWithin.rangeEnd,
      negated: false
    });
  }

  return {
    raw: '',
    normalized: '',
    positiveTerms: normalizedArgs.textAll.slice(),
    positiveTermsLower: normalizedArgs.textAll.map(item => item.toLowerCase()),
    negativeTerms: normalizedArgs.textNot.slice(),
    negativeTermsLower: normalizedArgs.textNot.map(item => item.toLowerCase()),
    filters,
    scope: normalizedArgs.scope === 'message' ? 'message' : 'session',
    hasText: normalizedArgs.textAll.length > 0 || normalizedArgs.textNot.length > 0,
    hasPositiveText: normalizedArgs.textAll.length > 0,
    hasNegativeText: normalizedArgs.textNot.length > 0
  };
}

function normalizeHistoryReadArguments(rawArgs) {
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs))
    ? rawArgs
    : {};
  const convRef = clampPositiveInt(args.conv_ref, 0);
  const start = clampPositiveInt(args.start, 0);
  const end = clampPositiveInt(args.end, 0);
  if (convRef <= 0) {
    throw new Error('history_read 参数错误：conv_ref 必须是从 1 开始的正整数。');
  }
  if (start <= 0 || end <= 0) {
    throw new Error('history_read 参数错误：start / end 必须是从 1 开始的正整数。');
  }
  if (end < start) {
    throw new Error('history_read 参数错误：end 不能小于 start。');
  }
  const threadRef = (args.thread_ref == null)
    ? null
    : clampPositiveInt(args.thread_ref, 0);
  if (args.thread_ref != null && threadRef <= 0) {
    throw new Error('history_read 参数错误：thread_ref 必须是从 1 开始的正整数。');
  }
  const readFullMessages = args.read_full_messages === true;
  return {
    convRef,
    start,
    end,
    threadRef,
    readFullMessages
  };
}

function compareConversationAbsoluteOrder(left, right) {
  const leftEnd = Number(left?.endTime) || 0;
  const rightEnd = Number(right?.endTime) || 0;
  if (leftEnd !== rightEnd) return leftEnd - rightEnd;

  const leftStart = Number(left?.startTime) || 0;
  const rightStart = Number(right?.startTime) || 0;
  if (leftStart !== rightStart) return leftStart - rightStart;

  return String(left?.id || '').localeCompare(String(right?.id || ''));
}

function compareConversationRecentOrder(left, right) {
  return compareConversationAbsoluteOrder(right, left);
}

/**
 * 基于“当前快照”生成会话绝对编号。
 *
 * 语义：
 * - 1-based；
 * - 最早 = 1；
 * - 最新 = N；
 * - 不持久化，只在当前工具快照里有效。
 *
 * @param {Array<Object>} conversationMetas
 * @returns {{orderedMetas:Array<Object>, metaById:Map<string,Object>, convRefById:Map<string,number>, convIdByRef:Map<number,string>}}
 */
export function buildConversationReferenceSnapshot(conversationMetas) {
  const orderedMetas = (Array.isArray(conversationMetas) ? conversationMetas : [])
    .filter(item => item && typeof item === 'object' && !Array.isArray(item) && item.id)
    .slice()
    .sort(compareConversationAbsoluteOrder);

  const metaById = new Map();
  const convRefById = new Map();
  const convIdByRef = new Map();

  orderedMetas.forEach((meta, index) => {
    const convRef = index + 1;
    metaById.set(meta.id, meta);
    convRefById.set(meta.id, convRef);
    convIdByRef.set(convRef, meta.id);
  });

  return {
    orderedMetas,
    metaById,
    convRefById,
    convIdByRef
  };
}

function normalizeThreadKey(message, rawIndex) {
  const threadId = typeof message?.threadId === 'string' ? message.threadId.trim() : '';
  if (threadId) return `thread:${threadId}`;
  const threadRootId = typeof message?.threadRootId === 'string' ? message.threadRootId.trim() : '';
  if (threadRootId) return `root:${threadRootId}`;
  const threadAnchorId = typeof message?.threadAnchorId === 'string' ? message.threadAnchorId.trim() : '';
  if (threadAnchorId) return `anchor:${threadAnchorId}`;
  return `orphan:${rawIndex}`;
}

function toReadableMessageRecord(message, indexField, indexValue) {
  return {
    [indexField]: indexValue,
    role: typeof message?.role === 'string' ? message.role : '',
    timestamp: Number(message?.timestamp) || 0,
    content: extractMessagePlainText(message, { includeHiddenThreadSelection: false })
  };
}

function buildHistoryReadMessageRecord(message, readFullMessages = false) {
  const base = (message && typeof message === 'object' && !Array.isArray(message))
    ? { ...message }
    : {};
  const rawContent = typeof base.content === 'string' ? base.content : '';
  const totalChars = rawContent.length;
  const shouldTruncate = !readFullMessages && totalChars > HISTORY_READ_MESSAGE_DEFAULT_MAX_CHARS;
  const content = shouldTruncate
    ? rawContent.slice(0, HISTORY_READ_MESSAGE_DEFAULT_MAX_CHARS)
    : rawContent;
  const returnedChars = content.length;
  const omittedChars = Math.max(0, totalChars - returnedChars);
  return {
    ...base,
    content,
    content_total_chars: totalChars,
    content_returned_chars: returnedChars,
    content_omitted_chars: omittedChars,
    content_omitted_pct: formatPercent(omittedChars, totalChars),
    content_truncated: omittedChars > 0,
    content_max_chars: readFullMessages ? null : HISTORY_READ_MESSAGE_DEFAULT_MAX_CHARS
  };
}

/**
 * 为单个会话构造“主线编号 + 线程编号”映射。
 *
 * 说明：
 * - 主线与线程分开编号，不拍平；
 * - `threadHiddenSelection` 默认不进入用户可见读取窗口；
 * - `thread_ref` 按“第一条可见线程消息的首次出现顺序”编号。
 *
 * @param {Object} conversation
 * @returns {{mainMessages:Array<Object>, mainByRawIndex:Map<number,Object>, mainMsgIndexByMessageId:Map<string,number>, threads:Array<Object>, threadByRawIndex:Map<number,Object>}}
 */
export function buildConversationReadReferenceMap(conversation) {
  const list = Array.isArray(conversation?.messages) ? conversation.messages : [];
  const mainMessages = [];
  const mainByRawIndex = new Map();
  const mainMsgIndexByMessageId = new Map();
  const threadEntriesByKey = new Map();

  const ensureThreadEntry = (key, message, rawIndex) => {
    if (threadEntriesByKey.has(key)) return threadEntriesByKey.get(key);
    const entry = {
      key,
      firstVisibleRawIndex: rawIndex,
      anchorMessageId: typeof message?.threadAnchorId === 'string' ? message.threadAnchorId.trim() : '',
      rootMessageId: typeof message?.threadRootId === 'string' ? message.threadRootId.trim() : '',
      messages: []
    };
    threadEntriesByKey.set(key, entry);
    return entry;
  };

  for (let rawIndex = 0; rawIndex < list.length; rawIndex += 1) {
    const message = list[rawIndex];
    if (!message) continue;
    if (isThreadMessageLike(message)) continue;
    const msgIndex = mainMessages.length + 1;
    const record = toReadableMessageRecord(message, 'msg_index', msgIndex);
    mainMessages.push(record);
    mainByRawIndex.set(rawIndex, {
      msg_index: msgIndex
    });
    if (typeof message?.id === 'string' && message.id.trim()) {
      mainMsgIndexByMessageId.set(message.id.trim(), msgIndex);
    }
  }

  for (let rawIndex = 0; rawIndex < list.length; rawIndex += 1) {
    const message = list[rawIndex];
    if (!message || !isThreadMessageLike(message) || message?.threadHiddenSelection) continue;
    const key = normalizeThreadKey(message, rawIndex);
    const entry = ensureThreadEntry(key, message, rawIndex);
    if (rawIndex < entry.firstVisibleRawIndex) {
      entry.firstVisibleRawIndex = rawIndex;
    }
    if (!entry.anchorMessageId && typeof message?.threadAnchorId === 'string' && message.threadAnchorId.trim()) {
      entry.anchorMessageId = message.threadAnchorId.trim();
    }
    if (!entry.rootMessageId && typeof message?.threadRootId === 'string' && message.threadRootId.trim()) {
      entry.rootMessageId = message.threadRootId.trim();
    }
    entry.messages.push({
      rawIndex,
      message
    });
  }

  const threads = Array.from(threadEntriesByKey.values())
    .filter(entry => entry.messages.length > 0)
    .sort((left, right) => left.firstVisibleRawIndex - right.firstVisibleRawIndex || left.key.localeCompare(right.key))
    .map((entry, threadOffset) => {
      const threadRef = threadOffset + 1;
      const messages = entry.messages.map(({ message }, index) => toReadableMessageRecord(message, 'thread_msg_index', index + 1));
      return {
        thread_ref: threadRef,
        thread_message_count: messages.length,
        thread_anchor_msg_index: entry.anchorMessageId ? (mainMsgIndexByMessageId.get(entry.anchorMessageId) || null) : null,
        key: entry.key,
        messages
      };
    });

  const threadByRawIndex = new Map();
  threads.forEach((thread) => {
    const sourceEntry = threadEntriesByKey.get(thread.key);
    if (!sourceEntry) return;
    sourceEntry.messages.forEach(({ rawIndex }, index) => {
      threadByRawIndex.set(rawIndex, {
        thread_ref: thread.thread_ref,
        thread_msg_index: index + 1
      });
    });
  });

  return {
    mainMessages,
    mainByRawIndex,
    mainMsgIndexByMessageId,
    threads: threads.map(({ key, ...rest }) => rest),
    threadByRawIndex
  };
}

function collectExcerptRanges(sourceText, highlightTerms, contextChars = HISTORY_SEARCH_EXCERPT_CONTEXT_CHARS) {
  if (!sourceText) return [];
  const seen = new Set();
  const ranges = [];
  const lowerText = sourceText.toLowerCase();

  for (const term of Array.isArray(highlightTerms) ? highlightTerms : []) {
    const lowerTerm = typeof term === 'string' ? term.trim().toLowerCase() : '';
    if (!lowerTerm || seen.has(lowerTerm)) continue;
    seen.add(lowerTerm);
    let fromIndex = 0;
    while (fromIndex < lowerText.length) {
      const index = lowerText.indexOf(lowerTerm, fromIndex);
      if (index === -1) break;
      ranges.push({
        start: Math.max(0, index - contextChars),
        end: Math.min(sourceText.length, index + lowerTerm.length + contextChars)
      });
      fromIndex = index + Math.max(1, lowerTerm.length);
    }
  }

  if (!ranges.length) return [];
  ranges.sort((left, right) => left.start - right.start);
  const merged = [];
  for (const range of ranges) {
    if (!merged.length) {
      merged.push({ ...range });
      continue;
    }
    const last = merged[merged.length - 1];
    if (range.start <= last.end + 8) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function countMatchedTerms(sourceText, highlightTerms) {
  const lowerText = sourceText.toLowerCase();
  const seen = new Set();
  let count = 0;
  for (const term of Array.isArray(highlightTerms) ? highlightTerms : []) {
    const lowerTerm = typeof term === 'string' ? term.trim().toLowerCase() : '';
    if (!lowerTerm || seen.has(lowerTerm)) continue;
    seen.add(lowerTerm);
    if (lowerText.includes(lowerTerm)) count += 1;
  }
  return count;
}

function buildPlainSearchExcerpt(sourceText, highlightTerms) {
  const ranges = collectExcerptRanges(sourceText, highlightTerms);
  if (!ranges.length) return '';
  return ranges
    .map(range => sourceText.slice(range.start, range.end).trim())
    .filter(Boolean)
    .join(' … ');
}

function buildToolSearchExcerpts(matchedMessages, highlightTerms) {
  const list = (Array.isArray(matchedMessages) ? matchedMessages : [])
    .map((item) => ({
      ...item,
      excerpt: buildPlainSearchExcerpt(item.plainText || '', highlightTerms),
      matchedTermCount: countMatchedTerms(item.plainText || '', highlightTerms)
    }))
    .filter(item => item.excerpt);

  list.sort((left, right) => {
    const coverageDelta = right.matchedTermCount - left.matchedTermCount;
    if (coverageDelta !== 0) return coverageDelta;
    const hitDelta = (Number(right.hitCount) || 0) - (Number(left.hitCount) || 0);
    if (hitDelta !== 0) return hitDelta;
    return (Number(left.rawMessageIndex) || 0) - (Number(right.rawMessageIndex) || 0);
  });

  return list.slice(0, HISTORY_SEARCH_MAX_EXCERPTS).map(item => item.excerpt);
}

function buildMatchLocations(referenceMap, matchedMessages) {
  const locations = [];
  const seen = new Set();

  for (const item of Array.isArray(matchedMessages) ? matchedMessages : []) {
    const rawIndex = Number(item?.rawMessageIndex);
    if (!Number.isFinite(rawIndex)) continue;
    let location = referenceMap.mainByRawIndex.get(rawIndex) || null;
    if (!location) location = referenceMap.threadByRawIndex.get(rawIndex) || null;
    if (!location) continue;
    const key = JSON.stringify(location);
    if (seen.has(key)) continue;
    seen.add(key);
    locations.push(location);
  }

  return locations;
}

function buildVisibleConversationCounts(referenceMap) {
  const mainCount = Array.isArray(referenceMap?.mainMessages) ? referenceMap.mainMessages.length : 0;
  const threadCount = Array.isArray(referenceMap?.threads) ? referenceMap.threads.length : 0;
  const visibleThreadMessageCount = Array.isArray(referenceMap?.threads)
    ? referenceMap.threads.reduce((sum, item) => sum + (Number(item?.thread_message_count) || 0), 0)
    : 0;
  return {
    message_count: mainCount + visibleThreadMessageCount,
    main_message_count: mainCount,
    thread_message_count: visibleThreadMessageCount,
    thread_count: threadCount
  };
}

function formatLocalIsoOffset(timestamp) {
  const numeric = Number(timestamp);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  const date = new Date(numeric);
  if (!Number.isFinite(date.getTime())) return '';

  const pad = (value, length = 2) => String(value).padStart(length, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  const milliseconds = pad(date.getMilliseconds(), 3);

  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = pad(Math.floor(absOffsetMinutes / 60));
  const offsetRemainderMinutes = pad(absOffsetMinutes % 60);

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}${sign}${offsetHours}:${offsetRemainderMinutes}`;
}

function buildConversationMetadataResult(meta, snapshot, visibleCounts = null) {
  const counts = visibleCounts || {
    message_count: Number(meta?.messageCount) || 0,
    main_message_count: Number(meta?.mainMessageCount) || 0,
    thread_message_count: Number(meta?.threadMessageCount) || 0,
    thread_count: Number(meta?.threadCount) || 0
  };
  const parentConversationId = (typeof meta?.parentConversationId === 'string' && meta.parentConversationId.trim())
    ? meta.parentConversationId.trim()
    : '';
  const parentConvRef = parentConversationId ? (snapshot?.convRefById?.get(parentConversationId) || null) : null;
  const createdAtMs = Number(meta?.startTime) || 0;
  const updatedAtMs = Number(meta?.endTime) || 0;

  return {
    conv_ref: snapshot?.convRefById?.get(meta?.id) || 0,
    page_title: typeof meta?.title === 'string' ? meta.title : '',
    conversation_title: typeof meta?.summary === 'string' ? meta.summary : '',
    url: typeof meta?.url === 'string' ? meta.url : '',
    created_at: formatLocalIsoOffset(createdAtMs),
    updated_at: formatLocalIsoOffset(updatedAtMs),
    message_count: counts.message_count,
    main_message_count: counts.main_message_count,
    thread_message_count: counts.thread_message_count,
    thread_count: counts.thread_count,
    has_threads: counts.thread_count > 0,
    is_branch: !!parentConversationId,
    parent_conv_ref: parentConvRef,
    has_api_lock: !!(meta?.apiLock && typeof meta.apiLock === 'object'),
    ...(Number.isFinite(Number(meta?.urlMatchLevel))
      ? { url_match_level: Math.max(0, Math.trunc(Number(meta.urlMatchLevel))) }
      : {}),
    ...((typeof meta?.urlMatchPrefix === 'string' && meta.urlMatchPrefix)
      ? { url_match_prefix: meta.urlMatchPrefix }
      : {})
  };
}

function buildCurrentPageUrlFilter(normalizedArgs, dependencies) {
  if (!normalizedArgs?.currentPageOnly) {
    return {
      active: false,
      currentPageUrl: '',
      candidateUrls: []
    };
  }

  const currentPageUrl = typeof dependencies?.currentPageUrl === 'string'
    ? dependencies.currentPageUrl.trim()
    : '';
  if (!currentPageUrl) {
    throw new Error('history_search 参数错误：current_page_only=true 时当前页面 URL 不可用。');
  }

  const candidateUrls = generateCandidateUrls(currentPageUrl);
  if (!candidateUrls.length) {
    throw new Error('history_search 参数错误：current_page_only=true 时未生成可用的 URL 匹配前缀。');
  }

  return {
    active: true,
    currentPageUrl,
    candidateUrls
  };
}

function applyCurrentPageUrlFilter(meta, currentPageFilter) {
  if (!currentPageFilter?.active) return meta;
  const match = findBestCandidateUrlPrefixMatch(meta?.url, currentPageFilter.candidateUrls);
  if (!match) return null;
  return {
    ...meta,
    urlMatchLevel: match.urlMatchLevel,
    urlMatchPrefix: match.urlMatchPrefix
  };
}

/**
 * 基于快照搜索历史会话。
 *
 * @param {any} rawArgs
 * @param {{snapshot:Object, currentPageUrl?:string, loadConversationsByIds:(ids:string[]) => Promise<Array<Object>>}} dependencies
 * @returns {Promise<Object>}
 */
export async function executeHistorySearchTool(rawArgs, dependencies = {}) {
  const normalizedArgs = normalizeHistorySearchArguments(rawArgs);
  const { maxResults, resultMode } = normalizedArgs;
  const snapshot = dependencies?.snapshot;
  if (!snapshot || !Array.isArray(snapshot.orderedMetas)) {
    throw new Error('history_search 缺少可用的会话快照。');
  }
  if (typeof dependencies?.loadConversationsByIds !== 'function') {
    throw new Error('history_search 缺少会话读取函数。');
  }

  const searchPlan = buildHistorySearchPlanFromStructuredArgs(normalizedArgs);
  const textPlan = buildChatHistoryTextPlan(searchPlan);
  const currentPageFilter = buildCurrentPageUrlFilter(normalizedArgs, dependencies);
  const resolvedScope = textPlan.hasPositive || textPlan.hasNegative
    ? (searchPlan.scope === 'message' ? 'message' : 'session')
    : 'session';
  const shouldUseMetaMatch = resolvedScope === 'session';

  const matchedEntries = [];
  const pendingMessageScans = [];
  const matchedConversationById = new Map();

  for (const rawMeta of snapshot.orderedMetas) {
    const meta = applyCurrentPageUrlFilter(rawMeta, currentPageFilter);
    if (!meta) continue;
    if (!evaluateChatHistoryFilters(meta, searchPlan.filters)) continue;

    if (!searchPlan.hasText) {
      matchedEntries.push({
        meta,
        matchInfo: {
          reason: 'meta',
          totalHitCount: 0,
          matchedMessageCount: 0,
          matchedMessages: []
        }
      });
      continue;
    }

    if (!shouldUseMetaMatch) {
      pendingMessageScans.push({ meta, remainingTerms: null });
      continue;
    }

    const metaText = buildMetaSearchText(meta);
    const metaResult = evaluateMetaTextMatch(metaText, textPlan);
    if (metaResult.blocked) continue;
    const remainingTerms = Array.from(metaResult.remaining || []);
    const needsMessageScan = textPlan.hasNegative || remainingTerms.length > 0;
    if (!needsMessageScan) {
      matchedEntries.push({
        meta,
        matchInfo: {
          reason: 'meta',
          totalHitCount: 0,
          matchedMessageCount: 0,
          matchedMessages: []
        }
      });
      continue;
    }

    pendingMessageScans.push({ meta, remainingTerms });
  }

  if (pendingMessageScans.length > 0) {
    const conversations = await dependencies.loadConversationsByIds(pendingMessageScans.map(item => item.meta.id));
    const conversationById = new Map();
    for (const conversation of Array.isArray(conversations) ? conversations : []) {
      if (conversation?.id) conversationById.set(conversation.id, conversation);
    }

    for (const item of pendingMessageScans) {
      const conversation = conversationById.get(item.meta.id);
      if (!conversation) continue;
      const inlineScan = scanConversationMessagesForSearch(
        conversation,
        textPlan,
        item.remainingTerms,
        { includeHiddenThreadSelection: false }
      );
      if (inlineScan.blocked || !inlineScan.matched) continue;
      matchedConversationById.set(item.meta.id, conversation);
      matchedEntries.push({
        meta: item.meta,
        matchInfo: inlineScan.matchInfo
      });
    }
  }

  matchedEntries.sort((left, right) => compareConversationRecentOrder(left.meta, right.meta));

  const topEntries = matchedEntries.slice(0, maxResults);
  const missingVisibleCountIds = topEntries
    .map(entry => entry?.meta?.id)
    .filter(id => id && !matchedConversationById.has(id));
  if (missingVisibleCountIds.length > 0) {
    const extraConversations = await dependencies.loadConversationsByIds(missingVisibleCountIds);
    for (const conversation of Array.isArray(extraConversations) ? extraConversations : []) {
      if (conversation?.id) matchedConversationById.set(conversation.id, conversation);
    }
  }

  const results = topEntries.map(({ meta, matchInfo }) => {
    const conversation = matchedConversationById.get(meta.id) || null;
    const referenceMap = conversation ? buildConversationReadReferenceMap(conversation) : null;
    const conversationStats = referenceMap
      ? buildVisibleConversationCounts(referenceMap)
      : null;
    let locations = [];
    let excerpts = [];
    if (matchInfo?.matchedMessages?.length && referenceMap) {
      locations = buildMatchLocations(referenceMap, matchInfo.matchedMessages);
      excerpts = buildToolSearchExcerpts(matchInfo.matchedMessages, textPlan.highlightLower);
    }

    const base = buildConversationMetadataResult(meta, snapshot, conversationStats);
    if (resultMode === 'metadata_only') {
      return base;
    }
    return {
      ...base,
      match: {
        reason: matchInfo?.reason || 'meta',
        total_hit_count: Number(matchInfo?.totalHitCount) || 0,
        matched_message_count: Number(matchInfo?.matchedMessageCount) || 0,
        locations,
        excerpts
      }
    };
  });

  return {
    ok: true,
    query: {
      text_all: normalizedArgs.textAll,
      text_not: normalizedArgs.textNot,
      url_contains: normalizedArgs.urlContains || null,
      current_page_only: normalizedArgs.currentPageOnly,
      current_page_url: currentPageFilter.active ? currentPageFilter.currentPageUrl : null,
      min_message_count: normalizedArgs.minMessageCount,
      max_message_count: normalizedArgs.maxMessageCount,
      date_from: rawArgs?.date_from ?? null,
      date_to: rawArgs?.date_to ?? null,
      recent_within: normalizedArgs.recentWithin ? rawArgs?.recent_within ?? null : null,
      scope: normalizedArgs.scope,
      result_mode: normalizedArgs.resultMode
    },
    max_results: maxResults,
    result_mode: resultMode,
    total_matches: matchedEntries.length,
    results
  };
}

/**
 * 按主线或线程窗口读取单个会话。
 *
 * @param {any} rawArgs
 * @param {{snapshot:Object, loadConversationById:(id:string)=>Promise<Object|null>}} dependencies
 * @returns {Promise<Object>}
 */
export async function executeHistoryReadTool(rawArgs, dependencies = {}) {
  const { convRef, start, end, threadRef, readFullMessages } = normalizeHistoryReadArguments(rawArgs);
  const snapshot = dependencies?.snapshot;
  if (!snapshot || !(snapshot.convIdByRef instanceof Map)) {
    throw new Error('history_read 缺少可用的会话快照。');
  }
  if (typeof dependencies?.loadConversationById !== 'function') {
    throw new Error('history_read 缺少单会话读取函数。');
  }

  const conversationId = snapshot.convIdByRef.get(convRef);
  if (!conversationId) {
    throw new Error(`history_read 找不到 conv_ref=${convRef} 对应的会话。`);
  }
  const conversation = await dependencies.loadConversationById(conversationId);
  if (!conversation) {
    throw new Error(`history_read 无法读取 conv_ref=${convRef} 对应的会话内容。`);
  }

  const referenceMap = buildConversationReadReferenceMap(conversation);
  const meta = snapshot.metaById.get(conversationId) || {};
  const visibleCounts = buildVisibleConversationCounts(referenceMap);

  if (threadRef == null) {
    if (start > referenceMap.mainMessages.length) {
      throw new Error(`history_read 读取范围超出主线消息总数（共 ${referenceMap.mainMessages.length} 条）。`);
    }
    const effectiveEnd = Math.min(end, referenceMap.mainMessages.length);
    return {
      ok: true,
      conv_ref: convRef,
      ...buildConversationMetadataResult(meta, snapshot, visibleCounts),
      scope: 'main',
      read_full_messages: readFullMessages,
      message_truncation_max_chars: readFullMessages ? null : HISTORY_READ_MESSAGE_DEFAULT_MAX_CHARS,
      start,
      end: effectiveEnd,
      messages: referenceMap.mainMessages
        .slice(start - 1, effectiveEnd)
        .map(message => buildHistoryReadMessageRecord(message, readFullMessages))
    };
  }

  const thread = referenceMap.threads.find(item => item.thread_ref === threadRef);
  if (!thread) {
    throw new Error(`history_read 找不到 thread_ref=${threadRef} 对应的线程。`);
  }
  if (start > thread.messages.length) {
    throw new Error(`history_read 读取范围超出线程消息总数（共 ${thread.messages.length} 条）。`);
  }
  const effectiveEnd = Math.min(end, thread.messages.length);
  return {
    ok: true,
    conv_ref: convRef,
    ...buildConversationMetadataResult(meta, snapshot, visibleCounts),
    scope: 'thread',
    read_full_messages: readFullMessages,
    message_truncation_max_chars: readFullMessages ? null : HISTORY_READ_MESSAGE_DEFAULT_MAX_CHARS,
    thread_ref: thread.thread_ref,
    thread_message_count: thread.thread_message_count,
    thread_anchor_msg_index: thread.thread_anchor_msg_index,
    start,
    end: effectiveEnd,
    messages: thread.messages
      .slice(start - 1, effectiveEnd)
      .map(message => buildHistoryReadMessageRecord(message, readFullMessages))
  };
}
