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
const {
  launchWorktreeUnpackedChromiumContext,
  resolveWorktreeUnpackedProfileDir,
  waitForWorktreeExtensionWorker
} = require('./lib/worktree_unpacked_extension_harness.cjs');

const DEFAULT_VISIBLE_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const VISIBLE_EFFORTS_WITH_DEFAULT = ['default', ...DEFAULT_VISIBLE_EFFORTS];
const VISIBLE_EFFORTS_WITH_MAX = [...DEFAULT_VISIBLE_EFFORTS, 'max'];
const CONFIGURED_EFFORTS = [...DEFAULT_VISIBLE_EFFORTS];
const CONFIGURED_EFFORTS_WITH_DEFAULT = [...VISIBLE_EFFORTS_WITH_DEFAULT];
const CONFIGURED_EFFORTS_WITH_MAX = [...VISIBLE_EFFORTS_WITH_MAX];
const RESPONSES_CONFIG_ID = 'responses_reasoning_effort_regression';
const CHAT_CONFIG_ID = 'chat_reasoning_effort_regression';
const [
  repoRootArg = '.',
  outputDirArg = 'output/playwright/responses-reasoning-effort-slider',
  launchModeArg = 'stable'
] = process.argv.slice(2);
const repoRoot = path.resolve(repoRootArg);
const outputDir = path.resolve(outputDirArg);
const launchMode = launchModeArg === 'worktree_unpacked' ? 'worktree_unpacked' : 'stable';
const chromePath = resolveStableChromeExecutablePath();
const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);
const startedAtMs = Date.now();

function logProgress(step, details = '') {
  const elapsedSeconds = ((Date.now() - startedAtMs) / 1000).toFixed(1);
  console.log(`[reasoning-effort-menu][${elapsedSeconds}s] ${step}${details ? ` ${details}` : ''}`);
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
    selectedConfigIndex: 0,
    theme: 'dark',
    responsesReasoningEffortSliderOptions: CONFIGURED_EFFORTS
  };
}

