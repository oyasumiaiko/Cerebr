const fsp = require('fs/promises');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const [repoRoot, outputDir, chromePath] = process.argv.slice(2);

if (!repoRoot || !outputDir || !chromePath) {
  throw new Error(
    'Usage: node tests/browser_incremental_markdown_regression.cjs <repoRoot> <outputDir> <chromePath>'
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
  const sourceId = 'src_incremental_markdown_regression';
  const config = {
    id: 'cfg_incremental_markdown_regression',
    connectionSourceId: sourceId,
    displayName: 'Incremental Markdown Regression',
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

function createPageHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Incremental markdown regression</title>
  </head>
  <body>
    <main>
      <h1>Incremental markdown regression host</h1>
      <p>This page only exists to host the Cerebr sidebar during the regression test.</p>
    </main>
  </body>
</html>`;
}

function createMessageItem(id) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    phase: 'answer',
    status: 'completed',
    content: [{ type: 'output_text', text: '' }]
  };
}

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function buildStreamingMarkdownPayload() {
  const finalText = [
    '可以。',
    '',
    '# 1. 最表层：它首先是一种“夜晚的物理质感”',
    '',
    '说“柏林夜生活气味”，很多人脑子里先出来的，不是香水味，而是这些东西混在一起：',
    '',
    '- 混凝土和旧砖墙的灰尘感',
    '- 地下室、仓库、废弃工业建筑的潮气',
    '- 冬夜空气的冷冽',
    '',
    '# 2. 声音层面：为什么一听就像“柏林”',
    '',
    '## 常见元素',
    '',
    '- 强拍、机械重复',
    '- 低频很硬',
    '- 鼓点像机器运转',
    '',
    '# 9. 这个“气味”也不是全是真的，它有神话成分',
    '',
    '这点也要说清楚。',
    '“柏林夜生活气味”不是纯客观事实，它也包含大量被反复传播的城市神话。',
    '',
    '## 神话版本里的柏林夜生活',
    '',
    '- 最自由',
    '- 最地下',
    '',
    '## 现实里的柏林夜生活',
    '',
    '- 也会商业化',
    '- 也会被游客消费',
    '',
    'Brutalismus 3000 有意思的地方就在于：',
    '他们一方面明显在利用这种“柏林感”，另一方面又在扭曲它。'
  ].join('\n');

  const chunkSizes = [8, 22, 31, 57, 41, 63, 29, 44, 33, 38, 9999];
  const deltas = [];
  let offset = 0;
  for (const size of chunkSizes) {
    if (offset >= finalText.length) break;
    deltas.push(finalText.slice(offset, offset + size));
    offset += size;
  }
  if (offset < finalText.length) {
    deltas.push(finalText.slice(offset));
  }

  return { finalText, deltas };
}

async function runMockResponsesServer() {
  const requestLog = [];
  const pageHtml = createPageHtml();
  const { finalText, deltas } = buildStreamingMarkdownPayload();

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
          const messageItem = createMessageItem('msg_markdown_regression');

          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
            'access-control-allow-origin': '*'
          });

          writeSseEvent(res, { type: 'response.created', response: { id: 'resp_markdown_regression' } });
          writeSseEvent(res, { type: 'response.in_progress', response: { id: 'resp_markdown_regression' } });
          writeSseEvent(res, { type: 'response.output_item.added', item: messageItem });

          let accumulated = '';
          for (const delta of deltas) {
            accumulated += delta;
            writeSseEvent(res, {
              type: 'response.output_text.delta',
              item_id: 'msg_markdown_regression',
              output_item_id: 'msg_markdown_regression',
              output_index: 0,
              content_index: 0,
              delta
            });
            await sleep(150);
          }

          writeSseEvent(res, {
            type: 'response.output_text.done',
            item_id: 'msg_markdown_regression',
            output_item_id: 'msg_markdown_regression',
            output_index: 0,
            content_index: 0,
            text: accumulated
          });
          writeSseEvent(res, {
            type: 'response.output_item.done',
            item: {
              ...messageItem,
              content: [{ type: 'output_text', text: accumulated }]
            }
          });
          writeSseEvent(res, {
            type: 'response.completed',
            response: {
              id: 'resp_markdown_regression',
              output: [{
                ...messageItem,
                content: [{ type: 'output_text', text: accumulated }]
              }],
              usage: {
                input_tokens: 100,
                output_tokens: 100,
                total_tokens: 200,
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
    finalText,
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
  await fsp.mkdir(profileDir, { recursive: true });
  result.profileDir = profileDir;

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
    result.steps.push('extension_id_resolved');

    await extensionWorker.evaluate(async (seed) => {
      await chrome.storage.sync.clear();
      await chrome.storage.local.clear();
      await chrome.storage.sync.set(seed);
      return true;
    }, buildStorageSeed(`${mockServer.origin}/v1/responses`));
    result.steps.push('storage_seeded');

    await extensionWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab || typeof tab.id !== 'number') {
        throw new Error('active tab not found');
      }
      return await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_SIDEBAR' });
    });
    result.steps.push('sidebar_open_requested');

    const sidebarFrame = await waitFor(async () => (
      hostPage.frames().find((frame) => frame.url().startsWith(`chrome-extension://${extensionId}/src/ui/sidebar/sidebar.html`)) || null
    ), { timeoutMs: 30000, intervalMs: 200, label: 'embedded sidebar frame' });
    await sidebarFrame.locator('#message-input').waitFor({ state: 'visible', timeout: 30000 });
    result.sidebarStorageSnapshot = await waitFor(async () => {
      return await sidebarFrame.evaluate(async () => {
        const syncSnapshot = await globalThis.chrome.storage.sync.get(null);
        const apiConfigsLength = Array.isArray(window.apiConfigs) ? window.apiConfigs.length : null;
        if (!(apiConfigsLength > 0)) return null;
        return {
          syncKeys: Object.keys(syncSnapshot).sort(),
          apiConfigsLength,
          apiConfigBaseUrls: window.apiConfigs.map((config) => config?.baseUrl || '')
        };
      });
    }, { timeoutMs: 15000, intervalMs: 200, label: 'sidebar api config ready' });
    result.steps.push('sidebar_ready');

    const input = sidebarFrame.locator('#message-input');
    await input.focus();
    await input.fill('请解释一下柏林夜生活气味。');
    await input.press('Enter');
    result.steps.push('message_sent');

    result.firstRequestObserved = await waitFor(async () => (
      mockServer.requestLog.length >= 1 ? { count: mockServer.requestLog.length } : null
    ), { timeoutMs: 15000, intervalMs: 100, label: 'first mock responses request' });
    result.steps.push('first_request_observed');

    result.selectionSeedText = await waitFor(async () => {
      return await sidebarFrame.evaluate(() => {
        const paragraph = Array.from(document.querySelectorAll('.message.ai-message .text-content p'))
          .find((element) => (element.textContent || '').includes('说“柏林夜生活气味”'));
        if (!paragraph) return null;
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        const selection = window.getSelection?.();
        if (!selection) return null;
        selection.removeAllRanges();
        selection.addRange(range);
        const text = selection.toString();
        return text.includes('说“柏林夜生活气味”') ? text : null;
      });
    }, { timeoutMs: 10000, intervalMs: 100, label: 'selection seeded during streaming' });
    result.steps.push('selection_seeded');

    result.selectionSurvivedDuringStreaming = await waitFor(async () => {
      return await sidebarFrame.evaluate(() => {
        const selectionText = window.getSelection?.()?.toString?.() || '';
        const textRoot = document.querySelector('.message.ai-message .text-content');
        const currentText = textRoot?.innerText || '';
        if (!currentText.includes('现实里的柏林夜生活')) return null;
        return selectionText.includes('说“柏林夜生活气味”')
          ? selectionText
          : null;
      });
    }, { timeoutMs: 10000, intervalMs: 100, label: 'selection survives while later blocks render' });
    result.steps.push('selection_survived_during_streaming');

    await sidebarFrame.evaluate(() => {
      window.getSelection?.()?.removeAllRanges?.();
      return true;
    });

    const settled = await waitFor(async () => {
      return await sidebarFrame.evaluate(() => {
        const message = document.querySelector('.message.ai-message[data-response-runtime-status="completed"], .message.ai-message:not(.loading-message):not(.updating)');
        const textContent = message?.querySelector?.('.text-content');
        if (!textContent) return null;
        const originalText = message?.getAttribute?.('data-original-text') || '';
        return originalText.includes('这个“气味”也不是全是真的，它有神话成分')
          ? true
          : null;
      });
    }, { timeoutMs: 30000, intervalMs: 200, label: 'assistant markdown settled' });
    result.settled = settled;
    result.requestLogLength = mockServer.requestLog.length;

    result.renderAnalysis = await sidebarFrame.evaluate(() => {
      const message = document.querySelector('.message.ai-message[data-original-text*="这个“气味”也不是全是真的"]');
      const textRoot = message?.querySelector?.('.text-content');
      if (!message || !textRoot) {
        return { found: false };
      }
      const blockTexts = Array.from(textRoot.children).map((element) => ({
        tag: String(element.tagName || '').toLowerCase(),
        text: (element.textContent || '').replace(/\s+/g, ' ').trim()
      }));
      const emptyHeadingCount = blockTexts.filter((block) => /^h[1-6]$/.test(block.tag) && !block.text).length;
      const prefixDuplicatePairs = [];
      for (let i = 0; i < blockTexts.length - 1; i += 1) {
        const current = blockTexts[i];
        const next = blockTexts[i + 1];
        if (!current.text || !next.text) continue;
        if (current.text === next.text) {
          prefixDuplicatePairs.push({ kind: 'equal', index: i, current: current.text, next: next.text });
          continue;
        }
        if (next.text.startsWith(current.text) || current.text.startsWith(next.text)) {
          prefixDuplicatePairs.push({ kind: 'prefix', index: i, current: current.text, next: next.text });
        }
      }
      return {
        found: true,
        originalText: message.getAttribute('data-original-text') || '',
        textContentHtml: textRoot.innerHTML,
        blockTexts,
        emptyHeadingCount,
        prefixDuplicatePairs
      };
    });

    await hostPage.screenshot({ path: path.join(outputDir, '01-final.png'), fullPage: true });

    if (!result.renderAnalysis?.found) {
      throw new Error('failed to locate rendered assistant message');
    }
    if (result.renderAnalysis.emptyHeadingCount !== 0) {
      throw new Error(`unexpected empty heading count: ${result.renderAnalysis.emptyHeadingCount}`);
    }
    if ((result.renderAnalysis.prefixDuplicatePairs || []).length > 0) {
      throw new Error(`unexpected prefix duplicate blocks: ${JSON.stringify(result.renderAnalysis.prefixDuplicatePairs)}`);
    }
    if (!String(result.renderAnalysis.originalText || '').includes('这个“气味”也不是全是真的，它有神话成分')) {
      throw new Error('assistant data-original-text did not settle to the expected final markdown');
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
