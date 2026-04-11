const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadMicroSkillManagerModule() {
  const filePath = path.resolve(__dirname, '../src/extension/micro_skill_manager.js');
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

test('create/update/delete/enable/disable 会驱动 register/update/unregister 与当前文档 refresh', async () => {
  const { createMicroSkillManager } = await loadMicroSkillManagerModule();

  const calls = {
    register: [],
    update: [],
    unregister: [],
    execute: []
  };
  const manager = createMicroSkillManager({
    store: createMockStore(),
    userScriptsApi: {
      async getScripts() { return []; },
      async register(definitions) { calls.register.push(clone(definitions)); },
      async update(definitions) { calls.update.push(clone(definitions)); },
      async unregister(payload) { calls.unregister.push(clone(payload)); }
    },
    tabsApi: {
      async get(tabId) {
        return {
          id: tabId,
          url: 'https://app.example.com/path',
          title: 'Example'
        };
      }
    },
    jsRuntimeManager: {
      async execute(request) {
        calls.execute.push(clone(request));
        return {
          ok: true,
          tabId: request.tabId,
          value: { mounted: true },
          logs: [],
          items: []
        };
      }
    }
  });

  const created = await manager.executeRegistryAction({
    action: 'create',
    skill: buildSkillInput()
  }, { tabId: 11 });
  assert.equal(created.ok, true);
  assert.equal(calls.register.length, 1);
  assert.equal(calls.execute.length, 1);

  const updated = await manager.executeRegistryAction({
    action: 'update',
    skill: {
      ...buildSkillInput(),
      files: [
        {
          path: 'SKILL.md',
          kind: 'instruction',
          content: [
            '---',
            'name: dom-probe',
            'description: 读取页面标题和链接',
            'metadata:',
            '  short-description: Read current page title, URL, and base page summary safely',
            '---',
            '',
            '# DOM Probe',
            '',
            '更新后的说明。'
          ].join('\n')
        },
        {
          path: 'src/main.js',
          kind: 'runtime_source',
          content: 'const helpers = await require("./helpers/dom.js"); return { read() { return helpers.readTitle(); } };'
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
    }
  }, { tabId: 11 });
  assert.equal(updated.ok, true);
  assert.equal(calls.update.length, 1);
  assert.equal(calls.execute.length, 2);

  const readFile = await manager.executeRegistryAction({
    action: 'read_file',
    skill_name: 'dom-probe',
    file_path: 'src/helpers/dom.js'
  }, { tabId: 11 });
  assert.equal(readFile.ok, true);
  assert.equal(readFile.skill.file.path, 'src/helpers/dom.js');
  assert.match(readFile.skill.file.content, /document\.title/);

  const writtenFile = await manager.executeRegistryAction({
    action: 'write_file',
    skill_name: 'dom-probe',
    file: {
      path: 'src/helpers/url.js',
      kind: 'runtime_source',
      content: 'module.exports = { readUrl() { return location.href; } };'
    }
  }, { tabId: 11 });
  assert.equal(writtenFile.ok, true);
  assert.equal(writtenFile.files.total_count, 6);
  assert.equal(calls.update.length, 2);
  assert.equal(calls.execute.length, 3);

  const deletedFile = await manager.executeRegistryAction({
    action: 'delete_file',
    skill_name: 'dom-probe',
    file_path: 'src/helpers/url.js'
  }, { tabId: 11 });
  assert.equal(deletedFile.ok, true);
  assert.equal(deletedFile.files.total_count, 5);
  assert.equal(calls.update.length, 3);
  assert.equal(calls.execute.length, 4);

  const disabled = await manager.executeRegistryAction({
    action: 'disable',
    skill_name: 'dom-probe'
  }, { tabId: 11 });
  assert.equal(disabled.ok, true);
  assert.equal(calls.unregister.length, 1);
  assert.equal(calls.execute.length, 5);

  const enabled = await manager.executeRegistryAction({
    action: 'enable',
    skill_name: 'dom-probe'
  }, { tabId: 11 });
  assert.equal(enabled.ok, true);
  assert.equal(calls.register.length, 2);
  assert.equal(calls.execute.length, 6);

  const removed = await manager.executeRegistryAction({
    action: 'delete',
    skill_name: 'dom-probe'
  }, { tabId: 11 });
  assert.equal(removed.ok, true);
  assert.equal(calls.unregister.length, 2);
  assert.equal(calls.execute.length, 7);
});

test('内置 skill-creator 会自动出现在列表中且保持只读', async () => {
  const { createMicroSkillManager } = await loadMicroSkillManagerModule();

  const manager = createMicroSkillManager({
    store: createMockStore(),
    userScriptsApi: {
      async getScripts() { return []; },
      async register() {},
      async update() {},
      async unregister() {}
    },
    tabsApi: {
      async get() {
        return {
          url: 'https://app.example.com/path',
          title: 'Example'
        };
      }
    },
    jsRuntimeManager: {
      async execute() {
        return { ok: true, tabId: 1, value: null, logs: [], items: [] };
      }
    }
  });

  const listed = await manager.executeRegistryAction({ action: 'list' });
  assert.equal(listed.ok, true);
  assert.equal(listed.skills[0].name, 'skill-creator');
  assert.equal(listed.skills[0].builtin, true);

  const detail = await manager.executeRegistryAction({
    action: 'read_detail',
    skill_name: 'skill-creator'
  });
  assert.equal(detail.ok, true);
  assert.equal(detail.skill.builtin, true);
  assert.match(detail.skill.instruction.content, /Skill Creator/);

  await assert.rejects(
    () => manager.executeRegistryAction({
      action: 'delete',
      skill_name: 'skill-creator'
    }),
    /内置只读指导 skill/
  );
});

test('reconcileRegisteredSkills 会对现有动态脚本做 register/update/unregister 分流', async () => {
  const { createMicroSkillManager } = await loadMicroSkillManagerModule();

  const calls = {
    register: [],
    update: [],
    unregister: []
  };
  const store = createMockStore([
    {
      ...buildSkillInput('dom-probe'),
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      revision: 1
    },
    {
      ...buildSkillInput('api-reader'),
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      revision: 1
    }
  ]);

  const manager = createMicroSkillManager({
    store,
    userScriptsApi: {
      async getScripts() {
        return [
          { id: 'cerebr-micro-skill--dom-probe' },
          { id: 'cerebr-micro-skill--stale-old-skill' }
        ];
      },
      async register(definitions) { calls.register.push(clone(definitions)); },
      async update(definitions) { calls.update.push(clone(definitions)); },
      async unregister(payload) { calls.unregister.push(clone(payload)); }
    },
    tabsApi: {
      async get() {
        return { url: 'https://app.example.com/path', title: 'Example' };
      }
    },
    jsRuntimeManager: {
      async execute() {
        return { ok: true, tabId: 1, value: null, logs: [], items: [] };
      }
    }
  });

  const result = await manager.reconcileRegisteredSkills();
  assert.equal(result.ok, true);
  assert.equal(calls.register.length, 1);
  assert.equal(calls.update.length, 1);
  assert.equal(calls.unregister.length, 1);
  assert.deepEqual(calls.unregister[0], {
    ids: ['cerebr-micro-skill--stale-old-skill']
  });
});

test('listMatchingSkillSummariesForTab 只返回当前 URL 命中的轻量摘要', async () => {
  const { createMicroSkillManager } = await loadMicroSkillManagerModule();

  const store = createMockStore([
    {
      ...buildSkillInput('dom-probe'),
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      revision: 1
    },
    {
      ...buildSkillInput('file-only'),
      match: ['file:///*'],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      revision: 1
    }
  ]);

  const manager = createMicroSkillManager({
    store,
    userScriptsApi: {
      async getScripts() { return []; },
      async register() {},
      async update() {},
      async unregister() {}
    },
    tabsApi: {
      async get() {
        return { url: 'https://a.example.com/path', title: 'Example' };
      }
    },
    jsRuntimeManager: {
      async execute() {
        return { ok: true, tabId: 1, value: null, logs: [], items: [] };
      }
    }
  });

  const result = await manager.listMatchingSkillSummariesForTab(9);
  assert.equal(result.ok, true);
  assert.equal(result.skills.some((skill) => skill.name === 'dom-probe'), true);
  assert.equal(result.skills.some((skill) => skill.name === 'file-only'), false);
  assert.equal(result.skills[0].name, 'skill-creator');
});

test('allow_implicit_invocation=false 的技能不会进入自动匹配摘要，但 validate 可显式返回结果', async () => {
  const { createMicroSkillManager } = await loadMicroSkillManagerModule();

  const hiddenSkill = {
    ...buildSkillInput('hidden-skill'),
    policy: {
      allow_implicit_invocation: false
    }
  };

  const manager = createMicroSkillManager({
    store: createMockStore([hiddenSkill]),
    userScriptsApi: {
      async getScripts() { return []; },
      async register() {},
      async update() {},
      async unregister() {}
    },
    tabsApi: {
      async get() {
        return { url: 'https://a.example.com/path', title: 'Example' };
      }
    },
    jsRuntimeManager: {
      async execute() {
        return { ok: true, tabId: 1, value: null, logs: [], items: [] };
      }
    }
  });

  const summaries = await manager.listMatchingSkillSummariesForTab(9);
  assert.equal(summaries.skills.some((skill) => skill.name === 'hidden-skill'), false);

  const validation = await manager.executeRegistryAction({
    action: 'validate',
    skill_name: 'hidden-skill'
  });
  assert.equal(validation.ok, true);
  assert.equal(validation.valid, true);
});

test('create 在 validation 失败时拒绝写入并返回结构化校验结果', async () => {
  const { createMicroSkillManager } = await loadMicroSkillManagerModule();

  const manager = createMicroSkillManager({
    store: createMockStore(),
    userScriptsApi: {
      async getScripts() { return []; },
      async register() {},
      async update() {},
      async unregister() {}
    },
    tabsApi: {
      async get() {
        return { url: 'https://a.example.com/path', title: 'Example' };
      }
    },
    jsRuntimeManager: {
      async execute() {
        return { ok: true, tabId: 1, value: null, logs: [], items: [] };
      }
    }
  });

  const invalidSkill = buildSkillInput('invalid-skill');
  invalidSkill.interface.default_prompt = 'Read the page quickly.';

  const result = await manager.executeRegistryAction({
    action: 'create',
    skill: invalidSkill
  }, { tabId: 9 });

  assert.equal(result.ok, false);
  assert.equal(result.valid, false);
  assert.match(result.error.message, /default_prompt/);
});
