import { normalizeSkillName } from '../skill/registry_tool.js';
import { buildStrictObjectSchema } from '../shared/model_tool_contract.js';
import {
  ensurePlainObject,
  normalizeOptionalString,
  normalizeString,
  VIRTUAL_FILE_TARGET_KIND_ROOT,
  VIRTUAL_FILE_TARGET_KIND_SKILL
} from './shared.js';

export function normalizeVirtualFileTargetKind(value, fallback = VIRTUAL_FILE_TARGET_KIND_ROOT) {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return fallback;
  if (
    normalized === VIRTUAL_FILE_TARGET_KIND_ROOT
    || normalized === VIRTUAL_FILE_TARGET_KIND_SKILL
  ) {
    return normalized;
  }
  throw new Error(`virtual_file 参数错误：不支持的 target.kind \`${value}\`。`);
}

export function normalizeVirtualFileTarget(rawTarget, options = {}) {
  if (rawTarget == null) {
    return { kind: VIRTUAL_FILE_TARGET_KIND_ROOT, name: null };
  }
  const input = ensurePlainObject(rawTarget);
  const kind = normalizeVirtualFileTargetKind(
    input.kind,
    options?.defaultKind || VIRTUAL_FILE_TARGET_KIND_ROOT
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
  throw new Error('virtual_file 参数错误：默认根必须使用 target=null；target object 只用于选择 skill。');
}

export function buildVirtualFileTargetSchemaDescription(options = {}) {
  const requireSkillName = options?.requireSkillName === true;
  return buildStrictObjectSchema({
    kind: {
      type: 'string',
      enum: [VIRTUAL_FILE_TARGET_KIND_SKILL],
      description: '目标类型；target object 只用于选择 skill，因此固定传 `skill`。'
    },
    name: {
      type: ['string', 'null'],
      description: requireSkillName
        ? '必须填写单个 skill 的稳定 key。'
        : '填写单个 skill 的稳定 key；传 null 表示跨全部 skill。'
    }
  }, {
    nullable: true,
    description: requireSkillName
      ? '目标根。传 null 表示当前对话文件根；访问 skill 时传 {"kind":"skill","name":"<skill-key>"}。默认根的本机只读映射直接使用 `local/...` 路径。'
      : '目标根。传 null 表示当前对话文件根；列出或搜索 skill 时传 kind=`skill`，name=null 可跨全部 skill。默认根的本机只读映射直接使用 `local/...` 路径。'
  });
}

export function buildVirtualFileTargetSummary(target) {
  const normalizedTarget = ensurePlainObject(target);
  return {
    kind: normalizeVirtualFileTargetKind(
      normalizedTarget.kind,
      VIRTUAL_FILE_TARGET_KIND_ROOT
    ),
    name: normalizeOptionalString(normalizedTarget.name)
  };
}
