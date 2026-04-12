/**
 * Cerebr 浏览器微型 Skill 注册表。
 *
 * 新模型收敛为“skill package + 虚拟文件树”：
 * - manifest 负责触发、匹配、启停、更新时间、runtime 入口等结构化索引；
 * - files 负责承载 `SKILL.md`、runtime 源码、references、模板等可按路径读取的内容；
 * - 持久化默认走 IndexedDB，而不是继续把整包文本塞进 chrome.storage.local。
 *
 * 这样做的目的：
 * - 更接近 Codex skill 的组织方式；
 * - 让模型可以按文件增量读取和修改；
 * - 列表/上下文注入只读 manifest，不再每次把整包源码都拉进来。
 */

import { getBuiltinMicroSkillRecordByName, getBuiltinMicroSkillRecords } from './builtin_micro_skill_creator.js';
import { createIndexedDbMicroSkillStore, MICRO_SKILL_DB_NAME } from '../storage/micro_skill_store.js';
import {
  PAGE_CONTENT_READ_DEFAULT_RANGE_CHARS,
  PAGE_CONTENT_READ_MAX_CHARS
} from './page_content_read_tool.js';

export const MICRO_SKILL_REGISTRY_TOOL_NAME = 'micro_skill_registry';
export const MICRO_SKILL_REGISTRY_STORAGE_KEY = 'micro_skill_registry_v1';
export const MICRO_SKILL_REGISTRY_DB_NAME = MICRO_SKILL_DB_NAME;
export const MICRO_SKILL_REGISTRY_VERSION = 2;
export const MICRO_SKILL_MATCH_ALL_URLS = '<all_urls>';
export const CEREBR_MICRO_SKILL_MOUNT_SURFACE = 'globalThis.__cerebrMicroSkills';
export const MICRO_SKILL_VIRTUAL_MANIFEST_PATH = 'manifest.json';
export const MICRO_SKILL_READ_DEFAULT_RANGE_CHARS = PAGE_CONTENT_READ_DEFAULT_RANGE_CHARS;
export const MICRO_SKILL_READ_MAX_CHARS = PAGE_CONTENT_READ_MAX_CHARS;

const MICRO_SKILL_KIND_PAGE_RUNTIME = 'page_runtime';
const MICRO_SKILL_KIND_BUILTIN_GUIDANCE = 'builtin_guidance';
const MICRO_SKILL_FILE_KIND_INSTRUCTION = 'instruction';
const MICRO_SKILL_FILE_KIND_RUNTIME_SOURCE = 'runtime_source';
const MICRO_SKILL_FILE_KIND_REFERENCE = 'reference';
const MICRO_SKILL_FILE_KIND_UI_METADATA = 'ui_metadata';
const MICRO_SKILL_FILE_KIND_TEMPLATE = 'template';
const MICRO_SKILL_DEFAULT_INSTRUCTION_PATH = 'SKILL.md';
const MICRO_SKILL_DEFAULT_RUNTIME_ENTRY_PATH = 'src/main.js';

