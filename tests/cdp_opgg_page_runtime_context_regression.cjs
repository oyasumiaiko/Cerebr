const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const [
  rawRepoRoot,
  outputDir,
  chromePathOrPageUrl,
  pageUrlArg
] = process.argv.slice(2);

if (!rawRepoRoot || !outputDir) {
  throw new Error(
    'Usage: node tests/cdp_opgg_page_runtime_context_regression.cjs <repoRoot> <outputDir> [chromePathIgnored] [pageUrl]'
  );
}

const repoRoot = path.resolve(rawRepoRoot);

const DEFAULT_PAGE_URL = 'https://op.gg/zh-cn/lol/summoners/kr/jio3r-Miss';
const inferredPageUrl = (() => {
  const first = (typeof chromePathOrPageUrl === 'string') ? chromePathOrPageUrl.trim() : '';
  const second = (typeof pageUrlArg === 'string') ? pageUrlArg.trim() : '';
  if (second) return second;
  if (first && /^https?:\/\//i.test(first)) return first;
  return DEFAULT_PAGE_URL;
})();
const pageUrl = inferredPageUrl;
const JS_RUNTIME_LIST_FRAMES_TIMEOUT_MS = 15_000;
const SEND_PROGRESS_TIMEOUT_MS = 25_000;
const runHeadless = String(process.env.CEREBR_PW_HEADLESS || 'true').trim().toLowerCase() !== 'false';
const forceHangGetJsRuntimeFrames = String(process.env.CEREBR_FORCE_HANG_GET_JS_RUNTIME_FRAMES || '').trim().toLowerCase() === 'true';
const externalChromePath = (typeof process.env.CEREBR_EXTERNAL_CHROME_PATH === 'string')
  ? process.env.CEREBR_EXTERNAL_CHROME_PATH.trim()
  : '';
const skipLoadExtensionArgs = String(process.env.CEREBR_SKIP_LOAD_EXTENSION_ARGS || '').trim().toLowerCase() === 'true';

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
  throw new Error(
    'Cannot resolve playwright. Tried repo-local paths and the known temp harness cache under %TEMP%\\cerebr-playwright-cdp.'
  );
}

const { chromium } = loadPlaywright();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition, { timeoutMs = 30_000, intervalMs = 200, label = 'condition' } = {}) {
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

function parseDotEnv(content) {
  const env = {};
  String(content || '')
    .split(/\r?\n/)
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex <= 0) return;
      const key = trimmed.slice(0, separatorIndex).trim();
      const rawValue = trimmed.slice(separatorIndex + 1).trim();
      const unquoted = (
        (rawValue.startsWith('"') && rawValue.endsWith('"'))
        || (rawValue.startsWith('\'') && rawValue.endsWith('\''))
      )
        ? rawValue.slice(1, -1)
        : rawValue;
      env[key] = unquoted;
    });
  return env;
}

async function loadFixedApiEnv(repoRootPath) {
  const envPath = path.join(repoRootPath, '.env');
  const content = await fsp.readFile(envPath, 'utf8');
  const env = parseDotEnv(content);
  const required = (key) => {
    const value = (typeof env[key] === 'string') ? env[key].trim() : '';
    if (!value) {
      throw new Error(`.env 缺少必填项 ${key}`);
    }
    return value;
  };
  const optional = (key) => {
    const value = (typeof env[key] === 'string') ? env[key] : '';
    return value.trim();
  };
  return {
    responsesBaseUrl: required('CEREBR_FIXED_RESPONSES_BASE_URL'),
    responsesApiKey: required('CEREBR_FIXED_RESPONSES_API_KEY'),
    geminiBaseUrl: required('CEREBR_FIXED_GEMINI_BASE_URL'),
    geminiApiKey: optional('CEREBR_FIXED_GEMINI_API_KEY')
  };
}

