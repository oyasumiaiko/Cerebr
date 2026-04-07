const fsp = require('fs/promises');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const [repoRoot, outputDir, chromePath] = process.argv.slice(2);

if (!repoRoot || !outputDir || !chromePath) {
  throw new Error(
    'Usage: node tests/cdp_steer_tool_loop_regression.cjs <repoRoot> <outputDir> <chromePath>'
  );
}

function loadPlaywright() {
  const candidateBases = [
    process.cwd(),
    repoRoot,
    path.join(repoRoot, 'node_modules'),
    path.join(os.tmpdir(), 'cerebr-playwright-cdp'),
    path.join(os.tmpdir(), 'cerebr-playwright-cdp', 'node_modules')
  ];
  for (const base of candidateBases) {
    try {
      const resolved = require.resolve('playwright', { paths: [base] });
      return require(resolved);
    } catch (_) {}
  }
  throw new Error('Cannot resolve playwright');
}

const { chromium } = loadPlaywright();

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

async function waitFor(condition, {
  timeoutMs = 30000,
  intervalMs = 200,
  label = 'condition'
} = {}) {
  const startedAt = Date.now();
  while (true) {
    try {
      const value = await condition();
      if (value) return value;
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) throw error;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await sleep(intervalMs);
  }
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`failed to list CDP targets: HTTP ${response.status}`);
  return await response.json();
}

async function createTargetSession(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', (event) => reject(event.error || new Error('cdp websocket error')));
  });

  ws.addEventListener('message', (event) => {
    const payload = JSON.parse(String(event.data));
    if (!payload || typeof payload !== 'object') return;
    if (!payload.id || !pending.has(payload.id)) return;
    const entry = pending.get(payload.id);
    pending.delete(payload.id);
    if (payload.error) {
      entry.reject(new Error(payload.error.message || JSON.stringify(payload.error)));
      return;
    }
    entry.resolve(payload.result || {});
  });

  const send = (method, params = {}) => {
    nextId += 1;
    const id = nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  await send('Runtime.enable');

  return {
    async evaluate(expression) {
      const evaluation = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      });
      if (evaluation.exceptionDetails) {
        throw new Error(evaluation.exceptionDetails.text || evaluation.result?.description || 'Runtime.evaluate failed');
      }
      return evaluation.result?.value;
    },
    close() {
      try { ws.close(); } catch (_) {}
    }
  };
}

function buildSendContentMessageExpression(messageLiteral) {
  return `(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || typeof tab.id !== 'number') throw new Error('active tab not found');
    const response = await chrome.tabs.sendMessage(tab.id, ${messageLiteral});
    return { tabId: tab.id, response };
  })()`;
}

