/**
 * 自定义背景图片的短生命周期二进制中转库。
 *
 * background 与 sidebar 同属 chrome-extension origin，却不能可靠地共享 Blob URL；
 * Cache Storage 在部分 Chrome 扩展上下文会直接抛出内部错误。这里使用 IndexedDB
 * 结构化克隆 Blob，避免 Base64 膨胀和 runtime.sendMessage 传输大图片。
 */

export const BACKGROUND_IMAGE_BLOB_DB_NAME = 'CerebrBackgroundImageBlobDB';
export const BACKGROUND_IMAGE_BLOB_STORE_NAME = 'background_image_blobs';
const BACKGROUND_IMAGE_BLOB_DB_VERSION = 1;
const BACKGROUND_IMAGE_BLOB_TTL_MS = 10 * 60 * 1000;

let databasePromise = null;

function getIndexedDb() {
  if (!globalThis.indexedDB || typeof globalThis.indexedDB.open !== 'function') {
    throw new Error('当前环境没有可用的 IndexedDB，无法暂存背景图片。');
  }
  return globalThis.indexedDB;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败。'));
  });
}

function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 事务失败。'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB 事务已中止。'));
  });
}

function normalizeBlobKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key) throw new Error('背景图片暂存键为空。');
  return key;
}

function openBackgroundImageBlobDb() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = getIndexedDb().open(BACKGROUND_IMAGE_BLOB_DB_NAME, BACKGROUND_IMAGE_BLOB_DB_VERSION);
    request.onerror = () => {
      databasePromise = null;
      reject(request.error || new Error('打开背景图片暂存库失败。'));
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BACKGROUND_IMAGE_BLOB_STORE_NAME)) {
        db.createObjectStore(BACKGROUND_IMAGE_BLOB_STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        try { db.close(); } catch (_) {}
        databasePromise = null;
      };
      resolve(db);
    };
  });
  return databasePromise;
}

async function removeExpiredBackgroundImageBlobs(db, now) {
  const transaction = db.transaction(BACKGROUND_IMAGE_BLOB_STORE_NAME, 'readwrite');
  const store = transaction.objectStore(BACKGROUND_IMAGE_BLOB_STORE_NAME);
  const expiry = now - BACKGROUND_IMAGE_BLOB_TTL_MS;
  const cursorRequest = store.openCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    if (!Number.isFinite(cursor.value?.createdAt) || cursor.value.createdAt < expiry) {
      cursor.delete();
    }
    cursor.continue();
  };
  await transactionToPromise(transaction);
}

/**
 * 由 background 写入刚下载完成的图片 Blob。记录只能被 sidebar 消费一次。
 */
export async function putBackgroundImageBlob({ key, blob, sourceUrl = '', contentType = '' }) {
  const normalizedKey = normalizeBlobKey(key);
  if (!(blob instanceof Blob) || blob.size <= 0) {
    throw new Error('待暂存的背景图片 Blob 无效。');
  }
  const db = await openBackgroundImageBlobDb();
  const now = Date.now();
  await removeExpiredBackgroundImageBlobs(db, now);
  const transaction = db.transaction(BACKGROUND_IMAGE_BLOB_STORE_NAME, 'readwrite');
  transaction.objectStore(BACKGROUND_IMAGE_BLOB_STORE_NAME).put({
    key: normalizedKey,
    blob,
    sourceUrl: typeof sourceUrl === 'string' ? sourceUrl : '',
    contentType: typeof contentType === 'string' ? contentType : '',
    createdAt: now
  });
  await transactionToPromise(transaction);
}

/**
 * 由 sidebar 读取并立即删除图片 Blob，避免列表切换时长期占用扩展配额。
 */
export async function takeBackgroundImageBlob(key) {
  const normalizedKey = normalizeBlobKey(key);
  const db = await openBackgroundImageBlobDb();
  const transaction = db.transaction(BACKGROUND_IMAGE_BLOB_STORE_NAME, 'readwrite');
  const store = transaction.objectStore(BACKGROUND_IMAGE_BLOB_STORE_NAME);
  const record = await requestToPromise(store.get(normalizedKey));
  if (record) store.delete(normalizedKey);
  await transactionToPromise(transaction);
  if (!(record?.blob instanceof Blob)) {
    throw new Error('background 图片暂存记录不存在或已过期。');
  }
  return record.blob;
}
