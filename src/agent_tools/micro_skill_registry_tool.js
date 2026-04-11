/**
 * Cerebr 浏览器微型 Skill 注册表。
 *
 * 这一版直接把源码模型升级为“多文件/代码片段 bundle”：
 * - skill.source.entry: 入口文件路径；
 * - skill.source.files: 若干 `{ path, code }` 片段；
 * - runtime 侧会把这些片段当成一个 skill 内部的模块集合来挂载。
 *
 * 设计目标：
 * - 扩展侧只维护一份 `chrome.storage.local` 注册表；
 * - summary / detail / source 继续遵循渐进式披露；
 * - 模型既可以一次全读整份源码 bundle，也可以按单个“文件/片段”做 CRUD。
 */

import { getBuiltinMicroSkillRecordByName, getBuiltinMicroSkillRecords } from './builtin_micro_skill_creator.js';

export const MICRO_SKILL_REGISTRY_TOOL_NAME = 'micro_skill_registry';
export const MICRO_SKILL_REGISTRY_STORAGE_KEY = 'micro_skill_registry_v1';
export const MICRO_SKILL_REGISTRY_VERSION = 1;
export const MICRO_SKILL_MATCH_ALL_URLS = '<all_urls>';
export const CEREBR_MICRO_SKILL_MOUNT_SURFACE = 'globalThis.__cerebrMicroSkills';

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

