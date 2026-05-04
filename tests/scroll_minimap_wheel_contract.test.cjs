const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  return fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

test('滚动缩略图的按消息滚轮导航默认关闭，并保留普通滚动路径', async () => {
  const [settingsSource, sidebarCss, handlerSource] = await Promise.all([
    readWorkspaceFile('src/ui/settings_manager.js'),
    readWorkspaceFile('src/ui/styles/sidebar.css'),
    readWorkspaceFile('src/ui/sidebar/sidebar-message-handler.js')
  ]);

  assert.match(
    settingsSource,
    /scrollMinimapWheelMessageStep:\s*false,/
  );
  assert.match(
    settingsSource,
    /key:\s*'scrollMinimapWheelMessageStep'[\s\S]*?label:\s*'缩略图滚轮按消息滚动'[\s\S]*?apply:\s*\(v\)\s*=>\s*applyScrollMinimapWheelMessageStep\(v\)/s
  );
  assert.match(
    settingsSource,
    /function applyScrollMinimapWheelMessageStep\(enabled\)\s*\{[\s\S]*?--cerebr-scroll-minimap-wheel-message-step[\s\S]*?enabled \? '1' : '0'/s
  );
  assert.match(
    sidebarCss,
    /--cerebr-scroll-minimap-wheel-message-step:\s*0;/
  );
  assert.match(
    handlerSource,
    /function isMinimapWheelMessageStepEnabled\(\)\s*\{[\s\S]*?--cerebr-scroll-minimap-wheel-message-step[\s\S]*?0\) > 0\.5;/s
  );
  assert.match(
    handlerSource,
    /function scrollContainerByNativeWheelDelta\(state, event\)\s*\{[\s\S]*?container\.scrollTop = nextTop;[\s\S]*?return true;[\s\S]*?\}/s
  );
  assert.match(
    handlerSource,
    /if \(!isMinimapWheelMessageStepEnabled\(\)\) \{[\s\S]*?scrollContainerByNativeWheelDelta\(state, event\)[\s\S]*?event\.preventDefault\(\);[\s\S]*?return;/s
  );
});
