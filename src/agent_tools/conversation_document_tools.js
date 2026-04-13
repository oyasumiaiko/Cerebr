/**
 * 对话级文档虚拟文件工具。
 *
 * 说明：
 * - 只操作“当前对话”名下的文本虚拟文件；
 * - 不触碰真实工作区文件，也不自动把文档内容注入模型上下文；
 * - 公开给模型的只有 `apply_patch` / `list_files` / `read_file` / `search_files` 四个顶层工具；
 * - UI 为了编辑与完整查看，会额外复用 `write_file` / `read_file_full` 两个内部 action。
 */

import {
  PAGE_CONTENT_READ_DEFAULT_RANGE_CHARS,
  PAGE_CONTENT_READ_MAX_CHARS
} from './page_content_read_tool.js';
import { derivePatchedFileContent, parseApplyPatch } from './apply_patch_core.js';
import {
  getConversationDocument,
  listConversationDocuments,
  putConversationDocument,
  replaceConversationDocuments
} from '../storage/conversation_document_store.js';

export const CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME = 'apply_patch';
export const CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME = 'list_files';
export const CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME = 'read_file';
export const CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME = 'search_files';
export const CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION = 'write_file';
export const CONVERSATION_DOCUMENT_INTERNAL_READ_FILE_FULL_ACTION = 'read_file_full';
export const CONVERSATION_DOCUMENT_CHANGE_EVENT_NAME = 'cerebr-conversation-document-change';

export const CONVERSATION_DOCUMENT_READ_DEFAULT_RANGE_CHARS = PAGE_CONTENT_READ_DEFAULT_RANGE_CHARS;
export const CONVERSATION_DOCUMENT_READ_MAX_CHARS = PAGE_CONTENT_READ_MAX_CHARS;
export const CONVERSATION_DOCUMENT_SEARCH_DEFAULT_MAX_RESULTS = 50;
export const CONVERSATION_DOCUMENT_SEARCH_MAX_RESULTS = 200;

const PUBLIC_ACTIONS = new Set([
  CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME,
  CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME,
  CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME,
  CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME
]);

const INTERNAL_ACTIONS = new Set([
  CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION,
  CONVERSATION_DOCUMENT_INTERNAL_READ_FILE_FULL_ACTION
]);

function normalizeString(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

function ensurePlainObject(value) {
  return (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
}

function clampNonNegativeInt(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.trunc(numeric));
}

function clampPositiveInt(value, fallback = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.trunc(numeric));
}

function formatPercent(numerator, denominator) {
  const safeNumerator = Number(numerator);
  const safeDenominator = Number(denominator);
  if (!Number.isFinite(safeNumerator) || !Number.isFinite(safeDenominator) || safeDenominator <= 0) {
    return 0;
  }
  return Number(((safeNumerator / safeDenominator) * 100).toFixed(2));
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toIsoTimestamp(value) {
  const text = normalizeString(value);
  if (!text) return new Date().toISOString();
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString();
}

function buildDocumentSizeChars(content) {
  return Array.from(typeof content === 'string' ? content : '').length;
}

export function normalizeConversationDocumentPath(value) {
  const rawPath = normalizeString(value).replace(/\\/g, '/');
  const withoutLeadingDot = rawPath.replace(/^(?:\.\/)+/, '');
  const normalizedPath = withoutLeadingDot.startsWith('/')
    ? withoutLeadingDot.slice(1)
    : withoutLeadingDot;

  if (!normalizedPath) {
    throw new Error('conversation_document 参数错误：file_path 不能为空。');
  }
  if (normalizedPath.length > 512) {
    throw new Error('conversation_document 参数错误：file_path 长度不能超过 512。');
  }

  const segments = normalizedPath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`conversation_document 参数错误：文件路径 \`${normalizedPath}\` 不能包含空段、"." 或 ".."。`);
  }
  for (const segment of segments) {
    if (/[\u0000-\u001F<>:"|?*]/.test(segment)) {
      throw new Error(`conversation_document 参数错误：文件路径 \`${normalizedPath}\` 包含 Windows 不允许的字符。`);
    }
  }
  return normalizedPath;
}

function splitPathBasenameAndExtension(path) {
  const normalized = normalizeConversationDocumentPath(path);
  const lastSlashIndex = normalized.lastIndexOf('/');
  const directory = lastSlashIndex >= 0 ? normalized.slice(0, lastSlashIndex) : '';
  const filename = lastSlashIndex >= 0 ? normalized.slice(lastSlashIndex + 1) : normalized;
  const lastDotIndex = filename.lastIndexOf('.');
  if (lastDotIndex <= 0) {
    return { directory, stem: filename, extension: '' };
  }
  return {
    directory,
    stem: filename.slice(0, lastDotIndex),
    extension: filename.slice(lastDotIndex)
  };
}

