const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadSkillRuntimeModule() {
  const filePath = path.resolve(__dirname, '../src/extension/skill_runtime.js');
  return import(pathToFileURL(filePath).href);
}

function buildSkill(name) {
  return {
    kind: 'page_runtime',
    name,
    description: `skill ${name}`,
    interface: {
      display_name: name,
      short_description: `short ${name}`
    },
    match: ['https://*.example.com/*'],
    enabled: true,
    instruction: {
      path: 'SKILL.md'
    },
    runtime: {
      entry_path: 'src/main.js'
    },
    files: [
      {
        path: 'SKILL.md',
        kind: 'instruction',
        content: `# ${name}\n\nusage`
      },
      {
        path: 'src/main.js',
        kind: 'runtime_source',
        content: `const helper = await require('./helper.js'); return { ping() { return helper.readValue(); }, label: helper.readValue() };`
      },
      {
        path: 'src/helper.js',
        kind: 'runtime_source',
        content: `module.exports = { readValue() { return "${name}"; } };`
      }
    ],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    revision: 1
  };
}

test('buildSkillDocumentRefreshSource 只清理失效 revision，不再生成 document_start runtime', async () => {
  const {
    buildSkillDocumentRefreshSource,
    buildSkillMountOnCurrentPageSource,
    buildSkillUnmountFromCurrentPageSource
  } = await loadSkillRuntimeModule();

  const refreshSource = buildSkillDocumentRefreshSource([
    buildSkill('dom-probe'),
    buildSkill('api-reader')
  ]);
  const mountSource = buildSkillMountOnCurrentPageSource(buildSkill('dom-probe'));
  const unmountSource = buildSkillUnmountFromCurrentPageSource('dom-probe');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  assert.doesNotThrow(() => new AsyncFunction(refreshSource));
  assert.doesNotThrow(() => new AsyncFunction(mountSource));
  assert.doesNotThrow(() => new AsyncFunction(unmountSource));
  assert.doesNotMatch(refreshSource, /readValue/);
  assert.match(refreshSource, /__desiredSkillRevisions/);
});

test('document refresh 保留同 revision，更新时只卸载旧实例并等待下次 $invoke', async () => {
  const {
    buildSkillDocumentRefreshSource,
    buildSkillMountOnCurrentPageSource
  } = await loadSkillRuntimeModule();
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const previousRuntime = globalThis.__cerebrSkills;
  const previousSkill = globalThis.$skill;
  const previousInvoke = globalThis.$invoke;
  const previousMethods = globalThis.$methods;

  try {
    delete globalThis.__cerebrSkills;
    delete globalThis.$skill;
    delete globalThis.$invoke;
    delete globalThis.$methods;

    const skill = buildSkill('lazy-probe');
    await new AsyncFunction(buildSkillMountOnCurrentPageSource(skill))();
    await new AsyncFunction(buildSkillDocumentRefreshSource([skill]))();
    assert.equal(globalThis.$skill('lazy-probe')?.label, 'lazy-probe');

    await new AsyncFunction(buildSkillDocumentRefreshSource([{
      ...skill,
      revision: 2,
      updated_at: '2026-01-02T00:00:00.000Z'
    }]))();
    assert.equal(globalThis.$skill('lazy-probe'), null);
  } finally {
    if (previousRuntime === undefined) delete globalThis.__cerebrSkills;
    else globalThis.__cerebrSkills = previousRuntime;
    if (previousSkill === undefined) delete globalThis.$skill;
    else globalThis.$skill = previousSkill;
    if (previousInvoke === undefined) delete globalThis.$invoke;
    else globalThis.$invoke = previousInvoke;
    if (previousMethods === undefined) delete globalThis.$methods;
    else globalThis.$methods = previousMethods;
  }
});

