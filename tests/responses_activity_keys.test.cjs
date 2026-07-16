const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadResponsesActivityKeysModule() {
  const filePath = path.resolve(__dirname, '../src/utils/responses_activity_keys.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('getResponsesToolCallRecordKey 会把 function_call namespace 纳入稳定 key', async () => {
  const { getResponsesToolCallRecordKey } = await loadResponsesActivityKeysModule();

  const keyA = getResponsesToolCallRecordKey({
    type: 'function_call',
    namespace: 'browser',
    name: 'search'
  }, 0);
  const keyB = getResponsesToolCallRecordKey({
    type: 'function_call',
    namespace: 'history',
    name: 'search'
  }, 0);

  assert.notEqual(keyA, keyB);
  assert.equal(keyA, 'function_call:browser:search:0');
  assert.equal(keyB, 'function_call:history:search:0');
});

test('getResponsesActivityTimelineEntryKey 会用 stream_error id 构造稳定 key', async () => {
  const { getResponsesActivityTimelineEntryKey } = await loadResponsesActivityKeysModule();

  assert.equal(
    getResponsesActivityTimelineEntryKey({ kind: 'stream_error', id: 'retry_2' }, 9),
    'stream_error:retry_2'
  );
  assert.notEqual(
    getResponsesActivityTimelineEntryKey({ kind: 'stream_error', id: 'retry_2' }, 9),
    getResponsesActivityTimelineEntryKey({ kind: 'stream_error', id: 'retry_3' }, 9)
  );
});
