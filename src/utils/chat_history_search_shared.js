/**
 * 聊天记录搜索共享纯函数。
 *
 * 设计目标：
 * - 让 UI 搜索与工具搜索复用同一套 query 语法与匹配规则；
 * - 只处理“用户可见消息正文”这类纯数据，不触碰 DOM；
 * - 保持可配置：例如线程隐藏占位消息是否纳入搜索，由调用方决定。
 */

export const CHAT_HISTORY_SEARCH_FILTER_KEYS = new Map([
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

export const CHAT_HISTORY_SEARCH_SCOPE_VALUES = new Map([
  ['message', 'message'],
  ['msg', 'message'],
  ['messages', 'message'],
  ['消息', 'message'],
  ['session', 'session'],
  ['conversation', 'session'],
  ['conv', 'session'],
  ['会话', 'session']
]);

function escapeRegExp(rawValue) {
  return String(rawValue ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function tokenizeSearchQuery(rawInput) {
  const input = typeof rawInput === 'string' ? rawInput : '';
  const tokens = [];
  let buffer = '';
  let inQuotes = false;
  let escapeNext = false;

  for (let i = 0; i < input.length; i += 1) {
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

export function normalizeSearchTerms(rawTerms) {
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
 * 从消息 content 中提取“用户可见文本”。
 *
 * 说明：
 * - 只关心消息正文，不读取 tool output / hidden contextual items / footer 等内部字段；
 * - 数组型多模态消息里，图片会折叠为 `[图片]`，便于搜索与阅读时保留存在感。
 *
 * @param {string|Array<any>|null|undefined} content
 * @returns {string}
 */
export function extractPlainTextFromMessageContent(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part?.type === 'image_url') return '[图片]';
        return part?.text?.trim() || '';
      })
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

export function isThreadMessageLike(message) {
  const threadId = typeof message?.threadId === 'string' && message.threadId.trim();
  const threadRootId = typeof message?.threadRootId === 'string' && message.threadRootId.trim();
  const threadAnchorId = typeof message?.threadAnchorId === 'string' && message.threadAnchorId.trim();
  return !!(threadId || threadRootId || threadAnchorId || message?.threadHiddenSelection);
}

export function extractMessagePlainText(message, options = {}) {
  if (!message) return '';
  const includeHiddenThreadSelection = options?.includeHiddenThreadSelection === true;
  if (!includeHiddenThreadSelection && message?.threadHiddenSelection) {
    return '';
  }
  return extractPlainTextFromMessageContent(message.content);
}

/**
 * 为聊天搜索构造持久化的轻量正文投影。
 *
 * 投影只保留搜索真正需要的小写正文，不复制 tool output、隐藏上下文、图片对象等重字段。
 * 它只用于快速排除不可能命中的会话；最终命中与摘录仍由完整消息扫描确认，因此不会改变搜索语义。
 *
 * @param {Object} conversation
 * @param {{includeHiddenThreadSelection?:boolean}} [options]
 * @returns {{id:string, textLower:string}}
 */
export function buildConversationSearchProjection(conversation, options = {}) {
  const id = typeof conversation?.id === 'string' ? conversation.id : '';
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  const textParts = [];
  for (const message of messages) {
    const plainText = extractMessagePlainText(message, options);
    if (plainText) textParts.push(plainText.toLowerCase());
  }
  return { id, textLower: textParts.join('\n') };
}

/**
 * 用轻量正文投影判断会话是否“可能”命中，供读取完整会话前做低成本裁剪。
 *
 * message scope 下，不同正向词可能分散在不同消息中，所以这里只能排除缺词会话；
 * session scope 下，正向词与否定词都可安全预判。返回 true 仍必须执行完整消息扫描。
 *
 * @param {{textLower?:string}} projection
 * @param {{positiveLower?:string[], negativeLower?:string[], hasNegative?:boolean, scope?:string}} textPlan
 * @param {string[]|null} [remainingTerms=null]
 * @returns {boolean}
 */
export function canConversationSearchProjectionMatch(projection, textPlan, remainingTerms = null) {
  const textLower = typeof projection?.textLower === 'string' ? projection.textLower : '';
  const scope = resolveSearchScope(textPlan);
  const positiveTerms = scope === 'message'
    ? (Array.isArray(textPlan?.positiveLower) ? textPlan.positiveLower : [])
    : (Array.isArray(remainingTerms)
      ? remainingTerms
      : (Array.isArray(textPlan?.positiveLower) ? textPlan.positiveLower : []));

  for (const term of positiveTerms) {
    if (term && !textLower.includes(term)) return false;
  }

  if (scope === 'session' && textPlan?.hasNegative) {
    const negativeTerms = Array.isArray(textPlan?.negativeLower) ? textPlan.negativeLower : [];
    for (const term of negativeTerms) {
      if (term && textLower.includes(term)) return false;
    }
  }

  return true;
}

/**
 * 统计会话的主线/线程消息结构。
 *
 * @param {Array<Object>} messages
 * @returns {{totalCount:number, mainMessageCount:number, threadMessageCount:number, threadCount:number}}
 */
export function computeConversationMessageStats(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let totalCount = 0;
  let mainMessageCount = 0;
  let threadMessageCount = 0;
  const threadIds = new Set();

  for (const message of list) {
    if (!message) continue;
    totalCount += 1;
    if (isThreadMessageLike(message)) {
      threadMessageCount += 1;
      const threadId = typeof message?.threadId === 'string' && message.threadId.trim()
        ? message.threadId.trim()
        : (typeof message?.threadRootId === 'string' && message.threadRootId.trim()
          ? `root:${message.threadRootId.trim()}`
          : (typeof message?.threadAnchorId === 'string' && message.threadAnchorId.trim()
            ? `anchor:${message.threadAnchorId.trim()}`
            : ''));
      if (threadId) threadIds.add(threadId);
    } else {
      mainMessageCount += 1;
    }
  }

  return {
    totalCount,
    mainMessageCount,
    threadMessageCount,
    threadCount: threadIds.size
  };
}

export function resolveSearchScope(textPlan) {
  if (!textPlan) return 'session';
  if (textPlan.scope === 'message' && textPlan.hasPositive) return 'message';
  return 'session';
}

export function parseSearchOperatorValue(rawValue) {
  const input = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!input) return null;
  const match = input.match(/^(>=|<=|==|!=|=|>|<)?\s*(.+)$/);
  if (!match) return null;
  const operator = match[1] || '=';
  const operand = (match[2] || '').trim();
  if (!operand) return null;
  return { operator, operand };
}

export function parseRelativeDateRange(rawValue) {
  const input = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!input) return null;
  const match = input.match(/^(\d+)\s*([dhwmy])$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase();
  const end = Date.now();
  const startDate = new Date(end);
  switch (unit) {
    case 'h':
      startDate.setHours(startDate.getHours() - amount);
      break;
    case 'd':
      startDate.setDate(startDate.getDate() - amount);
      break;
    case 'w':
      startDate.setDate(startDate.getDate() - amount * 7);
      break;
    case 'm':
      startDate.setMonth(startDate.getMonth() - amount);
      break;
    case 'y':
      startDate.setFullYear(startDate.getFullYear() - amount);
      break;
    default:
      return null;
  }
  const start = startDate.getTime();
  if (!Number.isFinite(start)) return null;
  return { start, end, isRelative: true };
}

export function parseSearchDateRange(rawValue) {
  const input = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!input) return null;

  const relativeRange = parseRelativeDateRange(input);
  if (relativeRange) return relativeRange;

  if (/^\d{10}$/.test(input)) {
    const seconds = Number(input);
    if (!Number.isFinite(seconds)) return null;
    const ts = seconds * 1000;
    return { start: ts, end: ts };
  }

  if (/^\d{13}$/.test(input)) {
    const ms = Number(input);
    if (!Number.isFinite(ms)) return null;
    return { start: ms, end: ms };
  }

  const compactDateMatch = input.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compactDateMatch) {
    const year = Number(compactDateMatch[1]);
    const month = Number(compactDateMatch[2]);
    const day = Number(compactDateMatch[3]);
    const start = new Date(year, month - 1, day);
    if (!Number.isFinite(start.getTime())) return null;
    const startMs = start.getTime();
    return { start: startMs, end: startMs + 24 * 60 * 60 * 1000 - 1 };
  }

  const dateMatch = input.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (dateMatch) {
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    const start = new Date(year, month - 1, day);
    if (!Number.isFinite(start.getTime())) return null;
    const startMs = start.getTime();
    return { start: startMs, end: startMs + 24 * 60 * 60 * 1000 - 1 };
  }

  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed)) return null;
  return { start: parsed, end: parsed };
}

