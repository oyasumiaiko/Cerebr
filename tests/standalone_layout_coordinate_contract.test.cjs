const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  return fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

test('独立页 Esc 面板尺寸与位置统一使用 zoom-aware 布局坐标', async () => {
  const source = await readWorkspaceFile('src/ui/chat_history_ui.js');

  assert.match(source, /from '\.\.\/utils\/coordinate_space\.js';/);
  assert.match(source, /function getChatHistoryPanelDocumentLayoutRect\(panel\) \{[\s\S]*?getElementLayoutRect\(panel, \{ zoomFactor \}\);[\s\S]*?\}/s);
  assert.match(source, /function getChatHistoryPanelDocumentLayoutSize\(panel\) \{[\s\S]*?getElementLayoutSize\(panel, \{ zoomFactor \}\);[\s\S]*?\}/s);
  assert.match(source, /function getChatHistoryPanelDocumentLayoutViewport\(\) \{[\s\S]*?getLayoutViewportSize\(\{ zoomFactor \}\);[\s\S]*?\}/s);
  assert.match(
    source,
    /function persistChatHistoryPanelLayout\(panel\) \{[\s\S]*?const layoutRect = getChatHistoryPanelDocumentLayoutRect\(panel\);[\s\S]*?const layoutSize = getChatHistoryPanelDocumentLayoutSize\(panel\);[\s\S]*?readPositiveStylePixelValue\(panel, 'width'\) \|\| layoutSize\.width \|\| layoutRect\.width/s
  );
  assert.match(
    source,
    /function clampChatHistoryPanelSize\(panel, nextWidth = null, nextHeight = null\) \{[\s\S]*?const layoutSize = getChatHistoryPanelDocumentLayoutSize\(panel\);[\s\S]*?const viewport = getChatHistoryPanelDocumentLayoutViewport\(\);[\s\S]*?viewport\.width - CHAT_HISTORY_PANEL_RESIZE_MARGIN_PX \* 2/s
  );
  assert.match(
    source,
    /const layoutRect = getChatHistoryPanelDocumentLayoutRect\(panel\);[\s\S]*?panel\.style\.left = `\$\{Math\.round\(layoutRect\.left\)\}px`;[\s\S]*?panel\.style\.top = `\$\{Math\.round\(layoutRect\.top\)\}px`;/s
  );
  assert.doesNotMatch(source, /window\.innerWidth - rect\.width/);
  assert.doesNotMatch(source, /window\.innerHeight - rect\.height/);
  assert.doesNotMatch(source, /const rawWidth = Number\.isFinite\(nextWidth\) \? Number\(nextWidth\) : rect\.width/);
});

test('独立页全屏聊天宽度上限使用可见视口宽度', async () => {
  const source = await readWorkspaceFile('src/ui/settings_manager.js');

  assert.match(
    source,
    /function getCurrentViewportWidthForFullscreenSetting\(\) \{[\s\S]*?if \(isStandalone\) \{[\s\S]*?window\.visualViewport\?\.width[\s\S]*?window\.innerWidth[\s\S]*?document\.documentElement\?\.clientWidth[\s\S]*?\}[\s\S]*?--cerebr-viewport-width/s
  );
});

test('独立页设置菜单定位复用共享坐标空间工具', async () => {
  const source = await readWorkspaceFile('src/ui/ui_manager.js');

  assert.match(source, /from '\.\.\/utils\/coordinate_space\.js';/);
  assert.match(
    source,
    /function positionSettingsMenu\(\) \{[\s\S]*?const zoomFactor = getDocumentZoomFactor\(\);[\s\S]*?getElementLayoutRect\(dom\.settingsButton, \{ zoomFactor \}\)[\s\S]*?getLayoutViewportSize\(\{ zoomFactor \}\)[\s\S]*?getElementLayoutSize\(menu, \{ zoomFactor \}\)/s
  );
  assert.doesNotMatch(source, /function toLayoutPixels\(value, zoomFactor = getDocumentZoomFactor\(\)\)/);
});
