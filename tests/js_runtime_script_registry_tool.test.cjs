const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadSkillRegistryToolModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/skill/registry_tool.js');
  return import(`${pathToFileURL(filePath).href}?test=${Date.now()}`);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createMockStore() {
  const rows = new Map();
  return {
    async listManifests() {
      return Array.from(rows.values()).map((record) => {
        const { files, ...manifest } = clone(record);
        return {
          ...manifest,
          files_meta: files.map((file) => ({ path: file.path, kind: file.kind }))
        };
      });
    },
    async getManifest(name) {
      const record = rows.get(name);
      if (!record) return null;
      const { files, ...manifest } = clone(record);
      return {
        ...manifest,
        files_meta: files.map((file) => ({ path: file.path, kind: file.kind }))
      };
    },
    async getPackage(name) {
      return clone(rows.get(name) || null);
    },
    async savePackage(record, options = {}) {
      const current = rows.get(record.name) || null;
      const actualRevision = current ? current.revision : null;
      if (Object.prototype.hasOwnProperty.call(options, 'expectedRevision')) {
        const expected = options.expectedRevision;
        if ((expected === null && current) || (expected !== null && expected !== actualRevision)) {
          const error = new Error('revision conflict');
          error.code = 'SKILL_REVISION_CONFLICT';
          error.state_changed = false;
          throw error;
        }
      }
      rows.set(record.name, clone(record));
    },
    async deletePackage(name) {
      rows.delete(name);
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
      default_prompt: null
    },
    match: ['https://*.example.com/*'],
    enabled: true,
    instruction: { path: 'SKILL.md' },
    runtime: { entry_path: 'src/main.js' },
    files: [
      { path: 'SKILL.md', content: '# DOM Probe\n\nUse this skill.\n' },
      {
        path: 'src/main.js',
        content: 'const token = document.title; const again = document.title;\nreturn token;\n'
      },
      { path: 'empty.txt', content: '' }
    ]
  };
}

test('Skill match 规则保持 Chrome/Tampermonkey 风格闭集', async () => {
  const {
    normalizeSkillMatchPatterns,
    skillMatchPatternMatchesUrl
  } = await loadSkillRegistryToolModule();

  assert.deepEqual(
    normalizeSkillMatchPatterns(['https://*.example.com/*', 'https://*.example.com/*']),
    ['https://*.example.com/*']
  );
  assert.equal(
    skillMatchPatternMatchesUrl('https://*.example.com/*', 'https://a.example.com/path?q=1'),
    true
  );
  assert.equal(
    skillMatchPatternMatchesUrl('*://*.example.com/*', 'file:///tmp/a.txt'),
    false
  );
  assert.throws(
    () => normalizeSkillMatchPatterns(['https://exa*mple.com/*']),
    /不支持的 match 规则/
  );
});

test('Skill package 允许空文件并通过单一读取搜索语义访问', async () => {
  const {
    buildSkillFileIndexPayload,
    buildSkillFilePayload,
    buildSkillSummary,
    buildStoredSkillRecord,
    getStoredSkillPackage,
    saveStoredSkillPackage,
    searchSkillFiles
  } = await loadSkillRegistryToolModule();

  const store = createMockStore();
  const created = buildStoredSkillRecord(buildSkillInput());
  await saveStoredSkillPackage(created, store, { expectedRevision: null });
  const loaded = await getStoredSkillPackage('dom-probe', store);

  assert.equal(loaded.files.find((file) => file.path === 'empty.txt').content, '');
  assert.equal(buildSkillSummary(loaded).files.total_count, 4);

  const index = buildSkillFileIndexPayload(loaded, {
    requestedSkillName: 'dom-probe',
    path_glob: null
  });
  assert.deepEqual(index.files.map((file) => file.path), [
    'manifest.json',
    'SKILL.md',
    'src/main.js',
    'empty.txt'
  ]);

  const ranged = buildSkillFilePayload(loaded, 'SKILL.md', {
    contentReadArgs: { start_line: 1, end_line: 1 }
  });
  assert.equal(ranged.file.content, '# DOM Probe\n');
  assert.equal(ranged.file.numbered_content, undefined);

  const search = searchSkillFiles(loaded, {
    pattern: 'document.title',
    regex: false,
    ignore_case: false,
    path_glob: 'src/**/*.js',
    context_lines: 0
  });
  assert.equal(search.total_matching_lines, 1);
  assert.equal(search.groups.length, 1);
  assert.equal(search.groups[0].lines.length, 1);
  assert.equal(search.groups[0].lines[0].is_match, true);
});

