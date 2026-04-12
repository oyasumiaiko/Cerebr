/**
 * 将 Codex `apply_patch` 的核心解析与文本替换逻辑移植到微型 skill 的虚拟文件模型中。
 *
 * 这里刻意保留 Codex 原始补丁格式：
 * - `*** Begin Patch` / `*** End Patch`
 * - `*** Add File:` / `*** Delete File:` / `*** Update File:`
 * - `*** Move to:`
 * - `@@` 更新块与 `+` / `-` / ` ` 行前缀
 *
 * 在 Cerebr 里，文件用途不再靠额外枚举驱动，而是靠：
 * - manifest 指针：`instruction.path`、`runtime.entry_path`
 * - 路径约定：例如 `src/`、`templates/`、`references/`
 *
 * 因此这里不再额外引入 `File Kind` 之类的扩展指令，尽量让模型直接复用
 * Codex 原生 patch 心智模型。
 */

import {
  buildStoredMicroSkillRecord,
  MICRO_SKILL_VIRTUAL_MANIFEST_PATH,
  normalizeMicroSkillFilePath,
  parseMicroSkillVirtualManifestContent,
  normalizeStoredMicroSkillRecord,
  pickDefaultMicroSkillInstructionPath,
  pickDefaultMicroSkillRuntimeEntryPath,
  serializeMicroSkillVirtualManifest
} from './micro_skill_registry_tool.js';

const BEGIN_PATCH_MARKER = '*** Begin Patch';
const END_PATCH_MARKER = '*** End Patch';
const ADD_FILE_MARKER = '*** Add File: ';
const DELETE_FILE_MARKER = '*** Delete File: ';
const UPDATE_FILE_MARKER = '*** Update File: ';
const MOVE_TO_MARKER = '*** Move to: ';
const CHANGE_CONTEXT_MARKER = '@@ ';
const EMPTY_CHANGE_CONTEXT_MARKER = '@@';
const EOF_MARKER = '*** End of File';

function createInvalidPatchError(message) {
  const error = new Error(message);
  error.name = 'InvalidPatchError';
  return error;
}

function createInvalidHunkError(message, lineNumber) {
  const error = new Error(message);
  error.name = 'InvalidHunkError';
  error.line_number = lineNumber;
  return error;
}

function splitPatchLines(patch) {
  const trimmed = String(patch || '').trim();
  return trimmed ? trimmed.split(/\r?\n/) : [];
}

function checkStartAndEndLinesStrict(firstLine, lastLine) {
  const normalizedFirst = typeof firstLine === 'string' ? firstLine.trim() : null;
  const normalizedLast = typeof lastLine === 'string' ? lastLine.trim() : null;

  if (normalizedFirst === BEGIN_PATCH_MARKER && normalizedLast === END_PATCH_MARKER) {
    return;
  }
  if (normalizedFirst !== BEGIN_PATCH_MARKER) {
    throw createInvalidPatchError("The first line of the patch must be '*** Begin Patch'");
  }
  throw createInvalidPatchError("The last line of the patch must be '*** End Patch'");
}

function checkPatchBoundariesStrict(lines) {
  if (!Array.isArray(lines) || lines.length <= 0) {
    checkStartAndEndLinesStrict(null, null);
    return;
  }
  checkStartAndEndLinesStrict(lines[0], lines[lines.length - 1]);
}

function checkPatchBoundariesLenient(lines, originalError) {
  if (!Array.isArray(lines) || lines.length < 4) {
    throw originalError;
  }
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (
    (first === '<<EOF' || first === "<<'EOF'" || first === '<<"EOF"')
    && last.endsWith('EOF')
  ) {
    const innerLines = lines.slice(1, -1);
    checkPatchBoundariesStrict(innerLines);
    return innerLines;
  }
  throw originalError;
}