function ensurePlainObject(value) {
  return (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
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

/**
 * 微型 skill 的默认挂载合同文本。
 *
 * 当前强调三件事：
 * - 页面可见的 runtime surface；
 * - 多文件 bundle 的 authoring 约定；
 * - helper 文件通过 async require 进行拆分。
 *
 * @returns {string}
 */
export function buildDefaultMicroSkillMountContract() {
  return [
    'Mount surface: `globalThis.__cerebrMicroSkills`.',
    'Use `globalThis.__cerebrMicroSkills.skills[name]` to access mounted exports.',
    'Use `globalThis.__cerebrMicroSkills.invoke("skill.method", ...args)` to call a mounted method.',
    'Source bundle contract: save code as `source.entry` + `source.files[]`, where each file is a `{ path, code }` snippet.',
    'Each file runs as an async CommonJS-like body with `ctx`, `module`, `exports`, `require` available.',
    '`require()` is async in this runtime, so helper imports should use `await require("./helper.js")`.',
    'Entry file can `return { methods... }`, or assign `module.exports = { ... }`; advanced style: call `ctx.mount(exports)` manually.',
    'Helper files can use `return ...` or `module.exports = ...` to expose values to the entry file.',
    'Optional cleanup: if the mounted exports object exposes `dispose()`, Cerebr may call it before unmount / remount.'
  ].join('\n');
}

function normalizeMicroSkillInterface(rawInterface, fallbackDescription = '') {
  const input = ensurePlainObject(rawInterface);
  return {
    display_name: normalizeOptionalString(input.display_name),
    short_description: normalizeOptionalString(input.short_description) || normalizeOptionalString(fallbackDescription),
    default_prompt: normalizeOptionalString(input.default_prompt)
  };
}

export function normalizeMicroSkillSourceFilePath(value) {
  const rawPath = normalizeString(value).replace(/\\/g, '/');
  const withoutLeadingDot = rawPath.replace(/^(?:\.\/)+/, '');
  const normalizedPath = withoutLeadingDot.startsWith('/')
    ? withoutLeadingDot.slice(1)
    : withoutLeadingDot;

  if (!normalizedPath) {
    throw new Error('micro_skill_registry 参数错误：source.files[].path 不能为空。');
  }
  if (normalizedPath.length > 256) {
    throw new Error('micro_skill_registry 参数错误：source.files[].path 长度不能超过 256。');
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

export function normalizeMicroSkillSourceFile(rawFile, options = {}) {
  const file = ensurePlainObject(rawFile);
  const path = normalizeMicroSkillSourceFilePath(file.path);
  const code = (typeof file.code === 'string') ? file.code : '';
  const requireCode = options?.requireCode !== false;
  if (requireCode && !code.trim()) {
    throw new Error(`micro_skill_registry 参数错误：source.files[\`${path}\`].code 不能为空。`);
  }
  return { path, code };
}

export function normalizeMicroSkillSource(rawSource, options = {}) {
  const source = ensurePlainObject(rawSource);
  const rawFiles = Array.isArray(source.files) ? source.files : [];
  const requireFiles = options?.requireFiles !== false;
  if (requireFiles && rawFiles.length <= 0) {
    throw new Error('micro_skill_registry 参数错误：skill.source.files 至少需要提供 1 个文件。');
  }

  const files = [];
  const seenPaths = new Set();
  rawFiles.forEach((rawFile) => {
    const file = normalizeMicroSkillSourceFile(rawFile, {
      requireCode: options?.requireCode !== false
    });
    if (seenPaths.has(file.path)) {
      throw new Error(`micro_skill_registry 参数错误：source.files 中存在重复路径 \`${file.path}\`。`);
    }
    seenPaths.add(file.path);
    files.push(file);
  });

  const normalizedEntry = normalizeOptionalString(source.entry)
    ? normalizeMicroSkillSourceFilePath(source.entry)
    : (files[0]?.path || null);

  if (requireFiles && !normalizedEntry) {
    throw new Error('micro_skill_registry 参数错误：skill.source.entry 不能为空。');
  }
  if (normalizedEntry && !files.some((file) => file.path === normalizedEntry)) {
    throw new Error(`micro_skill_registry 参数错误：source.entry \`${normalizedEntry}\` 必须指向 source.files 中已有的文件。`);
  }

  return {
    entry: normalizedEntry,
    files
  };
}

function normalizeMicroSkillDetails(rawDetails, options = {}) {
  const details = ensurePlainObject(rawDetails);
  const usage = normalizeString(details.usage);
  const requireUsage = options?.requireUsage === true;
  if (requireUsage && !usage) {
    throw new Error('micro_skill_registry 参数错误：skill.details.usage 不能为空。');
  }
  return {
    usage: usage || '',
    mount_contract: normalizeOptionalString(details.mount_contract) || buildDefaultMicroSkillMountContract()
  };
}

/**
 * 校验并规范化 Chrome/TM 风格 `@match`。
 *
 * 第一阶段只支持：
 * - `<all_urls>`
 * - `*://host/path`
 * - `http://...`
 * - `https://...`
 * - `file:///*`
 *
 * @param {any} rawPatterns
 * @returns {string[]}
 */
export function normalizeMicroSkillMatchPatterns(rawPatterns) {
  const input = Array.isArray(rawPatterns) ? rawPatterns : [];
  if (input.length <= 0) {
    throw new Error('micro_skill_registry 参数错误：skill.match 需要至少提供 1 条 `@match` 规则。');
  }

  const normalized = input.map((value) => normalizeString(value));
  if (normalized.some(value => !value)) {
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

export function microSkillMatchesUrl(record, url) {
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill || skill.enabled !== true) return false;
  return skill.match.some((pattern) => microSkillMatchPatternMatchesUrl(pattern, url));
}

export function normalizeMicroSkillInput(rawSkill, options = {}) {
  const skill = ensurePlainObject(rawSkill);
  const description = normalizeString(skill.description);
  if (!description) {
    throw new Error('micro_skill_registry 参数错误：skill.description 不能为空。');
  }

  return {
    name: normalizeMicroSkillName(skill.name),
    description,
    interface: normalizeMicroSkillInterface(skill.interface, description),
    match: normalizeMicroSkillMatchPatterns(skill.match),
    enabled: normalizeBoolean(skill.enabled, true),
    details: normalizeMicroSkillDetails(skill.details, {
      requireUsage: options?.requireUsage === true
    }),
    source: normalizeMicroSkillSource(skill.source, {
      requireFiles: options?.requireFiles !== false,
      requireCode: options?.requireCode !== false
    })
  };
}

export function normalizeStoredMicroSkillRecord(rawRecord) {
  const record = ensurePlainObject(rawRecord);

  let normalizedInput = null;
  try {
    normalizedInput = normalizeMicroSkillInput(record, {
      requireUsage: false,
      requireFiles: true,
      requireCode: true
    });
  } catch (_) {
    return null;
  }

  const createdAt = toIsoTimestamp(record.created_at) || new Date(0).toISOString();
  const updatedAt = toIsoTimestamp(record.updated_at) || createdAt;

  return {
    ...normalizedInput,
    created_at: createdAt,
    updated_at: updatedAt,
    revision: normalizeRevision(record.revision)
  };
}

export function buildStoredMicroSkillRecord(skillInput, existingRecord = null) {
  const normalizedInput = normalizeMicroSkillInput(skillInput, {
    requireUsage: true,
    requireFiles: true,
    requireCode: true
  });
  const existing = normalizeStoredMicroSkillRecord(existingRecord);
  const now = new Date().toISOString();

  return {
    ...normalizedInput,
    created_at: existing?.created_at || now,
    updated_at: now,
    revision: existing ? existing.revision + 1 : 1
  };
}

export function buildMicroSkillSourceManifest(record, options = {}) {
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) return null;

  const includeCode = options?.includeCode === true;
  const onlyPaths = Array.isArray(options?.onlyPaths)
    ? new Set(options.onlyPaths.map((value) => normalizeMicroSkillSourceFilePath(value)))
    : null;
  const selectedFiles = skill.source.files
    .filter((file) => !onlyPaths || onlyPaths.has(file.path))
    .map((file) => ({
      path: file.path,
      is_entry: file.path === skill.source.entry,
      ...(includeCode ? { code: file.code } : {})
    }));

  return {
    entry: skill.source.entry,
    file_count: skill.source.files.length,
    returned_file_count: selectedFiles.length,
    files: selectedFiles
  };
}

export function buildMicroSkillSummary(record) {
  const rawRecord = ensurePlainObject(record);
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) return null;
  const builtin = rawRecord.builtin === true;
  return {
    kind: builtin ? 'builtin_guidance' : 'page_runtime',
    builtin,
    read_only: builtin || rawRecord.read_only === true,
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
    source: {
      entry: skill.source.entry,
      file_count: skill.source.files.length
    }
  };
}

export function buildMicroSkillDetail(record) {
  const rawRecord = ensurePlainObject(record);
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) return null;
  return {
    ...buildMicroSkillSummary(rawRecord),
    details: {
      usage: skill.details.usage,
      mount_contract: skill.details.mount_contract
    },
    source: buildMicroSkillSourceManifest(skill, { includeCode: false })
  };
}

export function buildMicroSkillSourcePayload(record) {
  const rawRecord = ensurePlainObject(record);
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) return null;
  return {
    kind: rawRecord.builtin === true ? 'builtin_guidance' : 'page_runtime',
    builtin: rawRecord.builtin === true,
    read_only: rawRecord.builtin === true || rawRecord.read_only === true,
    name: skill.name,
    revision: skill.revision,
    source: buildMicroSkillSourceManifest(skill, { includeCode: true })
  };
}

export function buildMicroSkillSourceFilePayload(record, filePath) {
  const rawRecord = ensurePlainObject(record);
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) return null;
  const normalizedPath = normalizeMicroSkillSourceFilePath(filePath);
  if (!skill.source.files.some((file) => file.path === normalizedPath)) {
    throw new Error(`微型 skill ${skill.name} 中不存在源码文件 ${normalizedPath}。`);
  }
  return {
    kind: rawRecord.builtin === true ? 'builtin_guidance' : 'page_runtime',
    builtin: rawRecord.builtin === true,
    read_only: rawRecord.builtin === true || rawRecord.read_only === true,
    name: skill.name,
    revision: skill.revision,
    requested_file_path: normalizedPath,
    source: buildMicroSkillSourceManifest(skill, {
      includeCode: true,
      onlyPaths: [normalizedPath]
    })
  };
}

