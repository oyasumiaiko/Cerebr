const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadCore() {
  return import(pathToFileURL(path.resolve(
    __dirname,
    '../src/agent_tools/shared/apply_patch_core.js'
  )).href);
}

async function loadContract() {
  return import(pathToFileURL(path.resolve(
    __dirname,
    '../src/agent_tools/shared/apply_patch_contract.js'
  )).href);
}

const UPSTREAM_REVISION = '63d213884daea50e4f74efc192cdc44f549b67d5';

test('Codex 固定提交的 Freeform description 与 Environment ID grammar 不漂移', async () => {
  const {
    APPLY_PATCH_CUSTOM_TOOL_DESCRIPTION,
    APPLY_PATCH_UPSTREAM_REVISION
  } = await loadContract();

  assert.equal(APPLY_PATCH_UPSTREAM_REVISION, UPSTREAM_REVISION);
  assert.equal(
    APPLY_PATCH_CUSTOM_TOOL_DESCRIPTION,
    'The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.'
  );
});

test('parse_patch 默认采用 Codex lenient 边界并返回规范化 patch', async () => {
  const {
    APPLY_PATCH_PARSE_MODE_STRICT,
    parseApplyPatch
  } = await loadCore();
  const rawPatch = [
    "<<'EOF'",
    '*** Begin Patch',
    '*** Add File: hello.txt',
    '+hello',
    '*** End Patch',
    'EOF'
  ].join('\r\n');

  const parsed = parseApplyPatch(`\n\t${rawPatch}\n`);
  assert.equal(parsed.patch, [
    '*** Begin Patch',
    '*** Add File: hello.txt',
    '+hello',
    '*** End Patch'
  ].join('\n'));
  assert.equal(parsed.hunks[0].contents, 'hello\n');

  assert.throws(
    () => parseApplyPatch(rawPatch, { mode: APPLY_PATCH_PARSE_MODE_STRICT }),
    /The first line of the patch must be '\*\*\* Begin Patch'/
  );
});

test('StreamingPatchParser 记录 Codex context_line_indices', async () => {
  const { parseApplyPatch } = await loadCore();
  const parsed = parseApplyPatch([
    '*** Begin Patch',
    '*** Update File: lines.txt',
    '@@',
    '-one',
    '+ONE',
    ' two',
    '+between',
    '',
    ' three',
    '*** End Patch'
  ].join('\n'));

  assert.deepEqual(parsed.hunks[0].chunks[0].context_line_indices, [
    [1, 1],
    [2, 3],
    [3, 4]
  ]);
});

test('PreserveLineEndings 与 Codex 一样保留 CRLF 和混合行尾', async () => {
  const {
    APPLY_PATCH_FILE_UPDATE_MODE_PRESERVE_LINE_ENDINGS,
    derivePatchedFileContent,
    parseApplyPatch
  } = await loadCore();

  const crlfPatch = parseApplyPatch([
    '*** Begin Patch',
    '*** Update File: lines.txt',
    '@@',
    '-one',
    '+ONE',
    ' two',
    '+between',
    ' three',
    '*** End Patch'
  ].join('\n'));
  assert.equal(
    derivePatchedFileContent(
      'one\r\ntwo\r\nthree\r\n',
      'lines.txt',
      crlfPatch.hunks[0].chunks,
      APPLY_PATCH_FILE_UPDATE_MODE_PRESERVE_LINE_ENDINGS
    ),
    'ONE\r\ntwo\r\nbetween\r\nthree\r\n'
  );

  const mixedPatch = parseApplyPatch([
    '*** Begin Patch',
    '*** Update File: lines.txt',
    '@@',
    ' one',
    ' two',
    '-three',
    '+THREE',
    ' four',
    '*** End Patch'
  ].join('\n'));
  assert.equal(
    derivePatchedFileContent(
      'one\r\ntwo\nthree\rfour',
      'lines.txt',
      mixedPatch.hunks[0].chunks,
      APPLY_PATCH_FILE_UPDATE_MODE_PRESERVE_LINE_ENDINGS
    ),
    'one\r\ntwo\nTHREE\r\nfour\r\n'
  );
});

test('同一 Update File 的 chunk 逆序时复现 Codex 原始 missing-lines 错误', async () => {
  const {
    derivePatchedFileContent,
    formatApplyPatchVerificationError,
    parseApplyPatch
  } = await loadCore();
  const source = [
    '开头',
    '该路径在前端中存在过，但新代码优先使用 `/backend-api/projects`。除非当前版本明确仍调用它，否则不要把旧路径作为首选。',
    '中间',
    '批量写入必须顺序执行。',
    '结尾'
  ].join('\n') + '\n';
  const patch = parseApplyPatch([
    '*** Begin Patch',
    '*** Update File: references/api-reference.md',
    '@@',
    '-批量写入必须顺序执行。',
    '+批量写入必须顺序执行，并记录状态。',
    '@@',
    '-该路径在前端中存在过，但新代码优先使用 `/backend-api/projects`。除非当前版本明确仍调用它，否则不要把旧路径作为首选。',
    '+该路径仍仅作为历史记录。',
    '*** End Patch'
  ].join('\n'));

  assert.ok(source.includes(patch.hunks[0].chunks[1].old_lines[0]));
  assert.throws(
    () => derivePatchedFileContent(
      source,
      'references/api-reference.md',
      patch.hunks[0].chunks
    ),
    (error) => formatApplyPatchVerificationError(error) === [
      'apply_patch verification failed: Failed to find expected lines in references/api-reference.md:',
      '该路径在前端中存在过，但新代码优先使用 `/backend-api/projects`。除非当前版本明确仍调用它，否则不要把旧路径作为首选。'
    ].join('\n')
  );
});
