import {
  VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
  normalizeString
} from './shared.js';
import { normalizeVirtualFileEnvironmentId } from './environment.js';
import { parseApplyPatch } from '../shared/apply_patch_core.js';
import {
  APPLY_PATCH_CUSTOM_TOOL_DESCRIPTION,
  APPLY_PATCH_LARK_GRAMMAR
} from '../shared/apply_patch_contract.js';

export { APPLY_PATCH_LARK_GRAMMAR };

export function normalizeVirtualFileApplyPatchArguments(args, environment) {
  const patch = typeof args.patch === 'string' ? args.patch : '';
  if (!normalizeString(patch)) {
    throw new Error('virtual_file 参数错误：apply_patch 需要 patch。');
  }
  return {
    action: VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
    environment,
    patch
  };
}

export function normalizeVirtualFileApplyPatchCustomInput(input) {
  const patch = typeof input === 'string' ? input : '';
  const parsed = parseApplyPatch(patch);
  const environmentId = normalizeString(parsed.environment_id);
  return {
    action: VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
    environment: normalizeVirtualFileEnvironmentId(environmentId || null),
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
