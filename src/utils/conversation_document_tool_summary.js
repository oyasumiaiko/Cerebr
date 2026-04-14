import {
  VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
  VIRTUAL_FILE_LIST_FILES_TOOL_NAME,
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
  const startLine = Number(args?.start_line);
  const endLine = Number(args?.end_line);
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return '';
  const normalizedStart = Math.max(1, Math.trunc(startLine));
  const normalizedEnd = Math.max(normalizedStart, Math.trunc(endLine));
  return `L${normalizedStart}-L${normalizedEnd}`;
}

export function isVirtualFileToolCall(record) {
  return String(record?.type || '').toLowerCase() === 'function_call'
    && [
      VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
      VIRTUAL_FILE_LIST_FILES_TOOL_NAME,
      VIRTUAL_FILE_READ_FILE_TOOL_NAME,
      VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME
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
        value: normalizeSummaryText(firstFile?.path) || (target.kind === VIRTUAL_FILE_TARGET_KIND_SKILL ? '技能文件' : '文档文件'),
        valueUrl: '',
        meta: joinSummaryMeta(metaParts),
        locationAction: '',
        locationValue: '',
        locationUrl: ''
      };
    }
    return {
      action: isInProgress ? '正在修改' : '修改',
      value: target.kind === VIRTUAL_FILE_TARGET_KIND_SKILL ? (targetMeta || '技能文件') : '当前对话文档',
      valueUrl: '',
      meta: '',
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  if (toolName === VIRTUAL_FILE_LIST_FILES_TOOL_NAME) {
    return {
      action: isInProgress ? '正在查看列表' : '查看列表',
      value: target.kind === VIRTUAL_FILE_TARGET_KIND_SKILL ? (targetMeta || '全部技能') : (normalizeSummaryText(args?.path_glob) || '当前对话文档'),
      valueUrl: '',
      meta: target.kind === VIRTUAL_FILE_TARGET_KIND_SKILL ? normalizeSummaryText(args?.path_glob) : '',
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  if (toolName === VIRTUAL_FILE_READ_FILE_TOOL_NAME) {
    return {
      action: isInProgress ? '正在读取' : '读取',
      value: [
        normalizeSummaryText(args?.file_path) || (target.kind === VIRTUAL_FILE_TARGET_KIND_SKILL ? '技能文件' : '文档文件'),
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
    return {
      action: isInProgress ? '正在搜索' : '搜索',
      value: normalizeSummaryText(args?.pattern) || (target.kind === VIRTUAL_FILE_TARGET_KIND_SKILL ? '技能文件' : '文档文件'),
      valueUrl: '',
      meta: joinSummaryMeta([targetMeta, normalizeSummaryText(args?.path_glob)]),
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
