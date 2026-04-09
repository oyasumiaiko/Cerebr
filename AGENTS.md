# Repository Guidelines

## Project Structure & Modules
- src/: extension source (ES modules)
  - src/extension/: Chrome service worker (`background.js`) and content script (`content.js`)
  - src/ui/: sidebar UI (`sidebar.html`, `sidebar.js`, styles) and managers
  - src/core/: chat logic (composition, processing, history)
  - src/api/: API settings and request building
  - src/utils/, src/storage/, src/debug/: helpers, IndexedDB, dev tools
- lib/: vendored third‑party assets (KaTeX, Highlight.js, Cytoscape, etc.)
- icons/, statics/: images and static assets
- manifest.json: Chrome extension manifest (v3)

## Build, Test, and Development
- Run locally: Chrome → Extensions → Enable Developer Mode → Load unpacked → select repo root.
- No build step: code runs as-is; libs are pre-bundled in `lib/`.
- Zip for manual release: `zip -r cerebr.zip . -x "*.git*" -x "*.github*" -x "*.DS_Store" -x "README*"`.
- CI release: pushing a tag `v*` creates a ZIP and GitHub Release.

## Coding Style & Naming
- JavaScript ES modules; 2-space indentation; use semicolons.
- camelCase for variables/functions; PascalCase for factory types if introduced.
- Filenames: snake_case.js (e.g., `message_processor.js`).
- Keep zero-build: avoid adding bundlers/deps without discussion.

## Testing Guidelines
- No automated tests yet; validate manually:
  - Load unpacked, open any page, open the sidebar (toolbar icon or configured shortcut).
  - Exercise chat send/stream, markdown/math rendering, code highlighting, screenshots, and context menus.
- Prefer small, verifiable changes; include repro steps in PRs.

### Browser / CDP regression notes for this repo
- **不要默认用 standalone sidebar 做最终验证**。这个仓库的大多数真实问题都发生在**宿主页内嵌侧栏**路径；优先用 `https://example.com/` 之类简单宿主页加载扩展，再在页面里打开嵌入式 sidebar。
- **本机稳定版 Chrome 往往不会真正加载 unpacked extension**。需要真实扩展验证时，优先用本机已验证可加载扩展的 **Chrome for Testing / Puppeteer 缓存 Chrome**，不要在稳定版上反复踩坑。
- 如果用户已经在**稳定版 Chrome 固定 profile**里手动装好了 `Cerebr` unpacked 扩展，并且已经打开 **Allow User Scripts**，后续回归应**优先复用那个 profile**，不要再新建 profile 反复装扩展。
  - 当前固定 profile 路径：`output/playwright/_profiles/chrome_stable_manual_extension_profile`
  - 复用这个 profile 时，**不要**再传 `--load-extension` / `--disable-extensions-except`，否则会重新走“稳定版不真正加载 unpacked 扩展”的旧坑；应直接启动稳定版 Chrome 并复用该 profile 里已安装好的扩展。
  - 对应 `tests/cdp_opgg_page_runtime_context_regression.cjs` 可通过环境变量切到这条模式：
    - `CEREBR_EXTERNAL_CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe`
    - `CEREBR_CDP_PROFILE_DIR=<repoRoot>\output\playwright\_profiles\chrome_stable_manual_extension_profile`
    - `CEREBR_SKIP_LOAD_EXTENSION_ARGS=true`
    - `CEREBR_PW_HEADLESS=false`（稳定版 + 已装扩展 profile 目前优先走有头但移出屏幕的模式）
- 用 Playwright 跑扩展时，优先：
  - `chromium.launchPersistentContext(...)`
  - `ignoreDefaultArgs: ['--disable-extensions']`
  - `args: ['--disable-extensions-except=<repoRoot>', '--load-extension=<repoRoot>']`
  - 给独立 `userDataDir/profile`，避免污染默认配置。
- 如果需要验证 **service worker / extension target / 更底层网络日志**，再走 **CDP**；但先确认浏览器实例里确实已经看到扩展 service worker。
- 打开侧栏后，**先等 sidebar 内部真正读到 API 配置**，再发消息。至少确认：
  - `window.apiConfigs.length > 0`
  - 目标 `baseUrl` 已正确写入
- **发消息优先直接对 sidebar iframe 里的 `#message-input` 执行 `fill(...)` + `press('Enter')`**。不要只依赖宿主页键盘事件，否则容易出现“只输入了换行/文本留在输入框里没有真正发送”的假阳性。
- **做嵌入式 sidebar 的视觉截图时，优先直接对 `sidebarFrame.locator('body')` 截图**。这条是已经被 session 历史证明过的有效路径；`page.screenshot(...)`、活动窗口截图、桌面区域截图都可能漏掉扩展 iframe，或者截到错误窗口。
- 如果 `locator('body').screenshot(...)` 因为 Playwright 的“等待稳定”卡住，优先先保留 DOM 状态断言与 `result.json`，然后再单独处理截图，不要把宿主页整页截图误当成 sidebar 视觉证据。
- 跑浏览器回归时，优先把结果落到 `output/playwright/<case>/result.json` 和截图里，确保失败时能直接看：
  - 是否真正发出请求
  - 当前使用的扩展 `extensionId`
  - sidebar 是否真的 ready
  - 页面 console / pageerror 里有没有报错

## Commit & Pull Requests
- Commits: short, imperative, and scoped (project history uses Chinese, e.g., “修复…”, “添加…”). Link issues when relevant.
- PRs must include:
  - Description of change and rationale
  - Testing steps and expected results
  - Screenshots/GIFs for UI changes
  - Notes on permissions/manifest changes

## Security & Configuration
- Do not commit API keys; keys are stored via the UI in `chrome.storage.sync`.
- Be cautious changing `permissions`/`host_permissions` in `manifest.json`; propose rationale and least privilege.
- Follow existing patterns in `src/api/api_settings.js` for handling secrets and sync chunking.

## Architecture Overview
- Core drives chat flow; UI renders sidebar; Extension layer wires background/content; API manages model configs.
