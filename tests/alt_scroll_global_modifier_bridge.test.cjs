const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  return fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

test('宿主页 Alt 状态会桥接到 iframe 侧栏滚动管理器', async () => {
  const [contentSource, sidebarEventsSource, uiManagerSource] = await Promise.all([
    readWorkspaceFile('src/extension/content.js'),
    readWorkspaceFile('src/ui/sidebar/sidebar_events.js'),
    readWorkspaceFile('src/ui/ui_manager.js')
  ]);

  assert.match(
    contentSource,
    /this\.isAltKeyPressed = false;/
  );
  assert.match(
    contentSource,
    /syncHostAltKeyState\(isPressed\) \{\s*const nextPressed = !!isPressed;\s*if \(this\.isAltKeyPressed === nextPressed\) return;\s*this\.isAltKeyPressed = nextPressed;\s*this\.sidebars\.forEach\(\(item\) => item\.notifyIframeAltKeyState\(nextPressed\)\);/s
  );
  assert.match(
    contentSource,
    /window\.addEventListener\('keydown', \(event\) => \{\s*if \(event\.key === 'Alt'\) \{\s*this\.syncHostAltKeyState\(true\);\s*\}\s*\}, true\);/s
  );
  assert.match(
    contentSource,
    /window\.addEventListener\('keyup', \(event\) => \{\s*if \(event\.key === 'Alt'\) \{\s*this\.syncHostAltKeyState\(false\);\s*\}\s*\}, true\);/s
  );
  assert.match(
    contentSource,
    /window\.addEventListener\('blur', \(\) => \{\s*this\.syncHostAltKeyState\(false\);/s
  );
  assert.match(
    contentSource,
    /document\.addEventListener\('visibilitychange', \(\) => \{\s*if \(document\.visibilityState !== 'visible'\) \{\s*this\.syncHostAltKeyState\(false\);/s
  );
  assert.match(
    contentSource,
    /iframe\.addEventListener\('load', \(\) => \{[\s\S]*?this\.notifyIframeAltKeyState\(this\.isAltKeyPressed\);/s
  );
  assert.match(
    contentSource,
    /case 'REQUEST_ALT_KEY_STATE':\s*sourceSidebar\.notifyIframeAltKeyState\(this\.isAltKeyPressed\);/s
  );
  assert.match(
    contentSource,
    /type: 'ALT_KEY_STATE_SYNC',\s*isPressed: !!isPressed/s
  );

  assert.match(
    sidebarEventsSource,
    /case 'ALT_KEY_STATE_SYNC':[\s\S]*?appContext\.services\.uiManager\?\.setExternalAltKeyPressed\?\.\(data\.isPressed\);/s
  );
  assert.match(
    sidebarEventsSource,
    /window\.parent\.postMessage\(\{ type: 'REQUEST_ALT_KEY_STATE' \}, '\*'\);/
  );

  assert.match(
    uiManagerSource,
    /const externalAltWheelStateUpdaters = new Set\(\);/
  );
  assert.match(
    uiManagerSource,
    /const syncAltWheelCaptureState = \(\) => \{\s*if \(localAltKeyPressed \|\| externalAltKeyPressed\) \{\s*enableAltWheelCapture\(\);/s
  );
  assert.match(
    uiManagerSource,
    /setExternalAltKeyPressed\(isPressed\) \{\s*for \(const updateState of externalAltWheelStateUpdaters\) \{\s*updateState\(isPressed\);/s
  );
});

test('侧栏焦点内裸 Alt 会阻止浏览器菜单栏默认行为', async () => {
  const sidebarSource = await readWorkspaceFile('src/ui/sidebar/sidebar.js');

  assert.match(
    sidebarSource,
    /installAltKeyBrowserMenuGuard\(\);/
  );
  assert.match(
    sidebarSource,
    /function shouldSuppressBrowserMenuAltKeyEvent\(event\) \{\s*if \(!event \|\| event\.key !== 'Alt'\) return false;\s*const isAltGraph = typeof event\.getModifierState === 'function' && event\.getModifierState\('AltGraph'\);\s*return !isAltGraph;\s*\}/s
  );
  assert.match(
    sidebarSource,
    /function suppressBrowserMenuAltKeyEvent\(event\) \{\s*if \(!shouldSuppressBrowserMenuAltKeyEvent\(event\)\) return;\s*if \(event\.cancelable !== false\) \{\s*event\.preventDefault\(\);\s*\}\s*\}/s
  );
  assert.match(
    sidebarSource,
    /window\.addEventListener\('keydown', suppressBrowserMenuAltKeyEvent, \{ capture: true \}\);/
  );
  assert.match(
    sidebarSource,
    /window\.addEventListener\('keyup', suppressBrowserMenuAltKeyEvent, \{ capture: true \}\);/
  );
});
