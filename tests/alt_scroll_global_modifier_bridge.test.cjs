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
    /window\.addEventListener\('keydown', \(event\) => \{\s*if \(event\.key === 'Alt'\) \{\s*syncHostAltKeyState\(true\);/s
  );
  assert.match(
    contentSource,
    /window\.addEventListener\('keyup', \(event\) => \{\s*if \(event\.key === 'Alt'\) \{\s*syncHostAltKeyState\(false\);/s
  );
  assert.match(
    contentSource,
    /case 'REQUEST_ALT_KEY_STATE':\s*this\.notifyIframeAltKeyState\(this\.isAltKeyPressed\);/s
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
