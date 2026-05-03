import { normalizeConversationDocumentPath } from './document_path.js';
import {
  buildDocumentSizeChars,
  escapeRegExp,
  normalizeString,
  toIsoTimestamp
} from './shared.js';

export const LOCAL_MOUNT_ROOT = 'local';
export const LOCAL_MOUNT_DEFAULT_MAX_FILES = 1000;

function normalizeLocalMountString(value) {
  return normalizeString(value).replace(/\\/g, '/');
}

export function isLocalVirtualPath(value) {
  const normalized = normalizeLocalMountString(value);
  return normalized === LOCAL_MOUNT_ROOT || normalized.startsWith(`${LOCAL_MOUNT_ROOT}/`);
}

export function assertWritableWorkspacePath(path, action) {
  if (!isLocalVirtualPath(path)) return;
  throw new Error(`${action || '文件操作'} 不能直接修改 local 映射路径 ${path}。本地映射是只读的；请先用 copy_file 从 local/... 复制到 workspace/... 后再修改副本。`);
}

export function assertPatchDoesNotTouchLocalPaths(patchText) {
  const lines = String(patchText || '').replace(/\r\n?/g, '\n').split('\n');
  for (const line of lines) {
    const match = line.match(/^\*\*\* (?:Add File|Update File|Delete File|Move to):\s+(.+?)\s*$/);
    if (!match) continue;
    const candidate = normalizeLocalMountString(match[1]);
    if (isLocalVirtualPath(candidate)) {
      throw new Error(`apply_patch 不能直接修改 local 映射路径 ${candidate}。本地映射是只读的；请先用 copy_file 复制到 workspace/... 后再修改副本。`);
    }
  }
}

export function normalizeLocalMountPath(value) {
  const normalized = normalizeConversationDocumentPath(value);
  if (!isLocalVirtualPath(normalized) || normalized === LOCAL_MOUNT_ROOT) {
    throw new Error('local mount 参数错误：mount_path 必须形如 local/<name>。');
  }
  return normalized;
}

export function buildLocalMountCollisionPath(requestedPath, occupiedPaths = []) {
  const normalizedPath = normalizeLocalMountPath(requestedPath);
  const occupied = new Set((Array.isArray(occupiedPaths) ? occupiedPaths : [])
    .map((path) => normalizeLocalMountString(path))
    .filter(Boolean));
  if (!occupied.has(normalizedPath)) return normalizedPath;

  const slashIndex = normalizedPath.lastIndexOf('/');
  const parent = slashIndex >= 0 ? normalizedPath.slice(0, slashIndex + 1) : '';
  const basename = slashIndex >= 0 ? normalizedPath.slice(slashIndex + 1) : normalizedPath;
  const dotIndex = basename.lastIndexOf('.');
  const stem = dotIndex > 0 ? basename.slice(0, dotIndex) : basename;
  const extension = dotIndex > 0 ? basename.slice(dotIndex) : '';
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${parent}${stem} (${index})${extension}`;
    if (!occupied.has(candidate)) return candidate;
  }
  throw new Error(`local mount 参数错误：无法为 ${normalizedPath} 生成可用挂载路径。`);
}

function buildPathGlobRegExp(pathGlob) {
  if (!pathGlob) return null;
  const normalized = normalizeLocalPathGlob(pathGlob);
  let pattern = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    const afterNext = normalized[index + 2];
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

function normalizeLocalPathGlob(value) {
  const rawGlob = normalizeLocalMountString(value);
  const withoutLeadingDot = rawGlob.replace(/^(?:\.\/)+/, '');
  const normalizedGlob = withoutLeadingDot.startsWith('/')
    ? withoutLeadingDot.slice(1)
    : withoutLeadingDot;
  if (!normalizedGlob) return '';
  if (normalizedGlob.length > 512) {
    throw new Error('local mount 参数错误：path_glob 长度不能超过 512。');
  }
  const segments = normalizedGlob.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`local mount 参数错误：path_glob \`${normalizedGlob}\` 不能包含空段、"." 或 ".."。`);
  }
  return normalizedGlob;
}

