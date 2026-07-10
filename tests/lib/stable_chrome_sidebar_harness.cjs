const path = require('path');
const os = require('os');

const DEFAULT_STABLE_CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/**
 * 统一解析 Playwright。
 * 保留当前仓库已经验证过的搜索顺序，避免在不同 cwd / 临时缓存下丢模块。
 *
 * @param {string} repoRoot
 * @returns {{chromium: import('playwright').chromium}}
 */
function loadPlaywright(repoRoot) {
  const candidateBases = [
    process.cwd(),
    repoRoot,
    path.join(repoRoot, 'node_modules'),
    path.join(os.tmpdir(), 'cerebr-playwright-cdp'),
    path.join(os.tmpdir(), 'cerebr-playwright-cdp', 'node_modules')
  ];
  for (const base of candidateBases) {
    try {
      const resolved = require.resolve('playwright', { paths: [base] });
      return require(resolved);
    } catch (_) {}
  }
  throw new Error(
    'Cannot resolve playwright. Tried repo-local paths and the known temp harness cache under %TEMP%\\cerebr-playwright-cdp.'
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition, { timeoutMs = 30_000, intervalMs = 200, label = 'condition' } = {}) {
  const startedAt = Date.now();
  while (true) {
    try {
      const value = await condition();
      if (value) return value;
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) throw error;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await sleep(intervalMs);
  }
}

function buildSendContentMessageExpression(messageLiteral) {
  return `(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || typeof tab.id !== 'number') throw new Error('active tab not found');
    const response = await chrome.tabs.sendMessage(tab.id, ${messageLiteral});
    return { tabId: tab.id, response };
  })()`;
}

/**
 * 默认复用“手动装好扩展 + 已开启 userScripts 权限”的固定 stable Chrome profile。
 * 这里不再保留其它默认 profile 分叉，避免再次偏离到错误环境。
 *
 * @param {string} repoRoot
 * @param {{envVarName?: string}} [options]
 * @returns {string}
 */
function resolveFixedSidebarProfileDir(repoRoot, options = {}) {
  const envVarName = typeof options.envVarName === 'string' && options.envVarName.trim()
    ? options.envVarName.trim()
    : 'CEREBR_CDP_PROFILE_DIR';
  const fromEnv = (typeof process.env[envVarName] === 'string')
    ? process.env[envVarName].trim()
    : '';
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.join(repoRoot, 'output', 'playwright', '_profiles', 'chrome_stable_manual_extension_profile');
}

function resolveStableChromeExecutablePath() {
  const fromEnv = (typeof process.env.CEREBR_EXTERNAL_CHROME_PATH === 'string')
    ? process.env.CEREBR_EXTERNAL_CHROME_PATH.trim()
    : '';
  return fromEnv || DEFAULT_STABLE_CHROME_PATH;
}

function shouldRunHeadless() {
  return String(process.env.CEREBR_PW_HEADLESS || 'false').trim().toLowerCase() === 'true';
}

function buildPersistentContextLaunchOptions({
  executablePath,
  headless
}) {
  return {
    headless,
    executablePath,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-search-engine-choice-screen',
      // Chrome Stable 145+ 会把固定 profile 中的 unpacked developer extension 标记为
      // unsupported，除非显式开启扩展调试。这个开关不指定扩展路径，也不替代固定
      // profile；它只让已经由 profile 持久化管理的 Cerebr service worker 正常启动。
      '--enable-unsafe-extension-debugging',
      ...(headless ? [] : ['--window-position=-2400,-2400', '--window-size=1440,960', '--start-minimized'])
    ]
  };
}

async function launchFixedSidebarContext({
  chromium,
  profileDir,
  executablePath,
  headless
}) {
  return await chromium.launchPersistentContext(
    profileDir,
    buildPersistentContextLaunchOptions({ executablePath, headless })
  );
}

async function waitForExtensionWorker(context, { timeoutMs = 30_000 } = {}) {
  return await waitFor(async () => (
    context.serviceWorkers().find((worker) => worker.url().endsWith('/src/extension/background.js')) || null
  ), { timeoutMs, intervalMs: 300, label: 'extension service worker' });
}

/**
 * 通过 Chrome 的扩展调试 CDP 域把当前 repo 登记到固定 profile。
 *
 * Chrome Stable 145+ 可能在下一次启动时把 unpacked developer extension 标记为
 * disabled。仅依赖 profile 旧状态会导致 service worker 永远不出现；这里使用固定
 * profile 本身的浏览器会话重新加载同一路径，不传 `--load-extension`，也不会连接
 * 或污染用户日常 Chrome profile。
 *
 * @param {import('playwright').BrowserContext} context
 * @param {string} unpackedPath
 * @returns {Promise<string>}
 */
