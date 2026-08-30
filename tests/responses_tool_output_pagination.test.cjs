const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function importSourceModule(relativePath) {
  return import(pathToFileURL(path.resolve(__dirname, '..', relativePath)).href);
}

function formatTextItems(items) {
  return (Array.isArray(items) ? items : [])
    .filter(item => item?.type === 'input_text')
    .map(item => item.text || '')
    .join('');
}

function readPageContent(items) {
  const text = formatTextItems(items);
  const match = text.match(/<content>\n([\s\S]*?)\n<\/content>/);
  return match ? match[1] : text;
}

function readPlainPageContent(items) {
  const text = formatTextItems(items);
  const separatorIndex = text.indexOf('\n');
  return separatorIndex >= 0 ? text.slice(separatorIndex + 1) : text;
}

test('统一分页出口在超限时返回可续读 cursor 且严格遵守字符预算', async () => {
  const { paginateResponsesToolOutputContentItems } = await importSourceModule(
    'src/agent_tools/shared/responses_tool_output.js'
  );
  const page = paginateResponsesToolOutputContentItems([
    { type: 'input_text', text: 'A'.repeat(2000) }
  ], {
    maxOutputChars: 500,
    nextCursor: 'cursor-next'
  });
  const text = formatTextItems(page.contentItems);

  assert.equal(Array.from(text).length <= 500, true);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextCursor, 'cursor-next');
  assert.equal(page.rangeStart, 0);
  assert.equal(page.rangeEnd > 0, true);
  assert.match(text, /<tool_output_page /);
  assert.match(text, /next_cursor="cursor-next"/);
});

test('分页缓存按游标无重复地续读完整结果，并只在第一页保留图片', async () => {
  const { createResponsesToolOutputPageCache } = await importSourceModule(
    'src/agent_tools/shared/responses_tool_output_page_cache.js'
  );
  let cursorIndex = 0;
  const cache = createResponsesToolOutputPageCache({
    createCursor: () => `cursor-${cursorIndex += 1}`
  });
  const source = Array.from({ length: 1800 }, (_, index) => String(index % 10)).join('');
  const sourceItems = [
    { type: 'input_text', text: source },
    { type: 'input_image', image_url: 'data:image/png;base64,AA==' }
  ];

  let page = cache.paginate(sourceItems, 500);
  let reconstructed = '';
  let pageCount = 0;
  while (page) {
    pageCount += 1;
    reconstructed += readPageContent(page.contentItems);
    const images = page.contentItems.filter(item => item?.type === 'input_image');
    assert.equal(images.length, pageCount === 1 ? 1 : 0);
    if (!page.nextCursor) break;
    assert.equal(cache.has(page.nextCursor), true);
    page = cache.read(page.nextCursor, null);
  }

  assert.equal(pageCount > 1, true);
  assert.equal(reconstructed, source);
  assert.equal(cache.read('missing-cursor', 500), null);
});

test('虚拟文件纯文本分页不转义正文并可按 cursor 无损拼回', async () => {
  const { createResponsesToolOutputPageCache } = await importSourceModule(
    'src/agent_tools/shared/responses_tool_output_page_cache.js'
  );
  let cursorIndex = 0;
  const cache = createResponsesToolOutputPageCache({
    createCursor: () => `plain-cursor-${cursorIndex += 1}`
  });
  const source = '<tag>&value</tag>\r\n'.repeat(80);
  let page = cache.paginate([
    { type: 'input_text', text: source }
  ], 300, { format: 'plain' });
  let reconstructed = '';
  let pageCount = 0;
  while (page) {
    pageCount += 1;
    const pageText = formatTextItems(page.contentItems);
    assert.match(pageText, /^tool_output_page total_chars=/);
    assert.doesNotMatch(pageText, /&lt;tag&gt;|&amp;value/);
    reconstructed += readPlainPageContent(page.contentItems);
    if (!page.nextCursor) break;
    page = cache.read(page.nextCursor, null);
  }

  assert.equal(pageCount > 1, true);
  assert.equal(reconstructed, source);
});

test('read_tool_output 契约只接受上页 cursor，并继承统一输出预算', async () => {
  const {
    buildReadToolOutputFunctionToolDefinition,
    normalizeReadToolOutputArguments
  } = await importSourceModule('src/agent_tools/read_tool_output/tool.js');
  const definition = buildReadToolOutputFunctionToolDefinition();

  assert.equal(definition.name, 'read_tool_output');
  assert.deepEqual(definition.parameters.required, ['cursor', 'max_output_chars']);
  assert.match(definition.description, /不重新执行原工具/);
  assert.deepEqual(normalizeReadToolOutputArguments({ cursor: '  abc  ' }), { cursor: 'abc' });
  assert.throws(() => normalizeReadToolOutputArguments({ cursor: '' }), /cursor 不能为空/);
});