function buildStorageSeed(fixedEnv) {
  const responsesSourceId = 'src_fixed_responses_opgg';
  const geminiSourceId = 'src_fixed_gemini_opgg';
  const responsesConfig = {
    id: 'cfg_fixed_responses_opgg',
    connectionSourceId: responsesSourceId,
    displayName: 'Fixed Responses OPGG',
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
        generate_summary: 'detailed',
        summary: 'detailed'
      },
      service_tier: 'priority',
      parallel_tool_calls: true,
      store: false,
      text: {
        verbosity: 'low'
      },
      builtin_tools: {
        web_search: {
          enabled: true,
          external_web_access: true,
          include_sources: true
        },
        code_interpreter: {
          enabled: false
        }
      }
    }
  };
  const geminiConfig = {
    id: 'cfg_fixed_gemini_opgg',
    connectionSourceId: geminiSourceId,
    displayName: 'Fixed Gemini OPGG',
    modelName: 'gemini-3.1-pro-preview',
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
    userMessagePreprocessorIncludeInHistory: false
  };
  const responsesSource = {
    id: responsesSourceId,
    name: 'Fixed Responses Source',
    connectionType: 'openai_responses',
    baseUrl: fixedEnv.responsesBaseUrl,
    apiKey: fixedEnv.responsesApiKey,
    apiKeyFilePath: ''
  };
  const geminiSource = {
    id: geminiSourceId,
    name: 'Fixed Gemini Source',
    connectionType: 'gemini',
    baseUrl: fixedEnv.geminiBaseUrl,
    apiKey: fixedEnv.geminiApiKey,
    apiKeyFilePath: ''
  };
  return {
    apiConfigs_chunk_0: JSON.stringify({
      v: 2,
      items: [responsesConfig, geminiConfig],
      connectionSources: [responsesSource, geminiSource]
    }),
    apiConfigs_chunks_meta: { count: 1, updatedAt: Date.now() },
    selectedConfigIndex: 0,
    sendChatHistory: true,
    showThoughtProcess: true,
    queueCurrentConversationMessages: true,
    autoGenerateConversationTitle: false
  };
}

function resolvePersistentProfileDir(repoRootPath) {
  const fromEnv = (typeof process.env.CEREBR_CDP_PROFILE_DIR === 'string')
    ? process.env.CEREBR_CDP_PROFILE_DIR.trim()
    : '';
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.join(repoRootPath, 'output', 'playwright', '_profiles', 'cdp_opgg_page_runtime_context');
}

function buildBrowserLaunchArgs(repoRootPath) {
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    ...(runHeadless ? [] : ['--window-position=-2400,-2400', '--window-size=1440,960', '--start-minimized'])
  ];

  if (!skipLoadExtensionArgs) {
    args.unshift(
      '--enable-unsafe-extension-debugging',
      `--load-extension=${repoRootPath}`,
      `--disable-extensions-except=${repoRootPath}`
    );
  }

  return args;
}

async function readSidebarSnapshot(sidebarFrame) {
  return await sidebarFrame.evaluate(() => {
    const input = document.querySelector('#message-input');
    const loadingMessages = Array.from(document.querySelectorAll('.message.loading-message')).map((item) => ({
      messageId: item.getAttribute('data-message-id') || '',
      text: (item.innerText || '').trim(),
      className: item.className || ''
    }));
    const aiMessages = Array.from(document.querySelectorAll('.message.ai-message')).map((item) => ({
      messageId: item.getAttribute('data-message-id') || '',
      text: (item.innerText || '').trim(),
      className: item.className || ''
    }));
    const attemptSnapshot = (typeof window.cerebr?.debug?.messageSender?.__debugGetActiveAttemptsSnapshot === 'function')
      ? window.cerebr.debug.messageSender.__debugGetActiveAttemptsSnapshot()
      : [];
    return {
      inputText: (input?.innerText || '').trim(),
      loadingMessages,
      aiMessages,
      attemptSnapshot,
      apiConfigsLength: Array.isArray(window.apiConfigs) ? window.apiConfigs.length : null,
      apiConfigBaseUrls: Array.isArray(window.apiConfigs) ? window.apiConfigs.map((config) => config?.baseUrl || '') : [],
      selectedConfigIndex: Number.isFinite(Number(window.selectedConfigIndex)) ? Number(window.selectedConfigIndex) : null
    };
  });
}