export function buildMicroSkillContextSummary(record) {
  const rawRecord = ensurePlainObject(record);
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) return null;
  const builtin = rawRecord.builtin === true;
  return {
    priority: builtin ? 0 : 1000,
    kind: builtin ? 'builtin_guidance' : 'page_runtime',
    name: skill.name,
    display_name: skill.interface.display_name || skill.name,
    short_description: skill.interface.short_description || skill.description,
    default_prompt: skill.interface.default_prompt,
    mount_surface: builtin
      ? 'Instruction-only built-in skill. Read detail via micro_skill_registry(action="read_detail", skill_name="skill-creator").'
      : `${CEREBR_MICRO_SKILL_MOUNT_SURFACE}.skills["${skill.name}"] / ${CEREBR_MICRO_SKILL_MOUNT_SURFACE}.invoke("${skill.name}.method", ...args)`
  };
}

export function listBuiltinMicroSkillRecords() {
  return getBuiltinMicroSkillRecords();
}

export function getBuiltinMicroSkillRecord(skillName) {
  return getBuiltinMicroSkillRecordByName(skillName);
}

function ensureStorageArea(storageArea = null) {
  const area = storageArea || globalThis?.chrome?.storage?.local || null;
  if (!area || typeof area.get !== 'function' || typeof area.set !== 'function' || typeof area.remove !== 'function') {
    throw new Error('当前环境没有可用的 chrome.storage.local，无法管理 micro skill 注册表。');
  }
  return area;
}

