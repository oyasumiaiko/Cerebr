const BEGIN_PATCH_MARKER = '*** Begin Patch';
const END_PATCH_MARKER = '*** End Patch';
const ADD_FILE_MARKER = '*** Add File: ';
const DELETE_FILE_MARKER = '*** Delete File: ';
const UPDATE_FILE_MARKER = '*** Update File: ';
const MOVE_TO_MARKER = '*** Move to: ';
const HUNK_MARKER = '@@';
const EOF_MARKER = '*** End of File';

const DEFAULT_MAX_FILES = 12;
const DEFAULT_MAX_LINES_PER_FILE = 160;
const DEFAULT_MAX_TOTAL_LINES = 320;
const OPENAI_APPLY_PATCH_SKILL_PATH_PREFIX = '@skill/';

function normalizePatchPath(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function skipJsonWhitespace(text, index, endIndex = text.length) {
  let cursor = Math.max(0, Number(index) || 0);
  while (cursor < endIndex && /\s/.test(text[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function decodeJsonEscape(sequence) {
  switch (sequence) {
    case '"':
    case '\\':
    case '/':
      return sequence;
    case 'b':
      return '\b';
    case 'f':
      return '\f';
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    default:
      return sequence;
  }
}

function readJsonStringLiteral(text, quoteIndex, options = {}) {
  const source = typeof text === 'string' ? text : '';
  const start = Math.max(0, Math.trunc(Number(quoteIndex) || 0));
  if (source[start] !== '"') return null;

  const allowUnterminated = options.allowUnterminated === true;
  let cursor = start + 1;
  let value = '';
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '"') {
      return {
        value,
        endIndex: cursor + 1,
        complete: true
      };
    }

    if (char === '\\') {
      const escapeType = source[cursor + 1];
      if (escapeType == null) {
        return allowUnterminated
          ? { value, endIndex: source.length, complete: false }
          : null;
      }
      if (escapeType === 'u') {
        const hex = source.slice(cursor + 2, cursor + 6);
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
          return allowUnterminated
            ? { value, endIndex: source.length, complete: false }
            : null;
        }
        value += String.fromCharCode(parseInt(hex, 16));
        cursor += 6;
        continue;
      }
      value += decodeJsonEscape(escapeType);
      cursor += 2;
      continue;
    }

    value += char;
    cursor += 1;
  }

  return allowUnterminated
    ? { value, endIndex: source.length, complete: false }
    : null;
}

function skipJsonValue(text, startIndex, endIndex = text.length) {
  const source = typeof text === 'string' ? text : '';
  const end = Math.min(source.length, Math.max(0, Math.trunc(Number(endIndex) || source.length)));
  let cursor = skipJsonWhitespace(source, startIndex, end);
  if (cursor >= end) return end;

  if (source[cursor] === '"') {
    const stringValue = readJsonStringLiteral(source, cursor, { allowUnterminated: true });
    return stringValue?.endIndex || end;
  }

  if (source[cursor] === '{' || source[cursor] === '[') {
    const closingStack = [source[cursor] === '{' ? '}' : ']'];
    cursor += 1;
    while (cursor < end && closingStack.length > 0) {
      const char = source[cursor];
      if (char === '"') {
        const stringValue = readJsonStringLiteral(source, cursor, { allowUnterminated: true });
        cursor = stringValue?.endIndex || end;
        if (stringValue?.complete === false) return end;
        continue;
      }
      if (char === '{') {
        closingStack.push('}');
        cursor += 1;
        continue;
      }
      if (char === '[') {
        closingStack.push(']');
        cursor += 1;
        continue;
      }
      if (char === closingStack[closingStack.length - 1]) {
        closingStack.pop();
        cursor += 1;
        continue;
      }
      cursor += 1;
    }
    return cursor;
  }

  while (cursor < end && !/[,\]}]/.test(source[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function findJsonFieldValue(text, fieldName, options = {}) {
  const source = typeof text === 'string' ? text : '';
  const targetField = typeof fieldName === 'string' ? fieldName : '';
  if (!source || !targetField) return null;

  const endIndex = Number.isFinite(Number(options.endIndex))
    ? Math.min(source.length, Math.max(0, Math.trunc(Number(options.endIndex))))
    : source.length;
  let cursor = Number.isFinite(Number(options.startIndex))
    ? Math.max(0, Math.trunc(Number(options.startIndex)))
    : 0;

  while (cursor < endIndex) {
    if (source[cursor] !== '"') {
      cursor += 1;
      continue;
    }

    const key = readJsonStringLiteral(source, cursor, { allowUnterminated: false });
    if (!key?.complete) return null;
    const colonIndex = skipJsonWhitespace(source, key.endIndex, endIndex);
    if (source[colonIndex] !== ':') {
      cursor = key.endIndex;
      continue;
    }

    const valueStart = skipJsonWhitespace(source, colonIndex + 1, endIndex);
    const valueEnd = skipJsonValue(source, valueStart, endIndex);
    if (key.value === targetField) {
      return {
        valueStart,
        valueEnd,
        complete: valueEnd < endIndex || /[\]}]/.test(source[valueEnd - 1] || '')
      };
    }

    cursor = Math.max(valueEnd, key.endIndex + 1);
  }

  return null;
}

function extractJsonStringField(text, fieldName) {
  const field = findJsonFieldValue(text, fieldName);
  if (!field || text[field.valueStart] !== '"') return undefined;
  const stringValue = readJsonStringLiteral(text, field.valueStart, { allowUnterminated: true });
  return stringValue ? stringValue.value : undefined;
}

function extractJsonObjectFieldText(text, fieldName) {
  const field = findJsonFieldValue(text, fieldName);
  if (!field || text[field.valueStart] !== '{') return '';
  return text.slice(field.valueStart, field.valueEnd || text.length);
}

function parsePartialArgumentsObject(text) {
  const partial = {};
  const action = extractJsonStringField(text, 'action');
  if (typeof action === 'string') partial.action = action;
  const skillName = extractJsonStringField(text, 'skill_name');
  if (typeof skillName === 'string') partial.skill_name = skillName;
  const patch = extractJsonStringField(text, 'patch');
  if (typeof patch === 'string') partial.patch = patch;

  const targetText = extractJsonObjectFieldText(text, 'target');
  if (targetText) {
    const target = {};
    const kind = extractJsonStringField(targetText, 'kind');
    if (typeof kind === 'string') target.kind = kind;
    const name = extractJsonStringField(targetText, 'name');
    if (typeof name === 'string') target.name = name;
    if (Object.keys(target).length > 0) {
      partial.target = target;
    }
  }

  return Object.keys(partial).length > 0 ? partial : null;
}

function parseArgumentsObject(rawArguments) {
  if (rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)) {
    return rawArguments;
  }
  const text = typeof rawArguments === 'string' ? rawArguments.trim() : '';
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch (_) {
    // Responses 的 function_call arguments 会逐片流式到达。这里不要等到完整 JSON
    // 才展示 apply_patch，而是只抽取 UI 需要的稳定字段，让 diff 能按行即时展开。
    return parsePartialArgumentsObject(text);
  }
}

function splitPatchLines(patch) {
  const text = typeof patch === 'string' ? patch.trim() : '';
  return text ? text.split(/\r?\n/) : [];
}

function truncatePreviewLines(lines, maxLines) {
  const normalized = Array.isArray(lines) ? lines : [];
  const limit = Number.isFinite(Number(maxLines)) ? Math.max(0, Math.trunc(Number(maxLines))) : DEFAULT_MAX_LINES_PER_FILE;
  if (normalized.length <= limit) {
    return {
      lines: normalized,
      truncated: false,
      omittedLineCount: 0
    };
  }
  return {
    lines: normalized.slice(0, limit),
    truncated: true,
    omittedLineCount: normalized.length - limit
  };
}

function createLine(kind, text) {
  return {
    kind,
    text: typeof text === 'string' ? text : ''
  };
}

function finalizeFilePreview(file, options = {}) {
  const normalized = file && typeof file === 'object' ? file : null;
  if (!normalized) return null;

  const perFileLimit = Number.isFinite(Number(options.maxLinesPerFile))
    ? Math.max(0, Math.trunc(Number(options.maxLinesPerFile)))
    : DEFAULT_MAX_LINES_PER_FILE;
  const totalLines = Array.isArray(normalized.lines) ? normalized.lines.length : 0;
  const lineResult = truncatePreviewLines(normalized.lines, perFileLimit);

  return {
    path: normalized.path,
    movePath: normalized.movePath || '',
    operation: normalized.operation,
    additions: normalized.additions || 0,
    deletions: normalized.deletions || 0,
    totalLines,
    lines: lineResult.lines,
    truncated: lineResult.truncated,
    omittedLineCount: lineResult.omittedLineCount
  };
}

function normalizeOpenAIApplyPatchPreviewOperation(rawOperation) {
  const operation = (rawOperation && typeof rawOperation === 'object' && !Array.isArray(rawOperation))
    ? rawOperation
    : null;
  if (!operation) return null;

  const type = String(operation.type || '').trim().toLowerCase();
  if (!['create_file', 'update_file', 'delete_file'].includes(type)) return null;

  const path = normalizePatchPath(operation.path).replace(/\\/g, '/');
  if (!path) return null;
  if (type !== 'delete_file' && typeof operation.diff !== 'string') return null;

  return {
    type,
    path,
    diff: type === 'delete_file' ? '' : operation.diff
  };
}

function resolveOpenAIApplyPatchPreviewPath(path) {
  const normalizedPath = normalizePatchPath(path).replace(/\\/g, '/');
  if (!normalizedPath.startsWith(OPENAI_APPLY_PATCH_SKILL_PATH_PREFIX)) {
    return {
      path: normalizedPath,
      skillName: ''
    };
  }

  const remainder = normalizedPath.slice(OPENAI_APPLY_PATCH_SKILL_PATH_PREFIX.length);
  const separatorIndex = remainder.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex >= remainder.length - 1) {
    return {
      path: normalizedPath,
      skillName: ''
    };
  }

  return {
    path: remainder.slice(separatorIndex + 1),
    skillName: remainder.slice(0, separatorIndex)
  };
}

