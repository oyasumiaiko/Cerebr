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
const rawOutputDir = args[1];
const rawPageUrl = (typeof args[2] === 'string' && !args[2].startsWith('--')) ? args[2] : '';
const rawExtraArgs = args.slice(rawPageUrl ? 3 : 2);

if (!rawRepoRoot || !rawOutputDir) {
  throw new Error(
    'Usage: node tests/cdp_responses_compact_har_followup_probe.cjs <repoRoot> <outputDir> [pageUrl] --variant-body-path=<path> [--variant-body-path=<path> ...]'
  );
}

const repoRoot = path.resolve(rawRepoRoot);
const outputDir = path.resolve(rawOutputDir);
const extensionRoot = path.resolve(__dirname, '..');
const pageUrl = (typeof rawPageUrl === 'string' && rawPageUrl.trim())
  ? rawPageUrl.trim()
  : 'https://example.com/';
const variantBodyPaths = rawExtraArgs
  .filter((item) => typeof item === 'string' && item.startsWith('--variant-body-path='))
  .map((item) => path.resolve(item.slice('--variant-body-path='.length).trim()))
  .filter(Boolean);
if (variantBodyPaths.length <= 0) {
  throw new Error('至少需要提供一个 --variant-body-path=<path>');
}

const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);

function buildStorageSeed(fixedEnv) {
  const responsesSourceId = 'src_fixed_compact_har_followup_probe';
  const responsesConfig = {
    id: 'cfg_fixed_compact_har_followup_probe',
    connectionSourceId: responsesSourceId,
    displayName: 'Fixed Compact HAR Follow-up Probe',
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
  }, { timeoutMs: 30_000, intervalMs: 250, label: 'sidebar ready for compact har followup probe' });
}

async function postJsonFromSidebar(sidebarFrame, payload) {
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
        parsed,
        responsePreview: text.slice(0, 1000)
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
        parsed: null,
        responsePreview: '',
        requestError: String(error && (error.message || error))
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }, payload);
}

function buildFollowupQuestions() {
  return [
    {
      id: 'field_count',
      question: '根据前文，当前这个配置下字段一共多少个？只回答数字。',
      expectedSubstrings: ['2646']
    },
    {
      id: 'scope',
      question: '根据前文，当前配置是什么？只回答 instrumentType / region / delay / universe，例如 EQUITY / USA / D1 / TOP3000。',
      expectedSubstrings: ['EQUITY / USA / D1 / TOP3000', 'EQUITY/USA/D1/TOP3000']
    }
  ];
}

function extractTextFromOutput(parsed) {
  const output = Array.isArray(parsed?.output) ? parsed.output : [];
  const segments = [];
  output.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    if (String(item.type || '').trim().toLowerCase() !== 'message') return;
    (Array.isArray(item.content) ? item.content : []).forEach((part) => {
      if (typeof part?.text === 'string' && part.text.trim()) {
        segments.push(part.text.trim());
      }
    });
  });
  return segments.join('\n');
}

function buildFollowupBody(compactBody, compactOutput, question) {
  const body = {
    model: compactBody.model,
    input: [
      ...JSON.parse(JSON.stringify(compactOutput)),
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: question
          }
        ]
      }
    ],
    store: false,
    stream: false,
    text: JSON.parse(JSON.stringify(compactBody.text || { verbosity: 'low' }))
  };
  if (compactBody.instructions) {
    body.instructions = compactBody.instructions;
  }
  if (compactBody.reasoning && typeof compactBody.reasoning === 'object') {
    body.reasoning = JSON.parse(JSON.stringify(compactBody.reasoning));
  }
  return body;
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const fixedEnv = await loadFixedApiEnv(repoRoot);
  const resultPath = path.join(outputDir, 'result.json');
  const questions = buildFollowupQuestions();
  const result = {
    startedAt: new Date().toISOString(),
    outputDir,
    pageUrl,
    browserBinary: 'playwright:chromium',
    headless: runHeadless,
    compactUrl: `${fixedEnv.responsesBaseUrl.replace(/\/+$/, '')}/compact`,
    responsesUrl: fixedEnv.responsesBaseUrl,
    questions,
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

    const sidebarFrame = await waitForSidebarFrame(page, extensionId, { timeoutMs: 30_000 });
    await sidebarFrame.locator('#message-input').waitFor({ state: 'visible', timeout: 30_000 });
    await waitForSidebarReady(sidebarFrame, fixedEnv);
    result.steps.push('sidebar_ready');

    for (let index = 0; index < variantBodyPaths.length; index += 1) {
      const bodyPath = variantBodyPaths[index];
      const compactBody = JSON.parse(await fs.readFile(bodyPath, 'utf8'));
      const variantId = path.parse(bodyPath).name;
      const variantDir = path.join(outputDir, variantId);
      await fs.mkdir(variantDir, { recursive: true });

      console.log(`[${index + 1}/${variantBodyPaths.length}] ${variantId}`);
      const compactStartedAt = Date.now();
      const compactResult = await postJsonFromSidebar(sidebarFrame, {
        url: result.compactUrl,
        apiKey: fixedEnv.responsesApiKey,
        body: compactBody,
        timeoutMs: 300_000
      });
      const compactOutput = Array.isArray(compactResult?.parsed?.output) ? compactResult.parsed.output : [];

      await fs.writeFile(
        path.join(variantDir, 'compact_request.json'),
        JSON.stringify(compactBody, null, 2),
        'utf8'
      );
      await fs.writeFile(
        path.join(variantDir, 'compact_result.json'),
        JSON.stringify(compactResult, null, 2),
        'utf8'
      );

      const followups = [];
      if (compactResult.ok && compactResult.jsonOk && compactOutput.length > 0) {
        for (const question of questions) {
          const followupBody = buildFollowupBody(compactBody, compactOutput, question.question);
          const followupStartedAt = Date.now();
          const followupResult = await postJsonFromSidebar(sidebarFrame, {
            url: result.responsesUrl,
            apiKey: fixedEnv.responsesApiKey,
            body: followupBody,
            timeoutMs: 300_000
          });
          const answerText = extractTextFromOutput(followupResult.parsed);
          const matched = question.expectedSubstrings.some((item) => answerText.includes(item));
          const followupRecord = {
            id: question.id,
            question: question.question,
            expectedSubstrings: question.expectedSubstrings,
            requestBytes: Buffer.byteLength(JSON.stringify(followupBody), 'utf8'),
            response: {
              status: followupResult.status,
              ok: followupResult.ok,
              jsonOk: followupResult.jsonOk,
              responseBytes: followupResult.responseBytes,
              durationMs: Date.now() - followupStartedAt,
              responsePreview: followupResult.responsePreview
            },
            answerText,
            matched
          };
          followups.push(followupRecord);
          await fs.writeFile(
            path.join(variantDir, `followup_${question.id}_request.json`),
            JSON.stringify(followupBody, null, 2),
            'utf8'
          );
          await fs.writeFile(
            path.join(variantDir, `followup_${question.id}_result.json`),
            JSON.stringify({ ...followupResult, answerText, matched }, null, 2),
            'utf8'
          );
        }
      }

      result.variants.push({
        id: variantId,
        bodyPath,
        compactRequestBytes: Buffer.byteLength(JSON.stringify(compactBody), 'utf8'),
        compactResult: {
          status: compactResult.status,
          ok: compactResult.ok,
          jsonOk: compactResult.jsonOk,
          responseBytes: compactResult.responseBytes,
          outputCount: compactOutput.length,
          durationMs: Date.now() - compactStartedAt,
          responsePreview: compactResult.responsePreview
        },
        followups
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
