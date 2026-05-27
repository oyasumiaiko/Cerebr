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

const [rawRepoRoot, rawOutputDir, rawTargetUrl = 'https://example.com/'] = process.argv.slice(2);
const repoRoot = rawRepoRoot ? path.resolve(rawRepoRoot) : '';
const outputDir = rawOutputDir ? path.resolve(rawOutputDir) : '';

if (!repoRoot || !outputDir) {
  throw new Error(
    'Usage: node tests/cdp_streaming_scroll_stability_regression.cjs <repoRoot> <outputDir> [targetUrl=https://example.com/]'
  );
}

const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);

async function waitFrame(sidebarFrame, count = 2) {
  await sidebarFrame.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function seedStreamingMessage(sidebarFrame) {
  return await sidebarFrame.evaluate(() => {
    const chatContainer = document.getElementById('chat-container');
    const emptyState = document.querySelector('.empty-state-content');
    const debug = window.cerebr?.debug;
    const messageProcessor = debug?.messageProcessor;
    const messageSender = debug?.messageSender;
    if (!chatContainer || !messageProcessor || !messageSender) {
      throw new Error('sidebar debug services not ready');
    }

    if (emptyState instanceof HTMLElement) {
      emptyState.style.display = 'none';
    }
    chatContainer.innerHTML = '';

    for (let index = 0; index < 36; index += 1) {
      const message = document.createElement('div');
      message.className = `message ${index % 2 === 0 ? 'user-message' : 'ai-message'} skip-appear-animation`;
      message.style.minHeight = '86px';
      message.textContent = `stream-scroll-seed-${index}`;
      chatContainer.appendChild(message);
    }

    const buildMarkdown = (sections) => {
      const parts = ['流式回答滚动稳定性回归。'];
      for (let index = 0; index < sections; index += 1) {
        parts.push('');
        parts.push(`## 小节 ${index + 1}`);
        parts.push('');
        parts.push(`这是一段用于制造真实 Markdown block 高度的内容 ${index + 1}。`);
        parts.push('');
        parts.push('- 列表项一');
        parts.push('- 列表项二');
        if (index % 4 === 3) {
          parts.push('');
          parts.push('```js');
          parts.push(`console.log("stream-block-${index + 1}");`);
          parts.push('```');
        }
      }
      return parts.join('\n');
    };

    const latestMessage = messageProcessor.appendMessage('', 'ai', false);
    if (!(latestMessage instanceof HTMLElement)) {
      throw new Error('failed to create streaming assistant message');
    }
    latestMessage.classList.add('skip-appear-animation');
    const messageId = latestMessage.getAttribute('data-message-id') || '';
    messageProcessor.updateAIMessage(messageId, buildMarkdown(10), null);
    messageSender.setShouldAutoScroll(true);
    chatContainer.scrollTop = Math.max(0, latestMessage.offsetTop + 180);
    chatContainer.dispatchEvent(new Event('scroll', { bubbles: true }));

    const distanceToBottom = Math.max(
      0,
      (chatContainer.scrollHeight || 0) - (chatContainer.scrollTop || 0) - (chatContainer.clientHeight || 0)
    );

    return {
      messageId,
      scrollTop: chatContainer.scrollTop,
      scrollHeight: chatContainer.scrollHeight,
      clientHeight: chatContainer.clientHeight,
      distanceToBottom,
      shouldAutoScroll: messageSender.getShouldAutoScroll()
    };
  });
}

async function simulateUserScrollAway(sidebarFrame) {
  return await sidebarFrame.evaluate(() => {
    const chatContainer = document.getElementById('chat-container');
    const messageSender = window.cerebr?.debug?.messageSender;
    if (!chatContainer || !messageSender) {
      throw new Error('scroll container or sender missing');
    }

    chatContainer.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: -180,
      deltaMode: 0
    }));
    chatContainer.scrollTop = Math.max(0, (chatContainer.scrollTop || 0) - 180);
    chatContainer.dispatchEvent(new Event('scroll', { bubbles: true }));

    return {
      scrollTop: chatContainer.scrollTop,
      scrollHeight: chatContainer.scrollHeight,
      clientHeight: chatContainer.clientHeight,
      distanceToBottom: Math.max(
        0,
        (chatContainer.scrollHeight || 0) - (chatContainer.scrollTop || 0) - (chatContainer.clientHeight || 0)
      ),
      shouldAutoScroll: messageSender.getShouldAutoScroll()
    };
  });
}

