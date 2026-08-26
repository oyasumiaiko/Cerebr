const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadResponsesLocalCompactionModule() {
  const filePath = path.resolve(__dirname, '../src/utils/responses_local_compaction.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

function sse(payloads) {
  return payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join('');
}

test('buildResponsesCompactV2RequestBody 在原 Responses 请求上追加唯一 compaction_trigger', async () => {
  const { buildResponsesCompactV2RequestBody } = await loadResponsesLocalCompactionModule();

  assert.deepEqual(
    buildResponsesCompactV2RequestBody({
      model: 'gpt-5.4',
      input: [
        { type: 'message', role: 'user', content: 'hello' },
        { type: 'compaction_trigger' }
      ],
      instructions: 'chat system prompt',
      tools: [{ type: 'web_search' }],
      tool_choice: 'required',
      parallel_tool_calls: true,
      reasoning: { effort: 'medium', generate_summary: 'detailed', summary: 'detailed' },
      text: {
        verbosity: 'medium',
        format: { type: 'json_schema', name: 'must_not_reach_compaction' }
      },
      store: false,
      stream: false,
      stream_options: { reasoning_summary_delivery: 'sequential_cutoff' },
      include: ['reasoning.encrypted_content'],
      service_tier: 'priority',
      prompt_cache_key: 'conversation-1',
      prompt_cache_options: { mode: 'explicit' },
      client_metadata: { source: 'cerebr' },
      metadata: { scene: 'ignored' },
      previous_response_id: 'resp_1',
      conversation: 'conv_1',
      context_management: [{ type: 'compaction' }],
      max_output_tokens: 2048,
      temperature: 0.2
    }),
    {
      model: 'gpt-5.4',
      instructions: 'chat system prompt',
      tools: [{ type: 'web_search' }],
      parallel_tool_calls: true,
      store: false,
      stream_options: { reasoning_summary_delivery: 'sequential_cutoff' },
      include: ['reasoning.encrypted_content'],
      service_tier: 'priority',
      prompt_cache_key: 'conversation-1',
      prompt_cache_options: { mode: 'explicit' },
      client_metadata: { source: 'cerebr' },
      reasoning: { effort: 'medium', summary: 'detailed' },
      text: { verbosity: 'medium' },
      tool_choice: 'auto',
      stream: true,
      input: [
        { type: 'message', role: 'user', content: 'hello' },
        { type: 'compaction_trigger' }
      ]
    }
  );
});

test('buildResponsesCompactV2RequestBody 保留完整工具输出供服务端压缩', async () => {
  const { buildResponsesCompactV2RequestBody } = await loadResponsesLocalCompactionModule();

  const largeOutput = 'A'.repeat(12000) + 'tail';
  const compactBody = buildResponsesCompactV2RequestBody({
    model: 'gpt-5.4',
    input: [
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [{ type: 'input_text', text: largeOutput }]
      },
      {
        type: 'custom_tool_call_output',
        call_id: 'call_2',
        output: { status: 'ok', text: largeOutput }
      }
    ]
  });

  assert.equal(compactBody.input[0].output[0].text, largeOutput);
  assert.deepEqual(compactBody.input[1].output, { status: 'ok', text: largeOutput });
  assert.deepEqual(compactBody.input[2], { type: 'compaction_trigger' });
  assert.deepEqual(compactBody.include, ['reasoning.encrypted_content']);
  assert.equal(compactBody.parallel_tool_calls, false);
  assert.equal(compactBody.store, false);
});

test('buildResponsesCompactV2RequestHeaders 与 Codex v2 元数据一致', async () => {
  const { buildResponsesCompactV2RequestHeaders } = await loadResponsesLocalCompactionModule();

  const headers = buildResponsesCompactV2RequestHeaders();
  assert.equal(headers.Accept, 'text/event-stream');
  assert.equal(headers['x-codex-beta-features'], 'remote_compaction_v2');
  assert.deepEqual(JSON.parse(headers['x-codex-turn-metadata']), {
    request_kind: 'compaction',
    compaction: {
      trigger: 'manual',
      reason: 'user_requested',
      implementation: 'responses_compaction_v2',
      phase: 'standalone_turn',
      strategy: 'memento'
    }
  });
});

test('parseResponsesCompactV2SseText 接受额外 output item，但只回收唯一 compaction', async () => {
  const { parseResponsesCompactV2SseText } = await loadResponsesLocalCompactionModule();

  const raw = sse([
    {
      type: 'response.output_item.done',
      item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ignored' }] }
    },
    {
      type: 'response.output_item.done',
      item: { id: 'cmp_1', type: 'compaction', encrypted_content: 'encrypted-summary' }
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_compact',
        usage: {
          input_tokens: 1234,
          output_tokens: 56,
          total_tokens: 1290
        }
      }
    }
  ]);
  const result = parseResponsesCompactV2SseText(raw, { status: 200 });

  assert.deepEqual(result.compactionOutput, {
    id: 'cmp_1',
    type: 'compaction',
    encrypted_content: 'encrypted-summary'
  });
  assert.equal(result.responseId, 'resp_compact');
  assert.equal(result.outputItemCount, 2);
  assert.equal(result.compactionCount, 1);
  assert.equal(result.usage.input_tokens, 1234);
  assert.equal(result.responseBytes, Buffer.byteLength(raw, 'utf8'));
});

