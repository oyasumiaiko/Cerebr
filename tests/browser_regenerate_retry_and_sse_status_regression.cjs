const fsp = require('fs/promises');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const [repoRoot, outputDir, chromePath] = process.argv.slice(2);

if (!repoRoot || !outputDir || !chromePath) {
  throw new Error(
    'Usage: node tests/browser_regenerate_retry_and_sse_status_regression.cjs <repoRoot> <outputDir> <chromePath>'
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

function buildStorageSeed(baseUrl) {
  const sourceId = 'src_regenerate_retry_status_regression';
  const config = {
    id: 'cfg_regenerate_retry_status_regression',
    connectionSourceId: sourceId,
    displayName: 'Regenerate Retry Status Regression',
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
    <title>Regenerate retry status regression</title>
  </head>
  <body>
    <main>
      <h1>Regenerate retry status regression host</h1>
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
    content: [{ type: 'output_text', text }]
  };
}

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function runMockResponsesServer() {
  const requestLog = [];
  const pageHtml = createPageHtml();
  const firstReplyText = 'FIRST_REPLY_20260408';
  const secondReplyText = 'SECOND_REPLY_AFTER_EDIT_20260408';
  const secondReasoningText = 'SECOND_REASONING_20260408';

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
          const requestIndex = requestLog.length;
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
            'access-control-allow-origin': '*'
          });
          try { res.flushHeaders(); } catch (_) {}
          try { req.socket?.setNoDelay?.(true); } catch (_) {}

          if (requestIndex === 1) {
            const messageItem = createMessageItem('msg_first_reply', firstReplyText);
            writeSseEvent(res, { type: 'response.created', response: { id: 'resp_first' } });
            writeSseEvent(res, { type: 'response.in_progress', response: { id: 'resp_first' } });
            writeSseEvent(res, { type: 'response.output_item.added', item: messageItem });
            writeSseEvent(res, {
              type: 'response.output_text.delta',
              item_id: 'msg_first_reply',
              output_item_id: 'msg_first_reply',
              output_index: 0,
              content_index: 0,
              delta: firstReplyText
            });
            writeSseEvent(res, {
              type: 'response.output_text.done',
              item_id: 'msg_first_reply',
              output_item_id: 'msg_first_reply',
              output_index: 0,
              content_index: 0,
              text: firstReplyText
            });
            writeSseEvent(res, { type: 'response.output_item.done', item: messageItem });
            writeSseEvent(res, {
              type: 'response.completed',
              response: {
                id: 'resp_first',
                output: [messageItem],
                usage: {
                  input_tokens: 40,
                  output_tokens: 20,
                  total_tokens: 60,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens_details: { reasoning_tokens: 0 }
                }
              }
            });
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }

          const messageItem = createMessageItem('msg_second_reply', secondReplyText);
          writeSseEvent(res, { type: 'response.created', response: { id: 'resp_second' } });
          writeSseEvent(res, { type: 'response.in_progress', response: { id: 'resp_second' } });
          await sleep(120);
          writeSseEvent(res, {
            type: 'response.reasoning_summary_text.delta',
            item_id: 'reasoning_second',
            delta: secondReasoningText
          });
          await sleep(1200);
          writeSseEvent(res, { type: 'response.output_item.added', item: messageItem });
          writeSseEvent(res, {
            type: 'response.output_text.delta',
            item_id: 'msg_second_reply',
            output_item_id: 'msg_second_reply',
            output_index: 0,
            content_index: 0,
            delta: secondReplyText
          });
          writeSseEvent(res, {
            type: 'response.output_text.done',
            item_id: 'msg_second_reply',
            output_item_id: 'msg_second_reply',
            output_index: 0,
            content_index: 0,
            text: secondReplyText
          });
          writeSseEvent(res, { type: 'response.output_item.done', item: messageItem });
          writeSseEvent(res, {
            type: 'response.completed',
            response: {
              id: 'resp_second',
              output: [messageItem],
              usage: {
                input_tokens: 45,
                output_tokens: 25,
                total_tokens: 70,
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
    firstReplyText,
    secondReplyText,
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
  const profileDir = path.join(outputDir, 'profile');
  await fsp.mkdir(profileDir, { recursive: true });

  let context = null;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      executablePath: chromePath,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        `--disable-extensions-except=${repoRoot}`,
        `--load-extension=${repoRoot}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-search-engine-choice-screen'
      ]
    });
    result.steps.push('browser_ready');

    let hostPage = context.pages().find((page) => page.url().startsWith('https://example.com/')) || null;
    if (!hostPage) {
      hostPage = await context.newPage();
      await hostPage.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    }
    hostPage.on('console', (msg) => {
      result.console.push({ type: msg.type(), text: msg.text() });
    });
    hostPage.on('pageerror', (error) => {
      result.console.push({ type: 'pageerror', text: String(error && (error.stack || error.message || error)) });
    });
    result.steps.push('host_page_ready');

    const extensionWorker = await waitFor(async () => (
      context.serviceWorkers().find((worker) => worker.url().endsWith('/src/extension/background.js')) || null
    ), { timeoutMs: 30000, intervalMs: 300, label: 'extension service worker' });
    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;

    await extensionWorker.evaluate(async (seed) => {
      await chrome.storage.sync.clear();
      await chrome.storage.local.clear();
      await chrome.storage.sync.set(seed);
      return true;
    }, buildStorageSeed(`${mockServer.origin}/v1/responses`));
    result.steps.push('storage_seeded');

    await extensionWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab || typeof tab.id !== 'number') throw new Error('active tab not found');
      return chrome.tabs.sendMessage(tab.id, { type: 'OPEN_SIDEBAR' });
    });
    result.steps.push('sidebar_open_requested');

    const sidebarFrame = await waitFor(async () => (
      hostPage.frames().find((frame) => (
        frame.url().startsWith('chrome-extension://')
        && frame.url().includes('/src/ui/sidebar/sidebar.html')
      )) || null
    ), { timeoutMs: 30000, intervalMs: 200, label: 'embedded sidebar frame' });
    await sidebarFrame.locator('#message-input').waitFor({ state: 'visible', timeout: 30000 });
    await waitFor(async () => {
      return await sidebarFrame.evaluate(() => Array.isArray(window.apiConfigs) && window.apiConfigs.length > 0);
    }, { timeoutMs: 15000, intervalMs: 200, label: 'sidebar api configs ready' });
    result.steps.push('sidebar_ready');

    const input = sidebarFrame.locator('#message-input');
    await input.fill('first message');
    await input.press('Enter');
    result.steps.push('first_message_sent');

    await waitFor(async () => (
      mockServer.requestLog.length >= 1 ? true : null
    ), { timeoutMs: 15000, intervalMs: 100, label: 'first request observed' });
    result.steps.push('first_request_observed');

    const initialConversation = await waitFor(async () => {
      return await sidebarFrame.evaluate((expectedText) => {
        const userMessage = document.querySelector('.message.user-message[data-message-id]');
        const aiMessage = document.querySelector('.message.ai-message[data-message-id]');
        const aiText = aiMessage?.querySelector?.('.text-content')?.innerText || '';
        if (!userMessage || !aiMessage || !aiText.includes(expectedText)) return null;
        return {
          userId: userMessage.getAttribute('data-message-id'),
          aiId: aiMessage.getAttribute('data-message-id'),
          aiCount: document.querySelectorAll('.message.ai-message').length
        };
      }, mockServer.firstReplyText);
    }, { timeoutMs: 20000, intervalMs: 150, label: 'first reply settled' });
    result.initialConversation = initialConversation;
    result.steps.push('first_reply_settled');

    await sidebarFrame.evaluate(async ({ userId, aiId }) => {
      const sender = window.cerebr?.debug?.messageSender;
      if (!sender) throw new Error('messageSender debug handle missing');
      const userElement = document.querySelector(`.message.user-message[data-message-id="${userId}"]`);
      await sender.requestConversationHistoryEdit({
        messageId: userId,
        newText: 'edited user message',
        messageElement: userElement
      });
      void sender.requestRegenerateMessage({
        originalMessageText: 'edited user message',
        messageId: userId,
        targetAiMessageId: aiId
      });
      return true;
    }, {
      userId: initialConversation.userId,
      aiId: initialConversation.aiId
    });
    result.steps.push('regenerate_requested');

    const midStreamStatusPromise = sidebarFrame.evaluate(({ aiId, finalText }) => {
      return new Promise((resolve) => {
        const sender = window.cerebr?.debug?.messageSender;
        const history = [];
        const readSnapshot = () => {
          const aiMessage = document.querySelector(`.message.ai-message[data-message-id="${aiId}"]`);
          const aiMessages = Array.from(document.querySelectorAll('.message.ai-message'));
          const loadingMessages = Array.from(document.querySelectorAll('.message.loading-message'));
          const statusText = aiMessage?.querySelector?.('.assistant-pre-response-status__text')?.innerText
            || aiMessage?.querySelector?.('.text-content')?.innerText
            || '';
          const attemptSnapshot = (typeof sender?.__debugGetActiveAttemptsSnapshot === 'function')
            ? sender.__debugGetActiveAttemptsSnapshot()
            : [];
          return {
            aiCount: aiMessages.length,
            loadingCount: loadingMessages.length,
            aiIds: aiMessages.map((el) => el.getAttribute('data-message-id') || ''),
            statusText,
            className: aiMessage?.className || '',
            reachedFinalTextEarly: statusText.includes(finalText),
            matched: /请求已发出，等待模型响应|模型正在思考|模型正在准备工具调用|模型正在生成回复/.test(statusText),
            attemptSnapshot
          };
        };
        const maybeResolve = () => {
          const snapshot = readSnapshot();
          history.push(snapshot);
          if (snapshot.matched || snapshot.reachedFinalTextEarly) {
            cleanup();
            resolve({ ...snapshot, history });
          }
        };
        const observer = new MutationObserver(() => {
          maybeResolve();
        });
        const cleanup = () => {
          try { observer.disconnect(); } catch (_) {}
          try { clearTimeout(timeoutId); } catch (_) {}
        };
        const timeoutId = setTimeout(() => {
          const snapshot = readSnapshot();
          history.push(snapshot);
          cleanup();
          resolve({ ...snapshot, matched: false, history });
        }, 2000);

        const chatRoot = document.querySelector('#chat-container') || document.body;
        observer.observe(chatRoot, {
          subtree: true,
          childList: true,
          characterData: true
        });
        maybeResolve();
      });
    }, {
      aiId: initialConversation.aiId,
      finalText: mockServer.secondReplyText
    });

    const reasoningStatePromise = sidebarFrame.evaluate(({ aiId, finalText }) => {
      return new Promise((resolve) => {
        const readSnapshot = () => {
          const aiMessage = document.querySelector(`.message.ai-message[data-message-id="${aiId}"]`);
          const statusText = aiMessage?.querySelector?.('.text-content')?.innerText || '';
          const title = aiMessage?.getAttribute?.('title') || '';
          const hasResponseActivity = !!aiMessage?.querySelector?.('.response-activity-timeline');
          return {
            title,
            statusText,
            hasResponseActivity,
            reachedFinalTextEarly: statusText.includes(finalText)
          };
        };
        const maybeResolve = () => {
          const snapshot = readSnapshot();
          if ((snapshot.hasResponseActivity && !snapshot.reachedFinalTextEarly) || snapshot.reachedFinalTextEarly) {
            cleanup();
            resolve(snapshot);
          }
        };
        const observer = new MutationObserver(() => {
          maybeResolve();
        });
        const cleanup = () => {
          try { observer.disconnect(); } catch (_) {}
          try { clearTimeout(timeoutId); } catch (_) {}
        };
        const timeoutId = setTimeout(() => {
          const snapshot = readSnapshot();
          cleanup();
          resolve(snapshot);
        }, 2000);
        const chatRoot = document.querySelector('#chat-container') || document.body;
        observer.observe(chatRoot, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['title']
        });
        maybeResolve();
      });
    }, {
      aiId: initialConversation.aiId,
      finalText: mockServer.secondReplyText
    });

    await waitFor(async () => (
      mockServer.requestLog.length >= 2 ? true : null
    ), { timeoutMs: 15000, intervalMs: 100, label: 'second request observed' });
    result.steps.push('second_request_observed');
    result.midStreamState = await midStreamStatusPromise;
    result.midStreamStatusHistory = Array.isArray(result.midStreamState?.history)
      ? result.midStreamState.history
      : [];
    if (!result.midStreamState?.matched) {
      throw new Error('Timed out waiting for mid-stream server-side status text');
    }

    result.reasoningState = await reasoningStatePromise;
    if (!result.reasoningState?.hasResponseActivity) {
      throw new Error('Timed out waiting for reasoning activity to become visible');
    }
    if (result.reasoningState.title) {
      throw new Error(`Expected empty assistant title after reasoning became visible, got: ${result.reasoningState.title}`);
    }
    if (/等待首个 token|stream_wait_first_token/i.test(result.reasoningState.statusText || '')) {
      throw new Error(`Reasoning-visible state still showed wait-first-token text: ${result.reasoningState.statusText}`);
    }

    const finalState = await waitFor(async () => {
      return await sidebarFrame.evaluate(({ aiId, expectedText }) => {
        const aiMessage = document.querySelector(`.message.ai-message[data-message-id="${aiId}"]`);
        const statusText = aiMessage?.querySelector?.('.text-content')?.innerText || '';
        if (!statusText.includes(expectedText)) return null;
        return {
          aiCount: document.querySelectorAll('.message.ai-message').length,
          loadingCount: document.querySelectorAll('.message.loading-message').length,
          statusText,
          className: aiMessage?.className || ''
        };
      }, {
        aiId: initialConversation.aiId,
        expectedText: mockServer.secondReplyText
      });
    }, { timeoutMs: 20000, intervalMs: 150, label: 'regenerated reply settled' });
    result.finalState = finalState;

    await hostPage.screenshot({ path: path.join(outputDir, '01-final.png'), fullPage: true });

    if (result.midStreamState.aiCount !== initialConversation.aiCount) {
      throw new Error(`unexpected extra ai message during regenerate: before=${initialConversation.aiCount}, now=${result.midStreamState.aiCount}`);
    }
    if (result.midStreamState.loadingCount !== 0) {
      throw new Error(`unexpected extra loading placeholder during regenerate: ${result.midStreamState.loadingCount}`);
    }
    if (result.midStreamState.reachedFinalTextEarly) {
      throw new Error(`reply content appeared before mid-stream status sampling: ${result.midStreamState.statusText}`);
    }
    if (!/请求已发出，等待模型响应|模型正在思考|模型正在准备工具调用|模型正在生成回复/.test(result.midStreamState.statusText || '')) {
      throw new Error(`status text did not advance to server-side phase: ${result.midStreamState.statusText}`);
    }
    if (/构建消息|构造请求载荷|上传请求载荷/.test(result.midStreamState.statusText || '')) {
      throw new Error(`status text is still stuck in local phase: ${result.midStreamState.statusText}`);
    }
    if (result.finalState.aiCount !== initialConversation.aiCount) {
      throw new Error(`final ai count changed unexpectedly: before=${initialConversation.aiCount}, after=${result.finalState.aiCount}`);
    }
    if (result.finalState.loadingCount !== 0) {
      throw new Error(`loading placeholder remained after regenerate: ${result.finalState.loadingCount}`);
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
