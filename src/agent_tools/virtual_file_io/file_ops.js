import { normalizeSkillFilePath } from '../skill/registry_tool.js';
import {
  VIRTUAL_FILE_COPY_FILE_TOOL_NAME,
  VIRTUAL_FILE_TARGET_KIND_SKILL,
  normalizeString
} from './shared.js';
import { normalizeConversationDocumentPath } from './document_path.js';
import { buildVirtualFileTargetSchemaDescription } from './target.js';
import {
  buildModelToolDescription,
  buildStrictFunctionToolDefinition
} from '../shared/model_tool_contract.js';

function normalizeOperationPath(value, target, label) {
  const path = normalizeString(value);
  if (!path) {
    throw new Error(`virtual_file 参数错误：${label} 不能为空。`);
  }
  return target?.kind === VIRTUAL_FILE_TARGET_KIND_SKILL
    ? normalizeSkillFilePath(path)
    : normalizeConversationDocumentPath(path);
}

function buildMutationTargetDescription() {
  return buildVirtualFileTargetSchemaDescription({ requireSkillName: true });
}

export function normalizeVirtualFileCopyFileArguments(args, target) {
  return {
    action: VIRTUAL_FILE_COPY_FILE_TOOL_NAME,
    target,
    source_path: normalizeOperationPath(args.from, target, 'copy_file.from'),
    destination_path: normalizeOperationPath(args.to, target, 'copy_file.to')
  };
}

export function buildVirtualFileCopyFileFunctionToolDefinition() {
  return buildStrictFunctionToolDefinition({
    name: VIRTUAL_FILE_COPY_FILE_TOOL_NAME,
    description: buildModelToolDescription({
      purpose: '复制一个虚拟文件到同一目标作用域中的新路径，语义对齐 `cp -- from to`。',
      useWhen: '需要保留源文件，或把 `local/...` 只读映射复制成当前对话文件区中的可写副本。',
      avoidWhen: '需要移动/重命名时使用 apply_patch 的 `*** Move to:`；需要删除时使用 `*** Delete File:`。',
      input: 'target=null 时，to 是当前对话文件路径，from 既可指向当前对话文件，也可指向 `local/...` 只读映射；target=skill 时 from/to 都相对同一个 skill。',
      output: '与 cp 一样，目标存在时覆盖；成功返回最小 Success 状态，失败返回 Error。'
    }),
    properties: {
      target: buildMutationTargetDescription(),
      from: {
        type: 'string',
        description: '源文件路径。允许从 `local/...` 只读映射读取。'
      },
      to: {
        type: 'string',
        description: '目标路径。已存在时覆盖；`local/...` 不能作为可写目标。'
      }
    }
  });
}

export function buildConversationDocumentCopyFileFunctionToolDefinition() {
  return buildVirtualFileCopyFileFunctionToolDefinition();
}
