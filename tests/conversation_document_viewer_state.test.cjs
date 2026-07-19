const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function importViewerStateModule() {
  const modulePath = path.resolve(__dirname, '../src/utils/conversation_document_viewer_state.js');
  return import(pathToFileURL(modulePath).href);
}

test('对 md/txt/code 文件会推断出正确的默认显示模式', async () => {
  const {
    CONVERSATION_DOCUMENT_VIEW_MODE_CODE_HIGHLIGHT,
    CONVERSATION_DOCUMENT_VIEW_MODE_HTML_PREVIEW,
    CONVERSATION_DOCUMENT_VIEW_MODE_MARKDOWN,
    CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN,
    resolveConversationDocumentRenderState
  } = await importViewerStateModule();

  const mdState = resolveConversationDocumentRenderState('plan.md', {});
  assert.equal(mdState.mode, CONVERSATION_DOCUMENT_VIEW_MODE_MARKDOWN);
  assert.equal(mdState.allowMarkdownToggle, true);

  const txtState = resolveConversationDocumentRenderState('notes.txt', {});
  assert.equal(txtState.mode, CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN);
  assert.equal(txtState.allowMarkdownToggle, false);
  assert.deepEqual(txtState.allowedModes, [CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN]);

  const codeState = resolveConversationDocumentRenderState('src/sample.js', {});
  assert.equal(codeState.mode, CONVERSATION_DOCUMENT_VIEW_MODE_CODE_HIGHLIGHT);
  assert.equal(codeState.allowCodeHighlightToggle, true);

  const htmlState = resolveConversationDocumentRenderState('preview.html', {});
  assert.equal(htmlState.mode, CONVERSATION_DOCUMENT_VIEW_MODE_HTML_PREVIEW);
  assert.equal(htmlState.language, 'xml');
  assert.equal(htmlState.allowHtmlPreviewToggle, true);
  assert.equal(htmlState.allowCodeHighlightToggle, true);
  assert.deepEqual(htmlState.allowedModes, [
    CONVERSATION_DOCUMENT_VIEW_MODE_HTML_PREVIEW,
    CONVERSATION_DOCUMENT_VIEW_MODE_CODE_HIGHLIGHT,
    CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN
  ]);

  const otherState = resolveConversationDocumentRenderState('readme.rst', {});
  assert.equal(otherState.mode, CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN);
  assert.equal(otherState.allowMarkdownToggle, false);
});

test('Markdown 默认偏好、固定 TXT 纯文本与按路径 override 会正确合并', async () => {
  const {
    CONVERSATION_DOCUMENT_VIEW_MODE_MARKDOWN,
    CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN,
    resolveConversationDocumentRenderState
  } = await importViewerStateModule();

  const txtPlainState = resolveConversationDocumentRenderState('notes.txt', {
    documentRenderMarkdownForTxt: true
  });
  assert.equal(txtPlainState.mode, CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN);

  const plainMdState = resolveConversationDocumentRenderState('notes.md', {
    documentRenderMarkdownForMd: false
  });
  assert.equal(plainMdState.mode, CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN);

  const overriddenMdState = resolveConversationDocumentRenderState('plan.md', {
    documentRenderMarkdownForMd: true,
    documentViewModeOverrides: {
      'plan.md': 'plain'
    }
  });
  assert.equal(overriddenMdState.mode, CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN);

  const overriddenHtmlState = resolveConversationDocumentRenderState('preview.html', {
    documentViewModeOverrides: {
      'preview.html': 'code-highlight'
    }
  });
  assert.equal(overriddenHtmlState.mode, 'code-highlight');

  const overriddenCodeState = resolveConversationDocumentRenderState('src/main.js', {
    documentViewModeOverrides: {
      'src/main.js': 'plain'
    }
  });
  assert.equal(overriddenCodeState.mode, CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN);
});

test('代码语言会按扩展名映射，未知扩展回退空字符串', async () => {
  const {
    clampConversationDocumentFontSizePercent,
    resolveConversationDocumentCodeLanguage
  } = await importViewerStateModule();

  assert.equal(resolveConversationDocumentCodeLanguage('src/main.tsx'), 'typescript');
  assert.equal(resolveConversationDocumentCodeLanguage('scripts/tool.ps1'), 'powershell');
  assert.equal(resolveConversationDocumentCodeLanguage('notes/unknown.xyz'), '');

  assert.equal(clampConversationDocumentFontSizePercent(83), 85);
  assert.equal(clampConversationDocumentFontSizePercent(107), 105);
  assert.equal(clampConversationDocumentFontSizePercent(151), 150);
});
