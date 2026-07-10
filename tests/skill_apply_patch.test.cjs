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
    instruction: { path: 'SKILL.md' },
    runtime: { entry_path: 'src/main.js' },
    files: [
      {
        path: 'SKILL.md',
        content: '# DOM Probe\n\n在需要读取页面基础信息时使用。\n'
      },
      {
        path: 'src/main.js',
        content: 'return { read() { return document.title; } };\n'
      },
      {
        path: 'src/helpers/dom.js',
        content: 'module.exports = { readTitle() { return document.title; } };\n'
      }
    ]
  };
}

test('官方 OpenAI apply_patch operation 对 skill 支持 create/update/delete，并拒绝同名 create', async () => {
  const { buildStoredSkillRecord, buildSkillFilePayload } = await loadSkillRegistryToolModule();
  const { applyOpenAIApplyPatchOperationToSkillPackage } = await loadSkillApplyPatchModule();

  const record = buildStoredSkillRecord(buildSkillInput());
  const created = applyOpenAIApplyPatchOperationToSkillPackage(record, {
    type: 'create_file',
    path: 'references/official.md',
    diff: ['+# Official', '+alpha', '+'].join('\n')
  });
  assert.deepEqual(created.affected_files, {
    added: ['references/official.md'],
    modified: [],
    deleted: []
  });
  assert.equal(
    buildSkillFilePayload(created.record, 'references/official.md').file.content,
    '# Official\nalpha\n'
  );
  assert.equal(
    buildSkillFilePayload(created.record, 'references/official.md').file.kind,
    'reference'
  );

  assert.throws(
    () => applyOpenAIApplyPatchOperationToSkillPackage(created.record, {
      type: 'create_file',
      path: 'references/official.md',
      diff: '+duplicate'
    }),
    /已存在文件 references\/official\.md，无法 create_file/
  );

  const updated = applyOpenAIApplyPatchOperationToSkillPackage(created.record, {
    type: 'update_file',
    path: 'references/official.md',
    diff: [' # Official', '-alpha', '+beta'].join('\n')
  });
  assert.equal(
    buildSkillFilePayload(updated.record, 'references/official.md').file.content,
    '# Official\nbeta\n'
  );

  const deleted = applyOpenAIApplyPatchOperationToSkillPackage(updated.record, {
    type: 'delete_file',
    path: 'references/official.md'
  });
  assert.deepEqual(deleted.affected_files.deleted, ['references/official.md']);
  assert.equal(deleted.record.files.some((file) => file.path === 'references/official.md'), false);
});

test('官方 manifest operation 会保留显式 null，而不是回退到旧 interface/runtime 值', async () => {
  const { buildStoredSkillRecord } = await loadSkillRegistryToolModule();
  const { applyOpenAIApplyPatchOperationToSkillPackage } = await loadSkillApplyPatchModule();

  const record = buildStoredSkillRecord(buildSkillInput());
  const updated = applyOpenAIApplyPatchOperationToSkillPackage(record, {
    type: 'update_file',
    path: 'manifest.json',
    diff: [
      '-    "display_name": "DOM Probe",',
      '-    "short_description": "读取当前页面标题和 URL",',
      '-    "default_prompt": "Read the current page title and URL."',
      '+    "display_name": null,',
      '+    "short_description": null,',
      '+    "default_prompt": null',
      '@@',
      '-    "entry_path": "src/main.js"',
      '+    "entry_path": null'
    ].join('\n')
  });

  assert.deepEqual(updated.record.interface, {
    display_name: null,
    short_description: null,
    default_prompt: null
  });
  assert.equal(updated.record.runtime.entry_path, null);
  assert.equal(updated.record.kind, 'guidance');
});

test('官方 skill operation 保护 manifest、缺失文件和最后一个文件', async () => {
  const { buildStoredSkillRecord } = await loadSkillRegistryToolModule();
  const { applyOpenAIApplyPatchOperationToSkillPackage } = await loadSkillApplyPatchModule();
  const record = buildStoredSkillRecord(buildSkillInput());

  assert.throws(
    () => applyOpenAIApplyPatchOperationToSkillPackage(record, {
      type: 'delete_file',
      path: 'manifest.json'
    }),
    /manifest\.json 是保留虚拟文件，只支持 update_file/
  );
  assert.throws(
    () => applyOpenAIApplyPatchOperationToSkillPackage(record, {
      type: 'update_file',
      path: 'missing.js',
      diff: '-old\n+new'
    }),
    /不存在文件 missing\.js/
  );

  const singleFileRecord = buildStoredSkillRecord({
    ...buildSkillInput('single-file'),
    runtime: { entry_path: null },
    files: [{ path: 'SKILL.md', content: '# Single\n' }]
  });
  assert.throws(
    () => applyOpenAIApplyPatchOperationToSkillPackage(singleFileRecord, {
      type: 'delete_file',
      path: 'SKILL.md'
    }),
    /只剩最后一个文件/
  );
});
