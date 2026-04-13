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
    /const promptTab = document\.createElement\('div'\);[\s\S]*?promptTab\.dataset\.tab = 'prompt-settings';[\s\S]*?const microSkillsTab = document\.createElement\('div'\);[\s\S]*?microSkillsTab\.textContent = 'Skill 管理';[\s\S]*?microSkillsTab\.dataset\.tab = 'micro-skills';[\s\S]*?const apiTab = document\.createElement\('div'\);[\s\S]*?apiTab\.dataset\.tab = 'api-settings';/s
  );
  assert.match(
    source,
    /tabBar\.appendChild\(historyTab\);\s*tabBar\.appendChild\(promptTab\);\s*tabBar\.appendChild\(microSkillsTab\);\s*tabBar\.appendChild\(apiTab\);/s
  );
  assert.match(
    source,
    /if \(promptSettingsContent\) tabContents\.appendChild\(promptSettingsContent\);\s*tabContents\.appendChild\(microSkillContent\);\s*if \(apiSettingsContent\) tabContents\.appendChild\(apiSettingsContent\);/s
  );
});

test('Esc 面板兼容补齐逻辑会把已有 micro-skills tab 纠正到提示词设置后，并统一文案', async () => {
  const source = await readWorkspaceFile('src/ui/chat_history_ui.js');

  assert.match(source, /function ensureMicroSkillsTabDom\(panel\) \{/);
  assert.match(source, /const moveNodeAfter = \(parent, node, anchor\) => \{/);
  assert.match(source, /microSkillsTab\.textContent = 'Skill 管理';/);
  assert.match(
    source,
    /moveNodeAfter\(\s*tabBar,\s*microSkillsTab,\s*tabBar\.querySelector\('\.history-tab\[data-tab="prompt-settings"\]'\)\s*\|\|\s*tabBar\.querySelector\('\.history-tab\[data-tab="history"\]'\)\s*\);/s
  );
  assert.match(
    source,
    /moveNodeAfter\(\s*tabContents,\s*microSkillContent,\s*tabContents\.querySelector\('\.history-tab-content\[data-tab="prompt-settings"\]'\)\s*\|\|\s*tabContents\.querySelector\('\.history-tab-content\[data-tab="history"\]'\)\s*\);/s
  );
});

test('Skill 查看器标题改为 Skill 管理', async () => {
  const source = await readWorkspaceFile('src/ui/chat_history_ui.js');

  assert.match(source, /title\.textContent = 'Skill 管理';/);
  assert.match(source, /subtitle\.textContent = '查看当前扩展里已注册的浏览器 Skill，点列表查看详情；源码按需加载。';/);
});