test('parseResponsesCompactV2SseText 把未收到 response.completed 的断流标成可重试', async () => {
  const { parseResponsesCompactV2SseText } = await loadResponsesLocalCompactionModule();

  assert.throws(
    () => parseResponsesCompactV2SseText(sse([
      {
        type: 'response.output_item.done',
        item: { type: 'compaction', encrypted_content: 'incomplete' }
      }
    ]), { status: 200 }),
    error => {
      assert.equal(error.code, 'responses_compact_v2_stream_incomplete');
      assert.equal(error.retryable, true);
      assert.match(error.message, /before response\.completed/);
      return true;
    }
  );
});

test('parseResponsesCompactV2SseText 兼容 Codex 协议里的 compaction_summary 别名', async () => {
  const { parseResponsesCompactV2SseText } = await loadResponsesLocalCompactionModule();

  const result = parseResponsesCompactV2SseText(sse([
    {
      type: 'response.output_item.done',
      item: { type: 'compaction_summary', encrypted_content: 'legacy-alias' }
    },
    { type: 'response.completed', response: { id: 'resp_alias' } }
  ]), { status: 200 });

  assert.deepEqual(result.compactionOutput, {
    type: 'compaction',
    encrypted_content: 'legacy-alias'
  });
});

test('parseResponsesCompactV2SseText 对零个或多个 compaction item fail closed', async () => {
  const { parseResponsesCompactV2SseText } = await loadResponsesLocalCompactionModule();

  for (const outputItems of [
    [{ type: 'message', role: 'assistant', content: 'not a compaction' }],
    [
      { type: 'compaction', encrypted_content: 'one' },
      { type: 'compaction', encrypted_content: 'two' }
    ]
  ]) {
    const raw = sse([
      ...outputItems.map(item => ({ type: 'response.output_item.done', item })),
      { type: 'response.completed', response: { id: 'resp_invalid' } }
    ]);
    assert.throws(
      () => parseResponsesCompactV2SseText(raw, { status: 200 }),
      error => {
        assert.equal(error.code, 'responses_compact_v2_invalid_output_count');
        assert.equal(error.retryable, false);
        return true;
      }
    );
  }
});

test('buildResponsesCompactV2ReplacementHistory 只保留真实 user 消息并追加新 compaction', async () => {
  const { buildResponsesCompactV2ReplacementHistory } = await loadResponsesLocalCompactionModule();

  const replacement = buildResponsesCompactV2ReplacementHistory([
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<environment_context>hidden</environment_context>' }]
    },
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'remember this' },
        { type: 'input_image', image_url: 'data:image/png;base64,AA==' }
      ]
    },
    { type: 'message', role: 'assistant', content: 'old answer', phase: 'final_answer' },
    { type: 'function_call', call_id: 'call_1', name: 'tool', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'result' },
    { type: 'compaction', encrypted_content: 'old-summary' },
    { type: 'compaction_trigger' }
  ], {
    id: 'cmp_new',
    type: 'compaction',
    encrypted_content: 'new-summary'
  });

  assert.deepEqual(replacement, [
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'remember this' },
        { type: 'input_image', image_url: 'data:image/png;base64,AA==' }
      ]
    },
    {
      id: 'cmp_new',
      type: 'compaction',
      encrypted_content: 'new-summary'
    }
  ]);
});

test('buildResponsesCompactV2ReplacementHistory 从最新消息向前执行 retained token 预算', async () => {
  const { buildResponsesCompactV2ReplacementHistory } = await loadResponsesLocalCompactionModule();

  const replacement = buildResponsesCompactV2ReplacementHistory([
    { type: 'message', role: 'user', content: 'old-old' },
    { type: 'message', role: 'user', content: 'middle1234' },
    { type: 'message', role: 'user', content: 'new' }
  ], {
    type: 'compaction',
    encrypted_content: 'summary'
  }, {
    retainedMessageTokenBudget: 3
  });

  assert.equal(replacement.at(-1).type, 'compaction');
  assert.equal(replacement.at(-2).content, 'new');
  assert.match(replacement.at(-3).content, /…/);
  assert.equal(replacement.some(item => item.content === 'old-old'), false);
});
