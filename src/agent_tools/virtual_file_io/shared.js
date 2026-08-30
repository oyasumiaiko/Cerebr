export const VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME = 'apply_patch';
export const VIRTUAL_FILE_LIST_FILES_TOOL_NAME = 'list_files';
export const VIRTUAL_FILE_READ_FILE_TOOL_NAME = 'read_file';
export const VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME = 'search_files';
export const VIRTUAL_FILE_COPY_FILE_TOOL_NAME = 'copy_file';
export const VIRTUAL_FILE_ENVIRONMENT_KIND_ROOT = 'root';
export const VIRTUAL_FILE_ENVIRONMENT_KIND_LOCAL = 'local';
export const VIRTUAL_FILE_ENVIRONMENT_KIND_SKILL = 'skill';

export const CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME = VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME;
export const CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME = VIRTUAL_FILE_LIST_FILES_TOOL_NAME;
export const CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME = VIRTUAL_FILE_READ_FILE_TOOL_NAME;
export const CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME = VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME;
export const CONVERSATION_DOCUMENT_COPY_FILE_TOOL_NAME = VIRTUAL_FILE_COPY_FILE_TOOL_NAME;
export const CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION = 'write_file';
export const CONVERSATION_DOCUMENT_INTERNAL_READ_FILE_FULL_ACTION = 'read_file_full';
export const CONVERSATION_DOCUMENT_CHANGE_EVENT_NAME = 'cerebr-conversation-document-change';

export const VIRTUAL_FILE_PUBLIC_ACTIONS = new Set([
  VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
  VIRTUAL_FILE_LIST_FILES_TOOL_NAME,
  VIRTUAL_FILE_READ_FILE_TOOL_NAME,
  VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME,
  VIRTUAL_FILE_COPY_FILE_TOOL_NAME
]);

export const VIRTUAL_FILE_INTERNAL_ACTIONS = new Set([
  CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION,
  CONVERSATION_DOCUMENT_INTERNAL_READ_FILE_FULL_ACTION
]);

export function normalizeString(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

export function assertPlainObject(value, label = 'virtual_file payload') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是 object。`);
  }
  return value;
}

export function assertOnlyObjectKeys(value, allowedKeys, label = 'virtual_file') {
  const input = assertPlainObject(value, `${label} 参数`);
  const allowed = allowedKeys instanceof Set ? allowedKeys : new Set(allowedKeys || []);
  const unexpected = Object.keys(input).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} 参数错误：不接受参数 ${unexpected.join(', ')}。`);
  }
  return input;
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