function normalizeString(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

function normalizeOptionalString(value) {
  const text = normalizeString(value);
  return text || null;
}

function normalizeBoolean(value, fallback = false) {
  return (typeof value === 'boolean') ? value : fallback;
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

function ensurePlainObject(value) {
  return (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
}

function isMicroSkillVirtualManifestPath(value) {
  return normalizeMicroSkillFilePath(value) === MICRO_SKILL_VIRTUAL_MANIFEST_PATH;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toIsoTimestamp(value) {
  const text = normalizeString(value);
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeRevision(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 1;
}

export function normalizeMicroSkillName(value) {
  const name = normalizeString(value).toLowerCase();
  if (!name) {
    throw new Error('micro_skill_registry 参数错误：skill.name 不能为空。');
  }
  if (!/^[a-z0-9-]{1,64}$/.test(name)) {
    throw new Error('micro_skill_registry 参数错误：skill.name 只支持小写字母、数字、连字符，且长度不能超过 64。');
  }
  return name;
}

function normalizeMicroSkillKind(value, fallback = MICRO_SKILL_KIND_PAGE_RUNTIME) {
  const text = normalizeString(value).toLowerCase();
  if (!text) return fallback;
  if (text === MICRO_SKILL_KIND_PAGE_RUNTIME || text === MICRO_SKILL_KIND_BUILTIN_GUIDANCE) {
    return text;
  }
  throw new Error(`micro_skill_registry 参数错误：不支持的 skill.kind \`${value}\`。`);
}

export function normalizeMicroSkillFileKind(value) {
  const text = normalizeString(value).toLowerCase();
  const supportedKinds = new Set([
    MICRO_SKILL_FILE_KIND_INSTRUCTION,
    MICRO_SKILL_FILE_KIND_RUNTIME_SOURCE,
    MICRO_SKILL_FILE_KIND_REFERENCE,
    MICRO_SKILL_FILE_KIND_UI_METADATA,
    MICRO_SKILL_FILE_KIND_TEMPLATE
  ]);
  if (!supportedKinds.has(text)) {
    throw new Error(`micro_skill_registry 参数错误：不支持的文件 kind \`${value}\`。`);
  }
  return text;
}

function getMicroSkillFileExtension(filePath) {
  const normalizedPath = normalizeMicroSkillFilePath(filePath);
  const lastSlashIndex = normalizedPath.lastIndexOf('/');
  const filename = lastSlashIndex >= 0 ? normalizedPath.slice(lastSlashIndex + 1) : normalizedPath;
  const lastDotIndex = filename.lastIndexOf('.');
  return lastDotIndex >= 0 ? filename.slice(lastDotIndex).toLowerCase() : '';
}

function pathStartsWithAnyPrefix(filePath, prefixes) {
  const normalizedPath = normalizeMicroSkillFilePath(filePath).toLowerCase();
  return prefixes.some((prefix) => normalizedPath.startsWith(String(prefix || '').toLowerCase()));
}

export function isMicroSkillRuntimeSourcePath(filePath) {
  const extension = getMicroSkillFileExtension(filePath);
  return extension === '.js' || extension === '.mjs' || extension === '.cjs';
}

export function pickDefaultMicroSkillInstructionPath(files) {
  const normalizedFiles = Array.isArray(files) ? files : [];
  const exactDefault = normalizedFiles.find((file) => file.path === MICRO_SKILL_DEFAULT_INSTRUCTION_PATH);
  if (exactDefault) return exactDefault.path;
  const markdownFile = normalizedFiles.find((file) => {
    const extension = getMicroSkillFileExtension(file.path);
    return extension === '.md' || extension === '.markdown';
  });
  if (markdownFile) return markdownFile.path;
  return normalizedFiles[0]?.path || null;
}

export function pickDefaultMicroSkillRuntimeEntryPath(files) {
  const normalizedFiles = Array.isArray(files) ? files : [];
  const exactDefault = normalizedFiles.find((file) => file.path === MICRO_SKILL_DEFAULT_RUNTIME_ENTRY_PATH);
  if (exactDefault) return exactDefault.path;
  const srcRuntimeFile = normalizedFiles.find((file) => (
    pathStartsWithAnyPrefix(file.path, ['src/']) && isMicroSkillRuntimeSourcePath(file.path)
  ));
  if (srcRuntimeFile) return srcRuntimeFile.path;
  const anyRuntimeFile = normalizedFiles.find((file) => isMicroSkillRuntimeSourcePath(file.path));
  return anyRuntimeFile?.path || null;
}

export function inferMicroSkillFileKindForPath(filePath, options = {}) {
  const normalizedPath = normalizeMicroSkillFilePath(filePath);
  const instructionPath = options?.instructionPath ? normalizeMicroSkillFilePath(options.instructionPath) : null;
  const runtimeEntryPath = options?.runtimeEntryPath ? normalizeMicroSkillFilePath(options.runtimeEntryPath) : null;
  const explicitKind = options?.explicitKind ? normalizeMicroSkillFileKind(options.explicitKind) : null;

  if (instructionPath && normalizedPath === instructionPath) {
    return MICRO_SKILL_FILE_KIND_INSTRUCTION;
  }
  if (runtimeEntryPath && normalizedPath === runtimeEntryPath) {
    return MICRO_SKILL_FILE_KIND_RUNTIME_SOURCE;
  }
  if (pathStartsWithAnyPrefix(normalizedPath, ['template/', 'templates/'])) {
    return MICRO_SKILL_FILE_KIND_TEMPLATE;
  }
  if (pathStartsWithAnyPrefix(normalizedPath, ['ui/', 'meta/', 'metadata/'])) {
    return MICRO_SKILL_FILE_KIND_UI_METADATA;
  }
  if (isMicroSkillRuntimeSourcePath(normalizedPath)) {
    return MICRO_SKILL_FILE_KIND_RUNTIME_SOURCE;
  }
  return explicitKind || MICRO_SKILL_FILE_KIND_REFERENCE;
}

function normalizeMicroSkillInterface(rawInterface, fallbackDescription = '') {
  const input = ensurePlainObject(rawInterface);
  return {
    display_name: normalizeOptionalString(input.display_name),
    short_description: normalizeOptionalString(input.short_description) || normalizeOptionalString(fallbackDescription),
    default_prompt: normalizeOptionalString(input.default_prompt)
  };
}

export function normalizeMicroSkillFilePath(value) {
  const rawPath = normalizeString(value).replace(/\\/g, '/');
  const withoutLeadingDot = rawPath.replace(/^(?:\.\/)+/, '');
  const normalizedPath = withoutLeadingDot.startsWith('/')
    ? withoutLeadingDot.slice(1)
    : withoutLeadingDot;

  if (!normalizedPath) {
    throw new Error('micro_skill_registry 参数错误：files[].path 不能为空。');
  }
  if (normalizedPath.length > 256) {
    throw new Error('micro_skill_registry 参数错误：files[].path 长度不能超过 256。');
  }
  if (!/^[a-zA-Z0-9._/-]+$/.test(normalizedPath)) {
    throw new Error(`micro_skill_registry 参数错误：不支持的文件路径 \`${normalizedPath}\`。`);
  }

  const segments = normalizedPath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`micro_skill_registry 参数错误：文件路径 \`${normalizedPath}\` 不能包含空段、"." 或 ".."。`);
  }
  return normalizedPath;
}

function buildEditableMicroSkillManifestObject(skill) {
  return {
    description: skill.description,
    interface: {
      display_name: skill.interface.display_name || null,
      short_description: skill.interface.short_description || null,
      default_prompt: skill.interface.default_prompt || null
    },
    match: [...skill.match],
    enabled: skill.enabled === true,
    instruction: {
      path: skill.instruction.path
    },
    runtime: {
      entry_path: skill.runtime.entry_path
    }
  };
}

export function serializeMicroSkillVirtualManifest(record) {
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) {
    throw new Error('无法为无效的微型 skill 生成 manifest 虚拟文件。');
  }
  return `${JSON.stringify(buildEditableMicroSkillManifestObject(skill), null, 2)}\n`;
}

export function parseMicroSkillVirtualManifestContent(content, existingRecord = null) {
  const existing = existingRecord ? normalizeStoredMicroSkillRecord(existingRecord) : null;
  let parsed = null;
  try {
    parsed = JSON.parse(String(content || ''));
  } catch (error) {
    throw new Error(`micro_skill_registry 参数错误：manifest.json 不是合法 JSON：${error?.message || error}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('micro_skill_registry 参数错误：manifest.json 顶层必须是 JSON object。');
  }

  return {
    kind: existing?.kind || MICRO_SKILL_KIND_PAGE_RUNTIME,
    name: existing?.name || null,
    description: normalizeString(parsed.description || existing?.description),
    interface: {
      display_name: normalizeOptionalString(parsed?.interface?.display_name ?? existing?.interface?.display_name),
      short_description: normalizeOptionalString(parsed?.interface?.short_description ?? existing?.interface?.short_description),
      default_prompt: normalizeOptionalString(parsed?.interface?.default_prompt ?? existing?.interface?.default_prompt)
    },
    match: Array.isArray(parsed.match) ? parsed.match : (existing?.match || []),
    enabled: (typeof parsed.enabled === 'boolean') ? parsed.enabled : (existing?.enabled ?? true),
    instruction: {
      path: normalizeOptionalString(parsed?.instruction?.path ?? existing?.instruction?.path)
        ? normalizeMicroSkillFilePath(parsed?.instruction?.path ?? existing?.instruction?.path)
        : null
    },
    runtime: {
      entry_path: normalizeOptionalString(parsed?.runtime?.entry_path ?? existing?.runtime?.entry_path)
        ? normalizeMicroSkillFilePath(parsed?.runtime?.entry_path ?? existing?.runtime?.entry_path)
        : null
    }
  };
}

function buildMicroSkillVirtualManifestFile(record, options = {}) {
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) return null;
  return {
    path: MICRO_SKILL_VIRTUAL_MANIFEST_PATH,
    kind: null,
    is_virtual: true,
    is_manifest: true,
    is_instruction: false,
    is_runtime_entry: false,
    ...(options?.includeContent === true
      ? { content: serializeMicroSkillVirtualManifest(skill) }
      : {})
  };
}

function normalizeMicroSkillReadRangeArgs(rawArgs, options = {}) {
  const args = ensurePlainObject(rawArgs);
  const allowLineRange = options?.allowLineRange === true;
  const explicitMode = normalizeString(args.mode).toLowerCase();
  const hasSkipChars = args.skip_chars != null;
  const hasMaxChars = args.max_chars != null;
  const hasStartLine = args.start_line != null;
  const hasEndLine = args.end_line != null;

  if ((hasStartLine || hasEndLine) && (hasSkipChars || hasMaxChars)) {
    throw new Error('micro_skill_registry 参数错误：不能同时使用字符区间和行区间读取参数。');
  }
  if (!allowLineRange && (hasStartLine || hasEndLine)) {
    throw new Error('micro_skill_registry 参数错误：当前 action 不支持 start_line / end_line。');
  }
  if (allowLineRange && (hasStartLine || hasEndLine) && !(hasStartLine && hasEndLine)) {
    throw new Error('micro_skill_registry 参数错误：使用行区间读取时，start_line 与 end_line 需要同时提供。');
  }

  const skipChars = hasSkipChars ? clampNonNegativeInt(args.skip_chars, 0) : null;
  const maxChars = hasMaxChars
    ? Math.max(1, Math.min(MICRO_SKILL_READ_MAX_CHARS, clampNonNegativeInt(args.max_chars, MICRO_SKILL_READ_DEFAULT_RANGE_CHARS)))
    : null;

  if (explicitMode === 'preview') {
    return {
      mode: 'preview',
      skip_chars: 0,
      max_chars: maxChars ?? MICRO_SKILL_READ_DEFAULT_RANGE_CHARS,
      start_line: null,
      end_line: null
    };
  }

  if (hasStartLine || hasEndLine) {
    const startLine = clampPositiveInt(args.start_line, 1);
    const endLine = clampPositiveInt(args.end_line, startLine);
    if (endLine < startLine) {
      throw new Error('micro_skill_registry 参数错误：end_line 不能小于 start_line。');
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
      max_chars: maxChars ?? MICRO_SKILL_READ_DEFAULT_RANGE_CHARS,
      start_line: null,
      end_line: null
    };
  }

  return {
    mode: 'preview',
    skip_chars: 0,
    max_chars: MICRO_SKILL_READ_DEFAULT_RANGE_CHARS,
    start_line: null,
    end_line: null
  };
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
  return {
    text: normalized,
    lines
  };
}

function countLogicalLines(text) {
  return splitLogicalLines(text).lines.length;
}

function buildMicroSkillTextReadResult(text, rawArgs, options = {}) {
  const sourceText = String(text ?? '');
  const range = normalizeMicroSkillReadRangeArgs(rawArgs, {
    allowLineRange: options?.allowLineRange === true
  });
  const totalChars = sourceText.length;
  const totalLines = countLogicalLines(sourceText);

  if (range.mode === 'line_range') {
    const { text: normalizedText, lines } = splitLogicalLines(sourceText);
    const totalLogicalLines = lines.length;
    const requestedStartLine = Math.min(range.start_line, Math.max(1, totalLogicalLines || 1));
    const requestedEndLine = Math.min(Math.max(requestedStartLine, range.end_line), Math.max(requestedStartLine, totalLogicalLines || requestedStartLine));

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
  const effectiveMaxChars = range.max_chars ?? MICRO_SKILL_READ_DEFAULT_RANGE_CHARS;
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

function normalizeMicroSkillFile(rawFile, options = {}) {
  const file = ensurePlainObject(rawFile);
  const path = normalizeMicroSkillFilePath(file.path);
  const content = (typeof file.content === 'string')
    ? file.content
    : ((typeof file.code === 'string') ? file.code : '');
  const requireContent = options?.requireContent !== false;
  const explicitKind = (typeof file.kind === 'string' && file.kind.trim())
    ? normalizeMicroSkillFileKind(file.kind)
    : null;

  if (requireContent && !content.trim()) {
    throw new Error(`micro_skill_registry 参数错误：files[\`${path}\`].content 不能为空。`);
  }

  return {
    path,
    kind: explicitKind,
    content
  };
}

function normalizeMicroSkillFiles(rawFiles, options = {}) {
  const input = Array.isArray(rawFiles) ? rawFiles : [];
  const requireFiles = options?.requireFiles !== false;
  if (requireFiles && input.length <= 0) {
    throw new Error('micro_skill_registry 参数错误：skill.files 至少需要提供 1 个文件。');
  }

  const files = [];
  const seenPaths = new Set();
  input.forEach((rawFile) => {
    const file = normalizeMicroSkillFile(rawFile, {
      requireContent: options?.requireContent !== false
    });
    if (seenPaths.has(file.path)) {
      throw new Error(`micro_skill_registry 参数错误：files 中存在重复路径 \`${file.path}\`。`);
    }
    seenPaths.add(file.path);
    files.push(file);
  });
  return files;
}

function normalizeMicroSkillInstruction(rawInstruction, files) {
  const input = ensurePlainObject(rawInstruction);
  const requestedPath = normalizeOptionalString(input.path)
    ? normalizeMicroSkillFilePath(input.path)
    : null;
  const instructionFile = requestedPath
    ? files.find((file) => file.path === requestedPath)
    : (files.find((file) => file.path === pickDefaultMicroSkillInstructionPath(files)) || null);

  if (!instructionFile) {
    throw new Error('micro_skill_registry 参数错误：skill.instruction.path 必须指向 files 中的说明文件。');
  }

  return {
    path: instructionFile.path
  };
}

function normalizeMicroSkillRuntime(rawRuntime, files, kind) {
  const input = ensurePlainObject(rawRuntime);
  const requestedPath = normalizeOptionalString(input.entry_path || input.entry)
    ? normalizeMicroSkillFilePath(input.entry_path || input.entry)
    : null;
  const runtimeEntryFile = requestedPath
    ? files.find((file) => file.path === requestedPath)
    : (files.find((file) => file.path === pickDefaultMicroSkillRuntimeEntryPath(files)) || null);

  if (kind === MICRO_SKILL_KIND_PAGE_RUNTIME) {
    if (!runtimeEntryFile) {
      throw new Error('micro_skill_registry 参数错误：page runtime skill 必须提供 runtime.entry_path。');
    }
    if (!isMicroSkillRuntimeSourcePath(runtimeEntryFile.path)) {
      throw new Error(`micro_skill_registry 参数错误：runtime.entry_path \`${runtimeEntryFile.path}\` 必须指向可执行的 JS runtime 文件。`);
    }
  }

  if (!runtimeEntryFile) {
    return { entry_path: null };
  }
  return {
    entry_path: runtimeEntryFile.path
  };
}

/**
 * 默认挂载说明。
 *
 * 这不是单独字段存储，而是用于生成默认 SKILL.md/内置指导文案时的公共片段。
 */
export function buildDefaultMicroSkillMountContract() {
  return [
    'Mount surface: `globalThis.__cerebrMicroSkills`.',
    'Use `globalThis.__cerebrMicroSkills.skills[name]` to access mounted exports.',
    'Use `globalThis.__cerebrMicroSkills.invoke("skill.method", ...args)` to call a mounted method.',
    'Runtime source files run as async CommonJS-like bodies with `ctx`, `module`, `exports`, `require` available.',
    '`require()` is async in this runtime, so helper imports should use `await require("./helper.js")`.',
    'Entry file can `return { methods... }`, or assign `module.exports = { ... }`; advanced style: call `ctx.mount(exports)` manually.',
    'If a mounted exports object exposes `dispose()`, Cerebr may call it before unmount / remount.'
  ].join('\n');
}

/**
 * 校验并规范化 Chrome/TM 风格 `@match`。
 */
export function normalizeMicroSkillMatchPatterns(rawPatterns, options = {}) {
  const input = Array.isArray(rawPatterns) ? rawPatterns : [];
  const allowEmpty = options?.allowEmpty === true;
  if (!allowEmpty && input.length <= 0) {
    throw new Error('micro_skill_registry 参数错误：skill.match 需要至少提供 1 条 `@match` 规则。');
  }

  const normalized = input.map((value) => normalizeString(value)).filter(Boolean);
  if (!allowEmpty && normalized.length <= 0) {
    throw new Error('micro_skill_registry 参数错误：skill.match 里不能出现空规则。');
  }

  const unique = Array.from(new Set(normalized));
  unique.forEach((pattern) => {
    if (!isValidMicroSkillMatchPattern(pattern)) {
      throw new Error(`micro_skill_registry 参数错误：不支持的 match 规则 \`${pattern}\`。`);
    }
  });
  return unique;
}

export function isValidMicroSkillMatchPattern(pattern) {
  const text = normalizeString(pattern);
  if (!text) return false;
  if (text === MICRO_SKILL_MATCH_ALL_URLS) return true;

  const match = text.match(/^(\*|http|https|file):\/\/([^/]*)(\/.*)$/);
  if (!match) return false;
  const [, scheme, host, path] = match;
  if (!path.startsWith('/')) return false;

  if (scheme === 'file') {
    return host === '';
  }

  if (!host) return false;
  if (host === '*') return true;
  if (host.startsWith('*.')) {
    return /^[*.a-z0-9-]+$/i.test(host);
  }
  if (host.includes('*')) return false;
  return /^[a-z0-9.-]+$/i.test(host);
}

function matchPathPattern(pathPattern, pathname) {
  const regex = new RegExp(`^${escapeRegExp(pathPattern).replace(/\\\*/g, '.*')}$`);
  return regex.test(pathname);
}

function matchHostPattern(hostPattern, hostname) {
  if (hostPattern === '*') return !!hostname;
  if (hostPattern.startsWith('*.')) {
    const suffix = hostPattern.slice(2).toLowerCase();
    const host = String(hostname || '').toLowerCase();
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return String(hostname || '').toLowerCase() === hostPattern.toLowerCase();
}

export function microSkillMatchPatternMatchesUrl(pattern, url) {
  const text = normalizeString(pattern);
  if (!text) return false;

  let parsedUrl = null;
  try {
    parsedUrl = new URL(url);
  } catch (_) {
    return false;
  }

  if (text === MICRO_SKILL_MATCH_ALL_URLS) {
    return ['http:', 'https:', 'file:'].includes(parsedUrl.protocol);
  }

  const match = text.match(/^(\*|http|https|file):\/\/([^/]*)(\/.*)$/);
  if (!match) return false;
  const [, scheme, hostPattern, pathPattern] = match;

  if (scheme === 'file') {
    if (parsedUrl.protocol !== 'file:') return false;
    return matchPathPattern(pathPattern, parsedUrl.pathname || '/');
  }

  if (scheme === '*') {
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) return false;
  } else if (`${scheme}:` !== parsedUrl.protocol) {
    return false;
  }

  return (
    matchHostPattern(hostPattern, parsedUrl.hostname)
    && matchPathPattern(pathPattern, parsedUrl.pathname || '/')
  );
}

export function normalizeMicroSkillInput(rawSkill, options = {}) {
  const skill = ensurePlainObject(rawSkill);
  const kind = normalizeMicroSkillKind(skill.kind, MICRO_SKILL_KIND_PAGE_RUNTIME);
  const description = normalizeString(skill.description);
  if (!description) {
    throw new Error('micro_skill_registry 参数错误：skill.description 不能为空。');
  }

  const rawFiles = Array.isArray(skill.files) ? skill.files : (
    Array.isArray(skill.files_meta) ? skill.files_meta : []
  );
  const rawNormalizedFiles = normalizeMicroSkillFiles(rawFiles, {
    requireFiles: options?.requireFiles !== false,
    requireContent: options?.requireContent !== false
  });
  const instruction = normalizeMicroSkillInstruction(skill.instruction, rawNormalizedFiles);
  const runtime = normalizeMicroSkillRuntime(skill.runtime, rawNormalizedFiles, kind);
  const files = rawNormalizedFiles.map((file) => ({
    ...file,
    kind: inferMicroSkillFileKindForPath(file.path, {
      instructionPath: instruction.path,
      runtimeEntryPath: runtime.entry_path,
      explicitKind: file.kind
    })
  }));

  return {
    kind,
    name: normalizeMicroSkillName(skill.name),
    description,
    interface: normalizeMicroSkillInterface(skill.interface, description),
    match: normalizeMicroSkillMatchPatterns(skill.match, {
      allowEmpty: kind !== MICRO_SKILL_KIND_PAGE_RUNTIME
    }),
    enabled: normalizeBoolean(skill.enabled, true),
    instruction,
    runtime,
    files
  };
}

export function normalizeStoredMicroSkillRecord(rawRecord) {
  const record = ensurePlainObject(rawRecord);
  let normalizedInput = null;
  let inferredKind = MICRO_SKILL_KIND_PAGE_RUNTIME;
  let hasFullFiles = false;
  try {
    hasFullFiles = record.has_file_contents === true
      || (
        Array.isArray(record.files)
        && record.files.some((file) => typeof file?.content === 'string' && file.content.length > 0)
      );
    inferredKind = normalizeMicroSkillKind(
      record.kind,
      record.builtin === true ? MICRO_SKILL_KIND_BUILTIN_GUIDANCE : MICRO_SKILL_KIND_PAGE_RUNTIME
    );
    normalizedInput = normalizeMicroSkillInput({
      ...record,
      kind: inferredKind
    }, {
      requireFiles: true,
      requireContent: hasFullFiles
    });
  } catch (_) {
    return null;
  }

  const createdAt = toIsoTimestamp(record.created_at) || new Date(0).toISOString();
  const updatedAt = toIsoTimestamp(record.updated_at) || createdAt;
  const builtin = record.builtin === true || inferredKind === MICRO_SKILL_KIND_BUILTIN_GUIDANCE;

  return {
    ...normalizedInput,
    builtin,
    read_only: builtin || record.read_only === true,
    has_file_contents: hasFullFiles,
    created_at: createdAt,
    updated_at: updatedAt,
    revision: normalizeRevision(record.revision)
  };
}

export function buildStoredMicroSkillRecord(skillInput, existingRecord = null) {
  const normalizedInput = normalizeMicroSkillInput(skillInput, {
    requireFiles: true,
    requireContent: true
  });
  const existing = normalizeStoredMicroSkillRecord(existingRecord);
  const now = new Date().toISOString();

  return {
    ...normalizedInput,
    builtin: false,
    read_only: false,
    created_at: existing?.created_at || now,
    updated_at: now,
    revision: existing ? existing.revision + 1 : 1
  };
}

function summarizeFileKinds(files) {
  const counts = Object.create(null);
  (Array.isArray(files) ? files : []).forEach((file) => {
    counts[file.kind] = Number(counts[file.kind] || 0) + 1;
  });
  return counts;
}

export function buildMicroSkillFileManifest(record, options = {}) {
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) return null;

  const includeContent = options?.includeContent === true;
  const contentReadArgs = options?.contentReadArgs || null;
  const onlyPaths = Array.isArray(options?.onlyPaths)
    ? new Set(options.onlyPaths.map((value) => normalizeMicroSkillFilePath(value)))
    : null;
  const onlyKinds = Array.isArray(options?.onlyKinds)
    ? new Set(options.onlyKinds.map((value) => normalizeMicroSkillFileKind(value)))
    : null;

  const selectedFiles = skill.files
    .filter((file) => (!onlyPaths || onlyPaths.has(file.path)) && (!onlyKinds || onlyKinds.has(file.kind)))
    .map((file) => ({
      path: file.path,
      kind: file.kind,
      is_instruction: file.path === skill.instruction.path,
      is_runtime_entry: !!skill.runtime.entry_path && file.path === skill.runtime.entry_path,
      ...(includeContent ? (() => {
        const contentRead = buildMicroSkillTextReadResult(file.content, contentReadArgs, {
          allowLineRange: false
        });
        return {
          content: contentRead.content,
          content_read: contentRead
        };
      })() : {})
    }));
  const manifestFile = buildMicroSkillVirtualManifestFile(skill, { includeContent });
  if (manifestFile && includeContent) {
    const contentRead = buildMicroSkillTextReadResult(manifestFile.content, contentReadArgs, {
      allowLineRange: false
    });
    manifestFile.content = contentRead.content;
    manifestFile.content_read = contentRead;
  }
  if (manifestFile && !onlyKinds && (!onlyPaths || onlyPaths.has(manifestFile.path))) {
    selectedFiles.unshift(manifestFile);
  }

  return {
    total_count: skill.files.length + 1,
    returned_file_count: selectedFiles.length,
    by_kind: summarizeFileKinds(skill.files),
    virtual_manifest_path: MICRO_SKILL_VIRTUAL_MANIFEST_PATH,
    instruction_path: skill.instruction.path,
    runtime_entry_path: skill.runtime.entry_path,
    files: selectedFiles
  };
}

function readInstructionContent(skill) {
  return skill.files.find((file) => file.path === skill.instruction.path)?.content || '';
}

export function buildMicroSkillSummary(record) {
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) return null;
  return {
    kind: skill.kind,
    builtin: skill.builtin === true,
    read_only: skill.read_only === true,
    name: skill.name,
    description: skill.description,
    interface: {
      display_name: skill.interface.display_name || skill.name,
      short_description: skill.interface.short_description || skill.description,
      default_prompt: skill.interface.default_prompt
    },
    match: [...skill.match],
    enabled: skill.enabled,
    created_at: skill.created_at,
    updated_at: skill.updated_at,
    revision: skill.revision,
    instruction: {
      path: skill.instruction.path
    },
    runtime: {
      entry_path: skill.runtime.entry_path,
      runtime_file_count: skill.files.filter((file) => file.kind === MICRO_SKILL_FILE_KIND_RUNTIME_SOURCE).length
    },
    files: {
      total_count: skill.files.length + 1,
      by_kind: summarizeFileKinds(skill.files),
      virtual_manifest_path: MICRO_SKILL_VIRTUAL_MANIFEST_PATH
    }
  };
}

export function buildMicroSkillDetail(record, options = {}) {
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) return null;
  const instructionRead = buildMicroSkillTextReadResult(readInstructionContent(skill), options?.contentReadArgs || null, {
    allowLineRange: true
  });
  return {
    ...buildMicroSkillSummary(skill),
    instruction: {
      path: skill.instruction.path,
      content: instructionRead.content,
      content_read: instructionRead
    },
    files: buildMicroSkillFileManifest(skill, { includeContent: false })
  };
}

