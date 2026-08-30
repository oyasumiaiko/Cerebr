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
const {
  launchFixedSidebarContext,
  reloadUnpackedExtension,
  resolveFixedSidebarProfileDir,
  resolveStableChromeExecutablePath
} = require('./lib/stable_chrome_sidebar_harness.cjs');

const [
  rawRepoRoot,
  outputDir,
  targetUrl = 'https://example.com/',
  rawLaunchMode = 'worktree_unpacked'
] = process.argv.slice(2);
const repoRoot = rawRepoRoot ? path.resolve(rawRepoRoot) : '';
const launchMode = String(rawLaunchMode || '').trim().toLowerCase();

if (!repoRoot || !outputDir || !['worktree_unpacked', 'stable'].includes(launchMode)) {
  throw new Error(
    'Usage: node tests/cdp_sidebar_iframe_auto_recovery_regression.cjs <repoRoot> <outputDir> '
      + '[targetUrl=https://example.com/] [launchMode=worktree_unpacked|stable]'
  );
}

const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);
const startedAtMs = Date.now();

function logProgress(message) {
  const elapsedSeconds = ((Date.now() - startedAtMs) / 1000).toFixed(1);
  console.log(`[sidebar-iframe-recovery +${elapsedSeconds}s] ${message}`);
}

function getSidebarFrames(page, extensionId) {
  const prefix = `chrome-extension://${extensionId}/src/ui/sidebar/sidebar.html`;
  return page.frames().filter((frame) => frame.url().startsWith(prefix));
}

function getSidebarInstanceId(frame) {
  try {
    return new URL(frame.url()).searchParams.get('instanceId') || '';
  } catch (_) {
    return '';
  }
}

async function readHostDebugState(extensionWorker, tabId = null) {
  const payload = Number.isFinite(Number(tabId))
    ? await extensionWorker.evaluate(async (targetTabId) => ({
        tabId: targetTabId,
        response: await chrome.tabs.sendMessage(targetTabId, { type: 'GET_SIDEBAR_DEBUG_STATE' })
      }), Math.trunc(Number(tabId)))
    : await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
  return payload?.response?.debugState || null;
}

async function readTaskTabRegistry(extensionWorker) {
  return await extensionWorker.evaluate(async () => {
    const key = 'sidebarIframeTaskTabsV1';
    const stored = await chrome.storage.session.get([key]);
    return Array.isArray(stored?.[key]) ? stored[key] : [];
  });
}

async function waitForSidebarFrames(page, extensionId, expectedCount) {
  return await waitFor(async () => {
    const frames = getSidebarFrames(page, extensionId);
    if (frames.length < expectedCount) return null;
    for (const frame of frames) {
      const ready = await frame.evaluate(() => !!window.cerebr?.debug?.sidebarIframeHealthReporter).catch(() => false);
      if (!ready) return null;
    }
    return frames;
  }, {
    timeoutMs: 30_000,
    intervalMs: 250,
    label: `${expectedCount} ready sidebar frames`
  });
}

async function seedConversation(frame, marker) {
  return await frame.evaluate(async (seedMarker) => {
    const debug = window.cerebr?.debug;
    if (!debug?.messageProcessor || !debug?.chatHistoryUI) {
      throw new Error('sidebar debug services are unavailable');
    }
    debug.messageProcessor.appendMessage(`${seedMarker}-user`, 'user', false);
    debug.messageProcessor.appendMessage(`${seedMarker}-assistant`, 'ai', false);
    const saved = await debug.chatHistoryUI.saveCurrentConversation(false);
    return {
      conversationId: saved?.id || debug.chatHistoryUI.getCurrentConversationId?.() || '',
      marker: seedMarker
    };
  }, marker);
}

async function stopHeartbeat(frame, marker) {
  return await frame.evaluate((probeMarker) => {
    window.__cerebrIframeRecoveryProbeMarker = probeMarker;
    const reporter = window.cerebr?.debug?.sidebarIframeHealthReporter;
    if (typeof reporter?.__debugStopHeartbeat !== 'function') {
      throw new Error('sidebar iframe heartbeat debug stop hook is unavailable');
    }
    reporter.__debugStopHeartbeat();
    return true;
  }, marker);
}

