/**
 * 模型工具契约的统一构造器。
 *
 * 这个模块只负责模型可见协议，不参与任何工具执行：
 * - description 固定按“用途 / 适用 / 不要用于 / 输入 / 返回 / 注意”组织，
 *   让模型在 deferred tool 被加载后也能独立判断何时调用、怎样调用以及如何解释结果；
 * - function tool 默认使用 Responses API strict schema，所有对象都关闭
 *   additionalProperties，并把可选值显式表示为 nullable 字段；
 * - 对外发送的 schema 使用标准模型与 fine-tuned 模型都支持的可移植子集，
 *   数值范围、字符串 pattern 和数组长度等业务约束继续由 description 与 normalize 层负责；
 * - schema 的业务条件仍由各工具自己的 normalize/execute 层校验，避免把复杂的
 *   条件分支塞进模型不一定稳定支持的 JSON Schema 组合关键字。
 */

const RESPONSES_TOOL_OUTPUT_MAX_CHARS_PARAMETER = 'max_output_chars';
const RESPONSES_TOOL_OUTPUT_DEFAULT_MAX_CHARS = 10_000;
const RESPONSES_CONTENT_READ_TOOL_OUTPUT_DEFAULT_MAX_CHARS = 50_000;
const RESPONSES_CONTENT_READ_TOOL_NAMES = new Set([
  'page_content_read',
  'pdf_content_read'
]);

const RESPONSES_TOOL_OUTPUT_MAX_CHARS_PROPERTY = Object.freeze({
  type: ['integer', 'null'],
  description: `本次调用最终返回给模型的文本字符上限。传正整数时使用该值；传 null 时普通工具默认 ${RESPONSES_TOOL_OUTPUT_DEFAULT_MAX_CHARS}，page_content_read 与 pdf_content_read 默认 ${RESPONSES_CONTENT_READ_TOOL_OUTPUT_DEFAULT_MAX_CHARS}。工具自身的分页或读取范围参数仍独立生效，图片不计入。`
});

const PORTABLE_STRICT_SCHEMA_OMITTED_KEYWORDS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'pattern'
]);

function normalizeContractText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeContractItems(value) {
  const source = Array.isArray(value) ? value : [value];
  return source
    .map(item => normalizeContractText(item))
    .filter(Boolean);
}

function buildDescriptionSection(label, value) {
  const items = normalizeContractItems(value);
  if (items.length <= 0) return '';
  return `${label}：${items.join('；')}`;
}

/**
 * 把工具参数 schema 收敛到 OpenAI 标准模型与 fine-tuned 模型共同支持的 strict 子集。
 *
 * 这些关键字在普通 Structured Outputs 中可用，但 fine-tuned 模型不支持；如果仍与
 * `strict: true` 一起发送，整个请求会在模型开始生成前被拒绝。保留原 builder 中的
 * 边界声明有助于维护者就近理解约束，而这里在最终出口统一剥离，避免各工具重复分叉。
 * 执行器仍必须做完整校验，description 也必须把真实范围明确告诉模型。
 *
 * @param {any} value
 * @param {{preservePropertyNames?:boolean}} [options]
 * @returns {any}
 */
function buildPortableStrictSchemaValue(value, options = {}) {
  if (Array.isArray(value)) {
    return value.map(item => buildPortableStrictSchemaValue(item));
  }
  if (!value || typeof value !== 'object') return value;

  const normalized = {};
  for (const [key, item] of Object.entries(value)) {
    // `pattern` 既可能是 JSON Schema 关键字，也可能是 search_files 的合法参数名。
    // properties map 中的 key 是字段名，不能按 schema keyword 误删。
    if (options?.preservePropertyNames !== true && PORTABLE_STRICT_SCHEMA_OMITTED_KEYWORDS.has(key)) continue;
    normalized[key] = buildPortableStrictSchemaValue(item, {
      preservePropertyNames: key === 'properties'
    });
  }
  return normalized;
}

/**
 * 生成统一、可扫描的模型工具说明。
 *
 * 每一段都使用稳定中文标签，而不是依赖 Markdown 标题层级。这样既能减少 token，
 * 也能让不同模型在工具搜索、普通 function calling 与回放上下文里得到一致提示。
 *
 * @param {{
 *   purpose:string,
 *   useWhen?:string|string[],
 *   avoidWhen?:string|string[],
 *   input?:string|string[],
 *   output:string|string[],
 *   notes?:string|string[]
 * }} contract
 * @returns {string}
 */
