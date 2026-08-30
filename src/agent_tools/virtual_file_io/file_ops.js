import {
  VIRTUAL_FILE_COPY_FILE_TOOL_NAME,
  normalizeString
} from './shared.js';
import { normalizeVirtualFilePath } from '../shared/virtual_file_path.js';
import { buildVirtualFileEnvironmentIdSchema } from './environment.js';
import {
  buildModelToolDescription,
  buildStrictFunctionToolDefinition
} from '../shared/model_tool_contract.js';

function normalizeOperationPath(value, label) {
  const path = normalizeString(value);
  if (!path) {
    throw new Error(`virtual_file 参数错误：${label} 不能为空。`);
  }
  return normalizeVirtualFilePath(path, { label });
}

export function normalizeVirtualFileCopyFileArguments(args, environment) {
  return {
    action: VIRTUAL_FILE_COPY_FILE_TOOL_NAME,
    environment,
    source_path: normalizeOperationPath(args.from, 'copy_file.from'),
    destination_path: normalizeOperationPath(args.to, 'copy_file.to')
  };
}

export function buildVirtualFileCopyFileFunctionToolDefinition() {
  return buildStrictFunctionToolDefinition({
    name: VIRTUAL_FILE_COPY_FILE_TOOL_NAME,
    description: buildModelToolDescription({
      purpose: '在同一虚拟文件根内复制一个文件。',
      input: 'environment_id 选择文件根；from/to 都是该根下的相对路径。当前对话根的 from 可读取 `local/...`，但 to 不能写入 `local/...`。目标已存在时覆盖。',
      output: '成功返回 `Success.`；失败返回具体错误。'
    }),
    properties: {
      environment_id: buildVirtualFileEnvironmentIdSchema(),
      from: {
        type: 'string',
        description: '所选根下的相对源路径。默认根允许读取 `local/...` 本机只读映射；skill 允许从虚拟 manifest.json 复制出。'
      },
      to: {
        type: 'string',
        description: '所选根下的相对目标路径，已存在时覆盖。默认根不能写入 `local/...`；skill 不能把 manifest.json 作为目标。'
      }
    },
    includeOutputControl: false
  });
}

export function buildConversationDocumentCopyFileFunctionToolDefinition() {
  return buildVirtualFileCopyFileFunctionToolDefinition();
}
