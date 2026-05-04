const fsp = require('fs/promises');
const http = require('http');
const net = require('net');
const path = require('path');
const {
  buildSendContentMessageExpression,
  launchWorktreeUnpackedChromiumContext,
  loadPlaywright,
  shouldRunHeadless,
  waitFor,
  waitForSidebarFrame,
  waitForWorktreeExtensionWorker
} = require('./lib/worktree_unpacked_extension_harness.cjs');

const [rawRepoRoot, outputDir] = process.argv.slice(2);
const repoRoot = rawRepoRoot ? path.resolve(rawRepoRoot) : '';

if (!repoRoot || !outputDir) {
  throw new Error('Usage: node tests/cdp_retry_failed_user_message_regression.cjs <repoRoot> <outputDir>');
}

const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const sourceId = 'src_retry_failed_user_message_regression';
  const config = {
    id: 'cfg_retry_failed_user_message_regression',
    connectionSourceId: sourceId,
    displayName: 'Retry Failed User Message Regression',
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
    name: 'Mock Retry Source',
    connectionType: 'openai_responses',
    baseUrl,
    apiKey: 'mock-key',
    apiKeyFilePath: ''
  };
  return {
    apiConfigs_chunk_0: JSON.stringify({ v: 2, items: [config], connectionSources: [source] }),
    apiConfigs_chunks_meta: { count: 1, updatedAt: Date.now() },
    selectedConfigIndex: 0,
    queueCurrentConversationMessages: true,
    autoRetry: false,
    autoGenerateConversationTitle: false
  };
}

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function createMessageItem(id, text) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    phase: 'answer',
    status: 'completed',
    content: [{ type: 'output_text', text }]
  };
}

