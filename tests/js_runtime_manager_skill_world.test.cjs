const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadJsRuntimeManagerModule() {
  const filePath = path.resolve(__dirname, '../src/extension/js_runtime_manager.js');
  return import(pathToFileURL(filePath).href);
}

async function loadSkillRuntimeModule() {
  const filePath = path.resolve(__dirname, '../src/extension/skill_runtime.js');
  return import(pathToFileURL(filePath).href);
}

test('createJsRuntimeManager.execute 会在共享 skill worldId 下运行 userScripts.execute', async () => {
  const { createJsRuntimeManager } = await loadJsRuntimeManagerModule();
  const { CEREBR_SKILL_WORLD_ID } = await loadSkillRuntimeModule();

  let capturedExecuteOptions = null;
  const configuredWorlds = [];
  global.chrome = {
    userScripts: {
      async getScripts() { return []; },
      async configureWorld(options) { configuredWorlds.push(options); },
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
    timeoutMs: 45000,
    documentIds: ['doc-target'],
    frameIds: [3],
    injectImmediately: true
  });

  assert.equal(result.ok, true);
  assert.deepEqual(configuredWorlds, [{ worldId: CEREBR_SKILL_WORLD_ID, messaging: true }]);
  assert.equal(capturedExecuteOptions.world, 'USER_SCRIPT');
  assert.equal(capturedExecuteOptions.worldId, CEREBR_SKILL_WORLD_ID);
  assert.equal(capturedExecuteOptions.target.tabId, 9);
  assert.deepEqual(capturedExecuteOptions.target.documentIds, ['doc-target']);
  assert.equal(capturedExecuteOptions.target.frameIds, undefined);
  assert.match(capturedExecuteOptions.js[0].code, /const __cerebrTimeoutMs = 45000;/);
  assert.match(capturedExecuteOptions.js[0].code, /const __cerebrEnsureSkillRuntime/);

  delete global.chrome;
});

test('createJsRuntimeManager.execute 会在用户代码前升级已打开页面中的旧 skill runtime', async () => {
  const { createJsRuntimeManager } = await loadJsRuntimeManagerModule();
  let capturedSource = '';
  const previousChrome = global.chrome;
  const previousRuntime = globalThis.__cerebrSkills;
  const previousInvoke = globalThis.$invoke;
  const previousSkill = globalThis.$skill;
  const previousMethods = globalThis.$methods;

  try {
    global.chrome = {
      userScripts: {
        async getScripts() { return []; },
        async configureWorld() {},
        async execute(options) {
          capturedSource = options.js[0].code;
          return [];
        }
      }
    };
    const legacyInvoke = async () => 'legacy';
    globalThis.__cerebrSkills = {
      __cerebrRuntime: true,
      skills: Object.create(null),
      skillMeta: Object.create(null)
    };
    globalThis.$invoke = legacyInvoke;

    const manager = createJsRuntimeManager();
    await manager.execute({
      tabId: 9,
      code: 'return typeof globalThis.__cerebrSkills.ensureMounted;',
      timeoutMs: 10
    });
    const envelope = await eval(capturedSource);

    assert.equal(envelope.value, 'function');
    assert.equal(typeof globalThis.__cerebrSkills.ensureMounted, 'function');
    assert.notEqual(globalThis.$invoke, legacyInvoke);
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
    if (previousRuntime === undefined) delete globalThis.__cerebrSkills;
    else globalThis.__cerebrSkills = previousRuntime;
    if (previousInvoke === undefined) delete globalThis.$invoke;
    else globalThis.$invoke = previousInvoke;
    if (previousSkill === undefined) delete globalThis.$skill;
    else globalThis.$skill = previousSkill;
    if (previousMethods === undefined) delete globalThis.$methods;
    else globalThis.$methods = previousMethods;
  }
});

test('createJsRuntimeManager.execute 超时时会通过词法 signal 通知协作式取消', async () => {
  const { createJsRuntimeManager } = await loadJsRuntimeManagerModule();
  const previousChrome = global.chrome;

  try {
    global.chrome = {
      userScripts: {
        async getScripts() { return []; },
        async configureWorld() {},
        async execute(options) {
          const envelope = await eval(options.js[0].code);
          return [{
            frameId: 0,
            documentId: 'doc-timeout',
            result: envelope
          }];
        }
      }
    };

    const manager = createJsRuntimeManager();
    const result = await manager.execute({
      tabId: 9,
      timeoutMs: 10,
      code: `
signal.addEventListener('abort', () => console.log('signal-aborted:' + signal.aborted), { once: true });
await new Promise(() => {});
`
    });

    assert.equal(result.ok, false);
    assert.match(result.items[0].error.message, /执行超时（10ms）/);
    assert.equal(result.logs.some((entry) => entry.text === 'signal-aborted:true'), true);
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
  }
});

test('createJsRuntimeManager.abort 会在同一 worldId 下发送 executionId 中止脚本', async () => {
  const { createJsRuntimeManager } = await loadJsRuntimeManagerModule();
  const { CEREBR_SKILL_WORLD_ID } = await loadSkillRuntimeModule();

  let capturedAbortOptions = null;
  global.chrome = {
    userScripts: {
      async getScripts() { return []; },
      async configureWorld() {},
      async execute(options) {
        capturedAbortOptions = options;
        return [];
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
  const result = await manager.abort({
    tabId: 9,
    executionId: 'jsrt_abort_demo',
    frameIds: [3]
  });

  assert.equal(result.ok, true);
  assert.equal(capturedAbortOptions.world, 'USER_SCRIPT');
  assert.equal(capturedAbortOptions.worldId, CEREBR_SKILL_WORLD_ID);
  assert.deepEqual(capturedAbortOptions.target.frameIds, [3]);
  assert.match(capturedAbortOptions.js[0].code, /jsrt_abort_demo/);
  assert.match(capturedAbortOptions.js[0].code, /__cerebrJsRuntimeAbortRegistry/);

  delete global.chrome;
});
