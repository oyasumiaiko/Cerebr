const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadMicroSkillManagerModule() {
  const filePath = path.resolve(__dirname, '../src/extension/micro_skill_manager.js');
  return import(pathToFileURL(filePath).href);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createMockStorageArea(initial = {}) {
  let store = clone(initial);
  return {
    async get(keys) {
      if (Array.isArray(keys)) {
        const result = {};
        for (const key of keys) {
          if (Object.prototype.hasOwnProperty.call(store, key)) {
            result[key] = clone(store[key]);
          }
        }
        return result;
      }
      return clone(store);
    },
    async set(payload) {
      store = { ...store, ...clone(payload) };
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach((key) => delete store[key]);
    }
  };
}

function buildSkillInput(name = 'dom-probe') {
  return {
    name,
    description: '读取页面标题和链接',
    interface: {
      display_name: 'DOM Probe',
      short_description: '读取当前页面标题和 URL',
      default_prompt: 'Read the current page title and URL.'
    },
    match: ['https://*.example.com/*'],
    details: {
      usage: '在需要读取页面基础信息时使用。'
    },
    source: {
      code: 'return { read() { return { title: document.title, href: location.href }; } };'
    }
  };
}

test('create/update/delete/enable/disable 会驱动 register/update/unregister 与当前文档 refresh', async () => {
  const { createMicroSkillManager } = await loadMicroSkillManagerModule();

  const calls = {
    register: [],
    update: [],
    unregister: [],
    execute: []
  };
  const manager = createMicroSkillManager({
    storageArea: createMockStorageArea(),
    userScriptsApi: {
      async getScripts() { return []; },
      async register(definitions) { calls.register.push(clone(definitions)); },
      async update(definitions) { calls.update.push(clone(definitions)); },
      async unregister(payload) { calls.unregister.push(clone(payload)); }
    },
    tabsApi: {
      async get(tabId) {
        return {
          id: tabId,
          url: 'https://app.example.com/path',
          title: 'Example'
        };
      }
    },
    jsRuntimeManager: {
      async execute(request) {
        calls.execute.push(clone(request));
        return {
          ok: true,
          tabId: request.tabId,
          value: { mounted: true },
          logs: [],
          items: []
        };
      }
    }
  });

  const created = await manager.executeRegistryAction({
    action: 'create',
    skill: buildSkillInput()
  }, { tabId: 11 });
  assert.equal(created.ok, true);
  assert.equal(calls.register.length, 1);
  assert.equal(calls.execute.length, 1);

  const updated = await manager.executeRegistryAction({
    action: 'update',
    skill: {
      ...buildSkillInput(),
      details: { usage: '更新后的 usage' },
      source: { code: 'return { read() { return document.title; } };' }
    }
  }, { tabId: 11 });
  assert.equal(updated.ok, true);
  assert.equal(calls.update.length, 1);
  assert.equal(calls.execute.length, 2);

  const disabled = await manager.executeRegistryAction({
    action: 'disable',
    skill_name: 'dom-probe'
  }, { tabId: 11 });
  assert.equal(disabled.ok, true);
  assert.equal(calls.unregister.length, 1);
  assert.equal(calls.execute.length, 3);

  const enabled = await manager.executeRegistryAction({
    action: 'enable',
    skill_name: 'dom-probe'
  }, { tabId: 11 });
  assert.equal(enabled.ok, true);
  assert.equal(calls.register.length, 2);
  assert.equal(calls.execute.length, 4);

  const removed = await manager.executeRegistryAction({
    action: 'delete',
    skill_name: 'dom-probe'
  }, { tabId: 11 });
  assert.equal(removed.ok, true);
  assert.equal(calls.unregister.length, 2);
  assert.equal(calls.execute.length, 5);
});

test('reconcileRegisteredSkills 会对现有动态脚本做 register/update/unregister 分流', async () => {
  const { MICRO_SKILL_REGISTRY_STORAGE_KEY } = await import(pathToFileURL(path.resolve(__dirname, '../src/agent_tools/micro_skill_registry_tool.js')).href);
  const { createMicroSkillManager } = await loadMicroSkillManagerModule();

  const calls = {
    register: [],
    update: [],
    unregister: []
  };
  const storageArea = createMockStorageArea({
    [MICRO_SKILL_REGISTRY_STORAGE_KEY]: {
      version: 1,
      skills_by_name: {
        'dom-probe': {
          ...buildSkillInput('dom-probe'),
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
          revision: 1
        },
        'api-reader': {
          ...buildSkillInput('api-reader'),
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
          revision: 1
        }
      }
    }
  });

  const manager = createMicroSkillManager({
    storageArea,
    userScriptsApi: {
      async getScripts() {
        return [
          { id: 'cerebr-micro-skill--dom-probe' },
          { id: 'cerebr-micro-skill--stale-old-skill' }
        ];
      },
      async register(definitions) { calls.register.push(clone(definitions)); },
      async update(definitions) { calls.update.push(clone(definitions)); },
      async unregister(payload) { calls.unregister.push(clone(payload)); }
    },
    tabsApi: {
      async get() {
        return { url: 'https://app.example.com/path', title: 'Example' };
      }
    },
    jsRuntimeManager: {
      async execute() {
        return { ok: true, tabId: 1, value: null, logs: [], items: [] };
      }
    }
  });

  const result = await manager.reconcileRegisteredSkills();
  assert.equal(result.ok, true);
  assert.equal(calls.register.length, 1);
  assert.equal(calls.update.length, 1);
  assert.equal(calls.unregister.length, 1);
  assert.deepEqual(calls.unregister[0], {
    ids: ['cerebr-micro-skill--stale-old-skill']
  });
});

test('listMatchingSkillSummariesForTab 只返回当前 URL 命中的轻量摘要', async () => {
  const { MICRO_SKILL_REGISTRY_STORAGE_KEY } = await import(pathToFileURL(path.resolve(__dirname, '../src/agent_tools/micro_skill_registry_tool.js')).href);
  const { createMicroSkillManager } = await loadMicroSkillManagerModule();

  const storageArea = createMockStorageArea({
    [MICRO_SKILL_REGISTRY_STORAGE_KEY]: {
      version: 1,
      skills_by_name: {
        'dom-probe': {
          ...buildSkillInput('dom-probe'),
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
          revision: 1
        },
        'file-only': {
          ...buildSkillInput('file-only'),
          match: ['file:///*'],
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
          revision: 1
        }
      }
    }
  });

  const manager = createMicroSkillManager({
    storageArea,
    userScriptsApi: {
      async getScripts() { return []; },
      async register() {},
      async update() {},
      async unregister() {}
    },
    tabsApi: {
      async get() {
        return {
          url: 'https://app.example.com/path',
          title: 'Example'
        };
      }
    },
    jsRuntimeManager: {
      async execute() {
        return { ok: true, tabId: 1, value: null, logs: [], items: [] };
      }
    }
  });

  const result = await manager.listMatchingSkillSummariesForTab(7);
  assert.equal(result.ok, true);
  assert.equal(result.total_skills, 1);
  assert.equal(result.skills[0].name, 'dom-probe');
  assert.ok(result.skills[0].mount_surface);
});
