const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadApplyDiffModule() {
  const filePath = path.resolve(
    __dirname,
    '../src/agent_tools/shared/openai_v4a_apply_diff.js'
  );
  return import(pathToFileURL(filePath).href + '?test=' + Date.now());
}

test('create 模式要求所有行使用 + 前缀，并按显式空行决定尾换行', async () => {
  const { applyDiff } = await loadApplyDiffModule();

  assert.equal(
    applyDiff('', ['+hello', '+world'].join('\n'), 'create'),
    'hello\nworld'
  );
  assert.equal(
    applyDiff('', ['+hello', '+world', '+'].join('\n'), 'create'),
    'hello\nworld\n'
  );
  assert.throws(
    () => applyDiff('', ['+hello', 'world'].join('\n'), 'create'),
    /Invalid Add File Line: world/
  );
});

test('update 模式支持 floating hunk 与增删替换', async () => {
  const { applyDiff } = await loadApplyDiffModule();
  const input = [
    '- Milk',
    '- Bread',
    '- Eggs',
    '- Apples',
    '- Coffee'
  ].join('\n');
  const diff = [
    '@@',
    ' - Milk',
    ' - Bread',
    ' - Eggs',
    '-- Apples',
    '-- Coffee',
    '+- [x] Apples',
    '+- [x] Coffee'
  ].join('\n');

  assert.equal(
    applyDiff(input, diff),
    [
      '- Milk',
      '- Bread',
      '- Eggs',
      '- [x] Apples',
      '- [x] Coffee'
    ].join('\n')
  );
});

test('update 模式保留原文件是否具有尾换行的状态', async () => {
  const { applyDiff } = await loadApplyDiffModule();
  const diff = [
    '@@ one',
    '-two',
    '+2'
  ].join('\n');

  assert.equal(applyDiff('one\ntwo', diff), 'one\n2');
  assert.equal(applyDiff('one\ntwo\n', diff), 'one\n2\n');
});

test('多个 @@ anchor 会从前向后定位并更新不同区段', async () => {
  const { applyDiff } = await loadApplyDiffModule();
  const input = [
    'class Foo:',
    '    def baz(self):',
    '        return "foo"',
    '',
    'def main():',
    '    foo = Foo()',
    '    print(foo.baz())',
    ''
  ].join('\n');
  const diff = [
    '@@ class Foo:',
    '-    def baz(self):',
    '+    def value(self):',
    '         return "foo"',
    '@@ def main():',
    '     foo = Foo()',
    '-    print(foo.baz())',
    '+    print(foo.value())'
  ].join('\n');

  assert.equal(
    applyDiff(input, diff),
    [
      'class Foo:',
      '    def value(self):',
      '        return "foo"',
      '',
      'def main():',
      '    foo = Foo()',
      '    print(foo.value())',
      ''
    ].join('\n')
  );
});

test('上下文匹配依次容忍行尾空白与两端空白 fuzz', async () => {
  const { applyDiff } = await loadApplyDiffModule();

  assert.equal(
    applyDiff(
      'alpha   \nbeta\t\n',
      [' alpha', '-beta', '+B'].join('\n')
    ),
    'alpha   \nB\n'
  );

  assert.equal(
    applyDiff(
      '  alpha  \n\tbeta \n',
      [' alpha', '-beta', '+B'].join('\n')
    ),
    '  alpha  \nB\n'
  );
});

test('*** End of File 优先在文件末尾匹配上下文', async () => {
  const { applyDiff } = await loadApplyDiffModule();
  const input = [
    'header',
    'same',
    'old',
    'middle',
    'same',
    'old'
  ].join('\n');
  const diff = [
    ' same',
    '-old',
    '+new',
    '*** End of File'
  ].join('\n');

  assert.equal(
    applyDiff(input, diff),
    [
      'header',
      'same',
      'old',
      'middle',
      'same',
      'new'
    ].join('\n')
  );
});

test('上下文不存在时抛出包含失败位置与上下文的错误', async () => {
  const { applyDiff } = await loadApplyDiffModule();

  assert.throws(
    () => applyDiff(
      'one\ntwo\n',
      [' x', '-two', '+2'].join('\n')
    ),
    /Invalid Context 0:\nx\ntwo/
  );
});

test('非法 section 行和空 section 会明确失败', async () => {
  const { applyDiff } = await loadApplyDiffModule();

  assert.throws(
    () => applyDiff('one\n', ['@@', 'unexpected'].join('\n')),
    /Invalid Line: unexpected/
  );
  assert.throws(
    () => applyDiff('one\n', '@@'),
    /Nothing in this section/
  );
});
