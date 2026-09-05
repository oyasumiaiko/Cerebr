# Cerebr Agent 使用指南

[项目介绍](../README_ZH.md) · [English](./agent-guide.md)

## Agent 与工具

在“增强模式”中，Cerebr 会根据当前页面和配置向模型暴露可用工具。对于 Responses API，扩展会执行已授权的 `function_call` / `custom_tool_call`，把匹配的 output item 加入下一跳请求，并持续这一过程直到没有新的本地工具调用。

当前内置 17 个本地工具：16 个 function tool，以及 Freeform custom tool `apply_patch`：

| 类别 | 工具 |
| --- | --- |
| 页面与运行时 | `js_runtime_execute`、`page_content_read`、`pdf_content_read`、`webpage_screenshot`、`view_image` |
| 工具输出 | `read_tool_output`（按 cursor 继续读取支持分页的工具结果；不用于 JS Runtime 输出） |
| 对话文件 | `apply_patch`、`list_files`、`read_file`、`search_files`、`copy_file`；移动/改名和删除分别使用 `apply_patch` 的 `*** Move to:` 与 `*** Delete File:` |
| Skill | `skill_registry` |
| 用户交互 | `request_user_input` |
| 其他模型 | `list_askable_models`、`ask_other_ai` |
| 聊天历史 | `history_search`、`history_read` |

Agent 工作流还包括：

- 流式显示推理、工具调用、工具输出、错误与重试状态；工具执行期间可以追加 steer，普通消息也可以进入队列。
- 支持分页的超长工具结果会缓存并通过内部 `read_tool_output` 续读；`js_runtime_execute` 固定最多返回 5000 字符，超限完整结果保存在当前 JS Runtime 的有界缓存中，模型用后续 JavaScript 搜索、筛选或聚合后只取相关小结果。
- `request_user_input` 可以暂停当前工具链并展示结构化问题；回答后从原调用继续。
- 每个扩展工具都可在 Responses 设置中单独关闭，页面工具还会按照普通网页、PDF、独立页等运行环境自动收敛。
- “纯对话”API 模式只发送用户、系统与 AI 消息，不注入隐藏页面上下文，也不声明或执行工具。

完整参数、输出格式、副作用和信任边界见 [`docs/model-tools-contract.md`](./model-tools-contract.md)。

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
