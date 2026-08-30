# Cerebr 模型工具当前契约

本文记录 Cerebr 当前发送给 Responses API 的本地工具协议、虚拟文件语义、工具输出和副作用边界。代码中的 definition builder、参数校验器和执行器是权威实现；本文只描述当前有效行为。

## 1. 总体规则

- Cerebr 当前注册 17 个稳定工具名。
- `apply_patch` 是 grammar-constrained Freeform custom tool；其余工具是 strict function tool。
- function tool 的每层 object schema 都使用 `additionalProperties: false`，所有声明字段都列入 `required`；可选值使用包含 `null` 的类型表达。
- 执行器再次校验参数类型、范围、组合条件和未知字段。未知字段不会被忽略。
- 带 namespace 的同名 function 不会命中 Cerebr 顶层本地工具。
- 只有当前请求 `tools` 中实际存在的工具定义才获得执行授权。
- 工具错误作为正常工具输出返回模型；本地工具错误不进入网络传输重试器。

## 2. 当前工具清单

| 工具 | 类型 | 作用 | 加载方式 |
| --- | --- | --- | --- |
| `js_runtime_execute` | function | 在宿主页或隔离 sandbox 中执行 JavaScript | 按需 |
| `read_tool_output` | function | 使用不透明 cursor 继续读取已经生成的超长工具结果 | 立即 |
| `apply_patch` | custom | 修改当前对话文件根或一个 Skill 文件根 | 立即 |
| `list_files` | function | 列出一个虚拟文件根中的路径 | 立即 |
| `read_file` | function | 读取一个虚拟文本文件的原始正文 | 立即 |
| `search_files` | function | 在一个虚拟文件根中按行搜索文本 | 立即 |
| `copy_file` | function | 在同一虚拟文件根内复制文件 | 按需 |
| `skill_registry` | function | 管理 Skill 生命周期并显式挂载 Skill | 按需 |
| `request_user_input` | function | 向用户显示结构化问题并等待回答 | 按需 |
| `view_image` | function | 读取本地图片并作为视觉输入继续分析 | 按需 |
| `list_askable_models` | function | 列出可供 `ask_other_ai` 调用的模型 | 按需 |
| `ask_other_ai` | function | 向已配置的其它模型发送问题 | 按需 |
| `history_search` | function | 搜索本地聊天历史索引 | 按需 |
| `history_read` | function | 读取聊天历史窗口 | 按需 |
| `webpage_screenshot` | function | 截取当前宿主页 | 按需，限宿主页环境 |
| `pdf_content_read` | function | 读取当前 PDF 页面内容 | 按需，限 PDF 环境 |
| `page_content_read` | function | 读取当前 HTML 页面正文 | 按需，限 HTML 环境 |

## 3. 统一工具输出

### 3.1 字符预算

支持分页的 function tool 使用 `max_output_chars`：

- 值必须是 `null` 或不小于 256 的安全整数。
- `read_file` 和 `page_content_read` 的默认值是 20000。
- 其它使用统一分页的 function tool 默认值是 5000。
- `copy_file` 没有 `max_output_chars`，因为成功输出固定为 `Success.`。
- `js_runtime_execute` 使用自身固定的 5000 字符上限，不使用 `read_tool_output`。

业务执行器始终先生成完整结果。分页只发生在最终序列化出口，不会重新执行工具，也不会重复副作用。

### 3.2 `read_tool_output`

参数：

- `cursor`：上一页返回的不透明 `next_cursor`。
- `max_output_chars`：本页预算；`null` 沿用上一页预算。

cursor 只引用本地内存中的已序列化结果。cursor 不存在或已失效时直接报错。

虚拟文件工具分页使用纯文本页头，文件正文中的 `<`、`>`、`&` 等字符保持原样。其它结构化工具继续使用 XML 页封装。

## 4. 虚拟文件环境

虚拟文件工具使用同一个 `environment_id` 选择文件根：

- `null`：当前对话文件根。
- `skill:<stable-key>`：指定 Skill 文件根；值必须使用规范 stable key 且不能包含首尾空白。

文件路径始终相对于所选根：

- 不接受绝对路径。
- 不接受空路径段、`.` 或 `..` 段。
- 普通文件路径不接受 glob 字符。
- `path_glob` 支持 `*`、`?` 和 `**`。
- 路径使用 `/` 分隔。

当前对话文件根中的 `local/...` 是用户显式挂载的本机只读映射：

- `list_files`、`read_file` 和 `search_files` 实时读取本机当前内容。
- `apply_patch` 不能修改 `local/...`。
- `copy_file` 可以把 `local/...` 源文件复制为普通对话文件，但目标不能位于 `local/...`。

