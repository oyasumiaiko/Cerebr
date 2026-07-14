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

const [repoRootArg = '.', outputDirArg = 'output/playwright/api-pure-chat-mode'] = process.argv.slice(2);
const repoRoot = path.resolve(repoRootArg);
const outputDir = path.resolve(outputDirArg);
const runHeadless = shouldRunHeadless();
const chromePath = resolveStableChromeExecutablePath();
const { chromium } = loadPlaywright(repoRoot);
const startedAtMs = Date.now();

function logProgress(step, details = '') {
  const elapsedSeconds = ((Date.now() - startedAtMs) / 1000).toFixed(1);
  const suffix = details ? ` ${details}` : '';
  console.log(`[api-pure-chat][${elapsedSeconds}s] ${step}${suffix}`);
}

function buildStorageSeed() {
  return {
    apiConfigs: [{
      id: 'config_api_pure_chat_regression',
      displayName: '纯对话回归模型',
      modelName: 'gpt-5.4',
      connectionType: 'openai_responses',
      baseUrl: 'https://api.openai.com/v1/responses',
      apiKey: '',
      apiKeyFilePath: '',
      requestMode: 'pure_chat',
      temperature: 1,
      useStreaming: true,
      isFavorite: false,
      customParams: '',
      customSystemPrompt: '用户自定义系统提示词',
      userMessagePreprocessorEnabled: false,
      userMessagePreprocessorTemplate: '模板前缀：{{input}}',
      userMessagePreprocessorIncludeInHistory: false,
      maxChatHistory: 500,
      maxChatHistoryUser: 500,
      maxChatHistoryAssistant: 500,
      responsesApiSettings: {
        tools: [{ type: 'web_search' }],
        extension_tools: {
          js_runtime_execute: { enabled: true }
        }
      }
    }],
    selectedConfigIndex: 0
  };
}

async function openApiSettings(sidebarFrame) {
  await sidebarFrame.locator('#settings-button').click();
  const apiSettingsToggle = sidebarFrame.locator('#api-settings-toggle');
  await apiSettingsToggle.waitFor({ state: 'visible', timeout: 15_000 });
  // 固定测试窗口会被移出屏幕并最小化，菜单底部可能落在 iframe 可视区之外；
  // 直接触发元素自身 click，仍走应用注册的真实事件处理器，不依赖宿主窗口坐标。
  await apiSettingsToggle.evaluate((element) => element.click());
  const card = sidebarFrame.locator('.api-card:not(.template)').first();
  await card.waitFor({ state: 'visible', timeout: 20_000 });
  if (!(await card.evaluate(element => element.classList.contains('expanded')))) {
    await card.locator('.api-card-header').click();
  }
  await card.locator('.api-request-mode').waitFor({ state: 'visible', timeout: 10_000 });
  return card;
}

async function readCardState(card) {
  return await card.evaluate((element) => {
    const mode = element.querySelector('.api-request-mode');
    const hint = element.querySelector('.api-request-mode-hint');
    const templateToggle = element.querySelector('.user-message-template-enabled');
    const templateInput = element.querySelector('.user-message-template');
    return {
      requestMode: mode?.value || '',
      hint: (hint?.textContent || '').trim(),
      templateEnabled: templateToggle?.checked === true,
      templateDisabled: templateInput?.disabled === true,
      pureModeClass: element.classList.contains('pure-chat-api-mode')
    };
  });
}

