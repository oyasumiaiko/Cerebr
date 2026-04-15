const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadModule() {
  const modulePath = path.resolve(__dirname, '../src/utils/auto_scroll_follow_state.js');
  return import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`);
}

test('用户向上滚动时立即停止自动跟随', async () => {
  const { deriveAutoScrollFollowState } = await loadModule();
  const next = deriveAutoScrollFollowState({
    previousTop: 420,
    currentTop: 360,
    distanceFromBottom: 280,
    threshold: 100,
    autoScrollEnabled: true,
    currentShouldAutoScroll: true
  });
  assert.equal(next, false);
});

test('回到底部阈值内时恢复自动跟随', async () => {
  const { deriveAutoScrollFollowState } = await loadModule();
  const next = deriveAutoScrollFollowState({
    previousTop: 360,
    currentTop: 920,
    distanceFromBottom: 24,
    threshold: 100,
    autoScrollEnabled: true,
    currentShouldAutoScroll: false
  });
  assert.equal(next, true);
});

test('全局 autoScroll 关闭时不会被滚动位置重新打开', async () => {
  const { deriveAutoScrollFollowState } = await loadModule();
  const next = deriveAutoScrollFollowState({
    previousTop: 360,
    currentTop: 920,
    distanceFromBottom: 0,
    threshold: 100,
    autoScrollEnabled: false,
    currentShouldAutoScroll: true
  });
  assert.equal(next, false);
});

test('仅因内容继续增长而暂时离底部变远时保留当前自动跟随状态', async () => {
  const { deriveAutoScrollFollowState } = await loadModule();
  const next = deriveAutoScrollFollowState({
    previousTop: 920,
    currentTop: 920,
    distanceFromBottom: 180,
    threshold: 100,
    autoScrollEnabled: true,
    currentShouldAutoScroll: true
  });
  assert.equal(next, true);
});
