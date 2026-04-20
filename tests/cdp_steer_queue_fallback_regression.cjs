const fsp = require('fs/promises');
const http = require('http');
const net = require('net');
const path = require('path');
const {
  buildSendContentMessageExpression,
  launchFixedSidebarContext,
  loadPlaywright,
  resolveFixedSidebarProfileDir,
  shouldRunHeadless,
  sleep,
  waitFor,
  waitForExtensionWorker,
  waitForSidebarFrame
} = require('./lib/stable_chrome_sidebar_harness.cjs');

const [repoRoot, outputDir, chromePath] = process.argv.slice(2);

if (!repoRoot || !outputDir || !chromePath) {
  throw new Error(
    'Usage: node tests/cdp_steer_queue_fallback_regression.cjs <repoRoot> <outputDir> <chromePath>'
  );
}

const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);
const STEER_TEXT = 'STEER_QUEUE_FALLBACK_OK_20260412';
const FINAL_TEXT = 'STEER_QUEUE_FALLBACK_APPLIED_20260412';

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

function buildStorageSeed(baseUrl) {
  const sourceId = 'src_steer_queue_fallback_regression';
  const config = {
    id: 'cfg_steer_queue_fallback_regression',
    connectionSourceId: sourceId,
    displayName: 'Steer Queue Fallback Regression',
    modelName: 'gpt-5.4-mini',
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
      reasoning: {
        effort: 'medium',
        generate_summary: 'concise',
        summary: 'concise'
      },
      text: {
        verbosity: 'low'
      },
      parallel_tool_calls: true,
      store: false,
      builtin_tools: {
        web_search: {
          enabled: false
        }
      }
    }
  };
  const source = {
    id: sourceId,
    name: 'Mock Responses Source',
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
    autoGenerateConversationTitle: false
  };
}