export function parseSearchFilterToken(rawToken) {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!token) return null;
  const colonIndex = token.indexOf(':');
  if (colonIndex <= 0) return null;
  const rawKey = token.slice(0, colonIndex).trim().toLowerCase();
  const rawValue = token.slice(colonIndex + 1).trim();
  if (!rawValue) return null;
  const key = CHAT_HISTORY_SEARCH_FILTER_KEYS.get(rawKey);
  if (!key) return null;

  if (key === 'url') {
    return {
      key,
      value: rawValue,
      valueLower: rawValue.toLowerCase()
    };
  }

  if (key === 'scope') {
    const rawScope = rawValue.trim();
    if (!rawScope) return null;
    const normalized = CHAT_HISTORY_SEARCH_SCOPE_VALUES.get(rawScope.toLowerCase())
      || CHAT_HISTORY_SEARCH_SCOPE_VALUES.get(rawScope);
    if (!normalized) return null;
    return { key, value: normalized };
  }

  const parsed = parseSearchOperatorValue(rawValue);
  if (!parsed) return null;

  if (key === 'count') {
    const numericValue = Number(parsed.operand);
    if (!Number.isFinite(numericValue)) return null;
    return { key, operator: parsed.operator, rangeStart: numericValue, rangeEnd: numericValue };
  }

  if (key === 'date') {
    const range = parseSearchDateRange(parsed.operand);
    if (!range) return null;
    let operator = parsed.operator;
    if (range.isRelative) {
      if (operator === '>' || operator === '>=') {
        operator = '!=';
      } else if (operator === '<' || operator === '<=' || operator === '=' || operator === '==') {
        operator = '=';
      }
    }
    return { key, operator, rangeStart: range.start, rangeEnd: range.end };
  }

  return null;
}

