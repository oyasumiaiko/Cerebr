<p align="center">
  <img src="./icons/icon128.png" alt="Cerebr 图标" width="96" />
</p>

<h1 align="center">Cerebr</h1>

<p align="center">
  运行在 Chrome 中的网页上下文 AI Agent：对话、工具、Skill 与本地知识工作区合为一体。
</p>

<p align="center">
  <a href="./README_EN.md">English</a>
</p>

## 当前状态

Cerebr 目前仅支持以“已解压的扩展程序”方式本地加载，尚未发布到 Chrome 应用商店。这是一个快速迭代的个人项目，配置格式、工具协议和界面可能继续变化。

扩展需要访问当前页面、标签页、下载和用户脚本等浏览器能力，才能提供页面读取、截图与 Agent 代码执行。安装前请阅读 [`manifest.json`](./manifest.json) 并确认权限符合你的使用场景。

## Cerebr 是什么

Cerebr 不只是一个聊天侧栏。它把当前网页、PDF、图片、聊天历史、对话文件和可复用 Skill 组织成模型可以按需调用的 Agent 工作区。

| 能力 | 说明 |
| --- | --- |
| 网页上下文 | 读取当前网页或 PDF、获取页面截图、围绕划词内容建立线程，并在侧栏、停靠、全屏和独立页面间切换 |
| Agent 工具链 | 执行本地 function/custom tool，回传结果并自动继续 Responses 请求，直到模型给出最终回答 |
| 对话文件 | 创建、搜索、读取、补丁修改和复制当前对话中的持久化文件；移动与删除统一由补丁工具处理；支持本机文件或目录的只读映射 |
| Skill | 创建、编辑、启用、停用、挂载、删除和 ZIP 导出 Skill；支持纯指导型 Skill 与网页运行时 Skill |
| 多 API | 支持 OpenAI 兼容 Chat Completions、OpenAI Responses 和 Gemini，可配置多个连接源、模型与 API Key |
| 本地知识 | IndexedDB 聊天历史、全文搜索、分支与划词线程、图片相册、统计、备份与恢复 |

## 界面预览

### 侧栏主界面

<p align="center">
  <img src="./statics/readme/readme-main-ui.png" alt="Cerebr 侧栏主界面" width="860" />
</p>

### 网页与视频内容总结

<p align="center">
  <img src="./statics/readme/readme-one-click-summary.png" alt="在网页侧栏中总结视频内容" width="860" />
</p>

### 全屏对话与划词线程

<p align="center">
  <img src="./statics/readme/readme-fullscreen-thread-mode.png" alt="全屏对话与划词线程" width="860" />
</p>

### 聊天历史搜索

<p align="center">
  <img src="./statics/readme/readme-history-search-1.png" alt="聊天历史管理与全文搜索" width="860" />
</p>

## Agent 与工具

在“增强模式”中，Cerebr 会根据当前页面和配置向模型暴露可用工具。对于 Responses API，扩展会执行已授权的 `function_call` / `custom_tool_call`，把匹配的 output item 加入下一跳请求，并持续这一过程直到没有新的本地工具调用。

当前内置 17 个本地工具：16 个 function tool，以及 Freeform custom tool `apply_patch`：

| 类别 | 工具 |
| --- | --- |
| 页面与运行时 | `js_runtime_execute`、`page_content_read`、`pdf_content_read`、`webpage_screenshot`、`view_image` |
| 工具输出 | `read_tool_output`（按 cursor 继续读取被统一长度控制截断的后续页） |
| 对话文件 | `apply_patch`、`list_files`、`read_file`、`search_files`、`copy_file`；移动/改名和删除分别使用 `apply_patch` 的 `*** Move to:` 与 `*** Delete File:` |
| Skill | `skill_registry` |
| 用户交互 | `request_user_input` |
| 其他模型 | `list_askable_models`、`ask_other_ai` |
| 聊天历史 | `history_search`、`history_read` |

Agent 工作流还包括：

- 流式显示推理、工具调用、工具输出、错误与重试状态；工具执行期间可以追加 steer，普通消息也可以进入队列。
- 超长工具结果会分页缓存，模型通过内部 `read_tool_output` 游标继续读取，无需重新执行原工具。
- `request_user_input` 可以暂停当前工具链并展示结构化问题；回答后从原调用继续。
- 每个扩展工具都可在 Responses 设置中单独关闭，页面工具还会按照普通网页、PDF、独立页等运行环境自动收敛。
- “纯对话”API 模式只发送用户、系统与 AI 消息，不注入隐藏页面上下文，也不声明或执行工具。

完整参数、输出格式、副作用和信任边界见 [`docs/model-tools-contract.md`](./docs/model-tools-contract.md)。

## Skill 系统

Skill 是持久化在 IndexedDB 中的可复用能力包。每个 Skill 以 `SKILL.md` 作为说明入口，以 `manifest.json` 保存 Cerebr 的界面、匹配规则、启用状态和运行时配置，并可按需包含 `scripts/`、`references/`、`assets/` 等资源。

- **指导型 Skill**：向模型提供领域工作流、决策规则和资源导航，不直接执行代码。
- **网页运行时 Skill**：按 URL 规则匹配页面，并通过运行时入口向 `js_runtime_execute` 暴露可复用方法。
- **按需挂载**：模型可在 JS Runtime 中通过 `$invoke(skillName, methodName, ...args)` 调用；匹配且已启用的网页运行时 Skill 会在需要时自动挂载。
- **完整生命周期**：模型可创建脚手架、维护文件和删除 Skill；Skill 管理页可查看文件、启用或停用、在当前页重挂载，并将完整包下载为 ZIP。
- **内置 Skill Creator**：提供与 Cerebr 实际运行时一致的 Skill 创建、拆分、校验和渐进式披露指南。

