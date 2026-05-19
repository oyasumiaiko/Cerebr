const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('settings_manager 已注册过长代码块折叠开关', async () => {
  const source = await readWorkspaceFile('src/ui/settings_manager.js');

  assert.match(source, /collapseLongCodeBlocks/);
  assert.match(source, /label: '折叠过长代码块'/);
});

test('markdown_renderer 会为 fenced code block 输出可增强的包装节点', async () => {
  const source = await readWorkspaceFile('src/utils/markdown_renderer.js');

  assert.match(source, /normalizeCodeFenceLanguage/);
  assert.match(source, /cerebr-markdown-code-block/);
  assert.match(source, /data-code-language/);
});

test('message_processor 会给 Markdown 代码块挂载语言标签、复制按钮与展开按钮', async () => {
  const source = await readWorkspaceFile('src/core/message_processor.js');

  assert.match(source, /enhanceRenderedMarkdownCodeBlocks/);
  assert.match(source, /cerebr-markdown-code-block__language/);
  assert.match(source, /cerebr-markdown-code-block__copy/);
  assert.match(source, /navigator\.clipboard\?\.writeText/);
  assert.match(source, /cerebr-markdown-code-block__toggle/);
  assert.match(source, /rootElement\.matches\('.*cerebr-markdown-code-block.*'\)/);
  assert.match(source, /subscribe\?\.\('collapseLongCodeBlocks'/);
});

test('conversation_document_viewer 的 Markdown 模式也会复用挂载期增强链路', async () => {
  const source = await readWorkspaceFile('src/utils/conversation_document_viewer.js');

  assert.match(source, /enhanceMarkdownContent/);
  assert.match(source, /renderState\.mode === CONVERSATION_DOCUMENT_VIEW_MODE_MARKDOWN/);
});

test('sidebar.css 已提供代码块工具条与 50vh 折叠体样式', async () => {
  const source = await readWorkspaceFile('src/ui/styles/sidebar.css');

  assert.match(source, /\.message \.cerebr-markdown-code-block/);
  assert.match(source, /\.message \.cerebr-markdown-code-block__header/);
  assert.match(source, /\.message \.cerebr-markdown-code-block__action/);
  assert.match(source, /\.message \.cerebr-markdown-code-block\.is-collapsible:not\(\.is-expanded\) \.cerebr-markdown-code-block__body/);
  assert.match(source, /max-height: 50vh;/);
});

test('sidebar.css 保证 Markdown 代码块换行并可横向滚动', async () => {
  const source = await readWorkspaceFile('src/ui/styles/sidebar.css');

  assert.match(
    source,
    /\.message \.cerebr-markdown-code-block__body\s*\{[\s\S]*overflow-x:\s*auto;[\s\S]*overflow-y:\s*hidden;[\s\S]*overscroll-behavior-x:\s*contain;[\s\S]*\}/
  );
  assert.match(
    source,
    /\.message \.cerebr-markdown-code-block\.is-collapsible\.is-expanded \.cerebr-markdown-code-block__body\s*\{[\s\S]*overflow-x:\s*auto;[\s\S]*overflow-y:\s*hidden;[\s\S]*\}/
  );
  assert.match(
    source,
    /\.message \.cerebr-markdown-code-block pre code\s*\{[\s\S]*white-space:\s*pre-wrap;[\s\S]*overflow:\s*visible;[\s\S]*\}/
  );
});
