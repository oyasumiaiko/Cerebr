import {
  VIRTUAL_FILE_LIST_FILES_TOOL_NAME,
  normalizeOptionalString
} from './shared.js';
import { buildVirtualFileTargetSchemaDescription } from './target.js';

export function normalizeVirtualFileListFilesArguments(args, target) {
  return {
    action: VIRTUAL_FILE_LIST_FILES_TOOL_NAME,
    target,
    path_glob: normalizeOptionalString(args.path_glob)
  };
}

export function buildVirtualFileListFilesFunctionToolDefinition() {
  return {
    type: 'function',
    name: VIRTUAL_FILE_LIST_FILES_TOOL_NAME,
    description: '列出虚拟文件路径，输出为紧凑的 path + 简短标记/大小行。默认作用于 workspace 可写区；传 `path_glob="local/..."` 时列出用户授权的本地只读映射；当 `target.kind="skill"` 时可列出单个或全部 skill 文件。',
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: buildVirtualFileTargetSchemaDescription({ requireSkillName: false }),
        path_glob: {
          type: ['string', 'null'],
          description: '可选。按虚拟文件路径过滤，例如 `workspace/**/*.md`、`local/project/**/*.js` 或 `src/**/*.js`。'
        }
      }
    }
  };
}

export function buildConversationDocumentListFilesFunctionToolDefinition() {
  return buildVirtualFileListFilesFunctionToolDefinition();
}
