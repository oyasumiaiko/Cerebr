const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadApiRequestModeModule() {
  const filePath = path.resolve(__dirname, '../src/api/api_request_mode.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('API 请求模式默认保持增强模式，消息模板只有显式关闭才停用', async () => {
  const {
    API_REQUEST_MODE_ENHANCED,
    API_REQUEST_MODE_PURE_CHAT,
    isPureConversationApiConfig,
    isUserMessageTemplateEnabled,
    normalizeApiRequestMode
  } = await loadApiRequestModeModule();

  assert.equal(normalizeApiRequestMode(undefined), API_REQUEST_MODE_ENHANCED);
  assert.equal(normalizeApiRequestMode('unknown'), API_REQUEST_MODE_ENHANCED);
  assert.equal(normalizeApiRequestMode(API_REQUEST_MODE_PURE_CHAT), API_REQUEST_MODE_PURE_CHAT);
  assert.equal(isPureConversationApiConfig({ requestMode: API_REQUEST_MODE_PURE_CHAT }), true);
  assert.equal(isPureConversationApiConfig({ requestMode: API_REQUEST_MODE_ENHANCED }), false);
  assert.equal(isUserMessageTemplateEnabled({}), true);
  assert.equal(isUserMessageTemplateEnabled({ userMessagePreprocessorEnabled: false }), false);
});

test('纯对话消息副本只保留 user/system/assistant 显式正文且不修改历史对象', async () => {
  const { buildPureConversationMessages } = await loadApiRequestModeModule();
  const source = [
    {
      role: 'system',
      content: '用户设置的系统提示词',
      contextual_input_items_before: [{ type: 'message', role: 'developer', content: '隐藏上下文' }]
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: '看这张图' },
        { type: 'image_url', image_url: { url: 'https://example.com/a.png', detail: 'high' } },
        { type: 'input_file', file_id: 'file-secret' }
      ],
      response_input_items: [{ type: 'function_call_output', output: 'secret' }]
    },
    {
      role: 'assistant',
      content: '这是 AI 回复',
      tool_calls: [{ id: 'call-1', function: { name: 'read_file' } }],
      response_activity_timeline: [{ kind: 'commentary', text: '内部过程' }]
    },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-2' }] },
    { role: 'tool', content: '工具输出' }
  ];

  const result = buildPureConversationMessages(source);

  assert.deepEqual(result, [
    { role: 'system', content: '用户设置的系统提示词' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '看这张图' },
        { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }
      ]
    },
    { role: 'assistant', content: '这是 AI 回复' }
  ]);
  assert.equal(source[0].contextual_input_items_before[0].content, '隐藏上下文');
  assert.equal(source[1].response_input_items[0].output, 'secret');
  assert.equal(source[2].tool_calls[0].function.name, 'read_file');
});

test('Responses 纯对话请求保留 message input 与用户 instructions，清除工具和服务端上下文', async () => {
  const { enforcePureConversationRequestBody } = await loadApiRequestModeModule();
  const original = {
    model: 'gpt-5',
    input: [{ type: 'function_call_output', call_id: 'call-1', output: 'hidden' }],
    instructions: '用户配置的系统提示词',
    tools: [{ type: 'web_search' }],
    tool_choice: 'required',
    previous_response_id: 'resp_old',
    conversation: 'conv_old',
    prompt: { id: 'pmpt_hidden' },
    context_management: [{ type: 'compaction' }],
    include: ['reasoning.encrypted_content'],
    extra_body: {
      tools: [{ type: 'mcp' }],
      input: [{ type: 'function_call_output', output: 'nested hidden' }],
      instructions: 'nested hidden instructions',
      keep: true
    }
  };
  const canonicalInput = [
    { type: 'message', role: 'user', content: '你好' },
    { type: 'message', role: 'assistant', content: '你好，有什么可以帮你？' }
  ];

  const result = enforcePureConversationRequestBody(original, {
    connectionType: 'openai_responses',
    input: canonicalInput,
    instructions: '用户配置的系统提示词'
  });

  assert.deepEqual(result.input, canonicalInput);
  assert.equal(result.instructions, '用户配置的系统提示词');
  assert.deepEqual(result.include, ['reasoning.encrypted_content']);
  assert.deepEqual(result.extra_body, { keep: true });
  for (const field of ['tools', 'tool_choice', 'previous_response_id', 'conversation', 'prompt', 'context_management']) {
    assert.equal(Object.hasOwn(result, field), false, field);
  }
  assert.equal(original.tools[0].type, 'web_search');
  assert.equal(original.input[0].type, 'function_call_output');
});

test('OpenAI Chat 与 Gemini 纯对话请求都以规范消息覆盖自定义内容字段', async () => {
  const { enforcePureConversationRequestBody } = await loadApiRequestModeModule();
  const messages = [
    { role: 'system', content: '系统提示词' },
    { role: 'user', content: '问题' },
    { role: 'assistant', content: '回答' }
  ];
  const chatResult = enforcePureConversationRequestBody({
    model: 'chat-model',
    messages: [{ role: 'system', content: 'customParams 覆盖内容' }],
    instructions: '额外隐藏指令',
    functions: [{ name: 'legacy_tool' }],
    tool_choice: 'auto'
  }, {
    connectionType: 'openai',
    messages
  });
  assert.deepEqual(chatResult.messages, messages);
  assert.equal(Object.hasOwn(chatResult, 'instructions'), false);
  assert.equal(Object.hasOwn(chatResult, 'functions'), false);
  assert.equal(Object.hasOwn(chatResult, 'tool_choice'), false);

  const contents = [
    { role: 'user', parts: [{ text: '问题' }] },
    { role: 'model', parts: [{ text: '回答' }] }
  ];
  const systemInstruction = { parts: [{ text: '系统提示词' }] };
  const geminiResult = enforcePureConversationRequestBody({
    contents: [{ role: 'user', parts: [{ text: '被覆盖' }] }],
    systemInstruction: { parts: [{ text: '被覆盖' }] },
    cachedContent: 'cachedContents/secret',
    tools: [{ functionDeclarations: [] }],
    toolConfig: { functionCallingConfig: { mode: 'ANY' } },
    generationConfig: { temperature: 0.2 }
  }, {
    connectionType: 'gemini',
    contents,
    systemInstruction
  });
  assert.deepEqual(geminiResult.contents, contents);
  assert.deepEqual(geminiResult.systemInstruction, systemInstruction);
  assert.deepEqual(geminiResult.generationConfig, { temperature: 0.2 });
  assert.equal(Object.hasOwn(geminiResult, 'cachedContent'), false);
  assert.equal(Object.hasOwn(geminiResult, 'tools'), false);
  assert.equal(Object.hasOwn(geminiResult, 'toolConfig'), false);
});
