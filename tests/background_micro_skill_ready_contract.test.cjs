const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('ensureMicroSkillManagerReady 在 pending 时复用同一 promise，并在失败后清空缓存以允许重试', async () => {
  const backgroundSource = await readWorkspaceFile('src/extension/background.js');

  assert.match(backgroundSource, /let microSkillManagerReadyPending = false;/);
  assert.match(
    backgroundSource,
    /if \(microSkillManagerReadyPromise && microSkillManagerReadyPending\) \{\s*return microSkillManagerReadyPromise;\s*\}/s
  );
  assert.match(backgroundSource, /microSkillManagerReadyPending = true;/);
  assert.match(
    backgroundSource,
    /\.then\(\(result\) => \{\s*microSkillManagerReadyPending = false;\s*return result;\s*\}\)/s
  );
  assert.match(
    backgroundSource,
    /\.catch\(\(error\) => \{\s*microSkillManagerReadyPending = false;\s*microSkillManagerReadyPromise = null;/s
  );
});