export function buildConversationDocumentCollisionPath(requestedPath, occupiedPaths, options = {}) {
  const normalizedRequestedPath = normalizeConversationDocumentPath(requestedPath);
  const excludedPath = normalizeString(options?.excludedPath)
    ? normalizeConversationDocumentPath(options.excludedPath)
    : '';
  const occupied = new Set(
    Array.from(occupiedPaths || [])
      .map((value) => {
        try {
          return normalizeConversationDocumentPath(value);
        } catch (_) {
          return '';
        }
      })
      .filter(Boolean)
      .filter((value) => value !== excludedPath)
  );
  if (!occupied.has(normalizedRequestedPath)) {
    return normalizedRequestedPath;
  }

  const { directory, stem, extension } = splitPathBasenameAndExtension(normalizedRequestedPath);
  const prefix = directory ? `${directory}/` : '';
  let nextIndex = 2;
  while (nextIndex < 10_000) {
    const candidate = `${prefix}${stem} (${nextIndex})${extension}`;
    if (!occupied.has(candidate)) {
      return candidate;
    }
    nextIndex += 1;
  }
  throw new Error(`无法为文档 \`${normalizedRequestedPath}\` 生成不冲突的文件名。`);
}

function normalizeConversationId(value) {
  const text = normalizeString(value);
  if (!text) {
    throw new Error('conversation_document 参数错误：conversation_id 不能为空。');
  }
  return text;
}

