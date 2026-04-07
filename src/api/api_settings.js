/**
 * API 设置和请求处理模块
 * 负责管理 API 配置、UI 渲染以及构建和发送 API 请求
 */

/**
 * 创建 API 管理器
 * @param {Object} options - 配置选项
 * @param {HTMLElement} options.apiSettings - API 设置面板元素
 * @param {HTMLElement} options.apiCards - API 卡片容器元素
 * @param {Function} options.closeExclusivePanels - 关闭其他面板的函数
 * @returns {Object} API 管理器实例
 */
import {
  MAX_SYNC_ITEM_BYTES,
  splitStringToByteChunks,
  setChunksToSync,
  getChunksFromSync
} from '../utils/sync_chunk.js';
import { cloneResponsesInputItems } from '../utils/responses_input_items.js';

// 用户消息预处理模板的说明与示例，用于“？”提示与“复制角色块”按钮。
const USER_MESSAGE_TEMPLATE_HELP_TEXT = [
  '模板语法：',
  '- {{input}} / {{text}} / {{message}}：用户输入',
  '- {{datetime}} / {{date}} / {{time}}：时间占位符',
  '- {{no_system_prompt}}：不发送“提示词设置”中的默认系统提示词（标记本身不会发给模型）',
  '- 角色块（直接写在模板中，按出现顺序发送）：',
  '  {{#system}}...{{/system}} / {{#assistant}}...{{/assistant}} / {{#user}}...{{/user}}',
  '  或 {{#message role="assistant"}}...{{/message}}',
  '- 角色块外的文本会在 trim 后作为 user 消息插入到相对位置（空白则忽略）',
  '- 若模板包含任意角色块，则发送时会替换最后一条 user（不发送空白消息）',
  '- 控制标记会在预处理开始前先过滤；若过滤后模板为空，则按“无模板”逻辑原样发送用户输入'
].join('\n');
const USER_MESSAGE_TEMPLATE_INJECT_SNIPPET = [
  '{{#system}}',
  '这里是你要置顶的系统指令',
  '{{/system}}',
  '{{#assistant}}',
  '这里是你要“虚拟插入”的 AI 回复',
  '{{/assistant}}',
  '{{#user}}',
  '这里是紧跟其后的用户追问',
  '{{/user}}'
].join('\n');
const CONNECTION_TYPE_OPENAI = 'openai';
const CONNECTION_TYPE_OPENAI_RESPONSES = 'openai_responses';
const CONNECTION_TYPE_GEMINI = 'gemini';
const GEMINI_LEGACY_BASE_URL = 'genai';
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_RESPONSES_DEFAULT_BASE_URL = 'https://api.openai.com/v1/responses';
const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const CONNECTION_SOURCE_DEFAULT_NAME_PREFIX = '连接源';
const RESPONSES_REASONING_EFFORT_OPTIONS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const RESPONSES_REASONING_SUMMARY_OPTIONS = Object.freeze(['auto', 'concise', 'detailed']);
const RESPONSES_PROMPT_CACHE_RETENTION_OPTIONS = Object.freeze(['in-memory', '24h']);
const RESPONSES_SERVICE_TIER_OPTIONS = Object.freeze(['auto', 'default', 'flex', 'scale', 'priority']);
const RESPONSES_TRUNCATION_OPTIONS = Object.freeze(['auto', 'disabled']);
const RESPONSES_TEXT_VERBOSITY_OPTIONS = Object.freeze(['low', 'medium', 'high']);
const RESPONSES_WEB_SEARCH_SOURCE_INCLUDE = 'web_search_call.action.sources';
const RESPONSES_SEARCH_TOOL_SECTION_TOGGLE_SPEC = Object.freeze({
  path: ['builtin_tools', 'web_search', 'enabled'],
  key: 'builtin_tools.web_search.enabled',
  label: '启用搜索工具',
  help: '启用后自动在 /responses 的 tools 中附加 { type: "web_search" }，由 OpenAI 服务端执行搜索。'
});
const RESPONSES_CODE_INTERPRETER_TOOL_SECTION_TOGGLE_SPEC = Object.freeze({
  path: ['builtin_tools', 'code_interpreter', 'enabled'],
  key: 'builtin_tools.code_interpreter.enabled',
  label: '启用代码解释器',
  help: '启用后自动在 /responses 的 tools 中附加 { type: "code_interpreter", container: { type: "auto" } }，由 OpenAI 服务端沙箱执行 Python。'
});
const RESPONSES_MAIN_FIELD_SPECS = Object.freeze([
  {
    path: ['reasoning', 'effort'],
    key: 'reasoning.effort',
    label: '思考强度',
    kind: 'select',
    defaultValue: 'medium',
    options: RESPONSES_REASONING_EFFORT_OPTIONS,
    help: 'gpt-5 / o 系列模型可用；未启用时不附加 reasoning.effort。'
  },
  {
    path: ['text', 'verbosity'],
    key: 'text.verbosity',
    label: '回答详细度',
    kind: 'select',
    defaultValue: 'medium',
    options: RESPONSES_TEXT_VERBOSITY_OPTIONS,
    help: '约束输出文本的详细程度。'
  },
  {
    path: ['max_output_tokens'],
    key: 'max_output_tokens',
    label: '最大输出 Token',
    kind: 'number',
    min: 1,
    step: 1,
    placeholder: '例如 4096',
    help: '限制本次 Responses API 的输出上限。'
  },
  {
    path: ['top_p'],
    key: 'top_p',
    label: 'Top P',
    kind: 'range',
    defaultValue: 1,
    min: 0,
    max: 1,
    step: 0.05,
    help: '与 Temperature 二选一优先调一个；未启用时不发送 top_p。'
  },
  {
    path: ['truncation'],
    key: 'truncation',
    label: '截断策略',
    kind: 'select',
    defaultValue: 'auto',
    options: RESPONSES_TRUNCATION_OPTIONS,
    help: '控制超出上下文窗口时的处理方式。'
  },
  {
    path: ['service_tier'],
    key: 'service_tier',
    label: '服务层级',
    kind: 'select',
    defaultValue: 'auto',
    options: RESPONSES_SERVICE_TIER_OPTIONS,
    help: '未启用时由 OpenAI 项目默认策略决定。'
  },
  {
    path: ['parallel_tool_calls'],
    key: 'parallel_tool_calls',
    label: '并行工具调用',
    kind: 'boolean',
    help: '显式控制模型是否允许并行调用工具。'
  },
  {
    path: ['store'],
    key: 'store',
    label: '存储响应',
    kind: 'boolean',
    help: '显式控制是否将响应保存到 OpenAI。'
  }
]);
const RESPONSES_ADVANCED_FIELD_SPECS = Object.freeze([
  {
    path: ['background'],
    key: 'background',
    label: '后台执行',
    kind: 'boolean',
    help: '启用后将响应任务放到后台执行。'
  },
  {
    path: ['instructions'],
    key: 'instructions',
    label: 'Instructions',
    kind: 'textarea',
    rows: 4,
    placeholder: '额外插入到 Responses API 上下文里的 system/developer 指令',
    help: '与现有系统提示词并存；为空时不附加。'
  },
  {
    path: ['conversation'],
    key: 'conversation',
    label: 'Conversation ID',
    kind: 'text',
    placeholder: '例如 conv_...',
    help: '与 previous_response_id 互斥。'
  },
  {
    path: ['previous_response_id'],
    key: 'previous_response_id',
    label: 'Previous Response ID',
    kind: 'text',
    placeholder: '例如 resp_...',
    help: '与 conversation 互斥。'
  },
  {
    path: ['max_tool_calls'],
    key: 'max_tool_calls',
    label: '最大工具调用次数',
    kind: 'number',
    min: 1,
    step: 1,
    placeholder: '例如 4'
  },
  {
    path: ['top_logprobs'],
    key: 'top_logprobs',
    label: 'Top Logprobs',
    kind: 'number',
    min: 0,
    max: 20,
    step: 1,
    placeholder: '0 - 20'
  },
  {
    path: ['prompt_cache_key'],
    key: 'prompt_cache_key',
    label: 'Prompt Cache Key',
    kind: 'text',
    placeholder: '例如 user-cache-key'
  },
  {
    path: ['prompt_cache_retention'],
    key: 'prompt_cache_retention',
    label: 'Prompt Cache Retention',
    kind: 'select',
    defaultValue: 'in-memory',
    options: RESPONSES_PROMPT_CACHE_RETENTION_OPTIONS
  },
  {
    path: ['safety_identifier'],
    key: 'safety_identifier',
    label: 'Safety Identifier',
    kind: 'text',
    maxLength: 64,
    placeholder: '建议放哈希后的稳定用户标识'
  },
  {
    path: ['user'],
    key: 'user',
    label: 'User（已废弃）',
    kind: 'text',
    placeholder: '旧字段，优先改用 safety_identifier / prompt_cache_key'
  },
  {
    path: ['reasoning', 'generate_summary'],
    key: 'reasoning.generate_summary',
    label: '推理摘要生成',
    kind: 'select',
    defaultValue: 'auto',
    options: RESPONSES_REASONING_SUMMARY_OPTIONS
  },
  {
    path: ['reasoning', 'summary'],
    key: 'reasoning.summary',
    label: '推理摘要详略',
    kind: 'select',
    defaultValue: 'auto',
    options: RESPONSES_REASONING_SUMMARY_OPTIONS
  },
  {
    path: ['stream_options', 'include_obfuscation'],
    key: 'stream_options.include_obfuscation',
    label: '流式混淆填充',
    kind: 'boolean',
    help: '仅在当前 API 卡片开启流式输出时才会真正发送。'
  },
  {
    path: ['include'],
    key: 'include',
    label: 'Include',
    kind: 'json',
    jsonMode: 'array',
    rows: 4,
    placeholder: '[\n  \"reasoning.encrypted_content\"\n]',
    help: '填写 JSON 数组。'
  },
  {
    path: ['metadata'],
    key: 'metadata',
    label: 'Metadata',
    kind: 'json',
    jsonMode: 'object',
    rows: 4,
    placeholder: '{\n  \"scene\": \"research\"\n}',
    help: '填写 JSON 对象。'
  },
  {
    path: ['prompt'],
    key: 'prompt',
    label: 'Prompt',
    kind: 'json',
    jsonMode: 'object',
    rows: 5,
    placeholder: '{\n  \"id\": \"pmpt_...\",\n  \"version\": \"1\",\n  \"variables\": { \"foo\": \"bar\" }\n}',
    help: '填写 prompt 模板对象。'
  },
  {
    path: ['context_management'],
    key: 'context_management',
    label: 'Context Management',
    kind: 'json',
    jsonMode: 'array',
    rows: 5,
    placeholder: '[\n  { \"type\": \"compaction\", \"compact_threshold\": 120000 }\n]',
    help: '填写 JSON 数组。'
  },
  {
    path: ['text', 'format'],
    key: 'text.format',
    label: 'Text Format',
    kind: 'json',
    jsonMode: 'object',
    rows: 5,
    placeholder: '{\n  \"type\": \"json_schema\",\n  \"name\": \"output\",\n  \"schema\": {}\n}',
    help: '填写 Responses API text.format 对象。'
  },
  {
    path: ['tool_choice'],
    key: 'tool_choice',
    label: 'Tool Choice',
    kind: 'json_or_string',
    rows: 4,
    placeholder: 'auto\n或\n{\n  \"type\": \"allowed_tools\",\n  \"mode\": \"required\",\n  \"tools\": [\"web_search\"]\n}',
    help: '可填写 none/auto/required，也可填写 JSON 对象。'
  },
  {
    path: ['tools'],
    key: 'tools',
    label: 'Tools',
    kind: 'json',
    jsonMode: 'array',
    rows: 6,
    placeholder: '[\n  { \"type\": \"web_search\" }\n]',
    help: '填写 JSON 数组。'
  }
]);
const RESPONSES_SEARCH_TOOL_FIELD_SPECS = Object.freeze([
  {
    path: ['builtin_tools', 'web_search', 'external_web_access'],
    key: 'builtin_tools.web_search.external_web_access',
    label: '实时外网搜索',
    kind: 'boolean',
    help: '显式控制 web_search 是否允许实时访问外部网页；未启用时沿用 OpenAI 默认策略。'
  },
  {
    path: ['builtin_tools', 'web_search', 'include_sources'],
    key: 'builtin_tools.web_search.include_sources',
    label: '返回搜索来源',
    kind: 'boolean',
    help: '启用后会自动在 include 中附加 web_search_call.action.sources，便于展示与存档来源。'
  },
  {
    path: ['builtin_tools', 'web_search', 'filters', 'allowed_domains'],
    key: 'builtin_tools.web_search.filters.allowed_domains',
    label: '搜索域名白名单',
    kind: 'json',
    jsonMode: 'array',
    rows: 4,
    placeholder: '[\n  \"openai.com\"\n]',
    help: '仅允许搜索指定域名；填写 JSON 数组。'
  },
  {
    path: ['builtin_tools', 'web_search', 'user_location'],
    key: 'builtin_tools.web_search.user_location',
    label: '搜索用户位置',
    kind: 'json',
    jsonMode: 'object',
    rows: 6,
    placeholder: '{\n  \"type\": \"approximate\",\n  \"country\": \"US\",\n  \"city\": \"San Francisco\",\n  \"region\": \"California\",\n  \"timezone\": \"America/Los_Angeles\"\n}',
    help: '传给 web_search 的 user_location 对象。'
  }
]);
const RESPONSES_CODE_INTERPRETER_TOOL_FIELD_SPECS = Object.freeze([]);
const GEMINI_THINKING_LEVEL_OPTIONS = Object.freeze(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']);
const GEMINI_RESPONSE_MIME_TYPE_OPTIONS = Object.freeze(['text/plain', 'application/json']);
const GEMINI_MEDIA_RESOLUTION_OPTIONS = Object.freeze([
  'MEDIA_RESOLUTION_LOW',
  'MEDIA_RESOLUTION_MEDIUM',
  'MEDIA_RESOLUTION_HIGH'
]);
const GEMINI_MAIN_FIELD_SPECS = Object.freeze([
  {
    path: ['generationConfig', 'topP'],
    key: 'generationConfig.topP',
    label: 'Top P',
    kind: 'range',
    defaultValue: 0.95,
    min: 0,
    max: 1,
    step: 0.05,
    help: 'Gemini 使用 nucleus sampling；仅启用后才附加 topP。'
  },
  {
    path: ['generationConfig', 'topK'],
    key: 'generationConfig.topK',
    label: 'Top K',
    kind: 'number',
    min: 1,
    step: 1,
    placeholder: '例如 40',
    help: '部分仅支持 nucleus sampling 的模型不允许设置 topK。'
  },
  {
    path: ['generationConfig', 'maxOutputTokens'],
    key: 'generationConfig.maxOutputTokens',
    label: '最大输出 Token',
    kind: 'number',
    min: 1,
    step: 1,
    placeholder: '例如 8192'
  },
  {
    path: ['generationConfig', 'candidateCount'],
    key: 'generationConfig.candidateCount',
    label: '候选数',
    kind: 'number',
    min: 1,
    step: 1,
    placeholder: '默认 1'
  },
  {
    path: ['generationConfig', 'responseMimeType'],
    key: 'generationConfig.responseMimeType',
    label: '响应 MIME',
    kind: 'select',
    defaultValue: 'text/plain',
    options: GEMINI_RESPONSE_MIME_TYPE_OPTIONS,
    help: '若要结构化 JSON，请配合 responseSchema / responseJsonSchema。'
  },
  {
    path: ['generationConfig', 'thinkingConfig', 'thinkingLevel'],
    key: 'generationConfig.thinkingConfig.thinkingLevel',
    label: '思考层级',
    kind: 'select',
    defaultValue: 'HIGH',
    options: GEMINI_THINKING_LEVEL_OPTIONS,
    help: '推荐 Gemini 3 及以后模型使用。'
  },
  {
    path: ['generationConfig', 'thinkingConfig', 'thinkingBudget'],
    key: 'generationConfig.thinkingConfig.thinkingBudget',
    label: '思考预算',
    kind: 'number',
    min: 0,
    step: 1,
    placeholder: '例如 1024',
    help: '推荐较早支持 thinking 的模型使用；与 thinkingLevel 视为二选一。'
  },
  {
    path: ['generationConfig', 'thinkingConfig', 'includeThoughts'],
    key: 'generationConfig.thinkingConfig.includeThoughts',
    label: '返回 Thoughts',
    kind: 'boolean',
    help: '启用后在模型支持时返回 thoughts。'
  }
]);
const GEMINI_ADVANCED_FIELD_SPECS = Object.freeze([
  {
    path: ['store'],
    key: 'store',
    label: '请求日志存储',
    kind: 'boolean',
    help: '覆盖项目级 logging 配置。'
  },
  {
    path: ['cachedContent'],
    key: 'cachedContent',
    label: 'Cached Content',
    kind: 'text',
    placeholder: 'cachedContents/...'
  },
  {
    path: ['generationConfig', 'stopSequences'],
    key: 'generationConfig.stopSequences',
    label: 'Stop Sequences',
    kind: 'json',
    jsonMode: 'array',
    rows: 4,
    placeholder: '[\n  \"\\nUser:\"\n]'
  },
  {
    path: ['generationConfig', 'seed'],
    key: 'generationConfig.seed',
    label: 'Seed',
    kind: 'number',
    step: 1,
    placeholder: '固定随机种子'
  },
  {
    path: ['generationConfig', 'presencePenalty'],
    key: 'generationConfig.presencePenalty',
    label: 'Presence Penalty',
    kind: 'number',
    step: 0.1,
    placeholder: '例如 0.5 或 -0.5'
  },
  {
    path: ['generationConfig', 'frequencyPenalty'],
    key: 'generationConfig.frequencyPenalty',
    label: 'Frequency Penalty',
    kind: 'number',
    step: 0.1,
    placeholder: '例如 0.5 或 -0.5'
  },
  {
    path: ['generationConfig', 'responseLogprobs'],
    key: 'generationConfig.responseLogprobs',
    label: '导出 Logprobs',
    kind: 'boolean'
  },
  {
    path: ['generationConfig', 'logprobs'],
    key: 'generationConfig.logprobs',
    label: 'Top Logprobs',
    kind: 'number',
    min: 0,
    max: 20,
    step: 1,
    placeholder: '0 - 20'
  },
  {
    path: ['generationConfig', 'enableEnhancedCivicAnswers'],
    key: 'generationConfig.enableEnhancedCivicAnswers',
    label: '增强 Civic Answers',
    kind: 'boolean'
  },
  {
    path: ['generationConfig', 'mediaResolution'],
    key: 'generationConfig.mediaResolution',
    label: '媒体分辨率',
    kind: 'select',
    defaultValue: 'MEDIA_RESOLUTION_MEDIUM',
    options: GEMINI_MEDIA_RESOLUTION_OPTIONS
  },
  {
    path: ['generationConfig', 'responseSchema'],
    key: 'generationConfig.responseSchema',
    label: 'Response Schema',
    kind: 'json',
    jsonMode: 'object',
    rows: 5,
    placeholder: '{\n  \"type\": \"object\",\n  \"properties\": {}\n}'
  },
  {
    path: ['generationConfig', 'responseJsonSchema'],
    key: 'generationConfig.responseJsonSchema',
    label: 'Response JSON Schema',
    kind: 'json',
    jsonMode: 'object',
    rows: 6,
    placeholder: '{\n  \"$schema\": \"https://json-schema.org/draft/2020-12/schema\",\n  \"type\": \"object\"\n}'
  },
  {
    path: ['generationConfig', 'responseModalities'],
    key: 'generationConfig.responseModalities',
    label: 'Response Modalities',
    kind: 'json',
    jsonMode: 'array',
    rows: 4,
    placeholder: '[\n  \"TEXT\"\n]'
  },
  {
    path: ['generationConfig', 'speechConfig'],
    key: 'generationConfig.speechConfig',
    label: 'Speech Config',
    kind: 'json',
    jsonMode: 'object',
    rows: 5,
    placeholder: '{\n  \"voiceConfig\": {}\n}'
  },
  {
    path: ['generationConfig', 'imageConfig'],
    key: 'generationConfig.imageConfig',
    label: 'Image Config',
    kind: 'json',
    jsonMode: 'object',
    rows: 5,
    placeholder: '{\n  \"aspectRatio\": \"16:9\",\n  \"imageSize\": \"1K\"\n}'
  },
  {
    path: ['tools'],
    key: 'tools',
    label: 'Tools',
    kind: 'json',
    jsonMode: 'array',
    rows: 6,
    placeholder: '[\n  { \"functionDeclarations\": [] }\n]'
  },
  {
    path: ['toolConfig'],
    key: 'toolConfig',
    label: 'Tool Config',
    kind: 'json',
    jsonMode: 'object',
    rows: 5,
    placeholder: '{\n  \"functionCallingConfig\": { \"mode\": \"ANY\" }\n}'
  },
  {
    path: ['safetySettings'],
    key: 'safetySettings',
    label: 'Safety Settings',
    kind: 'json',
    jsonMode: 'array',
    rows: 6,
    placeholder: '[\n  { \"category\": \"HARM_CATEGORY_HARASSMENT\", \"threshold\": \"BLOCK_ONLY_HIGH\" }\n]'
  }
]);

export function createApiManager(appContext) {
  // 私有状态
  let apiConfigs = [];
  let connectionSources = [];
  let selectedConfigIndex = 0;
  // 约定：当滑块设置为“无限制”时，使用一个极大值来表示（避免 Infinity 在 JSON 中丢失）
  const MAX_CHAT_HISTORY_UNLIMITED = 2147483647;
  // 用于存储每个配置下次应使用的 API Key 索引 (内存中)
  const apiKeyUsageIndex = {};
  // 本地 key 文件的运行时缓存（仅内存）：避免每次请求都读磁盘。
  // 设计：首次读取后复用；仅在“当前 key 不可用/无可用 key”时触发一次强制重读。
  const apiKeyFileRuntimeCache = new Map();
  // API Key 黑名单（本地持久化），结构为 Map<key, expiresAtMs>
  // 约定：429 时加入黑名单 24 小时；403 与“非 bad request 的 400”写入 -1 表示永久失效
  const BLACKLIST_STORAGE_KEY = 'apiKeyBlacklist';
  let apiKeyBlacklist = {};
  // 拖动排序用的临时状态，避免在拖动过程中频繁写入。
  let draggingCardIndex = null;
  // 连接源配置区展开状态：默认折叠，减少设置页初始高度占用。
  let isConnectionSourcesPanelExpanded = false;
  const DELETE_CONFIRM_TIMEOUT_MS = 2600;
  const MODEL_LIST_FETCH_TIMEOUT_MS = 15000;
  // 模型列表缓存（按 connectionSourceId 聚合）：同一连接源下的所有 API 卡片共享一份模型列表。
  const modelListCacheBySourceId = new Map();
  const modelListPendingBySourceId = new Map();

  const {
    dom,
    services,
    utils // utils.closeExclusivePanels (which might call uiManager internally)
  } = appContext;

  // Settings manager（用于读取“是否发送 signature”等全局开关）
  const settingsManager = services?.settingsManager;

  const apiSettingsPanel = dom.apiSettingsPanel; // Use renamed dom property
  const apiCardsContainer = dom.apiCardsContainer;
  const closeExclusivePanels = utils.closeExclusivePanels; // Or services.uiManager.closeExclusivePanels if preferred & ready

  // ---- Sync Chunking Helpers ----
  const SYNC_CHUNK_META_KEY = 'apiConfigs_chunks_meta';
  const SYNC_CHUNK_KEY_PREFIX = 'apiConfigs_chunk_';
  let lastMetaUpdatedAt = 0;

  // 本地兜底备份（用于应对 sync 配额/写入失败/分片损坏等情况）
  // 说明：
  // - sync 是“跨设备同步”的主存储，但存在写入频率/容量限制；当多标签页并发写入或触发配额时容易失败；
  // - 过去的实现存在“先删旧分片再写新分片”的窗口期：只要写入失败，就会导致配置直接丢失；
  // - 因此这里额外维护一份 local 备份，保证“最坏情况下也能在本机恢复”。
  const API_CONFIGS_LOCAL_BACKUP_KEY = 'apiConfigs_backup_v1';

  // 保存失败提示节流：避免拖动滑块等高频操作导致 toast 刷屏
  let lastSyncSaveWarningAt = 0;
  const SYNC_SAVE_WARNING_COOLDOWN_MS = 8000;


  function minifyJsonIfPossible(input) {
    if (!input || typeof input !== 'string') return input || '';
    try {
      const parsed = JSON.parse(input);
      return JSON.stringify(parsed);
    } catch (_) {
      return input.trim();
    }
  }

  /**
   * 深拷贝仅包含 JSON 兼容值的数据结构。
   * Responses API 设置最终需要落到 chrome.storage，因此这里明确限制为可序列化数据。
   * @param {any} value
   * @returns {any}
   */
  function cloneJsonCompatible(value) {
    if (typeof value === 'undefined') return undefined;
    try {
      if (typeof structuredClone === 'function') {
        return structuredClone(value);
      }
    } catch (_) {}
    return JSON.parse(JSON.stringify(value));
  }

  /**
   * 递归裁剪 Responses API 设置中的空值，只保留真正会写入请求体的字段。
   * 说明：
   * - false / 0 这类显式值必须保留；
   * - 空字符串、空数组、空对象一律删除，避免 sync storage 被无意义字段撑爆；
   * - 字符串统一 trim，减少存储噪音。
   * @param {any} value
   * @returns {any}
   */
  function compactResponsesApiSettingValue(value) {
    if (value == null) return undefined;

    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed ? trimmed : undefined;
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : undefined;
    }

    if (typeof value === 'boolean') {
      return value;
    }

    if (Array.isArray(value)) {
      const compactedItems = value
        .map(item => compactResponsesApiSettingValue(item))
        .filter(item => typeof item !== 'undefined');
      return compactedItems.length > 0 ? compactedItems : undefined;
    }

    if (typeof value === 'object') {
      const compactedObject = {};
      Object.entries(value).forEach(([key, childValue]) => {
        const compactedChild = compactResponsesApiSettingValue(childValue);
        if (typeof compactedChild !== 'undefined') {
          compactedObject[key] = compactedChild;
        }
      });
      return Object.keys(compactedObject).length > 0 ? compactedObject : undefined;
    }

    return undefined;
  }

  /**
   * 规范化并裁剪 Responses API 设置对象。
   * @param {any} settings
   * @returns {Object|undefined}
   */
  function normalizeResponsesApiSettings(settings) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return undefined;
    }
    const compacted = compactResponsesApiSettingValue(settings);
    if (!compacted || typeof compacted !== 'object' || Array.isArray(compacted)) {
      return undefined;
    }
    return compacted;
  }

  /**
   * 规范化字符串数组：去空白、去重，仅保留非空字符串。
   * 主要用于 include / allowed_domains 这类列表型字段，避免把重复项写进 sync storage 或请求体。
   * @param {any} value
   * @returns {string[]|undefined}
   */
  function normalizeResponsesStringArray(value) {
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
   * 合并字符串数组并去重，保持“已有配置在前、追加项在后”的稳定顺序。
   * @param {any} existing
   * @param {any} additions
   * @returns {string[]|undefined}
   */
  function mergeResponsesStringArray(existing, additions) {
    return normalizeResponsesStringArray([
      ...(Array.isArray(existing) ? existing : []),
      ...(Array.isArray(additions) ? additions : [])
    ]);
  }

  /**
   * 合并同类型 tool 定义。
   * 设计说明：
   * - 用户既可以用“专门开关”启用 web_search，也可以在 Tools JSON 里手写更完整的对象；
   * - 这里选择“同类型工具做浅合并 + filters/container 深一层合并”，
   *   避免出现两个重复内置工具，同时减少开关默认值把用户手写细节覆盖掉的概率。
   * @param {any} existingTool
   * @param {Object} nextTool
   * @returns {Object}
   */
  function mergeResponsesToolDefinition(existingTool, nextTool) {
    if (!existingTool || typeof existingTool !== 'object' || Array.isArray(existingTool)) {
      return compactResponsesApiSettingValue(nextTool);
    }
    const merged = {
      ...existingTool,
      ...nextTool
    };
    if ((existingTool.filters && typeof existingTool.filters === 'object' && !Array.isArray(existingTool.filters))
      || (nextTool.filters && typeof nextTool.filters === 'object' && !Array.isArray(nextTool.filters))) {
      merged.filters = {
        ...(existingTool.filters || {}),
        ...(nextTool.filters || {})
      };
    }
    if ((existingTool.container && typeof existingTool.container === 'object' && !Array.isArray(existingTool.container))
      || (nextTool.container && typeof nextTool.container === 'object' && !Array.isArray(nextTool.container))) {
      merged.container = {
        ...(existingTool.container || {}),
        ...(nextTool.container || {})
      };
    }
    return compactResponsesApiSettingValue(merged);
  }

  /**
   * 把“专门的内置工具开关”翻译为真正的 Responses API tools/include 字段。
   * 当前覆盖 web_search / code_interpreter；后续若要扩展 file_search，也只需在这里追加。
   * @param {Object} settings
   * @returns {{tools: Array<Object>, include: Array<string>}}
   */
  function buildResponsesBuiltinToolOverrides(settings) {
    const builtinTools = (settings?.builtin_tools && typeof settings.builtin_tools === 'object' && !Array.isArray(settings.builtin_tools))
      ? settings.builtin_tools
      : null;
    if (!builtinTools) {
      return { tools: [], include: [] };
    }

    const tools = [];
    const include = [];
    const webSearch = (builtinTools.web_search && typeof builtinTools.web_search === 'object' && !Array.isArray(builtinTools.web_search))
      ? builtinTools.web_search
      : null;
    const codeInterpreter = (builtinTools.code_interpreter && typeof builtinTools.code_interpreter === 'object' && !Array.isArray(builtinTools.code_interpreter))
      ? builtinTools.code_interpreter
      : null;

    if (webSearch?.enabled === true) {
      const tool = { type: 'web_search' };

      if (typeof webSearch.external_web_access === 'boolean') {
        tool.external_web_access = webSearch.external_web_access;
      }

      const allowedDomains = normalizeResponsesStringArray(webSearch?.filters?.allowed_domains);
      if (allowedDomains) {
        tool.filters = { allowed_domains: allowedDomains };
      }

      const userLocation = compactResponsesApiSettingValue(webSearch?.user_location);
      if (userLocation && typeof userLocation === 'object' && !Array.isArray(userLocation)) {
        tool.user_location = userLocation;
      }

      const compactedTool = compactResponsesApiSettingValue(tool);
      if (compactedTool && typeof compactedTool === 'object' && !Array.isArray(compactedTool)) {
        tools.push(compactedTool);
      }

      if (webSearch.include_sources === true) {
        include.push(RESPONSES_WEB_SEARCH_SOURCE_INCLUDE);
      }
    }

    if (codeInterpreter?.enabled === true) {
      const tool = {
        type: 'code_interpreter',
        container: { type: 'auto' }
      };
      const compactedTool = compactResponsesApiSettingValue(tool);
      if (compactedTool && typeof compactedTool === 'object' && !Array.isArray(compactedTool)) {
        tools.push(compactedTool);
      }
    }

    return { tools, include };
  }

  /**
   * Gemini 配置同样使用稀疏对象持久化，仅保留启用字段。
   * @param {any} settings
   * @returns {Object|undefined}
   */
  function normalizeGeminiApiSettings(settings) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return undefined;
    }
    const compacted = compactResponsesApiSettingValue(settings);
    if (!compacted || typeof compacted !== 'object' || Array.isArray(compacted)) {
      return undefined;
    }
    return compacted;
  }

  /**
   * 读取深层路径值。
   * @param {Object|undefined|null} root
   * @param {string[]} path
   * @returns {any}
   */
  function getNestedValue(root, path) {
    if (!root || typeof root !== 'object' || !Array.isArray(path) || path.length <= 0) return undefined;
    let current = root;
    for (const segment of path) {
      if (!current || typeof current !== 'object' || !(segment in current)) return undefined;
      current = current[segment];
    }
    return current;
  }

  /**
   * 写入深层路径值，不存在的父节点会自动创建。
   * @param {Object} root
   * @param {string[]} path
   * @param {any} value
   */
  function setNestedValue(root, path, value) {
    if (!root || typeof root !== 'object' || !Array.isArray(path) || path.length <= 0) return;
    let current = root;
    for (let i = 0; i < path.length - 1; i += 1) {
      const segment = path[i];
      if (!current[segment] || typeof current[segment] !== 'object' || Array.isArray(current[segment])) {
        current[segment] = {};
      }
      current = current[segment];
    }
    current[path[path.length - 1]] = value;
  }

  /**
   * 删除深层路径值，并回收因此变为空壳的父对象。
   * @param {Object} root
   * @param {string[]} path
   */
  function deleteNestedValue(root, path) {
    if (!root || typeof root !== 'object' || !Array.isArray(path) || path.length <= 0) return;

    const stack = [];
    let current = root;
    for (let i = 0; i < path.length - 1; i += 1) {
      const segment = path[i];
      if (!current || typeof current !== 'object' || !(segment in current)) return;
      stack.push([current, segment]);
      current = current[segment];
    }

    if (!current || typeof current !== 'object') return;
    delete current[path[path.length - 1]];

    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const [parent, segment] = stack[i];
      const candidate = parent?.[segment];
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) break;
      if (Object.keys(candidate).length > 0) break;
      delete parent[segment];
    }
  }

  function normalizeConnectionType(rawType) {
    const normalized = (typeof rawType === 'string') ? rawType.trim().toLowerCase() : '';
    if (normalized === CONNECTION_TYPE_GEMINI) return CONNECTION_TYPE_GEMINI;
    if (normalized === CONNECTION_TYPE_OPENAI_RESPONSES) return CONNECTION_TYPE_OPENAI_RESPONSES;
    if (normalized === CONNECTION_TYPE_OPENAI) return CONNECTION_TYPE_OPENAI;
    return '';
  }

  function isLegacyGeminiBaseUrl(baseUrl) {
    return (typeof baseUrl === 'string') && baseUrl.trim().toLowerCase() === GEMINI_LEGACY_BASE_URL;
  }

  function inferConnectionTypeByBaseUrl(baseUrl) {
    const normalizedBaseUrl = (typeof baseUrl === 'string') ? baseUrl.trim().toLowerCase() : '';
    if (normalizedBaseUrl === GEMINI_LEGACY_BASE_URL) return CONNECTION_TYPE_GEMINI;
    if (normalizedBaseUrl.includes('generativelanguage.googleapis.com')) return CONNECTION_TYPE_GEMINI;
    if (isOpenAIResponsesEndpoint(baseUrl)) return CONNECTION_TYPE_OPENAI_RESPONSES;
    return CONNECTION_TYPE_OPENAI;
  }

  function normalizeConfigBaseUrlByConnection(connectionType, baseUrl) {
    const normalizedType = normalizeConnectionType(connectionType) || CONNECTION_TYPE_OPENAI;
    const trimmed = (typeof baseUrl === 'string') ? baseUrl.trim() : '';
    if (normalizedType === CONNECTION_TYPE_GEMINI) {
      if (!trimmed || isLegacyGeminiBaseUrl(trimmed)) {
        return GEMINI_DEFAULT_BASE_URL;
      }
      return trimmed;
    }
    if (normalizedType === CONNECTION_TYPE_OPENAI_RESPONSES) {
      return trimmed || OPENAI_RESPONSES_DEFAULT_BASE_URL;
    }
    return trimmed;
  }

  function getConnectionTypeDisplayLabel(connectionType) {
    const normalizedType = normalizeConnectionType(connectionType) || CONNECTION_TYPE_OPENAI;
    if (normalizedType === CONNECTION_TYPE_GEMINI) return 'Gemini';
    if (normalizedType === CONNECTION_TYPE_OPENAI_RESPONSES) return 'OpenAI Responses';
    return 'OpenAI 兼容';
  }

  function normalizeConnectionSourceName(name) {
    const trimmed = (typeof name === 'string') ? name.trim() : '';
    return trimmed || '';
  }

  function buildConnectionSourceDisplayName(source, index = 0) {
    const rawName = normalizeConnectionSourceName(source?.name);
    if (rawName) return rawName;
    const sourceConnectionType = normalizeConnectionType(source?.connectionType) || inferConnectionTypeByBaseUrl(source?.baseUrl);
    const normalizedBaseUrl = normalizeConfigBaseUrlByConnection(sourceConnectionType, source?.baseUrl);
    try {
      const parsed = new URL(normalizedBaseUrl);
      const provider = getConnectionTypeDisplayLabel(sourceConnectionType);
      return `${provider} @ ${parsed.host}`;
    } catch (_) {
      const fallbackName = normalizedBaseUrl || `#${index + 1}`;
      return `${CONNECTION_SOURCE_DEFAULT_NAME_PREFIX} ${fallbackName}`;
    }
  }

  function getConnectionSourceById(connectionSourceId) {
    if (!connectionSourceId) return null;
    return connectionSources.find(source => source.id === connectionSourceId) || null;
  }

  function hasConfiguredConnectionSource(config) {
    const sourceId = (typeof config?.connectionSourceId === 'string') ? config.connectionSourceId.trim() : '';
    if (!sourceId) return false;
    return !!getConnectionSourceById(sourceId);
  }

  function getApiConfigBaseTitle(config) {
    const effective = resolveEffectiveConfig(config) || config || {};
    return config?.displayName || config?.modelName || effective?.baseUrl || '新配置';
  }

  function getConfigConnectionSourceDisplayName(config) {
    const sourceId = (typeof config?.connectionSourceId === 'string') ? config.connectionSourceId.trim() : '';
    if (!sourceId) return '';
    const sourceIndex = connectionSources.findIndex(source => source.id === sourceId);
    if (sourceIndex < 0) return '';
    return buildConnectionSourceDisplayName(connectionSources[sourceIndex], sourceIndex);
  }

  function getApiConfigDisplayTitle(config) {
    const baseTitle = getApiConfigBaseTitle(config);
    const sourceDisplayName = getConfigConnectionSourceDisplayName(config);
    if (!sourceDisplayName) return baseTitle;
    return `${baseTitle} - ${sourceDisplayName}`;
  }

  function getConfigConnectionType(config) {
    const byField = normalizeConnectionType(config?.connectionType);
    if (byField) return byField;

    if (config?.connectionSourceId) {
      const source = getConnectionSourceById(config.connectionSourceId);
      if (source) {
        const sourceByField = normalizeConnectionType(source.connectionType);
        if (sourceByField) return sourceByField;
        return inferConnectionTypeByBaseUrl(source.baseUrl);
      }
    }
    return inferConnectionTypeByBaseUrl(config?.baseUrl);
  }

  function resolveConnectionSourceFromConfig(config) {
    if (!config || typeof config !== 'object') return null;
    if (config.connectionSourceId) {
      const linked = getConnectionSourceById(config.connectionSourceId);
      if (linked) return linked;
    }
    return null;
  }

  function resolveEffectiveConfig(config, options = {}) {
    if (!config || typeof config !== 'object') return null;
    const source = resolveConnectionSourceFromConfig(config);
    const sourceConnectionType = normalizeConnectionType(source?.connectionType);
    const sourceBaseUrl = (typeof source?.baseUrl === 'string') ? source.baseUrl.trim() : '';
    const sourceApiKey = source?.apiKey;
    const sourceApiKeyFilePath = normalizeApiKeyFilePath(source?.apiKeyFilePath);

    const rawConnectionType = sourceConnectionType || normalizeConnectionType(config?.connectionType) || inferConnectionTypeByBaseUrl(sourceBaseUrl || config?.baseUrl);
    const rawBaseUrl = sourceBaseUrl || ((typeof config?.baseUrl === 'string') ? config.baseUrl.trim() : '');
    const normalizedBaseUrl = normalizeConfigBaseUrlByConnection(rawConnectionType, rawBaseUrl);

    const effective = {
      ...config,
      connectionSourceId: source?.id || config?.connectionSourceId || '',
      connectionSourceName: source ? buildConnectionSourceDisplayName(source, 0) : '',
      connectionType: rawConnectionType,
      baseUrl: normalizedBaseUrl,
      apiKey: (typeof sourceApiKey !== 'undefined') ? sourceApiKey : config?.apiKey,
      apiKeyFilePath: source ? sourceApiKeyFilePath : normalizeApiKeyFilePath(config?.apiKeyFilePath)
    };

    if (options.includeSource !== true) {
      return effective;
    }
    return {
      ...effective,
      __connectionSource: source || null
    };
  }

  function isGeminiConnectionConfig(config) {
    return getConfigConnectionType(config) === CONNECTION_TYPE_GEMINI;
  }

  function normalizeGeminiModelName(modelName) {
    const trimmed = (typeof modelName === 'string') ? modelName.trim() : '';
    if (!trimmed) return '';
    return trimmed.replace(/^models\//i, '');
  }

  function buildGeminiEndpointUrl({ baseUrl, modelName, apiKey, useStreaming }) {
    const normalizedModelName = normalizeGeminiModelName(modelName);
    if (!normalizedModelName) {
      throw new Error('Gemini 模型名为空，请在 API 设置中填写 modelName');
    }

    const action = useStreaming ? 'streamGenerateContent' : 'generateContent';
    const encodedModelName = encodeURIComponent(normalizedModelName);
    const normalizedBase = normalizeConfigBaseUrlByConnection(CONNECTION_TYPE_GEMINI, baseUrl);

    // 支持在 baseUrl 中通过占位符自定义完整路径（例如代理服务）。
    const candidate = normalizedBase
      .replace(/\{model\}/gi, encodedModelName)
      .replace(/\{action\}/gi, action)
      .replace(/\{method\}/gi, action)
      .replace(/\{key\}/gi, encodeURIComponent(apiKey));

    let parsedUrl = null;
    try {
      parsedUrl = new URL(candidate);
    } catch (_) {
      throw new Error(`Gemini API 端点无效：${candidate || '(empty)'}`);
    }

    const protocol = String(parsedUrl?.protocol || '').toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error(`Gemini API 端点协议不受支持：${protocol || 'unknown'}`);
    }

    const path = parsedUrl.pathname || '/';
    const hasModelPlaceholder = /\{model\}/i.test(baseUrl || '');
    const hasActionPlaceholder = /\{action\}|\{method\}/i.test(baseUrl || '');
    const hasKeyPlaceholder = /\{key\}/i.test(baseUrl || '');
    const hasGeminiMethodSuffix = /:(streamGenerateContent|generateContent)$/i.test(path);
    const hasModelPathWithoutMethod = /\/models\/[^/]+$/i.test(path);

    let normalizedPath = path.replace(/\/+$/, '');
    if (!normalizedPath) normalizedPath = '';
    if (hasGeminiMethodSuffix) {
      normalizedPath = normalizedPath.replace(/:(streamGenerateContent|generateContent)$/i, `:${action}`);
      parsedUrl.pathname = normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`;
    } else if (hasModelPathWithoutMethod) {
      parsedUrl.pathname = `${normalizedPath}:${action}`;
    } else if (!hasModelPlaceholder && !hasActionPlaceholder) {
      const lowered = normalizedPath.toLowerCase();
      if (/\/v\d+(alpha|beta)?$/i.test(normalizedPath)) {
        normalizedPath = `${normalizedPath}/models/${encodedModelName}:${action}`;
      } else if (lowered.endsWith('/models')) {
        normalizedPath = `${normalizedPath}/${encodedModelName}:${action}`;
      } else {
        normalizedPath = `${normalizedPath}/v1beta/models/${encodedModelName}:${action}`;
      }
      parsedUrl.pathname = normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`;
    }

    const normalizedApiKey = (typeof apiKey === 'string') ? apiKey.trim() : '';
    if (!hasKeyPlaceholder && !parsedUrl.searchParams.has('key') && normalizedApiKey) {
      parsedUrl.searchParams.set('key', normalizedApiKey);
    }
    if (useStreaming) {
      if (!parsedUrl.searchParams.has('alt')) {
        parsedUrl.searchParams.set('alt', 'sse');
      }
    } else if (parsedUrl.searchParams.get('alt') === 'sse') {
      parsedUrl.searchParams.delete('alt');
    }

    return parsedUrl.toString();
  }

  function setSelectedIndexInternal(index) {
    if (!Number.isFinite(index)) return false;
    if (index < 0 || index >= apiConfigs.length) return false;
    selectedConfigIndex = index;
    saveAPIConfigs(); // 保存选中的索引
    renderAPICards(); // 更新卡片选中状态
    renderFavoriteApis(); // 更新收藏列表选中状态
    return true;
  }

  function compactConfigsForSync(configs) {
    return configs.map((c) => {
      const compacted = {
        id: c.id,
        connectionSourceId: (typeof c.connectionSourceId === 'string') ? c.connectionSourceId.trim() : '',
        modelName: c.modelName,
        displayName: c.displayName,
        temperature: c.temperature,
      useStreaming: (c.useStreaming !== false),
      isFavorite: !!c.isFavorite,
      enableAskOtherAiTool: !!c.enableAskOtherAiTool,
      // 旧字段：单一条数上限（按“消息条目”计数）。保留以便向后兼容与降级回滚。
        maxChatHistory: c.maxChatHistory ?? 500,
        // 新字段：分别限制历史 user / assistant 消息条数（便于长对话压缩 AI 输出）
        maxChatHistoryUser: c.maxChatHistoryUser ?? null,
        maxChatHistoryAssistant: c.maxChatHistoryAssistant ?? null,
        customParams: minifyJsonIfPossible(c.customParams || ''),
        customSystemPrompt: (c.customSystemPrompt || '').trim(),
        userMessagePreprocessorTemplate: (typeof c.userMessagePreprocessorTemplate === 'string') ? c.userMessagePreprocessorTemplate : '',
        userMessagePreprocessorIncludeInHistory: !!c.userMessagePreprocessorIncludeInHistory
      };
      const compactedResponsesSettings = normalizeResponsesApiSettings(c.responsesApiSettings);
      if (compactedResponsesSettings) {
        compacted.responsesApiSettings = compactedResponsesSettings;
      }
      const compactedGeminiSettings = normalizeGeminiApiSettings(c.geminiApiSettings);
      if (compactedGeminiSettings) {
        compacted.geminiApiSettings = compactedGeminiSettings;
      }
      return compacted;
    });
  }

  function compactConnectionSourcesForSync(sources) {
    return (Array.isArray(sources) ? sources : []).map((source) => {
      const normalizedType = normalizeConnectionType(source?.connectionType) || inferConnectionTypeByBaseUrl(source?.baseUrl);
      const normalizedBaseUrl = normalizeConfigBaseUrlByConnection(normalizedType, source?.baseUrl);
      const apiKeyFilePath = normalizeApiKeyFilePath(source?.apiKeyFilePath);
      const normalizedApiKey = (() => {
        const keys = normalizeApiKeys(source?.apiKey);
        if (keys.length <= 1) return keys[0] || '';
        return keys;
      })();
      return {
        id: source?.id || '',
        name: normalizeConnectionSourceName(source?.name),
        connectionType: normalizedType,
        baseUrl: normalizedBaseUrl,
        // 当配置了本地 key 文件路径时，不把内联 key 同步到 sync，避免长 key 列表撞配额。
        apiKey: apiKeyFilePath ? '' : normalizedApiKey,
        apiKeyFilePath
      };
    });
  }

  async function saveConfigsToLocalBackup(configs, sources, selectedIndex, updatedAt) {
    try {
      const index = Number.isFinite(selectedIndex) ? selectedIndex : 0;
      await chrome.storage.local.set({
        [API_CONFIGS_LOCAL_BACKUP_KEY]: {
          v: 2,
          updatedAt: Number(updatedAt) || Date.now(),
          selectedConfigIndex: index,
          items: (Array.isArray(configs) ? configs : []).map(c => ({ ...c })),
          connectionSources: (Array.isArray(sources) ? sources : []).map(source => ({ ...source }))
        }
      });
      return true;
    } catch (e) {
      console.warn('写入本地 API 配置备份失败（可忽略）:', e);
      return false;
    }
  }

  async function loadConfigsFromLocalBackup() {
    try {
      const wrap = await chrome.storage.local.get([API_CONFIGS_LOCAL_BACKUP_KEY]);
      const backup = wrap?.[API_CONFIGS_LOCAL_BACKUP_KEY];
      if (!backup || !Array.isArray(backup.items) || backup.items.length <= 0) return null;
      const backupVersion = Number(backup.v || 1);
      const normalizedSources = Array.isArray(backup.connectionSources)
        ? backup.connectionSources
        : [];
      return {
        apiConfigs: backup.items,
        connectionSources: backupVersion >= 2 ? normalizedSources : [],
        selectedConfigIndex: Number(backup.selectedConfigIndex) || 0,
        updatedAt: Number(backup.updatedAt) || 0
      };
    } catch (e) {
      console.warn('读取本地 API 配置备份失败（可忽略）:', e);
      return null;
    }
  }

  function emitApiConfigsUpdated() {
    // 暴露 apiConfigs 到 window 对象 (向后兼容)
    window.apiConfigs = apiConfigs.map(config => resolveEffectiveConfig(config) || config);
    window.connectionSources = connectionSources.map(source => ({ ...source }));
    // 触发配置更新事件：用于同步菜单文本等 UI（跨标签页由 storage.onChanged 驱动后再触发）
    (apiSettingsPanel || document).dispatchEvent(new Event('apiConfigsUpdated', { bubbles: true, composed: true }));
  }

  // ---- API Key 黑名单相关函数 ----
  // 说明：为降低侵入性，黑名单存储在 chrome.storage.local，结构为 { [key: string]: expiresAtMs }
  async function loadApiKeyBlacklist() {
    try {
      const data = await chrome.storage.local.get([BLACKLIST_STORAGE_KEY]);
      const stored = data[BLACKLIST_STORAGE_KEY] || {};
      const now = Date.now();
      const cleaned = {};
      for (const k in stored) {
        const raw = stored[k];
        const value = Number(raw);
        if (!Number.isFinite(value) && value !== -1) continue;
        if (value === -1) {
          cleaned[k] = -1;
          continue;
        }
        if (value > now) {
          cleaned[k] = value;
        }
      }
      apiKeyBlacklist = cleaned;
      if (Object.keys(stored).length !== Object.keys(cleaned).length) {
        await chrome.storage.local.set({ [BLACKLIST_STORAGE_KEY]: cleaned });
      }
    } catch (e) {
      console.warn('加载 API Key 黑名单失败（忽略）：', e);
      apiKeyBlacklist = {};
    }
  }

  async function saveApiKeyBlacklist() {
    try {
      await chrome.storage.local.set({ [BLACKLIST_STORAGE_KEY]: apiKeyBlacklist });
    } catch (e) {
      console.warn('保存 API Key 黑名单失败（忽略）：', e);
    }
  }

  function isKeyBlacklisted(key) {
    const normalizedKey = (key || '').trim();
    if (!normalizedKey) return false;
    const expRaw = apiKeyBlacklist[normalizedKey];
    const exp = Number(expRaw);
    if (!Number.isFinite(exp) && exp !== -1) return false;
    if (exp === -1) return true;
    if (exp <= Date.now()) {
      // 过期清理（惰性）
      delete apiKeyBlacklist[normalizedKey];
      // 异步落盘但不 await，避免阻塞调用方
      saveApiKeyBlacklist();
      return false;
    }
    return true;
  }

  async function blacklistKey(key, durationMs) {
    const normalizedKey = (key || '').trim();
    if (!normalizedKey) return;
    let expiresAt = -1;
    const durationNumber = Number(durationMs);
    if (Number.isFinite(durationNumber) && durationNumber >= 0) {
      expiresAt = Date.now() + durationNumber;
    } else if (durationNumber === -1) {
      expiresAt = -1;
    } else {
      expiresAt = Date.now();
    }
    apiKeyBlacklist[normalizedKey] = expiresAt;
    await saveApiKeyBlacklist();
  }

  function getNextUsableKeyIndex(config, startIndex, excluded = new Set()) {
    if (!Array.isArray(config.apiKey) || config.apiKey.length === 0) return -1;
    const n = config.apiKey.length;
    let idx = Math.min(Math.max(0, startIndex || 0), n - 1);
    for (let i = 0; i < n; i++) {
      const candidateIndex = (idx + i) % n;
      const candidate = (config.apiKey[candidateIndex] || '').trim();
      if (!candidate) continue;
      if (excluded.has(candidate)) continue;
      if (!isKeyBlacklisted(candidate)) return candidateIndex;
    }
    return -1;
  }

  function normalizeApiKeys(apiKey) {
    // 说明：UI 支持「单 Key」或「逗号分隔的多 Key」两种输入形态。
    // 只有在真正存在多个 Key 时（即拆分后长度 > 1），才启用黑名单筛选/轮换逻辑；
    // 单 Key 场景下即便曾被加入黑名单，也继续尝试发起请求，避免被“永久/临时不可用”状态卡死。
    if (Array.isArray(apiKey)) {
      return apiKey.map(k => (typeof k === 'string' ? k.trim() : '')).filter(Boolean);
    }
    if (typeof apiKey !== 'string') return [];
    const raw = apiKey.trim();
    if (!raw) return [];
    if (!raw.includes(',')) return [raw];
    return raw.split(',').map(k => k.trim()).filter(Boolean);
  }

  function normalizeApiKeyFilePath(apiKeyFilePath) {
    return (typeof apiKeyFilePath === 'string') ? apiKeyFilePath.trim() : '';
  }

  function getApiKeyFileCacheEntry(config, filePath) {
    const normalizedPath = normalizeApiKeyFilePath(filePath);
    if (!normalizedPath) return null;
    const configId = getConfigIdentifier(config || {});
    const cached = apiKeyFileRuntimeCache.get(configId);
    if (!cached || cached.filePath !== normalizedPath) return null;
    if (!Array.isArray(cached.keys) || cached.keys.length === 0) return null;
    return {
      configId,
      filePath: normalizedPath,
      keys: cached.keys.slice(),
      loadedAt: Number(cached.loadedAt) || 0
    };
  }

  function setApiKeyFileCacheEntry(config, filePath, keys) {
    const normalizedPath = normalizeApiKeyFilePath(filePath);
    if (!normalizedPath || !Array.isArray(keys) || keys.length === 0) return;
    const configId = getConfigIdentifier(config || {});
    apiKeyFileRuntimeCache.set(configId, {
      filePath: normalizedPath,
      keys: keys.slice(),
      loadedAt: Date.now()
    });
  }

  function clearApiKeyFileCacheEntry(config) {
    const configId = getConfigIdentifier(config || {});
    apiKeyFileRuntimeCache.delete(configId);
  }

  // 将用户输入的本地文件路径规范为可 fetch 的 file:// URL。
  // 支持：file://、Windows 盘符路径、UNC 路径、Unix 绝对路径。
  function toLocalFileUrl(rawPath) {
    const normalizedPath = normalizeApiKeyFilePath(rawPath);
    if (!normalizedPath) return '';
    if (/^file:\/\//i.test(normalizedPath)) {
      return normalizedPath;
    }
    if (/^[a-zA-Z]:[\\/]/.test(normalizedPath)) {
      return encodeURI(`file:///${normalizedPath.replace(/\\/g, '/')}`);
    }
    if (normalizedPath.startsWith('\\\\')) {
      const uncPath = normalizedPath.replace(/\\/g, '/');
      return encodeURI(`file:${uncPath}`);
    }
    if (normalizedPath.startsWith('/')) {
      return encodeURI(`file://${normalizedPath}`);
    }
    return '';
  }

  function parseApiKeysFromFileText(rawText) {
    if (typeof rawText !== 'string') return [];
    const lines = rawText.replace(/\uFEFF/g, '').split(/\r?\n/);
    const keys = [];
    for (const rawLine of lines) {
      const line = String(rawLine || '').trim();
      if (!line) continue;
      if (line.startsWith('#') || line.startsWith('//')) continue;
      if (!line.includes(',')) {
        keys.push(line);
        continue;
      }
      line.split(',').forEach((part) => {
        const value = part.trim();
        if (value) keys.push(value);
      });
    }
    return Array.from(new Set(keys));
  }

  // 本地 key 文件读取重试参数：
  // - 默认最多尝试 3 次；
  // - 使用指数退避 + 轻微随机抖动，降低瞬时失败（文件尚未写完/短暂权限抖动）带来的误报。
  const LOCAL_KEY_FILE_READ_MAX_ATTEMPTS = 3;
  const LOCAL_KEY_FILE_READ_BASE_DELAY_MS = 120;
  const LOCAL_KEY_FILE_READ_MAX_DELAY_MS = 1200;

  function getLocalKeyFileRetryDelayMs(attemptIndex) {
    const safeIndex = Math.max(0, Number(attemptIndex) || 0);
    const expDelay = LOCAL_KEY_FILE_READ_BASE_DELAY_MS * Math.pow(2, safeIndex);
    const jitterMs = Math.floor(Math.random() * 80);
    return Math.min(LOCAL_KEY_FILE_READ_MAX_DELAY_MS, expDelay + jitterMs);
  }

  function sleepMs(ms) {
    const delay = Math.max(0, Number(ms) || 0);
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  async function loadApiKeysFromLocalFile(apiKeyFilePath) {
    const filePath = normalizeApiKeyFilePath(apiKeyFilePath);
    if (!filePath) return { keys: [], error: 'empty_path', detail: '' };
    const fileUrl = toLocalFileUrl(filePath);
    if (!fileUrl) return { keys: [], error: 'invalid_path', detail: '仅支持绝对路径或 file:// 路径' };
    let lastError = 'read_failed';
    let lastDetail = '';
    const maxAttempts = Math.max(1, LOCAL_KEY_FILE_READ_MAX_ATTEMPTS);

    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
      try {
        const response = await fetch(fileUrl, { method: 'GET', cache: 'no-store' });
        if (!response.ok) {
          lastError = 'http_error';
          lastDetail = `HTTP ${response.status}`;
        } else {
          const text = await response.text();
          const keys = parseApiKeysFromFileText(text);
          if (keys.length > 0) {
            return { keys, error: '', detail: '', attempts: attemptIndex + 1 };
          }
          lastError = 'empty_file';
          lastDetail = '文件中未找到有效 key（支持每行一个，或逗号分隔）';
        }
      } catch (e) {
        lastError = 'read_failed';
        lastDetail = (e && typeof e.message === 'string') ? e.message : String(e || '未知读取错误');
      }

      const hasNextAttempt = attemptIndex < (maxAttempts - 1);
      if (hasNextAttempt) {
        await sleepMs(getLocalKeyFileRetryDelayMs(attemptIndex));
      }
    }

    const detailWithRetry = lastDetail
      ? `读取失败（已重试 ${maxAttempts} 次）：${lastDetail}`
      : `读取失败（已重试 ${maxAttempts} 次）`;
    return {
      keys: [],
      error: lastError || 'read_failed',
      detail: detailWithRetry,
      attempts: maxAttempts
    };
  }

  async function resolveRuntimeApiKeys(config, emitStatus, options = {}) {
    const forceFileReload = !!options?.forceFileReload;
    const inlineKeys = normalizeApiKeys(config?.apiKey);
    const filePath = normalizeApiKeyFilePath(config?.apiKeyFilePath);
    if (!filePath) {
      return { keys: inlineKeys, source: 'inline', detail: '' };
    }

    const cached = getApiKeyFileCacheEntry(config, filePath);
    if (!forceFileReload && cached?.keys?.length > 0) {
      return { keys: cached.keys, source: 'file_cache', detail: '', attempts: 0 };
    }

    const loaded = await loadApiKeysFromLocalFile(filePath);
    if (loaded.keys.length > 0) {
      setApiKeyFileCacheEntry(config, filePath, loaded.keys);
      emitStatus({
        stage: 'api_key_file_loaded',
        keyCount: loaded.keys.length,
        readAttempts: loaded.attempts || 1,
        loadedFrom: forceFileReload ? 'file_reload' : 'file',
        apiBase: config?.baseUrl || '',
        modelName: config?.modelName || ''
      });
      return { keys: loaded.keys, source: forceFileReload ? 'file_reload' : 'file', detail: '' };
    }

    if (cached?.keys?.length > 0) {
      emitStatus({
        stage: 'api_key_file_load_failed',
        willFallback: true,
        fallbackSource: 'file_cache',
        fallbackKeyCount: cached.keys.length,
        readAttempts: loaded.attempts || LOCAL_KEY_FILE_READ_MAX_ATTEMPTS,
        reason: loaded?.detail || loaded?.error || 'unknown',
        apiBase: config?.baseUrl || '',
        modelName: config?.modelName || ''
      });
      return {
        keys: cached.keys,
        source: 'file_cache_fallback',
        detail: loaded?.detail || loaded?.error || ''
      };
    }

    const hasFallback = inlineKeys.length > 0;
    emitStatus({
      stage: 'api_key_file_load_failed',
      willFallback: hasFallback,
      fallbackSource: hasFallback ? 'inline' : '',
      fallbackKeyCount: inlineKeys.length,
      readAttempts: loaded.attempts || LOCAL_KEY_FILE_READ_MAX_ATTEMPTS,
      reason: loaded?.detail || loaded?.error || 'unknown',
      apiBase: config?.baseUrl || '',
      modelName: config?.modelName || ''
    });
    if (hasFallback) {
      return {
        keys: inlineKeys,
        source: 'inline_fallback',
        detail: loaded?.detail || loaded?.error || ''
      };
    }
    return {
      keys: [],
      source: 'file',
      detail: loaded?.detail || loaded?.error || '本地 key 文件读取失败'
    };
  }

  // 仅用于识别“请求体/参数错误”的 400。命中后不拉黑 key，避免误伤可用 key。
  // 细化依据：Gemini 后端常见 payload 错误会返回 INVALID_ARGUMENT，并伴随以下文案。
  const BAD_REQUEST_400_HINTS = [
    'contents is not specified',
    'request contains an invalid argument',
    'invalid value at',
    'unknown name',
    'please use a valid role: user, model',
    'generatecontentrequest.contents',
    'invalid_request_error',
    'malformed',
    'parse error',
    'invalid json payload',
    'missing required parameter',
    'cannot find field',
    'unsupported parameter',
    'parameter is required',
    'messages is required'
  ];

  // 一些后端会把鉴权失败也放在 400，需要优先识别，避免被 bad request 关键词误判。
  const AUTH_RELATED_400_HINTS = [
    'api key not valid',
    'key not valid',
    'invalid api key',
    'incorrect api key',
    'api_key_invalid',
    'invalid_api_key',
    'not_authorized',
    'unauthorized',
    'authentication',
    'permission denied',
    'service_disabled',
    'api has not been used'
  ];

  async function isBadRequest400(response) {
    if (!response || response.status !== 400) return false;
    let responseText = '';
    try {
      responseText = await response.clone().text();
    } catch (_) {
      // 无法读取错误体时，保守处理为“非 bad request”，由上层继续走拉黑逻辑。
      return false;
    }

    const baseText = (responseText || '').toLowerCase();
    if (!baseText) return false;

    // 优先解析结构化错误体，避免仅靠字符串匹配导致误判。
    let parsedMessage = '';
    let parsedStatus = '';
    let parsedDetails = '';
    try {
      const parsed = JSON.parse(responseText);
      parsedMessage = String(parsed?.error?.message || '').toLowerCase();
      parsedStatus = String(parsed?.error?.status || '').toLowerCase();
      parsedDetails = JSON.stringify(parsed?.error?.details || '').toLowerCase();
    } catch (_) {
      // 解析失败时退化为纯文本匹配即可。
    }
    const normalized = [baseText, parsedMessage, parsedStatus, parsedDetails].filter(Boolean).join('\n');

    const hasAuthHint = AUTH_RELATED_400_HINTS.some((hint) => normalized.includes(hint));
    if (hasAuthHint) return false;

    const hasBadRequestHint = BAD_REQUEST_400_HINTS.some((hint) => normalized.includes(hint));
    if (!hasBadRequestHint) return false;

    // Gemini 常见 bad request 状态；注意：鉴权失败也可能复用 INVALID_ARGUMENT，
    // 因此必须先过鉴权关键词，再结合 payload 关键词一起判断。
    if (parsedStatus === 'invalid_argument' || parsedStatus === 'bad_request') {
      return true;
    }

    // 兼容其它后端只返回 message 文案、不带结构化 status 的情况。
    return hasBadRequestHint;
  }

  async function saveConfigsToSyncChunked(configs, sources, options = {}) {
    // 重要：不要“先删后写”
    // - chrome.storage.sync 有写入频率限制；高频操作（例如温度滑块拖动）可能触发配额导致 set 失败；
    // - 若先 remove 再 set，一旦 set 失败就会造成配置被清空（你这次遇到的“只剩一个 gpt-4o”就是典型表现）；
    // - 因此改为“直接覆盖写入”，即使失败也不会破坏旧数据；多余的旧分片键最多只会占用一些空间，但不会影响读取。
    const updatedAt = Number(options?.updatedAt) || Date.now();
    const selectedIndexToSync = Number.isFinite(options?.selectedConfigIndex)
      ? options.selectedConfigIndex
      : selectedConfigIndex;
    try {
      const slim = compactConfigsForSync(configs);
      const slimSources = compactConnectionSourcesForSync(sources);
      const serialized = JSON.stringify({ v: 2, items: slim, connectionSources: slimSources });
      const maxBytesPerChunkData = MAX_SYNC_ITEM_BYTES - 1000;
      const chunks = splitStringToByteChunks(serialized, maxBytesPerChunkData);
      if (!chunks || chunks.length <= 0) {
        throw new Error('分片结果为空，拒绝写入 sync（避免写入空配置覆盖旧数据）');
      }

      // 与分片一起写入 selectedConfigIndex，减少一次 sync 写操作（降低触发配额概率）
      await setChunksToSync(SYNC_CHUNK_KEY_PREFIX, chunks, {
        [SYNC_CHUNK_META_KEY]: { count: chunks.length, updatedAt },
        selectedConfigIndex: selectedIndexToSync
      });

      return { ok: true, updatedAt };
    } catch (e) {
      console.warn('保存API配置到 sync 失败：', e);
      return { ok: false, updatedAt };
    }
  }

  async function loadConfigsFromSyncChunked() {
    try {
      const metaWrap = await chrome.storage.sync.get([SYNC_CHUNK_META_KEY]);
      const meta = metaWrap[SYNC_CHUNK_META_KEY];
      const count = Number(meta?.count || 0);
      if (!meta || !Number.isFinite(count) || count <= 0) {
        return { state: 'empty', items: null, connectionSources: null, meta: null, error: null };
      }

      const serialized = await getChunksFromSync(SYNC_CHUNK_KEY_PREFIX, count);
      if (!serialized) {
        return { state: 'corrupt', items: null, connectionSources: null, meta, error: new Error('sync serialized 为空') };
      }

      const parsed = JSON.parse(serialized);
      if (!parsed || !Array.isArray(parsed.items)) {
        return { state: 'corrupt', items: null, connectionSources: null, meta, error: new Error('sync payload 格式不合法') };
      }
      if (Number(parsed.v) >= 2) {
        const loadedSources = Array.isArray(parsed.connectionSources) ? parsed.connectionSources : [];
        return { state: 'ok', items: parsed.items, connectionSources: loadedSources, meta, error: null };
      }
      // 兼容 v1：仅包含 apiConfigs，连接字段稍后在 loadAPIConfigs 中迁移为连接源。
      return { state: 'ok', items: parsed.items, connectionSources: [], meta, error: null };
    } catch (e) {
      console.warn('从 sync 读取API配置失败：', e);
      return { state: 'error', items: null, connectionSources: null, meta: null, error: e };
    }
  }

  // 为每个 API 配置提供稳定 ID
  function generateUUID() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
      }
    } catch (_) {}
    const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
    return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`;
  }

  function normalizeApiKeyValue(rawApiKey) {
    const normalizedKeys = normalizeApiKeys(rawApiKey);
    if (normalizedKeys.length <= 1) return normalizedKeys[0] || '';
    return normalizedKeys;
  }

  function normalizeConnectionSource(source = {}, options = {}) {
    const normalizedType = normalizeConnectionType(source?.connectionType)
      || inferConnectionTypeByBaseUrl(source?.baseUrl);
    let normalizedBaseUrl = normalizeConfigBaseUrlByConnection(normalizedType, source?.baseUrl);
    if (!normalizedBaseUrl && normalizedType === CONNECTION_TYPE_OPENAI) {
      normalizedBaseUrl = OPENAI_DEFAULT_BASE_URL;
    } else if (!normalizedBaseUrl && normalizedType === CONNECTION_TYPE_OPENAI_RESPONSES) {
      normalizedBaseUrl = OPENAI_RESPONSES_DEFAULT_BASE_URL;
    }
    const normalizedName = normalizeConnectionSourceName(source?.name);
    return {
      id: source?.id || (options.keepIdIfMissing ? '' : generateUUID()),
      name: normalizedName,
      connectionType: normalizedType,
      baseUrl: normalizedBaseUrl,
      apiKey: normalizeApiKeyValue(source?.apiKey),
      apiKeyFilePath: normalizeApiKeyFilePath(source?.apiKeyFilePath)
    };
  }

  function buildConnectionSourceDedupeKey(source) {
    const normalized = normalizeConnectionSource(source, { keepIdIfMissing: true });
    const normalizedKeys = normalizeApiKeys(normalized.apiKey);
    return JSON.stringify([
      normalized.connectionType,
      normalized.baseUrl,
      normalized.apiKeyFilePath,
      normalizedKeys
    ]);
  }

  function assignStableConnectionSourceNames(sources) {
    const seen = new Map();
    sources.forEach((source, index) => {
      const baseName = normalizeConnectionSourceName(source?.name) || buildConnectionSourceDisplayName(source, index);
      const key = baseName.toLowerCase();
      const existing = seen.get(key) || 0;
      seen.set(key, existing + 1);
      if (existing === 0) {
        source.name = baseName;
        return;
      }
      source.name = `${baseName} (${existing + 1})`;
    });
  }

  function createDefaultConnectionSource(overrides = {}) {
    return normalizeConnectionSource({
      id: generateUUID(),
      name: `${CONNECTION_SOURCE_DEFAULT_NAME_PREFIX} 1`,
      connectionType: CONNECTION_TYPE_OPENAI,
      baseUrl: OPENAI_DEFAULT_BASE_URL,
      apiKey: '',
      apiKeyFilePath: '',
      ...overrides
    });
  }

  function createDefaultApiConfig(connectionSourceId = '', overrides = {}) {
    return {
      id: generateUUID(),
      connectionSourceId,
      modelName: 'gpt-4o',
      displayName: '',
      temperature: 1,
      useStreaming: true,
      isFavorite: false,
      enableAskOtherAiTool: false,
      customParams: '',
      customSystemPrompt: '',
      userMessagePreprocessorTemplate: '',
      userMessagePreprocessorIncludeInHistory: false,
      maxChatHistory: 500,
      maxChatHistoryUser: 500,
      maxChatHistoryAssistant: 500,
      ...overrides
    };
  }

  // 仅当旧版连接字段里存在“有效值”时，才迁移/创建连接源；避免空字段误生成默认连接源。
  function hasMeaningfulLegacyConnectionFields(config = {}) {
    const legacyConnectionType = normalizeConnectionType(config.connectionType);
    const legacyBaseUrl = (typeof config.baseUrl === 'string') ? config.baseUrl.trim() : '';
    const hasInlineApiKeys = normalizeApiKeys(config.apiKey).length > 0;
    const hasApiKeyFilePath = !!normalizeApiKeyFilePath(config.apiKeyFilePath);
    return !!(legacyConnectionType || legacyBaseUrl || hasInlineApiKeys || hasApiKeyFilePath);
  }

  function migrateConnectionSourcesAndConfigs(rawConfigs, rawSources) {
    const sourceList = [];
    const sourceById = new Map();
    const sourceBySignature = new Map();

    const pushSource = (rawSource, options = {}) => {
      const dedupeBySignature = options.dedupeBySignature !== false;
      const normalizedSource = normalizeConnectionSource(rawSource);
      if (!normalizedSource.id || sourceById.has(normalizedSource.id)) {
        normalizedSource.id = generateUUID();
      }
      const signature = buildConnectionSourceDedupeKey(normalizedSource);
      if (dedupeBySignature && sourceBySignature.has(signature)) {
        return sourceBySignature.get(signature);
      }
      sourceList.push(normalizedSource);
      sourceById.set(normalizedSource.id, normalizedSource);
      if (!sourceBySignature.has(signature)) {
        sourceBySignature.set(signature, normalizedSource);
      }
      return normalizedSource;
    };

    (Array.isArray(rawSources) ? rawSources : []).forEach((source) => {
      pushSource(source, { dedupeBySignature: false });
    });

    const configs = (Array.isArray(rawConfigs) ? rawConfigs : []).map((rawConfig) => {
      const config = { ...rawConfig };
      if (!config.id) config.id = generateUUID();

      let source = null;
      const configuredSourceId = (typeof config.connectionSourceId === 'string') ? config.connectionSourceId.trim() : '';
      if (configuredSourceId) {
        source = sourceById.get(configuredSourceId) || null;
      }
      if (!source && hasMeaningfulLegacyConnectionFields(config)) {
        source = pushSource({
          connectionType: config.connectionType,
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          apiKeyFilePath: config.apiKeyFilePath
        }, { dedupeBySignature: true });
      }

      config.connectionSourceId = source?.id || '';
      delete config.connectionType;
      delete config.baseUrl;
      delete config.apiKey;
      delete config.apiKeyFilePath;
      return config;
    });

    assignStableConnectionSourceNames(sourceList);
    return {
      apiConfigs: configs,
      connectionSources: sourceList
    };
  }

  function normalizeApiConfigsAfterMigration(configs, availableSources) {
    const sourceIdSet = new Set((Array.isArray(availableSources) ? availableSources : []).map(source => source.id));
    return (Array.isArray(configs) ? configs : []).map((rawConfig) => {
      const config = { ...rawConfig };
      if (!config.id) config.id = generateUUID();

      const candidateSourceId = (typeof config.connectionSourceId === 'string') ? config.connectionSourceId.trim() : '';
      config.connectionSourceId = sourceIdSet.has(candidateSourceId) ? candidateSourceId : '';

      if (typeof config.modelName !== 'string') {
        config.modelName = '';
      } else {
        config.modelName = config.modelName.trim();
      }
      if (typeof config.displayName !== 'string') {
        config.displayName = '';
      } else {
        config.displayName = config.displayName.trim();
      }
      config.temperature = Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : 1;
      config.useStreaming = (config.useStreaming !== false);
      config.isFavorite = !!config.isFavorite;
      config.enableAskOtherAiTool = !!config.enableAskOtherAiTool;
      config.customParams = (typeof config.customParams === 'string') ? config.customParams : '';
      config.customSystemPrompt = (typeof config.customSystemPrompt === 'string') ? config.customSystemPrompt.trim() : '';
      config.userMessagePreprocessorTemplate = (typeof config.userMessagePreprocessorTemplate === 'string')
        ? config.userMessagePreprocessorTemplate
        : '';
      config.userMessagePreprocessorIncludeInHistory = !!config.userMessagePreprocessorIncludeInHistory;
      const normalizedResponsesApiSettings = normalizeResponsesApiSettings(config.responsesApiSettings);
      if (normalizedResponsesApiSettings) {
        config.responsesApiSettings = normalizedResponsesApiSettings;
      } else {
        delete config.responsesApiSettings;
      }
      const normalizedGeminiApiSettings = normalizeGeminiApiSettings(config.geminiApiSettings);
      if (normalizedGeminiApiSettings) {
        config.geminiApiSettings = normalizedGeminiApiSettings;
      } else {
        delete config.geminiApiSettings;
      }
      delete config.connectionType;
      delete config.baseUrl;
      delete config.apiKey;
      delete config.apiKeyFilePath;
      return config;
    });
  }

  function normalizeConnectionSourcesAfterMigration(sources) {
    const deduped = [];
    const byId = new Set();
    (Array.isArray(sources) ? sources : []).forEach((rawSource) => {
      const normalized = normalizeConnectionSource(rawSource);
      if (!normalized.id || byId.has(normalized.id)) {
        normalized.id = generateUUID();
      }
      byId.add(normalized.id);
      deduped.push(normalized);
    });
    assignStableConnectionSourceNames(deduped);
    return deduped;
  }

  /**
   * 加载 API 配置
   * @returns {Promise<void>}
   */
  async function loadAPIConfigs() {
    try {
      // 提前加载黑名单，确保首次请求前可用
      await loadApiKeyBlacklist();
      // 读取顺序统一：sync 分片 → 旧 sync 字段（一次性迁移）
      let result = { apiConfigs: null, connectionSources: null, selectedConfigIndex: 0 };
      const chunked = await loadConfigsFromSyncChunked();
      if (chunked?.state === 'ok' && Array.isArray(chunked.items) && chunked.items.length > 0) {
        result.apiConfigs = chunked.items;
        result.connectionSources = Array.isArray(chunked.connectionSources) ? chunked.connectionSources : [];
        const syncSel = await chrome.storage.sync.get(['selectedConfigIndex']);
        result.selectedConfigIndex = syncSel.selectedConfigIndex || 0;
        lastMetaUpdatedAt = Number(chunked?.meta?.updatedAt || Date.now());
      } else if (chunked?.state === 'corrupt' || chunked?.state === 'error') {
        // 云端分片存在但无法读取：优先从本地备份恢复（避免覆盖掉用户真实配置）
        const backup = await loadConfigsFromLocalBackup();
        if (backup?.apiConfigs && backup.apiConfigs.length > 0) {
          result.apiConfigs = backup.apiConfigs;
          result.connectionSources = backup.connectionSources || [];
          result.selectedConfigIndex = backup.selectedConfigIndex || 0;
        } else {
          // 再尝试兼容最老的存储形态（可能是旧版本尚未迁移的情况）
          const syncResult = await chrome.storage.sync.get(['apiConfigs', 'selectedConfigIndex']);
          if (syncResult.apiConfigs && syncResult.apiConfigs.length > 0) {
            result.apiConfigs = syncResult.apiConfigs;
            result.connectionSources = [];
            result.selectedConfigIndex = syncResult.selectedConfigIndex || 0;
          }
        }

        // 提示：不自动写回默认配置，避免“错误读取 => 覆盖清空”的连锁反应
        utils?.showNotification?.({
          type: 'warning',
          message: '云端 API 设置读取失败，已尝试从本地备份恢复',
          description: '建议刷新/关闭其它旧标签页后，再打开 API 设置保存一次以修复云端。'
        });
      } else {
        // 兼容最老的存储形态（仅一次性迁移）
        const syncResult = await chrome.storage.sync.get(['apiConfigs', 'selectedConfigIndex']);
        if (syncResult.apiConfigs && syncResult.apiConfigs.length > 0) {
          result.apiConfigs = syncResult.apiConfigs;
          result.connectionSources = [];
          result.selectedConfigIndex = syncResult.selectedConfigIndex || 0;
        }
      }

      if (result.apiConfigs && result.apiConfigs.length > 0) {
        const migration = migrateConnectionSourcesAndConfigs(result.apiConfigs, result.connectionSources);
        connectionSources = normalizeConnectionSourcesAfterMigration(migration.connectionSources);
        apiConfigs = normalizeApiConfigsAfterMigration(migration.apiConfigs, connectionSources);
        invalidateAllModelListCaches();

        // 清理历史运行时状态，避免连接源迁移后沿用旧索引/缓存键。
        Object.keys(apiKeyUsageIndex).forEach((key) => delete apiKeyUsageIndex[key]);
        apiKeyFileRuntimeCache.clear();

        selectedConfigIndex = result.selectedConfigIndex || 0;
        selectedConfigIndex = Math.max(0, Math.min(selectedConfigIndex, apiConfigs.length - 1));

        let needResave = false;

        apiConfigs.forEach(config => {
          if (!config.id) {
            config.id = generateUUID();
            needResave = true;
          }

          const normalizedSourceId = (typeof config.connectionSourceId === 'string')
            ? config.connectionSourceId.trim()
            : '';
          const isValidSource = !!(normalizedSourceId && connectionSources.some(source => source.id === normalizedSourceId));
          if (!isValidSource) {
            if (config.connectionSourceId !== '') {
              config.connectionSourceId = '';
              needResave = true;
            }
          } else if (normalizedSourceId !== config.connectionSourceId) {
            config.connectionSourceId = normalizedSourceId;
            needResave = true;
          }

          if (typeof config.modelName !== 'string') {
            config.modelName = '';
            needResave = true;
          } else {
            const trimmedModelName = config.modelName.trim();
            if (trimmedModelName !== config.modelName) {
              config.modelName = trimmedModelName;
              needResave = true;
            }
          }
          if (typeof config.displayName !== 'string') {
            config.displayName = '';
            needResave = true;
          } else {
            const trimmedDisplayName = config.displayName.trim();
            if (trimmedDisplayName !== config.displayName) {
              config.displayName = trimmedDisplayName;
              needResave = true;
            }
          }

          // 默认开启流式传输（向后兼容）
          if (typeof config.useStreaming === 'undefined') {
            config.useStreaming = true;
            needResave = true;
          }
          if (typeof config.userMessagePreprocessorTemplate !== 'string') {
            config.userMessagePreprocessorTemplate = '';
            needResave = true;
          }
          if (typeof config.userMessagePreprocessorIncludeInHistory !== 'boolean') {
            config.userMessagePreprocessorIncludeInHistory = false;
            needResave = true;
          }
          // 兼容旧版本：将单一 maxChatHistory 迁移为按角色拆分的双上限
          // 设计目标：尽量保持“总条数”接近旧行为（默认按 50%/50% 拆分）
          const hasUserLimit = Number.isFinite(config.maxChatHistoryUser);
          const hasAssistantLimit = Number.isFinite(config.maxChatHistoryAssistant);
          if (!hasUserLimit || !hasAssistantLimit) {
            const legacyMax = Number.isFinite(config.maxChatHistory) ? config.maxChatHistory : 500;
            const legacy = Number(legacyMax);
            const isUnlimited = Number.isFinite(legacy) && legacy >= 500;
            const isDisabled = !Number.isFinite(legacy) ? false : legacy <= 0;

            if (!hasUserLimit || !hasAssistantLimit) {
              if (isUnlimited) {
                if (!hasUserLimit) config.maxChatHistoryUser = MAX_CHAT_HISTORY_UNLIMITED;
                if (!hasAssistantLimit) config.maxChatHistoryAssistant = MAX_CHAT_HISTORY_UNLIMITED;
              } else if (isDisabled) {
                if (!hasUserLimit) config.maxChatHistoryUser = 0;
                if (!hasAssistantLimit) config.maxChatHistoryAssistant = 0;
              } else {
                const clamped = Math.min(499, Math.max(1, Math.floor(legacy)));
                if (!hasUserLimit) config.maxChatHistoryUser = Math.ceil(clamped / 2);
                if (!hasAssistantLimit) config.maxChatHistoryAssistant = Math.floor(clamped / 2);
              }
              needResave = true;
            }
          }
        });

        connectionSources.forEach((source, index) => {
          const normalizedSource = normalizeConnectionSource(source, { keepIdIfMissing: true });
          if (!normalizedSource.id) {
            normalizedSource.id = generateUUID();
            needResave = true;
          }
          const expectedName = normalizeConnectionSourceName(source?.name) || buildConnectionSourceDisplayName(source, index);
          if (source.id !== normalizedSource.id
            || source.connectionType !== normalizedSource.connectionType
            || source.baseUrl !== normalizedSource.baseUrl
            || source.apiKeyFilePath !== normalizedSource.apiKeyFilePath) {
            Object.assign(source, normalizedSource);
            needResave = true;
          }
          source.apiKey = normalizeApiKeyValue(source.apiKey);
          if (!normalizeConnectionSourceName(source.name)) {
            source.name = expectedName;
            needResave = true;
          }

          const sourceId = source.id;
          if (Array.isArray(source.apiKey) && source.apiKey.length > 0 && typeof apiKeyUsageIndex[sourceId] !== 'number') {
            apiKeyUsageIndex[sourceId] = 0;
          }
        });

        if (needResave) { await saveAPIConfigs(); }

        // 将“可用配置快照”写入本地备份，避免 sync 发生异常时无从恢复
        try { await saveConfigsToLocalBackup(apiConfigs, connectionSources, selectedConfigIndex, lastMetaUpdatedAt || Date.now()); } catch (_) {}

      } else {
        // 创建默认配置（仅在确认为“完全没有存储数据”的情况下才写回 sync）
        const defaultSource = createDefaultConnectionSource();
        connectionSources = [defaultSource];
        apiConfigs = [createDefaultApiConfig(defaultSource.id)];
        selectedConfigIndex = 0;
        invalidateAllModelListCaches();
        // 如果云端分片损坏导致读取不到数据，这里不应写回默认值（否则会覆盖掉真实数据）
        // 仅当 sync 分片为空且旧字段也为空时，才写入默认配置作为初始化。
        if (chunked?.state === 'empty') {
          await saveAPIConfigs();
        } else {
          await saveConfigsToLocalBackup(apiConfigs, connectionSources, selectedConfigIndex, Date.now());
        }
      }
    } catch (error) {
      console.error('加载 API 配置失败:', error);
      // 如果加载失败，也创建默认配置
      const defaultSource = createDefaultConnectionSource();
      connectionSources = [defaultSource];
      apiConfigs = [createDefaultApiConfig(defaultSource.id)];
      selectedConfigIndex = 0;
      invalidateAllModelListCaches();
    }

    emitApiConfigsUpdated();

    // 确保一定会渲染连接源、卡片和收藏列表
    renderConnectionSources();
    renderAPICards();
    renderFavoriteApis();
  }

  /**
   * 保存配置到存储
   * @returns {Promise<void>}
   */
  async function saveAPIConfigs() {
    try {
      // 保存前做一次轻量规范化，避免不同入口写入不一致数据结构。
      connectionSources = normalizeConnectionSourcesAfterMigration(connectionSources);
      apiConfigs = normalizeApiConfigsAfterMigration(apiConfigs, connectionSources);

      const configsToSave = apiConfigs.map(config => ({ ...config }));
      const sourcesToSave = connectionSources.map(source => ({ ...source }));

      const updatedAt = Date.now();

      // 先写本地兜底备份：即使后续 sync 写入失败，也能在本机恢复
      await saveConfigsToLocalBackup(configsToSave, sourcesToSave, selectedConfigIndex, updatedAt);

      // 若检测到 sync 上有更新且当前标签页可能滞后：做一次“保守合并”以避免误覆盖
      // 合并策略：以 sync 为底，按 id 用本地配置覆盖；这样至少不会把其它标签页新加的配置“抹掉”。
      const selectedId = apiConfigs?.[selectedConfigIndex]?.id || null;
      const remote = await loadConfigsFromSyncChunked();
      if (remote?.state === 'ok') {
        const remoteUpdatedAt = Number(remote?.meta?.updatedAt || 0);
        if (remoteUpdatedAt && remoteUpdatedAt > lastMetaUpdatedAt) {
          const localById = new Map(configsToSave.map(c => [c.id, c]));
          const localSourceById = new Map(sourcesToSave.map(source => [source.id, source]));
          const merged = [];
          const mergedSources = [];
          remote.items.forEach((cfg) => {
            const local = localById.get(cfg.id);
            if (local) {
              merged.push(local);
              localById.delete(cfg.id);
            } else {
              merged.push(cfg);
            }
          });
          localById.forEach((cfg) => merged.push(cfg));

          (Array.isArray(remote.connectionSources) ? remote.connectionSources : []).forEach((source) => {
            const localSource = localSourceById.get(source.id);
            if (localSource) {
              mergedSources.push(localSource);
              localSourceById.delete(source.id);
            } else {
              mergedSources.push(source);
            }
          });
          localSourceById.forEach((source) => mergedSources.push(source));

          const remigrated = migrateConnectionSourcesAndConfigs(merged, mergedSources);
          connectionSources = normalizeConnectionSourcesAfterMigration(remigrated.connectionSources);
          apiConfigs = normalizeApiConfigsAfterMigration(remigrated.apiConfigs, connectionSources);

          configsToSave.length = 0;
          apiConfigs.forEach(c => configsToSave.push({ ...c }));
          sourcesToSave.length = 0;
          connectionSources.forEach(source => sourcesToSave.push({ ...source }));

          if (selectedId) {
            const newIndex = apiConfigs.findIndex(c => c.id === selectedId);
            selectedConfigIndex = (newIndex >= 0) ? newIndex : Math.min(selectedConfigIndex, apiConfigs.length - 1);
          } else {
            selectedConfigIndex = Math.min(selectedConfigIndex, apiConfigs.length - 1);
          }

          // 合并发生意味着当前 UI 很可能不是最新：重渲染以保持一致
          renderConnectionSources();
          renderAPICards();
          renderFavoriteApis();
        }
      }

      // 同步到 sync（分片以规避单项 8KB），并同步 selectedConfigIndex（同一次 set）
      const syncSave = await saveConfigsToSyncChunked(configsToSave, sourcesToSave);
      if (syncSave?.ok) {
        lastMetaUpdatedAt = Math.max(lastMetaUpdatedAt, Number(syncSave.updatedAt) || 0);
        try { await chrome.storage.sync.remove(['apiConfigs']); } catch (_) {}
      } else {
        const now = Date.now();
        if ((now - lastSyncSaveWarningAt) > SYNC_SAVE_WARNING_COOLDOWN_MS) {
          lastSyncSaveWarningAt = now;
          utils?.showNotification?.({
            type: 'warning',
            message: '云端 API 设置同步失败，已写入本地备份',
            description: '可能是 sync 写入配额/网络波动导致；稍后再保存一次即可。'
          });
        }
      }

      // 清理本地遗留的旧 local 缓存（如有），注意不要删除新的备份键
      try { await chrome.storage.local.remove(['apiConfigs', 'selectedConfigIndex']); } catch (_) {}

      emitApiConfigsUpdated();
    } catch (error) {
      console.error('保存 API 配置失败:', error);
    }
  }

  // 跨标签页同步：监听 storage 变更（sync + local）
  function setupStorageSyncListeners() {
    try {
      chrome.storage.onChanged.addListener(async (changes, areaName) => {
        if (areaName === 'local') {
          if (changes[BLACKLIST_STORAGE_KEY]) {
            await loadApiKeyBlacklist();
          }
          return;
        }
        if (areaName !== 'sync') return;
        let needReload = false;
        if (changes[SYNC_CHUNK_META_KEY]) {
          const ts = Number(changes[SYNC_CHUNK_META_KEY]?.newValue?.updatedAt || 0);
          if (ts && ts > lastMetaUpdatedAt) {
            lastMetaUpdatedAt = ts;
            needReload = true;
          }
        }
        if (changes['selectedConfigIndex']) {
          selectedConfigIndex = Number(changes['selectedConfigIndex']?.newValue || 0);
          needReload = true;
        }
        Object.keys(changes).forEach((k) => { if (k.startsWith(SYNC_CHUNK_KEY_PREFIX)) needReload = true; });
        if (needReload) {
          const loaded = await loadConfigsFromSyncChunked();
          if (loaded?.state === 'ok' && loaded.items && Array.isArray(loaded.items)) {
            const migrated = migrateConnectionSourcesAndConfigs(loaded.items, loaded.connectionSources);
            connectionSources = normalizeConnectionSourcesAfterMigration(migrated.connectionSources);
            apiConfigs = normalizeApiConfigsAfterMigration(migrated.apiConfigs, connectionSources);
            invalidateAllModelListCaches();
            selectedConfigIndex = Math.max(0, Math.min(selectedConfigIndex, apiConfigs.length - 1));
            // 同步到本地备份，确保“最近一次可用配置”始终存在
            try { await saveConfigsToLocalBackup(apiConfigs, connectionSources, selectedConfigIndex, Number(loaded?.meta?.updatedAt || Date.now())); } catch (_) {}

            renderConnectionSources();
            renderAPICards();
            renderFavoriteApis();
            emitApiConfigsUpdated();
          }
        }
      });
    } catch (e) {
      console.warn('注册 API 配置跨标签同步失败（忽略）：', e);
    }
  }

  /**
   * 生成“连接凭证”的唯一标识符（以连接源为主，回退到连接字段签名）
   * @param {Object} config - API 配置对象
   * @returns {string} 唯一标识符
   */
  function getConfigIdentifier(config) {
    const effective = resolveEffectiveConfig(config, { includeSource: true }) || config || {};
    const source = effective?.__connectionSource;
    if (source?.id) return source.id;
    const connectionType = getConfigConnectionType(effective);
    const normalizedBaseUrl = normalizeConfigBaseUrlByConnection(connectionType, effective?.baseUrl);
    const normalizedFilePath = normalizeApiKeyFilePath(effective?.apiKeyFilePath);
    const normalizedKeys = normalizeApiKeys(effective?.apiKey);
    return JSON.stringify([connectionType, normalizedBaseUrl, normalizedFilePath, normalizedKeys]);
  }

  function normalizeUrlPathname(pathname) {
    const raw = (typeof pathname === 'string') ? pathname.trim() : '';
    if (!raw || raw === '/') return '';
    const noTrailingSlash = raw.replace(/\/+$/, '');
    return noTrailingSlash.startsWith('/') ? noTrailingSlash : `/${noTrailingSlash}`;
  }

  function appendUrlPathname(basePath, segment) {
    const normalizedBasePath = normalizeUrlPathname(basePath);
    const normalizedSegment = String(segment || '').replace(/^\/+/, '');
    if (!normalizedSegment) return normalizedBasePath || '/';
    if (!normalizedBasePath) return `/${normalizedSegment}`;
    return `${normalizedBasePath}/${normalizedSegment}`;
  }

  function parseHttpBaseUrl(baseUrl) {
    const raw = (typeof baseUrl === 'string') ? baseUrl.trim() : '';
    if (!raw) return null;
    try {
      const parsed = new URL(raw);
      const protocol = String(parsed.protocol || '').toLowerCase();
      if (protocol !== 'http:' && protocol !== 'https:') return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function buildOpenAIModelListPath(basePath) {
    // OpenAI 官方模型列表端点为 /v1/models；这里按 basePath 推断前缀后固定到该路径，
    // 避免多端点探测导致的额外请求噪声。
    const normalizedBasePath = normalizeUrlPathname(basePath)
      .replace(/\/models\/[^/]+$/i, '')
      .replace(/\/models$/i, '')
      .replace(/\/chat\/completions(?:\/.*)?$/i, '')
      .replace(/\/responses(?:\/.*)?$/i, '')
      .replace(/\/completions(?:\/.*)?$/i, '');

    const versionMatch = normalizedBasePath.match(/^(.*\/v\d+(?:alpha|beta)?)(?:\/.*)?$/i);
    if (versionMatch?.[1]) {
      return appendUrlPathname(versionMatch[1], 'models');
    }
    return '/v1/models';
  }

  function buildGeminiModelListPath(basePath) {
    // Gemini 模型列表严格固定为 v1beta/models，只构造一个请求地址，避免多端点探测。
    const normalizedBasePath = normalizeUrlPathname(basePath).replace(/:(streamGenerateContent|generateContent)$/i, '');
    const trimmed = normalizedBasePath
      .replace(/\/models\/[^/]+$/i, '')
      .replace(/\/models$/i, '')
      .replace(/\/v1beta$/i, '');
    if (!trimmed) return '/v1beta/models';
    return appendUrlPathname(trimmed, 'v1beta/models');
  }

  function buildModelListRequestCandidates(config, selectedKey) {
    const connectionType = getConfigConnectionType(config);
    const normalizedBaseUrl = normalizeConfigBaseUrlByConnection(connectionType, config?.baseUrl);
    const parsedBase = parseHttpBaseUrl(normalizedBaseUrl);
    if (!parsedBase) return [];

    const pathCandidates = connectionType === CONNECTION_TYPE_GEMINI
      ? [buildGeminiModelListPath(parsedBase.pathname || '/')]
      : [buildOpenAIModelListPath(parsedBase.pathname || '/')];

    const seen = new Set();
    const candidates = [];
    pathCandidates.forEach((path) => {
      const endpoint = new URL(parsedBase.toString());
      endpoint.pathname = path;
      endpoint.hash = '';
      if (connectionType === CONNECTION_TYPE_GEMINI) {
        if (endpoint.searchParams.get('alt') === 'sse') {
          endpoint.searchParams.delete('alt');
        }
        if (selectedKey) {
          endpoint.searchParams.set('key', selectedKey);
        }
      }
      const finalUrl = endpoint.toString();
      if (seen.has(finalUrl)) return;
      seen.add(finalUrl);

      const headers = { Accept: 'application/json' };
      if (connectionType !== CONNECTION_TYPE_GEMINI && selectedKey) {
        headers.Authorization = `Bearer ${selectedKey}`;
      }
      candidates.push({ url: finalUrl, headers });
    });
    return candidates;
  }

  function pickApiKeyForModelListing(config, keys) {
    const normalizedKeys = normalizeApiKeys(keys);
    if (normalizedKeys.length <= 0) return '';
    if (normalizedKeys.length === 1) return normalizedKeys[0];
    const configId = getConfigIdentifier(config || {});
    const startIndex = Number.isFinite(apiKeyUsageIndex[configId]) ? apiKeyUsageIndex[configId] : 0;
    const nextIndex = getNextUsableKeyIndex({ ...config, apiKey: normalizedKeys }, startIndex);
    if (nextIndex < 0) return normalizedKeys[0];
    apiKeyUsageIndex[configId] = (nextIndex + 1) % normalizedKeys.length;
    return normalizedKeys[nextIndex];
  }

  async function fetchJsonWithTimeout(url, options = {}, timeoutMs = MODEL_LIST_FETCH_TIMEOUT_MS) {
    const safeTimeout = Math.max(1000, Number(timeoutMs) || MODEL_LIST_FETCH_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), safeTimeout);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      if (!text) {
        return { response, payload: null, parseError: null };
      }
      try {
        const payload = JSON.parse(text);
        return { response, payload, parseError: null };
      } catch (error) {
        return { response, payload: null, parseError: error };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  function collectModelEntries(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    const queue = [payload];
    const visited = new Set();
    const listKeys = ['data', 'models', 'items', 'results', 'model_list', 'modelList'];
    const nestedKeys = ['result', 'response', 'output', 'payload'];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || typeof current !== 'object') continue;
      if (visited.has(current)) continue;
      visited.add(current);

      for (const key of listKeys) {
        if (Array.isArray(current[key])) {
          return current[key];
        }
      }
      nestedKeys.forEach((key) => {
        const nested = current[key];
        if (nested && typeof nested === 'object') queue.push(nested);
      });
    }
    return [];
  }

  function extractModelOption(entry, connectionType) {
    if (typeof entry === 'string') {
      const rawId = entry.trim();
      if (!rawId) return null;
      const normalizedId = connectionType === CONNECTION_TYPE_GEMINI ? normalizeGeminiModelName(rawId) : rawId;
      if (!normalizedId) return null;
      return { id: normalizedId, label: normalizedId };
    }
    if (!entry || typeof entry !== 'object') return null;
    const rawId = [
      entry.id,
      entry.model,
      entry.name,
      entry.modelId,
      entry.model_id,
      entry.slug
    ].find(value => (typeof value === 'string') && value.trim());
    if (!rawId) return null;
    const normalizedId = connectionType === CONNECTION_TYPE_GEMINI
      ? normalizeGeminiModelName(rawId)
      : String(rawId).trim();
    if (!normalizedId) return null;

    const displayName = [
      entry.displayName,
      entry.display_name,
      entry.title,
      entry.label
    ].find(value => (typeof value === 'string') && value.trim());
    const normalizedDisplayName = (typeof displayName === 'string') ? displayName.trim() : '';
    const label = normalizedDisplayName
      && normalizedDisplayName.toLowerCase() !== normalizedId.toLowerCase()
      ? `${normalizedDisplayName} (${normalizedId})`
      : normalizedId;
    return { id: normalizedId, label };
  }

  function normalizeModelOptionsFromPayload(payload, connectionType) {
    const entries = collectModelEntries(payload);
    const optionById = new Map();
    entries.forEach((entry) => {
      const option = extractModelOption(entry, connectionType);
      if (!option) return;
      const key = option.id.toLowerCase();
      if (!optionById.has(key)) optionById.set(key, option);
    });
    return Array.from(optionById.values()).sort((a, b) =>
      a.id.localeCompare(b.id, 'en', { sensitivity: 'base' }));
  }

  // 模型列表接口在不同服务商上的路径风格不一致：
  // - Gemini：固定只请求 v1beta/models（单端点，不探测其它路径）；
  // - OpenAI 兼容 / Responses：固定请求 /v1/models（若 basePath 含前缀，则保留前缀后拼接 v*/models）。
  async function fetchModelOptionsForConfig(config) {
    const effectiveConfig = resolveEffectiveConfig(config) || config || {};
    const connectionType = getConfigConnectionType(effectiveConfig);
    const resolvedKeys = await resolveRuntimeApiKeys(effectiveConfig, () => {});
    const selectedKey = pickApiKeyForModelListing(effectiveConfig, resolvedKeys?.keys || []);
    const candidates = buildModelListRequestCandidates(effectiveConfig, selectedKey);
    if (candidates.length <= 0) {
      return { ok: false, options: [], endpoint: '', error: '端点 URL 无效，无法拉取模型列表。' };
    }

    let lastError = '';
    for (const candidate of candidates) {
      try {
        const { response, payload, parseError } = await fetchJsonWithTimeout(candidate.url, {
          method: 'GET',
          headers: candidate.headers,
          cache: 'no-store'
        });
        if (!response?.ok) {
          lastError = `HTTP ${response?.status || 0}（${candidate.url}）`;
          continue;
        }
        if (parseError || !payload) {
          lastError = `响应不是有效 JSON（${candidate.url}）`;
          continue;
        }
        const options = normalizeModelOptionsFromPayload(payload, connectionType);
        if (options.length > 0) {
          return { ok: true, options, endpoint: candidate.url, error: '' };
        }
        lastError = `未从响应中识别到模型列表（${candidate.url}）`;
      } catch (error) {
        if (error?.name === 'AbortError') {
          lastError = `请求超时（${candidate.url}）`;
        } else {
          lastError = `${error?.message || '请求失败'}（${candidate.url}）`;
        }
      }
    }

    return {
      ok: false,
      options: [],
      endpoint: candidates[candidates.length - 1]?.url || '',
      error: lastError || '模型列表请求失败'
    };
  }

  function normalizeConnectionSourceId(connectionSourceId) {
    return (typeof connectionSourceId === 'string') ? connectionSourceId.trim() : '';
  }

  function invalidateModelListCacheForSource(connectionSourceId) {
    const normalizedSourceId = normalizeConnectionSourceId(connectionSourceId);
    if (!normalizedSourceId) return;
    modelListCacheBySourceId.delete(normalizedSourceId);
    modelListPendingBySourceId.delete(normalizedSourceId);
  }

  function invalidateAllModelListCaches() {
    modelListCacheBySourceId.clear();
    modelListPendingBySourceId.clear();
  }

  function getModelOptionsBySourceId(connectionSourceId) {
    const normalizedSourceId = normalizeConnectionSourceId(connectionSourceId);
    if (!normalizedSourceId) return [];
    const cached = modelListCacheBySourceId.get(normalizedSourceId);
    if (!cached || cached.status !== 'ready' || !Array.isArray(cached.options)) return [];
    return cached.options;
  }

  function refreshRenderedModelNameOptions() {
    if (!apiCardsContainer) return;
    const cards = apiCardsContainer.querySelectorAll('.api-card:not(.template)');
    cards.forEach((card) => {
      const sourceSelect = card.querySelector('.connection-source-id');
      const modelOptions = card.querySelector('.model-name-options');
      if (!modelOptions) return;
      const sourceId = getConnectionSourceById(sourceSelect?.value)?.id || '';
      const options = getModelOptionsBySourceId(sourceId);
      modelOptions.innerHTML = '';
      options.forEach((item) => {
        if (!item?.id) return;
        const option = document.createElement('option');
        option.value = item.id;
        if (item.label && item.label !== item.id) {
          option.label = item.label;
        }
        modelOptions.appendChild(option);
      });
    });
  }

  async function fetchModelOptionsForConnectionSource(connectionSourceId, options = {}) {
    const normalizedSourceId = normalizeConnectionSourceId(connectionSourceId);
    if (!normalizedSourceId) return { status: 'idle', options: [] };
    const source = getConnectionSourceById(normalizedSourceId);
    if (!source) return { status: 'idle', options: [] };

    const force = !!options?.force;
    const cached = modelListCacheBySourceId.get(normalizedSourceId);
    if (!force && cached?.status === 'ready' && Array.isArray(cached.options) && cached.options.length > 0) {
      return cached;
    }
    if (!force && cached?.status === 'error') {
      return cached;
    }

    const pending = modelListPendingBySourceId.get(normalizedSourceId);
    if (pending) return pending;

    modelListCacheBySourceId.set(normalizedSourceId, {
      status: 'loading',
      options: Array.isArray(cached?.options) ? cached.options : [],
      endpoint: cached?.endpoint || '',
      error: '',
      updatedAt: Date.now()
    });

    const task = (async () => {
      const transientConfig = createDefaultApiConfig(normalizedSourceId, {
        id: `source-model-list-${normalizedSourceId}`,
        modelName: '',
        displayName: ''
      });
      const result = await fetchModelOptionsForConfig(transientConfig);
      if (result.ok) {
        const readyState = {
          status: 'ready',
          options: result.options,
          endpoint: result.endpoint,
          error: '',
          updatedAt: Date.now()
        };
        modelListCacheBySourceId.set(normalizedSourceId, readyState);
        refreshRenderedModelNameOptions();
        return readyState;
      }
      const errorState = {
        status: 'error',
        options: [],
        endpoint: result.endpoint || '',
        error: result.error || '模型列表请求失败',
        updatedAt: Date.now()
      };
      modelListCacheBySourceId.set(normalizedSourceId, errorState);
      refreshRenderedModelNameOptions();
      return errorState;
    })();

    modelListPendingBySourceId.set(normalizedSourceId, task);
    try {
      return await task;
    } finally {
      modelListPendingBySourceId.delete(normalizedSourceId);
    }
  }

  // 将卡片索引安全转为数字，非法值返回 null。
  function parseCardIndex(value) {
    const index = Number.parseInt(value, 10);
    return Number.isFinite(index) ? index : null;
  }

  // 清理拖动高亮与插入指示，避免残留样式干扰后续操作。
  function clearDragOverStyles() {
    if (!apiCardsContainer) return;
    apiCardsContainer.querySelectorAll('.api-card.drag-over, .api-card.drag-insert-before, .api-card.drag-insert-after').forEach((card) => {
      card.classList.remove('drag-over', 'drag-insert-before', 'drag-insert-after');
    });
  }

  // 计算拖动落点是在卡片上半区还是下半区，用于显示“插入到哪一侧”。
  function getDropPosition(card, clientY) {
    const rect = card.getBoundingClientRect();
    return clientY > rect.top + rect.height / 2 ? 'after' : 'before';
  }

  // 拖动排序：在数组内移动并同步选中索引，避免选中项错位。
  function moveConfig(fromIndex, toIndex) {
    if (fromIndex === toIndex) return false;
    if (fromIndex < 0 || fromIndex >= apiConfigs.length) return false;

    const [moved] = apiConfigs.splice(fromIndex, 1);
    const insertIndex = Math.max(0, Math.min(toIndex, apiConfigs.length));
    apiConfigs.splice(insertIndex, 0, moved);

    if (selectedConfigIndex === fromIndex) {
      selectedConfigIndex = insertIndex;
    } else if (fromIndex < insertIndex && selectedConfigIndex > fromIndex && selectedConfigIndex <= insertIndex) {
      selectedConfigIndex -= 1;
    } else if (fromIndex > insertIndex && selectedConfigIndex >= insertIndex && selectedConfigIndex < fromIndex) {
      selectedConfigIndex += 1;
    }

    return true;
  }

  function getConnectionSourceRefCount(connectionSourceId) {
    if (!connectionSourceId) return 0;
    return apiConfigs.filter(config => config?.connectionSourceId === connectionSourceId).length;
  }

  function renderConnectionSources() {
    const listContainer = document.getElementById('connection-sources-list');
    const templateItem = listContainer?.querySelector('.connection-source-item.template');
    if (!listContainer || !templateItem) return;

    const templateClone = templateItem.cloneNode(true);
    listContainer.innerHTML = '';
    listContainer.appendChild(templateClone);

    connectionSources.forEach((source, index) => {
      const card = createConnectionSourceCard(source, index, templateClone);
      listContainer.appendChild(card);
    });
  }

  function createConnectionSourceCard(source, index, templateItem) {
    const template = templateItem.cloneNode(true);
    template.classList.remove('template');
    template.style.display = '';
    template.dataset.connectionSourceId = source.id;

    const titleElement = template.querySelector('.connection-source-item-title');
    const nameInput = template.querySelector('.connection-source-name');
    const connectionTypeSelect = template.querySelector('.connection-source-type');
    const baseUrlLabel = template.querySelector('.connection-source-base-url-label');
    const baseUrlInput = template.querySelector('.connection-source-base-url');
    const baseUrlHint = template.querySelector('.connection-source-base-url-hint');
    const apiKeyInput = template.querySelector('.connection-source-api-key');
    const apiKeyFilePathInput = template.querySelector('.connection-source-api-key-file-path');
    const deleteButton = template.querySelector('.connection-source-delete-btn');
    const refCountElement = template.querySelector('.connection-source-ref-count');

    const applyConnectionTypeUiState = (rawConnectionType) => {
      const normalizedType = normalizeConnectionType(rawConnectionType) || CONNECTION_TYPE_OPENAI;
      if (connectionTypeSelect) connectionTypeSelect.value = normalizedType;
      if (!baseUrlInput) return;
      if (normalizedType === CONNECTION_TYPE_GEMINI) {
        if (baseUrlLabel) baseUrlLabel.textContent = 'Gemini API 端点（可自定义）';
        baseUrlInput.placeholder = '例如 https://generativelanguage.googleapis.com 或你的代理地址';
        if (baseUrlHint) {
          baseUrlHint.textContent = '支持官方地址与代理地址；支持 {model}/{action}/{method}/{key} 占位符。';
        }
      } else if (normalizedType === CONNECTION_TYPE_OPENAI_RESPONSES) {
        if (baseUrlLabel) baseUrlLabel.textContent = 'OpenAI Responses 端点 URL';
        baseUrlInput.placeholder = `例如 ${OPENAI_RESPONSES_DEFAULT_BASE_URL}`;
        if (baseUrlHint) {
          baseUrlHint.textContent = 'Responses 模式会按 input 结构请求并解析 response.output_text.* 事件；无 key 时会按免鉴权模式请求。';
        }
      } else {
        if (baseUrlLabel) baseUrlLabel.textContent = 'API 端点 URL';
        baseUrlInput.placeholder = `例如 ${OPENAI_DEFAULT_BASE_URL}`;
        if (baseUrlHint) {
          baseUrlHint.textContent = 'OpenAI 兼容模式走 chat/completions；无 key 时会按免鉴权模式请求。';
        }
      }
    };

    const normalizedType = normalizeConnectionType(source?.connectionType) || inferConnectionTypeByBaseUrl(source?.baseUrl);
    const normalizedBaseUrl = normalizeConfigBaseUrlByConnection(normalizedType, source?.baseUrl);
    const normalizedName = normalizeConnectionSourceName(source?.name) || buildConnectionSourceDisplayName(source, index);
    const refCount = getConnectionSourceRefCount(source?.id);

    if (titleElement) titleElement.textContent = normalizedName;
    if (nameInput) nameInput.value = normalizedName;
    if (connectionTypeSelect) connectionTypeSelect.value = normalizedType;
    if (baseUrlInput) baseUrlInput.value = normalizedBaseUrl;
    if (refCountElement) {
      refCountElement.textContent = `已被 ${refCount} 个 API 使用`;
    }

    if (apiKeyInput) {
      if (Array.isArray(source?.apiKey)) {
        apiKeyInput.value = source.apiKey.join(',');
      } else {
        apiKeyInput.value = source?.apiKey || '';
      }
    }
    if (apiKeyFilePathInput) {
      apiKeyFilePathInput.value = source?.apiKeyFilePath || '';
    }
    applyConnectionTypeUiState(normalizedType);

    const persistSourceChanges = () => {
      const sourceIndex = connectionSources.findIndex(item => item.id === source.id);
      if (sourceIndex < 0) return;
      const sourceId = connectionSources[sourceIndex]?.id || source.id;
      const nextType = normalizeConnectionType(connectionTypeSelect?.value) || CONNECTION_TYPE_OPENAI;
      let nextBaseUrl = normalizeConfigBaseUrlByConnection(nextType, baseUrlInput?.value || '');
      if (!nextBaseUrl && nextType === CONNECTION_TYPE_OPENAI) {
        nextBaseUrl = OPENAI_DEFAULT_BASE_URL;
      } else if (!nextBaseUrl && nextType === CONNECTION_TYPE_OPENAI_RESPONSES) {
        nextBaseUrl = OPENAI_RESPONSES_DEFAULT_BASE_URL;
      }

      let apiKeyValue = normalizeApiKeyValue(apiKeyInput?.value || '');
      if (Array.isArray(apiKeyValue) && apiKeyValue.length <= 1) {
        apiKeyValue = apiKeyValue[0] || '';
      }

      const nameCandidate = normalizeConnectionSourceName(nameInput?.value);
      const fallbackName = buildConnectionSourceDisplayName({
        ...connectionSources[sourceIndex],
        connectionType: nextType,
        baseUrl: nextBaseUrl
      }, index);

      connectionSources[sourceIndex] = {
        ...connectionSources[sourceIndex],
        name: nameCandidate || fallbackName,
        connectionType: nextType,
        baseUrl: nextBaseUrl,
        apiKey: apiKeyValue,
        apiKeyFilePath: normalizeApiKeyFilePath(apiKeyFilePathInput?.value)
      };
      clearApiKeyFileCacheEntry({ connectionSourceId: source.id });
      invalidateModelListCacheForSource(sourceId);
      saveAPIConfigs();
      renderConnectionSources();
      renderAPICards();
      renderFavoriteApis();
    };

    if (nameInput) {
      nameInput.addEventListener('change', persistSourceChanges);
      nameInput.addEventListener('blur', persistSourceChanges);
    }
    if (connectionTypeSelect) {
      connectionTypeSelect.addEventListener('change', () => {
        applyConnectionTypeUiState(connectionTypeSelect.value);
        persistSourceChanges();
      });
    }
    if (baseUrlInput) {
      baseUrlInput.addEventListener('change', persistSourceChanges);
      baseUrlInput.addEventListener('blur', persistSourceChanges);
    }
    if (apiKeyInput) {
      apiKeyInput.addEventListener('change', persistSourceChanges);
      // 聚焦时临时明文显示，便于检查/编辑；失焦后恢复密码态，降低肩窥风险。
      apiKeyInput.addEventListener('focus', () => {
        if (apiKeyInput.type !== 'text') {
          apiKeyInput.type = 'text';
        }
      });
      apiKeyInput.addEventListener('blur', () => {
        if (apiKeyInput.type !== 'password') {
          apiKeyInput.type = 'password';
        }
      });
    }
    if (apiKeyFilePathInput) {
      apiKeyFilePathInput.addEventListener('change', persistSourceChanges);
      apiKeyFilePathInput.addEventListener('blur', persistSourceChanges);
    }

    if (deleteButton) {
      let deleteConfirmTimer = null;
      const resetDeleteConfirm = () => {
        deleteButton.dataset.confirming = 'false';
        deleteButton.classList.remove('is-confirming');
        template.classList.remove('delete-confirming');
        deleteButton.title = '删除';
        if (deleteConfirmTimer) {
          clearTimeout(deleteConfirmTimer);
          deleteConfirmTimer = null;
        }
      };

      deleteButton.addEventListener('click', (e) => {
        e.stopPropagation();
        if (deleteButton.dataset.confirming === 'true') {
          resetDeleteConfirm();
        } else {
          // 删除连接源改为“原地二次确认”，降低误触成本。
          deleteButton.dataset.confirming = 'true';
          deleteButton.classList.add('is-confirming');
          template.classList.add('delete-confirming');
          deleteButton.title = '再次点击确认删除';
          deleteConfirmTimer = setTimeout(() => {
            resetDeleteConfirm();
          }, DELETE_CONFIRM_TIMEOUT_MS);
          return;
        }

        let affectedConfigs = 0;
        // 允许删除被引用连接源：将引用它的 API 标记为“未配置连接源”。
        apiConfigs.forEach((configItem) => {
          if (!configItem || configItem.connectionSourceId !== source.id) return;
          configItem.connectionSourceId = '';
          affectedConfigs += 1;
        });
        connectionSources = connectionSources.filter(item => item.id !== source.id);
        delete apiKeyUsageIndex[source.id];
        clearApiKeyFileCacheEntry({ connectionSourceId: source.id });
        invalidateModelListCacheForSource(source.id);
        saveAPIConfigs();
        renderConnectionSources();
        renderAPICards();
        renderFavoriteApis();
        if (affectedConfigs > 0) {
          utils?.showNotification?.({
            type: 'warning',
            message: `已删除连接源，${affectedConfigs} 个 API 变为“未配置连接源”`,
            duration: 2800
          });
        }
      });
    }

    return template;
  }

  /**
   * 渲染 API 卡片
   */
  function renderAPICards() {
    // 确保模板元素在
    const templateCard = document.querySelector('.api-card.template');
    if (!templateCard) {
      console.error('找不到模板卡片元素');
      return;
    }

    // 保存模板的副本
    const templateClone = templateCard.cloneNode(true);

    // 清空现有卡片
    apiCardsContainer.innerHTML = '';

    // 先重新添加模板（保持隐藏状态）
    apiCardsContainer.appendChild(templateClone);

    // 渲染实际的卡
    apiConfigs.forEach((config, index) => {
      const card = createAPICard(config, index, templateClone);
      apiCardsContainer.appendChild(card);
    });
  }

  /**
   * 创建并渲染单个 API 配置卡片
   * @param {Object} config - API 配置对象
   * @param {string} [config.connectionSourceId] - 连接源 ID
   * @param {string} [config.modelName] - 模型名称
   * @param {number} [config.temperature] - temperature 值（可为 0）
   * @param {boolean} [config.isFavorite] - 是否收藏
   * @param {boolean} [config.enableAskOtherAiTool] - 是否允许“向其他AI提问”工具使用该配置
   * @param {string} [config.customParams] - 自定义参数
   * @param {string} [config.userMessagePreprocessorTemplate] - 用户消息预处理模板（支持 {{#system}}/{{#assistant}}/{{#user}} 角色块与 {{no_system_prompt}} 控制标记）
   * @param {boolean} [config.userMessagePreprocessorIncludeInHistory] - 预处理结果是否写入历史
   * @param {number} index - 该配置在 apiConfigs 数组中的索引
   * @param {HTMLElement} templateCard - 用于克隆的卡片模板 DOM
   * @returns {HTMLElement} 渲染后的卡片元素
   */
  function createAPICard(config, index, templateCard) {
    // 克隆模板
    const template = templateCard.cloneNode(true);
    template.classList.remove('template');
    template.style.display = '';
    template.dataset.index = String(index);

    if (index === selectedConfigIndex) {
      template.classList.add('selected');
    }

    // 设置标题
    const titleElement = template.querySelector('.api-card-title');
    const updateCardTitle = () => {
      const currentConfig = apiConfigs[index] || config || {};
      const baseTitle = getApiConfigDisplayTitle(currentConfig);
      const missingSource = !hasConfiguredConnectionSource(currentConfig);
      titleElement.textContent = missingSource ? `⚠ ${baseTitle}` : baseTitle;
      titleElement.title = missingSource ? `未配置连接源：${baseTitle}` : baseTitle;
      template.classList.toggle('missing-connection-source', missingSource);
    };

    const connectionSourceSelect = template.querySelector('.connection-source-id');
    const connectionSourceHint = template.querySelector('.connection-source-hint');
    const displayNameInput = template.querySelector('.display-name');
    const modelNameInput = template.querySelector('.model-name');
    const modelNameOptions = template.querySelector('.model-name-options');
    const temperatureInput = template.querySelector('.temperature');
    const temperatureValue = template.querySelector('.temperature-value');
    const apiForm = template.querySelector('.api-form');
    const favoriteBtn = template.querySelector('.favorite-btn');
    const selectBtn = template.querySelector('.select-btn');
    const customParamsInput = template.querySelector('.custom-params');
    const customSystemPromptInput = template.querySelector('.custom-system-prompt');
    const askOtherAiToolEnabledToggle = template.querySelector('.ask-other-ai-tool-enabled');
    const userMessageTemplateInput = template.querySelector('.user-message-template');
    const userMessageTemplateIncludeHistoryToggle = template.querySelector('.user-message-template-include-history');
    const userMessageTemplateHelpBtn = template.querySelector('.template-help-icon');
    const userMessageTemplateCopyBtn = template.querySelector('.template-inject-copy-btn');
    const refreshConnectionSourceOptions = () => {
      if (!connectionSourceSelect) return;
      const currentSourceId = (typeof apiConfigs[index]?.connectionSourceId === 'string')
        ? apiConfigs[index].connectionSourceId.trim()
        : '';
      connectionSourceSelect.innerHTML = '';
      // 始终保留“未配置连接源”选项，支持显式置空绑定关系。
      const emptyOption = document.createElement('option');
      emptyOption.value = '';
      emptyOption.textContent = '未配置连接源';
      connectionSourceSelect.appendChild(emptyOption);
      connectionSources.forEach((source, sourceIndex) => {
        const option = document.createElement('option');
        option.value = source.id;
        option.textContent = buildConnectionSourceDisplayName(source, sourceIndex);
        connectionSourceSelect.appendChild(option);
      });
      const normalizedSourceId = getConnectionSourceById(currentSourceId)?.id || '';
      connectionSourceSelect.value = normalizedSourceId;
      if (apiConfigs[index] && apiConfigs[index].connectionSourceId !== normalizedSourceId) {
        apiConfigs[index].connectionSourceId = normalizedSourceId;
      }
    };
    const refreshConnectionSourceHint = () => {
      if (!connectionSourceHint) return;
      const selectedSourceId = (typeof connectionSourceSelect?.value === 'string')
        ? connectionSourceSelect.value.trim()
        : '';
      const selectedSource = getConnectionSourceById(selectedSourceId);
      if (!selectedSource) {
        // 未配置连接源时给出明确风险提示，并给卡片加警示态，便于快速定位。
        connectionSourceHint.textContent = '⚠ 未配置连接源：该 API 暂无端点与鉴权信息。';
        connectionSourceHint.classList.add('warning');
        updateCardTitle();
        return;
      }
      connectionSourceHint.classList.remove('warning');
      const sourceType = normalizeConnectionType(selectedSource.connectionType) || inferConnectionTypeByBaseUrl(selectedSource.baseUrl);
      const sourceBaseUrl = normalizeConfigBaseUrlByConnection(sourceType, selectedSource.baseUrl);
      const sourceLabel = getConnectionTypeDisplayLabel(sourceType);
      connectionSourceHint.textContent = `${sourceLabel} · ${sourceBaseUrl || '未设置端点'} · 统一复用鉴权`;
      updateCardTitle();
    };
    const getSelectedSourceId = () =>
      getConnectionSourceById(connectionSourceSelect?.value)?.id || '';

    if (modelNameInput && modelNameOptions) {
      const dataListId = `api-model-options-${config.id || index}`;
      modelNameOptions.id = dataListId;
      modelNameInput.setAttribute('list', dataListId);
    }

    const applyModelNameOptions = () => {
      if (!modelNameOptions) return;
      const selectedSourceId = getSelectedSourceId();
      const options = getModelOptionsBySourceId(selectedSourceId);
      modelNameOptions.innerHTML = '';
      options.forEach((item) => {
        if (!item?.id) return;
        const option = document.createElement('option');
        option.value = item.id;
        if (item.label && item.label !== item.id) {
          option.label = item.label;
        }
        modelNameOptions.appendChild(option);
      });
    };

    const ensureModelOptionsLoaded = ({ force = false } = {}) => {
      const selectedSourceId = getSelectedSourceId();
      if (!selectedSourceId) {
        return;
      }
      const cachedState = modelListCacheBySourceId.get(selectedSourceId);
      const cachedOptions = getModelOptionsBySourceId(selectedSourceId);
      if (!force && cachedOptions.length > 0) {
        return;
      }
      // 仅在用户点击模型输入框时才请求；若该源之前拉取失败，点击时允许强制重试。
      const shouldForce = force || cachedState?.status === 'error';
      void fetchModelOptionsForConnectionSource(selectedSourceId, { force: shouldForce }).then(() => {
        if (!template.isConnected) return;
        const latestSourceId = getSelectedSourceId();
        if (latestSourceId !== selectedSourceId) return;
        applyModelNameOptions();
      }).catch(() => {
        // 模型列表加载失败时允许用户继续手动输入模型名，不中断表单交互。
      });
    };
    const customParamsErrorElemId = `custom-params-error-${index}`;
    let lastFormattedCustomParams = '';
    let customParamsValueBeforeEdit = '';
    const ensureCustomParamsErrorElem = () => {
      let errorElem = customParamsInput.parentNode.querySelector(`#${customParamsErrorElemId}`);
      if (!errorElem) {
        errorElem = document.createElement('div');
        errorElem.id = customParamsErrorElemId;
        errorElem.className = 'custom-params-error';
        errorElem.style.color = 'red';
        errorElem.style.fontSize = '12px';
        errorElem.style.marginTop = '4px';
        customParamsInput.parentNode.appendChild(errorElem);
      }
      return errorElem;
    };
    const clearCustomParamsError = () => {
      customParamsInput.style.borderColor = '';
      const errorElem = customParamsInput.parentNode.querySelector(`#${customParamsErrorElemId}`);
      if (errorElem) errorElem.remove();
    };
    const showCustomParamsError = (message) => {
      customParamsInput.style.borderColor = 'red';
      const errorElem = ensureCustomParamsErrorElem();
      errorElem.textContent = message;
    };
    const formatCustomParamsJson = (rawValue) => {
      const trimmed = (typeof rawValue === 'string') ? rawValue.trim() : '';
      if (!trimmed) return { ok: true, formatted: '' };
      try {
        const parsed = JSON.parse(trimmed);
        return { ok: true, formatted: JSON.stringify(parsed, null, 2) };
      } catch (error) {
        return { ok: false, formatted: trimmed, error };
      }
    };
    // 统一入口：右侧“自定义参数”只保留格式化后的 JSON 文本，避免出现同配置多种排版格式。
    const commitCustomParamsFormatted = ({ persist = true } = {}) => {
      const rawValue = customParamsInput.value;
      const result = formatCustomParamsJson(rawValue);
      if (!result.ok) {
        const fallbackValue = (typeof customParamsValueBeforeEdit === 'string') ? customParamsValueBeforeEdit : '';
        customParamsInput.value = fallbackValue;
        showCustomParamsError('JSON 无效，已回退到上一次格式化内容');
        return false;
      }
      customParamsInput.value = result.formatted;
      lastFormattedCustomParams = result.formatted;
      customParamsValueBeforeEdit = result.formatted;
      apiConfigs[index].customParams = result.formatted;
      clearCustomParamsError();
      if (persist) saveAPIConfigs();
      return true;
    };

    const apiFormGrid = apiForm.querySelector('.api-form-grid');
    const getSelectedConnectionTypeForCard = () => {
      const selectedSourceId = (typeof connectionSourceSelect?.value === 'string')
        ? connectionSourceSelect.value.trim()
        : '';
      const selectedSource = getConnectionSourceById(selectedSourceId);
      if (!selectedSource) return '';
      return normalizeConnectionType(selectedSource.connectionType) || inferConnectionTypeByBaseUrl(selectedSource.baseUrl);
    };
    const isResponsesConnectionSelected = () => getSelectedConnectionTypeForCard() === CONNECTION_TYPE_OPENAI_RESPONSES;
    const isGeminiConnectionSelected = () => getSelectedConnectionTypeForCard() === CONNECTION_TYPE_GEMINI;
    const getResponsesSettingsSnapshot = () => normalizeResponsesApiSettings(apiConfigs[index]?.responsesApiSettings) || {};
    const setResponsesSettingsSnapshot = (nextSettings, { persist = true } = {}) => {
      const normalized = normalizeResponsesApiSettings(nextSettings);
      if (normalized) {
        apiConfigs[index].responsesApiSettings = normalized;
      } else {
        delete apiConfigs[index].responsesApiSettings;
      }
      if (persist) saveAPIConfigs();
    };
    const updateResponsesSettingAtPath = (path, value, { persist = true } = {}) => {
      const draft = cloneJsonCompatible(apiConfigs[index]?.responsesApiSettings || {}) || {};
      if (typeof value === 'undefined') {
        deleteNestedValue(draft, path);
      } else {
        setNestedValue(draft, path, value);
      }
      setResponsesSettingsSnapshot(draft, { persist });
    };
    const getGeminiSettingsSnapshot = () => normalizeGeminiApiSettings(apiConfigs[index]?.geminiApiSettings) || {};
    const setGeminiSettingsSnapshot = (nextSettings, { persist = true } = {}) => {
      const normalized = normalizeGeminiApiSettings(nextSettings);
      if (normalized) {
        apiConfigs[index].geminiApiSettings = normalized;
      } else {
        delete apiConfigs[index].geminiApiSettings;
      }
      if (persist) saveAPIConfigs();
    };
    const updateGeminiSettingAtPath = (path, value, { persist = true } = {}) => {
      const draft = cloneJsonCompatible(apiConfigs[index]?.geminiApiSettings || {}) || {};
      if (typeof value === 'undefined') {
        deleteNestedValue(draft, path);
      } else {
        setNestedValue(draft, path, value);
      }
      setGeminiSettingsSnapshot(draft, { persist });
    };
    const parseNumberFieldValue = (rawValue, spec) => {
      const trimmed = (typeof rawValue === 'string') ? rawValue.trim() : '';
      if (!trimmed) return { ok: true, value: undefined };
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) {
        return { ok: false, message: '请输入有效数字' };
      }
      if (Number.isFinite(spec.min) && parsed < spec.min) {
        return { ok: false, message: `最小值为 ${spec.min}` };
      }
      if (Number.isFinite(spec.max) && parsed > spec.max) {
        return { ok: false, message: `最大值为 ${spec.max}` };
      }
      if (spec.step === 1 && !Number.isInteger(parsed)) {
        return { ok: false, message: '该字段只接受整数' };
      }
      return { ok: true, value: parsed };
    };
    const parseJsonFieldValue = (rawValue, spec) => {
      const trimmed = (typeof rawValue === 'string') ? rawValue.trim() : '';
      if (!trimmed) return { ok: true, value: undefined, formatted: '' };
      try {
        const parsed = JSON.parse(trimmed);
        if (spec.jsonMode === 'array' && !Array.isArray(parsed)) {
          return { ok: false, message: '需要填写 JSON 数组' };
        }
        if (spec.jsonMode === 'object' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
          return { ok: false, message: '需要填写 JSON 对象' };
        }
        const compacted = compactResponsesApiSettingValue(parsed);
        if (typeof compacted === 'undefined') {
          return { ok: true, value: undefined, formatted: '' };
        }
        return { ok: true, value: compacted, formatted: JSON.stringify(compacted, null, 2) };
      } catch (_) {
        return { ok: false, message: 'JSON 格式无效' };
      }
    };
    const parseJsonOrStringFieldValue = (rawValue) => {
      const trimmed = (typeof rawValue === 'string') ? rawValue.trim() : '';
      if (!trimmed) return { ok: true, value: undefined, formatted: '' };
      if (/^[A-Za-z0-9_.:-]+$/.test(trimmed)) {
        return { ok: true, value: trimmed, formatted: trimmed };
      }
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'string') {
          const compactedString = compactResponsesApiSettingValue(parsed);
          return {
            ok: true,
            value: compactedString,
            formatted: compactedString || ''
          };
        }
        const compacted = compactResponsesApiSettingValue(parsed);
        if (typeof compacted === 'undefined') {
          return { ok: true, value: undefined, formatted: '' };
        }
        return { ok: true, value: compacted, formatted: JSON.stringify(compacted, null, 2) };
      } catch (_) {
        return { ok: false, message: '请输入简单字符串或合法 JSON' };
      }
    };
    const createApiFieldSettingsSection = ({
      title: sectionTitle,
      description,
      mainSpecs,
      advancedSpecs,
      sectionToggleSpec = null,
      getSettingsSnapshot,
      updateSettingAtPath
    }) => {
      const section = document.createElement('section');
      section.className = 'responses-settings-panel';

      const headerBar = document.createElement('div');
      headerBar.className = 'responses-settings-header';

      const title = document.createElement('div');
      title.className = 'responses-settings-title';
      title.textContent = sectionTitle;
      headerBar.appendChild(title);
      section.appendChild(headerBar);

      let sectionToggleInput = null;
      if (sectionToggleSpec && Array.isArray(sectionToggleSpec.path) && sectionToggleSpec.path.length > 0) {
        const sectionToggleWrap = document.createElement('div');
        sectionToggleWrap.className = 'responses-settings-section-toggle';
        if (sectionToggleSpec.help) {
          sectionToggleWrap.title = sectionToggleSpec.help;
        }

        const sectionToggleText = document.createElement('span');
        sectionToggleText.className = 'responses-settings-section-toggle-text';
        sectionToggleText.textContent = sectionToggleSpec.label || '启用';
        sectionToggleWrap.appendChild(sectionToggleText);

        const sectionToggleSwitch = document.createElement('label');
        sectionToggleSwitch.className = 'switch responses-settings-section-toggle-switch';
        sectionToggleInput = document.createElement('input');
        sectionToggleInput.type = 'checkbox';
        const sectionToggleSlider = document.createElement('span');
        sectionToggleSlider.className = 'slider';
        sectionToggleSwitch.appendChild(sectionToggleInput);
        sectionToggleSwitch.appendChild(sectionToggleSlider);
        sectionToggleWrap.appendChild(sectionToggleSwitch);
        headerBar.appendChild(sectionToggleWrap);
      }

      const body = document.createElement('div');
      body.className = 'responses-settings-body';
      section.appendChild(body);

      const desc = document.createElement('div');
      desc.className = 'responses-settings-description';
      desc.textContent = description;
      body.appendChild(desc);

      const mainGrid = document.createElement('div');
      mainGrid.className = 'responses-settings-grid responses-settings-grid--main';
      body.appendChild(mainGrid);

      const advancedDetails = document.createElement('details');
      advancedDetails.className = 'responses-advanced-settings';
      const advancedSummary = document.createElement('summary');
      advancedSummary.textContent = '高级字段';
      advancedDetails.appendChild(advancedSummary);
      const advancedGrid = document.createElement('div');
      advancedGrid.className = 'responses-settings-grid responses-settings-grid--advanced';
      advancedDetails.appendChild(advancedGrid);
      body.appendChild(advancedDetails);
      const transientFieldKeys = new Set();
      const getSectionEnabled = () => {
        if (!sectionToggleSpec) return true;
        return getNestedValue(getSettingsSnapshot(), sectionToggleSpec.path) === true;
      };

      const createField = (spec) => {
        const field = document.createElement('div');
        field.className = 'responses-setting-field';
        field.dataset.fieldKey = spec.key;

        const header = document.createElement('div');
        header.className = 'responses-setting-row';
        const label = document.createElement('span');
        label.className = 'responses-setting-label';
        label.textContent = spec.label;
        if (spec.help) {
          label.title = spec.help;
        }

        const enableLabel = document.createElement('label');
        enableLabel.className = 'responses-setting-enable';
        const enableToggle = document.createElement('input');
        enableToggle.type = 'checkbox';
        enableToggle.className = 'responses-setting-enable-checkbox';
        enableLabel.appendChild(enableToggle);
        header.appendChild(enableLabel);
        header.appendChild(label);
        field.appendChild(header);

        const error = document.createElement('div');
        error.className = 'responses-setting-error';
        const clearError = () => {
          error.textContent = '';
          error.hidden = true;
        };
        const showError = (message) => {
          error.textContent = message;
          error.hidden = !message;
        };

        const controlWrap = document.createElement('div');
        controlWrap.className = 'responses-setting-control';
        header.appendChild(controlWrap);
        clearError();

        let lastJsonFormattedValue = '';
        let jsonValueBeforeEdit = '';
        const isEditorField = spec.kind === 'textarea' || spec.kind === 'json' || spec.kind === 'json_or_string';
        let editorWrap = null;
        let editorToggle = null;
        const getStoredValue = () => getNestedValue(getSettingsSnapshot(), spec.path);
        const isEnabled = () => transientFieldKeys.has(spec.key) || typeof getStoredValue() !== 'undefined';
        const resolveFallbackValue = () => {
          if (typeof spec.defaultValue !== 'undefined') return spec.defaultValue;
          if (spec.kind === 'boolean') return true;
          if (spec.kind === 'select' && Array.isArray(spec.options) && spec.options.length > 0) return spec.options[0];
          if (spec.kind === 'range') return Number.isFinite(spec.max) ? spec.max : 1;
          return '';
        };
        const syncControlVisibility = () => {
          controlWrap.hidden = !isEnabled();
          enableToggle.checked = isEnabled();
          if (editorWrap) {
            editorWrap.hidden = !isEnabled() || !field.classList.contains('is-editor-open');
          }
        };

        let control = null;
        let controlValueLabel = null;
        if (spec.kind === 'boolean') {
          const boolLabel = document.createElement('label');
          boolLabel.className = 'switch responses-setting-bool-switch';
          control = document.createElement('input');
          control.type = 'checkbox';
          const boolSlider = document.createElement('span');
          boolSlider.className = 'slider';
          boolLabel.appendChild(control);
          boolLabel.appendChild(boolSlider);
          control.addEventListener('change', () => {
            clearError();
            updateSettingAtPath(spec.path, !!control.checked);
          });
          controlWrap.appendChild(boolLabel);
        } else if (spec.kind === 'select') {
          control = document.createElement('select');
          control.className = 'responses-setting-select';
          (spec.options || []).forEach((optionValue) => {
            const optionEl = document.createElement('option');
            optionEl.value = optionValue;
            optionEl.textContent = optionValue;
            control.appendChild(optionEl);
          });
          control.addEventListener('change', () => {
            clearError();
            updateSettingAtPath(spec.path, control.value || undefined);
          });
          controlWrap.appendChild(control);
        } else if (spec.kind === 'range') {
          const rangeValue = document.createElement('span');
          rangeValue.className = 'responses-setting-inline-value';
          controlValueLabel = rangeValue;
          controlWrap.appendChild(rangeValue);

          control = document.createElement('input');
          control.type = 'range';
          control.className = 'responses-setting-range temperature';
          control.min = String(spec.min ?? 0);
          control.max = String(spec.max ?? 1);
          control.step = String(spec.step ?? 0.1);
          control.addEventListener('input', () => {
            if (controlValueLabel) {
              controlValueLabel.textContent = Number(control.value).toFixed(control.step === '1' ? 0 : 2);
            }
          });
          control.addEventListener('change', () => {
            clearError();
            const numericValue = Number(control.value);
            updateSettingAtPath(spec.path, Number.isFinite(numericValue) ? numericValue : undefined);
          });
          controlWrap.appendChild(control);
        } else if (spec.kind === 'number' || spec.kind === 'text') {
          control = document.createElement('input');
          control.type = (spec.kind === 'number') ? 'number' : 'text';
          control.className = 'responses-setting-input';
          if (typeof spec.placeholder === 'string') control.placeholder = spec.placeholder;
          if (Number.isFinite(spec.min)) control.min = String(spec.min);
          if (Number.isFinite(spec.max)) control.max = String(spec.max);
          if (Number.isFinite(spec.step)) control.step = String(spec.step);
          if (Number.isFinite(spec.maxLength)) control.maxLength = spec.maxLength;
          const commitValue = () => {
            clearError();
            if (spec.kind === 'number') {
              const parsed = parseNumberFieldValue(control.value, spec);
              if (!parsed.ok) {
                showError(parsed.message);
                return;
              }
              updateSettingAtPath(spec.path, parsed.value);
              if (typeof parsed.value === 'undefined') {
                transientFieldKeys.delete(spec.key);
                syncControlVisibility();
              }
            } else {
              const nextValue = compactResponsesApiSettingValue(control.value);
              updateSettingAtPath(spec.path, nextValue);
              if (typeof nextValue === 'undefined') {
                transientFieldKeys.delete(spec.key);
                syncControlVisibility();
              }
            }
          };
          control.addEventListener('change', commitValue);
          control.addEventListener('blur', commitValue);
          controlWrap.appendChild(control);
        } else if (isEditorField) {
          editorToggle = document.createElement('button');
          editorToggle.type = 'button';
          editorToggle.className = 'responses-setting-editor-toggle';
          editorToggle.addEventListener('click', (event) => {
            event.stopPropagation();
            if (!isEnabled()) return;
            field.classList.toggle('is-editor-open');
            syncControlVisibility();
          });
          controlWrap.appendChild(editorToggle);

          editorWrap = document.createElement('div');
          editorWrap.className = 'responses-setting-editor-wrap';
          control = document.createElement('textarea');
          control.className = 'responses-setting-textarea';
          control.rows = spec.rows || 4;
          if (typeof spec.placeholder === 'string') control.placeholder = spec.placeholder;
          const commitValue = () => {
            clearError();
            let parsed = null;
            if (spec.kind === 'textarea') {
              parsed = {
                ok: true,
                value: compactResponsesApiSettingValue(control.value),
                formatted: control.value.trim()
              };
            } else if (spec.kind === 'json') {
              parsed = parseJsonFieldValue(control.value, spec);
            } else {
              parsed = parseJsonOrStringFieldValue(control.value);
            }
            if (!parsed?.ok) {
              control.value = jsonValueBeforeEdit || lastJsonFormattedValue || '';
              showError(parsed?.message || '字段格式无效');
              return;
            }
            const nextFormatted = (typeof parsed.formatted === 'string') ? parsed.formatted : '';
            control.value = nextFormatted;
            lastJsonFormattedValue = nextFormatted;
            jsonValueBeforeEdit = nextFormatted;
            updateSettingAtPath(spec.path, parsed.value);
            if (typeof parsed.value === 'undefined') {
              transientFieldKeys.delete(spec.key);
              syncControlVisibility();
            }
          };
          control.addEventListener('focus', () => {
            jsonValueBeforeEdit = lastJsonFormattedValue || control.value;
          });
          control.addEventListener('change', commitValue);
          control.addEventListener('blur', commitValue);
          editorWrap.appendChild(control);
          field.appendChild(editorWrap);
        }

        const syncControlValue = () => {
          const storedValue = getStoredValue();
          const fallbackValue = resolveFallbackValue();
          const effectiveValue = (typeof storedValue === 'undefined') ? fallbackValue : storedValue;
          if (!control) return;

          if (spec.kind === 'boolean') {
            control.checked = (typeof storedValue === 'boolean') ? storedValue : !!fallbackValue;
            return;
          }
          if (spec.kind === 'select') {
            control.value = effectiveValue || '';
            return;
          }
          if (spec.kind === 'range') {
            control.value = String(typeof effectiveValue === 'number' ? effectiveValue : fallbackValue || 0);
            if (controlValueLabel) {
              controlValueLabel.textContent = Number(control.value).toFixed((spec.step ?? 0.1) === 1 ? 0 : 2);
            }
            return;
          }
          if (spec.kind === 'number') {
            control.value = (typeof storedValue === 'number') ? String(storedValue) : '';
            return;
          }
          if (spec.kind === 'text' || spec.kind === 'textarea') {
            control.value = (typeof storedValue === 'string') ? storedValue : '';
            return;
          }
          if (spec.kind === 'json') {
            const formatted = (typeof storedValue === 'undefined') ? '' : JSON.stringify(storedValue, null, 2);
            control.value = formatted;
            lastJsonFormattedValue = formatted;
            jsonValueBeforeEdit = formatted;
            if (editorToggle) {
              editorToggle.textContent = formatted ? '编辑 JSON' : '填写 JSON';
            }
            return;
          }
          if (spec.kind === 'json_or_string') {
            const formatted = (() => {
              if (typeof storedValue === 'undefined') return '';
              if (typeof storedValue === 'string') return storedValue;
              return JSON.stringify(storedValue, null, 2);
            })();
            control.value = formatted;
            lastJsonFormattedValue = formatted;
            jsonValueBeforeEdit = formatted;
            if (editorToggle) {
              editorToggle.textContent = formatted ? '编辑' : '填写';
            }
            return;
          }
          if (spec.kind === 'textarea' && editorToggle) {
            editorToggle.textContent = (typeof storedValue === 'string' && storedValue.trim()) ? '编辑文本' : '填写文本';
          }
        };

        enableToggle.addEventListener('change', () => {
          clearError();
          if (enableToggle.checked) {
            transientFieldKeys.add(spec.key);
            if (spec.kind === 'boolean' && control) {
              updateSettingAtPath(spec.path, !!control.checked);
            }
          } else {
            transientFieldKeys.delete(spec.key);
            updateSettingAtPath(spec.path, undefined);
            field.classList.remove('is-editor-open');
          }
          syncControlValue();
          syncControlVisibility();
        });

        syncControlValue();
        syncControlVisibility();
        field.appendChild(error);
        return field;
      };

      (mainSpecs || []).forEach((spec) => {
        mainGrid.appendChild(createField(spec));
      });
      (advancedSpecs || []).forEach((spec) => {
        advancedGrid.appendChild(createField(spec));
      });
      mainGrid.hidden = !(mainSpecs || []).length;
      advancedDetails.hidden = !(advancedSpecs || []).length;

      const computeHasAdvancedValue = () => (advancedSpecs || []).some(spec =>
        typeof getNestedValue(getSettingsSnapshot(), spec.path) !== 'undefined');
      advancedDetails.open = !advancedDetails.hidden && computeHasAdvancedValue();

      const syncSectionVisibility = () => {
        const enabled = getSectionEnabled();
        if (sectionToggleInput) {
          sectionToggleInput.checked = enabled;
        }
        body.hidden = !enabled;
        section.classList.toggle('is-section-disabled', !enabled);
        if (!enabled) {
          advancedDetails.open = false;
        } else if (!advancedDetails.hidden && computeHasAdvancedValue()) {
          advancedDetails.open = true;
        }
      };

      if (sectionToggleInput) {
        sectionToggleInput.addEventListener('change', () => {
          updateSettingAtPath(sectionToggleSpec.path, sectionToggleInput.checked ? true : undefined);
          syncSectionVisibility();
        });
      }
      syncSectionVisibility();

      return section;
    };
    const createResponsesSettingsSection = () => createApiFieldSettingsSection({
      title: 'Responses API 字段',
      description: '已启用的字段才会写入 /responses 请求体；未启用字段不会占用同步存储。',
      mainSpecs: RESPONSES_MAIN_FIELD_SPECS,
      advancedSpecs: RESPONSES_ADVANCED_FIELD_SPECS,
      getSettingsSnapshot: getResponsesSettingsSnapshot,
      updateSettingAtPath: updateResponsesSettingAtPath
    });
    const createResponsesSearchToolSection = () => createApiFieldSettingsSection({
      title: '搜索工具',
      description: '这里单独管理 Responses API 的 web_search 工具；关闭后不会往请求体附加该工具。',
      mainSpecs: [],
      advancedSpecs: RESPONSES_SEARCH_TOOL_FIELD_SPECS,
      sectionToggleSpec: RESPONSES_SEARCH_TOOL_SECTION_TOGGLE_SPEC,
      getSettingsSnapshot: getResponsesSettingsSnapshot,
      updateSettingAtPath: updateResponsesSettingAtPath
    });
    const createResponsesCodeInterpreterToolSection = () => createApiFieldSettingsSection({
      title: '代码解释器工具',
      description: '这里单独管理 Responses API 的 code_interpreter 工具；开启后会自动附加一个 `container.type=auto` 的托管 Python 沙箱。',
      mainSpecs: [],
      advancedSpecs: RESPONSES_CODE_INTERPRETER_TOOL_FIELD_SPECS,
      sectionToggleSpec: RESPONSES_CODE_INTERPRETER_TOOL_SECTION_TOGGLE_SPEC,
      getSettingsSnapshot: getResponsesSettingsSnapshot,
      updateSettingAtPath: updateResponsesSettingAtPath
    });
    const createGeminiSettingsSection = () => createApiFieldSettingsSection({
      title: 'Gemini API 字段',
      description: 'Gemini generateContent 的附加字段会以稀疏结构存储；未启用字段不会附加到请求体。',
      mainSpecs: GEMINI_MAIN_FIELD_SPECS,
      advancedSpecs: GEMINI_ADVANCED_FIELD_SPECS,
      getSettingsSnapshot: getGeminiSettingsSnapshot,
      updateSettingAtPath: updateGeminiSettingAtPath
    });

    // 在 temperature 设置后添加“聊天历史裁剪”设置：分别控制 user / AI(assistant) 的历史消息条数
    // 背景：超长对话时，AI 回复往往更长；允许只保留最近 N 条 AI，同时保留更多用户指令上下文。
    const formLeft = apiForm.querySelector('.api-form-left');

    const formatHistoryLimitText = (v, zeroText) => {
      if (v >= 500) return '无限制';
      if (v === 0) return zeroText;
      return `${v}条`;
    };

    const createHistoryLimitSlider = ({
      label,
      zeroText,
      inputClassName,
      getConfigValue,
      setConfigValue
    }) => {
      const group = document.createElement('div');
      group.className = 'form-group';

      const header = document.createElement('div');
      header.className = 'form-group-header';

      const labelEl = document.createElement('label');
      labelEl.textContent = label;

      const valueEl = document.createElement('span');
      valueEl.className = 'temperature-value';

      header.appendChild(labelEl);
      header.appendChild(valueEl);

      const input = document.createElement('input');
      input.type = 'range';
      input.className = `${inputClassName} temperature`;
      input.min = '0';
      input.max = '500';
      input.step = '1';

      // 初始化值与显示：500 => 无限制；0 => 不发送/仅当前；其余按条数显示
      const raw = Number.isFinite(getConfigValue()) ? getConfigValue() : 500;
      const isUnlimited = raw >= 500;
      const clamped = Math.min(499, Math.max(0, isUnlimited ? 499 : raw));
      const uiValue = isUnlimited ? 500 : clamped;
      input.value = String(uiValue);
      valueEl.textContent = formatHistoryLimitText(uiValue, zeroText);

      input.addEventListener('input', () => {
        const v = parseInt(input.value, 10);
        valueEl.textContent = formatHistoryLimitText(v, zeroText);
      });

      input.addEventListener('change', () => {
        const v = parseInt(input.value, 10);
        // 500 代表关闭限制，保存为一个极大值；composeMessages 会按此视为“发送全部”
        setConfigValue((v >= 500) ? MAX_CHAT_HISTORY_UNLIMITED : v);
        saveAPIConfigs();
      });

      group.appendChild(header);
      group.appendChild(input);
      return group;
    };

    const userHistoryGroup = createHistoryLimitSlider({
      label: '历史用户消息',
      zeroText: '仅当前',
      inputClassName: 'max-chat-history-user',
      getConfigValue: () => config.maxChatHistoryUser,
      setConfigValue: (v) => { apiConfigs[index].maxChatHistoryUser = v; }
    });

    const assistantHistoryGroup = createHistoryLimitSlider({
      label: '历史AI消息',
      zeroText: '不发送',
      inputClassName: 'max-chat-history-assistant',
      getConfigValue: () => config.maxChatHistoryAssistant,
      setConfigValue: (v) => { apiConfigs[index].maxChatHistoryAssistant = v; }
    });

    if (formLeft) {
      formLeft.appendChild(userHistoryGroup);
      formLeft.appendChild(assistantHistoryGroup);
    } else {
      apiForm.appendChild(userHistoryGroup);
      apiForm.appendChild(assistantHistoryGroup);
    }

    // 传输模式：右侧开关（开启=流式 SSE，关闭=非流式 JSON）
    const streamingGroup = document.createElement('div');
    streamingGroup.className = 'form-group';

    const streamingRow = document.createElement('div');
    streamingRow.className = 'switch-row backup-form-row';
    const streamingText = document.createElement('span');
    streamingText.className = 'switch-text';
    streamingText.textContent = '流式传输';
    const switchLabel = document.createElement('label');
    switchLabel.className = 'switch';
    const streamingToggle = document.createElement('input');
    streamingToggle.type = 'checkbox';
    streamingToggle.id = `use-streaming-${index}`;
    streamingToggle.className = 'use-streaming-toggle';
    streamingToggle.checked = (config.useStreaming !== false);
    streamingToggle.title = streamingToggle.checked ? '当前：流式 (SSE)' : '当前：非流式 (JSON)';
    const slider = document.createElement('span');
    slider.className = 'slider';
    switchLabel.appendChild(streamingToggle);
    switchLabel.appendChild(slider);
    streamingRow.appendChild(streamingText);
    streamingRow.appendChild(switchLabel);

    streamingToggle.addEventListener('change', () => {
      const enabled = !!streamingToggle.checked;
      streamingToggle.title = enabled ? '当前：流式 (SSE)' : '当前：非流式 (JSON)';
      apiConfigs[index].useStreaming = enabled;
      saveAPIConfigs();
    });

    streamingGroup.appendChild(streamingRow);
    if (formLeft) {
      formLeft.appendChild(streamingGroup);
    } else {
      apiForm.appendChild(streamingGroup);
    }

    const responsesSettingsSection = createResponsesSettingsSection();
    const responsesSearchToolSection = createResponsesSearchToolSection();
    const responsesCodeInterpreterToolSection = createResponsesCodeInterpreterToolSection();
    const geminiSettingsSection = createGeminiSettingsSection();
    const providerSettingsHost = document.createElement('div');
    providerSettingsHost.className = 'provider-settings-host';
    if (apiFormGrid?.parentElement === apiForm) {
      apiForm.appendChild(providerSettingsHost);
    } else if (apiForm) {
      apiForm.appendChild(providerSettingsHost);
    }
    const refreshProviderSettingsVisibility = () => {
      if (!providerSettingsHost) return;
      const nextSections = [];
      if (isResponsesConnectionSelected() && responsesSettingsSection) {
        responsesSettingsSection.hidden = false;
        nextSections.push(responsesSettingsSection);
        if (responsesSearchToolSection) {
          responsesSearchToolSection.hidden = false;
          nextSections.push(responsesSearchToolSection);
        }
        if (responsesCodeInterpreterToolSection) {
          responsesCodeInterpreterToolSection.hidden = false;
          nextSections.push(responsesCodeInterpreterToolSection);
        }
      } else if (responsesSettingsSection) {
        responsesSettingsSection.hidden = true;
        if (responsesSearchToolSection) {
          responsesSearchToolSection.hidden = true;
        }
        if (responsesCodeInterpreterToolSection) {
          responsesCodeInterpreterToolSection.hidden = true;
        }
      }
      if (isGeminiConnectionSelected() && geminiSettingsSection) {
        geminiSettingsSection.hidden = false;
        nextSections.push(geminiSettingsSection);
      } else if (geminiSettingsSection) {
        geminiSettingsSection.hidden = true;
      }
      providerSettingsHost.replaceChildren(...nextSections);
    };

    // 选择按钮点击事件
    selectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // 移除其他卡片的选中状态
      document.querySelectorAll('.api-card').forEach(card => {
        card.classList.remove('selected');
      });
      // 设置当前卡片为选中状态
      template.classList.add('selected');
      setSelectedIndexInternal(index);
      // 关闭面板并回到聊天界面（旧行为：选择后退出设置层）
      if (appContext.services?.chatHistoryUI?.closeChatHistoryPanel) {
        appContext.services.chatHistoryUI.closeChatHistoryPanel();
      } else {
        apiSettingsPanel.classList.remove('visible');
      }
    });

    // 点击卡片只展开/折叠表单
    template.addEventListener('click', () => {
      template.classList.toggle('expanded');
    });

    refreshConnectionSourceOptions();
    if (connectionSourceSelect) {
      apiConfigs[index].connectionSourceId = getConnectionSourceById(connectionSourceSelect.value)?.id || '';
    }
    refreshConnectionSourceHint();
    refreshProviderSettingsVisibility();

    displayNameInput.value = config.displayName ?? '';
    modelNameInput.value = config.modelName ?? 'gpt-4o';
    temperatureInput.value = config.temperature ?? 1;
    temperatureValue.textContent = (config.temperature ?? 1).toFixed(1);
    customParamsInput.value = (typeof config.customParams === 'string') ? config.customParams : '';
    // 首次渲染也统一格式化，确保展示层始终是缩进 JSON 结构。
    commitCustomParamsFormatted({ persist: false });
    if (customSystemPromptInput) {
      customSystemPromptInput.value = config.customSystemPrompt || '';
    }
    if (askOtherAiToolEnabledToggle) {
      askOtherAiToolEnabledToggle.checked = !!config.enableAskOtherAiTool;
    }
    if (userMessageTemplateInput) {
      userMessageTemplateInput.value = config.userMessagePreprocessorTemplate || '';
    }
    if (userMessageTemplateIncludeHistoryToggle) {
      userMessageTemplateIncludeHistoryToggle.checked = !!config.userMessagePreprocessorIncludeInHistory;
    }
    if (userMessageTemplateHelpBtn) {
      userMessageTemplateHelpBtn.title = USER_MESSAGE_TEMPLATE_HELP_TEXT;
    }
    applyModelNameOptions();

    // 监听温度变化
    temperatureInput.addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      temperatureValue.textContent = value.toFixed(1);
      apiConfigs[index].temperature = value;
    });
    // 说明：input 事件触发频率很高，直接同步到 sync 容易撞到写入配额；
    // 因此改为 change 时再落盘（用户松手/确认时触发），既省配额也更稳定。
    temperatureInput.addEventListener('change', () => saveAPIConfigs());

    // 检查是否已收藏
    if (config.isFavorite) {
      favoriteBtn.classList.add('active');
    }

    // 收藏按钮点击事件
    favoriteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // 直接切换当前配置的收藏状态
      apiConfigs[index].isFavorite = !apiConfigs[index].isFavorite;
      favoriteBtn.classList.toggle('active', apiConfigs[index].isFavorite);
      saveAPIConfigs();
      renderFavoriteApis();
    });

    // 阻止输入框和按钮点击事件冒泡
    const stopPropagation = (e) => e.stopPropagation();
    apiForm.addEventListener('click', stopPropagation);
    template.querySelector('.api-card-actions').addEventListener('click', stopPropagation);

    // 拖动排序：仅允许通过拖动手柄触发，避免干扰表单输入。
    const dragHandle = template.querySelector('.drag-handle');
    if (dragHandle) {
      dragHandle.setAttribute('draggable', 'true');
      dragHandle.addEventListener('click', stopPropagation);
      dragHandle.addEventListener('mousedown', stopPropagation);
      dragHandle.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        draggingCardIndex = index;
        template.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(index));
        }
      });
      dragHandle.addEventListener('dragend', () => {
        draggingCardIndex = null;
        template.classList.remove('dragging');
        clearDragOverStyles();
      });
    }

    template.addEventListener('dragover', (e) => {
      const fromIndex = draggingCardIndex ?? parseCardIndex(e.dataTransfer?.getData('text/plain'));
      const toIndex = parseCardIndex(template.dataset.index);
      if (fromIndex == null || toIndex == null || fromIndex === toIndex) return;
      e.preventDefault();
      clearDragOverStyles();
      // 根据指针所在上下半区显示“插入线”，明确提示将插入到卡片的前或后。
      const dropPosition = getDropPosition(template, e.clientY);
      template.classList.add('drag-over');
      template.classList.toggle('drag-insert-before', dropPosition === 'before');
      template.classList.toggle('drag-insert-after', dropPosition === 'after');
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'move';
      }
    });

    template.addEventListener('dragleave', (e) => {
      if (template.contains(e.relatedTarget)) return;
      template.classList.remove('drag-over', 'drag-insert-before', 'drag-insert-after');
    });

    template.addEventListener('drop', (e) => {
      e.preventDefault();
      template.classList.remove('drag-over', 'drag-insert-before', 'drag-insert-after');

      const fromIndex = draggingCardIndex ?? parseCardIndex(e.dataTransfer?.getData('text/plain'));
      const toIndex = parseCardIndex(template.dataset.index);
      if (fromIndex == null || toIndex == null || fromIndex === toIndex) return;

      const insertAfter = getDropPosition(template, e.clientY) === 'after';
      const rawIndex = toIndex + (insertAfter ? 1 : 0);
      const insertIndex = (fromIndex < rawIndex) ? rawIndex - 1 : rawIndex;
      if (insertIndex === fromIndex) return;

      draggingCardIndex = null;
      if (moveConfig(fromIndex, insertIndex)) {
        saveAPIConfigs();
        renderAPICards();
        renderFavoriteApis();
      }
    });

    // --- 输入变化时保存 ---
    const saveCardBasicFields = () => {
      const previousConfig = { ...apiConfigs[index] };
      const selectedSourceId = getConnectionSourceById(connectionSourceSelect?.value)?.id || '';
      apiConfigs[index] = {
        ...apiConfigs[index],
        connectionSourceId: selectedSourceId,
        displayName: displayNameInput.value,
        modelName: (modelNameInput.value || '').trim(),
      };
      refreshConnectionSourceHint();
      clearApiKeyFileCacheEntry(previousConfig);
      clearApiKeyFileCacheEntry(apiConfigs[index]);
      updateCardTitle();
      saveAPIConfigs();
      renderFavoriteApis();
    };
    if (connectionSourceSelect) {
      connectionSourceSelect.addEventListener('change', () => {
        applyModelNameOptions();
        refreshProviderSettingsVisibility();
        saveCardBasicFields();
      });
    }
    if (displayNameInput) {
      displayNameInput.addEventListener('change', saveCardBasicFields);
    }
    if (modelNameInput) {
      modelNameInput.addEventListener('click', () => {
        ensureModelOptionsLoaded({ force: false });
      });
      modelNameInput.addEventListener('change', saveCardBasicFields);
    }

    // 自定义参数处理：失焦/变更后统一格式化为缩进 JSON。
    customParamsInput.addEventListener('focus', () => {
      customParamsValueBeforeEdit = lastFormattedCustomParams;
    });
    customParamsInput.addEventListener('change', () => {
      commitCustomParamsFormatted({ persist: true });
    });
    customParamsInput.addEventListener('blur', () => {
      commitCustomParamsFormatted({ persist: true });
    });

    // 自定义提示词处理（不做 JSON 校验，仅保存文本）
    if (customSystemPromptInput) {
      customSystemPromptInput.addEventListener('input', () => {
        apiConfigs[index].customSystemPrompt = customSystemPromptInput.value;
      });
      customSystemPromptInput.addEventListener('blur', () => {
        apiConfigs[index].customSystemPrompt = customSystemPromptInput.value || '';
        saveAPIConfigs();
      });
      customSystemPromptInput.addEventListener('change', () => {
        apiConfigs[index].customSystemPrompt = customSystemPromptInput.value || '';
        saveAPIConfigs();
      });
    }

    // “向其他 AI 提问”工具开关：
    // - 这是按 API 配置维度暴露的能力白名单；
    // - 勾选后，该配置才会出现在 list_askable_models 的候选目录里；
    // - sender 侧只读取这个布尔值，不依赖 DOM 状态做事实判断。
    if (askOtherAiToolEnabledToggle) {
      askOtherAiToolEnabledToggle.addEventListener('change', () => {
        apiConfigs[index].enableAskOtherAiTool = !!askOtherAiToolEnabledToggle.checked;
        saveAPIConfigs();
      });
    }

    if (userMessageTemplateInput) {
      userMessageTemplateInput.addEventListener('input', () => {
        apiConfigs[index].userMessagePreprocessorTemplate = userMessageTemplateInput.value;
      });
      userMessageTemplateInput.addEventListener('blur', () => {
        apiConfigs[index].userMessagePreprocessorTemplate = userMessageTemplateInput.value || '';
        saveAPIConfigs();
      });
      userMessageTemplateInput.addEventListener('change', () => {
        apiConfigs[index].userMessagePreprocessorTemplate = userMessageTemplateInput.value || '';
        saveAPIConfigs();
      });
    }

    if (userMessageTemplateIncludeHistoryToggle) {
      userMessageTemplateIncludeHistoryToggle.addEventListener('change', () => {
        apiConfigs[index].userMessagePreprocessorIncludeInHistory = !!userMessageTemplateIncludeHistoryToggle.checked;
        saveAPIConfigs();
      });
    }

    if (userMessageTemplateCopyBtn) {
      userMessageTemplateCopyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!navigator?.clipboard?.writeText) {
          utils?.showNotification?.({ message: '当前环境不支持剪贴板复制', type: 'warning', duration: 2200 });
          return;
        }
        try {
          await navigator.clipboard.writeText(USER_MESSAGE_TEMPLATE_INJECT_SNIPPET);
          utils?.showNotification?.({ message: '已复制角色块', type: 'success', duration: 1800 });
        } catch (error) {
          console.error('复制角色块失败:', error);
          utils?.showNotification?.({ message: '复制失败，请重试', type: 'error', duration: 2200 });
        }
      });
    }

    // 自定义 Headers 功能已移除

    // 复制配置
    template.querySelector('.duplicate-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const copied = JSON.parse(JSON.stringify(config));
      copied.id = generateUUID();
      apiConfigs.push(copied);
      saveAPIConfigs();
      renderAPICards();
    });

    // 删除配置：需要二次确认，避免误触。
    const deleteButton = template.querySelector('.delete-btn');
    let deleteConfirmTimer = null;
    const resetDeleteConfirm = () => {
      if (!deleteButton) return;
      deleteButton.dataset.confirming = 'false';
      deleteButton.classList.remove('is-confirming');
      template.classList.remove('delete-confirming');
      deleteButton.title = '删除';
      if (deleteConfirmTimer) {
        clearTimeout(deleteConfirmTimer);
        deleteConfirmTimer = null;
      }
    };

    if (deleteButton) {
      deleteButton.addEventListener('click', (e) => {
        e.stopPropagation();
        if (apiConfigs.length <= 1) return;

        if (deleteButton.dataset.confirming === 'true') {
          resetDeleteConfirm();

          const deletedConfig = apiConfigs.splice(index, 1)[0];
          const deletedSourceId = deletedConfig?.connectionSourceId || '';
          const stillUsedByOthers = deletedSourceId
            ? apiConfigs.some(cfg => cfg?.connectionSourceId === deletedSourceId)
            : false;
          if (!stillUsedByOthers && deletedSourceId) {
            delete apiKeyUsageIndex[deletedSourceId];
            clearApiKeyFileCacheEntry({ connectionSourceId: deletedSourceId });
          }

          if (selectedConfigIndex >= apiConfigs.length) {
            selectedConfigIndex = apiConfigs.length - 1;
          }
          // 如果删除的是当前选中的，需要更新选中项状态
          if (index === selectedConfigIndex && apiConfigs.length > 0) {
               // 默认选中第一个，或者最后一个如果索引超出
               selectedConfigIndex = Math.max(0, Math.min(selectedConfigIndex, apiConfigs.length - 1));
          } else if (index < selectedConfigIndex) {
               // 如果删除的是选中项之前的，索引要减一
               selectedConfigIndex--;
          }

          saveAPIConfigs();
          renderAPICards();
          renderFavoriteApis(); // 更新收藏列表状态
          return;
        }

        deleteButton.dataset.confirming = 'true';
        deleteButton.classList.add('is-confirming');
        template.classList.add('delete-confirming');
        deleteButton.title = '再次点击确认删除';
        deleteConfirmTimer = setTimeout(() => {
          resetDeleteConfirm();
        }, DELETE_CONFIRM_TIMEOUT_MS);
      });
    }

    return template;
  }

  /**
   * 渲染收藏的API列表至设置菜单。
   * - 无收藏时隐藏整个收藏区域，保持菜单简洁
   * - 有收藏时显示区域并高亮当前选中项
   * - 点击收藏项后切换当前 API 并关闭设置菜单
   * @since 1.3.0
   */
  function renderFavoriteApis() {
    const favoriteApisSection = document.getElementById('favorite-apis');
    const favoriteApisList = favoriteApisSection ? favoriteApisSection.querySelector('.favorite-apis-list') : null;
    if (!favoriteApisList) return;

    // 过滤出收藏的API
    const favoriteConfigs = apiConfigs.filter(config => config.isFavorite);

    // 无收藏：隐藏区域并清空列表
    if (favoriteConfigs.length === 0) {
      favoriteApisList.innerHTML = '';
      if (favoriteApisSection) favoriteApisSection.style.display = 'none';
      return;
    }

    // 有收藏：展示区域并渲染
    if (favoriteApisSection) favoriteApisSection.style.display = 'block';
    favoriteApisList.innerHTML = '';

    // 获取当前使用的API配置
    const currentConfig = apiConfigs[selectedConfigIndex];

    favoriteConfigs.forEach((config) => {
      const item = document.createElement('div');
      item.className = 'favorite-api-item';

      // 当前使用的API：按 id 对比
      if (currentConfig && currentConfig.id && config.id && currentConfig.id === config.id) {
        item.classList.add('current');
      }

      const apiName = document.createElement('span');
      apiName.className = 'api-name';
      const baseTitle = getApiConfigDisplayTitle(config);
      const missingSource = !hasConfiguredConnectionSource(config);
      apiName.textContent = missingSource ? `⚠ ${baseTitle}` : baseTitle;
      apiName.title = missingSource ? `未配置连接源：${baseTitle}` : baseTitle;
      item.classList.toggle('missing-connection-source', missingSource);

      item.appendChild(apiName);

      // 点击切换到该API配置（不关闭设置菜单）
      item.addEventListener('click', () => {
        // 按 id 查找索引
        const configIndex = apiConfigs.findIndex(c => c.id && c.id === config.id);

        if (configIndex !== -1 && configIndex !== selectedConfigIndex) {
          selectedConfigIndex = configIndex;
          saveAPIConfigs();
          renderAPICards(); // 重新渲染卡片以更新选中状态
          renderFavoriteApis(); // 更新收藏列表状态
        }
      });

      favoriteApisList.appendChild(item);
    });
  }

 /**
  * 辅助函数：将 image_url.url 转换为 Gemini 需要的 inline_data 结构
  * 
  * 设计目标：
  * - 优先支持 dataURL（兼容现有逻辑）
  * - 如果是本地文件链接 file://，在发送前临时读取文件并转为 Base64；
   * - 如果是相对路径（Images/...），结合已保存的下载根目录拼出 file://；
  * - 读取失败时返回 null，由调用方决定是否忽略该图片。
   *
   * 注意：
   * - 这里仅在构造请求体时做一次性转换，不会把 Base64 写入 IndexedDB；
   * - 需要 manifest.json 中包含 "file:///*" host_permissions 才能 fetch 本地文件。
   *
   * @param {string} url - image_url.url 字段值
   * @returns {Promise<{inline_data: { mime_type: string, data: string }}|null>}
   */
  const IMAGE_DOWNLOAD_ROOT_KEY = 'image_download_root';
  function normalizePath(p) {
    return (p || '').replace(/\\/g, '/');
  }

  /**
   * 安全约束：
   * - 扩展在具备读取 `file://` 的能力时，必须限制「仅允许读取 Cerebr/Images 目录下的图片」；
   * - 否则用户消息里夹带任意 `<img src="file://...">` 都可能被读取并转成 Base64 上传到 API，造成隐私泄漏。
   *
   * 说明：
   * - 这里不尝试做“完全可信”的路径校验（浏览器环境也很难做到），而是以最小代价实现明确的白名单：
   *   1) 仅允许 `file://` 且路径包含 `/Cerebr/Images/` 目录段；
   *   2) 仅允许相对路径且以 `Images/` 开头，并且需要已保存的下载根目录指向 Cerebr 目录。
   */
  function hasPathSegment(normalizedPathString, segment) {
    const s = String(normalizedPathString || '');
    const seg = String(segment || '');
    if (!s || !seg) return false;
    const re = new RegExp(`(^|/)${seg}(/|$)`, 'i');
    return re.test(s);
  }

  function isCerebrRootPath(rootPath) {
    const normalized = normalizePath(String(rootPath || ''));
    return hasPathSegment(normalized.toLowerCase(), 'cerebr');
  }

  function normalizeFileUrlForCheck(fileUrl) {
    const raw = String(fileUrl || '');
    if (!raw.startsWith('file://')) return '';
    try {
      // 仅做“尽力而为”的解码：无法解码时保留原串，避免抛异常中断请求构建。
      const decoded = decodeURIComponent(raw);
      return normalizePath(decoded).toLowerCase();
    } catch (_) {
      return normalizePath(raw).toLowerCase();
    }
  }

  function isAllowedCerebrImageFileUrl(fileUrl) {
    const normalized = normalizeFileUrlForCheck(fileUrl);
    if (!normalized) return false;
    // 仅允许 Cerebr/Images 下的内容，避免误读 Cerebr 根目录中的备份/其他文件。
    return /(^|\/)cerebr\/images(\/|$)/i.test(normalized);
  }

  function isAllowedCerebrRelativeImagePath(relPath) {
    const rel = normalizePath(String(relPath || '')).replace(/^\/+/, '');
    if (!rel) return false;
    // 禁止路径穿越，避免通过 Images/../../ 逃逸出白名单目录
    if (/(^|\/)\.\.(\/|$)/.test(rel)) return false;
    return rel.toLowerCase().startsWith('images/');
  }

  async function resolveToFileUrl(raw) {
    if (!raw || typeof raw !== 'string') return null;
    if (raw.startsWith('data:') || raw.startsWith('http')) return raw;
    if (raw.startsWith('file://')) {
      return isAllowedCerebrImageFileUrl(raw) ? raw : null;
    }
    // 处理相对路径：Images/...
    const rel = normalizePath(raw).replace(/^\/+/, '');
    if (!isAllowedCerebrRelativeImagePath(rel)) return null;
    try {
      const res = await chrome.storage.local.get([IMAGE_DOWNLOAD_ROOT_KEY]);
      const root = normalizePath(res[IMAGE_DOWNLOAD_ROOT_KEY] || '');
      if (!root || !isCerebrRootPath(root)) return null;
      let full = `${root.replace(/\/+$/, '')}/${rel}`;
      full = normalizePath(full);
      if (/^[A-Za-z]:\//.test(full)) full = '/' + full;
      const fileUrl = `file://${full}`;
      return isAllowedCerebrImageFileUrl(fileUrl) ? fileUrl : null;
    } catch (_) {
      return null;
    }
  }

  async function buildGeminiInlinePartFromImageUrl(url) {
    if (!url) {
      return null;
    }

    try {
      const resolvedUrl = await resolveToFileUrl(url);
      const finalUrl = resolvedUrl || url;

      // 1) 兼容原有 dataURL 格式：data:image/...;base64,XXXX
      if (typeof finalUrl === 'string' && finalUrl.startsWith('data:')) {
        const match = finalUrl.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,(.*)$/);
        if (!match) {
          console.warn('不支持的 dataURL 图片格式 (Gemini):', finalUrl.substring(0, 48) + '...');
          return null;
        }
        return {
          inline_data: {
            mime_type: match[1],
            data: match[2]
          }
        };
      }

      // 2) 本地文件链接：file:// 开头
      if (typeof finalUrl === 'string' && finalUrl.startsWith('file://')) {
        if (!isAllowedCerebrImageFileUrl(finalUrl)) {
          console.warn('已阻止读取非 Cerebr/Images 目录的本地图片 (Gemini):', finalUrl);
          return null;
        }
        const response = await fetch(finalUrl);
        if (!response.ok) {
          console.warn('读取本地图片失败 (Gemini):', finalUrl, response.status, response.statusText);
          return null;
        }
        const blob = await response.blob();

        // 推断 mimeType：优先使用 blob.type，其次根据扩展名猜测
        let mimeType = (blob.type || '').toLowerCase();
        if (!mimeType || !mimeType.startsWith('image/')) {
          const lowerUrl = url.toLowerCase();
          if (lowerUrl.endsWith('.jpg') || lowerUrl.endsWith('.jpeg')) mimeType = 'image/jpeg';
          else if (lowerUrl.endsWith('.png')) mimeType = 'image/png';
          else if (lowerUrl.endsWith('.gif')) mimeType = 'image/gif';
          else if (lowerUrl.endsWith('.webp')) mimeType = 'image/webp';
          else mimeType = 'image/png';
        }

        const arrayBuffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        const chunkSize = 0x8000; // 分片编码，避免参数过长导致栈溢出
        let binary = '';
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const subarray = bytes.subarray(i, i + chunkSize);
          binary += String.fromCharCode.apply(null, subarray);
        }
        const base64Data = btoa(binary);

        return {
          inline_data: {
            mime_type: mimeType,
            data: base64Data
          }
        };
      }

      // 3) 其他 URL（http/https 等）暂不自动处理，避免跨域/授权问题
      console.warn('不支持的图片URL格式 (Gemini):', url.substring(0, 64) + '...');
      return null;
    } catch (error) {
      console.error('buildGeminiInlinePartFromImageUrl 失败:', error);
      return null;
    }
  }

  /**
   * 将 image_url 的原始路径转换为 OpenAI 兼容的 dataURL：
   * - data: 开头直接透传；
   * - http/https 原样返回（OpenAI 支持远程地址）；
   * - file:// 或相对路径复用 Gemini 的读取逻辑转为 Base64，避免把本地路径直接塞进请求体。
   * @param {string} rawUrl 原始 image_url.url 或 path
   * @returns {Promise<string|null>} 可发送的 dataURL/http 链接，失败返回 null
   */
  async function normalizeImageUrlForOpenAI(rawUrl) {
    const url = typeof rawUrl === 'string' ? rawUrl : '';
    if (!url) return null;
    if (url.startsWith('data:')) return url;
    if (/^https?:\/\//i.test(url)) return url;

    try {
      const inlinePart = await buildGeminiInlinePartFromImageUrl(url);
      if (inlinePart?.inline_data?.mime_type && inlinePart.inline_data.data) {
        return `data:${inlinePart.inline_data.mime_type};base64,${inlinePart.inline_data.data}`;
      }
    } catch (e) {
      console.warn('转换图片为数据URL失败，已跳过问题图片:', e);
    }
    console.warn('无法解析的图片路径，已避免发送 file:// 链接:', url);
    return null;
  }

  function getOpenAIEndpointPath(baseUrl) {
    const raw = (typeof baseUrl === 'string') ? baseUrl.trim() : '';
    if (!raw) return '';
    try {
      return (new URL(raw).pathname || '').toLowerCase();
    } catch (_) {
      // 兜底：当用户输入了不完整 URL（例如仅路径）时，仍尝试按路径判断接口类型。
      return raw.split('?')[0].split('#')[0].toLowerCase();
    }
  }

  function isOpenAIResponsesEndpoint(baseUrl) {
    const path = getOpenAIEndpointPath(baseUrl);
    return /(^|\/)responses(?:\/[^/?#]+)?\/?$/.test(path);
  }

  function isOpenAIResponsesConnectionConfig(config) {
    if (!config || typeof config !== 'object') return false;
    const connectionType = getConfigConnectionType(config);
    if (connectionType === CONNECTION_TYPE_OPENAI_RESPONSES) return true;
    return isOpenAIResponsesEndpoint(config?.baseUrl);
  }

  /**
   * 读取当前配置上的 Responses API 额外参数，并做最终请求前校验。
   * 约束：
   * - 只保留启用的字段；
   * - stream_options 仅在当前配置启用了流式输出时才发送；
   * - conversation 与 previous_response_id 互斥，冲突时直接报错，避免把 400 留给上游接口。
   * @param {Object} config
   * @returns {Object|null}
   */
  function buildResponsesApiRequestOverrides(config) {
    const normalizedSettings = normalizeResponsesApiSettings(config?.responsesApiSettings);
    if (!normalizedSettings) return null;

    const settings = cloneJsonCompatible(normalizedSettings);
    if (!settings || typeof settings !== 'object') return null;

    if (settings.conversation && settings.previous_response_id) {
      throw new Error('OpenAI Responses 配置冲突：conversation 与 previous_response_id 不能同时启用。');
    }

    const builtinToolOverrides = buildResponsesBuiltinToolOverrides(settings);
    delete settings.builtin_tools;

    if (builtinToolOverrides.tools.length > 0) {
      const existingTools = Array.isArray(settings.tools)
        ? settings.tools.filter(item => item && typeof item === 'object' && !Array.isArray(item))
        : [];
      const mergedTools = existingTools.map(item => cloneJsonCompatible(item));

      builtinToolOverrides.tools.forEach((nextTool) => {
        const nextType = (typeof nextTool?.type === 'string') ? nextTool.type.trim() : '';
        if (!nextType) return;
        const existingIndex = mergedTools.findIndex((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
          return (typeof item.type === 'string' ? item.type.trim() : '') === nextType;
        });
        if (existingIndex >= 0) {
          mergedTools[existingIndex] = mergeResponsesToolDefinition(mergedTools[existingIndex], nextTool);
        } else {
          mergedTools.push(nextTool);
        }
      });

      settings.tools = mergedTools;
    }

    if (builtinToolOverrides.include.length > 0) {
      settings.include = mergeResponsesStringArray(settings.include, builtinToolOverrides.include);
    }

    if (config?.useStreaming === false && settings.stream_options) {
      delete settings.stream_options;
    }

    return normalizeResponsesApiSettings(settings) || null;
  }

  /**
   * 构造 Gemini generateContent 的附加请求字段。
   * 说明：
   * - geminiApiSettings 允许同时配置根级字段与 generationConfig；
   * - 仅保留启用字段；
   * - 对明显互斥/依赖关系做前置校验，减少上游 400 噪音。
   * @param {Object} config
   * @returns {Object|null}
   */
  function buildGeminiApiRequestOverrides(config) {
    const normalizedSettings = normalizeGeminiApiSettings(config?.geminiApiSettings);
    if (!normalizedSettings) return null;

    const settings = cloneJsonCompatible(normalizedSettings);
    if (!settings || typeof settings !== 'object') return null;

    const generationConfig = (settings.generationConfig && typeof settings.generationConfig === 'object' && !Array.isArray(settings.generationConfig))
      ? settings.generationConfig
      : null;

    if (generationConfig?.responseSchema && generationConfig?.responseJsonSchema) {
      throw new Error('Gemini 配置冲突：responseSchema 与 responseJsonSchema 不能同时启用。');
    }

    if ((generationConfig?.responseSchema || generationConfig?.responseJsonSchema)
      && generationConfig?.responseMimeType !== 'application/json') {
      throw new Error('Gemini 配置冲突：启用 responseSchema / responseJsonSchema 时，responseMimeType 必须为 application/json。');
    }

    if (generationConfig?.logprobs != null && generationConfig?.responseLogprobs !== true) {
      throw new Error('Gemini 配置冲突：设置 logprobs 时必须同时启用 responseLogprobs。');
    }

    const thinkingConfig = (generationConfig?.thinkingConfig && typeof generationConfig.thinkingConfig === 'object' && !Array.isArray(generationConfig.thinkingConfig))
      ? generationConfig.thinkingConfig
      : null;
    if (thinkingConfig?.thinkingBudget != null && thinkingConfig?.thinkingLevel) {
      throw new Error('Gemini 配置冲突：thinkingBudget 与 thinkingLevel 请二选一。');
    }

    return normalizeGeminiApiSettings(settings) || null;
  }

  function normalizeResponsesMessagePhase(value) {
    return (typeof value === 'string') ? value.trim().toLowerCase() : '';
  }

  /**
   * 将 Responses 请求中的 system 消息抽离为顶层 instructions。
   *
   * 背景：
   * - 一些 OpenAI 兼容的 `/responses` 端点会拒绝 `input` 里的 `role=system`，
   *   报错形如 `System messages are not allowed`；
   * - 但同一批 system 指令通常可以安全地放到顶层 `instructions`；
   * - 因此这里在构造 Responses 请求体前，统一把 system 消息从历史里摘出来并顺序合并。
   *
   * 设计约束：
   * - 只改 Responses 请求；Chat Completions / Gemini 路线保持原样；
   * - 仅提取文本内容；system 里若出现非文本片段则忽略（当前 Cerebr 正常路径本来也主要生成纯文本 system）。
   *
   * @param {Array<any>} messages
   * @returns {{messages:Array<any>, instructions:string|undefined}}
   */
  function extractResponsesSystemInstructions(messages) {
    const source = Array.isArray(messages) ? messages : [];
    const filteredMessages = [];
    const instructionParts = [];

    source.forEach((msg) => {
      if (!msg || typeof msg !== 'object') return;
      const role = (typeof msg.role === 'string') ? msg.role.trim() : '';
      if (role !== 'system') {
        filteredMessages.push(msg);
        return;
      }

      if (typeof msg.content === 'string') {
        const text = msg.content.trim();
        if (text) instructionParts.push(text);
        return;
      }

      if (Array.isArray(msg.content)) {
        const text = msg.content
          .filter(part => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string' && part.text.trim())
          .map(part => part.text.trim())
          .join('\n');
        if (text) instructionParts.push(text);
      }
    });

    return {
      messages: filteredMessages,
      instructions: instructionParts.length > 0 ? instructionParts.join('\n\n') : undefined
    };
  }

  /**
   * 合并 Responses 顶层 instructions。
   * @param {string|undefined|null} baseInstructions
   * @param {string|undefined|null} appendedInstructions
   * @returns {string|undefined}
   */
  function appendResponsesInstructions(baseInstructions, appendedInstructions) {
    const base = (typeof baseInstructions === 'string') ? baseInstructions.trim() : '';
    const appended = (typeof appendedInstructions === 'string') ? appendedInstructions.trim() : '';
    if (!appended) return base || undefined;
    return base ? `${base}\n\n${appended}` : appended;
  }

  async function buildResponsesInputMessageItem(msg, options = {}) {
    if (!msg || typeof msg !== 'object') return null;
    const role = (typeof options.role === 'string' && options.role.trim())
      ? options.role.trim()
      : ((typeof msg.role === 'string') ? msg.role.trim() : '');
    if (!role) return null;

    const item = {
      type: 'message',
      role
    };
    if (typeof msg.name === 'string' && msg.name.trim()) {
      item.name = msg.name.trim();
    }

    const phase = normalizeResponsesMessagePhase(
      Object.prototype.hasOwnProperty.call(options, 'phase') ? options.phase : msg.phase
    );
    if (phase) {
      item.phase = phase;
    }

    const contentSource = Object.prototype.hasOwnProperty.call(options, 'content')
      ? options.content
      : msg.content;

    if (Array.isArray(contentSource)) {
      const contentParts = [];
      for (const part of contentSource) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text') {
          const text = (typeof part.text === 'string') ? part.text : '';
          if (!text) continue;
          contentParts.push({ type: 'input_text', text });
          continue;
        }
        if (part.type === 'image_url' && part.image_url) {
          const rawUrl = part.image_url.url || part.image_url.path || '';
          const resolvedUrl = await normalizeImageUrlForOpenAI(rawUrl);
          if (!resolvedUrl) continue;
          contentParts.push({
            type: 'input_image',
            image_url: resolvedUrl
          });
        }
      }
      if (contentParts.length === 0) {
        contentParts.push({ type: 'input_text', text: '[图片无法读取]' });
      }
      item.content = contentParts;
      return item;
    }

    if (typeof contentSource === 'string') {
      item.content = contentSource;
      return item;
    }

    item.content = '';
    return item;
  }

  async function convertOpenAIMessagesToResponsesInput(messages) {
    const source = Array.isArray(messages) ? messages : [];
    const result = [];

    for (const msg of source) {
      if (!msg || typeof msg !== 'object') continue;
      const role = (typeof msg.role === 'string') ? msg.role.trim() : '';
      if (!role) continue;

      if (Array.isArray(msg.contextual_input_items_before) && msg.contextual_input_items_before.length > 0) {
        const contextualItems = cloneResponsesInputItems(msg.contextual_input_items_before);
        if (contextualItems.length > 0) {
          result.push(...contextualItems);
        }
      }

      if (Array.isArray(msg.response_input_items) && msg.response_input_items.length > 0) {
        const replayItems = cloneResponsesInputItems(msg.response_input_items);
        if (replayItems.length > 0) {
          result.push(...replayItems);
          continue;
        }
      }

      if (role === 'assistant' && Array.isArray(msg.response_activity_timeline)) {
        for (const entry of msg.response_activity_timeline) {
          if (!entry || typeof entry !== 'object') continue;
          if (String(entry.kind || '').trim().toLowerCase() !== 'commentary') continue;
          const commentaryText = (typeof entry.text === 'string') ? entry.text.trim() : '';
          if (!commentaryText) continue;
          const commentaryItem = await buildResponsesInputMessageItem(msg, {
            content: commentaryText,
            phase: normalizeResponsesMessagePhase(entry.phase || 'commentary') || 'commentary'
          });
          if (commentaryItem) {
            result.push(commentaryItem);
          }
        }
      }

      const item = await buildResponsesInputMessageItem(msg);
      if (item) {
        result.push(item);
      }
    }

    return result;
  }

  function normalizeModelIdForSignatureMatch(value) {
    return (typeof value === 'string') ? value.trim().toLowerCase() : '';
  }

  function detectModelFamily(modelId) {
    const id = normalizeModelIdForSignatureMatch(modelId);
    if (!id) return '';
    if (id.includes('claude')) return 'claude';
    if (id.includes('gemini')) return 'gemini';
    return '';
  }

  /**
   * 判断“某条历史消息上的 signature”是否允许回传到当前请求的模型。
   *
   * 背景（线上报错示例）：
   * - 不同模型/不同供应商的 thought signature 不可互传；
   * - 误回传时上游可能返回 400：Corrupted thought signature / signature required；
   *
   * 规则（按用户诉求做“每条消息单独判断”）：
   * - 若双方模型名都包含 claude，则认为同族，可回传；
   * - 若双方模型名都包含 gemini，则认为同族，可回传；
   * - 其他情况：仅当模型 id 完全一致时才回传；
   * - 若缺少任一侧模型 id，则保守不回传（避免误发触发校验失败）。
   *
   * @param {string|null|undefined} messageModelId 历史消息记录的模型ID（apiModelId）
   * @param {string|null|undefined} currentModelId 当前请求使用的模型ID（config.modelName）
   * @returns {boolean}
   */
  function isSignatureCompatibleWithModel(messageModelId, currentModelId) {
    const msgId = normalizeModelIdForSignatureMatch(messageModelId);
    const curId = normalizeModelIdForSignatureMatch(currentModelId);
    if (!msgId || !curId) return false;

    const msgFamily = detectModelFamily(msgId);
    const curFamily = detectModelFamily(curId);
    if (msgFamily && curFamily) {
      return msgFamily === curFamily;
    }
    return msgId === curId;
  }

  function getShouldSendSignatureSetting() {
    try {
      const value = settingsManager?.getSetting?.('shouldSendSignature');
      if (typeof value === 'boolean') return value;
    } catch (_) {}
    // 默认开启：保持与历史行为兼容（Gemini Thought Signature 以及 OpenAI 兼容签名都可用）
    return true;
  }

  /**
   * 构建 API 请求
   * @param {Object} options - 请求选项
   * @param {Array} options.messages - 消息数组
   * @param {Object} options.config - API 配置
   * @param {Object} [options.overrides] - 覆盖默认设置的参数
   * @returns {Promise<Object>} 请求体对象
   */
  async function buildRequest({ messages, config, overrides = {} }) {
    config = resolveEffectiveConfig(config) || config;
    // 构造请求基本结构
    let requestBody = {};
    // 全局开关：是否发送 signature（无论是否发送，接收端解析到 signature 仍会照常存入历史）
    const shouldSendSignature = getShouldSendSignatureSetting();

    // 复制并规范化消息，按需注入“自定义提示词”至系统提示词最顶端
    //
    // 说明（签名透传）：
    // - Cerebr 内部会在历史节点上保存 `thoughtSignature` 等字段；
    // - Gemini：用于在 Part-level 回传 thought_signature；
    // - OpenAI 兼容：部分代理会要求在 message-level 回传 `thoughtSignature` + `reasoning_content`（以及 tool_calls[i].thoughtSignature），否则可能报 “signature required”；
    // - 因此这里先保留内部字段，后续按 API 类型有条件地注入/过滤。
    let normalizedMessages = Array.isArray(messages) ? messages.map(m => ({ ...m })) : [];
    const customSystemPrompt = (config.customSystemPrompt || '').trim();
    if (customSystemPrompt) {
      const systemIndex = normalizedMessages.findIndex(m => m && m.role === 'system');
      if (systemIndex >= 0) {
        const current = normalizedMessages[systemIndex];
        const currentContent = typeof current.content === 'string' ? current.content : '';
        normalizedMessages[systemIndex] = {
          ...current,
          content: `${customSystemPrompt}\n${currentContent}`.trim()
        };
      } else {
        normalizedMessages.unshift({ role: 'system', content: customSystemPrompt });
      }
    }

    // 收集 Gemini systemInstruction 的 parts：
    // - 兼容多条 system 消息（例如“API 消息模板”注入的 {{#system}} 块）；
    // - 保持出现顺序，避免只取首条导致后续系统指令丢失。
    const collectGeminiSystemInstructionParts = (messageList) => {
      const parts = [];
      const source = Array.isArray(messageList) ? messageList : [];
      for (const msg of source) {
        if (!msg || msg.role !== 'system') continue;
        const content = msg.content;
        if (typeof content === 'string') {
          if (content.trim()) {
            parts.push({ text: content });
          }
          continue;
        }
        if (Array.isArray(content)) {
          for (const item of content) {
            if (!item || item.type !== 'text') continue;
            if (typeof item.text !== 'string' || !item.text.trim()) continue;
            parts.push({ text: item.text });
          }
        }
      }
      return parts;
    };

    if (isGeminiConnectionConfig(config)) {
      // Gemini API 请求格式（包含 Gemini 3 思维链签名 Thought Signature 的回传）
      const contents = (await Promise.all(normalizedMessages.map(async (msg) => {
        // Gemini API 使用 'user' 和 'model' 角色
        const role = msg.role === 'assistant' ? 'model' : msg.role;
        // Gemini API 将 'system' 消息作为单独的 systemInstruction
        if (msg.role === 'system') {
          return null; // 在后面单独处理
        }

        const parts = [];
        if (Array.isArray(msg.content)) { // OpenAI Vision 格式 (文本和/或图片)
          for (const item of msg.content) {
            if (item.type === 'text') {
              parts.push({ text: item.text });
            } else if (item.type === 'image_url' && item.image_url) {
              const rawUrl = item.image_url.url || item.image_url.path || '';
              const inlinePart = await buildGeminiInlinePartFromImageUrl(rawUrl);
              if (inlinePart) {
                parts.push(inlinePart);
              }
            }
          }
        } else if (typeof msg.content === 'string') { // 纯文本消息
          parts.push({ text: msg.content });
        } else {
          console.warn('未知的消息内容格式 (Gemini):', msg.content);
        }

        // 如果该消息带有 Gemini 思维链签名，则将签名附加到最后一个 part 上
        // - 只在模型消息（assistant/model）上回传，以符合官方文档建议；
        // - 读取历史消息上记录的 Thought Signature，兼容下划线与驼峰命名；
        // - 重要：若该签名来自 OpenAI 兼容接口（thoughtSignatureSource==='openai'），则不能发给 Gemini。
	        const thoughtSignature =
	          (typeof msg.thoughtSignature === 'string' && msg.thoughtSignature) ||
	          (typeof msg.thought_signature === 'string' && msg.thought_signature) ||
	          null;
	        const thoughtSignatureSource = (typeof msg.thoughtSignatureSource === 'string' && msg.thoughtSignatureSource) || null;
	        const canSendGeminiSignature =
	          shouldSendSignature &&
	          (thoughtSignatureSource !== 'openai') &&
	          isSignatureCompatibleWithModel(msg.apiModelId, config?.modelName);
	        if (canSendGeminiSignature && thoughtSignature && parts.length > 0 && (msg.role === 'assistant' || role === 'model')) {
	          const lastPart = parts[parts.length - 1];
	          if (lastPart && typeof lastPart === 'object') {
	            // 文档中非函数调用场景为 Part-level 字段 thought_signature
	            lastPart.thought_signature = thoughtSignature;
            // 同时写入驼峰形式以兼容可能的服务端实现
            lastPart.thoughtSignature = thoughtSignature;
          }
        }
        
        // 只有当 parts 数组不为空时才创建 content 对象
        if (parts.length > 0) {
          return { role: role, parts: parts };
        }
        return null; // 如果没有有效的 parts，则不为此消息创建 content entry
      }))).filter(Boolean); // 过滤掉 null (例如 system 消息或无效消息)

      const geminiOverrides = buildGeminiApiRequestOverrides(config) || {};
      const {
        generationConfig: geminiGenerationOverrides = {},
        ...geminiRootOverrides
      } = geminiOverrides;
      requestBody = {
        contents: contents,
        generationConfig: {
          responseMimeType: "text/plain",
          temperature: config.temperature ?? 1.0,
          topP: 0.95, // Gemini 使用 topP 而不是 top_p
          ...geminiGenerationOverrides
        },
        ...geminiRootOverrides,
        ...overrides
      };

      // 处理 system 消息：合并所有 system 内容到 systemInstruction（保序）。
      const systemInstructionParts = collectGeminiSystemInstructionParts(normalizedMessages);
      if (systemInstructionParts.length > 0) {
        requestBody.systemInstruction = {
          // 根据Gemini API文档，systemInstruction是Content类型，其role是可选的 ('user'或'model')
          // 对于系统指令，通常不指定role或留空
          parts: systemInstructionParts
        };
      }
      // 如果存在自定义参数，解析并合并到 generationConfig
      if (config.customParams) {
        try {
          const allCustomParams = JSON.parse(config.customParams);
          const { tools, ...generationCustomParams } = allCustomParams; // 分离 tools 和其他参数

          if (tools && Array.isArray(tools)) {
            requestBody.tools = tools; // 将 tools 添加到请求体的根级别
          }
          
          // 将剩余的自定义参数合并到 generationConfig
          if (Object.keys(generationCustomParams).length > 0) {
            requestBody.generationConfig = { 
              ...requestBody.generationConfig, 
              ...generationCustomParams 
            };
          }
        } catch (e) {
          console.error("解析自定义参数 JSON 失败 (Gemini)，请检查格式。", e);
        }
      }

      // 再次应用 overrides，确保单次请求级别的覆盖（例如宽高比）优先于配置级自定义参数
      if (overrides && typeof overrides === 'object') {
        const originalGenerationConfig = requestBody.generationConfig || {};
        requestBody = { ...requestBody, ...overrides };
        if (overrides.generationConfig) {
          const mergedGenConfig = {
            ...originalGenerationConfig,
            ...overrides.generationConfig
          };
          // 深度合并 imageConfig，避免覆盖用户已配置的分辨率等字段
          if (overrides.generationConfig.imageConfig || originalGenerationConfig.imageConfig) {
            const mergedImageConfig = {
              ...(originalGenerationConfig.imageConfig || {}),
              ...(overrides.generationConfig.imageConfig || {})
            };
            if (!mergedImageConfig.imageSize) {
              mergedImageConfig.imageSize = (originalGenerationConfig.imageConfig && originalGenerationConfig.imageConfig.imageSize) || '4K';
            }
            mergedGenConfig.imageConfig = mergedImageConfig;
          }
          requestBody.generationConfig = mergedGenConfig;
        }
      }

    } else {
      // OpenAI 兼容请求格式：
      // - /chat/completions 继续沿用原结构；
      // - /responses 自动切换为 Responses API 结构（支持 input_text/input_image）。
      const useResponsesApi = isOpenAIResponsesConnectionConfig(config);
      const sanitizedMessages = await Promise.all(normalizedMessages.map(async (msg) => {
        const base = { role: msg.role };
        if (msg.name) base.name = msg.name;
        if (msg.tool_call_id) base.tool_call_id = msg.tool_call_id;
        if (useResponsesApi && Array.isArray(msg.response_input_items) && msg.response_input_items.length > 0) {
          base.response_input_items = cloneResponsesInputItems(msg.response_input_items);
        }

        // OpenAI 兼容：对每条历史消息单独判断是否允许回传 signature（避免跨模型导致 Corrupted thought signature）
        // 仅在 thoughtSignatureSource==='openai' 时才考虑回传，避免把 Gemini 的签名/字段发给 OpenAI 接口。
        const thoughtSignatureSource = (typeof msg.thoughtSignatureSource === 'string' && msg.thoughtSignatureSource) || null;
        const isAssistant = msg.role === 'assistant';
        const canSendOpenAISignature =
          shouldSendSignature &&
          thoughtSignatureSource === 'openai' &&
          isAssistant &&
          isSignatureCompatibleWithModel(msg.apiModelId, config?.modelName);

        // tool_calls：如果该片段带签名但当前不允许回传，则整个 tool_calls 片段都不发送（遵循“不要回传带签名的 tool 片段”原则）
        const rawToolCalls = (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) ? msg.tool_calls : null;
        if (rawToolCalls) {
          const toolCallsHasSignature = rawToolCalls.some((tc) => {
            if (!tc || typeof tc !== 'object') return false;
            const ts = (typeof tc.thoughtSignature === 'string' && tc.thoughtSignature) ||
              (typeof tc.thought_signature === 'string' && tc.thought_signature) ||
              null;
            return !!ts;
          });
          if (!toolCallsHasSignature) {
            base.tool_calls = rawToolCalls;
          } else if (canSendOpenAISignature) {
            base.tool_calls = rawToolCalls;
          }
        }

        // message-level thoughtSignature（对应 reasoning_content 的签名）
        if (canSendOpenAISignature) {
          const thoughtSignature =
            (typeof msg.thoughtSignature === 'string' && msg.thoughtSignature) ||
            (typeof msg.thought_signature === 'string' && msg.thought_signature) ||
            null;
          if (thoughtSignature) {
            base.thoughtSignature = thoughtSignature;
            // 注意：reasoning_content 必须与 message-level thoughtSignature 成对回传，否则部分上游会报 “signature required”。
            // 同时要求“原样回传”，不要做 trim/合并/格式化。
            if (typeof msg.reasoning_content === 'string') {
              base.reasoning_content = msg.reasoning_content;
            } else if (typeof msg.reasoning === 'string') {
              base.reasoning = msg.reasoning;
            }
          }
        }

        if (Array.isArray(msg.content)) {
          const parts = [];
          for (const item of msg.content) {
            if (item.type === 'text') {
              parts.push({ type: 'text', text: item.text });
            } else if (item.type === 'image_url' && item.image_url) {
              const rawUrl = item.image_url.url || item.image_url.path || '';
              const resolvedUrl = await normalizeImageUrlForOpenAI(rawUrl);
              if (resolvedUrl) {
                parts.push({ type: 'image_url', image_url: { url: resolvedUrl } });
              }
            }
          }
          if (parts.length === 0) {
            // 当图片解析失败时提供占位文本，避免发送空消息或携带 file:// 路径
            parts.push({ type: 'text', text: '[图片无法读取]' });
          }
          base.content = parts;
        } else {
          base.content = msg.content;
        }
        return base;
      }));

      if (useResponsesApi) {
        const {
          messages: responsesMessages,
          instructions: responsesSystemInstructions
        } = extractResponsesSystemInstructions(normalizedMessages);
        const responsesInput = await convertOpenAIMessagesToResponsesInput(responsesMessages);
        const responsesOverrides = buildResponsesApiRequestOverrides(config) || {};
        requestBody = {
          model: config.modelName,
          input: responsesInput,
          stream: (config.useStreaming !== false),
          ...responsesOverrides,
          ...overrides
        };
        requestBody.instructions = appendResponsesInstructions(
          requestBody.instructions,
          responsesSystemInstructions
        );
        // Responses API 对不同模型支持参数存在差异；默认仅在用户主动调节时带上 temperature，避免不兼容参数导致 400。
        const temperature = Number(config.temperature);
        if (Number.isFinite(temperature) && temperature !== 1) {
          requestBody.temperature = temperature;
        }
      } else {
        requestBody = {
          model: config.modelName,
          messages: sanitizedMessages, // OpenAI API 仅接收标准字段，过滤内部扩展字段
          stream: (config.useStreaming !== false),
          temperature: config.temperature ?? 1.0, // 确保有默认值
          top_p: 0.95,
          ...overrides // 允许覆盖默认参数
        };
      }

      // 如果存在自定义参数，解析并合并
      if (config.customParams) {
        try {
          const extraParams = JSON.parse(config.customParams);
          requestBody = { ...requestBody, ...extraParams };
        } catch (e) {
          console.error("解析自定义参数 JSON 失败，请检查格式。", e);
        }
      }
    }
    return requestBody;
  }

  /**
   * 发送 API 请求
   * @param {Object} options - 请求选项
   * @param {Object} options.requestBody - 请求体
   * @param {Object} options.config - API 配置
   * @param {AbortSignal} [options.signal] - 中止信号
   * @param {(evt: {stage: string, [key: string]: any}) => void} [options.onStatus] - 状态回调（用于 UI 展示更细粒度的请求阶段；不得包含敏感信息）
   * @returns {Promise<Response>} Fetch 响应对象
   * @throws {Error} 如果鉴权信息无效（当未填写 key/文件路径时会走免 key 请求）
   */
  async function sendRequest({ requestBody, config, signal, onStatus }) {
    config = resolveEffectiveConfig(config) || config;
    // 说明：Fetch API 无法精确提供“上传进度/已上传完毕”的事件。
    // 这里的阶段回调只基于我们能观测到的关键生命周期节点（开始发起请求/请求已发出/收到响应头/遇到限流切换 Key 等），
    // 用于提升 UI 透明度，但不承诺网络层面的逐字节进度。
    const emitStatus = (evt) => {
      if (typeof onStatus !== 'function') return;
      try { onStatus(evt); } catch (e) { console.warn('sendRequest onStatus 回调异常:', e); }
    };

    const configId = getConfigIdentifier(config);
    const normalizedBaseUrl = (typeof config?.baseUrl === 'string') ? config.baseUrl.trim() : '';
    const normalizedModelName = (typeof config?.modelName === 'string') ? config.modelName.trim() : '';
    const connectionType = getConfigConnectionType(config);
    const isGeminiConnection = connectionType === CONNECTION_TYPE_GEMINI;
    const effectiveBaseUrl = isGeminiConnection
      ? normalizeConfigBaseUrlByConnection(CONNECTION_TYPE_GEMINI, normalizedBaseUrl)
      : normalizedBaseUrl;
    const statusApiBase = effectiveBaseUrl || String(config?.baseUrl || '');
    const statusModelName = normalizedModelName || String(config?.modelName || '');
    // 确保黑名单已加载（若未调用过 loadAPIConfigs）
    if (!apiKeyBlacklist || typeof apiKeyBlacklist !== 'object') {
      try { await loadApiKeyBlacklist(); } catch (_) {}
    }

    // 选择可用的 Key：成功不轮换；429 临时黑名单；bad request 的 400 不拉黑；其余 400/403 永久黑名单
    const tried = new Set();
    let lastErrorResponse = null;
    const hasApiKeyFilePath = !!normalizeApiKeyFilePath(config?.apiKeyFilePath);
    const hasInlineApiKey = normalizeApiKeys(config?.apiKey).length > 0;
    const allowRequestWithoutApiKey = !hasApiKeyFilePath && !hasInlineApiKey;
    let hasReloadedFileKeys = false;

    // 计算候选 key：
    // - 默认使用输入框中的 apiKey；
    // - 若配置了 apiKeyFilePath，则优先从文件读取；首次成功后走内存缓存；
    // - 仅在“当前 key 不可用/无可用 key”时，才会强制重读文件一次。
    let resolvedKeys = await resolveRuntimeApiKeys(config, emitStatus);
    let keysArray = Array.isArray(resolvedKeys?.keys) ? resolvedKeys.keys : [];
    let isArrayKeys = keysArray.length > 1;
    const isKeylessMode = allowRequestWithoutApiKey && keysArray.length === 0;
    if (keysArray.length === 0) {
      if (isKeylessMode) {
        emitStatus({
          stage: 'api_key_omitted',
          keySource: 'none',
          apiBase: statusApiBase,
          modelName: statusModelName
        });
      } else {
      console.error('API Key 缺失或无效:', { modelName: config?.modelName, baseUrl: config?.baseUrl, source: resolvedKeys?.source });
      const detailText = (typeof resolvedKeys?.detail === 'string' && resolvedKeys.detail.trim())
        ? ` (${resolvedKeys.detail.trim()})`
        : '';
      throw new Error(`API Key for ${config.displayName || config.modelName} is missing or invalid${detailText}.`);
      }
    }

    // 查找当前使用索引（若未设置，默认为 0）
    if (isArrayKeys && typeof apiKeyUsageIndex[configId] !== 'number') {
      apiKeyUsageIndex[configId] = 0;
    }

    const tryReloadKeysFromFileOnce = async (reason = '') => {
      if (!hasApiKeyFilePath || hasReloadedFileKeys) return false;
      hasReloadedFileKeys = true;

      emitStatus({
        stage: 'api_key_file_reload_start',
        reason,
        apiBase: statusApiBase,
        modelName: statusModelName
      });

      const refreshed = await resolveRuntimeApiKeys(config, emitStatus, { forceFileReload: true });
      const refreshedKeys = Array.isArray(refreshed?.keys) ? refreshed.keys : [];
      if (refreshedKeys.length === 0) return false;

      resolvedKeys = refreshed;
      keysArray = refreshedKeys;
      isArrayKeys = keysArray.length > 1;
      if (isArrayKeys && typeof apiKeyUsageIndex[configId] !== 'number') {
        apiKeyUsageIndex[configId] = 0;
      } else if (isArrayKeys) {
        apiKeyUsageIndex[configId] = Math.min(Math.max(0, apiKeyUsageIndex[configId] || 0), keysArray.length - 1);
      }
      return true;
    };

    while (true) {
      let selectedIndex = 0;
      let selectedKey = '';
      if (isKeylessMode) {
        selectedIndex = -1;
        selectedKey = '';
      } else if (isArrayKeys) {
        // 从当前索引开始，选择第一个不在黑名单且未尝试过的 key
        const startIndex = Math.min(Math.max(0, apiKeyUsageIndex[configId] || 0), keysArray.length - 1);
        const idx = getNextUsableKeyIndex({ apiKey: keysArray }, startIndex, tried);
        if (idx === -1) {
          const reloaded = await tryReloadKeysFromFileOnce('no_usable_key_before_request');
          if (reloaded) {
            continue;
          }
          // 无可用 key
          if (lastErrorResponse) return lastErrorResponse; // 返回最后一次错误响应，让上层按原逻辑处理
          throw new Error('没有可用的 API Key（全部黑名单或被删除）');
        }
        selectedIndex = idx;
        selectedKey = keysArray[selectedIndex] || '';
      } else {
        // 单 key 情况
        selectedIndex = 0;
        selectedKey = keysArray[0];
      }

      if (!selectedKey && !isKeylessMode) {
        if (lastErrorResponse) return lastErrorResponse;
        throw new Error(`Selected API Key for ${config.displayName || config.modelName} is empty.`);
      }

      if (!isKeylessMode) {
        emitStatus({
          stage: 'api_key_selected',
          keyIndex: selectedIndex,
          keyCount: isArrayKeys ? keysArray.length : 1,
          triedCount: tried.size,
          isKeyRotation: isArrayKeys,
          keySource: resolvedKeys?.source || 'inline',
          apiBase: statusApiBase,
          modelName: statusModelName
        });
      }

      // 组装请求
      let endpointUrl = effectiveBaseUrl;
      const headers = { 'Content-Type': 'application/json' };
      if (isGeminiConnection) {
        endpointUrl = buildGeminiEndpointUrl({
          baseUrl: effectiveBaseUrl,
          modelName: normalizedModelName,
          apiKey: selectedKey,
          useStreaming: (config.useStreaming !== false)
        });
      } else {
        if (!endpointUrl) {
          throw new Error('API Base URL 为空，请在 API 设置中填写有效地址');
        }
        let parsedEndpoint = null;
        try {
          parsedEndpoint = new URL(endpointUrl);
        } catch (_) {
          throw new Error(`API Base URL 无效：${endpointUrl}`);
        }
        const protocol = String(parsedEndpoint?.protocol || '').toLowerCase();
        if (protocol !== 'http:' && protocol !== 'https:') {
          throw new Error(`API Base URL 协议不受支持：${protocol || 'unknown'}`);
        }
        if (selectedKey) {
          headers['Authorization'] = `Bearer ${selectedKey}`;
        }
      }

      emitStatus({
        stage: 'http_request_start',
        apiBase: statusApiBase,
        modelName: statusModelName,
        useStreaming: isGeminiConnection ? (config.useStreaming !== false) : !!requestBody?.stream
      });

      // 重要：先创建 fetch Promise 再 emit “已发出请求”，让 UI 可以在等待响应头阶段展示更明确的状态。
      // 这里不向 onStatus 透出 endpointUrl，避免 Gemini 场景下 URL 携带 key 造成泄漏风险。
      const endpointHint = (() => {
        if (isGeminiConnection) {
          try {
            const parsed = new URL(endpointUrl);
            return `gemini:${parsed.host}${parsed.pathname}`;
          } catch (_) {
            return `gemini:${normalizedModelName}`;
          }
        }
        try {
          const parsed = new URL(endpointUrl);
          return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
        } catch (_) {
          return endpointUrl;
        }
      })();
      let fetchPromise = null;
      try {
        fetchPromise = fetch(endpointUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
          signal
        });
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        throw new Error(`网络请求初始化失败（${endpointHint}）：${error?.message || 'Failed to fetch'}`);
      }

      emitStatus({
        stage: 'http_request_sent',
        apiBase: statusApiBase,
        modelName: statusModelName
      });

      let response = null;
      try {
        response = await fetchPromise;
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        throw new Error(`网络请求失败（${endpointHint}）：${error?.message || 'Failed to fetch'}`);
      }
      emitStatus({
        stage: 'http_response_headers_received',
        status: response?.status,
        ok: response?.ok,
        apiBase: statusApiBase,
        modelName: statusModelName
      });

      // 处理 429：加入黑名单并尝试下一个 key
      if (response.status === 429) {
        emitStatus({
          stage: 'http_429_rate_limited',
          willRetry: !!(isArrayKeys && !isKeylessMode),
          apiBase: statusApiBase,
          modelName: statusModelName
        });
        lastErrorResponse = response;
        if (selectedKey) {
          try { await blacklistKey(selectedKey, 24 * 60 * 60 * 1000); } catch (_) {}
          tried.add(selectedKey);
        }
        if (isArrayKeys) {
          // 轮换到下一个可用 key（并更新“当前使用”索引）
          const nextIdx = getNextUsableKeyIndex({ apiKey: keysArray }, (selectedIndex + 1) % keysArray.length, tried);
          if (nextIdx === -1) {
            const reloaded = await tryReloadKeysFromFileOnce('rate_limited_no_next_key');
            if (reloaded) {
              continue;
            }
            return response; // 无可用 key，返回 429 响应
          }
          apiKeyUsageIndex[configId] = nextIdx;
          // 循环继续自动重试
          continue;
        }
        // 单 key：仅在使用本地文件 key 时尝试一次重读（便于立即接入新 key），否则按原逻辑返回。
        {
          const reloaded = await tryReloadKeysFromFileOnce('rate_limited_single_key');
          if (reloaded) {
            continue;
          }
        }
        return response;
      }

      // 处理 400：若明确是 bad request（请求体/参数错误），不拉黑 key。
      if (response.status === 400) {
        const badRequest = await isBadRequest400(response);
        if (badRequest) {
          emitStatus({
            stage: 'http_400_bad_request_not_blacklisted',
            status: 400,
            willRetry: false,
            apiBase: statusApiBase,
            modelName: statusModelName
          });
          return response;
        }
      }

      // 处理“非 bad request 的 400”与 403：标记 key 永久不可用
      if (response.status === 400 || response.status === 403) {
        emitStatus({
          stage: 'http_auth_or_bad_request_key_blacklisted',
          status: response.status,
          willRetry: !!(isArrayKeys && !isKeylessMode),
          noApiKey: !selectedKey,
          apiBase: statusApiBase,
          modelName: statusModelName
        });
        if (!selectedKey) {
          return response;
        }
        lastErrorResponse = response;
        tried.add(selectedKey);
        try { await blacklistKey(selectedKey, -1); } catch (_) {}
        if (isArrayKeys) {
          const nextIdx = getNextUsableKeyIndex({ apiKey: keysArray }, (selectedIndex + 1) % keysArray.length, tried);
          if (nextIdx === -1) {
            const reloaded = await tryReloadKeysFromFileOnce('key_blacklisted_no_next_key');
            if (reloaded) {
              continue;
            }
            return response;
          }
          apiKeyUsageIndex[configId] = nextIdx;
          continue;
        }
        {
          const reloaded = await tryReloadKeysFromFileOnce('key_blacklisted_single_key');
          if (reloaded) {
            continue;
          }
        }
        return response;
      }

      // 其他错误：直接返回给上层处理（不更改轮换状态）
      if (!response.ok) {
        return response;
      }

      // 成功：固定在当前 key（不轮换）。将当前索引保存为“正在使用”的索引
      if (isArrayKeys) {
        apiKeyUsageIndex[configId] = selectedIndex;
      }
      return response;
    }
  }

  /**
   * 设置UI事件处理
   * @param {HTMLElement} apiSettingsToggle - API设置切换按钮
   * @param {HTMLElement} backButton - 返回按钮
   */
  function setupUIEventHandlers(appContextForSetup) {
    const currentAppContext = appContextForSetup || appContext;
    const toggleButton = currentAppContext.dom.apiSettingsToggle;
    const panel = currentAppContext.dom.apiSettingsPanel;
    const backButtonElement = currentAppContext.dom.apiSettingsBackButton;
    const addButton = currentAppContext.dom.apiSettingsAddButton;
    const addConnectionSourceButton = currentAppContext.dom.connectionSourceAddButton
      || document.getElementById('connection-source-add');
    const connectionSourcesPanel = panel?.querySelector('.connection-sources-panel')
      || document.querySelector('#api-settings .connection-sources-panel')
      || document.querySelector('.connection-sources-panel');
    const connectionSourcesHeader = connectionSourcesPanel?.querySelector('.connection-sources-header') || null;
    const connectionSourcesTitle = connectionSourcesPanel?.querySelector('.connection-sources-title') || null;
    if (connectionSourcesTitle && !connectionSourcesTitle.dataset.baseTitle) {
      connectionSourcesTitle.dataset.baseTitle = (connectionSourcesTitle.textContent || '').trim() || '连接源';
    }
    const applyConnectionSourcesPanelState = () => {
      if (!connectionSourcesPanel || !connectionSourcesHeader) return;
      const baseTitle = (connectionSourcesTitle?.dataset?.baseTitle || '连接源').trim() || '连接源';
      connectionSourcesPanel.classList.toggle('collapsed', !isConnectionSourcesPanelExpanded);
      connectionSourcesHeader.setAttribute('aria-expanded', isConnectionSourcesPanelExpanded ? 'true' : 'false');
      connectionSourcesHeader.title = isConnectionSourcesPanelExpanded ? '点击折叠连接源配置区' : '点击展开连接源配置区';
      if (connectionSourcesTitle) {
        connectionSourcesTitle.textContent = isConnectionSourcesPanelExpanded ? baseTitle : `${baseTitle}（已折叠）`;
      }
    };
    if (connectionSourcesHeader) {
      connectionSourcesHeader.classList.add('is-collapsible');
      connectionSourcesHeader.setAttribute('tabindex', '0');
      connectionSourcesHeader.setAttribute('role', 'button');
      connectionSourcesHeader.addEventListener('click', (event) => {
        const target = event.target;
        if (addConnectionSourceButton && target instanceof Element && (target === addConnectionSourceButton || addConnectionSourceButton.contains(target))) {
          return;
        }
        isConnectionSourcesPanelExpanded = !isConnectionSourcesPanelExpanded;
        applyConnectionSourcesPanelState();
      });
      connectionSourcesHeader.addEventListener('keydown', (event) => {
        if (event.target !== connectionSourcesHeader) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        isConnectionSourcesPanelExpanded = !isConnectionSourcesPanelExpanded;
        applyConnectionSourcesPanelState();
      });
      applyConnectionSourcesPanelState();
    }

    // 显示/隐藏 API 设置（已并入“聊天记录”面板的标签页）
    toggleButton.addEventListener('click', async (e) => {
      e?.stopPropagation?.();

      const chatHistoryUI = currentAppContext.services?.chatHistoryUI;
      const uiManager = currentAppContext.services?.uiManager;
      const targetTab = 'api-settings';

      const isPanelOpen = !!chatHistoryUI?.isChatHistoryPanelOpen?.();
      const activeTab = chatHistoryUI?.getActiveTabName?.();

      // 行为对齐旧交互：已在该标签页时再次点击则关闭面板，否则跳转到该标签页。
      if (isPanelOpen && activeTab === targetTab) {
        uiManager?.closeExclusivePanels?.();
        return;
      }

      if (!isPanelOpen) {
        uiManager?.closeExclusivePanels?.();
        await chatHistoryUI?.showChatHistoryPanel?.(targetTab);
      } else {
        await chatHistoryUI?.activateTab?.(targetTab);
      }

    });

    // 返回聊天界面
    backButtonElement.addEventListener('click', () => {
      const chatHistoryUI = currentAppContext.services?.chatHistoryUI;
      if (chatHistoryUI?.closeChatHistoryPanel) {
        chatHistoryUI.closeChatHistoryPanel();
      } else {
        panel.classList.remove('visible');
      }
    });

    // 新增按钮：创建空配置，避免依赖克隆。
    if (addButton) {
      addButton.addEventListener('click', (e) => {
        e?.stopPropagation?.();
        addConfig();
      });
    }

    if (addConnectionSourceButton) {
      addConnectionSourceButton.addEventListener('click', (e) => {
        e?.stopPropagation?.();
        const nextSource = createDefaultConnectionSource({
          name: `${CONNECTION_SOURCE_DEFAULT_NAME_PREFIX} ${connectionSources.length + 1}`
        });
        connectionSources.push(nextSource);
        assignStableConnectionSourceNames(connectionSources);
        invalidateModelListCacheForSource(nextSource.id);
        saveAPIConfigs();
        renderConnectionSources();
        renderAPICards();
      });
    }
  }

  /**
   * 获取模型配置
   * @param {string} [promptType] - 提示词类型
   * @param {Object} promptsConfig - 提示词设置
   * @param {number} [messagesCount] - 当前对话的消息数量 (可选)
   * @returns {Object} 选中的API配置
   */
  function getModelConfig(promptType, promptsConfig, messagesCount) {
    const SHORT_CONVO_DISPLAY_NAME = "[S]"; // 用于短对话的配置标识
    const MEDIUM_CONVO_DISPLAY_NAME = "[M]"; // 用于中等长度对话的配置标识

    // 2. 检查特定提示词类型是否指定了特定模型 (原有逻辑)
    if (promptType && promptsConfig && promptsConfig[promptType]?.model) {
      const preferredValue = String(promptsConfig[promptType].model || '').trim();
      if (preferredValue) {
        // 支持 id 优先；回退 displayName；再回退 modelName
        let config = apiConfigs.find(c => c.id && c.id === preferredValue);
        if (!config) config = apiConfigs.find(c => (c.displayName || '').trim() === preferredValue);
        if (!config) config = apiConfigs.find(c => (c.modelName || '').trim() === preferredValue);
        if (config) {
          console.log(`根据 promptType "${promptType}" 使用配置: ${config.displayName || config.modelName}`);
          return resolveEffectiveConfig(config) || config;
        }
        console.log(`未找到 promptType "${promptType}" 指定的配置 "${preferredValue}"，将使用默认选中配置。`);
      }
    }

    // 1. 检查对话长度并尝试查找特定配置
    if (messagesCount !== undefined) {
      if (messagesCount < 50) {
        const shortConvoConfig = apiConfigs.find(c => c.displayName?.includes(SHORT_CONVO_DISPLAY_NAME));
        if (shortConvoConfig) {
          console.log(`使用短对话配置: ${shortConvoConfig.displayName}`);
          return resolveEffectiveConfig(shortConvoConfig) || shortConvoConfig;
        }
        console.log(`未找到displayName包含"${SHORT_CONVO_DISPLAY_NAME}" 的配置，将继续默认逻辑。`);
      } else if (messagesCount < 300) {
        const mediumConvoConfig = apiConfigs.find(c => c.displayName?.includes(MEDIUM_CONVO_DISPLAY_NAME));
        if (mediumConvoConfig) {
          console.log(`使用中等长度对话配置: ${mediumConvoConfig.displayName}`);
          return resolveEffectiveConfig(mediumConvoConfig) || mediumConvoConfig;
        }
        console.log(`未找到displayName包含"${MEDIUM_CONVO_DISPLAY_NAME}" 的配置，将继续默认逻辑。`);
      }
    }
    // 3. 如果没有特定模型配置或找不到，使用当前选中的配置 (原有逻辑)
    const selectedConfig = apiConfigs[selectedConfigIndex] || apiConfigs[0]; // 保证总有返回值
    console.log(`使用当前选中配置: ${selectedConfig?.displayName || selectedConfig?.modelName}`);
    return resolveEffectiveConfig(selectedConfig) || selectedConfig;
  }

  /**
   * 从部分配置信息中获取完整的 API 配置
   * @param {Object} partialConfig - 部分 API 配置信息
   * @param {'openai'|'openai_responses'|'gemini'} [partialConfig.connectionType] - 连接方式（可选）
   * @param {string} partialConfig.baseUrl - API 基础 URL
   * @param {string} partialConfig.modelName - 模型名称
   * @param {string} [partialConfig.apiKeyFilePath] - 本地 Key 文件路径（可选）
   * @param {number} [partialConfig.temperature] - 温度值
   * @param {string} [partialConfig.customParams] - 自定义参数字符串
   * @param {boolean} [partialConfig.enableAskOtherAiTool] - 是否允许“向其他AI提问”工具使用该配置
   * @param {string} [partialConfig.userMessagePreprocessorTemplate] - 用户消息预处理模板（支持 {{#system}}/{{#assistant}}/{{#user}} 角色块与 {{no_system_prompt}} 控制标记）
   * @param {boolean} [partialConfig.userMessagePreprocessorIncludeInHistory] - 预处理结果是否写入历史
   * @returns {Object|null} 完整的 API 配置对象或 null
   */
  function getApiConfigFromPartial(partialConfig) {
    if (!partialConfig || !partialConfig.modelName) {
      return null;
    }
    const partialConnectionType = normalizeConnectionType(partialConfig.connectionType);
    const inferredType = partialConnectionType
      || inferConnectionTypeByBaseUrl(partialConfig.baseUrl)
      || CONNECTION_TYPE_OPENAI;
    const normalizedPartialBaseUrl = normalizeConfigBaseUrlByConnection(inferredType, partialConfig.baseUrl);

    const normalizedModelName = (typeof partialConfig.modelName === 'string')
      ? partialConfig.modelName.trim()
      : '';
    if (!normalizedModelName) return null;

    let matchedConfig = null;
    if (partialConfig.id) {
      matchedConfig = apiConfigs.find(config => config.id === partialConfig.id) || null;
    }
    if (!matchedConfig && partialConfig.connectionSourceId) {
      matchedConfig = apiConfigs.find(config =>
        config.connectionSourceId === partialConfig.connectionSourceId
        && (config.modelName || '').trim() === normalizedModelName
      ) || null;
    }
    if (!matchedConfig && normalizedPartialBaseUrl) {
      matchedConfig = apiConfigs.find((config) => {
        const effective = resolveEffectiveConfig(config);
        if (!effective) return false;
        return (effective.modelName || '').trim() === normalizedModelName
          && effective.baseUrl === normalizedPartialBaseUrl
          && (!partialConnectionType || getConfigConnectionType(effective) === partialConnectionType);
      }) || null;
    }
    if (!matchedConfig && partialConfig.displayName) {
      matchedConfig = apiConfigs.find(config => (config.displayName || '').trim() === String(partialConfig.displayName).trim()) || null;
    }

    if (matchedConfig) {
      return resolveEffectiveConfig(matchedConfig) || matchedConfig;
    }

    const selectedRawConfig = apiConfigs[selectedConfigIndex] || apiConfigs[0] || null;
    const selectedEffectiveConfig = resolveEffectiveConfig(selectedRawConfig) || null;
    let selectedSourceId = selectedRawConfig?.connectionSourceId || '';

    if (partialConfig.connectionSourceId && getConnectionSourceById(partialConfig.connectionSourceId)) {
      selectedSourceId = partialConfig.connectionSourceId;
    } else if (normalizedPartialBaseUrl) {
      const matchedSource = connectionSources.find((source) => {
        const sourceType = normalizeConnectionType(source?.connectionType) || inferConnectionTypeByBaseUrl(source?.baseUrl);
        const sourceBaseUrl = normalizeConfigBaseUrlByConnection(sourceType, source?.baseUrl);
        if (sourceBaseUrl !== normalizedPartialBaseUrl) return false;
        if (partialConnectionType && sourceType !== partialConnectionType) return false;
        return true;
      });
      if (matchedSource?.id) {
        selectedSourceId = matchedSource.id;
      }
    }

    const transientConfig = {
      id: generateUUID(),
      connectionSourceId: selectedSourceId,
      modelName: normalizedModelName,
      displayName: partialConfig.displayName || '',
      temperature: partialConfig.temperature ?? 1.0,
      useStreaming: partialConfig.useStreaming !== false,
      isFavorite: false,
      enableAskOtherAiTool: !!partialConfig.enableAskOtherAiTool,
      customParams: partialConfig.customParams || '',
      customSystemPrompt: partialConfig.customSystemPrompt || '',
      userMessagePreprocessorTemplate: (typeof partialConfig.userMessagePreprocessorTemplate === 'string')
        ? partialConfig.userMessagePreprocessorTemplate
        : '',
      userMessagePreprocessorIncludeInHistory: !!partialConfig.userMessagePreprocessorIncludeInHistory,
      maxChatHistory: 500,
      maxChatHistoryUser: 500,
      maxChatHistoryAssistant: 500
    };
    const transientResponsesApiSettings = normalizeResponsesApiSettings(partialConfig.responsesApiSettings);
    if (transientResponsesApiSettings) {
      transientConfig.responsesApiSettings = transientResponsesApiSettings;
    }
    const transientGeminiApiSettings = normalizeGeminiApiSettings(partialConfig.geminiApiSettings);
    if (transientGeminiApiSettings) {
      transientConfig.geminiApiSettings = transientGeminiApiSettings;
    }

    const hasSource = !!getConnectionSourceById(selectedSourceId);
    if (!hasSource) {
      transientConfig.connectionType = inferredType;
      transientConfig.baseUrl = normalizedPartialBaseUrl || selectedEffectiveConfig?.baseUrl || '';
      transientConfig.apiKey = normalizeApiKeyValue(partialConfig.apiKey || selectedEffectiveConfig?.apiKey || '');
      transientConfig.apiKeyFilePath = normalizeApiKeyFilePath(partialConfig.apiKeyFilePath || selectedEffectiveConfig?.apiKeyFilePath || '');
    }

    return resolveEffectiveConfig(transientConfig) || transientConfig;
  }

  /**
   * 解析外部传入的 apiParam 为可用的完整 API 配置
   * 支持以下形式：
   * - 字符串：'selected' | 配置 id | displayName | modelName
   * - 对象：
   *   - { id?: string, displayName?: string }
   *   - { favoriteIndex?: number } 选择收藏列表中的第 N 个
   *   - { baseUrl, modelName, ... } 作为部分配置，自动补全为完整配置
   * @param {string|Object|null|undefined} apiParam
   * @returns {Object|null} 匹配/构造的配置，未解析成功返回 null
   */
  function resolveApiParam(apiParam) {
    if (apiParam == null) {
      const selected = apiConfigs[selectedConfigIndex] || apiConfigs[0] || null;
      return resolveEffectiveConfig(selected) || selected;
    }

    // 字符串：特殊值或 id/displayName/modelName
    if (typeof apiParam === 'string') {
      const key = apiParam.trim();
      if (key.toLowerCase() === 'selected' || key.toLowerCase() === 'follow_current') {
        const selected = apiConfigs[selectedConfigIndex] || apiConfigs[0] || null;
        return resolveEffectiveConfig(selected) || selected;
      }
      let config = apiConfigs.find(c => c.id && c.id === key);
      if (!config) config = apiConfigs.find(c => (c.displayName || '').trim() === key);
      if (!config) config = apiConfigs.find(c => (c.modelName || '').trim() === key);
      return (resolveEffectiveConfig(config) || config || null);
    }

    // 对象：优先 id/displayName；favoriteIndex；否则按部分配置补全
    if (typeof apiParam === 'object') {
      if (apiParam.id) {
        const cfg = apiConfigs.find(c => c.id === apiParam.id);
        if (cfg) return resolveEffectiveConfig(cfg) || cfg;
      }
      if (apiParam.displayName) {
        const cfg = apiConfigs.find(c => (c.displayName || '').trim() === String(apiParam.displayName).trim());
        if (cfg) return resolveEffectiveConfig(cfg) || cfg;
      }
      if (apiParam.connectionSourceId) {
        const cfg = apiConfigs.find((c) => {
          if (!c || c.connectionSourceId !== apiParam.connectionSourceId) return false;
          if (apiParam.modelName && (c.modelName || '').trim() !== String(apiParam.modelName).trim()) return false;
          return true;
        });
        if (cfg) return resolveEffectiveConfig(cfg) || cfg;
      }
      if (typeof apiParam.favoriteIndex === 'number') {
        const favorites = apiConfigs.filter(c => c.isFavorite);
        const idx = apiParam.favoriteIndex;
        if (idx >= 0 && idx < favorites.length) {
          const favorite = favorites[idx];
          return resolveEffectiveConfig(favorite) || favorite;
        }
        return null;
      }
      // 作为部分配置尝试补全
      return getApiConfigFromPartial(apiParam);
    }

    return null;
  }

  // 新增配置入口：集中处理默认值与持久化，避免各处复制逻辑。
  function addConfig(config = {}) {
    let connectionSourceId = (typeof config?.connectionSourceId === 'string') ? config.connectionSourceId.trim() : '';
    const hasLegacyConnectionFields = hasMeaningfulLegacyConnectionFields(config);

    if (!connectionSourceId && hasLegacyConnectionFields) {
      const signatureSource = normalizeConnectionSource({
        connectionType: config.connectionType,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        apiKeyFilePath: config.apiKeyFilePath
      });
      const signature = buildConnectionSourceDedupeKey(signatureSource);
      const matchedSource = connectionSources.find(source => buildConnectionSourceDedupeKey(source) === signature) || null;
      if (matchedSource?.id) {
        connectionSourceId = matchedSource.id;
      } else {
        const nextSource = normalizeConnectionSource({
          ...signatureSource,
          id: generateUUID(),
          name: config.connectionSourceName || ''
        });
        connectionSources.push(nextSource);
        assignStableConnectionSourceNames(connectionSources);
        connectionSourceId = nextSource.id;
        renderConnectionSources();
      }
    }

    // 新建配置默认沿用“当前选中 API”的连接源；若当前也是未配置，则保持空值。
    if (!connectionSourceId) {
      const preferredSourceId = (typeof apiConfigs[selectedConfigIndex]?.connectionSourceId === 'string')
        ? apiConfigs[selectedConfigIndex].connectionSourceId.trim()
        : '';
      if (preferredSourceId && getConnectionSourceById(preferredSourceId)) {
        connectionSourceId = preferredSourceId;
      }
    }

    if (connectionSourceId && !getConnectionSourceById(connectionSourceId)) {
      connectionSourceId = '';
    }

    const mergedConfig = createDefaultApiConfig(connectionSourceId, {
      id: config.id || generateUUID(),
      modelName: config.modelName || 'new-model',
      displayName: config.displayName || '新配置',
      temperature: config.temperature ?? 1,
      useStreaming: config.useStreaming !== false,
      isFavorite: !!config.isFavorite,
      enableAskOtherAiTool: !!config.enableAskOtherAiTool,
      customParams: config.customParams || '',
      customSystemPrompt: config.customSystemPrompt || '',
      userMessagePreprocessorTemplate: (typeof config.userMessagePreprocessorTemplate === 'string')
        ? config.userMessagePreprocessorTemplate
        : '',
      userMessagePreprocessorIncludeInHistory: !!config.userMessagePreprocessorIncludeInHistory,
      maxChatHistory: Number.isFinite(config.maxChatHistory) ? config.maxChatHistory : 500,
      maxChatHistoryUser: Number.isFinite(config.maxChatHistoryUser) ? config.maxChatHistoryUser : 500,
      maxChatHistoryAssistant: Number.isFinite(config.maxChatHistoryAssistant) ? config.maxChatHistoryAssistant : 500
    });
    const mergedResponsesApiSettings = normalizeResponsesApiSettings(config.responsesApiSettings);
    if (mergedResponsesApiSettings) {
      mergedConfig.responsesApiSettings = mergedResponsesApiSettings;
    }
    const mergedGeminiApiSettings = normalizeGeminiApiSettings(config.geminiApiSettings);
    if (mergedGeminiApiSettings) {
      mergedConfig.geminiApiSettings = mergedGeminiApiSettings;
    }

    const normalizedConfig = normalizeApiConfigsAfterMigration([mergedConfig], connectionSources)[0] || mergedConfig;
    apiConfigs.push(normalizedConfig);
    saveAPIConfigs();
    renderAPICards();
    renderFavoriteApis();
  }

  /**
   * 公共API接口
   */
  return {
    init: loadAPIConfigs,
    loadAPIConfigs,
    saveAPIConfigs,
    renderConnectionSources,
    renderAPICards,
    renderFavoriteApis,
    buildRequest,
    sendRequest,
    setupUIEventHandlers,
    getModelConfig,
    getApiConfigFromPartial,
    resolveApiParam,

    // 获取和设置配置
    getSelectedConfig: () => {
        const config = apiConfigs[selectedConfigIndex];
        return resolveEffectiveConfig(config) || config;
    },
    getAllConfigs: () => apiConfigs.map(config => resolveEffectiveConfig(config) || config),
    getAllConnectionSources: () => connectionSources.map(source => ({ ...source })),
    getSelectedIndex: () => selectedConfigIndex,
    setSelectedIndex: (index) => setSelectedIndexInternal(index),

    // 添加新配置
    addConfig
  };

  // 启动跨标签页变更监听（在管理器创建时即注册）
  setupStorageSyncListeners();
}
