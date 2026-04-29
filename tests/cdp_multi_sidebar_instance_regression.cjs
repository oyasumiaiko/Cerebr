const fsp = require('fs/promises');
const path = require('path');
const {
  buildSendContentMessageExpression,
  launchWorktreeUnpackedChromiumContext,
  loadPlaywright,
  resolveWorktreeUnpackedProfileDir,
  shouldRunHeadless,
  waitFor,
  waitForWorktreeExtensionWorker
} = require('./lib/worktree_unpacked_extension_harness.cjs');

const [rawRepoRoot, outputDir, targetUrl = 'https://example.com/'] = process.argv.slice(2);
const repoRoot = rawRepoRoot ? path.resolve(rawRepoRoot) : '';

if (!repoRoot || !outputDir) {
  throw new Error(
    'Usage: node tests/cdp_multi_sidebar_instance_regression.cjs <repoRoot> <outputDir> [targetUrl=https://example.com/]'
  );
}

const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);

function getSidebarFrames(page, extensionId) {
  return page.frames().filter((frame) => (
    frame.url().startsWith(`chrome-extension://${extensionId}/src/ui/sidebar/sidebar.html`)
  ));
}

function extractInstanceId(frameUrl) {
  const url = new URL(frameUrl);
  return url.searchParams.get('instanceId') || '';
}

function findInstanceState(debugState, instanceId) {
  return Array.isArray(debugState?.instances)
    ? debugState.instances.find((item) => item?.instanceId === instanceId) || null
    : null;
}

