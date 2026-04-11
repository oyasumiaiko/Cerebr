/**
 * Cerebr 浏览器微型 Skill 注册表。
 *
 * 设计目标：
 * - 用一份扩展侧 `chrome.storage.local` 注册表，统一保存“可自动挂载的浏览器微型 skill”；
 * - 数据模型尽量贴近 Codex skill 的 metadata / interface / progressive disclosure 语义；
 * - 让 background、tool、隐藏上下文注入、未来 UI 都共用同一套纯函数规范化与摘要构建逻辑。
 *
 * 当前刻意不把自动挂载、副作用注册等逻辑放在这里：
 * - 本文件只负责纯数据层；
 * - 真正的 `chrome.userScripts.register/update/unregister`、当前文档 refresh、导航时重挂，
 *   统一交给扩展侧 manager 处理。
 */

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

function normalizeMicroSkillName(value) {
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
 * 微型 skill 的 mount contract 默认说明。
 *
 * 这里不是完整源码规范，而是给模型/人看的最短“如何使用”合同文本：
 * - 让它知道当前页面里可用的 runtime surface；
 * - 让它知道作者侧的 factory 约定；
 * - 避免在默认上下文里泄露完整实现源码。
 *
 * @returns {string}
 */
export function buildDefaultMicroSkillMountContract() {
  return [
    'Mount surface: `globalThis.__cerebrMicroSkills`.',
    'Use `globalThis.__cerebrMicroSkills.skills[name]` to access mounted exports.',
    'Use `globalThis.__cerebrMicroSkills.invoke("skill.method", ...args)` to call a mounted method.',
    'Authoring contract: the saved source code runs as an async factory body with `ctx` available.',
    'Preferred authoring style: `return { methods... }`; advanced style: call `ctx.mount(exports)` manually.',
    'Optional cleanup: if the mounted exports object exposes `dispose()`, Cerebr may call it before unmount / remount.'
  ].join('\n');
}

function normalizeMicroSkillInterface(rawInterface, fallbackDescription = '') {
  const input = (rawInterface && typeof rawInterface === 'object' && !Array.isArray(rawInterface))
    ? rawInterface
    : {};
  return {
    display_name: normalizeOptionalString(input.display_name),
    short_description: normalizeOptionalString(input.short_description) || normalizeOptionalString(fallbackDescription),
    default_prompt: normalizeOptionalString(input.default_prompt)
  };
}

function normalizeMicroSkillSource(rawSource, options = {}) {
  const source = (rawSource && typeof rawSource === 'object' && !Array.isArray(rawSource))
    ? rawSource
    : {};
  const code = (typeof source.code === 'string') ? source.code : '';
  const requireCode = options?.requireCode !== false;
  if (requireCode && !code.trim()) {
    throw new Error('micro_skill_registry 参数错误：skill.source.code 不能为空。');
  }
  return { code };
}

function normalizeMicroSkillDetails(rawDetails, options = {}) {
  const details = (rawDetails && typeof rawDetails === 'object' && !Array.isArray(rawDetails))
    ? rawDetails
    : {};
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
 * 不支持：
 * - exclude 规则
 * - 正则表达式
 * - 自定义布尔表达式
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
  const skill = (rawSkill && typeof rawSkill === 'object' && !Array.isArray(rawSkill))
    ? rawSkill
    : {};
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
      requireCode: options?.requireCode !== false
    })
  };
}

export function normalizeStoredMicroSkillRecord(rawRecord) {
  const record = (rawRecord && typeof rawRecord === 'object' && !Array.isArray(rawRecord))
    ? rawRecord
    : {};

  let normalizedInput = null;
  try {
    normalizedInput = normalizeMicroSkillInput(record, {
      requireUsage: false,
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

export function buildMicroSkillSummary(record) {
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) return null;
  return {
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
    revision: skill.revision
  };
}

export function buildMicroSkillDetail(record) {
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) return null;
  return {
    ...buildMicroSkillSummary(skill),
    details: {
      usage: skill.details.usage,
      mount_contract: skill.details.mount_contract
    }
  };
}

export function buildMicroSkillSourcePayload(record) {
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) return null;
  return {
    name: skill.name,
    revision: skill.revision,
    source: {
      code: skill.source.code
    }
  };
}

export function buildMicroSkillContextSummary(record) {
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) return null;
  return {
    name: skill.name,
    display_name: skill.interface.display_name || skill.name,
    short_description: skill.interface.short_description || skill.description,
    default_prompt: skill.interface.default_prompt,
    mount_surface: `${CEREBR_MICRO_SKILL_MOUNT_SURFACE}.skills["${skill.name}"] / ${CEREBR_MICRO_SKILL_MOUNT_SURFACE}.invoke("${skill.name}.method", ...args)`
  };
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
  const rawSkillsByName = (rawSnapshot && typeof rawSnapshot === 'object' && !Array.isArray(rawSnapshot))
    ? (
        (rawSnapshot.skills_by_name && typeof rawSnapshot.skills_by_name === 'object' && !Array.isArray(rawSnapshot.skills_by_name))
          ? rawSnapshot.skills_by_name
          : {}
      )
    : {};

  const skills_by_name = {};
  for (const value of Object.values(rawSkillsByName)) {
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
  const source = (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot))
    ? snapshot.skills_by_name
    : null;
  const skills_by_name = {};

  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const value of Object.values(source)) {
      const normalized = normalizeStoredMicroSkillRecord(value);
      if (!normalized) continue;
      skills_by_name[normalized.name] = normalized;
    }
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
      '扩展会按 `@match` 自动挂载匹配 skill，并在需要时只向模型注入 skill 摘要；',
      '完整 usage 和源码必须通过本工具按需读取，避免一次性暴露过多上下文。'
    ].join(' '),
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          description: '必填。支持 list、read_detail、read_source、create、update、delete、enable、disable、refresh_current_document。'
        },
        skill_name: {
          type: ['string', 'null'],
          description: '读写单个 skill 时使用的稳定 key。'
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
                code: { type: 'string' }
              },
              required: ['code']
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
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs))
    ? rawArgs
    : {};
  const rawAction = normalizeString(args.action).toLowerCase();
  const legacyActionMap = {
    save: 'update',
    get: 'read_detail',
    refresh: 'refresh_current_document'
  };
  const action = legacyActionMap[rawAction] || rawAction;
  const skillName = normalizeOptionalString(args.skill_name || args.script_id);

  if (!action) {
    throw new Error('micro_skill_registry 参数错误：action 不能为空。');
  }

  const supportedActions = new Set([
    'list',
    'read_detail',
    'read_source',
    'create',
    'update',
    'delete',
    'enable',
    'disable',
    'refresh_current_document'
  ]);
  if (!supportedActions.has(action)) {
    throw new Error(`micro_skill_registry 参数错误：不支持的 action \`${action}\`。`);
  }

  if (action === 'list') {
    return { action, skill_name: null, skill: null };
  }

  if (action === 'create' || action === 'update') {
    return {
      action,
      skill_name: null,
      skill: normalizeMicroSkillInput(args.skill, {
        requireUsage: true,
        requireCode: true
      })
    };
  }

  if (action === 'refresh_current_document') {
    return {
      action,
      skill_name: skillName,
      skill: null
    };
  }

  if (!skillName) {
    throw new Error(`micro_skill_registry 参数错误：action=${action} 时 skill_name 不能为空。`);
  }

  return {
    action,
    skill_name: skillName,
    skill: null
  };
}
