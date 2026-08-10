/**
 * 虚拟文件系统唯一的路径与路径过滤实现。
 *
 * Conversation 文件、Skill 文件和 local 只读挂载都使用同一套根相对路径语义：
 * - 工具选择哪个根由 target / Environment ID 决定，path 本身从不携带根信息；
 * - 路径首段不会被解释成隐藏的根别名；
 * - 精确路径与过滤路径分开校验，避免把 glob 元字符误当成文件名。
 */

export const VIRTUAL_FILE_PATH_MAX_CHARS = 512;

function normalizePathInput(value) {
  return typeof value === 'string' ? value.trim().replace(/\\/g, '/') : '';
}

function countUnicodeCharacters(value) {
  return Array.from(String(value || '')).length;
}

function stripLeadingCurrentDirectory(path) {
  return String(path || '').replace(/^(?:\.\/)+/, '');
}

function assertRelativePathShape(path, label) {
  if (path.startsWith('/')) {
    throw new Error(`virtual_file 参数错误：${label} 必须是当前根下的相对路径，不能以 "/" 开头。`);
  }
  if (countUnicodeCharacters(path) > VIRTUAL_FILE_PATH_MAX_CHARS) {
    throw new Error(`virtual_file 参数错误：${label} 长度不能超过 ${VIRTUAL_FILE_PATH_MAX_CHARS} 个字符。`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`virtual_file 参数错误：${label} \`${path}\` 不能包含空段、"." 或 ".."。`);
  }
}

function assertPortablePathCharacters(path, label, options = {}) {
  const allowGlob = options?.allowGlob === true;
  const invalidCharacters = allowGlob
    ? /[\u0000-\u001F<>:"|]/
    : /[\u0000-\u001F<>:"|?*]/;
  if (invalidCharacters.test(path)) {
    throw new Error(`virtual_file 参数错误：${label} \`${path}\` 包含不允许的字符。`);
  }
}

export function normalizeVirtualFilePath(value, options = {}) {
  const label = typeof options?.label === 'string' && options.label.trim()
    ? options.label.trim()
    : 'path';
  const normalizedPath = stripLeadingCurrentDirectory(normalizePathInput(value));
  if (!normalizedPath) {
    throw new Error(`virtual_file 参数错误：${label} 不能为空。`);
  }
  assertRelativePathShape(normalizedPath, label);
  assertPortablePathCharacters(normalizedPath, label);
  return normalizedPath;
}

export function normalizeVirtualPathFilter(value, options = {}) {
  const label = typeof options?.label === 'string' && options.label.trim()
    ? options.label.trim()
    : 'path_glob';
  const rawFilter = normalizePathInput(value);
  if (!rawFilter || rawFilter === '.') return null;
  const normalizedFilter = stripLeadingCurrentDirectory(rawFilter);
  if (!normalizedFilter) return null;
  assertRelativePathShape(normalizedFilter, label);
  assertPortablePathCharacters(normalizedFilter, label, { allowGlob: true });
  return normalizedFilter;
}

export function hasVirtualPathGlobSyntax(value) {
  return /[*?]/.test(String(value || ''));
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildVirtualPathFilterRegExp(value, options = {}) {
  const normalizedFilter = normalizeVirtualPathFilter(value, options);
  if (!normalizedFilter || !hasVirtualPathGlobSyntax(normalizedFilter)) return null;

  let pattern = '^';
  for (let index = 0; index < normalizedFilter.length; index += 1) {
    const char = normalizedFilter[index];
    const next = normalizedFilter[index + 1];
    const afterNext = normalizedFilter[index + 2];
    if (char === '*' && next === '*' && afterNext === '/') {
      pattern += '(?:[^/]+/)*';
      index += 2;
      continue;
    }
    if (char === '*' && next === '*') {
      pattern += '.*';
      index += 1;
      continue;
    }
    if (char === '*') {
      pattern += '[^/]*';
      continue;
    }
    if (char === '?') {
      pattern += '[^/]';
      continue;
    }
    pattern += escapeRegExp(char);
  }
  pattern += '$';
  return new RegExp(pattern);
}

export function matchesVirtualPathFilter(filePath, value, options = {}) {
  const normalizedPath = normalizeVirtualFilePath(filePath, {
    label: options?.pathLabel || 'file_path'
  });
  const normalizedFilter = normalizeVirtualPathFilter(value, {
    label: options?.filterLabel || 'path_glob'
  });
  if (!normalizedFilter) return true;
  if (!hasVirtualPathGlobSyntax(normalizedFilter)) {
    return normalizedPath === normalizedFilter || normalizedPath.startsWith(`${normalizedFilter}/`);
  }
  return buildVirtualPathFilterRegExp(normalizedFilter, {
    label: options?.filterLabel || 'path_glob'
  }).test(normalizedPath);
}
