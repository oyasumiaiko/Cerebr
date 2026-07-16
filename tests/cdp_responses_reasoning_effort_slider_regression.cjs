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

const EFFORTS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const RESPONSES_CONFIG_ID = 'responses_reasoning_effort_regression';
const CHAT_CONFIG_ID = 'chat_reasoning_effort_regression';
const [repoRootArg = '.', outputDirArg = 'output/playwright/responses-reasoning-effort-slider'] = process.argv.slice(2);
const repoRoot = path.resolve(repoRootArg);
const outputDir = path.resolve(outputDirArg);
const chromePath = resolveStableChromeExecutablePath();
const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);
const startedAtMs = Date.now();

function logProgress(step, details = '') {
  const elapsedSeconds = ((Date.now() - startedAtMs) / 1000).toFixed(1);
  console.log(`[reasoning-effort-slider][${elapsedSeconds}s] ${step}${details ? ` ${details}` : ''}`);
}

function buildStorageSeed() {
  return {
    apiConfigs: [
      {
        id: RESPONSES_CONFIG_ID,
        displayName: '',
        modelName: 'gpt-5.6',
        connectionType: 'openai_responses',
        baseUrl: 'https://api.openai.com/v1/responses',
        apiKey: 'test-responses-key',
        apiKeyFilePath: '',
        temperature: 1,
        useStreaming: true,
        isFavorite: true,
        customParams: '',
        responsesApiSettings: { reasoning: { effort: 'medium' } }
      },
      {
        id: CHAT_CONFIG_ID,
        displayName: '',
        modelName: 'chat-model',
        connectionType: 'openai',
        baseUrl: 'https://example.com/v1/chat/completions',
        apiKey: 'test-chat-key',
        apiKeyFilePath: '',
        temperature: 1,
        useStreaming: true,
        isFavorite: true,
        customParams: ''
      }
    ],
    selectedConfigIndex: 0
  };
}

async function readReasoningUi(sidebarFrame) {
  return sidebarFrame.evaluate(() => {
    const control = document.querySelector('#reasoning-effort-control');
    const slider = document.querySelector('#reasoning-effort-slider');
    const panel = document.querySelector('.reasoning-effort-slider-panel');
    const input = document.querySelector('#message-input');
    const documentButton = document.querySelector('#document-button');
    const currentApi = document.querySelector('.input-api-current-text');
    const dots = Array.from(document.querySelectorAll('.reasoning-effort-dot'));
    const icon = document.querySelector('#reasoning-effort-button .fa-brain');
    const controlStyle = control ? getComputedStyle(control) : null;
    const panelStyle = panel ? getComputedStyle(panel) : null;
    const siblings = Array.from(document.querySelector('#message-row')?.children || []);

    return {
      hidden: control?.hidden === true,
      display: controlStyle?.display || '',
      effort: control?.dataset?.effort || '',
      valueText: document.querySelector('#reasoning-effort-value')?.textContent?.trim() || '',
      slider: slider ? {
        min: slider.min,
        max: slider.max,
        step: slider.step,
        value: slider.value,
        ariaValueText: slider.getAttribute('aria-valuetext') || ''
      } : null,
      dots: dots.map(dot => ({
        effort: dot.dataset.effort || '',
        active: dot.classList.contains('is-active'),
        current: dot.classList.contains('is-current')
      })),
      hasBrainIcon: !!icon,
      domOrder: {
        input: siblings.indexOf(input),
        control: siblings.indexOf(control),
        documentButton: siblings.indexOf(documentButton)
      },
      pill: currentApi?.textContent?.trim() || '',
      placeholder: input?.getAttribute('placeholder') || '',
      panel: {
        width: Number.parseFloat(panelStyle?.width || '0'),
        opacity: Number.parseFloat(panelStyle?.opacity || '0'),
        visibility: panelStyle?.visibility || '',
        transitionDuration: panelStyle?.transitionDuration || ''
      }
    };
  });
}