export function buildMicroSkillPackagePayload(record, options = {}) {
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) return null;
  return {
    kind: skill.kind,
    builtin: skill.builtin === true,
    read_only: skill.read_only === true,
    name: skill.name,
    revision: skill.revision,
    instruction: {
      path: skill.instruction.path
    },
    runtime: {
      entry_path: skill.runtime.entry_path
    },
    manifest_path: MICRO_SKILL_VIRTUAL_MANIFEST_PATH,
    files: buildMicroSkillFileManifest(skill, {
      includeContent: true,
      contentReadArgs: options?.contentReadArgs || null
    })
  };
}

export function buildMicroSkillFilePayload(record, filePath, options = {}) {
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) return null;
  const normalizedPath = normalizeMicroSkillFilePath(filePath);
  if (isMicroSkillVirtualManifestPath(normalizedPath)) {
    const manifestFile = buildMicroSkillVirtualManifestFile(skill, { includeContent: true });
    const contentRead = buildMicroSkillTextReadResult(manifestFile.content, options?.contentReadArgs || null, {
      allowLineRange: true
    });
    manifestFile.content = contentRead.content;
    manifestFile.content_read = contentRead;
    return {
      kind: skill.kind,
      builtin: skill.builtin === true,
      read_only: skill.read_only === true,
      name: skill.name,
      revision: skill.revision,
      requested_file_path: normalizedPath,
      instruction: {
        path: skill.instruction.path
      },
      runtime: {
        entry_path: skill.runtime.entry_path
      },
      file: manifestFile
    };
  }
  const file = skill.files.find((item) => item.path === normalizedPath) || null;
  if (!file) {
    throw new Error(`微型 skill ${skill.name} 中不存在文件 ${normalizedPath}。`);
  }
  const contentRead = buildMicroSkillTextReadResult(file.content, options?.contentReadArgs || null, {
    allowLineRange: true
  });
  return {
    kind: skill.kind,
    builtin: skill.builtin === true,
    read_only: skill.read_only === true,
    name: skill.name,
    revision: skill.revision,
    requested_file_path: normalizedPath,
    instruction: {
      path: skill.instruction.path
    },
    runtime: {
      entry_path: skill.runtime.entry_path
    },
    file: {
      path: file.path,
      kind: file.kind,
      is_instruction: file.path === skill.instruction.path,
      is_runtime_entry: !!skill.runtime.entry_path && file.path === skill.runtime.entry_path,
      content: contentRead.content,
      content_read: contentRead
    }
  };
}

