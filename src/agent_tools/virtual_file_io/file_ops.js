import { normalizeSkillFilePath } from '../skill/registry_tool.js';
import {
  VIRTUAL_FILE_COPY_FILE_TOOL_NAME,
  VIRTUAL_FILE_DELETE_FILE_TOOL_NAME,
  VIRTUAL_FILE_MOVE_FILE_TOOL_NAME,
  VIRTUAL_FILE_TARGET_KIND_SKILL,
  normalizeString
} from './shared.js';
import { normalizeConversationDocumentPath } from './document_path.js';
import { buildVirtualFileTargetSchemaDescription } from './target.js';

function normalizeOperationPath(value, target, label) {
  const path = normalizeString(value);
  if (!path) {
    throw new Error(`virtual_file 参数错误：${label} 不能为空。`);
  }
  return target?.kind === VIRTUAL_FILE_TARGET_KIND_SKILL
    ? normalizeSkillFilePath(path)
    : normalizeConversationDocumentPath(path);
}

function buildMutationTargetDescription() {
  return buildVirtualFileTargetSchemaDescription({ requireSkillName: true });
}

export function normalizeVirtualFileCopyFileArguments(args, target) {
  return {
    action: VIRTUAL_FILE_COPY_FILE_TOOL_NAME,
    target,
    source_path: normalizeOperationPath(args.from, target, 'copy_file.from'),
    destination_path: normalizeOperationPath(args.to, target, 'copy_file.to')
  };
}

export function normalizeVirtualFileMoveFileArguments(args, target) {
  return {
    action: VIRTUAL_FILE_MOVE_FILE_TOOL_NAME,
    target,
    source_path: normalizeOperationPath(args.from, target, 'move_file.from'),
    destination_path: normalizeOperationPath(args.to, target, 'move_file.to')
  };
}

export function normalizeVirtualFileDeleteFileArguments(args, target) {
  return {
    action: VIRTUAL_FILE_DELETE_FILE_TOOL_NAME,
    target,
    file_path: normalizeOperationPath(args.path, target, 'delete_file.path')
  };
}

export function buildVirtualFileCopyFileFunctionToolDefinition() {
  return {
    type: 'function',
    name: VIRTUAL_FILE_COPY_FILE_TOOL_NAME,
    description: '复制虚拟文件，接近 `cp <from> <to>`。用于把已有文件复制到另一个虚拟路径；如果目标已存在会失败，不会覆盖。',
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: buildMutationTargetDescription(),
        from: {
          type: 'string',
          description: '必填。源文件路径，等价于 `cp <from> <to>` 的 from。'
        },
        to: {
          type: 'string',
          description: '必填。目标文件路径，等价于 `cp <from> <to>` 的 to；目标已存在时会报错。'
        }
      },
      required: ['from', 'to']
    }
  };
}

export function buildVirtualFileMoveFileFunctionToolDefinition() {
  return {
    type: 'function',
    name: VIRTUAL_FILE_MOVE_FILE_TOOL_NAME,
    description: '移动或重命名可写虚拟文件，接近 `mv <from> <to>`。如果目标已存在会失败，不会覆盖。',
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: buildMutationTargetDescription(),
        from: {
          type: 'string',
          description: '必填。源文件路径，等价于 `mv <from> <to>` 的 from。'
        },
        to: {
          type: 'string',
          description: '必填。目标文件路径，等价于 `mv <from> <to>` 的 to；目标已存在时会报错。'
        }
      },
      required: ['from', 'to']
    }
  };
}

export function buildVirtualFileDeleteFileFunctionToolDefinition() {
  return {
    type: 'function',
    name: VIRTUAL_FILE_DELETE_FILE_TOOL_NAME,
    description: '删除可写虚拟文件，接近 `rm <path>`。只能删除虚拟文件，不会删除真实本机文件。',
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: buildMutationTargetDescription(),
        path: {
          type: 'string',
          description: '必填。要删除的虚拟文件路径，等价于 `rm <path>` 的 path。'
        }
      },
      required: ['path']
    }
  };
}

export function buildConversationDocumentCopyFileFunctionToolDefinition() {
  return buildVirtualFileCopyFileFunctionToolDefinition();
}

export function buildConversationDocumentMoveFileFunctionToolDefinition() {
  return buildVirtualFileMoveFileFunctionToolDefinition();
}

export function buildConversationDocumentDeleteFileFunctionToolDefinition() {
  return buildVirtualFileDeleteFileFunctionToolDefinition();
}
