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
    CONVERSATION_DOCUMENT_VIEW_MODE_MARKDOWN,
    CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN,
    resolveConversationDocumentRenderState
  } = await importViewerStateModule();

  const mdState = resolveConversationDocumentRenderState('docs/plan.md', {});
  assert.equal(mdState.mode, CONVERSATION_DOCUMENT_VIEW_MODE_MARKDOWN);
  assert.equal(mdState.allowMarkdownToggle, true);

  const txtState = resolveConversationDocumentRenderState('docs/notes.txt', {});
  assert.equal(txtState.mode, CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN);
  assert.equal(txtState.allowMarkdownToggle, true);

  const codeState = resolveConversationDocumentRenderState('src/sample.js', {});
  assert.equal(codeState.mode, CONVERSATION_DOCUMENT_VIEW_MODE_CODE_HIGHLIGHT);
  assert.equal(codeState.allowCodeHighlightToggle, true);

  const otherState = resolveConversationDocumentRenderState('docs/readme.rst', {});
  assert.equal(otherState.mode, CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN);
  assert.equal(otherState.allowMarkdownToggle, false);
});

test('全局默认值与按路径 override 会正确合并', async () => {
  const {
    CONVERSATION_DOCUMENT_VIEW_MODE_MARKDOWN,
    CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN,
    resolveConversationDocumentRenderState
  } = await importViewerStateModule();

  const txtMarkdownState = resolveConversationDocumentRenderState('docs/notes.txt', {
    documentRenderMarkdownForTxt: true
  });
  assert.equal(txtMarkdownState.mode, CONVERSATION_DOCUMENT_VIEW_MODE_MARKDOWN);

  const overriddenMdState = resolveConversationDocumentRenderState('docs/plan.md', {
    documentRenderMarkdownForMd: true,
    documentViewModeOverrides: {
      'docs/plan.md': 'plain'
    }
  });
  assert.equal(overriddenMdState.mode, CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN);
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
