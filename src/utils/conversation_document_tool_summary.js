import {
  VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
  VIRTUAL_FILE_LIST_FILES_TOOL_NAME,
  VIRTUAL_FILE_READ_FILE_TOOL_NAME,
  VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME,
  VIRTUAL_FILE_TARGET_KIND_CONVERSATION_DOCUMENT,
  VIRTUAL_FILE_TARGET_KIND_SKILL
} from '../agent_tools/conversation_document/tools.js';
import { buildVirtualFileApplyPatchPreview } from './micro_skill_patch_preview.js';

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
  if (!isVirtualFileToolCall(record)) return '';
  const args = parseArgumentsObject(record?.arguments);
  const target = resolveVirtualFileTarget(args);
  return target.kind === VIRTUAL_FILE_TARGET_KIND_SKILL ? '技能' : '文档';
}

export function buildVirtualFileSummaryParts(record, options = {}) {
  if (!isVirtualFileToolCall(record)) return null;
  const toolName = normalizeSummaryText(record?.name);
  const args = parseArgumentsObject(record?.arguments);
  const target = resolveVirtualFileTarget(args);
  const isInProgress = options?.isInProgress === true;
  const targetMeta = target.kind === VIRTUAL_FILE_TARGET_KIND_SKILL ? target.name : '';

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
        action: isInProgress ? '正在修改' : '修改了',
        value: normalizeSummaryText(firstFile?.path) || (target.kind === VIRTUAL_FILE_TARGET_KIND_SKILL ? '技能文件' : '文档文件'),
        valueUrl: '',
        meta: joinSummaryMeta(metaParts),
        locationAction: '',
        locationValue: '',
        locationUrl: ''
      };
    }
    return {
      action: isInProgress ? '正在修改文件' : '修改文件',
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
      action: isInProgress ? '正在查看文件列表' : '查看文件列表',
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
      action: isInProgress ? '正在读取文件' : '读取文件',
      value: normalizeSummaryText(args?.file_path) || (target.kind === VIRTUAL_FILE_TARGET_KIND_SKILL ? '技能文件' : '文档文件'),
      valueUrl: '',
      meta: targetMeta,
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  if (toolName === VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME) {
    return {
      action: isInProgress ? '正在搜索文件' : '搜索文件',
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