function parseUpdateFileChunk(lines, lineNumber, allowMissingContext) {
  if (!Array.isArray(lines) || lines.length <= 0) {
    throw createInvalidHunkError('Update hunk does not contain any lines', lineNumber);
  }

  let changeContext = null;
  let startIndex = 0;
  if (lines[0] === EMPTY_CHANGE_CONTEXT_MARKER) {
    startIndex = 1;
  } else if (typeof lines[0] === 'string' && lines[0].startsWith(CHANGE_CONTEXT_MARKER)) {
    changeContext = lines[0].slice(CHANGE_CONTEXT_MARKER.length);
    startIndex = 1;
  } else if (!allowMissingContext) {
    throw createInvalidHunkError(
      `Expected update hunk to start with a @@ context marker, got: '${lines[0]}'`,
      lineNumber
    );
  }

  if (startIndex >= lines.length) {
    throw createInvalidHunkError('Update hunk does not contain any lines', lineNumber + 1);
  }

  const chunk = {
    change_context: changeContext,
    old_lines: [],
    new_lines: [],
    is_end_of_file: false
  };
  let parsedLines = 0;

  for (const lineContents of lines.slice(startIndex)) {
    if (lineContents === EOF_MARKER) {
      if (parsedLines === 0) {
        throw createInvalidHunkError('Update hunk does not contain any lines', lineNumber + 1);
      }
      chunk.is_end_of_file = true;
      parsedLines += 1;
      break;
    }

    const firstChar = typeof lineContents === 'string' ? lineContents.charAt(0) : '';
    if (!lineContents) {
      chunk.old_lines.push('');
      chunk.new_lines.push('');
      parsedLines += 1;
      continue;
    }
    if (firstChar === ' ') {
      chunk.old_lines.push(lineContents.slice(1));
      chunk.new_lines.push(lineContents.slice(1));
      parsedLines += 1;
      continue;
    }
    if (firstChar === '+') {
      chunk.new_lines.push(lineContents.slice(1));
      parsedLines += 1;
      continue;
    }
    if (firstChar === '-') {
      chunk.old_lines.push(lineContents.slice(1));
      parsedLines += 1;
      continue;
    }
    if (parsedLines === 0) {
      throw createInvalidHunkError(
        `Unexpected line found in update hunk: '${lineContents}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
        lineNumber + 1
      );
    }
    break;
  }

  return {
    chunk,
    parsed_lines: parsedLines + startIndex
  };
}

function parseOneHunk(lines, lineNumber) {
  const firstLine = String(lines[0] || '').trim();
  if (firstLine.startsWith(ADD_FILE_MARKER)) {
    const path = firstLine.slice(ADD_FILE_MARKER.length);
    let parsedLines = 1;
    let contents = '';
    for (const addLine of lines.slice(parsedLines)) {
      if (typeof addLine === 'string' && addLine.startsWith('+')) {
        contents += `${addLine.slice(1)}\n`;
        parsedLines += 1;
        continue;
      }
      break;
    }
    return {
      hunk: {
        type: 'add_file',
        path,
        contents
      },
      parsed_lines: parsedLines
    };
  }

  if (firstLine.startsWith(DELETE_FILE_MARKER)) {
    return {
      hunk: {
        type: 'delete_file',
        path: firstLine.slice(DELETE_FILE_MARKER.length)
      },
      parsed_lines: 1
    };
  }

  if (firstLine.startsWith(UPDATE_FILE_MARKER)) {
    const path = firstLine.slice(UPDATE_FILE_MARKER.length);
    let remainingLines = lines.slice(1);
    let parsedLines = 1;
    let movePath = null;

    if (remainingLines[0] && String(remainingLines[0]).trim().startsWith(MOVE_TO_MARKER)) {
      movePath = String(remainingLines[0]).trim().slice(MOVE_TO_MARKER.length);
      remainingLines = remainingLines.slice(1);
      parsedLines += 1;
    }

    const chunks = [];
    while (remainingLines.length > 0) {
      if (!String(remainingLines[0] || '').trim()) {
        remainingLines = remainingLines.slice(1);
        parsedLines += 1;
        continue;
      }
      if (String(remainingLines[0]).startsWith('***')) {
        break;
      }

      const { chunk, parsed_lines: chunkLines } = parseUpdateFileChunk(
        remainingLines,
        lineNumber + parsedLines,
        chunks.length === 0
      );
      chunks.push(chunk);
      remainingLines = remainingLines.slice(chunkLines);
      parsedLines += chunkLines;
    }

    if (chunks.length <= 0) {
      throw createInvalidHunkError(`Update file hunk for path '${path}' is empty`, lineNumber);
    }

    return {
      hunk: {
        type: 'update_file',
        path,
        move_path: movePath,
        chunks
      },
      parsed_lines: parsedLines
    };
  }

  throw createInvalidHunkError(
    `'${firstLine}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
    lineNumber
  );
}

export function parseMicroSkillApplyPatch(patch, options = {}) {
  const mode = options?.mode === 'lenient' ? 'lenient' : 'strict';
  const rawLines = splitPatchLines(patch);
  let lines = rawLines;

  try {
    checkPatchBoundariesStrict(rawLines);
  } catch (error) {
    if (mode !== 'lenient') throw error;
    lines = checkPatchBoundariesLenient(rawLines, error);
  }

  const hunks = [];
  const lastLineIndex = Math.max(lines.length - 1, 1);
  let remainingLines = lines.slice(1, lastLineIndex);
  let lineNumber = 2;
  while (remainingLines.length > 0) {
    const { hunk, parsed_lines: hunkLines } = parseOneHunk(remainingLines, lineNumber);
    hunks.push(hunk);
    remainingLines = remainingLines.slice(hunkLines);
    lineNumber += hunkLines;
  }

  return {
    patch: lines.join('\n'),
    hunks
  };
}

export function seekSequence(lines, pattern, start, eof) {
  if (!Array.isArray(pattern) || pattern.length <= 0) {
    return start;
  }
  if (!Array.isArray(lines) || pattern.length > lines.length) {
    return null;
  }

  const searchStart = (eof && lines.length >= pattern.length)
    ? (lines.length - pattern.length)
    : start;
  const maxStart = lines.length - pattern.length;

  for (let index = searchStart; index <= maxStart; index += 1) {
    let ok = true;
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (lines[index + offset] !== pattern[offset]) {
        ok = false;
        break;
      }
    }
    if (ok) return index;
  }

  for (let index = searchStart; index <= maxStart; index += 1) {
    let ok = true;
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (String(lines[index + offset]).trimEnd() !== String(pattern[offset]).trimEnd()) {
        ok = false;
        break;
      }
    }
    if (ok) return index;
  }

  for (let index = searchStart; index <= maxStart; index += 1) {
    let ok = true;
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (String(lines[index + offset]).trim() !== String(pattern[offset]).trim()) {
        ok = false;
        break;
      }
    }
    if (ok) return index;
  }

  const normalizeLoose = (value) => String(value || '')
    .trim()
    .split('')
    .map((char) => {
      switch (char) {
        case '\u2010':
        case '\u2011':
        case '\u2012':
        case '\u2013':
        case '\u2014':
        case '\u2015':
        case '\u2212':
          return '-';
        case '\u2018':
        case '\u2019':
        case '\u201A':
        case '\u201B':
          return '\'';
        case '\u201C':
        case '\u201D':
        case '\u201E':
        case '\u201F':
          return '"';
        case '\u00A0':
        case '\u2002':
        case '\u2003':
        case '\u2004':
        case '\u2005':
        case '\u2006':
        case '\u2007':
        case '\u2008':
        case '\u2009':
        case '\u200A':
        case '\u202F':
        case '\u205F':
        case '\u3000':
          return ' ';
        default:
          return char;
      }
    })
    .join('');

  for (let index = searchStart; index <= maxStart; index += 1) {
    let ok = true;
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (normalizeLoose(lines[index + offset]) !== normalizeLoose(pattern[offset])) {
        ok = false;
        break;
      }
    }
    if (ok) return index;
  }

  return null;
}

