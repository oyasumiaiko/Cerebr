<h1 align="center">Cerebr</h1>

<p align="center"><strong>浏览器里的开源 AI 工作区。</strong></p>
<p align="center">读取网页，执行 JavaScript，构建可复用 Skill，留下有用的成果。</p>

<p align="center">
  <a href="./README.md">English</a> · <strong>简体中文</strong><br />
  <a href="#可以用它做什么">使用场景</a> · <a href="#快速开始">快速开始</a> · <a href="./docs/agent-guide.zh-CN.md">Agent 指南</a> · <a href="https://github.com/oyasumiaiko/Cerebr/issues">问题反馈</a>
</p>

<p align="center">
  <img src="./statics/readme/cerebr-hero.svg" alt="Cerebr 工作流：读取网页、执行 JavaScript，将成果保存为文件与可复用 Skill" width="860" />
</p>

Cerebr 把 AI Agent 带到你正在使用的网页里。它能读取页面内容，按任务编写并执行操作真实 DOM 的 JavaScript，维护持久化的对话文件，再把重复工作整理为可复用的 Skill。这些都在 Chrome 侧栏中完成。

**Agent 运行时与工作区在浏览器内运行。** 模型通过你配置的 API 服务调用，无需额外部署 Cerebr 后端或本地自动化服务。

## 为什么做 Cerebr

文档、文章、数据看板、PDF 和 Web 应用，已经承载了我们大量的日常工作。Cerebr 将这些现场上下文交给 Agent，让它在同一个工作区里读取、操作，并保存有用的结果。

- **围绕真实页面工作。** 模型可以检查 DOM、提取结构化数据、执行计算，并通过 JavaScript 操作网页控件。
- **把工作方法积累下来。** 将指令、参考资料和浏览器方法打包为 Skill，按网站匹配和复用。
- **保留答案，也保留成果。** 对话旁的文件可以继续编辑，历史工作可以搜索，分支和划词线程让延伸问题有自己的空间。
- **自由选择模型。** 支持 OpenAI Responses、OpenAI 兼容 Chat Completions 和 Gemini；Responses 增强模式提供本地 Agent 工具闭环。

## 可以用它做什么

以下提示词展示了 Cerebr 工具支持的工作方式。网页交互的实际效果取决于网站 DOM、浏览器权限和所选模型。

| 场景 | 可以这样问 |
| --- | --- |
| **把网页变成可用数据** | “提取这张表格，用 JavaScript 统一数值格式，保存为 CSV 对话文件。” |
| **操作网页界面** | “检查这个页面的筛选项，选择我描述的条件，告诉我结果发生了什么变化。” |
| **带着上下文阅读** | “总结这份 PDF，解释我划选的段落，把追问放到单独的线程里。” |
| **创建网站专用 Skill** | “把这次提取流程保存成 Skill，下次打开这个网站时继续用。” |
| **接着之前的研究做** | “找到我们之前对这个主题的讨论，把相关结论整理成可编辑的 Markdown 笔记。” |
| **听听另一个模型的意见** | “请另一个已配置的模型审阅这段解释，再比较你们的结论。” |

### 从网页到工作成果

读取表格、计算覆盖率、标记需要关注的行，再保存为报告，整个过程都在当前页面完成。

<p align="center">
  <img src="./statics/readme/readme-browser-demo.png" alt="Cerebr 嵌入示例文档表格页面，并将页面截图作为 Agent 上下文" width="860" />
</p>

<details>
<summary><strong>近距离查看 Agent 工作区</strong></summary>

<p align="center">
  <img src="./statics/readme/readme-agent-demo.png" alt="真实 Cerebr 侧栏中的文档审计对话与工具活动" width="860" />
</p>

</details>

*演示使用示例数据与预设的模型响应，可重复运行；JavaScript 和文件工具在真实扩展中执行。界面控件目前为中文，完整英文界面本地化尚未提供。*

## 可以持续扩展的浏览器 Agent

### 用 JavaScript 处理真实页面

在绑定网页的侧栏中，`js_runtime_execute` 通过 Chrome 用户脚本环境运行模型编写的 JavaScript，可以访问网页 DOM 和浏览器 Web API。模型能检查结构、提取数据、计算结果和操作元素；返回值、日志和错误会回到对话，供它决定下一步。

运行时支持 `await`、显式跨调用状态复用和可访问的 frame。未绑定宿主页时，独立的 JavaScript 沙箱负责计算与解析。页面执行不提供本机 Shell；服务端托管 Python 是单独的可选能力。

### 让 Skill 随工作流一起成长

每个 Skill 以 `SKILL.md` 描述使用方法，也可包含脚本、参考资料和资源文件。指导型 Skill 定义任务方法；网页运行时 Skill 提供可复用 JavaScript 方法和 URL 匹配规则。Agent 可以创建、维护这些能力包，再通过 `$invoke(...)` 调用其中的方法。

Skill 管理页支持查看文件、启用或停用、在当前页重挂载，并将完整包导出为 ZIP。

