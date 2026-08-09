/**
 * 统一虚拟文件工具。
 *
 * 说明：
 * - 顶层公开给模型的文件工具统一为 `apply_patch` / `list_files` / `read_file` / `search_files` / `copy_file`；
 * - 文件工具通过结构化 `target` 选择 skill，默认当前对话文件区；本地映射通过 `local/...` 路径进入；
 * - 会话文件仍在侧栏本地 IndexedDB 执行；local 文件实时读取用户授权 handle；skill 文件复用现有 skill package / background 执行链路；
 * - UI 为了编辑对话文档与完整查看，会额外复用 `write_file` / `read_file_full` 两个内部 action。
 *
 * 当前目录结构：
 * - 顶层文件工具按动作拆到独立文件；
 * - `index.js` 负责保留公共导出面与执行路由；
 * - 这样既能保持外部调用稳定，也能让 tool-family 内部不再继续扁平堆叠。
 */

import { derivePatchedFileContent, parseApplyPatch } from '../shared/apply_patch_core.js';
import {
  getConversationDocument,
  listConversationDocuments,
  putConversationDocument,
  replaceConversationDocuments
} from '../../storage/conversation_document_store.js';
import { listLocalFileMounts } from '../../storage/local_file_mount_store.js';
import {
  CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME,
  CONVERSATION_DOCUMENT_CHANGE_EVENT_NAME,
  CONVERSATION_DOCUMENT_COPY_FILE_TOOL_NAME,
  CONVERSATION_DOCUMENT_DELETE_FILE_TOOL_NAME,
  CONVERSATION_DOCUMENT_INTERNAL_READ_FILE_FULL_ACTION,
  CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION,
  CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME,
  CONVERSATION_DOCUMENT_MOVE_FILE_TOOL_NAME,
  CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME,
  CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME,
  VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
  VIRTUAL_FILE_COPY_FILE_TOOL_NAME,
  VIRTUAL_FILE_DELETE_FILE_TOOL_NAME,
  VIRTUAL_FILE_INTERNAL_ACTIONS,
  VIRTUAL_FILE_LIST_FILES_TOOL_NAME,
  VIRTUAL_FILE_MOVE_FILE_TOOL_NAME,
  VIRTUAL_FILE_PUBLIC_ACTIONS,
  VIRTUAL_FILE_READ_FILE_TOOL_NAME,
  VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME,
  VIRTUAL_FILE_TARGET_KIND_CONVERSATION_DOCUMENT,
  VIRTUAL_FILE_TARGET_KIND_LOCAL,
  VIRTUAL_FILE_TARGET_KIND_SKILL,
  VIRTUAL_FILE_TARGET_KIND_WORKSPACE,
  buildDocumentSizeChars,
  clampNonNegativeInt,
  clampPositiveInt,
  ensurePlainObject,
  escapeRegExp,
  formatPercent,
  normalizeOptionalString,
  normalizeString,
  toIsoTimestamp
} from './shared.js';
import {
  buildVirtualFileTargetSummary,
  normalizeVirtualFileTarget
} from './target.js';
import {
  buildConversationDocumentCollisionPath,
  normalizeConversationDocumentHrefPath,
  normalizeConversationDocumentPath
} from './document_path.js';
import {
  buildConversationDocumentApplyPatchCustomToolDefinition,
  buildVirtualFileApplyPatchCustomToolDefinition,
  normalizeVirtualFileApplyPatchArguments,
  normalizeVirtualFileApplyPatchCustomInput
} from './apply_patch.js';
import {
  buildConversationDocumentListFilesFunctionToolDefinition,
  buildVirtualFileListFilesFunctionToolDefinition,
  normalizeVirtualFileListFilesArguments
} from './list_files.js';
import {
  buildConversationDocumentReadFileFunctionToolDefinition,
  buildVirtualFileReadFileFunctionToolDefinition,
  normalizeVirtualFileReadFileArguments
} from './read_file.js';
import {
  buildConversationDocumentSearchFilesFunctionToolDefinition,
  buildVirtualFileSearchFilesFunctionToolDefinition,
  normalizeVirtualFileSearchFilesArguments
} from './search_files.js';
import {
  buildConversationDocumentCopyFileFunctionToolDefinition,
  buildVirtualFileCopyFileFunctionToolDefinition,
  normalizeVirtualFileCopyFileArguments
} from './file_ops.js';
import {
  assertPatchDoesNotTouchLocalPaths,
  assertWritableWorkspacePath,
  isLocalVirtualPath,
  listLocalVirtualFileDocuments,
  readLocalVirtualFileDocument
} from './local_mount.js';