async function waitForModel(sidebarFrame, expectedModel) {
  return waitFor(async () => {
    const state = await sidebarFrame.evaluate(() => ({
      pill: document.querySelector('.input-api-current-text')?.textContent?.trim() || '',
      placeholder: document.querySelector('#message-input')?.getAttribute('placeholder') || ''
    })).catch(() => null);
    return state?.pill.includes(expectedModel) && state.placeholder.includes(expectedModel) ? state : null;
  }, { timeoutMs: 20_000, intervalMs: 200, label: `selected model ${expectedModel}` });
}

async function cycleFavoriteApi(sidebarFrame, key, expectedModel) {
  const input = sidebarFrame.locator('#message-input');
  await input.focus();
  await input.press(`Control+${key}`);
  return waitForModel(sidebarFrame, expectedModel);
}

async function collectHoverMotion(sidebarFrame, page) {
  await page.mouse.move(12, 12);
  await page.waitForTimeout(280);
  const collapsed = await readReasoningUi(sidebarFrame);
  await sidebarFrame.locator('#reasoning-effort-control').hover({ force: true });

  const motion = await sidebarFrame.locator('.reasoning-effort-slider-panel').evaluate(async (panel) => {
    const animations = panel.getAnimations().map(animation => {
      const timing = animation.effect?.getComputedTiming?.() || {};
      return {
        duration: Number(timing.duration) || 0,
        currentTime: Number(animation.currentTime) || 0,
        playState: animation.playState || ''
      };
    });
    const widths = [];
    for (let index = 0; index < 10; index += 1) {
      widths.push(Number.parseFloat(getComputedStyle(panel).width || '0'));
      await new Promise(resolve => setTimeout(resolve, 28));
    }
    return { animations, widths };
  });

  const expanded = await readReasoningUi(sidebarFrame);
  return { collapsed, motion, expanded };
}

async function setEffortIndex(sidebarFrame, index) {
  await sidebarFrame.locator('#reasoning-effort-slider').evaluate((slider, nextIndex) => {
    slider.value = String(nextIndex);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  }, index);
}

async function readPersistedEffort(extensionWorker, configId) {
  return extensionWorker.evaluate(`(async () => {
    const configId = ${JSON.stringify(configId)};
    const localWrap = await chrome.storage.local.get(['apiConfigs_backup_v1']);
    const localItems = localWrap.apiConfigs_backup_v1?.items || [];
    const localConfig = localItems.find(item => item?.id === configId) || null;

    const metaWrap = await chrome.storage.sync.get(['apiConfigs_chunks_meta']);
    const count = Number(metaWrap.apiConfigs_chunks_meta?.count || 0);
    const keys = Array.from({ length: count }, (_, index) => 'apiConfigs_chunk_' + index);
    const chunks = count > 0 ? await chrome.storage.sync.get(keys) : {};
    const serialized = keys.map(key => chunks[key] || '').join('');
    let syncConfig = null;
    if (serialized) {
      const parsed = JSON.parse(serialized);
      syncConfig = (parsed.items || []).find(item => item?.id === configId) || null;
    }

    return {
      localEffort: localConfig?.responsesApiSettings?.reasoning?.effort || '',
      syncEffort: syncConfig?.responsesApiSettings?.reasoning?.effort || '',
      syncChunkCount: count
    };
  })()`);
}

function assertState(condition, message, details = null) {
  if (condition) return;
  const suffix = details == null ? '' : `: ${JSON.stringify(details)}`;
  throw new Error(`${message}${suffix}`);
}

