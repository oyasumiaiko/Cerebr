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

const [rawRepoRoot, rawOutputDir, rawChromePath, rawTargetUrl] = process.argv.slice(2);

if (!rawRepoRoot || !rawOutputDir) {
  throw new Error(
    'Usage: node tests/cdp_scroll_to_bottom_button_regression.cjs <repoRoot> <outputDir> [chromePath] [targetUrl=https://example.com/]'
  );
}

const repoRoot = path.resolve(rawRepoRoot);
const outputDir = path.resolve(rawOutputDir);
const chromePath = (typeof rawChromePath === 'string' && rawChromePath.trim())
  ? rawChromePath.trim()
  : resolveStableChromeExecutablePath();
const targetUrl = (typeof rawTargetUrl === 'string' && rawTargetUrl.trim())
  ? rawTargetUrl.trim()
  : 'https://example.com/';
const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);

async function prepareScrollableSidebar(sidebarFrame) {
  return await sidebarFrame.evaluate(() => {
    const chatContainer = document.getElementById('chat-container');
    const emptyState = document.querySelector('.empty-state-content');
    if (!chatContainer) {
      throw new Error('chat-container not found');
    }

    if (emptyState instanceof HTMLElement) {
      emptyState.style.display = 'none';
    }

    chatContainer.innerHTML = '';
    for (let index = 0; index < 140; index += 1) {
      const message = document.createElement('div');
      message.className = `message ${index % 3 === 0 ? 'user-message' : 'ai-message'}`;
      message.style.minHeight = '72px';
      message.style.padding = '14px 16px';
      message.style.borderRadius = '16px';
      message.style.marginBottom = '8px';
      message.style.background = index % 3 === 0
        ? 'rgba(80, 140, 255, 0.12)'
        : 'rgba(255, 255, 255, 0.05)';
      message.textContent = `scroll-to-bottom-regression-${index}`;
      chatContainer.appendChild(message);
    }

    chatContainer.scrollTop = Math.max(0, (chatContainer.scrollHeight || 0) - (chatContainer.clientHeight || 0));

    return {
      clientHeight: chatContainer.clientHeight,
      scrollHeight: chatContainer.scrollHeight,
      scrollTop: chatContainer.scrollTop
    };
  });
}

async function setSidebarScrollTop(sidebarFrame, targetTop) {
  return await sidebarFrame.evaluate((top) => {
    const chatContainer = document.getElementById('chat-container');
    if (!chatContainer) {
      throw new Error('chat-container not found while setting scrollTop');
    }
    chatContainer.scrollTop = top;
    return {
      scrollTop: chatContainer.scrollTop,
      clientHeight: chatContainer.clientHeight,
      scrollHeight: chatContainer.scrollHeight
    };
  }, targetTop);
}

async function readSidebarButtonState(sidebarFrame) {
  return await sidebarFrame.evaluate(() => {
    const button = document.getElementById('scroll-to-bottom-button');
    const chatContainer = document.getElementById('chat-container');
    const anchor = document.getElementById('scroll-to-bottom-anchor');
    const distanceToBottom = chatContainer
      ? Math.max(0, (chatContainer.scrollHeight || 0) - (chatContainer.scrollTop || 0) - (chatContainer.clientHeight || 0))
      : null;
    return {
      buttonVisible: !!button?.classList.contains('is-visible'),
      ariaHidden: button?.getAttribute('aria-hidden') || null,
      tabIndex: button?.tabIndex ?? null,
      distanceToBottom,
      scrollTop: chatContainer?.scrollTop || 0,
      scrollHeight: chatContainer?.scrollHeight || 0,
      clientHeight: chatContainer?.clientHeight || 0,
      anchorRect: anchor?.getBoundingClientRect?.() || null,
      buttonRect: button?.getBoundingClientRect?.() || null
    };
  });
}

async function main() {
  await fsp.mkdir(outputDir, { recursive: true });

  const result = {
    startedAt: new Date().toISOString(),
    outputDir,
    chromePath,
    targetUrl,
    headless: runHeadless,
    steps: []
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

    const extensionWorker = await reloadUnpackedExtension(context, { timeoutMs: 30_000 });
    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;
    result.steps.push('extension_reloaded');

    const page = context.pages().find((entry) => entry.url().startsWith(targetUrl)) || await context.newPage();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
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

    result.seedState = await prepareScrollableSidebar(sidebarFrame);
    result.steps.push('scrollable_content_ready');

    result.initialButtonState = await readSidebarButtonState(sidebarFrame);
    result.steps.push('initial_state_read');

    await waitFor(async () => {
      const state = await readSidebarButtonState(sidebarFrame);
      return state.buttonVisible === false ? state : null;
    }, { timeoutMs: 10_000, intervalMs: 150, label: 'button hidden at bottom' });
    result.steps.push('button_hidden_at_bottom');

    result.scrolledAwayState = await setSidebarScrollTop(sidebarFrame, 480);
    await waitFor(async () => {
      const state = await readSidebarButtonState(sidebarFrame);
      return state.buttonVisible ? state : null;
    }, { timeoutMs: 10_000, intervalMs: 150, label: 'button visible after scroll up' });
    result.visibleState = await readSidebarButtonState(sidebarFrame);
    result.steps.push('button_visible_after_scroll_up');

    await sidebarFrame.locator('#scroll-to-bottom-button').click();
    result.steps.push('button_clicked');

    await waitFor(async () => {
      const state = await readSidebarButtonState(sidebarFrame);
      const nearBottom = state.distanceToBottom != null && state.distanceToBottom <= 2;
      return nearBottom && !state.buttonVisible ? state : null;
    }, { timeoutMs: 10_000, intervalMs: 150, label: 'button click scrolls to bottom' });
    result.finalState = await readSidebarButtonState(sidebarFrame);
    result.steps.push('button_hidden_after_jump');

    await sidebarFrame.locator('body').screenshot({
      path: path.join(outputDir, 'sidebar-body.png')
    });
    result.steps.push('screenshot_saved');
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
