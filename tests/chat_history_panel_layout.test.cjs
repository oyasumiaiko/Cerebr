const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadChatHistoryPanelLayoutModule() {
  const filePath = path.resolve(__dirname, '../src/utils/chat_history_panel_layout.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('normalizeChatHistoryPanelStoredLayout 兼容旧版 fullscreen-only payload', async () => {
  const {
    CHAT_HISTORY_PANEL_LAYOUT_STORAGE_VERSION,
    normalizeChatHistoryPanelStoredLayout
  } = await loadChatHistoryPanelLayoutModule();

  const result = normalizeChatHistoryPanelStoredLayout({
    version: 1,
    width: 960,
    height: 720,
    left: 80,
    top: 40,
    dragPositioned: true,
    sizeCustomized: true,
    updatedAt: 123
  });

  assert.equal(result.version, CHAT_HISTORY_PANEL_LAYOUT_STORAGE_VERSION);
  assert.deepEqual(result.fullscreen, {
    width: 960,
    height: 720,
    left: 80,
    top: 40,
    dragPositioned: true,
    sizeCustomized: true,
    updatedAt: 123
  });
  assert.equal(result.sidebar, null);
});

test('buildChatHistoryPanelStoredLayout 只覆盖当前模式并保留另一模式数据', async () => {
  const {
    CHAT_HISTORY_PANEL_LAYOUT_MODE_FULLSCREEN,
    CHAT_HISTORY_PANEL_LAYOUT_MODE_SIDEBAR,
    buildChatHistoryPanelStoredLayout,
    normalizeChatHistoryPanelStoredLayout
  } = await loadChatHistoryPanelLayoutModule();

  const existing = normalizeChatHistoryPanelStoredLayout({
    version: 2,
    fullscreen: {
      width: 900,
      height: 700,
      left: 30,
      top: 20,
      dragPositioned: true,
      sizeCustomized: true,
      updatedAt: 1
    }
  });

  const next = buildChatHistoryPanelStoredLayout({
    existingLayout: existing,
    mode: CHAT_HISTORY_PANEL_LAYOUT_MODE_SIDEBAR,
    entry: {
      width: 680,
      height: 540,
      sizeCustomized: true,
      updatedAt: 2
    }
  });

  assert.equal(next.fullscreen.width, 900);
  assert.equal(next.fullscreen.left, 30);
  assert.deepEqual(next.sidebar, {
    width: 680,
    height: 540,
    left: null,
    top: null,
    dragPositioned: false,
    sizeCustomized: true,
    updatedAt: 2
  });

  const replacedFullscreen = buildChatHistoryPanelStoredLayout({
    existingLayout: next,
    mode: CHAT_HISTORY_PANEL_LAYOUT_MODE_FULLSCREEN,
    entry: {
      width: 1000,
      height: 760,
      left: 50,
      top: 24,
      dragPositioned: false,
      sizeCustomized: true,
      updatedAt: 3
    }
  });

  assert.equal(replacedFullscreen.sidebar.width, 680);
  assert.equal(replacedFullscreen.fullscreen.width, 1000);
  assert.equal(replacedFullscreen.fullscreen.left, 50);
  assert.equal(replacedFullscreen.fullscreen.dragPositioned, false);
});

test('resolveChatHistoryPanelInteractionScale 会把文档缩放和宿主嵌入缩放相乘，并忽略非法值', async () => {
  const { resolveChatHistoryPanelInteractionScale } = await loadChatHistoryPanelLayoutModule();

  assert.equal(resolveChatHistoryPanelInteractionScale({
    documentZoomFactor: 1.25,
    hostEmbedScale: 0.8
  }), 1);

  assert.equal(resolveChatHistoryPanelInteractionScale({
    documentZoomFactor: 0,
    hostEmbedScale: null
  }), 1);
});