export function buildChatHistorySearchPlan(rawFilter) {
  const raw = typeof rawFilter === 'string' ? rawFilter : '';
  const normalized = raw.trim().toLowerCase();
  const tokens = tokenizeSearchQuery(raw);
  const terms = [];
  const negativeTerms = [];
  const filters = [];
  let scope = 'session';

  tokens.forEach((token) => {
    let working = token.trim();
    if (!working) return;
    let negated = false;
    while (working.startsWith('!')) {
      negated = !negated;
      working = working.slice(1);
    }
    if (!working) return;

    const filter = parseSearchFilterToken(working);
    if (filter) {
      if (filter.key === 'scope') {
        if (!negated && filter.value) {
          scope = filter.value;
        }
        return;
      }
      filter.negated = negated;
      filters.push(filter);
      return;
    }

    if (negated) {
      negativeTerms.push(working);
    } else {
      terms.push(working);
    }
  });

  const positive = normalizeSearchTerms(terms);
  const negative = normalizeSearchTerms(negativeTerms);

  return {
    raw,
    normalized,
    positiveTerms: positive.raw,
    positiveTermsLower: positive.lower,
    negativeTerms: negative.raw,
    negativeTermsLower: negative.lower,
    filters,
    scope,
    hasText: positive.lower.length > 0 || negative.lower.length > 0,
    hasPositiveText: positive.lower.length > 0,
    hasNegativeText: negative.lower.length > 0
  };
}

export function compareNumericRange(value, operator, rangeStart, rangeEnd) {
  const numericValue = Number(value) || 0;
  switch (operator) {
    case '>':
      return numericValue > rangeEnd;
    case '>=':
      return numericValue >= rangeStart;
    case '<':
      return numericValue < rangeStart;
    case '<=':
      return numericValue <= rangeEnd;
    case '!=':
      return numericValue < rangeStart || numericValue > rangeEnd;
    case '=':
    case '==':
      return numericValue >= rangeStart && numericValue <= rangeEnd;
    default:
      return false;
  }
}

export function compareMessageDateRange(startTime, endTime, operator, rangeStart, rangeEnd) {
  const convStart = Number(startTime) || 0;
  const convEnd = Number(endTime) || 0;
  switch (operator) {
    case '>':
      return convEnd > rangeEnd;
    case '>=':
      return convEnd >= rangeStart;
    case '<':
      return convStart < rangeStart;
    case '<=':
      return convStart <= rangeEnd;
    case '!=':
      return convEnd < rangeStart || convStart > rangeEnd;
    case '=':
    case '==':
      return convStart <= rangeEnd && convEnd >= rangeStart;
    default:
      return false;
  }
}

export function evaluateChatHistoryFilters(meta, filters) {
  const list = Array.isArray(filters) ? filters : [];
  if (!list.length) return true;
  for (const filter of list) {
    if (!filter || !filter.key) continue;
    let matched = false;
    if (filter.key === 'url') {
      const url = typeof meta?.url === 'string' ? meta.url.toLowerCase() : '';
      const value = filter.valueLower || '';
      matched = value ? url.includes(value) : false;
    } else if (filter.key === 'count') {
      matched = compareNumericRange(meta?.messageCount, filter.operator, filter.rangeStart, filter.rangeEnd);
    } else if (filter.key === 'date') {
      matched = compareMessageDateRange(meta?.startTime, meta?.endTime, filter.operator, filter.rangeStart, filter.rangeEnd);
    }
    if (filter.negated) matched = !matched;
    if (!matched) return false;
  }
  return true;
}

