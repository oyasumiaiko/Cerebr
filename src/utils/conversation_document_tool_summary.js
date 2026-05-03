import {
  VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
  VIRTUAL_FILE_COPY_FILE_TOOL_NAME,
  VIRTUAL_FILE_DELETE_FILE_TOOL_NAME,
  VIRTUAL_FILE_LIST_FILES_TOOL_NAME,
  VIRTUAL_FILE_MOVE_FILE_TOOL_NAME,
  VIRTUAL_FILE_READ_FILE_TOOL_NAME,
  VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME,
  VIRTUAL_FILE_TARGET_KIND_CONVERSATION_DOCUMENT,
  VIRTUAL_FILE_TARGET_KIND_SKILL
} from '../agent_tools/virtual_file_io/index.js';
import { buildVirtualFileApplyPatchPreview } from './skill_patch_preview.js';

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

function joinSummaryMeta(parts) {
  return parts
    .map((part) => normalizeSummaryText(part))
    .filter(Boolean)
    .join(' · ');
}

function resolvePathArg(args) {
  return normalizeSummaryText(args?.path);
}

function resolveGlobArg(args) {
  return normalizeSummaryText(args?.glob);
}

function resolveSearchPatternArg(args) {
  return normalizeSummaryText(args?.pattern);
}

function resolveFromArg(args) {
  return normalizeSummaryText(args?.from);
}

function resolveToArg(args) {
  return normalizeSummaryText(args?.to);
}

function resolveVirtualFileTarget(args) {
  const target = (args?.target && typeof args.target === 'object' && !Array.isArray(args.target))
    ? args.target
    : null;
  const kind = normalizeSummaryText(target?.kind).toLowerCase() || VIRTUAL_FILE_TARGET_KIND_CONVERSATION_DOCUMENT;
  return {
    kind: kind === VIRTUAL_FILE_TARGET_KIND_SKILL ? VIRTUAL_FILE_TARGET_KIND_SKILL : VIRTUAL_FILE_TARGET_KIND_CONVERSATION_DOCUMENT,
    name: normalizeSummaryText(target?.name)
  };
}

