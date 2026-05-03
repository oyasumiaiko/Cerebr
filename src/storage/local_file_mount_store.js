/**
 * 本地文件只读挂载存储层。
 *
 * 说明：
 * - 这里保存的是用户通过 File System Access API 授权得到的 handle，不保存真实文件内容；
 * - 文件内容读取必须在工具调用时实时从 handle 读取，保证 `local/...` 映射反映本机当前状态；
 * - handle 不能 JSON 序列化，所以本模块只做浅拷贝，避免破坏浏览器的结构化克隆对象。
 */

import { openChatHistoryDB } from './indexeddb_helper.js';

export const LOCAL_FILE_MOUNT_STORE = 'local_file_mounts';

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败。'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 事务失败。'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB 事务已中止。'));
  });
}

function cloneLocalMountRecord(record) {
  return record ? { ...record } : null;
}

function normalizeMountKind(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'directory' ? 'directory' : 'file';
}

function normalizeStoredLocalFileMount(rawRecord) {
  if (!rawRecord || typeof rawRecord !== 'object') return null;
  const conversationId = typeof rawRecord.conversation_id === 'string'
    ? rawRecord.conversation_id.trim()
    : '';
  const mountPath = typeof rawRecord.mount_path === 'string'
    ? rawRecord.mount_path.trim()
    : '';
  const handle = rawRecord.handle || null;
  if (!conversationId || !mountPath || !handle) return null;
  const kind = normalizeMountKind(rawRecord.kind || handle.kind);
  return {
    conversation_id: conversationId,
    mount_path: mountPath,
    kind,
    source_name: typeof rawRecord.source_name === 'string' ? rawRecord.source_name.trim() : '',
    updated_at: typeof rawRecord.updated_at === 'string' ? rawRecord.updated_at : new Date().toISOString(),
    handle
  };
}

async function collectMountsByConversationId(store, conversationId) {
  const index = store.index('conversation_id');
  const range = IDBKeyRange.only(String(conversationId || ''));
  const rows = await requestToPromise(index.getAll(range));
  return (Array.isArray(rows) ? rows : [])
    .map(normalizeStoredLocalFileMount)
    .filter(Boolean)
    .sort((left, right) => left.mount_path.localeCompare(right.mount_path));
}

async function deleteMountsByConversationIdInTransaction(store, conversationId) {
  const index = store.index('conversation_id');
  const range = IDBKeyRange.only(String(conversationId || ''));
  await new Promise((resolve, reject) => {
    const request = index.openKeyCursor(range);
    request.onerror = () => reject(request.error || new Error('删除本地文件映射失败。'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
  });
}

export async function listLocalFileMounts(conversationId) {
  const db = await openChatHistoryDB();
  const transaction = db.transaction(LOCAL_FILE_MOUNT_STORE, 'readonly');
  const store = transaction.objectStore(LOCAL_FILE_MOUNT_STORE);
  const donePromise = transactionDone(transaction);
  const rows = await collectMountsByConversationId(store, conversationId);
  await donePromise;
  return rows.map(cloneLocalMountRecord);
}

export async function putLocalFileMount(conversationId, mountRecord) {
  const normalized = normalizeStoredLocalFileMount({
    conversation_id: conversationId,
    ...cloneLocalMountRecord(mountRecord)
  });
  if (!normalized) {
    throw new Error('无法保存无效的本地文件映射。');
  }

  const db = await openChatHistoryDB();
  const transaction = db.transaction(LOCAL_FILE_MOUNT_STORE, 'readwrite');
  const store = transaction.objectStore(LOCAL_FILE_MOUNT_STORE);
  const donePromise = transactionDone(transaction);
  store.put(normalized);
  await donePromise;
  return cloneLocalMountRecord(normalized);
}

export async function deleteLocalFileMount(conversationId, mountPath) {
  const db = await openChatHistoryDB();
  const transaction = db.transaction(LOCAL_FILE_MOUNT_STORE, 'readwrite');
  const store = transaction.objectStore(LOCAL_FILE_MOUNT_STORE);
  const donePromise = transactionDone(transaction);
  store.delete([String(conversationId || ''), String(mountPath || '')]);
  await donePromise;
  return { ok: true, conversation_id: String(conversationId || ''), mount_path: String(mountPath || '') };
}

export async function deleteLocalFileMountsByConversationId(conversationId) {
  const normalizedConversationId = String(conversationId || '').trim();
  if (!normalizedConversationId) {
    return { ok: true, conversation_id: '', deleted_count: 0 };
  }

  const db = await openChatHistoryDB();
  const transaction = db.transaction(LOCAL_FILE_MOUNT_STORE, 'readwrite');
  const store = transaction.objectStore(LOCAL_FILE_MOUNT_STORE);
  const donePromise = transactionDone(transaction);
  const existing = await collectMountsByConversationId(store, normalizedConversationId);
  await deleteMountsByConversationIdInTransaction(store, normalizedConversationId);
  await donePromise;
  return {
    ok: true,
    conversation_id: normalizedConversationId,
    deleted_count: existing.length
  };
}

export async function copyLocalFileMounts(sourceConversationId, targetConversationId) {
  const sourceId = String(sourceConversationId || '').trim();
  const targetId = String(targetConversationId || '').trim();
  if (!sourceId || !targetId) {
    throw new Error('copyLocalFileMounts 需要 sourceConversationId 与 targetConversationId。');
  }
  const sourceMounts = await listLocalFileMounts(sourceId);
  const copied = sourceMounts.map((mount) => ({
    mount_path: mount.mount_path,
    kind: mount.kind,
    source_name: mount.source_name,
    updated_at: mount.updated_at,
    handle: mount.handle
  }));

  const db = await openChatHistoryDB();
  const transaction = db.transaction(LOCAL_FILE_MOUNT_STORE, 'readwrite');
  const store = transaction.objectStore(LOCAL_FILE_MOUNT_STORE);
  const donePromise = transactionDone(transaction);
  await deleteMountsByConversationIdInTransaction(store, targetId);
  copied.forEach((mount) => {
    store.put({
      conversation_id: targetId,
      ...mount
    });
  });
  await donePromise;
  return copied.map((mount) => ({
    conversation_id: targetId,
    ...mount
  }));
}