async function appendStreamingMarkdown(sidebarFrame, messageId, sections) {
  return await sidebarFrame.evaluate(({ id, count }) => {
    const chatContainer = document.getElementById('chat-container');
    const messageProcessor = window.cerebr?.debug?.messageProcessor;
    const messageSender = window.cerebr?.debug?.messageSender;
    if (!chatContainer || !messageProcessor || !messageSender) {
      throw new Error('streaming update services missing');
    }

    const parts = ['流式回答滚动稳定性回归。'];
    for (let index = 0; index < count; index += 1) {
      parts.push('');
      parts.push(`## 小节 ${index + 1}`);
      parts.push('');
      parts.push(`这是一段用于制造真实 Markdown block 高度的内容 ${index + 1}。`);
      parts.push('');
      parts.push('- 列表项一');
      parts.push('- 列表项二');
      if (index % 4 === 3) {
        parts.push('');
        parts.push('```js');
        parts.push(`console.log("stream-block-${index + 1}");`);
        parts.push('```');
      }
    }
    messageProcessor.updateAIMessage(id, parts.join('\n'), null);
    const distanceToBottom = Math.max(
      0,
      (chatContainer.scrollHeight || 0) - (chatContainer.scrollTop || 0) - (chatContainer.clientHeight || 0)
    );
    return {
      scrollTop: chatContainer.scrollTop,
      scrollHeight: chatContainer.scrollHeight,
      clientHeight: chatContainer.clientHeight,
      distanceToBottom,
      shouldAutoScroll: messageSender.getShouldAutoScroll()
    };
  }, { id: messageId, count: sections });
}

async function scrollBackToBottomAndUpdate(sidebarFrame, messageId) {
  return await sidebarFrame.evaluate((id) => {
    const chatContainer = document.getElementById('chat-container');
    const messageProcessor = window.cerebr?.debug?.messageProcessor;
    const messageSender = window.cerebr?.debug?.messageSender;
    if (!chatContainer || !messageProcessor || !messageSender) {
      throw new Error('bottom update services missing');
    }

    chatContainer.scrollTop = Math.max(0, (chatContainer.scrollHeight || 0) - (chatContainer.clientHeight || 0));
    chatContainer.dispatchEvent(new Event('scroll', { bubbles: true }));

    const parts = ['已经回到底部，下一帧应该继续稳定跟随。'];
    for (let index = 0; index < 42; index += 1) {
      parts.push('');
      parts.push(`### 底部追加 ${index + 1}`);
      parts.push(`追加内容 ${index + 1}`);
    }
    messageProcessor.updateAIMessage(id, parts.join('\n'), null);

    return {
      scrollTop: chatContainer.scrollTop,
      scrollHeight: chatContainer.scrollHeight,
      clientHeight: chatContainer.clientHeight,
      distanceToBottom: Math.max(
        0,
        (chatContainer.scrollHeight || 0) - (chatContainer.scrollTop || 0) - (chatContainer.clientHeight || 0)
      ),
      shouldAutoScroll: messageSender.getShouldAutoScroll()
    };
  }, messageId);
}

