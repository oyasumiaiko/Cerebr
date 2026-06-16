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

const EXPECTED_DOC_PATH = '手动文档.md';
const EXPECTED_DOC_CONTENT = '# 手动文档\n\n来自输入区。\n';

const [rawRepoRoot, outputDir, rawArg3 = '', rawArg4 = ''] = process.argv.slice(2);
const repoRoot = rawRepoRoot ? path.resolve(rawRepoRoot) : '';
const launchMode = (rawArg3 === 'stable' || rawArg3 === 'worktree_unpacked')
  ? rawArg3
  : ((rawArg4 === 'stable' || rawArg4 === 'worktree_unpacked') ? rawArg4 : 'stable');
const chromePath = (launchMode === rawArg3) ? '' : rawArg3;

if (!repoRoot || !outputDir || (launchMode === 'stable' && !chromePath)) {
  throw new Error(
    'Usage: node tests/cdp_conversation_document_input_regression.cjs <repoRoot> <outputDir> [chromePath] [mode=stable|worktree_unpacked]'
  );
}

const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);

function createPageHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Conversation Document Input Regression</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(220, 252, 231, 0.9), rgba(220, 252, 231, 0) 40%),
          linear-gradient(135deg, #0f172a 0%, #1d4ed8 55%, #38bdf8 100%);
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
        <h1>Conversation Document Input Regression</h1>
        <p>This page validates the manual create-document panel inside the embedded sidebar.</p>
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
  const sourceId = 'src_conversation_document_input_regression';
  const config = {
    id: 'cfg_conversation_document_input_regression',
    connectionSourceId: sourceId,
    displayName: 'Conversation Document Input Regression',
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
    name: 'Mock Input Source',
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

async function writeResultSnapshot(outputDir, result) {
  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.writeFile(
    path.join(outputDir, 'result.json'),
    JSON.stringify(result, null, 2),
    'utf8'
  );
}

async function runStaticServer() {
  const pageHtml = createPageHtml();
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end(pageHtml);
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
  global.__conversationDocumentInputRegressionPartialResult = result;

  try {
    server = await runStaticServer();
    const storageSeed = buildStorageSeed(server.origin);

    if (launchMode === 'worktree_unpacked') {
      const profileDir = resolveWorktreeUnpackedProfileDir(repoRoot, 'conversation-document-input');
      result.profileDir = profileDir;
      context = await launchWorktreeUnpackedChromiumContext({
        chromium,
        repoRoot,
        profileDir,
        headless: runHeadless
      });
    } else {
      const chromeExecutable = resolveStableChromeExecutablePath(chromePath);
      const profileDir = resolveFixedSidebarProfileDir(repoRoot, 'conversation-document-input');
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

    let extensionWorker = await getExtensionWorker(context, launchMode);
    result.steps.push('worker_ready');

    await page.evaluate((entries) => {
      Object.entries(entries).forEach(([key, value]) => {
        if (typeof value === 'string') {
          localStorage.setItem(key, value);
        } else {
          localStorage.setItem(key, JSON.stringify(value));
        }
      });
    }, storageSeed);
    result.steps.push('storage_seeded');

    result.openSidebarResponse = await openSidebar(extensionWorker);
    result.steps.push('sidebar_open_requested');
    await waitForSidebarVisible(extensionWorker);
    result.steps.push('sidebar_visible');

    const extensionId = extensionWorker.url().split('/')[2] || '';
    result.extensionId = extensionId;
    const sidebarFrame = await waitForSidebarReady(page, extensionId);
    result.steps.push('sidebar_ready');

    await sidebarFrame.locator('#document-button').click();
    result.steps.push('document_panel_opened');
    await sidebarFrame.locator('.composer-document-panel__textarea').fill(EXPECTED_DOC_CONTENT);
    await sidebarFrame.locator('.composer-document-panel__button.is-primary').click();
    result.steps.push('document_created');

    result.inputText = await waitFor(async () => {
      const text = await sidebarFrame.locator('#message-input').textContent().catch(() => null);
      return text && text.includes(EXPECTED_DOC_PATH) ? text.trim() : null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 200,
      label: 'document markdown link inserted into composer'
    });
    result.steps.push('document_link_inserted');

    result.conversationId = await waitFor(async () => {
      const id = await sidebarFrame.evaluate(() => (
        window.cerebr?.debug?.messageSender?.getCurrentConversationId?.() || ''
      )).catch(() => '');
      return id || null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 200,
      label: 'conversation id after manual document create'
    });
    result.steps.push('conversation_created');

    result.indexedDbDocument = await readIndexedDbDocument(sidebarFrame, result.conversationId, EXPECTED_DOC_PATH);
    if (!result.indexedDbDocument || result.indexedDbDocument.content !== EXPECTED_DOC_CONTENT) {
      throw new Error(`indexeddb document mismatch: ${JSON.stringify(result.indexedDbDocument)}`);
    }
    result.steps.push('document_persisted');

    result.panelClosed = await sidebarFrame.evaluate(() => !document.querySelector('.composer-document-panel'));
    if (!result.panelClosed) {
      throw new Error('document create panel should be closed after successful creation');
    }
    result.steps.push('document_panel_closed');

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
  const partial = global.__conversationDocumentInputRegressionPartialResult
    && typeof global.__conversationDocumentInputRegressionPartialResult === 'object'
    ? global.__conversationDocumentInputRegressionPartialResult
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
