/**
 * 通用的文本虚拟文件 patch 核心。
 *
 * 设计目标：
 * - 保留 Codex `apply_patch` 原始语法，不引入 Cerebr 私有 hunk；
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

export const APPLY_PATCH_PARSE_MODE_STRICT = 'strict';
export const APPLY_PATCH_PARSE_MODE_LENIENT = 'lenient';
export const APPLY_PATCH_FILE_UPDATE_MODE_NORMALIZE_TO_LF = 'normalize_to_lf';
export const APPLY_PATCH_FILE_UPDATE_MODE_PRESERVE_LINE_ENDINGS = 'preserve_line_endings';

const RUST_WHITESPACE_START = /^\p{White_Space}+/u;
const RUST_WHITESPACE_END = /\p{White_Space}+$/u;

function trimRustWhitespace(value) {
  return String(value ?? '')
    .replace(RUST_WHITESPACE_START, '')
    .replace(RUST_WHITESPACE_END, '');
}

function trimEndRustWhitespace(value) {
  return String(value ?? '').replace(RUST_WHITESPACE_END, '');
}

function createInvalidPatchError(message) {
  const error = new Error(message);
  error.name = 'InvalidPatchError';
  error.code = 'APPLY_PATCH_INVALID_PATCH';
  error.stage = 'parse';
  error.state_changed = false;
  return error;
}

function createInvalidHunkError(message, lineNumber) {
  const error = new Error(message);
  error.name = 'InvalidHunkError';
  error.code = 'APPLY_PATCH_INVALID_HUNK';
  error.stage = 'parse';
  error.state_changed = false;
  error.line_number = lineNumber;
  return error;
}

/**
 * 生成 Codex `FunctionCallError::RespondToModel` 同款的 model-visible 文本。
 * 错误对象本身保留结构化诊断字段，wire output 则只使用这段直接文本。
 */
export function formatApplyPatchVerificationError(error) {
  const message = typeof error?.message === 'string' && error.message.length > 0
    ? error.message
    : String(error || 'unknown apply_patch error');
  if (message.startsWith('apply_patch verification failed:')) {
    return message;
  }
  if (error?.name === 'InvalidHunkError') {
    const lineNumber = Number.isFinite(Number(error?.line_number))
      ? Math.max(1, Math.trunc(Number(error.line_number)))
      : 1;
    return `apply_patch verification failed: invalid hunk at line ${lineNumber}, ${message}`;
  }
  if (error?.name === 'InvalidPatchError') {
    return `apply_patch verification failed: invalid patch: ${message}`;
  }
  return `apply_patch verification failed: ${message}`;
}

/**
 * 在不丢失原始错误类型的前提下，复制出稳定的 apply_patch 诊断对象。
 */
export function normalizeApplyPatchVerificationError(error, metadata = {}) {
  const source = error instanceof Error ? error : new Error(String(error || 'unknown apply_patch error'));
  const normalized = new Error(source.message);
  normalized.name = source.name || 'ApplyPatchVerificationError';
  normalized.code = typeof source.code === 'string' && source.code.trim()
    ? source.code.trim()
    : 'APPLY_PATCH_VERIFICATION_FAILED';
  normalized.stage = typeof metadata.stage === 'string' && metadata.stage.trim()
    ? metadata.stage.trim()
    : (typeof source.stage === 'string' && source.stage.trim() ? source.stage.trim() : 'verify');
  normalized.state_changed = false;
  normalized.retryable = false;
  const lineNumber = metadata.line_number ?? source.line_number;
  if (Number.isFinite(Number(lineNumber))) {
    normalized.line_number = Math.max(1, Math.trunc(Number(lineNumber)));
  }
  for (const key of ['file_path', 'environment_id', 'skill_name']) {
    const value = metadata[key] ?? source[key];
    if (typeof value === 'string' && value.trim()) normalized[key] = value.trim();
  }
  const revision = metadata.revision ?? source.revision;
  if (Number.isFinite(Number(revision))) normalized.revision = Math.max(0, Math.trunc(Number(revision)));
  const hunkIndex = metadata.hunk_index ?? source.hunk_index;
  if (Number.isFinite(Number(hunkIndex))) normalized.hunk_index = Math.max(1, Math.trunc(Number(hunkIndex)));
  normalized.tool_output = formatApplyPatchVerificationError(normalized);
  normalized.cause = source;
  return normalized;
}

/**
 * Codex 新版 verifier 会拒绝多个操作指向同一源路径。路径先由具体虚拟
 * 环境规范化，避免不同拼写绕过重复检测。
 */