function normalizeReadTextLineEndings(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

function splitLogicalLines(text) {
  const normalized = normalizeReadTextLineEndings(text);
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return { text: normalized, lines };
}

function countLogicalLines(text) {
  return splitLogicalLines(text).lines.length;
}

function countLogicalLinesBeforeChar(text, offset) {
  const normalized = normalizeReadTextLineEndings(String(text ?? '').slice(0, Math.max(0, Math.trunc(Number(offset) || 0))));
  if (!normalized) return 1;
  return normalized.split('\n').length;
}

function normalizeConversationDocumentReadRangeArgs(rawArgs, options = {}) {
  const args = ensurePlainObject(rawArgs);
  const allowLineRange = options?.allowLineRange === true;
  const explicitMode = normalizeString(args.mode).toLowerCase();
  const hasSkipChars = args.skip_chars != null;
  const hasMaxChars = args.max_chars != null;
  const hasStartLine = args.start_line != null;
  const hasEndLine = args.end_line != null;

  if ((hasStartLine || hasEndLine) && (hasSkipChars || hasMaxChars)) {
    throw new Error('conversation_document 参数错误：不能同时使用字符区间和行区间读取参数。');
  }
  if (!allowLineRange && (hasStartLine || hasEndLine)) {
    throw new Error('conversation_document 参数错误：当前 action 不支持 start_line / end_line。');
  }
  if (allowLineRange && (hasStartLine || hasEndLine) && !(hasStartLine && hasEndLine)) {
    throw new Error('conversation_document 参数错误：使用行区间读取时，start_line 与 end_line 需要同时提供。');
  }

  const skipChars = hasSkipChars ? clampNonNegativeInt(args.skip_chars, 0) : null;
  const maxChars = hasMaxChars
    ? Math.max(1, Math.min(CONVERSATION_DOCUMENT_READ_MAX_CHARS, clampNonNegativeInt(args.max_chars, CONVERSATION_DOCUMENT_READ_DEFAULT_RANGE_CHARS)))
    : null;

  if (explicitMode === 'preview') {
    return {
      mode: 'preview',
      skip_chars: 0,
      max_chars: maxChars ?? CONVERSATION_DOCUMENT_READ_DEFAULT_RANGE_CHARS,
      start_line: null,
      end_line: null
    };
  }

  if (hasStartLine || hasEndLine) {
    const startLine = clampPositiveInt(args.start_line, 1);
    const endLine = clampPositiveInt(args.end_line, startLine);
    if (endLine < startLine) {
      throw new Error('conversation_document 参数错误：end_line 不能小于 start_line。');
    }
    return {
      mode: 'line_range',
      skip_chars: null,
      max_chars: null,
      start_line: startLine,
      end_line: endLine
    };
  }

  if (hasSkipChars || hasMaxChars) {
    return {
      mode: 'char_range',
      skip_chars: skipChars ?? 0,
      max_chars: maxChars ?? CONVERSATION_DOCUMENT_READ_DEFAULT_RANGE_CHARS,
      start_line: null,
      end_line: null
    };
  }

  return {
    mode: 'preview',
    skip_chars: 0,
    max_chars: CONVERSATION_DOCUMENT_READ_DEFAULT_RANGE_CHARS,
    start_line: null,
    end_line: null
  };
}

function buildConversationDocumentReadResult(text, rawArgs, options = {}) {
  const sourceText = String(text ?? '');
  const range = normalizeConversationDocumentReadRangeArgs(rawArgs, {
    allowLineRange: options?.allowLineRange === true
  });
  const totalChars = sourceText.length;
  const totalLines = countLogicalLines(sourceText);

  if (range.mode === 'line_range') {
    const { text: normalizedText, lines } = splitLogicalLines(sourceText);
    const totalLogicalLines = lines.length;
    const requestedStartLine = Math.min(range.start_line, Math.max(1, totalLogicalLines || 1));
    const requestedEndLine = Math.min(
      Math.max(requestedStartLine, range.end_line),
      Math.max(requestedStartLine, totalLogicalLines || requestedStartLine)
    );

    const lineStartOffsets = [];
    let cursor = 0;
    for (let index = 0; index < lines.length; index += 1) {
      lineStartOffsets.push(cursor);
      cursor += lines[index].length + 1;
    }
    const startOffset = totalLogicalLines > 0 ? lineStartOffsets[requestedStartLine - 1] : 0;
    const endOffset = totalLogicalLines > 0
      ? (requestedEndLine < totalLogicalLines ? lineStartOffsets[requestedEndLine] : normalizedText.length)
      : 0;
    const content = normalizedText.slice(startOffset, endOffset);
    const returnedLineCount = requestedEndLine >= requestedStartLine ? (requestedEndLine - requestedStartLine + 1) : 0;
    const omittedChars = Math.max(0, totalChars - content.length);

    return {
      mode: 'line_range',
      total_chars: totalChars,
      total_lines: totalLines,
      start_line: requestedStartLine,
      end_line: requestedEndLine,
      returned_line_count: returnedLineCount,
      returned_chars: content.length,
      omitted_chars: omittedChars,
      omitted_pct: formatPercent(omittedChars, totalChars),
      truncated: omittedChars > 0,
      has_more_after_range: requestedEndLine < totalLogicalLines,
      content
    };
  }

  const start = Math.min(range.skip_chars, totalChars);
  const effectiveMaxChars = range.max_chars ?? CONVERSATION_DOCUMENT_READ_DEFAULT_RANGE_CHARS;
  const end = Math.min(totalChars, start + effectiveMaxChars);
  const content = sourceText.slice(start, end);
  const omittedChars = Math.max(0, totalChars - content.length);

  return {
    mode: range.mode,
    total_chars: totalChars,
    total_lines: totalLines,
    skip_chars: start,
    max_chars: effectiveMaxChars,
    returned_chars: content.length,
    omitted_chars: omittedChars,
    omitted_pct: formatPercent(omittedChars, totalChars),
    truncated: omittedChars > 0,
    has_more_after_range: end < totalChars,
    content
  };
}

function buildConversationDocumentNumberedContent(text, readResult) {
  const sourceText = String(text ?? '');
  const returnedText = normalizeReadTextLineEndings(readResult?.content || '');
  if (!returnedText) return '';

  const lines = returnedText.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  if (lines.length <= 0) return '';

  let firstLineNumber = 1;
  if (readResult?.mode === 'line_range' && Number.isFinite(Number(readResult?.start_line))) {
    firstLineNumber = Math.max(1, Math.trunc(Number(readResult.start_line)));
  } else if (Number.isFinite(Number(readResult?.skip_chars))) {
    firstLineNumber = countLogicalLinesBeforeChar(sourceText, readResult.skip_chars);
  }

  const width = String(firstLineNumber + lines.length - 1).length;
  return lines
    .map((line, index) => `${String(firstLineNumber + index).padStart(width, ' ')} | ${line}`)
    .join('\n');
}

function normalizeSearchCaseMode(value) {
  const text = normalizeString(value).toLowerCase();
  if (!text || text === 'smart') return 'smart';
  if (text === 'sensitive' || text === 'insensitive') return text;
  throw new Error(`conversation_document 参数错误：不支持的 case_mode \`${value}\`。`);
}

function normalizeSearchMaxResults(value) {
  if (value == null) return CONVERSATION_DOCUMENT_SEARCH_DEFAULT_MAX_RESULTS;
  return Math.max(1, Math.min(CONVERSATION_DOCUMENT_SEARCH_MAX_RESULTS, clampPositiveInt(value, CONVERSATION_DOCUMENT_SEARCH_DEFAULT_MAX_RESULTS)));
}

function normalizeContextLineCount(value) {
  if (value == null) return 0;
  return Math.max(0, Math.min(10, clampNonNegativeInt(value, 0)));
}

function normalizeSearchPathGlob(value) {
  const rawGlob = normalizeString(value).replace(/\\/g, '/');
  const withoutLeadingDot = rawGlob.replace(/^(?:\.\/)+/, '');
  const normalizedGlob = withoutLeadingDot.startsWith('/')
    ? withoutLeadingDot.slice(1)
    : withoutLeadingDot;
  if (!normalizedGlob) return null;
  if (normalizedGlob.length > 512) {
    throw new Error('conversation_document 参数错误：path_glob 长度不能超过 512。');
  }
  const segments = normalizedGlob.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`conversation_document 参数错误：path_glob \`${normalizedGlob}\` 不能包含空段、"." 或 ".."。`);
  }
  return normalizedGlob;
}

