const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadModule() {
  const modulePath = path.resolve(__dirname, '../src/utils/response_activity_tool_auto_collapse.js');
  return import(pathToFileURL(modulePath).href);
}

test('工具进行中时保持展开且不进入延迟收起', async () => {
  const { resolveResponseActivityToolExpansionState } = await loadModule();
  const state = resolveResponseActivityToolExpansionState({
    shouldAutoRemainExpanded: true,
    autoCollapsed: false,
    pendingAutoCollapseDeadlineAtMs: null,
    nowMs: 1000
  });

  assert.deepEqual(state, {
    expanded: true,
    autoCollapsed: false,
    pendingAutoCollapseDeadlineAtMs: null
  });
});

test('工具刚完成时保持展开并启动 2 秒延迟', async () => {
  const {
    resolveResponseActivityToolExpansionState,
    RESPONSE_ACTIVITY_TOOL_AUTO_COLLAPSE_DELAY_MS
  } = await loadModule();
  const state = resolveResponseActivityToolExpansionState({
    shouldAutoRemainExpanded: false,
    autoCollapsed: false,
    pendingAutoCollapseDeadlineAtMs: null,
    nowMs: 1000
  });

  assert.deepEqual(state, {
    expanded: true,
    autoCollapsed: false,
    pendingAutoCollapseDeadlineAtMs: 1000 + RESPONSE_ACTIVITY_TOOL_AUTO_COLLAPSE_DELAY_MS
  });
});

test('延迟窗口内继续保持展开', async () => {
  const { resolveResponseActivityToolExpansionState } = await loadModule();
  const state = resolveResponseActivityToolExpansionState({
    shouldAutoRemainExpanded: false,
    autoCollapsed: false,
    pendingAutoCollapseDeadlineAtMs: 3000,
    nowMs: 2500
  });

  assert.deepEqual(state, {
    expanded: true,
    autoCollapsed: false,
    pendingAutoCollapseDeadlineAtMs: 3000
  });
});

test('超过截止时间后自动收起且只标记为 autoCollapsed', async () => {
  const { resolveResponseActivityToolExpansionState } = await loadModule();
  const state = resolveResponseActivityToolExpansionState({
    shouldAutoRemainExpanded: false,
    autoCollapsed: false,
    pendingAutoCollapseDeadlineAtMs: 3000,
    nowMs: 3000
  });

  assert.deepEqual(state, {
    expanded: false,
    autoCollapsed: true,
    pendingAutoCollapseDeadlineAtMs: null
  });
});

test('用户手动展开时取消待收起计时并保持展开', async () => {
  const { resolveResponseActivityToolExpansionState } = await loadModule();
  const state = resolveResponseActivityToolExpansionState({
    manualState: 'expanded',
    shouldAutoRemainExpanded: false,
    autoCollapsed: false,
    pendingAutoCollapseDeadlineAtMs: 3000,
    nowMs: 1500
  });

  assert.deepEqual(state, {
    expanded: true,
    autoCollapsed: false,
    pendingAutoCollapseDeadlineAtMs: null
  });
});

test('用户手动收起时取消待收起计时并保持收起', async () => {
  const { resolveResponseActivityToolExpansionState } = await loadModule();
  const state = resolveResponseActivityToolExpansionState({
    manualState: 'collapsed',
    shouldAutoRemainExpanded: false,
    autoCollapsed: false,
    pendingAutoCollapseDeadlineAtMs: 3000,
    nowMs: 1500
  });

  assert.deepEqual(state, {
    expanded: false,
    autoCollapsed: false,
    pendingAutoCollapseDeadlineAtMs: null
  });
});

test('已自动收起的工具若重新进入进行中，会重新展开并清掉 autoCollapsed', async () => {
  const { resolveResponseActivityToolExpansionState } = await loadModule();
  const state = resolveResponseActivityToolExpansionState({
    shouldAutoRemainExpanded: true,
    autoCollapsed: true,
    pendingAutoCollapseDeadlineAtMs: null,
    nowMs: 5000
  });

  assert.deepEqual(state, {
    expanded: true,
    autoCollapsed: false,
    pendingAutoCollapseDeadlineAtMs: null
  });
});