async function main() {
  await fsp.mkdir(outputDir, { recursive: true });
  const fixedEnv = await loadFixedApiEnv(repoRoot);
  const result = {
    startedAt: new Date().toISOString(),
    outputDir,
    pageUrl,
    browserBinary: externalChromePath || chromium.executablePath(),
    headless: runHeadless,
    forceHangGetJsRuntimeFrames,
    skipLoadExtensionArgs,
    fixedConfig: {
      responsesBaseUrl: fixedEnv.responsesBaseUrl,
      geminiBaseUrl: fixedEnv.geminiBaseUrl,
      responsesModel: 'gpt-5.4',
      geminiModel: 'gemini-3.1-pro-preview'
    },
    console: [],
    steps: []
  };

  const profileDir = resolvePersistentProfileDir(repoRoot);
  await fsp.mkdir(profileDir, { recursive: true });
  result.profileDir = profileDir;

  let context = null;
  let pageCdpSession = null;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: runHeadless,
      ...(externalChromePath ? { executablePath: externalChromePath } : {}),
      ignoreDefaultArgs: ['--disable-extensions'],
      args: buildBrowserLaunchArgs(repoRoot)
    });
    result.steps.push('browser_ready');

    const extensionWorker = await waitFor(async () => (
      context.serviceWorkers().find((worker) => worker.url().endsWith('/src/extension/background.js')) || null
    ), { timeoutMs: 30_000, intervalMs: 300, label: 'extension service worker' });
    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;
    result.extensionWorkerUserScripts = await extensionWorker.evaluate(async () => {
      const summary = {
        hasUserScriptsApi: !!chrome.userScripts,
        hasExecute: typeof chrome?.userScripts?.execute === 'function',
        getScripts: null
      };
      try {
        if (chrome?.userScripts?.getScripts) {
          const scripts = await chrome.userScripts.getScripts();
          summary.getScripts = Array.isArray(scripts) ? `ok:${scripts.length}` : 'ok';
        } else {
          summary.getScripts = 'missing';
        }
      } catch (error) {
        summary.getScripts = error?.message || String(error);
      }
      return summary;
    });
    result.steps.push('background_ready');

    await extensionWorker.evaluate(async (seed) => {
      await chrome.storage.sync.clear();
      await chrome.storage.local.clear();
      await chrome.storage.sync.set(seed);
      return true;
    }, buildStorageSeed(fixedEnv));
    result.steps.push('storage_seeded');

    const page = await context.newPage();
    page.on('console', (msg) => {
      result.console.push({ type: msg.type(), text: msg.text() });
    });
    page.on('pageerror', (error) => {
      result.console.push({ type: 'pageerror', text: String(error && (error.stack || error.message || error)) });
    });

    pageCdpSession = await context.newCDPSession(page);
    await pageCdpSession.send('Network.enable');
    result.network = [];
    pageCdpSession.on('Network.requestWillBeSent', (event) => {
      const url = String(event?.request?.url || '');
      if (!url) return;
      if (
        url.startsWith(fixedEnv.responsesBaseUrl)
        || url.startsWith(fixedEnv.geminiBaseUrl)
      ) {
        result.network.push({
          type: 'requestWillBeSent',
          url,
          method: event?.request?.method || '',
          timestamp: event?.timestamp || 0
        });
      }
    });
    pageCdpSession.on('Network.responseReceived', (event) => {
      const url = String(event?.response?.url || '');
      if (!url) return;
      if (
        url.startsWith(fixedEnv.responsesBaseUrl)
        || url.startsWith(fixedEnv.geminiBaseUrl)
      ) {
        result.network.push({
          type: 'responseReceived',
          url,
          status: Number(event?.response?.status || 0),
          mimeType: event?.response?.mimeType || '',
          timestamp: event?.timestamp || 0
        });
      }
    });
    result.steps.push('page_cdp_ready');

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    result.pageTitleAfterLoad = await page.title();
    result.hostFrameCount = page.frames().length;
    result.hostFrameUrls = page.frames().slice(0, 20).map((frame) => frame.url());
    result.steps.push('host_page_loaded');

    const openSidebarResponse = await extensionWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab || typeof tab.id !== 'number') throw new Error('active tab not found');
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_SIDEBAR' });
      return { tabId: tab.id, response };
    });
    result.openSidebarResponse = openSidebarResponse;
    result.steps.push('sidebar_open_requested');

    const sidebarFrame = await waitFor(async () => {
      return page.frames().find((frame) => frame.url().startsWith(`chrome-extension://${extensionId}/src/ui/sidebar/sidebar.html`)) || null;
    }, { timeoutMs: 30_000, label: 'sidebar frame' });
    await sidebarFrame.locator('#message-input').waitFor({ state: 'visible', timeout: 30_000 });
    await waitFor(async () => {
      return await sidebarFrame.evaluate(() => Array.isArray(window.apiConfigs) && window.apiConfigs.length >= 2);
    }, { timeoutMs: 15_000, intervalMs: 250, label: 'sidebar api configs ready' });
    result.sidebarReadySnapshot = await readSidebarSnapshot(sidebarFrame);
    result.steps.push('sidebar_ready');

    if (forceHangGetJsRuntimeFrames) {
      result.injectedGetJsRuntimeFramesHang = await sidebarFrame.evaluate(() => {
        if (!chrome?.runtime?.sendMessage) return { ok: false, reason: 'runtime.sendMessage unavailable' };
        if (globalThis.__cerebrOriginalRuntimeSendMessage) {
          return { ok: true, alreadyPatched: true };
        }
        const original = chrome.runtime.sendMessage.bind(chrome.runtime);
        globalThis.__cerebrOriginalRuntimeSendMessage = original;
        chrome.runtime.sendMessage = (...args) => {
          const message = args[0];
          if (message && typeof message === 'object' && message.type === 'GET_JS_RUNTIME_FRAMES') {
            return new Promise(() => {});
          }
          return original(...args);
        };
        return { ok: true, alreadyPatched: false };
      });
      result.steps.push('runtime_frames_hang_injected');
    }

    result.directListFramesProbe = await sidebarFrame.evaluate(async (timeoutMs) => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab || typeof tab.id !== 'number') {
        return { ok: false, error: 'active tab not found', durationMs: 0 };
      }
      const startedAt = Date.now();
      try {
        const probe = await Promise.race([
          chrome.runtime.sendMessage({ type: 'GET_JS_RUNTIME_FRAMES', tabId: tab.id }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('GET_JS_RUNTIME_FRAMES timeout')), timeoutMs))
        ]);
        return {
          ok: probe?.success === true,
          success: probe?.success === true,
          durationMs: Date.now() - startedAt,
          tabId: tab.id,
          frameCount: Array.isArray(probe?.frames) ? probe.frames.length : null,
          frames: Array.isArray(probe?.frames) ? probe.frames.slice(0, 20) : [],
          error: probe?.success === true ? '' : (probe?.error || ''),
          raw: probe
        };
      } catch (error) {
        return {
          ok: false,
          success: false,
          durationMs: Date.now() - startedAt,
          tabId: tab.id,
          error: error?.message || String(error)
        };
      }
    }, JS_RUNTIME_LIST_FRAMES_TIMEOUT_MS);
    result.steps.push('direct_list_frames_probed');

    const input = sidebarFrame.locator('#message-input');
    await input.fill('请只回复 OK。');
    await input.press('Enter');
    result.steps.push('message_sent');

    const statusHistory = [];
    const progressed = await waitFor(async () => {
      const snapshot = await readSidebarSnapshot(sidebarFrame);
      statusHistory.push({
        elapsedMs: statusHistory.length === 0 ? 0 : undefined,
        snapshot
      });
      const attempt = Array.isArray(snapshot.attemptSnapshot) ? snapshot.attemptSnapshot[0] || null : null;
      const stage = attempt?.pendingLoadingStatusStage || '';
      const latestLoadingText = snapshot.loadingMessages[0]?.text || '';
      const latestAiText = snapshot.aiMessages[snapshot.aiMessages.length - 1]?.text || '';
      if (stage && stage !== 'get_js_runtime_frames') {
        return {
          reason: 'attempt_stage_progressed',
          stage,
          latestLoadingText,
          latestAiText,
          snapshot
        };
      }
      if (latestAiText && !/正在获取页面运行环境上下文/.test(latestAiText)) {
        return {
          reason: 'ai_message_progressed',
          stage,
          latestLoadingText,
          latestAiText,
          snapshot
        };
      }
      return null;
    }, { timeoutMs: SEND_PROGRESS_TIMEOUT_MS, intervalMs: 500, label: 'message send progress beyond get_js_runtime_frames' }).catch((error) => ({
      reason: 'timeout',
      error: error?.message || String(error),
      snapshot: null
    }));

    result.sendProgress = progressed;
    result.statusHistory = statusHistory.map((entry, index) => ({
      elapsedMs: index * 500,
      snapshot: entry.snapshot
    }));
    result.finalSidebarSnapshot = await readSidebarSnapshot(sidebarFrame);
    await page.screenshot({ path: path.join(outputDir, 'opgg-sidebar-state.png'), fullPage: true });
    await fsp.writeFile(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');

    if (progressed?.reason === 'timeout') {
      throw new Error('发送消息在 get_js_runtime_frames 阶段未能前进，详见 output result.json');
    }
  } finally {
    if (pageCdpSession) {
      try { await pageCdpSession.detach(); } catch (_) {}
    }
    if (context) {
      try { await context.close(); } catch (_) {}
    }
  }
}

main().catch(async (error) => {
  const outputPath = path.join(outputDir, 'result.error.txt');
  try {
    await fsp.mkdir(outputDir, { recursive: true });
    await fsp.writeFile(outputPath, String(error && (error.stack || error.message || error)), 'utf8');
  } catch (_) {}
  console.error(error);
  process.exitCode = 1;
});
