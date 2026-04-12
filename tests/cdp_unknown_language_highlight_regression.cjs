const fsp = require('fs/promises');
const http = require('http');
const net = require('net');
const path = require('path');

const {
  loadPlaywright,
  launchFixedSidebarContext,
  buildSendContentMessageExpression,
  reloadUnpackedExtension,
  resolveFixedSidebarProfileDir,
  resolveStableChromeExecutablePath,
  shouldRunHeadless,
  sleep,
  waitFor,
  waitForExtensionWorker,
  waitForSidebarFrame
} = require('./lib/stable_chrome_sidebar_harness.cjs');

const [repoRootArg, outputDirArg, chromePathArg] = process.argv.slice(2);
const repoRoot = path.resolve(repoRootArg || '.');
const outputDir = path.resolve(outputDirArg || path.join(repoRoot, 'output', 'playwright', 'unknown_language_highlight_regression'));
const chromePath = chromePathArg || resolveStableChromeExecutablePath();

function createPageHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Unknown language highlight regression</title>
  </head>
  <body>
    <main>
      <h1>Unknown language highlight regression host</h1>
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
    content: [{ type: 'output_text', text }]
  };
}

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
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

function buildStorageSeed(baseUrl) {
  const sourceId = 'src_unknown_language_highlight_regression';
  const config = {
    id: 'cfg_unknown_language_highlight_regression',
    connectionSourceId: sourceId,
    displayName: 'Unknown Language Highlight Regression',
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
        web_search: { enabled: false }
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

async function runMockResponsesServer() {
  const requestLog = [];
  const pageHtml = createPageHtml();
  const codeText = 'rank(add(zscore(ts_rank(divide(operating_income, cap), 252)), zscore(ts_rank(divide(cashflow_op, cap), 252))))';
  const finalText = [
    '下面这段表达式会故意使用一个 highlight.js 不认识的 fenced language：',
    '',
    '```fasteexpr',
    codeText,
    '```'
  ].join('\n');

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
        req.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(body);
          } catch (error) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: { message: `invalid json: ${error.message}` } }));
            return;
          }

          requestLog.push(parsed);
          const messageItem = createMessageItem('msg_unknown_language_1', finalText);
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
            'access-control-allow-origin': '*'
          });
          writeSseEvent(res, { type: 'response.created', response: { id: 'resp_unknown_language_1' } });
          writeSseEvent(res, { type: 'response.in_progress', response: { id: 'resp_unknown_language_1' } });
          writeSseEvent(res, { type: 'response.output_item.added', item: messageItem });
          writeSseEvent(res, {
            type: 'response.output_text.delta',
            item_id: messageItem.id,
            output_item_id: messageItem.id,
            output_index: 0,
            content_index: 0,
            delta: finalText
          });
          writeSseEvent(res, {
            type: 'response.output_text.done',
            item_id: messageItem.id,
            output_item_id: messageItem.id,
            output_index: 0,
            content_index: 0,
            text: finalText
          });
          writeSseEvent(res, { type: 'response.output_item.done', item: messageItem });
          writeSseEvent(res, {
            type: 'response.completed',
            response: {
              id: 'resp_unknown_language_1',
              output: [messageItem],
              usage: {
                input_tokens: 64,
                output_tokens: 48,
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
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(String(error && (error.stack || error.message || error)));
    }
  });

  const port = await getFreePort();
  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', (error) => error ? reject(error) : resolve());
  });

  return {
    origin: `http://127.0.0.1:${port}`,
    requestLog,
    finalText,
    codeText,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

async function openSidebarAndWaitReady(hostPage, extensionWorker, mockOrigin) {
  const extensionId = new URL(extensionWorker.url()).host;
  await extensionWorker.evaluate(
    buildSendContentMessageExpression(JSON.stringify({ type: 'OPEN_SIDEBAR' }))
  );
  const sidebarFrame = await waitForSidebarFrame(hostPage, extensionId, { timeoutMs: 30_000 });
  await sidebarFrame.locator('#message-input').waitFor({ state: 'visible', timeout: 30_000 });
  await waitFor(async () => {
    return await sidebarFrame.evaluate(() => {
      const configs = Array.isArray(window.apiConfigs) ? window.apiConfigs : [];
      return configs.length > 0 ? true : null;
    });
  }, { timeoutMs: 15_000, intervalMs: 200, label: 'sidebar api config ready' });
  return { sidebarFrame, extensionId };
}

async function waitForUnknownLanguageCode(sidebarFrame, expectedText) {
  return await waitFor(async () => {
    return await sidebarFrame.evaluate((needle) => {
      const aiMessages = Array.from(document.querySelectorAll('.message.ai-message'));
      const target = aiMessages.find((element) => {
        const code = element.querySelector('pre code.language-fasteexpr');
        return (code?.innerText || '').includes(needle);
      }) || null;
      if (!target) return null;
      const code = target.querySelector('pre code.language-fasteexpr');
      if (!code) return null;
      return {
        text: (code.innerText || '').trim(),
        className: code.className || '',
        highlightState: code.dataset.cerebrHighlightState || '',
        highlightSignature: code.dataset.cerebrHighlightSignature || ''
      };
    }, expectedText);
  }, { timeoutMs: 20_000, intervalMs: 200, label: 'unknown language code rendered' });
}

async function main() {
  const { chromium } = loadPlaywright(repoRoot);
  await fsp.mkdir(outputDir, { recursive: true });

  const result = {
    startedAt: new Date().toISOString(),
    outputDir,
    chromePath,
    console: [],
    steps: []
  };

  const mockServer = await runMockResponsesServer();
  result.mockOrigin = mockServer.origin;

  const profileDir = resolveFixedSidebarProfileDir(repoRoot);
  result.profileDir = profileDir;
  const runHeadless = shouldRunHeadless();

  let context = null;
  try {
    context = await launchFixedSidebarContext({
      chromium,
      profileDir,
      executablePath: chromePath,
      headless: runHeadless
    });
    result.steps.push('browser_ready');

    await reloadUnpackedExtension(context, { timeoutMs: 30_000, settleMs: 2_000 });
    result.steps.push('extension_reloaded');

    const extensionWorker = await waitForExtensionWorker(context, { timeoutMs: 30_000 });
    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;
    result.steps.push('extension_id_resolved');

    await extensionWorker.evaluate(async (seed) => {
      await chrome.storage.sync.clear();
      await chrome.storage.local.clear();
      await chrome.storage.sync.set(seed);
      return true;
    }, buildStorageSeed(`${mockServer.origin}/v1/responses`));
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

    const { sidebarFrame } = await openSidebarAndWaitReady(hostPage, extensionWorker, mockServer.origin);
    result.steps.push('sidebar_ready');

    await sidebarFrame.locator('#message-input').fill('Render one unknown-language code block.');
    await sidebarFrame.locator('#message-input').press('Enter');
    result.steps.push('message_sent');

    await waitFor(async () => mockServer.requestLog.length >= 1 ? true : null, {
      timeoutMs: 15_000,
      intervalMs: 100,
      label: 'first request observed'
    });
    result.steps.push('first_request_observed');

    result.initialRender = await waitForUnknownLanguageCode(sidebarFrame, mockServer.codeText);
    result.steps.push('initial_code_rendered');

    await sleep(500);
    result.highlightWarnings = result.console.filter((entry) => {
      const text = String(entry.text || '');
      return text.includes('Could not find the language')
        || text.includes('Falling back to no-highlight mode');
    });

    await hostPage.screenshot({ path: path.join(outputDir, '01-final.png'), fullPage: true });

    if (result.highlightWarnings.length > 0) {
      throw new Error(`unexpected highlight warnings: ${JSON.stringify(result.highlightWarnings)}`);
    }
    if (!String(result.initialRender?.highlightState || '').trim()) {
      throw new Error(`initial render did not persist Cerebr highlight state: ${JSON.stringify(result.initialRender)}`);
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
