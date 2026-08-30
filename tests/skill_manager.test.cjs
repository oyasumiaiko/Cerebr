const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadSkillManagerModule() {
  const filePath = path.resolve(__dirname, '../src/extension/skill_manager.js');
  return import(pathToFileURL(filePath).href);
}

async function loadVirtualFileToolsModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/virtual_file_io/index.js');
  return import(`${pathToFileURL(filePath).href}?test=${Date.now()}`);
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
    async savePackage(skillPackage, options = {}) {
      const current = packagesByName.get(skillPackage.name) || null;
      if (Object.prototype.hasOwnProperty.call(options, 'expectedRevision')) {
        const expected = options.expectedRevision;
        const actual = current ? (current.revision ?? 1) : null;
        if ((expected === null && current) || (expected !== null && expected !== actual)) {
          const error = new Error('revision conflict');
          error.code = 'SKILL_REVISION_CONFLICT';
          error.state_changed = false;
          throw error;
        }
      }
      packagesByName.set(skillPackage.name, clone(skillPackage));
      return clone(skillPackage);
    },
    async deletePackage(skillName, options = {}) {
      const current = packagesByName.get(String(skillName || '')) || null;
      if (
        Object.prototype.hasOwnProperty.call(options, 'expectedRevision')
        && (current ? (current.revision ?? 1) : null) !== options.expectedRevision
      ) {
        const error = new Error('revision conflict');
        error.code = 'SKILL_REVISION_CONFLICT';
        error.state_changed = false;
        throw error;
      }
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

function buildCreateTemplateInput(name = 'DOM Probe') {
  return {
    name,
    description: '读取页面标题和链接',
    interface: {
      short_description: '读取当前页面标题和 URL',
      default_prompt: 'Read the current page title and URL.'
    },
    resources: ['references'],
    examples: true
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

test('Skill 生命周期与虚拟文件动作使用两条独立执行路径', async () => {
  const { createSkillManager } = await loadSkillManagerModule();
  const calls = { register: [], update: [], unregister: [], execute: [] };
  const manager = createSkillManager({
    store: createMockStore([buildSkillInput('dom-probe')]),
    userScriptsApi: {
      async getScripts() { return []; },
      async register(definitions) { calls.register.push(clone(definitions)); },
      async update(definitions) { calls.update.push(clone(definitions)); },
      async unregister(payload) { calls.unregister.push(clone(payload)); }
    },
    tabsApi: {
      async get(tabId) {
        return { id: tabId, url: 'https://app.example.com/path', title: 'Example' };
      }
    },
    jsRuntimeManager: {
      async execute(request) {
        calls.execute.push(clone(request));
        return {
          ok: true,
          tabId: request.tabId,
          value: { active_skills: ['dom-probe'] },
          logs: [],
          items: []
        };
      }
    }
  });

  const readFile = await manager.executeVirtualFileAction({
    action: 'read_file',
    environment_id: 'skill:dom-probe',
    file_path: 'src/helpers/dom.js',
    start_line: null,
    end_line: null
  });
  assert.equal(readFile.file.path, 'src/helpers/dom.js');
  assert.match(readFile.file.content, /document\.title/);

  const readManifest = await manager.executeVirtualFileAction({
    action: 'read_file',
    environment_id: 'skill:dom-probe',
    file_path: 'manifest.json',
    start_line: null,
    end_line: null
  });
  assert.equal(readManifest.file.is_manifest, true);
  assert.doesNotMatch(readManifest.file.content, /"name":|"kind":/);

  const added = await manager.executeVirtualFileAction({
    action: 'apply_patch',
    environment_id: 'skill:dom-probe',
    patch: [
      '*** Begin Patch',
      '*** Environment ID: skill:dom-probe',
      '*** Add File: src/helpers/url.js',
      '+module.exports = { readUrl() { return location.href; } };',
      '*** End Patch'
    ].join('\n')
  });
  assert.deepEqual(added.affected_files.added, ['src/helpers/url.js']);
  assert.equal(calls.execute.length, 0);

  const patchedManifest = await manager.executeVirtualFileAction({
    action: 'apply_patch',
    environment_id: 'skill:dom-probe',
    patch: [
      '*** Begin Patch',
      '*** Environment ID: skill:dom-probe',
      '*** Update File: manifest.json',
      '@@',
      '-  "description": "读取页面标题和链接",',
      '+  "description": "读取页面标题、链接与路径信息",',
      '*** End Patch'
    ].join('\n')
  });
  assert.equal(patchedManifest.skill.description, '读取页面标题、链接与路径信息');
  assert.equal(calls.execute.length, 0);

  const disabled = await manager.executeRegistryAction({
    action: 'disable_skill',
    include_all_sites: null,
    skill_name: 'dom-probe',
    skill: null
  }, { tabId: 11 });
  assert.equal(disabled.ok, true);
  assert.equal(calls.execute.length, 0);

  const enabled = await manager.executeRegistryAction({
    action: 'enable_skill',
    include_all_sites: null,
    skill_name: 'dom-probe',
    skill: null
  }, { tabId: 11 });
  assert.equal(enabled.ok, true);
  assert.equal(calls.execute.length, 0);

  const removed = await manager.executeRegistryAction({
    action: 'delete_skill',
    include_all_sites: null,
    skill_name: 'dom-probe',
    skill: null
  }, { tabId: 11 });
  assert.equal(removed.ok, true);
  assert.equal(calls.execute.length, 0);
  assert.equal(calls.register.length, 0);
  assert.equal(calls.update.length, 0);
});

test('copy_file 使用 cp 覆盖语义，skill 移动与删除统一由 apply_patch 执行', async () => {
  const { createSkillManager } = await loadSkillManagerModule();
  const calls = {
    update: []
  };
  const manager = createSkillManager({
    store: createMockStore([buildSkillInput('dom-probe')]),
    userScriptsApi: {
      async getScripts() { return []; },
      async register() {},
      async update(definitions) { calls.update.push(clone(definitions)); },
      async unregister() {}
    }
  });

  const copied = await manager.executeVirtualFileAction({
    action: 'copy_file',
    environment_id: 'skill:dom-probe',
    source_path: 'src/helpers/dom.js',
    destination_path: 'src/helpers/dom-copy.js'
  });
  assert.equal(copied.ok, true);
  assert.deepEqual(copied.affected_files.added, ['src/helpers/dom-copy.js']);
  assert.equal(copied.files.total_count, 5);

  const overwritten = await manager.executeVirtualFileAction({
    action: 'copy_file',
    environment_id: 'skill:dom-probe',
    source_path: 'src/helpers/dom.js',
    destination_path: 'src/helpers/dom-copy.js'
  });
  assert.equal(overwritten.ok, true);
  assert.deepEqual(overwritten.affected_files.modified, ['src/helpers/dom-copy.js']);
  assert.equal(overwritten.files.total_count, 5);

  const copiedManifest = await manager.executeVirtualFileAction({
    action: 'copy_file',
    environment_id: 'skill:dom-probe',
    source_path: 'manifest.json',
    destination_path: 'references/manifest-snapshot.json'
  });
  assert.equal(copiedManifest.ok, true);
  assert.deepEqual(copiedManifest.affected_files.added, ['references/manifest-snapshot.json']);
  const manifestSnapshot = await manager.executeVirtualFileAction({
    action: 'read_file',
    environment_id: 'skill:dom-probe',
    file_path: 'references/manifest-snapshot.json',
    start_line: null,
    end_line: null
  });
  assert.match(manifestSnapshot.file.content, /"description": "读取页面标题和链接"/);

  await assert.rejects(
    () => manager.executeVirtualFileAction({
      action: 'copy_file',
      environment_id: 'skill:dom-probe',
      source_path: 'src/helpers/dom.js',
      destination_path: 'manifest.json'
    }),
    /manifest\.json 是保留虚拟文件，不能作为 copy_file 的目标路径/
  );

  const moved = await manager.executeVirtualFileAction({
    action: 'apply_patch',
    environment_id: 'skill:dom-probe',
    patch: [
      '*** Begin Patch',
      '*** Environment ID: skill:dom-probe',
      '*** Update File: src/helpers/dom-copy.js',
      '*** Move to: src/helpers/dom-renamed.js',
      '@@',
      '-module.exports = { readTitle() { return document.title; } };',
      '+module.exports = { readTitle() { return document.title.trim(); } };',
      '*** End Patch'
    ].join('\n')
  });
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.affected_files.modified, ['src/helpers/dom-renamed.js']);
  assert.deepEqual(moved.affected_files.deleted, []);

  const deleted = await manager.executeVirtualFileAction({
    action: 'apply_patch',
    environment_id: 'skill:dom-probe',
    patch: [
      '*** Begin Patch',
      '*** Environment ID: skill:dom-probe',
      '*** Delete File: src/helpers/dom-renamed.js',
      '*** End Patch'
    ].join('\n')
  });
  assert.equal(deleted.ok, true);
  assert.deepEqual(deleted.affected_files.deleted, ['src/helpers/dom-renamed.js']);
  assert.equal(deleted.files.total_count, 5);
  assert.equal(calls.update.length, 0);

  await assert.rejects(
    () => manager.executeVirtualFileAction({
      action: 'move_file',
      environment_id: 'skill:dom-probe',
      source_path: 'src/helpers/dom.js',
      destination_path: 'src/helpers/other.js'
    }),
    /不支持的 Skill 文件 action `move_file`/
  );
});

test('模板式 create_skill 默认禁用且不会自动 refresh 当前文档', async () => {
  const { createSkillManager } = await loadSkillManagerModule();

  const calls = {
    register: [],
    execute: []
  };
  const manager = createSkillManager({
    store: createMockStore(),
    userScriptsApi: {
      async getScripts() { return []; },
      async register(definitions) { calls.register.push(clone(definitions)); },
      async update() {},
      async unregister() {}
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
    action: 'create_skill',
    skill: buildCreateTemplateInput('DOM Probe Template')
  }, { tabId: 11 });
  assert.equal(created.ok, true);
  assert.equal(created.create_mode, undefined);
  assert.equal(created.requested_name, 'DOM Probe Template');
  assert.equal(created.normalized_name, 'dom-probe-template');
  assert.equal(created.skill.kind, 'guidance');
  assert.equal(created.skill.enabled, false);
  assert.equal(created.refreshed_current_document, undefined);
  assert.equal(created.refresh_result, undefined);
  assert.equal(created.selected_resources, undefined);
  assert.equal(created.examples_created, undefined);
  assert.equal(Array.isArray(created.created_files), true);
  assert.equal(created.created_files.includes('SKILL.md'), true);
  assert.equal(created.created_files.includes('src/main.js'), false);
  assert.equal(created.created_files.includes('src/helpers/dom.js'), false);
  assert.equal(created.created_files.includes('references/api_reference.md'), true);
  assert.equal(created.next_steps, undefined);
  assert.equal(calls.register.length, 0);
  assert.equal(calls.execute.length, 0);

  const instruction = await manager.executeVirtualFileAction({
    action: 'read_file',
    environment_id: 'skill:dom-probe-template',
    file_path: 'SKILL.md',
    start_line: null,
    end_line: null
  });
  assert.equal(instruction.ok, true);
  assert.match(instruction.file.content, /## Overview/);
  assert.match(instruction.file.content, /## Structuring This Skill/);
  assert.match(instruction.file.content, /## Resources \(optional\)/);

  const manifest = await manager.executeVirtualFileAction({
    action: 'read_file',
    environment_id: 'skill:dom-probe-template',
    file_path: 'manifest.json',
    start_line: null,
    end_line: null
  });
  assert.equal(manifest.ok, true);
  assert.match(manifest.file.content, /"enabled": false/);
  assert.match(manifest.file.content, /"match": \[\]/);
  assert.match(manifest.file.content, /"entry_path": null/);
});

test('listMatchingSkillSummariesForTab 只返回当前页面命中的 page runtime skill 摘要', async () => {
  const { createSkillManager } = await loadSkillManagerModule();

  const manager = createSkillManager({
    store: createMockStore([
      {
        name: 'ops-guide',
        description: '指导如何检查当前页面状态',
        interface: {
          display_name: 'Ops Guide',
          short_description: '检查页面状态的通用指导',
          default_prompt: null
        },
        match: [],
        enabled: true,
        instruction: {
          path: 'SKILL.md'
        },
        runtime: {
          entry_path: null
        },
        files: [
          {
            path: 'SKILL.md',
            content: '# Ops Guide\n\nRead this guidance first.'
          }
        ],
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
        revision: 1
      },
      {
        ...buildSkillInput('page-probe'),
        match: ['https://app.example.com/*'],
        enabled: true,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-03T00:00:00.000Z',
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
        return { id: 11, url: 'https://app.example.com/path', title: 'Example' };
      }
    },
    jsRuntimeManager: {
      async execute() {
        return { ok: true, tabId: 11, value: null, logs: [], items: [] };
      }
    }
  });

  const summaries = await manager.listMatchingSkillSummariesForTab(11);
  assert.equal(summaries.ok, true);
  assert.equal(Array.isArray(summaries.skills), true);
  assert.deepEqual(
    summaries.skills.map((skill) => skill.name),
    ['page-probe']
  );
  assert.equal(summaries.skills.every((skill) => typeof skill.short_description === 'string' && skill.short_description), true);
  assert.equal(summaries.skills.every((skill) => skill.instruction_path === 'SKILL.md'), true);
  assert.equal(summaries.skills.every((skill) => !Object.prototype.hasOwnProperty.call(skill, 'mount_surface')), true);
  assert.equal(summaries.skills.some((skill) => skill.name === 'skill-creator'), false);
  assert.equal(summaries.skills.some((skill) => skill.name === 'ops-guide'), false);
});

test('skill 可以在后续 patch 后从 guidance 演进成 page runtime，再退回 guidance', async () => {
  const { createSkillManager } = await loadSkillManagerModule();
  const calls = {
    register: [],
    update: [],
    unregister: [],
    execute: []
  };

  const manager = createSkillManager({
    store: createMockStore(),
    userScriptsApi: {
      async getScripts() { return []; },
      async register(definitions) { calls.register.push(clone(definitions)); },
      async update(definitions) { calls.update.push(clone(definitions)); },
      async unregister(payload) { calls.unregister.push(clone(payload)); }
    },
    tabsApi: {
      async get() {
        return { id: 11, url: 'https://app.example.com/path', title: 'Example' };
      }
    },
    jsRuntimeManager: {
      async execute(request) {
        calls.execute.push(clone(request));
        return {
          ok: true,
          tabId: request.tabId,
          value: {
            active_skills: ['runtime-probe']
          },
          logs: [],
          items: []
        };
      }
    }
  });

  const created = await manager.executeRegistryAction({
    action: 'create_skill',
    skill: {
      name: 'Runtime Probe',
      description: '在需要页面 runtime 时再继续演进的通用 skill。',
      resources: [],
      examples: false
    }
  }, { tabId: 11 });
  assert.equal(created.skill.kind, 'guidance');

  const genericInstruction = await manager.executeVirtualFileAction({
    action: 'read_file',
    environment_id: 'skill:runtime-probe',
    file_path: 'SKILL.md',
    start_line: null,
    end_line: null
  });
  assert.match(genericInstruction.file.content, /Runtime Probe/);

  await manager.executeVirtualFileAction({
    action: 'apply_patch',
    environment_id: 'skill:runtime-probe',
    patch: [
      '*** Begin Patch',
      '*** Environment ID: skill:runtime-probe',
      '*** Add File: src/main.js',
      '+return {',
      '+  readSummary() {',
      '+    return { title: document.title, href: location.href };',
      '+  }',
      '+};',
      '*** End Patch'
    ].join('\n')
  });

  const runtimeManifest = await manager.executeVirtualFileAction({
    action: 'apply_patch',
    environment_id: 'skill:runtime-probe',
    patch: [
      '*** Begin Patch',
      '*** Environment ID: skill:runtime-probe',
      '*** Update File: manifest.json',
      '@@',
      '-  "match": [],',
      '+  "match": [',
      '+    "https://app.example.com/*"',
      '+  ],',
      '@@',
      '-    "entry_path": null',
      '+    "entry_path": "src/main.js"',
      '*** End Patch'
    ].join('\n')
  });
  assert.equal(runtimeManifest.skill.kind, 'page_runtime');

  const runtimeInstruction = await manager.executeVirtualFileAction({
    action: 'read_file',
    environment_id: 'skill:runtime-probe',
    file_path: 'SKILL.md',
    start_line: null,
    end_line: null
  });
  assert.match(runtimeInstruction.file.content, /Runtime Probe/);

  const enabled = await manager.executeRegistryAction({
    action: 'enable_skill',
    skill_name: 'runtime-probe'
  }, { tabId: 11 });
  assert.equal(enabled.skill.kind, 'page_runtime');
  assert.equal(calls.register.length, 0);

  const mounted = await manager.executeRegistryAction({
    action: 'mount_on_current_page',
    skill_name: 'runtime-probe'
  }, { tabId: 11 });
  assert.equal(mounted.ok, true);
  assert.equal(mounted.requested_skill_status, 'mounted');

  const reverted = await manager.executeVirtualFileAction({
    action: 'apply_patch',
    environment_id: 'skill:runtime-probe',
    patch: [
      '*** Begin Patch',
      '*** Environment ID: skill:runtime-probe',
      '*** Update File: manifest.json',
      '@@',
      '-  "match": [',
      '-    "https://app.example.com/*"',
      '-  ],',
      '+  "match": [],',
      '@@',
      '-    "entry_path": "src/main.js"',
      '+    "entry_path": null',
      '*** End Patch'
    ].join('\n')
  });
  assert.equal(reverted.skill.kind, 'guidance');
  assert.equal(calls.unregister.length, 0);

  const revertedInstruction = await manager.executeVirtualFileAction({
    action: 'read_file',
    environment_id: 'skill:runtime-probe',
    file_path: 'SKILL.md',
    start_line: null,
    end_line: null
  });
  assert.match(revertedInstruction.file.content, /Runtime Probe/);
});

test('mount_on_current_page 只挂载指定技能并返回当前页 active skills', async () => {
  const { createSkillManager } = await loadSkillManagerModule();
  const executeCalls = [];

  const manager = createSkillManager({
    store: createMockStore([
      {
        ...buildSkillInput('worldquant-brain-knowledge-cache'),
        match: ['https://platform.worldquantbrain.com/*'],
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
        revision: 1
      },
      {
        ...buildSkillInput('worldquant-brain-sim-state'),
        match: ['https://platform.worldquantbrain.com/*'],
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-03T00:00:00.000Z',
        revision: 2
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
        return { id: 11, url: 'https://platform.worldquantbrain.com/research', title: 'BRAIN' };
      }
    },
    jsRuntimeManager: {
      async execute(request) {
        executeCalls.push(clone(request));
        return {
          ok: true,
          tabId: 11,
          value: {
            active_skills: ['worldquant-brain-sim-state']
          },
          logs: [],
          items: []
        };
      }
    }
  });

  const result = await manager.executeRegistryAction({
    action: 'mount_on_current_page',
    skill_name: 'worldquant-brain-sim-state'
  }, { tabId: 11 });

  assert.equal(result.ok, true);
  assert.equal(result.requested_skill_name, 'worldquant-brain-sim-state');
  assert.equal(result.requested_skill_status, 'mounted');
  assert.equal(result.mounted_on_current_page, true);
  assert.equal(result.skill.name, 'worldquant-brain-sim-state');
  assert.deepEqual(result.active_skills, ['worldquant-brain-sim-state']);
  assert.equal(executeCalls.length, 1);
  assert.deepEqual(executeCalls[0].frameIds, null);
  assert.match(executeCalls[0].code, /worldquant-brain-sim-state/);
  assert.doesNotMatch(executeCalls[0].code, /worldquant-brain-knowledge-cache/);
});

test('mountSkillOnCurrentPage 会优先锁定发起请求的 document', async () => {
  const { createSkillManager } = await loadSkillManagerModule();
  const executeCalls = [];

  const manager = createSkillManager({
    store: createMockStore([{
      ...buildSkillInput('worldquant-brain-sim-state'),
      match: ['https://platform.worldquantbrain.com/*'],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-03T00:00:00.000Z',
      revision: 2
    }]),
    userScriptsApi: {
      async getScripts() { return []; },
      async register() {},
      async update() {},
      async unregister() {}
    },
    tabsApi: {
      async get() {
        return { id: 11, url: 'https://platform.worldquantbrain.com/research', title: 'BRAIN' };
      }
    },
    jsRuntimeManager: {
      async execute(request) {
        executeCalls.push(clone(request));
        return {
          ok: true,
          tabId: 11,
          value: { active_skills: ['worldquant-brain-sim-state'] },
          logs: [],
          items: []
        };
      }
    }
  });

  const result = await manager.mountSkillOnCurrentPage('worldquant-brain-sim-state', {
    tabId: 11,
    explicitUrl: 'https://platform.worldquantbrain.com/research',
    documentIds: ['document-7'],
    frameIds: [7]
  });

  assert.equal(result.ok, true);
  assert.equal(executeCalls.length, 1);
  assert.deepEqual(executeCalls[0].documentIds, ['document-7']);
  assert.equal(executeCalls[0].frameIds, null);
});

test('mount_on_current_page 失败时返回 ok=false 并透传首个 frame 错误', async () => {
  const { createSkillManager } = await loadSkillManagerModule();

  const manager = createSkillManager({
    store: createMockStore([
      {
        ...buildSkillInput('worldquant-brain-knowledge-cache'),
        match: ['https://platform.worldquantbrain.com/*'],
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
        return { id: 11, url: 'https://platform.worldquantbrain.com/research', title: 'BRAIN' };
      }
    },
    jsRuntimeManager: {
      async execute() {
        return {
          ok: false,
          tabId: 11,
          value: null,
          logs: [],
          items: [
            {
              frameId: 0,
              error: {
                message: 'Skill not mounted: worldquant-brain-knowledge-cache'
              }
            }
          ]
        };
      }
    }
  });

  const result = await manager.executeRegistryAction({
    action: 'mount_on_current_page',
    skill_name: 'worldquant-brain-knowledge-cache'
  }, { tabId: 11 });

  assert.equal(result.ok, false);
  assert.equal(result.requested_skill_status, 'runtime_failed');
  assert.equal(result.error.message, 'Skill not mounted: worldquant-brain-knowledge-cache');
  assert.deepEqual(result.active_skills, []);
});

test('mount_on_current_page 遇到 URL 不匹配时会显式返回 url_not_matched', async () => {
  const { createSkillManager } = await loadSkillManagerModule();
  const executeCalls = [];

  const manager = createSkillManager({
    store: createMockStore([
      {
        ...buildSkillInput('worldquant-brain-knowledge-cache'),
        match: ['https://platform.worldquantbrain.com/*'],
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
        return { id: 11, url: 'https://example.com/path', title: 'Example' };
      }
    },
    jsRuntimeManager: {
      async execute(request) {
        executeCalls.push(clone(request));
        return {
          ok: true,
          tabId: 11,
          value: {
            active_skills: []
          },
          logs: [],
          items: []
        };
      }
    }
  });

  const result = await manager.executeRegistryAction({
    action: 'mount_on_current_page',
    skill_name: 'worldquant-brain-knowledge-cache'
  }, { tabId: 11 });

  assert.equal(result.ok, false);
  assert.equal(result.requested_skill_status, 'url_not_matched');
  assert.equal(result.mounted_on_current_page, false);
  assert.deepEqual(result.active_skills, []);
  assert.match(result.error.message, /URL 不匹配/);
  assert.equal(executeCalls.length, 1);
});

test('内置 skill-creator 会自动出现在列表中且保持只读', async () => {
  const { createSkillManager } = await loadSkillManagerModule();

  const manager = createSkillManager({
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

  const detail = await manager.executeVirtualFileAction({
    action: 'read_file',
    environment_id: 'skill:skill-creator',
    file_path: 'SKILL.md',
    start_line: null,
    end_line: null
  });
  assert.equal(detail.ok, true);
  assert.match(detail.file.content, /Skill Creator/);

  await assert.rejects(
    () => manager.executeRegistryAction({
      action: 'delete_skill',
      skill_name: 'skill-creator'
    }),
    /内置只读指导 skill/
  );

  const builtinSearch = await manager.executeVirtualFileAction({
    action: 'search_files',
    environment_id: 'skill:skill-creator',
    pattern: 'search_files',
    regex: false,
    ignore_case: false,
    path_glob: null,
    context_lines: 0
  });
  assert.equal(builtinSearch.ok, true);
  assert.equal(builtinSearch.total_matching_lines > 0, true);
  assert.equal(builtinSearch.groups[0].skill_name, 'skill-creator');
});

test('Skill read_file 返回原文行范围且不生成行号', async () => {
  const { createSkillManager } = await loadSkillManagerModule();
  const manager = createSkillManager({
    store: createMockStore([{
      ...buildLongSkillInput(),
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      revision: 1
    }])
  });

  const full = await manager.executeVirtualFileAction({
    action: 'read_file',
    environment_id: 'skill:long-dom-probe',
    file_path: 'SKILL.md',
    start_line: null,
    end_line: null
  });
  assert.equal(full.file.content_read.mode, 'full');
  assert.equal(full.file.content.length > 10000, true);
  assert.equal(full.file.numbered_content, undefined);

  const ranged = await manager.executeVirtualFileAction({
    action: 'read_file',
    environment_id: 'skill:long-dom-probe',
    file_path: 'SKILL.md',
    start_line: 3,
    end_line: 4
  });
  assert.equal(ranged.file.content_read.mode, 'lines');
  assert.equal(ranged.file.content_read.start_line, 3);
  assert.equal(ranged.file.content_read.end_line, 4);
  assert.match(ranged.file.content, /^Line 1:/m);
  assert.doesNotMatch(ranged.file.content, /\d+ \| /);

  await assert.rejects(
    () => manager.executeVirtualFileAction({
      action: 'read_file',
      environment_id: 'skill:long-dom-probe',
      file_path: 'SKILL.md',
      start_line: 999,
      end_line: 1000
    }),
    /超过文件总行数/
  );
});

test('Skill list_files/search_files 使用单一 environment_id 并按匹配行返回', async () => {
  const { createSkillManager } = await loadSkillManagerModule();
  const manager = createSkillManager({
    store: createMockStore([{
      ...buildSkillInput('dom-probe'),
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      revision: 1
    }])
  });

  const listFiles = await manager.executeVirtualFileAction({
    action: 'list_files',
    environment_id: 'skill:dom-probe',
    path_glob: null
  });
  assert.equal(listFiles.total_files, 4);
  assert.equal(listFiles.files[0].path, 'manifest.json');

  const filteredFiles = await manager.executeVirtualFileAction({
    action: 'list_files',
    environment_id: 'skill:dom-probe',
    path_glob: 'src'
  });
  assert.equal(filteredFiles.files.every((file) => file.path.startsWith('src/')), true);

  const search = await manager.executeVirtualFileAction({
    action: 'search_files',
    environment_id: 'skill:dom-probe',
    pattern: 'readTitle',
    regex: false,
    ignore_case: false,
    path_glob: 'src/**/*.js',
    context_lines: 1
  });
  assert.equal(search.total_matching_lines >= 2, true);
  assert.equal(search.groups.every((group) => group.file_path.startsWith('src/')), true);

  const matchingLine = search.groups
    .flatMap((group) => group.lines.map((line) => ({ ...line, file_path: group.file_path })))
    .find((line) => line.is_match === true);
  const targetedRead = await manager.executeVirtualFileAction({
    action: 'read_file',
    environment_id: 'skill:dom-probe',
    file_path: matchingLine.file_path,
    start_line: matchingLine.line_number,
    end_line: matchingLine.line_number
  });
  assert.match(targetedRead.file.content, /readTitle/);
  assert.doesNotMatch(targetedRead.file.content, /\d+ \| /);
});

test('reconcileRegisteredSkills 会清理旧版 document_start skill 注册且不再新增', async () => {
  const { createSkillManager } = await loadSkillManagerModule();

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

  const manager = createSkillManager({
    store,
    userScriptsApi: {
      async getScripts() {
        return [
          { id: 'cerebr-skill--dom-probe' },
          { id: 'cerebr-skill--stale-old-skill' }
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
  assert.equal(result.registered_count, 0);
  assert.equal(result.updated_count, 0);
  assert.equal(result.unregistered_count, 2);
  assert.equal(calls.register.length, 0);
  assert.equal(calls.update.length, 0);
  assert.equal(calls.unregister.length, 1);
  assert.deepEqual(calls.unregister[0], {
    ids: ['cerebr-skill--dom-probe', 'cerebr-skill--stale-old-skill']
  });
});

test('listMatchingSkillSummariesForTab 只返回当前 URL 命中的轻量摘要', async () => {
  const { createSkillManager } = await loadSkillManagerModule();

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

  const manager = createSkillManager({
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
  assert.equal(result.skills.some((skill) => skill.name === 'skill-creator'), false);
  assert.equal(result.skills[0].name, 'dom-probe');
});

test('skill_registry list 默认只返回当前页面可见的技能，include_all_sites=true 时返回全量', async () => {
  const { createSkillManager } = await loadSkillManagerModule();

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

  const manager = createSkillManager({
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
        return { ok: true, tabId: 9, value: null, logs: [], items: [] };
      }
    }
  });

  const visibleOnly = await manager.executeRegistryAction({ action: 'list' }, { tabId: 9 });
  assert.equal(visibleOnly.ok, true);
  assert.equal(visibleOnly.scope, 'current_page');
  assert.equal(visibleOnly.include_all_sites, false);
  assert.equal(visibleOnly.skills.some((skill) => skill.name === 'dom-probe'), true);
  assert.equal(visibleOnly.skills.some((skill) => skill.name === 'file-only'), false);

  const allSkills = await manager.executeRegistryAction({
    action: 'list',
    include_all_sites: true
  }, { tabId: 9 });
  assert.equal(allSkills.ok, true);
  assert.equal(allSkills.scope, 'all_sites');
  assert.equal(allSkills.include_all_sites, true);
  assert.equal(allSkills.skills.some((skill) => skill.name === 'dom-probe'), true);
  assert.equal(allSkills.skills.some((skill) => skill.name === 'file-only'), true);
});

test('Skill 文件动作收到 tabId=null 时只持久化，不把 null 误转成 tab 0', async () => {
  const { createSkillManager } = await loadSkillManagerModule();
  const store = createMockStore();
  let runtimeExecuteCount = 0;
  const manager = createSkillManager({
    store,
    jsRuntimeManager: {
      async execute() {
        runtimeExecuteCount += 1;
        throw new Error('Skill 文件动作不应执行页面 runtime。');
      }
    }
  });
  await manager.createSkill(buildSkillInput('null-tab-file-action'));

  const result = await manager.executeVirtualFileAction({
    action: 'apply_patch',
    environment_id: 'skill:null-tab-file-action',
    patch: [
      '*** Begin Patch',
      '*** Environment ID: skill:null-tab-file-action',
      '*** Add File: local/说明.md',
      '+普通 Skill 文件。',
      '*** End Patch'
    ].join('\n')
  });

  assert.equal(result.ok, true);
  assert.equal(result.refreshed_current_document, undefined);
  assert.equal(result.refresh_result, undefined);
  assert.equal(runtimeExecuteCount, 0);
  const stored = await store.getPackage('null-tab-file-action');
  assert.equal(stored.files.find((file) => file.path === 'local/说明.md')?.content, '普通 Skill 文件。\n');
});

test('Skill apply_patch 在完整验证失败时不写入、不增 revision，并拒绝内部环境上下文冲突', async () => {
  const { createSkillManager } = await loadSkillManagerModule();
  const store = createMockStore();
  const manager = createSkillManager({ store });
  await manager.createSkill(buildSkillInput('atomic-skill'));
  const before = await store.getPackage('atomic-skill');

  await assert.rejects(
    () => manager.executeVirtualFileAction({
      action: 'apply_patch',
      environment_id: 'skill:atomic-skill',
      patch: [
        '*** Begin Patch',
        '*** Environment ID: skill:atomic-skill',
        '*** Add File: references/new.md',
        '+new content',
        '*** Update File: SKILL.md',
        '@@',
        '-missing stale scaffold line',
        '+replacement',
        '*** End Patch'
      ].join('\n')
    }),
    (error) => error?.state_changed === false
      && error?.revision === before.revision
      && error?.file_path === 'SKILL.md'
      && error?.hunk_index === 2
      && /apply_patch verification failed: Failed to find expected lines in SKILL\.md/.test(error?.tool_output || '')
  );

  const afterFailure = await store.getPackage('atomic-skill');
  assert.deepEqual(afterFailure, before);

  await assert.rejects(
    () => manager.executeVirtualFileAction({
      action: 'apply_patch',
      environment_id: 'skill:other-skill',
      patch: [
        '*** Begin Patch',
        '*** Environment ID: skill:atomic-skill',
        '*** Add File: references/never-written.md',
        '+no',
        '*** End Patch'
      ].join('\n')
    }),
    (error) => error?.code === 'APPLY_PATCH_ENVIRONMENT_CONTEXT_MISMATCH'
      && error?.state_changed === false
  );
  assert.deepEqual(await store.getPackage('atomic-skill'), before);

  const success = await manager.executeVirtualFileAction({
    action: 'apply_patch',
    environment_id: 'skill:atomic-skill',
    patch: [
      '*** Begin Patch',
      '*** Environment ID: skill:atomic-skill',
      '*** Add File: references/new.md',
      '+new content',
      '*** End Patch'
    ].join('\n')
  });
  assert.equal(success.skill.revision, before.revision + 1);
  assert.equal(
    (await store.getPackage('atomic-skill')).files.find((file) => file.path === 'references/new.md')?.content,
    'new content\n'
  );
});