function buildOpenAIApplyPatchDiffLines(operation) {
  if (operation.type === 'delete_file') {
    return {
      additions: 0,
      deletions: 0,
      lines: [createLine('meta', '已删除文件')]
    };
  }

  const lines = operation.diff.replace(/\r\n?/g, '\n').split('\n');
  let additions = 0;
  let deletions = 0;
  const previewLines = [];

  lines.forEach((line) => {
    if (operation.type === 'create_file') {
      if (line.startsWith('+')) {
        additions += 1;
        previewLines.push(createLine('add', line.slice(1)));
      } else if (line) {
        // 官方 create_file 的 V4A diff 正常只包含 `+` 行；异常片段仍以 meta
        // 显示，便于用户看清模型实际返回了什么，而不是静默隐藏整次调用。
        previewLines.push(createLine('meta', line));
      }
      return;
    }

    if (line.startsWith(HUNK_MARKER)) {
      previewLines.push(createLine('hunk', line));
      return;
    }
    if (line === EOF_MARKER) {
      previewLines.push(createLine('meta', line));
      return;
    }
    if (line.startsWith('+')) {
      additions += 1;
      previewLines.push(createLine('add', line.slice(1)));
      return;
    }
    if (line.startsWith('-')) {
      deletions += 1;
      previewLines.push(createLine('delete', line.slice(1)));
      return;
    }
    if (line.startsWith(' ')) {
      previewLines.push(createLine('context', line.slice(1)));
      return;
    }
    if (line) {
      previewLines.push(createLine('meta', line));
    }
  });

  return {
    additions,
    deletions,
    lines: previewLines
  };
}

