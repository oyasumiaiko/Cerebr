<p align="center">
  <img src="./icons/icon128.png" alt="Cerebr icon" width="96" />
</p>

<h1 align="center">Cerebr</h1>

<p align="center">
  A browser-context AI agent for Chrome, combining chat, tools, Skills, and a local knowledge workspace.
</p>

<p align="center">
  <a href="./README.md">简体中文</a>
</p>

## Project status

Cerebr is currently available only as a locally loaded unpacked extension. It is not published on the Chrome Web Store. This is a fast-moving personal project, so configuration formats, tool protocols, and UI behavior may continue to change.

The extension needs browser capabilities such as current-page access, tabs, downloads, and user scripts to provide page reading, screenshots, and agent code execution. Review [`manifest.json`](./manifest.json) before installation and make sure the permissions fit your use case.

## What Cerebr is

Cerebr is more than a chat sidebar. It turns the current web page, PDFs, images, chat history, conversation files, and reusable Skills into an agent workspace that a model can use on demand.

| Capability | Description |
| --- | --- |
| Web context | Read the current page or PDF, capture page screenshots, create threads from selected text, and switch among sidebar, docked, fullscreen, and standalone modes |
| Agent tool loop | Execute local function/custom tools, return their results, and automatically continue a Responses request until the model produces a final answer |
| Conversation files | Create, search, read, patch, copy, move, and delete persistent files attached to a conversation; mount local files or folders read-only |
| Skills | Create, edit, enable, disable, mount, delete, and export Skills as ZIP packages; supports guidance and page-runtime Skills |
| Multiple APIs | OpenAI-compatible Chat Completions, OpenAI Responses, and Gemini, with multiple connection sources, models, and API keys |
| Local knowledge | IndexedDB chat history, full-text search, branches and selection threads, image gallery, statistics, backup, and restore |

## Interface

### Sidebar

<p align="center">
  <img src="./statics/readme/readme-main-ui.png" alt="Cerebr sidebar" width="860" />
</p>

### Web and video summaries

<p align="center">
  <img src="./statics/readme/readme-one-click-summary.png" alt="Summarizing video content from a web sidebar" width="860" />
</p>

### Fullscreen chat and selection threads

<p align="center">
  <img src="./statics/readme/readme-fullscreen-thread-mode.png" alt="Fullscreen chat and selection threads" width="860" />
</p>

### Chat history search

<p align="center">
  <img src="./statics/readme/readme-history-search-1.png" alt="Chat history management and full-text search" width="860" />
</p>

## Agent and tools

In Enhanced mode, Cerebr exposes tools according to the current page and API configuration. With the Responses API, the extension executes authorized `function_call` and `custom_tool_call` items, adds the matching output item to the next request, and continues until no new local tool call remains.

Cerebr currently registers 18 local tools: 17 function tools plus the Freeform custom tool `apply_patch`:

| Category | Tools |
| --- | --- |
| Page and runtime | `js_runtime_execute`, `page_content_read`, `pdf_content_read`, `webpage_screenshot`, `view_image` |
| Conversation files | `apply_patch`, `list_files`, `read_file`, `search_files`, `copy_file`, `move_file`, `delete_file` |
| Skills | `skill_registry` |
| User interaction | `request_user_input` |
| Other models | `list_askable_models`, `ask_other_ai` |
| Chat history | `history_search`, `history_read` |

The agent workflow also provides:

- Streaming reasoning, tool-call, tool-output, error, and retry status; users can steer a running tool loop or queue normal messages.
- Cursor-based paging for oversized tool results through the internal `read_tool_output` tool, without rerunning the original operation.
- Structured `request_user_input` prompts that pause the current tool chain and resume the original call after an answer.
- Per-tool switches in Responses settings, plus automatic environment filtering for normal pages, PDFs, and standalone contexts.
- A Pure Chat API mode that sends only user, system, and assistant messages, with no hidden page context, tool declarations, or tool execution.

For exact parameters, output formats, side effects, and trust boundaries, see [`docs/model-tools-contract.md`](./docs/model-tools-contract.md).

## Skill system

Skills are reusable capability packages persisted in IndexedDB. Each Skill uses `SKILL.md` as its instruction entry point and `manifest.json` for Cerebr UI metadata, URL matching, enabled state, and runtime configuration. A package can also include resources such as `scripts/`, `references/`, and `assets/`.

- **Guidance Skills** provide domain workflows, decision rules, and resource navigation without executing code directly.
- **Page-runtime Skills** match URL rules and expose reusable methods to `js_runtime_execute` through a JavaScript runtime entry point.
- **On-demand mounting** lets the model call `$invoke(skillName, methodName, ...args)` inside the JS Runtime; matching enabled page-runtime Skills mount automatically when needed.
- **Full lifecycle support** lets the model scaffold and maintain files or delete Skills, while the Skill manager can inspect, enable, disable, remount on the current page, and download complete packages as ZIP files.
- **Built-in Skill Creator** documents a Cerebr-native workflow for creating, splitting, validating, and progressively disclosing Skill content.

## Code execution

