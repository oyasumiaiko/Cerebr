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
  const instructionLines = Array.from({ length: 40 }, (_, index) => `Line ${index + 1}: ${'A'.repeat(400)}`);
  const instructionContent = `# Long DOM Probe\n\n${instructionLines.join('\n')}\n`;
  const runtimeContent = `${'const value = "x";\n'.repeat(800)}return { read() { return value; } };`;
  return {
    ...buildSkillInput(name),
    files: [
      {
        path: 'SKILL.md',
        content: instructionContent
      },
      {
        path: 'src/main.js',
        content: runtimeContent
      },
      {
        path: 'src/helpers/dom.js',
        content: 'module.exports = { readTitle() { return document.title; } };'
      }
    ]
  };
}

test('normalizeSkillMatchPatterns 与 URL 匹配遵循第一阶段 Chrome/TM 风格约束', async () => {
  const {
    normalizeSkillMatchPatterns,
    skillMatchPatternMatchesUrl
  } = await loadSkillRegistryToolModule();

  assert.deepEqual(
    normalizeSkillMatchPatterns(['https://*.example.com/*', 'file:///*']),
    ['https://*.example.com/*', 'file:///*']
  );

  assert.equal(
    skillMatchPatternMatchesUrl('https://*.example.com/*', 'https://a.example.com/path?q=1'),
    true
  );
  assert.equal(
    skillMatchPatternMatchesUrl('https://*.example.com/*', 'https://example.com/root'),
    true
  );
  assert.equal(
    skillMatchPatternMatchesUrl('*://*.example.com/*', 'http://b.example.com/path'),
    true
  );
  assert.equal(
    skillMatchPatternMatchesUrl('*://*.example.com/*', 'https://b.example.com/path'),
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

test('buildStoredSkillRecord / saveStoredSkillPackage / getStoredSkillPackage 保持 package 结构与渐进式披露边界', async () => {
  const {
    buildSkillDetail,
    buildSkillFileIndexPayload,
    buildSkillFilePayload,
    buildSkillPackagePayload,
    buildSkillSummary,
    buildStoredSkillRecord,
    getStoredSkillPackage,
    searchSkillFiles,
    saveStoredSkillPackage
  } = await loadSkillRegistryToolModule();

  const store = createMockStore();
  const created = buildStoredSkillRecord(buildSkillInput());

  assert.equal(created.revision, 1);
  assert.equal(created.interface.display_name, 'DOM Probe');
  assert.equal(created.instruction.path, 'SKILL.md');
  assert.equal(created.runtime.entry_path, 'src/main.js');
  assert.equal(created.files.length, 3);

  await saveStoredSkillPackage(created, store);
  const loaded = await getStoredSkillPackage('dom-probe', store);
  assert.equal(loaded.name, 'dom-probe');

  const summary = buildSkillSummary(loaded);
  assert.equal(summary.interface.short_description, '读取当前页面标题和 URL');
  assert.equal(summary.files.total_count, 4);

  const detail = buildSkillDetail(loaded);
  assert.equal(detail.instruction.path, 'SKILL.md');
  assert.match(detail.instruction.content, /DOM Probe/);
  assert.equal(detail.instruction.content_read.mode, 'preview');
  assert.equal(detail.files.virtual_manifest_path, 'manifest.json');
  assert.equal(detail.files.files[0].path, 'manifest.json');
  assert.equal(detail.files.files[0].content, undefined);

  const source = buildSkillPackagePayload(loaded);
  assert.equal(source.manifest_path, 'manifest.json');
  assert.equal(source.runtime.entry_path, 'src/main.js');
  assert.equal(source.files.files.length, 4);
  assert.match(source.files.files[0].content, /"instruction"/);
  assert.match(source.files.files[3].content, /document\.title/);

  const manifestFile = buildSkillFilePayload(loaded, 'manifest.json');
  assert.equal(manifestFile.file.path, 'manifest.json');
  assert.equal(manifestFile.file.is_manifest, true);
  assert.equal(manifestFile.file.content_read.mode, 'preview');
  assert.doesNotMatch(manifestFile.file.content, /"name":/);
  assert.doesNotMatch(manifestFile.file.content, /"kind":/);
  assert.match(manifestFile.file.content, /"description": "读取页面标题和链接"/);

  const fileIndex = buildSkillFileIndexPayload(loaded, {
    requestedSkillName: 'dom-probe'
  });
  assert.equal(fileIndex.total_files, 4);
  assert.equal(fileIndex.files[0].skill_name, 'dom-probe');
  assert.equal(fileIndex.files[0].path, 'manifest.json');
  assert.equal(fileIndex.files[0].is_manifest, true);

  const instructionFile = buildSkillFilePayload(loaded, 'SKILL.md');
  assert.equal(instructionFile.has_runtime, true);
  assert.equal(instructionFile.runtime_entry_path, 'src/main.js');
  assert.equal(instructionFile.runtime_file_count, 2);
  assert.match(instructionFile.runtime_hint, /Read SKILL\.md first/);
  assert.match(instructionFile.runtime_hint, /js_runtime_execute/);

  const searchResult = searchSkillFiles(loaded, {
    requestedSkillName: 'dom-probe',
    pattern: 'readTitle'
  });
  assert.equal(searchResult.total_matches, 2);
  assert.equal(searchResult.matches[0].skill_name, 'dom-probe');
  assert.equal(searchResult.matches[0].file_path, 'src/main.js');
  assert.equal(searchResult.matches[0].line_number, 1);
  assert.equal(searchResult.matches[0].column_start > 0, true);
  assert.equal(searchResult.matches[0].column_end >= searchResult.matches[0].column_start, true);
  assert.match(searchResult.matches[0].line_text, /readTitle/);

  assert.equal(store.dump().length, 1);
});

test('normalizeSkillRegistryToolArguments 会收敛为新的 package/file action 集', async () => {
  const {
    SKILL_REGISTRY_TOOL_NAME,
    buildSkillRegistryFunctionToolDefinition,
    normalizeSkillRegistryToolArguments
  } = await loadSkillRegistryToolModule();

  const definition = buildSkillRegistryFunctionToolDefinition();
  assert.equal(definition.name, SKILL_REGISTRY_TOOL_NAME);
  assert.match(definition.parameters.properties.action.description, /create_skill/);
  assert.match(definition.parameters.properties.action.description, /mount_on_current_page/);
  assert.doesNotMatch(definition.parameters.properties.action.description, /read_file/);
  assert.doesNotMatch(definition.parameters.properties.action.description, /apply_patch/);
  assert.equal(definition.parameters.properties.skill.required.includes('name'), true);
  assert.equal(definition.parameters.properties.skill.required.includes('match'), false);
  assert.equal(definition.parameters.properties.skill.properties.resources.items.enum.includes('references'), true);

  const normalizedCreate = normalizeSkillRegistryToolArguments({
    action: 'create',
    skill: buildCreateTemplateInput()
  });
  assert.equal(normalizedCreate.original_action, 'create');
  assert.equal(normalizedCreate.action, 'create_skill');
  assert.equal(normalizedCreate.create_mode, 'template');
  assert.equal(normalizedCreate.deprecated_compat_action, false);
  assert.equal(normalizedCreate.skill.requested_name, 'DOM Probe');
  assert.equal(normalizedCreate.skill.name, 'dom-probe');
  assert.equal(normalizedCreate.skill.interface.display_name, 'Dom Probe');
  assert.deepEqual(normalizedCreate.skill.match, []);
  assert.equal(normalizedCreate.skill.enabled, false);
  assert.deepEqual(normalizedCreate.skill.resources, ['references']);
  assert.equal(normalizedCreate.skill.examples, true);

  const normalizedCompatCreate = normalizeSkillRegistryToolArguments({
    action: 'create_skill',
    skill: buildSkillInput()
  });
  assert.equal(normalizedCompatCreate.create_mode, 'package_compat');
  assert.equal(normalizedCompatCreate.deprecated_compat_action, true);
  assert.equal(normalizedCompatCreate.skill.instruction.path, 'SKILL.md');
  assert.equal(normalizedCompatCreate.skill.files.length, 3);

  const normalizedListFiles = normalizeSkillRegistryToolArguments({
    action: 'list_files',
    skill_name: 'dom-probe'
  });
  assert.equal(normalizedListFiles.original_action, 'list_files');
  assert.equal(normalizedListFiles.action, 'list_files');
  assert.equal(normalizedListFiles.skill_name, 'dom-probe');
  assert.equal(normalizedListFiles.deprecated_compat_action, true);

  const normalizedSearchFiles = normalizeSkillRegistryToolArguments({
    action: 'search_files',
    pattern: 'document.title',
    context_before: 1,
    context_after: 2,
    path_glob: 'src/**/*.js',
    max_results: 5
  });
  assert.deepEqual(normalizedSearchFiles, {
    original_action: 'search_files',
    action: 'search_files',
    skill_name: null,
    skill: null,
    file_path: null,
    file: null,
    patch: null,
    pattern: 'document.title',
    regex: false,
    case_mode: 'smart',
    path_glob: 'src/**/*.js',
    context_before: 1,
    context_after: 2,
    max_results: 5,
    read_options: null,
    include_line_numbers: false,
    deprecated_compat_action: true,
    next_instruction_path: null,
    next_runtime_entry_path: null
  });

  const normalizedReadFile = normalizeSkillRegistryToolArguments({
    action: 'read_file',
    skill_name: 'dom-probe',
    file_path: './src/helpers/dom.js',
    include_line_numbers: true
  });
  assert.deepEqual(normalizedReadFile, {
    original_action: 'read_file',
    action: 'read_file',
    skill_name: 'dom-probe',
    skill: null,
    file_path: 'src/helpers/dom.js',
    file: null,
    patch: null,
    pattern: null,
    regex: false,
    case_mode: 'smart',
    path_glob: null,
    context_before: 0,
    context_after: 0,
    max_results: 50,
    read_options: {
      mode: 'preview',
      skip_chars: 0,
      max_chars: 10000,
      start_line: null,
      end_line: null
    },
    include_line_numbers: true,
    deprecated_compat_action: true,
    next_instruction_path: null,
    next_runtime_entry_path: null
  });

  assert.throws(
    () => normalizeSkillRegistryToolArguments({
      action: 'write_file',
      skill_name: 'dom-probe',
      file: {
        path: 'src/runtime/new-main.js',
        content: 'module.exports = { read() { return document.title; } };'
      }
    }),
    /不支持的 action `write_file`/
  );

  assert.throws(
    () => normalizeSkillRegistryToolArguments({
      action: 'read_source_file',
      skill_name: 'dom-probe',
      file_path: 'src/helpers/dom.js'
    }),
    /不支持的 action `read_source_file`/
  );

  assert.throws(
    () => normalizeSkillRegistryToolArguments({
      action: 'create_skill',
      skill: {
        ...buildCreateTemplateInput('Need Examples'),
        resources: [],
        examples: true
      }
    }),
    /examples=true 时必须同时提供/
  );

  const normalizedApplyPatch = normalizeSkillRegistryToolArguments({
    action: 'apply_patch',
    skill_name: 'dom-probe',
    patch: '*** Begin Patch\n*** Update File: src/main.js\n@@\n-old\n+new\n*** End Patch'
  });
  assert.deepEqual(normalizedApplyPatch, {
    original_action: 'apply_patch',
    action: 'apply_patch',
    skill_name: 'dom-probe',
    skill: null,
    file_path: null,
    file: null,
    patch: '*** Begin Patch\n*** Update File: src/main.js\n@@\n-old\n+new\n*** End Patch',
    pattern: null,
    regex: false,
    case_mode: 'smart',
    path_glob: null,
    context_before: 0,
    context_after: 0,
    max_results: 50,
    read_options: null,
    include_line_numbers: false,
    deprecated_compat_action: true,
    next_instruction_path: null,
    next_runtime_entry_path: null
  });

  const normalizedMount = normalizeSkillRegistryToolArguments({
    action: 'mount_on_current_page',
    skill_name: 'dom-probe'
  });
  assert.deepEqual(normalizedMount, {
    original_action: 'mount_on_current_page',
    action: 'mount_on_current_page',
    skill_name: 'dom-probe',
    skill: null,
    file_path: null,
    file: null,
    patch: null,
    pattern: null,
    regex: false,
    case_mode: 'smart',
    path_glob: null,
    context_before: 0,
    context_after: 0,
    max_results: 50,
    read_options: null,
    include_line_numbers: false,
    deprecated_compat_action: false,
    next_instruction_path: null,
    next_runtime_entry_path: null
  });
});

test('skill 读取参数支持字符偏移与按行续读', async () => {
  const {
    buildSkillDetail,
    buildSkillFilePayload,
    buildStoredSkillRecord,
    normalizeSkillRegistryToolArguments
  } = await loadSkillRegistryToolModule();

  const record = buildStoredSkillRecord(buildLongSkillInput());

  const normalizedReadDetail = normalizeSkillRegistryToolArguments({
    action: 'read_detail',
    skill_name: 'long-dom-probe',
    start_line: 3,
    end_line: 5
  });
  assert.deepEqual(normalizedReadDetail.read_options, {
    mode: 'line_range',
    skip_chars: null,
    max_chars: null,
    start_line: 3,
    end_line: 5
  });

  const normalizedReadFile = normalizeSkillRegistryToolArguments({
    action: 'read_file',
    skill_name: 'long-dom-probe',
    file_path: 'src/main.js',
    skip_chars: 120,
    max_chars: 200
  });
  assert.deepEqual(normalizedReadFile.read_options, {
    mode: 'char_range',
    skip_chars: 120,
    max_chars: 200,
    start_line: null,
    end_line: null
  });

  const detailByLine = buildSkillDetail(record, {
    contentReadArgs: normalizedReadDetail.read_options
  });
  assert.equal(detailByLine.instruction.content_read.mode, 'line_range');
  assert.equal(detailByLine.instruction.content_read.start_line, 3);
  assert.equal(detailByLine.instruction.content_read.end_line, 5);
  assert.match(detailByLine.instruction.content, /^Line 1:/m);
  assert.doesNotMatch(detailByLine.instruction.content, /^Line 4:/m);
  assert.equal(detailByLine.instruction.content_read.has_more_after_range, true);

  const fileByChars = buildSkillFilePayload(record, 'src/main.js', {
    contentReadArgs: normalizedReadFile.read_options
  });
  assert.equal(fileByChars.file.content_read.mode, 'char_range');
  assert.equal(fileByChars.file.content_read.skip_chars, 120);
  assert.equal(fileByChars.file.content_read.max_chars, 200);
  assert.equal(fileByChars.file.content.length, 200);
  assert.equal(fileByChars.file.content_read.has_more_after_range, true);

  const numberedDetail = buildSkillDetail(record, {
    contentReadArgs: normalizedReadDetail.read_options,
    includeLineNumbers: true
  });
  assert.match(numberedDetail.instruction.numbered_content, /^3 \| Line 1:/m);

  const numberedFile = buildSkillFilePayload(record, 'src/main.js', {
    contentReadArgs: normalizedReadFile.read_options,
    includeLineNumbers: true
  });
  assert.match(numberedFile.file.numbered_content, /^\d+ \| /m);

  assert.throws(
    () => normalizeSkillRegistryToolArguments({
      action: 'read_file',
      skill_name: 'long-dom-probe',
      file_path: 'src/main.js',
      skip_chars: 10,
      start_line: 1,
      end_line: 2
    }),
    /不能同时使用字符区间和行区间/
  );

  const globalSearch = (await loadSkillRegistryToolModule()).searchSkillFiles([
    record,
    buildStoredSkillRecord(buildSkillInput('dom-probe-2'))
  ], {
    pattern: 'readTitle',
    path_glob: 'src/**/*.js',
    max_results: 10
  });
  assert.equal(globalSearch.total_matches >= 3, true);
  assert.equal(globalSearch.matches.every((item) => item.file_path.startsWith('src/')), true);
});

test('buildSkillContextSummary 会返回官方风格的最小 skill 摘要', async () => {
  const {
    buildDefaultSkillMountContract,
    buildSkillContextSummary,
    buildStoredSkillRecord
  } = await loadSkillRegistryToolModule();

  const record = buildStoredSkillRecord(buildSkillInput());
  const summary = buildSkillContextSummary(record);
  const contract = buildDefaultSkillMountContract();

  assert.equal(summary.name, 'dom-probe');
  assert.equal(summary.short_description, '读取当前页面标题和 URL');
  assert.equal(summary.instruction_path, 'SKILL.md');
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'display_name'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'mount_surface'), false);
  assert.match(contract, /Recommended helpers: `globalThis\.\$skill\(name\)`, `globalThis\.\$invoke\(skillName, methodName, \.\.\.args\)`, `globalThis\.\$methods\(name\)`\./);
  assert.match(contract, /Compatibility runtime registry: `globalThis\.__cerebrSkills`\./);
});

test('searchSkillFiles 支持 regex、smart case、路径过滤与上下文行', async () => {
  const {
    buildStoredSkillRecord,
    searchSkillFiles
  } = await loadSkillRegistryToolModule();

  const record = buildStoredSkillRecord({
    ...buildSkillInput('search-probe'),
    files: [
      {
        path: 'SKILL.md',
        content: '# Search Probe\n\nuse searchFiles here'
      },
      {
        path: 'src/main.js',
        content: [
          'const before = 1;',
          'const SearchFiles = document.title;',
          'const after = document.title;',
          'return { read() { return after; } };'
        ].join('\n')
      },
      {
        path: 'references/notes.md',
        content: 'document.title appears here too'
      }
    ]
  });

  const smartCaseSearch = searchSkillFiles(record, {
    pattern: 'SearchFiles',
    path_glob: 'src/**/*.js',
    context_before: 1,
    context_after: 1
  });
  assert.equal(smartCaseSearch.total_matches, 1);
  assert.equal(smartCaseSearch.case_sensitive, true);
  assert.equal(smartCaseSearch.matches[0].before.length, 1);
  assert.equal(smartCaseSearch.matches[0].after.length, 1);
  assert.equal(smartCaseSearch.matches[0].before[0].line_number, 1);
  assert.equal(smartCaseSearch.matches[0].after[0].line_number, 3);

  const regexSearch = searchSkillFiles(record, {
    pattern: 'document\\.title',
    regex: true,
    path_glob: 'src/**/*.js'
  });
  assert.equal(regexSearch.total_matches, 2);
  assert.equal(regexSearch.matches.every((item) => item.file_path === 'src/main.js'), true);
});