export {
  CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME,
  CONVERSATION_DOCUMENT_CHANGE_EVENT_NAME,
  CONVERSATION_DOCUMENT_COPY_FILE_TOOL_NAME,
  CONVERSATION_DOCUMENT_DELETE_FILE_TOOL_NAME,
  CONVERSATION_DOCUMENT_INTERNAL_READ_FILE_FULL_ACTION,
  CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION,
  CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME,
  CONVERSATION_DOCUMENT_MOVE_FILE_TOOL_NAME,
  CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME,
  CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME,
  VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
  VIRTUAL_FILE_COPY_FILE_TOOL_NAME,
  VIRTUAL_FILE_DELETE_FILE_TOOL_NAME,
  VIRTUAL_FILE_LIST_FILES_TOOL_NAME,
  VIRTUAL_FILE_MOVE_FILE_TOOL_NAME,
  VIRTUAL_FILE_READ_FILE_TOOL_NAME,
  VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME,
  VIRTUAL_FILE_TARGET_KIND_CONVERSATION_DOCUMENT,
  VIRTUAL_FILE_TARGET_KIND_LOCAL,
  VIRTUAL_FILE_TARGET_KIND_SKILL,
  VIRTUAL_FILE_TARGET_KIND_WORKSPACE
};

export {
  normalizeVirtualFileTarget,
  normalizeConversationDocumentPath,
  normalizeConversationDocumentHrefPath,
  buildConversationDocumentCollisionPath,
  buildVirtualFileApplyPatchCustomToolDefinition,
  buildConversationDocumentApplyPatchCustomToolDefinition,
  normalizeVirtualFileApplyPatchCustomInput,
  buildVirtualFileListFilesFunctionToolDefinition,
  buildConversationDocumentListFilesFunctionToolDefinition,
  buildVirtualFileReadFileFunctionToolDefinition,
  buildConversationDocumentReadFileFunctionToolDefinition,
  buildVirtualFileSearchFilesFunctionToolDefinition,
  buildConversationDocumentSearchFilesFunctionToolDefinition,
  buildVirtualFileCopyFileFunctionToolDefinition,
  buildConversationDocumentCopyFileFunctionToolDefinition
};

