import {
  ASK_OTHER_AI_TOOL_NAME,
  LIST_ASKABLE_MODELS_TOOL_NAME
} from '../agent_tools/ask_other_ai/tool.js';
import {
  HISTORY_READ_TOOL_NAME,
  HISTORY_SEARCH_TOOL_NAME,
  HISTORY_READ_MESSAGE_DEFAULT_MAX_CHARS
} from '../agent_tools/chat_history/tool.js';
import {
  PAGE_CONTENT_READ_DEFAULT_RANGE_CHARS,
  PAGE_CONTENT_READ_TOOL_NAME
} from '../agent_tools/page_content_read/tool.js';
import {
  PDF_CONTENT_READ_DEFAULT_MAX_CHARS,
  PDF_CONTENT_READ_TOOL_NAME
} from '../agent_tools/pdf_content_read/tool.js';
import { REQUEST_USER_INPUT_TOOL_NAME } from '../agent_tools/request_user_input/tool.js';
import { VIEW_IMAGE_TOOL_NAME } from '../agent_tools/view_image/tool.js';
import { WEBPAGE_SCREENSHOT_TOOL_NAME } from '../agent_tools/webpage_screenshot/tool.js';

function normalizeSummaryText(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

function parseArgumentsObject(rawArguments) {
  if (rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)) {
    return rawArguments;
  }
  const text = normalizeSummaryText(rawArguments);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function truncateInlineText(value, maxChars = 48) {
  const text = normalizeSummaryText(value);
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function joinSummaryMeta(parts) {
  return parts
    .map((part) => normalizeSummaryText(part))
    .filter(Boolean)
    .join(' · ');
}

function formatCountLabel(count, unit) {
  const numeric = Number(count);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  return `${Math.max(0, Math.trunc(numeric))}${unit}`;
}

function formatCharRangeSuffix(start, length) {
  const normalizedStart = Number(start);
  const normalizedLength = Number(length);
  if (!Number.isFinite(normalizedStart) || !Number.isFinite(normalizedLength) || normalizedLength <= 0) {
    return '';
  }
  const safeStart = Math.max(0, Math.trunc(normalizedStart));
  const safeEnd = safeStart + Math.max(0, Math.trunc(normalizedLength));
  return `C${safeStart}-C${safeEnd}`;
}

function summarizeStringList(values, options = {}) {
  const list = Array.isArray(values)
    ? values.map((value) => normalizeSummaryText(value)).filter(Boolean)
    : [];
  if (list.length <= 0) return '';
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.trunc(Number(options.limit))) : 2;
  const head = list.slice(0, limit);
  if (list.length <= limit) {
    return head.join(' + ');
  }
  return `${head.join(' + ')} 等${list.length}项`;
}

function summarizeImageSource(path) {
  const text = normalizeSummaryText(path);
  if (!text) return '图片';
  const dataUrlMatch = text.match(/^data:([^;,]+)/i);
  if (dataUrlMatch) {
    return `data:${normalizeSummaryText(dataUrlMatch[1]) || 'image'}`;
  }
  try {
    const parsed = new URL(text);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'file:') {
      const pathname = parsed.pathname || '';
      const tail = pathname.split('/').filter(Boolean).pop() || parsed.hostname || parsed.protocol.replace(':', '');
      return truncateInlineText(tail, 56);
    }
  } catch (_) {}
  const normalizedPath = text.replace(/\\/g, '/');
  const tail = normalizedPath.split('/').filter(Boolean).pop() || normalizedPath;
  return truncateInlineText(tail, 56);
}

function buildPageContentReadSummaryParts(args, options = {}) {
  const isInProgress = options?.isInProgress === true;
  const hasExplicitRange = args?.skip_chars != null || args?.max_chars != null;
  const skipChars = Number.isFinite(Number(args?.skip_chars)) ? Number(args.skip_chars) : 0;
  const maxChars = Number.isFinite(Number(args?.max_chars))
    ? Number(args.max_chars)
    : PAGE_CONTENT_READ_DEFAULT_RANGE_CHARS;
  return {
    action: isInProgress ? '正在读取' : '读取',
    value: '当前页面',
    valueUrl: '',
    meta: hasExplicitRange ? formatCharRangeSuffix(skipChars, maxChars) : '预览',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  };
}