function buildPathGlobRegExp(pathGlob) {
  if (!pathGlob) return null;
  const normalized = normalizeSearchPathGlob(pathGlob);
  let pattern = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    const afterNext = normalized[index + 2];
    if (char === '*' && next === '*' && afterNext === '/') {
      pattern += '(?:[^/]+/)*';
      index += 2;
      continue;
    }
    if (char === '*' && next === '*') {
      pattern += '.*';
      index += 1;
      continue;
    }
    if (char === '*') {
      pattern += '[^/]*';
      continue;
    }
    if (char === '?') {
      pattern += '[^/]';
      continue;
    }
    pattern += escapeRegExp(char);
  }
  pattern += '$';
  return new RegExp(pattern);
}

function resolveSearchFlags(pattern, options = {}) {
  const regex = options?.regex === true;
  const caseMode = normalizeSearchCaseMode(options?.case_mode);
  const hasUppercase = /[A-Z]/.test(pattern);
  const caseSensitive = caseMode === 'sensitive' || (caseMode === 'smart' && hasUppercase);
  return {
    regex,
    case_mode: caseMode,
    case_sensitive: caseSensitive
  };
}

function buildSearchContextSlice(lines, startIndex, endExclusive) {
  const slice = [];
  for (let index = startIndex; index < endExclusive; index += 1) {
    if (index < 0 || index >= lines.length) continue;
    slice.push({
      line_number: index + 1,
      text: lines[index]
    });
  }
  return slice;
}

function findFixedStringMatches(lineText, needle, caseSensitive) {
  const matches = [];
  if (!needle) return matches;
  const source = String(lineText ?? '');
  const haystack = caseSensitive ? source : source.toLocaleLowerCase();
  const searchNeedle = caseSensitive ? needle : needle.toLocaleLowerCase();
  let startIndex = 0;
  while (startIndex <= haystack.length) {
    const foundIndex = haystack.indexOf(searchNeedle, startIndex);
    if (foundIndex < 0) break;
    matches.push({
      start: foundIndex,
      end: foundIndex + searchNeedle.length,
      text: source.slice(foundIndex, foundIndex + searchNeedle.length)
    });
    startIndex = foundIndex + Math.max(1, searchNeedle.length);
  }
  return matches;
}

function findRegexMatches(lineText, pattern, caseSensitive) {
  const source = String(lineText ?? '');
  const flags = caseSensitive ? 'g' : 'gi';
  const regex = new RegExp(pattern, flags);
  const matches = [];
  let match = regex.exec(source);
  while (match) {
    const fullMatch = String(match[0] ?? '');
    const start = Number(match.index) || 0;
    matches.push({
      start,
      end: start + fullMatch.length,
      text: fullMatch
    });
    if (fullMatch.length <= 0) {
      regex.lastIndex = start + 1;
    }
    match = regex.exec(source);
  }
  return matches;
}

function collectMatchesForLine(lineText, pattern, options = {}) {
  if (options?.regex === true) {
    return findRegexMatches(lineText, pattern, options.case_sensitive === true);
  }
  return findFixedStringMatches(lineText, pattern, options.case_sensitive === true);
}

function buildDocumentManifest(documents, options = {}) {
  const pathGlob = normalizeSearchPathGlob(options?.path_glob);
  const pathGlobRegExp = buildPathGlobRegExp(pathGlob);
  const files = (Array.isArray(documents) ? documents : [])
    .filter((doc) => !pathGlobRegExp || pathGlobRegExp.test(doc.path))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((doc) => ({
      path: doc.path,
      size_chars: buildDocumentSizeChars(doc.content),
      updated_at: toIsoTimestamp(doc.updated_at)
    }));
  return {
    path_glob: pathGlob,
    total_files: files.length,
    returned_file_count: files.length,
    files
  };
}