function computeReplacements(originalLines, path, chunks) {
  const replacements = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.change_context) {
      const matchedIndex = seekSequence(
        originalLines,
        [chunk.change_context],
        lineIndex,
        false
      );
      if (matchedIndex === null) {
        throw new Error(`Failed to find context '${chunk.change_context}' in ${path}`);
      }
      lineIndex = matchedIndex + 1;
    }

    if (chunk.old_lines.length <= 0) {
      const insertionIndex = originalLines[originalLines.length - 1] === ''
        ? originalLines.length - 1
        : originalLines.length;
      replacements.push([insertionIndex, 0, [...chunk.new_lines]]);
      continue;
    }

    let pattern = chunk.old_lines;
    let newSlice = chunk.new_lines;
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file);

    if (found === null && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1);
      if (newSlice[newSlice.length - 1] === '') {
        newSlice = newSlice.slice(0, -1);
      }
      found = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file);
    }

    if (found === null) {
      throw new Error(`Failed to find expected lines in ${path}:\n${chunk.old_lines.join('\n')}`);
    }

    replacements.push([found, pattern.length, [...newSlice]]);
    lineIndex = found + pattern.length;
  }

  replacements.sort((left, right) => left[0] - right[0]);
  return replacements;
}

function applyReplacements(lines, replacements) {
  const nextLines = [...lines];
  [...replacements].reverse().forEach(([startIndex, oldLen, newSegment]) => {
    nextLines.splice(startIndex, oldLen, ...newSegment);
  });
  return nextLines;
}

