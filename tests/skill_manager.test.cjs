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

test('create/update/delete/enable/disable 只持久化并刷新当前文档，不再注册 eager runtime', async () => {
  const { createSkillManager } = await loadSkillManagerModule();
  const {
    buildSkillRegistryFileActionPayloadFromVirtualFileAction,
    normalizeVirtualFileResultFromSkillRegistryAction,
    normalizeVirtualFileToolArguments
  } = await loadVirtualFileToolsModule();

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
    skill: buildSkillInput()
  }, { tabId: 11 });
  assert.equal(created.ok, true);
  assert.equal(calls.register.length, 0);
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
  assert.equal(calls.update.length, 0);
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

  const modelPatchArgs = normalizeVirtualFileToolArguments('apply_patch', {
    target: { kind: 'skill', name: 'dom-probe' },
    patch: [
      '*** Begin Patch',
      '*** Add File: src/helpers/url.js',
      '+module.exports = { readUrl() { return location.href; } };',
      '*** End Patch'
    ].join('\n')
  });
  const modelPatchPayload = buildSkillRegistryFileActionPayloadFromVirtualFileAction(
    'apply_patch',
    modelPatchArgs
  );
  assert.equal(modelPatchPayload.refresh_current_document, false);
  const addedFileRaw = await manager.executeRegistryAction(
    modelPatchPayload,
    { tabId: 11 }
  );
  const addedFile = normalizeVirtualFileResultFromSkillRegistryAction(
    'apply_patch',
    addedFileRaw,
    modelPatchArgs
  );
  assert.equal(addedFile.ok, true);
  assert.deepEqual(addedFile.target, { kind: 'skill', name: 'dom-probe' });
  assert.equal(addedFile.files.total_count, 5);
  assert.deepEqual(addedFile.affected_files, {
    added: ['src/helpers/url.js'],
    modified: [],
    deleted: []
  });
  assert.equal(calls.update.length, 0);
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
  assert.equal(calls.update.length, 0);
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
  assert.equal(calls.update.length, 0);
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
  assert.equal(calls.unregister.length, 0);
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
  assert.equal(calls.register.length, 0);
  assert.equal(calls.execute.length, 7);

  const deletedFile = await manager.executeRegistryAction({
    action: 'apply_patch',
    skill_name: 'dom-probe',
    patch: [
      '*** Begin Patch',
      '*** Delete File: src/helpers/url.js',
      '*** End Patch'
    ].join('\n')
  }, { tabId: 11 });
  assert.equal(deletedFile.ok, true);
  assert.equal(deletedFile.files.total_count, 4);
  assert.equal(calls.update.length, 0);
  assert.equal(calls.execute.length, 8);

  const disabled = await manager.executeRegistryAction({
    action: 'disable_skill',
    skill_name: 'dom-probe'
  }, { tabId: 11 });
  assert.equal(disabled.ok, true);
  assert.equal(calls.unregister.length, 0);
  assert.equal(calls.execute.length, 9);

  const enabled = await manager.executeRegistryAction({
    action: 'enable_skill',
    skill_name: 'dom-probe'
  }, { tabId: 11 });
  assert.equal(enabled.ok, true);
  assert.equal(calls.register.length, 0);
  assert.equal(calls.execute.length, 10);

  const removed = await manager.executeRegistryAction({
    action: 'delete_skill',
    skill_name: 'dom-probe'
  }, { tabId: 11 });
  assert.equal(removed.ok, true);
  assert.equal(calls.unregister.length, 0);
  assert.equal(calls.execute.length, 11);
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

  const copied = await manager.executeRegistryAction({
    action: 'copy_file',
    skill_name: 'dom-probe',
    source_file_path: 'src/helpers/dom.js',
    destination_file_path: 'src/helpers/dom-copy.js'
  });
  assert.equal(copied.ok, true);
  assert.deepEqual(copied.affected_files.added, ['src/helpers/dom-copy.js']);
  assert.equal(copied.files.total_count, 5);

  const overwritten = await manager.executeRegistryAction({
    action: 'copy_file',
    skill_name: 'dom-probe',
    source_file_path: 'src/helpers/dom.js',
    destination_file_path: 'src/helpers/dom-copy.js'
  });
  assert.equal(overwritten.ok, true);
  assert.deepEqual(overwritten.affected_files.modified, ['src/helpers/dom-copy.js']);
  assert.equal(overwritten.files.total_count, 5);

  const copiedManifest = await manager.executeRegistryAction({
    action: 'copy_file',
    skill_name: 'dom-probe',
    source_file_path: 'manifest.json',
    destination_file_path: 'references/manifest-snapshot.json'
  });
  assert.equal(copiedManifest.ok, true);
  assert.deepEqual(copiedManifest.affected_files.added, ['references/manifest-snapshot.json']);
  const manifestSnapshot = await manager.executeRegistryAction({
    action: 'read_file',
    skill_name: 'dom-probe',
    file_path: 'references/manifest-snapshot.json'
  });
  assert.match(manifestSnapshot.skill.file.content, /"description": "读取页面标题和链接"/);

  await assert.rejects(
    () => manager.executeRegistryAction({
      action: 'copy_file',
      skill_name: 'dom-probe',
      source_file_path: 'src/helpers/dom.js',
      destination_file_path: 'manifest.json'
    }),
    /manifest\.json 是保留虚拟文件，不能作为 copy_file 的目标路径/
  );

  const moved = await manager.executeRegistryAction({
    action: 'apply_patch',
    skill_name: 'dom-probe',
    patch: [
      '*** Begin Patch',
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

  const deleted = await manager.executeRegistryAction({
    action: 'apply_patch',
    skill_name: 'dom-probe',
    patch: [
      '*** Begin Patch',
      '*** Delete File: src/helpers/dom-renamed.js',
      '*** End Patch'
    ].join('\n')
  });
  assert.equal(deleted.ok, true);
  assert.deepEqual(deleted.affected_files.deleted, ['src/helpers/dom-renamed.js']);
  assert.equal(deleted.files.total_count, 5);
  assert.equal(calls.update.length, 0);

  await assert.rejects(
    () => manager.executeRegistryAction({
      action: 'move_file',
      skill_name: 'dom-probe',
      source_file_path: 'src/helpers/dom.js',
      destination_file_path: 'src/helpers/other.js'
    }),
    /不支持的 action `move_file`/
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
  assert.equal(created.create_mode, 'template');
  assert.equal(created.requested_name, 'DOM Probe Template');
  assert.equal(created.normalized_name, 'dom-probe-template');
  assert.equal(created.skill.kind, 'guidance');
  assert.equal(created.skill.enabled, false);
  assert.equal(created.refreshed_current_document, false);
  assert.equal(created.refresh_result, null);
  assert.deepEqual(created.selected_resources, ['references']);
  assert.equal(created.examples_created, true);
  assert.equal(Array.isArray(created.created_files), true);
  assert.equal(created.created_files.includes('SKILL.md'), true);
  assert.equal(created.created_files.includes('src/main.js'), false);
  assert.equal(created.created_files.includes('src/helpers/dom.js'), false);
  assert.equal(created.created_files.includes('references/api_reference.md'), true);
  assert.equal(Array.isArray(created.next_steps), true);
  assert.equal(created.next_steps.some((line) => /enable_skill/.test(line)), true);
  assert.equal(calls.register.length, 0);
  assert.equal(calls.execute.length, 0);

  const instruction = await manager.executeRegistryAction({
    action: 'read_file',
    skill_name: 'dom-probe-template',
    file_path: 'SKILL.md'
  }, { tabId: 11 });
  assert.equal(instruction.ok, true);
  assert.match(instruction.skill.file.content, /## Overview/);
  assert.match(instruction.skill.file.content, /## Structuring This Skill/);
  assert.match(instruction.skill.file.content, /## Resources \(optional\)/);
  assert.equal(Object.prototype.hasOwnProperty.call(instruction.skill, 'has_runtime'), false);

  const manifest = await manager.executeRegistryAction({
    action: 'read_file',
    skill_name: 'dom-probe-template',
    file_path: 'manifest.json'
  }, { tabId: 11 });
  assert.equal(manifest.ok, true);
  assert.match(manifest.skill.file.content, /"enabled": false/);
  assert.match(manifest.skill.file.content, /"match": \[\]/);
  assert.match(manifest.skill.file.content, /"entry_path": null/);
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

  const genericInstruction = await manager.executeRegistryAction({
    action: 'read_file',
    skill_name: 'runtime-probe',
    file_path: 'SKILL.md'
  }, { tabId: 11 });
  assert.equal(Object.prototype.hasOwnProperty.call(genericInstruction.skill, 'has_runtime'), false);

  await manager.executeRegistryAction({
    action: 'apply_patch',
    skill_name: 'runtime-probe',
    patch: [
      '*** Begin Patch',
      '*** Add File: src/main.js',
      '+return {',
      '+  readSummary() {',
      '+    return { title: document.title, href: location.href };',
      '+  }',
      '+};',
      '*** End Patch'
    ].join('\n')
  }, { tabId: 11 });

  const runtimeManifest = await manager.executeRegistryAction({
    action: 'apply_patch',
    skill_name: 'runtime-probe',
    patch: [
      '*** Begin Patch',
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
  }, { tabId: 11 });
  assert.equal(runtimeManifest.skill.kind, 'page_runtime');

  const runtimeInstruction = await manager.executeRegistryAction({
    action: 'read_file',
    skill_name: 'runtime-probe',
    file_path: 'SKILL.md'
  }, { tabId: 11 });
  assert.equal(runtimeInstruction.skill.has_runtime, true);
  assert.equal(runtimeInstruction.skill.runtime_entry_path, 'src/main.js');

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

  const reverted = await manager.executeRegistryAction({
    action: 'apply_patch',
    skill_name: 'runtime-probe',
    patch: [
      '*** Begin Patch',
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
  }, { tabId: 11 });
  assert.equal(reverted.skill.kind, 'guidance');
  assert.equal(calls.unregister.length, 0);

  const revertedInstruction = await manager.executeRegistryAction({
    action: 'read_file',
    skill_name: 'runtime-probe',
    file_path: 'SKILL.md'
  }, { tabId: 11 });
  assert.equal(revertedInstruction.skill.has_runtime, true);
  assert.match(revertedInstruction.skill.runtime_hint, /JS runtime files/i);
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

test('read_detail/read_file 使用统一输出预算支持字符偏移与按行续读', async () => {
  const { createSkillManager } = await loadSkillManagerModule();

  const manager = createSkillManager({
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
  assert.equal(detailPreview.skill.instruction.content_read.mode, 'full');
  assert.equal(detailPreview.skill.instruction.content_read.max_output_chars, undefined);
  assert.equal(detailPreview.skill.instruction.content_read.truncated, false);
  assert.equal(detailPreview.skill.instruction.content.length > 10000, true);

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
    max_output_chars: 150,
    include_line_numbers: true
  });
  assert.equal(fileByChars.ok, true);
  assert.equal(fileByChars.skill.file.content_read.mode, 'char_range');
  assert.equal(fileByChars.skill.file.content_read.skip_chars, 200);
  assert.equal(fileByChars.skill.file.content_read.max_output_chars, undefined);
  assert.equal(fileByChars.skill.file.content.length > 150, true);
  assert.equal(fileByChars.skill.file.content_read.has_more_after_range, false);
  assert.match(fileByChars.skill.file.numbered_content, /^\d+ \| /m);
});

test('list_files/search_files 支持单 skill 与全局搜索闭环', async () => {
  const { createSkillManager } = await loadSkillManagerModule();

  const manager = createSkillManager({
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
      },
      {
        ...buildLongSkillInput('long-dom-probe'),
        created_at: '2026-01-05T00:00:00.000Z',
        updated_at: '2026-01-06T00:00:00.000Z',
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

  const filteredFiles = await manager.executeRegistryAction({
    action: 'list_files',
    skill_name: 'dom-probe',
    path_glob: 'src'
  });
  assert.equal(filteredFiles.files.length > 0, true);
  assert.equal(filteredFiles.files.every((file) => file.path.startsWith('src/')), true);

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

  const uncappedSearch = await manager.executeRegistryAction({
    action: 'search_files',
    skill_name: 'long-dom-probe',
    pattern: 'const title',
    max_results: 10
  });
  assert.equal(uncappedSearch.total_matches, 900);
  assert.equal(uncappedSearch.returned_match_count, 900);
  assert.equal(uncappedSearch.truncated, false);

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

  const result = await manager.executeRegistryAction({
    action: 'apply_patch',
    skill_name: 'null-tab-file-action',
    patch: [
      '*** Begin Patch',
      '*** Add File: local/说明.md',
      '+普通 Skill 文件。',
      '*** End Patch'
    ].join('\n')
  }, { tabId: null });

  assert.equal(result.ok, true);
  assert.equal(result.refreshed_current_document, false);
  assert.equal(result.refresh_result, null);
  assert.equal(runtimeExecuteCount, 0);
  const stored = await store.getPackage('null-tab-file-action');
  assert.equal(stored.files.find((file) => file.path === 'local/说明.md')?.content, '普通 Skill 文件。\n');
});
