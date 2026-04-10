const path = require('path');
const {
  buildSendContentMessageExpression,
  loadPlaywright,
  shouldRunHeadless,
  waitFor,
  waitForSidebarFrame
} = require('./stable_chrome_sidebar_harness.cjs');

function sanitizeCaseSegment(value, fallback = 'default') {
  const text = (typeof value === 'string' ? value.trim() : '') || fallback;
  const normalized = text.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

/**
 * worktree 模式下的专用 profile 目录。
 *
 * 这里刻意和 stable Chrome 固定 profile 分离：
 * - stable 路径用于“主仓库/手动已安装 unpacked 扩展”的默认验证；
 * - worktree 路径用于“让 Chromium 直接加载当前 checkout 的 unpacked 扩展代码”。
 *
 * @param {string} repoRoot
 * @param {string} caseName
 * @returns {string}
 */
function resolveWorktreeUnpackedProfileDir(repoRoot, caseName = 'default') {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const envValue = (typeof process.env.CEREBR_WORKTREE_UNPACKED_PROFILE_DIR === 'string')
    ? process.env.CEREBR_WORKTREE_UNPACKED_PROFILE_DIR.trim()
    : '';
  if (envValue) {
    return path.resolve(envValue);
  }
  return path.join(
    resolvedRepoRoot,
    'output',
    'playwright',
    '_profiles',
    'chromium_worktree_unpacked',
    sanitizeCaseSegment(caseName)
  );
}

function buildWorktreeUnpackedChromiumLaunchOptions({ repoRoot, headless }) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  return {
    headless,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${resolvedRepoRoot}`,
      `--load-extension=${resolvedRepoRoot}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-search-engine-choice-screen',
      ...(headless ? [] : ['--window-position=-2400,-2400', '--window-size=1440,960', '--start-minimized'])
    ]
  };
}

async function launchWorktreeUnpackedChromiumContext({
  chromium,
  repoRoot,
  profileDir,
  headless
}) {
  return await chromium.launchPersistentContext(
    profileDir,
    buildWorktreeUnpackedChromiumLaunchOptions({ repoRoot, headless })
  );
}

async function waitForWorktreeExtensionWorker(context, { timeoutMs = 30_000 } = {}) {
  return await waitFor(async () => (
    context.serviceWorkers().find((worker) => worker.url().endsWith('/src/extension/background.js')) || null
  ), {
    timeoutMs,
    intervalMs: 300,
    label: 'worktree unpacked extension service worker'
  });
}

module.exports = {
  buildSendContentMessageExpression,
  loadPlaywright,
  shouldRunHeadless,
  waitFor,
  waitForSidebarFrame,
  buildWorktreeUnpackedChromiumLaunchOptions,
  launchWorktreeUnpackedChromiumContext,
  resolveWorktreeUnpackedProfileDir,
  waitForWorktreeExtensionWorker
};
