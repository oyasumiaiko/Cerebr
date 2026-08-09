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
  assert.equal(preview.patchComplete, true);
  assert.equal(preview.isPartial, false);
});

test('buildVirtualFileApplyPatchPreview 直接流式解析 custom_tool_call raw input', async () => {
  const { buildVirtualFileApplyPatchPreview } = await loadModule();
  const preview = buildVirtualFileApplyPatchPreview([
    '*** Begin Patch\n',
    '*** Environment ID: skill:dom-probe\n',
    '*** Update File: src/main.js\n',
    '@@\n',
    ' old\n',
    '-old\n',
    '+const label = "done";\n'
  ].join(''), { final: false });

  assert.equal(preview.skillName, 'dom-probe');
  assert.equal(preview.totalFiles, 1);
  assert.equal(preview.totalAdditions, 1);
  assert.equal(preview.totalDeletions, 1);
  assert.equal(preview.patchComplete, false);
  assert.equal(preview.isPartial, true);
  assert.equal(preview.files[0].path, 'src/main.js');
  assert.equal(preview.files[0].lines[0].kind, 'hunk');
  assert.equal(preview.files[0].lines[1].kind, 'context');
  assert.equal(preview.files[0].lines[2].kind, 'delete');
  assert.equal(preview.files[0].lines[3].kind, 'add');
  assert.equal(preview.files[0].lines[3].text, 'const label = "done";');
});

test('custom preview 的 done 会完成没有换行的最后一行', async () => {
  const { buildVirtualFileApplyPatchPreview } = await loadModule();
  const preview = buildVirtualFileApplyPatchPreview([
    '*** Begin Patch\n',
    '*** Environment ID: skill:dom-probe\n',
    '*** Add File: references/notes.md\n',
    '+hello\n',
    '*** End Patch'
  ].join(''), { final: true });

  assert.equal(preview.skillName, 'dom-probe');
  assert.equal(preview.totalFiles, 1);
  assert.equal(preview.totalAdditions, 1);
  assert.equal(preview.patchComplete, true);
  assert.equal(preview.files[0].path, 'references/notes.md');
  assert.equal(preview.files[0].operation, 'add');
  assert.equal(preview.files[0].lines[0].kind, 'add');
});

test('preview 与执行 parser 同样拒绝非法完整行并报告精确行号', async () => {
  const { buildVirtualFileApplyPatchPreview } = await loadModule();
  const preview = buildVirtualFileApplyPatchPreview([
    '*** Begin Patch',
    '*** Update File: a.txt',
    '@@',
    '-old',
    'bogus',
    '*** End Patch'
  ].join('\n'), { final: true });

  assert.equal(preview.parseError.line_number, 5);
  assert.match(preview.parseError.message, /Expected update hunk to start/);
  assert.equal(preview.files[0].lines.some(line => line.text === 'bogus'), false);
});

test('preview 不再截断 12 个文件、单文件 160 行或总计 320 行', async () => {
  const { buildVirtualFileApplyPatchPreview } = await loadModule();
  const patchLines = ['*** Begin Patch'];
  for (let fileIndex = 0; fileIndex < 13; fileIndex += 1) {
    patchLines.push(`*** Add File: file-${fileIndex}.txt`);
    for (let lineIndex = 0; lineIndex < 31; lineIndex += 1) {
      patchLines.push(`+${fileIndex}:${lineIndex}`);
    }
  }
  patchLines.push('*** End Patch');
  const preview = buildVirtualFileApplyPatchPreview(patchLines.join('\n'), { final: true });

  assert.equal(preview.totalFiles, 13);
  assert.equal(preview.totalAdditions, 403);
  assert.equal(preview.files[12].lines.length, 31);
});

test('buildSkillApplyPatchPreview 对非 apply_patch 参数返回 null', async () => {
  const { buildSkillApplyPatchPreview } = await loadModule();
  assert.equal(buildSkillApplyPatchPreview({ action: 'read_file' }), null);
  assert.equal(buildSkillApplyPatchPreview('{"action":"read_file"}'), null);
});
