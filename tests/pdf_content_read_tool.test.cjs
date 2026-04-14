const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadPdfContentReadToolModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/pdf_content_read/tool.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('buildPdfContentReadResult 默认返回 PDF 章节索引 overview', async () => {
  const { buildPdfContentReadResult } = await loadPdfContentReadToolModule();
  const result = buildPdfContentReadResult({
    title: 'PDF',
    url: 'https://example.com/a.pdf',
    isPDF: true,
    content: '总正文',
    chapters: [
      {
        chapterTitle: '第一章',
        pageNumber: 1,
        content: '第一章 正文',
        children: [
          {
            chapterTitle: '第一章 第一节',
            pageNumber: 2,
            content: '第一节 正文',
            children: []
          }
        ]
      }
    ]
  }, {
    chapter_id: null,
    chunk_index: null,
    max_chars: null,
    include_outline: null
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'overview');
  assert.equal(result.total_chapters, 2);
  assert.equal(result.default_max_chars, 10000);
  assert.equal(result.max_chars_limit, 50000);
  assert.equal(result.outline[0].chapter_id, '1');
  assert.equal(result.outline[1].chapter_id, '1.1');
  assert.match(result.guidance, /chapter_id/);
});

test('buildPdfContentReadResult 支持按章节读取指定 chunk，并可附带 outline', async () => {
  const { buildPdfContentReadResult } = await loadPdfContentReadToolModule();
  const result = buildPdfContentReadResult({
    title: 'PDF',
    url: 'https://example.com/a.pdf',
    isPDF: true,
    content: 'A'.repeat(4500),
    chapters: [
      {
        chapterTitle: '第一章',
        pageNumber: 1,
        content: 'A'.repeat(4500),
        children: []
      }
    ]
  }, {
    chapter_id: '1',
    chunk_index: 1,
    max_chars: 2000,
    include_outline: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'chapter_chunk');
  assert.equal(result.chunk_index, 1);
  assert.equal(result.total_chunks, 3);
  assert.equal(result.returned_chars, 2000);
  assert.equal(result.selection.chapter_id, '1');
  assert.equal(Array.isArray(result.outline), true);
  assert.equal(result.content.length, 2000);
});

test('buildPdfContentReadResult 支持按整篇 PDF 顺序读取 chunk', async () => {
  const { buildPdfContentReadResult } = await loadPdfContentReadToolModule();
  const result = buildPdfContentReadResult({
    title: 'PDF',
    url: 'https://example.com/a.pdf',
    isPDF: true,
    content: '0123456789ABCDEFGHIJ',
    chapters: []
  }, {
    chapter_id: null,
    chunk_index: 1,
    max_chars: 6,
    include_outline: false
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'document_chunk');
  assert.equal(result.chunk_index, 1);
  assert.equal(result.content, '6789AB');
  assert.equal(result.has_next_chunk, true);
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
    chunk_index: null,
    max_chars: null,
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
    chapters: [
      {
        chapterTitle: '第一章',
        pageNumber: 1,
        content: 'Alpha',
        children: []
      }
    ]
  }, {
    chapter_id: '9.9',
    chunk_index: 0,
    max_chars: 100,
    include_outline: false
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.name, 'PdfChapterNotFoundError');
});
