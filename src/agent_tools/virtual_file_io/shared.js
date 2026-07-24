import {
  PAGE_CONTENT_READ_MAX_CHARS
} from '../page_content_read/tool.js';

export const VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME = 'apply_patch';
export const VIRTUAL_FILE_LIST_FILES_TOOL_NAME = 'list_files';
export const VIRTUAL_FILE_READ_FILE_TOOL_NAME = 'read_file';
export const VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME = 'search_files';
export const VIRTUAL_FILE_COPY_FILE_TOOL_NAME = 'copy_file';
export const VIRTUAL_FILE_MOVE_FILE_TOOL_NAME = 'move_file';
export const VIRTUAL_FILE_DELETE_FILE_TOOL_NAME = 'delete_file';
export const VIRTUAL_FILE_TARGET_KIND_WORKSPACE = 'workspace';
export const VIRTUAL_FILE_TARGET_KIND_CONVERSATION_DOCUMENT = VIRTUAL_FILE_TARGET_KIND_WORKSPACE;
export const VIRTUAL_FILE_TARGET_KIND_LOCAL = 'local';
export const VIRTUAL_FILE_TARGET_KIND_SKILL = 'skill';

export const CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME = VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME;
export const CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME = VIRTUAL_FILE_LIST_FILES_TOOL_NAME;
export const CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME = VIRTUAL_FILE_READ_FILE_TOOL_NAME;
export const CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME = VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME;
export const CONVERSATION_DOCUMENT_COPY_FILE_TOOL_NAME = VIRTUAL_FILE_COPY_FILE_TOOL_NAME;
export const CONVERSATION_DOCUMENT_MOVE_FILE_TOOL_NAME = VIRTUAL_FILE_MOVE_FILE_TOOL_NAME;
export const CONVERSATION_DOCUMENT_DELETE_FILE_TOOL_NAME = VIRTUAL_FILE_DELETE_FILE_TOOL_NAME;
export const CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION = 'write_file';
export const CONVERSATION_DOCUMENT_INTERNAL_READ_FILE_FULL_ACTION = 'read_file_full';
export const CONVERSATION_DOCUMENT_CHANGE_EVENT_NAME = 'cerebr-conversation-document-change';

export const CONVERSATION_DOCUMENT_READ_DEFAULT_RANGE_CHARS = 10_000;
export const CONVERSATION_DOCUMENT_READ_MAX_CHARS = PAGE_CONTENT_READ_MAX_CHARS;
export const CONVERSATION_DOCUMENT_SEARCH_DEFAULT_MAX_RESULTS = 50;
export const CONVERSATION_DOCUMENT_SEARCH_MAX_RESULTS = 200;

export const VIRTUAL_FILE_PUBLIC_ACTIONS = new Set([
  VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
  VIRTUAL_FILE_LIST_FILES_TOOL_NAME,
  VIRTUAL_FILE_READ_FILE_TOOL_NAME,
  VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME,
  VIRTUAL_FILE_COPY_FILE_TOOL_NAME,
  VIRTUAL_FILE_MOVE_FILE_TOOL_NAME,
  VIRTUAL_FILE_DELETE_FILE_TOOL_NAME
]);

export const VIRTUAL_FILE_INTERNAL_ACTIONS = new Set([
  CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION,
  CONVERSATION_DOCUMENT_INTERNAL_READ_FILE_FULL_ACTION
]);

export function normalizeString(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

export function normalizeOptionalString(value) {
  const text = normalizeString(value);
  return text || null;
}

export function ensurePlainObject(value) {
  return (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
}

export function clampNonNegativeInt(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.trunc(numeric));
}

export function clampPositiveInt(value, fallback = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.trunc(numeric));
}

export function formatPercent(numerator, denominator) {
  const safeNumerator = Number(numerator);
  const safeDenominator = Number(denominator);
  if (!Number.isFinite(safeNumerator) || !Number.isFinite(safeDenominator) || safeDenominator <= 0) {
    return 0;
  }
  return Number(((safeNumerator / safeDenominator) * 100).toFixed(2));
}

export function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function toIsoTimestamp(value) {
  const text = normalizeString(value);
  if (!text) return new Date().toISOString();
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString();
}

export function buildDocumentSizeChars(content) {
  return Array.from(typeof content === 'string' ? content : '').length;
}
