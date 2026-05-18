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

const [rawRepoRoot, outputDir, targetUrl = 'https://example.com/'] = process.argv.slice(2);
const repoRoot = rawRepoRoot ? path.resolve(rawRepoRoot) : '';

if (!repoRoot || !outputDir) {
  throw new Error(
    'Usage: node tests/cdp_message_screenshot_selection_regression.cjs <repoRoot> <outputDir> [targetUrl=https://example.com/]'
  );
}

const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);

async function openSidebar({ context, page, result }) {
  const extensionWorker = await waitForWorktreeExtensionWorker(context, { timeoutMs: 30_000 });
  const extensionId = new URL(extensionWorker.url()).host;
  result.extensionId = extensionId;
  result.steps.push('worker_ready');

  const openSidebarResponse = await extensionWorker.evaluate(
    buildSendContentMessageExpression(JSON.stringify({ type: 'OPEN_SIDEBAR' }))
  );
  result.openSidebarResponse = openSidebarResponse;
  result.steps.push('sidebar_open_requested');

  await waitFor(async () => {
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

  const sidebarFrame = await waitForSidebarFrame(page, extensionId, { timeoutMs: 30_000 });
  await sidebarFrame.locator('#message-input').waitFor({ state: 'visible', timeout: 30_000 });
  await waitFor(async () => (
    await sidebarFrame.evaluate(() => Boolean(window.cerebr?.debug?.messageProcessor))
  ), {
    timeoutMs: 30_000,
    intervalMs: 200,
    label: 'message processor ready'
  });
  result.sidebarFrameUrl = sidebarFrame.url();
  result.steps.push('sidebar_frame_ready');
  return sidebarFrame;
}

async function seedConversationMessages(sidebarFrame) {
  return await sidebarFrame.evaluate(() => {
    const container = document.querySelector('#chat-container');
    const processor = window.cerebr?.debug?.messageProcessor;
    if (!container || !processor?.appendMessage) {
      throw new Error('sidebar message processor unavailable');
    }
    container.innerHTML = '';

    const add = (id, sender, text) => {
      const message = processor.appendMessage(text, sender, true, null, null, null, null, null, {
        container
      });
      if (!message) throw new Error(`failed to append ${id}`);
      message.setAttribute('data-message-id', id);
      message.style.opacity = '1';
      message.style.transform = 'none';
      message.style.animation = 'none';
      return message;
    };

    add('probe-user-1', 'user', '用户第一条：需要放进长截图。');
    const ai = add('probe-ai-1', 'ai', 'AI 第一条：也需要放进同一张长图。');
    const thoughts = document.createElement('div');
    thoughts.className = 'thoughts-content';
    thoughts.textContent = '这段思考内容不应该进入截图快照。';
    ai.insertBefore(thoughts, ai.firstChild);
    add('probe-user-2', 'user', '用户第二条：验证顺序和多选计数。');

    return Array.from(container.querySelectorAll('.message[data-message-id]')).map((node) => ({
      id: node.getAttribute('data-message-id'),
      className: node.className,
      text: node.textContent
    }));
  });
}

async function installScreenshotExportProbe(sidebarFrame) {
  return await sidebarFrame.evaluate(() => {
    window.__messageScreenshotSelectionProbe = {
      canvasCalls: 0,
      clipboardWrites: 0,
      lastCanvas: null,
      lastClipboardItemCount: 0,
      canvasDelayMs: 350
    };

    Object.defineProperty(window, 'ClipboardItem', {
      configurable: true,
      value: class ClipboardItemProbe {
        constructor(items) {
          this.items = items;
        }
      }
    });

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        write: async (items) => {
          window.__messageScreenshotSelectionProbe.clipboardWrites += 1;
          window.__messageScreenshotSelectionProbe.lastClipboardItemCount = Array.isArray(items) ? items.length : 0;
        }
      }
    });

    window.domtoimage.toCanvas = async (node, options) => {
      const messages = Array.from(node.querySelectorAll('.message'));
      window.__messageScreenshotSelectionProbe.canvasCalls += 1;
      window.__messageScreenshotSelectionProbe.lastCanvas = {
        rootClassName: node.className,
        messageCount: messages.length,
        messageIds: messages.map((message) => message.getAttribute('data-message-id')),
        selectedArtifactCount: node.querySelectorAll('.message-screenshot-selectable, .message-screenshot-selected').length,
        thoughtsCount: node.querySelectorAll('.thoughts-content').length,
        width: options?.width || 0,
        height: options?.height || 0,
        scale: options?.scale || 0
      };
      await new Promise((resolve) => {
        setTimeout(resolve, window.__messageScreenshotSelectionProbe.canvasDelayMs);
      });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(options?.width || 1));
      canvas.height = Math.max(1, Math.round(options?.height || 1));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return canvas;
    };

    return true;
  });
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

  const profileDir = resolveWorktreeUnpackedProfileDir(repoRoot, 'message-screenshot-selection');
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
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    result.steps.push('page_loaded');

    const sidebarFrame = await openSidebar({ context, page, result });
    result.seededMessages = await seedConversationMessages(sidebarFrame);
    result.steps.push('messages_seeded');

    await installScreenshotExportProbe(sidebarFrame);
    result.steps.push('export_probe_installed');

    await sidebarFrame.locator('.message[data-message-id="probe-user-1"]').click({ button: 'right' });
    await sidebarFrame.locator('#context-menu').waitFor({ state: 'visible', timeout: 10_000 });
    await sidebarFrame.locator('#select-for-image').click();
    await sidebarFrame.locator('.message[data-message-id="probe-ai-1"]').click();
    await sidebarFrame.locator('.message[data-message-id="probe-user-2"]').click();

    result.selectionState = await waitFor(async () => {
      const state = await sidebarFrame.evaluate(() => ({
        selectedIds: Array.from(document.querySelectorAll('.message-screenshot-selected'))
          .map((node) => node.getAttribute('data-message-id')),
        selectableCount: document.querySelectorAll('.message-screenshot-selectable').length,
        toolbarText: document.querySelector('.message-screenshot-selection-toolbar')?.textContent || '',
        toolbarHidden: document.querySelector('.message-screenshot-selection-toolbar')?.hidden ?? true
      }));
      return state.selectedIds.length === 3 ? state : null;
    }, {
      timeoutMs: 10_000,
      intervalMs: 100,
      label: 'three screenshot messages selected'
    });
    result.steps.push('messages_selected');

    await sidebarFrame.locator('.message-screenshot-selection-toolbar [data-action="copy"]').click();
    result.exportingState = await waitFor(async () => {
      const state = await sidebarFrame.evaluate(() => {
        const copyButton = document.querySelector('.message-screenshot-selection-toolbar [data-action="copy"]');
        return {
          canvasCalls: window.__messageScreenshotSelectionProbe?.canvasCalls || 0,
          copyButtonText: copyButton?.textContent || '',
          copyButtonBusy: copyButton?.classList?.contains('is-busy') || false,
          copyButtonDisabled: !!copyButton?.disabled,
          notificationTexts: Array.from(document.querySelectorAll('.notification'))
            .map((node) => node.textContent || '')
        };
      });
      return state.canvasCalls === 1 && state.copyButtonBusy ? state : null;
    }, {
      timeoutMs: 10_000,
      intervalMs: 50,
      label: 'screenshot exporting feedback'
    });
    result.copyProbe = await waitFor(async () => {
      const probe = await sidebarFrame.evaluate(() => window.__messageScreenshotSelectionProbe || null);
      return probe?.clipboardWrites === 1 ? probe : null;
    }, {
      timeoutMs: 10_000,
      intervalMs: 100,
      label: 'long screenshot copied'
    });
    result.steps.push('long_screenshot_copied');

    const lastCanvas = result.copyProbe.lastCanvas || {};
    if (lastCanvas.rootClassName !== 'message-screenshot-transcript') {
      throw new Error(`unexpected screenshot root: ${lastCanvas.rootClassName}`);
    }
    if (lastCanvas.messageCount !== 3) {
      throw new Error(`unexpected screenshot message count: ${lastCanvas.messageCount}`);
    }
    if (lastCanvas.selectedArtifactCount !== 0) {
      throw new Error(`selection UI leaked into screenshot clone: ${lastCanvas.selectedArtifactCount}`);
    }
    if (lastCanvas.thoughtsCount !== 0) {
      throw new Error(`thoughts leaked into screenshot clone: ${lastCanvas.thoughtsCount}`);
    }
    if (result.copyProbe.lastClipboardItemCount !== 1) {
      throw new Error(`unexpected clipboard item count: ${result.copyProbe.lastClipboardItemCount}`);
    }
    if (!result.exportingState.copyButtonText.includes('正在截图')) {
      throw new Error(`missing exporting button label: ${result.exportingState.copyButtonText}`);
    }
    if (!result.exportingState.copyButtonDisabled) {
      throw new Error('copy button was not disabled while exporting');
    }
    if (!result.exportingState.notificationTexts.some((text) => text.includes('正在生成长截图'))) {
      throw new Error(`missing exporting notification: ${JSON.stringify(result.exportingState.notificationTexts)}`);
    }

    result.completedNotifications = await waitFor(async () => {
      const texts = await sidebarFrame.evaluate(() => (
        Array.from(document.querySelectorAll('.notification')).map((node) => node.textContent || '')
      ));
      return texts.some((text) => text.includes('截图完成')) ? texts : null;
    }, {
      timeoutMs: 10_000,
      intervalMs: 100,
      label: 'screenshot completed notification'
    });

    await sidebarFrame.locator('body').screenshot({
      path: path.join(outputDir, 'sidebar-selection.png')
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
