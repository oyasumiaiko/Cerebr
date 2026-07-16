const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('Esc 面板默认会把 Skill 管理 tab 放在提示词设置后面', async () => {
  const source = await readWorkspaceFile('src/ui/chat_history_ui.js');

  assert.match(
    source,
    /const promptTab = document\.createElement\('div'\);[\s\S]*?promptTab\.dataset\.tab = 'prompt-settings';[\s\S]*?const skillsTab = document\.createElement\('div'\);[\s\S]*?skillsTab\.textContent = 'Skill 管理';[\s\S]*?skillsTab\.dataset\.tab = 'skills';[\s\S]*?const apiTab = document\.createElement\('div'\);[\s\S]*?apiTab\.dataset\.tab = 'api-settings';/s
  );
  assert.match(
    source,
    /tabBar\.appendChild\(historyTab\);\s*tabBar\.appendChild\(promptTab\);\s*tabBar\.appendChild\(skillsTab\);\s*tabBar\.appendChild\(apiTab\);/s
  );
  assert.match(
    source,
    /if \(promptSettingsContent\) tabContents\.appendChild\(promptSettingsContent\);\s*tabContents\.appendChild\(skillContent\);\s*if \(apiSettingsContent\) tabContents\.appendChild\(apiSettingsContent\);/s
  );
});

test('Esc 面板兼容补齐逻辑会把已有 skills tab 纠正到提示词设置后，并统一文案', async () => {
  const source = await readWorkspaceFile('src/ui/chat_history_ui.js');

  assert.match(source, /function ensureSkillsTabDom\(panel\) \{/);
  assert.match(source, /const moveNodeAfter = \(parent, node, anchor\) => \{/);
  assert.match(source, /skillsTab\.textContent = 'Skill 管理';/);
  assert.match(
    source,
    /moveNodeAfter\(\s*tabBar,\s*skillsTab,\s*tabBar\.querySelector\('\.history-tab\[data-tab="prompt-settings"\]'\)\s*\|\|\s*tabBar\.querySelector\('\.history-tab\[data-tab="history"\]'\)\s*\);/s
  );
  assert.match(
    source,
    /moveNodeAfter\(\s*tabContents,\s*skillContent,\s*tabContents\.querySelector\('\.history-tab-content\[data-tab="prompt-settings"\]'\)\s*\|\|\s*tabContents\.querySelector\('\.history-tab-content\[data-tab="history"\]'\)\s*\);/s
  );
});

test('Skill 查看器标题改为 Skill 管理', async () => {
  const source = await readWorkspaceFile('src/ui/chat_history_ui.js');

  assert.match(source, /title\.textContent = 'Skill 管理';/);
  assert.match(source, /subtitle\.textContent = '查看当前扩展里已注册的浏览器 Skill，点列表查看详情；源码按需加载。';/);
});

test('Skill 查看器按公开 virtual_file 契约读取 skill 文件', async () => {
  const source = await readWorkspaceFile('src/ui/chat_history_ui.js');

  assert.match(
    source,
    /executeSkillViewerFileAction\('read_file', \{\s*target: \{ kind: 'skill', name: skillName \},\s*path: file\.path\s*\}\)/s
  );
  assert.match(
    source,
    /executeSkillViewerFileAction\('read_file', \{\s*target: \{ kind: 'skill', name: skillName \},\s*path: summary\?\.instruction\?\.path \|\| 'SKILL\.md'\s*\}\)/s
  );
});
