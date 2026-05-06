const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadResponsesStreamStatusModule() {
  const filePath = path.resolve(__dirname, '../src/utils/responses_stream_status.js');
  return import(pathToFileURL(filePath).href);
}

async function loadAssistantPreResponseStatusModule() {
  const filePath = path.resolve(__dirname, '../src/utils/assistant_pre_response_status.js');
  return import(pathToFileURL(filePath).href);
}

test('response.created 会映射为服务器已开始处理的状态文案', async () => {
  const { deriveResponsesSseLoadingStatus } = await loadResponsesStreamStatusModule();
  const status = deriveResponsesSseLoadingStatus('response.created', {});
  assert.equal(status.text, '模型正在思考...');
  assert.equal(status.meta.stage, 'responses_in_progress');
});

test('reasoning 事件会映射为模型正在思考', async () => {
  const { deriveResponsesSseLoadingStatus } = await loadResponsesStreamStatusModule();
  const status = deriveResponsesSseLoadingStatus('response.reasoning_summary_text.delta', {});
  assert.equal(status.text, '模型正在思考...');
  assert.equal(status.meta.stage, 'responses_reasoning');
});

test('function_call output item 会映射为准备工具调用', async () => {
  const { deriveResponsesSseLoadingStatus } = await loadResponsesStreamStatusModule();
  const status = deriveResponsesSseLoadingStatus('response.output_item.added', {
    item: {
      type: 'function_call'
    }
  });
  assert.equal(status.text, '模型正在准备工具调用...');
  assert.equal(status.meta.stage, 'responses_tool_call');
});

test('普通 message output item 会映射为正在生成回复', async () => {
  const { deriveResponsesSseLoadingStatus } = await loadResponsesStreamStatusModule();
  const status = deriveResponsesSseLoadingStatus('response.output_item.added', {
    item: {
      type: 'message',
      phase: 'output'
    }
  });
  assert.equal(status.text, '模型正在生成回复...');
  assert.equal(status.meta.stage, 'responses_message_item');
});

test('Responses retry wait 本地阶段会展示重试计数', async () => {
  const { deriveAssistantPreResponseStatusFromLocalStage } = await loadAssistantPreResponseStatusModule();
  const status = deriveAssistantPreResponseStatusFromLocalStage('responses_retry_wait', {
    retryAttempt: 2,
    maxRetries: 5
  });
  assert.equal(status.text, '连接异常，正在重试（2/5）...');
  assert.equal(status.stage, 'responses_retry_wait');
});
