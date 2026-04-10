const fsp = require('fs/promises');
const path = require('path');
const {
  buildSendContentMessageExpression,
  launchWorktreeUnpackedChromiumContext,
  loadPlaywright,
  resolveWorktreeUnpackedProfileDir,
  shouldRunHeadless,
  waitFor,
  waitForSidebarFrame,
  waitForWorktreeExtensionWorker
} = require('./lib/worktree_unpacked_extension_harness.cjs');

const [rawRepoRoot, outputDir, targetUrl = 'https://example.com/'] = process.argv.slice(2);
const repoRoot = rawRepoRoot ? path.resolve(rawRepoRoot) : '';

if (!repoRoot || !outputDir) {
  throw new Error(
    'Usage: node tests/cdp_worktree_unpacked_sidebar_probe.cjs <repoRoot> <outputDir> [targetUrl=https://example.com/]'
  );
}

const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);

async function main() {
  await fsp.mkdir(outputDir, { recursive: true });

  const result = {
    startedAt: new Date().toISOString(),
    outputDir,
    targetUrl,
    launchMode: 'worktree_unpacked',
    headless: runHeadless,
    steps: []
  };

  const profileDir = resolveWorktreeUnpackedProfileDir(repoRoot, 'sidebar-probe');
  await fsp.mkdir(profileDir, { recursive: true });
  result.profileDir = profileDir;

  let context = null;
  try {
    context = await launchWorktreeUnpackedChromiumContext({
      chromium,
      repoRoot,
      profileDir,
      headless: runHeadless
    });
    result.steps.push('browser_ready');

    const page = context.pages()[0] || await context.newPage();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    result.steps.push('page_loaded');

    const extensionWorker = await waitForWorktreeExtensionWorker(context, { timeoutMs: 30_000 });
    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;
    result.steps.push('worker_ready');

    const openSidebarResponse = await extensionWorker.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'OPEN_SIDEBAR' }))
    );
    result.openSidebarResponse = openSidebarResponse;
    result.steps.push('sidebar_open_requested');

    const sidebarDebugState = await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      return payload?.response?.debugState?.isActuallyVisible ? payload.response.debugState : null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 250,
      label: 'sidebar actual visibility'
    });
    result.sidebarDebugState = sidebarDebugState;
    result.steps.push('sidebar_visible');

    const sidebarFrame = await waitForSidebarFrame(page, extensionId, { timeoutMs: 30_000 });
    await sidebarFrame.locator('body').waitFor({ state: 'visible', timeout: 30_000 });
    result.sidebarFrameUrl = sidebarFrame.url();
    result.steps.push('sidebar_frame_ready');

    await sidebarFrame.locator('body').screenshot({
      path: path.join(outputDir, 'sidebar-body.png')
    });
    await page.screenshot({
      path: path.join(outputDir, 'host-page.png'),
      fullPage: true
    });
    result.steps.push('screenshots_saved');

    await fsp.writeFile(
      path.join(outputDir, 'result.json'),
      JSON.stringify(result, null, 2),
      'utf8'
    );
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

main().catch(async (error) => {
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
  process.exitCode = 1;
});
