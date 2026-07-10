const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

test('自定义背景的文本列表和图片统一由 background 获取', async () => {
  const [backgroundSource, settingsSource] = await Promise.all([
    fs.readFile(path.join(repoRoot, 'src/extension/background.js'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'src/ui/settings_manager.js'), 'utf8')
  ]);
  assert.match(backgroundSource, /message\?\.type === 'FETCH_BACKGROUND_TEXT'/);
  assert.match(backgroundSource, /message\?\.type === 'FETCH_BACKGROUND_IMAGE'/);
  assert.match(backgroundSource, /await caches\.open\(BACKGROUND_IMAGE_CACHE_NAME\)/);
  assert.match(backgroundSource, /contentType\.startsWith\('image\/'\)/);
  assert.match(settingsSource, /type: 'FETCH_BACKGROUND_TEXT', url: listUrl/);
  assert.match(settingsSource, /type: 'FETCH_BACKGROUND_IMAGE', url: resourceUrl/);
  assert.match(settingsSource, /URL\.createObjectURL\(blob\)/);
  assert.doesNotMatch(settingsSource, /const response = await fetch\(listUrl\)/);
});