export function buildMicroSkillContextSummary(record) {
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) return null;
  return {
    priority: skill.kind === MICRO_SKILL_KIND_BUILTIN_GUIDANCE ? 0 : 1000,
    name: skill.name,
    display_name: skill.interface.display_name || skill.name,
    short_description: skill.interface.short_description || skill.description,
    default_prompt: skill.interface.default_prompt,
    mount_surface: skill.kind === MICRO_SKILL_KIND_BUILTIN_GUIDANCE
      ? '先读取这条 skill 的详情，再按需读文件或修改目标 skill。'
      : `${CEREBR_MICRO_SKILL_MOUNT_SURFACE}.skills["${skill.name}"] / ${CEREBR_MICRO_SKILL_MOUNT_SURFACE}.invoke("${skill.name}.method", ...args)`
  };
}

export function microSkillMatchesUrl(record, url) {
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill || skill.enabled !== true || skill.kind !== MICRO_SKILL_KIND_PAGE_RUNTIME) return false;
  return skill.match.some((pattern) => microSkillMatchPatternMatchesUrl(pattern, url));
}

export function listBuiltinMicroSkillRecords() {
  return getBuiltinMicroSkillRecords();
}

export function getBuiltinMicroSkillRecord(skillName) {
  return getBuiltinMicroSkillRecordByName(skillName);
}

