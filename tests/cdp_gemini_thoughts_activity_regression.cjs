const fs = require('fs/promises');
const http = require('http');
const net = require('net');
const path = require('path');
const {
  buildSendContentMessageExpression,
  launchWorktreeUnpackedChromiumContext,
  loadPlaywright,
  resolveWorktreeUnpackedProfileDir,
  shouldRunHeadless,
  waitFor,
  waitForSidebarFrame,
  waitForWorktreeExtensionWorker
} = require('./lib/worktree_unpacked_extension_harness.cjs');

const [repoRoot, outputDir] = process.argv.slice(2);

if (!repoRoot || !outputDir) {
  throw new Error(
    'Usage: node tests/cdp_gemini_thoughts_activity_regression.cjs <repoRoot> <outputDir>'
  );
}

const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);
const FINAL_ANSWER_TEXT = 'GEMINI_THOUGHT_ACTIVITY_FINAL_20260530';
const FIRST_THOUGHT_MARKER = 'GEMINI_THOUGHT_ACTIVITY_CHUNK_0';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
    server.on('error', reject);
  });
}

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function readRequestBody(req) {
  return await new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

async function runMockGeminiServer() {
  const requestLog = [];
  const thoughtChunks = Array.from({ length: 10 }, (_, index) => (
    `GEMINI_THOUGHT_ACTIVITY_CHUNK_${index}: 这是一段只属于普通 Gemini thought=true 的流式思考内容，用来观察 pulse 是否会隐藏统一 activity 面板。\n`
  ));

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || !req.url.includes(':streamGenerateContent')) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }

      requestLog.push({
        url: req.url,
        body: await readRequestBody(req)
      });

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive'
      });

      for (const chunk of thoughtChunks) {
        writeSseEvent(res, {
          candidates: [{
            content: {
              parts: [{
                text: chunk,
                thought: true
              }]
            }
          }]
        });
        await sleep(110);
      }

      // 保留一个只更新思考、尚无正文的观察窗口，覆盖 loadingStatusPulse 的多次 tick。
      await sleep(1000);

      writeSseEvent(res, {
        candidates: [{
          content: {
            parts: [{
              text: FINAL_ANSWER_TEXT
            }]
          },
          finishReason: 'STOP'
        }]
      });
      res.end();
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });

  const port = await getFreePort();
  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', (error) => error ? reject(error) : resolve());
  });

  return {
    origin: `http://127.0.0.1:${port}`,
    requestLog,
    thoughtText: thoughtChunks.join(''),
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

function buildStorageSeed(baseUrl) {
  const sourceId = 'src_gemini_thought_activity_regression';
  const config = {
    id: 'cfg_gemini_thought_activity_regression',
    connectionSourceId: sourceId,
    displayName: 'Gemini Thought Activity Regression',
    modelName: 'gemini-thought-activity-regression',
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
    userMessagePreprocessorIncludeInHistory: false
  };
  const source = {
    id: sourceId,
    name: 'Mock Gemini Source',
    connectionType: 'gemini',
    baseUrl,
    apiKey: 'mock-gemini-key',
    apiKeyFilePath: ''
  };

  return {
    apiConfigs_chunk_0: JSON.stringify({
      v: 2,
      items: [config],
      connectionSources: [source]
    }),
    apiConfigs_chunks_meta: { count: 1, updatedAt: Date.now() },
    selectedConfigIndex: 0,
    showThoughtProcess: true,
    queueCurrentConversationMessages: true,
    autoGenerateConversationTitle: false
  };
}

async function readGeminiThoughtUiState(sidebarFrame) {
  return await sidebarFrame.evaluate((firstMarker) => {
    const aiMessages = Array.from(document.querySelectorAll('.message.ai-message'));
    const latest = aiMessages[aiMessages.length - 1] || null;
    const timeline = latest?.querySelector?.('.response-activity-timeline') || null;
    const bodyText = timeline?.querySelector?.('.response-activity-panel-body-inner')?.innerText || '';
    const panelStatusText = timeline?.querySelector?.('.response-activity-panel-status__text')?.innerText || '';
    const textContent = latest?.querySelector?.('.text-content')?.innerText || '';
    return {
      hasAiMessage: !!latest,
      className: latest?.className || '',
      hasTimeline: !!timeline,
      hasLegacyThoughts: !!latest?.querySelector?.('.thoughts-content'),
      hasPreResponseStatus: !!latest?.querySelector?.('.assistant-pre-response-status'),
      hasPreResponseClass: !!latest?.classList?.contains('assistant-pre-response'),
      panelExpanded: !!timeline?.classList?.contains('is-expanded'),
      panelPeek: !!timeline?.classList?.contains('is-peek'),
      panelStatusText,
      bodyText,
      textContent,
      containsFirstMarker: bodyText.includes(firstMarker),
      containsFinalAnswer: textContent.includes('GEMINI_THOUGHT_ACTIVITY_FINAL_20260530')
    };
  }, FIRST_THOUGHT_MARKER);
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const result = {
    startedAt: new Date().toISOString(),
    outputDir,
    headless: runHeadless,
    steps: [],
    console: []
  };

  const mockServer = await runMockGeminiServer();
  result.mockOrigin = mockServer.origin;

  let context = null;
  let page = null;

  try {
    const profileDir = resolveWorktreeUnpackedProfileDir(repoRoot, 'gemini-thought-activity-regression');
    result.profileDir = profileDir;
    await fs.mkdir(profileDir, { recursive: true });

    context = await launchWorktreeUnpackedChromiumContext({
      chromium,
      repoRoot,
      profileDir,
      headless: runHeadless
    });
    result.steps.push('browser_ready');

    const extensionWorker = await waitForWorktreeExtensionWorker(context, { timeoutMs: 30_000 });
    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;
    result.steps.push('background_ready');

    await extensionWorker.evaluate(`(async () => {
      await chrome.storage.sync.clear();
      await chrome.storage.local.clear();
      await chrome.storage.sync.set(${JSON.stringify(buildStorageSeed(mockServer.origin))});
      return true;
    })()`);
    result.steps.push('storage_seeded');

    page = context.pages().find((entry) => entry.url().startsWith('https://example.com/')) || await context.newPage();
    page.on('console', (msg) => {
      result.console.push({ type: msg.type(), text: msg.text() });
    });
    page.on('pageerror', (error) => {
      result.console.push({ type: 'pageerror', text: String(error && (error.stack || error.message || error)) });
    });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    result.steps.push('page_loaded');

    await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      return payload?.response?.debugState?.initialized ? payload : null;
    }, { timeoutMs: 15_000, intervalMs: 250, label: 'sidebar initialized before open' });
    result.steps.push('sidebar_initialized');

    const openSidebarResponse = await extensionWorker.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'OPEN_SIDEBAR' }))
    );
    result.openSidebarResponse = openSidebarResponse;
    if (!openSidebarResponse?.response?.success || openSidebarResponse?.response?.status !== true) {
      throw new Error(`OPEN_SIDEBAR did not report visible=true: ${JSON.stringify(openSidebarResponse)}`);
    }
    result.steps.push('sidebar_open_requested');

    const sidebarFrame = await waitForSidebarFrame(page, extensionId, { timeoutMs: 30_000 });
    await sidebarFrame.locator('#message-input').waitFor({ state: 'visible', timeout: 30_000 });
    result.steps.push('sidebar_frame_ready');

    result.apiConfigState = await waitFor(async () => {
      return await sidebarFrame.evaluate(() => {
        const configs = Array.isArray(window.apiConfigs) ? window.apiConfigs : [];
        const first = configs[0] || null;
        if (!first || first.connectionType !== 'gemini') return null;
        return {
          count: configs.length,
          baseUrl: first.baseUrl,
          modelName: first.modelName || '',
          connectionType: first.connectionType || ''
        };
      });
    }, { timeoutMs: 15_000, intervalMs: 250, label: 'sidebar gemini api config ready' });
    result.steps.push('api_config_ready');

    await sidebarFrame.locator('#message-input').fill('请先输出一段思考，再给出一句结论。');
    await sidebarFrame.locator('#message-input').press('Enter');
    result.steps.push('prompt_sent');

    await waitFor(async () => (
      mockServer.requestLog.length >= 1 ? mockServer.requestLog.length : null
    ), { timeoutMs: 10_000, intervalMs: 100, label: 'mock Gemini request observed' });
    result.steps.push('mock_request_observed');

    result.initialThoughtState = await waitFor(async () => {
      const state = await readGeminiThoughtUiState(sidebarFrame);
      return state.hasTimeline && state.containsFirstMarker && !state.containsFinalAnswer ? state : null;
    }, { timeoutMs: 10_000, intervalMs: 60, label: 'Gemini thoughts rendered in activity panel before answer' });
    result.steps.push('initial_thought_state_seen');

    const samples = [];
    const sampleUntil = Date.now() + 850;
    while (Date.now() < sampleUntil) {
      samples.push(await readGeminiThoughtUiState(sidebarFrame));
      await sleep(40);
    }
    result.thoughtWindowSamples = samples;
    result.badThoughtWindowSamples = samples.filter((sample) => (
      !sample.hasTimeline
      || sample.hasLegacyThoughts
      || sample.hasPreResponseClass
      || sample.hasPreResponseStatus
      || !sample.containsFirstMarker
      || sample.containsFinalAnswer
    ));
    if (result.badThoughtWindowSamples.length > 0) {
      throw new Error(`Gemini thoughts activity panel was unstable during pre-answer window: ${JSON.stringify(result.badThoughtWindowSamples.slice(0, 3))}`);
    }
    result.steps.push('pre_answer_thought_window_stable');

    result.finalState = await waitFor(async () => {
      const state = await readGeminiThoughtUiState(sidebarFrame);
      return state.containsFinalAnswer ? state : null;
    }, { timeoutMs: 10_000, intervalMs: 100, label: 'Gemini final answer visible' });
    result.steps.push('final_answer_seen');

    const screenshotPath = path.join(outputDir, 'gemini-thought-activity-body.png');
    await sidebarFrame.locator('body').screenshot({ path: screenshotPath });
    result.screenshotPath = screenshotPath;
  } finally {
    await fs.writeFile(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    if (context) {
      await context.close().catch(() => {});
    }
    await mockServer.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
