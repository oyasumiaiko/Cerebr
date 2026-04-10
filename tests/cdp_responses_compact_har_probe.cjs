const fs = require('fs/promises');
const path = require('path');
const {
  loadPlaywright,
  shouldRunHeadless,
  waitFor,
  waitForExtensionWorker,
  waitForSidebarFrame
} = require('./lib/stable_chrome_sidebar_harness.cjs');
const { loadFixedApiEnv } = require('./lib/fixed_api_env.cjs');

const args = process.argv.slice(2);
const rawRepoRoot = args[0];
const rawVariantResultPath = args[1];
const rawOutputDir = args[2];
const rawFourthArg = args[3];
const rawPageUrl = (typeof rawFourthArg === 'string' && !rawFourthArg.startsWith('--')) ? rawFourthArg : '';
const rawExtraArgs = args.slice(rawPageUrl ? 4 : 3);

if (!rawRepoRoot || !rawVariantResultPath || !rawOutputDir) {
  throw new Error(
    'Usage: node tests/cdp_responses_compact_har_probe.cjs <repoRoot> <variantResultPath> <outputDir> [pageUrl]'
  );
}

const repoRoot = path.resolve(rawRepoRoot);
const variantResultPath = path.resolve(rawVariantResultPath);
const outputDir = path.resolve(rawOutputDir);
const extensionRoot = path.resolve(__dirname, '..');
const pageUrl = (typeof rawPageUrl === 'string' && rawPageUrl.trim())
  ? rawPageUrl.trim()
  : 'https://example.com/';
const variantIncludePattern = (() => {
  const flag = rawExtraArgs.find((item) => typeof item === 'string' && item.startsWith('--variant-pattern='));
  if (!flag) return null;
  const raw = flag.slice('--variant-pattern='.length).trim();
  return raw ? new RegExp(raw, 'i') : null;
})();
const perRequestTimeoutMs = (() => {
  const flag = rawExtraArgs.find((item) => typeof item === 'string' && item.startsWith('--timeout-ms='));
  const parsed = Number(flag ? flag.slice('--timeout-ms='.length).trim() : 30_000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
})();
const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);

