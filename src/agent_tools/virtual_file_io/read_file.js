import { normalizeVirtualFilePath } from '../shared/virtual_file_path.js';
import {
  VIRTUAL_FILE_READ_FILE_TOOL_NAME,
  normalizeString
} from './shared.js';
import { buildVirtualFileEnvironmentIdSchema } from './environment.js';
import {
  buildModelToolDescription,
  buildStrictFunctionToolDefinition
} from '../shared/model_tool_contract.js';
import { normalizeVirtualFileLineRange } from './text_query.js';

function resolveReadFilePath(args) {
  const filePath = normalizeString(args.path);
  if (!filePath) {
    throw new Error('virtual_file 参数错误：read_file 需要 path。');
  }
  return filePath;
}

export function normalizeVirtualFileReadFileArguments(args, environment) {
  const filePath = resolveReadFilePath(args);
  return {
    action: VIRTUAL_FILE_READ_FILE_TOOL_NAME,
    environment,
    file_path: normalizeVirtualFilePath(filePath, { label: 'read_file.path' }),
    read_options: normalizeVirtualFileLineRange(args)
  };
}

export function buildVirtualFileReadFileFunctionToolDefinition() {
  const definition = buildStrictFunctionToolDefinition({
    name: VIRTUAL_FILE_READ_FILE_TOOL_NAME,
    description: buildModelToolDescription({
      purpose: '读取一个虚拟文本文件的原始正文或指定行范围。',
      input: 'environment_id 选择文件根；path 是根相对路径。start_line/end_line 同时为 null 时读取全文，同时为 1-based 整数时读取闭区间。',
      output: '首行标明路径和范围，随后返回未添加行号、未改写换行符的文件正文。结果过长时返回 next_cursor。'
    }),
    properties: {
      environment_id: buildVirtualFileEnvironmentIdSchema(),
      path: {
        type: 'string',
        description: '所选根下的相对文本文件路径；不能使用绝对路径或 `..`。'
      },
      start_line: {
        type: ['integer', 'null'],
        minimum: 1,
        description: '读取起始行，1-based；读取全文时传 null。'
      },
      end_line: {
        type: ['integer', 'null'],
        minimum: 1,
        description: '读取结束行，1-based 闭区间；读取全文时传 null。'
      }
    },
    outputControlDescription: '本页最多返回多少字符，最小 256；null 默认 20000。结果过长时返回 next_cursor。'
  });
  return definition;
}

export function buildConversationDocumentReadFileFunctionToolDefinition() {
  return buildVirtualFileReadFileFunctionToolDefinition();
}
