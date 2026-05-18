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
    sidebarCss
  ] = await Promise.all([
    readWorkspaceFile('src/ui/context_menu_manager.js'),
    readWorkspaceFile('src/ui/sidebar/sidebar.html'),
    readWorkspaceFile('src/ui/sidebar/sidebar_app_context.js'),
    readWorkspaceFile('src/ui/styles/sidebar.css')
  ]);

  assert.match(
    sidebarHtml,
    /id="select-for-image"[\s\S]*?选择长截图/
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
    /const selectedMessageElements = getOrderedScreenshotSelectionMessageElements\(messageElement\);[\s\S]*?const isMultiMessageExport = messageElements\.length > 1;[\s\S]*?createMessagesScreenshotSnapshot\(messageElements, exportOptions\)/
  );
  assert.match(
    contextMenuSource,
    /copyAsImageButton\.addEventListener\(MENU_ACTIVATE_EVENT, copyMessageAsImage\);[\s\S]*?selectForImageButton\.addEventListener\(MENU_ACTIVATE_EVENT/
  );

  assert.match(sidebarCss, /\.message\.message-screenshot-selectable/);
  assert.match(sidebarCss, /\.message\.message-screenshot-selected/);
  assert.match(sidebarCss, /\.message-screenshot-selection-toolbar/);
  assert.match(sidebarCss, /\.message-screenshot-transcript \.ai-message/);
});