## 代码执行

Cerebr 区分三种不同的执行环境，不会把它们静默混用：

| 环境 | 执行位置 | 适合任务 | 边界 |
| --- | --- | --- | --- |
| 宿主页 JS Runtime | 当前标签页的用户脚本环境 | 精确读取 DOM、表格、属性、可访问 frame，或执行页面级自动化 | 代码可能读取或改变当前页面；不是页面的主世界，也不是系统终端 |
| 隔离 JS Sandbox | 扩展的 sandbox iframe | 独立页或未绑定宿主页时的计算、解析和格式化 | 不能访问用户正在浏览的页面 DOM |
| Responses Code Interpreter | API 提供方托管容器 | Python 计算、数据处理与提供方支持的文件任务 | 由远端服务执行，能力、费用与数据策略取决于所用端点 |

本地 `js_runtime_execute` 执行 JavaScript，不提供本机 Shell、PowerShell、Python 或 Bash 终端。Skill 中的脚本也必须适配浏览器 JS Runtime；需要 Python 时应明确启用 Responses 的托管 `code_interpreter`。

## OpenAI Responses API

Cerebr 对 `/responses` 提供原生请求、流式解析、状态展示和多跳工具执行支持，并为常用官方字段提供结构化设置：

- `reasoning.effort` 快捷选择、reasoning summary、`text.verbosity`、`max_output_tokens`、`service_tier` 与 `truncation`。
- `store`、`background`、`conversation`、`previous_response_id`、prompt cache、`include` 与上下文 compaction 配置。
- `text.format` 结构化输出、`tool_choice` / `allowed_tools`、`parallel_tool_calls` 和额外 hosted、MCP、namespace tools JSON。
- 可独立启用官方 hosted tools：`web_search`、`code_interpreter`、`image_generation` 和 `tool_search`。
- 支持搜索来源、托管生图结果、工具 activity timeline、工具结果 replay、恢复性流重试和手动 `/compact`。
- Cerebr 自带的大多数 function tool 支持 `defer_loading`，可配合 hosted `tool_search` 按需加载，减少初始工具描述体积。

额外 Tools JSON 可以声明 provider-hosted、MCP 或 namespace 工具，但不能凭一段 JSON 为未知 client function 创造本地执行器；模型调用未接入的普通函数时会得到明确错误。不同 OpenAI 兼容代理对 Responses 字段和 hosted tools 的实现程度不同，请以实际端点为准。

## 其它对话与管理能力

- 网页/PDF 提取、页面截图、图片上传与查看、YouTube 字幕配合总结。
- Markdown、LaTeX、代码高亮、HTML 文件沙箱预览和流式增量渲染。
- 消息编辑、重新生成、插入、分支、复制、单条或多条长图导出。
- 划词线程、线程树、全屏分栏、停靠侧栏、独立聊天页和快捷键。
- URL 与内容全文搜索、置顶、图片相册、数据统计、导入导出和自动增量备份。
- 多连接源、多模型配置、收藏与排序、自定义请求参数、系统提示词和用户消息模板。

## 安装

1. 克隆仓库并初始化 submodule：

```powershell
git clone --recurse-submodules <仓库地址>
Set-Location Cerebr
```

如果已经克隆但缺少 submodule：

```powershell
git submodule update --init --recursive
```

2. 打开 `chrome://extensions`，启用“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择仓库根目录。
4. 点击扩展图标，或在 `chrome://extensions/shortcuts` 配置打开侧栏、总结页面、截图等快捷键。
5. 在“API 设置”中新增连接源和模型配置。使用 Agent 工具时选择“增强模式”；只需要显式消息对话时选择“纯对话”。

## API 配置

| 连接方式 | 默认协议 | 说明 |
| --- | --- | --- |
| OpenAI 兼容 | `chat/completions` | 适用于 OpenAI 兼容服务；支持流式响应、自定义参数和多 Key 轮询 |
| OpenAI Responses | `/responses` | 支持 reasoning、结构化输出、hosted tools、本地 Agent 工具链和高级上下文字段 |
| Gemini | `generateContent` / `streamGenerateContent` | 支持 Gemini 原生消息、图片、thinking 配置和结构化响应字段 |

API Key 和配置保存在 Chrome 扩展存储中；聊天历史、对话文件和 Skill 主要保存在本地 IndexedDB。请求、远程图片、`ask_other_ai` 以及 Responses hosted tools 会把相应数据发送到你配置的服务，请自行确认端点的隐私与费用策略。

## 开发与验证

项目基于 Chrome Extension Manifest V3，使用原生 JavaScript ES modules 和 CSS，无构建步骤。第三方前端库已保存在 `lib/`，Font Awesome 通过 git submodule 管理。

主要目录：

```text
src/extension/    service worker、content script、Skill/JS Runtime 管理
src/ui/           侧栏、设置、历史、文档与预览界面
src/core/         消息组合、流处理、Agent 生命周期与会话状态
src/api/          Chat Completions、Responses、Gemini 请求与设置
src/agent_tools/  本地 function tool 定义、执行与输出协议
src/storage/      IndexedDB 与持久化适配器
tests/            Node 契约测试与 Chrome/CDP 回归脚本
```

运行纯 Node 回归测试：

```powershell
node --test tests\*.test.cjs
```

浏览器回归应优先在普通宿主页中打开嵌入式侧栏，并复用 `tests/lib/` 中已有的 Chrome/Playwright harness。

## 许可证

本项目采用 [GNU General Public License v3.0](./LICENSE)。
