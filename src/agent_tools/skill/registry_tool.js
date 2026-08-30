/**
 * 浏览器 skill 注册表。
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

import { getBuiltinSkillRecordByName, getBuiltinSkillRecords } from './builtin_creator.js';
import { createIndexedDbSkillStore, SKILL_DB_NAME } from '../../storage/skill_store.js';
import {
  buildDefaultSkillMountContract as buildSharedDefaultSkillMountContract,
  normalizeSkillScaffoldName,
  SKILL_SCAFFOLD_ALLOWED_RESOURCES,
  titleCaseSkillName
} from './skill_scaffold.js';
import {
  buildModelToolDescription,
  buildStrictFunctionToolDefinition,
  buildStrictObjectSchema
} from '../shared/model_tool_contract.js';
import {
  matchesVirtualPathFilter,
  normalizeVirtualFilePath,
  normalizeVirtualPathFilter
} from '../shared/virtual_file_path.js';
import {
  buildVirtualTextReadResult,
  searchVirtualTextDocuments
} from '../virtual_file_io/text_query.js';

export const SKILL_REGISTRY_TOOL_NAME = 'skill_registry';
export const SKILL_REGISTRY_STORAGE_KEY = 'skill_registry_v1';
export const SKILL_REGISTRY_DB_NAME = SKILL_DB_NAME;
export const SKILL_REGISTRY_VERSION = 2;
export const SKILL_MATCH_ALL_URLS = '<all_urls>';
export const CEREBR_SKILL_MOUNT_SURFACE = 'globalThis.__cerebrSkills';
export const SKILL_VIRTUAL_MANIFEST_PATH = 'manifest.json';

const SKILL_KIND_PAGE_RUNTIME = 'page_runtime';
const SKILL_KIND_GUIDANCE = 'guidance';
const SKILL_KIND_BUILTIN_GUIDANCE = 'builtin_guidance';
const SKILL_FILE_KIND_INSTRUCTION = 'instruction';
const SKILL_FILE_KIND_RUNTIME_SOURCE = 'runtime_source';
const SKILL_FILE_KIND_REFERENCE = 'reference';
const SKILL_FILE_KIND_UI_METADATA = 'ui_metadata';
const SKILL_FILE_KIND_TEMPLATE = 'template';
const SKILL_DEFAULT_INSTRUCTION_PATH = 'SKILL.md';
const SKILL_DEFAULT_RUNTIME_ENTRY_PATH = 'src/main.js';

function normalizeString(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

function normalizeOptionalString(value) {
  const text = normalizeString(value);
  return text || null;
}

function normalizeSingleLineText(value) {
  return (typeof value === 'string') ? value.replace(/\s+/g, ' ').trim() : '';
}

function normalizeBoolean(value, fallback = false) {
  return (typeof value === 'boolean') ? value : fallback;
}

function ensurePlainObject(value) {
  return (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
}

function isSkillVirtualManifestPath(value) {
  return normalizeSkillFilePath(value) === SKILL_VIRTUAL_MANIFEST_PATH;
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

export function normalizeSkillName(value) {
  const name = normalizeString(value).toLowerCase();
  if (!name) {
    throw new Error('skill_registry 参数错误：skill.name 不能为空。');
  }
  if (!/^[a-z0-9-]{1,64}$/.test(name)) {
    throw new Error('skill_registry 参数错误：skill.name 只支持小写字母、数字、连字符，且长度不能超过 64。');
  }
  return name;
}

export function assertCanonicalSkillName(value, options = {}) {
  if (typeof value !== 'string') {
    throw new Error(`${options?.label || 'skill_name'} 必须是字符串。`);
  }
  const requested = value.trim();
  const canonical = normalizeSkillName(requested);
  if (value !== requested || requested !== canonical) {
    throw new Error(`${options?.label || 'skill_name'} 必须使用精确的稳定 key \`${canonical}\`。`);
  }
  return canonical;
}

function normalizeSkillKind(value, fallback = null) {
  const text = normalizeString(value).toLowerCase();
  if (!text) return fallback;
  if (
    text === SKILL_KIND_PAGE_RUNTIME
    || text === SKILL_KIND_GUIDANCE
    || text === SKILL_KIND_BUILTIN_GUIDANCE
  ) {
    return text;
  }
  throw new Error(`skill_registry 参数错误：不支持的 skill.kind \`${value}\`。`);
}

export function normalizeSkillFileKind(value) {
  const text = normalizeString(value).toLowerCase();
  const supportedKinds = new Set([
    SKILL_FILE_KIND_INSTRUCTION,
    SKILL_FILE_KIND_RUNTIME_SOURCE,
    SKILL_FILE_KIND_REFERENCE,
    SKILL_FILE_KIND_UI_METADATA,
    SKILL_FILE_KIND_TEMPLATE
  ]);
  if (!supportedKinds.has(text)) {
    throw new Error(`skill_registry 参数错误：不支持的文件 kind \`${value}\`。`);
  }
  return text;
}

function getSkillFileExtension(filePath) {
  const normalizedPath = normalizeSkillFilePath(filePath);
  const lastSlashIndex = normalizedPath.lastIndexOf('/');
  const filename = lastSlashIndex >= 0 ? normalizedPath.slice(lastSlashIndex + 1) : normalizedPath;
  const lastDotIndex = filename.lastIndexOf('.');
  return lastDotIndex >= 0 ? filename.slice(lastDotIndex).toLowerCase() : '';
}

function pathStartsWithAnyPrefix(filePath, prefixes) {
  const normalizedPath = normalizeSkillFilePath(filePath).toLowerCase();
  return prefixes.some((prefix) => normalizedPath.startsWith(String(prefix || '').toLowerCase()));
}

export function isSkillRuntimeSourcePath(filePath) {
  const extension = getSkillFileExtension(filePath);
  return extension === '.js' || extension === '.mjs' || extension === '.cjs';
}

export function pickDefaultSkillInstructionPath(files) {
  const normalizedFiles = Array.isArray(files) ? files : [];
  const exactDefault = normalizedFiles.find((file) => file.path === SKILL_DEFAULT_INSTRUCTION_PATH);
  if (exactDefault) return exactDefault.path;
  const markdownFile = normalizedFiles.find((file) => {
    const extension = getSkillFileExtension(file.path);
    return extension === '.md' || extension === '.markdown';
  });
  if (markdownFile) return markdownFile.path;
  return normalizedFiles[0]?.path || null;
}

export function pickDefaultSkillRuntimeEntryPath(files) {
  const normalizedFiles = Array.isArray(files) ? files : [];
  const exactDefault = normalizedFiles.find((file) => file.path === SKILL_DEFAULT_RUNTIME_ENTRY_PATH);
  if (exactDefault) return exactDefault.path;
  const srcRuntimeFile = normalizedFiles.find((file) => (
    pathStartsWithAnyPrefix(file.path, ['src/']) && isSkillRuntimeSourcePath(file.path)
  ));
  if (srcRuntimeFile) return srcRuntimeFile.path;
  const anyRuntimeFile = normalizedFiles.find((file) => isSkillRuntimeSourcePath(file.path));
  return anyRuntimeFile?.path || null;
}

export function inferSkillFileKindForPath(filePath, options = {}) {
  const normalizedPath = normalizeSkillFilePath(filePath);
  const instructionPath = options?.instructionPath ? normalizeSkillFilePath(options.instructionPath) : null;
  const runtimeEntryPath = options?.runtimeEntryPath ? normalizeSkillFilePath(options.runtimeEntryPath) : null;
  const explicitKind = options?.explicitKind ? normalizeSkillFileKind(options.explicitKind) : null;

  if (instructionPath && normalizedPath === instructionPath) {
    return SKILL_FILE_KIND_INSTRUCTION;
  }
  if (runtimeEntryPath && normalizedPath === runtimeEntryPath) {
    return SKILL_FILE_KIND_RUNTIME_SOURCE;
  }
  if (pathStartsWithAnyPrefix(normalizedPath, ['template/', 'templates/'])) {
    return SKILL_FILE_KIND_TEMPLATE;
  }
  if (pathStartsWithAnyPrefix(normalizedPath, ['ui/', 'meta/', 'metadata/'])) {
    return SKILL_FILE_KIND_UI_METADATA;
  }
  if (explicitKind) {
    return explicitKind;
  }
  if (isSkillRuntimeSourcePath(normalizedPath)) {
    return SKILL_FILE_KIND_RUNTIME_SOURCE;
  }
  return SKILL_FILE_KIND_REFERENCE;
}

function normalizeSkillInterface(rawInterface, fallbackDescription = '') {
  const input = ensurePlainObject(rawInterface);
  return {
    display_name: normalizeOptionalString(input.display_name),
    short_description: normalizeOptionalString(input.short_description) || normalizeOptionalString(fallbackDescription),
    default_prompt: normalizeOptionalString(input.default_prompt)
  };
}

function buildSkillCreateTemplateInterface(rawInterface, description, normalizedName) {
  const input = ensurePlainObject(rawInterface);
  const displayName = normalizeSingleLineText(input.display_name) || titleCaseSkillName(normalizedName);
  const shortDescription = normalizeSingleLineText(input.short_description) || description;
  const defaultPrompt = normalizeSingleLineText(input.default_prompt) || null;
  return {
    display_name: displayName,
    short_description: shortDescription,
    default_prompt: defaultPrompt
  };
}

function normalizeSkillCreateTemplateResources(rawResources) {
  const values = Array.isArray(rawResources) ? rawResources : [];
  const normalized = [];
  const seen = new Set();
  for (const value of values) {
    const resource = normalizeString(value).toLowerCase();
    if (!resource) continue;
    if (!SKILL_SCAFFOLD_ALLOWED_RESOURCES.includes(resource)) {
      throw new Error(`skill_registry 参数错误：create_skill.resources 不支持 \`${value}\`，只允许 ${SKILL_SCAFFOLD_ALLOWED_RESOURCES.join(', ')}。`);
    }
    if (seen.has(resource)) continue;
    seen.add(resource);
    normalized.push(resource);
  }
  return normalized;
}

function normalizeSkillCreateTemplateInput(rawSkill) {
  const skill = ensurePlainObject(rawSkill);
  const unexpectedKeys = Object.keys(skill).filter((key) => ![
    'name',
    'description',
    'interface',
    'enabled',
    'resources',
    'examples'
  ].includes(key));
  if (unexpectedKeys.length > 0) {
    throw new Error(`skill_registry 参数错误：create_skill.skill 不接受字段 ${unexpectedKeys.join(', ')}。`);
  }
  if (skill.interface != null) {
    const skillInterface = ensurePlainObject(skill.interface);
    const unexpectedInterfaceKeys = Object.keys(skillInterface).filter((key) => ![
      'display_name',
      'short_description',
      'default_prompt'
    ].includes(key));
    if (unexpectedInterfaceKeys.length > 0) {
      throw new Error(`skill_registry 参数错误：create_skill.skill.interface 不接受字段 ${unexpectedInterfaceKeys.join(', ')}。`);
    }
  }
  const requestedName = normalizeString(skill.name);
  if (!requestedName) {
    throw new Error('skill_registry 参数错误：create_skill.skill.name 不能为空。');
  }
  const normalizedName = normalizeSkillScaffoldName(requestedName);
  if (!normalizedName) {
    throw new Error('skill_registry 参数错误：create_skill.skill.name 归一化后不能为空。');
  }
  const safeName = normalizeSkillName(normalizedName);
  const description = normalizeSingleLineText(skill.description);
  if (!description) {
    throw new Error('skill_registry 参数错误：create_skill.skill.description 不能为空。');
  }
  const resources = normalizeSkillCreateTemplateResources(skill.resources);
  const examples = normalizeBoolean(skill.examples, false);
  if (examples && resources.length <= 0) {
    throw new Error('skill_registry 参数错误：create_skill.skill.examples=true 时必须同时提供 create_skill.skill.resources。');
  }
  return {
    requested_name: requestedName,
    name: safeName,
    description,
    interface: buildSkillCreateTemplateInterface(skill.interface, description, safeName),
    match: normalizeSkillMatchPatterns(skill.match, { allowEmpty: true }),
    enabled: normalizeBoolean(skill.enabled, false),
    resources,
    examples
  };
}

export function normalizeSkillFilePath(value) {
  return normalizeVirtualFilePath(value, { label: 'files[].path' });
}

function buildEditableSkillManifestObject(skill) {
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

export function serializeSkillVirtualManifest(record) {
  const skill = normalizeStoredSkillRecord(record);
  if (!skill) {
    throw new Error('无法为无效的技能生成 manifest 虚拟文件。');
  }
  return `${JSON.stringify(buildEditableSkillManifestObject(skill), null, 2)}\n`;
}

function assertExactObjectKeys(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`skill_registry 参数错误：${label} 必须是 JSON object。`);
  }
  const actualKeys = Object.keys(value).sort();
  const requiredKeys = [...expectedKeys].sort();
  const unexpected = actualKeys.filter((key) => !requiredKeys.includes(key));
  const missing = requiredKeys.filter((key) => !actualKeys.includes(key));
  if (unexpected.length > 0 || missing.length > 0) {
    const details = [
      unexpected.length > 0 ? `未知字段 ${unexpected.join(', ')}` : '',
      missing.length > 0 ? `缺少字段 ${missing.join(', ')}` : ''
    ].filter(Boolean).join('；');
    throw new Error(`skill_registry 参数错误：${label} 字段不完整（${details}）。`);
  }
  return value;
}

function readNullableManifestString(value, label) {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`skill_registry 参数错误：${label} 必须是 string 或 null。`);
  }
  return value.trim() || null;
}

export function parseSkillVirtualManifestContent(content, existingRecord = null) {
  const existing = existingRecord ? normalizeStoredSkillRecord(existingRecord) : null;
  let parsed = null;
  try {
    parsed = JSON.parse(String(content || ''));
  } catch (error) {
    throw new Error(`skill_registry 参数错误：manifest.json 不是合法 JSON：${error?.message || error}`);
  }
  const manifest = assertExactObjectKeys(parsed, [
    'description',
    'interface',
    'match',
    'enabled',
    'instruction',
    'runtime'
  ], 'manifest.json');
  const manifestInterface = assertExactObjectKeys(manifest.interface, [
    'display_name',
    'short_description',
    'default_prompt'
  ], 'manifest.json.interface');
  const manifestInstruction = assertExactObjectKeys(manifest.instruction, ['path'], 'manifest.json.instruction');
  const manifestRuntime = assertExactObjectKeys(manifest.runtime, ['entry_path'], 'manifest.json.runtime');
  const description = typeof manifest.description === 'string' ? manifest.description.trim() : '';
  if (!description) {
    throw new Error('skill_registry 参数错误：manifest.json.description 必须是非空字符串。');
  }
  if (!Array.isArray(manifest.match) || manifest.match.some((item) => typeof item !== 'string')) {
    throw new Error('skill_registry 参数错误：manifest.json.match 必须是 string 数组。');
  }
  if (typeof manifest.enabled !== 'boolean') {
    throw new Error('skill_registry 参数错误：manifest.json.enabled 必须是 boolean。');
  }
  if (typeof manifestInstruction.path !== 'string' || !manifestInstruction.path.trim()) {
    throw new Error('skill_registry 参数错误：manifest.json.instruction.path 必须是非空字符串。');
  }
  const runtimeEntryPath = readNullableManifestString(
    manifestRuntime.entry_path,
    'manifest.json.runtime.entry_path'
  );

  return {
    kind: existing?.builtin === true ? existing.kind : null,
    name: existing?.name || null,
    description,
    interface: {
      display_name: readNullableManifestString(manifestInterface.display_name, 'manifest.json.interface.display_name'),
      short_description: readNullableManifestString(manifestInterface.short_description, 'manifest.json.interface.short_description'),
      default_prompt: readNullableManifestString(manifestInterface.default_prompt, 'manifest.json.interface.default_prompt')
    },
    match: [...manifest.match],
    enabled: manifest.enabled,
    instruction: {
      path: normalizeSkillFilePath(manifestInstruction.path)
    },
    runtime: {
      entry_path: runtimeEntryPath ? normalizeSkillFilePath(runtimeEntryPath) : null
    }
  };
}

function buildSkillVirtualManifestFile(record, options = {}) {
  const skill = normalizeStoredSkillRecord(record);
  if (!skill) return null;
  return {
    path: SKILL_VIRTUAL_MANIFEST_PATH,
    kind: null,
    is_virtual: true,
    is_manifest: true,
    is_instruction: false,
    is_runtime_entry: false,
    ...(options?.includeContent === true
      ? { content: serializeSkillVirtualManifest(skill) }
      : {})
  };
}

function buildSkillResolvedFiles(record, options = {}) {
  const skill = normalizeStoredSkillRecord(record);
  if (!skill) return [];
  const includeContent = options?.includeContent !== false;
  const files = skill.files.map((file) => ({
    skill_name: skill.name,
    path: file.path,
    kind: file.kind,
    is_manifest: false,
    is_instruction: file.path === skill.instruction.path,
    is_runtime_entry: !!skill.runtime.entry_path && file.path === skill.runtime.entry_path,
    ...(includeContent ? { content: file.content } : {})
  }));
  const manifestFile = buildSkillVirtualManifestFile(skill, { includeContent });
  if (manifestFile) {
    files.unshift({
      skill_name: skill.name,
      path: manifestFile.path,
      kind: null,
      is_manifest: true,
      is_instruction: false,
      is_runtime_entry: false,
      ...(includeContent ? { content: manifestFile.content } : {})
    });
  }
  return files;
}

function normalizeSkillFile(rawFile, options = {}) {
  const file = ensurePlainObject(rawFile);
  const path = normalizeSkillFilePath(file.path);
  const requireContent = options?.requireContent !== false;
  if (requireContent && typeof file.content !== 'string') {
    throw new Error(`skill_registry 参数错误：files[\`${path}\`].content 必须是字符串。`);
  }
  if (!requireContent && file.content != null && typeof file.content !== 'string') {
    throw new Error(`skill_registry 参数错误：files[\`${path}\`].content 必须是字符串。`);
  }
  const content = typeof file.content === 'string' ? file.content : '';
  const explicitKind = (typeof file.kind === 'string' && file.kind.trim())
    ? normalizeSkillFileKind(file.kind)
    : null;

  return {
    path,
    kind: explicitKind,
    content
  };
}

function normalizeSkillFiles(rawFiles, options = {}) {
  const input = Array.isArray(rawFiles) ? rawFiles : [];
  const requireFiles = options?.requireFiles !== false;
  if (requireFiles && input.length <= 0) {
    throw new Error('skill_registry 参数错误：skill.files 至少需要提供 1 个文件。');
  }

  const files = [];
  const seenPaths = new Set();
  input.forEach((rawFile) => {
    const file = normalizeSkillFile(rawFile, {
      requireContent: options?.requireContent !== false
    });
    if (seenPaths.has(file.path)) {
      throw new Error(`skill_registry 参数错误：files 中存在重复路径 \`${file.path}\`。`);
    }
    seenPaths.add(file.path);
    files.push(file);
  });
  return files;
}

function normalizeSkillInstruction(rawInstruction, files) {
  const input = ensurePlainObject(rawInstruction);
  const requestedPath = normalizeOptionalString(input.path)
    ? normalizeSkillFilePath(input.path)
    : null;
  if (!requestedPath) {
    throw new Error('skill_registry 参数错误：skill.instruction.path 必须是非空字符串。');
  }
  const instructionFile = files.find((file) => file.path === requestedPath) || null;

  if (!instructionFile) {
    throw new Error('skill_registry 参数错误：skill.instruction.path 必须指向 files 中的说明文件。');
  }

  return {
    path: instructionFile.path
  };
}

function normalizeSkillRuntime(rawRuntime, files) {
  if (rawRuntime != null && (!rawRuntime || typeof rawRuntime !== 'object' || Array.isArray(rawRuntime))) {
    throw new Error('skill_registry 参数错误：skill.runtime 必须是 object 或 null。');
  }
  const input = rawRuntime || {};
  const rawEntryPath = Object.prototype.hasOwnProperty.call(input, 'entry_path')
    ? input.entry_path
    : null;
  if (rawEntryPath !== null && typeof rawEntryPath !== 'string') {
    throw new Error('skill_registry 参数错误：runtime.entry_path 必须是 string 或 null。');
  }
  const requestedPath = typeof rawEntryPath === 'string' && rawEntryPath.trim()
    ? normalizeSkillFilePath(rawEntryPath)
    : null;
  const runtimeEntryFile = requestedPath
    ? files.find((file) => file.path === requestedPath)
    : null;

  if (!requestedPath) {
    return { entry_path: null };
  }
  if (!runtimeEntryFile) {
    throw new Error(`skill_registry 参数错误：runtime.entry_path \`${requestedPath}\` 不存在于 files。`);
  }
  if (!isSkillRuntimeSourcePath(runtimeEntryFile.path)) {
    throw new Error(`skill_registry 参数错误：runtime.entry_path \`${runtimeEntryFile.path}\` 必须指向可执行的 JS runtime 文件。`);
  }
  return {
    entry_path: runtimeEntryFile.path
  };
}

function inferSkillKindFromContent(options = {}) {
  const explicitKind = normalizeSkillKind(options.kind, null);
  if (explicitKind) {
    return explicitKind;
  }
  if (options.builtin === true) {
    return SKILL_KIND_BUILTIN_GUIDANCE;
  }
  if (options.runtimeEntryPath && Array.isArray(options.match) && options.match.length > 0) {
    return SKILL_KIND_PAGE_RUNTIME;
  }
  return SKILL_KIND_GUIDANCE;
}

function countSkillRuntimeSourceFiles(files) {
  return (Array.isArray(files) ? files : []).filter((file) => file.kind === SKILL_FILE_KIND_RUNTIME_SOURCE).length;
}

function buildSkillRuntimeHint(record) {
  const skill = normalizeStoredSkillRecord(record);
  if (!skill) return null;
  const runtimeFileCount = countSkillRuntimeSourceFiles(skill.files);
  if (runtimeFileCount <= 0) {
    return null;
  }
  if (skill.runtime.entry_path) {
    return {
      has_runtime: true,
      runtime_entry_path: skill.runtime.entry_path,
      runtime_file_count: runtimeFileCount,
      runtime_hint: `This skill includes JS runtime files. Read SKILL.md first. Call its methods through $invoke inside js_runtime_execute; matching enabled skills are mounted automatically, for example: return await $invoke("${skill.name}", "methodName", args).`
    };
  }
  return {
    has_runtime: true,
    runtime_entry_path: null,
    runtime_file_count: runtimeFileCount,
    runtime_hint: 'This skill includes JS files, but no runtime.entry_path is configured yet. Read SKILL.md first, then inspect the JS files and manifest if you want to turn it into a page runtime skill. Browser code execution still goes through js_runtime_execute.'
  };
}

/**
 * 默认挂载说明。
 *
 * 这不是单独字段存储，而是用于生成默认 SKILL.md/内置指导文案时的公共片段。
 */
