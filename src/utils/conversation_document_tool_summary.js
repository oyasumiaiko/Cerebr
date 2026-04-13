import {
  CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME,
  CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME,
  CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME,
  CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME
} from '../agent_tools/conversation_document_tools.js';
import { buildConversationDocumentApplyPatchPreview } from './micro_skill_patch_preview.js';

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

export function isConversationDocumentToolCall(record) {
  return String(record?.type || '').toLowerCase() === 'function_call'
    && [
      CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME,
      CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME,
      CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME,
      CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME
    ].includes(normalizeSummaryText(record?.name));
}

export function getConversationDocumentToolTypeLabel(record) {
  return isConversationDocumentToolCall(record) ? '文档' : '';
}

export function buildConversationDocumentSummaryParts(record, options = {}) {
  if (!isConversationDocumentToolCall(record)) return null;
  const toolName = normalizeSummaryText(record?.name);
  const args = parseArgumentsObject(record?.arguments);
  const isInProgress = options?.isInProgress === true;

  if (toolName === CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME) {
    const preview = buildConversationDocumentApplyPatchPreview(args);
    if (preview?.files?.length) {
      const firstFile = preview.files[0];
      const metaParts = [];
      if (preview.totalAdditions > 0) metaParts.push(`+${preview.totalAdditions}`);
      if (preview.totalDeletions > 0) metaParts.push(`-${preview.totalDeletions}`);
      if (preview.totalFiles > 1) metaParts.push(`另 ${preview.totalFiles - 1} 个文件`);
      return {
        action: isInProgress ? '正在修改' : '修改了',
        value: normalizeSummaryText(firstFile?.path) || '文档文件',
        valueUrl: '',
        meta: joinSummaryMeta(metaParts),
        locationAction: '',
        locationValue: '',
        locationUrl: ''
      };
    }
    return {
      action: isInProgress ? '正在修改文档' : '修改文档',
      value: '当前对话文档',
      valueUrl: '',
      meta: '',
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  if (toolName === CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME) {
    return {
      action: isInProgress ? '正在查看文件列表' : '查看文件列表',
      value: normalizeSummaryText(args?.path_glob) || '当前对话文档',
      valueUrl: '',
      meta: '',
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  if (toolName === CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME) {
    return {
      action: isInProgress ? '正在读取文件' : '读取文件',
      value: normalizeSummaryText(args?.file_path) || '文档文件',
      valueUrl: '',
      meta: '',
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  if (toolName === CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME) {
    return {
      action: isInProgress ? '正在搜索文件' : '搜索文件',
      value: normalizeSummaryText(args?.pattern) || '文档文件',
      valueUrl: '',
      meta: normalizeSummaryText(args?.path_glob),
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  return null;
}

export function buildConversationDocumentPrimaryText(record, options = {}) {
  const parts = buildConversationDocumentSummaryParts(record, options);
  if (!parts) return '';
  return [parts.action, parts.value, parts.meta]
    .map((part) => normalizeSummaryText(part))
    .filter(Boolean)
    .join(' ');
}
