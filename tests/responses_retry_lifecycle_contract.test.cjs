const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  return fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

test('Responses API lifecycle 在发送和流式消费外层有默认 5 次恢复性重试', async () => {
  const source = await readWorkspaceFile('src/core/message_sender.js');

  assert.match(
    source,
    /const responsesMaxRetries = isOpenAIResponsesApiConfig\(usedApiConfig\)[\s\S]*?DEFAULT_RESPONSES_API_MAX_RETRIES/,
    'Responses API lifecycle 应使用默认 5 次重试预算'
  );
  assert.match(
    source,
    /shouldRetryResponsesLifecycleError\(error, usedApiConfig\)[\s\S]*?responsesRetryCount >= responsesMaxRetries/,
    '重试前必须统一判定错误是否可恢复，并受最大次数约束'
  );
  assert.match(
    source,
    /const retryDelayMs = buildResponsesRetryDelayMs\(responsesRetryCount\);/,
    '每次重试只能使用本地小幅退避策略，不接受服务端或代理提示延迟'
  );
  assert.doesNotMatch(
    source,
    /responsesRetryAfterMs|retryAfterHeader/,
    'Responses lifecycle 不应把 Retry-After 或错误消息里的延迟带入重试等待'
  );
});

test('Responses stream 未收到 completed 就关闭会转为可恢复错误', async () => {
  const source = await readWorkspaceFile('src/core/message_sender.js');

  assert.match(
    source,
    /let hasOpenAIResponsesTerminalEvent = false;/,
    '流式解析需要显式记录 Responses terminal event'
  );
  assert.match(
    source,
    /eventType === 'response\.completed'[\s\S]*?hasOpenAIResponsesTerminalEvent = true;/,
    'response.completed 必须标记为 terminal event'
  );
  assert.match(
    source,
    /Responses stream closed before response\.completed/,
    '连接提前关闭不能被当作成功的部分响应'
  );
});
