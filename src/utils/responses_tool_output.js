/**
 * Responses 自定义工具输出工具。
 *
 * 这里统一解决三件事：
 * 1. JS 工具返回对象 / 数组时，默认转成稳定、可读的 JSON 文本；
 * 2. 过长输出按接近 Codex 的思路做中间截断，避免上下文被意外撑爆；
 * 3. 需要时把长文本切成多个 input_text content item，避免“大块 JSON 字符串二次转义”。
 */

const APPROX_BYTES_PER_TOKEN = 4;

// 参考 Codex 在历史/工具输出路径里常见的 2_500 token 级别预算，
// 这里为浏览器 JS 工具也采用同量级上限，既能保留足够上下文，又不容易把后续 hop 撑爆。
export const RESPONSES_TOOL_OUTPUT_MAX_TOKENS = 2_500;
export const RESPONSES_TOOL_OUTPUT_MAX_BYTES = RESPONSES_TOOL_OUTPUT_MAX_TOKENS * APPROX_BYTES_PER_TOKEN;
export const RESPONSES_TOOL_OUTPUT_CHUNK_CHARS = 3_000;
const RESPONSES_JS_RUNTIME_RETURN_VALUE_MAX_TOKENS = 1_000;
const RESPONSES_JS_RUNTIME_CONSOLE_LOGS_MAX_TOKENS = 800;
const RESPONSES_JS_RUNTIME_FRAME_RESULTS_MAX_TOKENS = 500;
const RESPONSES_JS_RUNTIME_ERROR_MAX_TOKENS = 400;
const RESPONSES_JS_RUNTIME_METADATA_MAX_CHARS = 1_200;

function trimTrailingWhitespace(text) {
  return String(text ?? '').replace(/[ \t]+\n/g, '\n').trim();
}

function approxTokensFromByteCount(bytes) {
  const numeric = Number(bytes);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.ceil(numeric / APPROX_BYTES_PER_TOKEN);
}

function describeDomLikeValue(value) {
  if (!value || typeof value !== 'object') return null;
  const nodeType = Number(value.nodeType);
  const nodeName = typeof value.nodeName === 'string' ? value.nodeName.toLowerCase() : '';
  if (!Number.isFinite(nodeType) || !nodeName) return null;
  const id = typeof value.id === 'string' && value.id ? `#${value.id}` : '';
  const className = typeof value.className === 'string' && value.className.trim()
    ? `.${value.className.trim().split(/\s+/).join('.')}`
    : '';
  return `[DOM ${nodeName}${id}${className}]`;
}

function buildSafeStringifyReplacer() {
  const seen = new WeakSet();
  return function replace(_key, value) {
    if (typeof value === 'bigint') return `${value.toString()}n`;
    if (typeof value === 'function') return `[Function${value.name ? `: ${value.name}` : ''}]`;
    if (typeof value === 'symbol') return String(value);
    if (value instanceof Error) {
      return {
        name: value.name || 'Error',
        message: value.message || '',
        stack: typeof value.stack === 'string' ? value.stack : ''
      };
    }
    const domLike = describeDomLikeValue(value);
    if (domLike) return domLike;
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  };
}

/**
 * 把任意工具返回值压成适合模型和 UI 阅读的文本。
 *
 * 规则：
 * - 字符串保持原样；
 * - 其它值尽量走 JSON pretty stringify；
 * - 若 stringify 失败，则退回 String(value)；
 * - 保证“对象默认可显示”，避免 UI 因 JSON.stringify 失败而一片空白。
 *
 * @param {any} value
 * @returns {string}
 */
export function stringifyResponsesToolOutputValue(value) {
  if (typeof value === 'string') return value;
  if (value == null) return 'null';

  try {
    const serialized = JSON.stringify(value, buildSafeStringifyReplacer(), 2);
    if (typeof serialized === 'string') return serialized;
  } catch (_) {}

  try {
    return String(value);
  } catch (_) {
    return '[unserializable]';
  }
}

function splitBudget(maxBytes) {
  const left = Math.floor(maxBytes / 2);
  return [left, maxBytes - left];
}

