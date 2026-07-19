const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readRepoFile(relativePath) {
  return await fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

test('USER_SCRIPT world 只通过专用消息入口请求当前 frame 的单 skill 自动挂载', async () => {
  const [backgroundSource, managerSource, runtimeSource] = await Promise.all([
    readRepoFile('src/extension/background.js'),
    readRepoFile('src/extension/skill_manager.js'),
    readRepoFile('src/extension/skill_runtime.js')
  ]);

  assert.match(runtimeSource, /CEREBR_SKILL_AUTO_MOUNT_MESSAGE_TYPE/);
  assert.match(runtimeSource, /runtimeApi\.sendMessage\(\{/);
  assert.match(runtimeSource, /autoMountPromises/);
  assert.match(backgroundSource, /runtime\.onUserScriptMessage\.addListener/);
  assert.match(backgroundSource, /message\?\.type !== CEREBR_SKILL_AUTO_MOUNT_MESSAGE_TYPE/);
  assert.match(backgroundSource, /skillManager\.mountSkillOnCurrentPage\(skillName/);
  assert.match(backgroundSource, /documentIds: documentId \? \[documentId\] : null/);
  assert.match(backgroundSource, /frameIds: !documentId && Number\.isFinite\(frameId\).*\[frameId\]/s);
  assert.doesNotMatch(managerSource, /currentPageMountPromises/);
  assert.match(managerSource, /documentIds: Array\.isArray\(options\?\.documentIds\)/);
  assert.match(managerSource, /frameIds: Array\.isArray\(options\?\.frameIds\)/);
});