export function buildChatHistoryTextPlan(searchPlan) {
  const positiveRaw = Array.isArray(searchPlan?.positiveTerms) ? searchPlan.positiveTerms.slice() : [];
  const positiveLower = Array.isArray(searchPlan?.positiveTermsLower) ? searchPlan.positiveTermsLower.slice() : [];
  const negativeLower = Array.isArray(searchPlan?.negativeTermsLower) ? searchPlan.negativeTermsLower.slice() : [];
  const highlightRaw = positiveRaw.slice();
  const highlightLower = positiveLower.slice();
  const scope = searchPlan?.scope === 'message' ? 'message' : 'session';
  return {
    positiveRaw,
    positiveLower,
    negativeLower,
    highlightRaw,
    highlightLower,
    scope,
    hasPositive: positiveLower.length > 0,
    hasNegative: negativeLower.length > 0
  };
}

export function buildMetaSearchText(meta) {
  return (typeof meta?.url === 'string' ? meta.url.toLowerCase() : '');
}

export function evaluateMetaTextMatch(metaText, textPlan) {
  const remaining = new Set(textPlan.positiveLower);
  if (textPlan.hasNegative) {
    for (const term of textPlan.negativeLower) {
      if (term && metaText.includes(term)) {
        return { blocked: true, remaining };
      }
    }
  }
  for (const term of textPlan.positiveLower) {
    if (term && metaText.includes(term)) {
      remaining.delete(term);
    }
  }
  return { blocked: false, remaining };
}

function buildHighlightRegex(highlightTerms) {
  const terms = normalizeSearchTerms(highlightTerms);
  if (!terms.lower.length) return null;
  const pattern = terms.raw
    .slice()
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .map(term => escapeRegExp(term))
    .join('|');
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'gi');
  } catch (_) {
    return null;
  }
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
 * 只负责“判定会话正文是否命中 + 返回命中的消息记录”。
 *
 * 重要说明：
 * - 这里不构造 DOM snippet，也不做 UI 高亮片段；
 * - 它返回的是纯数据 matchedMessages，调用方可自行转换为：
 *   1. UI snippet；
 *   2. 工具返回中的 `locations` / `excerpts`。
 *
 * @param {Object} conversation
 * @param {{positiveLower:string[], negativeLower:string[], highlightLower:string[], hasPositive:boolean, hasNegative:boolean, scope:string}} textPlan
 * @param {string[]|null} remainingTerms
 * @param {{includeHiddenThreadSelection?:boolean, isCancelled?:() => boolean}} [options]
 * @returns {{cancelled:boolean, matched:boolean, blocked:boolean, matchInfo:{messageId:string|null, reason:string, totalHitCount:number, matchedMessageCount:number, matchedMessages:Array<Object>}, remainingTerms:string[]}}
 */
