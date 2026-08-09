/**
 * 通用的文本虚拟文件 patch 核心。
 *
 * 设计目标：
 * - 保留 Codex `apply_patch` 原始语法，不引入 Cerebr 私有扩展；
 * - 让不同“虚拟文件空间”（如 skill、对话文档）复用同一套解析/匹配/替换逻辑；
 * - 只负责纯文本 patch 本身，不关心更上层的 manifest、文件 kind、会话归属等业务语义。
 */

const BEGIN_PATCH_MARKER = '*** Begin Patch';
const END_PATCH_MARKER = '*** End Patch';
const ADD_FILE_MARKER = '*** Add File: ';
const DELETE_FILE_MARKER = '*** Delete File: ';
const UPDATE_FILE_MARKER = '*** Update File: ';
const MOVE_TO_MARKER = '*** Move to: ';
const CHANGE_CONTEXT_MARKER = '@@ ';
const EMPTY_CHANGE_CONTEXT_MARKER = '@@';
const EOF_MARKER = '*** End of File';
const ENVIRONMENT_ID_MARKER = '*** Environment ID:';

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

function cloneHunks(hunks) {
  return hunks.map((hunk) => ({
    ...hunk,
    ...(Array.isArray(hunk.chunks)
      ? {
        chunks: hunk.chunks.map((chunk) => ({
          ...chunk,
          old_lines: [...chunk.old_lines],
          new_lines: [...chunk.new_lines]
        }))
      }
      : {})
  }));
}

function clonePreviewFiles(files) {
  return files.map((file) => ({
    ...file,
    lines: file.lines.map((line) => ({ ...line }))
  }));
}

/**
 * Codex `StreamingPatchParser` 的 JavaScript 对齐实现。
 *
 * 同步基准：openai-codex `a16863f8704831d13e041ed7dba2c4a57a2a940b`。
 * 解析器是执行 AST 与流式预览的唯一语法来源：只有被状态机接受的完整行才会
 * 进入 previewFiles，非法完整行会携带精确行号抛错，UI 不再自行猜测 patch。
 */
export class StreamingApplyPatchParser {
  constructor() {
    this.lineBuffer = '';
    this.mode = 'not_started';
    this.hunkLineNumber = 0;
    this.hunks = [];
    this.previewFiles = [];
    this.environmentId = null;
    this.lineNumber = 0;
    this.finished = false;
  }

  get environment_id() {
    return this.environmentId;
  }

  getHunks() {
    return cloneHunks(this.hunks);
  }

  getSnapshot(options = {}) {
    return {
      hunks: this.getHunks(),
      environment_id: this.environmentId,
      files: clonePreviewFiles(this.previewFiles),
      line_number: this.lineNumber,
      pending_line: this.lineBuffer,
      complete: this.mode === 'ended_patch',
      finished: options.finished === true || this.finished === true
    };
  }

  getCurrentPreviewFile() {
    return this.previewFiles[this.previewFiles.length - 1] || null;
  }

  appendPreviewLine(type, content, raw) {
    const file = this.getCurrentPreviewFile();
    if (!file) return;
    file.lines.push({
      type,
      content,
      raw,
      line_number: this.lineNumber,
      sequence: file.lines.length
    });
  }

