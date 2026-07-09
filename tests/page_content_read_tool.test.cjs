const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadPageContentReadToolModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/page_content_read/tool.js');
  return import(`${pathToFileURL(filePath).href}?test=${Date.now()}`);
}

test('normalizePageContentReadText 会折叠多行与多余空白', async () => {
  const { normalizePageContentReadText } = await loadPageContentReadToolModule();
  const text = normalizePageContentReadText('  第一行 \n\n 第二行   第三词 \n  第四行 ');
  assert.equal(text, '第一行 第二行 第三词 第四行');
});

test('buildPageContentReadFunctionToolDefinition 声明可选图片 URL 参数且默认由模型显式开启', async () => {
  const { buildPageContentReadFunctionToolDefinition } = await loadPageContentReadToolModule();
  const spec = buildPageContentReadFunctionToolDefinition();
  assert.equal(spec.strict, true);
  assert.equal(spec.parameters.properties.include_image_urls.type[0], 'boolean');
  assert.ok(spec.parameters.required.includes('include_image_urls'));
  assert.match(spec.parameters.properties.include_image_urls.description, /false 或 null/);
  assert.equal(Object.hasOwn(spec.parameters.properties.max_chars, 'maximum'), false);
  assert.match(spec.parameters.properties.max_chars.description, /1-50000/);
  assert.match(spec.description, /用途：/);
  assert.match(spec.description, /next_skip_chars/);
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
  assert.equal(result.max_chars, 10000);
  assert.equal(result.truncated, true);
  assert.equal(result.returned_chars, 10000);
  assert.equal(result.omitted_chars, 2000);
  assert.equal(result.omitted_pct, 16.67);
  assert.equal(result.has_more_after_range, true);
  assert.equal(result.next_skip_chars, 10000);
  assert.equal(result.content.length, 10000);
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
  assert.equal(result.next_skip_chars, 11);
});

test('buildPageContentReadResult 默认不包含图片引用附录', async () => {
  const { buildPageContentReadResult } = await loadPageContentReadToolModule();
  const result = buildPageContentReadResult({
    title: 'Example',
    url: 'https://example.com',
    content: 'Alpha plain text',
    content_with_image_refs: 'Alpha [Hero][img-1] plain text',
    image_references: [
      { id: 'img-1', title: 'Hero', url: 'https://cdn.example.com/hero.png' }
    ]
  }, {});

  assert.equal(result.include_image_urls, false);
  assert.equal(result.image_reference_count, 0);
  assert.equal(result.content, 'Alpha plain text');
  assert.doesNotMatch(result.content, /\[img-1\]:/);
});

test('buildPageContentReadResult 显式开启后只附录本次片段实际出现的图片 URL', async () => {
  const { buildPageContentReadResult } = await loadPageContentReadToolModule();
  const result = buildPageContentReadResult({
    title: 'Example',
    url: 'https://example.com',
    content: 'Alpha plain text',
    content_with_image_refs: 'Alpha [Hero][img-1] Beta [Later][img-2] Gamma',
    image_references: [
      { id: 'img-1', title: 'Hero', url: 'https://cdn.example.com/hero.png' },
      { id: 'img-2', title: 'Later', url: 'https://cdn.example.com/later.png' }
    ]
  }, {
    max_chars: 24,
    include_image_urls: true
  });

  assert.equal(result.include_image_urls, true);
  assert.equal(result.image_reference_count, 1);
  assert.equal(result.returned_chars, 24);
  assert.match(result.content, /Alpha \[Hero\]\[img-1\] Beta/);
  assert.match(result.content, /\[img-1\]: https:\/\/cdn\.example\.com\/hero\.png/);
  assert.doesNotMatch(result.content, /\[img-2\]:/);
});

test('buildPageContentReadResult 在无内容时返回明确错误', async () => {
  const { buildPageContentReadResult } = await loadPageContentReadToolModule();
  const result = buildPageContentReadResult({ title: 'Empty', url: 'https://example.com', content: '' }, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.name, 'EmptyPageContentError');
});