function splitStringByByteBudget(text, prefixBudget, suffixBudget) {
  if (!text) return { prefix: '', suffix: '', removedChars: 0 };
  const len = text.length;
  const suffixStartTarget = Math.max(0, len - suffixBudget);
  let prefixEnd = 0;
  let suffixStart = len;
  let removedChars = 0;
  let suffixStarted = false;

  let index = 0;
  for (const ch of text) {
    const charEnd = index + ch.length;
    if (charEnd <= prefixBudget) {
      prefixEnd = charEnd;
    } else if (index >= suffixStartTarget) {
      if (!suffixStarted) {
        suffixStart = index;
        suffixStarted = true;
      }
    } else {
      removedChars += 1;
    }
    index = charEnd;
  }

  if (suffixStart < prefixEnd) suffixStart = prefixEnd;
  return {
    prefix: text.slice(0, prefixEnd),
    suffix: text.slice(suffixStart),
    removedChars
  };
}

/**
 * 参考 Codex 的截断风格：保留头尾，中间插入 “... N tokens truncated ...” 标记。
 *
 * @param {string} text
 * @param {number} [maxTokens]
 * @returns {string}
 */
export function truncateResponsesToolOutputText(text, maxTokens = RESPONSES_TOOL_OUTPUT_MAX_TOKENS) {
  const content = typeof text === 'string' ? text : String(text ?? '');
  if (!content) return '';

  const byteBudget = Math.max(0, Math.trunc(Number(maxTokens) || RESPONSES_TOOL_OUTPUT_MAX_TOKENS)) * APPROX_BYTES_PER_TOKEN;
  if (byteBudget <= 0) {
    return `…${approxTokensFromByteCount(content.length)} tokens truncated…`;
  }
  if (content.length <= byteBudget) {
    return content;
  }

  const removedBytes = content.length - byteBudget;
  const removedTokens = approxTokensFromByteCount(removedBytes);
  const marker = `…${removedTokens} tokens truncated…`;
  const [prefixBudget, suffixBudget] = splitBudget(byteBudget);
  const { prefix, suffix } = splitStringByByteBudget(content, prefixBudget, suffixBudget);
  return `${prefix}${marker}${suffix}`;
}

function chunkTextByChars(text, chunkChars = RESPONSES_TOOL_OUTPUT_CHUNK_CHARS) {
  const content = typeof text === 'string' ? text : String(text ?? '');
  if (!content) return [];
  const chars = Array.from(content);
  const size = Math.max(1, Math.trunc(Number(chunkChars) || RESPONSES_TOOL_OUTPUT_CHUNK_CHARS));
  const chunks = [];
  for (let index = 0; index < chars.length; index += size) {
    chunks.push(chars.slice(index, index + size).join(''));
  }
  return chunks;
}

/**
 * 构造可直接塞进 Responses `function_call_output.output` 的 body。
 *
 * 说明：
 * - 这里默认返回 content items，而不是单个 JSON 字符串；
 * - 好处是避免“大块 JSON 字符串被再包一层字符串”的二次转义噪音；
 * - 模型看到的是多段 input_text 文本，UI 也可以直接拼回自然文本展示。
 *
 * @param {any} value
 * @param {{maxTokens?:number, chunkChars?:number}} [options]
 * @returns {Array<{type:'input_text', text:string}>}
 */
export function buildResponsesToolOutputContentItems(value, options = {}) {
  const serialized = stringifyResponsesToolOutputValue(value);
  const truncated = truncateResponsesToolOutputText(
    serialized,
    Number.isFinite(Number(options?.maxTokens))
      ? Number(options.maxTokens)
      : RESPONSES_TOOL_OUTPUT_MAX_TOKENS
  );
  const chunks = chunkTextByChars(
    truncated,
    Number.isFinite(Number(options?.chunkChars))
      ? Number(options.chunkChars)
      : RESPONSES_TOOL_OUTPUT_CHUNK_CHARS
  );
  return chunks.map((text) => ({
    type: 'input_text',
    text
  }));
}

function xmlAttributeEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildXmlBlock(tagName, body) {
  const text = trimTrailingWhitespace(body);
  if (!text) return '';
  return `<${tagName}>\n${text}\n</${tagName}>`;
}

function formatResponsesJsRuntimeSpecialValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  switch (value.type) {
    case 'truncated_string':
      return `${typeof value.preview === 'string' ? value.preview : ''}\n… string truncated from ${Number.isFinite(Number(value.length)) ? Number(value.length) : '?'} chars …`.trim();
    case 'data_url':
      return [
        'data URL omitted',
        `mime_type: ${typeof value.mime_type === 'string' ? value.mime_type : ''}`,
        `length: ${Number.isFinite(Number(value.length)) ? Number(value.length) : '?'}`
      ].join('\n');
    case 'dom_node':
      return [
        `DOM node: ${typeof value.nodeName === 'string' ? value.nodeName : ''}`,
        value.id ? `id: ${value.id}` : '',
        value.className ? `class: ${value.className}` : '',
        typeof value.textContent === 'string' && value.textContent ? `text: ${value.textContent}` : '',
        typeof value.outerHTML === 'string' && value.outerHTML ? `outer_html: ${value.outerHTML}` : ''
      ].filter(Boolean).join('\n');
    case 'bigint':
      return `${typeof value.value === 'string' ? value.value : ''}n`;
    case 'function':
      return `[Function${value.name ? `: ${value.name}` : ''}]`;
    case 'circular_ref':
      return '[Circular]';
    case 'truncated_array':
      return '[array truncated]';
    case 'truncated_object':
      return '[object truncated]';
    case 'truncated_structure':
      return `[structure truncated: ${typeof value.value_type === 'string' ? value.value_type : 'unknown'}]`;
    case 'truncated_items':
      return `[… ${Number.isFinite(Number(value.omitted_count)) ? Number(value.omitted_count) : '?'} items omitted …]`;
    case 'normalization_error':
      return stringifyResponsesToolOutputValue(value.error || value);
    default:
      return null;
  }
}

