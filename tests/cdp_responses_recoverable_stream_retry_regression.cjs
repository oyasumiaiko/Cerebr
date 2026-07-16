const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const http = require('http');
const net = require('net');
const path = require('path');
const {
  buildSendContentMessageExpression,
  launchFixedSidebarContext,
  loadPlaywright,
  reloadUnpackedExtension,
  resolveFixedSidebarProfileDir,
  resolveStableChromeExecutablePath,
  shouldRunHeadless,
  sleep,
  waitFor,
  waitForSidebarFrame
} = require('./lib/stable_chrome_sidebar_harness.cjs');
const {
  launchWorktreeUnpackedChromiumContext,
  resolveWorktreeUnpackedProfileDir,
  waitForWorktreeExtensionWorker
} = require('./lib/worktree_unpacked_extension_harness.cjs');

const TOOL_RETRY_PROMPT = 'responses tool follow-up retry regression';
const NON_STREAM_RETRY_PROMPT = 'responses non-stream retry regression';
const FINAL_INTERRUPT_PROMPT = 'responses final interruption preserve regression';
const RECOVERED_TEXT = 'MOCK_TOOL_FOLLOW_UP_RECOVERED_20260716';
const NON_STREAM_RECOVERED_TEXT = 'MOCK_NON_STREAM_RECOVERED_20260716';
const PARTIAL_FINAL_TEXT = 'MOCK_PARTIAL_FINAL_MUST_BE_PRESERVED_20260716';
const FAILED_HOP_REASONING_TEXT = 'TRANSIENT_FAILED_HOP_REASONING_MUST_ROLL_BACK';
const RETRY_DETAIL = 'Selected model is at capacity. Please try again in 0.05s.';
const DISPLAYED_RETRY_DETAIL = `${RETRY_DETAIL} (code=server_overloaded)`;
const TOOL_CALL_ID = 'call_retry_once';

const [rawRepoRoot, outputDir, rawArg3 = '', rawArg4 = ''] = process.argv.slice(2);
const repoRoot = rawRepoRoot ? path.resolve(rawRepoRoot) : '';
const launchMode = (rawArg3 === 'stable' || rawArg3 === 'worktree_unpacked')
  ? rawArg3
  : ((rawArg4 === 'stable' || rawArg4 === 'worktree_unpacked') ? rawArg4 : 'stable');
const chromePath = (launchMode === rawArg3)
  ? resolveStableChromeExecutablePath()
  : (rawArg3 || resolveStableChromeExecutablePath());

if (!repoRoot || !outputDir) {
  throw new Error(
    'Usage: node tests/cdp_responses_recoverable_stream_retry_regression.cjs <repoRoot> <outputDir> [chromePath] [mode=stable|worktree_unpacked]'
  );
}

const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);
const startedAtMs = Date.now();

function logProgress(label) {
  const elapsedSeconds = ((Date.now() - startedAtMs) / 1000).toFixed(1);
  console.log(`[responses-retry +${elapsedSeconds}s] ${label}`);
}

async function getFreePort() {
  const unsafePorts = new Set([6000, 6665, 6666, 6667, 6668, 6669]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const selectedPort = address && typeof address === 'object' ? address.port : 0;
        server.close((error) => error ? reject(error) : resolve(selectedPort));
      });
      server.on('error', reject);
    });
    if (!unsafePorts.has(port)) return port;
  }
  throw new Error('failed to allocate a browser-safe local port');
}

function buildStorageSeed(baseUrl) {
  const sourceId = 'src_responses_recoverable_stream_retry_regression';
  const config = {
    id: 'cfg_responses_recoverable_stream_retry_regression',
    connectionSourceId: sourceId,
    displayName: 'Recoverable Responses Retry Regression',
    modelName: 'gpt-5.4',
    customParams: '',
    customSystemPrompt: '',
    temperature: 1,
    useStreaming: true,
    isFavorite: false,
    enableAskOtherAiTool: false,
    maxChatHistory: 500,
    maxChatHistoryUser: 2147483647,
    maxChatHistoryAssistant: 2147483647,
    userMessagePreprocessorTemplate: '',
    userMessagePreprocessorIncludeInHistory: false,
    responsesApiSettings: {
      reasoning: { effort: 'medium', generate_summary: 'none', summary: 'none' },
      text: { verbosity: 'low' },
      parallel_tool_calls: true,
      store: false,
      builtin_tools: { web_search: { enabled: false } }
    }
  };
  const source = {
    id: sourceId,
    name: 'Mock Recoverable Retry Source',
    connectionType: 'openai_responses',
    baseUrl,
    apiKey: 'mock-key',
    apiKeyFilePath: ''
  };
  return {
    apiConfigs_chunk_0: JSON.stringify({ v: 2, items: [config], connectionSources: [source] }),
    apiConfigs_chunks_meta: { count: 1, updatedAt: Date.now() },
    selectedConfigIndex: 0,
    showThoughtProcess: true,
    queueCurrentConversationMessages: true,
    autoRetry: false,
    autoGenerateConversationTitle: false
  };
}

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function createMessageItem(id, text, status = 'completed') {
  return {
    id,
    type: 'message',
    role: 'assistant',
    phase: 'answer',
    status,
    content: [{ type: 'output_text', text }]
  };
}

