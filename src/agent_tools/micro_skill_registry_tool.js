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

export const MICRO_SKILL_REGISTRY_TOOL_NAME = 'micro_skill_registry';
export const MICRO_SKILL_REGISTRY_STORAGE_KEY = 'micro_skill_registry_v1';
export const MICRO_SKILL_REGISTRY_DB_NAME = MICRO_SKILL_DB_NAME;
export const MICRO_SKILL_REGISTRY_VERSION = 2;
export const MICRO_SKILL_MATCH_ALL_URLS = '<all_urls>';
export const CEREBR_MICRO_SKILL_MOUNT_SURFACE = 'globalThis.__cerebrMicroSkills';

const MICRO_SKILL_KIND_PAGE_RUNTIME = 'page_runtime';
const MICRO_SKILL_KIND_BUILTIN_GUIDANCE = 'builtin_guidance';
const MICRO_SKILL_FILE_KIND_INSTRUCTION = 'instruction';
const MICRO_SKILL_FILE_KIND_RUNTIME_SOURCE = 'runtime_source';
const MICRO_SKILL_FILE_KIND_REFERENCE = 'reference';
const MICRO_SKILL_FILE_KIND_UI_METADATA = 'ui_metadata';
const MICRO_SKILL_FILE_KIND_TEMPLATE = 'template';
const MICRO_SKILL_FILE_KIND_ASSET = 'asset';
const MICRO_SKILL_DEFAULT_ALLOW_IMPLICIT_INVOCATION = true;
const OPENAI_INTERFACE_SHORT_DESCRIPTION_MIN_LENGTH = 25;
const OPENAI_INTERFACE_SHORT_DESCRIPTION_MAX_LENGTH = 64;

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

