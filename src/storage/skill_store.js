/**
 * skill 的 IndexedDB 持久化层。
 *
 * 设计目标：
 * - manifest 与文件内容分离存储，避免“只想列 skill 摘要”时把整包源码/说明都结构化克隆出来；
 * - service worker / sidebar 共用同一套最小接口；
 * - 不模拟完整文件系统，只提供 skill package 所需的按名称、按路径读写能力。
 */

export const SKILL_DB_NAME = 'CerebrSkillDB';
export const SKILL_DB_VERSION = 1;
export const SKILL_MANIFEST_STORE = 'skill_manifests';
export const SKILL_FILE_STORE = 'skill_files';
export const LEGACY_MICRO_SKILL_DB_NAME = 'CerebrMicroSkillDB';
export const LEGACY_MICRO_SKILL_DB_VERSION = 1;

let cachedSkillDbPromise = null;
let skillDbMigrationPromise = null;

function ensureIndexedDbAvailable() {
  if (!globalThis?.indexedDB || typeof globalThis.indexedDB.open !== 'function') {
    throw new Error('当前环境没有可用的 IndexedDB，无法访问skill 存储。');
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

function openNamedSkillDb(indexedDb, dbName, dbVersion) {
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(dbName, dbVersion);

    request.onerror = () => reject(request.error || new Error(`打开数据库 ${dbName} 失败。`));

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        try { db.close(); } catch (_) {}
      };
      resolve(db);
    };
  });
}

