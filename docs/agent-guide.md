# Cerebr agent guide

[Overview](../README.md) · [简体中文](./agent-guide.zh-CN.md)

## Agent and tools

In Enhanced mode, Cerebr exposes tools according to the current page and API configuration. With the Responses API, the extension executes authorized `function_call` and `custom_tool_call` items, adds the matching output item to the next request, and continues until no new local tool call remains.

Cerebr currently registers 17 local tools: 16 function tools plus the Freeform custom tool `apply_patch`:

| Category | Tools |
| --- | --- |
| Page and runtime | `js_runtime_execute`, `page_content_read`, `pdf_content_read`, `webpage_screenshot`, `view_image` |
| Tool output | `read_tool_output` (continue pageable tool results from a cursor; not used for JS Runtime output) |
| Conversation files | `apply_patch`, `list_files`, `read_file`, `search_files`, `copy_file`; use `apply_patch` with `*** Move to:` or `*** Delete File:` to move/rename or delete files |
| Skills | `skill_registry` |
| User interaction | `request_user_input` |
| Other models | `list_askable_models`, `ask_other_ai` |
| Chat history | `history_search`, `history_read` |

The agent workflow also provides:

- Streaming reasoning, tool-call, tool-output, error, and retry status; users can steer a running tool loop or queue normal messages.
- Cursor-based paging for tools that support it. `js_runtime_execute` is instead capped at 5,000 characters; oversized full results stay in a bounded cache inside the current JS Runtime so a follow-up JavaScript call can search, filter, or aggregate them and return only the relevant compact result.
- Structured `request_user_input` prompts that pause the current tool chain and resume the original call after an answer.
- Per-tool switches in Responses settings, plus automatic environment filtering for normal pages, PDFs, and standalone contexts.
- A Pure Chat API mode that sends only user, system, and assistant messages, with no hidden page context, tool declarations, or tool execution.

For exact parameters, output formats, side effects, and trust boundaries, see [`docs/model-tools-contract.md`](./model-tools-contract.md).

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
