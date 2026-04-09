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

const [
  rawRepoRoot,
  rawOutputDir,
  rawChromePath
] = process.argv.slice(2);

if (!rawRepoRoot || !rawOutputDir) {
  throw new Error(
    'Usage: node tests/cdp_request_user_input_screenshot_probe.cjs <repoRoot> <outputDir> [chromePath]'
  );
}

const repoRoot = path.resolve(rawRepoRoot);
const outputDir = path.resolve(rawOutputDir);
const chromePath = (typeof rawChromePath === 'string' && rawChromePath.trim())
  ? rawChromePath.trim()
  : resolveStableChromeExecutablePath();
const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);

async function collectLayoutSamples(sidebarFrame) {
  return await sidebarFrame.evaluate(async () => {
    const samples = [];
    const rectOf = (node) => {
      const rect = node?.getBoundingClientRect?.();
      return rect ? {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      } : null;
    };
    const collect = () => {
      const body = document.body;
      const panel = document.querySelector('.composer-request-panel');
      const accessory = document.querySelector('#composer-accessory-region');
      const messageRow = document.querySelector('#message-row');
      samples.push({
        t: performance.now(),
        bodyRect: rectOf(body),
        panelRect: rectOf(panel),
        accessoryRect: rectOf(accessory),
        messageRowRect: rectOf(messageRow),
        scrollHeight: body?.scrollHeight || null,
        clientHeight: body?.clientHeight || null,
        animationCount: document.getAnimations({ subtree: true }).length
      });
    };

    collect();
    await new Promise((resolve) => setTimeout(resolve, 250));
    collect();
    await new Promise((resolve) => setTimeout(resolve, 250));
    collect();
    await new Promise((resolve) => setTimeout(resolve, 250));
    collect();
    await new Promise((resolve) => setTimeout(resolve, 250));
    collect();
    return samples;
  });
}

async function main() {
  await fsp.mkdir(outputDir, { recursive: true });

  const result = {
    startedAt: new Date().toISOString(),
    outputDir,
    chromePath,
    headless: runHeadless,
    steps: [],
    screenshotAttempts: []
  };

  const profileDir = resolveFixedSidebarProfileDir(repoRoot);
  await fsp.mkdir(profileDir, { recursive: true });
  result.profileDir = profileDir;

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

    const page = context.pages().find((entry) => entry.url().startsWith('https://example.com/')) || await context.newPage();
    page.on('console', (msg) => {
      result.console = result.console || [];
      result.console.push({ type: msg.type(), text: msg.text() });
    });
    page.on('pageerror', (error) => {
      result.console = result.console || [];
      result.console.push({ type: 'pageerror', text: String(error && (error.stack || error.message || error)) });
    });

    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    result.steps.push('host_loaded');

    await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      return payload?.response?.debugState?.initialized ? true : null;
    }, { timeoutMs: 15_000, intervalMs: 250, label: 'sidebar initialized' });

    await extensionWorker.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'OPEN_SIDEBAR' }))
    );
    result.steps.push('sidebar_open_requested');

    await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      return payload?.response?.debugState?.isActuallyVisible ? true : null;
    }, { timeoutMs: 15_000, intervalMs: 250, label: 'sidebar visible' });
    result.steps.push('sidebar_visible');

    const sidebarFrame = await waitForSidebarFrame(page, extensionId, { timeoutMs: 30_000 });
    await sidebarFrame.locator('#message-input').waitFor({ state: 'visible', timeout: 30_000 });
    result.steps.push('sidebar_ready');

    await sidebarFrame.evaluate(async () => {
      if (!window.cerebr?.showRequestUserInputDemo) {
        throw new Error('showRequestUserInputDemo unavailable');
      }
      window.__requestUserInputProbe = window.cerebr.showRequestUserInputDemo();
      return true;
    });
    await sidebarFrame.locator('.composer-request-panel').waitFor({ state: 'visible', timeout: 15_000 });
    result.steps.push('demo_opened');

    result.layoutSamples = await collectLayoutSamples(sidebarFrame);
    result.animationSnapshot = await sidebarFrame.evaluate(() => (
      document.getAnimations({ subtree: true }).map((animation) => ({
        playState: animation.playState,
        currentTime: animation.currentTime,
        targetId: animation.effect?.target?.id || null,
        targetClass: typeof animation.effect?.target?.className === 'string' ? animation.effect.target.className : null,
        duration: animation.effect?.getTiming?.().duration ?? null,
        iterations: animation.effect?.getTiming?.().iterations ?? null
      }))
    ));

    const attempts = [
      {
        label: 'panel-default',
        locator: sidebarFrame.locator('.composer-request-panel'),
        outputName: 'panel-default.png',
        screenshotOptions: { timeout: 5_000 }
      },
      {
        label: 'panel-animations-disabled',
        locator: sidebarFrame.locator('.composer-request-panel'),
        outputName: 'panel-animations-disabled.png',
        screenshotOptions: { timeout: 5_000, animations: 'disabled' }
      },
      {
        label: 'body-default',
        locator: sidebarFrame.locator('body'),
        outputName: 'body-default.png',
        screenshotOptions: { timeout: 5_000 }
      },
      {
        label: 'body-animations-disabled',
        locator: sidebarFrame.locator('body'),
        outputName: 'body-animations-disabled.png',
        screenshotOptions: { timeout: 5_000, animations: 'disabled' }
      }
    ];

    for (const attempt of attempts) {
      const startedAt = Date.now();
      try {
        await attempt.locator.screenshot({
          path: path.join(outputDir, attempt.outputName),
          ...attempt.screenshotOptions
        });
        result.screenshotAttempts.push({
          label: attempt.label,
          ok: true,
          elapsedMs: Date.now() - startedAt
        });
      } catch (error) {
        result.screenshotAttempts.push({
          label: attempt.label,
          ok: false,
          elapsedMs: Date.now() - startedAt,
          error: String(error && (error.stack || error.message || error))
        });
      }
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
