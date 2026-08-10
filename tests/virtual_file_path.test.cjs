const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadVirtualFilePathModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/shared/virtual_file_path.js');
  return import(`${pathToFileURL(filePath).href}?test=${Date.now()}`);
}

test('精确路径在所有虚拟根中使用同一套可移植规则', async () => {
  const { normalizeVirtualFilePath } = await loadVirtualFilePathModule();

  assert.equal(normalizeVirtualFilePath('./资料\\设计 文档.md'), '资料/设计 文档.md');
  assert.equal(normalizeVirtualFilePath('workspace/a.md'), 'workspace/a.md');
  assert.equal(normalizeVirtualFilePath('界'.repeat(512)), '界'.repeat(512));
  assert.throws(() => normalizeVirtualFilePath('界'.repeat(513)), /不能超过 512 个字符/);
  assert.throws(() => normalizeVirtualFilePath('/absolute.md'), /相对路径/);
  assert.throws(() => normalizeVirtualFilePath('a//b.md'), /不能包含空段/);
  assert.throws(() => normalizeVirtualFilePath('a/../b.md'), /不能包含空段/);
  assert.throws(() => normalizeVirtualFilePath('a/*.md'), /不允许的字符/);
});

test('路径过滤统一支持目录 operand 与有限 glob 子集', async () => {
  const {
    matchesVirtualPathFilter,
    normalizeVirtualPathFilter
  } = await loadVirtualFilePathModule();

  assert.equal(normalizeVirtualPathFilter(null), null);
  assert.equal(normalizeVirtualPathFilter('.'), null);
  assert.equal(normalizeVirtualPathFilter('./src\\**\\*.js'), 'src/**/*.js');
  assert.equal(matchesVirtualPathFilter('src', 'src'), true);
  assert.equal(matchesVirtualPathFilter('src/main.js', 'src'), true);
  assert.equal(matchesVirtualPathFilter('source/main.js', 'src'), false);
  assert.equal(matchesVirtualPathFilter('src/main.js', 'src/**/*.js'), true);
  assert.equal(matchesVirtualPathFilter('src/deep/main.js', 'src/**/*.js'), true);
  assert.equal(matchesVirtualPathFilter('src/deep/main.ts', 'src/**/*.js'), false);
  assert.equal(matchesVirtualPathFilter('src/a.js', 'src/?.js'), true);
  assert.throws(() => normalizeVirtualPathFilter('/src/**'), /相对路径/);
  assert.throws(() => normalizeVirtualPathFilter('src/../**'), /不能包含空段/);
});