function searchConversationDocuments(documents, rawOptions = {}) {
  const pattern = normalizeString(rawOptions.pattern);
  if (!pattern) {
    throw new Error('conversation_document 参数错误：search_files 时 pattern 不能为空。');
  }

  const searchFlags = resolveSearchFlags(pattern, rawOptions);
  if (searchFlags.regex === true) {
    try {
      new RegExp(pattern, searchFlags.case_sensitive ? 'g' : 'gi');
    } catch (error) {
      throw new Error(`conversation_document 参数错误：无效的正则 pattern：${error?.message || error}`);
    }
  }
  const maxResults = normalizeSearchMaxResults(rawOptions.max_results);
  const contextBefore = normalizeContextLineCount(rawOptions.context_before);
  const contextAfter = normalizeContextLineCount(rawOptions.context_after);
  const pathGlob = normalizeSearchPathGlob(rawOptions.path_glob);
  const pathGlobRegExp = buildPathGlobRegExp(pathGlob);

  const matches = [];
  let totalMatches = 0;

  for (const documentRecord of Array.isArray(documents) ? documents : []) {
    if (pathGlobRegExp && !pathGlobRegExp.test(documentRecord.path)) {
      continue;
    }
    const { lines } = splitLogicalLines(documentRecord.content || '');
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const lineText = lines[lineIndex];
      const lineMatches = collectMatchesForLine(lineText, pattern, searchFlags);
      for (const lineMatch of lineMatches) {
        totalMatches += 1;
        if (matches.length >= maxResults) {
          continue;
        }
        matches.push({
          match_id: `m${matches.length + 1}`,
          file_path: documentRecord.path,
          line_number: lineIndex + 1,
          column_start: lineMatch.start + 1,
          column_end: Math.max(lineMatch.start + 1, lineMatch.end),
          match_text: lineMatch.text,
          line_text: lineText,
          before: buildSearchContextSlice(lines, lineIndex - contextBefore, lineIndex),
          after: buildSearchContextSlice(lines, lineIndex + 1, lineIndex + 1 + contextAfter)
        });
      }
    }
  }

  return {
    pattern,
    regex: searchFlags.regex,
    case_mode: searchFlags.case_mode,
    case_sensitive: searchFlags.case_sensitive,
    path_glob: pathGlob,
    context_before: contextBefore,
    context_after: contextAfter,
    max_results: maxResults,
    total_matches: totalMatches,
    returned_match_count: matches.length,
    truncated: totalMatches > matches.length,
    matches
  };
}

function normalizeDocumentRecord(rawDocument, fallbackUpdatedAt = null) {
  const path = normalizeConversationDocumentPath(rawDocument.path);
  const content = typeof rawDocument.content === 'string' ? rawDocument.content : '';
  return {
    path,
    content,
    updated_at: toIsoTimestamp(rawDocument.updated_at || fallbackUpdatedAt || new Date().toISOString()),
    size_chars: buildDocumentSizeChars(content)
  };
}

function cloneDocuments(documents) {
  return (Array.isArray(documents) ? documents : []).map((doc) => ({ ...doc }));
}

function findDocumentIndex(documents, path) {
  return documents.findIndex((doc) => doc.path === path);
}

function applyConversationDocumentPatch(documents, patch) {
  const { hunks } = parseApplyPatch(patch, { mode: 'strict' });
  if (hunks.length <= 0) {
    throw new Error('No files were modified.');
  }

  const nextDocuments = cloneDocuments(documents)
    .map((doc) => normalizeDocumentRecord(doc))
    .sort((left, right) => left.path.localeCompare(right.path));
  const affectedFiles = {
    added: [],
    modified: [],
    deleted: []
  };
  const renamedTargets = [];
  const patchTime = new Date().toISOString();

  for (const hunk of hunks) {
    if (hunk.type === 'add_file') {
      const requestedPath = normalizeConversationDocumentPath(hunk.path);
      const finalPath = buildConversationDocumentCollisionPath(
        requestedPath,
        nextDocuments.map((doc) => doc.path)
      );
      nextDocuments.push(normalizeDocumentRecord({
        path: finalPath,
        content: hunk.contents,
        updated_at: patchTime
      }, patchTime));
      nextDocuments.sort((left, right) => left.path.localeCompare(right.path));
      affectedFiles.added.push(finalPath);
      if (finalPath !== requestedPath) {
        renamedTargets.push({
          requested_path: requestedPath,
          final_path: finalPath,
          reason: 'collision'
        });
      }
      continue;
    }

    if (hunk.type === 'delete_file') {
      const targetPath = normalizeConversationDocumentPath(hunk.path);
      const existingIndex = findDocumentIndex(nextDocuments, targetPath);
      if (existingIndex < 0) {
        throw new Error(`Failed to delete file ${targetPath}`);
      }
      nextDocuments.splice(existingIndex, 1);
      affectedFiles.deleted.push(targetPath);
      continue;
    }

    if (hunk.type === 'update_file') {
      const sourcePath = normalizeConversationDocumentPath(hunk.path);
      const sourceIndex = findDocumentIndex(nextDocuments, sourcePath);
      if (sourceIndex < 0) {
        throw new Error(`Failed to read file to update ${sourcePath}`);
      }
      const sourceDocument = nextDocuments[sourceIndex];
      const nextContent = derivePatchedFileContent(sourceDocument.content, sourcePath, hunk.chunks);
      const requestedTargetPath = hunk.move_path
        ? normalizeConversationDocumentPath(hunk.move_path)
        : sourcePath;
      const finalTargetPath = buildConversationDocumentCollisionPath(
        requestedTargetPath,
        nextDocuments.map((doc) => doc.path),
        { excludedPath: sourcePath }
      );
      const nextRecord = normalizeDocumentRecord({
        path: finalTargetPath,
        content: nextContent,
        updated_at: patchTime
      }, patchTime);

      nextDocuments[sourceIndex] = nextRecord;
      nextDocuments.sort((left, right) => left.path.localeCompare(right.path));
      affectedFiles.modified.push(finalTargetPath);
      if (finalTargetPath !== requestedTargetPath) {
        renamedTargets.push({
          requested_path: requestedTargetPath,
          final_path: finalTargetPath,
          reason: 'collision'
        });
      }
    }
  }

  return {
    documents: nextDocuments,
    affected_files: {
      added: Array.from(new Set(affectedFiles.added)),
      modified: Array.from(new Set(affectedFiles.modified)),
      deleted: Array.from(new Set(affectedFiles.deleted))
    },
    renamed_targets: renamedTargets
  };
}

