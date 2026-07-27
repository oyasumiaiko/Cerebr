const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
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
  assert.equal(spec.parameters.properties.max_chars, undefined);
  assert.match(spec.parameters.properties.max_output_chars.description, /默认 20000/);
  assert.match(spec.description, /用途：/);
  assert.match(spec.description, /read_tool_output/);
});

test('buildPageContentReadResult 默认生成完整正文，统一出口再按 20000 分页', async () => {
  const { buildPageContentReadResult } = await loadPageContentReadToolModule();
  const result = buildPageContentReadResult({
    title: 'Example',
    url: 'https://example.com',
    content: 'A'.repeat(62000)
  }, {});

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'full');
  assert.equal(result.max_output_chars, undefined);
  assert.equal(result.truncated, false);
  assert.equal(result.returned_chars, 62000);
  assert.equal(result.omitted_chars, 0);
  assert.equal(result.has_more_after_range, false);
  assert.equal(result.next_skip_chars, null);
  assert.equal(result.content.length, 62000);
});

test('buildPageContentReadResult 的 skip_chars 只选择源起点，不再叠加内部字符窗口', async () => {
  const { buildPageContentReadResult } = await loadPageContentReadToolModule();
  const result = buildPageContentReadResult({
    title: 'Example',
    url: 'https://example.com',
    content: '0123456789ABCDEFGHIJ'
  }, {
    skip_chars: 5,
    max_output_chars: 6
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'range');
  assert.equal(result.skip_chars, 5);
  assert.equal(result.max_output_chars, undefined);
  assert.equal(result.content, '56789ABCDEFGHIJ');
  assert.equal(result.has_more_after_range, false);
  assert.equal(result.next_skip_chars, null);
});

test('buildPageContentReadResult 不会在统一出口前按 max_output_chars 预截断', async () => {
  const { buildPageContentReadResult } = await loadPageContentReadToolModule();
  const result = buildPageContentReadResult({
    title: 'Long page',
    url: 'https://example.com/long',
    content: 'P'.repeat(70000)
  }, {
    skip_chars: 0,
    max_output_chars: 100
  });

  assert.equal(result.max_output_chars, undefined);
  assert.equal(result.returned_chars, 70000);
  assert.equal(result.content.length, 70000);
});

test('网页与 PDF 运行时只在共享契约中定义默认预算并复用纯结果构造器', async () => {
  const contentSource = await fs.readFile(path.resolve(__dirname, '../src/extension/content.js'), 'utf8');
  const senderSource = await fs.readFile(path.resolve(__dirname, '../src/core/message_sender.js'), 'utf8');
  const contractSource = await fs.readFile(path.resolve(__dirname, '../src/agent_tools/shared/model_tool_contract.js'), 'utf8');
  assert.match(contractSource, /RESPONSES_TOOL_OUTPUT_DEFAULT_MAX_CHARS = 5_000/);
  assert.match(contractSource, /RESPONSES_PAGE_CONTENT_READ_TOOL_OUTPUT_DEFAULT_MAX_CHARS = 20_000/);
  assert.doesNotMatch(contentSource, /build(?:Page|Pdf)ContentReadResultForTransport|CONTENT_READ_DEFAULT_MAX_OUTPUT_CHARS/);
  assert.match(senderSource, /buildPageContentReadResult\(pageContent, rawArgs\)/);
  assert.match(senderSource, /buildPdfContentReadResult\(pageContent, rawArgs\)/);
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

test('buildPageContentReadResult 显式开启后为完整所选正文附录图片 URL', async () => {
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
    max_output_chars: 24,
    include_image_urls: true
  });

  assert.equal(result.include_image_urls, true);
  assert.equal(result.image_reference_count, 2);
  assert.equal(result.returned_chars, 45);
  assert.match(result.content, /Alpha \[Hero\]\[img-1\] Beta/);
  assert.match(result.content, /\[img-1\]: https:\/\/cdn\.example\.com\/hero\.png/);
  assert.match(result.content, /\[img-2\]: https:\/\/cdn\.example\.com\/later\.png/);
});

test('buildPageContentReadResult 在无内容时返回明确错误', async () => {
  const { buildPageContentReadResult } = await loadPageContentReadToolModule();
  const result = buildPageContentReadResult({ title: 'Empty', url: 'https://example.com', content: '' }, {});
  assert.equal(result.ok, false);
  assert.equal(result.error.name, 'EmptyPageContentError');
});