async function setDebugActiveTask(frame, hasActiveTask) {
  return await frame.evaluate((nextState) => {
    const reporter = window.cerebr?.debug?.sidebarIframeHealthReporter;
    if (typeof reporter?.__debugSetActiveTaskOverride !== 'function') {
      throw new Error('sidebar iframe active-task debug hook is unavailable');
    }
    return reporter.__debugSetActiveTaskOverride(nextState === true);
  }, hasActiveTask);
}

async function readConversationMarkers(frame) {
  return await frame.evaluate(() => ({
    userTexts: Array.from(document.querySelectorAll('.message.user-message .text-content'))
      .map((element) => element.textContent || ''),
    assistantTexts: Array.from(document.querySelectorAll('.message.ai-message .text-content'))
      .map((element) => element.textContent || ''),
    probeMarker: window.__cerebrIframeRecoveryProbeMarker || null,
    conversationId: window.cerebr?.debug?.chatHistoryUI?.getCurrentConversationId?.() || ''
  }));
}

async function deleteSeededConversations(frame, conversationIds) {
  const normalizedIds = conversationIds
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  if (normalizedIds.length === 0) return [];
  return await frame.evaluate(async (ids) => {
    const storageUrl = chrome.runtime.getURL('src/storage/indexeddb_helper.js');
    const { deleteConversation } = await import(storageUrl);
    const deleted = [];
    for (const id of ids) {
      await deleteConversation(id);
      deleted.push(id);
    }
    return deleted;
  }, normalizedIds);
}