Skill 文件根包含一个虚拟 `manifest.json` 和实际 package 文件。`manifest.json` 可以读取和通过 `apply_patch` 精确更新，但不能被删除、移动或作为 `copy_file` 目标。

## 5. `list_files`

参数：

- `environment_id: string | null`
- `path_glob: string | null`
- `max_output_chars: integer | null`

行为：

- 只列出路径，不读取正文。
- `path_glob=null` 或 `.` 表示整个根。
- 输出每行一个根相对路径。
- 无结果返回 `No files found.`。
- Skill 根中的 `manifest.json` 会作为一个正常可读路径列出。

## 6. `read_file`

参数：

- `environment_id: string | null`
- `path: string`
- `start_line: integer | null`
- `end_line: integer | null`
- `max_output_chars: integer | null`

行为：

- `start_line` 与 `end_line` 必须同时为 `null`，或同时为 1-based 整数。
- 两者为 `null` 时读取全文。
- 两者为整数时读取闭区间；`end_line` 不能小于 `start_line`。
- `start_line` 超过文件总行数时直接报错。
- 返回正文不添加行号。
- 返回正文保留源文件已有的 CRLF、LF 或 CR，不补写也不改写换行符。
- 输出首行只标明路径和实际读取范围，随后是文件原文。

## 7. `search_files`

参数：

- `environment_id: string | null`
- `pattern: string`
- `regex: boolean | null`
- `path_glob: string | null`
- `ignore_case: boolean | null`
- `context_lines: integer | null`
- `max_output_chars: integer | null`

行为：

- `pattern` 必须非空。
- `regex=true` 时按 JavaScript 正则表达式搜索；无效正则直接报错。
- `ignore_case=true` 时忽略大小写。
- `context_lines` 范围是 0-20，`null` 表示 0。
- 搜索以逻辑行为单位；同一行最多计为一次命中。
- 重叠或相邻的上下文窗口会合并。
- 输出按文件分组；命中行使用 `行号:正文`，上下文行使用 `行号-正文`。

## 8. `copy_file`

参数：

- `environment_id: string | null`
- `from: string`
- `to: string`

行为：

- 只在同一个文件根内复制。
- `from` 与 `to` 不能相同。
- 目标不存在时新增，已存在时覆盖。
- 所有读取和写入验证成功后才提交一次持久化事务。
- 成功输出固定为 `Success.`。

## 9. `apply_patch`

### 9.1 模型可见定义

模型可见 description 固定为：

```text
The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.
```

grammar 以 OpenAI Codex 提交 `63d213884daea50e4f74efc192cdc44f549b67d5` 为基准，只增加可选的 Cerebr Environment ID：

```text
*** Begin Patch
*** Environment ID: skill:<stable-key>
*** Update File: path
@@
-old
+new
*** End Patch
```

当前对话文件根不写 Environment ID。Skill 文件根必须写 Environment ID，并且该行只能紧跟 `*** Begin Patch`、最多一次且不能为空。

### 9.2 解析和验证

支持标准 Codex hunk：

- `*** Add File:`
- `*** Delete File:`
- `*** Update File:`
- `*** Move to:`
- `@@` 和带 context 的 `@@ ...`
- `*** End of File`

context 查找顺序与固定 Codex 基准一致：

1. 精确匹配。
2. 忽略行尾空白。
3. 忽略行首和行尾空白。
4. 使用 Codex 的 Unicode 标点规范化后匹配。

同一 patch 中不能让多个操作使用同一个源路径。全部 hunk 都针对调用开始时的同一份不可变文件快照验证，后一个 hunk 不能依赖前一个 hunk 尚未提交的结果。

### 9.3 执行顺序

写入顺序固定为：

1. parse：生成标准 hunk AST。
2. select environment：由 Environment ID 或缺省根唯一选择目标。
3. verify：读取目标环境当前 revision 和所有受影响文件，验证路径、context、move 目标和 manifest 约束。
4. prepare：在内存中生成完整新文件集合和变更摘要。
5. commit：只在前面全部成功后执行一次事务写入。

语法、context、路径、manifest 或 revision 错误都必须保持 `state_changed=false`，不能留下部分文件修改或增加 Skill revision。

### 9.4 成功和失败输出

成功输出：

```text
Success. Updated the following files:
A path
M path
D path
```

parser/verifier 失败直接返回权威错误文本，例如：

```text
apply_patch verification failed: invalid hunk at line 2, ...
```

