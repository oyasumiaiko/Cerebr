const fsp = require('fs/promises');
const http = require('http');
const path = require('path');
const {
  loadPlaywright,
  shouldRunHeadless,
  waitFor,
  waitForSidebarFrame,
  launchWorktreeUnpackedChromiumContext,
  resolveWorktreeUnpackedProfileDir,
  waitForWorktreeExtensionWorker
} = require('./lib/worktree_unpacked_extension_harness.cjs');
const {
  launchFixedSidebarContext,
  reloadUnpackedExtension,
  resolveFixedSidebarProfileDir,
  resolveStableChromeExecutablePath
} = require('./lib/stable_chrome_sidebar_harness.cjs');
const { loadFixedApiEnv } = require('./lib/fixed_api_env.cjs');

const [
  rawRepoRoot,
  rawOutputDir,
  rawPageUrl
] = process.argv.slice(2);

if (!rawRepoRoot || !rawOutputDir) {
  throw new Error(
    'Usage: node tests/cdp_responses_local_compaction_smoke.cjs <envRepoRoot> <outputDir> [pageUrl]'
  );
}

const repoRoot = path.resolve(rawRepoRoot);
const outputDir = path.resolve(rawOutputDir);
const extensionRoot = path.resolve(__dirname, '..');
const pageUrl = (typeof rawPageUrl === 'string' && rawPageUrl.trim())
  ? rawPageUrl.trim()
  : 'https://example.com/';
const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);

const FIRST_REPLY = 'STEP1_OK CODEWORD=BLUE-ELEPHANT-42';
const SECOND_REPLY = 'STEP2_OK';
const THIRD_REPLY = 'CODEWORD=BLUE-ELEPHANT-42';
const COMPACTION_MARKER_TEXT = '上下文已压缩';
const useMockResponsesServer = String(process.env.CEREBR_COMPACT_V2_MOCK || '').trim() === '1';
const browserMode = String(process.env.CEREBR_COMPACT_V2_BROWSER_MODE || '').trim().toLowerCase() === 'stable'
  ? 'stable'
  : 'worktree_unpacked';
const runStartedAt = Date.now();

function logProgress(stage, detail = '') {
  const suffix = detail ? ` ${detail}` : '';
  console.log(`[compact-v2-smoke] stage=${stage} elapsed_ms=${Date.now() - runStartedAt}${suffix}`);
}

