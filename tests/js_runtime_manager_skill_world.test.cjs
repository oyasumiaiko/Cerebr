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
  const previousOutputStore = globalThis.__cerebrJsToolOutputStore;
  const previousToolOutput = globalThis.$toolOutput;
  const previousToolOutputRefs = globalThis.$toolOutputRefs;

  try {
    global.chrome = {
      userScripts: {
        async getScripts() { return []; },
        async configureWorld() {},
        async execute(options) {
          capturedSource = options.js[0].code;
          return [{
            frameId: 0,
            documentId: 'doc-upgrade',
            result: {
              __cerebrJsRuntimeEnvelope: true,
              value: null,
              logs: [],
              error: null
            }
          }];
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
    if (previousOutputStore === undefined) delete globalThis.__cerebrJsToolOutputStore;
    else globalThis.__cerebrJsToolOutputStore = previousOutputStore;
    if (previousToolOutput === undefined) delete globalThis.$toolOutput;
    else globalThis.$toolOutput = previousToolOutput;
    if (previousToolOutputRefs === undefined) delete globalThis.$toolOutputRefs;
    else globalThis.$toolOutputRefs = previousToolOutputRefs;
  }
});

test('createJsRuntimeManager.execute 会把完整结果保存在有界 runtime store 并允许后续 JS 筛选', async () => {
  const { createJsRuntimeManager } = await loadJsRuntimeManagerModule();
  const previousChrome = global.chrome;
  const previousStore = globalThis.__cerebrJsToolOutputStore;
  const previousToolOutput = globalThis.$toolOutput;
  const previousToolOutputRefs = globalThis.$toolOutputRefs;

  try {
    delete globalThis.__cerebrJsToolOutputStore;
    delete globalThis.$toolOutput;
    delete globalThis.$toolOutputRefs;
    global.chrome = {
      userScripts: {
        async getScripts() { return []; },
        async configureWorld() {},
        async execute(options) {
          const envelope = await eval(options.js[0].code);
          return [{ frameId: 0, documentId: 'doc-saved-output', result: envelope }];
        }
      }
    };

    const manager = createJsRuntimeManager();
    const first = await manager.execute({
      tabId: 9,
      savedOutputRef: 'jsout_first',
      code: 'return Array.from({ length: 1000 }, (_, index) => ({ index, even: index % 2 === 0 }));'
    });
    assert.equal(first.items[0].savedOutputRef, 'jsout_first');
    assert.deepEqual(first.savedOutputRefs, [{
      ref: 'jsout_first',
      frameId: 0,
      documentId: 'doc-saved-output'
    }]);
    assert.equal(globalThis.$toolOutput('jsout_first').value.length, 1000);

    const second = await manager.execute({
      tabId: 9,
      savedOutputRef: 'jsout_second',
      code: `
const source = $toolOutput('jsout_first').value;
return source.filter((item) => item.even && item.index > 990).map((item) => item.index);
`
    });
    assert.deepEqual(second.value, [992, 994, 996, 998]);
    assert.deepEqual(globalThis.$toolOutputRefs().map((item) => item.ref), ['jsout_first', 'jsout_second']);

    for (let index = 3; index <= 10; index += 1) {
      await manager.execute({
        tabId: 9,
        savedOutputRef: `jsout_${index}`,
        code: `return ${index};`
      });
    }
    assert.deepEqual(
      globalThis.$toolOutputRefs().map((item) => item.ref),
      ['jsout_3', 'jsout_4', 'jsout_5', 'jsout_6', 'jsout_7', 'jsout_8', 'jsout_9', 'jsout_10']
    );
    assert.throws(() => globalThis.$toolOutput('jsout_first'), /not found or expired/);
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
    if (previousStore === undefined) delete globalThis.__cerebrJsToolOutputStore;
    else globalThis.__cerebrJsToolOutputStore = previousStore;
    if (previousToolOutput === undefined) delete globalThis.$toolOutput;
    else globalThis.$toolOutput = previousToolOutput;
    if (previousToolOutputRefs === undefined) delete globalThis.$toolOutputRefs;
    else globalThis.$toolOutputRefs = previousToolOutputRefs;
  }
});

test('createJsRuntimeManager.execute 会拒绝空 frame 结果', async () => {
  const { createJsRuntimeManager } = await loadJsRuntimeManagerModule();
  const previousChrome = global.chrome;

  try {
    global.chrome = {
      userScripts: {
        async getScripts() { return []; },
        async configureWorld() {},
        async execute() { return []; }
      }
    };
    const manager = createJsRuntimeManager();
    await assert.rejects(
      () => manager.execute({ tabId: 9, code: 'return 1;' }),
      (error) => error?.name === 'NoExecutionResultError'
    );
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
  }
});

test('createJsRuntimeManager.execute 并发执行不会改写共享 globalThis.console', async () => {
  const { createJsRuntimeManager } = await loadJsRuntimeManagerModule();
  const previousChrome = global.chrome;
  const originalConsole = globalThis.console;

  try {
    global.chrome = {
      userScripts: {
        async getScripts() { return []; },
        async configureWorld() {},
        async execute(options) {
          const envelope = await eval(options.js[0].code);
          return [{ frameId: 0, documentId: 'doc-console', result: envelope }];
        }
      }
    };
    const manager = createJsRuntimeManager();
    const [fast, slow] = await Promise.all([
      manager.execute({
        tabId: 9,
        timeoutMs: 100,
        code: `await new Promise((resolve) => setTimeout(resolve, 5)); console.log('fast'); return 'fast';`
      }),
      manager.execute({
        tabId: 9,
        timeoutMs: 100,
        code: `await new Promise((resolve) => setTimeout(resolve, 20)); console.log('slow'); return 'slow';`
      })
    ]);

    assert.equal(globalThis.console, originalConsole);
    assert.deepEqual(fast.logs.map((entry) => entry.text), ['fast']);
    assert.deepEqual(slow.logs.map((entry) => entry.text), ['slow']);
  } finally {
    if (previousChrome === undefined) delete global.chrome;
    else global.chrome = previousChrome;
    globalThis.console = originalConsole;
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
