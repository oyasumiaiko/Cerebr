const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadRequestUserInputResumeModule() {
  const filePath = path.resolve(__dirname, '../src/utils/request_user_input_resume.js');
  return import(pathToFileURL(filePath).href);
}

function buildRequestUserInputArguments() {
  return JSON.stringify({
    questions: [
      {
        header: '输出方式',
        id: 'output_mode',
        question: '这次你更希望我怎么落地？',
        options: [
          { label: '直接实现', description: '直接改代码并给结果。' },
          { label: '先出方案', description: '先确认方案再动手。' }
        ]
      }
    ]
  });
}

test('findPendingRequestUserInputFromConversationMessages 会返回最后一条主 assistant 消息上的未完成提问', async () => {
  const { findPendingRequestUserInputFromConversationMessages } = await loadRequestUserInputResumeModule();

  const pending = findPendingRequestUserInputFromConversationMessages([
    { id: 'u1', role: 'user', content: '帮我继续' },
    {
      id: 'a1',
      role: 'assistant',
      response_activity_timeline: [
        {
          kind: 'tool_call',
          type: 'function_call',
          call_id: 'call_1',
          name: 'request_user_input',
          arguments: buildRequestUserInputArguments()
        }
      ]
    }
  ]);

  assert.deepEqual(pending, {
    messageId: 'a1',
    callId: 'call_1',
    questions: [
      {
        header: '输出方式',
        id: 'output_mode',
        question: '这次你更希望我怎么落地？',
        is_other: true,
        options: [
          { label: '直接实现', description: '直接改代码并给结果。' },
          { label: '先出方案', description: '先确认方案再动手。' }
        ]
      }
    ]
  });
});

test('findPendingRequestUserInputFromConversationMessages 只在对话结尾仍停在未完成提问时返回结果', async () => {
  const { findPendingRequestUserInputFromConversationMessages } = await loadRequestUserInputResumeModule();

  const pending = findPendingRequestUserInputFromConversationMessages([
    {
      id: 'a1',
      role: 'assistant',
      response_activity_timeline: [
        {
          kind: 'tool_call',
          type: 'function_call',
          call_id: 'call_1',
          name: 'request_user_input',
          arguments: buildRequestUserInputArguments()
        }
      ]
    },
    { id: 'u2', role: 'user', content: '我晚点再答' }
  ]);

  assert.equal(pending, null);
});

test('extractPendingRequestUserInputFromAssistantMessage 在已有 output 时不会重复恢复', async () => {
  const { extractPendingRequestUserInputFromAssistantMessage } = await loadRequestUserInputResumeModule();

  const pending = extractPendingRequestUserInputFromAssistantMessage({
    id: 'a1',
    role: 'assistant',
    response_activity_timeline: [
      {
        kind: 'tool_call',
        type: 'function_call',
        call_id: 'call_1',
        name: 'request_user_input',
        arguments: buildRequestUserInputArguments(),
        output: [
          {
            type: 'input_text',
            text: '<request_user_input_result>{"cancelled":true}</request_user_input_result>'
          }
        ]
      }
    ]
  });

  assert.equal(pending, null);
});

test('extractPendingRequestUserInputFromAssistantMessage 遇到坏参数时直接放弃恢复', async () => {
  const { extractPendingRequestUserInputFromAssistantMessage } = await loadRequestUserInputResumeModule();

  const pending = extractPendingRequestUserInputFromAssistantMessage({
    id: 'a1',
    role: 'assistant',
    response_activity_timeline: [
      {
        kind: 'tool_call',
        type: 'function_call',
        call_id: 'call_1',
        name: 'request_user_input',
        arguments: '{"questions":[{"header":"坏数据"}]}'
      }
    ]
  });

  assert.equal(pending, null);
});
