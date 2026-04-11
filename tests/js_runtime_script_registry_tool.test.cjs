const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadMicroSkillRegistryToolModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/micro_skill_registry_tool.js');
  return import(`${pathToFileURL(filePath).href}?test=${Date.now()}`);
}

async function loadLegacyCompatModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/js_runtime_script_registry_tool.js');
  return import(pathToFileURL(filePath).href);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createMockStore(initialPackages = []) {
  const packagesByName = new Map(
    (Array.isArray(initialPackages) ? initialPackages : [])
      .map((item) => [item.name, clone(item)])
  );

  return {
    async listManifests() {
      return Array.from(packagesByName.values()).map((pkg) => {
        const { files, ...manifest } = clone(pkg);
        return {
          ...manifest,
          files_meta: Array.isArray(files)
            ? files.map((file) => ({ path: file.path, kind: file.kind }))
            : []
        };
      });
    },
    async getManifest(skillName) {
      const pkg = packagesByName.get(String(skillName || ''));
      if (!pkg) return null;
      const { files, ...manifest } = clone(pkg);
      return {
        ...manifest,
        files_meta: Array.isArray(files)
          ? files.map((file) => ({ path: file.path, kind: file.kind }))
          : []
      };
    },
    async getPackage(skillName) {
      return clone(packagesByName.get(String(skillName || '')) || null);
    },
    async savePackage(skillPackage) {
      packagesByName.set(skillPackage.name, clone(skillPackage));
      return clone(skillPackage);
    },
    async deletePackage(skillName) {
      packagesByName.delete(String(skillName || ''));
      return { ok: true };
    },
    dump() {
      return Array.from(packagesByName.values()).map(clone);
    }
  };
}

function buildSkillInput(name = 'dom-probe') {
  return {
    name,
    description: '读取页面标题和链接',
    interface: {
      display_name: 'DOM Probe',
      short_description: 'Read current page title, URL, and base page summary safely',
      icon_small: 'assets/icon-small.svg',
      icon_large: 'assets/icon-large.svg',
      brand_color: '#3B82F6',
      default_prompt: `Use $${name} to read the current page title and URL.`
    },
    dependencies: {
      tools: [{
        type: 'mcp',
        value: 'github',
        description: 'GitHub MCP server',
        transport: 'streamable_http',
        url: 'https://api.githubcopilot.com/mcp/'
      }]
    },
    policy: {
      allow_implicit_invocation: true
    },
    match: ['https://*.example.com/*'],
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
        content: [
          '---',
          `name: ${name}`,
          'description: 读取页面标题和链接',
          'metadata:',
          '  short-description: Read current page title, URL, and base page summary safely',
          '---',
          '',
          '# DOM Probe',
          '',
          '在需要读取页面基础信息时使用。'
        ].join('\n')
      },
      {
        path: 'src/main.js',
        kind: 'runtime_source',
        content: 'const helpers = await require("./helpers/dom.js"); return { read() { return { title: helpers.readTitle(), href: location.href }; } };'
      },
      {
        path: 'src/helpers/dom.js',
        kind: 'runtime_source',
        content: 'module.exports = { readTitle() { return document.title; } };'
      },
      {
        path: 'assets/icon-small.svg',
        kind: 'asset',
        content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#3B82F6"/></svg>'
      },
      {
        path: 'assets/icon-large.svg',
        kind: 'asset',
        content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#3B82F6"/></svg>'
      }
    ]
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

test('buildStoredMicroSkillRecord / saveStoredMicroSkillPackage / getStoredMicroSkillPackage 保持 package 结构与渐进式披露边界', async () => {
  const {
    buildMicroSkillDetail,
    buildMicroSkillPackagePayload,
    buildMicroSkillSummary,
    buildStoredMicroSkillRecord,
    getStoredMicroSkillPackage,
    saveStoredMicroSkillPackage
  } = await loadMicroSkillRegistryToolModule();

  const store = createMockStore();
  const created = buildStoredMicroSkillRecord(buildSkillInput());

  assert.equal(created.revision, 1);
  assert.equal(created.interface.display_name, 'DOM Probe');
  assert.equal(created.instruction.path, 'SKILL.md');
  assert.equal(created.runtime.entry_path, 'src/main.js');
  assert.equal(created.files.length, 5);

  await saveStoredMicroSkillPackage(created, store);
  const loaded = await getStoredMicroSkillPackage('dom-probe', store);
  assert.equal(loaded.name, 'dom-probe');

  const summary = buildMicroSkillSummary(loaded);
  assert.equal(summary.interface.short_description, 'Read current page title, URL, and base page summary safely');
  assert.equal(summary.files.total_count, 5);

  const detail = buildMicroSkillDetail(loaded);
  assert.equal(detail.instruction.path, 'SKILL.md');
  assert.match(detail.instruction.content, /DOM Probe/);
  assert.equal(detail.files.files[0].content, undefined);

  const source = buildMicroSkillPackagePayload(loaded);
  assert.equal(source.runtime.entry_path, 'src/main.js');
  assert.equal(source.files.files.length, 5);
  assert.match(source.files.files[2].content, /document\.title/);

  assert.equal(store.dump().length, 1);
});