function normalizeConversationId(value) {
  const text = normalizeString(value);
  if (!text) {
    throw new Error('virtual_file 参数错误：conversation_id 不能为空。');
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
  const hasStartLine = args.start_line != null;
  const hasEndLine = args.end_line != null;

  if ((hasStartLine || hasEndLine) && hasSkipChars) {
    throw new Error('virtual_file 参数错误：不能同时使用字符区间和行区间读取参数。');
  }
  if (!allowLineRange && (hasStartLine || hasEndLine)) {
    throw new Error('virtual_file 参数错误：当前 action 不支持 start_line / end_line。');
  }
  if (allowLineRange && (hasStartLine || hasEndLine) && !(hasStartLine && hasEndLine)) {
    throw new Error('virtual_file 参数错误：使用行区间读取时，start_line 与 end_line 需要同时提供。');
  }

  const skipChars = hasSkipChars ? clampNonNegativeInt(args.skip_chars, 0) : null;
  if (explicitMode === 'preview' || explicitMode === 'full') {
    return {
      mode: 'full',
      skip_chars: 0,
      start_line: null,
      end_line: null
    };
  }

  if (hasStartLine || hasEndLine) {
    const startLine = clampPositiveInt(args.start_line, 1);
    const endLine = clampPositiveInt(args.end_line, startLine);
    if (endLine < startLine) {
      throw new Error('virtual_file 参数错误：end_line 不能小于 start_line。');
    }
    return {
      mode: 'line_range',
      skip_chars: null,
      start_line: startLine,
      end_line: endLine
    };
  }

  if (hasSkipChars) {
    return {
      mode: 'char_range',
      skip_chars: skipChars ?? 0,
      start_line: null,
      end_line: null
    };
  }

  return {
    mode: 'full',
    skip_chars: 0,
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
  const content = sourceText.slice(start);

  return {
    mode: range.mode,
    total_chars: totalChars,
    total_lines: totalLines,
    skip_chars: start,
    returned_chars: content.length,
    omitted_chars: start,
    omitted_pct: formatPercent(start, totalChars),
    truncated: false,
    has_more_after_range: false,
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
  throw new Error(`virtual_file 参数错误：不支持的 case_mode \`${value}\`。`);
}

function normalizeContextLineCount(value) {
  if (value == null) return 0;
  return Math.max(0, Math.min(10, clampNonNegativeInt(value, 0)));
}

function normalizeSearchPathGlob(value) {
  const rawGlob = normalizeString(value).replace(/\\/g, '/');
  const withoutLeadingDot = rawGlob.replace(/^(?:\.\/)+/, '');
  const normalizedGlobWithLegacyPrefix = withoutLeadingDot.startsWith('/')
    ? withoutLeadingDot.slice(1)
    : withoutLeadingDot;
  const normalizedGlob = normalizedGlobWithLegacyPrefix === 'workspace'
    ? ''
    : normalizedGlobWithLegacyPrefix.replace(/^workspace\//, '');
  if (!normalizedGlob) return null;
  if (normalizedGlob.length > 512) {
    throw new Error('virtual_file 参数错误：path_glob 长度不能超过 512。');
  }
  const segments = normalizedGlob.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`virtual_file 参数错误：path_glob \`${normalizedGlob}\` 不能包含空段、"." 或 ".."。`);
  }
  return normalizedGlob;
}

function hasVirtualPathGlobSyntax(value) {
  return /[*?]/.test(String(value || ''));
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
  const files = normalizeDocumentRecords(documents)
    .filter((doc) => !pathGlobRegExp || pathGlobRegExp.test(doc.path))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((doc) => {
      const sizeChars = doc.size_chars != null && Number.isFinite(Number(doc.size_chars))
        ? Math.max(0, Math.trunc(Number(doc.size_chars)))
        : (typeof doc.content === 'string' ? buildDocumentSizeChars(doc.content) : null);
      return {
        path: doc.path,
        ...(sizeChars != null ? { size_chars: sizeChars } : {}),
        updated_at: toIsoTimestamp(doc.updated_at)
      };
    });
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
    throw new Error('virtual_file 参数错误：search_files 时 pattern 不能为空。');
  }

  const searchFlags = resolveSearchFlags(pattern, rawOptions);
  if (searchFlags.regex === true) {
    try {
      new RegExp(pattern, searchFlags.case_sensitive ? 'g' : 'gi');
    } catch (error) {
      throw new Error(`virtual_file 参数错误：无效的正则 pattern：${error?.message || error}`);
    }
  }
  const contextBefore = normalizeContextLineCount(rawOptions.context_before);
  const contextAfter = normalizeContextLineCount(rawOptions.context_after);
  const pathGlob = normalizeSearchPathGlob(rawOptions.path_glob);
  const pathGlobRegExp = buildPathGlobRegExp(pathGlob);

  const matches = [];
  let totalMatches = 0;

  for (const documentRecord of normalizeDocumentRecords(documents)) {
    if (pathGlobRegExp && !pathGlobRegExp.test(documentRecord.path)) {
      continue;
    }
    const { lines } = splitLogicalLines(documentRecord.content || '');
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const lineText = lines[lineIndex];
      const lineMatches = collectMatchesForLine(lineText, pattern, searchFlags);
      for (const lineMatch of lineMatches) {
        totalMatches += 1;
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
    max_results: null,
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

function normalizeDocumentRecordSafe(rawDocument, fallbackUpdatedAt = null) {
  try {
    return normalizeDocumentRecord(rawDocument, fallbackUpdatedAt);
  } catch (_) {
    return null;
  }
}

function normalizeDocumentRecords(documents) {
  const recordsByPath = new Map();
  for (const rawDocument of cloneDocuments(documents)) {
    const record = normalizeDocumentRecordSafe(rawDocument);
    if (!record) continue;
    const existing = recordsByPath.get(record.path);
    const existingTime = existing ? Date.parse(existing.updated_at) : Number.NEGATIVE_INFINITY;
    const recordTime = Date.parse(record.updated_at);
    if (!existing || (Number.isFinite(recordTime) && recordTime >= existingTime)) {
      recordsByPath.set(record.path, record);
    }
  }
  return Array.from(recordsByPath.values())
    .sort((left, right) => left.path.localeCompare(right.path));
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

  const nextDocuments = normalizeDocumentRecords(documents);
  const affectedFiles = {
    added: [],
    modified: [],
    deleted: []
  };
  const patchTime = new Date().toISOString();

  for (const hunk of hunks) {
    if (hunk.type === 'add_file') {
      const targetPath = normalizeConversationDocumentPath(hunk.path);
      const existingIndex = findDocumentIndex(nextDocuments, targetPath);
      const nextRecord = normalizeDocumentRecord({
        path: targetPath,
        content: hunk.contents,
        updated_at: patchTime
      }, patchTime);
      if (existingIndex >= 0) {
        nextDocuments[existingIndex] = nextRecord;
        affectedFiles.modified.push(targetPath);
      } else {
        nextDocuments.push(nextRecord);
        affectedFiles.added.push(targetPath);
      }
      nextDocuments.sort((left, right) => left.path.localeCompare(right.path));
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
      const targetPath = hunk.move_path
        ? normalizeConversationDocumentPath(hunk.move_path)
        : sourcePath;
      const nextRecord = normalizeDocumentRecord({
        path: targetPath,
        content: nextContent,
        updated_at: patchTime
      }, patchTime);

      if (targetPath === sourcePath) {
        nextDocuments[sourceIndex] = nextRecord;
      } else {
        const targetIndex = findDocumentIndex(nextDocuments, targetPath);
        if (targetIndex >= 0) {
          nextDocuments[targetIndex] = nextRecord;
          nextDocuments.splice(sourceIndex, 1);
        } else {
          nextDocuments[sourceIndex] = nextRecord;
        }
      }
      nextDocuments.sort((left, right) => left.path.localeCompare(right.path));
      affectedFiles.modified.push(targetPath);
    }
  }

  return {
    documents: nextDocuments,
    affected_files: {
      added: Array.from(new Set(affectedFiles.added)),
      modified: Array.from(new Set(affectedFiles.modified)),
      deleted: Array.from(new Set(affectedFiles.deleted))
    }
  };
}

function buildChangeEventPayload(conversationId, action, options = {}) {
  const updatedPaths = Array.isArray(options.updated_paths)
    ? Array.from(new Set(options.updated_paths.map((value) => {
        try {
          return normalizeConversationDocumentPath(value);
        } catch (_) {
          return normalizeString(value);
        }
      }).filter(Boolean)))
    : [];
  const deletedPaths = Array.isArray(options.deleted_paths)
    ? Array.from(new Set(options.deleted_paths.map((value) => {
        try {
          return normalizeConversationDocumentPath(value);
        } catch (_) {
          return normalizeString(value);
        }
      }).filter(Boolean)))
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
    throw new Error(`当前环境没有可用的 conversation file store，缺少方法：${missing.join(', ')}`);
  }
  return resolved;
}

function createDefaultLocalFileMountStore() {
  return {
    listMounts: listLocalFileMounts
  };
}

function ensureLocalMountStore(store = null) {
  const resolved = store || createDefaultLocalFileMountStore();
  const requiredMethods = ['listMounts'];
  const missing = requiredMethods.filter((name) => typeof resolved?.[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(`当前环境没有可用的 local file mount store，缺少方法：${missing.join(', ')}`);
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

function assertDifferentFileOperationPaths(sourcePath, destinationPath, action) {
  if (sourcePath === destinationPath) {
    throw new Error(`virtual_file 参数错误：${action} 的 from 与 to 不能相同。`);
  }
}

function findRequiredConversationDocument(documents, filePath, action) {
  const index = findDocumentIndex(documents, filePath);
  if (index < 0) {
    throw new Error(`virtual_file 参数错误：${action} 找不到文件 ${filePath}。`);
  }
  return {
    index,
    document: documents[index]
  };
}

async function getRequiredConversationDocumentByPath(store, conversationId, filePath) {
  const directRecord = await store.getDocument(conversationId, filePath);
  if (directRecord) {
    return normalizeDocumentRecord(directRecord);
  }
  const documents = normalizeDocumentRecords(await store.listDocuments(conversationId));
  return documents.find((doc) => doc.path === filePath) || null;
}

function buildFileOperationFilePayload(documentRecord) {
  return {
    path: documentRecord.path,
    updated_at: toIsoTimestamp(documentRecord.updated_at),
    size_chars: buildDocumentSizeChars(documentRecord.content)
  };
}

export function isVirtualFileToolAction(action) {
  return VIRTUAL_FILE_PUBLIC_ACTIONS.has(normalizeString(action).toLowerCase());
}

export function isConversationDocumentToolAction(action) {
  return isVirtualFileToolAction(action);
}

export function isConversationDocumentMutationAction(action) {
  const normalized = normalizeString(action).toLowerCase();
  return normalized === VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME
    || normalized === VIRTUAL_FILE_COPY_FILE_TOOL_NAME
    || normalized === CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION;
}

/**
 * 生成 cp 语义下的新文档集合：目标不存在时新增，目标存在时原位覆盖。
 * 这里保持纯函数，调用方只在完整源文件读取成功后执行一次 replaceDocuments。
 */
function buildCopiedConversationDocumentSet(documents, copiedDocument) {
  const normalizedDocuments = normalizeDocumentRecords(documents);
  const destinationExisted = findDocumentIndex(normalizedDocuments, copiedDocument.path) >= 0;
  const nextDocuments = normalizedDocuments
    .filter((documentRecord) => documentRecord.path !== copiedDocument.path)
    .concat(copiedDocument)
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    destinationExisted,
    nextDocuments
  };
}

export function normalizeVirtualFileToolArguments(action, rawArgs, options = {}) {
  const args = ensurePlainObject(rawArgs);
  const normalizedAction = normalizeString(action).toLowerCase();
  if (!VIRTUAL_FILE_PUBLIC_ACTIONS.has(normalizedAction)) {
    throw new Error(`virtual_file 参数错误：不支持的 action \`${action}\`。`);
  }

  const requireSkillName = normalizedAction === VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME
    || normalizedAction === VIRTUAL_FILE_COPY_FILE_TOOL_NAME
    || normalizedAction === VIRTUAL_FILE_READ_FILE_TOOL_NAME;
  const target = normalizeVirtualFileTarget(args.target, {
    defaultKind: options?.defaultTargetKind || VIRTUAL_FILE_TARGET_KIND_CONVERSATION_DOCUMENT,
    requireSkillName
  });

  switch (normalizedAction) {
    case VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME: {
      const normalized = normalizeVirtualFileApplyPatchArguments(args, target);
      assertPatchDoesNotTouchLocalPaths(normalized.patch);
      return normalized;
    }
    case VIRTUAL_FILE_LIST_FILES_TOOL_NAME:
      return normalizeVirtualFileListFilesArguments(args, target);
    case VIRTUAL_FILE_READ_FILE_TOOL_NAME:
      return normalizeVirtualFileReadFileArguments(args, target);
    case VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME:
      return normalizeVirtualFileSearchFilesArguments(args, target);
    case VIRTUAL_FILE_COPY_FILE_TOOL_NAME:
      return normalizeVirtualFileCopyFileArguments(args, target);
    default:
      throw new Error(`virtual_file 参数错误：未处理的 action \`${action}\`。`);
  }
}

export function buildConversationDocumentActionPayloadFromVirtualFileAction(action, normalizedArgs) {
  const input = ensurePlainObject(normalizedArgs);
  switch (normalizeString(action).toLowerCase()) {
    case VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME:
      return { patch: input.patch || '' };
    case VIRTUAL_FILE_LIST_FILES_TOOL_NAME:
      return { path_glob: input.path_glob || null };
    case VIRTUAL_FILE_READ_FILE_TOOL_NAME:
      return {
        file_path: input.file_path,
        include_line_numbers: input.include_line_numbers === true,
        ...(ensurePlainObject(input.read_options))
      };
    case VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME:
      return {
        pattern: input.pattern,
        regex: input.regex === true,
        case_mode: input.case_mode || null,
        path_glob: input.path_glob || null,
        context_before: input.context_before,
        context_after: input.context_after,
        max_results: input.max_results
      };
    case VIRTUAL_FILE_COPY_FILE_TOOL_NAME:
      return {
        source_path: input.source_path,
        destination_path: input.destination_path
      };
    default:
      throw new Error(`virtual_file 参数错误：未处理的会话文件 action \`${action}\`。`);
  }
}

export function buildSkillRegistryFileActionPayloadFromVirtualFileAction(action, normalizedArgs) {
  const input = ensurePlainObject(normalizedArgs);
  const target = ensurePlainObject(input.target);
  const payload = {
    skill_name: normalizeOptionalString(target.name)
  };
  switch (normalizeString(action).toLowerCase()) {
    case VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME:
      return {
        action: 'apply_patch',
        ...payload,
        patch: input.patch || ''
      };
    case VIRTUAL_FILE_LIST_FILES_TOOL_NAME:
      return {
        action: 'list_files',
        ...payload,
        path_glob: input.path_glob || null
      };
    case VIRTUAL_FILE_READ_FILE_TOOL_NAME:
      return {
        action: 'read_file',
        ...payload,
        file_path: input.file_path,
        include_line_numbers: input.include_line_numbers === true,
        ...(ensurePlainObject(input.read_options))
      };
    case VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME:
      return {
        action: 'search_files',
        ...payload,
        pattern: input.pattern,
        regex: input.regex === true,
        case_mode: input.case_mode || null,
        path_glob: input.path_glob || null,
        context_before: input.context_before,
        context_after: input.context_after,
        max_results: input.max_results
      };
    case VIRTUAL_FILE_COPY_FILE_TOOL_NAME:
      return {
        action: 'copy_file',
        ...payload,
        source_file_path: input.source_path,
        destination_file_path: input.destination_path
      };
    default:
      throw new Error(`virtual_file 参数错误：未处理的 skill action \`${action}\`。`);
  }
}

function normalizeActionArgs(action, rawArgs, options = {}) {
  const allowInternalActions = options?.allowInternalActions === true;
  const args = ensurePlainObject(rawArgs);
  const normalizedAction = normalizeString(action).toLowerCase();
  if (!VIRTUAL_FILE_PUBLIC_ACTIONS.has(normalizedAction) && !(allowInternalActions && VIRTUAL_FILE_INTERNAL_ACTIONS.has(normalizedAction))) {
    throw new Error(`virtual_file 参数错误：不支持的 action \`${action}\`。`);
  }

  const includeLineNumbers = args.include_line_numbers === true;
  const readOptions = {
    mode: args.mode,
    skip_chars: args.skip_chars,
    start_line: args.start_line,
    end_line: args.end_line
  };

  switch (normalizedAction) {
    case CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME:
      if (!normalizeString(args.patch)) {
        throw new Error('virtual_file 参数错误：apply_patch 需要 patch。');
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
        max_results: null,
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
        max_results: null,
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
        max_results: null,
        content: null
      };
    case CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME:
      if (!normalizeString(args.pattern)) {
        throw new Error('virtual_file 参数错误：search_files 需要 pattern。');
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
        max_results: null,
        content: null
      };
    case CONVERSATION_DOCUMENT_COPY_FILE_TOOL_NAME:
      return {
        action: normalizedAction,
        patch: null,
        file_path: null,
        source_path: normalizeConversationDocumentPath(args.source_path),
        destination_path: normalizeConversationDocumentPath(args.destination_path),
        pattern: null,
        read_options: null,
        include_line_numbers: false,
        path_glob: null,
        regex: false,
        case_mode: 'smart',
        context_before: 0,
        context_after: 0,
        max_results: null,
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
        max_results: null,
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
        max_results: null,
        content: typeof args.content === 'string' ? args.content : ''
      };
    default:
      throw new Error(`virtual_file 参数错误：未处理的 action \`${action}\`。`);
  }
}

export async function executeConversationDocumentAction(action, rawArgs, options = {}) {
  const normalizedAction = normalizeString(action).toLowerCase();
  const normalizedArgs = normalizeActionArgs(normalizedAction, rawArgs, {
    allowInternalActions: options?.allowInternalActions === true
  });
  const conversationId = normalizeConversationId(options?.conversationId);
  const store = ensureStore(options?.store || null);
  const localMountStore = ensureLocalMountStore(options?.localMountStore || null);

  switch (normalizedAction) {
    case CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME: {
      if (isLocalVirtualPath(normalizedArgs.path_glob)) {
        const shouldRefilterWithGlob = hasVirtualPathGlobSyntax(normalizedArgs.path_glob);
        const localDocuments = await listLocalVirtualFileDocuments(conversationId, {
          path_glob: normalizedArgs.path_glob,
          store: localMountStore
        });
        const manifest = buildDocumentManifest(localDocuments, {
          path_glob: shouldRefilterWithGlob ? normalizedArgs.path_glob : null
        });
        return {
          ok: true,
          action: normalizedAction,
          conversation_id: conversationId,
          target: { kind: VIRTUAL_FILE_TARGET_KIND_LOCAL, name: null },
          ...manifest,
          path_glob: normalizedArgs.path_glob
        };
      }
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
      if (isLocalVirtualPath(normalizedArgs.file_path)) {
        const localDocumentRecord = await readLocalVirtualFileDocument(
          conversationId,
          normalizedArgs.file_path,
          localMountStore
        );
        return {
          ok: true,
          action: normalizedAction,
          conversation_id: conversationId,
          target: { kind: VIRTUAL_FILE_TARGET_KIND_LOCAL, name: null },
          file: buildReadFilePayload(localDocumentRecord, normalizedArgs.read_options, normalizedArgs.include_line_numbers)
        };
      }
      const documentRecord = await getRequiredConversationDocumentByPath(
        store,
        conversationId,
        normalizedArgs.file_path
      );
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
      if (isLocalVirtualPath(normalizedArgs.file_path)) {
        try {
          const localDocumentRecord = await readLocalVirtualFileDocument(
            conversationId,
            normalizedArgs.file_path,
            localMountStore
          );
          return {
            ok: true,
            action: normalizedAction,
            conversation_id: conversationId,
            target: { kind: VIRTUAL_FILE_TARGET_KIND_LOCAL, name: null },
            file: {
              path: localDocumentRecord.path,
              updated_at: toIsoTimestamp(localDocumentRecord.updated_at),
              size_chars: buildDocumentSizeChars(localDocumentRecord.content),
              content: localDocumentRecord.content
            }
          };
        } catch (error) {
          return {
            ok: false,
            action: normalizedAction,
            conversation_id: conversationId,
            missing: true,
            file_path: normalizedArgs.file_path,
            error: {
              message: error?.message || String(error || ''),
              name: error?.name || 'LocalMountReadError',
              stack: error?.stack || ''
            }
          };
        }
      }
      const documentRecord = await getRequiredConversationDocumentByPath(
        store,
        conversationId,
        normalizedArgs.file_path
      );
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
      if (isLocalVirtualPath(normalizedArgs.path_glob)) {
        const shouldRefilterWithGlob = hasVirtualPathGlobSyntax(normalizedArgs.path_glob);
        const localDocuments = await listLocalVirtualFileDocuments(conversationId, {
          path_glob: normalizedArgs.path_glob,
          includeContent: true,
          store: localMountStore
        });
        return {
          ok: true,
          action: normalizedAction,
          conversation_id: conversationId,
          target: { kind: VIRTUAL_FILE_TARGET_KIND_LOCAL, name: null },
          ...searchConversationDocuments(localDocuments, {
            ...normalizedArgs,
            path_glob: shouldRefilterWithGlob ? normalizedArgs.path_glob : null
          }),
          path_glob: normalizedArgs.path_glob
        };
      }
      const documents = await store.listDocuments(conversationId);
      return {
        ok: true,
        action: normalizedAction,
        conversation_id: conversationId,
        ...searchConversationDocuments(documents, normalizedArgs)
      };
    }
    case CONVERSATION_DOCUMENT_COPY_FILE_TOOL_NAME: {
      assertDifferentFileOperationPaths(normalizedArgs.source_path, normalizedArgs.destination_path, 'copy_file');
      assertWritableWorkspacePath(normalizedArgs.destination_path, 'copy_file');
      const existingDocuments = normalizeDocumentRecords(await store.listDocuments(conversationId));
      const sourceDocument = isLocalVirtualPath(normalizedArgs.source_path)
        ? await readLocalVirtualFileDocument(
          conversationId,
          normalizedArgs.source_path,
          localMountStore
        )
        : findRequiredConversationDocument(
          existingDocuments,
          normalizedArgs.source_path,
          'copy_file'
        ).document;
      const now = new Date().toISOString();
      const copiedDocument = normalizeDocumentRecord({
        path: normalizedArgs.destination_path,
        content: sourceDocument.content,
        updated_at: now
      }, now);
      const { destinationExisted, nextDocuments } = buildCopiedConversationDocumentSet(
        existingDocuments,
        copiedDocument
      );
      const persistedDocuments = await store.replaceDocuments(conversationId, nextDocuments);
      return {
        ok: true,
        action: normalizedAction,
        conversation_id: conversationId,
        source_path: normalizedArgs.source_path,
        destination_path: copiedDocument.path,
        file: buildFileOperationFilePayload(copiedDocument),
        files: buildDocumentManifest(persistedDocuments),
        affected_files: {
          added: destinationExisted ? [] : [copiedDocument.path],
          modified: destinationExisted ? [copiedDocument.path] : [],
          deleted: []
        },
        change_event: buildChangeEventPayload(conversationId, normalizedAction, {
          updated_paths: [copiedDocument.path]
        })
      };
    }
    case CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION: {
      assertWritableWorkspacePath(normalizedArgs.file_path, 'write_file');
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
      assertPatchDoesNotTouchLocalPaths(normalizedArgs.patch);
      const existingDocuments = await store.listDocuments(conversationId);
      const patched = applyConversationDocumentPatch(existingDocuments, normalizedArgs.patch);
      const persistedDocuments = await store.replaceDocuments(conversationId, patched.documents);
      return {
        ok: true,
        action: normalizedAction,
        conversation_id: conversationId,
        files: buildDocumentManifest(persistedDocuments),
        affected_files: patched.affected_files,
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
      throw new Error(`virtual_file 参数错误：未处理的 action \`${action}\`。`);
  }
}

function normalizeSkillRegistryFileRecord(file, fallbackSkillName = null) {
  const input = ensurePlainObject(file);
  return {
    skill_name: normalizeOptionalString(input.skill_name || fallbackSkillName),
    path: normalizeOptionalString(input.path) || '',
    kind: normalizeOptionalString(input.kind),
    size_chars: Number.isFinite(Number(input.size_chars)) ? Math.max(0, Math.trunc(Number(input.size_chars))) : null,
    is_manifest: input.is_manifest === true,
    is_instruction: input.is_instruction === true,
    is_runtime_entry: input.is_runtime_entry === true,
    ...(typeof input.content === 'string' ? { content: input.content } : {}),
    ...(input.content_read && typeof input.content_read === 'object' ? { content_read: input.content_read } : {}),
    ...(typeof input.numbered_content === 'string' ? { numbered_content: input.numbered_content } : {})
  };
}

export function normalizeVirtualFileResultFromSkillRegistryAction(action, rawResult, normalizedArgs) {
  const normalizedAction = normalizeString(action).toLowerCase();
  const result = ensurePlainObject(rawResult);
  const target = buildVirtualFileTargetSummary(normalizedArgs?.target);
  if (result.ok !== true) {
    return {
      ...result,
      action: normalizedAction,
      target
    };
  }

  if (normalizedAction === VIRTUAL_FILE_LIST_FILES_TOOL_NAME) {
    return {
      ok: true,
      action: normalizedAction,
      target,
      total_files: Number.isFinite(Number(result.total_files)) ? Math.max(0, Math.trunc(Number(result.total_files))) : 0,
      returned_file_count: Number.isFinite(Number(result.returned_file_count))
        ? Math.max(0, Math.trunc(Number(result.returned_file_count)))
        : 0,
      files: Array.isArray(result.files)
        ? result.files.map((file) => normalizeSkillRegistryFileRecord(file))
        : []
    };
  }

  if (normalizedAction === VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME) {
    return {
      ok: true,
      action: normalizedAction,
      target,
      pattern: normalizeOptionalString(result.pattern) || normalizeOptionalString(normalizedArgs?.pattern) || '',
      regex: result.regex === true,
      case_mode: normalizeOptionalString(result.case_mode) || 'smart',
      case_sensitive: result.case_sensitive === true,
      path_glob: normalizeOptionalString(result.path_glob),
      context_before: Number.isFinite(Number(result.context_before)) ? Math.max(0, Math.trunc(Number(result.context_before))) : 0,
      context_after: Number.isFinite(Number(result.context_after)) ? Math.max(0, Math.trunc(Number(result.context_after))) : 0,
      max_results: Number.isFinite(Number(result.max_results)) ? Math.max(1, Math.trunc(Number(result.max_results))) : null,
      total_matches: Number.isFinite(Number(result.total_matches)) ? Math.max(0, Math.trunc(Number(result.total_matches))) : 0,
      returned_match_count: Number.isFinite(Number(result.returned_match_count))
        ? Math.max(0, Math.trunc(Number(result.returned_match_count)))
        : 0,
      truncated: result.truncated === true,
      matches: Array.isArray(result.matches)
        ? result.matches.map((match) => ({
            match_id: normalizeOptionalString(match?.match_id),
            skill_name: normalizeOptionalString(match?.skill_name),
            file_path: normalizeOptionalString(match?.file_path) || '',
            line_number: Number.isFinite(Number(match?.line_number)) ? Math.max(1, Math.trunc(Number(match.line_number))) : 1,
            column_start: Number.isFinite(Number(match?.column_start)) ? Math.max(1, Math.trunc(Number(match.column_start))) : 1,
            column_end: Number.isFinite(Number(match?.column_end)) ? Math.max(1, Math.trunc(Number(match.column_end))) : 1,
            match_text: typeof match?.match_text === 'string' ? match.match_text : '',
            line_text: typeof match?.line_text === 'string' ? match.line_text : '',
            before: Array.isArray(match?.before) ? match.before : [],
            after: Array.isArray(match?.after) ? match.after : []
          }))
        : []
    };
  }

  if (normalizedAction === VIRTUAL_FILE_READ_FILE_TOOL_NAME) {
    const skill = ensurePlainObject(result.skill);
    const file = normalizeSkillRegistryFileRecord(skill.file, skill.name || target.name);
    return {
      ok: true,
      action: normalizedAction,
      target,
      file
    };
  }

  if (normalizedAction === VIRTUAL_FILE_COPY_FILE_TOOL_NAME) {
    return {
      ok: true,
      action: normalizedAction,
      target,
      source_path: normalizeOptionalString(result.source_file_path || normalizedArgs?.source_path) || '',
      destination_path: normalizeOptionalString(result.destination_file_path || normalizedArgs?.destination_path) || '',
      affected_files: ensurePlainObject(result.affected_files),
      files: ensurePlainObject(result.files),
      skill: ensurePlainObject(result.skill),
      refreshed_current_document: result.refreshed_current_document === true,
      refresh_result: result.refresh_result || null
    };
  }

  if (normalizedAction === VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME) {
    return {
      ok: true,
      action: normalizedAction,
      target,
      affected_files: ensurePlainObject(result.affected_files),
      files: ensurePlainObject(result.files),
      skill: ensurePlainObject(result.skill),
      refreshed_current_document: result.refreshed_current_document === true,
      refresh_result: result.refresh_result || null
    };
  }

  return {
    ...result,
    action: normalizedAction,
    target
  };
}