function buildChangeEventPayload(conversationId, action, options = {}) {
  const updatedPaths = Array.isArray(options.updated_paths)
    ? Array.from(new Set(options.updated_paths.map((value) => normalizeString(value)).filter(Boolean)))
    : [];
  const deletedPaths = Array.isArray(options.deleted_paths)
    ? Array.from(new Set(options.deleted_paths.map((value) => normalizeString(value)).filter(Boolean)))
    : [];
  return {
    conversation_id: conversationId,
    action,
    updated_paths: updatedPaths,
    deleted_paths: deletedPaths
  };
}

function createDefaultConversationDocumentStore() {
  return {
    listDocuments: listConversationDocuments,
    getDocument: getConversationDocument,
    putDocument: putConversationDocument,
    replaceDocuments: replaceConversationDocuments
  };
}

function ensureStore(store = null) {
  const resolved = store || createDefaultConversationDocumentStore();
  const requiredMethods = ['listDocuments', 'getDocument', 'putDocument', 'replaceDocuments'];
  const missing = requiredMethods.filter((name) => typeof resolved?.[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(`当前环境没有可用的 conversation document store，缺少方法：${missing.join(', ')}`);
  }
  return resolved;
}

function buildReadFilePayload(documentRecord, readOptions, includeLineNumbers) {
  const contentRead = buildConversationDocumentReadResult(documentRecord.content, readOptions, {
    allowLineRange: true
  });
  return {
    path: documentRecord.path,
    updated_at: toIsoTimestamp(documentRecord.updated_at),
    size_chars: buildDocumentSizeChars(documentRecord.content),
    content: contentRead.content,
    content_read: contentRead,
    ...(includeLineNumbers === true
      ? { numbered_content: buildConversationDocumentNumberedContent(documentRecord.content, contentRead) }
      : {})
  };
}

export function isConversationDocumentToolAction(action) {
  return PUBLIC_ACTIONS.has(normalizeString(action).toLowerCase());
}

export function isConversationDocumentMutationAction(action) {
  const normalized = normalizeString(action).toLowerCase();
  return normalized === CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME
    || normalized === CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION;
}

function normalizeActionArgs(action, rawArgs, options = {}) {
  const allowInternalActions = options?.allowInternalActions === true;
  const args = ensurePlainObject(rawArgs);
  const normalizedAction = normalizeString(action).toLowerCase();
  if (!PUBLIC_ACTIONS.has(normalizedAction) && !(allowInternalActions && INTERNAL_ACTIONS.has(normalizedAction))) {
    throw new Error(`conversation_document 参数错误：不支持的 action \`${action}\`。`);
  }

  const includeLineNumbers = args.include_line_numbers === true;
  const readOptions = {
    mode: args.mode,
    skip_chars: args.skip_chars,
    max_chars: args.max_chars,
    start_line: args.start_line,
    end_line: args.end_line
  };

  switch (normalizedAction) {
    case CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME:
      if (!normalizeString(args.patch)) {
        throw new Error('conversation_document 参数错误：apply_patch 需要 patch。');
      }
      return {
        action: normalizedAction,
        patch: String(args.patch || ''),
        file_path: null,
        pattern: null,
        read_options: null,
        include_line_numbers: false,
        path_glob: null,
        regex: false,
        case_mode: 'smart',
        context_before: 0,
        context_after: 0,
        max_results: CONVERSATION_DOCUMENT_SEARCH_DEFAULT_MAX_RESULTS,
        content: null
      };
    case CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME:
      return {
        action: normalizedAction,
        patch: null,
        file_path: null,
        pattern: null,
        read_options: null,
        include_line_numbers: false,
        path_glob: normalizeSearchPathGlob(args.path_glob),
        regex: false,
        case_mode: 'smart',
        context_before: 0,
        context_after: 0,
        max_results: CONVERSATION_DOCUMENT_SEARCH_DEFAULT_MAX_RESULTS,
        content: null
      };
    case CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME:
      return {
        action: normalizedAction,
        patch: null,
        file_path: normalizeConversationDocumentPath(args.file_path),
        pattern: null,
        read_options: readOptions,
        include_line_numbers: includeLineNumbers,
        path_glob: null,
        regex: false,
        case_mode: 'smart',
        context_before: 0,
        context_after: 0,
        max_results: CONVERSATION_DOCUMENT_SEARCH_DEFAULT_MAX_RESULTS,
        content: null
      };
    case CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME:
      if (!normalizeString(args.pattern)) {
        throw new Error('conversation_document 参数错误：search_files 需要 pattern。');
      }
      return {
        action: normalizedAction,
        patch: null,
        file_path: null,
        pattern: normalizeString(args.pattern),
        read_options: null,
        include_line_numbers: false,
        path_glob: normalizeSearchPathGlob(args.path_glob),
        regex: args.regex === true,
        case_mode: normalizeSearchCaseMode(args.case_mode),
        context_before: normalizeContextLineCount(args.context_before),
        context_after: normalizeContextLineCount(args.context_after),
        max_results: normalizeSearchMaxResults(args.max_results),
        content: null
      };
    case CONVERSATION_DOCUMENT_INTERNAL_READ_FILE_FULL_ACTION:
      return {
        action: normalizedAction,
        patch: null,
        file_path: normalizeConversationDocumentPath(args.file_path),
        pattern: null,
        read_options: null,
        include_line_numbers: false,
        path_glob: null,
        regex: false,
        case_mode: 'smart',
        context_before: 0,
        context_after: 0,
        max_results: CONVERSATION_DOCUMENT_SEARCH_DEFAULT_MAX_RESULTS,
        content: null
      };
    case CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION:
      return {
        action: normalizedAction,
        patch: null,
        file_path: normalizeConversationDocumentPath(args.file_path),
        pattern: null,
        read_options: null,
        include_line_numbers: false,
        path_glob: null,
        regex: false,
        case_mode: 'smart',
        context_before: 0,
        context_after: 0,
        max_results: CONVERSATION_DOCUMENT_SEARCH_DEFAULT_MAX_RESULTS,
        content: typeof args.content === 'string' ? args.content : ''
      };
    default:
      throw new Error(`conversation_document 参数错误：未处理的 action \`${action}\`。`);
  }
}

export async function executeConversationDocumentAction(action, rawArgs, options = {}) {
  const normalizedAction = normalizeString(action).toLowerCase();
  const normalizedArgs = normalizeActionArgs(normalizedAction, rawArgs, {
    allowInternalActions: options?.allowInternalActions === true
  });
  const conversationId = normalizeConversationId(options?.conversationId);
  const store = ensureStore(options?.store || null);

  switch (normalizedAction) {
    case CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME: {
      const documents = await store.listDocuments(conversationId);
      return {
        ok: true,
        action: normalizedAction,
        conversation_id: conversationId,
        ...buildDocumentManifest(documents, {
          path_glob: normalizedArgs.path_glob
        })
      };
    }
    case CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME: {
      const documentRecord = await store.getDocument(conversationId, normalizedArgs.file_path);
      if (!documentRecord) {
        throw new Error(`当前对话中不存在文件 ${normalizedArgs.file_path}。`);
      }
      return {
        ok: true,
        action: normalizedAction,
        conversation_id: conversationId,
        file: buildReadFilePayload(documentRecord, normalizedArgs.read_options, normalizedArgs.include_line_numbers)
      };
    }
    case CONVERSATION_DOCUMENT_INTERNAL_READ_FILE_FULL_ACTION: {
      const documentRecord = await store.getDocument(conversationId, normalizedArgs.file_path);
      if (!documentRecord) {
        return {
          ok: false,
          action: normalizedAction,
          conversation_id: conversationId,
          missing: true,
          file_path: normalizedArgs.file_path
        };
      }
      return {
        ok: true,
        action: normalizedAction,
        conversation_id: conversationId,
        file: {
          path: documentRecord.path,
          updated_at: toIsoTimestamp(documentRecord.updated_at),
          size_chars: buildDocumentSizeChars(documentRecord.content),
          content: documentRecord.content
        }
      };
    }
    case CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME: {
      const documents = await store.listDocuments(conversationId);
      return {
        ok: true,
        action: normalizedAction,
        conversation_id: conversationId,
        ...searchConversationDocuments(documents, normalizedArgs)
      };
    }
    case CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION: {
      const nextRecord = await store.putDocument(conversationId, {
        path: normalizedArgs.file_path,
        content: normalizedArgs.content,
        updated_at: new Date().toISOString(),
        size_chars: buildDocumentSizeChars(normalizedArgs.content)
      });
      return {
        ok: true,
        action: normalizedAction,
        conversation_id: conversationId,
        file: {
          path: nextRecord.path,
          updated_at: nextRecord.updated_at,
          size_chars: nextRecord.size_chars,
          content: nextRecord.content
        },
        change_event: buildChangeEventPayload(conversationId, normalizedAction, {
          updated_paths: [nextRecord.path]
        })
      };
    }
    case CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME: {
      const existingDocuments = await store.listDocuments(conversationId);
      const patched = applyConversationDocumentPatch(existingDocuments, normalizedArgs.patch);
      const persistedDocuments = await store.replaceDocuments(conversationId, patched.documents);
      return {
        ok: true,
        action: normalizedAction,
        conversation_id: conversationId,
        files: buildDocumentManifest(persistedDocuments),
        affected_files: patched.affected_files,
        renamed_targets: patched.renamed_targets,
        change_event: buildChangeEventPayload(conversationId, normalizedAction, {
          updated_paths: [
            ...patched.affected_files.added,
            ...patched.affected_files.modified
          ],
          deleted_paths: patched.affected_files.deleted
        })
      };
    }
    default:
      throw new Error(`conversation_document 参数错误：未处理的 action \`${action}\`。`);
  }
}

function buildCommonFileReadParametersDescription() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      file_path: {
        type: 'string',
        description: '当前对话中文档的虚拟路径，例如 `docs/plan.md`。'
      },
      mode: {
        type: ['string', 'null'],
        description: '可选。preview 表示从头部预览读取。'
      },
      skip_chars: {
        type: ['integer', 'null'],
        description: '可选。从指定字符偏移开始读取正文。'
      },
      max_chars: {
        type: ['integer', 'null'],
        description: `可选。本次最多返回的正文字符数。默认 ${CONVERSATION_DOCUMENT_READ_DEFAULT_RANGE_CHARS}，最大 ${CONVERSATION_DOCUMENT_READ_MAX_CHARS}。`
      },
      start_line: {
        type: ['integer', 'null'],
        description: '可选。从指定行号开始读取正文。必须与 end_line 一起提供，且不能和 skip_chars/max_chars 同时使用。'
      },
      end_line: {
        type: ['integer', 'null'],
        description: '可选。读取到指定结束行。必须与 start_line 一起提供，且不能和 skip_chars/max_chars 同时使用。'
      },
      include_line_numbers: {
        type: ['boolean', 'null'],
        description: '可选。为 true 时额外返回带行号的 numbered_content。'
      }
    },
    required: ['file_path']
  };
}

