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

test('buildSkillDocumentRefreshSource 与 buildRegisteredSkillUserScript 生成可编译源码', async () => {
  const {
    buildSkillDocumentRefreshSource,
    buildSkillMountOnCurrentPageSource,
    buildSkillUnmountFromCurrentPageSource,
    buildRegisteredSkillUserScript
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

  const registered = buildRegisteredSkillUserScript(buildSkill('dom-probe'));
  assert.equal(registered.world, 'USER_SCRIPT');
  assert.equal(registered.js.length, 1);
  assert.doesNotThrow(() => new Function(registered.js[0].code));
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