function ensurePlainObject(value) {
  return (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
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

function normalizeMicroSkillFileKind(value) {
  const text = normalizeString(value).toLowerCase();
  const supportedKinds = new Set([
    MICRO_SKILL_FILE_KIND_INSTRUCTION,
    MICRO_SKILL_FILE_KIND_RUNTIME_SOURCE,
    MICRO_SKILL_FILE_KIND_REFERENCE,
    MICRO_SKILL_FILE_KIND_UI_METADATA,
    MICRO_SKILL_FILE_KIND_TEMPLATE,
    MICRO_SKILL_FILE_KIND_ASSET
  ]);
  if (!supportedKinds.has(text)) {
    throw new Error(`micro_skill_registry 参数错误：不支持的文件 kind \`${value}\`。`);
  }
  return text;
}

function normalizeMicroSkillInterface(rawInterface, fallbackDescription = '') {
  const input = ensurePlainObject(rawInterface);
  return {
    display_name: normalizeOptionalString(input.display_name),
    short_description: normalizeOptionalString(input.short_description) || normalizeOptionalString(fallbackDescription),
    icon_small: normalizeOptionalString(input.icon_small)
      ? normalizeMicroSkillFilePath(input.icon_small)
      : null,
    icon_large: normalizeOptionalString(input.icon_large)
      ? normalizeMicroSkillFilePath(input.icon_large)
      : null,
    brand_color: normalizeOptionalString(input.brand_color),
    default_prompt: normalizeOptionalString(input.default_prompt)
  };
}

function normalizeMicroSkillDependencies(rawDependencies) {
  const input = ensurePlainObject(rawDependencies);
  const rawTools = Array.isArray(input.tools) ? input.tools : [];
  return {
    tools: rawTools.map((rawTool, index) => {
      const tool = ensurePlainObject(rawTool);
      const type = normalizeString(tool.type).toLowerCase();
      const value = normalizeString(tool.value);
      if (!type) {
        throw new Error(`micro_skill_registry 参数错误：dependencies.tools[${index}].type 不能为空。`);
      }
      if (type !== 'mcp') {
        throw new Error(`micro_skill_registry 参数错误：dependencies.tools[${index}].type 目前只支持 \`mcp\`。`);
      }
      if (!value) {
        throw new Error(`micro_skill_registry 参数错误：dependencies.tools[${index}].value 不能为空。`);
      }
      const transport = normalizeOptionalString(tool.transport);
      const url = normalizeOptionalString(tool.url);
      return {
        type,
        value,
        description: normalizeOptionalString(tool.description),
        transport,
        url
      };
    })
  };
}

function normalizeMicroSkillPolicy(rawPolicy) {
  const input = ensurePlainObject(rawPolicy);
  return {
    allow_implicit_invocation: normalizeBoolean(
      input.allow_implicit_invocation,
      MICRO_SKILL_DEFAULT_ALLOW_IMPLICIT_INVOCATION
    )
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

function normalizeMicroSkillFile(rawFile, options = {}) {
  const file = ensurePlainObject(rawFile);
  const path = normalizeMicroSkillFilePath(file.path);
  const content = (typeof file.content === 'string')
    ? file.content
    : ((typeof file.code === 'string') ? file.code : '');
  const requireContent = options?.requireContent !== false;
  const requireKind = options?.requireKind !== false;
  const inferredKind = (() => {
    if (typeof file.kind === 'string' && file.kind.trim()) {
      return normalizeMicroSkillFileKind(file.kind);
    }
    if (!requireKind) return null;
    throw new Error(`micro_skill_registry 参数错误：files[\`${path}\`].kind 不能为空。`);
  })();

  if (requireContent && !content.trim()) {
    throw new Error(`micro_skill_registry 参数错误：files[\`${path}\`].content 不能为空。`);
  }

  return {
    path,
    kind: inferredKind,
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
      requireContent: options?.requireContent !== false,
      requireKind: options?.requireKind !== false
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
    : (files.find((file) => file.kind === MICRO_SKILL_FILE_KIND_INSTRUCTION) || null);

  if (!instructionFile) {
    throw new Error('micro_skill_registry 参数错误：skill.instruction.path 必须指向 files 中的 instruction 文件。');
  }
  if (instructionFile.kind !== MICRO_SKILL_FILE_KIND_INSTRUCTION) {
    throw new Error(`micro_skill_registry 参数错误：instruction.path \`${instructionFile.path}\` 必须指向 instruction 文件。`);
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
  const runtimeFiles = files.filter((file) => file.kind === MICRO_SKILL_FILE_KIND_RUNTIME_SOURCE);
  const runtimeEntryFile = requestedPath
    ? files.find((file) => file.path === requestedPath)
    : (runtimeFiles[0] || null);

  if (kind === MICRO_SKILL_KIND_PAGE_RUNTIME) {
    if (!runtimeEntryFile) {
      throw new Error('micro_skill_registry 参数错误：page runtime skill 必须提供 runtime.entry_path。');
    }
    if (runtimeEntryFile.kind !== MICRO_SKILL_FILE_KIND_RUNTIME_SOURCE) {
      throw new Error(`micro_skill_registry 参数错误：runtime.entry_path \`${runtimeEntryFile.path}\` 必须指向 runtime_source 文件。`);
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

function getUnicodeLength(value) {
  return Array.from(String(value || '')).length;
}

function normalizeValidationIssue(issue, fallbackLevel = 'error') {
  const input = ensurePlainObject(issue);
  return {
    key: normalizeString(input.key) || 'unknown',
    level: normalizeString(input.level) || fallbackLevel,
    message: normalizeString(input.message) || '校验失败。'
  };
}

function createValidationCollector() {
  const checklist = [];
  const errors = [];
  const warnings = [];

  function push(level, key, message) {
    const issue = normalizeValidationIssue({ level, key, message }, level);
    checklist.push(issue);
    if (level === 'warning') {
      warnings.push(issue);
    } else if (level === 'error') {
      errors.push(issue);
    }
  }

  return {
    pass(key, message) {
      checklist.push(normalizeValidationIssue({ level: 'pass', key, message }, 'pass'));
    },
    warn(key, message) {
      push('warning', key, message);
    },
    error(key, message) {
      push('error', key, message);
    },
    build(extra = {}) {
      return {
        valid: errors.length <= 0,
        errors,
        warnings,
        checklist,
        ...extra
      };
    }
  };
}

function stripYamlScalarQuotes(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('\'') && text.endsWith('\''))) {
    return text.slice(1, -1);
  }
  return text;
}

export function parseMicroSkillInstructionFrontmatter(markdownText) {
  const text = (typeof markdownText === 'string') ? markdownText : '';
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return {
      ok: false,
      error: 'SKILL.md 缺少 YAML frontmatter 开始标记 `---`。'
    };
  }

  const lines = text.split(/\r?\n/);
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex <= 0) {
    return {
      ok: false,
      error: 'SKILL.md 缺少 YAML frontmatter 结束标记 `---`。'
    };
  }

  const frontmatterLines = lines.slice(1, closingIndex);
  const data = {};
  let currentSection = null;
  for (const rawLine of frontmatterLines) {
    const line = rawLine.replace(/\t/g, '  ');
    if (!line.trim()) continue;
    const nestedMatch = line.match(/^\s+([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (nestedMatch && currentSection) {
      const [, key, value] = nestedMatch;
      data[currentSection] ||= {};
      data[currentSection][key] = stripYamlScalarQuotes(value);
      continue;
    }

    const topLevelMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!topLevelMatch) {
      return {
        ok: false,
        error: `SKILL.md frontmatter 含有无法解析的行：${rawLine}`
      };
    }
    const [, key, value] = topLevelMatch;
    if (!value.trim()) {
      data[key] ||= {};
      currentSection = key;
      continue;
    }
    data[key] = stripYamlScalarQuotes(value);
    currentSection = null;
  }

  return {
    ok: true,
    frontmatter: data,
    body: lines.slice(closingIndex + 1).join('\n')
  };
}

function validateMicroSkillInstructionFile(skill, collector) {
  const instructionPath = skill?.instruction?.path || '';
  const instructionFile = Array.isArray(skill?.files)
    ? skill.files.find((file) => file.path === instructionPath)
    : null;
  if (!instructionFile) {
    collector.error('instruction.file', 'instruction.path 指向的 SKILL.md 文件不存在。');
    return null;
  }

  collector.pass('instruction.file', `已找到 instruction 文件：${instructionPath}`);
  const parsed = parseMicroSkillInstructionFrontmatter(instructionFile.content);
  if (parsed.ok !== true) {
    collector.error('instruction.frontmatter', parsed.error || 'SKILL.md frontmatter 无法解析。');
    return null;
  }

  collector.pass('instruction.frontmatter', 'SKILL.md frontmatter 结构有效。');
  const frontmatterName = normalizeString(parsed.frontmatter?.name);
  const frontmatterDescription = normalizeString(parsed.frontmatter?.description);
  if (!frontmatterName) {
    collector.error('instruction.frontmatter.name', 'SKILL.md frontmatter 缺少 `name`。');
  } else if (frontmatterName !== skill.name) {
    collector.error('instruction.frontmatter.name', `SKILL.md frontmatter 的 name (${frontmatterName}) 与 manifest.name (${skill.name}) 不一致。`);
  } else {
    collector.pass('instruction.frontmatter.name', 'SKILL.md frontmatter.name 与 manifest.name 一致。');
  }

  if (!frontmatterDescription) {
    collector.error('instruction.frontmatter.description', 'SKILL.md frontmatter 缺少 `description`。');
  } else if (frontmatterDescription !== skill.description) {
    collector.error('instruction.frontmatter.description', 'SKILL.md frontmatter.description 与 manifest.description 不一致。');
  } else {
    collector.pass('instruction.frontmatter.description', 'SKILL.md frontmatter.description 与 manifest.description 一致。');
  }

  const frontmatterShortDescription = normalizeString(parsed.frontmatter?.metadata?.['short-description']);
  if (!frontmatterShortDescription) {
    collector.warn('instruction.frontmatter.metadata.short-description', 'SKILL.md frontmatter 未声明 metadata.short-description。');
  } else if (skill.interface.short_description && frontmatterShortDescription !== skill.interface.short_description) {
    collector.warn('instruction.frontmatter.metadata.short-description', 'SKILL.md frontmatter.metadata.short-description 与 interface.short_description 不一致。');
  } else {
    collector.pass('instruction.frontmatter.metadata.short-description', 'SKILL.md frontmatter.metadata.short-description 与 manifest.interface.short_description 一致。');
  }

  const bodyLineCount = parsed.body.split(/\r?\n/).length;
  if (bodyLineCount > 500) {
    collector.warn('instruction.body.length', `SKILL.md 正文共 ${bodyLineCount} 行，超过 500 行的建议上限。`);
  } else {
    collector.pass('instruction.body.length', `SKILL.md 正文行数为 ${bodyLineCount}。`);
  }
  return instructionFile;
}

function validateOpenAiAlignedInterface(skill, collector) {
  const input = ensurePlainObject(skill?.interface);
  const shortDescription = normalizeString(input.short_description);
  const defaultPrompt = normalizeString(input.default_prompt);
  const displayName = normalizeString(input.display_name);
  const brandColor = normalizeString(input.brand_color);

  if (!displayName) {
    collector.error('interface.display_name', 'interface.display_name 不能为空。');
  } else {
    collector.pass('interface.display_name', 'interface.display_name 已设置。');
  }

  if (!shortDescription) {
    collector.error('interface.short_description', 'interface.short_description 不能为空。');
  } else {
    const length = getUnicodeLength(shortDescription);
    if (length < OPENAI_INTERFACE_SHORT_DESCRIPTION_MIN_LENGTH || length > OPENAI_INTERFACE_SHORT_DESCRIPTION_MAX_LENGTH) {
      collector.error(
        'interface.short_description',
        `interface.short_description 长度需在 ${OPENAI_INTERFACE_SHORT_DESCRIPTION_MIN_LENGTH} 到 ${OPENAI_INTERFACE_SHORT_DESCRIPTION_MAX_LENGTH} 个字符之间，当前为 ${length}。`
      );
    } else {
      collector.pass('interface.short_description', `interface.short_description 长度为 ${length}，符合约束。`);
    }
  }

  if (!defaultPrompt) {
    collector.error('interface.default_prompt', 'interface.default_prompt 不能为空。');
  } else if (!(defaultPrompt.includes(`$${skill.name}`) || defaultPrompt.includes('$skill-name'))) {
    collector.error('interface.default_prompt', `interface.default_prompt 必须显式提到 \`$${skill.name}\`（或占位写法 \`$skill-name\`）。`);
  } else {
    collector.pass('interface.default_prompt', 'interface.default_prompt 已显式提到 skill 名称。');
  }

  if (brandColor) {
    if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(brandColor)) {
      collector.error('interface.brand_color', 'interface.brand_color 必须是合法的 hex 颜色，例如 `#3B82F6`。');
    } else {
      collector.pass('interface.brand_color', 'interface.brand_color 格式有效。');
    }
  } else {
    collector.pass('interface.brand_color', 'interface.brand_color 未设置，可选。');
  }

  ['icon_small', 'icon_large'].forEach((fieldName) => {
    const iconPath = normalizeOptionalString(input[fieldName]);
    if (!iconPath) {
      collector.pass(`interface.${fieldName}`, `interface.${fieldName} 未设置，可选。`);
      return;
    }
    const file = Array.isArray(skill?.files)
      ? skill.files.find((item) => item.path === iconPath)
      : null;
    if (!file) {
      collector.error(`interface.${fieldName}`, `interface.${fieldName} 指向的文件不存在：${iconPath}`);
      return;
    }
    if (file.kind !== MICRO_SKILL_FILE_KIND_ASSET) {
      collector.error(`interface.${fieldName}`, `interface.${fieldName} 必须指向 kind=\`${MICRO_SKILL_FILE_KIND_ASSET}\` 的文件：${iconPath}`);
      return;
    }
    collector.pass(`interface.${fieldName}`, `interface.${fieldName} 指向有效 asset 文件：${iconPath}`);
  });
}

function validateDependenciesAndPolicy(skill, collector) {
  const dependencies = ensurePlainObject(skill?.dependencies);
  const tools = Array.isArray(dependencies.tools) ? dependencies.tools : [];
  if (tools.length <= 0) {
    collector.pass('dependencies.tools', '未声明 dependencies.tools，可选。');
  } else {
    tools.forEach((tool, index) => {
      const keyPrefix = `dependencies.tools[${index}]`;
      if (tool.type !== 'mcp') {
        collector.error(`${keyPrefix}.type`, 'dependencies.tools[].type 当前只支持 `mcp`。');
      } else {
        collector.pass(`${keyPrefix}.type`, 'dependencies.tools[].type 为 `mcp`。');
      }
      if (!normalizeString(tool.value)) {
        collector.error(`${keyPrefix}.value`, 'dependencies.tools[].value 不能为空。');
      } else {
        collector.pass(`${keyPrefix}.value`, `dependencies.tools[].value 已设置为 ${tool.value}。`);
      }
      if (tool.transport && !normalizeString(tool.url)) {
        collector.warn(`${keyPrefix}.url`, '声明了 transport 但没有提供 url。');
      }
    });
  }

  if (typeof skill?.policy?.allow_implicit_invocation !== 'boolean') {
    collector.error('policy.allow_implicit_invocation', 'policy.allow_implicit_invocation 必须是布尔值。');
  } else {
    collector.pass('policy.allow_implicit_invocation', `policy.allow_implicit_invocation=${skill.policy.allow_implicit_invocation}.`);
  }
}

function validateRuntimeShape(skill, collector) {
  if (skill.kind !== MICRO_SKILL_KIND_PAGE_RUNTIME) {
    collector.pass('runtime.entry_path', '当前 skill 不是 page runtime skill，不要求 runtime.entry_path。');
    return;
  }

  const runtimeEntryPath = normalizeString(skill?.runtime?.entry_path);
  if (!runtimeEntryPath) {
    collector.error('runtime.entry_path', 'page runtime skill 必须提供 runtime.entry_path。');
    return;
  }

  const runtimeEntryFile = Array.isArray(skill?.files)
    ? skill.files.find((file) => file.path === runtimeEntryPath)
    : null;
  if (!runtimeEntryFile) {
    collector.error('runtime.entry_path', `runtime.entry_path 指向的文件不存在：${runtimeEntryPath}`);
    return;
  }
  if (runtimeEntryFile.kind !== MICRO_SKILL_FILE_KIND_RUNTIME_SOURCE) {
    collector.error('runtime.entry_path', `runtime.entry_path 必须指向 kind=\`${MICRO_SKILL_FILE_KIND_RUNTIME_SOURCE}\` 的文件。`);
    return;
  }

  const runtimeFileCount = Array.isArray(skill?.files)
    ? skill.files.filter((file) => file.kind === MICRO_SKILL_FILE_KIND_RUNTIME_SOURCE).length
    : 0;
  if (runtimeFileCount <= 0) {
    collector.error('runtime.files', 'page runtime skill 至少需要 1 个 runtime_source 文件。');
  } else {
    collector.pass('runtime.files', `已找到 ${runtimeFileCount} 个 runtime_source 文件。`);
  }
}

export function validateMicroSkillRecord(record, options = {}) {
  const collector = createValidationCollector();
  let normalizedRecord = null;
  let normalizeErrorMessage = '';
  try {
    const existingRecord = ensurePlainObject(record);
    const hasPersistenceFields = !!(
      existingRecord?.created_at
      || existingRecord?.updated_at
      || existingRecord?.revision
      || existingRecord?.builtin === true
      || existingRecord?.read_only === true
    );
    normalizedRecord = hasPersistenceFields
      ? normalizeStoredMicroSkillRecord(record)
      : buildStoredMicroSkillRecord(record, null);
  } catch (error) {
    normalizeErrorMessage = normalizeString(error?.message) || 'skill 结构无效，无法完成规范化。';
  }

  if (!normalizedRecord) {
    const issue = normalizeValidationIssue({
      key: 'skill.normalize',
      level: 'error',
      message: normalizeErrorMessage || 'skill 结构无效，无法完成规范化。'
    });
    return {
      ok: true,
      valid: false,
      errors: [issue],
      warnings: [],
      checklist: [issue],
      normalized_skill: null
    };
  }

  validateMicroSkillInstructionFile(normalizedRecord, collector);
  validateOpenAiAlignedInterface(normalizedRecord, collector);
  validateDependenciesAndPolicy(normalizedRecord, collector);
  validateRuntimeShape(normalizedRecord, collector);

  if (options?.requireMatch !== false && normalizedRecord.kind === MICRO_SKILL_KIND_PAGE_RUNTIME) {
    if (Array.isArray(normalizedRecord.match) && normalizedRecord.match.length > 0) {
      collector.pass('match', `已声明 ${normalizedRecord.match.length} 条 @match 规则。`);
    } else {
      collector.error('match', 'page runtime skill 必须声明至少 1 条 @match 规则。');
    }
  }

  return {
    ok: true,
    ...collector.build({
      normalized_skill: normalizedRecord
    })
  };
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
  const files = normalizeMicroSkillFiles(rawFiles, {
    requireFiles: options?.requireFiles !== false,
    requireContent: options?.requireContent !== false,
    requireKind: true
  });

  return {
    kind,
    name: normalizeMicroSkillName(skill.name),
    description,
    interface: normalizeMicroSkillInterface(skill.interface, description),
    dependencies: normalizeMicroSkillDependencies(skill.dependencies),
    policy: normalizeMicroSkillPolicy(skill.policy),
    match: normalizeMicroSkillMatchPatterns(skill.match, {
      allowEmpty: kind !== MICRO_SKILL_KIND_PAGE_RUNTIME
    }),
    enabled: normalizeBoolean(skill.enabled, true),
    instruction: normalizeMicroSkillInstruction(skill.instruction, files),
    runtime: normalizeMicroSkillRuntime(skill.runtime, files, kind),
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
      ...(includeContent ? { content: file.content } : {})
    }));

  return {
    total_count: skill.files.length,
    returned_file_count: selectedFiles.length,
    by_kind: summarizeFileKinds(skill.files),
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
      icon_small: skill.interface.icon_small,
      icon_large: skill.interface.icon_large,
      brand_color: skill.interface.brand_color,
      default_prompt: skill.interface.default_prompt
    },
    dependencies: {
      tools: Array.isArray(skill.dependencies?.tools) ? skill.dependencies.tools.map((tool) => ({ ...tool })) : []
    },
    policy: {
      allow_implicit_invocation: skill.policy?.allow_implicit_invocation !== false
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
      total_count: skill.files.length,
      by_kind: summarizeFileKinds(skill.files)
    }
  };
}

export function buildMicroSkillDetail(record) {
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) return null;
  const { normalized_skill, ...validation } = validateMicroSkillRecord(skill);
  return {
    ...buildMicroSkillSummary(skill),
    instruction: {
      path: skill.instruction.path,
      content: readInstructionContent(skill)
    },
    files: buildMicroSkillFileManifest(skill, { includeContent: false }),
    validation
  };
}

export function buildMicroSkillPackagePayload(record) {
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) return null;
  const { normalized_skill, ...validation } = validateMicroSkillRecord(skill);
  return {
    kind: skill.kind,
    builtin: skill.builtin === true,
    read_only: skill.read_only === true,
    name: skill.name,
    description: skill.description,
    interface: {
      display_name: skill.interface.display_name || skill.name,
      short_description: skill.interface.short_description || skill.description,
      icon_small: skill.interface.icon_small,
      icon_large: skill.interface.icon_large,
      brand_color: skill.interface.brand_color,
      default_prompt: skill.interface.default_prompt
    },
    dependencies: {
      tools: Array.isArray(skill.dependencies?.tools) ? skill.dependencies.tools.map((tool) => ({ ...tool })) : []
    },
    policy: {
      allow_implicit_invocation: skill.policy?.allow_implicit_invocation !== false
    },
    match: [...skill.match],
    enabled: skill.enabled,
    revision: skill.revision,
    instruction: {
      path: skill.instruction.path
    },
    runtime: {
      entry_path: skill.runtime.entry_path
    },
    files: buildMicroSkillFileManifest(skill, { includeContent: true }),
    validation
  };
}

export function buildMicroSkillFilePayload(record, filePath) {
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) return null;
  const normalizedPath = normalizeMicroSkillFilePath(filePath);
  const file = skill.files.find((item) => item.path === normalizedPath) || null;
  if (!file) {
    throw new Error(`微型 skill ${skill.name} 中不存在文件 ${normalizedPath}。`);
  }
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
      content: file.content
    }
  };
}

