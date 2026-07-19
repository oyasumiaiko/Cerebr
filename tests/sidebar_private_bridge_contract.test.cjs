const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readRepoFile(relativePath) {
  return fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

test('embedded sidebar business messages stay on the private MessagePort', async () => {
  const [contentSource, appContextSource, ...businessSources] = await Promise.all([
    readRepoFile('src/extension/content.js'),
    readRepoFile('src/ui/sidebar/sidebar_app_context.js'),
    readRepoFile('src/ui/sidebar/sidebar_events.js'),
    readRepoFile('src/ui/sidebar/sidebar.js'),
    readRepoFile('src/ui/sidebar/sidebar-message-handler.js'),
    readRepoFile('src/ui/settings_manager.js'),
    readRepoFile('src/ui/theme_manager.js'),
    readRepoFile('src/core/message_processor.js')
  ]);

  assert.match(contentSource, /postToIframe\(message\)[\s\S]*this\.sidebarBridgePort\.postMessage\(message\)/);
  assert.match(contentSource, /handleSidebarBridgeMessage\(sourceSidebar, data = \{\}\)/);
  assert.doesNotMatch(contentSource, /window\.addEventListener\('message'/);
  assert.doesNotMatch(contentSource, /handleFrameMessage/);
  assert.equal((contentSource.match(/iframe\.contentWindow\?*\.postMessage\(/g) || []).length, 2);
  assert.match(contentSource, /type: 'connect'[\s\S]*\}, '\*', \[channel\.port2\]/);
  assert.match(contentSource, /type: 'connect_sidebar'[\s\S]*\}, '\*', \[channel\.port2\]/);

  assert.match(appContextSource, /function postHostMessage\(message\)/);
  assert.match(appContextSource, /hostBridgePort\.postMessage\(message\)/);
  assert.match(appContextSource, /appContext\.utils\.setHostMessageHandler/);
  assert.equal((appContextSource.match(/window\.addEventListener\('message'/g) || []).length, 1);
  assert.match(appContextSource, /data\.type !== 'connect_sidebar'/);

  for (const source of businessSources) {
    assert.doesNotMatch(source, /window\.parent\.postMessage/);
    assert.doesNotMatch(source, /window\.addEventListener\('message'/);
  }
});
