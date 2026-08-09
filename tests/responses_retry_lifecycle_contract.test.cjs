const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  return fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

test('Responses API lifecycle 使用 10 次有界重试、同请求快照和 handled stream error', async () => {
  const source = await readWorkspaceFile('src/core/message_sender.js');

  assert.match(
    source,
    /const responsesMaxRetries = isOpenAIResponsesApiConfig\(usedApiConfig\)[\s\S]*?DEFAULT_RESPONSES_API_MAX_RETRIES/,
    'Responses API lifecycle 应使用默认 10 次重试预算'
  );
  assert.match(
    source,
    /const canRetryResponsesError = shouldRetryResponsesLifecycleError\(error, usedApiConfig\);[\s\S]*?responsesRetryCount >= responsesMaxRetries/,
    '重试前必须统一判定错误是否可恢复，并受最大次数约束'
  );
  assert.match(
    source,
    /const retryDelayMs = buildResponsesRetryDelayMs\(responsesRetryCount, \{[\s\S]*?retryAfterMs: error\?\.responsesRetryAfterMs[\s\S]*?\}\);/,
    '每次重试应优先采用服务端延迟，再由策略统一限制上限'
  );
  assert.match(
    source,
    /const requestBodySnapshot = cloneDataSafely\(currentRequestBody\)[\s\S]*?requestBody: cloneDataSafely\(requestBodySnapshot\)[\s\S]*?buildResponsesFunctionToolFollowUpRequest\([\s\S]*?requestBodySnapshot,/,
    '同一 hop 必须冻结请求体，所有重试和成功后的 follow-up 都以该快照为准'
  );
  assert.match(
    source,
    /let responsesRetryBaseline = captureResponsesRetryBaseline\(attemptState\);[\s\S]*?commitStagedPendingSteersForFollowUp\(attemptState\);[\s\S]*?responsesRetryBaseline = captureResponsesRetryBaseline\(attemptState\);/,
    'response headers 后已经提交的 steer 必须进入新的 retry baseline，不能在断流回滚时丢失'
  );
  assert.match(
    source,
    /const handledStreamErrors = \[\];[\s\S]*?handledStreamErrors\.push\(handledStreamError\)[\s\S]*?mergeResponsesActivityTimeline\([\s\S]*?responsesRetryBaseline\?\.timeline \|\| \[\],[\s\S]*?handledStreamErrors/,
    '每次 handled 中断都要在恢复 baseline 后保留，不能被下一次重试抹掉'
  );
  assert.match(
    source,
    /error\.responsesRetriesExhausted = true;[\s\S]*?error\.responsesRetryCount = responsesRetryCount;[\s\S]*?error\.skipConversationAutoRetry = true;/,
    'Responses 重试耗尽后不能再级联触发消息级自动重试'
  );
  assert.match(
    source,
    /const responsesRetriesExhausted = error\?\.responsesRetriesExhausted === true;[\s\S]*?Responses 连接重试失败/,
    'Responses 重试耗尽后的错误 UI 必须报告真实的独立重试次数'
  );
});

test('Responses stream 在 final 前断线会重试，final 已开始则保留半截回答并停止', async () => {
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
    'Responses 提前关闭必须只用 final 正文可见性决定是否停止重试'
  );
  assert.match(
    source,
    /responsesStreamClosureAction === 'retry'[\s\S]*?createResponsesRecoverableError/,
    'final 正文尚未开始时的提前关闭应进入恢复性重试'
  );
  assert.match(
    source,
    /catch \(error\) \{[\s\S]*?failureAction !== 'preserve_partial'[\s\S]*?responsesStreamFailure = error;/,
    'reader.read 抛出的真实传输错误也必须在 final 已开始时转成保留部分回答'
  );
  const readerFailureCatch = source.match(
    /let responsesStreamFailure = null;[\s\S]*?catch \(error\) \{[\s\S]*?failureAction !== 'preserve_partial'[\s\S]*?responsesStreamFailure = error;/
  )?.[0] || '';
  assert.doesNotMatch(
    readerFailureCatch,
    /shouldRetryResponsesLifecycleError/,
    'final 已开始后必须保留任意非 Abort 流错误，不能再依赖可重试错误分类'
  );
  assert.match(
    source,
    /const cancelPendingStreamRender = \(\) => \{[\s\S]*?uiUpdateThrottler\.cancel\(\)[\s\S]*?responsesStreamClosureAction === 'retry'[\s\S]*?cancelPendingStreamRender\(\);/,
    'final 前重试必须取消失败 hop 尚未落地的节流更新，避免 baseline 被旧 timer 污染'
  );
  assert.match(
    source,
    /if \(isOpenAIResponsesStream\) \{[\s\S]*?createResponsesRecoverableError\(readableError, \{[\s\S]*?reason: 'stream_parse'/,
    '截断 JSON 等 Responses SSE 解析错误必须进入同请求恢复性重试'
  );
  assert.match(
    source,
    /isConfiguredResponsesApi[\s\S]*?response\.text\(\)[\s\S]*?JSON\.parse\(responseText\)[\s\S]*?reason: 'response_json_parse'[\s\S]*?responseStatus === 'failed'[\s\S]*?responseStatus === 'incomplete'[\s\S]*?buildResponsesStreamErrorFromPayload/,
    'Responses 非流式 JSON 解析失败、failed 与 incomplete 也必须复用统一 lifecycle 重试'
  );
  assert.match(
    source,
    /text: '连接中断，已保留当前回答'[\s\S]*?status: 'stopped'/,
    'final 中断应留下可展开原因的非终止气泡记录'
  );
  assert.match(
    source,
    /incomplete: responsesStreamClosureAction === 'preserve_partial'/,
    '已有可见输出时应把部分回答作为不完整结果保留下来'
  );
  assert.match(
    source,
    /if \(lastHandleResult\?\.incomplete === true\) \{[\s\S]*?return lastHandleResult;[\s\S]*?\}[\s\S]*?if \(pendingToolCalls\.length <= 0\)/,
    '部分回答保留后不能继续执行半截工具调用 follow-up'
  );
});