async function loadUnpackedExtensionIntoFixedProfile(context, unpackedPath) {
  const normalizedPath = typeof unpackedPath === 'string' ? path.resolve(unpackedPath) : '';
  if (!normalizedPath) return '';
  const browser = context.browser();
  if (!browser || typeof browser.newBrowserCDPSession !== 'function') {
    throw new Error('Stable Chrome context does not expose a browser CDP session.');
  }
  const session = await browser.newBrowserCDPSession();
  try {
    const result = await session.send('Extensions.loadUnpacked', { path: normalizedPath });
    return typeof result?.id === 'string' ? result.id : '';
  } finally {
    await session.detach().catch(() => null);
  }
}

/**
 * 对固定 profile 里的 unpacked 扩展做一次显式 reload，确保当前测试读取到磁盘上的最新源码。
 *
 * 背景：
 * - 这个固定 stable Chrome profile 会长期复用已经安装好的 unpacked 扩展；
 * - 如果不主动 reload，Chrome 可能继续沿用上一次会话里已加载的旧代码；
 * - 这会导致“代码其实已经修好，但 smoke 仍在跑旧扩展”的假失败。
 *
 * @param {import('playwright').BrowserContext} context
 * @param {{timeoutMs?: number, settleMs?: number, unpackedPath?:string}} [options]
 * @returns {Promise<import('playwright').Worker>}
 */
async function reloadUnpackedExtension(context, {
  timeoutMs = 30_000,
  settleMs = 2_000,
  unpackedPath = ''
} = {}) {
  if (typeof unpackedPath === 'string' && unpackedPath.trim()) {
    await loadUnpackedExtensionIntoFixedProfile(context, unpackedPath);
  }
  const worker = await waitForExtensionWorker(context, { timeoutMs });
  await worker.evaluate(() => {
    chrome.runtime.reload();
    return true;
  }).catch(() => null);
  await sleep(settleMs);
  return await waitForExtensionWorker(context, { timeoutMs });
}

/**
 * 确保固定 stable Chrome 测试 profile 已允许当前 unpacked 扩展运行 user scripts。
 *
 * Chrome 138+ 把 `chrome.userScripts` 放在扩展详情页的独立用户确认开关后面；即使
 * manifest 已声明 userScripts 权限，未开启该开关时 service worker 里仍看不到 API。
 * 这里仅操作仓库专用的固定测试 profile，不接触用户日常 Chrome profile。
 *
 * @param {import('playwright').BrowserContext} context
 * @param {string} extensionId
 * @param {{timeoutMs?:number}} [options]
 * @returns {Promise<{allowed:boolean,changed:boolean}>}
 */
async function ensureExtensionUserScriptsAllowed(context, extensionId, { timeoutMs = 15_000 } = {}) {
  const normalizedExtensionId = typeof extensionId === 'string' ? extensionId.trim() : '';
  if (!normalizedExtensionId) {
    throw new Error('Cannot enable user scripts without an extension id.');
  }

  const page = await context.newPage();
  try {
    await page.goto(`chrome://extensions/?id=${normalizedExtensionId}`, {
      waitUntil: 'domcontentloaded'
    });
    const toggle = page.locator('extensions-toggle-row#allow-user-scripts');
    await toggle.waitFor({ state: 'visible', timeout: timeoutMs });
    const alreadyAllowed = await toggle.evaluate((element) => element.checked === true);
    if (alreadyAllowed) {
      return { allowed: true, changed: false };
    }

    await toggle.click();
    await waitFor(async () => (
      await toggle.evaluate((element) => element.checked === true).catch(() => false)
    ), {
      timeoutMs,
      intervalMs: 200,
      label: 'Allow User Scripts toggle'
    });
    return { allowed: true, changed: true };
  } finally {
    await page.close().catch(() => null);
  }
}

async function waitForSidebarFrame(page, extensionId, { timeoutMs = 30_000 } = {}) {
  return await waitFor(async () => (
    page.frames().find((frame) => frame.url().startsWith(`chrome-extension://${extensionId}/src/ui/sidebar/sidebar.html`)) || null
  ), { timeoutMs, label: 'sidebar frame' });
}

module.exports = {
  DEFAULT_STABLE_CHROME_PATH,
  buildPersistentContextLaunchOptions,
  buildSendContentMessageExpression,
  ensureExtensionUserScriptsAllowed,
  launchFixedSidebarContext,
  loadUnpackedExtensionIntoFixedProfile,
  loadPlaywright,
  reloadUnpackedExtension,
  resolveFixedSidebarProfileDir,
  resolveStableChromeExecutablePath,
  shouldRunHeadless,
  sleep,
  waitFor,
  waitForExtensionWorker,
  waitForSidebarFrame
};
