import {
  VIRTUAL_FILE_LIST_FILES_TOOL_NAME
} from './shared.js';
import { buildVirtualFileEnvironmentIdSchema } from './environment.js';
import {
  buildModelToolDescription,
  buildStrictFunctionToolDefinition
} from '../shared/model_tool_contract.js';
import { normalizeVirtualPathFilter } from '../shared/virtual_file_path.js';

function normalizeVirtualFilePathGlob(value) {
  return normalizeVirtualPathFilter(value, { label: 'path_glob' });
}

export function normalizeVirtualFileListFilesArguments(args, environment) {
  return {
    action: VIRTUAL_FILE_LIST_FILES_TOOL_NAME,
    environment,
    path_glob: normalizeVirtualFilePathGlob(args.path_glob)
  };
}

export function buildVirtualFileListFilesFunctionToolDefinition() {
  return buildStrictFunctionToolDefinition({
    name: VIRTUAL_FILE_LIST_FILES_TOOL_NAME,
    description: buildModelToolDescription({
      purpose: '列出所选虚拟文件根中的文件路径，不读取正文。',
      input: 'environment_id=null 选择当前对话文件；Skill 使用 `skill:<stable-key>`。path_glob 可限制根相对路径。当前对话根只有显式使用 `local` 或 `local/...` 才列出本机只读映射。',
      output: '每行返回一个根相对路径；没有文件时返回 `No files found.`。'
    }),
    properties: {
      environment_id: buildVirtualFileEnvironmentIdSchema(),
      path_glob: {
        type: ['string', 'null'],
        description: '根相对路径过滤；null 或 `.` 表示全部，支持 `*`、`?`、`**`。'
      }
    },
    outputControlDescription: '本页最多返回多少字符，最小 256；null 默认 5000。结果过长时返回 next_cursor。'
  });
}

export function buildConversationDocumentListFilesFunctionToolDefinition() {
  return buildVirtualFileListFilesFunctionToolDefinition();
}
