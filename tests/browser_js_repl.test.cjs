const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadBrowserJsReplModule() {
  const filePath = path.resolve(__dirname, '../src/utils/browser_js_repl.js');
  return import(pathToFileURL(filePath).href);
}

test('parseBrowserJsReplInput 支持 js-repl pragma', async () => {
  const { parseBrowserJsReplInput } = await loadBrowserJsReplModule();
  const parsed = parseBrowserJsReplInput('// js-repl: timeout_ms=15000\nconst value = 1;');
  assert.equal(parsed.timeoutMs, 15000);
  assert.equal(parsed.code, 'const value = 1;');
});

test('createBrowserJsReplKernel 能跨单元持久化顶层 const 绑定', async () => {
  const { createBrowserJsReplKernel } = await loadBrowserJsReplModule();
  const kernel = createBrowserJsReplKernel({
    console,
    setTimeout,
    clearTimeout
  });

  const first = await kernel.execute('const answer = 41;');
  assert.equal(first.ok, true);

  const second = await kernel.execute('return answer + 1;');
  assert.equal(second.ok, true);
  assert.equal(second.value, 42);
});

test('createBrowserJsReplKernel 支持顶层 await 与函数声明持久化', async () => {
  const { createBrowserJsReplKernel } = await loadBrowserJsReplModule();
  const kernel = createBrowserJsReplKernel({
    console,
    Promise,
    setTimeout,
    clearTimeout
  });

  const first = await kernel.execute('const payload = await Promise.resolve({ value: 5 }); async function addOne(v) { return v + 1; }');
  assert.equal(first.ok, true);

  const second = await kernel.execute('return await addOne(payload.value);');
  assert.equal(second.ok, true);
  assert.equal(second.value, 6);
});

test('createBrowserJsReplKernel 支持解构声明并在 reset 后清空绑定', async () => {
  const { createBrowserJsReplKernel } = await loadBrowserJsReplModule();
  const kernel = createBrowserJsReplKernel({
    console
  });

  const first = await kernel.execute('const { a, b: renamed } = { a: 2, b: 3 };');
  assert.equal(first.ok, true);

  const second = await kernel.execute('return a + renamed;');
  assert.equal(second.ok, true);
  assert.equal(second.value, 5);

  kernel.reset();
  const third = await kernel.execute('return typeof a;');
  assert.equal(third.ok, true);
  assert.equal(third.value, 'undefined');
});

test('createBrowserJsReplKernel 允许通过 globalThis 写入持久绑定', async () => {
  const { createBrowserJsReplKernel } = await loadBrowserJsReplModule();
  const kernel = createBrowserJsReplKernel({
    console
  });

  const first = await kernel.execute('globalThis.counter = 1;');
  assert.equal(first.ok, true);

  const second = await kernel.execute('counter += 1; return counter;');
  assert.equal(second.ok, true);
  assert.equal(second.value, 2);
});

test('createBrowserJsReplKernel 对未知标识符返回稳定错误', async () => {
  const { createBrowserJsReplKernel } = await loadBrowserJsReplModule();
  const kernel = createBrowserJsReplKernel({
    console
  });

  const result = await kernel.execute('return missingBinding + 1;');
  assert.equal(result.ok, false);
  assert.equal(result.error?.name, 'ReferenceError');
  assert.match(result.error?.message || '', /missingBinding is not defined/);
});
