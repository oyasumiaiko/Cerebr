const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function importFresh(relativePath) {
  const absolutePath = path.resolve(__dirname, relativePath);
  const url = pathToFileURL(absolutePath);
  url.searchParams.set('t', `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

function installChromeStub(t) {
  const previousChrome = global.chrome;
  global.chrome = {
    storage: {
      onChanged: {
        addListener() {}
      }
    }
  };
  t.after(() => {
    if (typeof previousChrome === 'undefined') {
      delete global.chrome;
      return;
    }
    global.chrome = previousChrome;
  });
}

async function createApiManagerForTest(t) {
  installChromeStub(t);
  const { createApiManager } = await importFresh('../src/api/api_settings.js');
  return createApiManager({
    dom: {
      apiSettingsPanel: null,
      apiCardsContainer: null
    },
    services: {
      settingsManager: {
        getSetting(_key, fallbackValue) {
          return typeof fallbackValue === 'undefined' ? true : fallbackValue;
        }
      }
    },
    utils: {
      closeExclusivePanels() {}
    }
  });
}

test('filterIncompleteResponsesToolCallReplayItems 会移除缺少 output 的半成品 function_call', async () => {
  const { filterIncompleteResponsesToolCallReplayItems } = await importFresh('../src/utils/responses_input_items.js');

  const filtered = filterIncompleteResponsesToolCallReplayItems([
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'partial answer' }]
    },
    {
      type: 'function_call',
      call_id: 'call_dangling',
      name: 'page_content_read',
      arguments: '{"max_chars":5000}'
    },
    {
      type: 'function_call',
      call_id: 'call_ok',
      name: 'history_search',
      arguments: '{"text_all":["alpha"]}'
    },
    {
      type: 'function_call_output',
      call_id: 'call_ok',
      output: [{ type: 'input_text', text: '<tool_result>done</tool_result>' }]
    }
  ]);

  assert.deepEqual(filtered, [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'partial answer' }]
    },
    {
      type: 'function_call',
      call_id: 'call_ok',
      name: 'history_search',
      arguments: '{"text_all":["alpha"]}'
    },
    {
      type: 'function_call_output',
      call_id: 'call_ok',
      output: [{ type: 'input_text', text: '<tool_result>done</tool_result>' }]
    }
  ]);
});

test('buildRequest 不会把中断后残留的裸 function_call 重放到下一次 Responses 请求', async (t) => {
  const apiManager = await createApiManagerForTest(t);

  const requestBody = await apiManager.buildRequest({
    config: {
      modelName: 'gpt-5.4',
      baseUrl: 'https://api.openai.com/v1/responses',
      connectionType: 'openai_responses',
      useStreaming: false
    },
    messages: [
      { role: 'user', content: 'first question' },
      {
        role: 'assistant',
        content: 'partial answer',
        response_input_items: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'partial answer' }]
          },
          {
            type: 'function_call',
            call_id: 'call_dangling',
            name: 'page_content_read',
            arguments: '{}'
          }
        ]
      },
      { role: 'user', content: 'next question' }
    ]
  });

  const responseInput = Array.isArray(requestBody?.input) ? requestBody.input : [];
  assert.equal(
    responseInput.some((item) => item?.type === 'function_call' && item?.call_id === 'call_dangling'),
    false
  );
  assert.equal(
    responseInput.some((item) => item?.type === 'message' && item?.role === 'assistant'),
    true
  );
});

test('buildRequest 仍会保留已闭环的 function_call 与 function_call_output', async (t) => {
  const apiManager = await createApiManagerForTest(t);

  const requestBody = await apiManager.buildRequest({
    config: {
      modelName: 'gpt-5.4',
      baseUrl: 'https://api.openai.com/v1/responses',
      connectionType: 'openai_responses',
      useStreaming: false
    },
    messages: [
      { role: 'user', content: 'first question' },
      {
        role: 'assistant',
        response_input_items: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'tool result ready' }]
          },
          {
            type: 'function_call',
            call_id: 'call_ok',
            name: 'history_search',
            arguments: '{"text_all":["alpha"]}'
          },
          {
            type: 'function_call_output',
            call_id: 'call_ok',
            output: [{ type: 'input_text', text: '<tool_result>done</tool_result>' }]
          }
        ]
      },
      { role: 'user', content: 'next question' }
    ]
  });

  const responseInput = Array.isArray(requestBody?.input) ? requestBody.input : [];
  assert.equal(
    responseInput.some((item) => item?.type === 'function_call' && item?.call_id === 'call_ok'),
    true
  );
  assert.equal(
    responseInput.some((item) => item?.type === 'function_call_output' && item?.call_id === 'call_ok'),
    true
  );
});

test('buildRequest 会在原 image_generation_call item 上水合本地化生图结果', async (t) => {
  const apiManager = await createApiManagerForTest(t);

  const requestBody = await apiManager.buildRequest({
    config: {
      modelName: 'gpt-5.4',
      baseUrl: 'https://api.openai.com/v1/responses',
      connectionType: 'openai_responses',
      useStreaming: false
    },
    messages: [
      { role: 'user', content: 'generate an image' },
      {
        role: 'assistant',
        response_input_items: [
          {
            type: 'image_generation_call',
            revised_prompt: 'blue pen on white paper',
            result_image_url: 'data:image/png;base64,QUJDRA=='
          }
        ]
      },
      { role: 'user', content: 'make it brighter' }
    ]
  });

  const responseInput = Array.isArray(requestBody?.input) ? requestBody.input : [];
  const imageItems = responseInput.filter((item) => item?.type === 'image_generation_call');
  assert.equal(imageItems.length, 1);
  assert.equal(imageItems[0].result, 'QUJDRA==');
  assert.equal(Object.prototype.hasOwnProperty.call(imageItems[0], 'result_image_url'), false);
  assert.equal(
    responseInput.some((item) => item?.type === 'message' && Array.isArray(item?.content)
      && item.content.some((part) => part?.type === 'input_image')),
    false
  );
});

test('buildRequest 的纯对话模式不会重放历史隐藏上下文或工具协议', async (t) => {
  const apiManager = await createApiManagerForTest(t);
  const messages = [
    {
      role: 'system',
      content: '全局系统提示词',
      contextual_input_items_before: [{ type: 'message', role: 'developer', content: '隐藏系统上下文' }]
    },
    { role: 'user', content: '第一问' },
    {
      role: 'assistant',
      content: '第一答',
      tool_calls: [{ id: 'call_old', function: { name: 'read_file', arguments: '{}' } }],
      response_input_items: [
        { type: 'function_call', call_id: 'call_old', name: 'read_file', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_old', output: '旧工具输出' }
      ]
    },
    {
      role: 'user',
      content: '第二问',
      contextual_input_items_before: [
        { type: 'message', role: 'developer', content: '<environment_context>secret</environment_context>' }
      ]
    }
  ];

  const requestBody = await apiManager.buildRequest({
    config: {
      modelName: 'gpt-5.4',
      baseUrl: 'https://api.openai.com/v1/responses',
      connectionType: 'openai_responses',
      requestMode: 'pure_chat',
      customSystemPrompt: 'API 自定义系统提示词',
      customParams: JSON.stringify({
        input: [{ type: 'function_call_output', call_id: 'override', output: 'override' }],
        instructions: 'customParams 不应覆盖规范系统提示词',
        tools: [{ type: 'web_search' }],
        tool_choice: 'required',
        previous_response_id: 'resp_old'
      }),
      responsesApiSettings: {
        instructions: 'Responses 用户 Instructions',
        tools: [{ type: 'mcp', server_label: 'hidden' }],
        tool_choice: 'required',
        conversation: 'conv_old',
        prompt: { id: 'pmpt_old' },
        extension_tools: {
          read_file: { enabled: true }
        }
      },
      useStreaming: false
    },
    messages
  });

  assert.match(requestBody.instructions, /Responses 用户 Instructions/);
  assert.match(requestBody.instructions, /API 自定义系统提示词/);
  assert.match(requestBody.instructions, /全局系统提示词/);
  assert.doesNotMatch(requestBody.instructions, /customParams 不应覆盖/);
  assert.deepEqual(
    requestBody.input.map(item => ({ type: item.type, role: item.role, content: item.content })),
    [
      { type: 'message', role: 'user', content: '第一问' },
      { type: 'message', role: 'assistant', content: '第一答' },
      { type: 'message', role: 'user', content: '第二问' }
    ]
  );
  assert.equal(requestBody.input.every(item => item.type === 'message'), true);
  for (const field of ['tools', 'tool_choice', 'previous_response_id', 'conversation', 'prompt']) {
    assert.equal(Object.hasOwn(requestBody, field), false, field);
  }
  assert.equal(messages[2].response_input_items[1].output, '旧工具输出');
  assert.match(messages[3].contextual_input_items_before[0].content, /secret/);
});

test('buildRequest 在 OpenAI Chat 与 Gemini 纯对话模式下也强制清除工具字段', async (t) => {
  const apiManager = await createApiManagerForTest(t);
  const messages = [
    { role: 'system', content: '系统提示词' },
    { role: 'user', content: '问题' },
    { role: 'assistant', content: '回答', tool_calls: [{ id: 'call_old' }] }
  ];

  const chatBody = await apiManager.buildRequest({
    config: {
      modelName: 'chat-model',
      baseUrl: 'https://example.com/v1/chat/completions',
      connectionType: 'openai',
      requestMode: 'pure_chat',
      customParams: JSON.stringify({
        messages: [{ role: 'system', content: '覆盖消息' }],
        tools: [{ type: 'function', function: { name: 'hidden' } }],
        functions: [{ name: 'legacy_hidden' }],
        tool_choice: 'required'
      }),
      useStreaming: false
    },
    messages
  });
  assert.deepEqual(chatBody.messages, [
    { role: 'system', content: '系统提示词' },
    { role: 'user', content: '问题' },
    { role: 'assistant', content: '回答' }
  ]);
  assert.equal(Object.hasOwn(chatBody, 'tools'), false);
  assert.equal(Object.hasOwn(chatBody, 'functions'), false);
  assert.equal(Object.hasOwn(chatBody, 'tool_choice'), false);

  const geminiBody = await apiManager.buildRequest({
    config: {
      modelName: 'gemini-model',
      baseUrl: 'https://generativelanguage.googleapis.com',
      connectionType: 'gemini',
      requestMode: 'pure_chat',
      customParams: JSON.stringify({ tools: [{ functionDeclarations: [] }], candidateCount: 1 }),
      geminiApiSettings: {
        cachedContent: 'cachedContents/hidden',
        tools: [{ functionDeclarations: [] }],
        toolConfig: { functionCallingConfig: { mode: 'ANY' } }
      },
      useStreaming: false
    },
    messages
  });
  assert.deepEqual(geminiBody.contents, [
    { role: 'user', parts: [{ text: '问题' }] },
    { role: 'model', parts: [{ text: '回答' }] }
  ]);
  assert.deepEqual(geminiBody.systemInstruction, { parts: [{ text: '系统提示词' }] });
  assert.equal(Object.hasOwn(geminiBody, 'tools'), false);
  assert.equal(Object.hasOwn(geminiBody, 'toolConfig'), false);
  assert.equal(Object.hasOwn(geminiBody, 'cachedContent'), false);
});

test('buildRequest 不再为 Chat Completions 默认添加 top_p，但保留用户显式配置', async (t) => {
  const apiManager = await createApiManagerForTest(t);
  const messages = [{ role: 'user', content: '你好' }];

  const defaultChatBody = await apiManager.buildRequest({
    config: {
      modelName: 'chat-model',
      baseUrl: 'https://example.com/v1/chat/completions',
      connectionType: 'openai',
      temperature: 1,
      useStreaming: false
    },
    messages
  });
  assert.equal(defaultChatBody.temperature, 1);
  assert.equal(Object.hasOwn(defaultChatBody, 'top_p'), false);

  const explicitChatBody = await apiManager.buildRequest({
    config: {
      modelName: 'chat-model',
      baseUrl: 'https://example.com/v1/chat/completions',
      connectionType: 'openai',
      customParams: JSON.stringify({ top_p: 0.8 }),
      useStreaming: false
    },
    messages
  });
  assert.equal(explicitChatBody.top_p, 0.8);
});
