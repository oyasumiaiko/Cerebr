const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('message_sender 已注册对话文档顶层工具并接入专用执行分支', async () => {
  const source = await readWorkspaceFile('src/core/message_sender.js');

  assert.match(source, /buildVirtualFileApplyPatchFunctionToolDefinition\(\)/);
  assert.match(source, /buildVirtualFileListFilesFunctionToolDefinition\(\)/);
  assert.match(source, /buildVirtualFileReadFileFunctionToolDefinition\(\)/);
  assert.match(source, /buildVirtualFileSearchFilesFunctionToolDefinition\(\)/);
  assert.match(source, /buildVirtualFileCopyFileFunctionToolDefinition\(\)/);
  assert.match(source, /buildVirtualFileMoveFileFunctionToolDefinition\(\)/);
  assert.match(source, /buildVirtualFileDeleteFileFunctionToolDefinition\(\)/);
  assert.match(source, /executeResponsesVirtualFileFunction\(functionName \|\| canonicalFunctionName, parsedArgs, options\)/);
  assert.match(source, /serializeResponsesConversationDocumentFunctionToolOutput\(functionName \|\| canonicalFunctionName, outputPayload\)/);
  assert.match(source, /consumePendingUploadedFileEnvironmentEntries/);
  assert.match(source, /uploadedFiles: uploadedFileEnvironmentEntries/);
});

test('message_processor 已把裸相对路径链接替换为文档卡片，并监听文档变更事件', async () => {
  const source = await readWorkspaceFile('src/core/message_processor.js');
  const viewerSource = await readWorkspaceFile('src/utils/conversation_document_viewer.js');

  assert.match(source, /isConversationDocumentRelativeHref\(rawHref\)/);
  assert.match(source, /createConversationDocumentViewer/);
  assert.match(source, /syncConversationDocumentAttachmentStrip/);
  assert.match(source, /createConversationDocumentCard\(link\)/);
  assert.match(source, /CONVERSATION_DOCUMENT_CHANGE_EVENT_NAME/);
  assert.match(viewerSource, /conversation-document-card/);
  assert.match(viewerSource, /conversation-document-attachments/);
});

test('conversation_document_viewer 使用无边框图标按钮承载基础文档操作', async () => {
  const source = await readWorkspaceFile('src/utils/conversation_document_viewer.js');

  assert.match(source, /conversation-document-card__tool-button/);
  assert.match(source, /fa-regular fa-pen-to-square/);
  assert.match(source, /fa-regular fa-copy/);
  assert.match(source, /fa-solid fa-download/);
  assert.match(source, /fa-brands fa-markdown/);
  assert.match(source, /fa-brands fa-html5/);
  assert.match(source, /fa-solid fa-code/);
  assert.match(source, /fa-solid fa-expand/);
});

test('conversation_document_viewer 会通过 manifest sandbox page 渲染 HTML 文件预览', async () => {
  const source = await readWorkspaceFile('src/utils/conversation_document_viewer.js');
  const stateSource = await readWorkspaceFile('src/utils/conversation_document_viewer_state.js');
  const sidebarCssSource = await readWorkspaceFile('src/ui/styles/sidebar.css');
  const manifestSource = await readWorkspaceFile('manifest.json');
  const sandboxHtmlSource = await readWorkspaceFile('src/ui/html_preview_sandbox/html_preview_sandbox.html');

  assert.match(stateSource, /CONVERSATION_DOCUMENT_VIEW_MODE_HTML_PREVIEW/);
  assert.match(stateSource, /HTML_PREVIEW_EXTENSIONS/);
  assert.match(source, /renderHtmlPreviewContent/);
  assert.match(source, /HTML_PREVIEW_SANDBOX_FRAME_URL/);
  assert.match(source, /html_preview_sandbox\/html_preview_sandbox\.html/);
  assert.match(source, /CEREBR_HTML_PREVIEW_RENDER/);
  assert.match(source, /CEREBR_HTML_PREVIEW_READY/);
  assert.match(source, /conversation-document-card__content--html-preview/);
  assert.doesNotMatch(source, /frame\.setAttribute\('sandbox'/);
  assert.doesNotMatch(source, /allow-same-origin/);
  assert.doesNotMatch(source, /frame\.srcdoc = content \|\| ''/);
  assert.match(sandboxHtmlSource, /sandbox="allow-scripts allow-forms allow-popups allow-modals"/);
  assert.doesNotMatch(sandboxHtmlSource, /allow-same-origin/);
  assert.match(sidebarCssSource, /\.conversation-document-card__html-frame/);
  assert.match(manifestSource, /"sandbox"\s*:\s*\{/);
  assert.match(manifestSource, /src\/ui\/html_preview_sandbox\/html_preview_sandbox\.html/);
  assert.match(manifestSource, /src\/ui\/html_preview_sandbox\/\*/);
});

test('conversation_document_viewer 为 HTML iframe 提供不重建 iframe 的放大预览入口', async () => {
  const viewerSource = await readWorkspaceFile('src/utils/conversation_document_viewer.js');
  const sidebarCssSource = await readWorkspaceFile('src/ui/styles/sidebar.css');
  const contentSource = await readWorkspaceFile('src/extension/content.js');

  assert.match(viewerSource, /toggleConversationDocumentHtmlPopout/);
  assert.match(viewerSource, /closeConversationDocumentHtmlPopout/);
  assert.match(viewerSource, /conversation-document-card__tool-button--html-fullscreen/);
  assert.doesNotMatch(viewerSource, /requestFullscreen\(\)/);
  assert.doesNotMatch(viewerSource, /exitFullscreen\(\)/);
  assert.match(sidebarCssSource, /\.conversation-document-card__content--html-preview\.is-popout/);
  assert.match(sidebarCssSource, /\.conversation-document-html-popout__toggle/);
  assert.doesNotMatch(sidebarCssSource, /\.conversation-document-html-fullscreen__toolbar/);
  assert.match(contentSource, /iframe\.allow = 'clipboard-write; file-system-access; fullscreen'/);
});

test('settings_manager 已注册文档渲染默认值偏好', async () => {
  const source = await readWorkspaceFile('src/ui/settings_manager.js');

  assert.match(source, /documentFontSizePercent/);
  assert.match(source, /documentRenderMarkdownForMd/);
  assert.match(source, /documentRenderMarkdownForTxt/);
  assert.match(source, /documentHighlightCodeByExtension/);
  assert.match(source, /documentViewModeOverrides/);
});

test('chat_history_ui 已在 fork 与备份恢复链路中处理对话文档', async () => {
  const source = await readWorkspaceFile('src/ui/chat_history_ui.js');

  assert.match(source, /copyConversationDocuments\(parentConversationId, newConversationId\)/);
  assert.match(source, /copyLocalFileMounts\(parentConversationId, newConversationId\)/);
  assert.match(source, /const documents = await listConversationDocuments\(meta\.id\);/);
  assert.match(source, /await replaceConversationDocuments\(conversationToStore\.id, documentSnapshot\);/);
});
