import {
  CONVERSATION_DOCUMENT_SEARCH_DEFAULT_MAX_RESULTS,
  CONVERSATION_DOCUMENT_SEARCH_MAX_RESULTS,
  VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME,
  normalizeOptionalString,
  normalizeString
} from './shared.js';
import { buildVirtualFileTargetSchemaDescription } from './target.js';

function normalizeVirtualFileSearchArgs(args) {
  return {
    pattern: normalizeString(args.pattern),
    regex: args.regex === true,
    case_mode: normalizeOptionalString(args.case_mode),
    path_glob: normalizeOptionalString(args.path_glob),
    context_before: args.context_before,
    context_after: args.context_after,
    max_results: args.max_results
  };
}

export function normalizeVirtualFileSearchFilesArguments(args, target) {
  const searchArgs = normalizeVirtualFileSearchArgs(args);
  if (!searchArgs.pattern) {
    throw new Error('virtual_file 参数错误：search_files 需要 pattern。');
  }
  return {
    action: VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME,
    target,
    ...searchArgs
  };
}

export function buildVirtualFileSearchFilesFunctionToolDefinition() {
  return {
    type: 'function',
    name: VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME,
    description: '在虚拟文件中搜索文本或正则模式。默认作用于当前对话文档；当 `target.kind="skill"` 时可搜索单个或全部 skill 文件。',
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: buildVirtualFileTargetSchemaDescription({ requireSkillName: false }),
        pattern: {
          type: 'string',
          description: '必填。固定字符串或正则模式。'
        },
        regex: {
          type: ['boolean', 'null'],
          description: '可选。为 true 时把 pattern 当作正则。'
        },
        case_mode: {
          type: ['string', 'null'],
          description: '可选。支持 smart、sensitive、insensitive。默认 smart。'
        },
        path_glob: {
          type: ['string', 'null'],
          description: '可选。按虚拟文件路径过滤，例如 `docs/**/*.md` 或 `src/**/*.js`。'
        },
        context_before: {
          type: ['integer', 'null'],
          description: '可选。返回命中行之前的上下文行数。'
        },
        context_after: {
          type: ['integer', 'null'],
          description: '可选。返回命中行之后的上下文行数。'
        },
        max_results: {
          type: ['integer', 'null'],
          description: `可选。返回的最大命中数。默认 ${CONVERSATION_DOCUMENT_SEARCH_DEFAULT_MAX_RESULTS}，最大 ${CONVERSATION_DOCUMENT_SEARCH_MAX_RESULTS}。`
        }
      },
      required: ['pattern']
    }
  };
}

export function buildConversationDocumentSearchFilesFunctionToolDefinition() {
  return buildVirtualFileSearchFilesFunctionToolDefinition();
}