export function scanConversationMessagesForSearch(conversation, textPlan, remainingTerms, options = {}) {
  const empty = {
    cancelled: false,
    matched: false,
    blocked: false,
    matchInfo: {
      messageId: null,
      reason: 'message',
      totalHitCount: 0,
      matchedMessageCount: 0,
      matchedMessages: []
    },
    remainingTerms: []
  };
  if (!conversation || !Array.isArray(conversation.messages)) return empty;

  const includeHiddenThreadSelection = options?.includeHiddenThreadSelection === true;
  const isCancelled = typeof options?.isCancelled === 'function' ? options.isCancelled : () => false;
  const matchInfo = {
    messageId: null,
    reason: 'message',
    totalHitCount: 0,
    matchedMessageCount: 0,
    matchedMessages: []
  };
  const highlightTerms = Array.isArray(textPlan?.highlightLower) ? textPlan.highlightLower : [];
  const negativeTerms = Array.isArray(textPlan?.negativeLower) ? textPlan.negativeLower : [];
  const hasNegative = !!textPlan?.hasNegative;
  const highlightRegex = buildHighlightRegex(highlightTerms);
  const matchedMessageKeySet = new Set();

  const registerMatchedMessage = (message, messageId, messageKey, rawMessageIndex, plainText, hitCount) => {
    if (!messageKey || matchedMessageKeySet.has(messageKey)) return;
    matchedMessageKeySet.add(messageKey);
    matchInfo.matchedMessageCount = matchedMessageKeySet.size;
    matchInfo.matchedMessages.push({
      messageId: messageId || null,
      rawMessageIndex,
      hitCount: Math.max(0, Number(hitCount || 0)),
      plainText,
      role: typeof message?.role === 'string' ? message.role : '',
      timestamp: Number(message?.timestamp) || 0,
      isThreadMessage: isThreadMessageLike(message),
      threadId: typeof message?.threadId === 'string' ? message.threadId : '',
      threadRootId: typeof message?.threadRootId === 'string' ? message.threadRootId : '',
      threadAnchorId: typeof message?.threadAnchorId === 'string' ? message.threadAnchorId : ''
    });
  };

  const collectHighlightHitsForMessage = (message, plainText, messageId, messageKey, rawMessageIndex) => {
    if (!plainText || !highlightRegex) return 0;
    const hitCount = countRegexMatches(plainText, highlightRegex);
    if (hitCount <= 0) return 0;
    matchInfo.totalHitCount += hitCount;
    registerMatchedMessage(message, messageId, messageKey, rawMessageIndex, plainText, hitCount);
    return hitCount;
  };

  const scope = resolveSearchScope(textPlan);
  if (scope === 'message') {
    const positiveTerms = Array.isArray(textPlan?.positiveLower) ? textPlan.positiveLower : [];
    const hasPositive = positiveTerms.length > 0;

    for (let index = 0; index < conversation.messages.length; index += 1) {
      const message = conversation.messages[index];
      if (isCancelled()) return { ...empty, cancelled: true };
      if (!message) continue;
      const messageId = typeof message?.id === 'string' ? message.id : '';
      const messageKey = messageId || `__message_${index}`;
      const plainText = extractMessagePlainText(message, { includeHiddenThreadSelection });
      if (!plainText) continue;

      const lowerText = plainText.toLowerCase();
      if (hasNegative) {
        let hasNegativeTerm = false;
        for (const term of negativeTerms) {
          if (term && lowerText.includes(term)) {
            hasNegativeTerm = true;
            break;
          }
        }
        if (hasNegativeTerm) continue;
      }

      if (hasPositive) {
        let matchedInMessage = true;
        for (const term of positiveTerms) {
          if (term && !lowerText.includes(term)) {
            matchedInMessage = false;
            break;
          }
        }
        if (matchedInMessage) {
          if (!matchInfo.messageId && messageId) {
            matchInfo.messageId = messageId;
          }
          collectHighlightHitsForMessage(message, plainText, messageId, messageKey, index);
        }
      }
    }

    if (!matchInfo.messageId && matchInfo.matchedMessages[0]?.messageId) {
      matchInfo.messageId = matchInfo.matchedMessages[0].messageId;
    }

    return {
      cancelled: false,
      matched: !!matchInfo.messageId || matchInfo.matchedMessageCount > 0,
      blocked: false,
      matchInfo,
      remainingTerms: []
    };
  }

  const remainingSet = new Set(Array.isArray(remainingTerms) ? remainingTerms : (textPlan?.positiveLower || []));
  for (let index = 0; index < conversation.messages.length; index += 1) {
    const message = conversation.messages[index];
    if (isCancelled()) return { ...empty, cancelled: true };
    if (!message) continue;
    const messageId = typeof message?.id === 'string' ? message.id : '';
    const messageKey = messageId || `__message_${index}`;
    const plainText = extractMessagePlainText(message, { includeHiddenThreadSelection });
    if (!plainText) continue;

    const lowerText = plainText.toLowerCase();
    if (hasNegative) {
      for (const term of negativeTerms) {
        if (term && lowerText.includes(term)) {
          return {
            cancelled: false,
            matched: false,
            blocked: true,
            matchInfo,
            remainingTerms: Array.from(remainingSet)
          };
        }
      }
    }

    let matchedInMessage = false;
    if (remainingSet.size > 0) {
      for (const term of Array.from(remainingSet)) {
        if (term && lowerText.includes(term)) {
          remainingSet.delete(term);
          matchedInMessage = true;
        }
      }
    }

    if (matchedInMessage && !matchInfo.messageId && messageId) {
      matchInfo.messageId = messageId;
    }

    collectHighlightHitsForMessage(message, plainText, messageId, messageKey, index);
  }

  if (!matchInfo.messageId && matchInfo.matchedMessages[0]?.messageId) {
    matchInfo.messageId = matchInfo.matchedMessages[0].messageId;
  }

  return {
    cancelled: false,
    matched: remainingSet.size === 0,
    blocked: false,
    matchInfo,
    remainingTerms: Array.from(remainingSet)
  };
}
