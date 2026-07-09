import { normalizeSkillName } from '../skill/registry_tool.js';
import { buildStrictObjectSchema } from '../shared/model_tool_contract.js';
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
  return buildStrictObjectSchema({
    kind: {
      type: ['string', 'null'],
      enum: [VIRTUAL_FILE_TARGET_KIND_CONVERSATION_DOCUMENT, VIRTUAL_FILE_TARGET_KIND_SKILL, null],
      description: '目标类型。传 null 或 `workspace` 表示当前对话文件区；传 `skill` 表示 skill 文件区。'
    },
    name: {
      type: ['string', 'null'],
      description: requireSkillName
        ? '当 kind=`skill` 时必须填写单个 skill 的稳定 key；kind 为 null/`workspace` 时必须传 null。'
        : 'kind=`skill` 时可填写单个 skill 的稳定 key；传 null 表示跨全部 skill。kind 为 null/`workspace` 时必须传 null。'
    }
  }, {
    nullable: true,
    description: requireSkillName
      ? '目标作用域。传 null 表示当前对话文件区；操作 skill 时传 {"kind":"skill","name":"<skill-key>"}。本地只读映射不用 target，而是直接使用 `local/...` 路径。'
      : '目标作用域。传 null 表示当前对话文件区；搜索/列出 skill 时传 kind=`skill`，name=null 可跨全部 skill。本地只读映射不用 target，而是直接使用 `local/...` 路径。'
  });
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
