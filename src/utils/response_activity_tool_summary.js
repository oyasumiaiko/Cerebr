import { buildMicroSkillApplyPatchPreview } from './micro_skill_patch_preview.js';

export const RESPONSE_ACTIVITY_SKILL_REGISTRY_TOOL_NAME = 'skill_registry';
export const RESPONSE_ACTIVITY_LEGACY_MICRO_SKILL_REGISTRY_TOOL_NAME = 'micro_skill_registry';

function normalizeSummaryText(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

function parseArgumentsObject(rawArguments) {
  if (rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)) {
    return rawArguments;
  }
  const text = normalizeSummaryText(rawArguments);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function joinSummaryMeta(parts) {
  return parts
    .map((part) => normalizeSummaryText(part))
    .filter(Boolean)
    .join(' · ');
}

function resolveMicroSkillSummarySkillName(args) {
  return normalizeSummaryText(args?.skill_name || args?.skill?.name);
}

function resolveMicroSkillSummaryFilePath(args) {
  return normalizeSummaryText(args?.file_path || args?.file?.path);
}

function buildApplyPatchSummaryParts(args, options = {}) {
  const preview = buildMicroSkillApplyPatchPreview(args);
  const isInProgress = options?.isInProgress === true;
  if (!preview || !Array.isArray(preview.files) || preview.files.length <= 0) {
    return {
      action: isInProgress ? '正在修改技能' : '修改技能',
      value: resolveMicroSkillSummarySkillName(args) || '技能文件',
      meta: ''
    };
  }

  const firstFile = preview.files[0] || null;
  const metaParts = [];
  if (preview.totalAdditions > 0) metaParts.push(`+${preview.totalAdditions}`);
  if (preview.totalDeletions > 0) metaParts.push(`-${preview.totalDeletions}`);
  if (preview.totalFiles > 1) metaParts.push(`另 ${preview.totalFiles - 1} 个文件`);

  return {
    action: isInProgress ? '正在修改' : '修改了',
    value: normalizeSummaryText(firstFile?.path) || resolveMicroSkillSummarySkillName(args) || '技能文件',
    meta: joinSummaryMeta(metaParts)
  };
}

function resolveMicroSkillActionLabel(action, options = {}) {
  const normalizedAction = normalizeSummaryText(action).toLowerCase();
  const isInProgress = options?.isInProgress === true;
  switch (normalizedAction) {
    case 'list':
      return isInProgress ? '正在查看技能列表' : '查看技能列表';
    case 'list_files':
      return isInProgress ? '正在查看文件列表' : '查看文件列表';
    case 'search_files':
      return isInProgress ? '正在搜索文件' : '搜索文件';
    case 'read_detail':
      return isInProgress ? '正在读取技能详情' : '读取技能详情';
    case 'read_package':
      return isInProgress ? '正在读取技能包' : '读取技能包';
    case 'read_file':
      return isInProgress ? '正在读取文件' : '读取文件';
    case 'create_skill':
      return isInProgress ? '正在创建技能' : '创建技能';
    case 'update':
      return isInProgress ? '正在更新技能' : '更新技能';
    case 'delete_file':
      return isInProgress ? '正在删除文件' : '删除文件';
    case 'delete_skill':
      return isInProgress ? '正在删除技能' : '删除技能';
    case 'enable_skill':
      return isInProgress ? '正在启用技能' : '启用技能';
    case 'disable_skill':
      return isInProgress ? '正在停用技能' : '停用技能';
    case 'refresh_current_document':
      return isInProgress ? '正在刷新当前文档挂载' : '刷新当前文档挂载';
    default:
      return isInProgress ? '正在执行技能操作' : '执行技能操作';
  }
}

function buildMicroSkillRegistryTargetParts(args, options = {}) {
  const normalizedAction = normalizeSummaryText(args?.action).toLowerCase();
  const skillName = resolveMicroSkillSummarySkillName(args);
  const filePath = resolveMicroSkillSummaryFilePath(args);
  const pattern = normalizeSummaryText(args?.pattern);
  const pathGlob = normalizeSummaryText(args?.path_glob);
  if (normalizedAction === 'apply_patch') {
    return buildApplyPatchSummaryParts(args, options);
  }

  const action = resolveMicroSkillActionLabel(normalizedAction, options);
  switch (normalizedAction) {
    case 'list':
      return { action, value: '全部技能', meta: '' };
    case 'list_files':
      return { action, value: skillName || '全部技能', meta: '' };
    case 'search_files':
      return {
        action,
        value: pattern || skillName || '技能文件',
        meta: joinSummaryMeta([skillName && pattern !== skillName ? skillName : '', pathGlob])
      };
    case 'read_detail':
    case 'read_package':
    case 'create_skill':
    case 'update':
    case 'delete_skill':
    case 'enable_skill':
    case 'disable_skill':
      return {
        action,
        value: skillName || '技能',
        meta: ''
      };
    case 'read_file':
    case 'delete_file':
      return {
        action,
        value: filePath || skillName || '技能文件',
        meta: (skillName && filePath) ? skillName : ''
      };
    case 'refresh_current_document':
      return {
        action,
        value: skillName || '当前文档',
        meta: ''
      };
    default:
      return {
        action,
        value: skillName || filePath || RESPONSE_ACTIVITY_SKILL_REGISTRY_TOOL_NAME,
        meta: ''
      };
  }
}

export function isMicroSkillRegistryToolCall(record) {
  return String(record?.type || '').toLowerCase() === 'function_call'
    && new Set([
      RESPONSE_ACTIVITY_SKILL_REGISTRY_TOOL_NAME,
      RESPONSE_ACTIVITY_LEGACY_MICRO_SKILL_REGISTRY_TOOL_NAME
    ]).has(normalizeSummaryText(record?.name).toLowerCase());
}

export function getMicroSkillRegistryToolTypeLabel(record) {
  return isMicroSkillRegistryToolCall(record) ? '技能' : '';
}

export function buildMicroSkillRegistrySummaryParts(record, options = {}) {
  if (!isMicroSkillRegistryToolCall(record)) return null;
  const args = parseArgumentsObject(record?.arguments);
  if (!args) {
    const action = options?.isInProgress === true ? '正在执行技能操作' : '执行技能操作';
    return {
      action,
      value: RESPONSE_ACTIVITY_SKILL_REGISTRY_TOOL_NAME,
      valueUrl: '',
      meta: '',
      locationAction: '',
      locationValue: '',
      locationUrl: ''
    };
  }

  const summary = buildMicroSkillRegistryTargetParts(args, options);
  return {
    action: summary.action || '',
    value: summary.value || '',
    valueUrl: '',
    meta: summary.meta || '',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  };
}

export function buildMicroSkillRegistryPrimaryText(record, options = {}) {
  const parts = buildMicroSkillRegistrySummaryParts(record, options);
  if (!parts) return '';
  return [parts.action, parts.value, parts.meta]
    .map((part) => normalizeSummaryText(part))
    .filter(Boolean)
    .join(' ');
}
