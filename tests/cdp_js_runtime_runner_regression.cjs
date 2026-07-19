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
  waitForSidebarFrame,
} = require('./lib/stable_chrome_sidebar_harness.cjs');

const [rawRepoRoot, outputDir, targetUrl = 'https://example.com/'] = process.argv.slice(2);
const repoRoot = rawRepoRoot ? path.resolve(rawRepoRoot) : '';

if (!repoRoot || !outputDir) {
  throw new Error(
    'Usage: node tests/cdp_js_runtime_runner_regression.cjs <repoRoot> <outputDir> [targetUrl=https://example.com/]'
  );
}

const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);
const startedAt = Date.now();

function logProgress(message) {
  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[js-runtime-runner ${elapsedSeconds}s] ${message}`);
}

async function main() {
  await fsp.mkdir(outputDir, { recursive: true });
  const result = {
    ok: false,
    startedAt: new Date(startedAt).toISOString(),
    targetUrl,
    steps: []
  };
  const profileDir = resolveFixedSidebarProfileDir(repoRoot);
  await fsp.mkdir(profileDir, { recursive: true });

  let context = null;
  try {
    logProgress('启动固定 profile 的 stable Chrome');
    context = await launchFixedSidebarContext({
      chromium,
      profileDir,
      executablePath: resolveStableChromeExecutablePath(),
      headless: runHeadless
    });
    const extensionWorker = await reloadUnpackedExtension(context, {
      timeoutMs: 30_000,
      unpackedPath: repoRoot
    });
    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;
    const page = context.pages()[0] || await context.newPage();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await extensionWorker.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'OPEN_SIDEBAR' }))
    );
    const sidebarFrame = await waitForSidebarFrame(page, extensionId, { timeoutMs: 30_000 });
    await sidebarFrame.locator('body').waitFor({ state: 'visible', timeout: 30_000 });
    await waitFor(async () => sidebarFrame.evaluate(() => (
      typeof window.cerebr?.debug?.executeJsRuntime === 'function'
    )), { timeoutMs: 30_000, intervalMs: 200, label: 'sidebar JS runtime debug API' });
    await sidebarFrame.evaluate(() => {
      window.__cerebrRunnerRegressionMarker = 'sidebar-still-alive';
    });
    result.sidebarUrlBefore = sidebarFrame.url();
    result.steps.push('sidebar_ready');

    logProgress('验证 runner 转发后仍可读取宿主页 DOM');
    const firstResult = await sidebarFrame.evaluate(async () => window.cerebr.debug.executeJsRuntime(
      'return { title: document.title, href: location.href };',
      { runtimeEnvironment: 'bound_host_page', timeoutMs: 5000 }
    ));
    if (firstResult?.success !== true || firstResult?.value?.title !== 'Example Domain') {
      throw new Error(`首次宿主页 JS Runtime 结果异常：${JSON.stringify(firstResult)}`);
    }
    result.firstResult = firstResult;

    const runnerFrameBefore = await waitFor(() => (
      page.frames().find((frame) => frame.url().includes('/src/ui/js_runtime_runner/js_runtime_runner.html')) || null
    ), { timeoutMs: 10_000, intervalMs: 100, label: 'initial JS runtime runner frame' });
    result.runnerUrlBefore = runnerFrameBefore.url();

    logProgress('人为挂起 runner 消息请求，等待宿主页控制器自动重建');
    await runnerFrameBefore.evaluate(() => {
      chrome.runtime.sendMessage = () => new Promise(() => {});
    });
    const timedOutResult = await sidebarFrame.evaluate(async () => window.cerebr.debug.executeJsRuntime(
      'return document.title;',
      { runtimeEnvironment: 'bound_host_page', timeoutMs: 100 }
    ));
    result.timedOutResult = timedOutResult;

    const runnerFrameAfter = await waitFor(() => {
      const current = page.frames().find((frame) => frame.url().includes('/src/ui/js_runtime_runner/js_runtime_runner.html')) || null;
      return current && current !== runnerFrameBefore ? current : null;
    }, { timeoutMs: 10_000, intervalMs: 100, label: 'recreated JS runtime runner frame' });
    result.runnerUrlAfter = runnerFrameAfter.url();

    logProgress('验证 runner 重建后侧栏状态保留且下一次 DOM 调用恢复');
    const sidebarMarker = await sidebarFrame.evaluate(() => window.__cerebrRunnerRegressionMarker);
    const secondResult = await sidebarFrame.evaluate(async () => window.cerebr.debug.executeJsRuntime(
      'return document.querySelector("h1")?.textContent || "";',
      { runtimeEnvironment: 'bound_host_page', timeoutMs: 5000 }
    ));
    if (sidebarMarker !== 'sidebar-still-alive') {
      throw new Error('runner 重建过程中侧栏 iframe 被重载。');
    }
    if (secondResult?.success !== true || secondResult?.value !== 'Example Domain') {
      throw new Error(`runner 重建后的宿主页 JS Runtime 结果异常：${JSON.stringify(secondResult)}`);
    }

    const frameUrls = page.frames().map((frame) => frame.url());
    const hostLightDomIframeCount = await page.locator('iframe').count();
    const runtimeFrameSnapshot = await sidebarFrame.evaluate(async () => (
      window.cerebr.debug.getJsRuntimeFrames?.({ runtimeEnvironment: 'bound_host_page' })
    ));
    if (hostLightDomIframeCount !== 0) {
      throw new Error(`侧栏或 runner iframe 泄漏到宿主页 light DOM：count=${hostLightDomIframeCount}`);
    }
    if (!frameUrls.some((url) => url.includes('/src/ui/sidebar/sidebar.html'))) {
      throw new Error('浏览器 frame 树中没有找到侧栏 iframe。');
    }
    if (!frameUrls.some((url) => url.includes('/src/ui/js_runtime_runner/js_runtime_runner.html'))) {
      throw new Error('浏览器 frame 树中没有找到隐藏 JS Runtime runner iframe。');
    }
    if (runtimeFrameSnapshot?.success !== true) {
      throw new Error(`读取 JS Runtime frame 快照失败：${JSON.stringify(runtimeFrameSnapshot)}`);
    }
    const exposedExtensionFrame = (runtimeFrameSnapshot.frames || []).find((frame) => (
      typeof frame?.url === 'string' && frame.url.startsWith(`chrome-extension://${extensionId}/`)
    ));
    if (exposedExtensionFrame) {
      throw new Error(`扩展内部 iframe 被错误注入 frame 上下文：${JSON.stringify(exposedExtensionFrame)}`);
    }
    result.sidebarMarker = sidebarMarker;
    result.secondResult = secondResult;
    result.frameUrls = frameUrls;
    result.hostLightDomIframeCount = hostLightDomIframeCount;
    result.runtimeFrameSnapshot = runtimeFrameSnapshot;
    result.sidebarUrlAfter = sidebarFrame.url();
    result.ok = true;
    result.finishedAt = new Date().toISOString();

    await fsp.writeFile(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    logProgress('回归通过');
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

main().catch(async (error) => {
  const failure = {
    ok: false,
    error: String(error?.stack || error?.message || error)
  };
  try {
    await fsp.mkdir(outputDir, { recursive: true });
    await fsp.writeFile(path.join(outputDir, 'result.json'), JSON.stringify(failure, null, 2), 'utf8');
  } catch (_) {}
  console.error(error);
  process.exitCode = 1;
});
