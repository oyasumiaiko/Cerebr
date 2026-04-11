const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
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
    'Usage: node tests/cdp_alt_scroll_acceleration_regression.cjs <repoRoot> <outputDir> [targetUrl=https://example.com/]'
  );
}

const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function prepareScrollableSidebar(sidebarFrame) {
  return await sidebarFrame.evaluate(() => {
    const container = document.getElementById('chat-container');
    if (!container) {
      throw new Error('chat-container not found');
    }

    container.innerHTML = '';
    const filler = document.createElement('div');
    filler.id = '__alt-scroll-regression-filler__';
    filler.style.display = 'flex';
    filler.style.flexDirection = 'column';
    filler.style.gap = '12px';
    filler.style.padding = '12px 0 40px';

    for (let index = 0; index < 120; index += 1) {
      const item = document.createElement('div');
      item.textContent = `alt-scroll-filler-${index}`;
      item.style.minHeight = '72px';
      item.style.padding = '12px 16px';
      item.style.borderRadius = '12px';
      item.style.background = index % 2 === 0 ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)';
      filler.appendChild(item);
    }

    container.appendChild(filler);
    container.scrollTop = 900;

    return {
      clientHeight: container.clientHeight,
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop
    };
  });
}

async function installHostAltRecorder(page) {
  await page.evaluate(() => {
    window.__cerebrAltHostEvents = [];
    const record = (type, event) => {
      if (event.key !== 'Alt') return;
      window.__cerebrAltHostEvents.push({
        type,
        defaultPrevented: event.defaultPrevented,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey
      });
    };
    window.addEventListener('keydown', (event) => record('keydown', event), true);
    window.addEventListener('keyup', (event) => record('keyup', event), true);
  });
}

async function focusHostPage(page) {
  const body = page.locator('body');
  await body.click({ position: { x: 24, y: 24 } });
  return await page.evaluate(() => ({
    documentHasFocus: document.hasFocus(),
    activeTag: document.activeElement?.tagName || null
  }));
}

async function resetSidebarScroll(sidebarFrame, scrollTop = 900) {
  return await sidebarFrame.evaluate((targetTop) => {
    const container = document.getElementById('chat-container');
    if (!container) {
      throw new Error('chat-container not found while resetting scroll');
    }
    container.scrollTop = targetTop;
    return {
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight
    };
  }, scrollTop);
}

async function readSidebarScrollState(sidebarFrame) {
  return await sidebarFrame.evaluate(() => {
    const container = document.getElementById('chat-container');
    if (!container) {
      throw new Error('chat-container not found while reading scroll state');
    }
    return {
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight
    };
  });
}

