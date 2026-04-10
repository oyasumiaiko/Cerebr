/**
 * 扩展状态透明备份工具。
 *
 * 设计目标：
 * - 只处理“扩展级状态”，不触碰 IndexedDB / 聊天记录主体；
 * - 透明读取 chrome.storage.sync / chrome.storage.local / 扩展页 localStorage；
 * - 提供 API 域与杂项域两种快照，避免未来每新增一个 key 都手工维护白名单；
 * - 导入时按“域”整体替换，只覆盖目标域，不误伤另一域。
 *
 * 说明：
 * - 这里的“透明”并不等于完全不分类；为了把 API 域单独导出，仍需要做一次通用启发式分类。
 * - 分类策略优先看 key 名，再看对象结构中的字段名；不会去扫描任意大字符串内容，
 *   以避免把 devtools/localStorage 之类“恰好出现 api 字样”的杂项误判成 API 状态。
 */

export const EXTENSION_STATE_BACKUP_KIND = 'cerebr_extension_state_backup';
export const EXTENSION_STATE_BACKUP_SCHEMA_VERSION = 1;
export const EXTENSION_STATE_BACKUP_CLASSIFIER_VERSION = 1;
export const EXTENSION_STATE_BACKUP_DOMAIN_API = 'api';
export const EXTENSION_STATE_BACKUP_DOMAIN_MISC = 'misc';

const DEFAULT_CHROME_STORAGE_AREAS = ['sync', 'local'];
const DEFAULT_WINDOW_STORAGE_AREAS = ['localStorage'];
const DEFAULT_SYNC_SET_BATCH_BYTES = 32 * 1024;
const DEFAULT_LOCAL_SET_BATCH_BYTES = 256 * 1024;
const DEFAULT_REMOVE_BATCH_SIZE = 128;

// 说明：
// - 这里只保留“语义级 token”，避免把实现绑定到某个固定 key；
// - 例如 apiConfigs_chunks_meta / prompt_system / conversationTitleApi / baseUrl / apiKey
//   都会落到这些 token 上；
// - 一旦后续实现换了具体 key，只要 key/对象结构仍表达“API / 模型 / 提示词 / 连接源”
//   这些语义，备份层通常无需修改。
const API_DOMAIN_TOKENS = [
  'api',
  'apikey',
  'apiconfig',
  'apiconfigs',
  'selectedconfigindex',
  'prompt',
  'model',
  'provider',
  'connection',
  'connectionsource',
  'responses',
  'openai',
  'gemini',
  'baseurl',
  'endpoint',
  'blacklist',
  'servicetier',
  'reasoning'
].map(normalizeClassifierText);

function normalizeBackupDomain(domain) {
  return domain === EXTENSION_STATE_BACKUP_DOMAIN_API
    ? EXTENSION_STATE_BACKUP_DOMAIN_API
    : EXTENSION_STATE_BACKUP_DOMAIN_MISC;
}

function normalizeClassifierText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function textLooksApiRelated(value) {
  const normalized = normalizeClassifierText(value);
  if (!normalized) return false;
  return API_DOMAIN_TOKENS.some((token) => normalized.includes(token));
}

function valueObjectLooksApiRelated(value, options = {}) {
  const maxNodes = Math.max(1, Number(options.maxNodes) || 400);
  if (!value || typeof value !== 'object') return false;

  const seen = new WeakSet();
  const queue = [value];
  let visited = 0;

  while (queue.length > 0 && visited < maxNodes) {
    const current = queue.shift();
    visited += 1;

    if (!current || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) {
        if (item && typeof item === 'object') queue.push(item);
      }
      continue;
    }

    for (const [key, child] of Object.entries(current)) {
      if (textLooksApiRelated(key)) return true;
      if (child && typeof child === 'object') queue.push(child);
    }
  }

  return false;
}

/**
 * 根据 key + 值结构判断条目应归属哪个域。
 *
 * 规则：
 * - key 看起来像 API / Prompt / Model / Connection Source 等语义 => API 域；
 * - key 本身不明显，但对象结构里出现 apiKey / baseUrl / prompt / model 等字段 => API 域；
 * - 其余一律视作杂项域。
 *
 * @param {string} key
 * @param {any} value
 * @returns {'api' | 'misc'}
 */
