const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadAssistantPreResponseStatusModule() {
  const filePath = path.resolve(__dirname, '../src/utils/assistant_pre_response_status.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('deriveAssistantPreResponseStatusFromLocalStage 会把本地请求阶段收敛到统一文案', async () => {
  const { deriveAssistantPreResponseStatusFromLocalStage } = await loadAssistantPreResponseStatusModule();

  assert.deepEqual(
    deriveAssistantPreResponseStatusFromLocalStage('compose_messages'),
    {
      text: '正在准备消息...',
      stage: 'compose_messages',
      note: '',
      showSpinner: true
    }
  );

  assert.deepEqual(
    deriveAssistantPreResponseStatusFromLocalStage('http_request_sent'),
    {
      text: '请求已发出，等待模型响应...',
      stage: 'http_request_sent',
      note: '',
      showSpinner: true
    }
  );

  assert.deepEqual(
    deriveAssistantPreResponseStatusFromLocalStage('http_429_rate_limited', { willRetry: true }),
    {
      text: '请求触发限流，正在重试...',
      stage: 'http_429_rate_limited',
      note: '',
      showSpinner: true
    }
  );
});

test('deriveAssistantPreResponseStatusFromResponsesSse 会把 SSE 事件收敛到统一文案', async () => {
  const { deriveAssistantPreResponseStatusFromResponsesSse } = await loadAssistantPreResponseStatusModule();

  assert.deepEqual(
    deriveAssistantPreResponseStatusFromResponsesSse('response.reasoning_summary_text.delta'),
    {
      text: '模型正在思考...',
      stage: 'responses_reasoning',
      note: '服务器已返回推理相关事件。',
      showSpinner: true
    }
  );

  assert.deepEqual(
    deriveAssistantPreResponseStatusFromResponsesSse('response.output_item.added', {
      item: { type: 'function_call' }
    }),
    {
      text: '模型正在准备工具调用...',
      stage: 'responses_tool_call',
      note: '',
      showSpinner: true
    }
  );

  assert.deepEqual(
    deriveAssistantPreResponseStatusFromResponsesSse('response.output_item.added', {
      item: { type: 'tool_search_call' }
    }),
    {
      text: '模型正在准备工具调用...',
      stage: 'responses_tool_call',
      note: '',
      showSpinner: true
    }
  );

  assert.deepEqual(
    deriveAssistantPreResponseStatusFromResponsesSse('response.output_text.delta'),
    {
      text: '模型正在生成回复...',
      stage: 'responses_output_text',
      note: '',
      showSpinner: true
    }
  );
});

test('normalizeAssistantPreResponseStatus 会过滤空文案并规范化字段', async () => {
  const { normalizeAssistantPreResponseStatus } = await loadAssistantPreResponseStatusModule();

  assert.equal(normalizeAssistantPreResponseStatus(null), null);
  assert.equal(normalizeAssistantPreResponseStatus({ text: '   ' }), null);
  assert.deepEqual(
    normalizeAssistantPreResponseStatus({
      text: '  请求已发出，等待模型响应... ',
      stage: ' wait_response ',
      note: '  note ',
      showSpinner: false
    }),
    {
      text: '请求已发出，等待模型响应...',
      stage: 'wait_response',
      note: 'note',
      showSpinner: false
    }
  );
});
