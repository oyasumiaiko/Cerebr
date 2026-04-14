const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadModule() {
  const modulePath = path.resolve(__dirname, '../src/utils/skill_patch_preview.js');
  return import(pathToFileURL(modulePath).href);
}

test('buildSkillApplyPatchPreview 会把 apply_patch 参数解析成可视化 diff 预览', async () => {
  const { buildSkillApplyPatchPreview } = await loadModule();
  const preview = buildSkillApplyPatchPreview({
    action: 'apply_patch',
    skill_name: 'worldquant-brain-sim-state',
    patch: [
      '*** Begin Patch',
      '*** Update File: SKILL.md',
      '@@',
      ' ## 推荐读取顺序',
      '+## 实验闭环',
      '*** Add File: references/experiment-loop.md',
      '+# Experiment Loop Notes',
      '+',
      '+loop body',
      '*** End Patch'
    ].join('\n')
  });

  assert.equal(preview.skillName, 'worldquant-brain-sim-state');
  assert.equal(preview.totalFiles, 2);
  assert.equal(preview.totalAdditions, 4);
  assert.equal(preview.totalDeletions, 0);
  assert.equal(preview.files[0].path, 'SKILL.md');
  assert.equal(preview.files[0].operation, 'update');
  assert.equal(preview.files[0].lines[0].kind, 'hunk');
  assert.equal(preview.files[0].lines[1].kind, 'context');
  assert.equal(preview.files[0].lines[2].kind, 'add');
  assert.equal(preview.files[1].path, 'references/experiment-loop.md');
  assert.equal(preview.files[1].operation, 'add');
  assert.equal(preview.files[1].lines[0].kind, 'add');
});

test('buildSkillApplyPatchPreview 对非 apply_patch 参数返回 null', async () => {
  const { buildSkillApplyPatchPreview } = await loadModule();
  assert.equal(buildSkillApplyPatchPreview({ action: 'read_file' }), null);
  assert.equal(buildSkillApplyPatchPreview('{"action":"read_file"}'), null);
});
