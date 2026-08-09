const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

test('Responses 页面读取工具按普通网页与 PDF 页面互斥暴露', async () => {
  const messageSenderSource = await fs.readFile(
    path.resolve(__dirname, '../src/core/message_sender.js'),
    'utf8'
  );
  const registrySource = await fs.readFile(
    path.resolve(__dirname, '../src/agent_tools/shared/responses_extension_tool_registry.js'),
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
  assert.match(messageSenderSource, /buildResponsesExtensionTools\(\{\s*pageToolEnvironment,/s);
  assert.match(registrySource, /case 'html_page':/);
  assert.match(registrySource, /pageToolEnvironment\?\.exposePageContentTool\s*===\s*true/);
  assert.match(registrySource, /pageToolEnvironment\?\.exposePdfContentTool\s*!==\s*true/);
  assert.match(registrySource, /case 'pdf_page':/);
  assert.match(registrySource, /pageToolEnvironment\?\.exposePdfContentTool\s*===\s*true/);
});
