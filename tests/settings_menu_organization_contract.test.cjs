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

test('右下角菜单只迁移点名设置，并保留新对话与底部收藏 API', async () => {
  const [settingsSource, sidebarHtml, sidebarEventsSource] = await Promise.all([
    readWorkspaceFile('src/ui/settings_manager.js'),
    readWorkspaceFile('src/ui/sidebar/sidebar.html'),
    readWorkspaceFile('src/ui/sidebar/sidebar_events.js')
  ]);

  assert.match(readSettingDefinition(settingsSource, 'sidebarWidth'), /uiHidden:\s*true/);
  for (const key of [
    'enableScrollMinimap',
    'scrollMinimapWheelMessageStep',
    'scrollMinimapWidth',
    'scrollMinimapOpacity',
    'scrollMinimapAutoHide',
    'scrollMinimapMessageMode',
    'DOCUMENT_VIEWER_SETTING_RENDER_MARKDOWN_FOR_MD'
  ]) {
    assert.doesNotMatch(readSettingDefinition(settingsSource, key), /menu:\s*'quick'/);
  }

  const historyIndex = sidebarHtml.indexOf('id="chat-history-menu"');
  const favoritesIndex = sidebarHtml.indexOf('id="favorite-apis"');
  assert.ok(historyIndex >= 0 && favoritesIndex > historyIndex);
  assert.match(sidebarHtml, /id="clear-chat"(?![^>]*display:\s*none)[^>]*>[\s\S]*?新对话/);
  assert.match(sidebarEventsSource, /case 'CLEAR_CHAT_COMMAND':[\s\S]*?appContext\.dom\.clearChat\?\.click\(\)/);
  assert.match(sidebarEventsSource, /appContext\.dom\.clearChat\.addEventListener\('click',[\s\S]*?clearChatHistory\(\)/);
});
