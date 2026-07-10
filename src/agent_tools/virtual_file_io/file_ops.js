import { normalizeSkillFilePath } from '../skill/registry_tool.js';
import {
  VIRTUAL_FILE_COPY_FILE_TOOL_NAME,
  VIRTUAL_FILE_MOVE_FILE_TOOL_NAME,
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

export function normalizeVirtualFileMoveFileArguments(args, target) {
  return {
    action: VIRTUAL_FILE_MOVE_FILE_TOOL_NAME,
    target,
    source_path: normalizeOperationPath(args.from, target, 'move_file.from'),
    destination_path: normalizeOperationPath(args.to, target, 'move_file.to')
  };
}

export function buildVirtualFileCopyFileFunctionToolDefinition() {
  return buildStrictFunctionToolDefinition({
    name: VIRTUAL_FILE_COPY_FILE_TOOL_NAME,
    description: buildModelToolDescription({
      purpose: '复制一个虚拟文件到同一目标作用域中的新路径，等价于不覆盖的 `cp from to`。',
      useWhen: '需要保留源文件，或把 `local/...` 只读映射复制成当前对话文件区中的可写副本。',
      avoidWhen: '需要重命名且不保留源文件时使用 move_file；目标路径已存在时不要调用，因为不会覆盖。',
      input: 'target=null 时，to 是当前对话文件路径，from 既可指向当前对话文件，也可指向 `local/...` 只读映射；target=skill 时 from/to 都相对同一个 skill。',
      output: '成功返回 `copy <from> -> <to>`；失败只返回 Error。'
    }),
    properties: {
      target: buildMutationTargetDescription(),
      from: {
        type: 'string',
        description: '源文件路径。允许从 `local/...` 只读映射读取。'
      },
      to: {
        type: 'string',
        description: '新目标路径。必须不存在；`local/...` 不能作为可写目标。'
      }
    }
  });
}

export function buildVirtualFileMoveFileFunctionToolDefinition() {
  return buildStrictFunctionToolDefinition({
    name: VIRTUAL_FILE_MOVE_FILE_TOOL_NAME,
    description: buildModelToolDescription({
      purpose: '移动或重命名一个可写虚拟文件，等价于不覆盖的 `mv from to`。',
      useWhen: '需要改变当前对话文件或 skill 文件的路径，并且不需要保留源路径。',
      avoidWhen: '不要移动 `local/...` 真实本机映射；需要保留源文件时使用 copy_file；目标已存在时不会覆盖。',
      input: 'target=null 操作当前对话文件区；操作 skill 时指定 target.name。from 与 to 必须属于同一可写目标作用域。',
      output: '成功返回 `move <from> -> <to>`；失败只返回 Error。'
    }),
    properties: {
      target: buildMutationTargetDescription(),
      from: {
        type: 'string',
        description: '现有可写虚拟文件路径。不能是 `local/...`。'
      },
      to: {
        type: 'string',
        description: '新路径。必须不存在，且不能是 `local/...`。'
      }
    }
  });
}

export function buildConversationDocumentCopyFileFunctionToolDefinition() {
  return buildVirtualFileCopyFileFunctionToolDefinition();
}

export function buildConversationDocumentMoveFileFunctionToolDefinition() {
  return buildVirtualFileMoveFileFunctionToolDefinition();
}