function matchesPathGlob(filePath, globRegExp) {
  return !globRegExp || globRegExp.test(filePath);
}

function hasGlobSyntax(value) {
  return /[*?]/.test(String(value || ''));
}

function matchesLocalPathFilter(filePath, pathFilter, globRegExp) {
  if (!pathFilter) return true;
  if (hasGlobSyntax(pathFilter)) return matchesPathGlob(filePath, globRegExp);
  return filePath === pathFilter || filePath.startsWith(`${pathFilter}/`);
}

async function assertReadPermission(handle, mountPath) {
  if (!handle || typeof handle !== 'object') {
    throw new Error(`local mount ${mountPath} 缺少可读取的文件句柄。`);
  }
  if (typeof handle.queryPermission !== 'function') return;
  const state = await handle.queryPermission({ mode: 'read' });
  if (state === 'granted') return;
  throw new Error(`local mount ${mountPath} 的读取权限不可用。请重新添加该本地文件或文件夹映射。`);
}

function normalizeMountRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const mountPath = normalizeLocalMountString(record.mount_path);
  const handle = record.handle || null;
  if (!mountPath || !handle || !isLocalVirtualPath(mountPath)) return null;
  const handleKind = normalizeLocalMountString(handle.kind);
  const kind = record.kind === 'directory' || handleKind === 'directory' ? 'directory' : 'file';
  return {
    mount_path: mountPath,
    kind,
    source_name: normalizeString(record.source_name || handle.name),
    updated_at: normalizeString(record.updated_at) || new Date().toISOString(),
    handle
  };
}

async function readTextFileFromHandle(handle, virtualPath) {
  await assertReadPermission(handle, virtualPath);
  if (typeof handle.getFile !== 'function') {
    throw new Error(`local mount ${virtualPath} 不是可读取文件。`);
  }
  const file = await handle.getFile();
  if (!file || typeof file.text !== 'function') {
    throw new Error(`local mount ${virtualPath} 无法读取为文本文件。`);
  }
  const content = await file.text();
  const lastModified = Number(file.lastModified);
  return {
    path: virtualPath,
    updated_at: Number.isFinite(lastModified) && lastModified > 0
      ? new Date(lastModified).toISOString()
      : new Date().toISOString(),
    size_chars: buildDocumentSizeChars(content),
    content
  };
}

async function collectDirectoryEntries(directoryHandle) {
  if (typeof directoryHandle.entries !== 'function') {
    throw new Error(`local mount ${directoryHandle?.name || ''} 不支持目录枚举。`);
  }
  const entries = [];
  for await (const entry of directoryHandle.entries()) {
    const name = Array.isArray(entry) ? entry[0] : '';
    const handle = Array.isArray(entry) ? entry[1] : null;
    if (!name || !handle) continue;
    entries.push([name, handle]);
  }
  entries.sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  return entries;
}

