import { normalizeSkillName } from '../skill/registry_tool.js';
import {
  ensurePlainObject,
  normalizeOptionalString,
  normalizeString,
  VIRTUAL_FILE_TARGET_KIND_CONVERSATION_DOCUMENT,
  VIRTUAL_FILE_TARGET_KIND_SKILL
} from './shared.js';

export function normalizeVirtualFileTargetKind(value, fallback = VIRTUAL_FILE_TARGET_KIND_CONVERSATION_DOCUMENT) {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return fallback;
  if (
    normalized === VIRTUAL_FILE_TARGET_KIND_CONVERSATION_DOCUMENT
    || normalized === VIRTUAL_FILE_TARGET_KIND_SKILL
  ) {
    return normalized;
  }
  throw new Error(`virtual_file 参数错误：不支持的 target.kind \`${value}\`。`);
}

export function normalizeVirtualFileTarget(rawTarget, options = {}) {
  const input = ensurePlainObject(rawTarget);
  const kind = normalizeVirtualFileTargetKind(
    input.kind,
    options?.defaultKind || VIRTUAL_FILE_TARGET_KIND_CONVERSATION_DOCUMENT
  );
  const name = normalizeOptionalString(input.name);
  if (kind === VIRTUAL_FILE_TARGET_KIND_SKILL) {
    if (options?.requireSkillName === true && !name) {
      throw new Error('virtual_file 参数错误：target.kind=skill 时 target.name 不能为空。');
    }
    return {
      kind,
      name: name ? normalizeSkillName(name) : null
    };
  }
  if (name) {
    throw new Error('virtual_file 参数错误：默认会话文件目标不能提供 target.name。');
  }
  return {
    kind,
    name: null
  };
}

export function buildVirtualFileTargetSchemaDescription(options = {}) {
  const requireSkillName = options?.requireSkillName === true;
  return {
    type: ['object', 'null'],
    description: requireSkillName
      ? '可选。文件目标作用域。默认当前对话文件区；若 `kind="skill"` 则必须提供 `name`。本地映射不使用 target.kind，而是直接使用 `local/...` 路径。'
      : '可选。文件目标作用域。默认当前对话文件区；当 `kind="skill"` 时可用 `name` 指定单个技能。本地映射不使用 target.kind，而是直接使用 `local/...` 路径。',
    additionalProperties: false,
    properties: {
      kind: {
        type: ['string', 'null'],
        description: '可选。支持默认会话文件目标与 `skill`；省略时使用会话文件目标。'
      },
      name: {
        type: ['string', 'null'],
        description: requireSkillName
          ? '当 `kind="skill"` 时必填。skill 的稳定 key。'
          : '当 `kind="skill"` 时可选。skill 的稳定 key；省略时表示跨全部 skill。'
      }
    }
  };
}

export function buildVirtualFileTargetSummary(target) {
  const normalizedTarget = ensurePlainObject(target);
  return {
    kind: normalizeVirtualFileTargetKind(
      normalizedTarget.kind,
      VIRTUAL_FILE_TARGET_KIND_CONVERSATION_DOCUMENT
    ),
    name: normalizeOptionalString(normalizedTarget.name)
  };
}
