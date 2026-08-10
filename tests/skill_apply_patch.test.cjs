const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadSkillApplyPatchModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/skill/skill_apply_patch.js');
  return import(`${pathToFileURL(filePath).href}?test=${Date.now()}`);
}

async function loadSkillRegistryToolModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/skill/registry_tool.js');
  return import(`${pathToFileURL(filePath).href}?test=${Date.now()}`);
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
        content: '# DOM Probe\n\n在需要读取页面基础信息时使用。\n'
      },
      {
        path: 'src/main.js',
        content: 'const helpers = await require("./helpers/dom.js");\nreturn { read() { return { title: helpers.readTitle(), href: location.href }; } };\n'
      },
      {
        path: 'src/helpers/dom.js',
        content: 'module.exports = { readTitle() { return document.title; } };\n'
      }
    ]
  };
}

function wrapPatch(body) {
  return `*** Begin Patch\n${body}\n*** End Patch`;
}

test('seekSequence 与 Codex 一样按 exact/rstrip/trim/宽松 Unicode 逐级匹配', async () => {
  const { seekSequence } = await loadSkillApplyPatchModule();

  assert.equal(seekSequence(['foo', 'bar', 'baz'], ['bar', 'baz'], 0, false), 1);
  assert.equal(seekSequence(['foo   ', 'bar\t\t'], ['foo', 'bar'], 0, false), 0);
  assert.equal(seekSequence(['   foo   ', '  bar\t'], ['foo', 'bar'], 0, false), 0);
  assert.equal(seekSequence(['just one line'], ['too', 'many', 'lines'], 0, false), null);
  assert.equal(
    seekSequence(
      ['import asyncio  # local import \u2013 avoids top\u2011level dep'],
      ['import asyncio  # local import - avoids top-level dep'],
      0,
      false
    ),
    0
  );
});

test('parseSkillApplyPatch 只解析与 Codex Freeform grammar 对齐的标准 patch', async () => {
  const { parseSkillApplyPatch } = await loadSkillApplyPatchModule();

  assert.throws(
    () => parseSkillApplyPatch('bad'),
    /The first line of the patch must be '\*\*\* Begin Patch'/
  );
  assert.throws(
    () => parseSkillApplyPatch('*** Begin Patch\nbad'),
    /'bad' is not a valid hunk header/
  );

  const parsed = parseSkillApplyPatch(wrapPatch(
    [
      '*** Add File: src/helpers/url.js',
      '+module.exports = { readUrl() { return location.href; } };',
      '*** Delete File: src/helpers/obsolete.js',
      '*** Update File: src/main.js',
      '*** Move to: src/runtime/main.js',
      '@@',
      '-return { read() { return { title: helpers.readTitle(), href: location.href }; } };',
      '+return { read() { return { title: helpers.readTitle(), href: helpers.readUrl() }; } };'
    ].join('\n')
  ));

  assert.equal(parsed.hunks.length, 3);
  assert.deepEqual(parsed.hunks[0], {
    type: 'add_file',
    path: 'src/helpers/url.js',
    contents: 'module.exports = { readUrl() { return location.href; } };\n'
  });
  assert.equal(parsed.hunks[2].move_path, 'src/runtime/main.js');

  assert.throws(
    () => parseSkillApplyPatch(`<<'EOF'\n${wrapPatch('*** Add File: foo.js\n+hi')}\nEOF\n`, {
      mode: 'lenient'
    }),
    /Unsupported apply_patch parser mode: lenient/
  );
});

test('applySkillPackagePatch 可以新增虚拟文件且用途由路径自动推断', async () => {
  const { buildStoredSkillRecord, buildSkillFilePayload } = await loadSkillRegistryToolModule();
  const { applySkillPackagePatch } = await loadSkillApplyPatchModule();

  const record = buildStoredSkillRecord(buildSkillInput());
  const result = applySkillPackagePatch(record, wrapPatch(
    [
      '*** Add File: src/runtime/new-main.js',
      '+module.exports = { read() { return location.href; } };'
    ].join('\n')
  ));

  assert.deepEqual(result.affected_files, {
    added: ['src/runtime/new-main.js'],
    modified: [],
    deleted: []
  });
  assert.equal(
    buildSkillFilePayload(result.record, 'src/runtime/new-main.js').file.kind,
    'runtime_source'
  );
  assert.equal(result.record.runtime.entry_path, 'src/main.js');
});

