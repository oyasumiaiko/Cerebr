const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

async function loadAssistantIncrementalRenderModule() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cerebr-assistant-incremental-render-'));
  await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  await fs.mkdir(path.join(tempDir, 'src', 'utils'), { recursive: true });
  await fs.copyFile(
    path.resolve(__dirname, '../src/utils/responses_activity_keys.js'),
    path.join(tempDir, 'src', 'utils', 'responses_activity_keys.js')
  );
  await fs.copyFile(
    path.resolve(__dirname, '../src/utils/assistant_incremental_render.js'),
    path.join(tempDir, 'src', 'utils', 'assistant_incremental_render.js')
  );
  return import(pathToFileURL(path.join(tempDir, 'src', 'utils', 'assistant_incremental_render.js')).href);
}

test('computeContiguousDiffWindow 在仅尾部变化时只替换尾段', async () => {
  const { computeContiguousDiffWindow } = await loadAssistantIncrementalRenderModule();
  const result = computeContiguousDiffWindow(
    ['p:1', 'p:2', 'p:3'],
    ['p:1', 'p:2', 'p:3_changed']
  );

  assert.deepEqual(result, {
    hasChanges: true,
    prefixCount: 2,
    suffixCount: 0,
    previousRangeStart: 2,
    previousRangeEnd: 3,
    nextRangeStart: 2,
    nextRangeEnd: 3
  });
});

test('computeContiguousDiffWindow 在中间插入块时保留公共前后缀', async () => {
  const { computeContiguousDiffWindow } = await loadAssistantIncrementalRenderModule();
  const result = computeContiguousDiffWindow(
    ['a', 'b', 'd'],
    ['a', 'b', 'c', 'd']
  );

  assert.deepEqual(result, {
    hasChanges: true,
    prefixCount: 2,
    suffixCount: 1,
    previousRangeStart: 2,
    previousRangeEnd: 2,
    nextRangeStart: 2,
    nextRangeEnd: 3
  });
});

test('computeContiguousDiffWindow 在完全一致时返回 noop 窗口', async () => {
  const { computeContiguousDiffWindow } = await loadAssistantIncrementalRenderModule();
  const result = computeContiguousDiffWindow(
    ['x', 'y'],
    ['x', 'y']
  );

  assert.deepEqual(result, {
    hasChanges: false,
    prefixCount: 2,
    suffixCount: 0,
    previousRangeStart: 2,
    previousRangeEnd: 2,
    nextRangeStart: 2,
    nextRangeEnd: 2
  });
});

test('resolveRenderedSurfaceDiffBaseSignatures 在 DOM 实况存在时优先相信当前 DOM', async () => {
  const { resolveRenderedSurfaceDiffBaseSignatures } = await loadAssistantIncrementalRenderModule();

  const result = resolveRenderedSurfaceDiffBaseSignatures(
    ['stale:a', 'stale:b'],
    ['dom:a', 'dom:b']
  );

  assert.deepEqual(result, ['dom:a', 'dom:b']);
});

test('resolveRenderedSurfaceDiffBaseSignatures 在 DOM 还没挂载 block 时回退到上一版 snapshot', async () => {
  const { resolveRenderedSurfaceDiffBaseSignatures } = await loadAssistantIncrementalRenderModule();

  const result = resolveRenderedSurfaceDiffBaseSignatures(
    ['snapshot:a', 'snapshot:b'],
    []
  );

  assert.deepEqual(result, ['snapshot:a', 'snapshot:b']);
});

test('response_activity 与 legacy tool key 规则与 sender 合并键保持一致', async () => {
  const {
    getResponseActivityEntrySnapshotKey,
    getLegacyToolCallSnapshotKey
  } = await loadAssistantIncrementalRenderModule();

  assert.equal(
    getResponseActivityEntrySnapshotKey({
      kind: 'tool_call',
      type: 'function_call',
      id: 'fc_1',
      name: 'page_content_read'
    }, 7),
    'tool:function_call:fc_1'
  );

  assert.equal(
    getResponseActivityEntrySnapshotKey({
      kind: 'reasoning_summary',
      id: 'reasoning_item_3'
    }, 2),
    'reasoning:reasoning_item_3'
  );

  assert.equal(
    getLegacyToolCallSnapshotKey({
      type: 'web_search_call',
      action_type: 'search',
      query: 'polymarket',
      url: ''
    }, 5),
    'web_search_call:search:polymarket:::5'
  );
});
