const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadModule() {
  const modulePath = path.resolve(__dirname, '../src/utils/response_activity_panel_mode.js');
  return import(pathToFileURL(modulePath).href);
}

test('首次进入思考中默认进入 peek 模式而不是完全展开', async () => {
  const { resolveResponseActivityPanelModeState } = await loadModule();
  const state = resolveResponseActivityPanelModeState({
    lifecycleInitialized: false,
    autoCollapsedAfterFinish: false,
    isInProgress: true
  });

  assert.deepEqual(state, {
    expanded: false,
    peek: true,
    lifecycleInitialized: true,
    autoCollapsedAfterFinish: false,
    clearManualState: false
  });
});

test('思考中手动展开时进入 full 模式', async () => {
  const { resolveResponseActivityPanelModeState } = await loadModule();
  const state = resolveResponseActivityPanelModeState({
    manualState: 'expanded',
    lifecycleInitialized: true,
    autoCollapsedAfterFinish: false,
    isInProgress: true
  });

  assert.deepEqual(state, {
    expanded: true,
    peek: false,
    lifecycleInitialized: true,
    autoCollapsedAfterFinish: false,
    clearManualState: false
  });
});

test('思考中即使是 collapsed 手动态也只会显示 peek', async () => {
  const { resolveResponseActivityPanelModeState } = await loadModule();
  const state = resolveResponseActivityPanelModeState({
    manualState: 'collapsed',
    lifecycleInitialized: true,
    autoCollapsedAfterFinish: false,
    isInProgress: true
  });

  assert.deepEqual(state, {
    expanded: false,
    peek: true,
    lifecycleInitialized: true,
    autoCollapsedAfterFinish: false,
    clearManualState: false
  });
});

test('思考结束后会自动完全收起一次并清掉思考期手动态', async () => {
  const { resolveResponseActivityPanelModeState } = await loadModule();
  const state = resolveResponseActivityPanelModeState({
    manualState: 'expanded',
    lifecycleInitialized: true,
    autoCollapsedAfterFinish: false,
    isInProgress: false
  });

  assert.deepEqual(state, {
    expanded: false,
    peek: false,
    lifecycleInitialized: true,
    autoCollapsedAfterFinish: true,
    clearManualState: true
  });
});

test('思考结束后手动展开/收起在 full 和 collapsed 间切换', async () => {
  const { resolveResponseActivityPanelModeState } = await loadModule();
  const expandedState = resolveResponseActivityPanelModeState({
    manualState: 'expanded',
    lifecycleInitialized: true,
    autoCollapsedAfterFinish: true,
    isInProgress: false
  });
  const collapsedState = resolveResponseActivityPanelModeState({
    manualState: 'collapsed',
    lifecycleInitialized: true,
    autoCollapsedAfterFinish: true,
    isInProgress: false
  });

  assert.deepEqual(expandedState, {
    expanded: true,
    peek: false,
    lifecycleInitialized: true,
    autoCollapsedAfterFinish: true,
    clearManualState: false
  });
  assert.deepEqual(collapsedState, {
    expanded: false,
    peek: false,
    lifecycleInitialized: true,
    autoCollapsedAfterFinish: true,
    clearManualState: false
  });
});