/**
 * 把 Responses API 官方 `apply_patch_call.operation` 转成现有 diff 视图模型。
 *
 * 官方工具每个 call 只描述一个文件，并且不再携带自定义 function arguments：
 * - create_file：`diff` 是逐行 `+` 的新文件正文；
 * - update_file：`diff` 是 V4A hunk；
 * - delete_file：没有 `diff`，只展示删除元信息。
 *
 * skill 文件通过保留路径 `@skill/<skill-key>/<path>` 定位。预览层会拆掉该
 * 前缀，把 skill 名放到摘要元信息中，保持与旧 skill_registry 预览一致。
 */
export function buildOpenAIApplyPatchOperationPreview(rawOperation, options = {}) {
  const operation = normalizeOpenAIApplyPatchPreviewOperation(rawOperation);
  if (!operation) return null;

  const resolvedPath = resolveOpenAIApplyPatchPreviewPath(operation.path);
  const diffPreview = buildOpenAIApplyPatchDiffLines(operation);
  const maxLinesPerFile = Number.isFinite(Number(options.maxLinesPerFile))
    ? Math.max(0, Math.trunc(Number(options.maxLinesPerFile)))
    : DEFAULT_MAX_LINES_PER_FILE;
  const maxTotalLines = Number.isFinite(Number(options.maxTotalLines))
    ? Math.max(0, Math.trunc(Number(options.maxTotalLines)))
    : DEFAULT_MAX_TOTAL_LINES;
  const preview = finalizeFilePreview({
    path: resolvedPath.path,
    operation: operation.type === 'create_file'
      ? 'add'
      : (operation.type === 'delete_file' ? 'delete' : 'update'),
    additions: diffPreview.additions,
    deletions: diffPreview.deletions,
    lines: diffPreview.lines
  }, {
    maxLinesPerFile: Math.min(maxLinesPerFile, maxTotalLines)
  });
  if (!preview) return null;

  return {
    skillName: resolvedPath.skillName,
    totalFiles: 1,
    discoveredFileCount: 1,
    totalAdditions: diffPreview.additions,
    totalDeletions: diffPreview.deletions,
    files: [preview],
    truncatedFiles: 0,
    patchComplete: true,
    isPartial: false
  };
}

