/**
 * “向其他 AI 提问”工具的纯函数辅助模块。
 *
 * 设计目标：
 * - 把“哪些 API 配置允许暴露给 ask 工具”与 sender 执行链路解耦；
 * - 把参数校验做成纯函数，便于单元测试；
 * - 把工具描述、使用边界、请求文本模板集中收口，避免继续散落在 sender 大文件里；
 * - 参考 Codex Rust 工具注释里对 `spawn_agent` 的写法，把“什么时候该用 / 不该用”直接写进工具描述，
 *   避免 ask_other_ai 退化成一个只会“多问几个模型”的空壳。
 */

export const LIST_ASKABLE_MODELS_TOOL_NAME = 'list_askable_models';
export const ASK_OTHER_AI_TOOL_NAME = 'ask_other_ai';

function normalizeString(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

function normalizeBoolean(value) {
  return value === true;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const next = [];
  value.forEach((item) => {
    const text = normalizeString(item);
    if (!text || seen.has(text)) return;
    seen.add(text);
    next.push(text);
  });
  return next;
}

function normalizeNullableString(value) {
  const text = normalizeString(value);
  return text || null;
}

function normalizeAskRequest(rawItem) {
  const item = (rawItem && typeof rawItem === 'object' && !Array.isArray(rawItem))
    ? rawItem
    : {};
  const configId = normalizeString(item.config_id);
  const question = normalizeString(item.question);
  if (!configId) {
    throw new Error('ask_other_ai 参数错误：每条 request 都必须提供非空 config_id。');
  }
  if (!question) {
    throw new Error('ask_other_ai 参数错误：每条 request 都必须提供非空 question。');
  }
  return {
    config_id: configId,
    question
  };
}

export function buildAskOtherAiToolGuidance() {
  return [
    '先调用 list_askable_models 查看当前可用目标，并从结果里复制 config_id。',
    'ask_other_ai 支持一次提交多条 requests；每条 request 都可以指定不同的 config_id。',
    '目标模型只会看到你显式提供的 question，不会自动继承当前对话、隐藏上下文、本地工具结果或页面状态。',
    '它适合获取第二意见、交叉验证分析、比较不同模型视角；不适合代替当前模型继续执行本地工具链。'
  ].join('\n');
}

export function buildListAskableModelsToolDescription() {
  return [
    '列出当前可通过 ask_other_ai 访问的目标模型配置。',
    '结果会返回每个目标的 config_id、显示名、模型名与连接信息，并附带使用须知。',
    '若后续要发起提问，请先调用这把工具，再把返回的 config_id 用于 ask_other_ai。'
  ].join(' ');
}

export function buildAskOtherAiToolDescription() {
  return [
    '向一个或多个已启用的其他模型配置提问，以获取独立观点、复核分析或比较不同模型结论。',
    '每条 request 都需要显式给出 config_id 与 question；同一次调用里可以向相同或不同模型发送多条问题。',
    '目标模型只会看到你提供的 question，不会自动继承当前对话、隐藏上下文、本地工具结果或页面状态。',
    '',
    '### 何时使用',
    '- 当你需要独立第二意见、交叉验证、对比不同模型结论时使用。',
    '- 优先把问题压成具体、边界清晰、可独立回答的子问题。',
    '',
    '### 不该怎么用',
    '- 不要把 ask_other_ai 当成隐式继承当前上下文的续写器；若问题不完整，应先在当前线程里整理后再提问。'
  ].join('\n');
}

export function buildListAskableModelsFunctionToolDefinition() {
  return {
    type: 'function',
    name: LIST_ASKABLE_MODELS_TOOL_NAME,
    description: buildListAskableModelsToolDescription(),
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: []
    }
  };
}

export function buildAskOtherAiFunctionToolDefinition() {
  const requestItemProperties = {
    config_id: {
      type: 'string',
      description: '必填。目标模型配置的 config_id，请先通过 list_askable_models 获取。'
    },
    question: {
      type: 'string',
      description: '必填。要向该目标模型提问的具体问题。'
    }
  };

  return {
    type: 'function',
    name: ASK_OTHER_AI_TOOL_NAME,
    description: buildAskOtherAiToolDescription(),
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        requests: {
          type: 'array',
          description: '必填。要执行的一组提问请求；每条 request 都是一次独立提问。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: requestItemProperties,
            required: Object.keys(requestItemProperties)
          }
        }
      },
      required: ['requests']
    }
  };
}

export function buildAskOtherAiCatalog(configs, options = {}) {
  const source = Array.isArray(configs) ? configs : [];
  const enabledConfigIdSet = new Set(normalizeStringArray(options?.enabledConfigIds));

  const models = source
    .map((config, index) => {
      if (!config || typeof config !== 'object') return null;
      const configId = normalizeString(config.id);
      const modelName = normalizeString(config.modelName);
      const displayName = normalizeString(config.displayName);
      const baseUrl = normalizeString(config.baseUrl);
      const connectionType = normalizeNullableString(config.connectionType);
      const connectionSourceName = normalizeNullableString(config.connectionSourceName);
      const enabled = enabledConfigIdSet.has(configId);
      if (!enabled || !configId || !modelName || !baseUrl) return null;

      return {
        rank: index + 1,
        config_id: configId,
        display_name: displayName || modelName,
        model_name: modelName,
        connection_type: connectionType,
        connection_source_name: connectionSourceName,
        base_url: baseUrl,
        is_favorite: normalizeBoolean(config.isFavorite),
        has_custom_system_prompt: normalizeString(config.customSystemPrompt).length > 0
      };
    })
    .filter(Boolean);

  return {
    ok: true,
    total_models: models.length,
    guidance: buildAskOtherAiToolGuidance(),
    models
  };
}

export function normalizeAskOtherAiArguments(rawArgs) {
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs))
    ? rawArgs
    : {};
  const requests = Array.isArray(args.requests)
    ? args.requests.map((item) => normalizeAskRequest(item))
    : [];

  if (requests.length <= 0) {
    throw new Error('ask_other_ai 参数错误：requests 至少需要 1 条。');
  }

  return { requests };
}

export function buildAskOtherAiUserMessage(question) {
  const normalizedQuestion = normalizeString(question);
  if (!normalizedQuestion) {
    throw new Error('ask_other_ai 生成提问消息失败：question 不能为空。');
  }

  const blocks = [
    '你正在提供一次独立的第二意见。',
    '请仅基于下面显式提供的问题作答。'
  ];
  blocks.push(`Question:\n${normalizedQuestion}`);
  blocks.push('请直接给出你的独立分析与判断。若信息不足，请明确说明缺口。');
  return blocks.join('\n\n');
}
