import { normalizeString } from './shared.js';

export function normalizeConversationDocumentPath(value) {
  const rawPath = normalizeString(value).replace(/\\/g, '/');
  const withoutLeadingDot = rawPath.replace(/^(?:\.\/)+/, '');
  const normalizedPath = withoutLeadingDot.startsWith('/')
    ? withoutLeadingDot.slice(1)
    : withoutLeadingDot;

  if (!normalizedPath) {
    throw new Error('conversation_document 参数错误：file_path 不能为空。');
  }
  if (normalizedPath.length > 512) {
    throw new Error('conversation_document 参数错误：file_path 长度不能超过 512。');
  }

  const segments = normalizedPath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`conversation_document 参数错误：文件路径 \`${normalizedPath}\` 不能包含空段、"." 或 ".."。`);
  }
  for (const segment of segments) {
    if (/[\u0000-\u001F<>:"|?*]/.test(segment)) {
      throw new Error(`conversation_document 参数错误：文件路径 \`${normalizedPath}\` 包含 Windows 不允许的字符。`);
    }
  }
  return normalizedPath;
}

function splitPathBasenameAndExtension(path) {
  const normalized = normalizeConversationDocumentPath(path);
  const lastSlashIndex = normalized.lastIndexOf('/');
  const directory = lastSlashIndex >= 0 ? normalized.slice(0, lastSlashIndex) : '';
  const filename = lastSlashIndex >= 0 ? normalized.slice(lastSlashIndex + 1) : normalized;
  const lastDotIndex = filename.lastIndexOf('.');
  if (lastDotIndex <= 0) {
    return { directory, stem: filename, extension: '' };
  }
  return {
    directory,
    stem: filename.slice(0, lastDotIndex),
    extension: filename.slice(lastDotIndex)
  };
}

export function buildConversationDocumentCollisionPath(requestedPath, occupiedPaths, options = {}) {
  const normalizedRequestedPath = normalizeConversationDocumentPath(requestedPath);
  const excludedPath = normalizeString(options?.excludedPath)
    ? normalizeConversationDocumentPath(options.excludedPath)
    : '';
  const occupied = new Set(
    Array.from(occupiedPaths || [])
      .map((value) => {
        try {
          return normalizeConversationDocumentPath(value);
        } catch (_) {
          return '';
        }
      })
      .filter(Boolean)
      .filter((value) => value !== excludedPath)
  );
  if (!occupied.has(normalizedRequestedPath)) {
    return normalizedRequestedPath;
  }

  const { directory, stem, extension } = splitPathBasenameAndExtension(normalizedRequestedPath);
  const prefix = directory ? `${directory}/` : '';
  let nextIndex = 2;
  while (nextIndex < 10_000) {
    const candidate = `${prefix}${stem} (${nextIndex})${extension}`;
    if (!occupied.has(candidate)) {
      return candidate;
    }
    nextIndex += 1;
  }
  throw new Error(`无法为文档 \`${normalizedRequestedPath}\` 生成不冲突的文件名。`);
}