test('normalizeMicroSkillRegistryToolArguments 会收敛为新的 package/file action 集', async () => {
  const {
    MICRO_SKILL_REGISTRY_TOOL_NAME,
    buildMicroSkillRegistryFunctionToolDefinition,
    normalizeMicroSkillRegistryToolArguments
  } = await loadMicroSkillRegistryToolModule();

  const definition = buildMicroSkillRegistryFunctionToolDefinition();
  assert.equal(definition.name, MICRO_SKILL_REGISTRY_TOOL_NAME);

  const normalizedCreate = normalizeMicroSkillRegistryToolArguments({
    action: 'create',
    skill: buildSkillInput()
  });
  assert.equal(normalizedCreate.action, 'create');
  assert.equal(normalizedCreate.skill.name, 'dom-probe');
  assert.equal(normalizedCreate.skill.instruction.path, 'SKILL.md');
  assert.equal(normalizedCreate.skill.files.length, 5);

  const normalizedReadFile = normalizeMicroSkillRegistryToolArguments({
    action: 'read_file',
    skill_name: 'dom-probe',
    file_path: './src/helpers/dom.js'
  });
  assert.deepEqual(normalizedReadFile, {
    action: 'read_file',
    skill_name: 'dom-probe',
    skill: null,
    file_path: 'src/helpers/dom.js',
    file: null,
    set_as_instruction: false,
    set_as_runtime_entry: false,
    next_instruction_path: null,
    next_runtime_entry_path: null
  });

  const normalizedWriteFile = normalizeMicroSkillRegistryToolArguments({
    action: 'write_file',
    skill_name: 'dom-probe',
    set_as_runtime_entry: true,
    file: {
      path: 'src/runtime/new-main.js',
      kind: 'runtime_source',
      content: 'module.exports = { read() { return document.title; } };'
    }
  });
  assert.equal(normalizedWriteFile.action, 'write_file');
  assert.equal(normalizedWriteFile.file.path, 'src/runtime/new-main.js');
  assert.equal(normalizedWriteFile.set_as_runtime_entry, true);

  const normalizedLegacy = normalizeMicroSkillRegistryToolArguments({
    action: 'read_source_file',
    skill_name: 'dom-probe',
    file_path: 'src/helpers/dom.js'
  });
  assert.deepEqual(normalizedLegacy, {
    action: 'read_file',
    skill_name: 'dom-probe',
    skill: null,
    file_path: 'src/helpers/dom.js',
    file: null,
    set_as_instruction: false,
    set_as_runtime_entry: false,
    next_instruction_path: null,
    next_runtime_entry_path: null
  });

  const normalizedValidate = normalizeMicroSkillRegistryToolArguments({
    action: 'validate',
    skill_name: 'dom-probe'
  });
  assert.equal(normalizedValidate.action, 'validate');
  assert.equal(normalizedValidate.skill_name, 'dom-probe');
});

test('validateMicroSkillRecord 会校验 openai interface 语义、asset 路径与 SKILL.md frontmatter', async () => {
  const {
    validateMicroSkillRecord
  } = await loadMicroSkillRegistryToolModule();

  const validResult = validateMicroSkillRecord(buildSkillInput('dom-probe'));
  assert.equal(validResult.valid, true);
  assert.equal(validResult.errors.length, 0);
  assert.equal(validResult.warnings.length, 0);

  const invalid = buildSkillInput('broken-skill');
  invalid.interface.short_description = 'too short';
  invalid.interface.default_prompt = 'Read the page without naming the skill.';
  invalid.interface.icon_small = 'src/main.js';
  invalid.policy.allow_implicit_invocation = 'yes';
  invalid.files[0].content = invalid.files[0].content.replace('name: broken-skill', 'name: other-skill');

  const invalidResult = validateMicroSkillRecord(invalid);
  assert.equal(invalidResult.valid, false);
  assert.match(JSON.stringify(invalidResult.errors), /short_description/);
  assert.match(JSON.stringify(invalidResult.errors), /default_prompt/);
  assert.match(JSON.stringify(invalidResult.errors), /icon_small/);
  assert.match(JSON.stringify(invalidResult.errors), /frontmatter/);
});

test('内置 skill-creator 提供模板文件与校验参考', async () => {
  const {
    getBuiltinMicroSkillRecord
  } = await loadMicroSkillRegistryToolModule();

  const record = getBuiltinMicroSkillRecord('skill-creator');
  assert.ok(record);
  const filePaths = record.files.map((file) => file.path);
  assert.ok(filePaths.includes('references/openai-interface.md'));
  assert.ok(filePaths.includes('references/testing-requirements.md'));
  assert.ok(filePaths.includes('template/SKILL.md'));
  assert.ok(filePaths.includes('template/src/main.js'));
  assert.ok(filePaths.includes('template/assets/icon-small.svg'));
  assert.match(record.interface.default_prompt, /\$skill-creator/);
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
