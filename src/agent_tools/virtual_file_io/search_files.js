import {
  CONVERSATION_DOCUMENT_SEARCH_DEFAULT_MAX_RESULTS,
  CONVERSATION_DOCUMENT_SEARCH_MAX_RESULTS,
  VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME,
  normalizeOptionalString,
  normalizeString
} from './shared.js';
import { buildVirtualFileTargetSchemaDescription } from './target.js';

function resolveSearchPattern(args) {
  const pattern = normalizeString(args.pattern);
  const query = normalizeString(args.query);
  if (pattern && query && pattern !== query) {
    throw new Error('virtual_file 参数错误：pattern 与 query 不能同时使用不同内容。');
  }
  return pattern || query;
}

function resolveSearchPathGlob(args) {
  const preferredGlob = normalizeOptionalString(args.glob);
  const legacyGlob = normalizeOptionalString(args.path_glob);
  const pathArg = normalizeOptionalString(args.path);
  const values = [preferredGlob, legacyGlob, pathArg].filter(Boolean);
  const uniqueValues = Array.from(new Set(values));
  if (uniqueValues.length > 1) {
    throw new Error('virtual_file 参数错误：glob、path_glob 与 path 不能同时指向不同过滤范围。');
  }
  return uniqueValues[0] || null;
}

function resolveSearchCaseMode(args) {
  const caseMode = normalizeOptionalString(args.case_mode);
  const ignoreCase = args.ignore_case === true;
  const caseSensitive = args.case_sensitive === true;
  if (ignoreCase && caseSensitive) {
    throw new Error('virtual_file 参数错误：ignore_case 与 case_sensitive 不能同时为 true。');
  }
  if (caseMode && (ignoreCase || caseSensitive)) {
    throw new Error('virtual_file 参数错误：不能同时使用 case_mode 与 ignore_case/case_sensitive。');
  }
  if (ignoreCase) return 'insensitive';
  if (caseSensitive) return 'sensitive';
  return caseMode;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value != null) return value;
  }
  return null;
}

function normalizeVirtualFileSearchArgs(args) {
  return {
    pattern: resolveSearchPattern(args),
    regex: args.regex === true,
    case_mode: resolveSearchCaseMode(args),
    path_glob: resolveSearchPathGlob(args),
    context_before: firstDefined(args.before, args.context, args.context_before),
    context_after: firstDefined(args.after, args.context, args.context_after),
    max_results: firstDefined(args.max_results, args.limit)
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
    description: '在虚拟文件中搜索文本或正则模式，调用方式尽量贴近 `rg "pattern" --glob "src/**/*.js" -n -C 2`。结果按接近 `rg --line-number --column` 的 `path:line:column:text` 纯文本行返回。默认作用于当前对话纯文本文件；当 `target.kind="skill"` 时可搜索单个或全部 skill 文件。',
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: buildVirtualFileTargetSchemaDescription({ requireSkillName: false }),
        pattern: {
          type: 'string',
          description: '必填。要搜索的固定字符串或正则模式，等价于 `rg <pattern>` 的 pattern。'
        },
        regex: {
          type: ['boolean', 'null'],
          description: '可选。为 true 时把 pattern 当作正则；为 false 时按固定字符串搜索。'
        },
        glob: {
          type: ['string', 'null'],
          description: '可选。rg 风格 glob 过滤，例如 `docs/**/*.md` 或 `src/**/*.js`；等价于旧参数 path_glob。'
        },
        path: {
          type: ['string', 'null'],
          description: '可选。bash/rg 风格的位置参数别名；在虚拟文件树中按 glob 解释，例如 `src/**/*.js`。'
        },
        case_mode: {
          type: ['string', 'null'],
          description: '兼容旧调用。可选，支持 smart、sensitive、insensitive。新调用可优先用 ignore_case 或 case_sensitive。'
        },
        ignore_case: {
          type: ['boolean', 'null'],
          description: '可选。等价于 `rg -i`。'
        },
        case_sensitive: {
          type: ['boolean', 'null'],
          description: '可选。强制大小写敏感。不能和 ignore_case 同时为 true。'
        },
        path_glob: {
          type: ['string', 'null'],
          description: '兼容旧调用。可选，按虚拟文件路径过滤；新调用优先用 `glob`。'
        },
        context: {
          type: ['integer', 'null'],
          description: '可选。等价于 `rg -C <n>`，同时返回命中前后 n 行。'
        },
        before: {
          type: ['integer', 'null'],
          description: '可选。等价于 `rg -B <n>`，返回命中前 n 行。'
        },
        after: {
          type: ['integer', 'null'],
          description: '可选。等价于 `rg -A <n>`，返回命中后 n 行。'
        },
        context_before: {
          type: ['integer', 'null'],
          description: '兼容旧调用。可选，返回命中行之前的上下文行数；新调用优先用 before/context。'
        },
        context_after: {
          type: ['integer', 'null'],
          description: '兼容旧调用。可选，返回命中行之后的上下文行数；新调用优先用 after/context。'
        },
        max_results: {
          type: ['integer', 'null'],
          description: `可选。返回的最大命中数。默认 ${CONVERSATION_DOCUMENT_SEARCH_DEFAULT_MAX_RESULTS}，最大 ${CONVERSATION_DOCUMENT_SEARCH_MAX_RESULTS}。`
        },
        limit: {
          type: ['integer', 'null'],
          description: '可选。max_results 的短别名。'
        }
      },
      required: ['pattern']
    }
  };
}

export function buildConversationDocumentSearchFilesFunctionToolDefinition() {
  return buildVirtualFileSearchFilesFunctionToolDefinition();
}