test('applySkillPackagePatch 可以删除、修改、移动文件并保持指针自洽', async () => {
  const { buildStoredSkillRecord, buildSkillFilePayload } = await loadSkillRegistryToolModule();
  const { applySkillPackagePatch } = await loadSkillApplyPatchModule();

  const record = buildStoredSkillRecord(buildSkillInput());
  const result = applySkillPackagePatch(record, wrapPatch(
    [
      '*** Update File: src/main.js',
      '*** Move to: src/runtime/main.js',
      '@@',
      ' const helpers = await require("./helpers/dom.js");',
      '-return { read() { return { title: helpers.readTitle(), href: location.href }; } };',
      '+return { read() { return { title: helpers.readTitle(), href: helpers.readUrl() }; } };',
      '*** Update File: src/helpers/dom.js',
      '@@',
      '-module.exports = { readTitle() { return document.title; } };',
      '+module.exports = { readTitle() { return document.title.trim(); } };'
    ].join('\n')
  ));

  assert.equal(result.record.runtime.entry_path, 'src/runtime/main.js');
  assert.equal(
    buildSkillFilePayload(result.record, 'src/runtime/main.js').file.is_runtime_entry,
    true
  );
  assert.match(
    buildSkillFilePayload(result.record, 'src/helpers/dom.js').file.content,
    /trim/
  );
  assert.deepEqual(result.affected_files, {
    added: [],
    modified: ['src/runtime/main.js', 'src/helpers/dom.js'],
    deleted: []
  });
});

test('skill 根中的 local 目录和 Unicode 路径使用普通可写文件语义', async () => {
  const { buildStoredSkillRecord, buildSkillFilePayload } = await loadSkillRegistryToolModule();
  const { applySkillPackagePatch } = await loadSkillApplyPatchModule();
  const record = buildStoredSkillRecord(buildSkillInput());
  const result = applySkillPackagePatch(record, wrapPatch([
    '*** Add File: local/说明 文档.md',
    '+# Skill local directory'
  ].join('\n')));

  assert.equal(
    buildSkillFilePayload(result.record, 'local/说明 文档.md').file.content,
    '# Skill local directory\n'
  );
  assert.deepEqual(result.affected_files.added, ['local/说明 文档.md']);
});

test('skill Add 与 Move 对同名目标使用和会话区一致的覆盖语义', async () => {
  const { buildStoredSkillRecord, buildSkillFilePayload } = await loadSkillRegistryToolModule();
  const { applySkillPackagePatch } = await loadSkillApplyPatchModule();
  const input = buildSkillInput();
  input.files.push({ path: 'references/target.md', content: 'old target\n' });
  const record = buildStoredSkillRecord(input);

  const added = applySkillPackagePatch(record, wrapPatch([
    '*** Add File: references/target.md',
    '+new add target'
  ].join('\n')));
  assert.equal(
    buildSkillFilePayload(added.record, 'references/target.md').file.content,
    'new add target\n'
  );
  assert.deepEqual(added.affected_files.modified, ['references/target.md']);

  const moved = applySkillPackagePatch(record, wrapPatch([
    '*** Update File: src/helpers/dom.js',
    '*** Move to: references/target.md',
    '@@',
    '-module.exports = { readTitle() { return document.title; } };',
    '+moved content'
  ].join('\n')));
  assert.equal(moved.record.files.some(file => file.path === 'src/helpers/dom.js'), false);
  assert.equal(
    buildSkillFilePayload(moved.record, 'references/target.md').file.content,
    'moved content\n'
  );
});

test('applySkillPackagePatch 支持直接 patch manifest.json', async () => {
  const { buildStoredSkillRecord, buildSkillFilePayload } = await loadSkillRegistryToolModule();
  const { applySkillPackagePatch } = await loadSkillApplyPatchModule();

  const record = buildStoredSkillRecord(buildSkillInput());
  const result = applySkillPackagePatch(record, wrapPatch(
    [
      '*** Update File: manifest.json',
      '@@',
      '-  "description": "读取页面标题和链接",',
      '+  "description": "读取页面标题、链接与路径信息",',
      '@@',
      '-  "enabled": true,',
      '+  "enabled": false,'
    ].join('\n')
  ));

  assert.equal(result.record.enabled, false);
  assert.equal(result.record.description, '读取页面标题、链接与路径信息');
  assert.equal(
    buildSkillFilePayload(result.record, 'manifest.json').file.is_manifest,
    true
  );
  assert.deepEqual(result.affected_files, {
    added: [],
    modified: ['manifest.json'],
    deleted: []
  });
});

test('applySkillPackagePatch 会复现 Codex 的多 chunk、交错修改与 EOF 追加行为', async () => {
  const { buildStoredSkillRecord, buildSkillFilePayload } = await loadSkillRegistryToolModule();
  const { applySkillPackagePatch } = await loadSkillApplyPatchModule();

  const record = buildStoredSkillRecord({
    ...buildSkillInput('multi-edit'),
    runtime: { entry_path: 'src/runtime/demo.js' },
    files: [
      {
        path: 'SKILL.md',
        kind: 'instruction',
        content: '# Multi Edit\n'
      },
      {
        path: 'src/runtime/demo.js',
        kind: 'runtime_source',
        content: 'a\nb\nc\nd\ne\nf\n'
      }
    ]
  });

  const result = applySkillPackagePatch(record, wrapPatch(
    [
      '*** Update File: src/runtime/demo.js',
      '@@',
      ' a',
      '-b',
      '+B',
      '@@',
      ' c',
      ' d',
      '-e',
      '+E',
      '@@',
      ' f',
      '+g',
      '*** End of File'
    ].join('\n')
  ));

  assert.equal(
    buildSkillFilePayload(result.record, 'src/runtime/demo.js').file.content,
    'a\nB\nc\nd\nE\nf\ng\n'
  );
});