async function measureWheelScroll({ page, sidebarFrame, useHostAlt }) {
  const hostFocus = await focusHostPage(page);
  const sidebarFocusBefore = await sidebarFrame.evaluate(() => ({
    documentHasFocus: document.hasFocus(),
    activeTag: document.activeElement?.tagName || null
  }));

  const before = await resetSidebarScroll(sidebarFrame, 900);
  const container = sidebarFrame.locator('#chat-container');
  const box = await container.boundingBox();
  if (!box) {
    throw new Error('Cannot resolve chat container bounding box');
  }

  if (useHostAlt) {
    await page.keyboard.down('Alt');
    await sleep(120);
  }

  try {
    await page.mouse.move(box.x + Math.min(box.width / 2, 120), box.y + Math.min(box.height / 2, 160));
    await page.mouse.wheel(0, 120);
    await sleep(useHostAlt ? 320 : 180);
  } finally {
    if (useHostAlt) {
      await page.keyboard.up('Alt').catch(() => {});
      await sleep(80);
    }
  }

  const after = await readSidebarScrollState(sidebarFrame);
  return {
    useHostAlt,
    hostFocus,
    sidebarFocusBefore,
    before,
    after,
    delta: after.scrollTop - before.scrollTop
  };
}

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

  const profileDir = resolveWorktreeUnpackedProfileDir(repoRoot, 'alt-scroll-regression');
  await fsp.mkdir(profileDir, { recursive: true });
  result.profileDir = profileDir;

  let context = null;
  let page = null;
  let sidebarFrame = null;

  try {
    context = await launchWorktreeUnpackedChromiumContext({
      chromium,
      repoRoot,
      profileDir,
      headless: runHeadless
    });
    result.steps.push('browser_ready');

    page = context.pages()[0] || await context.newPage();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    result.steps.push('page_loaded');

    const extensionWorker = await waitForWorktreeExtensionWorker(context, { timeoutMs: 30_000 });
    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;
    result.steps.push('worker_ready');

    await installHostAltRecorder(page);
    result.steps.push('host_alt_recorder_ready');

    result.openSidebarResponse = await extensionWorker.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'OPEN_SIDEBAR' }))
    );
    result.steps.push('sidebar_open_requested');

    result.sidebarDebugState = await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      return payload?.response?.debugState?.isActuallyVisible ? payload.response.debugState : null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 250,
      label: 'sidebar actual visibility'
    });
    result.steps.push('sidebar_visible');

    sidebarFrame = await waitForSidebarFrame(page, extensionId, { timeoutMs: 30_000 });
    await sidebarFrame.locator('#chat-container').waitFor({ state: 'visible', timeout: 30_000 });
    result.sidebarFrameUrl = sidebarFrame.url();
    result.steps.push('sidebar_frame_ready');

    result.scrollableSeedState = await prepareScrollableSidebar(sidebarFrame);
    result.steps.push('scrollable_content_ready');

    result.normalWheel = await measureWheelScroll({
      page,
      sidebarFrame,
      useHostAlt: false
    });
    result.steps.push('normal_wheel_measured');

    result.hostAltWheel = await measureWheelScroll({
      page,
      sidebarFrame,
      useHostAlt: true
    });
    result.steps.push('host_alt_wheel_measured');

    result.hostAltEvents = await page.evaluate(() => window.__cerebrAltHostEvents || []);
    result.finalSidebarScrollState = await readSidebarScrollState(sidebarFrame);

    assert.equal(
      result.hostAltWheel.sidebarFocusBefore.documentHasFocus,
      false,
      'Expected host-page focus path, but sidebar still had focus before Alt wheel'
    );
    assert.ok(
      result.normalWheel.delta > 0,
      `Expected normal wheel to move the sidebar, got delta=${result.normalWheel.delta}`
    );
    assert.ok(
      result.hostAltWheel.delta > result.normalWheel.delta * 2.5,
      `Expected host Alt wheel delta to be meaningfully larger. normal=${result.normalWheel.delta}, alt=${result.hostAltWheel.delta}`
    );

    const altKeydownEvents = result.hostAltEvents.filter((event) => event.type === 'keydown');
    const altKeyupEvents = result.hostAltEvents.filter((event) => event.type === 'keyup');
    assert.ok(altKeydownEvents.length >= 1, 'Expected host page to observe Alt keydown');
    assert.ok(altKeyupEvents.length >= 1, 'Expected host page to observe Alt keyup');
    assert.equal(
      result.hostAltEvents.some((event) => event.defaultPrevented),
      false,
      'Expected host Alt events to remain unprevented'
    );

    await sidebarFrame.locator('body').screenshot({
      path: path.join(outputDir, 'sidebar-body.png')
    });
    await page.screenshot({
      path: path.join(outputDir, 'host-page.png'),
      fullPage: true
    });
    result.steps.push('screenshots_saved');

    result.ok = true;
    await fsp.writeFile(
      path.join(outputDir, 'result.json'),
      JSON.stringify(result, null, 2),
      'utf8'
    );
  } finally {
    if (!result.ok) {
      try {
        result.ok = false;
        await fsp.writeFile(
          path.join(outputDir, 'result.json'),
          JSON.stringify(result, null, 2),
          'utf8'
        );
      } catch (_) {}
    }
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