async function main() {
  await fsp.mkdir(outputDir, { recursive: true });
  const result = {
    startedAt: new Date().toISOString(),
    outputDir,
    targetUrl: rawTargetUrl,
    launchMode: 'worktree_unpacked',
    headless: runHeadless,
    console: [],
    steps: []
  };

  const profileDir = resolveWorktreeUnpackedProfileDir(repoRoot, 'streaming-scroll-stability');
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
    page.on('console', (msg) => {
      result.console.push({ type: msg.type(), text: msg.text() });
    });
    page.on('pageerror', (error) => {
      result.console.push({ type: 'pageerror', text: String(error && (error.stack || error.message || error)) });
    });
    await page.goto(rawTargetUrl, { waitUntil: 'domcontentloaded' });
    result.steps.push('page_loaded');

    const extensionWorker = await waitForWorktreeExtensionWorker(context, { timeoutMs: 30_000 });
    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;
    result.steps.push('worker_ready');

    await extensionWorker.evaluate(async () => {
      await chrome.storage.sync.set({
        autoScroll: true,
        stopAtTop: false,
        collapseLongCodeBlocks: true
      });
      return true;
    });
    result.steps.push('settings_seeded');

    await extensionWorker.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'OPEN_SIDEBAR' }))
    );
    result.steps.push('sidebar_open_requested');

    await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      return payload?.response?.debugState?.isActuallyVisible ? true : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: 'sidebar visible' });
    result.steps.push('sidebar_visible');

    const sidebarFrame = await waitForSidebarFrame(page, extensionId, { timeoutMs: 30_000 });
    await waitFor(async () => await sidebarFrame.evaluate(() => (
      window.cerebr?.debug?.messageProcessor && window.cerebr?.debug?.messageSender ? true : null
    )), { timeoutMs: 30_000, intervalMs: 200, label: 'sidebar debug services' });
    result.steps.push('sidebar_debug_ready');

    result.seedState = await seedStreamingMessage(sidebarFrame);
    await waitFrame(sidebarFrame, 2);
    result.userScrollState = await simulateUserScrollAway(sidebarFrame);
    await waitFrame(sidebarFrame, 2);
    result.steps.push('user_scroll_away_simulated');

    const postUserTop = result.userScrollState.scrollTop;
    result.streamingUpdates = [];
    for (let step = 0; step < 8; step += 1) {
      const state = await appendStreamingMarkdown(sidebarFrame, result.seedState.messageId, 12 + step * 4);
      result.streamingUpdates.push(state);
      await waitFrame(sidebarFrame, 1);
    }
    result.afterStreamingAwayState = result.streamingUpdates[result.streamingUpdates.length - 1];
    result.steps.push('streaming_updates_while_away_applied');

    result.bottomUpdateState = await scrollBackToBottomAndUpdate(sidebarFrame, result.seedState.messageId);
    await waitFrame(sidebarFrame, 3);
    result.bottomSettledState = await sidebarFrame.evaluate(() => {
      const chatContainer = document.getElementById('chat-container');
      const messageSender = window.cerebr?.debug?.messageSender;
      return {
        scrollTop: chatContainer?.scrollTop || 0,
        scrollHeight: chatContainer?.scrollHeight || 0,
        clientHeight: chatContainer?.clientHeight || 0,
        distanceToBottom: chatContainer
          ? Math.max(0, (chatContainer.scrollHeight || 0) - (chatContainer.scrollTop || 0) - (chatContainer.clientHeight || 0))
          : null,
        shouldAutoScroll: messageSender?.getShouldAutoScroll?.() ?? null
      };
    });
    result.steps.push('bottom_follow_verified');

    await sidebarFrame.locator('body').screenshot({
      path: path.join(outputDir, 'sidebar-body.png')
    });
    result.steps.push('screenshot_saved');

    const awayState = result.afterStreamingAwayState || {};
    const awayDistance = Number(awayState.distanceToBottom);
    const awayDrift = Math.abs(Number(awayState.scrollTop || 0) - Number(postUserTop || 0));
    const bottomDistance = Number(result.bottomSettledState?.distanceToBottom);
    if (result.userScrollState.shouldAutoScroll !== false) {
      throw new Error('user scroll did not disable auto-follow');
    }
    if (awayState.shouldAutoScroll !== false) {
      throw new Error('streaming updates re-enabled auto-follow while user was away from bottom');
    }
    if (!Number.isFinite(awayDistance) || awayDistance <= 160) {
      throw new Error(`streaming updates snapped near bottom unexpectedly: distance=${awayDistance}`);
    }
    if (!Number.isFinite(awayDrift) || awayDrift > 96) {
      throw new Error(`scrollTop drifted too much while streaming away from bottom: drift=${awayDrift}`);
    }
    if (!Number.isFinite(bottomDistance) || bottomDistance > 4) {
      throw new Error(`auto-follow did not keep bottom after user returned: distance=${bottomDistance}`);
    }

    result.metrics = {
      awayDistance,
      awayDrift,
      bottomDistance
    };
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
