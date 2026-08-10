const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('ensureSkillManagerReady 在 pending 时复用同一 promise，并在失败后清空缓存以允许重试', async () => {
  const backgroundSource = await readWorkspaceFile('src/extension/background.js');

  assert.match(backgroundSource, /let skillManagerReadyPending = false;/);
  assert.match(
    backgroundSource,
    /if \(skillManagerReadyPromise && skillManagerReadyPending\) \{\s*return skillManagerReadyPromise;\s*\}/s
  );
  assert.match(backgroundSource, /skillManagerReadyPending = true;/);
  assert.match(
    backgroundSource,
    /\.then\(\(result\) => \{\s*skillManagerReadyPending = false;\s*return result;\s*\}\)/s
  );
  assert.match(
    backgroundSource,
    /\.catch\(\(error\) => \{\s*skillManagerReadyPending = false;\s*skillManagerReadyPromise = null;/s
  );
  assert.match(backgroundSource, /rawPayload\.refresh_current_document !== false/);
  assert.match(backgroundSource, /if \(refreshCurrentDocument\) \{\s*await ensureSkillManagerReady\(\);\s*\}/s);
  assert.match(backgroundSource, /isolateFromHostPage \|\| !refreshCurrentDocument/);
  assert.match(backgroundSource, /executeRegistryAction\(registryPayload/);
});
