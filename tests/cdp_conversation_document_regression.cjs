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

const MD_DOC_PATH = '随笔-关于学习与判断.md';
const TXT_DOC_PATH = '文本文档.txt';
const CODE_DOC_PATH = 'snippets/example.js';
const HTML_DOC_PATH = 'preview.html';
const PATCH_CALL_ID = 'call_conversation_document_apply_patch_1';
const EXPECTED_FINAL_MARKER = 'CONVERSATION_DOCUMENT_TOOL_OK_20260413';
const INITIAL_MD_DOC_CONTENT = '# 随笔\n\n第一版内容。\n';
const INITIAL_TXT_DOC_CONTENT = '# 文本标题\n\n这是一段可以切换为 Markdown 渲染的 txt 内容。\n';
const INITIAL_CODE_DOC_CONTENT = 'const answer = 42;\nconsole.log(answer);\n';
const INITIAL_HTML_DOC_CONTENT = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '  <head>',
  '    <meta charset="utf-8" />',
  '    <title>HTML Preview Regression</title>',
  '    <style>',
  '      body { margin: 0; font-family: system-ui, sans-serif; background: #f7fbff; color: #14213d; }',
  '      main { min-height: 180px; display: grid; place-items: center; padding: 32px; }',
  '      h1 { margin: 0; font-size: 28px; }',
  '      p { margin: 8px 0 0; }',
  '    </style>',
  '  </head>',
  '  <body>',
  '    <main>',
  '      <section>',
  '        <h1 id="html-preview-title">HTML preview rendered</h1>',
  '        <p id="html-preview-script-status">script pending</p>',
  '        <p>Created by the virtual file tool and rendered inside the document card.</p>',
  '        <script>',
  '          window.__cerebrInlineScriptRan = true;',
  '          document.getElementById("html-preview-script-status").textContent = "inline script ran";',
  '        </script>',
  '      </section>',
  '    </main>',
  '  </body>',
  '</html>'
].join('\n');
const EDITED_MD_DOC_CONTENT = '# 随笔\n\n第二版内容。\n';
const EXPECTED_DOWNLOAD_NAME = 'workspace__随笔-关于学习与判断.md';

const [rawRepoRoot, outputDir, rawArg3 = '', rawArg4 = '', rawArg5 = ''] = process.argv.slice(2);
const repoRoot = rawRepoRoot ? path.resolve(rawRepoRoot) : '';
const launchMode = (rawArg3 === 'stable' || rawArg3 === 'worktree_unpacked')
  ? rawArg3
  : ((rawArg4 === 'stable' || rawArg4 === 'worktree_unpacked') ? rawArg4 : 'stable');
const chromePath = (launchMode === rawArg3) ? '' : rawArg3;
const focusedApplyPatchRegression = rawArg5 === 'apply_patch_streaming';

if (!repoRoot || !outputDir || (launchMode === 'stable' && !chromePath)) {
  throw new Error(
    'Usage: node tests/cdp_conversation_document_regression.cjs <repoRoot> <outputDir> [chromePath] [mode=stable|worktree_unpacked] [case=apply_patch_streaming]'
  );
}

const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);

function createApplyPatchInput() {
  return [
    '*** Begin Patch',
    `*** Add File: ${MD_DOC_PATH}`,
    ...INITIAL_MD_DOC_CONTENT.replace(/\n$/, '').split('\n').map((line) => `+${line}`),
    `*** Add File: ${TXT_DOC_PATH}`,
    ...INITIAL_TXT_DOC_CONTENT.replace(/\n$/, '').split('\n').map((line) => `+${line}`),
    `*** Add File: ${CODE_DOC_PATH}`,
    ...INITIAL_CODE_DOC_CONTENT.replace(/\n$/, '').split('\n').map((line) => `+${line}`),
    `*** Add File: ${HTML_DOC_PATH}`,
    ...INITIAL_HTML_DOC_CONTENT.replace(/\n$/, '').split('\n').map((line) => `+${line}`),
    '*** End Patch'
  ].join('\n');
}

function createPageHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Conversation Document Regression</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Georgia, serif;
        background:
          radial-gradient(circle at top left, rgba(255, 244, 197, 0.85), rgba(255, 244, 197, 0) 42%),
          linear-gradient(140deg, #102542 0%, #1b3b6f 54%, #3a7ca5 100%);
        color: #f6f7fb;
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
        font-size: 44px;
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
        <h1>Conversation Document Regression</h1>
        <p>This page hosts the embedded sidebar while a mock Responses server drives the document tool flow.</p>
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
  const sourceId = 'src_conversation_document_regression';
  const config = {
    id: 'cfg_conversation_document_regression',
    connectionSourceId: sourceId,
    displayName: 'Conversation Document Regression',
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

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function createCustomToolCallItem(input = '') {
  return {
    id: `ctc_${PATCH_CALL_ID}`,
    type: 'custom_tool_call',
    call_id: PATCH_CALL_ID,
    name: 'apply_patch',
    input,
    status: 'completed'
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

function collectToolOutputText(outputItem) {
  const output = Array.isArray(outputItem?.output) ? outputItem.output : [];
  return output
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.value === 'string') return part.value;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

async function writeResultSnapshot(outputDir, result) {
  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.writeFile(
    path.join(outputDir, 'result.json'),
    JSON.stringify(result, null, 2),
    'utf8'
  );
}

async function runMockResponsesServer() {
  const requestLog = [];
  let firstRequestTools = [];
  let customToolCallOutputText = '';
  let customInputStreamStage = 0;
  let customInputDoneSent = false;
  const acknowledgedPreviewStages = new Set();
  const previewStageWaiters = new Map();
  const pageHtml = createPageHtml();

  function waitForPreviewStageAcknowledgement(stage) {
    if (acknowledgedPreviewStages.has(stage)) return Promise.resolve();
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        previewStageWaiters.delete(stage);
        resolve();
      }, 25_000);
      previewStageWaiters.set(stage, () => {
        clearTimeout(timeoutId);
        resolve();
      });
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/favicon.ico') {
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
        return;
      }
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
            firstRequestTools = (Array.isArray(parsed?.tools) ? parsed.tools : [])
              .map((tool) => ({ type: tool?.type || '', name: tool?.name || '' }));
          }

          const inputItems = Array.isArray(parsed?.input) ? parsed.input : [];
          const customToolOutput = inputItems.find((item) => (
            item?.type === 'custom_tool_call_output' && item?.call_id === PATCH_CALL_ID
          ));

          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'close',
            'access-control-allow-origin': '*'
          });
          res.socket?.setNoDelay(true);
          res.flushHeaders?.();
          // 避免真实 Chrome 对极短的首批 chunk 做网络层缓冲；这是 SSE comment，
          // 不会进入 Cerebr 的事件 parser，也不改变被测 custom tool 协议。
          res.write(`: ${' '.repeat(2048)}\n\n`);

          if (!customToolOutput) {
            const fullInput = createApplyPatchInput();
            const inputLines = fullInput.split('\n');
            const inputChunks = [
              `${inputLines.slice(0, 5).join('\n')}\n`,
              `${inputLines.slice(5, 10).join('\n')}\n`,
              inputLines.slice(10).join('\n')
            ];
            const pendingCall = createCustomToolCallItem('');
            writeSseEvent(res, { type: 'response.created', response: { id: 'resp_1' } });
            writeSseEvent(res, { type: 'response.in_progress', response: { id: 'resp_1' } });
            writeSseEvent(res, { type: 'response.output_item.added', output_index: 0, item: pendingCall });
            for (let index = 0; index < inputChunks.length; index += 1) {
              writeSseEvent(res, {
                type: 'response.custom_tool_call_input.delta',
                item_id: pendingCall.id,
                output_index: 0,
                delta: inputChunks[index]
              });
              customInputStreamStage = index + 1;
              if (index < inputChunks.length - 1) {
                await waitForPreviewStageAcknowledgement(index + 1);
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 900));
            customInputDoneSent = true;
            const completedCall = createCustomToolCallItem(fullInput);
            writeSseEvent(res, {
              type: 'response.custom_tool_call_input.done',
              item_id: completedCall.id,
              output_index: 0,
              input: fullInput
            });
            writeSseEvent(res, { type: 'response.output_item.done', output_index: 0, item: completedCall });
            writeSseEvent(res, {
              type: 'response.completed',
              response: {
                id: 'resp_1',
                output: [completedCall],
                usage: {
                  input_tokens: 90,
                  output_tokens: 12,
                  total_tokens: 102,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens_details: { reasoning_tokens: 0 }
                }
              }
            });
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }

          customToolCallOutputText = collectToolOutputText(customToolOutput);
          const finalText = [
            EXPECTED_FINAL_MARKER,
            '',
            `[Markdown 文档](${MD_DOC_PATH})`,
            `[文本说明](${TXT_DOC_PATH})`,
            `[代码示例](${CODE_DOC_PATH})`,
            `[HTML 预览](${HTML_DOC_PATH})`
          ].join('\n');
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
                input_tokens: 112,
                output_tokens: 18,
                total_tokens: 130,
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
    getFirstRequestTools() {
      return firstRequestTools.map((tool) => ({ ...tool }));
    },
    getCustomToolCallOutputText() {
      return customToolCallOutputText;
    },
    getCustomInputStreamStage() {
      return customInputStreamStage;
    },
    getCustomInputDoneSent() {
      return customInputDoneSent;
    },
    acknowledgePreviewStage(stage) {
      acknowledgedPreviewStages.add(stage);
      const resolve = previewStageWaiters.get(stage);
      previewStageWaiters.delete(stage);
      resolve?.();
    },
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
    return await new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction('conversation_documents', 'readonly');
        const store = transaction.objectStore('conversation_documents');
        const request = store.get([id, pathValue]);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result || null);
      } catch (error) {
        reject(error);
      }
    });
  }, { conversationId, filePath });
}

