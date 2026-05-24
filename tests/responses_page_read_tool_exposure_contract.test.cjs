const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

test('Responses 页面读取工具按普通网页与 PDF 页面互斥暴露', async () => {
  const messageSenderSource = await fs.readFile(
    path.resolve(__dirname, '../src/core/message_sender.js'),
    'utf8'
  );
  const pageContextSource = await fs.readFile(
    path.resolve(__dirname, '../src/ui/sidebar/sidebar_app_context.js'),
    'utf8'
  );
  const contentSource = await fs.readFile(
    path.resolve(__dirname, '../src/extension/content.js'),
    'utf8'
  );

  assert.match(contentSource, /isPdf:\s*isCurrentPagePdfLike\(\)/);
  assert.match(pageContextSource, /pageInfo\.isPdf\s*===\s*true/);
  assert.match(pageContextSource, /isPdfPage/);
  assert.match(messageSenderSource, /pageToolEnvironment\?\.exposePdfContentTool/);
  assert.match(
    messageSenderSource,
    /else\s+if\s*\(\s*pageToolEnvironment\?\.exposePageContentTool\s*\)\s*\{\s*tools\.push\(buildPageContentReadFunctionToolDefinition\(\)\);/s
  );
});