function buildStorageSeed(fixedEnv) {
  const responsesSourceId = 'src_fixed_compact_har_probe';
  const responsesConfig = {
    id: 'cfg_fixed_compact_har_probe',
    connectionSourceId: responsesSourceId,
    displayName: 'Fixed Compact HAR Probe',
    modelName: 'gpt-5.4',
    customParams: '',
    customSystemPrompt: '',
    temperature: 0,
    useStreaming: false,
    isFavorite: false,
    userMessagePreprocessorTemplate: '',
    userMessagePreprocessorIncludeInHistory: false,
    responsesApiSettings: {
      reasoning: {
        effort: 'low',
        summary: 'detailed'
      },
      parallel_tool_calls: true,
      store: false,
      text: {
        verbosity: 'low'
      },
      builtin_tools: {
        web_search: { enabled: false },
        code_interpreter: { enabled: false },
        tool_search: { enabled: false }
      }
    },
    responsesLocalCompaction: {
      enabled: false,
      thresholdPromptTokens: 120000
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
    sendChatHistory: true
  };
}

async function waitForSidebarReady(sidebarFrame, fixedEnv) {
  return await waitFor(async () => {
    return await sidebarFrame.evaluate((baseUrl) => {
      const configs = Array.isArray(window.apiConfigs) ? window.apiConfigs : [];
      if (configs.length <= 0) return null;
      const hasTarget = configs.some((config) => (config?.baseUrl || '') === baseUrl);
      if (!hasTarget) return null;
      if (!document.querySelector('#message-input')) return null;
      return {
        apiConfigsLength: configs.length,
        selectedConfigIndex: Number.isFinite(Number(window.selectedConfigIndex)) ? Number(window.selectedConfigIndex) : null
      };
    }, fixedEnv.responsesBaseUrl);
  }, { timeoutMs: 30_000, intervalMs: 250, label: 'sidebar ready for compact har probe' });
}

async function probeCompactRequestFromSidebar(sidebarFrame, payload) {
  return await sidebarFrame.evaluate(async (input) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort('timeout'), input.timeoutMs);
    try {
      const response = await fetch(input.url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${input.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(input.body),
        signal: controller.signal
      });
      const text = await response.text().catch(() => '');
      let parsed = null;
      let jsonOk = false;
      let jsonError = '';
      if (text.trim()) {
        try {
          parsed = JSON.parse(text);
          jsonOk = true;
        } catch (error) {
          jsonError = String(error && (error.message || error));
        }
      }
      return {
        status: response.status,
        ok: response.ok,
        responseBytes: Array.from(new TextEncoder().encode(text)).length,
        contentType: response.headers.get('content-type') || '',
        contentLengthHeader: response.headers.get('content-length') || '',
        jsonOk,
        jsonError,
        outputCount: Array.isArray(parsed?.output) ? parsed.output.length : null,
        errorField: parsed?.error || null,
        responsePreview: text.slice(0, 500)
      };
    } catch (error) {
      return {
        status: null,
        ok: false,
        responseBytes: 0,
        contentType: '',
        contentLengthHeader: '',
        jsonOk: false,
        jsonError: '',
        outputCount: null,
        errorField: null,
        responsePreview: '',
        requestError: String(error && (error.message || error))
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }, payload);
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const fixedEnv = await loadFixedApiEnv(repoRoot);
  const variantManifest = JSON.parse(await fs.readFile(variantResultPath, 'utf8'));
  const resultPath = path.join(outputDir, 'result.json');
  const result = {
    startedAt: new Date().toISOString(),
    variantResultPath,
    outputDir,
    pageUrl,
    browserBinary: 'playwright:chromium',
    headless: runHeadless,
    probeUrl: `${fixedEnv.responsesBaseUrl.replace(/\/+$/, '')}/compact`,
    variants: [],
    console: [],
    steps: []
  };
  async function flushResult() {
    await fs.writeFile(resultPath, JSON.stringify(result, null, 2), 'utf8');
  }

  const profileDir = path.join(outputDir, '_profile');
  await fs.rm(profileDir, { recursive: true, force: true });

  let context = null;
  let sidebarFrame = null;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: runHeadless,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-search-engine-choice-screen',
        `--disable-extensions-except=${extensionRoot}`,
        `--load-extension=${extensionRoot}`,
        ...(runHeadless ? [] : ['--window-position=-2400,-2400', '--window-size=1440,960', '--start-minimized'])
      ]
    });
    result.steps.push('browser_ready');

    const extensionWorker = await waitForExtensionWorker(context, { timeoutMs: 30_000 });
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
    result.steps.push('sidebar_ready');

    const runnableVariants = variantIncludePattern
      ? variantManifest.variants.filter((variant) => variantIncludePattern.test(String(variant.id || '')))
      : variantManifest.variants;
    result.runnableVariantCount = runnableVariants.length;
    await flushResult();

    for (let index = 0; index < runnableVariants.length; index += 1) {
      const variant = runnableVariants[index];
      const body = JSON.parse(await fs.readFile(variant.body_path, 'utf8'));
      console.log(
        `[${index + 1}/${runnableVariants.length}] ${variant.id} bytes=${variant.request_summary?.request_bytes} approx_visible_tokens=${variant.request_summary?.approx_visible_text_tokens_o200k}`
      );
      const startedAt = Date.now();
      const networkResult = await probeCompactRequestFromSidebar(sidebarFrame, {
        url: result.probeUrl,
        apiKey: fixedEnv.responsesApiKey,
        body,
        timeoutMs: perRequestTimeoutMs
      });
      result.variants.push({
        id: variant.id,
        instructionsMode: variant.instructions_mode,
        targetRequestBytes: variant.target_request_bytes,
        requestSummary: variant.request_summary,
        networkResult: {
          ...networkResult,
          durationMs: Date.now() - startedAt
        }
      });
      await flushResult();
    }

    result.ok = true;
  } catch (error) {
    result.ok = false;
    result.error = String(error && (error.stack || error.message || error));
  } finally {
    result.finishedAt = new Date().toISOString();
    await flushResult();
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