function formatReadLineRangeSuffix(args) {
  const lineRange = normalizeSummaryText(args?.line_range);
  if (!lineRange) return '';
  const compact = lineRange
    .replace(/^['"]|['"]$/g, '')
    .replace(/\s+/g, '')
    .replace(/p$/i, '');
  const rangeMatch = compact.match(/^L?(\d+)(?:[:-]|,)L?(\d+)$/i);
  if (rangeMatch) return `L${rangeMatch[1]}-L${rangeMatch[2]}`;
  const singleMatch = compact.match(/^L?(\d+)$/i);
  if (singleMatch) return `L${singleMatch[1]}`;
  return compact ? (compact.startsWith('L') ? compact : `L${compact}`) : '';
}

export function isVirtualFileToolCall(record) {
  return String(record?.type || '').toLowerCase() === 'function_call'
    && [
      VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
      VIRTUAL_FILE_LIST_FILES_TOOL_NAME,
      VIRTUAL_FILE_READ_FILE_TOOL_NAME,
      VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME,
      VIRTUAL_FILE_COPY_FILE_TOOL_NAME,
      VIRTUAL_FILE_MOVE_FILE_TOOL_NAME,
      VIRTUAL_FILE_DELETE_FILE_TOOL_NAME
    ].includes(normalizeSummaryText(record?.name));
}

export function getVirtualFileToolTypeLabel(record) {
  return isVirtualFileToolCall(record) ? '文件' : '';
}

export function buildVirtualFileSummaryParts(record, options = {}) {
  if (!isVirtualFileToolCall(record)) return null;
  const toolName = normalizeSummaryText(record?.name);
  const args = parseArgumentsObject(record?.arguments);
  const target = resolveVirtualFileTarget(args);
  const isInProgress = options?.isInProgress === true;
  const targetMeta = target.kind === VIRTUAL_FILE_TARGET_KIND_SKILL ? target.name : '';
  const lineRangeSuffix = formatReadLineRangeSuffix(args);

  if (toolName === VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME) {
    const preview = buildVirtualFileApplyPatchPreview(args);
    if (preview?.files?.length) {
      const firstFile = preview.files[0];
      const metaParts = [];
      if (targetMeta) metaParts.push(targetMeta);
      if (preview.totalAdditions > 0) metaParts.push(`+${preview.totalAdditions}`);
      if (preview.totalDeletions > 0) metaParts.push(`-${preview.totalDeletions}`);
      if (preview.totalFiles > 1) metaParts.push(`另 ${preview.totalFiles - 1} 个文件`);
      return {
        action: isInProgress ? '正在修改' : '修改',
        value: normalizeSummaryText(firstFile?.path) || (target.kind === VIRTUAL_FILE_TARGET_KIND_SKILL ? '技能文件' : 'workspace 文件'),
        valueUrl: '',
        meta: joinSummaryMeta(metaParts),
        locationAction: '',
        locationValue: '',
        locationUrl: ''
      };
    }
    return {
      action: isInProgress ? '正在修改' : '修改',
      value: target.kind === VIRTUAL_FILE_TARGET_KIND_SKILL ? (targetMeta || '技能文件') : 'workspace 文件',
      valueUrl: '',
      meta: '',
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  if (toolName === VIRTUAL_FILE_LIST_FILES_TOOL_NAME) {
    const glob = resolveGlobArg(args);
    return {
      action: isInProgress ? '正在查看列表' : '查看列表',
      value: target.kind === VIRTUAL_FILE_TARGET_KIND_SKILL ? (targetMeta || '全部技能') : (glob || 'workspace'),
      valueUrl: '',
      meta: target.kind === VIRTUAL_FILE_TARGET_KIND_SKILL ? glob : '',
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  if (toolName === VIRTUAL_FILE_READ_FILE_TOOL_NAME) {
    return {
      action: isInProgress ? '正在读取' : '读取',
      value: [
        resolvePathArg(args) || (target.kind === VIRTUAL_FILE_TARGET_KIND_SKILL ? '技能文件' : 'workspace 文件'),
        lineRangeSuffix
      ]
        .filter(Boolean)
        .join(' '),
      valueUrl: '',
      meta: targetMeta,
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  if (toolName === VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME) {
    const pattern = resolveSearchPatternArg(args);
    return {
      action: isInProgress ? '正在搜索' : '搜索',
      value: pattern || (target.kind === VIRTUAL_FILE_TARGET_KIND_SKILL ? '技能文件' : 'workspace'),
      valueUrl: '',
      meta: joinSummaryMeta([targetMeta, resolveGlobArg(args)]),
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  if (toolName === VIRTUAL_FILE_COPY_FILE_TOOL_NAME || toolName === VIRTUAL_FILE_MOVE_FILE_TOOL_NAME) {
    const from = resolveFromArg(args);
    const to = resolveToArg(args);
    return {
      action: toolName === VIRTUAL_FILE_COPY_FILE_TOOL_NAME
        ? (isInProgress ? '正在复制' : '复制')
        : (isInProgress ? '正在移动' : '移动'),
      value: from && to ? `${from} -> ${to}` : (from || to || '文件'),
      valueUrl: '',
      meta: targetMeta,
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  if (toolName === VIRTUAL_FILE_DELETE_FILE_TOOL_NAME) {
    return {
      action: isInProgress ? '正在删除' : '删除',
      value: resolvePathArg(args) || (target.kind === VIRTUAL_FILE_TARGET_KIND_SKILL ? '技能文件' : 'workspace 文件'),
      valueUrl: '',
      meta: targetMeta,
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  return null;
}

export function buildVirtualFilePrimaryText(record, options = {}) {
  const parts = buildVirtualFileSummaryParts(record, options);
  if (!parts) return '';
  return [parts.action, parts.value, parts.meta]
    .map((part) => normalizeSummaryText(part))
    .filter(Boolean)
    .join(' ');
}

export function isConversationDocumentToolCall(record) {
  return isVirtualFileToolCall(record);
}

export function getConversationDocumentToolTypeLabel(record) {
  return getVirtualFileToolTypeLabel(record);
}

export function buildConversationDocumentSummaryParts(record, options = {}) {
  return buildVirtualFileSummaryParts(record, options);
}

export function buildConversationDocumentPrimaryText(record, options = {}) {
  return buildVirtualFilePrimaryText(record, options);
}
