const fsp = require('fs/promises');
const path = require('path');
const {
  launchWorktreeUnpackedChromiumContext,
  loadPlaywright,
  resolveWorktreeUnpackedProfileDir,
  shouldRunHeadless,
  waitForWorktreeExtensionWorker
} = require('./lib/worktree_unpacked_extension_harness.cjs');

const [rawRepoRoot, outputDir] = process.argv.slice(2);
const repoRoot = rawRepoRoot ? path.resolve(rawRepoRoot) : '';

if (!repoRoot || !outputDir) {
  throw new Error(
    'Usage: node tests/cdp_standalone_context_menu_position_regression.cjs <repoRoot> <outputDir>'
  );
}

const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);

async function main() {
  await fsp.mkdir(outputDir, { recursive: true });

  const result = {
    startedAt: new Date().toISOString(),
    outputDir,
    launchMode: 'worktree_unpacked',
    headless: runHeadless,
    steps: []
  };

  const profileDir = resolveWorktreeUnpackedProfileDir(repoRoot, 'standalone-context-menu-position');
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

    const extensionWorker = await waitForWorktreeExtensionWorker(context, { timeoutMs: 30_000 });
    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;
    result.steps.push('worker_ready');

    const page = context.pages()[0] || await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/sidebar/sidebar.html#standalone`, {
      waitUntil: 'domcontentloaded'
    });
    result.steps.push('standalone_page_loaded');

    await page.waitForFunction(() => window.cerebr?.environment === 'standalone', null, { timeout: 30_000 });
    result.steps.push('standalone_ready');
    await page.waitForFunction(() => {
      const button = document.getElementById('add-sidebar-button');
      return button
        && getComputedStyle(button).display !== 'none'
        && button.getAttribute('title') === '新建并行独立聊天页';
    }, null, { timeout: 30_000 });
    result.steps.push('standalone_parallel_button_ready');

    const injectedState = await page.evaluate(() => {
      const zoom = 0.5;
      const root = document.documentElement;
      root.style.zoom = String(zoom);
      root.style.setProperty('--cerebr-viewport-width', `${window.innerWidth / zoom}px`);
      root.style.setProperty('--cerebr-viewport-height', `${window.innerHeight / zoom}px`);
      document.body.classList.add('standalone-mode');

      const chatContainer = document.getElementById('chat-container');
      if (!chatContainer) throw new Error('chat container missing');
      chatContainer.innerHTML = '';

      const message = document.createElement('div');
      message.className = 'message user-message';
      message.dataset.messageId = 'standalone-coordinate-message';
      message.dataset.originalText = 'standalone context menu coordinate probe';
      message.style.marginTop = '240px';
      message.style.width = '420px';
      message.style.minHeight = '88px';
      message.innerHTML = '<div class="text-content">standalone context menu coordinate probe</div>';
      chatContainer.appendChild(message);

      return {
        zoom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        addSidebarDisplay: getComputedStyle(document.getElementById('add-sidebar-button')).display,
        addSidebarTitle: document.getElementById('add-sidebar-button')?.getAttribute('title') || ''
      };
    });
    result.injectedState = injectedState;
    result.steps.push('probe_message_injected');

    if (injectedState.addSidebarDisplay === 'none') {
      throw new Error('Standalone parallel chat button is hidden.');
    }
    if (injectedState.addSidebarTitle !== '新建并行独立聊天页') {
      throw new Error(`Unexpected standalone parallel chat button title: ${injectedState.addSidebarTitle}`);
    }
    result.steps.push('standalone_parallel_button_visible');

    const box = await page.locator('.message.user-message').boundingBox();
    if (!box) throw new Error('Probe message bounding box missing.');
    const clickX = Math.round(box.x + 36);
    const clickY = Math.round(box.y + 28);
    await page.mouse.click(clickX, clickY, { button: 'right' });
    result.steps.push('right_click_sent');

    await page.waitForFunction(() => {
      const menu = document.getElementById('context-menu');
      return menu && getComputedStyle(menu).display !== 'none';
    }, null, { timeout: 10_000 });

    const menuState = await page.evaluate(({ clickX, clickY }) => {
      const menu = document.getElementById('context-menu');
      const rect = menu.getBoundingClientRect();
      return {
        clickX,
        clickY,
        rect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height
        },
        styleLeft: menu.style.left,
        styleTop: menu.style.top,
        zoom: Number.parseFloat(document.documentElement.style.zoom || '1')
      };
    }, { clickX, clickY });
    result.menuState = menuState;

    const dx = Math.abs(menuState.rect.left - clickX);
    const dy = Math.abs(menuState.rect.top - clickY);
    result.coordinateDelta = { dx, dy };
    if (dx > 2 || dy > 2) {
      throw new Error(
        `Standalone context menu is not anchored to click point: dx=${dx}, dy=${dy}, state=${JSON.stringify(menuState)}`
      );
    }
    result.steps.push('context_menu_position_verified');

    await page.locator('body').screenshot({
      path: path.join(outputDir, 'standalone-context-menu-body.png')
    });
    result.steps.push('screenshot_saved');

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
