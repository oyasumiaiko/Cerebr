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

async function loadResponsesCompactCodexInstructionsModule() {
  const filePath = path.resolve(__dirname, '../src/utils/responses_compact_codex_instructions.js');
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

test('resolveResponsesCompactEndpointUrl 优先使用独立 compact 端点配置', async () => {
  const { resolveResponsesCompactEndpointUrl } = await loadResponsesLocalCompactionModule();

  assert.equal(
    resolveResponsesCompactEndpointUrl(
      'https://api.openai.com/v1/responses',
      'https://proxy.example.com/custom/responses'
    ),
    'https://proxy.example.com/custom/responses/compact'
  );
  assert.equal(
    resolveResponsesCompactEndpointUrl(
      'https://api.openai.com/v1/responses',
      'https://proxy.example.com/custom/responses/compact'
    ),
    'https://proxy.example.com/custom/responses/compact'
  );
});

test('normalizeResponsesLocalCompactionSettings 仅保留手动 compact 端点配置', async () => {
  const { normalizeResponsesLocalCompactionSettings } = await loadResponsesLocalCompactionModule();

  assert.deepEqual(
    normalizeResponsesLocalCompactionSettings({
      endpointUrl: ' https://proxy.example.com/openai/responses/compact '
    }),
    { endpointUrl: 'https://proxy.example.com/openai/responses/compact' }
  );
  assert.equal(
    normalizeResponsesLocalCompactionSettings({
      enabled: true,
      thresholdPromptTokens: 150000
    }),
    null
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

test('buildResponsesCompactRequestBody 保留 function/custom tool output 原文，不再做强制预算截断', async () => {
  const { buildResponsesCompactRequestBody } = await loadResponsesLocalCompactionModule();

  const largeOutput = 'A'.repeat(12000) + 'tail';
  const requestBody = {
    model: 'gpt-5.4',
    instructions: 'base instructions',
    tools: [{ type: 'function', name: 'page_content_read' }, { type: 'function', name: 'js_runtime_execute' }],
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'keep original user message intact' }]
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [
          {
            type: 'input_text',
            text: largeOutput
          }
        ]
      },
      {
        type: 'custom_tool_call_output',
        call_id: 'call_2',
        output: {
          status: 'ok',
          text: largeOutput
        }
      },
      ...Array.from({ length: 2 }, (_unused, index) => ({
        type: 'function_call_output',
        call_id: `call_extra_${index}`,
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
  assert.equal(
    compactBody.input[0].content[0].text,
    'keep original user message intact'
  );
  assert.equal(compactBody.input[1].output[0].text, largeOutput);
  assert.deepEqual(compactBody.input[2].output, {
    status: 'ok',
    text: largeOutput
  });
  assert.equal(compactBody.input.length, requestBody.input.length);
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

test('applyResponsesCompactInstructionsOverride 会用 compact 专用 instructions 覆盖聊天链路里的 instructions', async () => {
  const { applyResponsesCompactInstructionsOverride } = await loadResponsesLocalCompactionModule();

  assert.deepEqual(
    applyResponsesCompactInstructionsOverride(
      {
        model: 'gpt-5.4',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        instructions: 'chat system prompt'
      },
      'codex compact instructions'
    ),
    {
      model: 'gpt-5.4',
      input: [{ type: 'message', role: 'user', content: 'hello' }],
      instructions: 'codex compact instructions'
    }
  );
});

test('responses_compact_codex_instructions 导出 Codex 风格的 gpt-5.4 base instructions', async () => {
  const { RESPONSES_COMPACT_CODEX_GPT_5_4_BASE_INSTRUCTIONS } = await loadResponsesCompactCodexInstructionsModule();

  assert.equal(typeof RESPONSES_COMPACT_CODEX_GPT_5_4_BASE_INSTRUCTIONS, 'string');
  assert.match(RESPONSES_COMPACT_CODEX_GPT_5_4_BASE_INSTRUCTIONS, /^You are Codex, a coding agent based on GPT-5\./);
  assert.ok(RESPONSES_COMPACT_CODEX_GPT_5_4_BASE_INSTRUCTIONS.length > 1000);
});
