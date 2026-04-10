const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadQueueModule() {
  const filePath = path.resolve(__dirname, '../src/utils/sequential_async_queue.js');
  return import(pathToFileURL(filePath).href);
}

test('createSequentialAsyncQueue 会严格按 enqueue 顺序执行', async () => {
  const { createSequentialAsyncQueue } = await loadQueueModule();
  const queue = createSequentialAsyncQueue();
  const trace = [];

  const first = queue.enqueue(async () => {
    trace.push('first:start');
    await new Promise((resolve) => setTimeout(resolve, 40));
    trace.push('first:end');
    return 'first';
  });

  const second = queue.enqueue(async () => {
    trace.push('second:start');
    trace.push('second:end');
    return 'second';
  });

  const third = queue.enqueue(async () => {
    trace.push('third:start');
    trace.push('third:end');
    return 'third';
  });

  const values = await Promise.all([first, second, third]);
  assert.deepEqual(values, ['first', 'second', 'third']);
  assert.deepEqual(trace, [
    'first:start',
    'first:end',
    'second:start',
    'second:end',
    'third:start',
    'third:end'
  ]);
});

test('createSequentialAsyncQueue 在前一个任务失败后仍继续执行后续任务', async () => {
  const { createSequentialAsyncQueue } = await loadQueueModule();
  const queue = createSequentialAsyncQueue();
  const trace = [];

  const first = queue.enqueue(async () => {
    trace.push('first');
    throw new Error('boom');
  });
  const second = queue.enqueue(async () => {
    trace.push('second');
    return 2;
  });

  await assert.rejects(first, /boom/);
  assert.equal(await second, 2);
  assert.deepEqual(trace, ['first', 'second']);
});

test('createKeyedSequentialAsyncQueue 只在同 key 内串行，不同 key 可并发', async () => {
  const { createKeyedSequentialAsyncQueue } = await loadQueueModule();
  const queue = createKeyedSequentialAsyncQueue();
  const trace = [];

  const firstA = queue.enqueue('tab-a', async () => {
    trace.push('a1:start');
    await new Promise((resolve) => setTimeout(resolve, 50));
    trace.push('a1:end');
    return 'a1';
  });
  const secondA = queue.enqueue('tab-a', async () => {
    trace.push('a2:start');
    trace.push('a2:end');
    return 'a2';
  });
  const firstB = queue.enqueue('tab-b', async () => {
    trace.push('b1:start');
    trace.push('b1:end');
    return 'b1';
  });

  const values = await Promise.all([firstA, secondA, firstB]);
  assert.deepEqual(values, ['a1', 'a2', 'b1']);
  assert.equal(trace.indexOf('a2:start') > trace.indexOf('a1:end'), true);
  assert.equal(trace.includes('b1:start'), true);
});
