const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  return fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

test('多消息长截图选择入口与导出管线保持同一套复制为图片实现', async () => {
  const [
    contextMenuSource,
    sidebarHtml,
    sidebarAppContextSource,
    sidebarCss,
    manifestSource
  ] = await Promise.all([
    readWorkspaceFile('src/ui/context_menu_manager.js'),
    readWorkspaceFile('src/ui/sidebar/sidebar.html'),
    readWorkspaceFile('src/ui/sidebar/sidebar_app_context.js'),
    readWorkspaceFile('src/ui/styles/sidebar.css'),
    readWorkspaceFile('manifest.json')
  ]);

  assert.match(
    sidebarHtml,
    /id="message-screenshot-menu"[\s\S]*?截图[\s\S]*?id="download-as-image"[\s\S]*?下载当前消息截图[\s\S]*?id="select-for-image"[\s\S]*?选择长截图/
  );
  assert.doesNotMatch(sidebarHtml, /id="copy-as-image"/);
  assert.match(
    sidebarAppContextSource,
    /screenshotMenu:\s*document\.getElementById\('message-screenshot-menu'\)/
  );
  assert.match(
    sidebarAppContextSource,
    /downloadAsImageButton:\s*document\.getElementById\('download-as-image'\)/
  );
  assert.match(
    sidebarAppContextSource,
    /selectForImageButton:\s*document\.getElementById\('select-for-image'\)/
  );

  assert.match(
    contextMenuSource,
    /const messageScreenshotSelection = \{[\s\S]*?selectedIds: new Set\(\),[\s\S]*?toolbar: null[\s\S]*?\};/
  );
  assert.match(
    contextMenuSource,
    /function toggleMessageScreenshotSelection\(messageElement\) \{[\s\S]*?messageScreenshotSelection\.selectedIds\.(?:add|delete)\(messageId\)[\s\S]*?syncMessageScreenshotSelectionDecorations\(\);[\s\S]*?\}/
  );
  assert.match(
    contextMenuSource,
    /container\.addEventListener\('click', \(e\) => \{[\s\S]*?handleMessageScreenshotSelectionClick\(e, container\);[\s\S]*?\}, true\);/
  );

  assert.match(
    contextMenuSource,
    /function createMessagesScreenshotSnapshot\(messageElements, options = \{\}\) \{[\s\S]*?message-screenshot-transcript[\s\S]*?prepareMessageScreenshotCloneTree\(snapshotNode\);/
  );
  assert.match(
    contextMenuSource,
    /async function copyMessageAsImage\(\) \{[\s\S]*?const selectedMessageElements = getOrderedScreenshotSelectionMessageElements\(messageElement\);[\s\S]*?const isMultiMessageExport = messageElements\.length > 1;[\s\S]*?createMessagesScreenshotSnapshot\(messageElements, exportOptions\)/
  );
  assert.match(
    contextMenuSource,
    /function showMessageScreenshotExportNotification\(messageElements\) \{[\s\S]*?正在生成长截图[\s\S]*?progressMode: 'indeterminate'/
  );
  assert.match(
    contextMenuSource,
    /function updateMessageScreenshotExportNotification\(toast, state, detail = \{\}\) \{[\s\S]*?截图完成，已复制到剪贴板[\s\S]*?截图完成，已下载图片/
  );
  assert.match(
    contextMenuSource,
    /function writeScreenshotBlobToClipboard\(blob\) \{[\s\S]*?navigator\.clipboard\.write[\s\S]*?'image\/png': blob/
  );
  assert.match(
    contextMenuSource,
    /const renderInfo = await renderMessageScreenshotSnapshotToBlob\([\s\S]*?writeScreenshotBlobToClipboard\(renderInfo\.blob\)/
  );
  assert.match(
    contextMenuSource,
    /resolveMessageScreenshotRenderPlan\(\{[\s\S]*?requestedScale: exportOptions\.resolutionScale[\s\S]*?renderPlan\.appliedScale/
  );
  assert.match(
    contextMenuSource,
    /renderInfo\?\.scaleAdjusted[\s\S]*?浏览器单张 PNG 单边[\s\S]*?像素倍率/
  );
  assert.doesNotMatch(
    contextMenuSource,
    /getImageData\(0, 0, newWidth, newHeight\)/
  );
  assert.match(
    contextMenuSource,
    /function downloadScreenshotBlob\(blob, filenamePrefix = '消息截图'\) \{[\s\S]*?a\.download[\s\S]*?return 'download'/
  );
  const clipboardWriterStart = contextMenuSource.indexOf('async function writeScreenshotBlobToClipboard');
  const clipboardWriterEnd = contextMenuSource.indexOf('\n  function downloadScreenshotBlob', clipboardWriterStart);
  assert.ok(clipboardWriterStart >= 0 && clipboardWriterEnd > clipboardWriterStart);
  assert.doesNotMatch(
    contextMenuSource.slice(clipboardWriterStart, clipboardWriterEnd),
    /a\.download/
  );
  assert.doesNotMatch(manifestSource, /"clipboardWrite"/);
  assert.match(
    contextMenuSource,
    /function setMessageScreenshotExporting\(isExporting, target = null\) \{[\s\S]*?updateMessageScreenshotSelectionToolbar\(\);[\s\S]*?\}/
  );
  assert.match(
    contextMenuSource,
    /const screenshotSubmenu = screenshotMenu\?\.querySelector\('\.context-menu-submenu'\);[\s\S]*?ensureSubmenuPortal\(screenshotSubmenu\);[\s\S]*?bindPortalSubmenuHover\(screenshotMenu, screenshotSubmenu\);/
  );
  assert.match(
    contextMenuSource,
    /screenshotMenu\?\.addEventListener\(MENU_ACTIVATE_EVENT,[\s\S]*?copyMessageAsImage\(\);[\s\S]*?downloadAsImageButton\.addEventListener\(MENU_ACTIVATE_EVENT, downloadMessageAsImage\);[\s\S]*?selectForImageButton\.addEventListener\(MENU_ACTIVATE_EVENT/
  );
  assert.match(contextMenuSource, /data-action="copy"[\s\S]*?data-action="download"/);

  assert.match(sidebarCss, /\.message\.message-screenshot-selectable/);
  assert.match(sidebarCss, /\.message\.message-screenshot-selected/);
  assert.match(sidebarCss, /\.message-screenshot-selection-toolbar/);
  assert.match(sidebarCss, /\.message-screenshot-selection-toolbar__button\.is-busy/);
  assert.match(sidebarCss, /\.context-menu-submenu-item--icon/);
  assert.match(sidebarCss, /\.message-screenshot-transcript \.ai-message/);
});
