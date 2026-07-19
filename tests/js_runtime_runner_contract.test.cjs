const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readRepoFile(relativePath) {
  return fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

test('host-page JS runtime requests are routed through a disposable hidden runner iframe', async () => {
  const [manifestSource, contentSource, sidebarSource, runnerHtml, runnerSource] = await Promise.all([
    readRepoFile('manifest.json'),
    readRepoFile('src/extension/content.js'),
    readRepoFile('src/ui/sidebar/sidebar_app_context.js'),
    readRepoFile('src/ui/js_runtime_runner/js_runtime_runner.html'),
    readRepoFile('src/ui/js_runtime_runner/js_runtime_runner.js')
  ]);

  assert.match(manifestSource, /src\/ui\/js_runtime_runner\/js_runtime_runner\.html/);
  assert.match(manifestSource, /src\/ui\/js_runtime_runner\/js_runtime_runner\.js/);
  assert.match(runnerHtml, /<script type="module" src="\.\/js_runtime_runner\.js"><\/script>/);

  assert.match(contentSource, /class CerebrJsRuntimeRunner/);
  assert.match(contentSource, /this\.pendingRequests = new Map\(\)/);
  assert.match(contentSource, /this\.container\?\.remove\?\.\(\)/);
  assert.match(contentSource, /const channel = new MessageChannel\(\)/);
  assert.match(contentSource, /handleJsRuntimeBridgeMessage\(sidebar, data = \{\}\)/);
  assert.match(contentSource, /data\.generation !== this\.generation \|\| data\.channelId !== this\.channelId/);

  assert.match(sidebarSource, /function requestJsRuntimeRunner\(runtimeMessage, timeoutMs, timeoutMessage\)/);
  assert.match(sidebarSource, /const port = event\.ports\?\.\[0\]/);
  assert.match(sidebarSource, /jsRuntimeRunnerPort\.postMessage\(\{/);
  assert.match(sidebarSource, /\{ type: 'GET_JS_RUNTIME_STATUS' \}/);
  assert.match(sidebarSource, /\{ type: 'GET_JS_RUNTIME_FRAMES', tabId: targetTabId \}/);
  assert.match(sidebarSource, /const executePromise = requestJsRuntimeRunner\(/);

  assert.match(runnerSource, /event\.source !== window\.parent/);
  assert.match(runnerSource, /const port = event\.ports\?\.\[0\]/);
  assert.match(runnerSource, /hostPort\.onmessage/);
  assert.match(runnerSource, /createJsRuntimeManager/);
  assert.match(runnerSource, /await executeRuntimeMessage\(runtimeMessage\)/);
  assert.doesNotMatch(runnerSource, /await chrome\.runtime\.sendMessage\(runtimeMessage\)/);
  assert.match(runnerSource, /'EXECUTE_JS_RUNTIME'/);
  assert.match(runnerSource, /'ABORT_JS_RUNTIME'/);
});
