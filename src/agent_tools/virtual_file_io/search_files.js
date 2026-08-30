import {
  VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME,
  normalizeString
} from './shared.js';
import { buildVirtualFileEnvironmentIdSchema } from './environment.js';
import {
  buildModelToolDescription,
  buildStrictFunctionToolDefinition
} from '../shared/model_tool_contract.js';
import { normalizeVirtualPathFilter } from '../shared/virtual_file_path.js';
import { readNullableSafeInteger } from './text_query.js';

function normalizeVirtualFileSearchArgs(args) {
  if (args.regex != null && typeof args.regex !== 'boolean') {
    throw new Error('virtual_file 参数错误：regex 必须是 boolean 或 null。');
  }
  if (args.ignore_case != null && typeof args.ignore_case !== 'boolean') {
    throw new Error('virtual_file 参数错误：ignore_case 必须是 boolean 或 null。');
  }
  return {
    pattern: normalizeString(args.pattern),
    regex: args.regex === true,
    ignore_case: args.ignore_case === true,
    path_glob: normalizeVirtualPathFilter(args.path_glob, { label: 'path_glob' }),
    context_lines: readNullableSafeInteger(args.context_lines, {
      label: 'context_lines',
      minimum: 0,
      maximum: 20
    }) ?? 0
  };
}

export function normalizeVirtualFileSearchFilesArguments(args, environment) {
  const searchArgs = normalizeVirtualFileSearchArgs(args);
  if (!searchArgs.pattern) {
    throw new Error('virtual_file 参数错误：search_files 需要 pattern。');
  }
  return {
    action: VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME,
    environment,
    ...searchArgs
  };
}

export function buildVirtualFileSearchFilesFunctionToolDefinition() {
  return buildStrictFunctionToolDefinition({
    name: VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME,
    description: buildModelToolDescription({
      purpose: '在所选虚拟文件根的文本文件中按行搜索固定字符串或正则表达式。',
      input: 'environment_id 选择文件根；regex 控制 pattern 是否为正则；ignore_case 控制大小写；path_glob 限制路径；context_lines 返回命中前后行。',
      output: '按文件分组返回 `行号:正文`；同一行只返回一次，重叠上下文会合并。'
    }),
    properties: {
      environment_id: buildVirtualFileEnvironmentIdSchema(),
      pattern: {
        type: 'string',
        description: '要搜索的非空固定字符串或正则表达式。'
      },
      regex: {
        type: ['boolean', 'null'],
        description: 'true 将 pattern 解释为正则；false 或 null 按固定字符串搜索。'
      },
      path_glob: {
        type: ['string', 'null'],
        description: '根相对路径过滤；null 或 `.` 表示全部，支持 `*`、`?`、`**`。'
      },
      ignore_case: {
        type: ['boolean', 'null'],
        description: 'true 忽略大小写；false 或 null 区分大小写。'
      },
      context_lines: {
        type: ['integer', 'null'],
        minimum: 0,
        maximum: 20,
        description: '命中前后各返回多少行，范围 0-20；null 表示 0。'
      }
    },
    outputControlDescription: '本页最多返回多少字符，最小 256；null 默认 5000。结果过长时返回 next_cursor。'
  });
}

export function buildConversationDocumentSearchFilesFunctionToolDefinition() {
  return buildVirtualFileSearchFilesFunctionToolDefinition();
}