async function collectDirectoryFiles(directoryHandle, virtualRootPath, options = {}) {
  await assertReadPermission(directoryHandle, virtualRootPath);
  const includeContent = options?.includeContent === true;
  const globRegExp = options?.globRegExp || null;
  const maxFiles = Math.max(1, Math.trunc(Number(options?.maxFiles) || LOCAL_MOUNT_DEFAULT_MAX_FILES));
  const files = [];
  const stack = [{ handle: directoryHandle, path: virtualRootPath }];

  while (stack.length > 0 && files.length < maxFiles) {
    const current = stack.pop();
    const entries = await collectDirectoryEntries(current.handle);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [name, handle] = entries[index];
      const childPath = `${current.path}/${name}`;
      if (handle.kind === 'directory') {
        stack.push({ handle, path: childPath });
        continue;
      }
      if (handle.kind !== 'file') continue;
      if (!matchesLocalPathFilter(childPath, options?.pathFilter || '', globRegExp)) continue;
      const fileRecord = includeContent
        ? await readTextFileFromHandle(handle, childPath)
        : {
            path: childPath,
            updated_at: new Date().toISOString(),
            size_chars: null
          };
      files.push(fileRecord);
      if (files.length >= maxFiles) break;
    }
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function resolveDirectoryFileHandle(directoryHandle, relativeSegments, mountPath) {
  await assertReadPermission(directoryHandle, mountPath);
  if (relativeSegments.length <= 0) {
    throw new Error(`local mount ${mountPath} 是文件夹，请指定文件路径。`);
  }
  let current = directoryHandle;
  for (let index = 0; index < relativeSegments.length - 1; index += 1) {
    const segment = relativeSegments[index];
    if (typeof current.getDirectoryHandle !== 'function') {
      throw new Error(`local mount ${mountPath} 不支持按路径读取子文件夹。`);
    }
    current = await current.getDirectoryHandle(segment);
  }
  const fileName = relativeSegments[relativeSegments.length - 1];
  if (typeof current.getFileHandle !== 'function') {
    throw new Error(`local mount ${mountPath} 不支持按路径读取文件。`);
  }
  return await current.getFileHandle(fileName);
}

function findBestLocalMount(mounts, filePath) {
  const candidates = mounts
    .map(normalizeMountRecord)
    .filter(Boolean)
    .filter((mount) => (
      filePath === mount.mount_path
      || (mount.kind === 'directory' && filePath.startsWith(`${mount.mount_path}/`))
    ))
    .sort((left, right) => right.mount_path.length - left.mount_path.length);
  return candidates[0] || null;
}

export async function readLocalVirtualFileDocument(conversationId, filePath, store) {
  const normalizedPath = normalizeConversationDocumentPath(filePath);
  if (!isLocalVirtualPath(normalizedPath)) {
    throw new Error(`local mount 参数错误：${normalizedPath} 不是 local/... 路径。`);
  }
  const mounts = await store.listMounts(conversationId);
  const mount = findBestLocalMount(Array.isArray(mounts) ? mounts : [], normalizedPath);
  if (!mount) {
    throw new Error(`找不到 local 映射文件 ${normalizedPath}。请先添加本地文件或文件夹映射。`);
  }
  if (mount.kind === 'file') {
    if (normalizedPath !== mount.mount_path) {
      throw new Error(`local mount ${mount.mount_path} 是单文件映射，不能读取子路径 ${normalizedPath}。`);
    }
    return await readTextFileFromHandle(mount.handle, normalizedPath);
  }
  const relativePath = normalizedPath.slice(mount.mount_path.length).replace(/^\/+/, '');
  const relativeSegments = relativePath.split('/').filter(Boolean);
  const fileHandle = await resolveDirectoryFileHandle(mount.handle, relativeSegments, mount.mount_path);
  return await readTextFileFromHandle(fileHandle, normalizedPath);
}

export async function listLocalVirtualFileDocuments(conversationId, options = {}) {
  const pathGlob = normalizeLocalMountString(options?.path_glob);
  const globRegExp = pathGlob ? buildPathGlobRegExp(pathGlob) : null;
  const includeContent = options?.includeContent === true;
  const maxFiles = Math.max(1, Math.trunc(Number(options?.maxFiles) || LOCAL_MOUNT_DEFAULT_MAX_FILES));
  const mounts = await options.store.listMounts(conversationId);
  const normalizedMounts = (Array.isArray(mounts) ? mounts : [])
    .map(normalizeMountRecord)
    .filter(Boolean);
  const files = [];

  for (const mount of normalizedMounts) {
    if (files.length >= maxFiles) break;
    if (mount.kind === 'file') {
      if (!matchesLocalPathFilter(mount.mount_path, pathGlob, globRegExp)) continue;
      const fileRecord = includeContent
        ? await readTextFileFromHandle(mount.handle, mount.mount_path)
        : {
            path: mount.mount_path,
            updated_at: mount.updated_at,
            size_chars: null
          };
      files.push(fileRecord);
      continue;
    }
    const remaining = maxFiles - files.length;
    const directoryFiles = await collectDirectoryFiles(mount.handle, mount.mount_path, {
      includeContent,
      globRegExp,
      pathFilter: pathGlob,
      maxFiles: remaining
    });
    files.push(...directoryFiles);
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}
