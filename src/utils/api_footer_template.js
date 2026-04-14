/**
 * AI 消息 footer 模板工具：
 * - 统一解析可展示的 API 元数据；
 * - 提供模板渲染（支持 {{var}} 与 {{#var}}...{{/var}}）；
 * - 输出 footer 文本与 tooltip 标题，避免多处重复实现。
 */

export const DEFAULT_AI_FOOTER_TEMPLATE = '{{display_label}}';
export const DEFAULT_AI_FOOTER_TOOLTIP_TEMPLATE = '{{tooltip_api_line}}\n{{tooltip_signature_line}}\n{{tooltip_usage_lines}}{{#tooltip_usage_detail_lines}}\n{{tooltip_usage_detail_lines}}{{/tooltip_usage_detail_lines}}{{#tooltip_timing_lines}}\n{{tooltip_timing_lines}}{{/tooltip_timing_lines}}';
export const DEFAULT_AI_FOOTER_INLINE_SEPARATOR = ' · ';

// AI footer 可配置模板变量（去重后的“主变量”清单，供设置界面展示/复制）。
export const AI_FOOTER_TEMPLATE_VARIABLES = Object.freeze([
  { key: 'display_label', group: '常用', description: '默认显示文案（含 signatured 前缀）' },
  { key: 'display_with_total_tokens_k', group: '常用', description: '默认文案 + 总 tokens（k/m/b）' },
  { key: 'display_with_usage_k', group: '常用', description: '默认文案 + in/out/total（k/m/b）' },
  { key: 'apiname', group: '模型信息', description: 'API 显示名（displayName 优先，回退 model）' },
  { key: 'display_name', group: '模型信息', description: '配置中的 displayName（或历史快照）' },
  { key: 'model', group: '模型信息', description: '模型名（modelName / apiModelId）' },
  { key: 'api_uuid', group: '模型信息', description: 'API 配置 id' },
  { key: 'signature', group: '模型信息', description: '有推理签名时为 signatured，否则为空' },
  { key: 'signature_prefix', group: '模型信息', description: '有签名时为 signatured · ' },
  { key: 'signature_source', group: '模型信息', description: '签名来源（gemini/openai）' },
  { key: 'input_tokens', group: 'Tokens', description: '输入 tokens（原始数值）' },
  { key: 'output_tokens', group: 'Tokens', description: '输出 tokens（原始数值）' },
  { key: 'total_tokens', group: 'Tokens', description: '总 tokens（原始数值）' },
  { key: 'input_tokens_k', group: 'Tokens', description: '输入 tokens（k/m/b）' },
  { key: 'output_tokens_k', group: 'Tokens', description: '输出 tokens（k/m/b）' },
  { key: 'total_tokens_k', group: 'Tokens', description: '总 tokens（k/m/b）' },
  { key: 'usage_line', group: 'Tokens', description: 'in/out/total 汇总（千分位）' },
  { key: 'usage_line_k', group: 'Tokens', description: 'in/out/total 汇总（k/m/b）' },
  { key: 'cached_input_tokens', group: 'Tokens', description: '缓存命中的输入 tokens（原始数值）' },
  { key: 'cached_input_tokens_k', group: 'Tokens', description: '缓存命中的输入 tokens（k/m/b）' },
  { key: 'reasoning_tokens', group: 'Tokens', description: '推理/思考输出 tokens（原始数值）' },
  { key: 'reasoning_tokens_k', group: 'Tokens', description: '推理/思考输出 tokens（k/m/b）' },
  { key: 'tooltip_api_line', group: 'Tooltip 快捷行', description: 'API uuid/displayName/model 的整行文案' },
  { key: 'tooltip_signature_line', group: 'Tooltip 快捷行', description: '有签名时输出 thought_signature: stored' },
  { key: 'tooltip_usage_lines', group: 'Tooltip 快捷行', description: '按可用项拼接的 token 多行（prompt/completion/total）' },
  { key: 'tooltip_usage_detail_lines', group: 'Tooltip 快捷行', description: '按可用项拼接的缓存/推理 token 多行' },
  { key: 'tooltip_prompt_tokens_line', group: 'Tooltip 快捷行', description: 'prompt_tokens 行（无值为空）' },
  { key: 'tooltip_completion_tokens_line', group: 'Tooltip 快捷行', description: 'completion_tokens 行（无值为空）' },
  { key: 'tooltip_total_tokens_line', group: 'Tooltip 快捷行', description: 'total_tokens 行（无值为空）' },
  { key: 'tooltip_cached_input_tokens_line', group: 'Tooltip 快捷行', description: 'cached_input_tokens 行（无值为空）' },
  { key: 'tooltip_reasoning_tokens_line', group: 'Tooltip 快捷行', description: 'reasoning_tokens 行（无值为空）' },
  { key: 'generation_duration_ms', group: '时长', description: '本次回复总耗时（毫秒）' },
  { key: 'generation_duration', group: '时长', description: '本次回复总耗时（格式化）' },
  { key: 'thinking_duration_ms', group: '时长', description: '思考/工具阶段耗时（毫秒）' },
  { key: 'thinking_duration', group: '时长', description: '思考/工具阶段耗时（格式化）' },
  { key: 'output_duration_ms', group: '时长', description: '开始输出可见正文后的耗时（毫秒）' },
  { key: 'output_duration', group: '时长', description: '开始输出可见正文后的耗时（格式化）' },
  { key: 'tooltip_generation_duration_line', group: 'Tooltip 快捷行', description: 'generation_duration 行（无值为空）' },
  { key: 'tooltip_thinking_duration_line', group: 'Tooltip 快捷行', description: 'thinking_duration 行（无值为空）' },
  { key: 'tooltip_output_duration_line', group: 'Tooltip 快捷行', description: 'output_duration 行（无值为空）' },
  { key: 'tooltip_timing_lines', group: 'Tooltip 快捷行', description: '按可用项拼接的时长多行' },
  { key: 'timestamp', group: '时间', description: '消息时间戳（毫秒）' },
  { key: 'time', group: '时间', description: '时间（HH:mm）' },
  { key: 'date', group: '时间', description: '智能日期（非本日显示 M/D，非本年显示 YYYY/M/D）' },
  { key: 'datetime', group: '时间', description: '智能日期 + 时间（date + HH:mm）' },
  { key: 'datetime_full', group: '时间', description: '完整日期时间（YYYY/MM/DD HH:mm:ss）' }
]);

