/**
 * Responses API 内置工具注册表。
 *
 * 设计目标：
 * - 把“工具面板元数据”和“请求体翻译逻辑”集中到同一个模块，避免定义分散在
 *   `api_settings.js` 的常量区、UI section 构造区、请求体 override 构造区三处；
 * - 保持纯函数接口，便于后续继续把 Gemini 或更多 provider 的内置工具接入同一套组织方式；
 * - 允许 `api_settings.js` 继续复用它自己的 compact / normalize 工具，避免在此处重新耦合 sync storage 细节。
 *
 * 说明：
 * - 本模块只管理 OpenAI Responses 官方 hosted builtin tools；
 * - Cerebr 扩展自身提供的本地 function tools 开关，统一收敛在
 *   `responses_extension_tools.js` 与 API 设置里的“扩展提供工具”面板。
 */

export const RESPONSES_WEB_SEARCH_SOURCE_INCLUDE = 'web_search_call.action.sources';
const RESPONSES_WEB_SEARCH_USER_LOCATION_TYPE_OPTIONS = Object.freeze(['approximate']);

/**
 * 规范化字符串数组：去空白、去重，仅保留非空字符串。
 *
 * 这里提供本地兜底实现，方便独立测试；正式运行时仍优先使用
 * `api_settings.js` 传入的 helper，确保与全局设置裁剪行为保持一致。
 *
 * @param {any} value
 * @returns {string[]|undefined}
 */
function defaultNormalizeStringArray(value) {
  if (!Array.isArray(value)) return undefined;
  const next = [];
  const seen = new Set();
  value.forEach((item) => {
    const text = (typeof item === 'string') ? item.trim() : '';
    if (!text || seen.has(text)) return;
    seen.add(text);
    next.push(text);
  });
  return next.length > 0 ? next : undefined;
}

/**
 * 对 JSON 风格数据做轻量裁剪：
 * - 删除 `undefined` / `null` / 空字符串 / 空数组 / 空对象；
 * - 保留 `false` / `0` 这类有意义的显式值。
 *
 * @param {any} value
 * @returns {any}
 */