function ensureMicroSkillStore(store = null) {
  const resolved = store || createIndexedDbMicroSkillStore();
  const requiredMethods = ['listManifests', 'getManifest', 'getPackage', 'savePackage', 'deletePackage'];
  const missing = requiredMethods.filter((name) => typeof resolved?.[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(`当前环境没有可用的 micro skill store，缺少方法：${missing.join(', ')}`);
  }
  return resolved;
}

export async function listStoredMicroSkillManifests(store = null) {
  const resolvedStore = ensureMicroSkillStore(store);
  const manifests = await resolvedStore.listManifests();
  return (Array.isArray(manifests) ? manifests : [])
    .map((record) => normalizeStoredMicroSkillRecord(record))
    .filter(Boolean)
    .sort((left, right) => {
      const leftTs = Date.parse(left.updated_at || '') || 0;
      const rightTs = Date.parse(right.updated_at || '') || 0;
      if (leftTs !== rightTs) return rightTs - leftTs;
      return left.name.localeCompare(right.name);
    });
}

export async function getStoredMicroSkillPackage(skillName, store = null) {
  const resolvedStore = ensureMicroSkillStore(store);
  const record = await resolvedStore.getPackage(String(skillName || ''));
  return normalizeStoredMicroSkillRecord(record);
}

export async function saveStoredMicroSkillPackage(record, store = null) {
  const resolvedStore = ensureMicroSkillStore(store);
  const normalized = normalizeStoredMicroSkillRecord(record);
  if (!normalized) {
    throw new Error('无法保存无效的微型 skill package。');
  }
  await resolvedStore.savePackage(normalized);
  return normalized;
}

export async function deleteStoredMicroSkillPackage(skillName, store = null) {
  const resolvedStore = ensureMicroSkillStore(store);
  await resolvedStore.deletePackage(String(skillName || ''));
  return {
    ok: true,
    name: String(skillName || '')
  };
}

export async function listMatchingStoredMicroSkillPackagesForUrl(url, store = null) {
  const manifests = await listStoredMicroSkillManifests(store);
  const matchedManifests = manifests.filter((record) => microSkillMatchesUrl(record, url));
  const packages = await Promise.all(
    matchedManifests.map((record) => getStoredMicroSkillPackage(record.name, store))
  );
  return packages.filter(Boolean);
}

function buildNormalizedWriteFileInput(rawFile) {
  const file = ensurePlainObject(rawFile);
  return {
    path: normalizeMicroSkillFilePath(file.path),
    kind: normalizeOptionalString(file.kind) ? normalizeMicroSkillFileKind(file.kind) : null,
    content: (typeof file.content === 'string')
      ? file.content
      : ((typeof file.code === 'string') ? file.code : '')
  };
}

function buildMicroSkillRecordInputSchemaDescription() {
  return {
    type: ['object', 'null'],
    description: 'create/update 时使用的完整微型 skill package 对象。',
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      interface: {
        type: ['object', 'null'],
        additionalProperties: false,
        properties: {
          display_name: { type: ['string', 'null'] },
          short_description: { type: ['string', 'null'] },
          default_prompt: { type: ['string', 'null'] }
        }
      },
      match: {
        type: 'array',
        items: { type: 'string' }
      },
      enabled: { type: ['boolean', 'null'] },
      instruction: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' }
        },
        required: ['path']
      },
      runtime: {
        type: ['object', 'null'],
        additionalProperties: false,
        properties: {
          entry_path: { type: ['string', 'null'] }
        }
      },
      files: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string' },
            content: { type: 'string' }
          },
          required: ['path', 'content']
        }
      }
    },
    required: ['name', 'description', 'instruction', 'files']
  };
}

