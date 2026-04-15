const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadModule() {
  const modulePath = path.resolve(__dirname, '../src/utils/response_activity_panel_status.js');
  return import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`);
}

test('进行中的 runtime 状态优先显示原始提示文案', async () => {
  const { resolveResponseActivityPanelStatusState } = await loadModule();
  const state = resolveResponseActivityPanelStatusState({
    activeStatus: {
      text: '正在调用工具...',
      stage: 'tool',
      note: 'running',
      showSpinner: true
    },
    completedDurationLabel: '9秒'
  });

  assert.deepEqual(state, {
    text: '正在调用工具...',
    stage: 'tool',
    note: 'running',
    showSpinner: true,
    collapsible: false
  });
});

test('完成后回退为可收起的思考用时状态行', async () => {
  const { resolveResponseActivityPanelStatusState } = await loadModule();
  const state = resolveResponseActivityPanelStatusState({
    activeStatus: null,
    completedDurationLabel: '9秒'
  });

  assert.deepEqual(state, {
    text: '思考用时 9秒',
    stage: 'completed_duration',
    note: '',
    showSpinner: false,
    collapsible: true
  });
});

test('没有进行中状态也没有持续时间时不显示状态行', async () => {
  const { resolveResponseActivityPanelStatusState } = await loadModule();
  const state = resolveResponseActivityPanelStatusState({
    activeStatus: null,
    completedDurationLabel: ''
  });

  assert.equal(state, null);
});
