import {
  normalizeSkillFilePath,
  normalizeSkillName
} from '../skill/registry_tool.js';
import { applyDiff } from '../shared/openai_v4a_apply_diff.js';
import { normalizeConversationDocumentPath } from './document_path.js';
import {
  VIRTUAL_FILE_TARGET_KIND_CONVERSATION_DOCUMENT,
  VIRTUAL_FILE_TARGET_KIND_SKILL
} from './shared.js';

/**
 * OpenAI Responses API 官方 apply_patch 协议常量。
 *
 * 与普通 function tool 不同，apply_patch 没有由客户端提供的 name / description /
 * parameters。模型返回专用的 apply_patch_call item，客户端执行后再回传
 * apply_patch_call_output。
 */
export const OPENAI_APPLY_PATCH_TOOL_TYPE = 'apply_patch';
export const OPENAI_APPLY_PATCH_CALL_TYPE = 'apply_patch_call';
export const OPENAI_APPLY_PATCH_CALL_OUTPUT_TYPE = 'apply_patch_call_output';
export const OPENAI_APPLY_PATCH_SKILL_PATH_PREFIX = '@skill/';

const OPENAI_APPLY_PATCH_OPERATION_TYPES = new Set([
  'create_file',
  'update_file',
  'delete_file'
]);

function ensurePlainObject(value) {
  return (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
}

function normalizeRelativeProtocolPath(value) {
  const raw = (typeof value === 'string' ? value : '').trim().replace(/\\/g, '/');
  if (!raw) {
    throw new Error('apply_patch operation.path 不能为空。');
  }
  if (raw.startsWith('/') || /^[a-zA-Z]:\//.test(raw) || raw.startsWith('//')) {
    throw new Error(`apply_patch 只接受虚拟工作区相对路径，不能使用绝对路径 \`${raw}\`。`);
  }
  return raw.replace(/^(?:\.\/)+/, '');
}

/**
 * 校验并规整 OpenAI apply_patch 单文件 operation。
 *
 * 官方协议只支持 create_file / update_file / delete_file。create/update 必须带
 * V4A diff；delete 不消费 diff，避免把非协议字段继续带入执行层。
 */
export function normalizeOpenAIApplyPatchOperation(rawOperation) {
  const input = ensurePlainObject(rawOperation);
  const type = (typeof input.type === 'string' ? input.type : '').trim().toLowerCase();
  if (!OPENAI_APPLY_PATCH_OPERATION_TYPES.has(type)) {
    throw new Error(`apply_patch 不支持 operation.type=\`${input.type || ''}\`。`);
  }

  const path = normalizeRelativeProtocolPath(input.path);
  if (type === 'delete_file') {
    return { type, path };
  }

  if (typeof input.diff !== 'string') {
    throw new Error(`apply_patch ${type} operation.diff 必须是字符串。`);
  }
  return {
    type,
    path,
    diff: input.diff
  };
}

/**
 * 将官方 operation.path 映射到 Cerebr 的两个可写虚拟文件空间。
 *
 * - 普通相对路径：当前对话文件区；
 * - @skill/<skill-key>/<path>：指定 skill 包；
 * - local/...：只读本机映射，明确拒绝写入。
 *
 * 使用显式保留前缀可以让一次响应中的多个 patch call 安全地编辑不同 skill，
 * 不需要维护“最近一次 read_file 的 target”这类并发不安全的隐式状态。
 */
export function resolveOpenAIApplyPatchVirtualTarget(rawOperation) {
  const operation = normalizeOpenAIApplyPatchOperation(rawOperation);
  const path = operation.path;
  const lowerPath = path.toLowerCase();

  if (lowerPath === 'workspace' || lowerPath.startsWith('workspace/')) {
    throw new Error('官方 apply_patch 使用工作区内普通相对路径，不接受旧 `workspace/...` 前缀。');
  }

  if (lowerPath.startsWith('@skill/') && !path.startsWith(OPENAI_APPLY_PATCH_SKILL_PATH_PREFIX)) {
    throw new Error('skill 补丁保留前缀必须精确使用小写 `@skill/`。');
  }

  if (path === '@skill' || path.startsWith('@skill/') && path.slice('@skill/'.length).split('/').length < 2) {
    throw new Error('skill 补丁路径必须使用 `@skill/<skill-key>/<file-path>`。');
  }

  if (path.startsWith(OPENAI_APPLY_PATCH_SKILL_PATH_PREFIX)) {
    const remainder = path.slice(OPENAI_APPLY_PATCH_SKILL_PATH_PREFIX.length);
    const separatorIndex = remainder.indexOf('/');
    if (separatorIndex <= 0 || separatorIndex >= remainder.length - 1) {
      throw new Error('skill 补丁路径必须使用 `@skill/<skill-key>/<file-path>`。');
    }
    const skillName = normalizeSkillName(remainder.slice(0, separatorIndex));
    const skillPath = normalizeSkillFilePath(remainder.slice(separatorIndex + 1));
    return {
      target: {
        kind: VIRTUAL_FILE_TARGET_KIND_SKILL,
        name: skillName
      },
      operation: {
        ...operation,
        path: skillPath
      },
      display_path: `${OPENAI_APPLY_PATCH_SKILL_PATH_PREFIX}${skillName}/${skillPath}`
    };
  }

  if (lowerPath === 'local' || lowerPath.startsWith('local/')) {
    throw new Error('apply_patch 不能直接修改 `local/...` 只读映射；请先用 copy_file 复制成会话文件。');
  }

  const workspacePath = normalizeConversationDocumentPath(path);
  return {
    target: {
      kind: VIRTUAL_FILE_TARGET_KIND_CONVERSATION_DOCUMENT,
      name: null
    },
    operation: {
      ...operation,
      path: workspacePath
    },
    display_path: workspacePath
  };
}

/**
 * 对 create/update operation 应用官方 V4A diff。
 * delete_file 由存储适配层直接删除，不经过本函数。
 */
export function applyOpenAIApplyPatchDiff(input, rawOperation) {
  const operation = normalizeOpenAIApplyPatchOperation(rawOperation);
  if (operation.type === 'create_file') {
    return applyDiff('', operation.diff, 'create');
  }
  if (operation.type === 'update_file') {
    return applyDiff(typeof input === 'string' ? input : '', operation.diff);
  }
  throw new Error('delete_file operation 不包含可应用的 diff。');
}

export function getOpenAIApplyPatchOperationCode(operationType) {
  switch (String(operationType || '').trim().toLowerCase()) {
    case 'create_file':
      return 'A';
    case 'update_file':
      return 'M';
    case 'delete_file':
      return 'D';
    default:
      return '?';
  }
}

export function buildOpenAIApplyPatchCallOutputText(options = {}) {
  const operation = normalizeOpenAIApplyPatchOperation(options.operation);
  const displayPath = (typeof options.displayPath === 'string' && options.displayPath.trim())
    ? options.displayPath.trim()
    : operation.path;
  if (options.ok !== true) {
    const message = (typeof options.errorMessage === 'string' && options.errorMessage.trim())
      ? options.errorMessage.trim()
      : 'Patch failed.';
    return `Error: ${message}`;
  }
  return `Success. Updated the following files:\n${getOpenAIApplyPatchOperationCode(operation.type)} ${displayPath}`;
}