export async function loadMicroSkillRegistrySnapshot(storageArea = null) {
  const area = ensureStorageArea(storageArea);
  const wrap = await area.get([MICRO_SKILL_REGISTRY_STORAGE_KEY]);
  const rawSnapshot = wrap?.[MICRO_SKILL_REGISTRY_STORAGE_KEY];
  const rawSkillsByName = ensurePlainObject(rawSnapshot).skills_by_name;
  const sourceMap = ensurePlainObject(rawSkillsByName);

  const skills_by_name = {};
  for (const value of Object.values(sourceMap)) {
    const normalized = normalizeStoredMicroSkillRecord(value);
    if (!normalized) continue;
    skills_by_name[normalized.name] = normalized;
  }

  return {
    version: MICRO_SKILL_REGISTRY_VERSION,
    skills_by_name
  };
}

export async function saveMicroSkillRegistrySnapshot(snapshot, storageArea = null) {
  const area = ensureStorageArea(storageArea);
  const source = ensurePlainObject(snapshot).skills_by_name;
  const skills_by_name = {};

  for (const value of Object.values(ensurePlainObject(source))) {
    const normalized = normalizeStoredMicroSkillRecord(value);
    if (!normalized) continue;
    skills_by_name[normalized.name] = normalized;
  }

  const normalizedSnapshot = {
    version: MICRO_SKILL_REGISTRY_VERSION,
    skills_by_name
  };
  await area.set({
    [MICRO_SKILL_REGISTRY_STORAGE_KEY]: normalizedSnapshot
  });
  return normalizedSnapshot;
}

