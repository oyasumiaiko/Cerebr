import {
  VIRTUAL_FILE_COPY_FILE_TOOL_NAME,
  normalizeString
} from './shared.js';
import { normalizeVirtualFilePath } from '../shared/virtual_file_path.js';
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
  return normalizeVirtualFilePath(path, { label });
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
      useWhen: '需要保留源文件，或把默认根中的 `local/...` 只读映射复制成可写副本。skill 的 manifest.json 可以复制出到普通路径。',
      avoidWhen: '需要移动/重命名时使用 apply_patch 的 `*** Move to:`；需要删除时使用 `*** Delete File:`。',
      input: 'target=null 时 from/to 都相对默认根，from 也可指向 `local/...` 只读映射；target=skill 时 from/to 都相对同一个 skill，`local/...` 是普通 skill 路径。路径必须根相对，目标存在时覆盖。',
      output: '与 cp 一样，目标存在时覆盖；成功返回最小 Success 状态，失败返回 Error。'
    }),
    properties: {
      target: buildMutationTargetDescription(),
      from: {
        type: 'string',
        description: '所选根下的相对源路径。默认根允许读取 `local/...` 本机只读映射；skill 允许从虚拟 manifest.json 复制出。'
      },
      to: {
        type: 'string',
        description: '所选根下的相对目标路径，已存在时覆盖。默认根不能写入 `local/...`；skill 不能把 manifest.json 作为目标。'
      }
    }
  });
}

export function buildConversationDocumentCopyFileFunctionToolDefinition() {
  return buildVirtualFileCopyFileFunctionToolDefinition();
}