function createMessageItem(id, text) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    phase: 'answer',
    status: 'completed',
    content: [
      {
        type: 'output_text',
        text
      }
    ]
  };
}

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function runMockResponsesServer() {
  const requestLog = [];
  const pageHtml = '<!doctype html><html lang="en"><body><main><h1>Steer queue fallback regression</h1></main></body></html>';

  const server = http.createServer((req, res) => {
    try {
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
          const parsed = JSON.parse(body || '{}');
          requestLog.push(parsed);
          const inputItems = Array.isArray(parsed?.input) ? parsed.input : [];
          const textBlob = JSON.stringify(inputItems);
          const hasSteer = textBlob.includes(STEER_TEXT);

          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
            'access-control-allow-origin': '*'
          });

          if (!hasSteer) {
            const firstText = 'FIRST_TURN_STREAM_20260412';
            const messageItem = createMessageItem('msg_first', firstText);
            writeSseEvent(res, { type: 'response.created', response: { id: 'resp_first' } });
            writeSseEvent(res, { type: 'response.in_progress', response: { id: 'resp_first' } });
            writeSseEvent(res, { type: 'response.output_item.added', item: messageItem });
            for (const delta of ['FIRST_', 'TURN_', 'STREAM_', '20260412']) {
              writeSseEvent(res, {
                type: 'response.output_text.delta',
                item_id: 'msg_first',
                output_item_id: 'msg_first',
                output_index: 0,
                content_index: 0,
                delta
              });
              await sleep(650);
            }
            writeSseEvent(res, {
              type: 'response.output_text.done',
              item_id: 'msg_first',
              output_item_id: 'msg_first',
              output_index: 0,
              content_index: 0,
              text: firstText
            });
            writeSseEvent(res, { type: 'response.output_item.done', item: messageItem });
            writeSseEvent(res, {
              type: 'response.completed',
              response: {
                id: 'resp_first',
                output: [messageItem],
                usage: {
                  input_tokens: 60,
                  output_tokens: 20,
                  total_tokens: 80,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens_details: { reasoning_tokens: 0 }
                }
              }
            });
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }

          const messageItem = createMessageItem('msg_second', FINAL_TEXT);
          writeSseEvent(res, { type: 'response.created', response: { id: 'resp_second' } });
          writeSseEvent(res, { type: 'response.in_progress', response: { id: 'resp_second' } });
          writeSseEvent(res, { type: 'response.output_item.added', item: messageItem });
          writeSseEvent(res, {
            type: 'response.output_text.delta',
            item_id: 'msg_second',
            output_item_id: 'msg_second',
            output_index: 0,
            content_index: 0,
            delta: FINAL_TEXT
          });
          writeSseEvent(res, {
            type: 'response.output_text.done',
            item_id: 'msg_second',
            output_item_id: 'msg_second',
            output_index: 0,
            content_index: 0,
            text: FINAL_TEXT
          });
          writeSseEvent(res, { type: 'response.output_item.done', item: messageItem });
          writeSseEvent(res, {
            type: 'response.completed',
            response: {
              id: 'resp_second',
              output: [messageItem],
              usage: {
                input_tokens: 70,
                output_tokens: 20,
                total_tokens: 90,
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
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

async function main() {
  await fsp.mkdir(outputDir, { recursive: true });
  const result = {
    startedAt: new Date().toISOString(),
    outputDir,
    console: [],
    steps: []
  };

  const mockServer = await runMockResponsesServer();
  result.mockOrigin = mockServer.origin;

  let context = null;
  try {
    const profileDir = path.join(outputDir, 'profile');
    const seedProfileDir = resolveFixedSidebarProfileDir(repoRoot);
    if (await fsp.stat(seedProfileDir).then(() => true).catch(() => false)) {
      await fsp.cp(seedProfileDir, profileDir, { recursive: true, force: true });
      result.seedProfileDir = seedProfileDir;
    } else {
      await fsp.mkdir(profileDir, { recursive: true });
    }
    result.profileDir = profileDir;

    context = await launchFixedSidebarContext({
      chromium,
      profileDir,
      executablePath: chromePath,
      headless: runHeadless
    });
    result.steps.push('browser_ready');

    const extensionWorker = await waitForExtensionWorker(context, { timeoutMs: 30_000 });
    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;
    result.steps.push('extension_id_resolved');

    await extensionWorker.evaluate(`(async () => {
      await chrome.storage.sync.clear();
      await chrome.storage.local.clear();
      await chrome.storage.sync.set(${JSON.stringify(buildStorageSeed(`${mockServer.origin}/v1/responses`))});
      return true;
    })()`);
    result.steps.push('storage_seeded');

    const hostPage = context.pages().find((page) => page.url().startsWith('https://example.com/')) || await context.newPage();
    hostPage.on('console', (msg) => {
      result.console.push({ type: msg.type(), text: msg.text() });
    });
    hostPage.on('pageerror', (error) => {
      result.console.push({ type: 'pageerror', text: String(error && (error.stack || error.message || error)) });
    });
    await hostPage.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await hostPage.bringToFront();
    result.steps.push('host_page_ready');

    await extensionWorker.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'OPEN_SIDEBAR' }))
    );
    result.steps.push('sidebar_open_requested');

    const sidebarFrame = await waitForSidebarFrame(hostPage, extensionId, { timeoutMs: 30_000 });
    await sidebarFrame.locator('#message-input').waitFor({ state: 'visible', timeout: 30_000 });
    result.steps.push('sidebar_ready');

    async function fillSidebarInput(text) {
      const input = sidebarFrame.locator('#message-input');
      await input.focus();
      await hostPage.keyboard.press('Control+A');
      await hostPage.keyboard.press('Backspace');
      await hostPage.keyboard.type(text);
    }

    async function sendSidebarMessage(text, shortcut = 'Enter') {
      await fillSidebarInput(text);
      await hostPage.keyboard.press(shortcut);
    }

    await sendSidebarMessage('Start the steer queue fallback regression.');
    result.steps.push('first_message_sent');

    await waitFor(async () => mockServer.requestLog.length >= 1 ? true : null, {
      timeoutMs: 15_000,
      intervalMs: 100,
      label: 'first request observed'
    });
    result.steps.push('first_request_observed');

    await sleep(1_200);
    await sendSidebarMessage(STEER_TEXT, 'Control+Enter');
    result.steps.push('steer_sent');

    result.pendingSteerPreview = await waitFor(async () => {
      return await sidebarFrame.evaluate(() => {
        const panel = document.querySelector('.conversation-send-queue-preview');
        if (!panel) return null;
        const snapshot = {
          text: (panel.innerText || '').trim(),
          steerWindowCount: panel.querySelectorAll('.conversation-send-queue-preview__pending-steer-window').length,
          steerItemCount: panel.querySelectorAll('.conversation-send-queue-preview__pending-steer-item').length
        };
        return snapshot.steerWindowCount === 1 && snapshot.steerItemCount === 1 ? snapshot : null;
      });
    }, { timeoutMs: 8_000, intervalMs: 150, label: 'pending steer preview visible' });
    result.steps.push('pending_steer_preview_visible');

    await waitFor(async () => mockServer.requestLog.length >= 2 ? true : null, {
      timeoutMs: 30_000,
      intervalMs: 200,
      label: 'fallback queue request observed'
    });
    result.steps.push('second_request_observed');

    const finalAssistantText = await waitFor(async () => {
      return await sidebarFrame.evaluate((expectedText) => {
        const texts = Array.from(document.querySelectorAll('.message.ai-message'))
          .map((el) => (el.innerText || '').trim())
          .filter(Boolean);
        return texts.find((text) => text.includes(expectedText)) || null;
      }, FINAL_TEXT);
    }, { timeoutMs: 20_000, intervalMs: 200, label: 'final assistant text observed' });
    result.finalAssistantText = finalAssistantText;

    result.requestLog = mockServer.requestLog;
    result.secondRequestInputTexts = (Array.isArray(mockServer.requestLog?.[1]?.input) ? mockServer.requestLog[1].input : [])
      .flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        if (typeof item.content === 'string') return [item.content];
        if (!Array.isArray(item.content)) return [];
        return item.content
          .map((part) => (typeof part?.text === 'string' ? part.text : ''))
          .filter(Boolean);
      });

    await hostPage.screenshot({ path: path.join(outputDir, '01-final.png'), fullPage: true });

    const hasSteerInSecondRequest = result.secondRequestInputTexts.some((text) => text.includes(STEER_TEXT));
    if (!hasSteerInSecondRequest) {
      throw new Error('fallback queue request did not include steer input text');
    }
    if (!String(finalAssistantText || '').includes(FINAL_TEXT)) {
      throw new Error(`final assistant text did not confirm fallback steer delivery: ${finalAssistantText}`);
    }
  } finally {
    result.finishedAt = new Date().toISOString();
    try {
      await fsp.writeFile(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    } catch (_) {}
    try {
      await context?.close?.();
    } catch (_) {}
    try {
      await mockServer.close();
    } catch (_) {}
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