export function buildMicroSkillRegistryFunctionToolDefinition() {
  return {
    type: 'function',
    name: MICRO_SKILL_REGISTRY_TOOL_NAME,
    description: [
      '管理浏览器里的微型 skill。',
      '支持列出 skill、读取详情和文件、创建和更新 skill、写入单个文件、对文件应用补丁，以及在需要时刷新当前网页。'
    ].join(' '),
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          description: '必填。支持 list、read_detail、read_package、read_file、write_file、apply_patch、create、update、delete_file、delete、enable、disable、refresh_current_document。'
        },
        skill_name: {
          type: ['string', 'null'],
          description: '读写单个 skill 时使用的稳定 key。'
        },
        file_path: {
          type: ['string', 'null'],
          description: '按单个文件读取或删除时使用的 skill 内部路径。'
        },
        set_as_instruction: {
          type: ['boolean', 'null'],
          description: 'write_file 时是否把该文件设为新的 instruction 文件。'
        },
        set_as_runtime_entry: {
          type: ['boolean', 'null'],
          description: 'write_file 时是否把该文件设为新的 runtime 入口文件。'
        },
        next_instruction_path: {
          type: ['string', 'null'],
          description: '删除 instruction 文件时，指定新的 instruction 文件路径。'
        },
        next_runtime_entry_path: {
          type: ['string', 'null'],
          description: '删除 runtime entry 文件时，指定新的 runtime 入口文件路径。'
        },
        file: {
          type: ['object', 'null'],
          description: '单个文件对象。用于 write_file。',
          additionalProperties: false,
          properties: {
            path: { type: 'string' },
            content: { type: 'string' }
          },
          required: ['path', 'content']
        },
        patch: {
          type: ['string', 'null'],
          description: '补丁文本。使用 `*** Begin Patch`、`*** Update File:`、`*** Add File:`、`*** Delete File:`、`*** End Patch` 这套格式。'
        },
        skip_chars: {
          type: ['integer', 'null'],
          description: 'read_detail、read_package、read_file 时可用。从指定字符偏移开始读取正文。'
        },
        max_chars: {
          type: ['integer', 'null'],
          description: `read_detail、read_package、read_file 时可用。本次最多返回的正文字符数。默认 ${MICRO_SKILL_READ_DEFAULT_RANGE_CHARS}，最大 ${MICRO_SKILL_READ_MAX_CHARS}。`
        },
        start_line: {
          type: ['integer', 'null'],
          description: 'read_detail、read_file 时可用。从指定行号开始读取正文。必须与 end_line 一起提供，且不能和 skip_chars/max_chars 同时使用。'
        },
        end_line: {
          type: ['integer', 'null'],
          description: 'read_detail、read_file 时可用。读取到指定结束行。必须与 start_line 一起提供，且不能和 skip_chars/max_chars 同时使用。'
        },
        skill: buildMicroSkillRecordInputSchemaDescription()
      },
      required: ['action']
    }
  };
}

