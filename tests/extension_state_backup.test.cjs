const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadExtensionStateBackupModule() {
  const filePath = path.resolve(__dirname, '../src/utils/extension_state_backup.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createMockChromeArea(initial = {}) {
  let store = clone(initial);
  return {
    async get(keys) {
      if (keys == null) return clone(store);
      if (Array.isArray(keys)) {
        const result = {};
        keys.forEach((key) => {
          if (Object.prototype.hasOwnProperty.call(store, key)) {
            result[key] = clone(store[key]);
          }
        });
        return result;
      }
      if (typeof keys === 'string') {
        return Object.prototype.hasOwnProperty.call(store, keys)
          ? { [keys]: clone(store[keys]) }
          : {};
      }
      return clone(store);
    },
    async set(payload) {
      store = { ...store, ...clone(payload) };
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach((key) => {
        delete store[key];
      });
    },
    dump() {
      return clone(store);
    }
  };
}

function createMockWindowStorage(initial = {}) {
  const map = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
  return {
    get length() {
      return map.size;
    },
    key(index) {
      return Array.from(map.keys())[index] ?? null;
    },
    getItem(key) {
      return map.has(String(key)) ? map.get(String(key)) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    dump() {
      return Object.fromEntries(map.entries());
    }
  };
}

test('createExtensionStateBackupSnapshot 会把 API 状态与杂项设置透明分桶', async () => {
  const {
    EXTENSION_STATE_BACKUP_DOMAIN_API,
    EXTENSION_STATE_BACKUP_DOMAIN_MISC,
    createExtensionStateBackupSnapshot
  } = await loadExtensionStateBackupModule();

  const syncArea = createMockChromeArea({
    apiConfigs_chunks_meta: { count: 2, updatedAt: 123 },
    prompt_system: { prompt: '你是助手', model: 'gpt-4.1' },
    selectedConfigIndex: 1,
    sidebarWidth: 480,
    chat_backup_prefs: { compressDefault: true }
  });
  const localArea = createMockChromeArea({
    apiConfigs_backup_v1: {
      version: 2,
      selectedConfigIndex: 1,
      items: [{ id: 'cfg_1', apiKey: 'sk-live', baseUrl: 'https://api.example.com/v1' }]
    },
    image_hash_cache_v1: { abc: 1 },
    thread_layout_prefs: { width: 360 }
  });
  const localStorageArea = createMockWindowStorage({
    'cerebr.chat_history_panel_fullscreen_layout_v1': '{"width":960}',
    'devtools-last-viewed': '["src/api/api_settings.js"]'
  });

  const apiSnapshot = await createExtensionStateBackupSnapshot({
    domain: EXTENSION_STATE_BACKUP_DOMAIN_API,
    chromeStorageProviders: { sync: syncArea, local: localArea },
    windowStorageProviders: { localStorage: localStorageArea }
  });
  const miscSnapshot = await createExtensionStateBackupSnapshot({
    domain: EXTENSION_STATE_BACKUP_DOMAIN_MISC,
    chromeStorageProviders: { sync: syncArea, local: localArea },
    windowStorageProviders: { localStorage: localStorageArea }
  });

  assert.deepEqual(Object.keys(apiSnapshot.sources.chromeStorage.sync).sort(), [
    'apiConfigs_chunks_meta',
    'prompt_system',
    'selectedConfigIndex'
  ]);
  assert.deepEqual(Object.keys(apiSnapshot.sources.chromeStorage.local).sort(), [
    'apiConfigs_backup_v1'
  ]);
  assert.deepEqual(apiSnapshot.sources.windowStorage.localStorage, {});

  assert.deepEqual(Object.keys(miscSnapshot.sources.chromeStorage.sync).sort(), [
    'chat_backup_prefs',
    'sidebarWidth'
  ]);
  assert.deepEqual(Object.keys(miscSnapshot.sources.chromeStorage.local).sort(), [
    'image_hash_cache_v1',
    'thread_layout_prefs'
  ]);
  assert.deepEqual(miscSnapshot.sources.windowStorage.localStorage, {
    'cerebr.chat_history_panel_fullscreen_layout_v1': '{"width":960}',
    'devtools-last-viewed': '["src/api/api_settings.js"]'
  });
});

test('restoreExtensionStateBackupSnapshot 只替换目标域，不覆盖另一域', async () => {
  const {
    EXTENSION_STATE_BACKUP_DOMAIN_API,
    restoreExtensionStateBackupSnapshot
  } = await loadExtensionStateBackupModule();

  const syncArea = createMockChromeArea({
    apiConfigs_chunks_meta: { count: 1, updatedAt: 10 },
    prompt_system: { prompt: '旧提示词', model: 'gpt-old' },
    sidebarWidth: 520,
    pinnedConversationIds: ['conv_1']
  });
  const localArea = createMockChromeArea({
    apiConfigs_backup_v1: {
      version: 2,
      items: [{ id: 'old', apiKey: 'sk-old', baseUrl: 'https://old.example.com/v1' }]
    },
    image_hash_cache_v1: { keep: true }
  });
  const localStorageArea = createMockWindowStorage({
    'cerebr.chat_history_panel_fullscreen_layout_v1': '{"width":800}'
  });

  const snapshot = {
    kind: 'cerebr_extension_state_backup',
    schemaVersion: 1,
    classifierVersion: 1,
    domain: EXTENSION_STATE_BACKUP_DOMAIN_API,
    createdAt: '2026-04-10T00:00:00.000Z',
    sources: {
      chromeStorage: {
        sync: {
          apiConfigs_chunks_meta: { count: 2, updatedAt: 20 },
          selectedConfigIndex: 3
        },
        local: {
          apiConfigs_backup_v1: {
            version: 2,
            items: [{ id: 'new', apiKey: 'sk-new', baseUrl: 'https://new.example.com/v1' }]
          }
        }
      },
      windowStorage: {
        localStorage: {}
      }
    }
  };

  const result = await restoreExtensionStateBackupSnapshot(snapshot, {
    expectedDomain: EXTENSION_STATE_BACKUP_DOMAIN_API,
    chromeStorageProviders: { sync: syncArea, local: localArea },
    windowStorageProviders: { localStorage: localStorageArea }
  });

  assert.deepEqual(syncArea.dump(), {
    apiConfigs_chunks_meta: { count: 2, updatedAt: 20 },
    selectedConfigIndex: 3,
    sidebarWidth: 520,
    pinnedConversationIds: ['conv_1']
  });
  assert.deepEqual(localArea.dump(), {
    apiConfigs_backup_v1: {
      version: 2,
      items: [{ id: 'new', apiKey: 'sk-new', baseUrl: 'https://new.example.com/v1' }]
    },
    image_hash_cache_v1: { keep: true }
  });
  assert.deepEqual(localStorageArea.dump(), {
    'cerebr.chat_history_panel_fullscreen_layout_v1': '{"width":800}'
  });

  assert.equal(result.domain, EXTENSION_STATE_BACKUP_DOMAIN_API);
  assert.deepEqual(result.chromeStorage.sync.writtenKeys.sort(), [
    'apiConfigs_chunks_meta',
    'selectedConfigIndex'
  ]);
});

test('parseExtensionStateBackupSnapshot 会校验域与文件结构', async () => {
  const {
    EXTENSION_STATE_BACKUP_DOMAIN_MISC,
    buildExtensionStateBackupFilename,
    parseExtensionStateBackupSnapshot
  } = await loadExtensionStateBackupModule();

  assert.equal(
    buildExtensionStateBackupFilename({
      domain: EXTENSION_STATE_BACKUP_DOMAIN_MISC,
      timestamp: new Date('2026-04-10T12:34:56Z'),
      compress: true
    }),
    'extension_state_misc_20260410_123456.json.gz'
  );

  assert.throws(() => parseExtensionStateBackupSnapshot({
    kind: 'cerebr_extension_state_backup',
    schemaVersion: 1,
    domain: 'api',
    sources: {}
  }, {
    expectedDomain: EXTENSION_STATE_BACKUP_DOMAIN_MISC
  }), /备份类型不匹配/);
});