async function main() {
  await fsp.mkdir(outputDir, { recursive: true });
  const result = {
    startedAt: new Date().toISOString(),
    outputDir,
    targetUrl,
    launchMode,
    headless: runHeadless,
    steps: []
  };

  const profileDir = launchMode === 'stable'
    ? resolveFixedSidebarProfileDir(repoRoot)
    : resolveWorktreeUnpackedProfileDir(repoRoot, 'sidebar-iframe-auto-recovery');
  await fsp.mkdir(profileDir, { recursive: true });
  result.profileDir = profileDir;

  let context = null;
  try {
    let extensionWorker = null;
    if (launchMode === 'stable') {
      logProgress('启动固定 profile 的 stable Chrome，并显式重载当前工作区扩展');
      context = await launchFixedSidebarContext({
        chromium,
        profileDir,
        executablePath: resolveStableChromeExecutablePath(),
        headless: runHeadless
      });
      extensionWorker = await reloadUnpackedExtension(context, {
        timeoutMs: 30_000,
        settleMs: 2_000,
        unpackedPath: repoRoot
      });
    } else {
      logProgress('启动 worktree unpacked Chromium');
      context = await launchWorktreeUnpackedChromiumContext({
        chromium,
        repoRoot,
        profileDir,
        headless: runHeadless
      });
      extensionWorker = await waitForWorktreeExtensionWorker(context, { timeoutMs: 30_000 });
    }

    const page = await context.newPage();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    result.steps.push('page_loaded');

    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;
    result.steps.push('worker_ready');

    logProgress('打开主侧栏并创建第二个并行侧栏');
    const openSidebarResult = await extensionWorker.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'OPEN_SIDEBAR' }))
    );
    const hostTabId = Number(openSidebarResult?.tabId);
    if (!Number.isFinite(hostTabId)) {
      throw new Error('embedded sidebar host tab id is unavailable');
    }
    result.hostTabId = hostTabId;
    let frames = await waitForSidebarFrames(page, extensionId, 1);
    const primaryFrame = frames.find((frame) => new URL(frame.url()).searchParams.get('isPrimary') === '1') || frames[0];
    await primaryFrame.locator('#add-sidebar-button').click({ force: true });
    frames = await waitForSidebarFrames(page, extensionId, 2);

    const primaryInstanceId = getSidebarInstanceId(
      frames.find((frame) => new URL(frame.url()).searchParams.get('isPrimary') === '1') || frames[0]
    );
    const secondaryInstanceId = getSidebarInstanceId(
      frames.find((frame) => getSidebarInstanceId(frame) !== primaryInstanceId)
    );
    result.primaryInstanceId = primaryInstanceId;
    result.secondaryInstanceId = secondaryInstanceId;
    result.steps.push('two_sidebars_ready');

    let primary = frames.find((frame) => getSidebarInstanceId(frame) === primaryInstanceId);
    let secondary = frames.find((frame) => getSidebarInstanceId(frame) === secondaryInstanceId);
    const primarySeed = await seedConversation(primary, 'primary-recovery-marker');
    const secondarySeed = await seedConversation(secondary, 'secondary-recovery-marker');
    result.primaryConversationId = primarySeed.conversationId;
    result.secondaryConversationId = secondarySeed.conversationId;
    result.steps.push('conversations_seeded');

    await waitFor(async () => {
      const state = await readHostDebugState(extensionWorker, hostTabId);
      const byId = new Map((state?.instances || []).map((item) => [item.instanceId, item]));
      return byId.get(primaryInstanceId)?.lastConversationId === primarySeed.conversationId
        && byId.get(secondaryInstanceId)?.lastConversationId === secondarySeed.conversationId
        ? state
        : null;
    }, {
      timeoutMs: 15_000,
      intervalMs: 250,
      label: 'host cached conversation ids'
    });

    logProgress('聚焦主侧栏，并同时停止两个 iframe 的心跳');
    await primary.locator('#message-input').click({ force: true });
    await waitFor(async () => {
      const state = await readHostDebugState(extensionWorker, hostTabId);
      return state?.focusedSidebarId === primaryInstanceId ? state : null;
    }, {
      timeoutMs: 10_000,
      intervalMs: 200,
      label: 'primary sidebar focused'
    });
    await stopHeartbeat(primary, 'primary-before-reload');
    await stopHeartbeat(secondary, 'secondary-before-reload');
    result.steps.push('heartbeats_stopped');

    logProgress('等待 watchdog 只重载已聚焦的主侧栏');
    const afterPrimaryRecovery = await waitFor(async () => {
      const state = await readHostDebugState(extensionWorker, hostTabId);
      const byId = new Map((state?.instances || []).map((item) => [item.instanceId, item]));
      const primaryState = byId.get(primaryInstanceId);
      const secondaryState = byId.get(secondaryInstanceId);
      if (
        primaryState?.lastConversationRestoreResult?.success === true
        && primaryState?.iframeHeartbeatStale === false
        && secondaryState?.lastIframeReloadReason == null
        && secondaryState?.iframeHeartbeatStale === true
      ) {
        return state;
      }
      return null;
    }, {
      timeoutMs: 35_000,
      intervalMs: 500,
      label: 'focused sidebar selective recovery'
    });
    result.afterPrimaryRecovery = afterPrimaryRecovery;
    result.steps.push('primary_recovered_secondary_untouched');

    frames = await waitForSidebarFrames(page, extensionId, 2);
    primary = frames.find((frame) => getSidebarInstanceId(frame) === primaryInstanceId);
    secondary = frames.find((frame) => getSidebarInstanceId(frame) === secondaryInstanceId);
    const primaryMarkers = await readConversationMarkers(primary);
    const secondaryBeforeFocusMarkers = await readConversationMarkers(secondary);
    if (!primaryMarkers.userTexts.some((text) => text.includes('primary-recovery-marker-user'))) {
      throw new Error(`primary conversation was not restored: ${JSON.stringify(primaryMarkers)}`);
    }
    if (primaryMarkers.probeMarker !== null) {
      throw new Error('primary iframe execution context was not actually reloaded');
    }
    if (secondaryBeforeFocusMarkers.probeMarker !== 'secondary-before-reload') {
      throw new Error('unfocused secondary iframe was reloaded unexpectedly');
    }

    logProgress('聚焦此前未重载的第二侧栏，验证它此时才重载并恢复自己的对话');
    await secondary.locator('#message-input').click({ force: true });
    const afterSecondaryRecovery = await waitFor(async () => {
      const state = await readHostDebugState(extensionWorker, hostTabId);
      const secondaryState = (state?.instances || []).find((item) => item.instanceId === secondaryInstanceId);
      return secondaryState?.lastConversationRestoreResult?.success === true
        && secondaryState?.iframeHeartbeatStale === false
        ? state
        : null;
    }, {
      timeoutMs: 35_000,
      intervalMs: 500,
      label: 'secondary recovery after focus'
    });
    result.afterSecondaryRecovery = afterSecondaryRecovery;
    result.steps.push('secondary_recovered_after_focus');

    frames = await waitForSidebarFrames(page, extensionId, 2);
    primary = frames.find((frame) => getSidebarInstanceId(frame) === primaryInstanceId);
    secondary = frames.find((frame) => getSidebarInstanceId(frame) === secondaryInstanceId);

    logProgress('把主侧栏登记为仍有任务，切到另一标签页后验证后台 alarm 定向恢复');
    await setDebugActiveTask(primary, true);
    const taskRegistryAfterReport = await waitFor(async () => {
      const registry = await readTaskTabRegistry(extensionWorker);
      return registry.includes(hostTabId) ? registry : null;
    }, {
      timeoutMs: 10_000,
      intervalMs: 250,
      label: 'active-task tab registry update'
    });
    result.taskRegistryAfterReport = taskRegistryAfterReport;
    const beforeBackgroundTaskRecovery = await readHostDebugState(extensionWorker, hostTabId);
    const primaryBeforeTaskRecovery = (beforeBackgroundTaskRecovery?.instances || [])
      .find((item) => item.instanceId === primaryInstanceId);
    const previousPrimaryReloadCount = Number(primaryBeforeTaskRecovery?.automaticReloadCount || 0);
    await stopHeartbeat(primary, 'primary-active-task-before-reload');

    const foregroundTab = await extensionWorker.evaluate(async (targetHostTabId) => {
      const hostTab = await chrome.tabs.get(targetHostTabId);
      return await chrome.tabs.create({
        windowId: hostTab.windowId,
        url: 'about:blank',
        active: true
      });
    }, hostTabId);
    const foregroundTabId = Number(foregroundTab?.id);
    if (!Number.isFinite(foregroundTabId)) {
      throw new Error('failed to create a foreground tab in the task host window');
    }

    try {
      result.backgroundHostTabState = await waitFor(async () => {
        const tab = await extensionWorker.evaluate(
          async (targetHostTabId) => await chrome.tabs.get(targetHostTabId),
          hostTabId
        );
        return tab?.active === false ? tab : null;
      }, {
        timeoutMs: 10_000,
        intervalMs: 200,
        label: 'task host tab inactive'
      });

      const lastHeartbeatAt = Number(primaryBeforeTaskRecovery?.lastIframeHeartbeatAt || 0);
      const staleAt = lastHeartbeatAt + 15_050;
      const waitUntilStaleMs = Math.max(0, staleAt - Date.now());
      if (waitUntilStaleMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitUntilStaleMs));
      }

      const alarmName = 'sidebar-iframe-task-health-check';
      result.backgroundAlarmBeforeTrigger = await extensionWorker.evaluate(async ({ name, triggerAt }) => {
        const existing = await chrome.alarms.get(name);
        await chrome.alarms.clear(name);
        await chrome.alarms.create(name, { when: triggerAt });
        return existing || null;
      }, { name: alarmName, triggerAt: Date.now() + 50 });

      const afterBackgroundTaskRecovery = await waitFor(async () => {
        const state = await readHostDebugState(extensionWorker, hostTabId);
        const primaryState = (state?.instances || []).find((item) => item.instanceId === primaryInstanceId);
        if (
          primaryState?.lastIframeReloadReason === 'active_task_watchdog:background_alarm'
          && Number(primaryState?.automaticReloadCount || 0) > previousPrimaryReloadCount
          && primaryState?.lastConversationRestoreResult?.success === true
          && primaryState?.iframeHeartbeatStale === false
        ) {
          return state;
        }
        return null;
      }, {
        timeoutMs: 60_000,
        intervalMs: 500,
        label: 'background active-task sidebar recovery'
      });
      const hostTabAfterRecovery = await extensionWorker.evaluate(
        async (targetHostTabId) => await chrome.tabs.get(targetHostTabId),
        hostTabId
      );
      if (hostTabAfterRecovery?.active !== false) {
        throw new Error('active-task sidebar did not recover while its host tab remained in the background');
      }
      result.afterBackgroundTaskRecovery = afterBackgroundTaskRecovery;
      result.steps.push('background_active_task_recovered');

      result.taskRegistryAfterRecovery = await waitFor(async () => {
        const registry = await readTaskTabRegistry(extensionWorker);
        return registry.includes(hostTabId) ? null : registry;
      }, {
        timeoutMs: 10_000,
        intervalMs: 250,
        label: 'active-task tab registry cleanup after reload'
      });
    } finally {
      await extensionWorker.evaluate(async ({ temporaryTabId, targetHostTabId, alarmName }) => {
        await chrome.alarms.clear(alarmName);
        await chrome.alarms.create(alarmName, { periodInMinutes: 0.5 });
        await chrome.tabs.remove(temporaryTabId);
        await chrome.tabs.update(targetHostTabId, { active: true });
      }, {
        temporaryTabId: foregroundTabId,
        targetHostTabId: hostTabId,
        alarmName: 'sidebar-iframe-task-health-check'
      });
    }

    await page.bringToFront();
    frames = await waitForSidebarFrames(page, extensionId, 2);
    primary = frames.find((frame) => getSidebarInstanceId(frame) === primaryInstanceId);
    secondary = frames.find((frame) => getSidebarInstanceId(frame) === secondaryInstanceId);
    const finalPrimaryMarkers = await readConversationMarkers(primary);
    const finalSecondaryMarkers = await readConversationMarkers(secondary);
    if (!finalPrimaryMarkers.userTexts.some((text) => text.includes('primary-recovery-marker-user'))) {
      throw new Error(`background task conversation was not restored: ${JSON.stringify(finalPrimaryMarkers)}`);
    }
    if (finalPrimaryMarkers.probeMarker !== null) {
      throw new Error('background active-task iframe execution context was not actually reloaded');
    }
    if (!finalSecondaryMarkers.userTexts.some((text) => text.includes('secondary-recovery-marker-user'))) {
      throw new Error(`secondary conversation was not restored: ${JSON.stringify(finalSecondaryMarkers)}`);
    }
    if (finalSecondaryMarkers.probeMarker !== null) {
      throw new Error('secondary iframe execution context was not actually reloaded');
    }
    result.finalPrimaryMarkers = finalPrimaryMarkers;
    result.finalSecondaryMarkers = finalSecondaryMarkers;

    await primary.locator('body').screenshot({ path: path.join(outputDir, 'primary-restored-body.png') });
    await secondary.locator('body').screenshot({ path: path.join(outputDir, 'secondary-restored-body.png') });
    result.steps.push('screenshots_saved');

    result.deletedSeedConversationIds = await deleteSeededConversations(primary, [
      primarySeed.conversationId,
      secondarySeed.conversationId
    ]);
    result.steps.push('seed_conversations_deleted');

    result.ok = true;
    result.completedAt = new Date().toISOString();
    await fsp.writeFile(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    logProgress('浏览器回归完成');
  } finally {
    if (context) {
      await context.close().catch((error) => {
        console.error('关闭浏览器回归 context 失败:', error);
      });
    }
  }
}

main().catch(async (error) => {
  const failure = {
    ok: false,
    error: String(error && (error.stack || error.message || error)),
    failedAt: new Date().toISOString()
  };
  try {
    await fsp.mkdir(outputDir, { recursive: true });
    await fsp.writeFile(path.join(outputDir, 'result.json'), JSON.stringify(failure, null, 2), 'utf8');
  } catch (_) {}
  console.error(error);
  process.exitCode = 1;
});
