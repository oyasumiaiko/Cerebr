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
      short_description: '读取当前页面标题和 URL',
      default_prompt: 'Read the current page title and URL.'
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
        content: '# DOM Probe\n\n在需要读取页面基础信息时使用。'
      },
      {
        path: 'src/main.js',
        content: 'const helpers = await require("./helpers/dom.js"); return { read() { return { title: helpers.readTitle(), href: location.href }; } };'
      },
      {
        path: 'src/helpers/dom.js',
        content: 'module.exports = { readTitle() { return document.title; } };'
      }
    ]
  };
}

function buildLongSkillInput(name = 'long-dom-probe') {
  const instructionLines = Array.from({ length: 40 }, (_, index) => `Line ${index + 1}: ${'B'.repeat(360)}`);
  return {
    ...buildSkillInput(name),
    files: [
      {
        path: 'SKILL.md',
        content: `# Long DOM Probe\n\n${instructionLines.join('\n')}\n`
      },
      {
        path: 'src/main.js',
        content: `${'const title = document.title;\n'.repeat(900)}return { read() { return title; } };`
      },
      {
        path: 'src/helpers/dom.js',
        content: 'module.exports = { readTitle() { return document.title; } };'
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
          content: '# DOM Probe\n\n更新后的说明。'
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

  const readManifest = await manager.executeRegistryAction({
    action: 'read_file',
    skill_name: 'dom-probe',
    file_path: 'manifest.json'
  }, { tabId: 11 });
  assert.equal(readManifest.ok, true);
  assert.equal(readManifest.skill.file.is_manifest, true);
  assert.doesNotMatch(readManifest.skill.file.content, /"name":/);
  assert.doesNotMatch(readManifest.skill.file.content, /"kind":/);

  const addedFile = await manager.executeRegistryAction({
    action: 'apply_patch',
    skill_name: 'dom-probe',
    patch: [
      '*** Begin Patch',
      '*** Add File: src/helpers/url.js',
      '+module.exports = { readUrl() { return location.href; } };',
      '*** End Patch'
    ].join('\n')
  }, { tabId: 11 });
  assert.equal(addedFile.ok, true);
  assert.equal(addedFile.files.total_count, 5);
  assert.deepEqual(addedFile.affected_files, {
    added: ['src/helpers/url.js'],
    modified: [],
    deleted: []
  });
  assert.equal(calls.update.length, 2);
  assert.equal(calls.execute.length, 3);

  const patchedManifestDescription = await manager.executeRegistryAction({
    action: 'apply_patch',
    skill_name: 'dom-probe',
    patch: [
      '*** Begin Patch',
      '*** Update File: manifest.json',
      '@@',
      '-  "description": "读取页面标题和链接",',
      '+  "description": "读取页面标题、链接与路径信息",',
      '*** End Patch'
    ].join('\n')
  }, { tabId: 11 });
  assert.equal(patchedManifestDescription.ok, true);
  assert.equal(patchedManifestDescription.skill.description, '读取页面标题、链接与路径信息');
  assert.equal(calls.update.length, 3);
  assert.equal(calls.execute.length, 4);

  const patchedFile = await manager.executeRegistryAction({
    action: 'apply_patch',
    skill_name: 'dom-probe',
    patch: [
      '*** Begin Patch',
      '*** Update File: src/helpers/url.js',
      '@@',
      '-module.exports = { readUrl() { return location.href; } };',
      '+module.exports = { readUrl() { return location.pathname; } };',
      '*** End Patch'
    ].join('\n')
  }, { tabId: 11 });
  assert.equal(patchedFile.ok, true);
  assert.deepEqual(patchedFile.affected_files, {
    added: [],
    modified: ['src/helpers/url.js'],
    deleted: []
  });
  assert.equal(calls.update.length, 4);
  assert.equal(calls.execute.length, 5);

  const patchedManifest = await manager.executeRegistryAction({
    action: 'apply_patch',
    skill_name: 'dom-probe',
    patch: [
      '*** Begin Patch',
      '*** Update File: manifest.json',
      '@@',
      '-  "enabled": true,',
      '+  "enabled": false,',
      '*** End Patch'
    ].join('\n')
  }, { tabId: 11 });
  assert.equal(patchedManifest.ok, true);
  assert.deepEqual(patchedManifest.affected_files, {
    added: [],
    modified: ['manifest.json'],
    deleted: []
  });
  assert.equal(patchedManifest.skill.enabled, false);
  assert.equal(calls.unregister.length, 1);
  assert.equal(calls.execute.length, 6);

  const reenabledViaManifest = await manager.executeRegistryAction({
    action: 'apply_patch',
    skill_name: 'dom-probe',
    patch: [
      '*** Begin Patch',
      '*** Update File: manifest.json',
      '@@',
      '-  "enabled": false,',
      '+  "enabled": true,',
      '*** End Patch'
    ].join('\n')
  }, { tabId: 11 });
  assert.equal(reenabledViaManifest.ok, true);
  assert.equal(calls.register.length, 2);
  assert.equal(calls.execute.length, 7);

  const deletedFile = await manager.executeRegistryAction({
    action: 'delete_file',
    skill_name: 'dom-probe',
    file_path: 'src/helpers/url.js'
  }, { tabId: 11 });
  assert.equal(deletedFile.ok, true);
  assert.equal(deletedFile.files.total_count, 4);
  assert.equal(calls.update.length, 5);
  assert.equal(calls.execute.length, 8);

  const disabled = await manager.executeRegistryAction({
    action: 'disable',
    skill_name: 'dom-probe'
  }, { tabId: 11 });
  assert.equal(disabled.ok, true);
  assert.equal(calls.unregister.length, 2);
  assert.equal(calls.execute.length, 9);

  const enabled = await manager.executeRegistryAction({
    action: 'enable',
    skill_name: 'dom-probe'
  }, { tabId: 11 });
  assert.equal(enabled.ok, true);
  assert.equal(calls.register.length, 3);
  assert.equal(calls.execute.length, 10);

  const removed = await manager.executeRegistryAction({
    action: 'delete',
    skill_name: 'dom-probe'
  }, { tabId: 11 });
  assert.equal(removed.ok, true);
  assert.equal(calls.unregister.length, 3);
  assert.equal(calls.execute.length, 11);
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

  const builtinSearch = await manager.executeRegistryAction({
    action: 'search_files',
    skill_name: 'skill-creator',
    pattern: 'search_files'
  });
  assert.equal(builtinSearch.ok, true);
  assert.equal(builtinSearch.total_matches > 0, true);
  assert.equal(builtinSearch.matches[0].skill_name, 'skill-creator');
});

test('read_detail/read_file 支持截断预览、字符偏移与按行续读', async () => {
  const { createMicroSkillManager } = await loadMicroSkillManagerModule();

  const manager = createMicroSkillManager({
    store: createMockStore([
      {
        ...buildLongSkillInput(),
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
        revision: 1
      }
    ]),
    userScriptsApi: {
      async getScripts() { return []; },
      async register() {},
      async update() {},
      async unregister() {}
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

  const detailPreview = await manager.executeRegistryAction({
    action: 'read_detail',
    skill_name: 'long-dom-probe'
  });
  assert.equal(detailPreview.ok, true);
  assert.equal(detailPreview.skill.instruction.content_read.mode, 'preview');
  assert.equal(detailPreview.skill.instruction.content_read.max_chars, 10000);
  assert.equal(detailPreview.skill.instruction.content_read.truncated, true);
  assert.equal(detailPreview.skill.instruction.content.length, 10000);

  const detailByLine = await manager.executeRegistryAction({
    action: 'read_detail',
    skill_name: 'long-dom-probe',
    start_line: 3,
    end_line: 4,
    include_line_numbers: true
  });
  assert.equal(detailByLine.ok, true);
  assert.equal(detailByLine.skill.instruction.content_read.mode, 'line_range');
  assert.equal(detailByLine.skill.instruction.content_read.start_line, 3);
  assert.equal(detailByLine.skill.instruction.content_read.end_line, 4);
  assert.match(detailByLine.skill.instruction.content, /^Line 1:/m);
  assert.doesNotMatch(detailByLine.skill.instruction.content, /^Line 3:/m);
  assert.match(detailByLine.skill.instruction.numbered_content, /^3 \| Line 1:/m);

  const fileByChars = await manager.executeRegistryAction({
    action: 'read_file',
    skill_name: 'long-dom-probe',
    file_path: 'src/main.js',
    skip_chars: 200,
    max_chars: 150,
    include_line_numbers: true
  });
  assert.equal(fileByChars.ok, true);
  assert.equal(fileByChars.skill.file.content_read.mode, 'char_range');
  assert.equal(fileByChars.skill.file.content_read.skip_chars, 200);
  assert.equal(fileByChars.skill.file.content_read.max_chars, 150);
  assert.equal(fileByChars.skill.file.content.length, 150);
  assert.equal(fileByChars.skill.file.content_read.has_more_after_range, true);
  assert.match(fileByChars.skill.file.numbered_content, /^\d+ \| /m);
});

test('list_files/search_files 支持单 skill 与全局搜索闭环', async () => {
  const { createMicroSkillManager } = await loadMicroSkillManagerModule();

  const manager = createMicroSkillManager({
    store: createMockStore([
      {
        ...buildSkillInput('dom-probe'),
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
        revision: 1
      },
      {
        ...buildSkillInput('dom-probe-2'),
        created_at: '2026-01-03T00:00:00.000Z',
        updated_at: '2026-01-04T00:00:00.000Z',
        revision: 1
      }
    ]),
    userScriptsApi: {
      async getScripts() { return []; },
      async register() {},
      async update() {},
      async unregister() {}
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

  const listFiles = await manager.executeRegistryAction({
    action: 'list_files',
    skill_name: 'dom-probe'
  });
  assert.equal(listFiles.ok, true);
  assert.equal(listFiles.total_files, 4);
  assert.equal(listFiles.files[0].path, 'manifest.json');
  assert.equal(listFiles.files[0].skill_name, 'dom-probe');

  const globalSearch = await manager.executeRegistryAction({
    action: 'search_files',
    pattern: 'readTitle',
    path_glob: 'src/**/*.js',
    context_before: 1,
    context_after: 1,
    max_results: 10
  });
  assert.equal(globalSearch.ok, true);
  assert.equal(globalSearch.total_matches >= 4, true);
  assert.equal(globalSearch.matches.every((item) => item.file_path.startsWith('src/')), true);
  assert.equal(globalSearch.matches.every((item) => item.before.length <= 1 && item.after.length <= 1), true);

  const targetedRead = await manager.executeRegistryAction({
    action: 'read_file',
    skill_name: globalSearch.matches[0].skill_name,
    file_path: globalSearch.matches[0].file_path,
    start_line: globalSearch.matches[0].line_number,
    end_line: globalSearch.matches[0].line_number,
    include_line_numbers: true
  });
  assert.equal(targetedRead.ok, true);
  assert.match(targetedRead.skill.file.numbered_content, new RegExp(`^${globalSearch.matches[0].line_number} \\| `, 'm'));
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

test('reconcileRegisteredSkills 遇到 Duplicate script ID 时会回退到 update 而不是整体失败', async () => {
  const { createMicroSkillManager } = await loadMicroSkillManagerModule();

  const calls = {
    register: [],
    update: []
  };

  const manager = createMicroSkillManager({
    store: createMockStore([
      {
        ...buildSkillInput('worldquant-brain-sim-state'),
        match: ['https://platform.worldquantbrain.com/*'],
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
        revision: 1
      }
    ]),
    userScriptsApi: {
      async getScripts() { return []; },
      async register(definitions) {
        calls.register.push(clone(definitions));
        throw new Error("Duplicate script ID 'cerebr-micro-skill--worldquant-brain-sim-state'");
      },
      async update(definitions) { calls.update.push(clone(definitions)); },
      async unregister() {}
    },
    tabsApi: {
      async get() {
        return { url: 'https://platform.worldquantbrain.com/', title: 'BRAIN' };
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
  assert.equal(result.registered_count, 0);
  assert.equal(result.updated_count, 1);
  assert.equal(calls.register.length, 1);
  assert.equal(calls.update.length, 1);
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
