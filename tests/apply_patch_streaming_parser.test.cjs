const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadModule() {
  return import(pathToFileURL(path.resolve(
    __dirname,
    '../src/agent_tools/shared/apply_patch_core.js'
  )).href);
}

const COMPLEX_PATCH = [
  '*** Begin Patch',
  '*** Environment ID: skill:parser-probe',
  '*** Add File: add.txt',
  '+one',
  '+',
  '*** Delete File: delete.txt',
  '*** Update File: old.txt',
  '*** Move to: new.txt',
  '@@ first',
  '-old',
  '+new',
  '@@',
  ' context',
  '+tail',
  '*** End of File',
  '*** End Patch'
].join('\n');

test('逐字符流式解析与一次性最终解析产生完全相同的 AST', async () => {
  const { StreamingApplyPatchParser, parseApplyPatch } = await loadModule();
  const parser = new StreamingApplyPatchParser();
  for (const character of COMPLEX_PATCH) parser.pushDelta(character);
  const streamedHunks = parser.finish();
  const parsed = parseApplyPatch(COMPLEX_PATCH);

  assert.deepEqual(streamedHunks, parsed.hunks);
  assert.equal(parser.environment_id, 'skill:parser-probe');
  assert.equal(parsed.environment_id, 'skill:parser-probe');
  assert.equal(streamedHunks.length, 3);
  assert.equal(streamedHunks[2].move_path, 'new.txt');
  assert.equal(streamedHunks[2].chunks.length, 2);
});

test('parser 支持 CRLF、空上下文行和缩进后的 marker', async () => {
  const { parseApplyPatch } = await loadModule();
  const patch = [
    '*** Begin Patch',
    '*** Update File: a.txt',
    '@@',
    '-old',
    '+new',
    ' *** Update File: b.txt',
    '',
    ' tail',
    '*** End Patch'
  ].join('\r\n');
  const parsed = parseApplyPatch(patch);

  assert.equal(parsed.hunks.length, 1);
  assert.deepEqual(parsed.hunks[0].chunks[0].old_lines, [
    'old',
    '*** Update File: b.txt',
    '',
    'tail'
  ]);
  assert.deepEqual(parsed.hunks[0].chunks[0].new_lines, [
    'new',
    '*** Update File: b.txt',
    '',
    'tail'
  ]);
});

test('完整行到达后预览立即增长，done 才处理无换行的最后一行', async () => {
  const { StreamingApplyPatchParser } = await loadModule();
  const parser = new StreamingApplyPatchParser();
  parser.pushDelta('*** Begin Patch\n*** Add File: a.txt\n+first\n+second');
  let snapshot = parser.getSnapshot();
  assert.equal(snapshot.files.length, 1);
  assert.equal(snapshot.files[0].lines.length, 1);
  assert.equal(snapshot.pending_line, '+second');

  parser.pushDelta('\n*** End Patch');
  snapshot = parser.getSnapshot();
  assert.equal(snapshot.files[0].lines.length, 2);
  assert.equal(snapshot.complete, false);
  parser.finish();
  assert.equal(parser.getSnapshot().complete, true);
});

test('Environment ID 的空值和重复值均明确失败', async () => {
  const { parseApplyPatch } = await loadModule();
  assert.throws(
    () => parseApplyPatch('*** Begin Patch\n*** Environment ID:   \n*** Add File: a\n+x\n*** End Patch'),
    /environment_id cannot be empty/
  );
  assert.throws(
    () => parseApplyPatch('*** Begin Patch\n*** Environment ID: skill:a\n*** Environment ID: skill:b\n*** Add File: a\n+x\n*** End Patch'),
    /environment_id cannot be specified more than once/
  );
});

test('非法完整行不会进入预览事件并保留精确行号', async () => {
  const { parseApplyPatchProgress } = await loadModule();
  const progress = parseApplyPatchProgress([
    '*** Begin Patch',
    '*** Update File: a.txt',
    '@@',
    '-old',
    'bogus',
    '*** End Patch'
  ].join('\n'), { finish: true });

  assert.equal(progress.error.line_number, 5);
  assert.equal(progress.files[0].lines.some(line => line.raw === 'bogus'), false);
});
