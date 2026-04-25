/**
 * Responses API 扩展提供工具注册表。
 *
 * 设计目标：
 * - 把 Cerebr 暴露给 Responses API 的“本地 function tools”统一登记到一个纯模块里；
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
    ...spec
  });
}

export const RESPONSES_EXTENSION_TOOL_SPECS = Object.freeze([
  createExtensionToolSpec({
    id: 'js_runtime_execute',
    title: 'JS Runtime 执行',
    description: '允许模型在宿主页 JS 环境或侧栏隔离 sandbox 中执行 JavaScript。'
  }),
  createExtensionToolSpec({
    id: 'apply_patch',
    title: '虚拟文件 Apply Patch',
    description: '允许模型对会话文档树执行补丁式文件修改。'
  }),
  createExtensionToolSpec({
    id: 'list_files',
    title: '虚拟文件列目录',
    description: '允许模型列出会话文档树中的文件与目录。'
  }),
  createExtensionToolSpec({
    id: 'read_file',
    title: '虚拟文件读文件',
    description: '允许模型读取会话文档树中的文件内容。'
  }),
  createExtensionToolSpec({
    id: 'search_files',
    title: '虚拟文件搜索',
    description: '允许模型在会话文档树中按文本搜索。'
  }),
  createExtensionToolSpec({
    id: 'skill_registry',
    title: 'Skill Registry',
    description: '允许模型读取、创建和维护 Cerebr skill 目录结构。'
  }),
  createExtensionToolSpec({
    id: 'request_user_input',
    title: '请求用户输入',
    description: '允许模型在需要确认时弹出结构化问题，等待用户选择或填写。'
  }),
  createExtensionToolSpec({
    id: 'view_image',
    title: '查看本地图像',
    description: '允许模型读取本地图片文件并作为视觉输入继续分析。'
  }),
  createExtensionToolSpec({
    id: 'list_askable_models',
    title: '列出可追问模型',
    description: '允许模型查看当前可通过 ask_other_ai 访问的配置。'
  }),
  createExtensionToolSpec({
    id: 'ask_other_ai',
    title: '询问其他模型',
    description: '允许模型把整理后的问题转发给其他已配置模型。'
  }),
  createExtensionToolSpec({
    id: 'history_search',
    title: '搜索聊天历史',
    description: '允许模型按关键词搜索本地聊天历史索引。'
  }),
  createExtensionToolSpec({
    id: 'history_read',
    title: '读取聊天历史',
    description: '允许模型按会话或命中结果读取聊天历史内容。'
  }),
  createExtensionToolSpec({
    id: 'webpage_screenshot',
    title: '网页截图',
    description: '允许模型对当前宿主页执行截图并消费图像结果。'
  }),
  createExtensionToolSpec({
    id: 'pdf_content_read',
    title: 'PDF 读取',
    description: '允许模型读取当前页面中的 PDF 内容。'
  }),
  createExtensionToolSpec({
    id: 'page_content_read',
    title: '页面内容读取',
    description: '允许模型读取当前宿主页的结构化文本内容。'
  })
]);

const RESPONSES_EXTENSION_TOOL_SPEC_BY_ID = new Map(
  RESPONSES_EXTENSION_TOOL_SPECS.map(spec => [spec.id, spec])
);

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
      const toolType = normalizeString(tool.type).toLowerCase();
      if (toolType !== 'function') return true;
      return isResponsesExtensionToolEnabled(settings, normalizeString(tool.name));
    })
    .map(tool => cloneJsonCompatible(tool));
}