test('applySkillPackagePatch 会保留 Codex 的纯追加 chunk 与 Unicode 宽松匹配', async () => {
  const { buildStoredSkillRecord, buildSkillFilePayload } = await loadSkillRegistryToolModule();
  const { applySkillPackagePatch } = await loadSkillApplyPatchModule();

  const additionRecord = buildStoredSkillRecord({
    ...buildSkillInput('pure-add'),
    files: [
      {
        path: 'SKILL.md',
        kind: 'instruction',
        content: '# Pure Add\n'
      },
      {
        path: 'src/main.js',
        kind: 'runtime_source',
        content: 'line1\nline2\nline3\n'
      }
    ]
  });
  const additionResult = applySkillPackagePatch(additionRecord, wrapPatch(
    [
      '*** Update File: src/main.js',
      '@@',
      '+after-context',
      '+second-line',
      '@@',
      ' line1',
      '-line2',
      '-line3',
      '+line2-replacement'
    ].join('\n')
  ));
  assert.equal(
    buildSkillFilePayload(additionResult.record, 'src/main.js').file.content,
    'line1\nline2-replacement\nafter-context\nsecond-line\n'
  );

  const unicodeRecord = buildStoredSkillRecord({
    ...buildSkillInput('unicode-edit'),
    files: [
      {
        path: 'SKILL.md',
        kind: 'instruction',
        content: '# Unicode\n'
      },
      {
        path: 'src/main.js',
        kind: 'runtime_source',
        content: 'import asyncio  # local import \u2013 avoids top\u2011level dep\n'
      }
    ]
  });
  const unicodeResult = applySkillPackagePatch(unicodeRecord, wrapPatch(
    [
      '*** Update File: src/main.js',
      '@@',
      '-import asyncio  # local import - avoids top-level dep',
      '+import asyncio  # HELLO'
    ].join('\n')
  ));
  assert.equal(
    buildSkillFilePayload(unicodeResult.record, 'src/main.js').file.content,
    'import asyncio  # HELLO\n'
  );
});

test('applySkillPackagePatch 会对虚拟文件特有的错误场景给出明确失败', async () => {
  const { buildStoredSkillRecord, buildSkillFilePayload } = await loadSkillRegistryToolModule();
  const { applySkillPackagePatch } = await loadSkillApplyPatchModule();

  const record = buildStoredSkillRecord(buildSkillInput());
  const originalRecordSnapshot = JSON.stringify(record);

  assert.throws(
    () => applySkillPackagePatch(record, wrapPatch([
      '*** Update File: src/helpers/dom.js',
      '@@',
      '-module.exports = { readTitle() { return document.title; } };',
      '+first hunk changed',
      '*** Update File: src/main.js',
      '@@',
      '-missing context',
      '+second hunk changed'
    ].join('\n'))),
    /Failed to find expected lines in src\/main\.js/
  );
  assert.equal(JSON.stringify(record), originalRecordSnapshot);

  const addedReference = applySkillPackagePatch(record, wrapPatch(
    [
      '*** Add File: references/notes.md',
      '+# Notes'
    ].join('\n')
  ));
  assert.equal(
    buildSkillFilePayload(addedReference.record, 'references/notes.md').file.kind,
    'reference'
  );

  assert.throws(
    () => applySkillPackagePatch(record, wrapPatch(
      [
        '*** Add File: manifest.json',
        '+{}'
      ].join('\n')
    )),
    /manifest\.json 是保留虚拟文件，不支持 Add File/
  );

  assert.throws(
    () => applySkillPackagePatch(record, wrapPatch(
      [
        '*** Delete File: manifest.json'
      ].join('\n')
    )),
    /manifest\.json 是保留虚拟文件，不支持 Delete File/
  );

  assert.throws(
    () => applySkillPackagePatch(record, wrapPatch(
      [
        '*** Update File: manifest.json',
        '*** Move to: other.json',
        '@@',
        '-  "enabled": true,',
        '+  "enabled": false,'
      ].join('\n')
    )),
    /manifest\.json 是保留虚拟文件，不支持 Move to/
  );

  assert.throws(
    () => applySkillPackagePatch(record, wrapPatch(
      [
        '*** Update File: src/helpers/dom.js',
        '*** Move to: manifest.json',
        '@@',
        '-module.exports = { readTitle() { return document.title; } };',
        '+moved into manifest'
      ].join('\n')
    )),
    /manifest\.json 是保留虚拟文件，不支持 Move to/
  );

  assert.throws(
    () => applySkillPackagePatch(record, wrapPatch(
      [
        '*** Add File: ../escape.js',
        '+oops'
      ].join('\n')
    )),
    /不能包含空段、"\." 或 "\.\."/
  );

  assert.throws(
    () => applySkillPackagePatch(record, wrapPatch(
      [
        '*** Delete File: missing.js'
      ].join('\n')
    )),
    /Failed to delete file missing\.js/
  );
});