test('runtime bootstrap 会暴露 $skill/$invoke/$methods facade 且与内部注册表共用状态', async () => {
  const {
    buildSkillMountOnCurrentPageSource,
    buildSkillUnmountFromCurrentPageSource
  } = await loadSkillRuntimeModule();

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const previousRuntime = globalThis.__cerebrSkills;
  const previousSkill = globalThis.$skill;
  const previousInvoke = globalThis.$invoke;
  const previousMethods = globalThis.$methods;

  try {
    delete globalThis.__cerebrSkills;
    delete globalThis.$skill;
    delete globalThis.$invoke;
    delete globalThis.$methods;

    await new AsyncFunction(buildSkillMountOnCurrentPageSource(buildSkill('dom-probe')))();

    assert.equal(typeof globalThis.$skill, 'function');
    assert.equal(typeof globalThis.$invoke, 'function');
    assert.equal(typeof globalThis.$methods, 'function');
    assert.equal(globalThis.$skill('missing-skill'), null);
    assert.deepEqual(globalThis.$methods('missing-skill'), []);
    assert.equal(globalThis.$skill('dom-probe').label, 'dom-probe');
    assert.deepEqual(globalThis.$methods('dom-probe'), ['ping']);
    assert.equal(await globalThis.$invoke('dom-probe', 'ping'), 'dom-probe');
    await assert.rejects(
      () => globalThis.$invoke('', 'ping'),
      /non-empty skill name/
    );
    await assert.rejects(
      () => globalThis.$invoke('dom-probe', ''),
      /non-empty method name/
    );
    await assert.rejects(
      () => globalThis.$invoke('dom-probe', 'missingMethod'),
      /Mounted skill method not found: dom-probe\.missingMethod/
    );

    await new AsyncFunction(buildSkillUnmountFromCurrentPageSource('dom-probe'))();
    assert.equal(globalThis.$skill('dom-probe'), null);
    assert.deepEqual(globalThis.$methods('dom-probe'), []);
  } finally {
    if (previousRuntime === undefined) delete globalThis.__cerebrSkills;
    else globalThis.__cerebrSkills = previousRuntime;
    if (previousSkill === undefined) delete globalThis.$skill;
    else globalThis.$skill = previousSkill;
    if (previousInvoke === undefined) delete globalThis.$invoke;
    else globalThis.$invoke = previousInvoke;
    if (previousMethods === undefined) delete globalThis.$methods;
    else globalThis.$methods = previousMethods;
  }
});

test('$invoke 会按名称自动挂载缺失 skill、合并并发请求且不重跑业务异常', async () => {
  const {
    CEREBR_SKILL_AUTO_MOUNT_MESSAGE_TYPE,
    buildSkillMountOnCurrentPageSource,
    buildSkillUnmountFromCurrentPageSource
  } = await loadSkillRuntimeModule();
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const previousRuntime = globalThis.__cerebrSkills;
  const previousSkill = globalThis.$skill;
  const previousInvoke = globalThis.$invoke;
  const previousMethods = globalThis.$methods;
  const previousChrome = globalThis.chrome;

  try {
    delete globalThis.__cerebrSkills;
    delete globalThis.$skill;
    delete globalThis.$invoke;
    delete globalThis.$methods;

    const skill = buildSkill('auto-probe');
    await new AsyncFunction(buildSkillMountOnCurrentPageSource(skill))();
    await new AsyncFunction(buildSkillUnmountFromCurrentPageSource(skill.name))();

    let autoMountCalls = 0;
    globalThis.chrome = {
      runtime: {
        async sendMessage(message) {
          autoMountCalls += 1;
          assert.deepEqual(message, {
            type: CEREBR_SKILL_AUTO_MOUNT_MESSAGE_TYPE,
            skillName: 'auto-probe'
          });
          await new Promise((resolve) => setImmediate(resolve));
          await new AsyncFunction(buildSkillMountOnCurrentPageSource(skill))();
          return { ok: true };
        }
      }
    };

    const values = await Promise.all([
      globalThis.$invoke('auto-probe', 'ping'),
      globalThis.$invoke('auto-probe', 'ping')
    ]);
    assert.deepEqual(values, ['auto-probe', 'auto-probe']);
    assert.equal(autoMountCalls, 1);

    await assert.rejects(
      () => globalThis.$invoke('auto-probe', 'missingMethod'),
      /Mounted skill method not found: auto-probe\.missingMethod/
    );
    assert.equal(autoMountCalls, 1);

    await new AsyncFunction(buildSkillUnmountFromCurrentPageSource(skill.name))();
    globalThis.chrome.runtime.sendMessage = async () => {
      autoMountCalls += 1;
      return { ok: false, error: 'URL 不匹配' };
    };
    await assert.rejects(
      () => globalThis.$invoke('auto-probe', 'ping'),
      (error) => error?.name === 'SkillAutoMountError' && /URL 不匹配/.test(error.message)
    );
    assert.equal(autoMountCalls, 2);

    globalThis.chrome.runtime.sendMessage = async () => {
      autoMountCalls += 1;
      throw new Error('message channel closed');
    };
    await assert.rejects(
      () => globalThis.$invoke('auto-probe', 'ping'),
      (error) => error?.name === 'SkillAutoMountError' && /message channel closed/.test(error.message)
    );
    assert.equal(autoMountCalls, 3);
  } finally {
    if (previousRuntime === undefined) delete globalThis.__cerebrSkills;
    else globalThis.__cerebrSkills = previousRuntime;
    if (previousSkill === undefined) delete globalThis.$skill;
    else globalThis.$skill = previousSkill;
    if (previousInvoke === undefined) delete globalThis.$invoke;
    else globalThis.$invoke = previousInvoke;
    if (previousMethods === undefined) delete globalThis.$methods;
    else globalThis.$methods = previousMethods;
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});