export function buildMicroSkillContextSummary(record) {
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) return null;
  return {
    priority: skill.kind === MICRO_SKILL_KIND_BUILTIN_GUIDANCE ? 0 : 1000,
    kind: skill.kind,
    name: skill.name,
    display_name: skill.interface.display_name || skill.name,
    short_description: skill.interface.short_description || skill.description,
    default_prompt: skill.interface.default_prompt,
    allow_implicit_invocation: skill.policy?.allow_implicit_invocation !== false,
    mount_surface: skill.kind === MICRO_SKILL_KIND_BUILTIN_GUIDANCE
      ? 'Instruction-only built-in skill. Read detail via micro_skill_registry(action="read_detail", skill_name="skill-creator").'
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
      kind: { type: ['string', 'null'] },
      name: { type: 'string' },
      description: { type: 'string' },
      interface: {
        type: ['object', 'null'],
        additionalProperties: false,
        properties: {
          display_name: { type: ['string', 'null'] },
          short_description: { type: ['string', 'null'] },
          icon_small: { type: ['string', 'null'] },
          icon_large: { type: ['string', 'null'] },
          brand_color: { type: ['string', 'null'] },
          default_prompt: { type: ['string', 'null'] }
        }
      },
      dependencies: {
        type: ['object', 'null'],
        additionalProperties: false,
        properties: {
          tools: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { type: 'string' },
                value: { type: 'string' },
                description: { type: ['string', 'null'] },
                transport: { type: ['string', 'null'] },
                url: { type: ['string', 'null'] }
              },
              required: ['type', 'value']
            }
          }
        }
      },
      policy: {
        type: ['object', 'null'],
        additionalProperties: false,
        properties: {
          allow_implicit_invocation: { type: ['boolean', 'null'] }
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
            kind: { type: 'string' },
            content: { type: 'string' }
          },
          required: ['path', 'kind', 'content']
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
      '管理 Cerebr 扩展侧持久化保存的浏览器微型 skill package。',
      '每个 skill 由 manifest + 虚拟文件树组成，底层默认使用 IndexedDB 持久化。',
      '摘要/详情/整包源码遵循渐进式披露：默认只注入 summary，详细说明和具体文件需要按需读取。',
      '支持整包 create/update，也支持按文件 read/write/delete，并在需要时刷新当前网页的挂载；另外提供 validate 动作用于显式校验模板、OpenAI interface 语义和运行时约束。'
    ].join(' '),
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          description: '必填。支持 list、read_detail、read_package、read_file、write_file、create、update、validate、delete_file、delete、enable、disable、refresh_current_document。旧别名 read_source/read_source_file/upsert_source_file/delete_source_file 也可用。'
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
            kind: { type: ['string', 'null'] },
            content: { type: 'string' }
          },
          required: ['path', 'content']
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
    'create',
    'update',
    'validate',
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
      set_as_instruction: false,
      set_as_runtime_entry: false,
      next_instruction_path: null,
      next_runtime_entry_path: null
    };
  }

  if (action === 'validate') {
    const hasInlineSkill = !!(args.skill && typeof args.skill === 'object' && !Array.isArray(args.skill));
    if (!skillName && !hasInlineSkill) {
      throw new Error('micro_skill_registry 参数错误：action=validate 时必须提供 skill_name 或 skill。');
    }
    return {
      action,
      skill_name: skillName,
      skill: hasInlineSkill ? args.skill : null,
      file_path: null,
      file: null,
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
      set_as_instruction: normalizeBoolean(args.set_as_instruction, false),
      set_as_runtime_entry: normalizeBoolean(args.set_as_runtime_entry || args.set_as_entry, false),
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
    set_as_instruction: false,
    set_as_runtime_entry: false,
    next_instruction_path: null,
    next_runtime_entry_path: null
  };
}
