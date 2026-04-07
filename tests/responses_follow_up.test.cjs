const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadResponsesFollowUpModule() {
  const filePath = path.resolve(__dirname, '../src/utils/responses_follow_up.js');
  const inputItemsPath = path.resolve(__dirname, '../src/utils/responses_input_items.js');
  const source = await fs.readFile(filePath, 'utf8');
  const inputItemsSource = await fs.readFile(inputItemsPath, 'utf8');

  const tempDir = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'cerebr-responses-follow-up-'));
  await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  await fs.mkdir(path.join(tempDir, 'src', 'utils'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'src', 'utils', 'responses_follow_up.js'), source, 'utf8');
  await fs.writeFile(path.join(tempDir, 'src', 'utils', 'responses_input_items.js'), inputItemsSource, 'utf8');
  return import(require('node:url').pathToFileURL(path.join(tempDir, 'src', 'utils', 'responses_follow_up.js')).href);
}

async function loadResponsesInputItemsModule() {
  const filePath = path.resolve(__dirname, '../src/utils/responses_input_items.js');
  const source = await fs.readFile(filePath, 'utf8');

  const tempDir = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'cerebr-responses-input-items-'));
  await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  await fs.mkdir(path.join(tempDir, 'src', 'utils'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'src', 'utils', 'responses_input_items.js'), source, 'utf8');
  return import(require('node:url').pathToFileURL(path.join(tempDir, 'src', 'utils', 'responses_input_items.js')).href);
}

test('ensureResponsesReplayOutputItemsIncludeFunctionCalls 会补齐缺失的 function_call replay item', async () => {
  const { ensureResponsesReplayOutputItemsIncludeFunctionCalls } = await loadResponsesFollowUpModule();
  const merged = ensureResponsesReplayOutputItemsIncludeFunctionCalls(
    [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hi' }]
      }
    ],
    [
      {
        type: 'function_call',
        call_id: 'call_123',
        item_id: 'fc_1',
        name: 'page_content_read',
        arguments: '{"max_chars":5000}',
        status: 'completed'
      }
    ]
  );

  assert.equal(Array.isArray(merged), true);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[1], {
    type: 'function_call',
    call_id: 'call_123',
    name: 'page_content_read',
    arguments: '{"max_chars":5000}'
  });
});

test('ensureResponsesReplayOutputItemsIncludeFunctionCalls 不会重复追加已存在的 function_call', async () => {
  const { ensureResponsesReplayOutputItemsIncludeFunctionCalls } = await loadResponsesFollowUpModule();
  const merged = ensureResponsesReplayOutputItemsIncludeFunctionCalls(
    [
      {
        type: 'function_call',
        call_id: 'call_123',
        item_id: 'fc_1',
        name: 'page_content_read',
        arguments: '{"max_chars":5000}'
      }
    ],
    [
      {
        type: 'function_call',
        call_id: 'call_123',
        item_id: 'fc_1',
        name: 'page_content_read',
        arguments: '{"max_chars":5000}',
        status: 'completed'
      }
    ]
  );

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], {
    type: 'function_call',
    call_id: 'call_123',
    name: 'page_content_read',
    arguments: '{"max_chars":5000}'
  });
});

test('sanitizeResponsesReplayItem 会移除不兼容 replay 的 item_id 运行态字段', async () => {
  const { sanitizeResponsesReplayItem } = await loadResponsesInputItemsModule();
  const sanitized = sanitizeResponsesReplayItem({
    type: 'function_call',
    call_id: 'call_123',
    item_id: 'fc_1',
    status: 'completed',
    name: 'page_content_read',
    arguments: '{"max_chars":5000}'
  });

  assert.deepEqual(sanitized, {
    type: 'function_call',
    call_id: 'call_123',
    name: 'page_content_read',
    arguments: '{"max_chars":5000}'
  });
});
