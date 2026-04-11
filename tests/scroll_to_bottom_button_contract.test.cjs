const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  return fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

test('scroll-to-bottom 按钮的 DOM、样式与 UI wiring 已接入侧栏', async () => {
  const [sidebarHtml, sidebarAppContextSource, sidebarCss, uiManagerSource] = await Promise.all([
    readWorkspaceFile('src/ui/sidebar/sidebar.html'),
    readWorkspaceFile('src/ui/sidebar/sidebar_app_context.js'),
    readWorkspaceFile('src/ui/styles/sidebar.css'),
    readWorkspaceFile('src/ui/ui_manager.js')
  ]);

  assert.match(
    sidebarHtml,
    /<div id="composer-accessory-region"[\s\S]*?<div id="scroll-to-bottom-anchor"[\s\S]*?<button id="scroll-to-bottom-button"[\s\S]*?fa-solid fa-chevron-down/s
  );

  assert.match(
    sidebarAppContextSource,
    /scrollToBottomAnchor: document\.getElementById\('scroll-to-bottom-anchor'\),/
  );
  assert.match(
    sidebarAppContextSource,
    /scrollToBottomButton: document\.getElementById\('scroll-to-bottom-button'\),/
  );

  assert.match(
    sidebarCss,
    /#scroll-to-bottom-anchor\s*\{[\s\S]*?order:\s*999;[\s\S]*?height:\s*0;/s
  );
  assert.match(
    sidebarCss,
    /#scroll-to-bottom-button\s*\{[\s\S]*?left:\s*50%;[\s\S]*?bottom:\s*12px;[\s\S]*?opacity:\s*0;[\s\S]*?pointer-events:\s*none;/s
  );
  assert.match(
    sidebarCss,
    /#scroll-to-bottom-button\.is-visible\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;/s
  );

  assert.match(
    uiManagerSource,
    /const SCROLL_TO_BOTTOM_BUTTON_THRESHOLD_PX = 48;/
  );
  assert.match(
    uiManagerSource,
    /function resolveScrollToBottomTargetContainer\(\) \{[\s\S]*?thread-mode-active[\s\S]*?return chatContainer;/s
  );
  assert.match(
    uiManagerSource,
    /function updateScrollToBottomButtonVisibility\(\) \{[\s\S]*?distanceToBottom > SCROLL_TO_BOTTOM_BUTTON_THRESHOLD_PX[\s\S]*?setScrollToBottomButtonVisible\(shouldShow\);/s
  );
  assert.match(
    uiManagerSource,
    /if \(settingsManager\?\.getSetting\?\.\('autoScroll'\) !== false\) \{\s*messageSender\.setShouldAutoScroll\(true\);/s
  );
  assert.match(
    uiManagerSource,
    /targetContainer\.scrollTo\(\{\s*top:\s*Math\.max\(0, targetContainer\.scrollHeight \|\| 0\),\s*behavior:\s*'smooth'/s
  );
  assert.match(
    uiManagerSource,
    /function setupScrollToBottomButton\(\) \{[\s\S]*?new MutationObserver[\s\S]*?new ResizeObserver[\s\S]*?scheduleScrollToBottomButtonVisibilityUpdate\(\);/s
  );
});
