/**
 * Responses 自定义工具与 hosted tool_search 的桥接辅助。
 *
 * 设计目标：
 * - 把“是否启用 hosted tool_search”与“哪些本地 function tool 需要改成 defer_loading”
 *   统一收口到纯函数里，避免散落在 sender 里写一堆 if/else；
 * - 保持默认行为向下兼容：未启用 hosted tool_search 时，继续按原来的立即暴露工具定义发送；
 * - 一旦请求体里已经包含 `{ type: "tool_search" }`，则把选中的 function tools 标记为
 *   `defer_loading: true`，让 OpenAI 服务端真正能搜索并按需加载这些工具。
 */

function normalizeString(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const next = [];
  value.forEach((item) => {
    const text = normalizeString(item).toLowerCase();
    if (!text || seen.has(text)) return;
    seen.add(text);
    next.push(text);
  });
  return next;
}

function cloneJsonCompatible(value) {
  if (value == null) return value ?? null;
  try {
    return structuredClone(value);
  } catch (_) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  }
}

/**
 * 判断当前请求体的 tools 中是否已经启用了 hosted tool_search。
 *
 * 说明：
 * - 这里故意只看“最终 requestBody.tools”，而不是回头猜配置开关；
 * - 这样无论 `{ type: "tool_search" }` 来自 UI 结构化开关，还是用户手写的 Tools JSON，
 *   最终都能走同一条兼容逻辑。
 *
 * @param {Array<any>|null|undefined} tools
 * @returns {boolean}
 */
export function hasResponsesHostedToolSearchTool(tools) {
  if (!Array.isArray(tools)) return false;
  return tools.some((tool) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return false;
    return normalizeString(tool.type).toLowerCase() === 'tool_search';
  });
}

/**
 * 在 hosted tool_search 场景下，把指定的本地 function tools 改成 defer_loading。
 *
 * 设计取向：
 * - 这里只负责给“已经存在的 function tool definition”补 `defer_loading: true`；
 * - 不擅自改 name / description / parameters，避免破坏现有本地执行契约；
 * - 默认返回克隆后的新数组，避免调用方误改原始定义。
 *
 * @param {Array<any>|null|undefined} tools
 * @param {{
 *   hostedToolSearchEnabled?: boolean,
 *   searchableToolNames?: Array<string>
 * }} [options]
 * @returns {Array<any>}
 */
export function adaptResponsesCustomFunctionToolsForHostedToolSearch(tools, options = {}) {
  const source = Array.isArray(tools) ? tools : [];
  const hostedToolSearchEnabled = options?.hostedToolSearchEnabled === true;
  const searchableToolNameSet = new Set(normalizeStringArray(options?.searchableToolNames));

  return source.map((tool) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
      return tool;
    }

    const clonedTool = cloneJsonCompatible(tool);
    if (!hostedToolSearchEnabled) {
      return clonedTool;
    }

    const toolType = normalizeString(clonedTool.type).toLowerCase();
    const toolName = normalizeString(clonedTool.name).toLowerCase();
    const isSearchableFunction = toolType === 'function'
      && toolName
      && (searchableToolNameSet.size <= 0 || searchableToolNameSet.has(toolName));

    if (isSearchableFunction) {
      clonedTool.defer_loading = true;
    }

    return clonedTool;
  });
}
