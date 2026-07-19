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
    frame.url().startsWith('chrome-extension://')
    && frame.url().includes('/src/ui/sidebar/sidebar.html')
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

function isEvenFullscreenSplit(debugState, expectedCount, viewportWidth) {
  const states = Array.isArray(debugState?.instances) ? debugState.instances : [];
  if (debugState?.sidebarCount !== expectedCount || states.length !== expectedCount) return false;
  if (states.some((item) => !item?.isActuallyVisible || !item?.isFullscreen)) return false;

  const expectedWidth = viewportWidth / expectedCount;
  const sortedRects = states
    .map((item) => item.rect)
    .filter(Boolean)
    .sort((a, b) => a.x - b.x);
  return sortedRects.length === expectedCount
    && sortedRects.every((rect, index) => (
      Math.abs(rect.width - expectedWidth) <= 16
      && Math.abs(rect.x - expectedWidth * index) <= 16
      && rect.y === 0
    ));
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

    const primaryVisibleDebugState = await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      const state = payload?.response?.debugState || null;
      return state?.sidebarCount === 1
        && state?.active?.isActuallyVisible
        && state?.active?.hasLegacyResizer === false
        ? state
        : null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 250,
      label: 'primary sidebar visible'
    });
    result.primaryVisibleDebugState = primaryVisibleDebugState;
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
    const secondInstanceId = extractInstanceId(secondFrame.url());
    const sidebarButtonTitles = await waitFor(async () => {
      const primaryTitle = await firstFrame.locator('#add-sidebar-button').getAttribute('title');
      const secondaryTitle = await secondFrame.locator('#add-sidebar-button').getAttribute('title');
      return primaryTitle === '新建并行侧栏' && secondaryTitle === '关闭此侧栏'
        ? { primaryButtonTitle: primaryTitle, secondaryButtonTitle: secondaryTitle }
        : null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 250,
      label: 'primary and secondary sidebar button roles'
    });
    const { primaryButtonTitle, secondaryButtonTitle } = sidebarButtonTitles;
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
      const viewportWidth = Number(page.viewportSize()?.width) || 1920;
      return isEvenFullscreenSplit(state, 2, viewportWidth) ? state : null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 250,
      label: 'multi-sidebar fullscreen splits viewport'
    });
    result.fullscreenDebugState = fullscreenDebugState;
    result.steps.push('multi_sidebar_fullscreen_split_verified');

    await firstFrame.locator('#add-sidebar-button').click();
    result.steps.push('add_sidebar_clicked_while_fullscreen');
    const fullscreenAfterAddDebugState = await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      const state = payload?.response?.debugState || null;
      const viewportWidth = Number(page.viewportSize()?.width) || 1920;
      return isEvenFullscreenSplit(state, 3, viewportWidth) ? state : null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 250,
      label: 'new sidebar joins fullscreen split'
    });
    result.fullscreenAfterAddDebugState = fullscreenAfterAddDebugState;
    result.steps.push('new_sidebar_joined_fullscreen_split');

    const fullscreenFramesAfterAdd = await waitFor(async () => {
      const frames = getSidebarFrames(page, extensionId);
      return frames.length === 3 ? frames : null;
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: 'three sidebar frames after fullscreen add'
    });
    const thirdFrame = fullscreenFramesAfterAdd.find((frame) => {
      const id = extractInstanceId(frame.url());
      return id && !instanceIds.includes(id);
    });
    if (!thirdFrame) {
      throw new Error('Cannot identify the fullscreen-created third sidebar frame.');
    }
    const thirdInstanceId = extractInstanceId(thirdFrame.url());
    result.thirdInstanceId = thirdInstanceId;

    await secondFrame.locator('#add-sidebar-button').click();
    const fullscreenAfterCloseDebugState = await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      const state = payload?.response?.debugState || null;
      const viewportWidth = Number(page.viewportSize()?.width) || 1920;
      return !findInstanceState(state, secondInstanceId)
        && isEvenFullscreenSplit(state, 2, viewportWidth)
        ? state
        : null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 250,
      label: 'closed fullscreen sidebar is destroyed and layout resplits'
    });
    result.fullscreenAfterCloseDebugState = fullscreenAfterCloseDebugState;
    result.steps.push('fullscreen_sidebar_destroyed_and_resplit');

    const sortedFullscreenStatesBeforeSplitResize = (fullscreenAfterCloseDebugState.instances || [])
      .filter((item) => item?.isActuallyVisible && item?.isFullscreen && item?.rect)
      .sort((a, b) => a.rect.x - b.rect.x);
    const leftSplitBeforeResize = sortedFullscreenStatesBeforeSplitResize[0] || null;
    const rightSplitBeforeResize = sortedFullscreenStatesBeforeSplitResize[1] || null;
    if (!leftSplitBeforeResize || !rightSplitBeforeResize || !leftSplitBeforeResize.hasFullscreenDivider) {
      throw new Error('Cannot find fullscreen split divider before resizing.');
    }
    const viewportWidthForSplitResize = Number(page.viewportSize()?.width) || 1920;
    const splitResizeDelta = Math.min(220, Math.max(120, viewportWidthForSplitResize * 0.14));
    await page.mouse.move(
      leftSplitBeforeResize.rect.x + leftSplitBeforeResize.rect.width - 4,
      leftSplitBeforeResize.rect.y + Math.round(leftSplitBeforeResize.rect.height / 2)
    );
    await page.mouse.down();
    await page.mouse.move(
      leftSplitBeforeResize.rect.x + leftSplitBeforeResize.rect.width + splitResizeDelta,
      leftSplitBeforeResize.rect.y + Math.round(leftSplitBeforeResize.rect.height / 2),
      { steps: 14 }
    );
    await page.mouse.up();

    const fullscreenSplitResizeDebugState = await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      const state = payload?.response?.debugState || null;
      const leftState = findInstanceState(state, leftSplitBeforeResize.instanceId);
      const rightState = findInstanceState(state, rightSplitBeforeResize.instanceId);
      return leftState?.rect?.width > leftSplitBeforeResize.rect.width + 60
        && rightState?.rect?.width < rightSplitBeforeResize.rect.width - 60
        && leftState?.hasFullscreenDivider === true
        && rightState?.hasFullscreenDivider === false
        ? state
        : null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 250,
      label: 'fullscreen split divider resizes pane ratios'
    });
    result.fullscreenSplitResizeDebugState = fullscreenSplitResizeDebugState;
    result.steps.push('fullscreen_split_divider_ratio_resize_verified');

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
      const remainingIds = [firstInstanceId, thirdInstanceId];
      const states = remainingIds.map((id) => findInstanceState(state, id));
      return state?.sidebarCount === 2
        && visibleCount === 2
        && !findInstanceState(state, secondInstanceId)
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

    await thirdFrame.locator('#add-sidebar-button').click();
    const closeDebugState = await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      const state = payload?.response?.debugState || null;
      const visibleCount = Array.isArray(state?.instances)
        ? state.instances.filter((item) => item?.isActuallyVisible).length
        : 0;
      return state?.sidebarCount === 1 && visibleCount === 1 ? state : null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 250,
      label: 'remaining secondary sidebar destroyed'
    });
    result.closeDebugState = closeDebugState;
    result.steps.push('remaining_secondary_sidebar_destroyed');

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
      return state?.sidebarCount === 1 && visibleCount === 1 ? state : null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 250,
      label: 'primary sidebar remains after destroyed secondaries'
    });
    result.reopenedDebugState = reopenedDebugState;
    result.steps.push('primary_sidebar_remains_after_destroyed_secondaries');

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
      return state?.sidebarCount === 1 && visibleCount === 0 ? state : null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 250,
      label: 'primary sidebar closed by global toggle'
    });
    result.toggleClosedDebugState = toggleClosedDebugState;
    result.steps.push('primary_sidebar_closed_by_global_toggle');

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
      return state?.sidebarCount === 1 && visibleCount === 1 ? state : null;
    }, {
      timeoutMs: 20_000,
      intervalMs: 250,
      label: 'primary sidebar reopened by global toggle'
    });
    result.toggleReopenedDebugState = toggleReopenedDebugState;
    result.steps.push('primary_sidebar_reopened_by_global_toggle');

    await firstFrame.locator('#add-sidebar-button').click();
    const sidebarAfterRecreateDebugState = await waitFor(async () => {
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
      label: 'second sidebar recreated for drag regression'
    });
    result.sidebarAfterRecreateDebugState = sidebarAfterRecreateDebugState;
    result.steps.push('second_sidebar_recreated_for_drag_regression');

    const framesAfterRecreate = await waitFor(async () => {
      const frames = getSidebarFrames(page, extensionId);
      return frames.length === 2 ? frames : null;
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      label: 'two sidebar frames after recreate'
    });
    const recreatedSecondFrame = framesAfterRecreate.find((frame) => extractInstanceId(frame.url()) !== firstInstanceId);
    if (!recreatedSecondFrame) {
      throw new Error('Cannot identify recreated second sidebar frame.');
    }
    const recreatedSecondInstanceId = extractInstanceId(recreatedSecondFrame.url());

    const secondBeforeDrag = findInstanceState(sidebarAfterRecreateDebugState, recreatedSecondInstanceId);
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
      const secondState = findInstanceState(state, recreatedSecondInstanceId);
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

    const secondBeforeResize = findInstanceState(dragReorderDebugState, recreatedSecondInstanceId);
    if (!secondBeforeResize?.rect || !Number.isFinite(Number(secondBeforeResize.sidebarWidth))) {
      throw new Error('Cannot find second sidebar debug state before resize.');
    }
    const edgeControlBox = await waitFor(async () => {
      const box = await recreatedSecondFrame.locator('#collapse-button').boundingBox().catch(() => null);
      return box && box.width > 0 && box.height > 0 ? box : null;
    }, {
      timeoutMs: 10_000,
      intervalMs: 250,
      label: 'sidebar edge control visible before resize'
    });
    const edgeControlStyle = await recreatedSecondFrame.locator('#collapse-button').evaluate((el) => {
      const style = window.getComputedStyle(el);
      return {
        width: style.width,
        height: style.height,
        opacity: style.opacity
      };
    });
    result.edgeControlStyleBeforeResize = edgeControlStyle;
    if (edgeControlStyle.width !== '5px' || edgeControlStyle.height !== '200px' || edgeControlStyle.opacity !== '0') {
      throw new Error(`Sidebar edge control style changed unexpectedly: ${JSON.stringify(edgeControlStyle)}`);
    }
    await page.mouse.move(
      edgeControlBox.x + Math.round(edgeControlBox.width / 2),
      edgeControlBox.y + Math.round(edgeControlBox.height / 2)
    );
    await page.mouse.down();
    await page.mouse.move(
      edgeControlBox.x + Math.round(edgeControlBox.width / 2) + 140,
      edgeControlBox.y + Math.round(edgeControlBox.height / 2),
      { steps: 10 }
    );
    await page.mouse.up();

    const resizeDebugState = await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      const state = payload?.response?.debugState || null;
      const secondState = findInstanceState(state, recreatedSecondInstanceId);
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
      recreatedSecondFrame.locator('body').screenshot({
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
