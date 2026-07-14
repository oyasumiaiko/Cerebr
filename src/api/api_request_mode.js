/**
 * API 请求模式与“纯对话”请求边界。
 *
 * 设计目标：
 * - 模式只影响发送给上游 API 的请求，不改写任何聊天历史节点；
 * - 纯对话模式只保留 user / system / assistant 三类显式消息；
 * - 页面、环境、技能、推理重放、工具调用与工具输出等内部字段一律不进入请求；
 * - 各供应商仍可保留模型、采样、输出格式等非上下文参数。
 */

export const API_REQUEST_MODE_ENHANCED = 'enhanced';
export const API_REQUEST_MODE_PURE_CHAT = 'pure_chat';

const PURE_CHAT_MESSAGE_ROLES = new Set(['user', 'system', 'assistant']);
const PURE_CHAT_FORBIDDEN_REQUEST_FIELDS = Object.freeze([
  // OpenAI / Responses / Gemini 的工具声明与工具选择字段。
  'tools',
  'tool_choice',
  'toolChoice',
  'functions',
  'function_call',
  'functionCall',
  'parallel_tool_calls',
  'parallelToolCalls',
  'max_tool_calls',
  'maxToolCalls',
  'tool_config',
  'toolConfig',
  // 服务端会话、存储提示词与缓存内容会在显式消息之外继续补充上下文。
  'conversation',
  'previous_response_id',
  'previousResponseId',
  'prompt',
  'context_management',
  'contextManagement',
  'cachedContent',
  'cached_content'
]);
const PURE_CHAT_NESTED_CONTENT_FIELDS = Object.freeze([
  'messages',
  'input',
  'contents',
  'instructions',
  'systemInstruction',
  'system_instruction'
]);

/**
 * 把未知或旧配置值收敛为增强模式，保证升级后行为保持兼容。
 * @param {unknown} value
 * @returns {'enhanced'|'pure_chat'}
 */
export function normalizeApiRequestMode(value) {
  return value === API_REQUEST_MODE_PURE_CHAT
    ? API_REQUEST_MODE_PURE_CHAT
    : API_REQUEST_MODE_ENHANCED;
}

/**
 * 判断某个 API 配置是否启用了持久化纯对话模式。
 * @param {Object|null|undefined} config
 * @returns {boolean}
 */
export function isPureConversationApiConfig(config) {
  return normalizeApiRequestMode(config?.requestMode) === API_REQUEST_MODE_PURE_CHAT;
}

/**
 * 消息模板默认保持历史行为（启用），只有显式关闭时才停用。
 * @param {Object|null|undefined} config
 * @returns {boolean}
 */
export function isUserMessageTemplateEnabled(config) {
  return config?.userMessagePreprocessorEnabled !== false;
}

/**
 * 复制允许进入纯对话请求的消息正文。
 * system 消息只允许文本；user / assistant 允许文本和用户显式附加的图片。
 * @param {unknown} content
 * @param {'user'|'system'|'assistant'} role
 * @returns {string|Array<Object>|null}
 */
function clonePureConversationContent(content, role) {
  if (typeof content === 'string') {
    return content.trim() ? content : null;
  }
  if (!Array.isArray(content)) return null;

  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      parts.push({ type: 'text', text: part.text });
      continue;
    }
    if (role === 'system' || part.type !== 'image_url' || !part.image_url) continue;

    const rawImageUrl = part.image_url;
    if (typeof rawImageUrl === 'string' && rawImageUrl.trim()) {
      parts.push({ type: 'image_url', image_url: { url: rawImageUrl } });
      continue;
    }
    if (typeof rawImageUrl === 'object' && !Array.isArray(rawImageUrl)) {
      const url = typeof rawImageUrl.url === 'string' ? rawImageUrl.url : '';
      const path = typeof rawImageUrl.path === 'string' ? rawImageUrl.path : '';
      if (url || path) {
        parts.push({
          type: 'image_url',
          image_url: {
            ...(url ? { url } : {}),
            ...(path ? { path } : {})
          }
        });
      }
    }
  }
  return parts.length > 0 ? parts : null;
}

