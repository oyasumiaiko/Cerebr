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

const PNG_FIXTURE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAUSURBVBhXY/jPAEZA3AAk////DwBGTwl4XmtEywAAAABJRU5ErkJggg==';
const PNG_FIXTURE_BYTES = Buffer.from(PNG_FIXTURE_BASE64, 'base64');
const EXPECTED_FINAL_TEXT = 'VIEW_IMAGE_TOOL_OK_20260413';
const VIEW_IMAGE_CALL_ID = 'call_view_image_1';

const [rawRepoRoot, outputDir, rawArg3 = '', rawArg4 = '', rawArg5 = ''] = process.argv.slice(2);
const repoRoot = rawRepoRoot ? path.resolve(rawRepoRoot) : '';
const launchMode = (rawArg3 === 'stable' || rawArg3 === 'worktree_unpacked')
  ? rawArg3
  : ((rawArg4 === 'stable' || rawArg4 === 'worktree_unpacked') ? rawArg4 : 'stable');
const chromePath = (launchMode === rawArg3) ? '' : rawArg3;
const requestedDetail = [rawArg3, rawArg4, rawArg5].includes('original') ? 'original' : null;

if (!repoRoot || !outputDir || (launchMode === 'stable' && !chromePath)) {
  throw new Error(
    'Usage: node tests/cdp_view_image_tool_regression.cjs <repoRoot> <outputDir> [chromePath] [mode=stable|worktree_unpacked] [detail=original]'
  );
}

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
  const sourceId = 'src_view_image_tool_regression';
  const config = {
    id: 'cfg_view_image_tool_regression',
    connectionSourceId: sourceId,
    displayName: 'View Image Tool Regression',
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

async function writeResultSnapshot(outputDir, result) {
  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.writeFile(
    path.join(outputDir, 'result.json'),
    JSON.stringify(result, null, 2),
    'utf8'
  );
}

function createPageHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>View Image Tool Regression</title>
    <style>
      body { font-family: sans-serif; margin: 0; padding: 40px; }
    </style>
  </head>
  <body>
    <main>
      <h1>View Image Tool Regression</h1>
      <p>Remote image URL is served from a different origin and intentionally omits CORS headers.</p>
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

function createFunctionCallItem(imageUrl) {
  const toolArguments = requestedDetail === 'original'
    ? { path: imageUrl, detail: 'original' }
    : { path: imageUrl, detail: null };
  return {
    id: `fc_${VIEW_IMAGE_CALL_ID}`,
    type: 'function_call',
    call_id: VIEW_IMAGE_CALL_ID,
    name: 'view_image',
    arguments: JSON.stringify(toolArguments),
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

async function runNoCorsImageServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/fixture.png') {
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'no-store',
        'content-length': PNG_FIXTURE_BYTES.length
      });
      res.end(PNG_FIXTURE_BYTES);
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

async function runMockResponsesServer(imageUrl) {
  const requestLog = [];
  let firstRequestToolNames = [];
  let imageOutputSummary = null;
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
          if (requestLog.length === 1) {
            firstRequestToolNames = (Array.isArray(parsed?.tools) ? parsed.tools : [])
              .map((tool) => (tool?.type === 'function' ? tool?.name : tool?.type))
              .filter(Boolean);
          }

          const inputItems = Array.isArray(parsed?.input) ? parsed.input : [];
          const imageOutput = inputItems.find((item) => item?.type === 'function_call_output' && item?.call_id === VIEW_IMAGE_CALL_ID);

          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'close',
            'access-control-allow-origin': '*'
          });

          if (!imageOutput) {
            const functionCall = createFunctionCallItem(imageUrl);
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

          imageOutputSummary = buildImageOutputSummary(imageOutput);
          const expectOriginalDetail = requestedDetail === 'original';
          const isValidImageOutput = (
            imageOutputSummary.outputLength === 1
            && imageOutputSummary.firstType === 'input_image'
            && imageOutputSummary.prefix === 'data:image/jpeg;base64'
            && (
              expectOriginalDetail
                ? (imageOutputSummary.hasDetailField === true && imageOutputSummary.detail === 'original')
                : imageOutputSummary.hasDetailField === false
            )
            && imageOutputSummary.approxBytes > 0
          );
          const finalText = isValidImageOutput
            ? EXPECTED_FINAL_TEXT
            : `VIEW_IMAGE_TOOL_BAD_OUTPUT ${JSON.stringify(imageOutputSummary)}`;
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
                input_tokens: 96,
                output_tokens: 12,
                total_tokens: 108,
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
    getImageOutputSummary() {
      return imageOutputSummary ? { ...imageOutputSummary } : null;
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

async function closeContext(context) {
  if (!context) return;
  try {
    await context.close();
  } catch (_) {}
}

async function main() {
  await fsp.mkdir(outputDir, { recursive: true });
  const imageServer = await runNoCorsImageServer();
  const imageUrl = `${imageServer.origin}/fixture.png`;
  const mockServer = await runMockResponsesServer(imageUrl);

  const result = {
    startedAt: new Date().toISOString(),
    outputDir,
    launchMode,
    requestedDetail: requestedDetail || 'default',
    imageUrl,
    headless: runHeadless,
    steps: []
  };

  await writeResultSnapshot(outputDir, result);

  const profileDir = launchMode === 'worktree_unpacked'
    ? resolveWorktreeUnpackedProfileDir(repoRoot, 'view-image-tool-regression')
    : resolveFixedSidebarProfileDir(repoRoot);
  await fsp.rm(profileDir, { recursive: true, force: true });
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

    const openSidebarResponse = await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'OPEN_SIDEBAR' }))
      );
      return payload?.response?.status === true ? payload : null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 250,
      label: 'sidebar open acknowledgement'
    });
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

    await sidebarFrame.locator('#message-input').fill('Please inspect the referenced image and answer briefly.');
    await sidebarFrame.locator('#message-input').press('Enter');
    result.steps.push('prompt_sent');

    await waitFor(async () => mockServer.requestLog.length >= 2 ? true : null, {
      timeoutMs: 30_000,
      intervalMs: 200,
      label: 'two mock responses requests'
    });
    result.steps.push('tool_followup_observed');

    result.finalAssistantText = await waitFor(async () => {
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
    result.steps.push('assistant_completed');

    result.toolPreview = await waitFor(async () => {
      const previewState = await sidebarFrame.evaluate(() => {
        const aiMessages = Array.from(document.querySelectorAll('.message.ai-message'));
        const latest = aiMessages[aiMessages.length - 1] || null;
        const timeline = latest?.querySelector('.response-activity-timeline') || null;
        if (!timeline) return null;
        if (!timeline.classList.contains('is-expanded')) {
          timeline.querySelector('.response-activity-panel-toggle')?.click?.();
          return null;
        }
        const toolItem = timeline.querySelector('.response-activity-entry--tool');
        if (!toolItem) return null;
        const previewRoot = toolItem.querySelector('.response-activity-tool-inline-preview');
        const first = previewRoot?.querySelector('.response-activity-tool-image') || null;
        const toolBody = toolItem.querySelector('.response-activity-tool-body');
        return {
          hasInlinePreview: !!previewRoot,
          itemExpanded: toolItem.classList.contains('is-expanded'),
          summaryAriaExpanded: toolItem.querySelector('.response-activity-tool-summary')?.getAttribute('aria-expanded') || '',
          detailLabel: toolItem.querySelector('.response-activity-tool-toggle-label')?.textContent || '',
          bodyHidden: !!toolBody?.hidden,
          bodyInert: !!toolBody?.inert,
          bodyAriaHidden: toolBody?.getAttribute('aria-hidden') || '',
          bodyClientHeight: Number(toolBody?.clientHeight || 0),
          firstSrcPrefix: String(first?.getAttribute('src') || '').slice(0, 32),
          firstNaturalWidth: Number(first?.naturalWidth || 0),
          firstNaturalHeight: Number(first?.naturalHeight || 0)
        };
      });
      return (previewState && previewState.firstNaturalWidth > 0 && previewState.firstNaturalHeight > 0)
        ? previewState
        : null;
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: 'tool output image preview'
    });
    result.steps.push('tool_preview_ready');

    result.firstRequestToolNames = mockServer.getFirstRequestToolNames();
    result.imageOutputSummary = mockServer.getImageOutputSummary();

    if (!result.firstRequestToolNames.includes('view_image')) {
      throw new Error(`first request did not include view_image tool: ${JSON.stringify(result.firstRequestToolNames)}`);
    }
    if (!result.imageOutputSummary || result.imageOutputSummary.firstType !== 'input_image') {
      throw new Error(`follow-up request did not include expected input_image output: ${JSON.stringify(result.imageOutputSummary)}`);
    }
    if (!result.toolPreview || !String(result.toolPreview.firstSrcPrefix || '').startsWith('data:image/jpeg;base64,')) {
      throw new Error(`tool output preview image missing or unexpected: ${JSON.stringify(result.toolPreview)}`);
    }
    if (result.toolPreview.hasInlinePreview !== true || result.toolPreview.itemExpanded !== false) {
      throw new Error(`view_image tool preview presentation unexpected: ${JSON.stringify(result.toolPreview)}`);
    }
    if (result.toolPreview.summaryAriaExpanded !== 'false' || result.toolPreview.detailLabel !== '详情') {
      throw new Error(`view_image detail toggle state unexpected: ${JSON.stringify(result.toolPreview)}`);
    }
    if (result.toolPreview.bodyHidden !== true || result.toolPreview.bodyAriaHidden !== 'true') {
      throw new Error(`view_image detail body should be truly hidden when collapsed: ${JSON.stringify(result.toolPreview)}`);
    }
    if (Number(result.toolPreview.bodyClientHeight || 0) > 4) {
      throw new Error(`view_image detail body should stay collapsed by default: ${JSON.stringify(result.toolPreview)}`);
    }

    await sidebarFrame.locator('body').screenshot({
      path: path.join(outputDir, 'sidebar-body-final.png')
    }).catch(() => {});

    result.ok = true;
    result.finishedAt = new Date().toISOString();
    await writeResultSnapshot(outputDir, result);
  } finally {
    await closeContext(context);
    await mockServer.close().catch(() => {});
    await imageServer.close().catch(() => {});
  }
}

main().then(() => {
  process.exit(0);
}).catch(async (error) => {
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
  process.exit(1);
});
