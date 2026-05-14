const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadResponsesRetryPolicyModule() {
  const filePath = path.resolve(__dirname, '../src/utils/responses_retry_policy.js');
  return import(pathToFileURL(filePath).href);
}

test('Responses API 默认重试策略是 5 次、200ms 起步指数退避并带小幅抖动', async () => {
  const {
    DEFAULT_RESPONSES_API_MAX_RETRIES,
    buildResponsesRetryDelayMs
  } = await loadResponsesRetryPolicyModule();

  assert.equal(DEFAULT_RESPONSES_API_MAX_RETRIES, 5);
  assert.equal(buildResponsesRetryDelayMs(1, { random: () => 0.5 }), 200);
  assert.equal(buildResponsesRetryDelayMs(2, { random: () => 0.5 }), 400);
  assert.equal(buildResponsesRetryDelayMs(3, { random: () => 0.5 }), 800);
  assert.equal(buildResponsesRetryDelayMs(1, { random: () => 0 }), 180);
  assert.equal(buildResponsesRetryDelayMs(1, { random: () => 1 }), 220);
});

test('Responses API 退避不接受服务端或代理提示的长延迟', async () => {
  const { buildResponsesRetryDelayMs } = await loadResponsesRetryPolicyModule();

  assert.equal(buildResponsesRetryDelayMs(1, { retryAfterMs: 60_000, random: () => 0.5 }), 200);
  assert.equal(buildResponsesRetryDelayMs(2, { retryAfterMs: 60_000, random: () => 0.5 }), 400);
});

test('Responses API 可恢复错误包括 5xx、429、response.failed 和连接类错误', async () => {
  const {
    classifyResponsesApiErrorPayload,
    isRecoverableResponsesTransportError
  } = await loadResponsesRetryPolicyModule();

  assert.equal(classifyResponsesApiErrorPayload('server exploded', { httpStatus: 500 }).retryable, true);
  assert.equal(classifyResponsesApiErrorPayload('rate limited', { httpStatus: 429 }).retryable, true);
  assert.equal(
    classifyResponsesApiErrorPayload(
      { code: 'server_overloaded', message: 'Selected model is at capacity. Please try again in 1.25s.' },
      { eventType: 'response.failed' }
    ).retryable,
    true
  );
  assert.equal(isRecoverableResponsesTransportError(new Error('network connection lost while reading stream')), true);
});

test('Responses API 确定性错误不会进入恢复性重试', async () => {
  const { classifyResponsesApiErrorPayload } = await loadResponsesRetryPolicyModule();

  assert.equal(
    classifyResponsesApiErrorPayload(
      { code: 'context_length_exceeded', message: 'Your input exceeds the context window.' },
      { eventType: 'response.failed' }
    ).fatal,
    true
  );
  assert.equal(classifyResponsesApiErrorPayload('forbidden', { httpStatus: 403 }).fatal, true);
});
