const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadSkillStoreModule() {
  const filePath = path.resolve(__dirname, '../src/storage/skill_store.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('shouldMigrateLegacySkillDb 仅在新库为空且存在 legacy micro skill 库时返回 true', async () => {
  const {
    LEGACY_MICRO_SKILL_DB_NAME,
    shouldMigrateLegacySkillDb
  } = await loadSkillStoreModule();

  assert.equal(shouldMigrateLegacySkillDb({
    availableDbNames: [LEGACY_MICRO_SKILL_DB_NAME],
    currentManifestCount: 0,
    currentFileCount: 0
  }), true);

  assert.equal(shouldMigrateLegacySkillDb({
    availableDbNames: [LEGACY_MICRO_SKILL_DB_NAME],
    currentManifestCount: 1,
    currentFileCount: 0
  }), false);

  assert.equal(shouldMigrateLegacySkillDb({
    availableDbNames: [LEGACY_MICRO_SKILL_DB_NAME],
    currentManifestCount: 0,
    currentFileCount: 3
  }), false);

  assert.equal(shouldMigrateLegacySkillDb({
    availableDbNames: ['CerebrSkillDB'],
    currentManifestCount: 0,
    currentFileCount: 0
  }), false);
});