async function main() {
  const regressionStartedAt = Date.now();
  await fsp.mkdir(outputDir, { recursive: true });
  const mockServer = await runMockResponsesServer();

  const result = {
    startedAt: new Date().toISOString(),
    outputDir,
    launchMode,
    headless: runHeadless,
    steps: []
  };
  global.__conversationDocumentRegressionPartialResult = result;
  await writeResultSnapshot(outputDir, result);

  const profileDir = launchMode === 'worktree_unpacked'
    ? resolveWorktreeUnpackedProfileDir(repoRoot, 'conversation-document-regression')
    : resolveFixedSidebarProfileDir(repoRoot);
  if (launchMode === 'worktree_unpacked') {
    await fsp.rm(profileDir, { recursive: true, force: true });
  }
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
        executablePath: chromePath || resolveStableChromeExecutablePath(),
        headless: runHeadless
      });
    result.steps.push('browser_ready');

    const page = context.pages()[0] || await context.newPage();
    result.consoleMessages = [];
    page.on('console', (message) => {
      result.consoleMessages.push({
        type: message.type(),
        text: message.text(),
        location: message.location()
      });
    });
    page.on('pageerror', (error) => {
      result.pageError = String(error && (error.stack || error.message || error));
    });

    if (launchMode === 'worktree_unpacked') {
      await page.goto(`${mockServer.origin}/`, { waitUntil: 'domcontentloaded' });
      result.steps.push('page_loaded');
    } else {
      await reloadUnpackedExtension(context, {
        timeoutMs: 30_000,
        unpackedPath: repoRoot
      });
      await page.goto(`${mockServer.origin}/`, { waitUntil: 'domcontentloaded' });
      result.steps.push('page_loaded');
    }

    let extensionWorker = await getExtensionWorker(context, launchMode);
    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;
    result.steps.push('worker_ready');

    await extensionWorker.evaluate(`(async () => {
      await chrome.storage.sync.clear();
      await chrome.storage.sync.set(${JSON.stringify(buildStorageSeed(`${mockServer.origin}/v1/responses`))});
      return true;
    })()`);
    result.steps.push('storage_seeded');

    result.openSidebarResponse = await openSidebar(extensionWorker);
    result.steps.push('sidebar_open_requested');
    await waitForSidebarVisible(extensionWorker);
    result.steps.push('sidebar_visible');

    let sidebarFrame = await waitForSidebarReady(page, extensionId);
    result.steps.push('sidebar_ready');

    await sidebarFrame.locator('#message-input').fill('Create a plan document, then link it in markdown.');
    await sidebarFrame.locator('#message-input').press('Enter');
    result.steps.push('prompt_sent');

    const readStreamingPatchPreview = async () => sidebarFrame.evaluate(() => {
      const previewRoot = document.querySelector('.response-activity-tool-diff-preview');
      if (!previewRoot) return null;
      const fileCards = Array.from(previewRoot.querySelectorAll('.response-activity-tool-diff-file'));
      const rows = Array.from(previewRoot.querySelectorAll('.response-activity-tool-diff-line'));
      return {
        fileCount: fileCards.length,
        lineCount: rows.length,
        paths: fileCards.map((card) => card.getAttribute('data-apply-patch-path') || ''),
        lines: rows.map((row) => (row.textContent || '').trim())
      };
    });

    try {
      result.streamingPreviewBeforeDone = await waitFor(async () => {
        if (mockServer.getCustomInputStreamStage() < 1 || mockServer.getCustomInputDoneSent()) return null;
        const preview = await readStreamingPatchPreview();
        return preview?.fileCount >= 1 && preview?.lineCount >= 3 ? preview : null;
      }, {
        timeoutMs: 30_000,
        intervalMs: 50,
        label: 'apply_patch preview before custom input done'
      });
      result.streamingPreviewBeforeDone.observedStreamStage = mockServer.getCustomInputStreamStage();
      result.previewBeforeDoneScreenshot = 'sidebar-preview-before-done.png';
      await sidebarFrame.locator('body').screenshot({
        path: path.join(outputDir, result.previewBeforeDoneScreenshot),
        timeout: 15_000
      });
      for (let stage = 1; stage <= result.streamingPreviewBeforeDone.observedStreamStage; stage += 1) {
        mockServer.acknowledgePreviewStage(stage);
      }
      result.steps.push('streaming_preview_visible_before_done');

      result.streamingPreviewGrowthBeforeDone = await waitFor(async () => {
        if (mockServer.getCustomInputStreamStage() < 2 || mockServer.getCustomInputDoneSent()) return null;
        const preview = await readStreamingPatchPreview();
        return preview?.lineCount > result.streamingPreviewBeforeDone.lineCount ? preview : null;
      }, {
        timeoutMs: 30_000,
        intervalMs: 50,
        label: 'apply_patch preview growth before custom input done'
      });
      result.previewGrowthBeforeDoneScreenshot = 'sidebar-preview-growth-before-done.png';
      await sidebarFrame.locator('body').screenshot({
        path: path.join(outputDir, result.previewGrowthBeforeDoneScreenshot),
        timeout: 15_000
      });
      mockServer.acknowledgePreviewStage(2);
      result.steps.push('streaming_preview_grew_before_done');
    } catch (error) {
      result.streamingPreviewFailureDiagnostics = {
        requestCount: mockServer.requestLog.length,
        streamStage: mockServer.getCustomInputStreamStage(),
        customInputDoneSent: mockServer.getCustomInputDoneSent(),
        preview: await readStreamingPatchPreview().catch(() => null),
        firstRequestTools: mockServer.getFirstRequestTools(),
        sidebarDom: await sidebarFrame.evaluate(() => ({
          messageCount: document.querySelectorAll('.message').length,
          aiMessageCount: document.querySelectorAll('.message.ai-message').length,
          loadingMessageCount: document.querySelectorAll('.loading-message').length,
          activityTimelineCount: document.querySelectorAll('.response-activity-timeline').length,
          activityToolCount: document.querySelectorAll('.response-activity-tool').length,
          bodyText: (document.body.innerText || '').slice(-8_000),
          messageHtml: Array.from(document.querySelectorAll('.message'))
            .slice(-3)
            .map((message) => message.outerHTML.slice(0, 20_000))
        })).catch(() => null)
      };
      throw error;
    }

    await waitFor(async () => mockServer.requestLog.length >= 2 ? true : null, {
      timeoutMs: 30_000,
      intervalMs: 200,
      label: 'two mock responses requests'
    });
    result.steps.push('tool_followup_observed');

    result.firstRequestTools = mockServer.getFirstRequestTools();
    result.firstRequestToolNames = result.firstRequestTools.map((tool) => tool.name || tool.type).filter(Boolean);
    result.customToolCallOutputText = mockServer.getCustomToolCallOutputText();

    const applyPatchDefinitions = result.firstRequestTools.filter((tool) => tool.name === 'apply_patch');
    if (applyPatchDefinitions.length !== 1 || applyPatchDefinitions[0].type !== 'custom') {
      throw new Error(`apply_patch must be exposed exactly once as custom: ${JSON.stringify(applyPatchDefinitions)}`);
    }
    if (result.firstRequestTools.some((tool) => tool.type === 'function' && tool.name === 'apply_patch')) {
      throw new Error(`legacy function apply_patch leaked into request: ${JSON.stringify(result.firstRequestTools)}`);
    }

    const expectedTools = ['apply_patch', 'list_files', 'read_file', 'search_files', 'copy_file', 'move_file', 'delete_file'];
    for (const toolName of expectedTools) {
      if (!result.firstRequestToolNames.includes(toolName)) {
        throw new Error(`first request missing tool ${toolName}: ${JSON.stringify(result.firstRequestToolNames)}`);
      }
    }
    for (const requiredPath of [MD_DOC_PATH, TXT_DOC_PATH, CODE_DOC_PATH, HTML_DOC_PATH]) {
      if (!result.customToolCallOutputText.includes(requiredPath)) {
        throw new Error(`apply_patch follow-up output missing ${requiredPath}: ${result.customToolCallOutputText}`);
      }
    }

    const followUpInput = Array.isArray(mockServer.requestLog[1]?.input) ? mockServer.requestLog[1].input : [];
    const replayedCustomCall = followUpInput.find((item) => (
      item?.type === 'custom_tool_call' && item?.call_id === PATCH_CALL_ID
    ));
    const replayedCustomOutput = followUpInput.find((item) => (
      item?.type === 'custom_tool_call_output' && item?.call_id === PATCH_CALL_ID
    ));
    result.followUpProtocol = {
      customCallType: replayedCustomCall?.type || '',
      customOutputType: replayedCustomOutput?.type || '',
      callIdMatches: !!replayedCustomCall && !!replayedCustomOutput,
      rawInputMatches: replayedCustomCall?.input === createApplyPatchInput()
    };
    if (!result.followUpProtocol.callIdMatches || !result.followUpProtocol.rawInputMatches) {
      throw new Error(`custom apply_patch follow-up protocol mismatch: ${JSON.stringify(result.followUpProtocol)}`);
    }

    result.finalAssistantText = await waitFor(async () => {
      const texts = await sidebarFrame.evaluate(() => (
        Array.from(document.querySelectorAll('.message.ai-message'))
          .map((element) => (element.innerText || '').trim())
          .filter(Boolean)
      ));
      const last = texts[texts.length - 1] || '';
      return last.includes(EXPECTED_FINAL_MARKER) ? last : null;
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: 'final assistant text'
    });
    result.steps.push('assistant_completed');

    if (focusedApplyPatchRegression) {
      result.conversationId = await sidebarFrame.evaluate(() => (
        window.cerebr?.debug?.messageSender?.getCurrentConversationId?.() || ''
      ));
      if (!result.conversationId) {
        throw new Error('conversation id not available after focused apply_patch flow');
      }
      const expectedDocuments = new Map([
        [MD_DOC_PATH, INITIAL_MD_DOC_CONTENT],
        [TXT_DOC_PATH, INITIAL_TXT_DOC_CONTENT],
        [CODE_DOC_PATH, INITIAL_CODE_DOC_CONTENT],
        [HTML_DOC_PATH, `${INITIAL_HTML_DOC_CONTENT}\n`]
      ]);
      result.indexedDbDocuments = {};
      for (const [documentPath, expectedContent] of expectedDocuments.entries()) {
        const stored = await readIndexedDbDocument(
          sidebarFrame,
          result.conversationId,
          documentPath
        );
        result.indexedDbDocuments[documentPath] = stored;
        if (!stored || stored.content !== expectedContent) {
          throw new Error(`focused apply_patch IndexedDB mismatch for ${documentPath}: ${JSON.stringify(stored)}`);
        }
      }
      result.steps.push('all_patch_files_persisted');
      result.finalScreenshot = 'sidebar-body-final.png';
      await sidebarFrame.locator('body').screenshot({
        path: path.join(outputDir, result.finalScreenshot),
        timeout: 15_000
      });
      result.ok = true;
      result.finishedAt = new Date().toISOString();
      result.elapsedMs = Date.now() - regressionStartedAt;
      await writeResultSnapshot(outputDir, result);
      console.log(`focused apply_patch regression passed in ${result.elapsedMs}ms`);
      return;
    }
    result.finalAssistantDomSnapshot = await sidebarFrame.evaluate((docPath) => {
      const aiMessages = Array.from(document.querySelectorAll('.message.ai-message'));
      const lastMessage = aiMessages[aiMessages.length - 1] || null;
      if (!lastMessage) return null;
      const anchors = Array.from(lastMessage.querySelectorAll('a')).map((anchor) => ({
        hrefAttr: anchor.getAttribute('href') || '',
        href: anchor.href || '',
        text: (anchor.textContent || '').trim()
      }));
      return {
        innerText: (lastMessage.innerText || '').trim(),
        innerHTML: lastMessage.innerHTML,
        textContentHtml: lastMessage.querySelector('.text-content')?.innerHTML || '',
        anchorCount: anchors.length,
        anchors,
        containsDocPathText: (lastMessage.innerText || '').includes(docPath)
      };
    }, MD_DOC_PATH);

    result.cardRenderState = await waitFor(async () => {
      const state = await sidebarFrame.evaluate((docPath) => {
        const aiMessages = Array.from(document.querySelectorAll('.message.ai-message'));
        const lastMessage = aiMessages[aiMessages.length - 1] || null;
        if (!lastMessage) return null;
        const card = Array.from(lastMessage.querySelectorAll('.conversation-document-card'))
          .find((node) => (node.getAttribute('data-document-path') || '') === docPath) || null;
        if (!card) return null;
        return {
          cardPath: card.getAttribute('data-document-path') || '',
          hasRawLink: !!lastMessage.querySelector(`a[href="${docPath}"]`),
          title: (card.querySelector('.conversation-document-card__title')?.textContent || '').trim()
        };
      }, MD_DOC_PATH);
      return state?.cardPath === MD_DOC_PATH ? state : null;
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: 'document card render'
    });
    result.steps.push('document_card_rendered');

    if (result.cardRenderState.hasRawLink) {
      throw new Error(`document link was not replaced by card: ${JSON.stringify(result.cardRenderState)}`);
    }

    result.attachmentStripState = await waitFor(async () => {
      return await sidebarFrame.evaluate(() => {
        const lastMessage = Array.from(document.querySelectorAll('.message.ai-message')).slice(-1)[0] || null;
        if (!lastMessage) return null;
        const strip = lastMessage.querySelector('.conversation-document-attachments');
        if (!strip) return null;
        const tiles = Array.from(strip.querySelectorAll('.conversation-document-attachments__tile')).map((tile) => ({
          text: (tile.textContent || '').trim(),
          title: tile.getAttribute('title') || ''
        }));
        if (tiles.length < 4) return null;
        return { tileCount: tiles.length, tiles };
      }).catch(() => null);
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: 'document attachment strip'
    });
    result.steps.push('document_attachment_strip_rendered');

    const mdCardRoot = sidebarFrame.locator(`.message.ai-message:last-child .conversation-document-card[data-document-path="${MD_DOC_PATH}"]`);
    const txtCardRoot = sidebarFrame.locator(`.message.ai-message:last-child .conversation-document-card[data-document-path="${TXT_DOC_PATH}"]`);
    const codeCardRoot = sidebarFrame.locator(`.message.ai-message:last-child .conversation-document-card[data-document-path="${CODE_DOC_PATH}"]`);
    const htmlCardRoot = sidebarFrame.locator(`.message.ai-message:last-child .conversation-document-card[data-document-path="${HTML_DOC_PATH}"]`);

    await sidebarFrame.locator(`.message.ai-message:last-child .conversation-document-attachments__tile[title="${MD_DOC_PATH}"]`).click();
    result.initialCardContent = await waitFor(async () => {
      return await mdCardRoot.evaluate((card) => {
        const content = card.querySelector('.conversation-document-card__content');
        if (!content) return null;
        const isMarkdown = content.classList.contains('conversation-document-card__content--markdown');
        const text = content.textContent || '';
        if (!isMarkdown || !text.includes('第一版内容')) return null;
        return {
          modeClass: Array.from(content.classList),
          text
        };
      }).catch(() => null);
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: 'initial markdown document content'
    });

    await mdCardRoot.locator('.conversation-document-card__tool-button--mode').click();
    result.toggledMarkdownPlainState = await waitFor(async () => {
      return await mdCardRoot.evaluate((card) => {
        const content = card.querySelector('.conversation-document-card__content');
        if (!content) return null;
        const isPlain = content.classList.contains('conversation-document-card__content--plain');
        const text = content.textContent || '';
        if (!isPlain || !text.includes('# 随笔')) return null;
        return {
          modeClass: Array.from(content.classList),
          text
        };
      }).catch(() => null);
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: 'markdown document toggled to plain'
    });

    const mdContentLocator = mdCardRoot.locator('.conversation-document-card__content');
    await mdContentLocator.click();
    result.documentFontSizeBeforeShortcut = await mdContentLocator.evaluate((element) => {
      return window.getComputedStyle(element).fontSize;
    });
    await page.keyboard.press('Control+=');
    result.documentFontSizeAfterIncrease = await waitFor(async () => {
      const fontSize = await mdContentLocator.evaluate((element) => window.getComputedStyle(element).fontSize).catch(() => null);
      return (fontSize && fontSize !== result.documentFontSizeBeforeShortcut) ? fontSize : null;
    }, {
      timeoutMs: 10_000,
      intervalMs: 150,
      label: 'document font size increase'
    });
    await page.keyboard.press('Control+-');
    result.documentFontSizeAfterDecrease = await waitFor(async () => {
      const fontSize = await mdContentLocator.evaluate((element) => window.getComputedStyle(element).fontSize).catch(() => null);
      return (fontSize && fontSize === result.documentFontSizeBeforeShortcut) ? fontSize : null;
    }, {
      timeoutMs: 10_000,
      intervalMs: 150,
      label: 'document font size decrease'
    });
    await page.keyboard.press('Control+=');
    await waitFor(async () => {
      const fontSize = await mdContentLocator.evaluate((element) => window.getComputedStyle(element).fontSize).catch(() => null);
      return (fontSize && fontSize !== result.documentFontSizeBeforeShortcut) ? fontSize : null;
    }, {
      timeoutMs: 10_000,
      intervalMs: 150,
      label: 'document font size increase again'
    });
    await page.keyboard.press('Control+0');
    result.documentFontSizeAfterReset = await waitFor(async () => {
      const fontSize = await mdContentLocator.evaluate((element) => window.getComputedStyle(element).fontSize).catch(() => null);
      return (fontSize && fontSize === result.documentFontSizeBeforeShortcut) ? fontSize : null;
    }, {
      timeoutMs: 10_000,
      intervalMs: 150,
      label: 'document font size reset'
    });

    await txtCardRoot.locator('summary').click();
    result.txtDefaultRenderState = await waitFor(async () => {
      return await txtCardRoot.evaluate((card) => {
        const content = card.querySelector('.conversation-document-card__content');
        if (!content) return null;
        const isPlain = content.classList.contains('conversation-document-card__content--plain');
        const text = content.textContent || '';
        if (!isPlain || !text.includes('# 文本标题')) return null;
        return {
          modeClass: Array.from(content.classList),
          text
        };
      }).catch(() => null);
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: 'txt default plain content'
    });

    await txtCardRoot.locator('.conversation-document-card__tool-button--mode').click();
    result.txtMarkdownRenderState = await waitFor(async () => {
      return await txtCardRoot.evaluate((card) => {
        const content = card.querySelector('.conversation-document-card__content');
        if (!content) return null;
        const isMarkdown = content.classList.contains('conversation-document-card__content--markdown');
        const text = content.textContent || '';
        if (!isMarkdown || !text.includes('文本标题')) return null;
        return {
          modeClass: Array.from(content.classList),
          text
        };
      }).catch(() => null);
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: 'txt toggled to markdown'
    });

    await codeCardRoot.locator('summary').click();
    result.codeHighlightedState = await waitFor(async () => {
      return await codeCardRoot.evaluate((card) => {
        const content = card.querySelector('.conversation-document-card__content');
        const code = card.querySelector('.conversation-document-card__content code');
        if (!content || !code) return null;
        const isCode = content.classList.contains('conversation-document-card__content--code');
        const hasHighlightClass = code.classList.contains('hljs');
        if (!isCode) return null;
        return {
          modeClass: Array.from(content.classList),
          codeClass: Array.from(code.classList),
          hasHighlightClass
        };
      }).catch(() => null);
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: 'code highlighted content'
    });

    await codeCardRoot.locator('.conversation-document-card__tool-button--mode').click();
    result.codePlainState = await waitFor(async () => {
      return await codeCardRoot.evaluate((card) => {
        const content = card.querySelector('.conversation-document-card__content');
        if (!content) return null;
        const isPlain = content.classList.contains('conversation-document-card__content--plain');
        const text = content.textContent || '';
        if (!isPlain || !text.includes('const answer = 42;')) return null;
        return {
          modeClass: Array.from(content.classList),
          text
        };
      }).catch(() => null);
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: 'code toggled to plain'
    });

    await htmlCardRoot.locator('summary').click();
    result.htmlPreviewState = await waitFor(async () => {
      return await htmlCardRoot.evaluate((card) => {
        const content = card.querySelector('.conversation-document-card__content');
        const frame = card.querySelector('iframe.conversation-document-card__html-frame');
        if (!content || !frame) return null;
        const isHtmlPreview = content.classList.contains('conversation-document-card__content--html-preview');
        const sandbox = frame.getAttribute('sandbox') || '';
        const allow = frame.getAttribute('allow') || '';
        const src = frame.getAttribute('src') || '';
        if (!isHtmlPreview || !src.includes('html_preview_sandbox.html')) return null;
        return {
          modeClass: Array.from(content.classList),
          sandbox,
          allow,
          src
        };
      }).catch(() => null);
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: 'html document iframe preview'
    });
    if (result.htmlPreviewState.sandbox) {
      throw new Error(`Outer HTML preview iframe should rely on manifest sandbox only: ${result.htmlPreviewState.sandbox}`);
    }

    const htmlFrameHandle = await htmlCardRoot.locator('iframe.conversation-document-card__html-frame').elementHandle();
    const htmlSandboxFrame = htmlFrameHandle ? await htmlFrameHandle.contentFrame() : null;
    if (!htmlSandboxFrame) {
      throw new Error('HTML preview sandbox frame unavailable');
    }
    result.htmlSandboxInnerFrameState = await htmlSandboxFrame.evaluate(() => {
      const frame = document.querySelector('iframe.html-preview-sandbox__content-frame');
      return frame ? {
        sandbox: frame.getAttribute('sandbox') || '',
        referrerPolicy: frame.getAttribute('referrerpolicy') || ''
      } : null;
    });
    if (!result.htmlSandboxInnerFrameState?.sandbox?.includes('allow-scripts')) {
      throw new Error(`Inner HTML preview iframe must allow scripts: ${JSON.stringify(result.htmlSandboxInnerFrameState)}`);
    }
    if (result.htmlSandboxInnerFrameState.sandbox.includes('allow-same-origin')) {
      throw new Error(`Inner HTML preview iframe must not allow same-origin: ${result.htmlSandboxInnerFrameState.sandbox}`);
    }
    const innerHtmlFrameHandle = await htmlSandboxFrame.locator('iframe.html-preview-sandbox__content-frame').elementHandle();
    const htmlPreviewFrame = innerHtmlFrameHandle ? await innerHtmlFrameHandle.contentFrame() : null;
    if (!htmlPreviewFrame) {
      throw new Error('HTML preview iframe content frame unavailable');
    }
    result.htmlPreviewFrameState = await waitFor(async () => {
      const state = await htmlPreviewFrame.evaluate(() => ({
        titleText: document.getElementById('html-preview-title')?.textContent || '',
        scriptStatus: document.getElementById('html-preview-script-status')?.textContent || '',
        inlineScriptRan: window.__cerebrInlineScriptRan === true
      })).catch(() => null);
      return state?.titleText.includes('HTML preview rendered') && state?.inlineScriptRan ? state : null;
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: 'html preview rendered DOM'
    });
    const cspInlineScriptErrors = result.consoleMessages.filter((entry) => (
      String(entry.text || '').includes('Executing inline script violates')
    ));
    if (cspInlineScriptErrors.length > 0) {
      throw new Error(`HTML preview should not emit inline-script CSP errors: ${JSON.stringify(cspInlineScriptErrors)}`);
    }

    await htmlPreviewFrame.evaluate(() => {
      window.__cerebrPreviewStateCounter = 42;
    });
    await htmlCardRoot.locator('.conversation-document-card__tool-button--html-fullscreen').click();
    result.htmlPopoutState = await waitFor(async () => {
      return await htmlCardRoot.evaluate((card) => {
        const content = card.querySelector('.conversation-document-card__content');
        if (!content || !content.classList.contains('is-popout')) return null;
        const frame = content.querySelector('iframe.conversation-document-card__html-frame');
        const closeButton = content.querySelector('.conversation-document-html-popout__toggle');
        if (!frame || !closeButton) return null;
        return {
          modeClass: Array.from(content.classList),
          frameSandbox: frame.getAttribute('sandbox') || '',
          frameAllow: frame.getAttribute('allow') || '',
          frameSrc: frame.getAttribute('src') || '',
          hasHoverButton: true
        };
      }).catch(() => null);
    }, {
      timeoutMs: 10_000,
      intervalMs: 200,
      label: 'html preview popout'
    });
    if (result.htmlPopoutState.frameSandbox) {
      throw new Error(`Popout HTML preview iframe should rely on manifest sandbox only: ${result.htmlPopoutState.frameSandbox}`);
    }
    result.htmlPreviewFrameStateAfterPopout = await htmlPreviewFrame.evaluate(() => ({
      counter: window.__cerebrPreviewStateCounter || 0,
      inlineScriptRan: window.__cerebrInlineScriptRan === true
    })).catch((error) => ({ error: String(error && (error.stack || error.message || error)) }));
    if (result.htmlPreviewFrameStateAfterPopout.counter !== 42) {
      throw new Error(`HTML preview popout should not reload iframe state: ${JSON.stringify(result.htmlPreviewFrameStateAfterPopout)}`);
    }
    await htmlCardRoot.locator('.conversation-document-html-popout__toggle').click();
    result.htmlPopoutRestoredState = await waitFor(async () => {
      return await htmlCardRoot.evaluate((card) => {
        const content = card.querySelector('.conversation-document-card__content--html-preview');
        if (!content || content.classList.contains('is-popout')) return null;
        return {
          modeClass: Array.from(content.classList)
        };
      }).catch(() => null);
    }, {
      timeoutMs: 10_000,
      intervalMs: 200,
      label: 'html preview popout restored'
    });
    result.htmlPreviewFrameStateAfterRestore = await htmlPreviewFrame.evaluate(() => ({
      counter: window.__cerebrPreviewStateCounter || 0,
      inlineScriptRan: window.__cerebrInlineScriptRan === true
    })).catch((error) => ({ error: String(error && (error.stack || error.message || error)) }));
    if (result.htmlPreviewFrameStateAfterRestore.counter !== 42) {
      throw new Error(`HTML preview restore should not reload iframe state: ${JSON.stringify(result.htmlPreviewFrameStateAfterRestore)}`);
    }

    await htmlCardRoot.locator('.conversation-document-card__tool-button--mode').click();
    result.htmlSourceState = await waitFor(async () => {
      return await htmlCardRoot.evaluate((card) => {
        const content = card.querySelector('.conversation-document-card__content');
        const code = card.querySelector('.conversation-document-card__content code');
        if (!content || !code) return null;
        const isCode = content.classList.contains('conversation-document-card__content--code');
        const text = code.textContent || '';
        if (!isCode || !text.includes('<!doctype html>')) return null;
        return {
          modeClass: Array.from(content.classList),
          codeClass: Array.from(code.classList),
          textPrefix: text.slice(0, 80)
        };
      }).catch(() => null);
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: 'html toggled to highlighted source'
    });
    result.steps.push('document_loaded');

    await mdCardRoot.locator('.conversation-document-card__tool-button[aria-label="编辑文件"]').click();
    await mdCardRoot.locator('.conversation-document-card__editor').fill(EDITED_MD_DOC_CONTENT);
    await mdCardRoot.locator('.conversation-document-card__button.is-primary').click();
    result.editedCardContent = await waitFor(async () => {
      return await mdCardRoot.evaluate((card) => {
        const content = card.querySelector('.conversation-document-card__content');
        if (!content) return null;
        const isPlain = content.classList.contains('conversation-document-card__content--plain');
        const text = content.textContent || '';
        if (!isPlain || !text.includes('第二版内容')) return null;
        return {
          modeClass: Array.from(content.classList),
          text
        };
      }).catch(() => null);
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: 'edited markdown document content'
    });
    result.steps.push('document_edited');

    result.conversationId = await sidebarFrame.evaluate(() => (
      window.cerebr?.debug?.messageSender?.getCurrentConversationId?.() || ''
    ));
    if (!result.conversationId) {
      throw new Error('conversation id not available after document tool flow');
    }

    result.indexedDbDocument = await readIndexedDbDocument(sidebarFrame, result.conversationId, MD_DOC_PATH);
    if (!result.indexedDbDocument || result.indexedDbDocument.content !== EDITED_MD_DOC_CONTENT) {
      throw new Error(`indexeddb document mismatch: ${JSON.stringify(result.indexedDbDocument)}`);
    }
    result.steps.push('document_persisted');

    const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
    await mdCardRoot.locator('.conversation-document-card__tool-button[aria-label="下载文件"]').click();
    const download = await downloadPromise;
    result.downloadSuggestedFilename = download.suggestedFilename();
    const downloadPath = await download.path().catch(() => null);
    if (downloadPath) {
      result.downloadedFileContent = await fsp.readFile(downloadPath, 'utf8');
    }
    if (result.downloadSuggestedFilename !== EXPECTED_DOWNLOAD_NAME) {
      throw new Error(`unexpected download filename: ${result.downloadSuggestedFilename}`);
    }
    if (result.downloadedFileContent !== EDITED_MD_DOC_CONTENT) {
      throw new Error(`unexpected downloaded content: ${JSON.stringify(result.downloadedFileContent)}`);
    }
    result.steps.push('document_downloaded');

    await page.reload({ waitUntil: 'domcontentloaded' });
    result.steps.push('page_reloaded');

    extensionWorker = await getExtensionWorker(context, launchMode);
    await openSidebar(extensionWorker);
    await waitForSidebarVisible(extensionWorker);
    sidebarFrame = await waitForSidebarReady(page, extensionId);
    result.steps.push('sidebar_reopened');

    await sidebarFrame.evaluate(async (conversationId) => {
      const chatHistoryUI = window.cerebr?.debug?.chatHistoryUI;
      if (!chatHistoryUI) {
        throw new Error('window.cerebr.debug.chatHistoryUI unavailable');
      }
      const conversation = await chatHistoryUI.getConversationSnapshotById(conversationId, true);
      if (!conversation) {
        throw new Error(`conversation ${conversationId} not found after reload`);
      }
      await chatHistoryUI.loadConversationIntoChat(conversation);
      return true;
    }, result.conversationId);
    result.steps.push('conversation_reloaded');

    const reloadedCard = sidebarFrame.locator(`.message.ai-message:last-child .conversation-document-card[data-document-path="${MD_DOC_PATH}"]`);
    await reloadedCard.locator('summary').click();
    result.reloadedCardContent = await waitFor(async () => {
      return await reloadedCard.evaluate((card) => {
        const content = card.querySelector('.conversation-document-card__content');
        if (!content) return null;
        const isPlain = content.classList.contains('conversation-document-card__content--plain');
        const text = content.textContent || '';
        if (!isPlain || !text.includes('第二版内容')) return null;
        return {
          modeClass: Array.from(content.classList),
          text
        };
      }).catch(() => null);
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: 'reloaded document content'
    });
    result.steps.push('document_reopened_after_reload');

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
    await mockServer.close().catch(() => {});
  }
}

main().then(() => {
  process.exit(0);
}).catch(async (error) => {
  const partial = global.__conversationDocumentRegressionPartialResult
    && typeof global.__conversationDocumentRegressionPartialResult === 'object'
    ? global.__conversationDocumentRegressionPartialResult
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