async function writeResult(outputDir, result) {
  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.writeFile(
    path.join(outputDir, 'result.json'),
    JSON.stringify(result, null, 2),
    'utf8'
  );
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

  const profileDir = resolveWorktreeUnpackedProfileDir(repoRoot, 'multi-sidebar-instance-regression');
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
    await page.setViewportSize({ width: 1920, height: 1080 }).catch(() => {});
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
    result.steps.push('primary_sidebar_open_requested');

    await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      const state = payload?.response?.debugState || null;
      return state?.sidebarCount === 1 && state?.active?.isActuallyVisible ? state : null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 250,
      label: 'primary sidebar visible'
    });
    result.steps.push('primary_sidebar_visible');

    const firstFrame = await waitFor(async () => {
      const [frame] = getSidebarFrames(page, extensionId);
      return frame || null;
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: 'primary sidebar frame'
    });
    await firstFrame.locator('body').waitFor({ state: 'visible', timeout: 30_000 });
    const firstInstanceId = extractInstanceId(firstFrame.url());
    if (!firstInstanceId) {
      throw new Error('Primary sidebar iframe is missing instanceId query parameter.');
    }
    result.primaryFrameUrl = firstFrame.url();
    result.primaryInstanceId = firstInstanceId;
    result.steps.push('primary_frame_ready');

    await firstFrame.locator('#message-input').fill('first sidebar draft');
    await firstFrame.locator('#add-sidebar-button').click();
    result.steps.push('add_sidebar_clicked');

    const sidebarDebugState = await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      const state = payload?.response?.debugState || null;
      const visibleCount = Array.isArray(state?.instances)
        ? state.instances.filter((item) => item?.isActuallyVisible).length
        : 0;
      return state?.sidebarCount === 2 && visibleCount === 2 ? state : null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 250,
      label: 'two visible sidebars'
    });
    result.sidebarDebugState = sidebarDebugState;
    result.steps.push('second_sidebar_visible');

    const sidebarFrames = await waitFor(async () => {
      const frames = getSidebarFrames(page, extensionId);
      return frames.length === 2 ? frames : null;
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: 'two sidebar frames'
    });
    const frameInfos = sidebarFrames.map((frame) => ({
      url: frame.url(),
      instanceId: extractInstanceId(frame.url())
    }));
    const instanceIds = frameInfos.map((item) => item.instanceId);
    if (new Set(instanceIds).size !== 2 || instanceIds.some((id) => !id)) {
      throw new Error(`Expected two distinct sidebar instance ids, got: ${JSON.stringify(instanceIds)}`);
    }
    result.frameInfos = frameInfos;
    result.steps.push('distinct_instance_ids_verified');

    const secondFrame = sidebarFrames.find((frame) => extractInstanceId(frame.url()) !== firstInstanceId);
    if (!secondFrame) {
      throw new Error('Cannot identify the newly-created sidebar frame.');
    }

    const firstDraftBefore = await firstFrame.locator('#message-input').textContent();
    const secondDraftBefore = await secondFrame.locator('#message-input').textContent();
    await secondFrame.locator('#message-input').fill('second sidebar draft');
    const firstDraftAfter = await firstFrame.locator('#message-input').textContent();
    const secondDraftAfter = await secondFrame.locator('#message-input').textContent();
    const primaryButtonTitle = await firstFrame.locator('#add-sidebar-button').getAttribute('title');
    const secondaryButtonTitle = await secondFrame.locator('#add-sidebar-button').getAttribute('title');
    result.draftIsolation = {
      firstDraftBefore,
      secondDraftBefore,
      firstDraftAfter,
      secondDraftAfter,
      primaryButtonTitle,
      secondaryButtonTitle
    };
    if (firstDraftBefore !== 'first sidebar draft' || firstDraftAfter !== 'first sidebar draft') {
      throw new Error('Primary sidebar draft changed while editing the second sidebar.');
    }
    if ((secondDraftBefore || '') !== '' || secondDraftAfter !== 'second sidebar draft') {
      throw new Error('Second sidebar draft is not isolated from the primary sidebar.');
    }
    if (primaryButtonTitle !== '新建并行侧栏' || secondaryButtonTitle !== '关闭此侧栏') {
      throw new Error(`Unexpected sidebar button titles: ${JSON.stringify({ primaryButtonTitle, secondaryButtonTitle })}`);
    }
    result.steps.push('draft_isolation_verified');
    result.steps.push('secondary_close_button_verified');

    const enterFullscreenResponse = await extensionWorker.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'TOGGLE_FULLSCREEN_FROM_BACKGROUND' }))
    );
    result.enterFullscreenResponse = enterFullscreenResponse;
    const fullscreenDebugState = await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      const state = payload?.response?.debugState || null;
      const states = instanceIds.map((id) => findInstanceState(state, id));
      if (state?.sidebarCount !== 2 || states.some((item) => !item?.isActuallyVisible || !item?.isFullscreen)) {
        return null;
      }

      const viewportWidth = Number(page.viewportSize()?.width) || 1920;
      const expectedWidth = viewportWidth / states.length;
      const sortedRects = states
        .map((item) => item.rect)
        .filter(Boolean)
        .sort((a, b) => a.x - b.x);
      const isSplitAcrossViewport = sortedRects.length === states.length
        && sortedRects.every((rect, index) => (
          Math.abs(rect.width - expectedWidth) <= 16
          && Math.abs(rect.x - expectedWidth * index) <= 16
          && rect.y === 0
        ));
      return isSplitAcrossViewport ? state : null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 250,
      label: 'multi-sidebar fullscreen splits viewport'
    });
    result.fullscreenDebugState = fullscreenDebugState;
    result.steps.push('multi_sidebar_fullscreen_split_verified');

    const exitFullscreenResponse = await extensionWorker.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'TOGGLE_FULLSCREEN_FROM_BACKGROUND' }))
    );
    result.exitFullscreenResponse = exitFullscreenResponse;
    const exitFullscreenDebugState = await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      const state = payload?.response?.debugState || null;
      const visibleCount = Array.isArray(state?.instances)
        ? state.instances.filter((item) => item?.isActuallyVisible).length
        : 0;
      const states = instanceIds.map((id) => findInstanceState(state, id));
      return state?.sidebarCount === 2
        && visibleCount === 2
        && states.every((item) => item && !item.isFullscreen)
        ? state
        : null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 250,
      label: 'multi-sidebar fullscreen exits cleanly'
    });
    result.exitFullscreenDebugState = exitFullscreenDebugState;
    result.steps.push('multi_sidebar_fullscreen_exit_verified');

    await secondFrame.locator('#add-sidebar-button').click();
    const closeDebugState = await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      const state = payload?.response?.debugState || null;
      const visibleCount = Array.isArray(state?.instances)
        ? state.instances.filter((item) => item?.isActuallyVisible).length
        : 0;
      return state?.sidebarCount === 2 && visibleCount === 1 ? state : null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 250,
      label: 'secondary sidebar closed'
    });
    result.closeDebugState = closeDebugState;
    result.steps.push('secondary_sidebar_closed');

    const reopenAllResponse = await extensionWorker.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'OPEN_SIDEBAR' }))
    );
    result.reopenAllResponse = reopenAllResponse;
    const reopenedDebugState = await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      const state = payload?.response?.debugState || null;
      const visibleCount = Array.isArray(state?.instances)
        ? state.instances.filter((item) => item?.isActuallyVisible).length
        : 0;
      return state?.sidebarCount === 2 && visibleCount === 2 ? state : null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 250,
      label: 'all sidebars reopened'
    });
    result.reopenedDebugState = reopenedDebugState;
    result.steps.push('all_sidebars_reopened');

    const toggleClosedResponse = await extensionWorker.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'TOGGLE_SIDEBAR_onClicked' }))
    );
    result.toggleClosedResponse = toggleClosedResponse;
    const toggleClosedDebugState = await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      const state = payload?.response?.debugState || null;
      const visibleCount = Array.isArray(state?.instances)
        ? state.instances.filter((item) => item?.isActuallyVisible).length
        : 0;
      return state?.sidebarCount === 2 && visibleCount === 0 ? state : null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 250,
      label: 'all sidebars closed by global toggle'
    });
    result.toggleClosedDebugState = toggleClosedDebugState;
    result.steps.push('all_sidebars_closed_by_global_toggle');

    const toggleReopenedResponse = await extensionWorker.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'TOGGLE_SIDEBAR_onClicked' }))
    );
    result.toggleReopenedResponse = toggleReopenedResponse;
    const toggleReopenedDebugState = await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      const state = payload?.response?.debugState || null;
      const visibleCount = Array.isArray(state?.instances)
        ? state.instances.filter((item) => item?.isActuallyVisible).length
        : 0;
      return state?.sidebarCount === 2 && visibleCount === 2 ? state : null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 250,
      label: 'all sidebars reopened by global toggle'
    });
    result.toggleReopenedDebugState = toggleReopenedDebugState;
    result.steps.push('all_sidebars_reopened_by_global_toggle');

    const secondBeforeDrag = findInstanceState(toggleReopenedDebugState, secondFrame ? extractInstanceId(secondFrame.url()) : '');
    if (!secondBeforeDrag?.rect) {
      throw new Error('Cannot find second sidebar debug state before drag.');
    }
    await page.mouse.move(
      secondBeforeDrag.rect.x + Math.round(secondBeforeDrag.rect.width / 2),
      secondBeforeDrag.rect.y + 8
    );
    await page.mouse.down();
    await page.mouse.move(80, secondBeforeDrag.rect.y + 8, { steps: 12 });
    await page.mouse.up();

    const dragReorderDebugState = await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      const state = payload?.response?.debugState || null;
      const secondState = findInstanceState(state, extractInstanceId(secondFrame.url()));
      return secondState?.isActuallyVisible
        && secondState?.sidebarPosition === 'left'
        && Number(secondState?.computedOpacity) > 0.99
        ? state
        : null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 250,
      label: 'secondary sidebar moved to left by drag'
    });
    result.dragReorderDebugState = dragReorderDebugState;
    result.steps.push('secondary_sidebar_dragged_to_left');

    const secondBeforeResize = findInstanceState(dragReorderDebugState, extractInstanceId(secondFrame.url()));
    if (!secondBeforeResize?.rect || !Number.isFinite(Number(secondBeforeResize.sidebarWidth))) {
      throw new Error('Cannot find second sidebar debug state before resize.');
    }
    await page.mouse.move(
      secondBeforeResize.rect.x + secondBeforeResize.rect.width - 6,
      secondBeforeResize.rect.y + Math.round(secondBeforeResize.rect.height / 2)
    );
    await page.mouse.down();
    await page.mouse.move(
      secondBeforeResize.rect.x + secondBeforeResize.rect.width + 140,
      secondBeforeResize.rect.y + Math.round(secondBeforeResize.rect.height / 2),
      { steps: 10 }
    );
    await page.mouse.up();

    const resizeDebugState = await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      const state = payload?.response?.debugState || null;
      const secondState = findInstanceState(state, extractInstanceId(secondFrame.url()));
      return secondState?.sidebarPosition === 'left'
        && Number(secondState?.sidebarWidth) > Number(secondBeforeResize.sidebarWidth) + 40
        ? state
        : null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 250,
      label: 'secondary sidebar resized by drag'
    });
    result.resizeDebugState = resizeDebugState;
    result.steps.push('secondary_sidebar_resized_by_drag');

    await Promise.all([
      firstFrame.locator('body').screenshot({
        path: path.join(outputDir, 'primary-sidebar-body.png'),
        timeout: 5_000
      }).catch((error) => {
        result.primarySidebarScreenshotError = String(error && (error.stack || error.message || error));
      }),
      secondFrame.locator('body').screenshot({
        path: path.join(outputDir, 'second-sidebar-body.png'),
        timeout: 5_000
      }).catch((error) => {
        result.secondSidebarScreenshotError = String(error && (error.stack || error.message || error));
      }),
      page.screenshot({
        path: path.join(outputDir, 'host-page.png'),
        timeout: 5_000,
        fullPage: true
      }).catch((error) => {
        result.hostPageScreenshotError = String(error && (error.stack || error.message || error));
      })
    ]);
    result.steps.push('screenshots_attempted');

    result.ok = true;
    await writeResult(outputDir, result);
  } catch (error) {
    result.ok = false;
    result.error = String(error && (error.stack || error.message || error));
    await writeResult(outputDir, result).catch(() => {});
    throw error;
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