export async function listMatchingMicroSkillRecordsForUrl(url, storageArea = null) {
  const snapshot = await loadMicroSkillRegistrySnapshot(storageArea);
  return Object.values(snapshot.skills_by_name)
    .filter((record) => microSkillMatchesUrl(record, url))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function buildMicroSkillRegistryFunctionToolDefinition() {
  return {
    type: 'function',
    name: MICRO_SKILL_REGISTRY_TOOL_NAME,
    description: [
      '管理 Cerebr 扩展侧持久化保存的浏览器微型 skill。',
      '微型 skill 带有 name/description/interface/match/details/source 等结构化字段。',
      'source 采用多文件 bundle：`source.entry` + `source.files[]`。',
      '扩展会按 `@match` 自动挂载匹配 skill，并在需要时只向模型注入 skill 摘要；',
      '完整 usage、全部源码 bundle、以及单个源码文件的读写，都必须通过本工具按需读取。'
    ].join(' '),
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          description: '必填。支持 list、read_detail、read_source、read_source_file、create、update、upsert_source_file、delete_source_file、delete、enable、disable、refresh_current_document。'
        },
        skill_name: {
          type: ['string', 'null'],
          description: '读写单个 skill 时使用的稳定 key。'
        },
        file_path: {
          type: ['string', 'null'],
          description: '按单个源码文件读取或删除时使用的 skill 内部文件路径。'
        },
        next_entry_path: {
          type: ['string', 'null'],
          description: '删除当前 entry 文件时，用于指定新的入口文件路径。'
        },
        set_as_entry: {
          type: ['boolean', 'null'],
          description: 'upsert_source_file 时是否把该文件设为新的 entry。'
        },
        file: {
          type: ['object', 'null'],
          description: '单个源码文件对象。用于 upsert_source_file。',
          additionalProperties: false,
          properties: {
            path: { type: 'string' },
            code: { type: 'string' }
          },
          required: ['path', 'code']
        },
        skill: {
          type: ['object', 'null'],
          description: 'create/update 时使用的完整微型 skill 对象。',
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
            details: {
              type: 'object',
              additionalProperties: false,
              properties: {
                usage: { type: 'string' },
                mount_contract: { type: ['string', 'null'] }
              },
              required: ['usage']
            },
            source: {
              type: 'object',
              additionalProperties: false,
              properties: {
                entry: { type: ['string', 'null'] },
                files: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      path: { type: 'string' },
                      code: { type: 'string' }
                    },
                    required: ['path', 'code']
                  }
                }
              },
              required: ['files']
            }
          },
          required: ['name', 'description', 'match', 'details', 'source']
        }
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
    refresh: 'refresh_current_document'
  };
  const action = legacyActionMap[rawAction] || rawAction;
  const skillName = normalizeOptionalString(args.skill_name || args.script_id);
  const filePath = normalizeOptionalString(args.file_path);
  const nextEntryPath = normalizeOptionalString(args.next_entry_path);

  if (!action) {
    throw new Error('micro_skill_registry 参数错误：action 不能为空。');
  }

  const supportedActions = new Set([
    'list',
    'read_detail',
    'read_source',
    'read_source_file',
    'create',
    'update',
    'upsert_source_file',
    'delete_source_file',
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
      set_as_entry: false,
      next_entry_path: null
    };
  }

  if (action === 'create' || action === 'update') {
    return {
      action,
      skill_name: null,
      skill: normalizeMicroSkillInput(args.skill, {
        requireUsage: true,
        requireFiles: true,
        requireCode: true
      }),
      file_path: null,
      file: null,
      set_as_entry: false,
      next_entry_path: null
    };
  }

  if (action === 'refresh_current_document') {
    return {
      action,
      skill_name: skillName,
      skill: null,
      file_path: null,
      file: null,
      set_as_entry: false,
      next_entry_path: null
    };
  }

  if (!skillName) {
    throw new Error(`micro_skill_registry 参数错误：action=${action} 时 skill_name 不能为空。`);
  }

  if (action === 'read_source_file' || action === 'delete_source_file') {
    if (!filePath) {
      throw new Error(`micro_skill_registry 参数错误：action=${action} 时 file_path 不能为空。`);
    }
    return {
      action,
      skill_name: skillName,
      skill: null,
      file_path: normalizeMicroSkillSourceFilePath(filePath),
      file: null,
      set_as_entry: false,
      next_entry_path: nextEntryPath ? normalizeMicroSkillSourceFilePath(nextEntryPath) : null
    };
  }

  if (action === 'upsert_source_file') {
    return {
      action,
      skill_name: skillName,
      skill: null,
      file_path: null,
      file: normalizeMicroSkillSourceFile(args.file, { requireCode: true }),
      set_as_entry: normalizeBoolean(args.set_as_entry, false),
      next_entry_path: null
    };
  }

  return {
    action,
    skill_name: skillName,
    skill: null,
    file_path: null,
    file: null,
    set_as_entry: false,
    next_entry_path: null
  };
}
