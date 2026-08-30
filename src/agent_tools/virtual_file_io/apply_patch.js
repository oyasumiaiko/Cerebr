import {
  VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
  VIRTUAL_FILE_TARGET_KIND_ROOT,
  VIRTUAL_FILE_TARGET_KIND_SKILL,
  normalizeString
} from './shared.js';
import { parseApplyPatch } from '../shared/apply_patch_core.js';
import {
  APPLY_PATCH_CUSTOM_TOOL_DESCRIPTION,
  APPLY_PATCH_LARK_GRAMMAR
} from '../shared/apply_patch_contract.js';

export { APPLY_PATCH_LARK_GRAMMAR };

export function normalizeVirtualFileApplyPatchArguments(args, target) {
  const patch = typeof args.patch === 'string' ? args.patch : '';
  if (!normalizeString(patch)) {
    throw new Error('virtual_file 参数错误：apply_patch 需要 patch。');
  }
  return {
    action: VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
    target,
    patch
  };
}

export function normalizeVirtualFileApplyPatchCustomInput(input) {
  const patch = typeof input === 'string' ? input : '';
  const parsed = parseApplyPatch(patch, { mode: 'strict' });
  const environmentId = normalizeString(parsed.environment_id);
  if (!environmentId) {
    return {
      action: VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
      target: { kind: VIRTUAL_FILE_TARGET_KIND_ROOT, name: null },
      patch
    };
  }
  if (!environmentId.startsWith('skill:')) {
    throw new Error(`apply_patch Environment ID 不受支持：${environmentId}。仅允许 skill:<stable-key>。`);
  }
  const skillName = normalizeString(environmentId.slice('skill:'.length));
  if (!skillName) {
    throw new Error('apply_patch Environment ID 中的 skill stable-key 不能为空。');
  }
  return {
    action: VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
    target: { kind: VIRTUAL_FILE_TARGET_KIND_SKILL, name: skillName },
    patch
  };
}

export function buildVirtualFileApplyPatchCustomToolDefinition() {
  return {
    type: 'custom',
    name: VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
    description: APPLY_PATCH_CUSTOM_TOOL_DESCRIPTION,
    format: {
      type: 'grammar',
      syntax: 'lark',
      definition: APPLY_PATCH_LARK_GRAMMAR
    }
  };
}

export function buildConversationDocumentApplyPatchCustomToolDefinition() {
  return buildVirtualFileApplyPatchCustomToolDefinition();
}
