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

test('Responses stream 未收到 completed 就关闭时按可见进度区分重试或保留部分回答', async () => {
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
    '连接提前关闭在无可见进度时仍应作为可恢复错误'
  );
  assert.match(
    source,
    /resolveResponsesStreamClosureAction\([\s\S]*?hasRenderedAssistantMessage: !!currentAiMessageId[\s\S]*?hasVisibleAnswerContent:[\s\S]*?streamRenderState\.hasEverShownAnswerContent/,
    'Responses 提前关闭必须先区分是否已有可见输出，避免重试覆盖已显示内容'
  );
  assert.match(
    source,
    /responsesStreamClosureAction === 'retry'[\s\S]*?createResponsesRecoverableError/,
    '只有尚无可见进度的提前关闭才允许进入恢复性重试'
  );
  assert.match(
    source,
    /incomplete: responsesStreamClosureAction === 'preserve_partial'/,
    '已有可见输出时应把部分回答作为不完整结果保留下来'
  );
  assert.match(
    source,
    /if \(lastHandleResult\?\.incomplete === true\) \{[\s\S]*?return lastHandleResult;[\s\S]*?\}[\s\S]*?if \(pendingClientToolCalls\.length <= 0\)/,
    '部分回答保留后不能继续执行半截工具调用 follow-up'
  );
});

test('多 client-tool call 会逐 call 持久化已完成 output，避免中止后副作用与历史漂移', async () => {
  const source = await readWorkspaceFile('src/core/message_sender.js');

  assert.match(
    source,
    /for \(const toolCall of pendingClientToolCalls\) \{[\s\S]*?clientToolOutputs\.push\(outputItem\);[\s\S]*?mergeResponsesClientToolOutputsIntoTimeline\([\s\S]*?persistAttemptConversationSnapshot\(attemptState, \{ force: true \}\);[\s\S]*?\}/,
    '每个本地工具完成后都必须立刻合并 call/output 并持久化'
  );
});

test('官方 apply_patch 只执行 completed call，非流式 incomplete 响应不会产生副作用', async () => {
  const source = await readWorkspaceFile('src/core/message_sender.js');

  assert.match(
    source,
    /type === OPENAI_APPLY_PATCH_CALL_TYPE[\s\S]*?record\?\.status[\s\S]*?=== 'completed'/,
    'in_progress apply_patch_call 不能进入本地执行队列'
  );
  assert.match(
    source,
    /const responsesNonStreamIncomplete = isResponsesApi[\s\S]*?json\?\.incomplete_details[\s\S]*?incomplete: responsesNonStreamIncomplete/,
    '非流式 Responses incomplete 状态必须传回 lifecycle 以阻止工具执行'
  );
});
