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
- 浏览器回归的**默认且唯一推荐路径**：
  - `chromium.launchPersistentContext(...)`
  - `executablePath = C:\Program Files\Google\Chrome\Application\chrome.exe`
  - `userDataDir/profile = output/playwright/_profiles/chrome_stable_manual_extension_profile`
  - `ignoreDefaultArgs: ['--disable-extensions']`
  - **不要默认再传** `--load-extension` / `--disable-extensions-except`
  - `CEREBR_PW_HEADLESS=false` 时把窗口移出屏幕并最小化
- **禁止**为了图省事直接 raw `spawn chrome.exe --user-data-dir=...` 再赌它会隔离到独立实例；这个路径已经在真实机器上证明会偏航，可能把页面开进用户当前正在使用的 Chrome。
- 当前固定 profile 路径：`output/playwright/_profiles/chrome_stable_manual_extension_profile`
- 浏览器/CDP 回归脚本统一优先复用 `tests/lib/stable_chrome_sidebar_harness.cjs`，不要各自再造一套浏览器启动分支。
- 如果需要验证 **service worker / extension target / 更底层网络日志**，再走 **CDP**；但先确认浏览器实例里确实已经看到扩展 service worker。
- 打开侧栏后，**先等 sidebar 内部真正读到 API 配置**，再发消息。至少确认：
  - `window.apiConfigs.length > 0`
  - 目标 `baseUrl` 已正确写入
- **发消息优先直接对 sidebar iframe 里的 `#message-input` 执行 `fill(...)` + `press('Enter')`**。不要只依赖宿主页键盘事件，否则容易出现“只输入了换行/文本留在输入框里没有真正发送”的假阳性。
- **做嵌入式 sidebar 的视觉截图时，优先直接对 `sidebarFrame.locator('body')` 截图**。这条是已经被 session 历史证明过的有效路径；`page.screenshot(...)`、活动窗口截图、桌面区域截图都可能漏掉扩展 iframe，或者截到错误窗口。
- 如果 `locator('body').screenshot(...)` 因为 Playwright 的“等待稳定”卡住，优先先保留 DOM 状态断言与 `result.json`，然后再单独处理截图，不要把宿主页整页截图误当成 sidebar 视觉证据。
- `request_user_input` 的截图回归不要再临时拼命令，直接跑 `node tests/cdp_request_user_input_screenshot_probe.cjs . output/playwright/<case>`；脚本默认复用固定 stable Chrome profile，并输出 `panel/body` 两套截图与 `result.json`。
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

## External Source References
- 当用户明确说“参考 Codex”时，从 `C:\Users\wintermute\Documents\repos\codex-remote\reference\openai-codex` 获取对应源码与协议实现。
- 当用户明确说“参考 Claude Code”时，从 `C:\Users\wintermute\Downloads\claude-code-main\src` 获取对应源码实现。
- 当需要参考 Codex GUI、前端 webview 或界面交互实现时，从 `C:\Users\wintermute\Documents\repos\codex-remote\reference\openai-chatgpt-vscode-webview-restored` 获取对应前端源码。
