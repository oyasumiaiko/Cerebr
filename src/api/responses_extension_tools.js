/**
 * Responses API 扩展提供工具注册表。
 *
 * 设计目标：
 * - 把 Cerebr 暴露给 Responses API 的本地 function/custom tools 统一登记到一个纯模块里；
 * - 让 API 设置 UI、请求构建和 sender 的自动注入逻辑共用同一份工具元数据，
 *   避免工具名、默认值、说明文案散落在多个文件后逐渐失配；
 * - 默认采用“全开 + 只持久化显式关闭项”的兼容策略，保证老配置升级后不会突然丢失工具。
 */

function normalizeString(value) {
  return (typeof value === 'string') ? value.trim() : '';
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

function createExtensionToolSpec(spec) {
  return Object.freeze({
    defaultEnabled: true,
    toolType: 'function',
    ...spec
  });
}

function matchesExtensionToolDefinition(tool, spec) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool) || !spec) return false;
  return normalizeString(tool.type).toLowerCase() === normalizeString(spec.toolType).toLowerCase()
    && !normalizeString(tool.namespace)
    && normalizeString(tool.name) === spec.id;
}

export const RESPONSES_EXTENSION_TOOL_SPECS = Object.freeze([
  createExtensionToolSpec({
    id: 'js_runtime_execute',
    title: 'JS Runtime 执行',
    description: '允许模型在宿主页 JS 环境或侧栏隔离 sandbox 中执行 JavaScript。',
    exposure: 'js_runtime',
    handlerKey: 'js_runtime_execute',
    outputKind: 'js_runtime',
    sideEffect: 'execute',
    deferLoading: true
  }),
  createExtensionToolSpec({
    id: 'read_tool_output',
    title: '续读工具输出',
    description: '允许模型通过游标继续读取支持分页的超长工具结果；不适用于 js_runtime_execute，JS 超限结果必须在运行时内搜索筛选。',
    exposure: 'always',
    handlerKey: 'read_tool_output',
    outputKind: 'tool_output_page',
    sideEffect: 'read',
    deferLoading: false,
    alwaysEnabled: true,
    configurable: false
  }),
  createExtensionToolSpec({
    id: 'apply_patch',
    title: '虚拟文件 Apply Patch',
    description: '允许模型对可写虚拟文件执行补丁式修改。',
    exposure: 'always',
    handlerKey: 'virtual_file',
    outputKind: 'virtual_file',
    sideEffect: 'write',
    toolType: 'custom',
    deferLoading: false
  }),
  createExtensionToolSpec({
    id: 'list_files',
    title: '虚拟文件列目录',
    description: '允许模型列出虚拟文件空间中的文件。',
    exposure: 'always',
    handlerKey: 'virtual_file',
    outputKind: 'virtual_file',
    sideEffect: 'read',
    deferLoading: false
  }),
  createExtensionToolSpec({
    id: 'read_file',
    title: '虚拟文件读文件',
    description: '允许模型读取虚拟文件空间中的文件内容。',
    exposure: 'always',
    handlerKey: 'virtual_file',
    outputKind: 'virtual_file',
    sideEffect: 'read',
    deferLoading: false
  }),
  createExtensionToolSpec({
    id: 'search_files',
    title: '虚拟文件搜索',
    description: '允许模型在虚拟文件空间中按文本搜索。',
    exposure: 'always',
    handlerKey: 'virtual_file',
    outputKind: 'virtual_file',
    sideEffect: 'read',
    deferLoading: false
  }),
  createExtensionToolSpec({
    id: 'copy_file',
    title: '虚拟文件复制',
    description: '允许模型把虚拟文件复制到新的虚拟路径。',
    exposure: 'always',
    handlerKey: 'virtual_file',
    outputKind: 'virtual_file',
    sideEffect: 'write',
    deferLoading: true
  }),
  createExtensionToolSpec({
    id: 'skill_registry',
    title: 'Skill Registry',
    description: '允许模型列出、创建、启用、停用、删除和挂载 Cerebr Skill。',
    exposure: 'always',
    handlerKey: 'skill_registry',
    outputKind: 'skill_registry',
    sideEffect: 'mixed',
    deferLoading: true
  }),
  createExtensionToolSpec({
    id: 'request_user_input',
    title: '请求用户输入',
    description: '允许模型在需要确认时弹出结构化问题，等待用户选择或填写。',
    exposure: 'always',
    handlerKey: 'request_user_input',
    outputKind: 'request_user_input',
    sideEffect: 'interactive',
    deferLoading: true
  }),
  createExtensionToolSpec({
    id: 'view_image',
    title: '查看本地图像',
    description: '允许模型读取本地图片文件并作为视觉输入继续分析。',
    exposure: 'always',
    handlerKey: 'view_image',
    outputKind: 'view_image',
    sideEffect: 'network',
    deferLoading: true
  }),
  createExtensionToolSpec({
    id: 'list_askable_models',
    title: '列出可追问模型',
    description: '允许模型查看当前可通过 ask_other_ai 访问的配置。',
    exposure: 'always',
    handlerKey: 'list_askable_models',
    outputKind: 'askable_models',
    sideEffect: 'read',
    deferLoading: true
  }),
  createExtensionToolSpec({
    id: 'ask_other_ai',
    title: '询问其他模型',
    description: '允许模型把整理后的问题转发给其他已配置模型。',
    exposure: 'always',
    handlerKey: 'ask_other_ai',
    outputKind: 'ask_other_ai',
    sideEffect: 'network',
    deferLoading: true
  }),
  createExtensionToolSpec({
    id: 'history_search',
    title: '搜索聊天历史',
    description: '允许模型按关键词搜索本地聊天历史索引。',
    exposure: 'always',
    handlerKey: 'history_search',
    outputKind: 'history_search',
    sideEffect: 'read',
    deferLoading: true
  }),
  createExtensionToolSpec({
    id: 'history_read',
    title: '读取聊天历史',
    description: '允许模型按会话或命中结果读取聊天历史内容。',
    exposure: 'always',
    handlerKey: 'history_read',
    outputKind: 'history_read',
    sideEffect: 'read',
    deferLoading: true
  }),
  createExtensionToolSpec({
    id: 'webpage_screenshot',
    title: '网页截图',
    description: '允许模型对当前宿主页执行截图并消费图像结果。',
    exposure: 'host_page',
    handlerKey: 'webpage_screenshot',
    outputKind: 'webpage_screenshot',
    sideEffect: 'read',
    deferLoading: true
  }),
  createExtensionToolSpec({
    id: 'pdf_content_read',
    title: 'PDF 读取',
    description: '允许模型读取当前页面中的 PDF 内容。',
    exposure: 'pdf_page',
    handlerKey: 'pdf_content_read',
    outputKind: 'pdf_content',
    sideEffect: 'read',
    deferLoading: true
  }),
  createExtensionToolSpec({
    id: 'page_content_read',
    title: '页面内容读取',
    description: '允许模型读取当前宿主页的结构化文本内容。',
    exposure: 'html_page',
    handlerKey: 'page_content_read',
    outputKind: 'page_content',
    sideEffect: 'read',
    deferLoading: true
  })
]);