function buildPdfContentReadSummaryParts(args, options = {}) {
  const isInProgress = options?.isInProgress === true;
  const chapterId = normalizeSummaryText(args?.chapter_id);
  const chunkIndex = Number.isFinite(Number(args?.chunk_index)) ? Math.max(0, Math.trunc(Number(args.chunk_index))) : 0;
  const maxChars = Number.isFinite(Number(args?.max_chars))
    ? Math.max(1, Math.trunc(Number(args.max_chars)))
    : PDF_CONTENT_READ_DEFAULT_MAX_CHARS;
  const includeOutline = args?.include_outline === true;
  const hasExplicitChunkRequest = !!chapterId || args?.chunk_index != null || args?.max_chars != null;

  if (!hasExplicitChunkRequest) {
    return {
      action: isInProgress ? '正在读取目录' : '读取目录',
      value: '当前PDF',
      valueUrl: '',
      meta: '',
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  if (chapterId) {
    return {
      action: isInProgress ? '正在读取章节' : '读取章节',
      value: chapterId,
      valueUrl: '',
      meta: joinSummaryMeta([
        `片段 ${chunkIndex}`,
        formatCharRangeSuffix(chunkIndex * maxChars, maxChars),
        includeOutline ? '含目录' : ''
      ]),
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  return {
    action: isInProgress ? '正在读取全文' : '读取全文',
    value: `片段 ${chunkIndex}`,
    valueUrl: '',
    meta: joinSummaryMeta([
      formatCharRangeSuffix(chunkIndex * maxChars, maxChars),
      includeOutline ? '含目录' : ''
    ]),
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  };
}

function buildHistorySearchSummaryParts(args, options = {}) {
  const isInProgress = options?.isInProgress === true;
  const textAll = Array.isArray(args?.text_all) ? args.text_all : [];
  const textNot = Array.isArray(args?.text_not) ? args.text_not : [];
  const urlContains = normalizeSummaryText(args?.url_contains);
  const currentPageOnly = args?.current_page_only === true;
  const recentWithin = normalizeSummaryText(args?.recent_within);
  const resultMode = normalizeSummaryText(args?.result_mode);
  const scope = normalizeSummaryText(args?.scope);
  const maxResults = Number.isFinite(Number(args?.max_results)) ? Math.max(1, Math.trunc(Number(args.max_results))) : 0;
  const subject = summarizeStringList(textAll)
    || (urlContains ? `URL ${truncateInlineText(urlContains, 36)}` : '')
    || (currentPageOnly ? '当前页面' : '')
    || (recentWithin ? `最近 ${recentWithin}` : '')
    || (summarizeStringList(textNot.map((item) => `排除 ${item}`), { limit: 1 }) || '聊天记录');

  return {
    action: isInProgress ? '正在搜索' : '搜索',
    value: subject,
    valueUrl: '',
    meta: joinSummaryMeta([
      currentPageOnly && subject !== '当前页面' ? '当前页面' : '',
      recentWithin && !subject.startsWith('最近 ') ? `最近 ${recentWithin}` : '',
      resultMode === 'metadata_only' ? '元数据' : '',
      scope === 'session' ? '会话级' : (scope === 'message' ? '消息级' : ''),
      maxResults > 0 ? `≤${maxResults}条` : ''
    ]),
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  };
}

function buildHistoryReadSummaryParts(args, options = {}) {
  const isInProgress = options?.isInProgress === true;
  const convRef = Number.isFinite(Number(args?.conv_ref)) ? Math.max(1, Math.trunc(Number(args.conv_ref))) : null;
  const threadRef = Number.isFinite(Number(args?.thread_ref)) ? Math.max(1, Math.trunc(Number(args.thread_ref))) : null;
  const start = Number.isFinite(Number(args?.start)) ? Math.max(1, Math.trunc(Number(args.start))) : null;
  const end = Number.isFinite(Number(args?.end)) ? Math.max(1, Math.trunc(Number(args.end))) : null;
  return {
    action: isInProgress ? '正在读取' : '读取',
    value: convRef ? `会话 #${convRef}` : '会话',
    valueUrl: '',
    meta: joinSummaryMeta([
      threadRef ? `线程 #${threadRef}` : '主线',
      (start != null && end != null) ? `M${start}-M${Math.max(start, end)}` : '',
      args?.read_full_messages === true ? '完整正文' : `单条≤${HISTORY_READ_MESSAGE_DEFAULT_MAX_CHARS}字`
    ]),
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  };
}

function buildListAskableModelsSummaryParts(options = {}) {
  const isInProgress = options?.isInProgress === true;
  return {
    action: isInProgress ? '正在列出' : '列出',
    value: '可问模型',
    valueUrl: '',
    meta: '',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  };
}

function buildAskOtherAiSummaryParts(args, options = {}) {
  const isInProgress = options?.isInProgress === true;
  const requests = Array.isArray(args?.requests) ? args.requests : [];
  const firstRequest = (requests[0] && typeof requests[0] === 'object') ? requests[0] : {};
  const uniqueConfigIds = Array.from(new Set(
    requests
      .map((item) => normalizeSummaryText(item?.config_id))
      .filter(Boolean)
  ));
  const requestCount = requests.length;
  const questionPreview = truncateInlineText(firstRequest.question, 42);
  return {
    action: isInProgress ? '正在询问' : '询问',
    value: questionPreview || formatCountLabel(requestCount, '个请求') || '其他模型',
    valueUrl: '',
    meta: requestCount <= 1
      ? normalizeSummaryText(firstRequest.config_id)
      : joinSummaryMeta([
        formatCountLabel(uniqueConfigIds.length, '个模型'),
        formatCountLabel(requestCount, '个请求')
      ]),
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  };
}

function buildRequestUserInputSummaryParts(args, options = {}) {
  const isInProgress = options?.isInProgress === true;
  const questions = Array.isArray(args?.questions) ? args.questions : [];
  const headers = questions
    .map((item) => normalizeSummaryText(item?.header))
    .filter(Boolean);
  const countLabel = formatCountLabel(questions.length, '个问题') || '用户输入';
  return {
    action: isInProgress ? '正在请求' : '请求',
    value: countLabel,
    valueUrl: '',
    meta: summarizeStringList(headers, { limit: 2 }),
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  };
}

function buildWebpageScreenshotSummaryParts(args, options = {}) {
  const isInProgress = options?.isInProgress === true;
  return {
    action: isInProgress ? '正在截图' : '截图',
    value: '当前页面',
    valueUrl: '',
    meta: normalizeSummaryText(args?.detail) === 'original' ? '原始分辨率' : '',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  };
}

function buildViewImageSummaryParts(args, options = {}) {
  const isInProgress = options?.isInProgress === true;
  const path = normalizeSummaryText(args?.path || args?.url || args?.image_url);
  return {
    action: isInProgress ? '正在查看' : '查看',
    value: summarizeImageSource(path),
    valueUrl: '',
    meta: normalizeSummaryText(args?.detail) === 'original' ? '原始分辨率' : '',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  };
}

const RESPONSE_ACTIVITY_CUSTOM_TOOL_SUMMARY_BUILDERS = new Map([
  [PAGE_CONTENT_READ_TOOL_NAME, { typeLabel: '页面', build: buildPageContentReadSummaryParts }],
  [PDF_CONTENT_READ_TOOL_NAME, { typeLabel: 'PDF', build: buildPdfContentReadSummaryParts }],
  [HISTORY_SEARCH_TOOL_NAME, { typeLabel: '历史', build: buildHistorySearchSummaryParts }],
  [HISTORY_READ_TOOL_NAME, { typeLabel: '历史', build: buildHistoryReadSummaryParts }],
  [LIST_ASKABLE_MODELS_TOOL_NAME, { typeLabel: '模型', build: buildListAskableModelsSummaryParts }],
  [ASK_OTHER_AI_TOOL_NAME, { typeLabel: '模型', build: buildAskOtherAiSummaryParts }],
  [REQUEST_USER_INPUT_TOOL_NAME, { typeLabel: '用户', build: buildRequestUserInputSummaryParts }],
  [WEBPAGE_SCREENSHOT_TOOL_NAME, { typeLabel: '页面', build: buildWebpageScreenshotSummaryParts }],
  [VIEW_IMAGE_TOOL_NAME, { typeLabel: '图片', build: buildViewImageSummaryParts }]
]);

function resolveResponseActivityCustomToolDefinition(record) {
  if (String(record?.type || '').toLowerCase() !== 'function_call') return null;
  const toolName = normalizeSummaryText(record?.name);
  if (!toolName) return null;
  return RESPONSE_ACTIVITY_CUSTOM_TOOL_SUMMARY_BUILDERS.get(toolName) || null;
}

export function isResponseActivityCustomToolCall(record) {
  return !!resolveResponseActivityCustomToolDefinition(record);
}

export function getResponseActivityCustomToolTypeLabel(record) {
  return resolveResponseActivityCustomToolDefinition(record)?.typeLabel || '';
}

export function buildResponseActivityCustomToolSummaryParts(record, options = {}) {
  const definition = resolveResponseActivityCustomToolDefinition(record);
  if (!definition) return null;
  const args = parseArgumentsObject(record?.arguments) || {};
  return definition.build(args, options);
}

export function buildResponseActivityCustomToolPrimaryText(record, options = {}) {
  const parts = buildResponseActivityCustomToolSummaryParts(record, options);
  if (!parts) return '';
  return [parts.action, parts.value, parts.meta]
    .map((part) => normalizeSummaryText(part))
    .filter(Boolean)
    .join(' ');
}