```text
apply_patch verification failed: Failed to find expected lines in SKILL.md:
...
```

环境选择、runtime contract 或提交冲突返回其具体错误，不伪装成 context verification 错误。

### 9.5 跨上下文 runtime contract

当前契约：

- `contract_id: codex-apply-patch@63d2138/cerebr-v4`
- `wire_version: 4`
- `parser_revision: codex-63d2138-faithful-js-port`
- `grammar_revision: codex-63d2138-environment-id`
- `upstream_revision: 63d213884daea50e4f74efc192cdc44f549b67d5`

sidebar 在发送包含 `apply_patch` 的 Responses 请求前检查 background capability。Skill 写请求携带完整 runtime contract，background 在持久化前再次检查。任一字段不一致时返回：

- `code: APPLY_PATCH_RUNTIME_VERSION_MISMATCH`
- `reload_required: true`
- `state_changed: false`
- `retryable: false`

版本不一致不会发送模型请求、不会解析 Skill patch，也不会自动重载或自动重试。

## 10. Skill 文件语义

### 10.1 `manifest.json`

虚拟 manifest 的顶层字段必须精确为：

- `description`
- `interface`
- `match`
- `enabled`
- `instruction`
- `runtime`

嵌套字段必须精确为：

- `interface.display_name`
- `interface.short_description`
- `interface.default_prompt`
- `instruction.path`
- `runtime.entry_path`

manifest 必须是合法 JSON，不能缺字段或包含未知字段。`instruction.path` 必须指向真实 package 文件；非 null 的 `runtime.entry_path` 必须指向真实可执行 JavaScript 文件。移动或删除被引用文件时，patch 必须同时显式更新 manifest。

### 10.2 revision 与提交

- 每次成功 Skill 写入只增加一次 revision。
- 创建要求目标不存在。
- 修改和删除使用当前 revision 做 compare-and-swap。
- revision 已变化时返回 `SKILL_REVISION_CONFLICT`，不写入任何记录。
- manifest 文件索引与实际文件记录不一致时按存储损坏报错，不过滤记录继续运行。
- 空文本文件是合法 Skill 文件。

## 11. `skill_registry`

`skill_registry` 只管理 Skill 生命周期。当前 action：

- `list`
- `create_skill`
- `delete_skill`
- `enable_skill`
- `disable_skill`
- `mount_on_current_page`（仅宿主页环境）

统一参数：

- `action`
- `include_all_sites`
- `skill_name`
- `skill`
- `max_output_chars`

每个 action 只允许使用对应字段：

- `list` 使用 `include_all_sites`。
- `create_skill` 使用 `skill`，生成当前标准 scaffold。
- `delete_skill`、`enable_skill`、`disable_skill` 和 `mount_on_current_page` 使用规范化 `skill_name`。
- 不适用字段必须为 `null`。

`enable_skill`、`disable_skill` 和 `delete_skill` 只改变 Registry 状态，不暗中挂载或刷新当前页面。页面注入只由显式 `mount_on_current_page` 执行。

## 12. Responses 工具循环

每个本地工具调用都使用同一条 Responses continuation 流程：

1. 持久化模型发出的 tool call。
2. 执行工具。
3. 持久化 `function_call_output` 或 `custom_tool_call_output`。
4. 标记需要 follow-up。
5. 使用同一工具定义继续当前 Responses turn。
6. 模型决定下一步工具调用或最终回答。

`apply_patch` 的 `custom_tool_call_output.output` 始终是普通字符串。工具失败不会触发 conversation-level 自动重试，也不会注入额外纠错 prompt。

follow-up 收到 `response.completed`，但既没有 assistant 文本也没有新 tool call 时，记录 `EMPTY_TOOL_FOLLOWUP_RESPONSE`，不生成空 assistant 消息。

## 13. 验证要求

虚拟文件或 Skill 工具改动至少验证：

- 固定 Codex description 和 grammar fixture。
- parser 的 Add/Delete/Update/Move、多 hunk、CRLF、EOF、Unicode context 和精确行号。
- read 原文换行与无行号行为。
- search 按行命中、大小写、正则和上下文合并。
- 未知参数、非法组合和越界值直接失败。
- 会话文件单事务读验写。
- Skill revision compare-and-swap 与 manifest/文件一致性。
- patch 验证失败前后文件集合和 revision 完全一致。
- sidebar/background runtime contract 错位在网络或写入前失败。
- 失败工具输出后同一 Responses turn 可以继续读取、修正和完成最终回答。
- stable Chrome 固定 profile 中的宿主页内嵌 sidebar 回归。
