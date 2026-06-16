import {
  CONVERSATION_DOCUMENT_SEARCH_DEFAULT_MAX_RESULTS,
  CONVERSATION_DOCUMENT_SEARCH_MAX_RESULTS,
  VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME,
  normalizeOptionalString,
  normalizeString
} from './shared.js';
import { buildVirtualFileTargetSchemaDescription } from './target.js';

function resolveSearchPathGlob(args) {
  const normalized = normalizeOptionalString(args.glob)?.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '') || null;
  if (!normalized) return null;
  const withoutLeadingSlash = normalized.startsWith('/') ? normalized.slice(1) : normalized;
  if (withoutLeadingSlash === 'workspace') return null;
  return withoutLeadingSlash.startsWith('workspace/')
    ? withoutLeadingSlash.slice('workspace/'.length)
    : withoutLeadingSlash;
}

function resolveSearchCaseMode(args) {
  const ignoreCase = args.ignore_case === true;
  if (ignoreCase) return 'insensitive';
  return null;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value != null) return value;
  }
  return null;
}

function normalizeVirtualFileSearchArgs(args) {
  return {
    pattern: normalizeString(args.pattern),
    regex: args.regex === true,
    case_mode: resolveSearchCaseMode(args),
    path_glob: resolveSearchPathGlob(args),
    context_before: firstDefined(args.before, args.context),
    context_after: firstDefined(args.after, args.context),
    max_results: args.limit
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
    description: '在虚拟文件中搜索文本或正则模式，调用方式尽量贴近 `rg "pattern" --glob "src/**/*.js" -n -C 2`。结果按接近 `rg --heading --line-number --column` 的纯文本块返回：每个文件路径只作为 heading 出现一次，下面是 `line:column:text` / `line-context` 行。默认作用于当前对话文件区；传 `glob="local/..."` 时搜索用户授权的本地只读映射；当 `target.kind="skill"` 时可搜索单个或全部 skill 文件。',
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
          description: '可选。rg 风格 glob 过滤，例如 `**/*.md`、`local/project/**/*.js` 或 `src/**/*.js`。'
        },
        ignore_case: {
          type: ['boolean', 'null'],
          description: '可选。等价于 `rg -i`。'
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
        limit: {
          type: ['integer', 'null'],
          description: `可选。最多返回的命中数。默认 ${CONVERSATION_DOCUMENT_SEARCH_DEFAULT_MAX_RESULTS}，最大 ${CONVERSATION_DOCUMENT_SEARCH_MAX_RESULTS}。`
        }
      },
      required: ['pattern']
    }
  };
}

export function buildConversationDocumentSearchFilesFunctionToolDefinition() {
  return buildVirtualFileSearchFilesFunctionToolDefinition();
}
