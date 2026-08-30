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
  if (rawRecord == null) return null;
  if (typeof rawRecord !== 'object' || Array.isArray(rawRecord)) {
    throw new Error('conversation document store 包含非 object 记录。');
  }
  const conversationId = typeof rawRecord.conversation_id === 'string'
    ? rawRecord.conversation_id.trim()
    : '';
  const path = typeof rawRecord.path === 'string'
    ? rawRecord.path.trim()
    : '';
  if (!conversationId || !path) {
    throw new Error('conversation document store 记录缺少 conversation_id 或 path。');
  }
  if (typeof rawRecord.content !== 'string') {
    throw new Error(`conversation document store 中的 ${path} 缺少字符串 content。`);
  }
  return {
    conversation_id: conversationId,
    path,
    content: rawRecord.content,
    updated_at: typeof rawRecord.updated_at === 'string' ? rawRecord.updated_at : new Date().toISOString(),
    size_chars: Number.isFinite(Number(rawRecord.size_chars))
      ? Math.max(0, Math.trunc(Number(rawRecord.size_chars)))
      : Array.from(rawRecord.content).length
  };
}

function normalizeConversationDocumentSet(conversationId, documents) {
  if (!Array.isArray(documents)) {
    throw new Error('conversation document store 写入值必须是数组。');
  }
  const seenPaths = new Set();
  const normalized = documents.map((doc) => normalizeStoredConversationDocument({
    conversation_id: conversationId,
    ...cloneStructured(doc)
  }));
  for (const documentRecord of normalized) {
    if (seenPaths.has(documentRecord.path)) {
      throw new Error(`conversation document store 写入包含重复路径 ${documentRecord.path}。`);
    }
    seenPaths.add(documentRecord.path);
  }
  return normalized.sort((left, right) => left.path.localeCompare(right.path));
}

async function collectDocumentsByConversationId(store, conversationId) {
  const index = store.index('conversation_id');
  const range = IDBKeyRange.only(String(conversationId || ''));
  const rows = await requestToPromise(index.getAll(range));
  if (!Array.isArray(rows)) {
    throw new Error('conversation document store 读取结果不是数组。');
  }
  const normalized = rows.map(normalizeStoredConversationDocument);
  const seenPaths = new Set();
  for (const documentRecord of normalized) {
    if (seenPaths.has(documentRecord.path)) {
      throw new Error(`conversation document store 包含重复路径 ${documentRecord.path}。`);
    }
    seenPaths.add(documentRecord.path);
  }
  return normalized.sort((left, right) => left.path.localeCompare(right.path));
}

async function deleteDocumentsByConversationIdInTransaction(store, conversationId) {
  const index = store.index('conversation_id');
  const range = IDBKeyRange.only(String(conversationId || ''));
  await new Promise((resolve, reject) => {
    const request = index.openKeyCursor(range);
    request.onerror = () => reject(request.error || new Error('删除对话文件失败。'));
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
    throw new Error('无法保存无效的对话文件。');
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
  const normalizedDocs = normalizeConversationDocumentSet(normalizedConversationId, documents);

  const db = await openChatHistoryDB();
  const transaction = db.transaction(CONVERSATION_DOCUMENT_STORE, 'readwrite');
  const store = transaction.objectStore(CONVERSATION_DOCUMENT_STORE);
  const donePromise = transactionDone(transaction);
  await deleteDocumentsByConversationIdInTransaction(store, normalizedConversationId);
  normalizedDocs.forEach((doc) => store.put(doc));
  await donePromise;
  return normalizedDocs.map(cloneStructured);
}

/**
 * 在同一个 readwrite 事务中读取、验证并替换一个对话的完整文件集合。
 * mutator 必须是同步纯函数，返回 `{ documents, value }`；任何异常都会在写入前中止。
 */
export async function mutateConversationDocuments(conversationId, mutator) {
  const normalizedConversationId = String(conversationId || '').trim();
  if (!normalizedConversationId) {
    throw new Error('mutateConversationDocuments 缺少 conversationId。');
  }
  if (typeof mutator !== 'function') {
    throw new Error('mutateConversationDocuments 缺少同步 mutator。');
  }
  const db = await openChatHistoryDB();
  const transaction = db.transaction(CONVERSATION_DOCUMENT_STORE, 'readwrite');
  const store = transaction.objectStore(CONVERSATION_DOCUMENT_STORE);
  const donePromise = transactionDone(transaction);
  try {
    const currentDocuments = await collectDocumentsByConversationId(store, normalizedConversationId);
    const prepared = mutator(currentDocuments.map(cloneStructured));
    if (prepared && typeof prepared.then === 'function') {
      throw new Error('mutateConversationDocuments mutator 必须同步返回。');
    }
    if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) {
      throw new Error('mutateConversationDocuments mutator 必须返回 { documents, value }。');
    }
    const nextDocuments = normalizeConversationDocumentSet(
      normalizedConversationId,
      prepared.documents
    );
    await deleteDocumentsByConversationIdInTransaction(store, normalizedConversationId);
    nextDocuments.forEach((documentRecord) => store.put(documentRecord));
    await donePromise;
    return {
      documents: nextDocuments.map(cloneStructured),
      value: cloneStructured(prepared.value)
    };
  } catch (error) {
    try {
      transaction.abort();
    } catch (_) {}
    try {
      await donePromise;
    } catch (_) {}
    if (error && typeof error === 'object') error.state_changed = false;
    throw error;
  }
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