const RESPONSES_EXTENSION_TOOL_SPEC_BY_ID = new Map(
  RESPONSES_EXTENSION_TOOL_SPECS.map(spec => [spec.id, spec])
);

/**
 * 按稳定工具名读取 manifest 条目。调用方只读使用冻结对象，不得在执行链临时改写。
 *
 * @param {string} toolId
 * @returns {Object|null}
 */
export function getResponsesExtensionToolSpec(toolId) {
  return RESPONSES_EXTENSION_TOOL_SPEC_BY_ID.get(normalizeString(toolId)) || null;
}

/**
 * 解析一个 Responses function_call 是否属于 Cerebr 顶层本地工具。
 * namespace 非空时始终返回 null，防止外部 namespace 中的同名函数误命中本地 handler。
 *
 * @param {string} toolName
 * @param {string|null|undefined} namespace
 * @returns {Object|null}
 */
export function resolveResponsesExtensionToolSpecForCall(toolName, namespace) {
  if (normalizeString(namespace)) return null;
  return getResponsesExtensionToolSpec(toolName);
}

/**
 * 只有本轮最终 request.tools 中实际存在的顶层本地 definition 才能获得执行授权。
 * 这让“关闭工具/页面不可用”不仅影响提示给模型的列表，也约束收到响应后的副作用。
 *
 * @param {string} toolName
 * @param {string|null|undefined} namespace
 * @param {Array<any>|null|undefined} requestTools
 * @returns {Object|null}
 */
export function resolveAuthorizedResponsesExtensionToolSpec(toolName, namespace, requestTools, toolType = 'function') {
  const spec = resolveResponsesExtensionToolSpecForCall(toolName, namespace);
  if (!spec) return null;
  if (normalizeString(toolType).toLowerCase() !== normalizeString(spec.toolType).toLowerCase()) {
    return null;
  }
  const exposed = (Array.isArray(requestTools) ? requestTools : []).some(tool => (
    matchesExtensionToolDefinition(tool, spec)
  ));
  return exposed ? spec : null;
}

