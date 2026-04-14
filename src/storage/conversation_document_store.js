/**
 * 对话级文档虚拟文件存储层。
 *
 * 说明：
 * - 文档与会话正文分库存于同一个 IndexedDB 数据库中，但单独放在 `conversation_documents` store；
 * - 这里不理解 patch / 搜索 / UI，只负责按 `(conversation_id, path)` 读写文本文件；
 * - 调用方需要自行保证 path 已做业务层规范化。
 */

import { openChatHistoryDB } from './indexeddb_helper.js';

export const CONVERSATION_DOCUMENT_STORE = 'conversation_documents';

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

function cloneStructured(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeStoredConversationDocument(rawRecord) {
  if (!rawRecord || typeof rawRecord !== 'object') return null;
  const conversationId = typeof rawRecord.conversation_id === 'string'
    ? rawRecord.conversation_id.trim()
    : '';
  const path = typeof rawRecord.path === 'string'
    ? rawRecord.path.trim()
    : '';
  if (!conversationId || !path) return null;
  return {
    conversation_id: conversationId,
    path,
    content: typeof rawRecord.content === 'string' ? rawRecord.content : '',
    updated_at: typeof rawRecord.updated_at === 'string' ? rawRecord.updated_at : new Date().toISOString(),
    size_chars: Number.isFinite(Number(rawRecord.size_chars))
      ? Math.max(0, Math.trunc(Number(rawRecord.size_chars)))
      : Array.from(typeof rawRecord.content === 'string' ? rawRecord.content : '').length
  };
}

async function collectDocumentsByConversationId(store, conversationId) {
  const index = store.index('conversation_id');
  const range = IDBKeyRange.only(String(conversationId || ''));
  const rows = await requestToPromise(index.getAll(range));
  return (Array.isArray(rows) ? rows : [])
    .map(normalizeStoredConversationDocument)
    .filter(Boolean)
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function deleteDocumentsByConversationIdInTransaction(store, conversationId) {
  const index = store.index('conversation_id');
  const range = IDBKeyRange.only(String(conversationId || ''));
  await new Promise((resolve, reject) => {
    const request = index.openKeyCursor(range);
    request.onerror = () => reject(request.error || new Error('删除对话文档失败。'));
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

export async function listConversationDocuments(conversationId) {
  const db = await openChatHistoryDB();
  const transaction = db.transaction(CONVERSATION_DOCUMENT_STORE, 'readonly');
  const store = transaction.objectStore(CONVERSATION_DOCUMENT_STORE);
  const donePromise = transactionDone(transaction);
  const rows = await collectDocumentsByConversationId(store, conversationId);
  await donePromise;
  return rows.map(cloneStructured);
}

export async function getConversationDocument(conversationId, path) {
  const db = await openChatHistoryDB();
  const transaction = db.transaction(CONVERSATION_DOCUMENT_STORE, 'readonly');
  const store = transaction.objectStore(CONVERSATION_DOCUMENT_STORE);
  const donePromise = transactionDone(transaction);
  const row = await requestToPromise(store.get([String(conversationId || ''), String(path || '')]));
  await donePromise;
  return cloneStructured(normalizeStoredConversationDocument(row));
}

export async function putConversationDocument(conversationId, documentRecord) {
  const normalized = normalizeStoredConversationDocument({
    conversation_id: conversationId,
    ...cloneStructured(documentRecord)
  });
  if (!normalized) {
    throw new Error('无法保存无效的对话文档。');
  }

  const db = await openChatHistoryDB();
  const transaction = db.transaction(CONVERSATION_DOCUMENT_STORE, 'readwrite');
  const store = transaction.objectStore(CONVERSATION_DOCUMENT_STORE);
  const donePromise = transactionDone(transaction);
  store.put(normalized);
  await donePromise;
  return cloneStructured(normalized);
}

export async function replaceConversationDocuments(conversationId, documents) {
  const normalizedConversationId = String(conversationId || '').trim();
  if (!normalizedConversationId) {
    throw new Error('replaceConversationDocuments 缺少 conversationId。');
  }
  const normalizedDocs = (Array.isArray(documents) ? documents : [])
    .map((doc) => normalizeStoredConversationDocument({
      conversation_id: normalizedConversationId,
      ...cloneStructured(doc)
    }))
    .filter(Boolean)
    .sort((left, right) => left.path.localeCompare(right.path));

  const db = await openChatHistoryDB();
  const transaction = db.transaction(CONVERSATION_DOCUMENT_STORE, 'readwrite');
  const store = transaction.objectStore(CONVERSATION_DOCUMENT_STORE);
  const donePromise = transactionDone(transaction);
  await deleteDocumentsByConversationIdInTransaction(store, normalizedConversationId);
  normalizedDocs.forEach((doc) => store.put(doc));
  await donePromise;
  return normalizedDocs.map(cloneStructured);
}

export async function deleteConversationDocument(conversationId, path) {
  const db = await openChatHistoryDB();
  const transaction = db.transaction(CONVERSATION_DOCUMENT_STORE, 'readwrite');
  const store = transaction.objectStore(CONVERSATION_DOCUMENT_STORE);
  const donePromise = transactionDone(transaction);
  store.delete([String(conversationId || ''), String(path || '')]);
  await donePromise;
  return { ok: true, conversation_id: String(conversationId || ''), path: String(path || '') };
}

export async function deleteConversationDocumentsByConversationId(conversationId) {
  const normalizedConversationId = String(conversationId || '').trim();
  if (!normalizedConversationId) {
    return { ok: true, conversation_id: '', deleted_count: 0 };
  }

  const db = await openChatHistoryDB();
  const transaction = db.transaction(CONVERSATION_DOCUMENT_STORE, 'readwrite');
  const store = transaction.objectStore(CONVERSATION_DOCUMENT_STORE);
  const donePromise = transactionDone(transaction);
  const existing = await collectDocumentsByConversationId(store, normalizedConversationId);
  await deleteDocumentsByConversationIdInTransaction(store, normalizedConversationId);
  await donePromise;
  return {
    ok: true,
    conversation_id: normalizedConversationId,
    deleted_count: existing.length
  };
}

export async function copyConversationDocuments(sourceConversationId, targetConversationId) {
  const sourceId = String(sourceConversationId || '').trim();
  const targetId = String(targetConversationId || '').trim();
  if (!sourceId || !targetId) {
    throw new Error('copyConversationDocuments 需要 sourceConversationId 与 targetConversationId。');
  }
  const sourceDocuments = await listConversationDocuments(sourceId);
  const copied = sourceDocuments.map((doc) => ({
    path: doc.path,
    content: doc.content,
    updated_at: doc.updated_at,
    size_chars: doc.size_chars
  }));
  return await replaceConversationDocuments(targetId, copied);
}
