const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readRepoFile(relativePath) {
  return fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

function extractFunctionBody(source, functionName) {
  const needle = `function ${functionName}`;
  const start = source.indexOf(needle);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const signatureEnd = source.indexOf(')', start);
  const open = source.indexOf('{', signatureEnd);
  assert.notEqual(open, -1, `${functionName} should have a body`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  assert.fail(`${functionName} body should close`);
}

function extractMethodBody(source, methodName) {
  const syncNeedle = `\n  ${methodName}(`;
  const asyncNeedle = `\n  async ${methodName}(`;
  const syncStart = source.indexOf(syncNeedle);
  const asyncStart = source.indexOf(asyncNeedle);
  const start = syncStart >= 0 ? syncStart : asyncStart;
  assert.notEqual(start, -1, `${methodName} should exist`);
  const signatureEnd = source.indexOf(')', start);
  const open = source.indexOf('{', signatureEnd);
  assert.notEqual(open, -1, `${methodName} should have a body`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  assert.fail(`${methodName} body should close`);
}

test('sidebar iframe heartbeat carries only focus-recovery state', async () => {
  const [healthSource, sidebarSource] = await Promise.all([
    readRepoFile('src/ui/sidebar/sidebar_iframe_health.js'),
    readRepoFile('src/ui/sidebar/sidebar.js')
  ]);

  assert.match(healthSource, /type: 'SIDEBAR_IFRAME_HEARTBEAT'/);
  assert.match(healthSource, /type: 'SIDEBAR_IFRAME_HEALTH_PROBE_RESULT'/);
  assert.match(healthSource, /respondToHealthProbe/);
  assert.match(healthSource, /conversationId: currentConversationId/);
  assert.match(healthSource, /Array\.isArray\(streamingConversationIds\) && streamingConversationIds\.length > 0/);
  assert.match(healthSource, /__debugSetActiveTaskOverride/);
  assert.match(healthSource, /SIDEBAR_IFRAME_HEARTBEAT_INTERVAL_MS = 3000/);
  assert.doesNotMatch(healthSource, /messages|requestBody|conversationSendQueues|sendMessage\(/);
  assert.match(sidebarSource, /createSidebarIframeHealthReporter\(appContext\)/);
  assert.match(sidebarSource, /sidebarIframeHealthReporter\?\.attachServices\?\.\(\)/);
});

test('host reload selection is limited to active-task or focused sidebar instances', async () => {
  const contentSource = await readRepoFile('src/extension/content.js');

  const taskCheckBody = extractMethodBody(contentSource, 'checkTaskSidebarIframes');
  assert.match(taskCheckBody, /sidebarInstance\.hasActiveTask === true/);
  assert.match(taskCheckBody, /reloadIframeIfStale\(`active_task_watchdog:\$\{source\}`\)/);

  const focusCheckBody = extractMethodBody(contentSource, 'checkFocusedSidebarIframeRecovery');
  assert.match(focusCheckBody, /document\.visibilityState !== 'visible'/);
  assert.match(focusCheckBody, /this\.getFocusedSidebar\(\)/);
  assert.match(focusCheckBody, /!target\.isVisible/);
  assert.match(focusCheckBody, /target\.reloadIframeIfStale/);

  const bridgeStart = contentSource.indexOf('handleSidebarBridgeMessage(sourceSidebar, data = {})');
  const heartbeatBranch = contentSource.indexOf("data.type === 'SIDEBAR_IFRAME_HEARTBEAT'", bridgeStart);
  const activeMutation = contentSource.indexOf('this.setActiveSidebar(sourceSidebar);', bridgeStart);
  assert.ok(heartbeatBranch > bridgeStart && heartbeatBranch < activeMutation);
  assert.match(contentSource, /iframe\.addEventListener\('focus',[\s\S]*markSidebarFocused/);
  const staleReloadBody = extractMethodBody(contentSource, 'reloadIframeIfStale');
  assert.match(staleReloadBody, /await this\.probeIframeHealth\(\)/);
  assert.match(staleReloadBody, /reason: 'health_probe_responsive'/);
  assert.match(contentSource, /data\.type === 'SIDEBAR_IFRAME_HEALTH_PROBE_RESULT'/);
  assert.match(contentSource, /case 'CHECK_FOCUSED_SIDEBAR_IFRAME_FROM_BACKGROUND'/);
  assert.match(contentSource, /case 'CHECK_TASK_SIDEBAR_IFRAMES_FROM_BACKGROUND'/);
});

test('background wakes only tabs that reported active tasks and focused tabs', async () => {
  const [manifestText, backgroundSource] = await Promise.all([
    readRepoFile('manifest.json'),
    readRepoFile('src/extension/background.js')
  ]);
  const manifest = JSON.parse(manifestText);

  assert.ok(manifest.permissions.includes('alarms'));
  assert.match(backgroundSource, /SIDEBAR_IFRAME_TASK_CHECK_PERIOD_MINUTES = 0\.5/);
  assert.match(backgroundSource, /chrome\.storage\.session\.get/);
  assert.match(backgroundSource, /type: 'CHECK_TASK_SIDEBAR_IFRAMES_FROM_BACKGROUND'/);
  assert.match(backgroundSource, /chrome\.tabs\.onActivated\.addListener/);
  assert.match(backgroundSource, /type: 'CHECK_FOCUSED_SIDEBAR_IFRAME_FROM_BACKGROUND'/);
  const registryStart = backgroundSource.indexOf('const SIDEBAR_IFRAME_TASK_REGISTRY_KEY');
  const registryEnd = backgroundSource.indexOf('function normalizeBackgroundResourceUrl', registryStart);
  const registrySection = backgroundSource.slice(registryStart, registryEnd);
  assert.doesNotMatch(registrySection, /conversationId|messageText|requestBody/);
});

test('iframe recovery reloads the previous conversation without continuing the task or adding UI', async () => {
  const [contentSource, eventsSource] = await Promise.all([
    readRepoFile('src/extension/content.js'),
    readRepoFile('src/ui/sidebar/sidebar_events.js')
  ]);

  assert.match(contentSource, /pendingConversationRestoreId = normalizeSidebarConversationId\(this\.lastConversationId\)/);
  assert.match(contentSource, /type: 'RESTORE_SIDEBAR_CONVERSATION'/);
  assert.match(eventsSource, /case 'RESTORE_SIDEBAR_CONVERSATION'/);

  const restoreBody = extractFunctionBody(eventsSource, 'restoreSidebarConversationAfterIframeReload');
  assert.match(restoreBody, /getConversationSnapshotById/);
  assert.match(restoreBody, /loadConversationIntoChat/);
  assert.doesNotMatch(restoreBody, /sendMessage|sendSteer|requestRegenerate|showNotification|confirm|dialog|queue/i);
});