export function buildModelToolDescription(contract = {}) {
  const sections = [
    buildDescriptionSection('用途', contract.purpose),
    buildDescriptionSection('适用', contract.useWhen),
    buildDescriptionSection('不要用于', contract.avoidWhen),
    buildDescriptionSection('输入', contract.input),
    buildDescriptionSection('返回', contract.output),
    buildDescriptionSection('注意', contract.notes)
  ].filter(Boolean);

  if (sections.length <= 0) {
    throw new Error('模型工具契约错误：description 至少需要提供 purpose 或 output。');
  }
  return sections.join('\n');
}

/**
 * 构造符合 Responses API strict mode 的对象 schema。
 *
 * strict mode 要求对象关闭 additionalProperties，且 properties 中出现的字段全部
 * 写入 required。业务上的“可选”通过字段 type 包含 null 表达，而不是从 required
 * 中删掉。这个约定能显著减少模型漏字段、拼错字段和服务端静默降级到非严格模式。
 *
 * @param {Record<string, Object>} properties
 * @param {{description?:string, nullable?:boolean}} [options]
 * @returns {Object}
 */
export function buildStrictObjectSchema(properties = {}, options = {}) {
  const sourceProperties = (
    properties
    && typeof properties === 'object'
    && !Array.isArray(properties)
  ) ? properties : {};
  const normalizedProperties = buildPortableStrictSchemaValue(sourceProperties, {
    preservePropertyNames: true
  });
  const schema = {
    type: options?.nullable === true ? ['object', 'null'] : 'object',
    additionalProperties: false,
    properties: normalizedProperties,
    required: Object.keys(normalizedProperties)
  };
  const description = normalizeContractText(options?.description);
  if (description) schema.description = description;
  return schema;
}

/**
 * 构造统一的 Responses API function tool 定义。
 *
 * @param {{name:string, description:string, properties?:Record<string, Object>}} options
 * @returns {Object}
 */
export function buildStrictFunctionToolDefinition(options = {}) {
  const name = normalizeContractText(options?.name);
  const description = normalizeContractText(options?.description);
  if (!name) {
    throw new Error('模型工具契约错误：function tool name 不能为空。');
  }
  if (!description) {
    throw new Error(`模型工具契约错误：${name} description 不能为空。`);
  }
  const properties = {
    ...(options?.properties || {}),
    [RESPONSES_TOOL_OUTPUT_MAX_CHARS_PARAMETER]: RESPONSES_TOOL_OUTPUT_MAX_CHARS_PROPERTY
  };
  return {
    type: 'function',
    name,
    description,
    strict: true,
    parameters: buildStrictObjectSchema(properties)
  };
}

/**
 * 从模型参数中拆出统一输出控制项，避免各工具执行器重复认识该协议字段。
 *
 * @param {any} rawArgs
 * @param {{toolName?:string}} [options]
 * @returns {{toolArgs:Object, maxOutputChars:number}}
 */
export function splitResponsesToolOutputControl(rawArgs, options = {}) {
  const toolArgs = (
    rawArgs
    && typeof rawArgs === 'object'
    && !Array.isArray(rawArgs)
  ) ? { ...rawArgs } : {};
  const rawMaxOutputChars = toolArgs[RESPONSES_TOOL_OUTPUT_MAX_CHARS_PARAMETER];
  delete toolArgs[RESPONSES_TOOL_OUTPUT_MAX_CHARS_PARAMETER];

  if (rawMaxOutputChars == null) {
    const toolName = typeof options?.toolName === 'string' ? options.toolName.trim() : '';
    return {
      toolArgs,
      maxOutputChars: RESPONSES_CONTENT_READ_TOOL_NAMES.has(toolName)
        ? RESPONSES_CONTENT_READ_TOOL_OUTPUT_DEFAULT_MAX_CHARS
        : RESPONSES_TOOL_OUTPUT_DEFAULT_MAX_CHARS
    };
  }
  if (!Number.isSafeInteger(rawMaxOutputChars) || rawMaxOutputChars <= 0) {
    throw new Error('工具参数错误：max_output_chars 必须是正安全整数或 null。');
  }
  return { toolArgs, maxOutputChars: rawMaxOutputChars };
}
