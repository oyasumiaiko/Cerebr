import { normalizeSkillFilePath } from '../skill/registry_tool.js';
import { normalizeConversationDocumentPath } from './document_path.js';
import {
  CONVERSATION_DOCUMENT_READ_DEFAULT_RANGE_CHARS,
  CONVERSATION_DOCUMENT_READ_MAX_CHARS,
  VIRTUAL_FILE_READ_FILE_TOOL_NAME,
  VIRTUAL_FILE_TARGET_KIND_SKILL,
  normalizeString
} from './shared.js';
import { buildVirtualFileTargetSchemaDescription } from './target.js';

function resolveReadFilePath(args) {
  const filePath = normalizeString(args.path);
  if (!filePath) {
    throw new Error('virtual_file 参数错误：read_file 需要 path。');
  }
  return filePath;
}

function parseLineRangeNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) {
    throw new Error(`virtual_file 参数错误：无效的 line_range 行号 \`${value}\`。`);
  }
  return Math.trunc(numeric);
}

function parseBashStyleLineRange(value) {
  const text = normalizeString(value)
    .replace(/^['"]|['"]$/g, '')
    .replace(/\s+/g, '');
  if (!text) return null;

  // 支持 sed/rg 用户常用的简写：`42`、`42p`、`20:80`、`20-80`、`20,80p`、`L20-L80`。
  const rangeMatch = text.match(/^L?(\d+)(?:[:-]|,)\s*L?(\d+)p?$/i);
  if (rangeMatch) {
    return {
      start_line: parseLineRangeNumber(rangeMatch[1]),
      end_line: parseLineRangeNumber(rangeMatch[2])
    };
  }

  const singleMatch = text.match(/^L?(\d+)p?$/i);
  if (singleMatch) {
    const line = parseLineRangeNumber(singleMatch[1]);
    return {
      start_line: line,
      end_line: line
    };
  }

  throw new Error('virtual_file 参数错误：line_range 需使用 `20:80`、`20-80`、`20,80p` 或 `42` 这类行号格式。');
}

function normalizeReadLineRange(args) {
  const lineRange = parseBashStyleLineRange(args.line_range);
  return lineRange || {
    start_line: null,
    end_line: null
  };
}

function normalizeVirtualFileReadArgs(action, args) {
  const lineRange = action === VIRTUAL_FILE_READ_FILE_TOOL_NAME
    ? normalizeReadLineRange(args)
    : { start_line: null, end_line: null };
  return {
    max_chars: args.max_chars,
    start_line: lineRange.start_line,
    end_line: lineRange.end_line
  };
}

export function normalizeVirtualFileReadFileArguments(args, target) {
  const filePath = resolveReadFilePath(args);
  return {
    action: VIRTUAL_FILE_READ_FILE_TOOL_NAME,
    target,
    file_path: target.kind === VIRTUAL_FILE_TARGET_KIND_SKILL
      ? normalizeSkillFilePath(filePath)
      : normalizeConversationDocumentPath(filePath),
    include_line_numbers: args.numbered === true,
    read_options: normalizeVirtualFileReadArgs(VIRTUAL_FILE_READ_FILE_TOOL_NAME, args)
  };
}

function buildCommonFileReadParametersDescription() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      target: buildVirtualFileTargetSchemaDescription({ requireSkillName: true }),
      path: {
        type: 'string',
        description: '必填。要读取的虚拟文件路径，等价于 shell 里 `cat <path>` / `sed -n ... <path>` 的 path；示例 `workspace/plan.md`、`local/project/src/main.js`、`SKILL.md`、`src/main.js`。'
      },
      max_chars: {
        type: ['integer', 'null'],
        description: `可选。按字符限制本次读取，接近 \`head -c <max_chars>\` 的用途。默认 ${CONVERSATION_DOCUMENT_READ_DEFAULT_RANGE_CHARS}，最大 ${CONVERSATION_DOCUMENT_READ_MAX_CHARS}。`
      },
      line_range: {
        type: ['string', 'null'],
        description: '可选。bash/sed 风格行范围，示例 `20:80`、`20-80`、`20,80p` 或单行 `42`；不能和 max_chars 同时使用。'
      },
      numbered: {
        type: ['boolean', 'null'],
        description: '可选。为 true 时返回带行号内容，接近 `nl -ba <path>`。'
      }
    },
    required: ['path']
  };
}

export function buildVirtualFileReadFileFunctionToolDefinition() {
  return {
    type: 'function',
    name: VIRTUAL_FILE_READ_FILE_TOOL_NAME,
    description: '读取单个虚拟文件，调用方式尽量贴近 `cat` / `sed -n` / `nl`：常用 `path` 指定文件，`line_range` 指定行范围，`numbered=true` 获取行号。默认读取 workspace 可写区；`local/...` 将用于后续本地只读映射；当 `target.kind="skill"` 时必须指定 `target.name`。输出是少量 path/range 属性 + 原文 content/numbered_content。',
    strict: false,
    parameters: buildCommonFileReadParametersDescription()
  };
}

export function buildConversationDocumentReadFileFunctionToolDefinition() {
  return buildVirtualFileReadFileFunctionToolDefinition();
}
