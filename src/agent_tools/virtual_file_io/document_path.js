import { normalizeString } from './shared.js';

export function normalizeConversationDocumentPath(value) {
  const rawPath = normalizeString(value).replace(/\\/g, '/');
  const withoutLeadingDot = rawPath.replace(/^(?:\.\/)+/, '');
  const normalizedPath = withoutLeadingDot.startsWith('/')
    ? withoutLeadingDot.slice(1)
    : withoutLeadingDot;

  if (!normalizedPath) {
    throw new Error('workspace 参数错误：file_path 不能为空。');
  }
  if (normalizedPath.length > 512) {
    throw new Error('workspace 参数错误：file_path 长度不能超过 512。');
  }

  const segments = normalizedPath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`workspace 参数错误：文件路径 \`${normalizedPath}\` 不能包含空段、"." 或 ".."。`);
  }
  for (const segment of segments) {
    if (/[\u0000-\u001F<>:"|?*]/.test(segment)) {
      throw new Error(`workspace 参数错误：文件路径 \`${normalizedPath}\` 包含 Windows 不允许的字符。`);
    }
  }
  return normalizedPath;
}

/**
 * 规范化 Markdown 链接里的对话文档路径。
 *
 * 为什么单独提供这层：
 * - Markdown 渲染后的 `<a href>` 往往会把空格、中文等字符转成 `%20` / `%E4...`；
 * - 但 workspace 文件实际存储时使用的是“原始逻辑路径”，例如 `workspace/随笔.md`；
 * - 如果 UI 直接拿编码后的 href 去查文档，就会误判为“文档不存在”。
 *
 * 这里使用 `decodeURI()` 而不是 `decodeURIComponent()`：
 * - 会还原中文、空格等常见显示字符；
 * - 同时保留 `%2F` 这类保留分隔符编码，避免把文件名里的编码斜杠误解成目录层级。
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeConversationDocumentHrefPath(value) {
  const rawHref = normalizeString(value).replace(/\\/g, '/');
  if (!rawHref) {
    return normalizeConversationDocumentPath(rawHref);
  }

  let decodedHref = rawHref;
  try {
    decodedHref = decodeURI(rawHref);
  } catch (_) {
    decodedHref = rawHref;
  }
  return normalizeConversationDocumentPath(decodedHref);
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