export function assertUniqueApplyPatchSourcePaths(hunks, normalizePath = (value) => String(value || '')) {
  const seen = new Set();
  const normalizedHunks = Array.isArray(hunks) ? hunks : [];
  for (let hunkIndex = 0; hunkIndex < normalizedHunks.length; hunkIndex += 1) {
    const hunk = normalizedHunks[hunkIndex];
    let path = '';
    try {
      path = normalizePath(hunk?.path);
    } catch (error) {
      throw normalizeApplyPatchVerificationError(error, {
        stage: 'verify',
        file_path: typeof hunk?.path === 'string' ? hunk.path : '',
        hunk_index: hunkIndex + 1
      });
    }
    if (seen.has(path)) {
      const error = createInvalidPatchError(`multiple operations target ${path}`);
      error.stage = 'verify';
      error.file_path = path;
      throw normalizeApplyPatchVerificationError(error, {
        stage: 'verify',
        file_path: path,
        hunk_index: hunkIndex + 1
      });
    }
    seen.add(path);
  }
}

function cloneHunks(hunks) {
  return hunks.map((hunk) => ({
    ...hunk,
    ...(Array.isArray(hunk.chunks)
      ? {
        chunks: hunk.chunks.map((chunk) => ({
          ...chunk,
          old_lines: [...chunk.old_lines],
          new_lines: [...chunk.new_lines],
          context_line_indices: Array.isArray(chunk.context_line_indices)
            ? chunk.context_line_indices.map(([oldIndex, newIndex]) => [oldIndex, newIndex])
            : []
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
 * 同步基准：openai-codex `63d213884daea50e4f74efc192cdc44f549b67d5`。
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
      finished: options.finished === true
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
      const environmentId = trimRustWhitespace(trimmed.slice(ENVIRONMENT_ID_MARKER.length));
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
    if (this.lineBuffer !== '') {
      const line = this.lineBuffer;
      this.lineBuffer = '';
      this.lineNumber += 1;
      if (trimRustWhitespace(line) === END_PATCH_MARKER) {
        this.ensureUpdateHunkIsNotEmpty(trimRustWhitespace(line));
        this.mode = 'ended_patch';
      } else {
        this.processLine(line);
      }
    }
    if (this.mode !== 'ended_patch') {
      throw createInvalidPatchError("The last line of the patch must be '*** End Patch'");
    }
    return this.getHunks();
  }

  processLine(line) {
    const trimmed = trimRustWhitespace(line);
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

    const updateLine = trimEndRustWhitespace(line);
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
        context_line_indices: [],
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
        chunks.push({
          change_context: null,
          old_lines: [],
          new_lines: [],
          context_line_indices: [],
          is_end_of_file: false
        });
      }
      lastChunk().context_line_indices.push([
        lastChunk().old_lines.length,
        lastChunk().new_lines.length
      ]);
      lastChunk().old_lines.push('');
      lastChunk().new_lines.push('');
      this.appendPreviewLine('context', '', line);
      return;
    }

    const prefix = line.charAt(0);
    if (prefix === ' ' || prefix === '+' || prefix === '-') {
      if (chunks.length === 0) {
        chunks.push({
          change_context: null,
          old_lines: [],
          new_lines: [],
          context_line_indices: [],
          is_end_of_file: false
        });
      }
      const content = line.slice(1);
      if (prefix === ' ') {
        lastChunk().context_line_indices.push([
          lastChunk().old_lines.length,
          lastChunk().new_lines.length
        ]);
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

function splitRustLines(value) {
  const text = String(value ?? '');
  if (!text) return [];
  return text.split('\n').map((line) => (
    line.endsWith('\r') ? line.slice(0, -1) : line
  ));
}

function checkPatchBoundariesStrict(lines) {
  const firstLine = lines.length > 0 ? trimRustWhitespace(lines[0]) : null;
  const lastLine = lines.length > 0 ? trimRustWhitespace(lines[lines.length - 1]) : null;
  if (firstLine === BEGIN_PATCH_MARKER && lastLine === END_PATCH_MARKER) {
    return lines;
  }
  if (firstLine !== null && firstLine !== BEGIN_PATCH_MARKER) {
    throw createInvalidPatchError("The first line of the patch must be '*** Begin Patch'");
  }
  throw createInvalidPatchError("The last line of the patch must be '*** End Patch'");
}

function checkPatchBoundariesLenient(lines) {
  let originalError;
  try {
    return checkPatchBoundariesStrict(lines);
  } catch (error) {
    originalError = error;
  }

  if (lines.length >= 4) {
    const firstLine = lines[0];
    const lastLine = lines[lines.length - 1];
    const hasHeredocStart = firstLine === '<<EOF'
      || firstLine === "<<'EOF'"
      || firstLine === '<<"EOF"';
    if (hasHeredocStart && lastLine.endsWith('EOF')) {
      return checkPatchBoundariesStrict(lines.slice(1, -1));
    }
  }
  throw originalError;
}

export function parseApplyPatch(patch, options = {}) {
  const mode = options?.mode || APPLY_PATCH_PARSE_MODE_LENIENT;
  if (![APPLY_PATCH_PARSE_MODE_STRICT, APPLY_PATCH_PARSE_MODE_LENIENT].includes(mode)) {
    throw createInvalidPatchError(`Unsupported apply_patch parser mode: ${options.mode}`);
  }
  const originalPatch = String(patch ?? '');
  const lines = splitRustLines(trimRustWhitespace(originalPatch));
  const patchLines = mode === APPLY_PATCH_PARSE_MODE_STRICT
    ? checkPatchBoundariesStrict(lines)
    : checkPatchBoundariesLenient(lines);
  const normalizedPatch = patchLines.join('\n');
  const parser = new StreamingApplyPatchParser();
  parser.pushDelta(normalizedPatch);
  const hunks = parser.finish();
  return {
    patch: normalizedPatch,
    environment_id: parser.environment_id,
    hunks
  };
}

function normalizeApplyPatchFileUpdateMode(value) {
  const mode = value || APPLY_PATCH_FILE_UPDATE_MODE_NORMALIZE_TO_LF;
  if (
    mode !== APPLY_PATCH_FILE_UPDATE_MODE_NORMALIZE_TO_LF
    && mode !== APPLY_PATCH_FILE_UPDATE_MODE_PRESERVE_LINE_ENDINGS
  ) {
    throw new Error(`Unsupported apply_patch file update mode: ${mode}`);
  }
  return mode;
}

export function seekSequence(
  lines,
  pattern,
  start,
  eof,
  updateFileMode = APPLY_PATCH_FILE_UPDATE_MODE_NORMALIZE_TO_LF
) {
  const normalizedUpdateFileMode = normalizeApplyPatchFileUpdateMode(updateFileMode);
  if (!Array.isArray(pattern) || pattern.length <= 0) {
    return start;
  }
  if (!Array.isArray(lines) || pattern.length > lines.length) {
    return null;
  }

  const searchStart = (() => {
    if (!eof || lines.length < pattern.length) return start;
    const eofStart = lines.length - pattern.length;
    return normalizedUpdateFileMode === APPLY_PATCH_FILE_UPDATE_MODE_PRESERVE_LINE_ENDINGS
      ? Math.max(eofStart, start)
      : eofStart;
  })();
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
      if (
        trimEndRustWhitespace(lines[index + offset])
        !== trimEndRustWhitespace(pattern[offset])
      ) {
        ok = false;
        break;
      }
    }
    if (ok) return index;
  }

  for (let index = searchStart; index <= maxStart; index += 1) {
    let ok = true;
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (
        trimRustWhitespace(lines[index + offset])
        !== trimRustWhitespace(pattern[offset])
      ) {
        ok = false;
        break;
      }
    }
    if (ok) return index;
  }

  const normalizeLoose = (value) => trimRustWhitespace(value)
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

function parseSourceFile(contents) {
  const text = String(contents ?? '');
  const lines = [];
  let preferredEnding = null;
  let lineStart = 0;
  let cursor = 0;

  while (cursor < text.length) {
    let ending = null;
    let endingLength = 0;
    if (text[cursor] === '\r' && text[cursor + 1] === '\n') {
      ending = '\r\n';
      endingLength = 2;
    } else if (text[cursor] === '\r') {
      ending = '\r';
      endingLength = 1;
    } else if (text[cursor] === '\n') {
      ending = '\n';
      endingLength = 1;
    } else {
      cursor += 1;
      continue;
    }

    if (preferredEnding === null) preferredEnding = ending;
    lines.push({
      text: text.slice(lineStart, cursor),
      ending
    });
    cursor += endingLength;
    lineStart = cursor;
  }

  if (lineStart < text.length) {
    lines.push({
      text: text.slice(lineStart),
      ending: null
    });
  }

  return {
    lines,
    preferredEnding: preferredEnding || '\n'
  };
}

function applySourceFileReplacements(sourceFile, replacements) {
  const sourceLines = sourceFile.lines;
  const nextLines = [];
  let sourceIndex = 0;

  for (const [startIndex, oldLength, newSegment] of replacements) {
    for (let index = sourceIndex; index < startIndex; index += 1) {
      nextLines.push(sourceLines[index]);
    }
    for (const text of newSegment) {
      nextLines.push({
        text,
        ending: sourceFile.preferredEnding
      });
    }
    sourceIndex = startIndex + oldLength;
  }

  for (let index = sourceIndex; index < sourceLines.length; index += 1) {
    nextLines.push(sourceLines[index]);
  }
  for (const line of nextLines) {
    if (line.ending === null) line.ending = sourceFile.preferredEnding;
  }
  return nextLines.map((line) => `${line.text}${line.ending || ''}`).join('');
}

function computeReplacements(originalLines, path, chunks, updateFileMode) {
  const replacements = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.change_context !== null && chunk.change_context !== undefined) {
      const matchedIndex = seekSequence(
        originalLines,
        [chunk.change_context],
        lineIndex,
        false,
        updateFileMode
      );
      if (matchedIndex === null) {
        throw new Error(`Failed to find context '${chunk.change_context}' in ${path}`);
      }
      lineIndex = matchedIndex + 1;
    }

    if (chunk.old_lines.length <= 0) {
      const insertionIndex = updateFileMode === APPLY_PATCH_FILE_UPDATE_MODE_PRESERVE_LINE_ENDINGS
        ? originalLines.length
        : (originalLines[originalLines.length - 1] === ''
          ? originalLines.length - 1
          : originalLines.length);
      replacements.push([insertionIndex, 0, [...chunk.new_lines]]);
      continue;
    }

    let pattern = chunk.old_lines;
    let newSlice = chunk.new_lines;
    let found = seekSequence(
      originalLines,
      pattern,
      lineIndex,
      chunk.is_end_of_file,
      updateFileMode
    );

    if (found === null && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1);
      if (newSlice[newSlice.length - 1] === '') {
        newSlice = newSlice.slice(0, -1);
      }
      found = seekSequence(
        originalLines,
        pattern,
        lineIndex,
        chunk.is_end_of_file,
        updateFileMode
      );
    }

    if (found === null) {
      throw new Error(`Failed to find expected lines in ${path}:\n${chunk.old_lines.join('\n')}`);
    }

    if (updateFileMode === APPLY_PATCH_FILE_UPDATE_MODE_NORMALIZE_TO_LF) {
      replacements.push([found, pattern.length, [...newSlice]]);
    } else {
      let oldStart = 0;
      let newStart = 0;
      const contextLineIndices = Array.isArray(chunk.context_line_indices)
        ? chunk.context_line_indices
        : [];
      for (const [oldContext, newContext] of contextLineIndices) {
        if (oldContext >= pattern.length || newContext >= newSlice.length) break;
        if (oldStart !== oldContext || newStart !== newContext) {
          replacements.push([
            found + oldStart,
            oldContext - oldStart,
            newSlice.slice(newStart, newContext)
          ]);
        }
        oldStart = oldContext + 1;
        newStart = newContext + 1;
      }
      if (oldStart !== pattern.length || newStart !== newSlice.length) {
        replacements.push([
          found + oldStart,
          pattern.length - oldStart,
          newSlice.slice(newStart)
        ]);
      }
    }
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

export function derivePatchedFileContent(originalContent, path, chunks, options = {}) {
  const updateFileMode = normalizeApplyPatchFileUpdateMode(
    typeof options === 'string'
      ? options
      : (options?.update_file_mode || options?.updateFileMode)
  );
  const sourceText = String(originalContent ?? '');

  if (updateFileMode === APPLY_PATCH_FILE_UPDATE_MODE_PRESERVE_LINE_ENDINGS) {
    const sourceFile = parseSourceFile(sourceText);
    const originalLines = sourceFile.lines.map((line) => line.text);
    const replacements = computeReplacements(
      originalLines,
      path,
      chunks,
      updateFileMode
    );
    return applySourceFileReplacements(sourceFile, replacements);
  }

  const originalLines = sourceText.split('\n');
  if (originalLines[originalLines.length - 1] === '') {
    originalLines.pop();
  }
  const replacements = computeReplacements(
    originalLines,
    path,
    chunks,
    updateFileMode
  );
  const nextLines = applyReplacements(originalLines, replacements);
  if (nextLines[nextLines.length - 1] !== '') {
    nextLines.push('');
  }
  return nextLines.join('\n');
}
