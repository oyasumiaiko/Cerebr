const fsp = require('fs/promises');
const http = require('http');
const net = require('net');
const path = require('path');
const {
  buildSendContentMessageExpression,
  launchFixedSidebarContext,
  loadPlaywright,
  resolveFixedSidebarProfileDir,
  resolveStableChromeExecutablePath,
  shouldRunHeadless,
  waitFor,
  waitForExtensionWorker,
  waitForSidebarFrame
} = require('./lib/stable_chrome_sidebar_harness.cjs');
const {
  launchWorktreeUnpackedChromiumContext,
  resolveWorktreeUnpackedProfileDir,
  waitForWorktreeExtensionWorker
} = require('./lib/worktree_unpacked_extension_harness.cjs');

const EXPECTED_DOC_PATH = 'docs/长文档标题.md';
const LONG_TEXT_LINES = Array.from(
  { length: 24 },
  (_, index) => `这是第 ${index + 1} 行内容，用于触发长文本转文档提示。${'这是一段额外的长文本填充。'.repeat(8)}`
);
const LONG_TEXT = ['# 长文档标题', '', ...LONG_TEXT_LINES].join('\n');
const LONG_TEXT_UNIQUE_SENTINEL = LONG_TEXT_LINES[LONG_TEXT_LINES.length - 1];

const [rawRepoRoot, outputDir, rawArg3 = '', rawArg4 = ''] = process.argv.slice(2);
const repoRoot = rawRepoRoot ? path.resolve(rawRepoRoot) : '';
const launchMode = (rawArg3 === 'stable' || rawArg3 === 'worktree_unpacked')
  ? rawArg3
  : ((rawArg4 === 'stable' || rawArg4 === 'worktree_unpacked') ? rawArg4 : 'stable');
const chromePath = (launchMode === rawArg3) ? '' : rawArg3;

if (!repoRoot || !outputDir || (launchMode === 'stable' && !chromePath)) {
  throw new Error(
    'Usage: node tests/cdp_conversation_document_long_text_regression.cjs <repoRoot> <outputDir> [chromePath] [mode=stable|worktree_unpacked]'
  );
}

const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);

function createPageHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Conversation Document Long Text Regression</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(254, 240, 138, 0.85), rgba(254, 240, 138, 0) 42%),
          linear-gradient(140deg, #172554 0%, #1d4ed8 54%, #38bdf8 100%);
        color: #eff6ff;
      }
      main {
        max-width: 760px;
        padding: 48px;
      }
      .hero {
        padding: 28px 32px;
        border-radius: 28px;
        background: rgba(255, 255, 255, 0.12);
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.26);
        backdrop-filter: blur(10px);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 40px;
        line-height: 1.05;
      }
      p {
        margin: 0;
        font-size: 18px;
        line-height: 1.6;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <h1>Conversation Document Long Text Regression</h1>
        <p>This page validates the “long text to document” prompt before sending a request.</p>
      </section>
    </main>
  </body>
</html>`;
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
  const sourceId = 'src_conversation_document_long_text_regression';
  const config = {
    id: 'cfg_conversation_document_long_text_regression',
    connectionSourceId: sourceId,
    displayName: 'Conversation Document Long Text Regression',
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
      store: false
    }
  };
  const source = {
    id: sourceId,
    name: 'Mock Long Text Source',
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

async function writeResultSnapshot(outputDir, result) {
  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.writeFile(
    path.join(outputDir, 'result.json'),
    JSON.stringify(result, null, 2),
    'utf8'
  );
}

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function runServer() {
  const pageHtml = createPageHtml();
  const requestLog = [];
  const server = http.createServer(async (req, res) => {
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
        const parsed = JSON.parse(body);
        requestLog.push(parsed);

        const finalText = 'LONG_TEXT_DOCUMENT_OK_20260415';
        const messageItem = createMessageItem('msg_long_text_document', finalText);
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'close',
          'access-control-allow-origin': '*'
        });
        writeSseEvent(res, { type: 'response.created', response: { id: 'resp_long_text_document' } });
        writeSseEvent(res, { type: 'response.in_progress', response: { id: 'resp_long_text_document' } });
        writeSseEvent(res, { type: 'response.output_item.added', item: messageItem });
        writeSseEvent(res, {
          type: 'response.output_text.delta',
          item_id: 'msg_long_text_document',
          output_item_id: 'msg_long_text_document',
          output_index: 0,
          content_index: 0,
          delta: finalText
        });
        writeSseEvent(res, {
          type: 'response.output_text.done',
          item_id: 'msg_long_text_document',
          output_item_id: 'msg_long_text_document',
          output_index: 0,
          content_index: 0,
          text: finalText
        });
        writeSseEvent(res, { type: 'response.output_item.done', item: messageItem });
        writeSseEvent(res, {
          type: 'response.completed',
          response: {
            id: 'resp_long_text_document',
            output: [messageItem],
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
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

async function getExtensionWorker(context, launchMode) {
  return launchMode === 'worktree_unpacked'
    ? waitForWorktreeExtensionWorker(context, { timeoutMs: 30_000 })
    : waitForExtensionWorker(context, { timeoutMs: 30_000 });
}

async function openSidebar(extensionWorker) {
  return await waitFor(async () => {
    const payload = await extensionWorker.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'OPEN_SIDEBAR' }))
    );
    return payload?.response?.status === true ? payload : null;
  }, {
    timeoutMs: 20_000,
    intervalMs: 250,
    label: 'sidebar open acknowledgement'
  });
}

async function waitForSidebarVisible(extensionWorker) {
  return await waitFor(async () => {
    const payload = await extensionWorker.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
    );
    return payload?.response?.debugState?.isActuallyVisible ? payload.response.debugState : null;
  }, {
    timeoutMs: 20_000,
    intervalMs: 250,
    label: 'sidebar visibility'
  });
}

async function waitForSidebarReady(page, extensionId) {
  const sidebarFrame = await waitForSidebarFrame(page, extensionId, { timeoutMs: 30_000 });
  await sidebarFrame.locator('#message-input').waitFor({ state: 'visible', timeout: 30_000 });
  await waitFor(
    () => sidebarFrame.evaluate(() => Array.isArray(window.apiConfigs) && window.apiConfigs.length > 0),
    { timeoutMs: 20_000, intervalMs: 250, label: 'sidebar api configs ready' }
  );
  return sidebarFrame;
}

async function readIndexedDbDocument(sidebarFrame, conversationId, filePath) {
  return await sidebarFrame.evaluate(async ({ conversationId: id, filePath: pathValue }) => {
    const openDb = () => new Promise((resolve, reject) => {
      const request = window.indexedDB.open('ChatHistoryDB');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction('conversation_documents', 'readonly');
        const store = transaction.objectStore('conversation_documents');
        const request = store.get([id, pathValue]);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result || null);
      });
    } finally {
      db.close();
    }
  }, { conversationId, filePath });
}

async function collectSidebarDebugState(sidebarFrame) {
  return await sidebarFrame.evaluate(async () => {
    const currentConversationId = window.cerebr?.debug?.messageSender?.getCurrentConversationId?.() || '';
    const openDb = () => new Promise((resolve, reject) => {
      const request = window.indexedDB.open('ChatHistoryDB');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });

    let indexedDbDoc = null;
    if (currentConversationId) {
      const db = await openDb().catch(() => null);
      if (db) {
        try {
          indexedDbDoc = await new Promise((resolve, reject) => {
            const transaction = db.transaction('conversation_documents', 'readonly');
            const store = transaction.objectStore('conversation_documents');
            const request = store.get([currentConversationId, 'docs/长文档标题.md']);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result || null);
          }).catch(() => null);
        } finally {
          db.close();
        }
      }
    }

    return {
      inputText: document.querySelector('#message-input')?.textContent || '',
      promptExists: !!document.querySelector('.composer-document-prompt'),
      currentConversationId,
      indexedDbDoc,
      attempts: (typeof window.cerebr?.debug?.messageSender?.__debugGetActiveAttemptsSnapshot === 'function')
        ? window.cerebr.debug.messageSender.__debugGetActiveAttemptsSnapshot()
        : null,
      notifications: Array.from(document.querySelectorAll('.notification')).map((element) => (element.innerText || '').trim()),
      userMessages: Array.from(document.querySelectorAll('.message.user-message')).map((element) => ({
        text: (element.innerText || '').trim(),
        originalText: element.getAttribute('data-original-text') || ''
      })),
      aiMessages: Array.from(document.querySelectorAll('.message.ai-message')).map((element) => (element.innerText || '').trim())
    };
  }).catch(() => null);
}

async function main() {
  let server = null;
  let context = null;
  const result = {
    startedAt: new Date().toISOString(),
    outputDir,
    launchMode,
    headless: runHeadless,
    steps: []
  };
  global.__conversationDocumentLongTextRegressionPartialResult = result;

  try {
    server = await runServer();
    const storageSeed = buildStorageSeed(`${server.origin}/v1/responses`);

    if (launchMode === 'worktree_unpacked') {
      const profileDir = resolveWorktreeUnpackedProfileDir(repoRoot, 'conversation-document-long-text');
      result.profileDir = profileDir;
      context = await launchWorktreeUnpackedChromiumContext({
        chromium,
        repoRoot,
        profileDir,
        headless: runHeadless
      });
    } else {
      const chromeExecutable = resolveStableChromeExecutablePath(chromePath);
      const profileDir = resolveFixedSidebarProfileDir(repoRoot, 'conversation-document-long-text');
      result.profileDir = profileDir;
      context = await launchFixedSidebarContext({
        chromium,
        executablePath: chromeExecutable,
        profileDir,
        headless: runHeadless
      });
    }
    result.steps.push('browser_ready');

    const page = await context.newPage();
    await page.goto(server.origin, { waitUntil: 'domcontentloaded' });
    result.steps.push('page_loaded');

    const extensionWorker = await getExtensionWorker(context, launchMode);
    result.steps.push('worker_ready');

    await extensionWorker.evaluate(`(async () => {
      await chrome.storage.sync.clear();
      await chrome.storage.sync.set(${JSON.stringify(storageSeed)});
      return true;
    })()`);
    result.steps.push('storage_seeded');

    result.openSidebarResponse = await openSidebar(extensionWorker);
    result.steps.push('sidebar_open_requested');
    await waitForSidebarVisible(extensionWorker);
    result.steps.push('sidebar_visible');

    const extensionId = extensionWorker.url().split('/')[2] || '';
    result.extensionId = extensionId;
    const sidebarFrame = await waitForSidebarReady(page, extensionId);
    result.steps.push('sidebar_ready');

    const pageConsoleLogs = [];
    page.on('console', (message) => {
      const type = message?.type?.() || '';
      if (type === 'debug' || type === 'warning' || type === 'error') {
        pageConsoleLogs.push(`${type}: ${message.text()}`);
      }
    });

    await sidebarFrame.locator('#message-input').fill(LONG_TEXT);
    await sidebarFrame.locator('#message-input').press('Enter');
    result.steps.push('long_text_entered');

    await sidebarFrame.locator('.composer-document-prompt').waitFor({ state: 'visible', timeout: 20_000 });
    result.steps.push('long_text_prompt_visible');

    await sidebarFrame.locator('.composer-document-prompt__button.is-primary').click();
    result.steps.push('long_text_converted');

    try {
      await waitFor(async () => server.requestLog.length >= 1 ? true : null, {
        timeoutMs: 30_000,
        intervalMs: 200,
        label: 'mock long text request'
      });
    } catch (error) {
      result.debugStateBeforeRequest = await collectSidebarDebugState(sidebarFrame);
      result.pageConsoleLogs = pageConsoleLogs.slice(-30);
      throw error;
    }
    result.steps.push('request_sent');

    const serializedRequest = JSON.stringify(server.requestLog[0] || {});
    result.requestContainsLink = serializedRequest.includes(EXPECTED_DOC_PATH);
    result.requestContainsLongTextTail = serializedRequest.includes(LONG_TEXT_UNIQUE_SENTINEL);
    if (!result.requestContainsLink) {
      throw new Error(`request body missing converted document link: ${serializedRequest}`);
    }
    if (result.requestContainsLongTextTail) {
      throw new Error(`request body still contains original long text tail: ${serializedRequest}`);
    }

    result.conversationId = await waitFor(async () => {
      const id = await sidebarFrame.evaluate(() => (
        window.cerebr?.debug?.messageSender?.getCurrentConversationId?.() || ''
      )).catch(() => '');
      return id || null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 200,
      label: 'conversation id after long text conversion'
    });
    result.steps.push('conversation_created');

    result.indexedDbDocument = await readIndexedDbDocument(sidebarFrame, result.conversationId, EXPECTED_DOC_PATH);
    if (!result.indexedDbDocument || result.indexedDbDocument.content !== LONG_TEXT) {
      throw new Error(`indexeddb document mismatch: ${JSON.stringify(result.indexedDbDocument)}`);
    }
    result.steps.push('document_persisted');

    result.promptClosed = await sidebarFrame.evaluate(() => !document.querySelector('.composer-document-prompt'));
    if (!result.promptClosed) {
      throw new Error('long text prompt should be closed after conversion');
    }
    result.steps.push('prompt_closed');

    result.finalAssistantText = await waitFor(async () => {
      const texts = await sidebarFrame.evaluate(() => (
        Array.from(document.querySelectorAll('.message.ai-message'))
          .map((element) => (element.innerText || '').trim())
          .filter(Boolean)
      ));
      const last = texts[texts.length - 1] || '';
      return last.includes('LONG_TEXT_DOCUMENT_OK_20260415') ? last : null;
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: 'final assistant text'
    });
    result.steps.push('assistant_completed');

    await sidebarFrame.locator('body').screenshot({
      path: path.join(outputDir, 'sidebar-body-final.png')
    }).catch(() => {});

    result.ok = true;
    result.finishedAt = new Date().toISOString();
    await writeResultSnapshot(outputDir, result);
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    await server?.close?.().catch(() => {});
  }
}

main().then(() => {
  process.exit(0);
}).catch(async (error) => {
  const partial = global.__conversationDocumentLongTextRegressionPartialResult
    && typeof global.__conversationDocumentLongTextRegressionPartialResult === 'object'
    ? global.__conversationDocumentLongTextRegressionPartialResult
    : {};
  const failure = {
    ...partial,
    ok: false,
    error: String(error && (error.stack || error.message || error))
  };
  try {
    await writeResultSnapshot(outputDir, failure);
  } catch (_) {}
  console.error(error);
  process.exit(1);
});
