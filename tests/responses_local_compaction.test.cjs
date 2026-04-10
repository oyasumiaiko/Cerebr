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
