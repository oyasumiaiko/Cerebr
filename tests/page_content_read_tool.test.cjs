const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadPageContentReadToolModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/page_content_read_tool.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('normalizePageContentReadText 会折叠多行与多余空白', async () => {
  const { normalizePageContentReadText } = await loadPageContentReadToolModule();
  const text = normalizePageContentReadText('  第一行 \n\n 第二行   第三词 \n  第四行 ');
  assert.equal(text, '第一行 第二行 第三词 第四行');
});

test('buildPageContentReadResult 默认返回安全预览而不是整篇正文', async () => {
  const { buildPageContentReadResult } = await loadPageContentReadToolModule();
  const result = buildPageContentReadResult({
    title: 'Example',
    url: 'https://example.com',
    content: 'A'.repeat(12000)
  }, {});

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'preview');
  assert.equal(result.max_chars, 20000);
  assert.equal(result.truncated, false);
  assert.equal(result.returned_chars, 12000);
  assert.equal(result.omitted_chars, 0);
  assert.equal(result.omitted_pct, 0);
  assert.equal(result.has_more_after_range, false);
  assert.equal(result.content.length, 12000);
});

test('buildPageContentReadResult 支持 skip_chars + max_chars 连续读取', async () => {
  const { buildPageContentReadResult } = await loadPageContentReadToolModule();
  const result = buildPageContentReadResult({
    title: 'Example',
    url: 'https://example.com',
    content: '0123456789ABCDEFGHIJ'
  }, {
    skip_chars: 5,
    max_chars: 6
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'range');
  assert.equal(result.skip_chars, 5);
  assert.equal(result.max_chars, 6);
  assert.equal(result.content, '56789A');
  assert.equal(result.has_more_after_range, true);
});

test('buildPageContentReadResult 在无内容时返回明确错误', async () => {
  const { buildPageContentReadResult } = await loadPageContentReadToolModule();
  const result = buildPageContentReadResult({ title: 'Empty', url: 'https://example.com', content: '' }, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.name, 'EmptyPageContentError');
});
