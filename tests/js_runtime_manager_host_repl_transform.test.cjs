const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadJsRuntimeManagerModule() {
  const filePath = path.resolve(__dirname, '../src/extension/js_runtime_manager.js');
  return import(pathToFileURL(filePath).href);
}

test('transformHostPageJsReplSource 会把简单顶层声明改写为 REPL 绑定写入', async () => {
  const { transformHostPageJsReplSource } = await loadJsRuntimeManagerModule();
  const transformed = transformHostPageJsReplSource(`
const savedTitle = document.title;
async function readHref() { return location.href; }
class Reader {}
return { savedTitle, href: await readHref(), hasReader: typeof Reader === 'function' };
`.trim());

  assert.match(transformed, /__cerebrSetBinding\("savedTitle", \(document\.title\)\);/);
  assert.match(transformed, /__cerebrSetBinding\("readHref", \(async function readHref\(\) \{ return location\.href; \}\)\);/);
  assert.match(transformed, /__cerebrSetBinding\("Reader", \(class Reader \{\}\)\);/);
  assert.match(transformed, /return \{ savedTitle, href: await readHref\(\), hasReader: typeof Reader === 'function' \};/);
});

test('transformHostPageJsReplSource 对顶层解构声明给出明确错误', async () => {
  const { transformHostPageJsReplSource } = await loadJsRuntimeManagerModule();
  assert.throws(
    () => transformHostPageJsReplSource('const { a, b } = source;'),
    /仅支持顶层简单标识符声明/
  );
});
