import { normalizeSkillFilePath } from '../skill/registry_tool.js';
import { normalizeConversationDocumentPath } from './document_path.js';
import {
  CONVERSATION_DOCUMENT_READ_DEFAULT_RANGE_CHARS,
  CONVERSATION_DOCUMENT_READ_MAX_CHARS,
  VIRTUAL_FILE_READ_FILE_TOOL_NAME,
  VIRTUAL_FILE_TARGET_KIND_SKILL
} from './shared.js';
import { buildVirtualFileTargetSchemaDescription } from './target.js';

function normalizeVirtualFileReadArgs(action, args) {
  return {
    mode: args.mode,
    skip_chars: args.skip_chars,
    max_chars: args.max_chars,
    start_line: action === VIRTUAL_FILE_READ_FILE_TOOL_NAME ? args.start_line : null,
    end_line: action === VIRTUAL_FILE_READ_FILE_TOOL_NAME ? args.end_line : null
  };
}

export function normalizeVirtualFileReadFileArguments(args, target) {
  return {
    action: VIRTUAL_FILE_READ_FILE_TOOL_NAME,
    target,
    file_path: target.kind === VIRTUAL_FILE_TARGET_KIND_SKILL
      ? normalizeSkillFilePath(args.file_path)
      : normalizeConversationDocumentPath(args.file_path),
    include_line_numbers: args.include_line_numbers === true,
    read_options: normalizeVirtualFileReadArgs(VIRTUAL_FILE_READ_FILE_TOOL_NAME, args)
  };
}

function buildCommonFileReadParametersDescription() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      target: buildVirtualFileTargetSchemaDescription({ requireSkillName: true }),
      file_path: {
        type: 'string',
        description: '要读取的虚拟文件路径；当前对话文件示例 `docs/plan.md`、`notes/todo.txt`、`snippets/example.html`，skill 文件示例 `SKILL.md` 或 `src/main.js`。'
      },
      mode: {
        type: ['string', 'null'],
        description: '可选。preview 表示从头部预览读取。'
      },
      skip_chars: {
        type: ['integer', 'null'],
        description: '可选。从指定字符偏移开始读取正文。'
      },
      max_chars: {
        type: ['integer', 'null'],
        description: `可选。本次最多返回的正文字符数。默认 ${CONVERSATION_DOCUMENT_READ_DEFAULT_RANGE_CHARS}，最大 ${CONVERSATION_DOCUMENT_READ_MAX_CHARS}。`
      },
      start_line: {
        type: ['integer', 'null'],
        description: '可选。从指定行号开始读取正文。必须与 end_line 一起提供，且不能和 skip_chars/max_chars 同时使用。'
      },
      end_line: {
        type: ['integer', 'null'],
        description: '可选。读取到指定结束行。必须与 start_line 一起提供，且不能和 skip_chars/max_chars 同时使用。'
      },
      include_line_numbers: {
        type: ['boolean', 'null'],
        description: '可选。为 true 时额外返回带行号的 numbered_content。'
      }
    },
    required: ['file_path']
  };
}

export function buildVirtualFileReadFileFunctionToolDefinition() {
  return {
    type: 'function',
    name: VIRTUAL_FILE_READ_FILE_TOOL_NAME,
    description: '读取单个虚拟文件。输出会尽量接近终端读文件结果：少量 path/range 属性 + 原文 content/numbered_content；默认读取安全预览，可按字符或行范围读取；当 `target.kind="skill"` 时必须指定 `target.name`。',
    strict: false,
    parameters: buildCommonFileReadParametersDescription()
  };
}

export function buildConversationDocumentReadFileFunctionToolDefinition() {
  return buildVirtualFileReadFileFunctionToolDefinition();
}