async function main() {
  await fsp.mkdir(outputDir, { recursive: true });
  const result = {
    startedAt: new Date(startedAtMs).toISOString(),
    repoRoot,
    outputDir,
    chromePath,
    headless: runHeadless,
    efforts: EFFORTS,
    steps: [],
    console: []
  };

  const profileDir = resolveFixedSidebarProfileDir(repoRoot);
  await fsp.mkdir(profileDir, { recursive: true });
  result.profileDir = profileDir;

  let context = null;
  try {
    logProgress('启动固定 Stable Chrome profile');
    context = await launchFixedSidebarContext({
      chromium,
      profileDir,
      executablePath: chromePath,
      headless: runHeadless
    });
    result.steps.push('browser_ready');

    logProgress('重新加载当前 checkout 的 unpacked 扩展');
    const extensionWorker = await reloadUnpackedExtension(context, {
      timeoutMs: 30_000,
      unpackedPath: repoRoot
    });
    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;
    result.steps.push('extension_reloaded');

    await extensionWorker.evaluate(`(async () => {
      await chrome.storage.sync.clear();
      await chrome.storage.local.clear();
      await chrome.storage.sync.set(${JSON.stringify(buildStorageSeed())});
      return true;
    })()`);
    result.steps.push('storage_seeded');

    const page = context.pages().find(entry => entry.url().startsWith('https://example.com/'))
      || await context.newPage();
    page.on('console', message => result.console.push({ type: message.type(), text: message.text() }));
    page.on('pageerror', error => result.console.push({
      type: 'pageerror',
      text: String(error?.stack || error?.message || error)
    }));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    result.steps.push('host_page_loaded');

    await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      return payload?.response?.debugState?.initialized ? payload : null;
    }, { timeoutMs: 15_000, intervalMs: 250, label: 'sidebar initialized' });

    const openResponse = await extensionWorker.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'OPEN_SIDEBAR' }))
    );
    if (openResponse?.response?.success !== true && openResponse?.response?.status !== true) {
      throw new Error(`OPEN_SIDEBAR failed: ${JSON.stringify(openResponse)}`);
    }

    let sidebarFrame = await waitForSidebarFrame(page, extensionId, { timeoutMs: 30_000 });
    await sidebarFrame.locator('#message-input').waitFor({ state: 'visible', timeout: 30_000 });
    await waitFor(async () => (
      await sidebarFrame.evaluate(() => (
        Array.isArray(window.apiConfigs)
        && window.apiConfigs.some(config => config?.modelName === 'gpt-5.6')
      )).catch(() => false)
    ), { timeoutMs: 20_000, intervalMs: 250, label: 'Responses config loaded' });
    await waitForModel(sidebarFrame, 'gpt-5.6');
    result.steps.push('sidebar_ready');

    result.initial = await readReasoningUi(sidebarFrame);
    assertState(!result.initial.hidden && result.initial.display !== 'none', 'Responses 配置下选择器未显示', result.initial);
    assertState(result.initial.hasBrainIcon, '缺少 Font Awesome 大脑图标', result.initial);
    assertState(
      result.initial.domOrder.input < result.initial.domOrder.control
      && result.initial.domOrder.control < result.initial.domOrder.documentButton,
      '选择器未位于输入框与文件按钮之间',
      result.initial.domOrder
    );
    assertState(
      result.initial.slider?.min === '0'
      && result.initial.slider?.max === '7'
      && result.initial.slider?.step === '1',
      '滑块离散范围不正确',
      result.initial.slider
    );
    assertState(
      JSON.stringify(result.initial.dots.map(dot => dot.effort)) === JSON.stringify(EFFORTS),
      '吸附点顺序不正确',
      result.initial.dots
    );
    assertState(result.initial.pill === 'gpt-5.6-medium', '初始模型标签缺少 -medium', result.initial);
    assertState(result.initial.placeholder.includes('gpt-5.6-medium'), 'placeholder 缺少 -medium', result.initial);
    await sidebarFrame.locator('#message-row').screenshot({ path: path.join(outputDir, 'collapsed.png') });

    logProgress('验证 hover 展开动画');
    result.hover = await collectHoverMotion(sidebarFrame, page);
    const distinctWidths = new Set(result.hover.motion.widths.map(width => width.toFixed(1)));
    // Chrome 在 width:0 与 1px 边框组合下可能保留约 1.33px 的亚像素计算值；
    // opacity/visibility 才是交互层面的折叠边界，因此宽度允许 2px 渲染容差。
    assertState(result.hover.collapsed.panel.width <= 2, '折叠宽度超出亚像素容差', result.hover.collapsed.panel);
    assertState(result.hover.collapsed.panel.opacity <= 0.01, '折叠透明度不为 0', result.hover.collapsed.panel);
    assertState(result.hover.expanded.panel.width >= 170, 'hover 后面板未完整展开', result.hover.expanded.panel);
    assertState(result.hover.expanded.panel.opacity >= 0.99, 'hover 后面板未显示', result.hover.expanded.panel);
    assertState(distinctWidths.size >= 3, 'hover 展开没有可观测的连续宽度变化', result.hover.motion);
    result.steps.push('hover_animation_verified');

    logProgress('验证非 Responses 配置自动隐藏');
    await cycleFavoriteApi(sidebarFrame, 'ArrowDown', 'chat-model');
    result.chatState = await readReasoningUi(sidebarFrame);
    assertState(result.chatState.hidden || result.chatState.display === 'none', 'Chat Completions 下选择器仍可见', result.chatState);
    await cycleFavoriteApi(sidebarFrame, 'ArrowUp', 'gpt-5.6');
    result.steps.push('responses_only_visibility_verified');

    logProgress('验证 default 会清除显式 effort');
    await setEffortIndex(sidebarFrame, 0);
    result.defaultState = await waitFor(async () => {
      const state = await readReasoningUi(sidebarFrame);
      return state.effort === 'default'
        && state.pill === 'gpt-5.6-default'
        && state.placeholder.includes('gpt-5.6-default')
        ? state
        : null;
    }, { timeoutMs: 10_000, intervalMs: 100, label: 'default effort UI state' });
    result.defaultPersistence = await waitFor(async () => {
      const persisted = await readPersistedEffort(extensionWorker, RESPONSES_CONFIG_ID);
      return persisted.localEffort === '' && persisted.syncEffort === '' ? persisted : null;
    }, { timeoutMs: 25_000, intervalMs: 350, label: 'default effort cleared from local and sync' });
    result.steps.push('default_cleared');

    logProgress('快速切换 xhigh → max 并验证 latest-wins 持久化');
    await setEffortIndex(sidebarFrame, 6);
    await setEffortIndex(sidebarFrame, 7);
    result.maxState = await waitFor(async () => {
      const state = await readReasoningUi(sidebarFrame);
      return state.effort === 'max'
        && state.pill === 'gpt-5.6-max'
        && state.placeholder.includes('gpt-5.6-max')
        ? state
        : null;
    }, { timeoutMs: 10_000, intervalMs: 100, label: 'max effort UI state' });
    assertState(result.maxState.slider?.ariaValueText === 'max', 'slider aria-valuetext 未更新为 max', result.maxState.slider);
    assertState(result.maxState.dots.at(-1)?.current === true, 'max 吸附点未成为当前点', result.maxState.dots);

    result.persistence = await waitFor(async () => {
      const persisted = await readPersistedEffort(extensionWorker, RESPONSES_CONFIG_ID);
      return persisted.localEffort === 'max' && persisted.syncEffort === 'max' ? persisted : null;
    }, { timeoutMs: 25_000, intervalMs: 350, label: 'max effort persisted to local and sync' });
    result.steps.push('max_persisted');

    await sidebarFrame.locator('#reasoning-effort-control').hover({ force: true });
    await sidebarFrame.locator('#message-row').screenshot({ path: path.join(outputDir, 'expanded-max.png') });

    logProgress('重载 sidebar 验证持久化恢复');
    await sidebarFrame.evaluate(() => window.location.reload());
    sidebarFrame = await waitForSidebarFrame(page, extensionId, { timeoutMs: 30_000 });
    await sidebarFrame.locator('#message-input').waitFor({ state: 'visible', timeout: 30_000 });
    result.reloaded = await waitFor(async () => {
      const state = await readReasoningUi(sidebarFrame);
      return state.effort === 'max'
        && state.pill === 'gpt-5.6-max'
        && state.placeholder.includes('gpt-5.6-max')
        ? state
        : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: 'reloaded max effort state' });
    result.steps.push('reload_persistence_verified');

    result.success = true;
    result.finishedAt = new Date().toISOString();
    result.elapsedMs = Date.now() - startedAtMs;
    await fsp.writeFile(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    logProgress('回归通过', `elapsedMs=${result.elapsedMs}`);
  } catch (error) {
    result.success = false;
    result.error = String(error?.stack || error?.message || error);
    result.finishedAt = new Date().toISOString();
    result.elapsedMs = Date.now() - startedAtMs;
    await fsp.writeFile(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    logProgress('回归失败', error?.message || String(error));
    throw error;
  } finally {
    await context?.close().catch(() => null);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