  ensureUpdateHunkIsNotEmpty(line) {
    const lastHunk = this.hunks[this.hunks.length - 1];
    if (!lastHunk || lastHunk.type !== 'update_file') return;
    if (lastHunk.chunks.length === 0 && this.mode === 'update_file') {
      throw createInvalidHunkError(
        `Update file hunk for path '${lastHunk.path}' is empty`,
        this.hunkLineNumber
      );
    }
    const lastChunk = lastHunk.chunks[lastHunk.chunks.length - 1];
    if (lastChunk && lastChunk.old_lines.length === 0 && lastChunk.new_lines.length === 0) {
      if (line === END_PATCH_MARKER) {
        throw createInvalidHunkError('Update hunk does not contain any lines', this.lineNumber);
      }
      throw createInvalidHunkError(
        `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
        this.lineNumber
      );
    }
  }

  handleHunkHeadersAndEndPatch(trimmed) {
    if (this.mode === 'started_patch' && trimmed.startsWith(ENVIRONMENT_ID_MARKER)) {
      if (this.environmentId !== null) {
        throw createInvalidPatchError('apply_patch environment_id cannot be specified more than once');
      }
      const environmentId = trimmed.slice(ENVIRONMENT_ID_MARKER.length).trim();
      if (!environmentId) {
        throw createInvalidPatchError('apply_patch environment_id cannot be empty');
      }
      this.environmentId = environmentId;
      return true;
    }
    if (trimmed === END_PATCH_MARKER) {
      this.ensureUpdateHunkIsNotEmpty(trimmed);
      this.mode = 'ended_patch';
      return true;
    }
    if (trimmed.startsWith(ADD_FILE_MARKER)) {
      this.ensureUpdateHunkIsNotEmpty(trimmed);
      const path = trimmed.slice(ADD_FILE_MARKER.length);
      this.hunks.push({ type: 'add_file', path, contents: '' });
      this.previewFiles.push({ operation: 'add', path, moveTo: '', lines: [] });
      this.mode = 'add_file';
      return true;
    }
    if (trimmed.startsWith(DELETE_FILE_MARKER)) {
      this.ensureUpdateHunkIsNotEmpty(trimmed);
      const path = trimmed.slice(DELETE_FILE_MARKER.length);
      this.hunks.push({ type: 'delete_file', path });
      this.previewFiles.push({ operation: 'delete', path, moveTo: '', lines: [] });
      this.mode = 'delete_file';
      return true;
    }
    if (trimmed.startsWith(UPDATE_FILE_MARKER)) {
      this.ensureUpdateHunkIsNotEmpty(trimmed);
      const path = trimmed.slice(UPDATE_FILE_MARKER.length);
      this.hunks.push({ type: 'update_file', path, move_path: null, chunks: [] });
      this.previewFiles.push({ operation: 'update', path, moveTo: '', lines: [] });
      this.mode = 'update_file';
      this.hunkLineNumber = this.lineNumber;
      return true;
    }
    return false;
  }

  pushDelta(delta) {
    if (this.finished) {
      throw createInvalidPatchError('StreamingApplyPatchParser.finish() has already been called');
    }
    for (const character of String(delta || '')) {
      if (character !== '\n') {
        this.lineBuffer += character;
        continue;
      }
      let line = this.lineBuffer;
      this.lineBuffer = '';
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.lineNumber += 1;
      this.processLine(line);
    }
    return this.getHunks();
  }

  finish() {
    if (this.finished) return this.getHunks();
    if (this.lineBuffer !== '') {
      const line = this.lineBuffer;
      this.lineBuffer = '';
      this.lineNumber += 1;
      if (line.trim() === END_PATCH_MARKER) {
        this.ensureUpdateHunkIsNotEmpty(line.trim());
        this.mode = 'ended_patch';
      } else {
        this.processLine(line);
      }
    }
    if (this.mode !== 'ended_patch') {
      throw createInvalidPatchError("The last line of the patch must be '*** End Patch'");
    }
    this.finished = true;
    return this.getHunks();
  }

  processLine(line) {
    const trimmed = line.trim();
    if (this.mode === 'not_started') {
      if (trimmed === BEGIN_PATCH_MARKER) {
        this.mode = 'started_patch';
        return;
      }
      throw createInvalidPatchError("The first line of the patch must be '*** Begin Patch'");
    }

    if (this.mode === 'started_patch') {
      if (this.handleHunkHeadersAndEndPatch(trimmed)) return;
      throw createInvalidHunkError(
        `'${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
        this.lineNumber
      );
    }

    if (this.mode === 'add_file') {
      if (this.handleHunkHeadersAndEndPatch(trimmed)) return;
      if (line.startsWith('+')) {
        const content = line.slice(1);
        this.hunks[this.hunks.length - 1].contents += `${content}\n`;
        this.appendPreviewLine('add', content, line);
        return;
      }
      throw createInvalidHunkError(
        `'${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
        this.lineNumber
      );
    }

    if (this.mode === 'delete_file') {
      if (this.handleHunkHeadersAndEndPatch(trimmed)) return;
      throw createInvalidHunkError(
        `'${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
        this.lineNumber
      );
    }

    if (this.mode === 'ended_patch') {
      if (!trimmed) return;
      throw createInvalidPatchError("The last line of the patch must be '*** End Patch'");
    }

    const updateLine = line.trimEnd();
    if (this.handleHunkHeadersAndEndPatch(updateLine)) return;
    const hunk = this.hunks[this.hunks.length - 1];
    const chunks = hunk.chunks;
    const lastChunk = () => chunks[chunks.length - 1] || null;

    if (lastChunk()?.is_end_of_file) {
      if (!updateLine) return;
      if (updateLine !== EMPTY_CHANGE_CONTEXT_MARKER && !updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
        throw createInvalidHunkError(
          `Expected update hunk to start with a @@ context marker, got: '${line}'`,
          this.lineNumber
        );
      }
    }

    if (chunks.length === 0 && !hunk.move_path && updateLine.startsWith(MOVE_TO_MARKER)) {
      hunk.move_path = updateLine.slice(MOVE_TO_MARKER.length);
      this.getCurrentPreviewFile().moveTo = hunk.move_path;
      this.getCurrentPreviewFile().operation = 'move';
      this.appendPreviewLine('move', hunk.move_path, line);
      return;
    }

    if (
      (updateLine === EMPTY_CHANGE_CONTEXT_MARKER || updateLine.startsWith(CHANGE_CONTEXT_MARKER))
      && lastChunk()
      && lastChunk().old_lines.length === 0
      && lastChunk().new_lines.length === 0
    ) {
      throw createInvalidHunkError(
        `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
        this.lineNumber
      );
    }

    if (updateLine === EMPTY_CHANGE_CONTEXT_MARKER || updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
      const changeContext = updateLine === EMPTY_CHANGE_CONTEXT_MARKER
        ? null
        : updateLine.slice(CHANGE_CONTEXT_MARKER.length);
      chunks.push({
        change_context: changeContext,
        old_lines: [],
        new_lines: [],
        is_end_of_file: false
      });
      this.appendPreviewLine('hunk', changeContext || '', line);
      return;
    }

    if (updateLine === EOF_MARKER) {
      if (lastChunk() && lastChunk().old_lines.length === 0 && lastChunk().new_lines.length === 0) {
        throw createInvalidHunkError('Update hunk does not contain any lines', this.lineNumber);
      }
      if (lastChunk()) lastChunk().is_end_of_file = true;
      this.appendPreviewLine('eof', '', line);
      return;
    }

    if (line === '') {
      if (chunks.length === 0) {
        chunks.push({ change_context: null, old_lines: [], new_lines: [], is_end_of_file: false });
      }
      lastChunk().old_lines.push('');
      lastChunk().new_lines.push('');
      this.appendPreviewLine('context', '', line);
      return;
    }

    const prefix = line.charAt(0);
    if (prefix === ' ' || prefix === '+' || prefix === '-') {
      if (chunks.length === 0) {
        chunks.push({ change_context: null, old_lines: [], new_lines: [], is_end_of_file: false });
      }
      const content = line.slice(1);
      if (prefix === ' ') {
        lastChunk().old_lines.push(content);
        lastChunk().new_lines.push(content);
        this.appendPreviewLine('context', content, line);
      } else if (prefix === '+') {
        lastChunk().new_lines.push(content);
        this.appendPreviewLine('add', content, line);
      } else {
        lastChunk().old_lines.push(content);
        this.appendPreviewLine('delete', content, line);
      }
      return;
    }

    if (lastChunk() && (lastChunk().old_lines.length > 0 || lastChunk().new_lines.length > 0)) {
      throw createInvalidHunkError(
        `Expected update hunk to start with a @@ context marker, got: '${line}'`,
        this.lineNumber
      );
    }
    throw createInvalidHunkError(
      `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
      this.lineNumber
    );
  }
}

/**
 * 为流式 UI 构建 parser 快照。错误会保留已经验证的前缀，并以结构化字段返回；
 * 执行路径则直接使用 `parseApplyPatch`，因此无法绕过同一状态机的拒绝结果。
 */
export function parseApplyPatchProgress(patch, options = {}) {
  const parser = new StreamingApplyPatchParser();
  let error = null;
  try {
    parser.pushDelta(String(patch || ''));
    if (options.finish === true) parser.finish();
  } catch (caught) {
    error = caught;
  }
  return {
    patch: String(patch || ''),
    ...parser.getSnapshot({ finished: options.finish === true && !error }),
    error: error
      ? {
        name: error.name || 'Error',
        message: error.message || String(error),
        line_number: Number.isFinite(Number(error.line_number))
          ? Number(error.line_number)
          : parser.lineNumber
      }
      : null
  };
}

export function parseApplyPatch(patch, options = {}) {
  if (options?.mode && options.mode !== 'strict') {
    throw createInvalidPatchError(`Unsupported apply_patch parser mode: ${options.mode}`);
  }
  const parser = new StreamingApplyPatchParser();
  parser.pushDelta(String(patch || ''));
  const hunks = parser.finish();
  return {
    patch: String(patch || ''),
    environment_id: parser.environment_id,
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

export function derivePatchedFileContent(originalContent, path, chunks) {
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
