/**
 * 微型 skill 的 IndexedDB 持久化层。
 *
 * 设计目标：
 * - manifest 与文件内容分离存储，避免“只想列 skill 摘要”时把整包源码/说明都结构化克隆出来；
 * - service worker / sidebar 共用同一套最小接口；
 * - 不模拟完整文件系统，只提供 skill package 所需的按名称、按路径读写能力。
 */

export const MICRO_SKILL_DB_NAME = 'CerebrMicroSkillDB';
export const MICRO_SKILL_DB_VERSION = 1;
export const MICRO_SKILL_MANIFEST_STORE = 'skill_manifests';
export const MICRO_SKILL_FILE_STORE = 'skill_files';

let cachedMicroSkillDbPromise = null;

function ensureIndexedDbAvailable() {
  if (!globalThis?.indexedDB || typeof globalThis.indexedDB.open !== 'function') {
    throw new Error('当前环境没有可用的 IndexedDB，无法访问微型 skill 存储。');
  }
  return globalThis.indexedDB;
}

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

export function openMicroSkillDb() {
  if (cachedMicroSkillDbPromise) return cachedMicroSkillDbPromise;

  cachedMicroSkillDbPromise = new Promise((resolve, reject) => {
    const indexedDb = ensureIndexedDbAvailable();
    const request = indexedDb.open(MICRO_SKILL_DB_NAME, MICRO_SKILL_DB_VERSION);

    request.onerror = () => {
      cachedMicroSkillDbPromise = null;
      reject(request.error || new Error('打开微型 skill 数据库失败。'));
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        try { db.close(); } catch (_) {}
        cachedMicroSkillDbPromise = null;
      };
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(MICRO_SKILL_MANIFEST_STORE)) {
        const manifestStore = db.createObjectStore(MICRO_SKILL_MANIFEST_STORE, { keyPath: 'name' });
        manifestStore.createIndex('updated_at', 'updated_at', { unique: false });
      }

      if (!db.objectStoreNames.contains(MICRO_SKILL_FILE_STORE)) {
        const fileStore = db.createObjectStore(MICRO_SKILL_FILE_STORE, {
          keyPath: ['skill_name', 'path']
        });
        fileStore.createIndex('skill_name', 'skill_name', { unique: false });
        fileStore.createIndex('skill_name_kind', ['skill_name', 'kind'], { unique: false });
      }
    };
  });

  return cachedMicroSkillDbPromise;
}

async function collectFilesBySkillName(fileStore, skillName) {
  const index = fileStore.index('skill_name');
  const range = IDBKeyRange.only(String(skillName || ''));
  return await requestToPromise(index.getAll(range));
}

async function deleteFilesBySkillName(fileStore, skillName) {
  const index = fileStore.index('skill_name');
  const range = IDBKeyRange.only(String(skillName || ''));

  await new Promise((resolve, reject) => {
    const request = index.openKeyCursor(range);
    request.onerror = () => reject(request.error || new Error('删除微型 skill 文件失败。'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      fileStore.delete(cursor.primaryKey);
      cursor.continue();
    };
  });
}

/**
 * 创建微型 skill 的持久化 store 适配器。
 *
 * 返回的接口故意很小：
 * - listManifests / getManifest 用于摘要、匹配、列表；
 * - getPackage / savePackage / deletePackage 用于详情、源码与更新；
 * - 底层固定走 IndexedDB，避免再把大文本塞回 chrome.storage.local。
 */
export function createIndexedDbMicroSkillStore() {
  return {
    kind: 'indexeddb',

    async listManifests() {
      const db = await openMicroSkillDb();
      const transaction = db.transaction(MICRO_SKILL_MANIFEST_STORE, 'readonly');
      const store = transaction.objectStore(MICRO_SKILL_MANIFEST_STORE);
      const manifests = await requestToPromise(store.getAll());
      await transactionDone(transaction);
      return Array.isArray(manifests) ? manifests.map(cloneStructured) : [];
    },

    async getManifest(skillName) {
      const db = await openMicroSkillDb();
      const transaction = db.transaction(MICRO_SKILL_MANIFEST_STORE, 'readonly');
      const store = transaction.objectStore(MICRO_SKILL_MANIFEST_STORE);
      const manifest = await requestToPromise(store.get(String(skillName || '')));
      await transactionDone(transaction);
      return manifest ? cloneStructured(manifest) : null;
    },

    async getPackage(skillName) {
      const db = await openMicroSkillDb();
      const transaction = db.transaction([MICRO_SKILL_MANIFEST_STORE, MICRO_SKILL_FILE_STORE], 'readonly');
      const manifestStore = transaction.objectStore(MICRO_SKILL_MANIFEST_STORE);
      const fileStore = transaction.objectStore(MICRO_SKILL_FILE_STORE);

      const [manifest, files] = await Promise.all([
        requestToPromise(manifestStore.get(String(skillName || ''))),
        collectFilesBySkillName(fileStore, skillName)
      ]);
      await transactionDone(transaction);

      if (!manifest) return null;
      return {
        ...cloneStructured(manifest),
        files: Array.isArray(files) ? files.map((file) => ({
          path: file.path,
          kind: file.kind,
          content: file.content
        })) : []
      };
    },

    async savePackage(skillPackage) {
      const pkg = cloneStructured(skillPackage);
      const db = await openMicroSkillDb();
      const transaction = db.transaction([MICRO_SKILL_MANIFEST_STORE, MICRO_SKILL_FILE_STORE], 'readwrite');
      const manifestStore = transaction.objectStore(MICRO_SKILL_MANIFEST_STORE);
      const fileStore = transaction.objectStore(MICRO_SKILL_FILE_STORE);

      const {
        files = [],
        ...manifest
      } = pkg || {};
      const filesMeta = (Array.isArray(files) ? files : []).map((file) => ({
        path: file.path,
        kind: file.kind
      }));

      await deleteFilesBySkillName(fileStore, manifest.name);
      manifestStore.put({
        ...manifest,
        has_file_contents: false,
        files_meta: filesMeta
      });
      (Array.isArray(files) ? files : []).forEach((file) => {
        fileStore.put({
          skill_name: manifest.name,
          path: file.path,
          kind: file.kind,
          content: file.content
        });
      });
      await transactionDone(transaction);
      return cloneStructured(pkg);
    },

    async deletePackage(skillName) {
      const normalizedName = String(skillName || '');
      const db = await openMicroSkillDb();
      const transaction = db.transaction([MICRO_SKILL_MANIFEST_STORE, MICRO_SKILL_FILE_STORE], 'readwrite');
      const manifestStore = transaction.objectStore(MICRO_SKILL_MANIFEST_STORE);
      const fileStore = transaction.objectStore(MICRO_SKILL_FILE_STORE);

      manifestStore.delete(normalizedName);
      await deleteFilesBySkillName(fileStore, normalizedName);
      await transactionDone(transaction);
      return {
        ok: true,
        name: normalizedName
      };
    }
  };
}
