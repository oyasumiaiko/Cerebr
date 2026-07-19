const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  return fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

function readSettingDefinition(source, key) {
  const start = Math.max(
    source.indexOf(`key: '${key}'`),
    source.indexOf(`key: ${key}`)
  );
  assert.notEqual(start, -1, `missing setting: ${key}`);
  const end = source.indexOf('\n    },', start);
  assert.notEqual(end, -1, `unterminated setting: ${key}`);
  return source.slice(start, end);
}

test('右下角菜单只迁移点名设置，并保留位置按钮、新对话、停靠开关与底部收藏 API', async () => {
  const [settingsSource, sidebarHtml, sidebarAppContextSource, sidebarEventsSource, contentSource, sidebarCss] = await Promise.all([
    readWorkspaceFile('src/ui/settings_manager.js'),
    readWorkspaceFile('src/ui/sidebar/sidebar.html'),
    readWorkspaceFile('src/ui/sidebar/sidebar_app_context.js'),
    readWorkspaceFile('src/ui/sidebar/sidebar_events.js'),
    readWorkspaceFile('src/extension/content.js'),
    readWorkspaceFile('src/ui/styles/sidebar.css')
  ]);

  assert.match(readSettingDefinition(settingsSource, 'sidebarWidth'), /uiHidden:\s*true/);
  for (const key of [
    'enableScrollMinimap',
    'scrollMinimapWheelMessageStep',
    'scrollMinimapWidth',
    'scrollMinimapOpacity',
    'scrollMinimapAutoHide',
    'scrollMinimapMessageMode',
    'hideNativeScrollbarInFullscreen',
    'DOCUMENT_VIEWER_SETTING_RENDER_MARKDOWN_FOR_MD'
  ]) {
    assert.doesNotMatch(readSettingDefinition(settingsSource, key), /menu:\s*'quick'/);
  }
  for (const key of [
    'enableScrollMinimap',
    'scrollMinimapWheelMessageStep',
    'scrollMinimapWidth',
    'scrollMinimapOpacity',
    'scrollMinimapAutoHide',
    'scrollMinimapMessageMode'
  ]) {
    assert.match(readSettingDefinition(settingsSource, key), /group:\s*'layout'/);
  }
  assert.match(settingsSource, /label:\s*'启用滚动迷你图'/);
  assert.match(settingsSource, /label:\s*'\$ \/ \$\$ 数学公式'/);
  assert.doesNotMatch(settingsSource, /label:\s*'缩略图(?:宽度|透明度|自动隐藏|消息模式|滚轮)/);
  assert.match(
    readSettingDefinition(settingsSource, 'sidebarPosition'),
    /type:\s*'toggle'[\s\S]*?label:\s*'侧栏显示位置'[\s\S]*?querySelector\('input\[name="sidebar-position"\]:checked'\)/
  );
  assert.match(
    settingsSource,
    /sidebarPositionSwitch\.addEventListener\('click',[\s\S]*?event\.preventDefault\(\);[\s\S]*?currentSettings\.sidebarPosition === 'left' \? 'right' : 'left'[\s\S]*?setSidebarPosition\(nextPosition\)/
  );
  assert.match(sidebarHtml, /id="sidebar-position-switch"[\s\S]*?type="radio" name="sidebar-position" value="left"[\s\S]*?type="radio" name="sidebar-position" value="right"/);
  assert.match(sidebarCss, /\.sidebar-position-buttons input:checked \+ span/);
  assert.match(sidebarCss, /--cerebr-switch-active-bg:\s*var\(--cerebr-highlight\)/);
  assert.match(sidebarCss, /:root\.dark-theme[\s\S]*?--cerebr-switch-active-bg:\s*var\(--cerebr-icon-color\)/);
  assert.match(sidebarCss, /\.sidebar-position-buttons input:checked \+ span \{[\s\S]*?background:\s*var\(--cerebr-switch-active-bg\)/);
  assert.match(sidebarCss, /input:checked \+ \.slider \{[\s\S]*?background-color:\s*var\(--cerebr-switch-active-bg\)/);
  assert.doesNotMatch(settingsSource, /type:\s*'button_group'/);
  assert.doesNotMatch(settingsSource, /label:\s*'侧栏在右侧显示'/);

  const historyIndex = sidebarHtml.indexOf('id="chat-history-menu"');
  const favoritesIndex = sidebarHtml.indexOf('id="favorite-apis"');
  assert.ok(historyIndex >= 0 && favoritesIndex > historyIndex);
  assert.match(sidebarHtml, /id="clear-chat"(?![^>]*display:\s*none)[^>]*>[\s\S]*?新对话/);
  assert.match(sidebarHtml, /<label class="menu-item menu-item--toggle" id="dock-mode-toggle"[\s\S]*?fa-sidebar[\s\S]*?id="dock-mode-switch"/);
  assert.match(sidebarAppContextSource, /dockModeSwitch:\s*document\.getElementById\('dock-mode-switch'\)/);
  assert.match(sidebarEventsSource, /case 'CLEAR_CHAT_COMMAND':[\s\S]*?appContext\.dom\.clearChat\?\.click\(\)/);
  assert.match(sidebarEventsSource, /appContext\.dom\.clearChat\.addEventListener\('click',[\s\S]*?clearChatHistory\(\)/);
  assert.match(sidebarEventsSource, /case 'DOCK_MODE_STATE_SYNC':[\s\S]*?applyDockModeState\(appContext, data\.isDocked\)/);
  assert.match(sidebarEventsSource, /dockModeSwitch\.addEventListener\('change',[\s\S]*?requestDockMode\(appContext, isDocked\)/);
  assert.match(contentSource, /case 'SET_DOCK_MODE_FROM_IFRAME':[\s\S]*?const nextDocked = data\.isDocked === true/);
  const dockSetupStart = sidebarEventsSource.indexOf('function setupDockModeToggle');
  const dockSetupEnd = sidebarEventsSource.indexOf('\nfunction ', dockSetupStart + 1);
  assert.doesNotMatch(sidebarEventsSource.slice(dockSetupStart, dockSetupEnd), /preventDefault/);
  assert.match(contentSource, /setDockMode\(isDocked\)[\s\S]*?this\.notifyIframeDockModeState\(\)/);
  assert.match(contentSource, /type:\s*'DOCK_MODE_STATE_SYNC'[\s\S]*?isDocked:\s*!!this\.isDocked/);
});
