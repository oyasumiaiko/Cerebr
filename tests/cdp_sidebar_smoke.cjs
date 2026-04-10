const fsp = require('fs/promises');
const path = require('path');
const {
  buildSendContentMessageExpression,
  launchFixedSidebarContext,
  loadPlaywright,
  reloadUnpackedExtension,
  resolveFixedSidebarProfileDir,
  shouldRunHeadless,
  waitFor,
  waitForSidebarFrame
} = require('./lib/stable_chrome_sidebar_harness.cjs');

const [
  repoRoot,
  outputDir,
  chromePath,
  baseUrl,
  apiKey,
  modelName,
  scenario = 'single',
  useStreamingArg = 'true'
] = process.argv.slice(2);

if (!repoRoot || !outputDir || !chromePath || !baseUrl || !apiKey || !modelName) {
  throw new Error(
    'Usage: node tests/cdp_sidebar_smoke.cjs <repoRoot> <outputDir> <chromePath> <baseUrl> <apiKey> <modelName> [scenario=single|queue] [useStreaming=true|false]'
  );
}

const useStreaming = useStreamingArg !== 'false';
const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);

async function captureRightBottomCrop(page, outputPath, {
  width = 420,
  height = 220,
  bottomInset = 0,
  rightInset = 0
} = {}) {
  const viewport = page.viewportSize() || await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }));
  if (!viewport?.width || !viewport?.height) {
    throw new Error('page viewport size unavailable for right-bottom crop');
  }
  const clipWidth = Math.min(width, viewport.width);
  const clipHeight = Math.min(height, viewport.height);
  const x = Math.max(0, viewport.width - clipWidth - rightInset);
  const y = Math.max(0, viewport.height - clipHeight - bottomInset);
  await page.screenshot({
    path: outputPath,
    clip: {
      x,
      y,
      width: clipWidth,
      height: clipHeight
    }
  });
}


function buildStorageSeed() {
  return {
    apiConfigs: [{
      id: 'cfg_real_responses_sidebar_smoke',
      displayName: 'Real Responses Sidebar Smoke',
      modelName,
      baseUrl,
      connectionType: 'openai_responses',
      apiKey,
      customParams: '',
      customSystemPrompt: '',
      temperature: 1,
      useStreaming,
      responsesApiSettings: {
        reasoning: {
          effort: 'medium',
          generate_summary: 'detailed',
          summary: 'detailed'
        },
        text: {
          verbosity: 'low'
        },
        parallel_tool_calls: true,
        store: false,
        builtin_tools: {
          web_search: {
            enabled: true,
            external_web_access: true,
            include_sources: true
          }
        }
      }
    }],
    selectedConfigIndex: 0,
    sendChatHistory: true,
    showThoughtProcess: true,
    queueCurrentConversationMessages: true
  };
}

function buildPrompt(currentScenario) {
  if (currentScenario === 'shortcut_steer') {
    return {
      first: 'Please directly call js_runtime_execute on the current page, report document.title and location.href on line 1, then continue with 40 short numbered lines so the response keeps streaming for a while.',
      queued: 'When it is your turn, reply with exactly QUEUE_ENTER_ONLY_20260405 and nothing else.',
      steer: 'When it is your turn, reply with exactly STEER_CTRL_NOW_20260405 and nothing else.',
      altOnly: 'UPSCREEN_ALT_ONLY_20260405',
      shiftLine1: 'SHIFT_LINE_ONE_20260405',
      shiftLine2: 'SHIFT_LINE_TWO_20260405'
    };
  }
  if (currentScenario === 'multi_queue_reorder') {
    return {
      first: 'Please directly call js_runtime_execute on the current page, report document.title and location.href on line 1, then continue with 40 short numbered lines so the response keeps streaming for a while.',
      second: 'When it is your turn, reply with exactly QUEUE_ALPHA_20260405 and nothing else.',
      third: 'When it is your turn, reply with exactly QUEUE_BETA_20260405 and nothing else.'
    };
  }
  if (currentScenario === 'queue') {
    return {
      first: 'Please directly call js_runtime_execute on the current page and briefly report document.title and location.href.',
      second: 'This is a second message that should enter the queue if the first one is still running.'
    };
  }
  return {
    first: 'Please directly call js_runtime_execute on the current page and read document.title, location.href, and document.readyState. Then reply briefly. Avoid web search unless absolutely necessary.'
  };
}

