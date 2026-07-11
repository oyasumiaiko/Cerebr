const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

test('自定义背景的文本列表和图片统一由 background 获取', async () => {
  const [backgroundSource, settingsSource, blobStoreSource, manifestSource] = await Promise.all([
    fs.readFile(path.join(repoRoot, 'src/extension/background.js'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'src/ui/settings_manager.js'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'src/storage/background_image_blob_store.js'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'manifest.json'), 'utf8')
  ]);
  const manifest = JSON.parse(manifestSource);
  assert.match(backgroundSource, /message\?\.type === 'FETCH_BACKGROUND_TEXT'/);
  assert.match(backgroundSource, /message\?\.type === 'FETCH_BACKGROUND_IMAGE'/);
  assert.match(backgroundSource, /putBackgroundImageBlob\(/);
  assert.match(backgroundSource, /contentType\.startsWith\('image\/'\)/);
  assert.match(settingsSource, /type: 'FETCH_BACKGROUND_TEXT', url: listUrl/);
  assert.match(settingsSource, /type: 'FETCH_BACKGROUND_IMAGE', url: resourceUrl/);
  assert.match(settingsSource, /takeBackgroundImageBlob\(result\.blobKey\)/);
  assert.match(settingsSource, /URL\.createObjectURL\(blob\)/);
  assert.doesNotMatch(settingsSource, /const response = await fetch\(listUrl\)/);
  assert.match(backgroundSource, /updateSessionRules\(\{ addRules: \[rule\] \}\)/);
  assert.match(backgroundSource, /updateSessionRules\(\{ removeRuleIds: \[ruleId\] \}\)/);
  assert.match(backgroundSource, /requestHeaders: \[\{ header: 'Referer', operation: 'set', value: normalizedUrl \}\]/);
  assert.match(backgroundSource, /regexFilter: `\^\$\{escapeDnrRegex\(normalizedUrl\)\}\$`/);
  assert.doesNotMatch(backgroundSource, /moely\.link/);
  assert.match(blobStoreSource, /getIndexedDb\(\)\.open\(BACKGROUND_IMAGE_BLOB_DB_NAME/);
  assert.match(blobStoreSource, /store\.delete\(normalizedKey\)/);
  assert.ok(manifest.permissions.includes('declarativeNetRequestWithHostAccess'));
  assert.equal(manifest.declarative_net_request, undefined);
});
