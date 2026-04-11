const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadJsRuntimeScriptRegistryToolModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/js_runtime_script_registry_tool.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
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
      if (typeof keys === 'string') {
        return Object.prototype.hasOwnProperty.call(store, keys)
          ? { [keys]: clone(store[keys]) }
          : {};
      }
      if (keys && typeof keys === 'object') {
        return clone(store);
      }
      return clone(store);
    },
    async set(payload) {
      store = { ...store, ...clone(payload) };
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) {
        delete store[key];
      }
    },
    dump() {
      return clone(store);
    }
  };
}

test('normalizeJsRuntimeScriptRegistryArguments 支持 save + refresh 参数并校验必填字段', async () => {
  const { normalizeJsRuntimeScriptRegistryArguments } = await loadJsRuntimeScriptRegistryToolModule();

  const normalized = normalizeJsRuntimeScriptRegistryArguments({
    action: 'save',
    script: {
      id: 'helper_bootstrap',
      name: 'Helper Bootstrap',
      description: 'bootstrap helpers',
      scope: 'https://example.com/*',
      enabled: true,
      code: 'globalThis.__x = 1;'
    },
    refresh_after_save: true,
    frame_ids: [0, '2'],
    inject_immediately: true,
    runtime_environment: 'bound_host_page'
  });

  assert.deepEqual(normalized, {
    action: 'save',
    scriptId: null,
    script: {
      id: 'helper_bootstrap',
      name: 'Helper Bootstrap',
      description: 'bootstrap helpers',
      scope: 'https://example.com/*',
      enabled: true,
      code: 'globalThis.__x = 1;'
    },
    refreshAfterSave: true,
    frameIds: [0, 2],
    injectImmediately: true,
    runtimeEnvironment: 'bound_host_page'
  });

  assert.throws(
    () => normalizeJsRuntimeScriptRegistryArguments({ action: 'refresh' }),
    /script_id 不能为空/
  );
  assert.throws(
    () => normalizeJsRuntimeScriptRegistryArguments({ action: 'save', script: { id: 'x', code: '   ' } }),
    /code 不能为空/
  );
});

test('executeJsRuntimeScriptRegistryTool 可以 save/list/get/delete 并维护 revision', async () => {
  const {
    JS_RUNTIME_SCRIPT_REGISTRY_STORAGE_KEY,
    executeJsRuntimeScriptRegistryTool
  } = await loadJsRuntimeScriptRegistryToolModule();

  const storageArea = createMockStorageArea();
  global.chrome = { storage: { local: storageArea } };

  const savedFirst = await executeJsRuntimeScriptRegistryTool({
    action: 'save',
    script: {
      id: 'dom_probe',
      name: 'DOM Probe',
      description: 'probe dom',
      scope: 'https://example.com/*',
      code: 'return document.title;'
    }
  });
  assert.equal(savedFirst.ok, true);
  assert.equal(savedFirst.script.id, 'dom_probe');
  assert.equal(savedFirst.script.revision, 1);

  const savedSecond = await executeJsRuntimeScriptRegistryTool({
    action: 'save',
    script: {
      id: 'dom_probe',
      name: 'DOM Probe V2',
      description: 'probe dom again',
      scope: 'https://example.com/*',
      code: 'return location.href;'
    }
  });
  assert.equal(savedSecond.script.revision, 2);
  assert.equal(savedSecond.script.name, 'DOM Probe V2');

  const listed = await executeJsRuntimeScriptRegistryTool({ action: 'list' });
  assert.equal(listed.ok, true);
  assert.equal(listed.total_scripts, 1);
  assert.equal(listed.scripts[0].id, 'dom_probe');
  assert.equal(listed.scripts[0].code_length, 'return location.href;'.length);

  const fetched = await executeJsRuntimeScriptRegistryTool({
    action: 'get',
    script_id: 'dom_probe'
  });
  assert.equal(fetched.ok, true);
  assert.equal(fetched.script.code, 'return location.href;');
  assert.equal(fetched.script.revision, 2);

  const removed = await executeJsRuntimeScriptRegistryTool({
    action: 'delete',
    script_id: 'dom_probe'
  });
  assert.equal(removed.ok, true);
  assert.equal(removed.deleted, true);
  assert.equal(removed.script.id, 'dom_probe');

  const snapshot = storageArea.dump();
  assert.deepEqual(snapshot[JS_RUNTIME_SCRIPT_REGISTRY_STORAGE_KEY], {
    version: 1,
    scripts_by_id: {}
  });

  delete global.chrome;
});

test('executeJsRuntimeScriptRegistryTool 的 refresh 会调用 executeJsRuntime 并透传执行选项', async () => {
  const { executeJsRuntimeScriptRegistryTool } = await loadJsRuntimeScriptRegistryToolModule();

  const storageArea = createMockStorageArea();
  global.chrome = { storage: { local: storageArea } };

  await executeJsRuntimeScriptRegistryTool({
    action: 'save',
    script: {
      id: 'helper_bootstrap',
      name: 'Helper Bootstrap',
      code: 'globalThis.__helperReady = true; return "ready";'
    }
  });

  let receivedCode = null;
  let receivedOptions = null;
  const refreshed = await executeJsRuntimeScriptRegistryTool({
    action: 'refresh',
    script_id: 'helper_bootstrap',
    frame_ids: [3],
    inject_immediately: true,
    runtime_environment: 'isolated_sandbox_iframe'
  }, {
    executeJsRuntime: async (code, options) => {
      receivedCode = code;
      receivedOptions = clone(options);
      return {
        success: true,
        ok: true,
        tabId: 99,
        value: 'ready',
        logs: [{ level: 'info', text: 'bootstrapped' }],
        items: []
      };
    }
  });

  assert.equal(receivedCode, 'globalThis.__helperReady = true; return "ready";');
  assert.deepEqual(receivedOptions, {
    frameIds: [3],
    injectImmediately: true,
    runtimeEnvironment: 'isolated_sandbox_iframe'
  });
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.refresh_result.ok, true);
  assert.equal(refreshed.refresh_result.tab_id, 99);
  assert.equal(refreshed.refresh_result.value, 'ready');

  delete global.chrome;
});