function buildStorageSeed(baseUrl) {
  const sourceId = 'src_steer_tool_loop_regression';
  const config = {
    id: 'cfg_steer_tool_loop_regression',
    connectionSourceId: sourceId,
    displayName: 'Steer Tool Loop Regression',
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
    <title>Steer tool loop regression</title>
  </head>
  <body>
    <main>
      <h1>Steer tool loop regression</h1>
      <p>This page only exists to host the Cerebr sidebar during the regression test.</p>
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

function createFunctionCallItem(callId, codeText) {
  return {
    id: `fc_${callId}`,
    type: 'function_call',
    call_id: callId,
    name: 'js_runtime_execute',
    arguments: JSON.stringify({
      code: codeText,
      frame_ids: null
    }),
    status: 'completed'
  };
}

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function runMockResponsesServer() {
  const requestLog = [];
  const steerText = 'STEER_TOOL_HOP_OK_20260408';
  const stage2VisibleText = 'SECOND_HOP_VISIBLE_TEXT_20260408';
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
          const inputItems = Array.isArray(parsed?.input) ? parsed.input : [];
          const inputTexts = inputItems.flatMap((item) => {
            if (!item || typeof item !== 'object') return [];
            if (typeof item.content === 'string') return [item.content];
            if (!Array.isArray(item.content)) return [];
            return item.content
              .map((part) => (typeof part?.text === 'string' ? part.text : ''))
              .filter(Boolean);
          });
          const allText = inputTexts.join('\n');
          const hasTool1Output = inputItems.some((item) => item?.type === 'function_call_output' && item?.call_id === 'call_1');
          const hasTool2Output = inputItems.some((item) => item?.type === 'function_call_output' && item?.call_id === 'call_2');
          const hasSteer = allText.includes(steerText);

          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
            'access-control-allow-origin': '*'
          });

          if (!hasTool1Output) {
            const functionCall = createFunctionCallItem(
              'call_1',
              "await new Promise((resolve) => setTimeout(resolve, 250)); console.log('tool-1'); return 'tool-1-done';"
            );
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
                  input_tokens: 100,
                  output_tokens: 10,
                  total_tokens: 110,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens_details: { reasoning_tokens: 0 }
                }
              }
            });
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }

          if (!hasTool2Output) {
            const messageItem = createMessageItem('msg_2', stage2VisibleText);
            const functionCall = createFunctionCallItem(
              'call_2',
              "await new Promise((resolve) => setTimeout(resolve, 2500)); console.log('tool-2'); return 'tool-2-done';"
            );
            writeSseEvent(res, { type: 'response.created', response: { id: 'resp_2' } });
            writeSseEvent(res, { type: 'response.in_progress', response: { id: 'resp_2' } });
            writeSseEvent(res, { type: 'response.output_item.added', item: messageItem });
            writeSseEvent(res, {
              type: 'response.output_text.delta',
              item_id: 'msg_2',
              output_item_id: 'msg_2',
              output_index: 0,
              content_index: 0,
              delta: stage2VisibleText
            });
            writeSseEvent(res, {
              type: 'response.output_text.done',
              item_id: 'msg_2',
              output_item_id: 'msg_2',
              output_index: 0,
              content_index: 0,
              text: stage2VisibleText
            });
            writeSseEvent(res, { type: 'response.output_item.done', item: messageItem });
            await sleep(1500);
            writeSseEvent(res, { type: 'response.output_item.added', item: functionCall });
            writeSseEvent(res, { type: 'response.output_item.done', item: functionCall });
            writeSseEvent(res, {
              type: 'response.completed',
              response: {
                id: 'resp_2',
                output: [messageItem, functionCall],
                usage: {
                  input_tokens: 120,
                  output_tokens: 20,
                  total_tokens: 140,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens_details: { reasoning_tokens: 0 }
                }
              }
            });
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }

          const finalText = hasSteer
            ? `STEER_APPLIED_20260408 ${steerText}`
            : 'STEER_MISSING_20260408';
          const messageItem = createMessageItem('msg_3', finalText);
          writeSseEvent(res, { type: 'response.created', response: { id: 'resp_3' } });
          writeSseEvent(res, { type: 'response.in_progress', response: { id: 'resp_3' } });
          writeSseEvent(res, { type: 'response.output_item.added', item: messageItem });
          writeSseEvent(res, {
            type: 'response.output_text.delta',
            item_id: 'msg_3',
            output_item_id: 'msg_3',
            output_index: 0,
            content_index: 0,
            delta: finalText
          });
          writeSseEvent(res, {
            type: 'response.output_text.done',
            item_id: 'msg_3',
            output_item_id: 'msg_3',
            output_index: 0,
            content_index: 0,
            text: finalText
          });
          writeSseEvent(res, { type: 'response.output_item.done', item: messageItem });
          writeSseEvent(res, {
            type: 'response.completed',
            response: {
              id: 'resp_3',
              output: [messageItem],
              usage: {
                input_tokens: 150,
                output_tokens: 30,
                total_tokens: 180,
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
    port,
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
    backgroundConsole: [],
    steps: []
  };

  const mockServer = await runMockResponsesServer();
  result.mockOrigin = mockServer.origin;
  const profileDir = path.join(outputDir, 'profile');
  const seedProfileDir = path.join(repoRoot, 'output', 'playwright', '_profiles', 'cdp_sidebar_smoke');
  if (await fsp.stat(seedProfileDir).then(() => true).catch(() => false)) {
    await fsp.cp(seedProfileDir, profileDir, { recursive: true, force: true });
    result.seedProfileDir = seedProfileDir;
  } else {
    await fsp.mkdir(profileDir, { recursive: true });
  }
  result.profileDir = profileDir;

  let browser = null;
  let chrome = null;
  let session = null;
  try {
    const cdpPort = await getFreePort();
    chrome = spawn(
      chromePath,
      [
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${profileDir}`,
        `--disable-extensions-except=${repoRoot}`,
        `--load-extension=${repoRoot}`,
        '--enable-unsafe-extension-debugging',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-search-engine-choice-screen',
        'https://example.com/'
      ],
      { stdio: 'ignore', windowsHide: false }
    );

    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
        return response.ok;
      } catch (_) {
        return false;
      }
    }, { timeoutMs: 30000, intervalMs: 200, label: 'cdp endpoint ready' });
    result.steps.push('cdp_ready');

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const context = await waitFor(async () => browser.contexts()[0] || null, {
      timeoutMs: 10000,
      intervalMs: 200,
      label: 'browser context'
    });
    result.steps.push('browser_ready');

    const hostPage = await waitFor(async () => {
      return context.pages().find((page) => page.url().startsWith('https://example.com/')) || null;
    }, { timeoutMs: 30000, intervalMs: 200, label: 'example host page' });
    hostPage.on('console', (msg) => {
      result.console.push({ type: msg.type(), text: msg.text() });
    });
    hostPage.on('pageerror', (error) => {
      result.console.push({ type: 'pageerror', text: String(error && (error.stack || error.message || error)) });
    });
    result.steps.push('host_page_ready');

    const backgroundTarget = await waitFor(async () => {
      const targets = await listTargets(cdpPort);
      return targets.find((target) => (
        typeof target?.url === 'string'
        && target.url.endsWith('/src/extension/background.js')
      )) || null;
    }, { timeoutMs: 30000, intervalMs: 500, label: 'background target' });
    session = await createTargetSession(backgroundTarget.webSocketDebuggerUrl);
    const extensionId = new URL(backgroundTarget.url).host;
    result.extensionId = extensionId;
    result.steps.push('extension_id_resolved');

    await session.evaluate(`(async () => {
      await chrome.storage.sync.clear();
      await chrome.storage.local.clear();
      await chrome.storage.sync.set(${JSON.stringify(buildStorageSeed(`${mockServer.origin}/v1/responses`))});
      return true;
    })()`);
    result.steps.push('storage_seeded');

    result.backgroundStorageSnapshot = await session.evaluate(`(async () => {
      const syncSnapshot = await chrome.storage.sync.get(null);
      return {
        syncKeys: Object.keys(syncSnapshot).sort(),
        selectedConfigIndex: syncSnapshot.selectedConfigIndex || 0
      };
    })()`);
    result.steps.push('background_storage_checked');

    const openSidebarResponse = await session.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'OPEN_SIDEBAR' }))
    );
    result.openSidebarResponse = openSidebarResponse;
    result.steps.push('sidebar_open_requested');

    const sidebarFrame = await waitFor(async () => {
      return hostPage.frames().find((frame) => frame.url().startsWith(`chrome-extension://${extensionId}/src/ui/sidebar/sidebar.html`)) || null;
    }, { timeoutMs: 30000, intervalMs: 200, label: 'embedded sidebar frame' });
    await sidebarFrame.locator('#message-input').waitFor({ state: 'visible', timeout: 30000 });
    result.sidebarStorageSnapshot = await sidebarFrame.evaluate(async () => {
      const syncSnapshot = await globalThis.chrome.storage.sync.get(null);
      return {
        syncKeys: Object.keys(syncSnapshot).sort(),
        apiConfigsLength: Array.isArray(window.apiConfigs) ? window.apiConfigs.length : null,
        apiConfigBaseUrls: Array.isArray(window.apiConfigs)
          ? window.apiConfigs.map((config) => config?.baseUrl || '')
          : []
      };
    });
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

    await sendSidebarMessage('Start the steer regression test.');
    result.steps.push('first_message_sent');

    await waitFor(async () => mockServer.requestLog.length >= 2 ? true : null, {
      timeoutMs: 20000,
      intervalMs: 100,
      label: 'second request sent'
    });
    result.steps.push('second_request_observed');

    await sleep(300);
    await sendSidebarMessage('STEER_TOOL_HOP_OK_20260408', 'Control+Enter');
    result.steps.push('steer_sent');
    await sleep(500);
    result.pendingSteerPreview = await sidebarFrame.evaluate(() => {
      const panel = document.querySelector('.conversation-send-queue-preview');
      return panel ? (panel.innerText || '').trim() : '';
    });
    result.toastTextsAfterSteer = await sidebarFrame.evaluate(() => (
      Array.from(document.querySelectorAll('.notification-toast, .notification, .toast'))
        .map((el) => (el.innerText || '').trim())
        .filter(Boolean)
    ));

    const settled = await waitFor(async () => {
      return await sidebarFrame.evaluate(() => {
        const texts = Array.from(document.querySelectorAll('.message.ai-message'))
          .map((el) => (el.innerText || '').trim())
          .filter(Boolean);
        return texts.find((text) => text.includes('STEER_APPLIED_20260408') || text.includes('STEER_MISSING_20260408')) || null;
      });
    }, { timeoutMs: 30000, intervalMs: 250, label: 'final steer result' });
    result.finalAssistantText = settled;
    result.requestLog = mockServer.requestLog;
    result.thirdRequestInputTexts = (Array.isArray(mockServer.requestLog?.[2]?.input) ? mockServer.requestLog[2].input : []).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      if (typeof item.content === 'string') return [item.content];
      if (!Array.isArray(item.content)) return [];
      return item.content
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .filter(Boolean);
    });

    await hostPage.screenshot({ path: path.join(outputDir, '01-final.png'), fullPage: true });

    const hasSteerInThirdRequest = result.thirdRequestInputTexts.some((text) => text.includes('STEER_TOOL_HOP_OK_20260408'));
    if (!hasSteerInThirdRequest) {
      throw new Error('third follow-up request did not include steer input text');
    }
    if (!String(settled || '').includes('STEER_APPLIED_20260408')) {
      throw new Error(`final assistant text did not confirm steer application: ${settled}`);
    }
  } finally {
    result.finishedAt = new Date().toISOString();
    try {
      await fsp.writeFile(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    } catch (_) {}
    try {
      await browser?.close?.();
    } catch (_) {}
    try {
      chrome?.kill?.();
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