async function main() {
  await fsp.mkdir(outputDir, { recursive: true });

  const result = {
    startedAt: new Date().toISOString(),
    outputDir,
    baseUrl,
    modelName,
    useStreaming,
    headless: runHeadless,
    scenario,
    console: [],
    backgroundConsole: [],
    steps: []
  };

  const profileDir = resolveFixedSidebarProfileDir(repoRoot);
  await fsp.mkdir(profileDir, { recursive: true });
  result.profileDir = profileDir;

  let context = null;
  let extensionWorker = null;
  try {
    context = await launchFixedSidebarContext({
      chromium,
      profileDir,
      executablePath: chromePath,
      headless: runHeadless
    });
    result.steps.push('browser_ready');

    extensionWorker = await reloadUnpackedExtension(context, { timeoutMs: 30_000 });
    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;
    result.steps.push('background_ready');
    result.steps.push('extension_reloaded');

    await extensionWorker.evaluate(`(async () => {
      await chrome.storage.sync.clear();
      await chrome.storage.sync.set(${JSON.stringify(buildStorageSeed())});
      return true;
    })()`);
    result.steps.push('storage_seeded');

    const page = context.pages().find((entry) => entry.url().startsWith('https://example.com/')) || await context.newPage();
    page.on('console', (msg) => {
      result.console.push({ type: msg.type(), text: msg.text() });
    });
    page.on('pageerror', (error) => {
      result.console.push({ type: 'pageerror', text: String(error && (error.stack || error.message || error)) });
    });

    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    result.steps.push('page_loaded');

    const preOpenSidebarState = await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      const debugState = payload?.response?.debugState || null;
      return debugState?.initialized ? payload : null;
    }, { timeoutMs: 15000, intervalMs: 250, label: 'sidebar initialized before open' });
    result.preOpenSidebarState = preOpenSidebarState;
    result.steps.push('sidebar_initialized');

    const openSidebarResponse = await extensionWorker.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'OPEN_SIDEBAR' }))
    );
    result.openSidebarResponse = openSidebarResponse;
    if (!openSidebarResponse?.response?.success || openSidebarResponse?.response?.status !== true) {
      throw new Error(`OPEN_SIDEBAR did not report visible=true: ${JSON.stringify(openSidebarResponse)}`);
    }
    result.steps.push('sidebar_open_requested');

    const sidebarDebugState = await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      const state = payload?.response?.debugState || null;
      return state?.isActuallyVisible ? state : null;
    }, { timeoutMs: 15000, intervalMs: 250, label: 'sidebar actual visibility' });
    result.sidebarDebugState = sidebarDebugState;
    result.steps.push('sidebar_visible_confirmed');

    const sidebarFrame = await waitForSidebarFrame(page, extensionId, { timeoutMs: 30000 });
    await sidebarFrame.locator('#message-input').waitFor({ state: 'visible', timeout: 30000 });
    await page.screenshot({ path: path.join(outputDir, '01-sidebar-visible.png'), fullPage: true });
    result.steps.push('sidebar_frame_ready');

    async function fillSidebarInput(text, options = {}) {
      const input = sidebarFrame.locator('#message-input');
      await input.focus();
      if (options.clear !== false) {
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
      }
      await page.keyboard.type(text);
      return input;
    }

    async function sendSidebarMessage(text, options = {}) {
      await fillSidebarInput(text, options);
      await page.keyboard.press(options.submitShortcut || 'Enter');
    }

    async function getAssistantTexts() {
      return await sidebarFrame.evaluate(() => (
        Array.from(document.querySelectorAll('.message.ai-message'))
          .map((el) => (el.innerText || '').trim())
          .filter(Boolean)
      ));
    }

    async function getUserTexts() {
      return await sidebarFrame.evaluate(() => (
        Array.from(document.querySelectorAll('.message.user-message'))
          .map((el) => (el.innerText || '').trim())
          .filter(Boolean)
      ));
    }

    async function getQueuePanelSnapshot() {
      return await sidebarFrame.evaluate(() => {
        const panel = document.querySelector('.conversation-send-queue-preview');
        if (!panel) return null;
        return {
          text: (panel.innerText || '').trim(),
          items: Array.from(panel.querySelectorAll('.conversation-send-queue-preview__item')).map((item) => ({
            text: (item.innerText || '').trim(),
            taskId: item.getAttribute('data-queue-task-id')
          }))
        };
      });
    }

    const prompts = buildPrompt(scenario);

    if (scenario === 'shortcut_steer') {
      result.shortcutChecks = {};

      await fillSidebarInput(prompts.shiftLine1);
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.type(prompts.shiftLine2);
      result.shortcutChecks.shiftEnter = await sidebarFrame.evaluate(() => {
        const input = document.querySelector('#message-input');
        return {
          textContent: input?.textContent || '',
          innerText: input?.innerText || '',
          html: input?.innerHTML || ''
        };
      });
      result.steps.push('shift_enter_checked');

      await sendSidebarMessage(prompts.first);
      result.steps.push('first_message_sent');

      await waitFor(async () => {
        return await sidebarFrame.evaluate(() => {
          const latestAi = Array.from(document.querySelectorAll('.message.ai-message')).slice(-1)[0] || null;
          return latestAi?.classList?.contains('updating') ? true : null;
        });
      }, { timeoutMs: 15000, intervalMs: 200, label: 'first message streaming for steer shortcut' });

      await sendSidebarMessage(prompts.queued);
      result.steps.push('queued_message_sent_with_enter');

      result.queueVisible = await waitFor(async () => {
        const snapshot = await getQueuePanelSnapshot();
        if (!snapshot?.items?.length) return null;
        return snapshot.items.some((item) => item.text.includes('QUEUE_ENTER_ONLY_20260405'))
          ? snapshot
          : null;
      }, { timeoutMs: 20000, intervalMs: 250, label: 'queue preview visible for steer shortcut' });
      await page.screenshot({ path: path.join(outputDir, '02-queue-visible.png'), fullPage: true });
      await captureRightBottomCrop(page, path.join(outputDir, '02-queue-visible-right-bottom.png'));
      result.steps.push('queue_visible');

      await sendSidebarMessage(prompts.steer, { submitShortcut: 'Control+Enter' });
      result.steps.push('ctrl_enter_steer_sent');

      result.queueAfterSteer = await waitFor(async () => {
        const snapshot = await getQueuePanelSnapshot();
        if (!snapshot?.items?.length) return null;
        return snapshot.items.some((item) => item.text.includes('待确认') && item.text.includes('QUEUE_ENTER_ONLY_20260405'))
          ? snapshot
          : null;
      }, { timeoutMs: 20000, intervalMs: 250, label: 'queue stale after steer' });
      await page.screenshot({ path: path.join(outputDir, '03-after-steer.png'), fullPage: true });
      await captureRightBottomCrop(page, path.join(outputDir, '03-after-steer-right-bottom.png'));
      result.steps.push('queue_staled_after_steer');

      const settled = await waitFor(async () => {
        const texts = await getAssistantTexts();
        const steerIndex = texts.findIndex((text) => text.includes('STEER_CTRL_NOW_20260405'));
        if (steerIndex < 0) return null;
        return {
          assistantTexts: texts,
          steerIndex,
          latestText: texts[texts.length - 1] || ''
        };
      }, { timeoutMs: 180000, intervalMs: 500, label: 'steer assistant settled' });
      result.assistant = settled;
      result.steps.push('assistant_settled');

      const assistantCountBeforeAlt = settled.assistantTexts.length;
      await sendSidebarMessage(prompts.altOnly, { submitShortcut: 'Alt+Enter' });
      result.steps.push('alt_enter_append_only');
      result.shortcutChecks.altEnter = await waitFor(async () => {
        const userTexts = await getUserTexts();
        const assistantTexts = await getAssistantTexts();
        const foundUser = userTexts.some((text) => text.includes('UPSCREEN_ALT_ONLY_20260405'));
        if (!foundUser) return null;
        return {
          userTexts,
          assistantCountBeforeAlt,
          assistantCountAfterAlt: assistantTexts.length
        };
      }, { timeoutMs: 10000, intervalMs: 250, label: 'alt enter append only user message' });

      result.highlightWarnings = result.console.filter((entry) => String(entry.text || '').includes('Element previously highlighted'));
      await page.screenshot({ path: path.join(outputDir, '04-after-alt-enter.png'), fullPage: true });
      await captureRightBottomCrop(page, path.join(outputDir, '04-after-alt-enter-right-bottom.png'));
      result.finishedAt = new Date().toISOString();
      await fsp.writeFile(path.join(outputDir, 'cdp-sidebar-smoke-result.json'), JSON.stringify(result, null, 2), 'utf8');
      return;
    }

    await sendSidebarMessage(prompts.first);
    result.steps.push('first_message_sent');

    if (scenario === 'queue' || scenario === 'multi_queue_reorder') {
      await waitFor(async () => {
        return await sidebarFrame.evaluate(() => {
          const latestAi = Array.from(document.querySelectorAll('.message.ai-message')).slice(-1)[0] || null;
          return latestAi?.classList?.contains('updating') ? true : null;
        });
      }, { timeoutMs: 15000, intervalMs: 200, label: 'first message streaming' });

      await sendSidebarMessage(prompts.second);
      result.steps.push('second_message_sent');

      if (scenario === 'multi_queue_reorder') {
        await sendSidebarMessage(prompts.third);
        result.steps.push('third_message_sent');
      }

      result.queueVisible = await waitFor(async () => {
        return await sidebarFrame.evaluate((currentScenario) => {
          const panel = document.querySelector('.conversation-send-queue-preview');
          if (!panel) return null;
          const count = panel.querySelectorAll('.conversation-send-queue-preview__item').length;
          const requiredCount = currentScenario === 'multi_queue_reorder' ? 2 : 1;
          if (count < requiredCount) return null;
          return {
            count,
            text: (panel.innerText || '').trim(),
            items: Array.from(panel.querySelectorAll('.conversation-send-queue-preview__item')).map((item) => ({
              text: (item.innerText || '').trim(),
              taskId: item.getAttribute('data-queue-task-id')
            }))
          };
        }, scenario);
      }, { timeoutMs: 20000, intervalMs: 250, label: 'queue preview visible' });
      await page.screenshot({ path: path.join(outputDir, '02-queue-visible.png'), fullPage: true });
      await captureRightBottomCrop(page, path.join(outputDir, '02-queue-visible-right-bottom.png'));
      result.queueDiagnostics = await sidebarFrame.evaluate(() => {
        const panel = document.querySelector('.conversation-send-queue-preview');
        if (!panel) return null;
        const list = panel.querySelector('.conversation-send-queue-preview__list');
        const firstItem = list?.querySelector('.conversation-send-queue-preview__item');
        const actions = firstItem?.querySelector('.conversation-send-queue-preview__actions');
        const summary = firstItem?.querySelector('.conversation-send-queue-preview__summary');
        const text = firstItem?.querySelector('.conversation-send-queue-preview__text');
        const collect = (node) => {
          if (!node) return null;
          const rect = node.getBoundingClientRect();
          const style = window.getComputedStyle(node);
          return {
            className: node.className || null,
            clientWidth: node.clientWidth,
            scrollWidth: node.scrollWidth,
            offsetWidth: node.offsetWidth,
            rect: {
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
              right: rect.right
            },
            paddingInlineEnd: style.paddingInlineEnd,
            marginInlineEnd: style.marginInlineEnd,
            overflowX: style.overflowX,
            overflowY: style.overflowY
          };
        };
        return {
          panel: collect(panel),
          list: collect(list),
          firstItem: collect(firstItem),
          actions: collect(actions),
          summary: collect(summary),
          text: collect(text),
          panelText: (panel.innerText || '').trim()
        };
      });
      result.steps.push('queue_visible');

      if (scenario === 'multi_queue_reorder') {
        const handles = sidebarFrame.locator('.conversation-send-queue-preview__drag-handle');
        const items = sidebarFrame.locator('.conversation-send-queue-preview__item');
        const sourceHandle = handles.nth(1);
        const targetItem = items.nth(0);
        await sourceHandle.scrollIntoViewIfNeeded();
        await targetItem.scrollIntoViewIfNeeded();
        const sourceBox = await waitFor(async () => await sourceHandle.boundingBox(), {
          timeoutMs: 5000,
          intervalMs: 100,
          label: 'source drag handle box'
        });
        const targetBox = await waitFor(async () => await targetItem.boundingBox(), {
          timeoutMs: 5000,
          intervalMs: 100,
          label: 'target queue item box'
        });
        result.queueDragBoxes = { sourceBox, targetBox };
        await page.mouse.move(sourceBox.x + (sourceBox.width / 2), sourceBox.y + (sourceBox.height / 2));
        await page.mouse.down();
        await page.mouse.move(targetBox.x + 24, targetBox.y + Math.max(6, targetBox.height * 0.25), { steps: 20 });
        await page.mouse.up();
        result.steps.push('queue_reordered');
        await sleep(500);
        result.queueOrderImmediatelyAfterDrag = await sidebarFrame.evaluate(() => {
          return Array.from(document.querySelectorAll('.conversation-send-queue-preview__item'))
            .map((item) => (item.innerText || '').trim());
        });
        await page.screenshot({ path: path.join(outputDir, '03-queue-reordered.png'), fullPage: true });
        await captureRightBottomCrop(page, path.join(outputDir, '03-queue-reordered-right-bottom.png'));
      }
    }

    const settled = await waitFor(async () => {
      return await sidebarFrame.evaluate((currentScenario) => {
        const aiMessages = Array.from(document.querySelectorAll('.message.ai-message'));
        const completed = aiMessages.filter((el) => !el.classList.contains('updating'));
        if (currentScenario === 'multi_queue_reorder') {
          if (completed.length < 3) return null;
          const texts = completed.map((el) => (el.innerText || '').trim());
          const alphaIndex = texts.findIndex((text) => text.includes('QUEUE_ALPHA_20260405'));
          const betaIndex = texts.findIndex((text) => text.includes('QUEUE_BETA_20260405'));
          if (alphaIndex < 0 || betaIndex < 0) return null;
          return {
            completedCount: completed.length,
            assistantTexts: texts,
            alphaIndex,
            betaIndex,
            reorderedDeliveryOk: betaIndex < alphaIndex
          };
        }
        if (currentScenario === 'queue') {
          if (completed.length < 2) return null;
          return {
            completedCount: completed.length,
            latestText: (completed[completed.length - 1]?.innerText || '').trim()
          };
        }
        const latest = aiMessages[aiMessages.length - 1];
        if (!latest) return null;
        if (latest.classList.contains('updating')) return null;
        const text = (latest.innerText || '').trim();
        if (!text) return null;
        const timeline = latest.querySelector('.response-activity-timeline');
        return {
          text,
          hasTimeline: !!timeline,
          toolCount: timeline ? timeline.querySelectorAll('.response-activity-entry--tool').length : 0,
          panelExpanded: timeline ? timeline.classList.contains('is-expanded') : null,
          runtimeStatus: latest.dataset.responseRuntimeStatus || null
        };
      }, scenario);
    }, { timeoutMs: 180000, intervalMs: 500, label: 'assistant settled' });
    result.assistant = settled;
    result.highlightWarnings = result.console.filter((entry) => String(entry.text || '').includes('Element previously highlighted'));
    await page.screenshot({
      path: path.join(
        outputDir,
        scenario === 'multi_queue_reorder'
          ? '04-final.png'
          : (scenario === 'queue' ? '03-final.png' : '02-final.png')
      ),
      fullPage: true
    });
    await captureRightBottomCrop(
      page,
      path.join(
        outputDir,
        scenario === 'multi_queue_reorder'
          ? '04-final-right-bottom.png'
          : (scenario === 'queue' ? '03-final-right-bottom.png' : '02-final-right-bottom.png')
      )
    );
    result.steps.push('assistant_settled');

    result.finishedAt = new Date().toISOString();
    await fsp.writeFile(path.join(outputDir, 'cdp-sidebar-smoke-result.json'), JSON.stringify(result, null, 2), 'utf8');
  } finally {
    try { await context?.close(); } catch (_) {}
  }
}

main().catch(async (error) => {
  const payload = {
    error: String(error && (error.stack || error.message || error)),
    finishedAt: new Date().toISOString()
  };
  try {
    await fsp.mkdir(outputDir, { recursive: true });
    await fsp.writeFile(path.join(outputDir, 'cdp-sidebar-smoke-result.json'), JSON.stringify(payload, null, 2), 'utf8');
  } catch (_) {}
  process.exitCode = 1;
});