function derivePatchedFileContent(originalContent, path, chunks) {
  const originalLines = String(originalContent || '').split('\n');
  if (originalLines[originalLines.length - 1] === '') {
    originalLines.pop();
  }
  const replacements = computeReplacements(originalLines, path, chunks);
  const nextLines = applyReplacements(originalLines, replacements);
  if (nextLines[nextLines.length - 1] !== '') {
    nextLines.push('');
  }
  return nextLines.join('\n');
}

function cloneFiles(files) {
  return (Array.isArray(files) ? files : []).map((file) => ({ ...file }));
}

function findFileIndex(files, filePath) {
  return files.findIndex((file) => file.path === filePath);
}

function upsertFilePreservingOrder(files, file, existingIndex = null) {
  const resolvedIndex = Number.isInteger(existingIndex) ? existingIndex : findFileIndex(files, file.path);
  if (resolvedIndex >= 0) {
    files[resolvedIndex] = file;
  } else {
    files.push(file);
  }
}

export function applyMicroSkillPackagePatch(record, patch) {
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) {
    throw new Error('Cannot apply patch to an invalid micro skill record.');
  }

  const { hunks } = parseMicroSkillApplyPatch(patch, { mode: 'strict' });
  if (hunks.length <= 0) {
    throw new Error('No files were modified.');
  }

  const nextFiles = cloneFiles(skill.files);
  let instructionPath = skill.instruction.path;
  let runtimeEntryPath = skill.runtime.entry_path;
  let manifestInput = null;
  let manifestContent = serializeMicroSkillVirtualManifest(skill);
  const affectedFiles = {
    added: [],
    modified: [],
    deleted: []
  };

  for (const hunk of hunks) {
    const normalizedHunkPath = normalizeMicroSkillFilePath(hunk.path);
    const isManifestHunk = normalizedHunkPath === MICRO_SKILL_VIRTUAL_MANIFEST_PATH;

    if (isManifestHunk && hunk.type === 'add_file') {
      throw new Error('manifest.json 是保留虚拟文件，不支持 Add File。');
    }
    if (isManifestHunk && hunk.type === 'delete_file') {
      throw new Error('manifest.json 是保留虚拟文件，不支持 Delete File。');
    }

    if (hunk.type === 'add_file') {
      const normalizedPath = normalizedHunkPath;
      const existingIndex = findFileIndex(nextFiles, normalizedPath);
      const existingFile = existingIndex >= 0 ? nextFiles[existingIndex] : null;
      upsertFilePreservingOrder(nextFiles, {
        path: normalizedPath,
        kind: existingFile?.kind || null,
        content: hunk.contents
      }, existingIndex);
      if (existingFile) {
        affectedFiles.modified.push(normalizedPath);
      } else {
        affectedFiles.added.push(normalizedPath);
      }
      continue;
    }

    if (hunk.type === 'delete_file') {
      const normalizedPath = normalizedHunkPath;
      const existingIndex = findFileIndex(nextFiles, normalizedPath);
      if (existingIndex < 0) {
        throw new Error(`Failed to delete file ${normalizedPath}`);
      }
      nextFiles.splice(existingIndex, 1);
      if (instructionPath === normalizedPath) instructionPath = null;
      if (runtimeEntryPath === normalizedPath) runtimeEntryPath = null;
      affectedFiles.deleted.push(normalizedPath);
      continue;
    }

    if (hunk.type === 'update_file') {
      const sourcePath = normalizedHunkPath;
      if (sourcePath === MICRO_SKILL_VIRTUAL_MANIFEST_PATH) {
        if (hunk.move_path) {
          throw new Error('manifest.json 是保留虚拟文件，不支持 Move to。');
        }
        manifestContent = derivePatchedFileContent(manifestContent, sourcePath, hunk.chunks);
        manifestInput = parseMicroSkillVirtualManifestContent(manifestContent, skill);
        if (manifestInput?.instruction?.path) {
          instructionPath = manifestInput.instruction.path;
        }
        if (Object.prototype.hasOwnProperty.call(manifestInput?.runtime || {}, 'entry_path')) {
          runtimeEntryPath = manifestInput.runtime.entry_path;
        }
        affectedFiles.modified.push(sourcePath);
        continue;
      }
      const sourceIndex = findFileIndex(nextFiles, sourcePath);
      if (sourceIndex < 0) {
        throw new Error(`Failed to read file to update ${sourcePath}`);
      }

      const sourceFile = nextFiles[sourceIndex];
      const nextContent = derivePatchedFileContent(sourceFile.content, sourcePath, hunk.chunks);
      const targetPath = hunk.move_path ? normalizeMicroSkillFilePath(hunk.move_path) : sourcePath;

      if (targetPath === sourcePath) {
        nextFiles[sourceIndex] = {
          path: sourcePath,
          kind: sourceFile.kind,
          content: nextContent
        };
      } else {
        const targetIndex = findFileIndex(nextFiles, targetPath);
        if (targetIndex >= 0 && targetIndex !== sourceIndex) {
          nextFiles[targetIndex] = {
            path: targetPath,
            kind: sourceFile.kind,
            content: nextContent
          };
          nextFiles.splice(sourceIndex, 1);
        } else {
          nextFiles[sourceIndex] = {
            path: targetPath,
            kind: sourceFile.kind,
            content: nextContent
          };
        }
        if (instructionPath === sourcePath) instructionPath = targetPath;
        if (runtimeEntryPath === sourcePath) runtimeEntryPath = targetPath;
      }
      affectedFiles.modified.push(targetPath);
      continue;
    }
  }

  if (instructionPath && findFileIndex(nextFiles, instructionPath) < 0) {
    instructionPath = pickDefaultMicroSkillInstructionPath(nextFiles);
  }
  if (runtimeEntryPath && findFileIndex(nextFiles, runtimeEntryPath) < 0) {
    runtimeEntryPath = pickDefaultMicroSkillRuntimeEntryPath(nextFiles);
  }

  const nextRecord = buildStoredMicroSkillRecord({
    ...skill,
    ...(manifestInput || {}),
    instruction: {
      path: manifestInput?.instruction?.path ?? instructionPath
    },
    runtime: {
      entry_path: Object.prototype.hasOwnProperty.call(manifestInput?.runtime || {}, 'entry_path')
        ? manifestInput.runtime.entry_path
        : runtimeEntryPath
    },
    files: nextFiles
  }, skill);

  return {
    patch: String(patch || ''),
    hunks,
    affected_files: {
      added: Array.from(new Set(affectedFiles.added)),
      modified: Array.from(new Set(affectedFiles.modified)),
      deleted: Array.from(new Set(affectedFiles.deleted))
    },
    record: nextRecord
  };
}
