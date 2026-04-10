const fsp = require('fs/promises');
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
  waitForSidebarFrame
} = require('./lib/stable_chrome_sidebar_harness.cjs');

const [
  rawRepoRoot,
  rawOutputDir,
  rawPageUrl
] = process.argv.slice(2);

if (!rawRepoRoot || !rawOutputDir) {
  throw new Error(
    'Usage: node tests/cdp_js_repl_serial_order_probe.cjs <repoRoot> <outputDir> [pageUrl=https://example.com/]'
  );
}

const repoRoot = path.resolve(rawRepoRoot);
const outputDir = path.resolve(rawOutputDir);
const pageUrl = (typeof rawPageUrl === 'string' && rawPageUrl.trim())
  ? rawPageUrl.trim()
  : 'https://example.com/';
const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);

async function main() {
  await fsp.mkdir(outputDir, { recursive: true });

  const result = {
    startedAt: new Date().toISOString(),
    outputDir,
    pageUrl,
    headless: runHeadless,
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

    const extensionWorker = await reloadUnpackedExtension(context, { timeoutMs: 30_000 });
    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;
    result.steps.push('background_ready');
    result.steps.push('extension_reloaded');

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
    result.steps.push('sidebar_ready');

    const probe = await sidebarFrame.evaluate(async () => {
      const send = (message) => new Promise((resolve) => {
        chrome.runtime.sendMessage(message, (response) => {
          resolve({
            response: response === undefined ? null : response,
            lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null
          });
        });
      });

      const initialReset = await send({ type: 'RESET_JS_REPL' });

      const phaseOne = await Promise.all([
        send({
          type: 'EXECUTE_JS_REPL',
          code: [
            'globalThis.__serialProbe = [];',
            '__serialProbe.push("A-start");',
            'await new Promise((resolve) => setTimeout(resolve, 250));',
            '__serialProbe.push("A-end");',
            'return __serialProbe.slice();'
          ].join('\n')
        }),
        send({
          type: 'EXECUTE_JS_REPL',
          code: [
            '__serialProbe.push("B");',
            'return __serialProbe.slice();'
          ].join('\n')
        })
      ]);

      const phaseTwo = await Promise.all([
        send({ type: 'RESET_JS_REPL' }),
        send({
          type: 'EXECUTE_JS_REPL',
          code: 'return typeof __serialProbe;'
        })
      ]);

      const finalRead = await send({
        type: 'EXECUTE_JS_REPL',
        code: 'return typeof __serialProbe;'
      });

      return {
        initialReset,
        phaseOne,
        phaseTwo,
        finalRead
      };
    });

    result.probe = probe;
    result.ok = (
      probe?.initialReset?.lastError === null
      && probe?.phaseOne?.[0]?.lastError === null
      && probe?.phaseOne?.[1]?.lastError === null
      && probe?.phaseTwo?.[0]?.lastError === null
      && probe?.phaseTwo?.[1]?.lastError === null
      && probe?.finalRead?.lastError === null
      && Array.isArray(probe?.phaseOne?.[0]?.response?.value)
      && Array.isArray(probe?.phaseOne?.[1]?.response?.value)
      && probe.phaseOne[0].response.value.join('|') === 'A-start|A-end'
      && probe.phaseOne[1].response.value.join('|') === 'A-start|A-end|B'
      && probe.phaseTwo[1]?.response?.value === 'undefined'
      && probe.finalRead?.response?.value === 'undefined'
    );

    result.finishedAt = new Date().toISOString();
    await fsp.writeFile(
      path.join(outputDir, 'result.json'),
      JSON.stringify(result, null, 2),
      'utf8'
    );

    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

main().catch(async (error) => {
  const failure = {
    ok: false,
    error: String(error && (error.stack || error.message || error)),
    finishedAt: new Date().toISOString()
  };
  try {
    await fsp.mkdir(outputDir, { recursive: true });
    await fsp.writeFile(
      path.join(outputDir, 'result.json'),
      JSON.stringify(failure, null, 2),
      'utf8'
    );
  } catch (_) {}
  console.error(failure.error);
  process.exit(1);
});