Cerebr keeps three execution environments distinct:

| Environment | Runs in | Best for | Boundary |
| --- | --- | --- | --- |
| Bound-page JS Runtime | User-script environment in the current tab | Precise DOM, table, attribute, accessible-frame, and page automation tasks | Code may read or modify the current page; this is not the page main world or a system terminal |
| Isolated JS Sandbox | Extension sandbox iframe | Computation, parsing, and formatting when no host page is bound | Cannot access the DOM of the page the user is browsing |
| Responses Code Interpreter | Provider-hosted container | Python computation, data processing, and provider-supported file tasks | Runs remotely; capabilities, cost, and data policy depend on the endpoint |

Local `js_runtime_execute` runs JavaScript. It does not provide a local Shell, PowerShell, Python, or Bash terminal. Scripts shipped in Skills must be adapted to the browser JS Runtime; Python execution requires explicitly enabling the hosted Responses `code_interpreter`.

## OpenAI Responses API

Cerebr provides native `/responses` request construction, streaming parsing, status rendering, and multi-hop tool execution. Structured settings cover commonly used official fields:

- Quick `reasoning.effort` selection, reasoning summaries, `text.verbosity`, `max_output_tokens`, `service_tier`, and `truncation`.
- `store`, `background`, `conversation`, `previous_response_id`, prompt caching, `include`, and context compaction configuration.
- Structured `text.format`, `tool_choice` / `allowed_tools`, `parallel_tool_calls`, and extra hosted, MCP, or namespace Tools JSON.
- Independently configurable hosted tools: `web_search`, `code_interpreter`, `image_generation`, and `tool_search`.
- Search sources, hosted image results, a tool activity timeline, tool-result replay, recoverable stream retries, and manual `/compact`.
- `defer_loading` for most built-in local function tools, allowing hosted `tool_search` to load them on demand and reduce the initial tool-description payload.

Extra Tools JSON can declare provider-hosted, MCP, or namespace tools, but JSON alone cannot create a local executor for an unknown client function. Calls to unsupported client functions return an explicit error. Support for Responses fields and hosted tools varies across OpenAI-compatible proxies, so verify behavior against the endpoint you use.

## More chat and management features

- Web/PDF extraction, page screenshots, image upload and inspection, and YouTube summaries with subtitle extensions.
- Markdown, LaTeX, syntax highlighting, sandboxed HTML-file previews, and incremental streaming rendering.
- Message editing, regeneration, insertion, branching, copying, and single- or multi-message long-image export.
- Selection threads, thread trees, fullscreen split views, docked sidebars, standalone chat, and keyboard shortcuts.
- URL and content search, pinning, image gallery, data statistics, import/export, and automatic incremental backup.
- Multiple connection sources and model profiles, favorites and ordering, custom request parameters, system prompts, and user-message templates.

## Installation

1. Clone the repository and initialize its submodule:

```powershell
git clone --recurse-submodules <repo-url>
Set-Location Cerebr
```

If the repository was already cloned without submodules:

```powershell
git submodule update --init --recursive
```

2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the repository root.
4. Click the extension icon, or configure shortcuts at `chrome://extensions/shortcuts` for opening the sidebar, summarizing pages, taking screenshots, and more.
5. Add a connection source and model in **API Settings**. Choose **Enhanced** for agent tools, or **Pure Chat** when only explicit conversation messages should be sent.

## API configuration

| Connection | Default protocol | Notes |
| --- | --- | --- |
| OpenAI-compatible | `chat/completions` | OpenAI-compatible services, with streaming, custom parameters, and multi-key rotation |
| OpenAI Responses | `/responses` | Reasoning, structured output, hosted tools, the local agent tool loop, and advanced context fields |
| Gemini | `generateContent` / `streamGenerateContent` | Native Gemini messages, images, thinking configuration, and structured response fields |

API keys and configuration are stored in Chrome extension storage. Chat history, conversation files, and Skills are primarily stored in local IndexedDB. Requests, remote images, `ask_other_ai`, and Responses hosted tools send relevant data to configured services; review each endpoint's privacy and billing policy.

## Development and verification

Cerebr is a Chrome Extension Manifest V3 project built with native JavaScript ES modules and CSS. It has no build step. Browser libraries are vendored under `lib/`, and Font Awesome is managed as a git submodule.

Main directories:

```text
src/extension/    service worker, content script, Skill and JS Runtime management
src/ui/           sidebar, settings, history, document, and preview UI
src/core/         message composition, streaming, agent lifecycle, and conversation state
src/api/          Chat Completions, Responses, and Gemini requests and settings
src/agent_tools/  local function-tool definitions, execution, and output contracts
src/storage/      IndexedDB and persistence adapters
tests/            Node contract tests and Chrome/CDP regression scripts
```

Run the pure Node regression suite:

```powershell
node --test tests\*.test.cjs
```

Browser regressions should exercise the embedded sidebar on a normal host page and reuse the Chrome/Playwright harnesses under `tests/lib/`.

## License

This project is licensed under the [GNU General Public License v3.0](./LICENSE).
