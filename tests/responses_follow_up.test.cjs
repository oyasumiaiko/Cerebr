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

test('ensureResponsesReplayOutputItemsIncludeToolCalls 会补齐缺失的 function_call replay item', async () => {
  const { ensureResponsesReplayOutputItemsIncludeToolCalls } = await loadResponsesFollowUpModule();
  const merged = ensureResponsesReplayOutputItemsIncludeToolCalls(
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
        arguments: '{"max_output_chars":5000}',
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
    arguments: '{"max_output_chars":5000}'
  });
});

test('ensureResponsesReplayOutputItemsIncludeToolCalls 不会重复追加已存在的 function_call', async () => {
  const { ensureResponsesReplayOutputItemsIncludeToolCalls } = await loadResponsesFollowUpModule();
  const merged = ensureResponsesReplayOutputItemsIncludeToolCalls(
    [
      {
        type: 'function_call',
        call_id: 'call_123',
        item_id: 'fc_1',
        name: 'page_content_read',
        arguments: '{"max_output_chars":5000}'
      }
    ],
    [
      {
        type: 'function_call',
        call_id: 'call_123',
        item_id: 'fc_1',
        name: 'page_content_read',
        arguments: '{"max_output_chars":5000}',
        status: 'completed'
      }
    ]
  );

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], {
    type: 'function_call',
    call_id: 'call_123',
    name: 'page_content_read',
    arguments: '{"max_output_chars":5000}'
  });
});

test('ensureResponsesReplayOutputItemsIncludeToolCalls 会原样回放 function_call.namespace', async () => {
  const { ensureResponsesReplayOutputItemsIncludeToolCalls } = await loadResponsesFollowUpModule();
  const merged = ensureResponsesReplayOutputItemsIncludeToolCalls(
    [],
    [
      {
        type: 'function_call',
        call_id: 'call_js_1',
        item_id: 'fc_js_1',
        namespace: 'cerebr_tools',
        name: 'js_runtime_execute',
        arguments: '{"code":"1+1"}',
        status: 'completed'
      }
    ]
  );

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], {
    type: 'function_call',
    call_id: 'call_js_1',
    namespace: 'cerebr_tools',
    name: 'js_runtime_execute',
    arguments: '{"code":"1+1"}'
  });
});

test('ensureResponsesReplayOutputItemsIncludeToolCalls 会按 raw input 补齐 custom_tool_call', async () => {
  const { ensureResponsesReplayOutputItemsIncludeToolCalls } = await loadResponsesFollowUpModule();
  const input = '*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch';
  const merged = ensureResponsesReplayOutputItemsIncludeToolCalls([], [{
    type: 'custom_tool_call',
    call_id: 'call_patch_1',
    item_id: 'ctc_1',
    name: 'apply_patch',
    input,
    status: 'completed'
  }]);

  assert.deepEqual(merged, [{
    type: 'custom_tool_call',
    call_id: 'call_patch_1',
    name: 'apply_patch',
    input
  }]);
});

test('sanitizeResponsesReplayItem 会移除不兼容 replay 的 item_id 运行态字段', async () => {
  const { sanitizeResponsesReplayItem } = await loadResponsesInputItemsModule();
  const sanitized = sanitizeResponsesReplayItem({
    type: 'function_call',
    call_id: 'call_123',
    item_id: 'fc_1',
    status: 'completed',
    name: 'page_content_read',
    arguments: '{"max_output_chars":5000}'
  });

  assert.deepEqual(sanitized, {
    type: 'function_call',
    call_id: 'call_123',
    name: 'page_content_read',
    arguments: '{"max_output_chars":5000}'
  });
});

test('sanitizeResponsesReplayItem 会剥离 image_generation_call 的 result 大字段但保留本地化引用', async () => {
  const { sanitizeResponsesReplayItem } = await loadResponsesInputItemsModule();
  const sanitized = sanitizeResponsesReplayItem({
    type: 'image_generation_call',
    id: 'ig_1',
    status: 'completed',
    revised_prompt: '把这张图改成蓝底',
    result: 'QUJDRA==',
    result_image_url: 'file:///C:/Users/test/Downloads/Cerebr/Images/ig_1.png'
  });

  assert.deepEqual(sanitized, {
    type: 'image_generation_call',
    revised_prompt: '把这张图改成蓝底',
    result_image_url: 'file:///C:/Users/test/Downloads/Cerebr/Images/ig_1.png'
  });
});

test('custom_tool_call_output 同时兼容新字符串 output 与旧 input_text 数组历史', async () => {
  const { cloneResponsesInputItems } = await loadResponsesInputItemsModule();
  const cloned = cloneResponsesInputItems([
    {
      type: 'custom_tool_call_output',
      call_id: 'call_new',
      output: 'Success. Updated the following files:\nA a.txt'
    },
    {
      type: 'custom_tool_call_output',
      call_id: 'call_legacy',
      output: [{ type: 'input_text', text: 'legacy output' }]
    }
  ]);

  assert.equal(cloned[0].output, 'Success. Updated the following files:\nA a.txt');
  assert.deepEqual(cloned[1].output, [{ type: 'input_text', text: 'legacy output' }]);
});