function toTrimmedText(value) {
  if (value == null) return '';
  return String(value).trim();
}

function normalizeTimestampMs(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

function normalizeTokenValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed);
}

function formatTokenWithThousands(value) {
  const normalized = normalizeTokenValue(value);
  if (normalized == null) return '';
  return normalized.toLocaleString();
}

function formatTokenCompact(value) {
  const normalized = normalizeTokenValue(value);
  if (normalized == null) return '';
  if (normalized < 1000) return String(normalized);
  const units = [
    { base: 1e9, suffix: 'b' },
    { base: 1e6, suffix: 'm' },
    { base: 1e3, suffix: 'k' }
  ];
  const unit = units.find(item => normalized >= item.base) || units[units.length - 1];
  const scaled = normalized / unit.base;
  const digits = scaled >= 100 ? 0 : (scaled >= 10 ? 1 : 2);
  const text = scaled
    .toFixed(digits)
    .replace(/(\.\d*?)0+$/g, '$1')
    .replace(/\.$/g, '');
  return `${text}${unit.suffix}`;
}

function formatDurationCompact(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return '';
  const ms = Math.max(0, Math.round(numeric));
  if (ms < 1000) return `${ms}毫秒`;
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds >= 10 ? 1 : 2).replace(/(\.\d*?)0+$/g, '$1').replace(/\.$/g, '')}秒`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds - (minutes * 60);
  if (minutes < 60) {
    const remainText = remainSeconds > 0
      ? remainSeconds.toFixed(remainSeconds >= 10 ? 0 : 1).replace(/(\.\d*?)0+$/g, '$1').replace(/\.$/g, '')
      : '0';
    return `${minutes}分${remainText}秒`;
  }
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return `${hours}时${remainMinutes}分`;
}

function buildUsageLine(usage, formatter) {
  if (!usage || typeof usage !== 'object') return '';
  const format = (typeof formatter === 'function') ? formatter : (value => String(value ?? ''));
  const parts = [];
  if (usage.promptTokens != null) parts.push(`in ${format(usage.promptTokens)}`);
  if (usage.completionTokens != null) parts.push(`out ${format(usage.completionTokens)}`);
  if (usage.totalTokens != null) parts.push(`total ${format(usage.totalTokens)}`);
  return parts.join(' · ');
}

// 日期展示策略：
// - 今天：不显示日期（返回空字符串）；
// - 同一年但非今天：显示 M/D；
// - 非本年：显示 YYYY/M/D。
function formatSmartDateLabel(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const sameMonth = date.getMonth() === now.getMonth();
  const sameDay = date.getDate() === now.getDate();
  if (sameYear && sameMonth && sameDay) return '';
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (sameYear) return `${month}/${day}`;
  return `${date.getFullYear()}/${month}/${day}`;
}

function formatTimeHhMm(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatFullDateTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
}

function hasTemplateValue(value) {
  if (value == null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value);
  return toTrimmedText(value).length > 0;
}

function applyConditionalSections(template, context) {
  let rendered = String(template ?? '');
  const sectionPattern = /{{#\s*([a-zA-Z0-9_]+)\s*}}([\s\S]*?){{\/\s*\1\s*}}/g;
  // 简单多轮替换，支持常见的浅层嵌套条件块。
  for (let i = 0; i < 8; i += 1) {
    let changed = false;
    rendered = rendered.replace(sectionPattern, (_, key, inner) => {
      changed = true;
      return hasTemplateValue(context[key]) ? inner : '';
    });
    if (!changed) break;
  }
  return rendered;
}

function normalizeFooterText(value) {
  // 保留模板中的换行：允许用户在 footer 模板中手动拆成两行显示。
  const lines = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]{2,}/g, ' ').trim())
    .filter(line => line.length > 0);
  return lines.join('\n');
}

function renderFooterTemplateSegment(template, context = {}) {
  const withSections = applyConditionalSections(template, context);
  const rendered = withSections.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => {
    const value = context[key];
    return value == null ? '' : String(value);
  });
  return normalizeFooterText(rendered);
}

function renderFooterTemplateLineWithSeparator(line, context = {}, separator = '') {
  const safeSeparator = String(separator ?? '');
  if (!safeSeparator) {
    return renderFooterTemplateSegment(line, context);
  }
  const parts = String(line ?? '')
    .split(safeSeparator)
    .map((segment) => renderFooterTemplateSegment(segment, context))
    .filter((segment) => toTrimmedText(segment).length > 0);
  return parts.join(safeSeparator);
}

function resolveMatchedConfig(nodeLike, allConfigs) {
  if (!nodeLike || !Array.isArray(allConfigs) || allConfigs.length === 0) return null;
  const targetUuid = toTrimmedText(nodeLike.apiUuid);
  if (!targetUuid) return null;
  return allConfigs.find(config => config?.id === targetUuid) || null;
}

/**
 * 统一归一化 usage 字段，兼容 promptTokens / prompt_tokens 两种命名。
 * @param {any} rawUsage
 * @returns {{promptTokens:number|null,completionTokens:number|null,totalTokens:number|null}|null}
 */
export function normalizeApiUsageMeta(rawUsage) {
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  const promptTokens = normalizeTokenValue(
    rawUsage.prompt_tokens
      ?? rawUsage.promptTokens
      ?? rawUsage.input_tokens
      ?? rawUsage.inputTokens
  );
  const completionTokens = normalizeTokenValue(
    rawUsage.completion_tokens
      ?? rawUsage.completionTokens
      ?? rawUsage.output_tokens
      ?? rawUsage.outputTokens
  );
  const totalTokens = normalizeTokenValue(rawUsage.total_tokens ?? rawUsage.totalTokens);
  const cachedInputTokens = normalizeTokenValue(
    rawUsage.cached_input_tokens
      ?? rawUsage.cachedInputTokens
      ?? rawUsage.input_tokens_details?.cached_tokens
      ?? rawUsage.inputTokensDetails?.cachedTokens
  );
  const reasoningTokens = normalizeTokenValue(
    rawUsage.reasoning_tokens
      ?? rawUsage.reasoningTokens
      ?? rawUsage.output_tokens_details?.reasoning_tokens
      ?? rawUsage.outputTokensDetails?.reasoningTokens
  );
  if (
    promptTokens == null
    && completionTokens == null
    && totalTokens == null
    && cachedInputTokens == null
    && reasoningTokens == null
  ) return null;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedInputTokens,
    reasoningTokens
  };
}

/**
 * 统一归一化响应时序元信息。
 * @param {any} rawTiming
 * @returns {{startedAtMs:number|null,firstVisibleOutputAtMs:number|null,completedAtMs:number|null,generationDurationMs:number|null,thinkingDurationMs:number|null,outputDurationMs:number|null}|null}
 */
export function normalizeApiTimingMeta(rawTiming) {
  if (!rawTiming || typeof rawTiming !== 'object') return null;
  const startedAtMs = normalizeTimestampMs(rawTiming.started_at_ms ?? rawTiming.startedAtMs);
  const firstVisibleOutputAtMs = normalizeTimestampMs(rawTiming.first_visible_output_at_ms ?? rawTiming.firstVisibleOutputAtMs);
  const completedAtMs = normalizeTimestampMs(rawTiming.completed_at_ms ?? rawTiming.completedAtMs);
  const generationDurationMs = normalizeTokenValue(rawTiming.generation_duration_ms ?? rawTiming.generationDurationMs);
  const thinkingDurationMs = normalizeTokenValue(rawTiming.thinking_duration_ms ?? rawTiming.thinkingDurationMs);
  const outputDurationMs = normalizeTokenValue(rawTiming.output_duration_ms ?? rawTiming.outputDurationMs);
  if (
    startedAtMs == null
    && firstVisibleOutputAtMs == null
    && completedAtMs == null
    && generationDurationMs == null
    && thinkingDurationMs == null
    && outputDurationMs == null
  ) {
    return null;
  }
  return {
    startedAtMs,
    firstVisibleOutputAtMs,
    completedAtMs,
    generationDurationMs,
    thinkingDurationMs,
    outputDurationMs
  };
}

/**
 * 生成 footer 模板可用上下文。
 * @param {any} nodeLike - 历史节点或等价对象
 * @param {any|null} matchedConfig - 按 apiUuid 匹配到的当前配置快照
 */
export function buildApiFooterContext(nodeLike, matchedConfig = null) {
  const displayName = toTrimmedText(matchedConfig?.displayName) || toTrimmedText(nodeLike?.apiDisplayName);
  const modelName = toTrimmedText(matchedConfig?.modelName) || toTrimmedText(nodeLike?.apiModelId);
  const apiName = displayName || modelName;
  const apiUuid = toTrimmedText(nodeLike?.apiUuid);
  const hasThoughtSignature = !!nodeLike?.thoughtSignature;
  const usage = normalizeApiUsageMeta(nodeLike?.apiUsage);
  const timing = normalizeApiTimingMeta(nodeLike?.responseTiming);
  const timestampMs = normalizeTimestampMs(nodeLike?.timestamp);
  const date = (timestampMs != null) ? new Date(timestampMs) : null;
  const promptTokens = usage?.promptTokens ?? '';
  const completionTokens = usage?.completionTokens ?? '';
  const totalTokens = usage?.totalTokens ?? '';
  const cachedInputTokens = usage?.cachedInputTokens ?? '';
  const reasoningTokens = usage?.reasoningTokens ?? '';
  const promptTokensK = formatTokenCompact(usage?.promptTokens);
  const completionTokensK = formatTokenCompact(usage?.completionTokens);
  const totalTokensK = formatTokenCompact(usage?.totalTokens);
  const cachedInputTokensK = formatTokenCompact(usage?.cachedInputTokens);
  const reasoningTokensK = formatTokenCompact(usage?.reasoningTokens);
  const usageLine = buildUsageLine(usage, value => formatTokenWithThousands(value));
  const usageLineK = buildUsageLine(usage, value => formatTokenCompact(value));
  const thinkingDurationMs = normalizeTokenValue(timing?.thinkingDurationMs ?? nodeLike?.response_activity_duration_ms);
  const outputDurationMs = normalizeTokenValue(timing?.outputDurationMs);
  const generationDurationMs = normalizeTokenValue(timing?.generationDurationMs);
  const thinkingDuration = formatDurationCompact(thinkingDurationMs);
  const outputDuration = formatDurationCompact(outputDurationMs);
  const generationDuration = formatDurationCompact(generationDurationMs);
  const timeLabel = formatTimeHhMm(date);
  const dateLabel = formatSmartDateLabel(date);
  const dateTimeLabel = dateLabel ? `${dateLabel} ${timeLabel}`.trim() : timeLabel;
  const fullDateTimeLabel = formatFullDateTime(date);
  const tooltipApiLine = `API uuid: ${apiUuid || '-'} | displayName: ${displayName || '-'} | model: ${modelName || '-'}`;
  const tooltipSignatureLine = hasThoughtSignature ? 'thought_signature: stored' : '';
  const tooltipPromptTokensLine = (usage?.promptTokens != null) ? `prompt_tokens: ${usage.promptTokens}` : '';
  const tooltipCompletionTokensLine = (usage?.completionTokens != null) ? `completion_tokens: ${usage.completionTokens}` : '';
  const tooltipTotalTokensLine = (usage?.totalTokens != null) ? `total_tokens: ${usage.totalTokens}` : '';
  const tooltipCachedInputTokensLine = (usage?.cachedInputTokens != null) ? `cached_input_tokens: ${usage.cachedInputTokens}` : '';
  const tooltipReasoningTokensLine = (usage?.reasoningTokens != null) ? `reasoning_tokens: ${usage.reasoningTokens}` : '';
  const tooltipUsageLines = [
    tooltipPromptTokensLine,
    tooltipCompletionTokensLine,
    tooltipTotalTokensLine
  ].filter(Boolean).join('\n');
  const tooltipUsageDetailLines = [
    tooltipCachedInputTokensLine,
    tooltipReasoningTokensLine
  ].filter(Boolean).join('\n');
  const tooltipGenerationDurationLine = generationDuration ? `generation_duration: ${generationDuration}` : '';
  const tooltipThinkingDurationLine = thinkingDuration ? `thinking_duration: ${thinkingDuration}` : '';
  const tooltipOutputDurationLine = outputDuration ? `output_duration: ${outputDuration}` : '';
  const tooltipTimingLines = [
    tooltipGenerationDurationLine,
    tooltipThinkingDurationLine,
    tooltipOutputDurationLine
  ].filter(Boolean).join('\n');

  const displayLabel = hasThoughtSignature
    ? (apiName ? `signatured · ${apiName}` : 'signatured')
    : apiName;
  const displayWithTotalTokensK = displayLabel
    ? (totalTokensK ? `${displayLabel} · ${totalTokensK} tok` : displayLabel)
    : (totalTokensK ? `${totalTokensK} tok` : '');
  const displayWithUsageK = displayLabel
    ? (usageLineK ? `${displayLabel} · ${usageLineK}` : displayLabel)
    : usageLineK;

  return {
    display_label: displayLabel || '',
    display_with_total_tokens_k: displayWithTotalTokensK,
    display_with_usage_k: displayWithUsageK,
    apiname: apiName || '',
    api_uuid: apiUuid,
    display_name: displayName || '',
    model: modelName || '',
    signature: hasThoughtSignature ? 'signatured' : '',
    signature_prefix: hasThoughtSignature ? 'signatured · ' : '',
    signature_source: toTrimmedText(nodeLike?.thoughtSignatureSource),
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    total_tokens: totalTokens,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    input_tokens_k: promptTokensK,
    output_tokens_k: completionTokensK,
    total_tokens_k: totalTokensK,
    cached_input_tokens: cachedInputTokens,
    cached_input_tokens_k: cachedInputTokensK,
    reasoning_tokens: reasoningTokens,
    reasoning_tokens_k: reasoningTokensK,
    prompt_tokens_k: promptTokensK,
    completion_tokens_k: completionTokensK,
    usage_line: usageLine,
    usage_line_k: usageLineK,
    tooltip_api_line: tooltipApiLine,
    tooltip_signature_line: tooltipSignatureLine,
    tooltip_usage_lines: tooltipUsageLines,
    tooltip_usage_detail_lines: tooltipUsageDetailLines,
    tooltip_prompt_tokens_line: tooltipPromptTokensLine,
    tooltip_completion_tokens_line: tooltipCompletionTokensLine,
    tooltip_total_tokens_line: tooltipTotalTokensLine,
    tooltip_cached_input_tokens_line: tooltipCachedInputTokensLine,
    tooltip_reasoning_tokens_line: tooltipReasoningTokensLine,
    generation_duration_ms: generationDurationMs ?? '',
    generation_duration: generationDuration,
    thinking_duration_ms: thinkingDurationMs ?? '',
    thinking_duration: thinkingDuration,
    output_duration_ms: outputDurationMs ?? '',
    output_duration: outputDuration,
    tooltip_generation_duration_line: tooltipGenerationDurationLine,
    tooltip_thinking_duration_line: tooltipThinkingDurationLine,
    tooltip_output_duration_line: tooltipOutputDurationLine,
    tooltip_timing_lines: tooltipTimingLines,
    timestamp: timestampMs != null ? String(timestampMs) : '',
    time: timeLabel,
    date: dateLabel,
    datetime: dateTimeLabel,
    datetime_full: fullDateTimeLabel
  };
}

/**
 * 渲染 footer 模板。
 * 支持：
 * - 变量：{{apiname}}
 * - 条件块：{{#total_tokens}}总: {{total_tokens}}{{/total_tokens}}
 */
export function renderApiFooterTemplate(template, context = {}, options = {}) {
  const source = (typeof template === 'string') ? template : DEFAULT_AI_FOOTER_TEMPLATE;
  const inlineSeparator = (typeof options.inlineSeparator === 'string')
    ? options.inlineSeparator
    : '';
  if (!inlineSeparator) {
    return renderFooterTemplateSegment(source, context);
  }
  const renderedLines = String(source ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => renderFooterTemplateLineWithSeparator(line, context, inlineSeparator));
  return normalizeFooterText(renderedLines.join('\n'));
}

/**
 * 生成 footer tooltip（标题）文本。
 */
export function buildApiFooterTitle(context, template) {
  const sourceTemplate = (typeof template === 'string' && template.trim())
    ? template
    : DEFAULT_AI_FOOTER_TOOLTIP_TEMPLATE;
  return renderApiFooterTemplate(sourceTemplate, context);
}

/**
 * 一次性输出 footer 渲染结果，供 UI 层直接消费。
 */
export function buildApiFooterRenderData(nodeLike, options = {}) {
  const allConfigs = Array.isArray(options.allConfigs) ? options.allConfigs : [];
  const matchedConfig = resolveMatchedConfig(nodeLike, allConfigs);
  const context = buildApiFooterContext(nodeLike, matchedConfig);
  const text = renderApiFooterTemplate(options.template, context, {
    inlineSeparator: (typeof options.inlineSeparator === 'string')
      ? options.inlineSeparator
      : DEFAULT_AI_FOOTER_INLINE_SEPARATOR
  });
  const title = buildApiFooterTitle(context, options.tooltipTemplate);
  return {
    text,
    title,
    context,
    matchedConfig
  };
}