function inspectAllowedLocalExtensionToolEntry(entry) {
  if (typeof entry === 'string') {
    const name = normalizeString(entry);
    return RESPONSES_EXTENSION_TOOL_SPEC_BY_ID.has(name)
      ? { id: name, typeMatches: true }
      : null;
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const namespace = normalizeString(entry.namespace);
  if (namespace) return null;
  const name = normalizeString(entry.name);
  const spec = RESPONSES_EXTENSION_TOOL_SPEC_BY_ID.get(name);
  if (!spec) return null;
  // 名称属于本地注册表但类型已漂移时也要参与对账；否则旧 function apply_patch
  // 会在 custom definition 切换后残留在 allowed_tools 中。
  return {
    id: name,
    typeMatches: matchesExtensionToolDefinition(entry, spec)
  };
}

/**
 * 让 `tool_choice.type=allowed_tools` 与最终实际暴露的本地 function 列表保持一致。
 *
 * 页面环境与扩展开关会在请求最后阶段裁掉部分本地工具。如果 allowed_tools 仍引用
 * 这些工具，上游会收到“允许/要求一个未定义工具”的矛盾请求。这里仅处理 Cerebr
 * 自己登记的名称；hosted、MCP 与提供商私有条目保持原样。
 *
 * - 仍有可用条目：删除当前不可用的本地条目；如果其中包含会经过统一分页出口的
 *   Cerebr 本地工具，则自动允许内部 `read_tool_output`，保证超长结果可以续读；
 * - auto 且只剩不可用本地条目：收敛为 `none`；
 * - required 且只剩不可用本地条目：抛出明确配置错误，不静默改变用户意图。
 *
 * @param {any} toolChoice
 * @param {Array<any>} tools
 * @returns {any}
 */
export function reconcileResponsesAllowedToolChoice(toolChoice, tools) {
  if (!toolChoice || typeof toolChoice !== 'object' || Array.isArray(toolChoice)) {
    return toolChoice;
  }
  if (normalizeString(toolChoice.type).toLowerCase() !== 'allowed_tools' || !Array.isArray(toolChoice.tools)) {
    return cloneJsonCompatible(toolChoice);
  }

  const availableLocalToolNames = new Set(
    (Array.isArray(tools) ? tools : [])
      .map((tool) => {
        const name = normalizeString(tool?.name);
        const spec = RESPONSES_EXTENSION_TOOL_SPEC_BY_ID.get(name);
        return matchesExtensionToolDefinition(tool, spec) ? name : '';
      })
      .filter(Boolean)
  );
  const unavailableLocalToolIds = [];
  const reconciledTools = toolChoice.tools.filter((entry) => {
    const localEntry = inspectAllowedLocalExtensionToolEntry(entry);
    if (!localEntry) return true;
    if (localEntry.typeMatches && availableLocalToolNames.has(localEntry.id)) return true;
    unavailableLocalToolIds.push(localEntry.id);
    return false;
  });

  // allowed_tools 会延续到 function output 的后续请求。如果这里只允许原工具、却没有
  // 同时允许续读工具，模型拿到 next_cursor 后仍无法翻页。read_tool_output 是统一输出
  // 协议的一部分，只在至少一个真正支持分页的其它 Cerebr 本地工具实际可用时补入，
  // 不影响 hosted/MCP。js_runtime_execute 固定返回 5000 字符并把超限结果留在 JS runtime，
  // 因此不能让它单独触发 read_tool_output 暴露。
  const hasPageableLocalTool = reconciledTools.some((entry) => {
    const localEntry = inspectAllowedLocalExtensionToolEntry(entry);
    const localSpec = localEntry ? RESPONSES_EXTENSION_TOOL_SPEC_BY_ID.get(localEntry.id) : null;
    return !!localEntry
      && localEntry.typeMatches
      && localEntry.id !== 'read_tool_output'
      && localSpec?.outputKind !== 'js_runtime'
      && availableLocalToolNames.has(localEntry.id);
  });
  const hasReadToolOutput = reconciledTools.some(
    (entry) => {
      const localEntry = inspectAllowedLocalExtensionToolEntry(entry);
      return localEntry?.typeMatches === true && localEntry.id === 'read_tool_output';
    }
  );
  if (
    hasPageableLocalTool
    && !hasReadToolOutput
    && availableLocalToolNames.has('read_tool_output')
  ) {
    reconciledTools.push('read_tool_output');
  }

  if (unavailableLocalToolIds.length <= 0 && reconciledTools.length === toolChoice.tools.length) {
    return cloneJsonCompatible(toolChoice);
  }
  if (reconciledTools.length > 0) {
    return {
      ...cloneJsonCompatible(toolChoice),
      tools: cloneJsonCompatible(reconciledTools)
    };
  }

  const mode = normalizeString(toolChoice.mode).toLowerCase() || 'auto';
  if (mode === 'required') {
    throw new Error(`Responses allowed_tools 配置只包含当前不可用的本地工具：${Array.from(new Set(unavailableLocalToolIds)).join(', ')}`);
  }
  return 'none';
}

function getExtensionToolSettingsRoot(settings) {
  return (settings?.extension_tools && typeof settings.extension_tools === 'object' && !Array.isArray(settings.extension_tools))
    ? settings.extension_tools
    : null;
}

function getToolSettingsById(settings, toolId) {
  const root = getExtensionToolSettingsRoot(settings);
  if (!root) return null;
  const candidate = root[toolId];
  return (candidate && typeof candidate === 'object' && !Array.isArray(candidate))
    ? candidate
    : null;
}

/**
 * 判断某个扩展工具在当前配置下是否应视为启用。
 *
 * 规则：
 * - 未配置时按默认值处理，目前全部默认开启；
 * - 仅当显式写入 `enabled: false` 时才视为关闭；
 * - 未注册工具保持“放行”，避免意外裁掉用户未来新增但当前版本还未登记的工具。
 *
 * @param {Object|null|undefined} settings
 * @param {string} toolId
 * @returns {boolean}
 */
export function isResponsesExtensionToolEnabled(settings, toolId) {
  const normalizedToolId = normalizeString(toolId);
  if (!normalizedToolId) return false;
  const spec = RESPONSES_EXTENSION_TOOL_SPEC_BY_ID.get(normalizedToolId);
  if (!spec) return true;
  if (spec.alwaysEnabled === true) return true;
  const toolSettings = getToolSettingsById(settings, normalizedToolId);
  if (!toolSettings) return spec.defaultEnabled !== false;
  if (toolSettings.enabled === false) return false;
  if (toolSettings.enabled === true) return true;
  return spec.defaultEnabled !== false;
}

/**
 * 过滤一组扩展 function tools，只保留当前配置允许暴露的工具。
 *
 * @param {Array<any>|null|undefined} tools
 * @param {Object|null|undefined} settings
 * @returns {Array<any>}
 */
export function filterResponsesExtensionFunctionTools(tools, settings) {
  const source = Array.isArray(tools) ? tools : [];
  return source
    .filter((tool) => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return true;
      const name = normalizeString(tool.name);
      const spec = RESPONSES_EXTENSION_TOOL_SPEC_BY_ID.get(name);
      if (!matchesExtensionToolDefinition(tool, spec)) return true;
      return isResponsesExtensionToolEnabled(settings, name);
    })
    .map(tool => cloneJsonCompatible(tool));
}

