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

test('buildResponsesCompactEndpointUrl 直接在当前 responses endpoint 末尾拼接 /compact', async () => {
  const { buildResponsesCompactEndpointUrl } = await loadResponsesLocalCompactionModule();

  assert.equal(
    buildResponsesCompactEndpointUrl('https://api.openai.com/v1/responses'),
    'https://api.openai.com/v1/responses/compact'
  );
  assert.equal(
    buildResponsesCompactEndpointUrl('https://proxy.example.com/openai/responses/'),
    'https://proxy.example.com/openai/responses/compact'
  );
});

test('buildResponsesCompactRequestBody 只保留 compact allow-list 字段', async () => {
  const { buildResponsesCompactRequestBody } = await loadResponsesLocalCompactionModule();

  assert.deepEqual(
    buildResponsesCompactRequestBody({
      model: 'gpt-5.4',
      input: [{ type: 'message', role: 'user', content: 'hello' }],
      instructions: 'base instructions',
      tools: [{ type: 'web_search' }],
      parallel_tool_calls: true,
      reasoning: { effort: 'medium', generate_summary: 'detailed', summary: 'detailed' },
      text: { verbosity: 'medium' },
      stream: true,
      include: ['reasoning.encrypted_content'],
      metadata: { scene: 'ignored' },
      previous_response_id: 'resp_1',
      conversation: 'conv_1',
      max_output_tokens: 2048,
      tool_choice: 'auto'
    }),
    {
      model: 'gpt-5.4',
      input: [{ type: 'message', role: 'user', content: 'hello' }],
      instructions: 'base instructions',
      tools: [{ type: 'web_search' }],
      parallel_tool_calls: true,
      reasoning: { effort: 'medium', summary: 'detailed' },
      text: { verbosity: 'medium' }
    }
  );
});

test('resolveResponsesAutoCompactionDecision 只看最新有效链里的 assistant promptTokens', async () => {
  const { resolveResponsesAutoCompactionDecision } = await loadResponsesLocalCompactionModule();

  const decision = resolveResponsesAutoCompactionDecision([
    { id: 'a-old', role: 'assistant', apiUsage: { promptTokens: 200000 } },
    {
      id: 'marker',
      role: 'assistant',
      response_input_items: [{ type: 'compaction', encrypted_content: 'summary' }],
      contextCompactionMarker: { source: 'responses_local', compactedAt: 1 }
    },
    { id: 'u1', role: 'user', content: 'after marker user' },
    { id: 'a-new', role: 'assistant', apiUsage: { promptTokens: 150001 } }
  ], 150000);

  assert.deepEqual(decision, {
    shouldCompact: true,
    promptTokensBefore: 150001,
    sourceAssistantMessageId: 'a-new'
  });
});

test('resolveResponsesAutoCompactionDecision 在最新 marker 后没有新 assistant 时跳过', async () => {
  const { resolveResponsesAutoCompactionDecision } = await loadResponsesLocalCompactionModule();

  const decision = resolveResponsesAutoCompactionDecision([
    { id: 'a-old', role: 'assistant', apiUsage: { promptTokens: 200000 } },
    {
      id: 'marker',
      role: 'assistant',
      response_input_items: [{ type: 'compaction', encrypted_content: 'summary' }],
      contextCompactionMarker: { source: 'responses_local', compactedAt: 1 }
    },
    { id: 'u1', role: 'user', content: 'after marker user' }
  ], 150000);

  assert.deepEqual(decision, {
    shouldCompact: false,
    promptTokensBefore: null,
    sourceAssistantMessageId: null
  });
});

test('buildResponsesCompactRequestBody 会仅对 compact 请求里的 function_call_output 做预算内截断', async () => {
  const {
    buildResponsesCompactRequestBody,
    RESPONSES_LOCAL_COMPACTION_REQUEST_MAX_BYTES
  } = await loadResponsesLocalCompactionModule();

  const largeOutput = 'A'.repeat(12000);
  const requestBody = {
    model: 'gpt-5.4',
    instructions: 'base instructions',
    tools: [{ type: 'function', name: 'page_content_read' }],
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'keep original user message intact' }]
      },
      ...Array.from({ length: 60 }, (_unused, index) => ({
        type: 'function_call_output',
        call_id: `call_${index}`,
        output: [
          {
            type: 'input_text',
            text: `${largeOutput}${index}`
          }
        ]
      }))
    ]
  };

  const compactBody = buildResponsesCompactRequestBody(requestBody);
  const serializedBytes = Buffer.byteLength(JSON.stringify(compactBody), 'utf8');
  assert.ok(serializedBytes <= RESPONSES_LOCAL_COMPACTION_REQUEST_MAX_BYTES);
  assert.equal(
    compactBody.input[0].content[0].text,
    'keep original user message intact'
  );
  assert.match(compactBody.input[1].output[0].text, /compact truncated/);
  assert.ok(compactBody.input[1].output[0].text.length < largeOutput.length);
});

test('buildResponsesCompactRequestBody 在仍超预算时只保留最新 turn 后缀', async () => {
  const {
    buildResponsesCompactRequestBody,
    RESPONSES_LOCAL_COMPACTION_REQUEST_MAX_BYTES
  } = await loadResponsesLocalCompactionModule();

  const requestBody = {
    model: 'gpt-5.4',
    instructions: 'base instructions',
    input: Array.from({ length: 40 }, (_unused, index) => ([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `user turn ${index}` }]
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `assistant turn ${index}: ${'B'.repeat(8000)}` }]
      }
    ])).flat()
  };

  const compactBody = buildResponsesCompactRequestBody(requestBody);
  const serializedBytes = Buffer.byteLength(JSON.stringify(compactBody), 'utf8');
  assert.ok(serializedBytes <= RESPONSES_LOCAL_COMPACTION_REQUEST_MAX_BYTES);
  assert.ok(compactBody.input.length < requestBody.input.length);
  assert.equal(compactBody.input[0].type, 'message');
  assert.equal(compactBody.input[0].role, 'user');
  assert.match(compactBody.input[0].content[0].text, /user turn \d+/);
});

test('parseResponsesCompactResponseText 对 200 空响应体给出明确错误', async () => {
  const { parseResponsesCompactResponseText } = await loadResponsesLocalCompactionModule();

  assert.throws(
    () => parseResponsesCompactResponseText('', {
      status: 200,
      contentLength: '0',
      requestSummary: {
        serializedBytes: 765600,
        inputCount: 335,
        functionCallOutputCount: 67,
        functionCallOutputBytes: 381980,
        maxFunctionCallOutputBytes: 12290,
        toolCount: 10
      }
    }),
    /空响应体/
  );
});