export function normalizeMicroSkillRegistryToolArguments(rawArgs) {
  const args = ensurePlainObject(rawArgs);
  const rawAction = normalizeString(args.action).toLowerCase();
  const legacyActionMap = {
    save: 'update',
    get: 'read_detail',
    refresh: 'refresh_current_document',
    read_source: 'read_package',
    read_source_file: 'read_file',
    upsert_source_file: 'write_file',
    delete_source_file: 'delete_file'
  };
  const action = legacyActionMap[rawAction] || rawAction;
  const skillName = normalizeOptionalString(args.skill_name || args.script_id);
  const filePath = normalizeOptionalString(args.file_path);

  if (!action) {
    throw new Error('micro_skill_registry 参数错误：action 不能为空。');
  }

  const supportedActions = new Set([
    'list',
    'read_detail',
    'read_package',
    'read_file',
    'write_file',
    'apply_patch',
    'create',
    'update',
    'delete_file',
    'delete',
    'enable',
    'disable',
    'refresh_current_document'
  ]);
  if (!supportedActions.has(action)) {
    throw new Error(`micro_skill_registry 参数错误：不支持的 action \`${action}\`。`);
  }

  if (action === 'list') {
    return {
      action,
      skill_name: null,
      skill: null,
      file_path: null,
      file: null,
      patch: null,
      read_options: null,
      set_as_instruction: false,
      set_as_runtime_entry: false,
      next_instruction_path: null,
      next_runtime_entry_path: null
    };
  }

  if (action === 'create' || action === 'update') {
    return {
      action,
      skill_name: null,
      skill: normalizeMicroSkillInput(args.skill, {
        requireFiles: true,
        requireContent: true
      }),
      file_path: null,
      file: null,
      patch: null,
      read_options: null,
      set_as_instruction: false,
      set_as_runtime_entry: false,
      next_instruction_path: null,
      next_runtime_entry_path: null
    };
  }

  if (action === 'refresh_current_document') {
    return {
      action,
      skill_name: skillName,
      skill: null,
      file_path: null,
      file: null,
      patch: null,
      read_options: null,
      set_as_instruction: false,
      set_as_runtime_entry: false,
      next_instruction_path: null,
      next_runtime_entry_path: null
    };
  }

  if (!skillName) {
    throw new Error(`micro_skill_registry 参数错误：action=${action} 时 skill_name 不能为空。`);
  }

  if (action === 'read_file' || action === 'delete_file') {
    if (!filePath) {
      throw new Error(`micro_skill_registry 参数错误：action=${action} 时 file_path 不能为空。`);
    }
    return {
      action,
      skill_name: skillName,
      skill: null,
      file_path: normalizeMicroSkillFilePath(filePath),
      file: null,
      patch: null,
      read_options: action === 'read_file'
        ? normalizeMicroSkillReadRangeArgs(args, {
          allowLineRange: true
        })
        : null,
      set_as_instruction: false,
      set_as_runtime_entry: false,
      next_instruction_path: normalizeOptionalString(args.next_instruction_path)
        ? normalizeMicroSkillFilePath(args.next_instruction_path)
        : null,
      next_runtime_entry_path: normalizeOptionalString(args.next_runtime_entry_path || args.next_entry_path)
        ? normalizeMicroSkillFilePath(args.next_runtime_entry_path || args.next_entry_path)
        : null
    };
  }

  if (action === 'write_file') {
    if (!args.file || typeof args.file !== 'object') {
      throw new Error('micro_skill_registry 参数错误：write_file 时 file 不能为空。');
    }
    return {
      action,
      skill_name: skillName,
      skill: null,
      file_path: null,
      file: buildNormalizedWriteFileInput(args.file),
      patch: null,
      read_options: null,
      set_as_instruction: normalizeBoolean(args.set_as_instruction, false),
      set_as_runtime_entry: normalizeBoolean(args.set_as_runtime_entry || args.set_as_entry, false),
      next_instruction_path: null,
      next_runtime_entry_path: null
    };
  }

  if (action === 'apply_patch') {
    const patch = (typeof args.patch === 'string') ? args.patch : '';
    if (!patch.trim()) {
      throw new Error('micro_skill_registry 参数错误：apply_patch 时 patch 不能为空。');
    }
    return {
      action,
      skill_name: skillName,
      skill: null,
      file_path: null,
      file: null,
      patch,
      read_options: null,
      set_as_instruction: false,
      set_as_runtime_entry: false,
      next_instruction_path: null,
      next_runtime_entry_path: null
    };
  }

  if (action === 'read_detail' || action === 'read_package') {
    return {
      action,
      skill_name: skillName,
      skill: null,
      file_path: null,
      file: null,
      patch: null,
      read_options: normalizeMicroSkillReadRangeArgs(args, {
        allowLineRange: action === 'read_detail'
      }),
      set_as_instruction: false,
      set_as_runtime_entry: false,
      next_instruction_path: null,
      next_runtime_entry_path: null
    };
  }

  return {
    action,
    skill_name: skillName,
    skill: null,
    file_path: null,
    file: null,
    patch: null,
    read_options: null,
    set_as_instruction: false,
    set_as_runtime_entry: false,
    next_instruction_path: null,
    next_runtime_entry_path: null
  };
}
