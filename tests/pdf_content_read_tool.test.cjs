const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadPdfContentReadToolModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/pdf_content_read/tool.js');
  return import(`${pathToFileURL(filePath).href}?test=${Date.now()}`);
}

test('buildPdfContentReadResult 默认返回 PDF 章节索引 overview', async () => {
  const { buildPdfContentReadResult } = await loadPdfContentReadToolModule();
  const result = buildPdfContentReadResult({
    title: 'PDF',
    url: 'https://example.com/a.pdf',
    isPDF: true,
    content: '总正文',
    chapters: [{
      chapterTitle: '第一章',
      pageNumber: 1,
      content: '第一章 正文',
      children: [{
        chapterTitle: '第一章 第一节',
        pageNumber: 2,
        content: '第一节 正文',
        children: []
      }]
    }]
  }, {
    chapter_id: null,
    read_document: null,
    max_output_chars: null,
    include_outline: null
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'overview');
  assert.equal(result.total_chapters, 2);
  assert.equal(result.max_output_chars, undefined);
  assert.equal(result.outline[0].chunk_count, undefined);
  assert.equal(result.outline[0].chapter_id, '1');
  assert.equal(result.outline[1].chapter_id, '1.1');
  assert.match(result.guidance, /read_tool_output/);
});

test('buildPdfContentReadResult 支持一次读取完整章节，并可附带 outline', async () => {
  const { buildPdfContentReadResult } = await loadPdfContentReadToolModule();
  const result = buildPdfContentReadResult({
    title: 'PDF',
    url: 'https://example.com/a.pdf',
    isPDF: true,
    content: 'A'.repeat(4500),
    chapters: [{
      chapterTitle: '第一章',
      pageNumber: 1,
      content: 'A'.repeat(4500),
      children: []
    }]
  }, {
    chapter_id: '1',
    read_document: false,
    max_output_chars: 2000,
    include_outline: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'chapter');
  assert.equal(result.chunk_index, undefined);
  assert.equal(result.total_chunks, undefined);
  assert.equal(result.returned_chars, 4500);
  assert.equal(result.selection.chapter_id, '1');
  assert.equal(Array.isArray(result.outline), true);
  assert.equal(result.content.length, 4500);
});

test('buildPdfContentReadResult 支持一次生成完整 PDF 正文', async () => {
  const { buildPdfContentReadResult } = await loadPdfContentReadToolModule();
  const result = buildPdfContentReadResult({
    title: 'PDF',
    url: 'https://example.com/a.pdf',
    isPDF: true,
    content: '0123456789ABCDEFGHIJ',
    chapters: []
  }, {
    chapter_id: null,
    read_document: true,
    max_output_chars: 6,
    include_outline: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'document');
  assert.equal(result.chunk_index, undefined);
  assert.equal(result.content, '0123456789ABCDEFGHIJ');
  assert.equal(result.has_next_chunk, undefined);
});

test('buildPdfContentReadResult 不会在统一出口前按 max_output_chars 预截断', async () => {
  const { buildPdfContentReadResult } = await loadPdfContentReadToolModule();
  const result = buildPdfContentReadResult({
    title: 'Long PDF',
    url: 'https://example.com/long.pdf',
    isPDF: true,
    content: 'D'.repeat(130000),
    chapters: []
  }, {
    chapter_id: null,
    read_document: true,
    max_output_chars: 100,
    include_outline: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.max_output_chars, undefined);
  assert.equal(result.returned_chars, 130000);
  assert.equal(result.content.length, 130000);
});

test('buildPdfContentReadResult 在非 PDF 页面返回明确错误', async () => {
  const { buildPdfContentReadResult } = await loadPdfContentReadToolModule();
  const result = buildPdfContentReadResult({
    title: 'HTML',
    url: 'https://example.com',
    isPDF: false,
    content: 'hello'
  }, {
    chapter_id: null,
    read_document: null,
    max_output_chars: null,
    include_outline: null
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.name, 'NotPdfPageError');
});

test('buildPdfContentReadResult 在 chapter_id 不存在时返回明确错误', async () => {
  const { buildPdfContentReadResult } = await loadPdfContentReadToolModule();
  const result = buildPdfContentReadResult({
    title: 'PDF',
    url: 'https://example.com/a.pdf',
    isPDF: true,
    content: 'Alpha',
    chapters: [{
      chapterTitle: '第一章',
      pageNumber: 1,
      content: 'Alpha',
      children: []
    }]
  }, {
    chapter_id: '9.9',
    read_document: false,
    max_output_chars: 100,
    include_outline: false
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.name, 'PdfChapterNotFoundError');
});

test('buildPdfContentReadResult 拒绝同时读取章节与全文', async () => {
  const { buildPdfContentReadResult } = await loadPdfContentReadToolModule();
  assert.throws(() => buildPdfContentReadResult({
    title: 'PDF',
    url: 'https://example.com/a.pdf',
    isPDF: true,
    content: 'Alpha',
    chapters: [{ chapterTitle: '第一章', content: 'Alpha', children: [] }]
  }, {
    chapter_id: '1',
    read_document: true,
    include_outline: false
  }), /不能同时使用/);
});