/**
 * 从 composer 结果生成纯对话消息副本。
 *
 * 注意：这里绝不修改传入对象，因此历史中的 contextual_input_items_before、
 * response_input_items、tool_calls 等字段仍会原样保存在本地，只是不进入本次请求。
 * @param {Array<Object>|null|undefined} messages
 * @returns {Array<{role:'user'|'system'|'assistant', content:string|Array<Object>}>}
 */
export function buildPureConversationMessages(messages) {
  const result = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const role = typeof message.role === 'string' ? message.role.trim() : '';
    if (!PURE_CHAT_MESSAGE_ROLES.has(role)) continue;
    const content = clonePureConversationContent(message.content, role);
    if (content == null) continue;
    result.push({ role, content });
  }
  return result;
}

function cloneJsonValue(value) {
  if (Array.isArray(value)) return value.map(item => cloneJsonValue(item));
  if (!value || typeof value !== 'object') return value;
  const clone = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    clone[key] = cloneJsonValue(nestedValue);
  }
  return clone;
}

function removeForbiddenRequestFields(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return;
  PURE_CHAT_FORBIDDEN_REQUEST_FIELDS.forEach((field) => {
    delete target[field];
  });
}

function removeNestedContentFields(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return;
  PURE_CHAT_NESTED_CONTENT_FIELDS.forEach((field) => {
    delete target[field];
  });
}

/**
 * 在所有配置、自定义参数与单次 overrides 合并完成后，执行最终的纯对话请求约束。
 * 这样即使用户以前在 customParams 中配置过 tools / previous_response_id，也不会绕过模式开关。
 *
 * @param {Object|null|undefined} requestBody
 * @param {Object} options
 * @param {'openai'|'openai_responses'|'gemini'} options.connectionType
 * @param {Array<Object>} [options.messages] OpenAI Chat 的规范消息
 * @param {Array<Object>} [options.input] Responses 的规范 message items
 * @param {string|null} [options.instructions] Responses 的规范用户 system instructions
 * @param {Array<Object>} [options.contents] Gemini 的规范 contents
 * @param {Object|null} [options.systemInstruction] Gemini 的用户系统指令
 * @returns {Object}
 */
export function enforcePureConversationRequestBody(requestBody, options = {}) {
  const nextBody = cloneJsonValue(requestBody && typeof requestBody === 'object' ? requestBody : {});
  removeForbiddenRequestFields(nextBody);
  // 常见代理会把原生上游字段放进 extra_body；这里同步封住工具与服务端上下文入口。
  removeForbiddenRequestFields(nextBody.extra_body);
  removeForbiddenRequestFields(nextBody.extraBody);
  removeNestedContentFields(nextBody.extra_body);
  removeNestedContentFields(nextBody.extraBody);

  const connectionType = typeof options.connectionType === 'string'
    ? options.connectionType.trim().toLowerCase()
    : 'openai';

  if (connectionType === 'openai_responses') {
    nextBody.input = cloneJsonValue(Array.isArray(options.input) ? options.input : []);
    if (typeof options.instructions === 'string' && options.instructions.trim()) {
      nextBody.instructions = options.instructions;
    } else {
      delete nextBody.instructions;
    }
    delete nextBody.messages;
    delete nextBody.contents;
    delete nextBody.systemInstruction;
    delete nextBody.system_instruction;
    return nextBody;
  }

  if (connectionType === 'gemini') {
    nextBody.contents = cloneJsonValue(Array.isArray(options.contents) ? options.contents : []);
    if (options.systemInstruction && typeof options.systemInstruction === 'object') {
      nextBody.systemInstruction = cloneJsonValue(options.systemInstruction);
    } else {
      delete nextBody.systemInstruction;
    }
    delete nextBody.system_instruction;
    delete nextBody.instructions;
    delete nextBody.input;
    delete nextBody.messages;
    return nextBody;
  }

  nextBody.messages = cloneJsonValue(Array.isArray(options.messages) ? options.messages : []);
  delete nextBody.instructions;
  delete nextBody.systemInstruction;
  delete nextBody.system_instruction;
  delete nextBody.input;
  delete nextBody.contents;
  return nextBody;
}
