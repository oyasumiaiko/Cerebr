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
  shouldRunHeadless,
  waitFor,
  waitForSidebarFrame
} = require('./lib/stable_chrome_sidebar_harness.cjs');
const {
  launchWorktreeUnpackedChromiumContext,
  resolveWorktreeUnpackedProfileDir,
  waitForWorktreeExtensionWorker
} = require('./lib/worktree_unpacked_extension_harness.cjs');

const [rawRepoRoot, outputDir, rawArg3 = '', rawArg4 = ''] = process.argv.slice(2);
const repoRoot = rawRepoRoot ? path.resolve(rawRepoRoot) : '';
const launchMode = (rawArg3 === 'stable' || rawArg3 === 'worktree_unpacked')
  ? rawArg3
  : ((rawArg4 === 'stable' || rawArg4 === 'worktree_unpacked') ? rawArg4 : 'stable');
const chromePath = (launchMode === rawArg3) ? '' : rawArg3;

if (!repoRoot || !outputDir || (launchMode === 'stable' && !chromePath)) {
  throw new Error(
    'Usage: node tests/cdp_webpage_screenshot_tool_regression.cjs <repoRoot> <outputDir> [chromePath] [mode=stable|worktree_unpacked]'
  );
}

const EXPECTED_FINAL_TEXT = 'WEBPAGE_SCREENSHOT_TOOL_OK_20260411';
const SCREENSHOT_CALL_ID = 'call_webpage_screenshot_1';
const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);

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
  const sourceId = 'src_webpage_screenshot_tool_regression';
  const config = {
    id: 'cfg_webpage_screenshot_tool_regression',
    connectionSourceId: sourceId,
    displayName: 'Webpage Screenshot Tool Regression',
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
    sendChatHistory: true,
    showThoughtProcess: true,
    queueCurrentConversationMessages: true,
    autoGenerateConversationTitle: false
  };
}

function createPageHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Webpage Screenshot Tool Regression</title>
    <style>
      body {
        margin: 0;
        font-family: Georgia, serif;
        background:
          radial-gradient(circle at top left, #ffe29a 0%, rgba(255, 226, 154, 0) 42%),
          linear-gradient(140deg, #0b132b 0%, #1c2541 55%, #3a506b 100%);
        color: #f6f7fb;
      }
      main {
        padding: 48px;
      }
      .hero {
        width: 520px;
        padding: 28px;
        border-radius: 24px;
        background: rgba(255, 255, 255, 0.14);
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.28);
        backdrop-filter: blur(10px);
      }
      .hero h1 {
        margin: 0 0 16px;
        font-size: 44px;
        line-height: 1.05;
      }
      .chips {
        display: flex;
        gap: 12px;
        margin-top: 18px;
      }
      .chip {
        padding: 10px 14px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.18);
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <p>Visual regression host page</p>
        <h1>Webpage Screenshot Tool</h1>
        <p>This page intentionally contains styled visual content so the screenshot tool captures a meaningful image.</p>
        <div class="chips">
          <span class="chip">Gradient</span>
          <span class="chip">Glass Panel</span>
          <span class="chip">Large Heading</span>
        </div>
      </section>
    </main>
  </body>
</html>`;
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

function createFunctionCallItem() {
  return {
    id: `fc_${SCREENSHOT_CALL_ID}`,
    type: 'function_call',
    call_id: SCREENSHOT_CALL_ID,
    name: 'webpage_screenshot',
    arguments: '{}',
    status: 'completed'
  };
}

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function buildImageOutputSummary(outputItem) {
  const output = Array.isArray(outputItem?.output) ? outputItem.output : [];
  const first = output[0] && typeof output[0] === 'object' ? output[0] : null;
  const imageUrl = (typeof first?.image_url === 'string') ? first.image_url : '';
  const commaIndex = imageUrl.indexOf(',');
  const prefix = commaIndex >= 0 ? imageUrl.slice(0, commaIndex) : imageUrl;
  const base64 = commaIndex >= 0 ? imageUrl.slice(commaIndex + 1) : '';
  return {
    outputLength: output.length,
    firstType: first?.type || '',
    prefix,
    hasDetailField: Object.prototype.hasOwnProperty.call(first || {}, 'detail'),
    detail: first?.detail ?? null,
    approxBytes: base64 ? Math.round((base64.length * 3) / 4) : 0
  };
}

async function runMockResponsesServer() {
  const requestLog = [];
  let firstRequestToolNames = [];
  let screenshotOutputSummary = null;
  const pageHtml = createPageHtml();

  const server = http.createServer(async (req, res) => {
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
          let parsed = null;
          try {
            parsed = JSON.parse(body);
          } catch (error) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: { message: `invalid json: ${error.message}` } }));
            return;
          }

          requestLog.push(parsed);
          if (requestLog.length === 1) {
            firstRequestToolNames = (Array.isArray(parsed?.tools) ? parsed.tools : [])
              .map((tool) => (tool?.type === 'function' ? tool?.name : tool?.type))
              .filter(Boolean);
          }

          const inputItems = Array.isArray(parsed?.input) ? parsed.input : [];
          const screenshotOutput = inputItems.find((item) => item?.type === 'function_call_output' && item?.call_id === SCREENSHOT_CALL_ID);

          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
            'access-control-allow-origin': '*'
          });

          if (!screenshotOutput) {
            const functionCall = createFunctionCallItem();
            writeSseEvent(res, { type: 'response.created', response: { id: 'resp_1' } });
            writeSseEvent(res, { type: 'response.in_progress', response: { id: 'resp_1' } });
            writeSseEvent(res, { type: 'response.output_item.added', item: functionCall });
            writeSseEvent(res, { type: 'response.output_item.done', item: functionCall });
            writeSseEvent(res, {
              type: 'response.completed',
              response: {
                id: 'resp_1',
                output: [functionCall],
                usage: {
                  input_tokens: 80,
                  output_tokens: 8,
                  total_tokens: 88,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens_details: { reasoning_tokens: 0 }
                }
              }
            });
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }

          screenshotOutputSummary = buildImageOutputSummary(screenshotOutput);
          const isValidImageOutput = (
            screenshotOutputSummary.outputLength === 1
            && screenshotOutputSummary.firstType === 'input_image'
            && screenshotOutputSummary.prefix === 'data:image/jpeg;base64'
            && screenshotOutputSummary.hasDetailField === false
            && screenshotOutputSummary.approxBytes > 0
          );
          const finalText = isValidImageOutput
            ? EXPECTED_FINAL_TEXT
            : `WEBPAGE_SCREENSHOT_TOOL_BAD_OUTPUT ${JSON.stringify(screenshotOutputSummary)}`;
          const messageItem = createMessageItem('msg_2', finalText);
          writeSseEvent(res, { type: 'response.created', response: { id: 'resp_2' } });
          writeSseEvent(res, { type: 'response.in_progress', response: { id: 'resp_2' } });
          writeSseEvent(res, { type: 'response.output_item.added', item: messageItem });
          writeSseEvent(res, {
            type: 'response.output_text.delta',
            item_id: 'msg_2',
            output_item_id: 'msg_2',
            output_index: 0,
            content_index: 0,
            delta: finalText
          });
          writeSseEvent(res, {
            type: 'response.output_text.done',
            item_id: 'msg_2',
            output_item_id: 'msg_2',
            output_index: 0,
            content_index: 0,
            text: finalText
          });
          writeSseEvent(res, { type: 'response.output_item.done', item: messageItem });
          writeSseEvent(res, {
            type: 'response.completed',
            response: {
              id: 'resp_2',
              output: [messageItem],
              usage: {
                input_tokens: 100,
                output_tokens: 12,
                total_tokens: 112,
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
    getFirstRequestToolNames() {
      return firstRequestToolNames.slice();
    },
    getScreenshotOutputSummary() {
      return screenshotOutputSummary ? { ...screenshotOutputSummary } : null;
    },
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
    launchMode,
    headless: runHeadless,
    steps: []
  };

  const mockServer = await runMockResponsesServer();
  result.mockOrigin = mockServer.origin;

  const profileDir = launchMode === 'worktree_unpacked'
    ? resolveWorktreeUnpackedProfileDir(repoRoot, 'webpage-screenshot-tool-regression')
    : resolveFixedSidebarProfileDir(repoRoot);
  await fsp.mkdir(profileDir, { recursive: true });
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

    const page = context.pages()[0] || await context.newPage();
    page.on('pageerror', (error) => {
      result.pageError = String(error && (error.stack || error.message || error));
    });

    let extensionWorker = null;
    if (launchMode === 'worktree_unpacked') {
      await page.goto(`${mockServer.origin}/`, { waitUntil: 'domcontentloaded' });
      result.steps.push('page_loaded');
      extensionWorker = await waitForWorktreeExtensionWorker(context, { timeoutMs: 30_000 });
    } else {
      extensionWorker = await reloadUnpackedExtension(context, { timeoutMs: 30_000 });
      await page.goto(`${mockServer.origin}/`, { waitUntil: 'domcontentloaded' });
      result.steps.push('page_loaded');
    }
    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;
    result.steps.push(launchMode === 'worktree_unpacked' ? 'worker_ready' : 'extension_reloaded');

    await extensionWorker.evaluate(`(async () => {
      await chrome.storage.sync.clear();
      await chrome.storage.sync.set(${JSON.stringify(buildStorageSeed(`${mockServer.origin}/v1/responses`))});
      return true;
    })()`);
    result.steps.push('storage_seeded');

    const openSidebarResponse = await extensionWorker.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'OPEN_SIDEBAR' }))
    );
    result.openSidebarResponse = openSidebarResponse;
    result.steps.push('sidebar_open_requested');

    await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      return payload?.response?.debugState?.isActuallyVisible ? payload.response.debugState : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: 'sidebar visibility' });
    result.steps.push('sidebar_visible');

    const sidebarFrame = await waitForSidebarFrame(page, extensionId, { timeoutMs: 30_000 });
    await sidebarFrame.locator('#message-input').waitFor({ state: 'visible', timeout: 30_000 });
    await waitFor(
      () => sidebarFrame.evaluate(() => Array.isArray(window.apiConfigs) && window.apiConfigs.length > 0),
      { timeoutMs: 20_000, intervalMs: 250, label: 'sidebar api configs ready' }
    );
    result.steps.push('sidebar_ready');

    const prompt = 'Please inspect the current page visually if useful and answer briefly.';
    await sidebarFrame.locator('#message-input').fill(prompt);
    await sidebarFrame.locator('#message-input').press('Enter');
    result.steps.push('prompt_sent');

    await waitFor(async () => mockServer.requestLog.length >= 2 ? true : null, {
      timeoutMs: 30_000,
      intervalMs: 200,
      label: 'two mock responses requests'
    });
    result.steps.push('tool_followup_observed');

    const finalAssistantText = await waitFor(async () => {
      const texts = await sidebarFrame.evaluate(() => (
        Array.from(document.querySelectorAll('.message.ai-message'))
          .map((element) => (element.innerText || '').trim())
          .filter(Boolean)
      ));
      const last = texts[texts.length - 1] || '';
      return last.includes(EXPECTED_FINAL_TEXT) ? last : null;
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: 'final assistant text'
    });
    result.finalAssistantText = finalAssistantText;
    result.steps.push('assistant_completed');

    await sidebarFrame.locator('body').screenshot({
      path: path.join(outputDir, 'sidebar-body-final.png')
    });
    await page.screenshot({
      path: path.join(outputDir, 'host-page-final.png'),
      fullPage: true
    });
    result.steps.push('screenshots_saved');

    result.firstRequestToolNames = mockServer.getFirstRequestToolNames();
    result.screenshotOutputSummary = mockServer.getScreenshotOutputSummary();

    if (!result.firstRequestToolNames.includes('webpage_screenshot')) {
      throw new Error(`first request did not include webpage_screenshot tool: ${JSON.stringify(result.firstRequestToolNames)}`);
    }
    if (!result.screenshotOutputSummary || result.screenshotOutputSummary.firstType !== 'input_image') {
      throw new Error(`follow-up request did not include expected input_image output: ${JSON.stringify(result.screenshotOutputSummary)}`);
    }

    await fsp.writeFile(
      path.join(outputDir, 'result.json'),
      JSON.stringify(result, null, 2),
      'utf8'
    );
  } finally {
    try {
      await mockServer.close();
    } catch (_) {}
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

main().catch(async (error) => {
  const failure = {
    ok: false,
    error: String(error && (error.stack || error.message || error))
  };
  try {
    await fsp.mkdir(outputDir, { recursive: true });
    await fsp.writeFile(
      path.join(outputDir, 'result.json'),
      JSON.stringify(failure, null, 2),
      'utf8'
    );
  } catch (_) {}
  console.error(error);
  process.exitCode = 1;
});
