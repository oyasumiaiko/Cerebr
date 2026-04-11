const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadMicroSkillRuntimeModule() {
  const filePath = path.resolve(__dirname, '../src/extension/micro_skill_runtime.js');
  return import(pathToFileURL(filePath).href);
}

function buildSkill(name) {
  return {
    name,
    description: `skill ${name}`,
    interface: {
      display_name: name,
      short_description: `short ${name}`
    },
    match: ['https://*.example.com/*'],
    enabled: true,
    details: {
      usage: `usage ${name}`,
      mount_contract: 'mount contract'
    },
    source: {
      code: `return { ping() { return "${name}"; } };`
    },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    revision: 1
  };
}

test('buildMicroSkillDocumentRefreshSource 与 buildRegisteredMicroSkillUserScript 生成可编译源码', async () => {
  const {
    buildMicroSkillDocumentRefreshSource,
    buildRegisteredMicroSkillUserScript
  } = await loadMicroSkillRuntimeModule();

  const refreshSource = buildMicroSkillDocumentRefreshSource([
    buildSkill('dom-probe'),
    buildSkill('api-reader')
  ]);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  assert.doesNotThrow(() => new AsyncFunction(refreshSource));

  const registered = buildRegisteredMicroSkillUserScript(buildSkill('dom-probe'));
  assert.equal(registered.world, 'USER_SCRIPT');
  assert.equal(registered.js.length, 1);
  assert.doesNotThrow(() => new Function(registered.js[0].code));
});
