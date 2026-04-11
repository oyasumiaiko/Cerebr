const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadMicroSkillRegistryToolModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/micro_skill_registry_tool.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

async function loadLegacyCompatModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/js_runtime_script_registry_tool.js');
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
      list.forEach((key) => {
        delete store[key];
      });
    },
    dump() {
      return clone(store);
    }
  };
}

test('normalizeMicroSkillMatchPatterns 与 URL 匹配遵循第一阶段 Chrome/TM 风格约束', async () => {
  const {
    normalizeMicroSkillMatchPatterns,
    microSkillMatchPatternMatchesUrl
  } = await loadMicroSkillRegistryToolModule();

  assert.deepEqual(
    normalizeMicroSkillMatchPatterns(['https://*.example.com/*', 'file:///*']),
    ['https://*.example.com/*', 'file:///*']
  );

  assert.equal(
    microSkillMatchPatternMatchesUrl('https://*.example.com/*', 'https://a.example.com/path?q=1'),
    true
  );
  assert.equal(
    microSkillMatchPatternMatchesUrl('https://*.example.com/*', 'https://example.com/root'),
    true
  );
  assert.equal(
    microSkillMatchPatternMatchesUrl('*://*.example.com/*', 'http://b.example.com/path'),
    true
  );
  assert.equal(
    microSkillMatchPatternMatchesUrl('*://*.example.com/*', 'https://b.example.com/path'),
    true
  );
  assert.equal(
    microSkillMatchPatternMatchesUrl('*://*.example.com/*', 'file:///tmp/a.txt'),
    false
  );

  assert.throws(
    () => normalizeMicroSkillMatchPatterns(['https://exa*mple.com/*']),
    /不支持的 match 规则/
  );
});

test('buildStoredMicroSkillRecord / loadMicroSkillRegistrySnapshot / saveMicroSkillRegistrySnapshot 保持 revision 与渐进式字段结构', async () => {
  const {
    MICRO_SKILL_REGISTRY_STORAGE_KEY,
    buildMicroSkillDetail,
    buildMicroSkillSourcePayload,
    buildMicroSkillSummary,
    buildStoredMicroSkillRecord,
    loadMicroSkillRegistrySnapshot,
    saveMicroSkillRegistrySnapshot
  } = await loadMicroSkillRegistryToolModule();

  const storageArea = createMockStorageArea();
  const created = buildStoredMicroSkillRecord({
    name: 'dom-probe',
    description: '读取页面标题和链接',
    interface: {
      display_name: 'DOM Probe',
      short_description: '读取当前页面标题和 URL',
      default_prompt: 'Read the current page title and URL.'
    },
    match: ['https://*.example.com/*'],
    details: {
      usage: '在需要读取页面基础信息时使用。',
      mount_contract: 'Use globalThis.__cerebrMicroSkills.invoke("dom-probe.read")'
    },
    source: {
      code: 'return { read() { return { title: document.title, href: location.href }; } };'
    }
  });

  assert.equal(created.revision, 1);
  assert.equal(created.interface.display_name, 'DOM Probe');

  await saveMicroSkillRegistrySnapshot({
    version: 1,
    skills_by_name: {
      'dom-probe': created
    }
  }, storageArea);

  const snapshot = await loadMicroSkillRegistrySnapshot(storageArea);
  assert.equal(snapshot.skills_by_name['dom-probe'].name, 'dom-probe');

  const summary = buildMicroSkillSummary(snapshot.skills_by_name['dom-probe']);
  assert.equal(summary.interface.short_description, '读取当前页面标题和 URL');

  const detail = buildMicroSkillDetail(snapshot.skills_by_name['dom-probe']);
  assert.equal(detail.details.usage, '在需要读取页面基础信息时使用。');
  assert.equal(detail.source, undefined);

  const source = buildMicroSkillSourcePayload(snapshot.skills_by_name['dom-probe']);
  assert.match(source.source.code, /document\.title/);

  assert.ok(storageArea.dump()[MICRO_SKILL_REGISTRY_STORAGE_KEY]);
});

test('normalizeMicroSkillRegistryToolArguments 会收敛为新的 micro skill action 集', async () => {
  const {
    MICRO_SKILL_REGISTRY_TOOL_NAME,
    buildMicroSkillRegistryFunctionToolDefinition,
    normalizeMicroSkillRegistryToolArguments
  } = await loadMicroSkillRegistryToolModule();

  const definition = buildMicroSkillRegistryFunctionToolDefinition();
  assert.equal(definition.name, MICRO_SKILL_REGISTRY_TOOL_NAME);

  const normalizedCreate = normalizeMicroSkillRegistryToolArguments({
    action: 'create',
    skill: {
      name: 'dom-probe',
      description: '读取页面标题和链接',
      match: ['https://*.example.com/*'],
      details: {
        usage: '在需要读取页面基础信息时使用。'
      },
      source: {
        code: 'return { read() { return document.title; } };'
      }
    }
  });
  assert.equal(normalizedCreate.action, 'create');
  assert.equal(normalizedCreate.skill.name, 'dom-probe');

  const normalizedLegacy = normalizeMicroSkillRegistryToolArguments({
    action: 'get',
    script_id: 'dom-probe'
  });
  assert.deepEqual(normalizedLegacy, {
    action: 'read_detail',
    skill_name: 'dom-probe',
    skill: null
  });
});

test('旧 js_runtime_script_registry 兼容层会映射到新的 micro_skill_registry 能力', async () => {
  const legacy = await loadLegacyCompatModule();
  const modern = await loadMicroSkillRegistryToolModule();

  assert.equal(legacy.JS_RUNTIME_SCRIPT_REGISTRY_TOOL_NAME, modern.MICRO_SKILL_REGISTRY_TOOL_NAME);
  assert.equal(
    legacy.buildJsRuntimeScriptRegistryFunctionToolDefinition().name,
    modern.MICRO_SKILL_REGISTRY_TOOL_NAME
  );
});
