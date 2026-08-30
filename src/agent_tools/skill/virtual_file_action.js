import {
  normalizeVirtualFileEnvironmentId
} from '../virtual_file_io/environment.js';
import {
  normalizeVirtualFileLineRange,
  readNullableSafeInteger
} from '../virtual_file_io/text_query.js';
import {
  normalizeVirtualFilePath,
  normalizeVirtualPathFilter
} from '../shared/virtual_file_path.js';
import {
  VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
  VIRTUAL_FILE_COPY_FILE_TOOL_NAME,
  VIRTUAL_FILE_LIST_FILES_TOOL_NAME,
  VIRTUAL_FILE_READ_FILE_TOOL_NAME,
  VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME,
  VIRTUAL_FILE_ENVIRONMENT_KIND_SKILL
} from '../virtual_file_io/shared.js';

const SKILL_VIRTUAL_FILE_ACTIONS = new Set([
  VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME,
  VIRTUAL_FILE_LIST_FILES_TOOL_NAME,
  VIRTUAL_FILE_READ_FILE_TOOL_NAME,
  VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME,
  VIRTUAL_FILE_COPY_FILE_TOOL_NAME
]);

function assertPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('virtual_file 参数错误：payload 必须是 object。');
  }
  return value;
}

function assertOnlyKeys(value, allowedKeys, action) {
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new Error(`virtual_file 参数错误：${action} 不接受参数 ${unexpected.join(', ')}。`);
  }
}

function readRequiredPath(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`virtual_file 参数错误：${label} 必须是非空字符串。`);
  }
  return normalizeVirtualFilePath(value, { label });
}

function readNullableBoolean(value, label) {
  if (value == null) return false;
  if (typeof value !== 'boolean') {
    throw new Error(`virtual_file 参数错误：${label} 必须是 boolean 或 null。`);
  }
  return value;
}

export function normalizeSkillVirtualFileActionArguments(rawArgs) {
  const args = assertPlainObject(rawArgs);
  const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';
  if (!SKILL_VIRTUAL_FILE_ACTIONS.has(action)) {
    throw new Error(`virtual_file 参数错误：不支持的 Skill 文件 action \`${action || '(empty)'}\`。`);
  }
  const environment = normalizeVirtualFileEnvironmentId(args.environment_id);
  if (environment.kind !== VIRTUAL_FILE_ENVIRONMENT_KIND_SKILL) {
    throw new Error('virtual_file 参数错误：Skill 文件 action 必须提供 skill:<stable-key> environment_id。');
  }

  if (action === VIRTUAL_FILE_APPLY_PATCH_TOOL_NAME) {
    assertOnlyKeys(args, new Set(['action', 'environment_id', 'patch']), action);
    if (typeof args.patch !== 'string' || !args.patch.trim()) {
      throw new Error('virtual_file 参数错误：apply_patch.patch 必须是非空字符串。');
    }
    return { action, environment, patch: args.patch };
  }

  if (action === VIRTUAL_FILE_LIST_FILES_TOOL_NAME) {
    assertOnlyKeys(args, new Set(['action', 'environment_id', 'path_glob']), action);
    return {
      action,
      environment,
      path_glob: normalizeVirtualPathFilter(args.path_glob, { label: 'path_glob' })
    };
  }

  if (action === VIRTUAL_FILE_READ_FILE_TOOL_NAME) {
    assertOnlyKeys(args, new Set(['action', 'environment_id', 'file_path', 'start_line', 'end_line']), action);
    return {
      action,
      environment,
      file_path: readRequiredPath(args.file_path, 'read_file.path'),
      read_options: normalizeVirtualFileLineRange(args)
    };
  }

  if (action === VIRTUAL_FILE_SEARCH_FILES_TOOL_NAME) {
    assertOnlyKeys(args, new Set([
      'action',
      'environment_id',
      'pattern',
      'regex',
      'ignore_case',
      'path_glob',
      'context_lines'
    ]), action);
    if (typeof args.pattern !== 'string' || !args.pattern) {
      throw new Error('virtual_file 参数错误：search_files.pattern 必须是非空字符串。');
    }
    return {
      action,
      environment,
      pattern: args.pattern,
      regex: readNullableBoolean(args.regex, 'regex'),
      ignore_case: readNullableBoolean(args.ignore_case, 'ignore_case'),
      path_glob: normalizeVirtualPathFilter(args.path_glob, { label: 'path_glob' }),
      context_lines: readNullableSafeInteger(args.context_lines, {
        label: 'context_lines',
        minimum: 0,
        maximum: 20
      }) ?? 0
    };
  }

  assertOnlyKeys(args, new Set([
    'action',
    'environment_id',
    'source_path',
    'destination_path'
  ]), action);
  return {
    action,
    environment,
    source_path: readRequiredPath(args.source_path, 'copy_file.from'),
    destination_path: readRequiredPath(args.destination_path, 'copy_file.to')
  };
}
