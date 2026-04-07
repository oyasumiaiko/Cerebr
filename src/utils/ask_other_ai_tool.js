/**
 * “向其他 AI 提问”工具的纯函数辅助模块。
 *
 * 设计目标：
 * - 把“哪些 API 配置允许暴露给 ask 工具”与 sender 执行链路解耦；
 * - 把参数校验做成纯函数，便于单元测试；
 * - 让工具描述、目录结果、请求归一化都能稳定复用，而不是散落在 sender 大文件里。
 */

function normalizeString(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

function normalizeBoolean(value) {
  return value === true;
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
  const context = normalizeNullableString(item.context);
  if (!configId) {
    throw new Error('ask_other_ai 参数错误：每条 request 都必须提供非空 config_id。');
  }
  if (!question) {
    throw new Error('ask_other_ai 参数错误：每条 request 都必须提供非空 question。');
  }
  return {
    config_id: configId,
    question,
    context
  };
}

export function buildAskOtherAiToolGuidance() {
  return [
    '先调用 list_askable_models 查看当前可用目标，并从结果里复制 config_id。',
    'ask_other_ai 支持一次提交多条 requests；每条 request 都可以指定不同的 config_id。',
    '目标模型只会看到你显式提供的 question 与 context，不会自动继承当前对话、隐藏上下文、本地工具结果或页面状态。',
    '它适合获取第二意见、交叉验证分析、比较不同模型视角；不适合代替当前模型继续执行本地工具链。'
  ].join('\n');
}

export function buildAskOtherAiCatalog(configs, options = {}) {
  const source = Array.isArray(configs) ? configs : [];
  void options;

  const models = source
    .map((config, index) => {
      if (!config || typeof config !== 'object') return null;
      const configId = normalizeString(config.id);
      const modelName = normalizeString(config.modelName);
      const displayName = normalizeString(config.displayName);
      const baseUrl = normalizeString(config.baseUrl);
      const connectionType = normalizeNullableString(config.connectionType);
      const connectionSourceName = normalizeNullableString(config.connectionSourceName);
      const enabled = normalizeBoolean(config.enableAskOtherAiTool);
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

export function buildAskOtherAiUserMessage(question, context = null) {
  const normalizedQuestion = normalizeString(question);
  const normalizedContext = normalizeNullableString(context);
  if (!normalizedQuestion) {
    throw new Error('ask_other_ai 生成提问消息失败：question 不能为空。');
  }

  const blocks = [];
  if (normalizedContext) {
    blocks.push(`<context>\n${normalizedContext}\n</context>`);
  }
  blocks.push(`<question>\n${normalizedQuestion}\n</question>`);
  blocks.push('请直接给出你的独立分析与判断。若信息不足，请明确说明缺口，不要假装看到了未提供的上下文。');
  return blocks.join('\n\n');
}
