/**
 * prompt 图片工具的“来源解析 + 字节读取”层。
 *
 * 设计重点：
 * - 统一在扩展后台直接 fetch 图片字节，而不是依赖宿主页里的 `<img>` 或 canvas；
 * - 这样远程 URL 不会落入网页本身的 CORS / stained canvas 限制；
 * - 成功拿到 Blob 后，再交给 `prompt_image_capture` 做统一 JPEG 转码。
 */

const IMAGE_DOWNLOAD_ROOT_KEY = 'image_download_root';

function normalizeString(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

function normalizePath(value) {
  return normalizeString(value).replace(/\\/g, '/');
}

function isWindowsAbsolutePath(value) {
  return /^[A-Za-z]:[\\/]/.test(String(value || ''));
}

function isPosixAbsolutePath(value) {
  return String(value || '').startsWith('/');
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

function isDataUrl(value) {
  return /^data:/i.test(String(value || ''));
}

function isFileUrl(value) {
  return /^file:\/\//i.test(String(value || ''));
}

function isSavedImagesRelativePath(value) {
  const normalized = normalizePath(value).replace(/^\/+/, '');
  if (!normalized) return false;
  if (/(^|\/)\.\.(\/|$)/.test(normalized)) return false;
  return normalized.toLowerCase().startsWith('images/');
}

function encodeFilePathForUrl(absolutePath) {
  let normalized = normalizePath(absolutePath);
  if (isWindowsAbsolutePath(normalized) && !normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }
  return encodeURI(normalized)
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F');
}

function buildFileUrlFromAbsolutePath(absolutePath) {
  const normalized = normalizeString(absolutePath);
  if (!normalized) return '';
  return `file://${encodeFilePathForUrl(normalized)}`;
}

function inferMimeTypeFromSourceUrl(sourceUrl, fallbackMimeType = '') {
  const value = normalizeString(sourceUrl).toLowerCase();
  if (!value) return normalizeString(fallbackMimeType).toLowerCase();

  if (value.startsWith('data:')) {
    const match = value.match(/^data:([^;,]+)(?:;base64)?,/i);
    return match ? String(match[1] || '').toLowerCase() : normalizeString(fallbackMimeType).toLowerCase();
  }

  const sanitized = value.split('#')[0].split('?')[0];
  if (sanitized.endsWith('.jpg') || sanitized.endsWith('.jpeg')) return 'image/jpeg';
  if (sanitized.endsWith('.png')) return 'image/png';
  if (sanitized.endsWith('.gif')) return 'image/gif';
  if (sanitized.endsWith('.webp')) return 'image/webp';
  if (sanitized.endsWith('.bmp')) return 'image/bmp';
  if (sanitized.endsWith('.svg')) return 'image/svg+xml';

  return normalizeString(fallbackMimeType).toLowerCase();
}

async function resolveSavedImagesPath(relativePath) {
  const rel = normalizePath(relativePath).replace(/^\/+/, '');
  const result = await chrome.storage.local.get([IMAGE_DOWNLOAD_ROOT_KEY]);
  const root = normalizeString(result?.[IMAGE_DOWNLOAD_ROOT_KEY]);
  if (!root) {
    throw new Error('未找到 image_download_root，无法解析 Images/... 相对路径。');
  }
  return `${root.replace(/[\\/]+$/, '')}/${rel}`;
}

export async function resolvePromptImageSourceUrl(rawPath) {
  const path = normalizeString(rawPath);
  if (!path) {
    throw new Error('view_image 参数错误：path 需要提供非空字符串。');
  }

  if (isDataUrl(path) || isHttpUrl(path) || isFileUrl(path)) {
    return path;
  }

  if (isWindowsAbsolutePath(path) || isPosixAbsolutePath(path)) {
    return buildFileUrlFromAbsolutePath(path);
  }

  if (isSavedImagesRelativePath(path)) {
    const absolutePath = await resolveSavedImagesPath(path);
    return buildFileUrlFromAbsolutePath(absolutePath);
  }

  throw new Error(
    'view_image 仅支持 http(s) URL、data URL、本地绝对路径、file URL，或保存过的 `Images/...` 相对路径。'
  );
}

export async function fetchPromptImageSourceBlob(rawPath) {
  const sourceUrl = await resolvePromptImageSourceUrl(rawPath);
  let response;
  try {
    response = await fetch(sourceUrl, {
      cache: 'no-store',
      redirect: 'follow'
    });
  } catch (error) {
    throw new Error(`读取图片失败：${error?.message || 'fetch 失败'}`);
  }

  if (!response.ok) {
    throw new Error(`读取图片失败：HTTP ${response.status}`);
  }

  const sourceBlob = await response.blob();
  if (!sourceBlob || typeof sourceBlob.arrayBuffer !== 'function') {
    throw new Error('读取图片失败：响应体不是可处理的 Blob。');
  }
  if (Number(sourceBlob.size) <= 0) {
    throw new Error('读取图片失败：图片内容为空。');
  }

  const mimeType = normalizeString(sourceBlob.type).toLowerCase();
  if (mimeType && !mimeType.startsWith('image/')) {
    throw new Error(`读取图片失败：目标资源不是图片，收到 MIME ${mimeType}。`);
  }

  return {
    sourceUrl,
    sourceBlob,
    originalMimeType: inferMimeTypeFromSourceUrl(sourceUrl, mimeType)
  };
}