function createFunctionCallItem() {
  return {
    id: `fc_${TOOL_CALL_ID}`,
    type: 'function_call',
    call_id: TOOL_CALL_ID,
    name: 'js_runtime_execute',
    arguments: JSON.stringify({
      code: "console.log('tool-retry-once'); return 'tool-retry-once-done';",
      timeout_ms: null,
      frame_ids: null
    }),
    status: 'completed'
  };
}

function collectUserInputTexts(requestBody) {
  const input = Array.isArray(requestBody?.input) ? requestBody.input : [];
  return input
    .filter((item) => item && item.type === 'message' && String(item.role || '').toLowerCase() === 'user')
    .map((item) => {
      if (typeof item.content === 'string') return item.content;
      if (!Array.isArray(item.content)) return '';
      return item.content
        .map((part) => {
          if (typeof part?.text === 'string') return part.text;
          if (typeof part?.input_text === 'string') return part.input_text;
          return '';
        })
        .filter(Boolean)
        .join('\n');
    });
}

function countToolOutputs(requestBody) {
  return (Array.isArray(requestBody?.input) ? requestBody.input : [])
    .filter((item) => item?.type === 'function_call_output' && item?.call_id === TOOL_CALL_ID)
    .length;
}

async function runMockServer() {
  const requestLog = [];
  const rawRequestLog = [];
  const pageHtml = '<!doctype html><html><body><main><h1>Responses retry regression host</h1></main></body></html>';

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end(pageHtml);
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/responses') {
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', async () => {
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: { message: `invalid json: ${error.message}` } }));
          return;
        }

        requestLog.push(parsed);
        rawRequestLog.push(body);
        const userTexts = collectUserInputTexts(parsed);
        const latestUserText = userTexts.at(-1) || '';
        const isFinalInterruptScenario = latestUserText.includes(FINAL_INTERRUPT_PROMPT);
        const isNonStreamRetryScenario = latestUserText.includes(NON_STREAM_RETRY_PROMPT);
        const toolOutputCount = countToolOutputs(parsed);

        if (isNonStreamRetryScenario) {
          const nonStreamAttempt = requestLog.filter((requestBody) => {
            const texts = collectUserInputTexts(requestBody);
            return (texts.at(-1) || '').includes(NON_STREAM_RETRY_PROMPT);
          }).length;
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'access-control-allow-origin': '*'
          });
          if (nonStreamAttempt === 1) {
            res.end(JSON.stringify({
              id: 'resp_non_stream_failed',
              object: 'response',
              status: 'failed',
              error: { code: 'server_overloaded', message: 'Non-stream capacity retry in 0.01s.' }
            }));
            return;
          }
          const nonStreamMessage = createMessageItem('msg_non_stream_success', NON_STREAM_RECOVERED_TEXT);
          res.end(JSON.stringify({
            id: 'resp_non_stream_success',
            object: 'response',
            status: 'completed',
            output: [nonStreamMessage],
            usage: { input_tokens: 35, output_tokens: 8, total_tokens: 43 }
          }));
          return;
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'access-control-allow-origin': '*'
        });
        try { res.flushHeaders(); } catch (_) {}

        if (isFinalInterruptScenario) {
          const partialItem = createMessageItem('msg_partial_final', '', 'in_progress');
          writeSseEvent(res, { type: 'response.created', response: { id: 'resp_partial_final' } });
          writeSseEvent(res, { type: 'response.in_progress', response: { id: 'resp_partial_final' } });
          writeSseEvent(res, { type: 'response.output_item.added', item: partialItem });
          writeSseEvent(res, {
            type: 'response.output_text.delta',
            item_id: partialItem.id,
            output_item_id: partialItem.id,
            output_index: 0,
            content_index: 0,
            delta: PARTIAL_FINAL_TEXT
          });
          // final delta 已经完整写出后直接 EOF，但故意不发送 response.completed / [DONE]。
          // 这精确覆盖“final 已开始，SSE 提前结束”的保留边界。
          await sleep(120);
          res.end();
          return;
        }

        if (toolOutputCount === 0) {
          const functionCall = createFunctionCallItem();
          writeSseEvent(res, { type: 'response.created', response: { id: 'resp_tool_call' } });
          writeSseEvent(res, { type: 'response.in_progress', response: { id: 'resp_tool_call' } });
          writeSseEvent(res, { type: 'response.output_item.added', item: functionCall });
          writeSseEvent(res, { type: 'response.output_item.done', item: functionCall });
          writeSseEvent(res, {
            type: 'response.completed',
            response: {
              id: 'resp_tool_call',
              output: [functionCall],
              usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 }
            }
          });
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        const toolFollowUpAttempt = requestLog.filter((requestBody) => (
          !collectUserInputTexts(requestBody).some((text) => text.includes(FINAL_INTERRUPT_PROMPT))
          && countToolOutputs(requestBody) === 1
        )).length;
        if (toolFollowUpAttempt === 1) {
          writeSseEvent(res, {
            type: 'response.failed',
            response: {
              id: 'resp_retryable_failure',
              status: 'failed',
              error: { code: 'server_overloaded', message: RETRY_DETAIL }
            }
          });
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        if (toolFollowUpAttempt === 2) {
          // 模拟最典型的半包 SSE：连接在 JSON event 中途 EOF。
          // 先发送两段 reasoning 以制造一个待执行的节流更新；回滚时必须取消旧 timer，
          // final 尚未开始时再把解析失败当作可恢复流错误，并精确重发同一请求。
          writeSseEvent(res, { type: 'response.created', response: { id: 'resp_truncated_json' } });
          writeSseEvent(res, {
            type: 'response.reasoning_summary_text.delta',
            item_id: 'reasoning_failed_hop',
            delta: FAILED_HOP_REASONING_TEXT
          });
          writeSseEvent(res, {
            type: 'response.reasoning_summary_text.delta',
            item_id: 'reasoning_failed_hop',
            delta: '_SECOND_DELTA'
          });
          res.write('data: {"type":"response.in_progress","response":');
          res.end();
          return;
        }

        const messageItem = createMessageItem('msg_recovered_success', RECOVERED_TEXT);
        writeSseEvent(res, { type: 'response.created', response: { id: 'resp_recovered_success' } });
        writeSseEvent(res, { type: 'response.in_progress', response: { id: 'resp_recovered_success' } });
        writeSseEvent(res, { type: 'response.output_item.added', item: messageItem });
        writeSseEvent(res, {
          type: 'response.output_text.delta',
          item_id: messageItem.id,
          output_item_id: messageItem.id,
          output_index: 0,
          content_index: 0,
          delta: RECOVERED_TEXT
        });
        writeSseEvent(res, { type: 'response.output_item.done', item: messageItem });
        writeSseEvent(res, {
          type: 'response.completed',
          response: {
            id: 'resp_recovered_success',
            output: [messageItem],
            usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 }
          }
        });
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  const port = await getFreePort();
  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', (error) => error ? reject(error) : resolve());
  });

  return {
    origin: `http://127.0.0.1:${port}`,
    requestLog,
    rawRequestLog,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

async function readDomSnapshot(sidebarFrame) {
  return await sidebarFrame.evaluate(() => {
    const userMessages = Array.from(document.querySelectorAll('.message.user-message'));
    const aiMessages = Array.from(document.querySelectorAll('.message.ai-message'));
    const streamErrors = Array.from(document.querySelectorAll('.response-activity-entry--stream-error'));
    return {
      userCount: userMessages.length,
      aiCount: aiMessages.length,
      errorCount: document.querySelectorAll('.message.ai-message.error-message').length,
      retryButtonCount: document.querySelectorAll('.error-retry-btn').length,
      userTexts: userMessages.map((el) => el.querySelector('.text-content')?.innerText || ''),
      aiTexts: aiMessages.map((el) => el.querySelector('.text-content')?.innerText || ''),
      streamErrors: streamErrors.map((el) => ({
        text: el.querySelector('.response-activity-stream-error-text')?.innerText || '',
        details: el.querySelector('.response-activity-stream-error-details-text')?.innerText || '',
        open: el.querySelector('.response-activity-stream-error')?.open === true
      }))
    };
  });
}

async function expandStreamErrorDetails(messageLocator, expectedText) {
  const timeline = messageLocator.locator('.response-activity-timeline');
  if (await timeline.count()) {
    const expanded = await timeline.evaluate((element) => element.classList.contains('is-expanded'));
    if (!expanded) {
      await timeline.locator(':scope > .response-activity-panel-toggle').click();
    }
  }
  const entry = messageLocator.locator('.response-activity-entry--stream-error').filter({ hasText: expectedText }).last();
  await entry.locator('.response-activity-stream-error-summary').click();
  return await entry.locator('.response-activity-stream-error-details-text').innerText();
}

async function main() {
  await fsp.mkdir(outputDir, { recursive: true });
  const result = {
    startedAt: new Date().toISOString(),
    outputDir,
    launchMode,
    headless: runHeadless,
    steps: []
  };

  const mockServer = await runMockServer();
  result.mockOrigin = mockServer.origin;
  logProgress(`mock server ready at ${mockServer.origin}`);

  const profileDir = launchMode === 'worktree_unpacked'
    ? resolveWorktreeUnpackedProfileDir(repoRoot, 'responses-recoverable-stream-retry-regression')
    : resolveFixedSidebarProfileDir(repoRoot);
  if (launchMode === 'worktree_unpacked') {
    await fsp.rm(profileDir, { recursive: true, force: true });
    await fsp.mkdir(profileDir, { recursive: true });
  }
  result.profileDir = profileDir;

  let context = null;
  try {
    context = launchMode === 'worktree_unpacked'
      ? await launchWorktreeUnpackedChromiumContext({
        chromium,
        repoRoot,
        profileDir,
        headless: runHeadless
      })
      : await launchFixedSidebarContext({
        chromium,
        profileDir,
        executablePath: chromePath,
        headless: runHeadless
      });
    result.steps.push('browser_ready');
    logProgress(`${launchMode} browser ready`);

    const hostPage = context.pages()[0] || await context.newPage();
    hostPage.on('console', (msg) => {
      if (msg.type() === 'error') {
        result.console = result.console || [];
        result.console.push({ type: msg.type(), text: msg.text() });
      }
    });
    hostPage.on('pageerror', (error) => {
      result.console = result.console || [];
      result.console.push({ type: 'pageerror', text: String(error?.stack || error?.message || error) });
    });

    let extensionWorker = null;
    if (launchMode === 'worktree_unpacked') {
      await hostPage.goto(mockServer.origin, { waitUntil: 'domcontentloaded' });
      extensionWorker = await waitForWorktreeExtensionWorker(context, { timeoutMs: 30_000 });
    } else {
      extensionWorker = await reloadUnpackedExtension(context, {
        timeoutMs: 30_000,
        unpackedPath: repoRoot
      });
      await hostPage.goto(mockServer.origin, { waitUntil: 'domcontentloaded' });
    }
    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;
    result.steps.push('worker_ready');
    logProgress(`extension worker ready: ${extensionId}`);

    await extensionWorker.evaluate(async (seed) => {
      await chrome.storage.sync.clear();
      await chrome.storage.local.clear();
      await chrome.storage.sync.set(seed);
      return true;
    }, buildStorageSeed(`${mockServer.origin}/v1/responses`));
    result.steps.push('storage_seeded');

    await extensionWorker.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'OPEN_SIDEBAR' }))
    );
    await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      return payload?.response?.debugState?.isActuallyVisible ? payload.response.debugState : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: 'sidebar visible' });

    const sidebarFrame = await waitForSidebarFrame(hostPage, extensionId, { timeoutMs: 30_000 });
    await sidebarFrame.locator('body').waitFor({ state: 'visible', timeout: 30_000 });
    await waitFor(async () => {
      return await sidebarFrame.evaluate((expectedBaseUrl) => {
        const configs = Array.isArray(window.apiConfigs) ? window.apiConfigs : [];
        return configs.some((config) => config?.baseUrl === expectedBaseUrl) ? true : null;
      }, `${mockServer.origin}/v1/responses`);
    }, { timeoutMs: 20_000, intervalMs: 250, label: 'api config loaded' });
    result.steps.push('sidebar_ready');
    logProgress('embedded sidebar ready');

    await sidebarFrame.locator('#message-input').fill(TOOL_RETRY_PROMPT);
    await sidebarFrame.locator('#message-input').press('Enter');
    await waitFor(() => mockServer.requestLog.length >= 4 ? true : null, {
      timeoutMs: 30_000,
      intervalMs: 100,
      label: 'tool follow-up retry sequence'
    });
    assert.deepStrictEqual(mockServer.requestLog[2], mockServer.requestLog[1]);
    assert.deepStrictEqual(mockServer.requestLog[3], mockServer.requestLog[1]);
    assert.equal(mockServer.rawRequestLog[2], mockServer.rawRequestLog[1]);
    assert.equal(mockServer.rawRequestLog[3], mockServer.rawRequestLog[1]);
    assert.equal(countToolOutputs(mockServer.requestLog[1]), 1);
    assert.equal(countToolOutputs(mockServer.requestLog[2]), 1);
    assert.equal(countToolOutputs(mockServer.requestLog[3]), 1);
    result.steps.push('same_follow_up_request_replayed');
    logProgress('tool follow-up retried with identical request body');

    const recoveredMessage = sidebarFrame.locator('.message.ai-message').filter({ hasText: RECOVERED_TEXT }).last();
    await waitFor(async () => {
      const snapshot = await readDomSnapshot(sidebarFrame);
      return (
        snapshot.userCount === 1
        && snapshot.aiCount === 1
        && snapshot.errorCount === 0
        && snapshot.retryButtonCount === 0
        && snapshot.aiTexts.some((text) => text.includes(RECOVERED_TEXT))
        && snapshot.streamErrors.some((entry) => entry.text.includes('1/10'))
        && snapshot.streamErrors.some((entry) => entry.text.includes('2/10'))
      ) ? snapshot : null;
    }, { timeoutMs: 25_000, intervalMs: 200, label: 'handled retry success UI' });
    const recoveredDetails = await expandStreamErrorDetails(recoveredMessage, '1/10');
    assert.equal(recoveredDetails, DISPLAYED_RETRY_DETAIL);
    result.recoveredDetails = recoveredDetails;
    const truncatedJsonDetails = await expandStreamErrorDetails(recoveredMessage, '2/10');
    assert.match(truncatedJsonDetails, /流式事件解析失败/);
    assert.equal((await recoveredMessage.innerText()).includes(FAILED_HOP_REASONING_TEXT), false);
    result.truncatedJsonDetails = truncatedJsonDetails;
    result.failedHopReasoningRolledBack = true;
    await sidebarFrame.locator('body').screenshot({
      path: path.join(outputDir, 'sidebar-after-handled-retry.png')
    });
    result.steps.push('handled_retry_ui_verified');
    logProgress('handled stream error detail verified');

    const requestCountBeforeNonStreamRetry = mockServer.requestLog.length;
    await sidebarFrame.locator('#message-input').fill(NON_STREAM_RETRY_PROMPT);
    await sidebarFrame.locator('#message-input').press('Enter');
    await waitFor(() => mockServer.requestLog.length >= requestCountBeforeNonStreamRetry + 2 ? true : null, {
      timeoutMs: 20_000,
      intervalMs: 100,
      label: 'non-stream Responses retry sequence'
    });
    const nonStreamFailedRequest = mockServer.requestLog[requestCountBeforeNonStreamRetry];
    const nonStreamRetryRequest = mockServer.requestLog[requestCountBeforeNonStreamRetry + 1];
    assert.deepStrictEqual(nonStreamRetryRequest, nonStreamFailedRequest);
    assert.equal(
      mockServer.rawRequestLog[requestCountBeforeNonStreamRetry + 1],
      mockServer.rawRequestLog[requestCountBeforeNonStreamRetry]
    );
    const nonStreamRecoveredMessage = sidebarFrame.locator('.message.ai-message').filter({ hasText: NON_STREAM_RECOVERED_TEXT }).last();
    await waitFor(async () => {
      const snapshot = await readDomSnapshot(sidebarFrame);
      return (
        snapshot.errorCount === 0
        && snapshot.retryButtonCount === 0
        && snapshot.aiTexts.some((text) => text.includes(NON_STREAM_RECOVERED_TEXT))
      ) ? snapshot : null;
    }, { timeoutMs: 20_000, intervalMs: 150, label: 'non-stream Responses retry success UI' });
    const nonStreamRetryDetails = await expandStreamErrorDetails(nonStreamRecoveredMessage, '1/10');
    assert.match(nonStreamRetryDetails, /Non-stream capacity retry in 0\.01s\./);
    result.nonStreamRetryDetails = nonStreamRetryDetails;
    result.steps.push('non_stream_retry_ui_verified');
    logProgress('non-stream Responses failure retried with identical request body');

    const requestCountBeforeFinalInterrupt = mockServer.requestLog.length;
    await sidebarFrame.locator('#message-input').fill(FINAL_INTERRUPT_PROMPT);
    await sidebarFrame.locator('#message-input').press('Enter');
    try {
      await waitFor(() => mockServer.requestLog.length >= requestCountBeforeFinalInterrupt + 1 ? true : null, {
        timeoutMs: 20_000,
        intervalMs: 100,
        label: 'final interruption request observed'
      });
    } catch (error) {
      result.finalInterruptDebug = {
        requestCount: mockServer.requestLog.length,
        dom: await readDomSnapshot(sidebarFrame)
      };
      await fsp.writeFile(
        path.join(outputDir, 'debug-before-final-interrupt-timeout.json'),
        JSON.stringify(result, null, 2),
        'utf8'
      );
      throw error;
    }
    logProgress('final interruption request observed');
    try {
      await waitFor(async () => {
        const snapshot = await readDomSnapshot(sidebarFrame);
        return snapshot.aiTexts.some((text) => text.includes(PARTIAL_FINAL_TEXT)) ? snapshot : null;
      }, { timeoutMs: 30_000, intervalMs: 150, label: 'partial final visible' });
    } catch (error) {
      result.partialFinalDebug = {
        requestUserTexts: mockServer.requestLog.map((requestBody) => collectUserInputTexts(requestBody)),
        requestToolOutputCounts: mockServer.requestLog.map((requestBody) => countToolOutputs(requestBody)),
        dom: await readDomSnapshot(sidebarFrame)
      };
      await fsp.writeFile(
        path.join(outputDir, 'debug-partial-final-timeout.json'),
        JSON.stringify(result, null, 2),
        'utf8'
      );
      throw error;
    }
    const requestCountAfterFinalInterrupt = mockServer.requestLog.length;
    await sleep(1_200);
    assert.equal(mockServer.requestLog.length, requestCountAfterFinalInterrupt);

    const partialMessage = sidebarFrame.locator('.message.ai-message').filter({ hasText: PARTIAL_FINAL_TEXT }).last();
    const finalSnapshot = await waitFor(async () => {
      const snapshot = await readDomSnapshot(sidebarFrame);
      const lastAiText = snapshot.aiTexts.at(-1) || '';
      const hasStoppedEntry = snapshot.streamErrors.some((entry) => entry.text.includes('已保留当前回答'));
      return (
        lastAiText.includes(PARTIAL_FINAL_TEXT)
        && snapshot.errorCount === 0
        && snapshot.retryButtonCount === 0
        && hasStoppedEntry
      ) ? snapshot : null;
    }, { timeoutMs: 20_000, intervalMs: 200, label: 'partial final preserved without retry' });
    result.finalSnapshot = finalSnapshot;
    result.finalInterruptionDetails = await expandStreamErrorDetails(partialMessage, '已保留当前回答');
    await sidebarFrame.locator('body').screenshot({
      path: path.join(outputDir, 'sidebar-after-partial-final-interruption.png')
    });
    result.steps.push('partial_final_preserved_without_retry');
    logProgress('partial final preserved and retry stopped');

    result.requestCount = mockServer.requestLog.length;
    result.requestBodiesEqual = true;
    result.toolOutputCountInFailedFollowUp = countToolOutputs(mockServer.requestLog[1]);
    result.toolOutputCountInRetryFollowUps = [
      countToolOutputs(mockServer.requestLog[2]),
      countToolOutputs(mockServer.requestLog[3])
    ];
    result.nonStreamRequestBodiesEqual = true;
    result.completedAt = new Date().toISOString();
    await fsp.writeFile(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    logProgress('regression completed');
  } finally {
    if (context) await context.close().catch(() => {});
    await mockServer.close().catch(() => {});
  }
}

main().catch(async (error) => {
  const failure = {
    ok: false,
    error: String(error?.stack || error?.message || error)
  };
  try {
    await fsp.mkdir(outputDir, { recursive: true });
    await fsp.writeFile(path.join(outputDir, 'failure.json'), JSON.stringify(failure, null, 2), 'utf8');
  } catch (_) {}
  console.error(error);
  process.exitCode = 1;
});