function formatResponsesJsRuntimeValueText(value) {
  const special = formatResponsesJsRuntimeSpecialValue(value);
  if (typeof special === 'string') return special;
  if (typeof value === 'string') return value;
  if (value == null || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return stringifyResponsesToolOutputValue(value);
}

function formatResponsesJsRuntimeErrorText(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  const special = formatResponsesJsRuntimeSpecialValue(error);
  if (typeof special === 'string') return special;
  if (typeof error === 'object') {
    const lines = [];
    if (typeof error.name === 'string' && error.name.trim()) {
      lines.push(`name: ${error.name.trim()}`);
    }
    if (typeof error.message === 'string' && error.message.trim()) {
      lines.push(`message: ${error.message.trim()}`);
    }
    if (typeof error.stack === 'string' && error.stack.trim()) {
      lines.push(`stack:\n${error.stack.trim()}`);
    }
    if (lines.length > 0) return lines.join('\n');
  }
  return stringifyResponsesToolOutputValue(error);
}

function formatResponsesJsRuntimeLogText(log, fallbackFrameId = null) {
  if (!log) return '';
  const level = (typeof log.level === 'string' && log.level.trim()) ? log.level.trim().toLowerCase() : 'log';
  const frameId = Number.isFinite(Number(log.frameId)) ? Number(log.frameId) : fallbackFrameId;
  const prefix = [
    frameId === null ? '' : `[frame ${frameId}]`,
    `[${level}]`
  ].filter(Boolean).join('');
  const text = formatResponsesJsRuntimeValueText(log.text ?? '');
  return `${prefix} ${text}`.trim();
}

function trimJsonText(jsonText, maxChars = RESPONSES_JS_RUNTIME_METADATA_MAX_CHARS) {
  if (typeof jsonText !== 'string') return '';
  if (jsonText.length <= maxChars) return jsonText;
  return `${jsonText.slice(0, maxChars)}\n… metadata truncated …`;
}

export function buildResponsesJsRuntimeToolOutputText(result, options = {}) {
  const normalized = (result && typeof result === 'object' && !Array.isArray(result)) ? result : {};
  const items = Array.isArray(normalized.items) ? normalized.items : [];
  const topLevelLogs = Array.isArray(normalized.logs) ? normalized.logs : [];
  const successFrameCount = items.filter((item) => !item?.error).length;
  const errorFrameCount = items.filter((item) => item?.error).length;
  const metadata = {
    ok: normalized.ok === true,
    tab_id: Number.isFinite(Number(normalized.tabId)) ? Number(normalized.tabId) : null,
    frame_count: items.length,
    success_frame_count: successFrameCount,
    error_frame_count: errorFrameCount,
    console_log_count: topLevelLogs.length > 0
      ? topLevelLogs.length
      : items.reduce((sum, item) => sum + (Array.isArray(item?.logs) ? item.logs.length : 0), 0)
  };

  const blocks = [];
  const metadataText = trimJsonText(JSON.stringify(metadata, null, 2));
  blocks.push(buildXmlBlock('metadata', metadataText));

  const returnValueText = trimTrailingWhitespace(
    truncateResponsesToolOutputText(
      formatResponsesJsRuntimeValueText(normalized.value),
      Number.isFinite(Number(options?.returnValueMaxTokens))
        ? Number(options.returnValueMaxTokens)
        : RESPONSES_JS_RUNTIME_RETURN_VALUE_MAX_TOKENS
    )
  );
  if (returnValueText && returnValueText !== 'null') {
    blocks.push(buildXmlBlock('return_value', returnValueText));
  }

  if (topLevelLogs.length > 0 && items.length <= 1) {
    const consoleLogsText = trimTrailingWhitespace(
      truncateResponsesToolOutputText(
        topLevelLogs.map((log) => formatResponsesJsRuntimeLogText(log)).filter(Boolean).join('\n'),
        Number.isFinite(Number(options?.consoleLogsMaxTokens))
          ? Number(options.consoleLogsMaxTokens)
          : RESPONSES_JS_RUNTIME_CONSOLE_LOGS_MAX_TOKENS
      )
    );
    if (consoleLogsText) {
      blocks.push(buildXmlBlock('console_logs', consoleLogsText));
    }
  }

  const topLevelErrorText = trimTrailingWhitespace(
    truncateResponsesToolOutputText(
      formatResponsesJsRuntimeErrorText(normalized.error),
      Number.isFinite(Number(options?.errorMaxTokens))
        ? Number(options.errorMaxTokens)
        : RESPONSES_JS_RUNTIME_ERROR_MAX_TOKENS
    )
  );
  if (topLevelErrorText) {
    blocks.push(buildXmlBlock('error', topLevelErrorText));
  }

  const shouldRenderFrameResults = items.length > 1 || items.some((item) => item?.error);
  if (shouldRenderFrameResults) {
    const frameBlocks = items.map((item) => {
      if (!item || typeof item !== 'object') return '';
      const attrs = [
        Number.isFinite(Number(item.frameId)) ? `frame_id="${xmlAttributeEscape(item.frameId)}"` : '',
        typeof item.documentId === 'string' && item.documentId ? `document_id="${xmlAttributeEscape(item.documentId)}"` : '',
        item.error ? 'status="error"' : 'status="ok"'
      ].filter(Boolean).join(' ');
      const innerBlocks = [];

      if (item.error) {
        const frameErrorText = trimTrailingWhitespace(
          truncateResponsesToolOutputText(
            formatResponsesJsRuntimeErrorText(item.error),
            Number.isFinite(Number(options?.errorMaxTokens))
              ? Number(options.errorMaxTokens)
              : RESPONSES_JS_RUNTIME_ERROR_MAX_TOKENS
          )
        );
        if (frameErrorText) innerBlocks.push(buildXmlBlock('error', frameErrorText));
      } else {
        const itemResultSerialized = stringifyResponsesToolOutputValue(item.result);
        const topValueSerialized = stringifyResponsesToolOutputValue(normalized.value);
        if (itemResultSerialized && topValueSerialized && itemResultSerialized === topValueSerialized && items.length === 1) {
          innerBlocks.push(buildXmlBlock('result_ref', 'return_value'));
        } else {
          const frameReturnValueText = trimTrailingWhitespace(
            truncateResponsesToolOutputText(
              formatResponsesJsRuntimeValueText(item.result),
              Number.isFinite(Number(options?.returnValueMaxTokens))
                ? Number(options.returnValueMaxTokens)
                : RESPONSES_JS_RUNTIME_RETURN_VALUE_MAX_TOKENS
            )
          );
          if (frameReturnValueText && frameReturnValueText !== 'null') {
            innerBlocks.push(buildXmlBlock('return_value', frameReturnValueText));
          }
        }
      }

      if (Array.isArray(item.logs) && item.logs.length > 0) {
        const frameLogsText = trimTrailingWhitespace(
          truncateResponsesToolOutputText(
            item.logs.map((log) => formatResponsesJsRuntimeLogText(log, Number.isFinite(Number(item.frameId)) ? Number(item.frameId) : null)).filter(Boolean).join('\n'),
            Number.isFinite(Number(options?.consoleLogsMaxTokens))
              ? Number(options.consoleLogsMaxTokens)
              : RESPONSES_JS_RUNTIME_CONSOLE_LOGS_MAX_TOKENS
          )
        );
        if (frameLogsText) innerBlocks.push(buildXmlBlock('console_logs', frameLogsText));
      }

      const innerText = innerBlocks.filter(Boolean).join('\n\n');
      if (!innerText) return '';
      return `<frame_result${attrs ? ` ${attrs}` : ''}>\n${innerText}\n</frame_result>`;
    }).filter(Boolean).join('\n\n');

    const frameResultsText = trimTrailingWhitespace(
      truncateResponsesToolOutputText(
        frameBlocks,
        Number.isFinite(Number(options?.frameResultsMaxTokens))
          ? Number(options.frameResultsMaxTokens)
          : RESPONSES_JS_RUNTIME_FRAME_RESULTS_MAX_TOKENS
      )
    );
    if (frameResultsText) {
      blocks.push(buildXmlBlock('frame_results', frameResultsText));
    }
  }

  const body = blocks.filter(Boolean).join('\n\n');
  return `<js_runtime_result>\n${body}\n</js_runtime_result>`;
}

export function buildResponsesJsRuntimeToolOutputContentItems(result, options = {}) {
  const text = buildResponsesJsRuntimeToolOutputText(result, options);
  const chunks = chunkTextByChars(
    text,
    Number.isFinite(Number(options?.chunkChars))
      ? Number(options.chunkChars)
      : RESPONSES_TOOL_OUTPUT_CHUNK_CHARS
  );
  return chunks.map((chunk) => ({
    type: 'input_text',
    text: chunk
  }));
}

/**
 * 将 function_call_output.output 正规化成适合 UI 展示的文本。
 *
 * 兼容：
 * - 旧格式：JSON 字符串
 * - 新格式：input_text content items 数组
 * - 极端情况：直接传对象/数组
 *
 * @param {any} body
 * @returns {string}
 */
export function formatResponsesToolOutputForDisplay(body) {
  if (body == null) return '';

  if (typeof body === 'string') {
    const text = body.trim();
    if (!text) return '';
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch (_) {
      return text;
    }
  }

  if (Array.isArray(body)) {
    const textChunks = body
      .map((item) => {
        if (item && typeof item === 'object' && item.type === 'input_text' && typeof item.text === 'string') {
          return item.text;
        }
        return null;
      })
      .filter(value => typeof value === 'string');

    if (textChunks.length === body.length && textChunks.length > 0) {
      const joined = textChunks.join('');
      try {
        return JSON.stringify(JSON.parse(joined), null, 2);
      } catch (_) {
        return joined;
      }
    }

    return stringifyResponsesToolOutputValue(body);
  }

  if (typeof body === 'object') {
    return stringifyResponsesToolOutputValue(body);
  }

  return String(body);
}

export function hasResponsesToolOutputBody(body) {
  return formatResponsesToolOutputForDisplay(body).trim() !== '';
}