async function setCheckboxState(locator, checked) {
  await locator.evaluate((element, nextChecked) => {
    element.checked = nextChecked === true;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, checked);
}

async function main() {
  await fsp.mkdir(outputDir, { recursive: true });
  const result = {
    startedAt: new Date(startedAtMs).toISOString(),
    repoRoot,
    outputDir,
    chromePath,
    headless: runHeadless,
    steps: [],
    console: []
  };

  const profileDir = resolveFixedSidebarProfileDir(repoRoot);
  await fsp.mkdir(profileDir, { recursive: true });
  result.profileDir = profileDir;

  let context = null;
  try {
    logProgress('启动固定 Stable Chrome 测试 profile');
    context = await launchFixedSidebarContext({
      chromium,
      profileDir,
      executablePath: chromePath,
      headless: runHeadless
    });
    result.steps.push('browser_ready');

    logProgress('重新加载当前仓库的 unpacked 扩展');
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
    logProgress('已写入纯对话 API 配置');

    const page = context.pages().find(entry => entry.url().startsWith('https://example.com/'))
      || await context.newPage();
    page.on('console', message => {
      result.console.push({ type: message.type(), text: message.text() });
    });
    page.on('pageerror', error => {
      result.console.push({ type: 'pageerror', text: String(error?.stack || error?.message || error) });
    });
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
    if (!openResponse?.response?.success || openResponse?.response?.status !== true) {
      throw new Error(`OPEN_SIDEBAR failed: ${JSON.stringify(openResponse)}`);
    }
    result.steps.push('sidebar_opened');

    const sidebarFrame = await waitForSidebarFrame(page, extensionId, { timeoutMs: 30_000 });
    await waitFor(async () => (
      await sidebarFrame.evaluate(() => (
        Array.isArray(window.apiConfigs)
        && window.apiConfigs.length > 0
        && window.apiConfigs[0]?.requestMode === 'pure_chat'
      )).catch(() => false)
    ), { timeoutMs: 20_000, intervalMs: 250, label: 'pure chat API config loaded' });
    result.steps.push('sidebar_config_ready');
    logProgress('侧栏已读取纯对话配置');

    let card = await openApiSettings(sidebarFrame);
    result.initialState = await readCardState(card);
    if (
      result.initialState.requestMode !== 'pure_chat'
      || result.initialState.templateEnabled !== false
      || result.initialState.templateDisabled !== true
      || result.initialState.pureModeClass !== true
    ) {
      throw new Error(`初始纯对话 UI 状态不正确: ${JSON.stringify(result.initialState)}`);
    }
    result.steps.push('initial_ui_verified');

    await card.locator('.api-request-mode').selectOption('enhanced');
    const enhancedState = await readCardState(card);
    if (enhancedState.requestMode !== 'enhanced' || !enhancedState.hint.includes('增强模式')) {
      throw new Error(`增强模式切换失败: ${JSON.stringify(enhancedState)}`);
    }
    await card.locator('.api-request-mode').selectOption('pure_chat');
    await setCheckboxState(card.locator('.user-message-template-enabled'), true);
    const templateEnabledState = await readCardState(card);
    if (templateEnabledState.templateEnabled !== true || templateEnabledState.templateDisabled !== false) {
      throw new Error(`模板启用状态不正确: ${JSON.stringify(templateEnabledState)}`);
    }
    await setCheckboxState(card.locator('.user-message-template-enabled'), false);

    await waitFor(async () => (
      await sidebarFrame.evaluate(() => (
        window.apiConfigs?.[0]?.requestMode === 'pure_chat'
        && window.apiConfigs?.[0]?.userMessagePreprocessorEnabled === false
      )).catch(() => false)
    ), { timeoutMs: 15_000, intervalMs: 250, label: 'pure chat config persisted in runtime' });
    result.persistedBackup = await waitFor(async () => {
      const backup = await extensionWorker.evaluate(`(async () => {
        const stored = await chrome.storage.local.get(['apiConfigs_backup_v1']);
        return stored.apiConfigs_backup_v1 || null;
      })()`);
      const config = backup?.items?.[0];
      return config?.requestMode === 'pure_chat'
        && config?.userMessagePreprocessorEnabled === false
        ? {
          requestMode: config.requestMode,
          userMessagePreprocessorEnabled: config.userMessagePreprocessorEnabled,
          updatedAt: backup.updatedAt || null
        }
        : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: 'pure chat config persisted to storage' });
    result.persistedSyncMeta = await waitFor(async () => {
      const meta = await extensionWorker.evaluate(`(async () => {
        const stored = await chrome.storage.sync.get(['apiConfigs_chunks_meta']);
        return stored.apiConfigs_chunks_meta || null;
      })()`);
      return Number(meta?.count) > 0
        && Number(meta?.updatedAt) >= Number(result.persistedBackup.updatedAt || 0)
        ? { count: Number(meta.count), updatedAt: Number(meta.updatedAt) }
        : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: 'pure chat config persisted to sync chunks' });
    result.steps.push('controls_interacted');

    await sidebarFrame.locator('body').screenshot({
      path: path.join(outputDir, 'api-pure-chat-settings.png')
    });
    const templateGroup = card.locator('.user-message-template-group');
    await templateGroup.scrollIntoViewIfNeeded();
    await templateGroup.screenshot({
      path: path.join(outputDir, 'api-pure-chat-template-toggle.png')
    });
    result.steps.push('screenshot_saved');
    logProgress('已保存设置页截图');

    await sidebarFrame.evaluate(() => window.location.reload());
    await sidebarFrame.locator('#message-input').waitFor({ state: 'visible', timeout: 30_000 });
    await waitFor(async () => (
      await sidebarFrame.evaluate(() => window.apiConfigs?.[0]?.requestMode === 'pure_chat').catch(() => false)
    ), { timeoutMs: 20_000, intervalMs: 250, label: 'pure chat config reloaded' });
    card = await openApiSettings(sidebarFrame);
    result.reloadedState = await readCardState(card);
    if (
      result.reloadedState.requestMode !== 'pure_chat'
      || result.reloadedState.templateEnabled !== false
      || result.reloadedState.templateDisabled !== true
    ) {
      throw new Error(`重载后的持久化状态不正确: ${JSON.stringify(result.reloadedState)}`);
    }
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
