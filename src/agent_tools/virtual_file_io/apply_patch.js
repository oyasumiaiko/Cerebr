import {
  VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
  normalizeString
} from './shared.js';
import { buildVirtualFileTargetSchemaDescription } from './target.js';
import {
  buildModelToolDescription,
  buildStrictFunctionToolDefinition
} from '../shared/model_tool_contract.js';

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
  return buildStrictFunctionToolDefinition({
    name: VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
    description: buildModelToolDescription({
      purpose: '用 Codex apply_patch 语法原子地新增、修改或删除一个或多个可写虚拟文本文件。',
      useWhen: [
        '需要对当前对话文件区中的 Markdown、HTML、JavaScript、CSS 等文本做精确变更',
        '需要修改单个 skill 包中的文件，并且已经知道该 skill 的稳定 key'
      ],
      avoidWhen: [
        '不要直接修改 `local/...` 本地映射；它是只读的，应先用 copy_file 复制到当前对话文件区',
        '不要用整文件重写代替可以清晰表达的局部补丁'
      ],
      input: 'target=null 修改当前对话文件区；修改 skill 时传 target.kind=`skill` 与 target.name。patch 必须包含完整 Begin/End Patch 边界。',
      output: '成功时返回紧凑变更清单，使用 A/M/D 标记新增、修改、删除文件；失败时只返回 Error，不会把失败伪装成成功。'
    }),
    properties: {
      target: buildVirtualFileTargetSchemaDescription({ requireSkillName: true }),
      patch: {
        type: 'string',
        description: '完整补丁文本。必须使用 `*** Begin Patch`，并包含一个或多个 `*** Update File:` / `*** Add File:` / `*** Delete File:` 段，最后以 `*** End Patch` 结束。'
      }
    }
  });
}

export function buildConversationDocumentApplyPatchFunctionToolDefinition() {
  return buildVirtualFileApplyPatchFunctionToolDefinition();
}
