const fsp = require('fs/promises');
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
const { loadFixedApiEnv } = require('./lib/fixed_api_env.cjs');

const [
  rawRepoRoot,
  rawOutputDir,
  rawPageUrl,
  rawModelName
] = process.argv.slice(2);

if (!rawRepoRoot || !rawOutputDir) {
  throw new Error(
    'Usage: node tests/cdp_js_repl_live_smoke.cjs <repoRoot> <outputDir> [pageUrl=https://example.com/] [modelName=gpt-5.4]'
  );
}

const repoRoot = path.resolve(rawRepoRoot);
const outputDir = path.resolve(rawOutputDir);
const pageUrl = (typeof rawPageUrl === 'string' && rawPageUrl.trim())
  ? rawPageUrl.trim()
  : 'https://example.com/';
const modelName = (typeof rawModelName === 'string' && rawModelName.trim())
  ? rawModelName.trim()
  : 'gpt-5.4';
const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);

function buildLiveResponsesStorageSeed({ baseUrl, apiKey, modelName: selectedModel }) {
  return {
    apiConfigs: [{
      id: 'cfg_live_js_repl_smoke',
      displayName: 'Live JS REPL Smoke',
      modelName: selectedModel,
      baseUrl,
      connectionType: 'openai_responses',
      apiKey,
      customParams: '',
      customSystemPrompt: '',
      temperature: 1,
      useStreaming: true,
      responsesApiSettings: {
        reasoning: {
          effort: 'medium',
          generate_summary: 'detailed',
          summary: 'detailed'
        },
        text: {
          verbosity: 'low'
        },
        parallel_tool_calls: true,
        store: false,
        builtin_tools: {
          web_search: {
            enabled: false,
            external_web_access: false,
            include_sources: false
          }
        }
      }
    }],
    selectedConfigIndex: 0,
    sendChatHistory: true,
    showThoughtProcess: true,
    queueCurrentConversationMessages: true
  };
}

function buildJsReplPersistResetPrompt() {
  return [
    'Use the browser js_repl tool on the current page.',
    'Do not use js_runtime_execute.',
    'Step 1: call js_repl to run `const savedTitle = document.title; return { savedTitle, href: location.href };`.',
    'Step 2: call js_repl again to run `return { savedTitle, href: location.href };` so you prove the binding persisted.',
    'Step 3: call js_repl_reset with null frame_ids.',
    'Step 4: call js_repl again to run `return typeof savedTitle;`.',
    'Final answer must be exactly three lines:',
    'persist=<savedTitle>',
    'href=<href>',
    'after_reset=<type>'
  ].join(' ');
}

async function main() {
  await fsp.mkdir(outputDir, { recursive: true });

  const fixedEnv = await loadFixedApiEnv(repoRoot);
  const result = {
    startedAt: new Date().toISOString(),
    outputDir,
    pageUrl,
    modelName,
    headless: runHeadless,
    baseUrlHost: (() => {
      try {
        return new URL(fixedEnv.responsesBaseUrl).host;
      } catch (_) {
        return null;
      }
    })(),
    steps: [],
    console: []
  };

  const profileDir = resolveFixedSidebarProfileDir(repoRoot);
  const chromePath = resolveStableChromeExecutablePath();
  let context = null;

  try {
    context = await launchFixedSidebarContext({
      chromium,
      profileDir,
      executablePath: chromePath,
      headless: runHeadless
    });
    result.steps.push('browser_ready');

    const extensionWorker = await waitForExtensionWorker(context, { timeoutMs: 30_000 });
    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;
    result.steps.push('background_ready');

    const storageSeed = buildLiveResponsesStorageSeed({
      baseUrl: fixedEnv.responsesBaseUrl,
      apiKey: fixedEnv.responsesApiKey,
      modelName
    });
    await extensionWorker.evaluate(`(async () => {
      await chrome.storage.sync.clear();
      await chrome.storage.sync.set(${JSON.stringify(storageSeed)});
      return true;
    })()`);
    result.steps.push('storage_seeded');

    const page = context.pages().find((entry) => entry.url().startsWith(pageUrl)) || await context.newPage();
    page.on('console', (msg) => {
      result.console.push({ type: msg.type(), text: msg.text() });
    });
    page.on('pageerror', (error) => {
      result.console.push({ type: 'pageerror', text: String(error && (error.stack || error.message || error)) });
    });

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
    result.steps.push('page_loaded');

    await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      return payload?.response?.debugState?.initialized ? true : null;
    }, { timeoutMs: 15_000, intervalMs: 250, label: 'sidebar initialized' });
    result.steps.push('sidebar_initialized');

    await extensionWorker.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'OPEN_SIDEBAR' }))
    );
    result.steps.push('sidebar_open_requested');

    const sidebarFrame = await waitForSidebarFrame(page, extensionId, { timeoutMs: 30_000 });
    await sidebarFrame.locator('#message-input').waitFor({ state: 'visible', timeout: 30_000 });
    await waitFor(async () => {
      return await sidebarFrame.evaluate(() => Array.isArray(window.apiConfigs) && window.apiConfigs.length > 0);
    }, { timeoutMs: 15_000, intervalMs: 250, label: 'sidebar api configs ready' });
    result.configSnapshot = await sidebarFrame.evaluate(() => ({
      configCount: Array.isArray(window.apiConfigs) ? window.apiConfigs.length : 0,
      selectedModel: Array.isArray(window.apiConfigs) ? (window.apiConfigs[0]?.modelName || null) : null,
      selectedBaseUrlHost: (() => {
        try {
          const config = Array.isArray(window.apiConfigs) ? window.apiConfigs[0] : null;
          return config?.baseUrl ? new URL(config.baseUrl).host : null;
        } catch (_) {
          return null;
        }
      })()
    }));
    result.steps.push('sidebar_ready');

    const prompt = buildJsReplPersistResetPrompt();
    result.prompt = prompt;

    const input = sidebarFrame.locator('#message-input');
    await input.fill(prompt);
    await input.press('Enter');
    result.steps.push('prompt_sent');

    const finalState = await waitFor(async () => {
      return await sidebarFrame.evaluate(() => {
        const aiMessages = Array.from(document.querySelectorAll('.message.ai-message'));
        const latest = aiMessages[aiMessages.length - 1] || null;
        if (!latest || latest.classList.contains('loading-message') || latest.classList.contains('updating')) return null;
        const text = (latest.querySelector('.text-content')?.innerText || latest.innerText || '').trim();
        if (!/persist=/.test(text) || !/after_reset=/.test(text)) return null;
        const toolEntries = Array.from(latest.querySelectorAll('.response-activity-entry--tool')).map((item) => ({
          summary: (item.querySelector('.response-activity-tool-summary')?.innerText || '').trim(),
          output: (item.querySelector('.response-activity-tool-output')?.innerText || '').trim()
        }));
        return {
          text,
          toolEntries,
          toolEntryCount: toolEntries.length
        };
      });
    }, { timeoutMs: 240_000, intervalMs: 1000, label: 'js_repl final assistant state' });

    result.finalState = finalState;
    result.steps.push('assistant_completed');

    try {
      await sidebarFrame.locator('body').screenshot({
        path: path.join(outputDir, 'sidebar-body-final.png')
      });
      result.sidebarScreenshot = 'sidebar-body-final.png';
    } catch (error) {
      result.sidebarScreenshotError = String(error && (error.stack || error.message || error));
    }

    result.ok = true;
  } catch (error) {
    result.ok = false;
    result.error = String(error && (error.stack || error.message || error));
  } finally {
    try { await context?.close(); } catch (_) {}
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