function collectUserInputTexts(requestBody) {
  const input = Array.isArray(requestBody?.input) ? requestBody.input : [];
  return input
    .filter((item) => (
      item
      && item.type === 'message'
      && String(item.role || '').toLowerCase() === 'user'
    ))
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

async function runMockServer() {
  const requestLog = [];
  const failureText = 'MOCK_RETRY_FAILURE_20260505';
  const successText = 'MOCK_RETRY_SUCCESS_20260505';
  const pageHtml = '<!doctype html><html><body><main><h1>Retry regression host</h1></main></body></html>';

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
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'access-control-allow-origin': '*'
        });
        try { res.flushHeaders(); } catch (_) {}

        if (requestLog.length === 1) {
          writeSseEvent(res, {
            type: 'response.error',
            error: {
              code: 'mock_retry_failure',
              message: failureText
            }
          });
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        const messageItem = createMessageItem('msg_retry_success', successText);
        writeSseEvent(res, { type: 'response.created', response: { id: 'resp_retry_success' } });
        writeSseEvent(res, { type: 'response.in_progress', response: { id: 'resp_retry_success' } });
        await sleep(80);
        writeSseEvent(res, { type: 'response.output_item.added', item: messageItem });
        writeSseEvent(res, {
          type: 'response.output_text.delta',
          item_id: 'msg_retry_success',
          output_item_id: 'msg_retry_success',
          output_index: 0,
          content_index: 0,
          delta: successText
        });
        writeSseEvent(res, {
          type: 'response.output_text.done',
          item_id: 'msg_retry_success',
          output_item_id: 'msg_retry_success',
          output_index: 0,
          content_index: 0,
          text: successText
        });
        writeSseEvent(res, { type: 'response.output_item.done', item: messageItem });
        writeSseEvent(res, {
          type: 'response.completed',
          response: {
            id: 'resp_retry_success',
            output: [messageItem],
            usage: {
              input_tokens: 30,
              output_tokens: 12,
              total_tokens: 42,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 }
            }
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
    failureText,
    successText,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

async function readRetryDomSnapshot(sidebarFrame) {
  return await sidebarFrame.evaluate(() => {
    const queueItems = Array.from(document.querySelectorAll('.conversation-send-queue-preview__item'));
    const userMessages = Array.from(document.querySelectorAll('.message.user-message'));
    const aiMessages = Array.from(document.querySelectorAll('.message.ai-message'));
    return {
      userCount: userMessages.length,
      aiCount: aiMessages.length,
      errorCount: document.querySelectorAll('.message.ai-message.error-message').length,
      retryButtonCount: document.querySelectorAll('.error-retry-btn').length,
      queueItemCount: queueItems.length,
      failedQueueItemCount: queueItems.filter((item) => item.classList.contains('conversation-send-queue-preview__item--failed')).length,
      userTexts: userMessages.map((el) => el.querySelector('.text-content')?.innerText || ''),
      aiTexts: aiMessages.map((el) => el.querySelector('.text-content')?.innerText || ''),
      aiClasses: aiMessages.map((el) => el.className || '')
    };
  });
}

async function main() {
  await fsp.mkdir(outputDir, { recursive: true });
  const result = {
    startedAt: new Date().toISOString(),
    outputDir,
    launchMode: 'worktree_unpacked',
    headless: runHeadless,
    steps: []
  };
  const promptText = 'retry failed user message baseline';

  const mockServer = await runMockServer();
  result.mockOrigin = mockServer.origin;

  const profileDir = path.join(outputDir, 'profile');
  await fsp.mkdir(profileDir, { recursive: true });
  result.profileDir = profileDir;

  let context = null;
  try {
    context = await launchWorktreeUnpackedChromiumContext({
      chromium,
      repoRoot,
      profileDir,
      headless: runHeadless
    });
    result.steps.push('browser_ready');

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

    await hostPage.goto(mockServer.origin, { waitUntil: 'domcontentloaded' });
    result.steps.push('host_page_ready');

    const extensionWorker = await waitForWorktreeExtensionWorker(context, { timeoutMs: 30_000 });
    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;
    result.steps.push('worker_ready');

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
    result.steps.push('sidebar_visible');

    const sidebarFrame = await waitForSidebarFrame(hostPage, extensionId, { timeoutMs: 30_000 });
    await sidebarFrame.locator('body').waitFor({ state: 'visible', timeout: 30_000 });
    await waitFor(async () => {
      return await sidebarFrame.evaluate((expectedBaseUrl) => {
        const configs = Array.isArray(window.apiConfigs) ? window.apiConfigs : [];
        return configs.some((config) => config?.baseUrl === expectedBaseUrl) ? true : null;
      }, `${mockServer.origin}/v1/responses`);
    }, { timeoutMs: 20_000, intervalMs: 250, label: 'api config loaded' });
    result.steps.push('sidebar_ready');

    await sidebarFrame.locator('#message-input').fill(promptText);
    await sidebarFrame.locator('#message-input').press('Enter');
    result.steps.push('first_message_sent');

    await waitFor(() => mockServer.requestLog.length >= 1 ? true : null, {
      timeoutMs: 15_000,
      intervalMs: 100,
      label: 'first failed request observed'
    });
    result.steps.push('first_request_observed');

    result.afterFailure = await waitFor(async () => {
      const snapshot = await readRetryDomSnapshot(sidebarFrame);
      const hasFailureText = snapshot.aiTexts.some((text) => text.includes(mockServer.failureText));
      return (
        snapshot.userCount === 1
        && snapshot.errorCount === 1
        && snapshot.retryButtonCount === 1
        && snapshot.queueItemCount === 0
        && snapshot.failedQueueItemCount === 0
        && hasFailureText
      ) ? snapshot : null;
    }, { timeoutMs: 20_000, intervalMs: 200, label: 'single error bubble without failed queue item' });
    result.steps.push('failure_ui_verified');

    await sidebarFrame.locator('.error-retry-btn').click();
    result.steps.push('retry_clicked');
    await sleep(500);
    result.afterRetryClick = await readRetryDomSnapshot(sidebarFrame);
    result.afterRetryClickActiveAttempts = await sidebarFrame.evaluate(() => {
      const sender = window.cerebr?.debug?.messageSender;
      return typeof sender?.__debugGetActiveAttemptsSnapshot === 'function'
        ? sender.__debugGetActiveAttemptsSnapshot()
        : [];
    }).catch((error) => ({ error: String(error?.message || error) }));
    await fsp.writeFile(path.join(outputDir, 'partial-before-retry-wait.json'), JSON.stringify(result, null, 2), 'utf8');

    await waitFor(() => mockServer.requestLog.length >= 2 ? true : null, {
      timeoutMs: 20_000,
      intervalMs: 100,
      label: 'retry request observed'
    });
    result.steps.push('retry_request_observed');

    result.afterRetry = await waitFor(async () => {
      const snapshot = await readRetryDomSnapshot(sidebarFrame);
      const hasSuccessText = snapshot.aiTexts.some((text) => text.includes(mockServer.successText));
      return (
        snapshot.userCount === 1
        && snapshot.aiCount === 1
        && snapshot.errorCount === 0
        && snapshot.retryButtonCount === 0
        && snapshot.queueItemCount === 0
        && hasSuccessText
      ) ? snapshot : null;
    }, { timeoutMs: 25_000, intervalMs: 200, label: 'retry success without duplicate user message' });
    result.steps.push('retry_ui_verified');

    result.requestUserInputTexts = mockServer.requestLog.map((body) => collectUserInputTexts(body));
    result.promptTextOccurrencesInRetryRequest = result.requestUserInputTexts[1]
      .filter((text) => text.includes(promptText)).length;
    if (result.promptTextOccurrencesInRetryRequest !== 1) {
      await fsp.writeFile(path.join(outputDir, 'failed-request-shape.json'), JSON.stringify(result, null, 2), 'utf8');
      throw new Error(`retry request should contain the visible user prompt exactly once, got ${result.promptTextOccurrencesInRetryRequest}`);
    }
    result.steps.push('retry_request_shape_verified');

    await sidebarFrame.locator('body').screenshot({
      path: path.join(outputDir, 'sidebar-after-retry.png')
    });
    result.steps.push('screenshot_saved');

    await fsp.writeFile(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
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
