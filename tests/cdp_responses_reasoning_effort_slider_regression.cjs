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

const DEFAULT_VISIBLE_EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh'];
const VISIBLE_EFFORTS_WITH_MAX = [...DEFAULT_VISIBLE_EFFORTS, 'max'];
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
    const button = document.querySelector('#reasoning-effort-button');
    const slider = document.querySelector('#reasoning-effort-slider');
    const panel = document.querySelector('.reasoning-effort-slider-panel');
    const value = document.querySelector('#reasoning-effort-value');
    const input = document.querySelector('#message-input');
    const documentButton = document.querySelector('#document-button');
    const currentApi = document.querySelector('.input-api-current-text');
    const dots = Array.from(document.querySelectorAll('.reasoning-effort-dot'));
    const icon = document.querySelector('#reasoning-effort-button .fa-microchip-ai');
    const brainIcon = document.querySelector('#reasoning-effort-button .fa-brain');
    const controlStyle = control ? getComputedStyle(control) : null;
    const buttonStyle = button ? getComputedStyle(button) : null;
    const iconStyle = icon ? getComputedStyle(icon) : null;
    const sliderStyle = slider ? getComputedStyle(slider) : null;
    const panelStyle = panel ? getComputedStyle(panel) : null;
    const siblings = Array.from(document.querySelector('#message-row')?.children || []);
    const rect = (element) => {
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      return {
        x: bounds.x,
        y: bounds.y,
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
        centerX: bounds.left + bounds.width / 2,
        centerY: bounds.top + bounds.height / 2
      };
    };
    const sliderRect = rect(slider);
    const sliderMin = Number(slider?.min || 0);
    const sliderMax = Number(slider?.max || 0);
    const sliderValue = Number(slider?.value || 0);
    const sliderRatio = sliderMax > sliderMin
      ? (sliderValue - sliderMin) / (sliderMax - sliderMin)
      : 0;
    const thumbSize = Number.parseFloat(controlStyle?.getPropertyValue('--reasoning-effort-thumb-size') || '0')
      * Number.parseFloat(controlStyle?.fontSize || '0');
    const thumbCenter = sliderRect ? {
      x: sliderRect.left + thumbSize / 2 + sliderRatio * Math.max(0, sliderRect.width - thumbSize),
      y: sliderRect.centerY
    } : null;

    return {
      hidden: control?.hidden === true,
      display: controlStyle?.display || '',
      isOpen: control?.classList.contains('is-open') === true,
      effort: control?.dataset?.effort || '',
      valueText: value?.textContent?.trim() || '',
      slider: slider ? {
        min: slider.min,
        max: slider.max,
        step: slider.step,
        value: slider.value,
        ariaValueText: slider.getAttribute('aria-valuetext') || '',
        disabled: slider.disabled,
        width: Number.parseFloat(sliderStyle?.width || '0'),
        height: Number.parseFloat(sliderStyle?.height || '0')
      } : null,
      dots: dots.map(dot => ({
        effort: dot.dataset.effort || '',
        active: dot.classList.contains('is-active'),
        current: dot.classList.contains('is-current'),
        isDefault: dot.classList.contains('is-default'),
        width: dot.getBoundingClientRect().width,
        centerX: dot.getBoundingClientRect().left + dot.getBoundingClientRect().width / 2
      })),
      hasMicrochipAiIcon: !!icon,
      hasBrainIcon: !!brainIcon,
      domOrder: {
        input: siblings.indexOf(input),
        control: siblings.indexOf(control),
        documentButton: siblings.indexOf(documentButton)
      },
      pill: currentApi?.textContent?.trim() || '',
      placeholder: input?.getAttribute('placeholder') || '',
      focusedElementId: document.activeElement?.id || '',
      geometry: {
        control: rect(control),
        button: rect(button),
        panel: rect(panel),
        slider: sliderRect,
        value: rect(value),
        thumbCenter
      },
      sizes: {
        controlFont: Number.parseFloat(controlStyle?.fontSize || '0'),
        buttonFont: Number.parseFloat(buttonStyle?.fontSize || '0'),
        iconFont: Number.parseFloat(iconStyle?.fontSize || '0')
      },
      panel: {
        width: Number.parseFloat(panelStyle?.width || '0'),
        opacity: Number.parseFloat(panelStyle?.opacity || '0'),
        visibility: panelStyle?.visibility || '',
        transitionDuration: panelStyle?.transitionDuration || '',
        clipPath: panelStyle?.clipPath || ''
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
    const clipPaths = [];
    for (let index = 0; index < 10; index += 1) {
      clipPaths.push(getComputedStyle(panel).clipPath || '');
      await new Promise(resolve => setTimeout(resolve, 28));
    }
    return { animations, clipPaths };
  });

  const expanded = await readReasoningUi(sidebarFrame);
  return { collapsed, motion, expanded };
}

