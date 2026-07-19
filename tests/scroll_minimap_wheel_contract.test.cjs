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
    /key:\s*'scrollMinimapWheelMessageStep'[\s\S]*?label:\s*'迷你图滚轮按消息滚动'[\s\S]*?apply:\s*\(v\)\s*=>\s*applyScrollMinimapWheelMessageStep\(v\)/s
  );
  assert.match(
    settingsSource,
    /function applyScrollMinimapWheelMessageStep\(enabled\)\s*\{[\s\S]*?--cerebr-scroll-minimap-wheel-message-step[\s\S]*?enabled \? '1' : '0'/s
  );
  assert.match(
    settingsSource,
    /document\.documentElement\.classList\.toggle\('scroll-minimap-wheel-message-step', !!enabled\);/
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
    sidebarCss,
    /\.chat-scroll-minimap\.chat-scroll-minimap--active\s*\{[\s\S]*?pointer-events:\s*none;/s
  );
  assert.match(
    sidebarCss,
    /:root\.scroll-minimap-wheel-message-step \.chat-scroll-minimap\.chat-scroll-minimap--active\s*\{[\s\S]*?pointer-events:\s*auto;/s
  );
  assert.match(
    handlerSource,
    /if \(!isMinimapWheelMessageStepEnabled\(\)\) return;\s*const deltaUnits = normalizeWheelDeltaToStepUnits\(event\);/s
  );
  assert.match(
    handlerSource,
    /关闭按消息滚动时，缩略图只做视觉提示[\s\S]*?resetMinimapWheelAccumulator\(state\);/s
  );
  assert.match(
    handlerSource,
    /function resolvePassthroughMinimapStateAtPoint\(clientX, clientY\) \{[\s\S]*?if \(isMinimapWheelMessageStepEnabled\(\)\) return null;[\s\S]*?state\.root\.getBoundingClientRect\(\)/s
  );
  assert.match(
    handlerSource,
    /function handleMinimapPassthroughPointerDown\(event\) \{[\s\S]*?if \(event\.button !== 0\) return;[\s\S]*?scrollContainerByThumbTop\(state, rawTop\);/s
  );
  assert.match(
    handlerSource,
    /chatLayout\.addEventListener\('pointerdown', handleMinimapPassthroughPointerDown, true\);/
  );
  assert.match(
    handlerSource,
    /chatLayout\.addEventListener\('pointermove', handleMinimapPassthroughPointerMove, true\);/
  );
  assert.doesNotMatch(
    handlerSource,
    /scrollContainerByNativeWheelDelta|normalizeWheelDeltaToScrollPixels/
  );
});