export function classifyExtensionStateEntryDomain(key, value) {
  if (textLooksApiRelated(key)) {
    return EXTENSION_STATE_BACKUP_DOMAIN_API;
  }
  if (valueObjectLooksApiRelated(value)) {
    return EXTENSION_STATE_BACKUP_DOMAIN_API;
  }
  return EXTENSION_STATE_BACKUP_DOMAIN_MISC;
}

export function filterExtensionStateEntriesForDomain(entries, domain) {
  const resolvedDomain = normalizeBackupDomain(domain);
  const source = isPlainObject(entries) ? entries : {};
  const result = {};

  for (const [key, value] of Object.entries(source)) {
    if (classifyExtensionStateEntryDomain(key, value) === resolvedDomain) {
      result[key] = cloneSerializableValue(value);
    }
  }

  return result;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneSerializableValue(value) {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function getUtf8ByteLength(text) {
  const encoder = new TextEncoder();
  return encoder.encode(String(text || '')).length;
}

function splitObjectEntriesIntoBatches(entries, maxBatchBytes) {
  const limit = Math.max(1024, Number(maxBatchBytes) || 1024);
  const sourceEntries = Array.isArray(entries) ? entries : [];
  const batches = [];
  let currentBatch = [];
  let currentBytes = 2; // 预留最外层对象的基础开销

  for (const entry of sourceEntries) {
    const [key, value] = entry;
    const entryBytes = getUtf8ByteLength(JSON.stringify({ [key]: value }));
    const shouldFlush = currentBatch.length > 0 && (currentBytes + entryBytes > limit);
    if (shouldFlush) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = 2;
    }
    currentBatch.push(entry);
    currentBytes += entryBytes;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

function splitKeysIntoBatches(keys, batchSize = DEFAULT_REMOVE_BATCH_SIZE) {
  const source = Array.isArray(keys) ? keys.filter(Boolean) : [];
  const size = Math.max(1, Number(batchSize) || DEFAULT_REMOVE_BATCH_SIZE);
  const batches = [];
  for (let index = 0; index < source.length; index += size) {
    batches.push(source.slice(index, index + size));
  }
  return batches;
}

function getWindowStorageLike(areaName, options = {}) {
  const explicit = options.windowStorageProviders?.[areaName];
  if (explicit) return explicit;
  return globalThis?.[areaName] || null;
}

function getChromeStorageAreaLike(areaName, options = {}) {
  const explicit = options.chromeStorageProviders?.[areaName];
  if (explicit) return explicit;
  return globalThis?.chrome?.storage?.[areaName] || null;
}

function readWindowStorageEntries(storageLike) {
  if (!storageLike || typeof storageLike.length !== 'number' || typeof storageLike.key !== 'function') {
    return {};
  }
  const result = {};
  for (let index = 0; index < storageLike.length; index += 1) {
    const key = storageLike.key(index);
    if (typeof key !== 'string' || !key) continue;
    result[key] = storageLike.getItem(key);
  }
  return result;
}

async function readChromeStorageEntries(areaLike) {
  if (!areaLike || typeof areaLike.get !== 'function') return {};
  const result = await areaLike.get(null);
  return isPlainObject(result) ? result : {};
}

async function replaceChromeStorageEntries(areaName, nextEntries, domain, options = {}) {
  const areaLike = getChromeStorageAreaLike(areaName, options);
  if (!areaLike || typeof areaLike.get !== 'function') {
    return { removedKeys: [], writtenKeys: [] };
  }

  const currentEntries = await readChromeStorageEntries(areaLike);
  const currentDomainKeys = Object.entries(currentEntries)
    .filter(([key, value]) => classifyExtensionStateEntryDomain(key, value) === domain)
    .map(([key]) => key);

  for (const batch of splitKeysIntoBatches(currentDomainKeys)) {
    if (batch.length > 0 && typeof areaLike.remove === 'function') {
      await areaLike.remove(batch);
    }
  }

  const entriesToWrite = Object.entries(isPlainObject(nextEntries) ? nextEntries : {});
  const maxBatchBytes = areaName === 'sync' ? DEFAULT_SYNC_SET_BATCH_BYTES : DEFAULT_LOCAL_SET_BATCH_BYTES;
  for (const batch of splitObjectEntriesIntoBatches(entriesToWrite, maxBatchBytes)) {
    if (batch.length === 0 || typeof areaLike.set !== 'function') continue;
    await areaLike.set(Object.fromEntries(batch));
  }

  return {
    removedKeys: currentDomainKeys,
    writtenKeys: entriesToWrite.map(([key]) => key)
  };
}

function replaceWindowStorageEntries(areaName, nextEntries, domain, options = {}) {
  const storageLike = getWindowStorageLike(areaName, options);
  if (!storageLike || typeof storageLike.setItem !== 'function') {
    return { removedKeys: [], writtenKeys: [] };
  }

  const currentEntries = readWindowStorageEntries(storageLike);
  const currentDomainKeys = Object.entries(currentEntries)
    .filter(([key, value]) => classifyExtensionStateEntryDomain(key, value) === domain)
    .map(([key]) => key);

  currentDomainKeys.forEach((key) => storageLike.removeItem(key));

  const source = isPlainObject(nextEntries) ? nextEntries : {};
  const writtenKeys = [];
  for (const [key, value] of Object.entries(source)) {
    storageLike.setItem(key, String(value ?? ''));
    writtenKeys.push(key);
  }

  return {
    removedKeys: currentDomainKeys,
    writtenKeys
  };
}

export async function createExtensionStateBackupSnapshot(options = {}) {
  const domain = normalizeBackupDomain(options.domain);
  const chromeStorageAreas = Array.isArray(options.chromeStorageAreas) && options.chromeStorageAreas.length > 0
    ? options.chromeStorageAreas
    : DEFAULT_CHROME_STORAGE_AREAS;
  const windowStorageAreas = Array.isArray(options.windowStorageAreas) && options.windowStorageAreas.length > 0
    ? options.windowStorageAreas
    : DEFAULT_WINDOW_STORAGE_AREAS;

  const chromeStorage = {};
  for (const areaName of chromeStorageAreas) {
    const areaLike = getChromeStorageAreaLike(areaName, options);
    const allEntries = await readChromeStorageEntries(areaLike);
    chromeStorage[areaName] = filterExtensionStateEntriesForDomain(allEntries, domain);
  }

  const windowStorage = {};
  for (const areaName of windowStorageAreas) {
    const storageLike = getWindowStorageLike(areaName, options);
    const allEntries = readWindowStorageEntries(storageLike);
    windowStorage[areaName] = filterExtensionStateEntriesForDomain(allEntries, domain);
  }

  return {
    kind: EXTENSION_STATE_BACKUP_KIND,
    schemaVersion: EXTENSION_STATE_BACKUP_SCHEMA_VERSION,
    classifierVersion: EXTENSION_STATE_BACKUP_CLASSIFIER_VERSION,
    domain,
    createdAt: new Date().toISOString(),
    sources: {
      chromeStorage,
      windowStorage
    },
    stats: {
      chromeStorage: Object.fromEntries(
        Object.entries(chromeStorage).map(([areaName, entries]) => [areaName, Object.keys(entries).length])
      ),
      windowStorage: Object.fromEntries(
        Object.entries(windowStorage).map(([areaName, entries]) => [areaName, Object.keys(entries).length])
      )
    }
  };
}

export function parseExtensionStateBackupSnapshot(raw, options = {}) {
  if (!isPlainObject(raw)) {
    throw new Error('扩展状态备份格式无效：根对象必须是 JSON 对象');
  }
  if (raw.kind !== EXTENSION_STATE_BACKUP_KIND) {
    throw new Error('扩展状态备份格式无效：kind 不匹配');
  }
  if (Number(raw.schemaVersion) !== EXTENSION_STATE_BACKUP_SCHEMA_VERSION) {
    throw new Error('扩展状态备份格式无效：schemaVersion 不支持');
  }

  const domain = normalizeBackupDomain(raw.domain);
  const expectedDomain = options.expectedDomain ? normalizeBackupDomain(options.expectedDomain) : null;
  if (expectedDomain && domain !== expectedDomain) {
    throw new Error(`备份类型不匹配：期望 ${expectedDomain}，实际为 ${domain}`);
  }

  const sources = isPlainObject(raw.sources) ? raw.sources : {};
  const chromeStorage = isPlainObject(sources.chromeStorage) ? sources.chromeStorage : {};
  const windowStorage = isPlainObject(sources.windowStorage) ? sources.windowStorage : {};

  const normalizedChromeStorage = {};
  for (const [areaName, entries] of Object.entries(chromeStorage)) {
    normalizedChromeStorage[areaName] = isPlainObject(entries) ? cloneSerializableValue(entries) : {};
  }

  const normalizedWindowStorage = {};
  for (const [areaName, entries] of Object.entries(windowStorage)) {
    normalizedWindowStorage[areaName] = isPlainObject(entries) ? cloneSerializableValue(entries) : {};
  }

  return {
    kind: EXTENSION_STATE_BACKUP_KIND,
    schemaVersion: EXTENSION_STATE_BACKUP_SCHEMA_VERSION,
    classifierVersion: Number(raw.classifierVersion) || EXTENSION_STATE_BACKUP_CLASSIFIER_VERSION,
    domain,
    createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : '',
    sources: {
      chromeStorage: normalizedChromeStorage,
      windowStorage: normalizedWindowStorage
    },
    stats: isPlainObject(raw.stats) ? cloneSerializableValue(raw.stats) : {}
  };
}

export async function restoreExtensionStateBackupSnapshot(rawSnapshot, options = {}) {
  const snapshot = parseExtensionStateBackupSnapshot(rawSnapshot, {
    expectedDomain: options.expectedDomain || null
  });
  const domain = snapshot.domain;

  const chromeStorageAreas = new Set([
    ...DEFAULT_CHROME_STORAGE_AREAS,
    ...Object.keys(snapshot.sources.chromeStorage || {}),
    ...Object.keys(options.chromeStorageProviders || {})
  ]);
  const windowStorageAreas = new Set([
    ...DEFAULT_WINDOW_STORAGE_AREAS,
    ...Object.keys(snapshot.sources.windowStorage || {}),
    ...Object.keys(options.windowStorageProviders || {})
  ]);

  const result = {
    domain,
    chromeStorage: {},
    windowStorage: {}
  };

  for (const areaName of chromeStorageAreas) {
    result.chromeStorage[areaName] = await replaceChromeStorageEntries(
      areaName,
      snapshot.sources.chromeStorage?.[areaName] || {},
      domain,
      options
    );
  }

  for (const areaName of windowStorageAreas) {
    result.windowStorage[areaName] = replaceWindowStorageEntries(
      areaName,
      snapshot.sources.windowStorage?.[areaName] || {},
      domain,
      options
    );
  }

  return result;
}

function formatTimestampPart(value) {
  return String(value).padStart(2, '0');
}

export function buildExtensionStateBackupFilename(options = {}) {
  const domain = normalizeBackupDomain(options.domain);
  const timestamp = options.timestamp instanceof Date
    ? options.timestamp
    : new Date(Number.isFinite(options.timestamp) ? options.timestamp : Date.now());
  const compress = !!options.compress;

  // 说明：
  // - 文件名使用 UTC 时间，避免不同机器时区导致同一备份在命名上不稳定；
  // - 这只影响文件名，不影响备份内容里的 createdAt。
  const year = timestamp.getUTCFullYear();
  const month = formatTimestampPart(timestamp.getUTCMonth() + 1);
  const day = formatTimestampPart(timestamp.getUTCDate());
  const hour = formatTimestampPart(timestamp.getUTCHours());
  const minute = formatTimestampPart(timestamp.getUTCMinutes());
  const second = formatTimestampPart(timestamp.getUTCSeconds());
  const suffix = compress ? '.json.gz' : '.json';

  return `extension_state_${domain}_${year}${month}${day}_${hour}${minute}${second}${suffix}`;
}