async function readReasoningUi(sidebarFrame) {
  return sidebarFrame.evaluate(() => {
    const control = document.querySelector('#reasoning-effort-control');
    const button = document.querySelector('#reasoning-effort-button');
    const menu = document.querySelector('#reasoning-effort-menu');
    const input = document.querySelector('#message-input');
    const documentButton = document.querySelector('#document-button');
    const icon = button?.querySelector('.fa-signal-bars') || null;
    const documentIcon = documentButton?.querySelector('i') || null;
    const settingsMenu = document.querySelector('#settings-menu');
    const settingsItem = document.querySelector('#preferences-settings-toggle');
    const currentApi = document.querySelector('.input-api-current-text');
    const options = Array.from(document.querySelectorAll('.reasoning-effort-option'));
    const siblings = Array.from(document.querySelector('#message-row')?.children || []);

    const rect = (element) => {
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      return {
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

    const readSurfaceStyle = (element) => {
      if (!element) return null;
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      const originParts = style.transformOrigin.split(/\s+/).map(value => Number.parseFloat(value));
      return {
        backgroundColor: style.backgroundColor,
        borderTopColor: style.borderTopColor,
        borderTopStyle: style.borderTopStyle,
        borderTopWidth: style.borderTopWidth,
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow,
        paddingTop: style.paddingTop,
        paddingRight: style.paddingRight,
        paddingBottom: style.paddingBottom,
        paddingLeft: style.paddingLeft,
        backdropFilter: style.backdropFilter || style.webkitBackdropFilter || '',
        transitionDuration: style.transitionDuration,
        originIsBottomRight: originParts.length >= 2
          && Math.abs(originParts[0] - bounds.width) <= 1
          && Math.abs(originParts[1] - bounds.height) <= 1
      };
    };

    const readItemStyle = (element) => {
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        paddingTop: style.paddingTop,
        paddingRight: style.paddingRight,
        paddingBottom: style.paddingBottom,
        paddingLeft: style.paddingLeft,
        borderRadius: style.borderRadius,
        marginTop: style.marginTop,
        marginBottom: style.marginBottom,
        fontSize: style.fontSize,
        color: style.color,
        alignItems: style.alignItems,
        justifyContent: style.justifyContent
      };
    };

    const controlStyle = control ? getComputedStyle(control) : null;
    const buttonStyle = button ? getComputedStyle(button) : null;
    const menuStyle = menu ? getComputedStyle(menu) : null;
    const iconStyle = icon ? getComputedStyle(icon) : null;
    const documentIconStyle = documentIcon ? getComputedStyle(documentIcon) : null;

    return {
      hidden: control?.hidden === true,
      display: controlStyle?.display || '',
      isOpen: control?.classList.contains('is-open') === true,
      effort: control?.dataset?.effort || '',
      button: {
        ariaLabel: button?.getAttribute('aria-label') || '',
        ariaExpanded: button?.getAttribute('aria-expanded') || '',
        ariaHaspopup: button?.getAttribute('aria-haspopup') || ''
      },
      menu: {
        exists: !!menu,
        opacity: Number.parseFloat(menuStyle?.opacity || '0'),
        visibility: menuStyle?.visibility || '',
        pointerEvents: menuStyle?.pointerEvents || '',
        transform: menuStyle?.transform || '',
        transitionDuration: menuStyle?.transitionDuration || ''
      },
      options: options.map(option => ({
        effort: option.dataset.effort || '',
        selected: option.classList.contains('is-selected'),
        ariaChecked: option.getAttribute('aria-checked') || '',
        role: option.getAttribute('role') || '',
        tabIndex: option.tabIndex,
        text: option.textContent?.trim() || ''
      })),
      hasSignalBarsIcon: !!icon,
      hasRegularSignalBarsIcon: !!button?.querySelector('.far.fa-signal-bars'),
      hasGaugeIcon: !!button?.querySelector('.fa-gauge-simple'),
      hasBrainIcon: !!button?.querySelector('.fa-brain'),
      hasChipIcon: !!button?.querySelector('.fa-microchip-ai'),
      hasLegacySlider: !!document.querySelector('#reasoning-effort-slider'),
      domOrder: {
        input: siblings.indexOf(input),
        control: siblings.indexOf(control),
        documentButton: siblings.indexOf(documentButton)
      },
      pill: currentApi?.textContent?.trim() || '',
      placeholder: input?.getAttribute('placeholder') || '',
      focus: {
        id: document.activeElement?.id || '',
        effort: document.activeElement?.dataset?.effort || ''
      },
      geometry: {
        control: rect(control),
        button: rect(button),
        menu: rect(menu)
      },
      sizes: {
        buttonFont: Number.parseFloat(buttonStyle?.fontSize || '0'),
        iconFont: Number.parseFloat(iconStyle?.fontSize || '0'),
        documentIconFont: Number.parseFloat(documentIconStyle?.fontSize || '0')
      },
      styles: {
        reasoningSurface: readSurfaceStyle(menu),
        settingsSurface: readSurfaceStyle(settingsMenu),
        reasoningItem: readItemStyle(options[0]),
        settingsItem: readItemStyle(settingsItem)
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

async function collectHoverMotion(sidebarFrame) {
  await sidebarFrame.locator('#message-input').hover({ position: { x: 18, y: 12 }, force: true });
  await sidebarFrame.page().waitForTimeout(260);
  const collapsed = await readReasoningUi(sidebarFrame);
  await sidebarFrame.locator('#reasoning-effort-button').hover({ force: true });

  const motion = await sidebarFrame.locator('#reasoning-effort-menu').evaluate(async (menu) => {
    const animations = menu.getAnimations().map(animation => {
      const timing = animation.effect?.getComputedTiming?.() || {};
      return {
        duration: Number(timing.duration) || 0,
        currentTime: Number(animation.currentTime) || 0,
        playState: animation.playState || ''
      };
    });
    const samples = [];
    for (let index = 0; index < 10; index += 1) {
      const style = getComputedStyle(menu);
      samples.push({
        opacity: Number.parseFloat(style.opacity || '0'),
        transform: style.transform || ''
      });
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return { animations, samples };
  });

  const expanded = await waitFor(async () => {
    const state = await readReasoningUi(sidebarFrame);
    return state.isOpen && state.menu.opacity >= 0.99 ? state : null;
  }, { timeoutMs: 5_000, intervalMs: 50, label: 'reasoning effort menu expanded' });

  await sidebarFrame.locator('.reasoning-effort-option[data-effort="xhigh"]').hover({ force: true });
  const heldOverOption = await readReasoningUi(sidebarFrame);
  await sidebarFrame.locator('#message-input').hover({ position: { x: 18, y: 12 }, force: true });
  const closedAfterLeave = await waitFor(async () => {
    const state = await readReasoningUi(sidebarFrame);
    return !state.isOpen && state.menu.opacity <= 0.01 && state.menu.visibility === 'hidden' ? state : null;
  }, { timeoutMs: 5_000, intervalMs: 50, label: 'reasoning effort menu closed after mouseleave' });

  return { collapsed, motion, expanded, heldOverOption, closedAfterLeave };
}

async function verifyKeyboardNavigation(sidebarFrame) {
  const input = sidebarFrame.locator('#message-input');
  const button = sidebarFrame.locator('#reasoning-effort-button');
  await input.hover({ position: { x: 18, y: 12 }, force: true });
  await button.focus();
  await button.press('Enter');
  const openedWithEnter = await waitFor(async () => {
    const state = await readReasoningUi(sidebarFrame);
    return state.isOpen && state.focus.effort === 'medium' ? state : null;
  }, { timeoutMs: 5_000, intervalMs: 50, label: 'reasoning menu keyboard Enter open' });

  await sidebarFrame.locator('.reasoning-effort-option:focus').press('Escape');
  const closedWithEscape = await waitFor(async () => {
    const state = await readReasoningUi(sidebarFrame);
    return !state.isOpen && state.focus.id === 'reasoning-effort-button' ? state : null;
  }, { timeoutMs: 5_000, intervalMs: 50, label: 'reasoning menu keyboard Escape close' });

  await button.focus();
  await button.press('ArrowDown');
  const openedWithArrow = await waitFor(async () => {
    const state = await readReasoningUi(sidebarFrame);
    return state.isOpen && state.focus.effort === 'medium' ? state : null;
  }, { timeoutMs: 5_000, intervalMs: 50, label: 'reasoning menu keyboard ArrowDown open' });

  await sidebarFrame.locator('.reasoning-effort-option:focus').press('Tab');
  const closedWithTab = await waitFor(async () => {
    const state = await readReasoningUi(sidebarFrame);
    return !state.isOpen && state.focus.id === 'document-button' ? state : null;
  }, { timeoutMs: 5_000, intervalMs: 50, label: 'reasoning menu focusout close' });

  return { openedWithEnter, closedWithEscape, openedWithArrow, closedWithTab };
}

async function selectEffortFromMenu(sidebarFrame, effort) {
  await sidebarFrame.evaluate(() => {
    window.cerebr?.debug?.chatHistoryUI?.closeChatHistoryPanel?.();
  });
  await sidebarFrame.locator('#reasoning-effort-button').hover({ force: true });
  const option = sidebarFrame.locator(`.reasoning-effort-option[data-effort="${effort}"]`);
  await option.waitFor({ state: 'visible', timeout: 5_000 });
  await option.click();
}

async function setEffortOptionChecked(sidebarFrame, effort, checked) {
  const settingsButton = sidebarFrame.locator('#settings-button');
  const preferencesToggle = sidebarFrame.locator('#preferences-settings-toggle');
  const settingControl = sidebarFrame.locator('#responses-reasoning-effort-slider-options');

  // 右下角设置菜单本身就是 hover 打开；先按真实交互移入按钮，
  // 再点击菜单项，避免 click 后鼠标仍停在按钮动画期间导致定位抖动。
  await settingsButton.hover({ force: true });
  await preferencesToggle.waitFor({ state: 'visible', timeout: 5_000 });
  // 设置菜单被 portal 到 body，并由 fixed 坐标定位；离屏最小化的 worktree
  // 浏览器会让 Playwright 的 viewport 命中检查误判，但 DOM 菜单本身已经可见。
  await preferencesToggle.evaluate(toggle => toggle.click());
  await sidebarFrame.page().mouse.move(10, 10);
  await sidebarFrame.page().waitForTimeout(260);
  await sidebarFrame.locator('#settings-menu').evaluate(menu => {
    menu.classList.remove('visible');
    menu.style.display = 'none';
    menu.style.pointerEvents = 'none';
  });
  await settingControl.waitFor({ state: 'visible', timeout: 15_000 });
  const dropdownToggle = settingControl.locator('.settings-multiselect-toggle');
  if (await dropdownToggle.getAttribute('aria-expanded') !== 'true') {
    await dropdownToggle.click();
  }

  const checkbox = settingControl.locator(`input[type="checkbox"][value="${effort}"]`);
  await checkbox.waitFor({ state: 'visible', timeout: 5_000 });
  if (checked) {
    await checkbox.check();
  } else {
    await checkbox.uncheck();
  }

  await waitFor(async () => (
    await checkbox.isChecked().catch(() => !checked)
  ) === checked, { timeoutMs: 5_000, intervalMs: 50, label: `${effort} setting checked=${checked}` });

  // 偏好设置面板复用同一个入口做关闭；交互验证本身已通过真实 checkbox 完成。
  await preferencesToggle.evaluate(toggle => toggle.click());
  await waitFor(async () => sidebarFrame.evaluate(() => {
    const panel = document.querySelector('#chat-history-panel');
    return !panel || (!panel.classList.contains('visible') && getComputedStyle(panel).display === 'none');
  }), { timeoutMs: 5_000, intervalMs: 50, label: 'preferences panel closed' });
  await sidebarFrame.locator('#settings-menu').evaluate(menu => {
    menu.style.display = '';
    menu.style.pointerEvents = '';
    menu.classList.remove('visible');
  });
}

async function readPersistedState(extensionWorker, configId) {
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

    const settingsWrap = await chrome.storage.sync.get(['responsesReasoningEffortSliderOptions']);
    return {
      localEffort: localConfig?.responsesApiSettings?.reasoning?.effort || '',
      syncEffort: syncConfig?.responsesApiSettings?.reasoning?.effort || '',
      syncChunkCount: count,
      visibleEfforts: settingsWrap.responsesReasoningEffortSliderOptions || []
    };
  })()`);
}

async function readStorageSnapshot(extensionWorker) {
  return extensionWorker.evaluate(`(async () => {
    const [sync, local] = await Promise.all([
      chrome.storage.sync.get(null),
      chrome.storage.local.get(null)
    ]);
    return { sync, local };
  })()`);
}

async function restoreStorageSnapshot(extensionWorker, snapshot) {
  if (!extensionWorker || !snapshot) return;
  await extensionWorker.evaluate(`(async () => {
    const snapshot = ${JSON.stringify(snapshot)};
    await Promise.all([chrome.storage.sync.clear(), chrome.storage.local.clear()]);
    const writes = [];
    if (Object.keys(snapshot.sync || {}).length > 0) writes.push(chrome.storage.sync.set(snapshot.sync));
    if (Object.keys(snapshot.local || {}).length > 0) writes.push(chrome.storage.local.set(snapshot.local));
    await Promise.all(writes);
    return true;
  })()`);
}

function assertState(condition, message, details = null) {
  if (condition) return;
  const suffix = details == null ? '' : `: ${JSON.stringify(details)}`;
  throw new Error(`${message}${suffix}`);
}

function assertStyleMatches(reasoningStyle, settingsStyle, keys, label) {
  const mismatches = keys
    .filter(key => reasoningStyle?.[key] !== settingsStyle?.[key])
    .map(key => ({ key, reasoning: reasoningStyle?.[key], settings: settingsStyle?.[key] }));
  assertState(mismatches.length === 0, `${label} 未与右下角设置菜单一致`, mismatches);
}

async function main() {
  await fsp.mkdir(outputDir, { recursive: true });
  const result = {
    startedAt: new Date(startedAtMs).toISOString(),
    repoRoot,
    outputDir,
    launchMode,
    chromePath,
    headless: runHeadless,
    defaultVisibleEfforts: DEFAULT_VISIBLE_EFFORTS,
    steps: [],
    console: []
  };

  const profileDir = launchMode === 'worktree_unpacked'
    ? resolveWorktreeUnpackedProfileDir(repoRoot, 'reasoning-effort-menu')
    : resolveFixedSidebarProfileDir(repoRoot);
  await fsp.mkdir(profileDir, { recursive: true });
  result.profileDir = profileDir;

  let context = null;
  let extensionWorker = null;
  let originalStorageSnapshot = null;
  try {
    logProgress(launchMode === 'worktree_unpacked'
      ? '启动隔离的 worktree unpacked Chromium profile'
      : '启动固定 Stable Chrome profile');
    context = launchMode === 'worktree_unpacked'
      ? await launchWorktreeUnpackedChromiumContext({
        chromium,
        repoRoot,
        profileDir,
        headless: runHeadless
      })
      : await launchFixedSidebarContext({
        chromium,
        profileDir,
        executablePath: chromePath,
        headless: runHeadless
      });
    result.steps.push('browser_ready');

    logProgress(launchMode === 'worktree_unpacked'
      ? '等待当前 checkout 的扩展 service worker'
      : '重新加载当前 checkout 的 unpacked 扩展');
    extensionWorker = launchMode === 'worktree_unpacked'
      ? await waitForWorktreeExtensionWorker(context, { timeoutMs: 30_000 })
      : await reloadUnpackedExtension(context, {
        timeoutMs: 30_000,
        unpackedPath: repoRoot
      });
    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;
    result.steps.push('extension_reloaded');

    originalStorageSnapshot = await readStorageSnapshot(extensionWorker);
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
    assertState(!result.initial.hidden && result.initial.display !== 'none', 'Responses 配置下推理强度入口未显示', result.initial);
    assertState(result.initial.menu.exists && !result.initial.hasLegacySlider, '仍在使用旧 slider DOM', result.initial);
    assertState(
      result.initial.hasSignalBarsIcon && result.initial.hasRegularSignalBarsIcon,
      '缺少 Font Awesome 空心 signal-bars 图标',
      result.initial
    );
    assertState(
      !result.initial.hasBrainIcon && !result.initial.hasChipIcon && !result.initial.hasGaugeIcon,
      '仍残留大脑、芯片或 gauge 图标',
      result.initial
    );
    assertState(
      Math.abs(result.initial.sizes.iconFont - result.initial.sizes.documentIconFont) <= 0.5,
      '推理强度图标与旁边文件按钮图标字号不一致',
      result.initial.sizes
    );
    assertState(
      result.initial.domOrder.input < result.initial.domOrder.control
      && result.initial.domOrder.control < result.initial.domOrder.documentButton,
      '推理强度入口未位于输入框与文件按钮之间',
      result.initial.domOrder
    );
    assertState(
      JSON.stringify(result.initial.options.map(option => option.effort)) === JSON.stringify(DEFAULT_VISIBLE_EFFORTS),
      '默认菜单不是 low/medium/high/xhigh',
      result.initial.options
    );
    assertState(
      result.initial.options.find(option => option.effort === 'medium')?.selected === true
      && result.initial.options.find(option => option.effort === 'medium')?.tabIndex === 0
      && result.initial.options.filter(option => option.effort !== 'medium').every(option => option.tabIndex === -1)
      && result.initial.options.every(option => option.role === 'menuitemradio'),
      '当前 medium 档位或菜单语义不正确',
      result.initial.options
    );
    assertState(result.initial.button.ariaHaspopup === 'menu' && result.initial.button.ariaExpanded === 'false', '入口 ARIA 状态不正确', result.initial.button);
    assertState(result.initial.pill === 'gpt-5.6-medium', '初始模型标签缺少 -medium', result.initial);
    assertState(result.initial.placeholder.includes('gpt-5.6-medium'), 'placeholder 缺少 -medium', result.initial);
    assertState(result.initial.menu.opacity <= 0.01 && result.initial.menu.visibility === 'hidden', '初始菜单未关闭', result.initial.menu);

    const surfaceKeys = [
      'backgroundColor',
      'borderTopColor',
      'borderTopStyle',
      'borderTopWidth',
      'borderRadius',
      'boxShadow',
      'paddingTop',
      'paddingRight',
      'paddingBottom',
      'paddingLeft',
      'backdropFilter',
      'transitionDuration'
    ];
    const itemKeys = [
      'paddingTop',
      'paddingRight',
      'paddingBottom',
      'paddingLeft',
      'borderRadius',
      'marginTop',
      'marginBottom',
      'fontSize',
      'color',
      'alignItems',
      'justifyContent'
    ];
    assertStyleMatches(result.initial.styles.reasoningSurface, result.initial.styles.settingsSurface, surfaceKeys, '推理菜单表面样式');
    assertStyleMatches(result.initial.styles.reasoningItem, result.initial.styles.settingsItem, itemKeys, '推理菜单项样式');
    assertState(
      result.initial.styles.reasoningSurface?.originIsBottomRight
      && result.initial.styles.settingsSurface?.originIsBottomRight,
      '两个上拉菜单都应从右下角展开',
      result.initial.styles
    );
    result.steps.push('initial_contract_and_style_verified');
    await sidebarFrame.locator('#message-row').screenshot({ path: path.join(outputDir, 'collapsed.png') });

    logProgress('验证悬停上拉、菜单内保持打开、离开关闭');
    result.hover = await collectHoverMotion(sidebarFrame);
    const distinctOpacities = new Set(result.hover.motion.samples.map(sample => sample.opacity.toFixed(2)));
    const distinctTransforms = new Set(result.hover.motion.samples.map(sample => sample.transform));
    assertState(result.hover.collapsed.menu.opacity <= 0.01, '悬停前菜单透明度不为 0', result.hover.collapsed.menu);
    assertState(result.hover.expanded.isOpen && result.hover.expanded.button.ariaExpanded === 'true', '悬停后菜单未打开', result.hover.expanded);
    assertState(result.hover.expanded.menu.opacity >= 0.99 && result.hover.expanded.menu.pointerEvents === 'auto', '悬停后菜单不可交互', result.hover.expanded.menu);
    assertState(
      result.hover.expanded.geometry.menu.bottom < result.hover.expanded.geometry.button.top,
      '推理强度菜单不是向上展开',
      result.hover.expanded.geometry
    );
    assertState(distinctOpacities.size >= 3 || distinctTransforms.size >= 3, '上拉菜单没有可观测的平滑过渡', result.hover.motion);
    assertState(result.hover.heldOverOption.isOpen, '鼠标移入菜单项后菜单意外关闭', result.hover.heldOverOption);
    assertState(
      !result.hover.closedAfterLeave.isOpen
      && result.hover.closedAfterLeave.button.ariaExpanded === 'false',
      '鼠标离开整个菜单后没有关闭',
      result.hover.closedAfterLeave
    );
    result.steps.push('hover_open_leave_close_verified');
    await sidebarFrame.locator('#reasoning-effort-button').hover({ force: true });
    await sidebarFrame.locator('body').screenshot({ path: path.join(outputDir, 'menu-open-medium-body.png') });
    await sidebarFrame.locator('#message-input').hover({ position: { x: 18, y: 12 }, force: true });

    logProgress('验证键盘打开、roving tabindex、Escape 与 focusout 关闭');
    result.keyboard = await verifyKeyboardNavigation(sidebarFrame);
    result.steps.push('keyboard_navigation_verified');

    logProgress('验证非 Responses 配置自动隐藏');
    await cycleFavoriteApi(sidebarFrame, 'ArrowDown', 'chat-model');
    result.chatState = await readReasoningUi(sidebarFrame);
    assertState(result.chatState.hidden || result.chatState.display === 'none', 'Chat Completions 下推理强度入口仍可见', result.chatState);
    await cycleFavoriteApi(sidebarFrame, 'ArrowUp', 'gpt-5.6');
    result.steps.push('responses_only_visibility_verified');

    logProgress('在偏好设置中真实勾选 default，并验证菜单即时显示');
    await setEffortOptionChecked(sidebarFrame, 'default', true);
    result.withDefaultOptions = await waitFor(async () => {
      const state = await readReasoningUi(sidebarFrame);
      return JSON.stringify(state.options.map(option => option.effort)) === JSON.stringify(VISIBLE_EFFORTS_WITH_DEFAULT)
        ? state
        : null;
    }, { timeoutMs: 10_000, intervalMs: 100, label: 'default added to reasoning effort menu' });
    result.withDefaultSettingPersistence = await waitFor(async () => {
      const persisted = await readPersistedState(extensionWorker, RESPONSES_CONFIG_ID);
      return JSON.stringify(persisted.visibleEfforts) === JSON.stringify(CONFIGURED_EFFORTS_WITH_DEFAULT)
        ? persisted
        : null;
    }, { timeoutMs: 15_000, intervalMs: 250, label: 'default visible setting persisted' });
    result.steps.push('default_visibility_setting_verified');

    logProgress('通过真实菜单点击 default 并验证清除显式 effort');
    await selectEffortFromMenu(sidebarFrame, 'default');
    result.defaultState = await waitFor(async () => {
      const state = await readReasoningUi(sidebarFrame);
      return state.effort === 'default'
        && state.pill === 'gpt-5.6-default'
        && state.placeholder.includes('gpt-5.6-default')
        && state.options.find(option => option.effort === 'default')?.selected
        ? state
        : null;
    }, { timeoutMs: 10_000, intervalMs: 100, label: 'default effort UI state' });
    result.defaultPersistence = await waitFor(async () => {
      const persisted = await readPersistedState(extensionWorker, RESPONSES_CONFIG_ID);
      return persisted.localEffort === '' && persisted.syncEffort === '' ? persisted : null;
    }, { timeoutMs: 25_000, intervalMs: 350, label: 'default effort cleared from local and sync' });
    result.steps.push('default_cleared');

    logProgress('取消显示当前 default，验证菜单严格隐藏但模型后缀保持 -default');
    await setEffortOptionChecked(sidebarFrame, 'default', false);
    result.hiddenDefaultPreserved = await waitFor(async () => {
      const state = await readReasoningUi(sidebarFrame);
      return state.effort === 'default'
        && state.pill === 'gpt-5.6-default'
        && state.placeholder.includes('gpt-5.6-default')
        && !state.options.some(option => option.effort === 'default')
        && !state.options.some(option => option.selected)
        && JSON.stringify(state.options.map(option => option.effort)) === JSON.stringify(DEFAULT_VISIBLE_EFFORTS)
        ? state
        : null;
    }, { timeoutMs: 10_000, intervalMs: 100, label: 'hidden current default removed from menu' });
    result.hiddenDefaultSettingPersistence = await waitFor(async () => {
      const persisted = await readPersistedState(extensionWorker, RESPONSES_CONFIG_ID);
      return persisted.localEffort === ''
        && persisted.syncEffort === ''
        && JSON.stringify(persisted.visibleEfforts) === JSON.stringify(CONFIGURED_EFFORTS)
        ? persisted
        : null;
    }, { timeoutMs: 15_000, intervalMs: 250, label: 'hidden default setting persisted without changing current effort' });
    result.steps.push('hidden_current_default_preserved');

    logProgress('在偏好设置中真实勾选 max，并验证菜单即时显示');
    await setEffortOptionChecked(sidebarFrame, 'max', true);
    result.withMaxOptions = await waitFor(async () => {
      const state = await readReasoningUi(sidebarFrame);
      return JSON.stringify(state.options.map(option => option.effort)) === JSON.stringify(VISIBLE_EFFORTS_WITH_MAX)
        ? state
        : null;
    }, { timeoutMs: 10_000, intervalMs: 100, label: 'max added to reasoning effort menu' });
    result.withMaxSettingPersistence = await waitFor(async () => {
      const persisted = await readPersistedState(extensionWorker, RESPONSES_CONFIG_ID);
      return JSON.stringify(persisted.visibleEfforts) === JSON.stringify(CONFIGURED_EFFORTS_WITH_MAX)
        ? persisted
        : null;
    }, { timeoutMs: 15_000, intervalMs: 250, label: 'max visible setting persisted' });
    result.steps.push('max_visibility_setting_verified');

    logProgress('通过真实菜单点击 max 并验证 API 配置持久化');
    await selectEffortFromMenu(sidebarFrame, 'max');
    result.maxState = await waitFor(async () => {
      const state = await readReasoningUi(sidebarFrame);
      return state.effort === 'max'
        && state.pill === 'gpt-5.6-max'
        && state.placeholder.includes('gpt-5.6-max')
        && state.options.find(option => option.effort === 'max')?.selected
        ? state
        : null;
    }, { timeoutMs: 10_000, intervalMs: 100, label: 'max effort UI state' });
    result.maxPersistence = await waitFor(async () => {
      const persisted = await readPersistedState(extensionWorker, RESPONSES_CONFIG_ID);
      return persisted.localEffort === 'max' && persisted.syncEffort === 'max' ? persisted : null;
    }, { timeoutMs: 25_000, intervalMs: 350, label: 'max effort persisted to local and sync' });
    result.steps.push('max_selected_and_persisted');

    logProgress('取消显示当前 max，验证菜单严格隐藏但模型后缀保持 -max');
    await setEffortOptionChecked(sidebarFrame, 'max', false);
    result.hiddenCurrentPreserved = await waitFor(async () => {
      const state = await readReasoningUi(sidebarFrame);
      return state.effort === 'max'
        && state.pill === 'gpt-5.6-max'
        && state.placeholder.includes('gpt-5.6-max')
        && !state.options.some(option => option.effort === 'max')
        && !state.options.some(option => option.selected)
        && JSON.stringify(state.options.map(option => option.effort)) === JSON.stringify(DEFAULT_VISIBLE_EFFORTS)
        ? state
        : null;
    }, { timeoutMs: 10_000, intervalMs: 100, label: 'hidden current max removed from menu' });
    result.hiddenSettingPersistence = await waitFor(async () => {
      const persisted = await readPersistedState(extensionWorker, RESPONSES_CONFIG_ID);
      return persisted.localEffort === 'max'
        && persisted.syncEffort === 'max'
        && JSON.stringify(persisted.visibleEfforts) === JSON.stringify(CONFIGURED_EFFORTS)
        ? persisted
        : null;
    }, { timeoutMs: 15_000, intervalMs: 250, label: 'hidden max setting persisted without changing current effort' });
    result.steps.push('hidden_current_effort_preserved');

    await sidebarFrame.locator('#reasoning-effort-button').hover({ force: true });
    await sidebarFrame.locator('body').screenshot({ path: path.join(outputDir, 'menu-open-hidden-max-body.png') });
    await sidebarFrame.locator('#message-input').hover({ position: { x: 18, y: 12 }, force: true });

    logProgress('重载 sidebar，验证 max 与隐藏设置同时恢复');
    await sidebarFrame.evaluate(() => window.location.reload());
    sidebarFrame = await waitForSidebarFrame(page, extensionId, { timeoutMs: 30_000 });
    await sidebarFrame.locator('#message-input').waitFor({ state: 'visible', timeout: 30_000 });
    result.reloaded = await waitFor(async () => {
      const state = await readReasoningUi(sidebarFrame);
      return state.effort === 'max'
        && state.pill === 'gpt-5.6-max'
        && state.placeholder.includes('gpt-5.6-max')
        && !state.options.some(option => option.effort === 'max')
        && !state.options.some(option => option.selected)
        && JSON.stringify(state.options.map(option => option.effort)) === JSON.stringify(DEFAULT_VISIBLE_EFFORTS)
        ? state
        : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: 'reloaded hidden current max state' });
    result.reloadedPersistence = await readPersistedState(extensionWorker, RESPONSES_CONFIG_ID);
    assertState(
      JSON.stringify(result.reloadedPersistence.visibleEfforts) === JSON.stringify(CONFIGURED_EFFORTS),
      '重载后 max 又被错误加入可见设置',
      result.reloadedPersistence
    );
    result.steps.push('reload_persistence_verified');

    logProgress('恢复测试前扩展存储');
    await restoreStorageSnapshot(extensionWorker, originalStorageSnapshot);
    originalStorageSnapshot = null;
    result.steps.push('storage_restored');

    result.success = true;
    result.finishedAt = new Date().toISOString();
    result.elapsedMs = Date.now() - startedAtMs;
    await fsp.writeFile(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    logProgress('回归通过', `elapsedMs=${result.elapsedMs}`);
  } catch (error) {
    if (extensionWorker && originalStorageSnapshot) {
      await restoreStorageSnapshot(extensionWorker, originalStorageSnapshot).catch(() => null);
      originalStorageSnapshot = null;
    }
    result.success = false;
    result.error = String(error?.stack || error?.message || error);
    result.finishedAt = new Date().toISOString();
    result.elapsedMs = Date.now() - startedAtMs;
    await fsp.writeFile(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    logProgress('回归失败', error?.message || String(error));
    throw error;
  } finally {
    if (extensionWorker && originalStorageSnapshot) {
      await restoreStorageSnapshot(extensionWorker, originalStorageSnapshot).catch(() => null);
    }
    await context?.close().catch(() => null);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
