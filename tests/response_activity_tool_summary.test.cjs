const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadModule() {
  const modulePath = path.resolve(__dirname, '../src/utils/response_activity_tool_summary.js');
  return import(pathToFileURL(modulePath).href);
}

test('skill_registry read_file 摘要会显示技能 action、文件路径和技能名', async () => {
  const {
    buildMicroSkillRegistrySummaryParts,
    buildMicroSkillRegistryPrimaryText,
    getMicroSkillRegistryToolTypeLabel
  } = await loadModule();

  const record = {
    type: 'function_call',
    name: 'skill_registry',
    arguments: JSON.stringify({
      action: 'read_file',
      skill_name: 'dom-probe',
      file_path: 'src/helpers/dom.js'
    })
  };

  const parts = buildMicroSkillRegistrySummaryParts(record);
  assert.deepEqual(parts, {
    action: '读取文件',
    value: 'src/helpers/dom.js',
    valueUrl: '',
    meta: 'dom-probe',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
  assert.equal(buildMicroSkillRegistryPrimaryText(record), '读取文件 src/helpers/dom.js dom-probe');
  assert.equal(getMicroSkillRegistryToolTypeLabel(record), '技能');
});

test('skill_registry apply_patch 摘要会显示首个文件和汇总增删行数', async () => {
  const {
    buildMicroSkillRegistrySummaryParts,
    buildMicroSkillRegistryPrimaryText
  } = await loadModule();

  const record = {
    type: 'function_call',
    name: 'skill_registry',
    arguments: JSON.stringify({
      action: 'apply_patch',
      skill_name: 'dom-probe',
      patch: [
        '*** Begin Patch',
        '*** Update File: src/main.js',
        '@@',
        ' old',
        '+new',
        '-old',
        '*** Add File: references/notes.md',
        '+hello',
        '*** End Patch'
      ].join('\n')
    })
  };

  const parts = buildMicroSkillRegistrySummaryParts(record);
  assert.deepEqual(parts, {
    action: '修改了',
    value: 'src/main.js',
    valueUrl: '',
    meta: '+2 · -1 · 另 1 个文件',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
  assert.equal(buildMicroSkillRegistryPrimaryText(record), '修改了 src/main.js +2 · -1 · 另 1 个文件');
});

test('skill_registry search_files 摘要会优先显示 action、pattern 和技能名', async () => {
  const { buildMicroSkillRegistrySummaryParts } = await loadModule();

  const record = {
    type: 'function_call',
    name: 'skill_registry',
    arguments: JSON.stringify({
      action: 'search_files',
      skill_name: 'dom-probe',
      pattern: 'document.title',
      path_glob: 'src/**/*.js'
    })
  };

  const parts = buildMicroSkillRegistrySummaryParts(record);
  assert.deepEqual(parts, {
    action: '搜索文件',
    value: 'document.title',
    valueUrl: '',
    meta: 'dom-probe · src/**/*.js',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
});

test('skill_registry create_skill 摘要会显示创建模板动作与技能名', async () => {
  const { buildMicroSkillRegistrySummaryParts, buildMicroSkillRegistryPrimaryText } = await loadModule();

  const record = {
    type: 'function_call',
    name: 'skill_registry',
    arguments: JSON.stringify({
      action: 'create_skill',
      skill: {
        name: 'DOM Probe Template',
        description: '读取页面标题和链接',
        match: ['https://*.example.com/*']
      }
    })
  };

  const parts = buildMicroSkillRegistrySummaryParts(record);
  assert.deepEqual(parts, {
    action: '创建技能模板',
    value: 'DOM Probe Template',
    valueUrl: '',
    meta: '',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
  assert.equal(buildMicroSkillRegistryPrimaryText(record), '创建技能模板 DOM Probe Template');
});

test('skill_registry mount_on_current_page 摘要会显示当前页挂载动作与技能名', async () => {
  const { buildMicroSkillRegistrySummaryParts, buildMicroSkillRegistryPrimaryText } = await loadModule();

  const record = {
    type: 'function_call',
    name: 'skill_registry',
    arguments: JSON.stringify({
      action: 'mount_on_current_page',
      skill_name: 'dom-probe'
    })
  };

  const parts = buildMicroSkillRegistrySummaryParts(record);
  assert.deepEqual(parts, {
    action: '挂载到当前页',
    value: 'dom-probe',
    valueUrl: '',
    meta: '',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
  assert.equal(buildMicroSkillRegistryPrimaryText(record), '挂载到当前页 dom-probe');
});