### 把工作成果留在工作区

对话文件支持读取、搜索、复制和原子化 `apply_patch` 修改，也支持将本机文件或目录以只读方式挂载。聊天、文件与 Skill 持久化在本地 IndexedDB 中，配合历史搜索、分支、导入导出与备份工具，让后续工作有据可依。

### 原生支持 OpenAI Responses

Cerebr 实现了 Responses 请求与流式处理的完整生命周期，包括本地工具的多轮执行和后续请求。你可以查看工具活动和错误，回答结构化问题，也可以在任务执行期间追加指示。

支持推理参数、结构化输出、上下文压缩、按需工具加载，以及可选的服务端网页搜索、Code Interpreter 和图像生成。托管能力取决于所配置端点的支持情况。

API 设置和运行时细节见 **[Agent 指南](./docs/agent-guide.zh-CN.md)**；精确参数、文件语义和执行边界见 **[模型工具契约](./docs/model-tools-contract.md)**。

## 快速开始

需要当前版本的 Chrome，以及所选模型的 API 服务地址和密钥。Cerebr 目前通过源码加载为已解压扩展。

1. 克隆仓库并初始化资源子模块：

   ```sh
   git clone --recurse-submodules https://github.com/oyasumiaiko/Cerebr.git
   cd Cerebr
   ```

2. 打开 `chrome://extensions`，启用**开发者模式**，点击**加载已解压的扩展程序**，选择仓库目录。
3. 如需执行网页 JavaScript，若 Chrome 在扩展详情中提供 **Allow User Scripts / 允许用户脚本** 开关，请将其开启。
4. 打开普通网页并点击 Cerebr 扩展图标，在 **API 设置**中添加连接源、API Key 和模型。
5. 使用 Agent 工具时，选择 **OpenAI Responses** 和**增强模式**。可以先问：“读取这个页面，告诉我你能帮我做哪些事情。”

无需构建。若此前克隆时遗漏子模块，运行 `git submodule update --init --recursive`。快捷键可在 `chrome://extensions/shortcuts` 配置。

### 模型与连接方式

| 连接方式 | 适用能力 |
| --- | --- |
| **OpenAI Responses** | 本地 Agent 工作流、推理控制、结构化输出，以及端点支持的托管工具 |
| **OpenAI 兼容 Chat Completions** | 兼容服务的流式对话与自定义请求参数 |
| **Gemini** | 原生 Gemini 对话、图片和 thinking 设置 |

可以同时保存多个连接源与模型配置。**纯对话**模式仅发送显式对话消息，不注入网页上下文或执行工具。

### 数据与权限

聊天历史、对话文件和 Skill 主要保存在本地 IndexedDB；API Key 与配置使用 Chrome 扩展存储，其中启用同步的配置会使用 Chrome Sync。模型请求和托管工具会将相关数据发往你配置的服务；本地存储不代表离线推理。

页面脚本可以读取和修改当前网页。请查看[扩展权限](./manifest.json)，选择需要启用的工具，并使用代码可信的 Skill。执行环境和工具行为在 [Agent 指南](./docs/agent-guide.zh-CN.md#代码执行)中有详细说明。

## 开放的实现

Cerebr 使用 **Manifest V3、原生 JavaScript ES modules 与 CSS**，前端依赖随仓库提供，无构建流程。浏览器运行时、工具契约和持久化实现都可直接阅读与修改。

| 模块 | 源码 |
| --- | --- |
| 浏览器集成、JavaScript 运行时与 Skill | [`src/extension/`](./src/extension/) |
| Agent 生命周期、消息与会话状态 | [`src/core/`](./src/core/) |
| API 协议与模型配置 | [`src/api/`](./src/api/) |
| 本地工具及契约 | [`src/agent_tools/`](./src/agent_tools/) |
| 侧栏、预览、设置与历史 | [`src/ui/`](./src/ui/) |
| 持久化与回归验证 | [`src/storage/`](./src/storage/) · [`tests/`](./tests/) |

贡献者可运行 `node --test tests/*.test.cjs` 执行 Node 回归测试。浏览器回归复用 [`tests/lib/`](./tests/lib/) 中的 Chrome/Playwright harness，在真实宿主页中验证嵌入式侧栏。开发流程见[仓库指南](./AGENTS.md)。

欢迎提交问题、可复现的网页案例、Skill 示例、文档改进和范围清晰的 Pull Request。[反馈问题](https://github.com/oyasumiaiko/Cerebr/issues)，或[查看开发历史](https://github.com/oyasumiaiko/Cerebr/commits/main/)。

## 项目来源与许可证

本项目起步于 [yym68686/Cerebr](https://github.com/yym68686/Cerebr) 的 fork，由 [oyasumiaiko](https://github.com/oyasumiaiko) 独立维护，现已发展为包含 JavaScript 执行、可复用 Skill、对话文件和原生 Responses 工具编排的浏览器 Agent 工作区。感谢原作者和贡献者提供的基础。

本项目采用 [GNU General Public License v3.0](./LICENSE)。
