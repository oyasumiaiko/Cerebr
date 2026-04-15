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
    description: '对虚拟文件应用 Codex apply_patch。支持当前对话纯文本文件和 skill 文件；可用于笔记、Markdown、代码、HTML、配置等任意纯文本格式，不会修改真实工作区文件。',
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
