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

async function waitForSidebarFrame(page, extensionId, { timeoutMs = 30_000 } = {}) {
  return await waitFor(async () => (
    page.frames().find((frame) => frame.url().startsWith(`chrome-extension://${extensionId}/src/ui/sidebar/sidebar.html`)) || null
  ), { timeoutMs, label: 'sidebar frame' });
}

module.exports = {
  DEFAULT_STABLE_CHROME_PATH,
  buildPersistentContextLaunchOptions,
  buildSendContentMessageExpression,
  launchFixedSidebarContext,
  loadPlaywright,
  resolveFixedSidebarProfileDir,
  resolveStableChromeExecutablePath,
  shouldRunHeadless,
  sleep,
  waitFor,
  waitForExtensionWorker,
  waitForSidebarFrame
};
