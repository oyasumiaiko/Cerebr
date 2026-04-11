const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadJsRuntimeManagerModule() {
  const filePath = path.resolve(__dirname, '../src/extension/js_runtime_manager.js');
  return import(pathToFileURL(filePath).href);
}

async function loadMicroSkillRuntimeModule() {
  const filePath = path.resolve(__dirname, '../src/extension/micro_skill_runtime.js');
  return import(pathToFileURL(filePath).href);
}

test('createJsRuntimeManager.execute 会在共享 micro skill worldId 下运行 userScripts.execute', async () => {
  const { createJsRuntimeManager } = await loadJsRuntimeManagerModule();
  const { CEREBR_MICRO_SKILL_WORLD_ID } = await loadMicroSkillRuntimeModule();

  let capturedExecuteOptions = null;
  global.chrome = {
    userScripts: {
      async getScripts() { return []; },
      async execute(options) {
        capturedExecuteOptions = options;
        return [{
          frameId: 0,
          documentId: 'doc',
          result: {
            __cerebrJsRuntimeEnvelope: true,
            value: 'ok',
            logs: [],
            error: null
          }
        }];
      }
    },
    tabs: {
      async get() {
        return { title: 'Example', url: 'https://example.com/' };
      }
    },
    webNavigation: {
      async getAllFrames() {
        return [{ frameId: 0, url: 'https://example.com/' }];
      }
    }
  };

  const manager = createJsRuntimeManager();
  const result = await manager.execute({
    tabId: 9,
    code: 'return "ok";',
    injectImmediately: true
  });

  assert.equal(result.ok, true);
  assert.equal(capturedExecuteOptions.world, 'USER_SCRIPT');
  assert.equal(capturedExecuteOptions.worldId, CEREBR_MICRO_SKILL_WORLD_ID);
  assert.equal(capturedExecuteOptions.target.tabId, 9);

  delete global.chrome;
});
