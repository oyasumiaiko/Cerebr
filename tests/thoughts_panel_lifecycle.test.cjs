const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function loadThoughtsPanelLifecycleModule() {
  const filePath = path.resolve(__dirname, '../src/utils/thoughts_panel_lifecycle.js');
  const source = await fs.readFile(filePath, 'utf8');

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cerebr-thoughts-panel-lifecycle-'));
  await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  await fs.mkdir(path.join(tempDir, 'src', 'utils'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'src', 'utils', 'thoughts_panel_lifecycle.js'), source, 'utf8');
  return import(require('node:url').pathToFileURL(path.join(tempDir, 'src', 'utils', 'thoughts_panel_lifecycle.js')).href);
}

test('首次出现且正文尚未开始输出时默认展开', async () => {
  const { resolveThoughtsPanelLifecycleState } = await loadThoughtsPanelLifecycleModule();
  const state = resolveThoughtsPanelLifecycleState({
    lifecycleInitialized: false,
    autoCollapsedAfterAnswerStart: false,
    isUpdating: true,
    hasVisibleAnswerStarted: false,
    currentlyExpanded: false
  });

  assert.deepEqual(state, {
    expanded: true,
    lifecycleInitialized: true,
    autoCollapsedAfterAnswerStart: false
  });
});

test('正文一开始输出就自动收起，不等待整条回答结束', async () => {
  const { resolveThoughtsPanelLifecycleState } = await loadThoughtsPanelLifecycleModule();
  const state = resolveThoughtsPanelLifecycleState({
    lifecycleInitialized: true,
    autoCollapsedAfterAnswerStart: false,
    isUpdating: true,
    hasVisibleAnswerStarted: true,
    currentlyExpanded: true
  });

  assert.deepEqual(state, {
    expanded: false,
    lifecycleInitialized: true,
    autoCollapsedAfterAnswerStart: true
  });
});

test('若直到结束都没有正文，也会在结束时自动收起一次', async () => {
  const { resolveThoughtsPanelLifecycleState } = await loadThoughtsPanelLifecycleModule();
  const state = resolveThoughtsPanelLifecycleState({
    lifecycleInitialized: true,
    autoCollapsedAfterAnswerStart: false,
    isUpdating: false,
    hasVisibleAnswerStarted: false,
    currentlyExpanded: true
  });

  assert.deepEqual(state, {
    expanded: false,
    lifecycleInitialized: true,
    autoCollapsedAfterAnswerStart: true
  });
});

test('用户手动展开后，自动逻辑不再覆盖', async () => {
  const { resolveThoughtsPanelLifecycleState } = await loadThoughtsPanelLifecycleModule();
  const state = resolveThoughtsPanelLifecycleState({
    manualState: 'expanded',
    lifecycleInitialized: true,
    autoCollapsedAfterAnswerStart: true,
    isUpdating: true,
    hasVisibleAnswerStarted: true,
    currentlyExpanded: false
  });

  assert.deepEqual(state, {
    expanded: true,
    lifecycleInitialized: true,
    autoCollapsedAfterAnswerStart: true
  });
});
