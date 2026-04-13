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

function normalizePatchPath(value) {
  return typeof value === 'string' ? value.trim() : '';
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
    return null;
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
  if (lines.length < 2 || lines[0] !== BEGIN_PATCH_MARKER || lines[lines.length - 1] !== END_PATCH_MARKER) {
    return null;
  }

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

  while (index < lines.length - 1 && filePreviews.length < maxFiles) {
    const line = lines[index];

    if (line.startsWith(ADD_FILE_MARKER)) {
      discoveredFileCount += 1;
      const path = normalizePatchPath(line.slice(ADD_FILE_MARKER.length));
      const fileLines = [];
      let additions = 0;
      index += 1;
      while (index < lines.length - 1) {
        const current = lines[index];
        if (current.startsWith('*** ')) break;
        if (current === EOF_MARKER) {
          fileLines.push(createLine('meta', current));
          index += 1;
          continue;
        }
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

      if (index < lines.length - 1 && lines[index].startsWith(MOVE_TO_MARKER)) {
        movePath = normalizePatchPath(lines[index].slice(MOVE_TO_MARKER.length));
        fileLines.push(createLine('meta', `移动到 ${movePath}`));
        index += 1;
      }

      while (index < lines.length - 1) {
        const current = lines[index];
        if (current.startsWith('*** ')) break;
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
    truncatedFiles: Math.max(0, discoveredFileCount - totalFiles)
  };
}

export function buildMicroSkillApplyPatchPreview(rawArguments, options = {}) {
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
  let args = rawArguments;
  if (typeof rawArguments === 'string') {
    try {
      args = JSON.parse(rawArguments);
    } catch (_) {
      args = null;
    }
  }
  const parsedArgs = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
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
