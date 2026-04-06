import {
  buildChatHistorySearchPlan,
  buildChatHistoryTextPlan,
  buildMetaSearchText,
  evaluateChatHistoryFilters,
  evaluateMetaTextMatch,
  extractMessagePlainText,
  isThreadMessageLike,
  scanConversationMessagesForSearch
} from './chat_history_search_shared.js';

export const HISTORY_SEARCH_TOOL_DEFAULT_MAX_RESULTS = 20;
export const HISTORY_SEARCH_TOOL_MAX_RESULTS = 100;
export const HISTORY_SEARCH_EXCERPT_CONTEXT_CHARS = 40;
export const HISTORY_SEARCH_MAX_EXCERPTS = 3;

function clampPositiveInt(value, fallback, max = Number.POSITIVE_INFINITY) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(Math.trunc(numeric), max));
}

function normalizeHistorySearchArguments(rawArgs) {
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs))
    ? rawArgs
    : {};
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    throw new Error('history_search 参数错误：query 不能为空。');
  }
  return {
    query,
    maxResults: clampPositiveInt(args.max_results, HISTORY_SEARCH_TOOL_DEFAULT_MAX_RESULTS, HISTORY_SEARCH_TOOL_MAX_RESULTS)
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
  return {
    convRef,
    start,
    end,
    threadRef
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
    thread_count: threadCount
  };
}

/**
 * 基于快照搜索历史会话。
 *
 * @param {any} rawArgs
 * @param {{snapshot:Object, loadConversationsByIds:(ids:string[]) => Promise<Array<Object>>}} dependencies
 * @returns {Promise<Object>}
 */
export async function executeHistorySearchTool(rawArgs, dependencies = {}) {
  const { query, maxResults } = normalizeHistorySearchArguments(rawArgs);
  const snapshot = dependencies?.snapshot;
  if (!snapshot || !Array.isArray(snapshot.orderedMetas)) {
    throw new Error('history_search 缺少可用的会话快照。');
  }
  if (typeof dependencies?.loadConversationsByIds !== 'function') {
    throw new Error('history_search 缺少会话读取函数。');
  }

  const searchPlan = buildChatHistorySearchPlan(query);
  const textPlan = buildChatHistoryTextPlan(searchPlan);
  const resolvedScope = textPlan.hasPositive || textPlan.hasNegative
    ? (searchPlan.scope === 'message' ? 'message' : 'session')
    : 'session';
  const shouldUseMetaMatch = resolvedScope === 'session';

  const matchedEntries = [];
  const pendingMessageScans = [];
  const matchedConversationById = new Map();

  for (const meta of snapshot.orderedMetas) {
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
    const convRef = snapshot.convRefById.get(meta.id) || 0;
    const conversation = matchedConversationById.get(meta.id) || null;
    const referenceMap = conversation ? buildConversationReadReferenceMap(conversation) : null;
    const conversationStats = referenceMap
      ? buildVisibleConversationCounts(referenceMap)
      : {
        message_count: Number(meta?.messageCount) || 0,
        main_message_count: Number(meta?.mainMessageCount) || 0,
        thread_count: Number(meta?.threadCount) || 0
      };
    let locations = [];
    let excerpts = [];
    if (matchInfo?.matchedMessages?.length && referenceMap) {
      locations = buildMatchLocations(referenceMap, matchInfo.matchedMessages);
      excerpts = buildToolSearchExcerpts(matchInfo.matchedMessages, textPlan.highlightLower);
    }

    return {
      conv_ref: convRef,
      title: typeof meta?.title === 'string' ? meta.title : '',
      url: typeof meta?.url === 'string' ? meta.url : '',
      summary: typeof meta?.summary === 'string' ? meta.summary : '',
      ...conversationStats,
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
    query,
    max_results: maxResults,
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
  const { convRef, start, end, threadRef } = normalizeHistoryReadArguments(rawArgs);
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
      title: typeof meta?.title === 'string' ? meta.title : '',
      url: typeof meta?.url === 'string' ? meta.url : '',
      message_count: visibleCounts.message_count,
      main_message_count: visibleCounts.main_message_count,
      thread_count: visibleCounts.thread_count,
      scope: 'main',
      start,
      end: effectiveEnd,
      messages: referenceMap.mainMessages.slice(start - 1, effectiveEnd)
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
    title: typeof meta?.title === 'string' ? meta.title : '',
    url: typeof meta?.url === 'string' ? meta.url : '',
    scope: 'thread',
    thread_ref: thread.thread_ref,
    thread_message_count: thread.thread_message_count,
    thread_anchor_msg_index: thread.thread_anchor_msg_index,
    start,
    end: effectiveEnd,
    messages: thread.messages.slice(start - 1, effectiveEnd)
  };
}