export function buildDefaultSkillMountContract() {
  return buildSharedDefaultSkillMountContract();
}

/**
 * 校验并规范化 Chrome/TM 风格 `@match`。
 */
export function normalizeSkillMatchPatterns(rawPatterns, options = {}) {
  const input = Array.isArray(rawPatterns) ? rawPatterns : [];
  const allowEmpty = options?.allowEmpty === true;
  if (!allowEmpty && input.length <= 0) {
    throw new Error('skill_registry 参数错误：skill.match 需要至少提供 1 条 `@match` 规则。');
  }

  const normalized = input.map((value) => normalizeString(value)).filter(Boolean);
  if (!allowEmpty && normalized.length <= 0) {
    throw new Error('skill_registry 参数错误：skill.match 里不能出现空规则。');
  }

  const unique = Array.from(new Set(normalized));
  unique.forEach((pattern) => {
    if (!isValidSkillMatchPattern(pattern)) {
      throw new Error(`skill_registry 参数错误：不支持的 match 规则 \`${pattern}\`。`);
    }
  });
  return unique;
}

export function isValidSkillMatchPattern(pattern) {
  const text = normalizeString(pattern);
  if (!text) return false;
  if (text === SKILL_MATCH_ALL_URLS) return true;

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

export function skillMatchPatternMatchesUrl(pattern, url) {
  const text = normalizeString(pattern);
  if (!text) return false;

  let parsedUrl = null;
  try {
    parsedUrl = new URL(url);
  } catch (_) {
    return false;
  }

  if (text === SKILL_MATCH_ALL_URLS) {
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

export function normalizeSkillInput(rawSkill, options = {}) {
  const skill = ensurePlainObject(rawSkill);
  const description = normalizeString(skill.description);
  if (!description) {
    throw new Error('skill_registry 参数错误：skill.description 不能为空。');
  }

  const rawFiles = Array.isArray(skill.files) ? skill.files : (
    Array.isArray(skill.files_meta) ? skill.files_meta : []
  );
  const rawNormalizedFiles = normalizeSkillFiles(rawFiles, {
    requireFiles: options?.requireFiles !== false,
    requireContent: options?.requireContent !== false
  });
  const instruction = normalizeSkillInstruction(skill.instruction, rawNormalizedFiles);
  const runtime = normalizeSkillRuntime(skill.runtime, rawNormalizedFiles);
  const requestedKind = normalizeSkillKind(skill.kind, null);
  const match = normalizeSkillMatchPatterns(skill.match, {
    allowEmpty: requestedKind !== SKILL_KIND_PAGE_RUNTIME || !runtime.entry_path
  });
  const kind = inferSkillKindFromContent({
    kind: requestedKind,
    builtin: skill.builtin === true,
    runtimeEntryPath: runtime.entry_path,
    match
  });
  if (kind === SKILL_KIND_PAGE_RUNTIME && !runtime.entry_path) {
    throw new Error('skill_registry 参数错误：page runtime skill 必须提供 runtime.entry_path。');
  }
  const files = rawNormalizedFiles.map((file) => ({
    ...file,
    kind: inferSkillFileKindForPath(file.path, {
      instructionPath: instruction.path,
      runtimeEntryPath: runtime.entry_path,
      explicitKind: file.kind
    })
  }));

  return {
    kind,
    name: normalizeSkillName(skill.name),
    description,
    interface: normalizeSkillInterface(skill.interface, description),
    match,
    enabled: normalizeBoolean(skill.enabled, true),
    instruction,
    runtime,
    files
  };
}

export function normalizeStoredSkillRecord(rawRecord) {
  if (rawRecord == null) return null;
  const record = ensurePlainObject(rawRecord);
  const hasFullFiles = record.has_file_contents === true
    || (
      Array.isArray(record.files)
      && record.files.some((file) => typeof file?.content === 'string')
    );
  const normalizedInput = normalizeSkillInput({
    ...record
  }, {
    requireFiles: true,
    requireContent: hasFullFiles
  });

  const createdAt = toIsoTimestamp(record.created_at) || new Date(0).toISOString();
  const updatedAt = toIsoTimestamp(record.updated_at) || createdAt;
  const builtin = record.builtin === true || normalizedInput.kind === SKILL_KIND_BUILTIN_GUIDANCE;

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

export function buildStoredSkillRecord(skillInput, existingRecord = null) {
  const normalizedInput = normalizeSkillInput(skillInput, {
    requireFiles: true,
    requireContent: true
  });
  const existing = normalizeStoredSkillRecord(existingRecord);
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

export function buildSkillFileManifest(record, options = {}) {
  const skill = normalizeStoredSkillRecord(record);
  if (!skill) return null;

  const includeContent = options?.includeContent === true;
  const contentReadArgs = options?.contentReadArgs || null;
  const onlyPaths = Array.isArray(options?.onlyPaths)
    ? new Set(options.onlyPaths.map((value) => normalizeSkillFilePath(value)))
    : null;
  const onlyKinds = Array.isArray(options?.onlyKinds)
    ? new Set(options.onlyKinds.map((value) => normalizeSkillFileKind(value)))
    : null;

  const selectedFiles = skill.files
    .filter((file) => (!onlyPaths || onlyPaths.has(file.path)) && (!onlyKinds || onlyKinds.has(file.kind)))
    .map((file) => ({
      path: file.path,
      kind: file.kind,
      is_instruction: file.path === skill.instruction.path,
      is_runtime_entry: !!skill.runtime.entry_path && file.path === skill.runtime.entry_path,
      ...(includeContent ? (() => {
        const contentRead = buildVirtualTextReadResult(file.content, contentReadArgs);
        return {
          content: contentRead.content,
          content_read: contentRead
        };
      })() : {})
    }));
  const manifestFile = buildSkillVirtualManifestFile(skill, { includeContent });
  if (manifestFile && includeContent) {
    const contentRead = buildVirtualTextReadResult(manifestFile.content, contentReadArgs);
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
    virtual_manifest_path: SKILL_VIRTUAL_MANIFEST_PATH,
    instruction_path: skill.instruction.path,
    runtime_entry_path: skill.runtime.entry_path,
    files: selectedFiles
  };
}

export function buildSkillSummary(record) {
  const skill = normalizeStoredSkillRecord(record);
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
      runtime_file_count: skill.files.filter((file) => file.kind === SKILL_FILE_KIND_RUNTIME_SOURCE).length
    },
    files: {
      total_count: skill.files.length + 1,
      by_kind: summarizeFileKinds(skill.files),
      virtual_manifest_path: SKILL_VIRTUAL_MANIFEST_PATH
    }
  };
}

export function buildSkillFilePayload(record, filePath, options = {}) {
  const skill = normalizeStoredSkillRecord(record);
  if (!skill) return null;
  const normalizedPath = normalizeSkillFilePath(filePath);
  if (isSkillVirtualManifestPath(normalizedPath)) {
    const manifestFile = buildSkillVirtualManifestFile(skill, { includeContent: true });
    const contentRead = buildVirtualTextReadResult(manifestFile.content, options?.contentReadArgs || null);
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
    throw new Error(`技能 ${skill.name} 中不存在文件 ${normalizedPath}。`);
  }
  const contentRead = buildVirtualTextReadResult(file.content, options?.contentReadArgs || null);
  const runtimeHint = normalizedPath === skill.instruction.path
    ? buildSkillRuntimeHint(skill)
    : null;
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
    ...(runtimeHint || {}),
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

export function buildSkillFileIndexPayload(records, options = {}) {
  const normalizedRecords = (Array.isArray(records) ? records : [records])
    .map((record) => normalizeStoredSkillRecord(record));
  const pathGlob = normalizeVirtualPathFilter(options?.path_glob, { label: 'path_glob' });
  const files = normalizedRecords.flatMap((record) => (
    buildSkillResolvedFiles(record, { includeContent: false })
      .filter((file) => matchesVirtualPathFilter(file.path, pathGlob))
      .map((file) => ({
        skill_name: record.name,
        path: file.path,
        size_chars: file.is_manifest
          ? serializeSkillVirtualManifest(record).length
          : (record.files.find((item) => item.path === file.path)?.content || '').length,
        is_manifest: file.is_manifest === true,
        is_instruction: file.is_instruction === true,
        is_runtime_entry: file.is_runtime_entry === true
      }))
  ));
  return {
    requested_skill_name: options?.requestedSkillName || null,
    path_glob: pathGlob,
    total_files: files.length,
    returned_file_count: files.length,
    files
  };
}

export function searchSkillFiles(records, rawOptions = {}) {
  const normalizedRecords = (Array.isArray(records) ? records : [records])
    .map((record) => normalizeStoredSkillRecord(record));
  const documents = normalizedRecords.flatMap((record) => (
    buildSkillResolvedFiles(record, { includeContent: true }).map((file) => ({
      skill_name: record.name,
      path: file.path,
      content: file.content
    }))
  ));
  return searchVirtualTextDocuments(documents, rawOptions);
}

export function buildSkillContextSummary(record) {
  const skill = normalizeStoredSkillRecord(record);
  if (!skill) return null;
  return {
    priority: skill.kind === SKILL_KIND_BUILTIN_GUIDANCE ? 0 : 1000,
    name: skill.name,
    short_description: skill.interface.short_description || skill.description,
    instruction_path: skill.instruction.path
  };
}

export function skillMatchesUrl(record, url) {
  const skill = normalizeStoredSkillRecord(record);
  if (!skill || skill.enabled !== true || skill.kind !== SKILL_KIND_PAGE_RUNTIME) return false;
  return skill.match.some((pattern) => skillMatchPatternMatchesUrl(pattern, url));
}

export function listBuiltinSkillRecords() {
  return getBuiltinSkillRecords();
}

export function getBuiltinSkillRecord(skillName) {
  return getBuiltinSkillRecordByName(skillName);
}

function ensureSkillStore(store = null) {
  const resolved = store || createIndexedDbSkillStore();
  const requiredMethods = ['listManifests', 'getManifest', 'getPackage', 'savePackage', 'deletePackage'];
  const missing = requiredMethods.filter((name) => typeof resolved?.[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(`当前环境没有可用的 skill store，缺少方法：${missing.join(', ')}`);
  }
  return resolved;
}

export async function listStoredSkillManifests(store = null) {
  const resolvedStore = ensureSkillStore(store);
  const manifests = await resolvedStore.listManifests();
  return (Array.isArray(manifests) ? manifests : [])
    .map((record) => normalizeStoredSkillRecord(record))
    .sort((left, right) => {
      const leftTs = Date.parse(left.updated_at || '') || 0;
      const rightTs = Date.parse(right.updated_at || '') || 0;
      if (leftTs !== rightTs) return rightTs - leftTs;
      return left.name.localeCompare(right.name);
    });
}

export async function getStoredSkillPackage(skillName, store = null) {
  const resolvedStore = ensureSkillStore(store);
  const canonicalName = assertCanonicalSkillName(String(skillName || ''), { label: 'skill_name' });
  const record = await resolvedStore.getPackage(canonicalName);
  return normalizeStoredSkillRecord(record);
}

export async function saveStoredSkillPackage(record, store = null, options = {}) {
  const resolvedStore = ensureSkillStore(store);
  const normalized = normalizeStoredSkillRecord(record);
  if (!normalized) {
    throw new Error('无法保存无效的 skill package。');
  }
  await resolvedStore.savePackage(normalized, options);
  return normalized;
}

export async function deleteStoredSkillPackage(skillName, store = null, options = {}) {
  const resolvedStore = ensureSkillStore(store);
  const canonicalName = assertCanonicalSkillName(String(skillName || ''), { label: 'skill_name' });
  await resolvedStore.deletePackage(canonicalName, options);
  return {
    ok: true,
    name: canonicalName
  };
}

export async function listMatchingStoredSkillPackagesForUrl(url, store = null) {
  const manifests = await listStoredSkillManifests(store);
  const matchedManifests = manifests.filter((record) => skillMatchesUrl(record, url));
  const packages = await Promise.all(
    matchedManifests.map((record) => getStoredSkillPackage(record.name, store))
  );
  const missingManifest = matchedManifests.find((_record, index) => !packages[index]);
  if (missingManifest) {
    throw new Error(`skill store 损坏：manifest ${missingManifest.name} 没有对应 package。`);
  }
  return packages;
}

function buildSkillCreateTemplateInputSchemaDescription() {
  return buildStrictObjectSchema({
    name: {
      type: 'string',
      description: 'skill 的显示输入名；系统会归一化为 hyphen-case 稳定 key。'
    },
    description: {
      type: 'string',
      description: '明确说明这个 skill 何时应触发，以及它解决什么任务。'
    },
    interface: buildStrictObjectSchema({
      display_name: {
        type: ['string', 'null'],
        description: '可选显示名；传 null 使用规范化 skill 名。'
      },
      short_description: {
        type: ['string', 'null'],
        description: '可选短说明；传 null 使用 description。'
      },
      default_prompt: {
        type: ['string', 'null'],
        description: '可选默认提示；没有时传 null。'
      }
    }, {
      nullable: true,
      description: '可选 UI 元数据；不需要自定义时传 null。'
    }),
    enabled: {
      type: ['boolean', 'null'],
      description: '是否创建后立即启用；null 表示 false。'
    },
    resources: {
      type: ['array', 'null'],
      maxItems: SKILL_SCAFFOLD_ALLOWED_RESOURCES.length,
      description: '要预建的资源目录；传 null 或 [] 不创建。只支持 scripts / references / assets。',
      items: {
        type: 'string',
        enum: [...SKILL_SCAFFOLD_ALLOWED_RESOURCES]
      }
    },
    examples: {
      type: ['boolean', 'null'],
      description: 'true 时为已选择 resources 生成示例文件；false 或 null 不生成。resources 为空时不能为 true。'
    }
  }, {
    nullable: true,
    description: '仅 action=create_skill 时传入；其它 action 必须传 null。'
  });
}

export function buildSkillRegistryFunctionToolDefinition(pageToolEnvironment = null) {
  const exposeHostPageTools = pageToolEnvironment?.exposeHostPageTools !== false;
  const scopeDescription = exposeHostPageTools
    ? '`list` 默认返回当前页可见的 Skill，include_all_sites=true 返回全部 Skill'
    : '`list` 默认返回内置和 guidance Skill，include_all_sites=true 返回全部 Skill';
  const publicActions = exposeHostPageTools
    ? ['list', 'create_skill', 'delete_skill', 'enable_skill', 'disable_skill', 'mount_on_current_page']
    : ['list', 'create_skill', 'delete_skill', 'enable_skill', 'disable_skill'];
  const actionDescription = `公开 action：${publicActions.join('、')}。只传其中一个精确值。`;
  const includeAllSitesDescription = exposeHostPageTools
    ? '仅 action=list 时使用。true 表示忽略当前页面 URL，返回所有已注册 skill；默认 false，只返回当前页可见的 skill。'
    : '仅 action=list 时使用。true 表示忽略网站过滤返回所有已注册 skill；默认 false 时不读取当前页面，只返回内置和 guidance skill。';
  return buildStrictFunctionToolDefinition({
    name: SKILL_REGISTRY_TOOL_NAME,
    description: buildModelToolDescription({
      purpose: '列出、创建、启用、停用、删除 Cerebr Skill，并在支持时挂载到当前页。',
      input: `${scopeDescription}；list 使用 include_all_sites；create_skill 使用 skill；其余动作使用 skill_name；不适用字段传 null。`,
      output: '返回 Skill 清单或本次生命周期操作的明确结果。'
    }),
    properties: {
      action: {
        type: 'string',
        enum: publicActions,
        description: actionDescription
      },
      include_all_sites: {
        type: ['boolean', 'null'],
        description: includeAllSitesDescription
      },
      skill_name: {
        type: ['string', 'null'],
        description: 'delete_skill、enable_skill、disable_skill、mount_on_current_page 的目标稳定 key；其它 action 传 null。'
      },
      skill: buildSkillCreateTemplateInputSchemaDescription()
    }
  });
}

export function normalizeSkillRegistryToolArguments(rawArgs) {
  const args = ensurePlainObject(rawArgs);
  const unexpectedKeys = Object.keys(args).filter((key) => ![
    'action',
    'include_all_sites',
    'skill_name',
    'skill'
  ].includes(key));
  if (unexpectedKeys.length > 0) {
    throw new Error(`skill_registry 参数错误：不接受参数 ${unexpectedKeys.join(', ')}。`);
  }
  const action = normalizeString(args.action).toLowerCase();

  if (!action) {
    throw new Error('skill_registry 参数错误：action 不能为空。');
  }

  const supportedActions = new Set([
    'list',
    'create_skill',
    'delete_skill',
    'enable_skill',
    'disable_skill',
    'mount_on_current_page'
  ]);
  if (!supportedActions.has(action)) {
    throw new Error(`skill_registry 参数错误：不支持的 action \`${action}\`。`);
  }

  if (action === 'list') {
    if (args.skill_name != null || args.skill != null) {
      throw new Error('skill_registry 参数错误：action=list 时 skill_name 与 skill 必须为 null。');
    }
    if (args.include_all_sites != null && typeof args.include_all_sites !== 'boolean') {
      throw new Error('skill_registry 参数错误：include_all_sites 必须是 boolean 或 null。');
    }
    return {
      action,
      include_all_sites: normalizeBoolean(args.include_all_sites, false),
      skill_name: null,
      skill: null
    };
  }

  if (action === 'create_skill') {
    if (args.include_all_sites != null || args.skill_name != null) {
      throw new Error('skill_registry 参数错误：action=create_skill 时 include_all_sites 与 skill_name 必须为 null。');
    }
    return {
      action,
      skill_name: null,
      skill: normalizeSkillCreateTemplateInput(args.skill)
    };
  }

  if (args.include_all_sites != null || args.skill != null) {
    throw new Error(`skill_registry 参数错误：action=${action} 时 include_all_sites 与 skill 必须为 null。`);
  }
  const skillName = assertCanonicalSkillName(args.skill_name, { label: 'skill_name' });

  if (action === 'mount_on_current_page') {
    return {
      action,
      skill_name: skillName,
      skill: null
    };
  }

  if (action === 'delete_skill' || action === 'enable_skill' || action === 'disable_skill') {
    return {
      action,
      skill_name: skillName,
      skill: null
    };
  }

  throw new Error(`skill_registry 参数错误：未处理的 action \`${action}\`。`);
}
