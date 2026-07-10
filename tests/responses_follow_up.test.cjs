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

test('ensureResponsesReplayOutputItemsIncludeFunctionCalls 会原样回放 function_call.namespace', async () => {
  const { ensureResponsesReplayOutputItemsIncludeFunctionCalls } = await loadResponsesFollowUpModule();
  const merged = ensureResponsesReplayOutputItemsIncludeFunctionCalls(
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

test('旧 ensureResponsesReplayOutputItemsIncludeFunctionCalls 导出也会补齐官方 apply_patch_call', async () => {
  const { ensureResponsesReplayOutputItemsIncludeFunctionCalls } = await loadResponsesFollowUpModule();
  const merged = ensureResponsesReplayOutputItemsIncludeFunctionCalls(
    [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'preparing patch' }]
      }
    ],
    [
      {
        type: 'apply_patch_call',
        call_id: 'call_patch_1',
        id: 'apc_1',
        status: 'completed',
        operation: {
          type: 'update_file',
          path: 'notes.md',
          diff: '@@\n-old\n+new'
        }
      }
    ]
  );

  assert.deepEqual(merged, [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'preparing patch' }]
    },
    {
      type: 'apply_patch_call',
      call_id: 'call_patch_1',
      status: 'completed',
      operation: {
        type: 'update_file',
        path: 'notes.md',
        diff: '@@\n-old\n+new'
      }
    }
  ]);
});

test('ensureResponsesReplayOutputItemsIncludeClientToolCalls 保持 function 与 patch 调用原始顺序并去重', async () => {
  const { ensureResponsesReplayOutputItemsIncludeClientToolCalls } = await loadResponsesFollowUpModule();
  const existingPatchCall = {
    type: 'apply_patch_call',
    call_id: 'call_patch_existing',
    status: 'completed',
    operation: {
      type: 'delete_file',
      path: 'old.md'
    }
  };
  const merged = ensureResponsesReplayOutputItemsIncludeClientToolCalls(
    [existingPatchCall],
    [
      {
        type: 'function_call',
        call_id: 'call_read_1',
        name: 'read_file',
        arguments: '{"path":"notes.md"}'
      },
      {
        ...existingPatchCall,
        id: 'apc_existing'
      },
      {
        type: 'apply_patch_call',
        call_id: 'call_patch_create',
        status: 'in_progress',
        caller: { type: 'direct' },
        operation: {
          type: 'create_file',
          path: 'new.md',
          diff: '+hello'
        }
      }
    ]
  );

  assert.deepEqual(merged, [
    existingPatchCall,
    {
      type: 'function_call',
      call_id: 'call_read_1',
      name: 'read_file',
      arguments: '{"path":"notes.md"}'
    },
    {
      type: 'apply_patch_call',
      call_id: 'call_patch_create',
      status: 'in_progress',
      operation: {
        type: 'create_file',
        path: 'new.md',
        diff: '+hello'
      },
      caller: { type: 'direct' }
    }
  ]);
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

test('sanitizeResponsesReplayItem 会保留 apply_patch call/output 的协议必需 status', async () => {
  const { sanitizeResponsesReplayItem } = await loadResponsesInputItemsModule();

  assert.deepEqual(sanitizeResponsesReplayItem({
    id: 'apc_runtime_1',
    type: 'apply_patch_call',
    call_id: 'call_patch_1',
    status: 'completed',
    created_by: 'server',
    operation: {
      type: 'delete_file',
      path: 'obsolete.md'
    }
  }), {
    type: 'apply_patch_call',
    call_id: 'call_patch_1',
    status: 'completed',
    operation: {
      type: 'delete_file',
      path: 'obsolete.md'
    }
  });

  assert.deepEqual(sanitizeResponsesReplayItem({
    id: 'apco_runtime_1',
    type: 'apply_patch_call_output',
    call_id: 'call_patch_1',
    status: 'failed',
    created_by: 'server',
    output: 'Patch context did not match.'
  }), {
    type: 'apply_patch_call_output',
    call_id: 'call_patch_1',
    status: 'failed',
    output: 'Patch context did not match.'
  });
});

test('filterIncompleteResponsesClientToolReplayItems 会移除未闭环 patch 并保留完整 patch 对', async () => {
  const { filterIncompleteResponsesClientToolReplayItems } = await loadResponsesInputItemsModule();
  const filtered = filterIncompleteResponsesClientToolReplayItems([
    {
      type: 'apply_patch_call',
      call_id: 'call_patch_dangling',
      status: 'completed',
      operation: { type: 'delete_file', path: 'dangling.md' }
    },
    {
      type: 'apply_patch_call',
      call_id: 'call_patch_ok',
      status: 'completed',
      operation: { type: 'delete_file', path: 'done.md' }
    },
    {
      type: 'apply_patch_call_output',
      call_id: 'call_patch_ok',
      status: 'completed',
      output: 'Deleted done.md.'
    },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'finished' }]
    }
  ]);

  assert.deepEqual(filtered, [
    {
      type: 'apply_patch_call',
      call_id: 'call_patch_ok',
      status: 'completed',
      operation: { type: 'delete_file', path: 'done.md' }
    },
    {
      type: 'apply_patch_call_output',
      call_id: 'call_patch_ok',
      status: 'completed',
      output: 'Deleted done.md.'
    },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'finished' }]
    }
  ]);
});

test('filterIncompleteResponsesClientToolReplayItems 会丢弃缺少官方必需字段的损坏 patch item', async () => {
  const { filterIncompleteResponsesClientToolReplayItems } = await loadResponsesInputItemsModule();
  const filtered = filterIncompleteResponsesClientToolReplayItems([
    {
      type: 'apply_patch_call',
      status: 'completed',
      operation: { type: 'delete_file', path: 'missing-call-id.md' }
    },
    {
      type: 'apply_patch_call',
      call_id: 'missing_status',
      operation: { type: 'delete_file', path: 'missing-status.md' }
    },
    {
      type: 'apply_patch_call',
      call_id: 'missing_diff',
      status: 'completed',
      operation: { type: 'update_file', path: 'missing-diff.md' }
    },
    {
      type: 'apply_patch_call_output',
      call_id: 'missing_status',
      output: 'invalid'
    },
    {
      type: 'apply_patch_call',
      call_id: 'invalid_output_shape',
      status: 'completed',
      operation: { type: 'delete_file', path: 'invalid-output.md' }
    },
    {
      type: 'apply_patch_call_output',
      call_id: 'invalid_output_shape',
      status: 'completed',
      output: [{ type: 'input_text', text: 'not allowed by the official protocol' }]
    },
    {
      type: 'apply_patch_call',
      call_id: 'programmatic_caller',
      status: 'completed',
      caller: { type: 'programmatic', id: 'tool_1' },
      operation: { type: 'delete_file', path: 'programmatic.md' }
    },
    {
      type: 'apply_patch_call_output',
      call_id: 'programmatic_caller',
      status: 'completed',
      output: 'must not replay'
    },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'keep me' }]
    }
  ]);

  assert.deepEqual(filtered, [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'keep me' }]
    }
  ]);
});