function defaultCompactValue(value) {
  if (Array.isArray(value)) {
    const next = value
      .map(item => defaultCompactValue(item))
      .filter(item => item !== undefined);
    return next.length > 0 ? next : undefined;
  }

  if (value && typeof value === 'object') {
    const next = {};
    Object.entries(value).forEach(([key, nestedValue]) => {
      const compacted = defaultCompactValue(nestedValue);
      if (compacted !== undefined) {
        next[key] = compacted;
      }
    });
    return Object.keys(next).length > 0 ? next : undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  if (value === null || value === undefined) {
    return undefined;
  }

  return value;
}

/**
 * 为某个内置工具 section 构造稳定元数据。
 *
 * @param {Object} spec
 * @returns {Readonly<Object>}
 */
function createBuiltinToolSpec(spec) {
  return Object.freeze({
    ...spec,
    sectionToggleSpec: Object.freeze(spec.sectionToggleSpec),
    advancedSpecs: Object.freeze(spec.advancedSpecs || [])
  });
}

export const RESPONSES_BUILTIN_TOOL_SPECS = Object.freeze([
  createBuiltinToolSpec({
    id: 'web_search',
    title: '搜索工具',
    description: '这里单独管理 Responses API 的 web_search 工具；关闭后不会往请求体附加该工具。',
    sectionToggleSpec: {
      path: ['builtin_tools', 'web_search', 'enabled'],
      key: 'builtin_tools.web_search.enabled',
      label: '启用搜索工具',
      help: '启用后自动在 /responses 的 tools 中附加 { type: "web_search" }，由 OpenAI 服务端执行搜索。'
    },
    advancedSpecs: [
      {
        path: ['builtin_tools', 'web_search', 'external_web_access'],
        key: 'builtin_tools.web_search.external_web_access',
        label: '实时外网搜索',
        kind: 'boolean',
        displayPath: ['external_web_access'],
        help: '显式控制 web_search 是否允许实时访问外部网页；未启用时沿用 OpenAI 默认策略。'
      },
      {
        path: ['builtin_tools', 'web_search', 'include_sources'],
        key: 'builtin_tools.web_search.include_sources',
        label: '返回搜索来源',
        kind: 'boolean',
        displayPath: ['include_sources'],
        help: '启用后会自动在 include 中附加 web_search_call.action.sources，便于展示与存档来源。'
      },
      {
        path: ['builtin_tools', 'web_search', 'filters', 'allowed_domains'],
        key: 'builtin_tools.web_search.filters.allowed_domains',
        label: '搜索域名白名单',
        kind: 'json',
        jsonMode: 'array',
        rows: 4,
        displayPath: ['filters', 'allowed_domains'],
        placeholder: '[\n  "openai.com"\n]',
        help: '仅允许搜索指定域名；填写 JSON 数组。'
      },
      {
        path: ['builtin_tools', 'web_search', 'user_location', 'type'],
        key: 'builtin_tools.web_search.user_location.type',
        label: '位置类型',
        kind: 'select',
        options: RESPONSES_WEB_SEARCH_USER_LOCATION_TYPE_OPTIONS,
        defaultValue: 'approximate',
        displayPath: ['user_location', 'type'],
        help: '官方 `user_location.type`。当前常见值为 approximate。'
      },
      {
        path: ['builtin_tools', 'web_search', 'user_location', 'country'],
        key: 'builtin_tools.web_search.user_location.country',
        label: '国家',
        kind: 'text',
        displayPath: ['user_location', 'country'],
        placeholder: '例如 US'
      },
      {
        path: ['builtin_tools', 'web_search', 'user_location', 'city'],
        key: 'builtin_tools.web_search.user_location.city',
        label: '城市',
        kind: 'text',
        displayPath: ['user_location', 'city'],
        placeholder: '例如 San Francisco'
      },
      {
        path: ['builtin_tools', 'web_search', 'user_location', 'region'],
        key: 'builtin_tools.web_search.user_location.region',
        label: '地区/州',
        kind: 'text',
        displayPath: ['user_location', 'region'],
        placeholder: '例如 California'
      },
      {
        path: ['builtin_tools', 'web_search', 'user_location', 'timezone'],
        key: 'builtin_tools.web_search.user_location.timezone',
        label: '时区',
        kind: 'text',
        displayPath: ['user_location', 'timezone'],
        placeholder: '例如 America/Los_Angeles'
      },
      {
        path: ['builtin_tools', 'web_search', 'user_location'],
        key: 'builtin_tools.web_search.user_location',
        label: '搜索用户位置（原始 JSON）',
        kind: 'json',
        jsonMode: 'object',
        rows: 6,
        displayPath: ['user_location'],
        placeholder: '{\n  "type": "approximate",\n  "country": "US",\n  "city": "San Francisco",\n  "region": "California",\n  "timezone": "America/Los_Angeles"\n}',
        help: '传给 web_search 的 user_location 对象；常见字段已拆成结构化控件。'
      }
    ],
    buildRequestOverride(toolSettings, helpers = {}) {
      if (!toolSettings || toolSettings.enabled !== true) return null;
      const compactValue = (typeof helpers.compactValue === 'function') ? helpers.compactValue : defaultCompactValue;
      const normalizeStringArray = (typeof helpers.normalizeStringArray === 'function')
        ? helpers.normalizeStringArray
        : defaultNormalizeStringArray;
      const tool = { type: 'web_search' };

      if (typeof toolSettings.external_web_access === 'boolean') {
        tool.external_web_access = toolSettings.external_web_access;
      }

      const allowedDomains = normalizeStringArray(toolSettings?.filters?.allowed_domains);
      if (allowedDomains) {
        tool.filters = { allowed_domains: allowedDomains };
      }

      const userLocation = compactValue(toolSettings.user_location);
      if (userLocation && typeof userLocation === 'object' && !Array.isArray(userLocation)) {
        tool.user_location = userLocation;
      }

      return {
        tool: compactValue(tool),
        include: toolSettings.include_sources === true
          ? [RESPONSES_WEB_SEARCH_SOURCE_INCLUDE]
          : []
      };
    }
  }),
  createBuiltinToolSpec({
    id: 'code_interpreter',
    title: '代码解释器工具',
    description: '这里单独管理 Responses API 的 code_interpreter 工具；开启后会自动附加一个 `container.type=auto` 的托管 Python 沙箱。',
    sectionToggleSpec: {
      path: ['builtin_tools', 'code_interpreter', 'enabled'],
      key: 'builtin_tools.code_interpreter.enabled',
      label: '启用代码解释器',
      help: '启用后自动在 /responses 的 tools 中附加 { type: "code_interpreter", container: { type: "auto" } }，由 OpenAI 服务端沙箱执行 Python。'
    },
    advancedSpecs: [],
    buildRequestOverride(toolSettings, helpers = {}) {
      if (!toolSettings || toolSettings.enabled !== true) return null;
      const compactValue = (typeof helpers.compactValue === 'function') ? helpers.compactValue : defaultCompactValue;
      return {
        tool: compactValue({
          type: 'code_interpreter',
          container: { type: 'auto' }
        }),
        include: []
      };
    }
  }),
  createBuiltinToolSpec({
    id: 'tool_search',
    title: '工具搜索',
    description: '这里单独管理 Responses API 的 hosted tool_search；开启后会自动附加 `{ type: "tool_search" }`。Cerebr 内置的大多数本地 function tools 会在发送时自动补成 `defer_loading`；若你手写额外工具 JSON，仍需自行声明其 defer_loading / namespace。',
    sectionToggleSpec: {
      path: ['builtin_tools', 'tool_search', 'enabled'],
      key: 'builtin_tools.tool_search.enabled',
      label: '启用工具搜索',
      help: '启用后自动在 /responses 的 tools 中附加 { type: "tool_search" }。Cerebr 自带的大多数 function tools 会自动改成可搜索的 defer_loading 形式；仅你额外手写的 function / namespace / MCP server 仍需在 Tools JSON 中自行声明。'
    },
    advancedSpecs: [],
    buildRequestOverride(toolSettings, helpers = {}) {
      if (!toolSettings || toolSettings.enabled !== true) return null;
      const compactValue = (typeof helpers.compactValue === 'function') ? helpers.compactValue : defaultCompactValue;
      return {
        tool: compactValue({ type: 'tool_search' }),
        include: []
      };
    }
  })
]);

/**
 * 根据当前 `responsesApiSettings.builtin_tools` 生成真正的 `/responses` 内置工具 overrides。
 *
 * @param {Object|null|undefined} settings
 * @param {Object} [helpers]
 * @param {(value: any) => any} [helpers.compactValue]
 * @param {(value: any) => (string[]|undefined)} [helpers.normalizeStringArray]
 * @returns {{tools: Array<Object>, include: Array<string>}}
 */
export function buildResponsesBuiltinToolOverrides(settings, helpers = {}) {
  const builtinTools = (settings?.builtin_tools && typeof settings.builtin_tools === 'object' && !Array.isArray(settings.builtin_tools))
    ? settings.builtin_tools
    : null;
  if (!builtinTools) {
    return { tools: [], include: [] };
  }

  const tools = [];
  const include = [];
  RESPONSES_BUILTIN_TOOL_SPECS.forEach((spec) => {
    const toolSettings = (builtinTools[spec.id] && typeof builtinTools[spec.id] === 'object' && !Array.isArray(builtinTools[spec.id]))
      ? builtinTools[spec.id]
      : null;
    const override = spec.buildRequestOverride(toolSettings, helpers);
    if (!override || typeof override !== 'object') return;

    if (override.tool && typeof override.tool === 'object' && !Array.isArray(override.tool)) {
      tools.push(override.tool);
    }

    const normalizedInclude = defaultNormalizeStringArray(override.include);
    if (normalizedInclude) {
      include.push(...normalizedInclude);
    }
  });

  return {
    tools,
    include: defaultNormalizeStringArray(include) || []
  };
}
