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

test('buildRequest 不会重放中断后缺少 output 的 apply_patch_call', async (t) => {
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
        content: 'partial patch',
        response_input_items: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'partial patch' }]
          },
          {
            type: 'apply_patch_call',
            call_id: 'call_patch_dangling',
            status: 'completed',
            operation: {
              type: 'update_file',
              path: 'notes.md',
              diff: '@@\n-old\n+new'
            }
          }
        ]
      },
      { role: 'user', content: 'next question' }
    ]
  });

  const responseInput = Array.isArray(requestBody?.input) ? requestBody.input : [];
  assert.equal(
    responseInput.some((item) => item?.type === 'apply_patch_call' && item?.call_id === 'call_patch_dangling'),
    false
  );
  assert.equal(
    responseInput.some((item) => item?.type === 'message' && item?.role === 'assistant'),
    true
  );
});

test('buildRequest 会保留已闭环 apply_patch call/output 及必需 status', async (t) => {
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
            type: 'apply_patch_call',
            call_id: 'call_patch_ok',
            status: 'completed',
            operation: {
              type: 'delete_file',
              path: 'obsolete.md'
            }
          },
          {
            type: 'apply_patch_call_output',
            call_id: 'call_patch_ok',
            status: 'completed',
            output: 'Deleted obsolete.md.'
          }
        ]
      },
      { role: 'user', content: 'next question' }
    ]
  });

  const responseInput = Array.isArray(requestBody?.input) ? requestBody.input : [];
  const patchCall = responseInput.find((item) => (
    item?.type === 'apply_patch_call' && item?.call_id === 'call_patch_ok'
  ));
  const patchOutput = responseInput.find((item) => (
    item?.type === 'apply_patch_call_output' && item?.call_id === 'call_patch_ok'
  ));

  assert.equal(patchCall?.status, 'completed');
  assert.deepEqual(patchCall?.operation, {
    type: 'delete_file',
    path: 'obsolete.md'
  });
  assert.equal(patchOutput?.status, 'completed');
  assert.equal(patchOutput?.output, 'Deleted obsolete.md.');
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