test('skill_registry 只接受当前生命周期 action 与参数', async () => {
  const {
    buildSkillRegistryFunctionToolDefinition,
    normalizeSkillRegistryToolArguments
  } = await loadSkillRegistryToolModule();

  const definition = buildSkillRegistryFunctionToolDefinition({ exposeHostPageTools: true });
  assert.deepEqual(
    definition.parameters.properties.action.enum,
    ['list', 'create_skill', 'delete_skill', 'enable_skill', 'disable_skill', 'mount_on_current_page']
  );
  assert.doesNotMatch(definition.description, /read_file|apply_patch|update|refresh_current_document/);

  const created = normalizeSkillRegistryToolArguments({
    action: 'create_skill',
    include_all_sites: null,
    skill_name: null,
    skill: {
      name: 'DOM Probe',
      description: '读取页面标题和链接',
      interface: {
        display_name: null,
        short_description: null,
        default_prompt: null
      },
      enabled: null,
      resources: ['references'],
      examples: true
    }
  });
  assert.equal(created.action, 'create_skill');
  assert.equal(created.skill.name, 'dom-probe');
  assert.equal(created.create_mode, undefined);

  assert.deepEqual(
    normalizeSkillRegistryToolArguments({
      action: 'mount_on_current_page',
      include_all_sites: null,
      skill_name: 'dom-probe',
      skill: null
    }),
    {
      action: 'mount_on_current_page',
      skill_name: 'dom-probe',
      skill: null
    }
  );

  for (const action of ['create', 'update', 'read_file', 'list_files', 'search_files', 'apply_patch', 'refresh_current_document']) {
    assert.throws(
      () => normalizeSkillRegistryToolArguments({
        action,
        include_all_sites: null,
        skill_name: null,
        skill: null
      }),
      /不支持的 action/
    );
  }
  assert.throws(
    () => normalizeSkillRegistryToolArguments({
      action: 'create_skill',
      include_all_sites: null,
      skill_name: null,
      skill: {
        name: 'x',
        description: 'x',
        interface: null,
        enabled: null,
        resources: [],
        examples: false,
        files: []
      }
    }),
    /不接受字段 files/
  );
});

test('manifest.json 必须完整、精确且不会回填旧值', async () => {
  const {
    buildSkillFilePayload,
    buildStoredSkillRecord,
    parseSkillVirtualManifestContent
  } = await loadSkillRegistryToolModule();
  const record = buildStoredSkillRecord(buildSkillInput('manifest-probe'));
  const manifest = JSON.parse(buildSkillFilePayload(record, 'manifest.json').file.content);
  manifest.interface.default_prompt = null;
  manifest.runtime.entry_path = null;

  const parsed = parseSkillVirtualManifestContent(JSON.stringify(manifest), record);
  assert.equal(parsed.interface.default_prompt, null);
  assert.equal(parsed.runtime.entry_path, null);

  const missingDescription = { ...manifest };
  delete missingDescription.description;
  assert.throws(
    () => parseSkillVirtualManifestContent(JSON.stringify(missingDescription), record),
    /缺少字段 description/
  );

  assert.throws(
    () => parseSkillVirtualManifestContent(
      JSON.stringify({ ...manifest, legacy_field: true }),
      record
    ),
    /未知字段 legacy_field/
  );

  assert.throws(
    () => buildStoredSkillRecord({
      ...buildSkillInput('missing-runtime'),
      runtime: { entry_path: 'src/missing.js' }
    }),
    /不存在于 files/
  );
});

test('searchSkillFiles 区分大小写并合并重叠上下文', async () => {
  const {
    buildStoredSkillRecord,
    searchSkillFiles
  } = await loadSkillRegistryToolModule();
  const input = buildSkillInput('search-probe');
  input.files[1].content = [
    'before',
    'Token first',
    'token second',
    'after'
  ].join('\n');
  const record = buildStoredSkillRecord(input);

  const sensitive = searchSkillFiles(record, {
    pattern: 'token',
    regex: false,
    ignore_case: false,
    path_glob: 'src/main.js',
    context_lines: 1
  });
  assert.equal(sensitive.total_matching_lines, 1);

  const insensitive = searchSkillFiles(record, {
    pattern: 'token',
    regex: false,
    ignore_case: true,
    path_glob: 'src/main.js',
    context_lines: 1
  });
  assert.equal(insensitive.total_matching_lines, 2);
  assert.equal(insensitive.groups.length, 1);
  assert.deepEqual(
    insensitive.groups[0].lines.map((line) => line.line_number),
    [1, 2, 3, 4]
  );
});