function buildApplyPatchPreview(rawArguments, options = {}) {
  const args = parseArgumentsObject(rawArguments);
  if (!args) {
    return null;
  }
  const requireAction = options.requireAction !== false;
  if (requireAction && String(args.action || '').trim() !== 'apply_patch') {
    return null;
  }

  const patch = typeof args.patch === 'string' ? args.patch : '';
  const lines = splitPatchLines(patch);
  if (lines.length < 1 || lines[0] !== BEGIN_PATCH_MARKER) {
    return null;
  }
  const hasEndPatchMarker = lines[lines.length - 1] === END_PATCH_MARKER;
  if (options.allowPartial === false && !hasEndPatchMarker) {
    return null;
  }
  const patchContentEndIndex = hasEndPatchMarker ? lines.length - 1 : lines.length;

  const maxFiles = Number.isFinite(Number(options.maxFiles))
    ? Math.max(1, Math.trunc(Number(options.maxFiles)))
    : DEFAULT_MAX_FILES;
  const maxTotalLines = Number.isFinite(Number(options.maxTotalLines))
    ? Math.max(1, Math.trunc(Number(options.maxTotalLines)))
    : DEFAULT_MAX_TOTAL_LINES;

  const filePreviews = [];
  let index = 1;
  let visibleLineBudget = maxTotalLines;
  let totalAdditions = 0;
  let totalDeletions = 0;
  let discoveredFileCount = 0;

  while (index < patchContentEndIndex && filePreviews.length < maxFiles) {
    const line = lines[index];

    if (line.startsWith(ADD_FILE_MARKER)) {
      discoveredFileCount += 1;
      const path = normalizePatchPath(line.slice(ADD_FILE_MARKER.length));
      const fileLines = [];
      let additions = 0;
      index += 1;
      while (index < patchContentEndIndex) {
        const current = lines[index];
        if (current === EOF_MARKER) {
          fileLines.push(createLine('meta', current));
          index += 1;
          continue;
        }
        if (current.startsWith('*** ')) break;
        if (current.startsWith('+')) {
          additions += 1;
          fileLines.push(createLine('add', current.slice(1)));
          index += 1;
          continue;
        }
        break;
      }
      totalAdditions += additions;
      const preview = finalizeFilePreview({
        path,
        operation: 'add',
        additions,
        deletions: 0,
        lines: fileLines
      }, { maxLinesPerFile: Math.min(visibleLineBudget, options.maxLinesPerFile ?? DEFAULT_MAX_LINES_PER_FILE) });
      if (preview) {
        visibleLineBudget = Math.max(0, visibleLineBudget - preview.lines.length);
        filePreviews.push(preview);
      }
      continue;
    }

    if (line.startsWith(DELETE_FILE_MARKER)) {
      discoveredFileCount += 1;
      const path = normalizePatchPath(line.slice(DELETE_FILE_MARKER.length));
      index += 1;
      const preview = finalizeFilePreview({
        path,
        operation: 'delete',
        additions: 0,
        deletions: 0,
        lines: [createLine('meta', '已删除文件')]
      }, { maxLinesPerFile: Math.min(visibleLineBudget, options.maxLinesPerFile ?? DEFAULT_MAX_LINES_PER_FILE) });
      if (preview) {
        visibleLineBudget = Math.max(0, visibleLineBudget - preview.lines.length);
        filePreviews.push(preview);
      }
      continue;
    }

    if (line.startsWith(UPDATE_FILE_MARKER)) {
      discoveredFileCount += 1;
      const path = normalizePatchPath(line.slice(UPDATE_FILE_MARKER.length));
      let movePath = '';
      const fileLines = [];
      let additions = 0;
      let deletions = 0;
      index += 1;

      if (index < patchContentEndIndex && lines[index].startsWith(MOVE_TO_MARKER)) {
        movePath = normalizePatchPath(lines[index].slice(MOVE_TO_MARKER.length));
        fileLines.push(createLine('meta', `移动到 ${movePath}`));
        index += 1;
      }

      while (index < patchContentEndIndex) {
        const current = lines[index];
        if (current.startsWith(HUNK_MARKER)) {
          fileLines.push(createLine('hunk', current));
          index += 1;
          continue;
        }
        if (current === EOF_MARKER) {
          fileLines.push(createLine('meta', current));
          index += 1;
          continue;
        }
        if (current.startsWith('*** ')) break;
        if (current.startsWith('+')) {
          additions += 1;
          fileLines.push(createLine('add', current.slice(1)));
          index += 1;
          continue;
        }
        if (current.startsWith('-')) {
          deletions += 1;
          fileLines.push(createLine('delete', current.slice(1)));
          index += 1;
          continue;
        }
        if (current.startsWith(' ')) {
          fileLines.push(createLine('context', current.slice(1)));
          index += 1;
          continue;
        }
        fileLines.push(createLine('meta', current));
        index += 1;
      }

      totalAdditions += additions;
      totalDeletions += deletions;
      const preview = finalizeFilePreview({
        path,
        movePath,
        operation: movePath ? 'move' : 'update',
        additions,
        deletions,
        lines: fileLines
      }, { maxLinesPerFile: Math.min(visibleLineBudget, options.maxLinesPerFile ?? DEFAULT_MAX_LINES_PER_FILE) });
      if (preview) {
        visibleLineBudget = Math.max(0, visibleLineBudget - preview.lines.length);
        filePreviews.push(preview);
      }
      continue;
    }

    index += 1;
  }

  const totalFiles = filePreviews.length;
  if (totalFiles <= 0) return null;

  return {
    skillName: typeof args.skill_name === 'string' ? args.skill_name.trim() : '',
    totalFiles,
    discoveredFileCount,
    totalAdditions,
    totalDeletions,
    files: filePreviews,
    truncatedFiles: Math.max(0, discoveredFileCount - totalFiles),
    patchComplete: hasEndPatchMarker,
    isPartial: !hasEndPatchMarker
  };
}

export function buildSkillApplyPatchPreview(rawArguments, options = {}) {
  return buildApplyPatchPreview(rawArguments, {
    ...options,
    requireAction: true
  });
}

export function buildConversationDocumentApplyPatchPreview(rawArguments, options = {}) {
  return buildApplyPatchPreview(rawArguments, {
    ...options,
    requireAction: false
  });
}

export function buildVirtualFileApplyPatchPreview(rawArguments, options = {}) {
  const parsedArgs = parseArgumentsObject(rawArguments) || {};
  const target = (parsedArgs.target && typeof parsedArgs.target === 'object' && !Array.isArray(parsedArgs.target))
    ? parsedArgs.target
    : null;
  if (String(target?.kind || '').trim().toLowerCase() === 'skill') {
    return buildApplyPatchPreview({
      action: 'apply_patch',
      skill_name: target?.name || '',
      patch: parsedArgs.patch || ''
    }, {
      ...options,
      requireAction: false
    });
  }
  return buildConversationDocumentApplyPatchPreview(rawArguments, options);
}