function writeJsonResponse(res, payload, statusCode = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function buildMockAssistantResponse(id, text) {
  return {
    id,
    object: 'response',
    status: 'completed',
    output: [{
      id: `msg_${id}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }]
    }],
    usage: {
      input_tokens: 120,
      output_tokens: 12,
      total_tokens: 132
    }
  };
}

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function startCompactV2MockServer() {
  const requests = [];
  let normalRequestCount = 0;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/v1/responses') {
        writeJsonResponse(res, { error: { message: 'not found' } }, 404);
        return;
      }

      const body = await readRequestJson(req);
      const input = Array.isArray(body.input) ? body.input : [];
      const compactionTriggerCount = input.filter(
        item => String(item?.type || '').toLowerCase() === 'compaction_trigger'
      ).length;
      requests.push({
        headers: {
          accept: req.headers.accept || '',
          codexBetaFeatures: req.headers['x-codex-beta-features'] || '',
          codexTurnMetadata: req.headers['x-codex-turn-metadata'] || ''
        },
        body
      });

      if (compactionTriggerCount === 1) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        writeSseEvent(res, {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            id: 'cmp_mock_v2',
            type: 'compaction',
            encrypted_content: 'MOCK_COMPACT_V2_SUMMARY'
          }
        });
        writeSseEvent(res, {
          type: 'response.completed',
          response: {
            id: 'resp_mock_compact_v2',
            status: 'completed',
            usage: {
              input_tokens: 240,
              output_tokens: 24,
              total_tokens: 264
            }
          }
        });
        res.end('data: [DONE]\n\n');
        return;
      }

      normalRequestCount += 1;
      if (normalRequestCount === 1) {
        writeJsonResponse(res, buildMockAssistantResponse('resp_mock_1', FIRST_REPLY));
        return;
      }
      if (normalRequestCount === 2) {
        writeJsonResponse(res, buildMockAssistantResponse('resp_mock_2', SECOND_REPLY));
        return;
      }

      const serializedInput = JSON.stringify(input);
      const hasRetainedUserMessage = serializedInput.includes('BLUE-ELEPHANT-42');
      const hasCompactionItem = input.some(
        item => String(item?.type || '').toLowerCase() === 'compaction'
          && item?.encrypted_content === 'MOCK_COMPACT_V2_SUMMARY'
      );
      const reply = hasRetainedUserMessage && hasCompactionItem
        ? THIRD_REPLY
        : `MISSING_V2_HISTORY retained_user=${hasRetainedUserMessage} compaction=${hasCompactionItem}`;
      writeJsonResponse(res, buildMockAssistantResponse('resp_mock_3', reply));
    } catch (error) {
      writeJsonResponse(res, { error: { message: error?.message || String(error) } }, 500);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('mock Responses server address unavailable');
  }
  return {
    fixedEnv: {
      responsesBaseUrl: `http://127.0.0.1:${address.port}/v1/responses`,
      responsesApiKey: 'mock-responses-api-key',
      geminiBaseUrl: 'http://127.0.0.1/unused-gemini',
      geminiApiKey: ''
    },
    requests,
    close: async () => {
      await new Promise(resolve => server.close(resolve));
    }
  };
}

function buildStorageSeed(fixedEnv) {
  const responsesSourceId = 'src_fixed_responses_local_compaction';
  const responsesConfig = {
    id: 'cfg_fixed_responses_local_compaction',
    connectionSourceId: responsesSourceId,
    displayName: 'Fixed Responses Local Compaction Smoke',
    modelName: 'gpt-5.4',
    customParams: '',
    customSystemPrompt: '',
    temperature: 0,
    useStreaming: false,
    isFavorite: false,
    enableAskOtherAiTool: false,
    maxChatHistory: 1,
    maxChatHistoryUser: null,
    maxChatHistoryAssistant: null,
    userMessagePreprocessorTemplate: '',
    userMessagePreprocessorIncludeInHistory: false,
    responsesApiSettings: {
      reasoning: {
        effort: 'low',
        generate_summary: 'detailed',
        summary: 'detailed'
      },
      parallel_tool_calls: true,
      store: false,
      text: {
        verbosity: 'low'
      },
      builtin_tools: {
        web_search: {
          enabled: false
        },
        code_interpreter: {
          enabled: false
        },
        tool_search: {
          enabled: false
        }
      }
    }
  };
  const responsesSource = {
    id: responsesSourceId,
    name: 'Fixed Responses Source',
    connectionType: 'openai_responses',
    baseUrl: fixedEnv.responsesBaseUrl,
    apiKey: fixedEnv.responsesApiKey,
    apiKeyFilePath: ''
  };
  return {
    apiConfigs_chunk_0: JSON.stringify({
      v: 2,
      items: [responsesConfig],
      connectionSources: [responsesSource]
    }),
    apiConfigs_chunks_meta: { count: 1, updatedAt: Date.now() },
    selectedConfigIndex: 0,
    showThoughtProcess: true,
    queueCurrentConversationMessages: false,
    autoGenerateConversationTitle: false
  };
}

async function readSidebarSnapshot(sidebarFrame) {
  return await sidebarFrame.evaluate((markerText) => {
    const getText = (node) => (node?.innerText || '').trim();
    const aiMessages = Array.from(document.querySelectorAll('.message.ai-message')).map((item) => ({
      messageId: item.getAttribute('data-message-id') || '',
      text: getText(item),
      className: item.className || ''
    }));
    const userMessages = Array.from(document.querySelectorAll('.message.user-message')).map((item) => ({
      messageId: item.getAttribute('data-message-id') || '',
      text: getText(item),
      className: item.className || ''
    }));
    const attemptSnapshot = (typeof window.cerebr?.debug?.messageSender?.__debugGetActiveAttemptsSnapshot === 'function')
      ? window.cerebr.debug.messageSender.__debugGetActiveAttemptsSnapshot()
      : [];
    return {
      aiMessages,
      userMessages,
      markerCount: aiMessages.filter((item) => item.text.includes(markerText)).length,
      lastAiText: aiMessages.length > 0 ? aiMessages[aiMessages.length - 1].text : '',
      lastUserText: userMessages.length > 0 ? userMessages[userMessages.length - 1].text : '',
      attemptSnapshot,
      apiConfigsLength: Array.isArray(window.apiConfigs) ? window.apiConfigs.length : null,
      apiConfigBaseUrls: Array.isArray(window.apiConfigs) ? window.apiConfigs.map((config) => config?.baseUrl || '') : [],
      selectedConfigIndex: Number.isFinite(Number(window.selectedConfigIndex)) ? Number(window.selectedConfigIndex) : null,
      currentConversationId: (typeof window.cerebr?.debug?.messageSender?.getCurrentConversationId === 'function')
        ? window.cerebr.debug.messageSender.getCurrentConversationId()
        : '',
      promptCacheKey: (typeof window.cerebr?.debug?.messageSender?.getCurrentConversationId === 'function')
        ? null
        : null
    };
  }, COMPACTION_MARKER_TEXT);
}

async function fillAndSend(page, sidebarFrame, text, { submitShortcut = 'Enter' } = {}) {
  const input = sidebarFrame.locator('#message-input');
  await input.waitFor({ state: 'visible', timeout: 30_000 });
  await input.focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text);
  await page.keyboard.press(submitShortcut);
}

async function waitForSidebarReady(sidebarFrame, fixedEnv) {
  return await waitFor(async () => {
    const snapshot = await readSidebarSnapshot(sidebarFrame);
    if (!snapshot.apiConfigsLength) return null;
    if (!Array.isArray(snapshot.apiConfigBaseUrls) || !snapshot.apiConfigBaseUrls.includes(fixedEnv.responsesBaseUrl)) {
      return null;
    }
    return snapshot;
  }, { timeoutMs: 30_000, intervalMs: 250, label: 'sidebar api config ready' });
}

async function waitForUserMessage(sidebarFrame, expectedSubstring) {
  return await waitFor(async () => {
    const snapshot = await readSidebarSnapshot(sidebarFrame);
    return snapshot.userMessages.some((item) => item.text.includes(expectedSubstring)) ? snapshot : null;
  }, { timeoutMs: 30_000, intervalMs: 250, label: `user message includes ${expectedSubstring}` });
}

async function waitForAssistantReply(sidebarFrame, expectedSubstring) {
  return await waitFor(async () => {
    const snapshot = await readSidebarSnapshot(sidebarFrame);
    if (Array.isArray(snapshot.attemptSnapshot) && snapshot.attemptSnapshot.length > 0) {
      return null;
    }
    return snapshot.lastAiText.includes(expectedSubstring) ? snapshot : null;
  }, { timeoutMs: 120_000, intervalMs: 400, label: `assistant reply includes ${expectedSubstring}` });
}

async function waitForMarkerCount(sidebarFrame, minimumCount) {
  return await waitFor(async () => {
    const snapshot = await readSidebarSnapshot(sidebarFrame);
    return snapshot.markerCount >= minimumCount ? snapshot : null;
  }, { timeoutMs: 120_000, intervalMs: 300, label: `markerCount >= ${minimumCount}` });
}

async function main() {
  await fsp.mkdir(outputDir, { recursive: true });
  const mockServer = useMockResponsesServer ? await startCompactV2MockServer() : null;
  const fixedEnv = mockServer?.fixedEnv || await loadFixedApiEnv(repoRoot);
  logProgress('responses_endpoint_ready', `mode=${useMockResponsesServer ? 'mock' : 'live'}`);
  const result = {
    startedAt: new Date().toISOString(),
    outputDir,
    pageUrl,
    browserBinary: browserMode === 'stable' ? resolveStableChromeExecutablePath() : 'playwright:chromium',
    browserMode,
    headless: runHeadless,
    fixedConfig: {
      responsesBaseUrl: fixedEnv.responsesBaseUrl,
      responsesModel: 'gpt-5.4',
      mode: useMockResponsesServer ? 'mock' : 'live'
    },
    console: [],
    network: [],
    steps: []
  };

  const profileDir = browserMode === 'stable'
    ? resolveFixedSidebarProfileDir(extensionRoot)
    : resolveWorktreeUnpackedProfileDir(
      extensionRoot,
      `responses-compact-v2-${path.basename(outputDir)}`
    );
  if (browserMode === 'worktree_unpacked') {
    await fsp.rm(profileDir, { recursive: true, force: true });
  }
  result.profileDir = profileDir;
  result.extensionRoot = extensionRoot;

  let context = null;
  let pageCdpSession = null;
  let sidebarFrame = null;
  try {
    context = browserMode === 'stable'
      ? await launchFixedSidebarContext({
        chromium,
        profileDir,
        executablePath: resolveStableChromeExecutablePath(),
        headless: runHeadless
      })
      : await launchWorktreeUnpackedChromiumContext({
        chromium,
        repoRoot: extensionRoot,
        profileDir,
        headless: runHeadless
      });
    result.steps.push('browser_ready');
    logProgress('browser_ready');

    const extensionWorker = browserMode === 'stable'
      ? await reloadUnpackedExtension(context, {
        timeoutMs: 30_000,
        unpackedPath: extensionRoot
      })
      : await waitForWorktreeExtensionWorker(context, { timeoutMs: 30_000 });
    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;
    result.steps.push('extension_ready');

    await extensionWorker.evaluate(async (seed) => {
      await chrome.storage.sync.clear();
      await chrome.storage.local.clear();
      await chrome.storage.sync.set(seed);
      return true;
    }, buildStorageSeed(fixedEnv));
    result.steps.push('storage_seeded');

    const page = context.pages().find((entry) => entry.url().startsWith(pageUrl)) || await context.newPage();
    page.on('console', (msg) => {
      result.console.push({ type: msg.type(), text: msg.text() });
    });
    page.on('pageerror', (error) => {
      result.console.push({ type: 'pageerror', text: String(error && (error.stack || error.message || error)) });
    });

    pageCdpSession = await context.newCDPSession(page);
    await pageCdpSession.send('Network.enable');

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
    result.steps.push('host_loaded');

    await extensionWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab || typeof tab.id !== 'number') {
        throw new Error('active tab not found for OPEN_SIDEBAR');
      }
      return await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_SIDEBAR' });
    });
    result.steps.push('sidebar_open_requested');

    sidebarFrame = await waitForSidebarFrame(page, extensionId, { timeoutMs: 30_000 });
    await sidebarFrame.locator('#message-input').waitFor({ state: 'visible', timeout: 30_000 });
    await waitForSidebarReady(sidebarFrame, fixedEnv);
    await sidebarFrame.evaluate(() => {
      if (window.__compactionSmokeFetchPatched) return true;
      window.__compactionSmokeFetchPatched = true;
      window.__compactionSmokeFetchLog = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const input = args[0];
        const init = args[1] || {};
        const url = typeof input === 'string'
          ? input
          : (input?.url || '');
        const method = String(init?.method || input?.method || 'GET').toUpperCase();
        const entry = {
          type: 'request',
          url,
          method,
          startedAt: Date.now()
        };
        const requestHeaders = {};
        try {
          const headers = new Headers(init?.headers || input?.headers || {});
          headers.forEach((value, name) => {
            requestHeaders[name.toLowerCase()] = value;
          });
        } catch (_) {}
        entry.headers = {
          accept: requestHeaders.accept || '',
          codexBetaFeatures: requestHeaders['x-codex-beta-features'] || '',
          codexTurnMetadata: requestHeaders['x-codex-turn-metadata'] || ''
        };
        const rawBody = typeof init?.body === 'string'
          ? init.body
          : (typeof input?.body === 'string' ? input.body : '');
        if (rawBody) {
          entry.postDataLength = rawBody.length;
          try {
            const parsed = JSON.parse(rawBody);
            entry.postDataKeys = Object.keys(parsed).sort();
            const inputItems = Array.isArray(parsed.input) ? parsed.input : [];
            entry.postDataCompactSummary = {
              hasModel: Object.prototype.hasOwnProperty.call(parsed, 'model'),
              hasInput: Object.prototype.hasOwnProperty.call(parsed, 'input'),
              hasInstructions: Object.prototype.hasOwnProperty.call(parsed, 'instructions'),
              hasTools: Object.prototype.hasOwnProperty.call(parsed, 'tools'),
              hasParallelToolCalls: Object.prototype.hasOwnProperty.call(parsed, 'parallel_tool_calls'),
              hasReasoning: Object.prototype.hasOwnProperty.call(parsed, 'reasoning'),
              hasText: Object.prototype.hasOwnProperty.call(parsed, 'text'),
              hasStream: Object.prototype.hasOwnProperty.call(parsed, 'stream'),
              hasPreviousResponseId: Object.prototype.hasOwnProperty.call(parsed, 'previous_response_id'),
              hasConversation: Object.prototype.hasOwnProperty.call(parsed, 'conversation'),
              stream: parsed.stream === true,
              compactionTriggerCount: inputItems.filter(
                item => String(item?.type || '').toLowerCase() === 'compaction_trigger'
              ).length
            };
          } catch (error) {
            entry.postDataParseError = error?.message || String(error);
          }
        }
        window.__compactionSmokeFetchLog.push(entry);
        try {
          const response = await originalFetch(...args);
          window.__compactionSmokeFetchLog.push({
            type: 'response',
            url,
            method,
            status: response?.status || 0,
            ok: !!response?.ok,
            finishedAt: Date.now()
          });
          return response;
        } catch (error) {
          window.__compactionSmokeFetchLog.push({
            type: 'fetch_error',
            url,
            method,
            error: error?.message || String(error),
            finishedAt: Date.now()
          });
          throw error;
        }
      };
      return true;
    });
    result.steps.push('sidebar_ready');

    await fillAndSend(
      page,
      sidebarFrame,
      'Remember this exact codeword for later: BLUE-ELEPHANT-42. Reply exactly STEP1_OK CODEWORD=BLUE-ELEPHANT-42.'
    );
    result.steps.push('first_message_sent');
    result.afterFirstUser = await waitForUserMessage(sidebarFrame, 'BLUE-ELEPHANT-42');
    result.afterFirstReply = await waitForAssistantReply(sidebarFrame, FIRST_REPLY);
    result.steps.push('first_reply_received');
    logProgress('first_reply_received');

    await fillAndSend(
      page,
      sidebarFrame,
      'Do not mention the earlier codeword. Reply exactly STEP2_OK.'
    );
    result.steps.push('second_message_sent');
    result.afterSecondUser = await waitForUserMessage(sidebarFrame, 'Reply exactly STEP2_OK.');
    result.afterSecondReply = await waitForAssistantReply(sidebarFrame, SECOND_REPLY);
    result.steps.push('second_reply_received');
    logProgress('second_reply_received');

    await fillAndSend(page, sidebarFrame, '/compact');
    result.steps.push('manual_compact_sent');
    result.afterManualMarker = await waitForMarkerCount(sidebarFrame, 1);
    result.steps.push('manual_compact_completed');
    logProgress('manual_compact_completed');

    await fillAndSend(
      page,
      sidebarFrame,
      'What exact codeword did I ask you to remember earlier? Reply exactly CODEWORD=<the exact codeword only>.'
    );
    result.steps.push('third_message_sent');
    result.afterThirdUser = await waitForUserMessage(sidebarFrame, 'Reply exactly CODEWORD=<the exact codeword only>.');
    result.afterThirdReply = await waitForAssistantReply(sidebarFrame, THIRD_REPLY);
    result.steps.push('third_reply_received');
    logProgress('third_reply_received');

    result.finalSidebarSnapshot = await readSidebarSnapshot(sidebarFrame);
    result.network = await sidebarFrame.evaluate(() => window.__compactionSmokeFetchLog || []);
    await sidebarFrame.locator('body').screenshot({
      path: path.join(outputDir, 'sidebar-body.png'),
      timeout: 10_000,
      animations: 'disabled'
    });
    result.steps.push('sidebar_screenshot_saved');

    result.compactRequests = result.network.filter(
      (entry) => entry.type === 'request'
        && /\/responses$/i.test(String(entry.url || ''))
        && entry.postDataCompactSummary?.compactionTriggerCount === 1
    );
    result.normalResponseRequests = result.network.filter(
      (entry) => entry.type === 'request'
        && /\/responses$/i.test(String(entry.url || ''))
        && entry.postDataCompactSummary?.compactionTriggerCount === 0
    );

    if (result.compactRequests.length <= 0) {
      throw new Error('未捕获到携带 compaction_trigger 的 /responses 请求。');
    }
    const compactRequest = result.compactRequests[0];
    if (compactRequest.headers?.codexBetaFeatures !== 'remote_compaction_v2') {
      throw new Error(`compact v2 beta header 不正确：${compactRequest.headers?.codexBetaFeatures || '<empty>'}`);
    }
    const compactTurnMetadata = JSON.parse(compactRequest.headers?.codexTurnMetadata || '{}');
    if (compactTurnMetadata.request_kind !== 'compaction') {
      throw new Error(`compact v2 request_kind 不正确：${compactTurnMetadata.request_kind || '<empty>'}`);
    }
    if (compactRequest.postDataCompactSummary?.stream !== true) {
      throw new Error('compact v2 请求没有强制启用 SSE。');
    }
    if ((result.finalSidebarSnapshot?.markerCount || 0) < 1) {
      throw new Error('最终侧栏中未看到 compact marker。');
    }
    if (!String(result.afterSecondReply?.lastAiText || '').includes(SECOND_REPLY)) {
      throw new Error(`手动 compact 前的第二次回复不符合预期：${result.afterSecondReply?.lastAiText || '<empty>'}`);
    }
    if (String(result.afterSecondReply?.lastAiText || '').includes('BLUE-ELEPHANT-42')) {
      throw new Error(`第二次回复仍泄露 codeword，导致第三次并不依赖 compact：${result.afterSecondReply?.lastAiText || '<empty>'}`);
    }
    if (!String(result.afterThirdReply?.lastAiText || '').includes(THIRD_REPLY)) {
      throw new Error(`手动 compact 后的第三次回复不符合预期：${result.afterThirdReply?.lastAiText || '<empty>'}`);
    }

    result.ok = true;
  } catch (error) {
    result.ok = false;
    result.error = String(error && (error.stack || error.message || error));
  } finally {
    if (sidebarFrame) {
      try {
        result.network = await sidebarFrame.evaluate(() => window.__compactionSmokeFetchLog || []);
      } catch (_) {}
      try {
        result.finalSidebarSnapshot = result.finalSidebarSnapshot || await readSidebarSnapshot(sidebarFrame);
      } catch (_) {}
    }
    try { await pageCdpSession?.detach(); } catch (_) {}
    try { await context?.close(); } catch (_) {}
    if (mockServer) {
      result.mockServerRequests = mockServer.requests;
      try { await mockServer.close(); } catch (_) {}
    }
    result.finishedAt = new Date().toISOString();
    await fsp.writeFile(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
