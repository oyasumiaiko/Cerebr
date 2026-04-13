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
        content: `const helper = await require('./helper.js'); return { ping() { return helper.readValue(); } };`
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

test('buildMicroSkillDocumentRefreshSource 与 buildRegisteredMicroSkillUserScript 生成可编译源码', async () => {
  const {
    buildMicroSkillDocumentRefreshSource,
    buildMicroSkillMountOnCurrentPageSource,
    buildMicroSkillUnmountFromCurrentPageSource,
    buildRegisteredMicroSkillUserScript
  } = await loadMicroSkillRuntimeModule();

  const refreshSource = buildMicroSkillDocumentRefreshSource([
    buildSkill('dom-probe'),
    buildSkill('api-reader')
  ]);
  const mountSource = buildMicroSkillMountOnCurrentPageSource(buildSkill('dom-probe'));
  const unmountSource = buildMicroSkillUnmountFromCurrentPageSource('dom-probe');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  assert.doesNotThrow(() => new AsyncFunction(refreshSource));
  assert.doesNotThrow(() => new AsyncFunction(mountSource));
  assert.doesNotThrow(() => new AsyncFunction(unmountSource));

  const registered = buildRegisteredMicroSkillUserScript(buildSkill('dom-probe'));
  assert.equal(registered.world, 'USER_SCRIPT');
  assert.equal(registered.js.length, 1);
  assert.doesNotThrow(() => new Function(registered.js[0].code));
});
