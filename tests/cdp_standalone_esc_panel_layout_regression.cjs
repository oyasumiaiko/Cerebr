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
    'Usage: node tests/cdp_standalone_esc_panel_layout_regression.cjs <repoRoot> <outputDir>'
  );
}

const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);

async function waitForPanelVisibility(page, visible) {
  await page.waitForFunction((expectedVisible) => {
    const panel = document.getElementById('chat-history-panel');
    if (!panel) return false;
    const isVisible = panel.classList.contains('visible') && getComputedStyle(panel).display !== 'none';
    return isVisible === expectedVisible;
  }, visible, { timeout: 10_000 });
}

async function pressEscape(page) {
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true
    }));
  });
  await page.waitForTimeout(120);
}

async function main() {
  await fsp.mkdir(outputDir, { recursive: true });

  const result = {
    startedAt: new Date().toISOString(),
    outputDir,
    launchMode: 'worktree_unpacked',
    headless: runHeadless,
    steps: []
  };

  const profileDir = resolveWorktreeUnpackedProfileDir(repoRoot, 'standalone-esc-panel-layout');
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
    await page.setViewportSize({ width: 1200, height: 820 });
    await page.goto(`chrome-extension://${extensionId}/src/ui/sidebar/sidebar.html#standalone`, {
      waitUntil: 'domcontentloaded'
    });
    result.steps.push('standalone_page_loaded');

    await page.waitForFunction(() => window.cerebr?.environment === 'standalone', null, { timeout: 30_000 });
    result.steps.push('standalone_ready');
    await page.waitForFunction(
      () => typeof window.cerebr?.debug?.chatHistoryUI?.showChatHistoryPanel === 'function',
      null,
      { timeout: 30_000 }
    );
    result.steps.push('chat_history_ui_ready');

    await page.evaluate(() => new Promise((resolve, reject) => {
      chrome.storage.sync.set({
        scaleFactor: 1.5,
        fullscreenWidth: 2000
      }, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve();
      });
    }));
    result.steps.push('standalone_width_settings_seeded');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.cerebr?.environment === 'standalone', null, { timeout: 30_000 });
    await page.waitForFunction(
      () => typeof window.cerebr?.debug?.chatHistoryUI?.showChatHistoryPanel === 'function',
      null,
      { timeout: 30_000 }
    );
    await page.waitForFunction(() => {
      const root = document.documentElement;
      const zoom = Number.parseFloat(root.style.zoom || getComputedStyle(root).zoom || '1');
      const fullscreenWidth = Number.parseFloat(
        root.style.getPropertyValue('--cerebr-fullscreen-width')
        || getComputedStyle(root).getPropertyValue('--cerebr-fullscreen-width')
      );
      return Number.isFinite(zoom) && zoom > 0 && Number.isFinite(fullscreenWidth) && fullscreenWidth > 0;
    }, null, { timeout: 30_000 });
    result.steps.push('standalone_width_settings_applied');

    const fullscreenWidthState = await page.evaluate(() => {
      const root = document.documentElement;
      const zoom = Number.parseFloat(root.style.zoom || getComputedStyle(root).zoom || '1');
      const layoutWidth = Number.parseFloat(
        root.style.getPropertyValue('--cerebr-fullscreen-width')
        || getComputedStyle(root).getPropertyValue('--cerebr-fullscreen-width')
      );
      const visualViewportWidth = Number(window.visualViewport?.width);
      const viewportWidth = (Number.isFinite(visualViewportWidth) && visualViewportWidth > 0)
        ? visualViewportWidth
        : window.innerWidth;
      const slider = document.getElementById('fullscreen-width');
      return {
        zoom,
        layoutWidth,
        visualWidth: layoutWidth * zoom,
        viewportWidth,
        expectedMaxVisualWidth: Math.max(500, viewportWidth - 30),
        sliderMin: Number(slider?.min),
        sliderMax: Number(slider?.max),
        sliderValue: Number(slider?.value)
      };
    });
    result.fullscreenWidthState = fullscreenWidthState;
    if (fullscreenWidthState.visualWidth > fullscreenWidthState.expectedMaxVisualWidth + 2) {
      throw new Error(`Standalone fullscreen width exceeds visible viewport: ${JSON.stringify(fullscreenWidthState)}`);
    }
    if (fullscreenWidthState.sliderMax > fullscreenWidthState.expectedMaxVisualWidth + 2) {
      throw new Error(`Standalone fullscreen width slider max exceeds visible viewport: ${JSON.stringify(fullscreenWidthState)}`);
    }
    result.steps.push('standalone_width_clamp_verified');

    const initialState = await page.evaluate(() => {
      const zoom = 1.5;
      const root = document.documentElement;
      root.style.zoom = String(zoom);
      root.style.setProperty('--cerebr-viewport-width', `${window.innerWidth / zoom}px`);
      root.style.setProperty('--cerebr-viewport-height', `${window.innerHeight / zoom}px`);
      root.style.setProperty('--cerebr-fullscreen-width', `${800 / zoom}px`);
      root.classList.add('standalone-mode', 'fullscreen-mode');
      document.body.classList.add('standalone-mode');

      window.localStorage.setItem('cerebr.chat_history_panel_layout_v2', JSON.stringify({
        version: 2,
        fullscreen: {
          width: 600,
          height: 480,
          left: null,
          top: null,
          dragPositioned: false,
          sizeCustomized: true,
          updatedAt: Date.now()
        },
        sidebar: null
      }));

      return {
        zoom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        layoutViewportWidth: Number.parseFloat(root.style.getPropertyValue('--cerebr-viewport-width')),
        layoutViewportHeight: Number.parseFloat(root.style.getPropertyValue('--cerebr-viewport-height'))
      };
    });
    result.initialState = initialState;
    result.steps.push('zoomed_layout_seeded');

    const measurements = [];
    for (let i = 0; i < 4; i += 1) {
      await pressEscape(page);
      await waitForPanelVisibility(page, true);
      const measurement = await page.evaluate((index) => {
        const panel = document.getElementById('chat-history-panel');
        const rect = panel.getBoundingClientRect();
        return {
          index,
          styleWidth: Number.parseFloat(panel.style.width || ''),
          styleHeight: Number.parseFloat(panel.style.height || ''),
          offsetWidth: panel.offsetWidth,
          offsetHeight: panel.offsetHeight,
          rectWidth: rect.width,
          rectHeight: rect.height,
          zoom: Number.parseFloat(document.documentElement.style.zoom || '1'),
          storedLayout: JSON.parse(window.localStorage.getItem('cerebr.chat_history_panel_layout_v2') || 'null')
        };
      }, i);
      measurements.push(measurement);
      await pressEscape(page);
      await waitForPanelVisibility(page, false);
    }
    result.measurements = measurements;
    result.steps.push('esc_panel_toggle_measured');

    const firstWidth = measurements[0]?.styleWidth;
    const lastWidth = measurements[measurements.length - 1]?.styleWidth;
    const firstHeight = measurements[0]?.styleHeight;
    const lastHeight = measurements[measurements.length - 1]?.styleHeight;
    if (Math.abs(firstWidth - 600) > 1 || Math.abs(lastWidth - 600) > 1) {
      throw new Error(`Esc panel width changed across toggles: ${JSON.stringify(measurements)}`);
    }
    if (Math.abs(firstHeight - 480) > 1 || Math.abs(lastHeight - 480) > 1) {
      throw new Error(`Esc panel height changed across toggles: ${JSON.stringify(measurements)}`);
    }

    const finalStoredLayout = await page.evaluate(() => (
      JSON.parse(window.localStorage.getItem('cerebr.chat_history_panel_layout_v2') || 'null')
    ));
    result.finalStoredLayout = finalStoredLayout;
    if (finalStoredLayout?.fullscreen?.width !== 600 || finalStoredLayout?.fullscreen?.height !== 480) {
      throw new Error(`Esc panel persisted layout drifted: ${JSON.stringify(finalStoredLayout)}`);
    }
    result.steps.push('esc_panel_layout_stable');

    await page.locator('body').screenshot({
      path: path.join(outputDir, 'standalone-esc-panel-body.png')
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