export function buildConversationDocumentApplyPatchFunctionToolDefinition() {
  return {
    type: 'function',
    name: CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME,
    description: '对当前对话下的虚拟文档应用 Codex apply_patch。仅作用于当前对话文档，不会修改真实工作区文件。',
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        patch: {
          type: 'string',
          description: '补丁文本。必须使用 `*** Begin Patch` / `*** Update File:` / `*** Add File:` / `*** Delete File:` / `*** End Patch` 语法。'
        }
      },
      required: ['patch']
    }
  };
}

export function buildConversationDocumentListFilesFunctionToolDefinition() {
  return {
    type: 'function',
    name: CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME,
    description: '列出当前对话下的虚拟文档路径与基本元数据。',
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path_glob: {
          type: ['string', 'null'],
          description: '可选。按文档路径过滤，例如 `docs/**/*.md`。'
        }
      }
    }
  };
}

export function buildConversationDocumentReadFileFunctionToolDefinition() {
  return {
    type: 'function',
    name: CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME,
    description: '读取当前对话下某个虚拟文档。默认返回安全预览，可按字符或行范围读取。',
    strict: false,
    parameters: buildCommonFileReadParametersDescription()
  };
}

export function buildConversationDocumentSearchFilesFunctionToolDefinition() {
  return {
    type: 'function',
    name: CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME,
    description: '在当前对话的全部虚拟文档中搜索文本或正则模式。',
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: {
          type: 'string',
          description: '必填。固定字符串或正则模式。'
        },
        regex: {
          type: ['boolean', 'null'],
          description: '可选。为 true 时把 pattern 当作正则。'
        },
        case_mode: {
          type: ['string', 'null'],
          description: '可选。支持 smart、sensitive、insensitive。默认 smart。'
        },
        path_glob: {
          type: ['string', 'null'],
          description: '可选。按文档路径过滤，例如 `docs/**/*.md`。'
        },
        context_before: {
          type: ['integer', 'null'],
          description: '可选。返回命中行之前的上下文行数。'
        },
        context_after: {
          type: ['integer', 'null'],
          description: '可选。返回命中行之后的上下文行数。'
        },
        max_results: {
          type: ['integer', 'null'],
          description: `可选。返回的最大命中数。默认 ${CONVERSATION_DOCUMENT_SEARCH_DEFAULT_MAX_RESULTS}，最大 ${CONVERSATION_DOCUMENT_SEARCH_MAX_RESULTS}。`
        }
      },
      required: ['pattern']
    }
  };
}
