const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadSidebarTargetTabModule() {
  const filePath = path.resolve(__dirname, '../src/utils/sidebar_target_tab.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('resolveSidebarRequestTargetTabId 优先使用显式 tabId', async () => {
  const { resolveSidebarRequestTargetTabId } = await loadSidebarTargetTabModule();
  assert.equal(
    resolveSidebarRequestTargetTabId({ explicitTabId: '17', senderTabId: 23 }),
    17
  );
});

test('resolveSidebarRequestTargetTabId 在没有显式 tabId 时退回 sender.tab.id', async () => {
  const { resolveSidebarRequestTargetTabId } = await loadSidebarTargetTabModule();
  assert.equal(
    resolveSidebarRequestTargetTabId({ explicitTabId: null, senderTabId: '23' }),
    23
  );
});

test('resolveSidebarRequestTargetTabId 不再隐式退回当前活动标签页', async () => {
  const { resolveSidebarRequestTargetTabId } = await loadSidebarTargetTabModule();
  assert.equal(
    resolveSidebarRequestTargetTabId({ explicitTabId: null, senderTabId: null }),
    null
  );
});

test('resolveSidebarRequestTargetTabId 可显式关闭 sender.tab.id 回退', async () => {
  const { resolveSidebarRequestTargetTabId } = await loadSidebarTargetTabModule();
  assert.equal(
    resolveSidebarRequestTargetTabId({
      explicitTabId: null,
      senderTabId: 23,
      allowSenderTabFallback: false
    }),
    null
  );
});