/**
 * 从用户/提供商原始 tools 中移除“名称属于 Cerebr，但本轮没有实际暴露”的 function。
 *
 * 这样可以阻止同名手写 client function 绕过页面环境或扩展开关：例如纯对话模式下
 * 即使 Tools JSON 里手写了 page_content_read，它也不会进入请求，更不会在返回调用时
 * 被本地 dispatcher 当成已授权的页面读取工具执行。
 *
 * @param {Array<any>|null|undefined} tools
 * @param {Array<any>|null|undefined} availableExtensionTools
 * @returns {Array<any>}
 */
export function filterUnavailableResponsesExtensionFunctionTools(tools, availableExtensionTools) {
  const availableNames = new Set(
    (Array.isArray(availableExtensionTools) ? availableExtensionTools : [])
      .map((tool) => {
        const name = normalizeString(tool?.name);
        const spec = RESPONSES_EXTENSION_TOOL_SPEC_BY_ID.get(name);
        return matchesExtensionToolDefinition(tool, spec) ? name : '';
      })
      .filter(Boolean)
  );

  return (Array.isArray(tools) ? tools : [])
    .filter((tool) => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return true;
      const name = normalizeString(tool.name);
      const spec = RESPONSES_EXTENSION_TOOL_SPEC_BY_ID.get(name);
      if (!spec) return true;
      if (!matchesExtensionToolDefinition(tool, spec)) return false;
      return availableNames.has(name);
    })
    .map(tool => cloneJsonCompatible(tool));
}