async function listIndexedDbNames(indexedDb) {
  if (!indexedDb || typeof indexedDb.databases !== 'function') {
    return [];
  }
  try {
    const databases = await indexedDb.databases();
    return (Array.isArray(databases) ? databases : [])
      .map((entry) => (typeof entry?.name === 'string') ? entry.name.trim() : '')
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

export function shouldMigrateLegacySkillDb({
  availableDbNames,
  currentManifestCount,
  currentFileCount
} = {}) {
  const names = Array.isArray(availableDbNames)
    ? availableDbNames
        .map((name) => (typeof name === 'string') ? name.trim() : '')
        .filter(Boolean)
    : [];
  const normalizedManifestCount = Number(currentManifestCount) || 0;
  const normalizedFileCount = Number(currentFileCount) || 0;
  const currentDbHasData = normalizedManifestCount > 0 || normalizedFileCount > 0;
  if (currentDbHasData) return false;
  return names.includes(LEGACY_MICRO_SKILL_DB_NAME);
}

async function countStoreRecords(store) {
  return await requestToPromise(store.count());
}

async function getAllStoreRecords(store) {
  return await requestToPromise(store.getAll());
}

async function ensureLegacyMicroSkillDbMigrated(currentDb) {
  if (!currentDb) return;
  if (skillDbMigrationPromise) {
    await skillDbMigrationPromise;
    return;
  }

  skillDbMigrationPromise = (async () => {
    const indexedDb = ensureIndexedDbAvailable();
    const availableDbNames = await listIndexedDbNames(indexedDb);

    const currentCountTx = currentDb.transaction([SKILL_MANIFEST_STORE, SKILL_FILE_STORE], 'readonly');
    const currentManifestStore = currentCountTx.objectStore(SKILL_MANIFEST_STORE);
    const currentFileStore = currentCountTx.objectStore(SKILL_FILE_STORE);
    const [currentManifestCount, currentFileCount] = await Promise.all([
      countStoreRecords(currentManifestStore),
      countStoreRecords(currentFileStore)
    ]);
    await transactionDone(currentCountTx);

    if (!shouldMigrateLegacySkillDb({
      availableDbNames,
      currentManifestCount,
      currentFileCount
    })) {
      return;
    }

    const legacyDb = await openNamedSkillDb(indexedDb, LEGACY_MICRO_SKILL_DB_NAME, LEGACY_MICRO_SKILL_DB_VERSION);
    try {
      const legacyReadTx = legacyDb.transaction([SKILL_MANIFEST_STORE, SKILL_FILE_STORE], 'readonly');
      const legacyManifestStore = legacyReadTx.objectStore(SKILL_MANIFEST_STORE);
      const legacyFileStore = legacyReadTx.objectStore(SKILL_FILE_STORE);
      const [legacyManifests, legacyFiles] = await Promise.all([
        getAllStoreRecords(legacyManifestStore),
        getAllStoreRecords(legacyFileStore)
      ]);
      await transactionDone(legacyReadTx);

      if ((!Array.isArray(legacyManifests) || legacyManifests.length <= 0)
        && (!Array.isArray(legacyFiles) || legacyFiles.length <= 0)) {
        return;
      }

      const currentWriteTx = currentDb.transaction([SKILL_MANIFEST_STORE, SKILL_FILE_STORE], 'readwrite');
      const writeManifestStore = currentWriteTx.objectStore(SKILL_MANIFEST_STORE);
      const writeFileStore = currentWriteTx.objectStore(SKILL_FILE_STORE);
      (Array.isArray(legacyManifests) ? legacyManifests : []).forEach((manifest) => {
        writeManifestStore.put(cloneStructured(manifest));
      });
      (Array.isArray(legacyFiles) ? legacyFiles : []).forEach((file) => {
        writeFileStore.put(cloneStructured(file));
      });
      await transactionDone(currentWriteTx);
    } finally {
      try { legacyDb.close(); } catch (_) {}
    }
  })().finally(() => {
    skillDbMigrationPromise = null;
  });

  await skillDbMigrationPromise;
}

export function openSkillDb() {
  if (cachedSkillDbPromise) return cachedSkillDbPromise;

  cachedSkillDbPromise = new Promise((resolve, reject) => {
    const indexedDb = ensureIndexedDbAvailable();
    const request = indexedDb.open(SKILL_DB_NAME, SKILL_DB_VERSION);

    request.onerror = () => {
      cachedSkillDbPromise = null;
      reject(request.error || new Error('打开skill 数据库失败。'));
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        try { db.close(); } catch (_) {}
        cachedSkillDbPromise = null;
      };
      Promise.resolve()
        .then(() => ensureLegacyMicroSkillDbMigrated(db))
        .then(() => resolve(db))
        .catch((error) => {
          cachedSkillDbPromise = null;
          try { db.close(); } catch (_) {}
          reject(error || new Error('迁移 legacy micro skill 数据库失败。'));
        });
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(SKILL_MANIFEST_STORE)) {
        const manifestStore = db.createObjectStore(SKILL_MANIFEST_STORE, { keyPath: 'name' });
        manifestStore.createIndex('updated_at', 'updated_at', { unique: false });
      }

      if (!db.objectStoreNames.contains(SKILL_FILE_STORE)) {
        const fileStore = db.createObjectStore(SKILL_FILE_STORE, {
          keyPath: ['skill_name', 'path']
        });
        fileStore.createIndex('skill_name', 'skill_name', { unique: false });
        fileStore.createIndex('skill_name_kind', ['skill_name', 'kind'], { unique: false });
      }
    };
  });

  return cachedSkillDbPromise;
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
    request.onerror = () => reject(request.error || new Error('删除skill 文件失败。'));
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
 * 创建skill 的持久化 store 适配器。
 *
 * 返回的接口故意很小：
 * - listManifests / getManifest 用于摘要、匹配、列表；
 * - getPackage / savePackage / deletePackage 用于详情、源码与更新；
 * - 底层固定走 IndexedDB，避免再把大文本塞回 chrome.storage.local。
 */
export function createIndexedDbSkillStore() {
  return {
    kind: 'indexeddb',

    async listManifests() {
      const db = await openSkillDb();
      const transaction = db.transaction(SKILL_MANIFEST_STORE, 'readonly');
      const store = transaction.objectStore(SKILL_MANIFEST_STORE);
      const manifests = await requestToPromise(store.getAll());
      await transactionDone(transaction);
      return Array.isArray(manifests) ? manifests.map(cloneStructured) : [];
    },

    async getManifest(skillName) {
      const db = await openSkillDb();
      const transaction = db.transaction(SKILL_MANIFEST_STORE, 'readonly');
      const store = transaction.objectStore(SKILL_MANIFEST_STORE);
      const manifest = await requestToPromise(store.get(String(skillName || '')));
      await transactionDone(transaction);
      return manifest ? cloneStructured(manifest) : null;
    },

    async getPackage(skillName) {
      const db = await openSkillDb();
      const transaction = db.transaction([SKILL_MANIFEST_STORE, SKILL_FILE_STORE], 'readonly');
      const manifestStore = transaction.objectStore(SKILL_MANIFEST_STORE);
      const fileStore = transaction.objectStore(SKILL_FILE_STORE);

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
      const db = await openSkillDb();
      const transaction = db.transaction([SKILL_MANIFEST_STORE, SKILL_FILE_STORE], 'readwrite');
      const manifestStore = transaction.objectStore(SKILL_MANIFEST_STORE);
      const fileStore = transaction.objectStore(SKILL_FILE_STORE);

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
      const db = await openSkillDb();
      const transaction = db.transaction([SKILL_MANIFEST_STORE, SKILL_FILE_STORE], 'readwrite');
      const manifestStore = transaction.objectStore(SKILL_MANIFEST_STORE);
      const fileStore = transaction.objectStore(SKILL_FILE_STORE);

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
