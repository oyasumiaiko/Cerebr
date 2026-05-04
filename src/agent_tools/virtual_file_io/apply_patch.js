import {
  VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
  normalizeString
} from './shared.js';
import { buildVirtualFileTargetSchemaDescription } from './target.js';

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

export function buildVirtualFileApplyPatchFunctionToolDefinition() {
  return {
    type: 'function',
    name: VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
    description: '对可写虚拟纯文本文件应用 Codex apply_patch，可修改 Markdown、HTML、JS、CSS 等文本内容。默认修改 workspace 可写区；skill 文件需传 `target.kind="skill"` 与 `target.name`。本地映射路径 `local/...` 是只读的，需要修改时先用 copy_file 复制到 workspace。如果在 workspace 中新增或修改了需要交付给用户的文件，最终回复应给出 Markdown 相对路径链接，例如 [计划](workspace/plan.md)。',
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: buildVirtualFileTargetSchemaDescription({ requireSkillName: true }),
        patch: {
          type: 'string',
          description: '补丁文本。必须使用 `*** Begin Patch` / `*** Update File:` / `*** Add File:` / `*** Delete File:` / `*** End Patch` 语法。'
        }
      },
      required: ['patch']
    }
  };
}

export function buildConversationDocumentApplyPatchFunctionToolDefinition() {
  return buildVirtualFileApplyPatchFunctionToolDefinition();
}