async function setFontSizeFromSettings(sidebarFrame, fontSize) {
  await sidebarFrame.locator('#font-size').evaluate((input, nextFontSize) => {
    input.value = String(nextFontSize);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, fontSize);
}

async function setEffortOptionChecked(sidebarFrame, effort, checked) {
  const settingControl = sidebarFrame.locator('#responses-reasoning-effort-slider-options');
  if (await settingControl.count() <= 0) {
    // 偏好设置采用懒渲染：真实打开一次“偏好设置”标签，
    // 再操作其多选控件，确保测到的是用户实际使用的设置链路。
    await sidebarFrame.locator('#preferences-settings-toggle').evaluate((toggle) => toggle.click());
    await settingControl.waitFor({ state: 'attached', timeout: 15_000 });
  }
  await settingControl.evaluate((control, payload) => {
    const checkbox = Array.from(control.querySelectorAll('input[type="checkbox"]'))
      .find(input => input.value === payload.effort);
    if (!checkbox) throw new Error(`Missing reasoning effort option: ${payload.effort}`);
    checkbox.checked = payload.checked;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  }, { effort, checked });
  await sidebarFrame.locator('#preferences-settings-toggle').evaluate((toggle) => {
    const panel = document.querySelector('#chat-history-panel');
    if (panel && (panel.classList.contains('visible') || getComputedStyle(panel).display !== 'none')) {
      toggle.click();
    }
  });
}

async function dragFromCurrentThumbToEnd(sidebarFrame, page) {
  const controlBox = await sidebarFrame.locator('#reasoning-effort-control').boundingBox();
  if (!controlBox) throw new Error('Reasoning effort control has no bounding box');
  const startX = controlBox.x + controlBox.width / 2;
  const startY = controlBox.y + controlBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.waitForTimeout(320);
  const sliderBox = await sidebarFrame.locator('#reasoning-effort-slider').boundingBox();
  if (!sliderBox) throw new Error('Reasoning effort slider has no bounding box after hover');
  await page.mouse.down();
  await page.mouse.move(sliderBox.x + sliderBox.width - 2, sliderBox.y + sliderBox.height / 2, { steps: 12 });
  await page.mouse.up();
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
    defaultVisibleEfforts: DEFAULT_VISIBLE_EFFORTS,
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
    assertState(result.initial.hasMicrochipAiIcon, '缺少 Font Awesome 空心 microchip-ai 图标', result.initial);
    assertState(!result.initial.hasBrainIcon, '仍残留大脑图标', result.initial);
    assertState(
      result.initial.domOrder.input < result.initial.domOrder.control
      && result.initial.domOrder.control < result.initial.domOrder.documentButton,
      '选择器未位于输入框与文件按钮之间',
      result.initial.domOrder
    );
    assertState(
      result.initial.slider?.min === '0'
      && result.initial.slider?.max === '4'
      && result.initial.slider?.step === '1',
      '滑块离散范围不正确',
      result.initial.slider
    );
    assertState(
      JSON.stringify(result.initial.dots.map(dot => dot.effort)) === JSON.stringify(DEFAULT_VISIBLE_EFFORTS),
      '默认可见吸附点不是 default + low/medium/high/xhigh',
      result.initial.dots
    );
    assertState(result.initial.dots[0]?.isDefault === true, 'default 吸附点未独立标记', result.initial.dots);
    assertState(result.initial.pill === 'gpt-5.6-medium', '初始模型标签缺少 -medium', result.initial);
    assertState(result.initial.placeholder.includes('gpt-5.6-medium'), 'placeholder 缺少 -medium', result.initial);
    await sidebarFrame.locator('#message-row').screenshot({ path: path.join(outputDir, 'collapsed.png') });

    logProgress('验证 hover 锚定、上方浮签与 clip-path 展开动画');
    result.hover = await collectHoverMotion(sidebarFrame, page);
    const distinctClipPaths = new Set(result.hover.motion.clipPaths);
    assertState(result.hover.collapsed.panel.width >= 220, '折叠时未保留最终 em 几何', result.hover.collapsed.panel);
    assertState(result.hover.collapsed.panel.opacity <= 0.01, '折叠透明度不为 0', result.hover.collapsed.panel);
    assertState(result.hover.expanded.isOpen, 'hover 后控件未进入 is-open', result.hover.expanded);
    assertState(result.hover.expanded.panel.width >= 220, 'hover 后面板未完整展开', result.hover.expanded.panel);
    assertState(result.hover.expanded.panel.opacity >= 0.99, 'hover 后面板未显示', result.hover.expanded.panel);
    assertState(distinctClipPaths.size >= 3, 'hover 展开没有可观测的 clip-path 过渡', result.hover.motion);
    assertState(
      Math.abs(result.hover.expanded.geometry.thumbCenter.x - result.hover.expanded.geometry.button.centerX) <= 1.5
      && Math.abs(result.hover.expanded.geometry.thumbCenter.y - result.hover.expanded.geometry.button.centerY) <= 1.5,
      '展开后当前 thumb 没有准确落在鼠标/图标位置',
      result.hover.expanded.geometry
    );
    assertState(
      Math.abs(result.hover.expanded.geometry.value.centerX - result.hover.expanded.geometry.thumbCenter.x) <= 1.5
      && result.hover.expanded.geometry.value.bottom < result.hover.expanded.geometry.thumbCenter.y,
      '档位浮签未对齐 thumb 或未位于鼠标上方',
      result.hover.expanded.geometry
    );
    result.steps.push('hover_animation_verified');

    logProgress('验证 slider、吸附点和计算图标跟随界面字体缩放');
    await page.mouse.move(12, 12);
    await setFontSizeFromSettings(sidebarFrame, 24);
    result.largeFont = await waitFor(async () => {
      const state = await readReasoningUi(sidebarFrame);
      return state.sizes.controlFont >= 23.5 ? state : null;
    }, { timeoutMs: 10_000, intervalMs: 100, label: 'reasoning slider font scaled to 24px' });
    const expectedScale = 24 / 14;
    assertState(
      Math.abs((result.largeFont.slider.width / result.initial.slider.width) - expectedScale) <= 0.08,
      'slider 宽度未按字体比例缩放',
      { initial: result.initial.slider, large: result.largeFont.slider }
    );
    assertState(
      Math.abs((result.largeFont.dots[0].width / result.initial.dots[0].width) - expectedScale) <= 0.12,
      '吸附点未按字体比例缩放',
      { initial: result.initial.dots[0], large: result.largeFont.dots[0] }
    );
    assertState(result.largeFont.sizes.iconFont >= 27, '计算图标未跟随字体放大', result.largeFont.sizes);
    await setFontSizeFromSettings(sidebarFrame, 14);
    await waitFor(async () => (await readReasoningUi(sidebarFrame)).sizes.controlFont <= 14.5, {
      timeoutMs: 10_000,
      intervalMs: 100,
      label: 'reasoning slider font restored to 14px'
    });
    result.steps.push('font_scaling_verified');

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

    logProgress('在设置中加入 max，验证可见档位无需重载即时更新');
    await setEffortOptionChecked(sidebarFrame, 'max', true);
    result.withMaxOptions = await waitFor(async () => {
      const state = await readReasoningUi(sidebarFrame);
      return JSON.stringify(state.dots.map(dot => dot.effort)) === JSON.stringify(VISIBLE_EFFORTS_WITH_MAX)
        ? state
        : null;
    }, { timeoutMs: 10_000, intervalMs: 100, label: 'max added to visible reasoning efforts' });
    assertState(result.withMaxOptions.slider?.max === '5', '加入 max 后 range 上限未更新', result.withMaxOptions.slider);
    result.steps.push('visible_options_updated');

    logProgress('从当前图标/thumb 位置直接按下拖到 max');
    await dragFromCurrentThumbToEnd(sidebarFrame, page);
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

    assertState(result.maxState.focusedElementId === 'reasoning-effort-slider', '真实拖动后 range 未保留焦点', result.maxState);
    await sidebarFrame.locator('#reasoning-effort-control').hover({ force: true });
    await sidebarFrame.locator('#message-row').screenshot({ path: path.join(outputDir, 'expanded-max.png') });
    await sidebarFrame.locator('body').screenshot({ path: path.join(outputDir, 'expanded-max-body.png') });

    logProgress('验证 range 仍有焦点时鼠标离开会立即关闭');
    // 在 sidebar iframe 内移到输入框左侧，确保浏览器向控件派发真实 pointerleave；
    // 直接跨出 iframe 的顶层坐标移动在 Chrome 中不保证传递子文档 pointerleave。
    await sidebarFrame.locator('#message-input').hover({ position: { x: 18, y: 12 }, force: true });
    result.closedAfterLeave = await waitFor(async () => {
      const state = await readReasoningUi(sidebarFrame);
      return !state.isOpen && state.panel.opacity <= 0.01 ? state : null;
    }, { timeoutMs: 5_000, intervalMs: 50, label: 'reasoning slider closed on pointerleave' });
    assertState(
      result.closedAfterLeave.focusedElementId !== 'reasoning-effort-slider',
      '离开后 range 焦点未释放',
      result.closedAfterLeave
    );
    result.steps.push('pointerleave_close_verified');

    logProgress('重载 sidebar 验证持久化恢复');
    await sidebarFrame.evaluate(() => window.location.reload());
    sidebarFrame = await waitForSidebarFrame(page, extensionId, { timeoutMs: 30_000 });
    await sidebarFrame.locator('#message-input').waitFor({ state: 'visible', timeout: 30_000 });
    result.reloaded = await waitFor(async () => {
      const state = await readReasoningUi(sidebarFrame);
      return state.effort === 'max'
        && state.pill === 'gpt-5.6-max'
        && state.placeholder.includes('gpt-5.6-max')
        && JSON.stringify(state.dots.map(dot => dot.effort)) === JSON.stringify(VISIBLE_EFFORTS_WITH_MAX)
        ? state
        : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: 'reloaded max effort state' });
    result.steps.push('reload_persistence_verified');

    logProgress('当前 max 被从可见设置取消后仍临时保留，不误标 default');
    await setEffortOptionChecked(sidebarFrame, 'max', false);
    result.hiddenCurrentPreserved = await waitFor(async () => {
      const state = await readReasoningUi(sidebarFrame);
      return state.effort === 'max' && state.dots.at(-1)?.effort === 'max' ? state : null;
    }, { timeoutMs: 10_000, intervalMs: 100, label: 'hidden current max preserved in slider' });
    assertState(result.hiddenCurrentPreserved.pill === 'gpt-5.6-max', '隐藏当前档位后模型标签失真', result.hiddenCurrentPreserved);
    result.steps.push('hidden_current_effort_preserved');

    logProgress('从已隐藏的 max 拖走时保持轨道稳定，离开后再收拢可见档位');
    await sidebarFrame.locator('#reasoning-effort-control').hover({ force: true });
    const hiddenTrackWidth = (await readReasoningUi(sidebarFrame)).slider.width;
    await setEffortIndex(sidebarFrame, 4);
    result.hiddenTrackDuringChange = await waitFor(async () => {
      const state = await readReasoningUi(sidebarFrame);
      return state.effort === 'xhigh' && state.dots.at(-1)?.effort === 'max' ? state : null;
    }, { timeoutMs: 10_000, intervalMs: 100, label: 'hidden max retained while slider open' });
    assertState(
      Math.abs(result.hiddenTrackDuringChange.slider.width - hiddenTrackWidth) <= 1,
      '拖离已隐藏当前档时轨道长度发生跳变',
      result.hiddenTrackDuringChange.slider
    );
    await sidebarFrame.locator('#message-input').hover({ position: { x: 18, y: 12 }, force: true });
    result.hiddenTrackAfterLeave = await waitFor(async () => {
      const state = await readReasoningUi(sidebarFrame);
      return !state.isOpen
        && JSON.stringify(state.dots.map(dot => dot.effort)) === JSON.stringify(DEFAULT_VISIBLE_EFFORTS)
        ? state
        : null;
    }, { timeoutMs: 10_000, intervalMs: 100, label: 'hidden max removed after pointerleave' });
    result.steps.push('hidden_effort_track_stability_verified');

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
