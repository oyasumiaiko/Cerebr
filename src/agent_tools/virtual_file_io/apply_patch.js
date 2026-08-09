import {
  VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
  VIRTUAL_FILE_TARGET_KIND_CONVERSATION_DOCUMENT,
  VIRTUAL_FILE_TARGET_KIND_SKILL,
  normalizeString
} from './shared.js';
import { parseApplyPatch } from '../shared/apply_patch_core.js';

export const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch environment_id? hunk+ end_patch
environment_id: "*** Environment ID: " filename LF
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

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
      target: { kind: VIRTUAL_FILE_TARGET_KIND_CONVERSATION_DOCUMENT, name: null },
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
    description: [
      'The `apply_patch` tool edits writable virtual text files. This is a FREEFORM tool, so emit the patch directly and do not wrap it in JSON.',
      'Omit `*** Environment ID:` to edit the current conversation file space.',
      'To edit one skill, put `*** Environment ID: skill:<stable-key>` immediately after `*** Begin Patch`.',
      'The read-only `local/...` mount cannot be modified.'
    ].join(' '),
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
