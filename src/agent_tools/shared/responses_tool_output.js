/**
 * Responses 自定义工具输出工具。
 *
 * 这里统一解决三件事：
 * 1. JS 工具返回对象 / 数组时，默认转成稳定、可读的 JSON 文本；
 * 2. 过长输出统一走可配置截断：默认尾截断，JS Runtime 明确使用中间截断；
 * 3. 需要时把长文本切成多个 input_text content item，避免“大块 JSON 字符串二次转义”。
 */
export const RESPONSES_TOOL_OUTPUT_MAX_CHARS = 5_000;
export const RESPONSES_TOOL_OUTPUT_CHUNK_CHARS = 3_000;
export const RESPONSES_TOOL_OUTPUT_PRETTY_JSON_MAX_CHARS = 1_000;
const RESPONSES_TOOL_OUTPUT_TRUNCATION_MODE_TAIL = 'tail';
const RESPONSES_TOOL_OUTPUT_TRUNCATION_MODE_MIDDLE = 'middle';

function trimTrailingWhitespace(text) {
  return String(text ?? '').replace(/[ \t]+\n/g, '\n').trim();
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
    const replacer = buildSafeStringifyReplacer();
    const pretty = JSON.stringify(value, replacer, 2);
    if (typeof pretty === 'string') {
      if (pretty.length <= RESPONSES_TOOL_OUTPUT_PRETTY_JSON_MAX_CHARS) {
        return pretty;
      }
      const compact = JSON.stringify(value, buildSafeStringifyReplacer());
      if (typeof compact === 'string') return compact;
      return pretty;
    }
  } catch (_) {}

  try {
    return String(value);
  } catch (_) {
    return '[unserializable]';
  }
}

function formatTruncationPercent(omittedChars, totalChars) {
  if (!Number.isFinite(omittedChars) || !Number.isFinite(totalChars) || totalChars <= 0) return '0.00';
  return ((omittedChars / totalChars) * 100).toFixed(2);
}

function normalizeResponsesToolOutputTruncationConfig(maxCharsOrOptions, maybeOptions = {}) {
  const options = (
    maxCharsOrOptions
    && typeof maxCharsOrOptions === 'object'
    && !Array.isArray(maxCharsOrOptions)
  )
    ? { ...maxCharsOrOptions }
    : { ...maybeOptions, maxChars: maxCharsOrOptions };
  const rawMode = typeof options.mode === 'string' ? options.mode.trim().toLowerCase() : '';
  const mode = rawMode === RESPONSES_TOOL_OUTPUT_TRUNCATION_MODE_MIDDLE
    ? RESPONSES_TOOL_OUTPUT_TRUNCATION_MODE_MIDDLE
    : RESPONSES_TOOL_OUTPUT_TRUNCATION_MODE_TAIL;
  const maxChars = Math.max(
    0,
    Math.trunc(Number(options.maxChars) || RESPONSES_TOOL_OUTPUT_MAX_CHARS)
  );
  return {
    maxChars,
    mode
  };
}

function buildResponsesToolOutputNoticeText({
  omittedChars,
  totalChars,
  omittedPct,
  omittedStart,
  omittedEnd,
  returnedStart = null,
  returnedEnd = null,
  mode = RESPONSES_TOOL_OUTPUT_TRUNCATION_MODE_TAIL
}) {
  const base = `output too long; truncated ${omittedChars} chars out of ${totalChars} total chars (${omittedPct}%)`;
  if (
    mode !== RESPONSES_TOOL_OUTPUT_TRUNCATION_MODE_MIDDLE
    && Number.isFinite(returnedStart)
    && Number.isFinite(returnedEnd)
  ) {
    return `[... ${base}; returned range [${returnedStart}, ${returnedEnd}) ...]`;
  }
  return `[... ${base}; omitted range [${omittedStart}, ${omittedEnd}) ...]`;
}

function appendStandaloneNoticeLine(text, notice) {
  const content = typeof text === 'string' ? text : String(text ?? '');
  const normalizedNotice = typeof notice === 'string' ? notice.trim() : '';
  if (!normalizedNotice) return content;
  if (!content) return normalizedNotice;
  return `${content}\n${normalizedNotice}`;
}

function applyResponsesToolOutputTruncation(text, truncation) {
  if (truncation === null || truncation === false) {
    return typeof text === 'string' ? text : String(text ?? '');
  }
  const normalized = normalizeResponsesToolOutputTruncationConfig(truncation);
  return truncateResponsesToolOutputText(text, normalized);
}

function buildResponsesToolOutputSelectionNoticeText(totalChars, rangeStart, rangeEnd) {
  const safeTotalChars = Number(totalChars);
  const safeRangeStart = Number(rangeStart);
  const safeRangeEnd = Number(rangeEnd);
  if (!Number.isFinite(safeTotalChars) || safeTotalChars <= 0) return '';
  if (!Number.isFinite(safeRangeStart) || !Number.isFinite(safeRangeEnd)) return '';
  const normalizedStart = Math.max(0, Math.min(Math.trunc(safeRangeStart), safeTotalChars));
  const normalizedEnd = Math.max(normalizedStart, Math.min(Math.trunc(safeRangeEnd), safeTotalChars));
  const returnedChars = normalizedEnd - normalizedStart;
  const omittedChars = Math.max(0, safeTotalChars - returnedChars);
  if (omittedChars <= 0) return '';
  return buildResponsesToolOutputNoticeText({
    omittedChars,
    totalChars: safeTotalChars,
    omittedPct: formatTruncationPercent(omittedChars, safeTotalChars),
    omittedStart: normalizedStart,
    omittedEnd: safeTotalChars,
    returnedStart: normalizedStart,
    returnedEnd: normalizedEnd,
    mode: RESPONSES_TOOL_OUTPUT_TRUNCATION_MODE_TAIL
  });
}

function buildResponsesToolOutputLineSelectionNoticeText(totalLines, startLine, endLine) {
  const safeTotalLines = Number(totalLines);
  const safeStartLine = Number(startLine);
  const safeEndLine = Number(endLine);
  if (!Number.isFinite(safeTotalLines) || safeTotalLines <= 0) return '';
  if (!Number.isFinite(safeStartLine) || !Number.isFinite(safeEndLine)) return '';
  const normalizedStart = Math.max(1, Math.min(Math.trunc(safeStartLine), safeTotalLines));
  const normalizedEnd = Math.max(normalizedStart, Math.min(Math.trunc(safeEndLine), safeTotalLines));
  const returnedLines = normalizedEnd - normalizedStart + 1;
  const omittedLines = Math.max(0, safeTotalLines - returnedLines);
  if (omittedLines <= 0) return '';
  return `[... omitted ${omittedLines} lines out of ${safeTotalLines} total lines; returned line range [${normalizedStart}, ${normalizedEnd + 1}) ...]`;
}

export function buildResponsesToolOutputTruncationInfo(
  text,
  maxCharsOrOptions = RESPONSES_TOOL_OUTPUT_MAX_CHARS,
  maybeOptions = {}
) {
  const content = typeof text === 'string' ? text : String(text ?? '');
  const chars = Array.from(content);
  const totalChars = chars.length;
  const { maxChars: safeMaxChars, mode } = normalizeResponsesToolOutputTruncationConfig(
    maxCharsOrOptions,
    maybeOptions
  );

  if (totalChars <= safeMaxChars) {
    return {
      text: content,
      notice: '',
      truncated: false,
      totalChars,
      omittedChars: 0,
      omittedPct: '0.00',
      omittedStart: totalChars,
      omittedEnd: totalChars,
      returnedStart: 0,
      returnedEnd: totalChars,
      mode
    };
  }

  if (mode === RESPONSES_TOOL_OUTPUT_TRUNCATION_MODE_MIDDLE) {
    let prefixChars = Math.ceil(safeMaxChars / 2);
    let suffixChars = safeMaxChars - prefixChars;
    let omittedStart = prefixChars;
    let omittedEnd = Math.max(omittedStart, totalChars - suffixChars);
    let omittedChars = Math.max(0, omittedEnd - omittedStart);
    let omittedPct = formatTruncationPercent(omittedChars, totalChars);
    let notice = buildResponsesToolOutputNoticeText({
      omittedChars,
      totalChars,
      omittedPct,
      omittedStart,
      omittedEnd,
      mode
    });

    const availableChars = Math.max(0, safeMaxChars - Array.from(notice).length);
    prefixChars = Math.ceil(availableChars / 2);
    suffixChars = availableChars - prefixChars;
    omittedStart = prefixChars;
    omittedEnd = Math.max(omittedStart, totalChars - suffixChars);
    omittedChars = Math.max(0, omittedEnd - omittedStart);
    omittedPct = formatTruncationPercent(omittedChars, totalChars);
    notice = buildResponsesToolOutputNoticeText({
      omittedChars,
      totalChars,
      omittedPct,
      omittedStart,
      omittedEnd,
      mode
    });
    const prefix = chars.slice(0, omittedStart).join('');
    const suffix = chars.slice(omittedEnd).join('');

    return {
      text: [prefix, notice, suffix].filter(Boolean).join('\n'),
      notice,
      truncated: true,
      totalChars,
      omittedChars,
      omittedPct,
      omittedStart,
      omittedEnd,
      returnedStart: null,
      returnedEnd: null,
      mode
    };
  }

  let returnedEnd = Math.min(totalChars, safeMaxChars);
  let omittedChars = Math.max(0, totalChars - returnedEnd);
  let omittedPct = formatTruncationPercent(omittedChars, totalChars);
  let notice = buildResponsesToolOutputNoticeText({
    omittedChars,
    totalChars,
    omittedPct,
    omittedStart: returnedEnd,
    omittedEnd: totalChars,
    returnedStart: 0,
    returnedEnd,
    mode
  });
  const minimumWithNotice = Array.from(notice).length + 1;
  if (safeMaxChars <= minimumWithNotice) {
    return {
      text: chars.slice(0, safeMaxChars).join(''),
      notice: '',
      truncated: true,
      totalChars,
      omittedChars: Math.max(0, totalChars - safeMaxChars),
      omittedPct: formatTruncationPercent(Math.max(0, totalChars - safeMaxChars), totalChars),
      omittedStart: safeMaxChars,
      omittedEnd: totalChars,
      returnedStart: 0,
      returnedEnd: Math.min(totalChars, safeMaxChars),
      mode
    };
  }

  const availableChars = Math.max(0, safeMaxChars - minimumWithNotice);
  returnedEnd = Math.min(totalChars, availableChars);
  omittedChars = Math.max(0, totalChars - returnedEnd);
  omittedPct = formatTruncationPercent(omittedChars, totalChars);
  notice = buildResponsesToolOutputNoticeText({
    omittedChars,
    totalChars,
    omittedPct,
    omittedStart: returnedEnd,
    omittedEnd: totalChars,
    returnedStart: 0,
    returnedEnd,
    mode
  });
  const prefix = chars.slice(0, returnedEnd).join('');

  return {
    text: appendStandaloneNoticeLine(prefix, notice),
    notice,
    truncated: true,
    totalChars,
    omittedChars,
    omittedPct,
    omittedStart: returnedEnd,
    omittedEnd: totalChars,
    returnedStart: 0,
    returnedEnd,
    mode
  };
}

export function truncateResponsesToolOutputText(
  text,
  maxCharsOrOptions = RESPONSES_TOOL_OUTPUT_MAX_CHARS,
  maybeOptions = {}
) {
  return buildResponsesToolOutputTruncationInfo(text, maxCharsOrOptions, maybeOptions).text;
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
 * @param {{maxChars?:number, chunkChars?:number}} [options]
 * @returns {Array<{type:'input_text', text:string}>}
 */
export function buildResponsesToolOutputContentItems(value, options = {}) {
  const serialized = stringifyResponsesToolOutputValue(value);
  const truncated = truncateResponsesToolOutputText(
    serialized,
    {
      maxChars: Number.isFinite(Number(options?.maxChars))
        ? Number(options.maxChars)
        : RESPONSES_TOOL_OUTPUT_MAX_CHARS,
      mode: RESPONSES_TOOL_OUTPUT_TRUNCATION_MODE_TAIL
    }
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

function trimJsonMetadataValue(value) {
  return trimTrailingWhitespace(stringifyResponsesToolOutputValue(value));
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

export function buildResponsesJsRuntimeToolOutputText(result, options = {}) {
  const normalized = (result && typeof result === 'object' && !Array.isArray(result)) ? result : {};
  const items = Array.isArray(normalized.items) ? normalized.items : [];
  const topLevelLogs = Array.isArray(normalized.logs) ? normalized.logs : [];
  const singleFrameLogs = (
    topLevelLogs.length <= 0
    && items.length === 1
    && Array.isArray(items[0]?.logs)
  )
    ? items[0].logs
    : [];
  const effectiveTopLevelLogs = topLevelLogs.length > 0 ? topLevelLogs : singleFrameLogs;
  const successFrameCount = items.filter((item) => !item?.error).length;
  const errorFrameCount = items.filter((item) => item?.error).length;
  const metadata = {
    ok: normalized.ok === true,
    tab_id: Number.isFinite(Number(normalized.tabId)) ? Number(normalized.tabId) : null,
    frame_count: items.length,
    success_frame_count: successFrameCount,
    error_frame_count: errorFrameCount,
    console_log_count: effectiveTopLevelLogs.length > 0
      ? effectiveTopLevelLogs.length
      : items.reduce((sum, item) => sum + (Array.isArray(item?.logs) ? item.logs.length : 0), 0)
  };

  const blocks = [];
  const metadataText = truncateResponsesToolOutputText(
    trimJsonMetadataValue(metadata),
    {
      maxChars: RESPONSES_TOOL_OUTPUT_MAX_CHARS,
      mode: RESPONSES_TOOL_OUTPUT_TRUNCATION_MODE_MIDDLE
    }
  );
  blocks.push(buildXmlBlock('metadata', metadataText));

  const returnValueText = truncateResponsesToolOutputText(
    trimTrailingWhitespace(formatResponsesJsRuntimeValueText(normalized.value)),
    {
      maxChars: RESPONSES_TOOL_OUTPUT_MAX_CHARS,
      mode: RESPONSES_TOOL_OUTPUT_TRUNCATION_MODE_MIDDLE
    }
  );
  if (returnValueText && returnValueText !== 'null') {
    blocks.push(buildXmlBlock('return_value', returnValueText));
  }

  if (effectiveTopLevelLogs.length > 0 && items.length <= 1) {
    const consoleLogsText = truncateResponsesToolOutputText(
      trimTrailingWhitespace(effectiveTopLevelLogs.map((log) => formatResponsesJsRuntimeLogText(log)).filter(Boolean).join('\n')),
      {
        maxChars: RESPONSES_TOOL_OUTPUT_MAX_CHARS,
        mode: RESPONSES_TOOL_OUTPUT_TRUNCATION_MODE_MIDDLE
      }
    );
    if (consoleLogsText) {
      blocks.push(buildXmlBlock('console_logs', consoleLogsText));
    }
  }

  const topLevelErrorText = truncateResponsesToolOutputText(
    trimTrailingWhitespace(formatResponsesJsRuntimeErrorText(normalized.error)),
    {
      maxChars: RESPONSES_TOOL_OUTPUT_MAX_CHARS,
      mode: RESPONSES_TOOL_OUTPUT_TRUNCATION_MODE_MIDDLE
    }
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
        const frameErrorText = truncateResponsesToolOutputText(
          trimTrailingWhitespace(formatResponsesJsRuntimeErrorText(item.error)),
          {
            maxChars: RESPONSES_TOOL_OUTPUT_MAX_CHARS,
            mode: RESPONSES_TOOL_OUTPUT_TRUNCATION_MODE_MIDDLE
          }
        );
        if (frameErrorText) innerBlocks.push(buildXmlBlock('error', frameErrorText));
      } else {
        const itemResultSerialized = stringifyResponsesToolOutputValue(item.result);
        const topValueSerialized = stringifyResponsesToolOutputValue(normalized.value);
        if (itemResultSerialized && topValueSerialized && itemResultSerialized === topValueSerialized && items.length === 1) {
          innerBlocks.push(buildXmlBlock('result_ref', 'return_value'));
        } else {
          const frameReturnValueText = truncateResponsesToolOutputText(
            trimTrailingWhitespace(formatResponsesJsRuntimeValueText(item.result)),
            {
              maxChars: RESPONSES_TOOL_OUTPUT_MAX_CHARS,
              mode: RESPONSES_TOOL_OUTPUT_TRUNCATION_MODE_MIDDLE
            }
          );
          if (frameReturnValueText && frameReturnValueText !== 'null') {
            innerBlocks.push(buildXmlBlock('return_value', frameReturnValueText));
          }
        }
      }

      if (Array.isArray(item.logs) && item.logs.length > 0) {
        const frameLogsText = truncateResponsesToolOutputText(
          trimTrailingWhitespace(item.logs.map((log) => formatResponsesJsRuntimeLogText(log, Number.isFinite(Number(item.frameId)) ? Number(item.frameId) : null)).filter(Boolean).join('\n')),
          {
            maxChars: RESPONSES_TOOL_OUTPUT_MAX_CHARS,
            mode: RESPONSES_TOOL_OUTPUT_TRUNCATION_MODE_MIDDLE
          }
        );
        if (frameLogsText) innerBlocks.push(buildXmlBlock('console_logs', frameLogsText));
      }

      const innerText = innerBlocks.filter(Boolean).join('\n\n');
      if (!innerText) return '';
      return `<frame_result${attrs ? ` ${attrs}` : ''}>\n${innerText}\n</frame_result>`;
    }).filter(Boolean).join('\n\n');

    const frameResultsText = truncateResponsesToolOutputText(
      trimTrailingWhitespace(frameBlocks),
      {
        maxChars: RESPONSES_TOOL_OUTPUT_MAX_CHARS,
        mode: RESPONSES_TOOL_OUTPUT_TRUNCATION_MODE_MIDDLE
      }
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

function buildXmlToolResultText(rootTag, metadata, blocks = [], options = {}) {
  const metadataTruncation = Object.prototype.hasOwnProperty.call(options, 'metadataTruncation')
    ? options.metadataTruncation
    : {
      mode: RESPONSES_TOOL_OUTPUT_TRUNCATION_MODE_TAIL,
      maxChars: RESPONSES_TOOL_OUTPUT_MAX_CHARS
    };
  const defaultBlockTruncation = Object.prototype.hasOwnProperty.call(options, 'blockTruncation')
    ? options.blockTruncation
    : {
      mode: RESPONSES_TOOL_OUTPUT_TRUNCATION_MODE_TAIL,
      maxChars: RESPONSES_TOOL_OUTPUT_MAX_CHARS
    };
  const sections = [];
  if (metadata && typeof metadata === 'object') {
    const metadataText = applyResponsesToolOutputTruncation(
      trimJsonMetadataValue(metadata),
      metadataTruncation
    );
    if (metadataText) sections.push(buildXmlBlock('metadata', metadataText));
  }

  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== 'object') continue;
    const tag = (typeof block.tag === 'string' && block.tag.trim()) ? block.tag.trim() : '';
    if (!tag) continue;
    const rawText = trimTrailingWhitespace(block.text);
    if (!rawText) continue;
    const blockTruncation = Object.prototype.hasOwnProperty.call(block, 'truncation')
      ? block.truncation
      : defaultBlockTruncation;
    const text = applyResponsesToolOutputTruncation(rawText, blockTruncation);
    sections.push(buildXmlBlock(tag, text));
  }

  const rootAttributes = (options?.rootAttributes && typeof options.rootAttributes === 'object' && !Array.isArray(options.rootAttributes))
    ? options.rootAttributes
    : {};
  const rootAttrText = Object.entries(rootAttributes)
    .filter(([, value]) => value != null && String(value).trim() !== '')
    .map(([key, value]) => `${key}="${xmlAttributeEscape(value)}"`)
    .join(' ');
  const openTag = rootAttrText ? `<${rootTag} ${rootAttrText}>` : `<${rootTag}>`;
  const body = sections.filter(Boolean).join('\n\n');
  return `${openTag}\n${body}\n</${rootTag}>`;
}

function buildResponsesXmlToolOutputContentItems(text, options = {}) {
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

function isResponsesToolOutputPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneResponsesToolOutputWithoutRawContent(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cloneResponsesToolOutputWithoutRawContent(item));
  }
  if (!isResponsesToolOutputPlainObject(value)) {
    return value;
  }
  const cloned = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'content' || key === 'numbered_content') continue;
    cloned[key] = cloneResponsesToolOutputWithoutRawContent(item);
  }
  return cloned;
}

function deleteResponsesToolOutputPath(target, path) {
  const segments = Array.isArray(path) ? path.filter((item) => typeof item === 'string' && item) : [];
  if (segments.length <= 0 || !isResponsesToolOutputPlainObject(target)) return;
  let cursor = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index];
    if (!isResponsesToolOutputPlainObject(cursor[key])) return;
    cursor = cursor[key];
  }
  delete cursor[segments[segments.length - 1]];
}

function readPositiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(1, Math.trunc(numeric));
}

function readNonNegativeInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.trunc(numeric));
}

function getResponsesFileSkillName(result, file = null) {
  const candidates = [
    file?.skill_name,
    result?.skill_name,
    result?.skill?.name
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function buildResponsesFileReadRangeAttribute(contentRead) {
  const normalized = isResponsesToolOutputPlainObject(contentRead) ? contentRead : {};
  const mode = typeof normalized.mode === 'string' ? normalized.mode.trim() : '';
  if (mode === 'line_range') {
    const startLine = readPositiveInteger(normalized.start_line);
    const endLine = readPositiveInteger(normalized.end_line);
    const totalLines = readNonNegativeInteger(normalized.total_lines);
    if (startLine && endLine) {
      return totalLines ? `lines ${startLine}-${endLine}/${totalLines}` : `lines ${startLine}-${endLine}`;
    }
  }
  if (mode === 'char_range' || mode === 'preview') {
    const start = readNonNegativeInteger(normalized.skip_chars) ?? 0;
    const returnedChars = readNonNegativeInteger(normalized.returned_chars);
    const totalChars = readNonNegativeInteger(normalized.total_chars);
    if (returnedChars != null) {
      const end = start + returnedChars;
      return totalChars ? `chars ${start}-${end}/${totalChars}` : `chars ${start}-${end}`;
    }
  }
  return '';
}

function buildResponsesFileReadNotice(contentRead, fallbackText = '') {
  const normalized = isResponsesToolOutputPlainObject(contentRead) ? contentRead : {};
  // 对显式范围读取，不再额外拼“output too long”提示。
  // 这里的省略是调用方主动请求的范围结果，不是工具层为了压缩输出而被动截断。
  if (normalized.mode === 'line_range' || normalized.mode === 'char_range') {
    return '';
  }
  const totalChars = Number(normalized.total_chars);
  const rangeStart = Number.isFinite(Number(normalized.skip_chars)) ? Number(normalized.skip_chars) : 0;
  const returnedChars = Number.isFinite(Number(normalized.returned_chars))
    ? Number(normalized.returned_chars)
    : String(fallbackText ?? '').length;
  return buildResponsesToolOutputSelectionNoticeText(
    totalChars,
    rangeStart,
    rangeStart + Math.max(0, returnedChars)
  );
}

function buildResponsesFileReadDisplayPath(result, file) {
  const normalized = isResponsesToolOutputPlainObject(file) ? file : {};
  const path = typeof normalized.path === 'string' ? normalized.path.trim() : '';
  const skillName = getResponsesFileSkillName(result, normalized);
  if (!path) return skillName || '';
  return skillName ? `${skillName}/${path}` : path;
}

function buildResponsesFileReadPlainContent(file) {
  const normalized = isResponsesToolOutputPlainObject(file) ? file : {};
  const preferredText = typeof normalized.numbered_content === 'string' && normalized.numbered_content.trim()
    ? normalized.numbered_content
    : (typeof normalized.content === 'string' ? normalized.content : '');
  const notice = buildResponsesFileReadNotice(normalized.content_read, preferredText);
  return appendStandaloneNoticeLine(preferredText, notice);
}

function buildResponsesFileListLine(file) {
  const normalized = isResponsesToolOutputPlainObject(file) ? file : {};
  const path = typeof normalized.path === 'string' ? normalized.path.trim() : '';
  const metaParts = [];
  const pushMetaPart = (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text && !metaParts.includes(text)) metaParts.push(text);
  };
  if (typeof normalized.skill_name === 'string' && normalized.skill_name.trim()) {
    pushMetaPart(`skill=${normalized.skill_name.trim()}`);
  }
  if (typeof normalized.kind === 'string' && normalized.kind.trim()) {
    pushMetaPart(normalized.kind.trim());
  }
  if (normalized.is_manifest === true) pushMetaPart('manifest');
  if (normalized.is_instruction === true) pushMetaPart('instruction');
  if (normalized.is_runtime_entry === true) pushMetaPart('runtime_entry');
  if (Number.isFinite(Number(normalized.size_chars))) {
    pushMetaPart(`${Math.max(0, Math.trunc(Number(normalized.size_chars)))} chars`);
  }
  return path
    ? `${path}${metaParts.length > 0 ? `  ${metaParts.join('  ')}` : ''}`
    : '';
}

function buildResponsesSearchLinePath(match) {
  const normalized = isResponsesToolOutputPlainObject(match) ? match : {};
  const filePath = typeof normalized.file_path === 'string'
    ? normalized.file_path.trim()
    : (typeof normalized.path === 'string' ? normalized.path.trim() : '');
  const skillName = typeof normalized.skill_name === 'string' ? normalized.skill_name.trim() : '';
  if (!filePath) return skillName || '';
  return skillName ? `${skillName}/${filePath}` : filePath;
}

function buildResponsesFileSearchContextLine(match, line, separator = '-') {
  const normalizedLine = isResponsesToolOutputPlainObject(line) ? line : {};
  const path = buildResponsesSearchLinePath(match);
  const lineNumber = readPositiveInteger(normalizedLine.line_number);
  const text = typeof normalizedLine.text === 'string' ? normalizedLine.text : '';
  if (!path && !lineNumber) return text;
  if (!lineNumber) return `${path}${separator}${text}`;
  return `${path}${separator}${lineNumber}${separator}${text}`;
}

function buildResponsesFileSearchMatchLine(match) {
  const normalized = isResponsesToolOutputPlainObject(match) ? match : {};
  const path = buildResponsesSearchLinePath(normalized);
  const lineNumber = readPositiveInteger(normalized.line_number);
  const column = readPositiveInteger(normalized.column_start);
  const lineText = typeof normalized.line_text === 'string' ? normalized.line_text : '';
  if (!path && !lineNumber) return lineText;
  if (!lineNumber) return `${path}:${lineText}`;
  if (!column) return `${path}:${lineNumber}:${lineText}`;
  return `${path}:${lineNumber}:${column}:${lineText}`;
}

function buildResponsesFileSearchContext(match) {
  const normalized = isResponsesToolOutputPlainObject(match) ? match : {};
  const lines = [];
  const before = Array.isArray(normalized.before) ? normalized.before : [];
  const after = Array.isArray(normalized.after) ? normalized.after : [];
  for (const line of before) {
    const text = buildResponsesFileSearchContextLine(normalized, line, '-');
    if (text) lines.push(text);
  }
  if (typeof normalized.line_text === 'string' && normalized.line_text.trim()) {
    lines.push(buildResponsesFileSearchMatchLine(normalized));
  }
  for (const line of after) {
    const text = buildResponsesFileSearchContextLine(normalized, line, '-');
    if (text) lines.push(text);
  }
  return lines.join('\n');
}

function buildResponsesFileReadToolOutputText(rootTag, result, options = {}) {
  const normalized = isResponsesToolOutputPlainObject(result) ? result : {};
  const file = isResponsesToolOutputPlainObject(options?.file) ? options.file : {};
  void rootTag;
  const path = buildResponsesFileReadDisplayPath(normalized, file);
  const range = buildResponsesFileReadRangeAttribute(file.content_read);
  const more = file?.content_read?.has_more_after_range === true ? 'more' : '';
  const headerDetail = [range, more].filter(Boolean).join('; ');
  const lines = [];
  if (path) lines.push(`# ${path}${headerDetail ? ` (${headerDetail})` : ''}`);
  const content = buildResponsesFileReadPlainContent(file);
  if (content) lines.push(content);
  if (normalized.error) {
    lines.push(`Error: ${formatResponsesJsRuntimeErrorText(normalized.error)}`);
  }
  return lines.join('\n') || 'No content.';
}

function buildResponsesFileListToolOutputText(rootTag, result, options = {}) {
  const normalized = isResponsesToolOutputPlainObject(result) ? result : {};
  void rootTag;
  const files = Array.isArray(options?.files) ? options.files : [];
  const lines = [];
  if (files.length > 0) {
    const listText = files
      .map((file) => buildResponsesFileListLine(file))
      .filter(Boolean)
      .join('\n');
    if (listText) {
      lines.push(listText);
    }
  } else {
    lines.push('No files found.');
  }
  const total = readNonNegativeInteger(normalized.total_files ?? normalized.total_count);
  const returned = readNonNegativeInteger(normalized.returned_file_count ?? files.length);
  if (total != null && returned != null && total > returned) {
    lines.push(`... returned ${returned} of ${total} files`);
  }
  if (normalized.error) {
    lines.push(`Error: ${formatResponsesJsRuntimeErrorText(normalized.error)}`);
  }
  return lines.filter(Boolean).join('\n');
}

function buildResponsesFileSearchToolOutputText(rootTag, result, options = {}) {
  const normalized = isResponsesToolOutputPlainObject(result) ? result : {};
  void rootTag;
  const matches = Array.isArray(options?.matches) ? options.matches : [];
  const lines = [];
  if (matches.length > 0) {
    // 这里刻意采用接近 `rg --line-number --column` 的纯文本形状：
    // `path:line:column:text` 是模型后续 read_file / apply_patch 最常用的定位信息，
    // 省掉每条命中的 JSON metadata，避免搜索工具输出比真正的匹配内容更吵。
    const matchesText = matches
      .map((match) => buildResponsesFileSearchContext(match))
      .filter(Boolean)
      .join('\n--\n');
    if (matchesText) {
      lines.push(matchesText);
    }
  } else {
    const pattern = typeof normalized.pattern === 'string' && normalized.pattern.trim()
      ? ` for "${normalized.pattern.trim()}"`
      : '';
    lines.push(`No matches found${pattern}.`);
  }
  const total = readNonNegativeInteger(normalized.total_matches);
  const returned = readNonNegativeInteger(normalized.returned_match_count ?? matches.length);
  if (total != null && returned != null && total > returned) {
    lines.push(`... returned ${returned} of ${total} matches`);
  } else if (normalized.truncated === true && returned != null) {
    lines.push(`... returned ${returned} matches; output truncated`);
  }
  if (normalized.error) {
    lines.push(`Error: ${formatResponsesJsRuntimeErrorText(normalized.error)}`);
  }
  return lines.filter(Boolean).join('\n');
}

function buildResponsesFileOperationToolOutputText(rootTag, result, options = {}) {
  const normalized = isResponsesToolOutputPlainObject(result) ? result : {};
  void rootTag;
  const action = typeof normalized.action === 'string' && normalized.action.trim()
    ? normalized.action.trim()
    : String(options?.toolName || '').trim();
  const sourcePath = typeof normalized.source_path === 'string'
    ? normalized.source_path.trim()
    : (typeof normalized.source_file_path === 'string' ? normalized.source_file_path.trim() : '');
  const destinationPath = typeof normalized.destination_path === 'string'
    ? normalized.destination_path.trim()
    : (typeof normalized.destination_file_path === 'string' ? normalized.destination_file_path.trim() : '');
  const deletedPath = typeof normalized.deleted_path === 'string'
    ? normalized.deleted_path.trim()
    : (typeof normalized.deleted_file_path === 'string' ? normalized.deleted_file_path.trim() : '');
  const resultLine = (() => {
    if (action === 'copy_file') return sourcePath && destinationPath ? `copy ${sourcePath} -> ${destinationPath}` : 'copy complete';
    if (action === 'move_file') return sourcePath && destinationPath ? `move ${sourcePath} -> ${destinationPath}` : 'move complete';
    if (action === 'delete_file') return deletedPath ? `delete ${deletedPath}` : 'delete complete';
    return 'file operation complete';
  })();
  const lines = [resultLine];
  if (normalized.error) {
    lines.push(`Error: ${formatResponsesJsRuntimeErrorText(normalized.error)}`);
  }
  return lines.filter(Boolean).join('\n');
}

function buildResponsesSkillReadDetailToolOutputText(result) {
  const normalized = isResponsesToolOutputPlainObject(result) ? result : {};
  const readContext = { ...normalized };
  delete readContext.error;
  const instruction = isResponsesToolOutputPlainObject(normalized?.skill?.instruction)
    ? normalized.skill.instruction
    : {};
  const lines = [];
  const instructionText = buildResponsesFileReadToolOutputText('skill_registry_result', readContext, {
    file: instruction,
    defaultTargetKind: 'skill'
  });
  if (instructionText && instructionText !== 'No content.') {
    lines.push(instructionText);
  }
  const files = Array.isArray(normalized?.skill?.files?.files) ? normalized.skill.files.files : [];
  if (files.length > 0) {
    const filesText = files
      .map((file) => buildResponsesFileListLine(file))
      .filter(Boolean)
      .join('\n');
    if (filesText) {
      lines.push(`Files:\n${filesText}`);
    }
  }
  if (normalized.error) {
    lines.push(`Error: ${formatResponsesJsRuntimeErrorText(normalized.error)}`);
  }
  return lines.filter(Boolean).join('\n\n') || 'No content.';
}

function buildResponsesSkillReadPackageToolOutputText(result) {
  const normalized = isResponsesToolOutputPlainObject(result) ? result : {};
  const readContext = { ...normalized };
  delete readContext.error;
  const files = Array.isArray(normalized?.skill?.files?.files) ? normalized.skill.files.files : [];
  const lines = [];
  if (files.length > 0) {
    lines.push(...files
      .map((file) => buildResponsesFileReadToolOutputText('skill_registry_result', readContext, {
        file,
        defaultTargetKind: 'skill'
      }))
      .filter((text) => text && text !== 'No content.'));
  } else {
    lines.push('No files found.');
  }
  const fileSummary = isResponsesToolOutputPlainObject(normalized?.skill?.files)
    ? normalized.skill.files
    : {};
  const total = readNonNegativeInteger(fileSummary.total_count ?? normalized.total_count);
  const returned = readNonNegativeInteger(fileSummary.returned_file_count ?? files.length);
  if (total != null && returned != null && total > returned) {
    lines.push(`... returned ${returned} of ${total} files`);
  }
  if (normalized.error) {
    lines.push(`Error: ${formatResponsesJsRuntimeErrorText(normalized.error)}`);
  }
  return lines.filter(Boolean).join('\n\n');
}

function buildResponsesPageContentToolOutputText(result) {
  const normalized = (result && typeof result === 'object' && !Array.isArray(result)) ? result : {};
  const metadata = {
    ok: normalized.ok === true,
    mode: typeof normalized.mode === 'string' ? normalized.mode : null,
    title: typeof normalized.title === 'string' ? normalized.title : '',
    url: typeof normalized.url === 'string' ? normalized.url : '',
    normalized_whitespace: normalized.normalized_whitespace === true,
    extraction_scope: typeof normalized.extraction_scope === 'string' ? normalized.extraction_scope : '',
    total_chars: Number.isFinite(Number(normalized.total_chars)) ? Number(normalized.total_chars) : null,
    skip_chars: Number.isFinite(Number(normalized.skip_chars)) ? Number(normalized.skip_chars) : null,
    max_chars: Number.isFinite(Number(normalized.max_chars)) ? Number(normalized.max_chars) : null,
    returned_chars: Number.isFinite(Number(normalized.returned_chars)) ? Number(normalized.returned_chars) : null,
    omitted_chars: Number.isFinite(Number(normalized.omitted_chars)) ? Number(normalized.omitted_chars) : null,
    omitted_pct: Number.isFinite(Number(normalized.omitted_pct)) ? Number(normalized.omitted_pct) : null,
    truncated: normalized.truncated === true,
    has_more_after_range: normalized.has_more_after_range === true
  };
  const blocks = [];
  if (typeof normalized.content === 'string' && normalized.content.trim()) {
    const rangeStart = Number.isFinite(Number(normalized.skip_chars)) ? Number(normalized.skip_chars) : 0;
    const returnedChars = Number.isFinite(Number(normalized.returned_chars))
      ? Number(normalized.returned_chars)
      : normalized.content.length;
    const rangeEnd = rangeStart + Math.max(0, returnedChars);
    const notice = buildResponsesToolOutputSelectionNoticeText(
      Number(normalized.total_chars) || 0,
      rangeStart,
      rangeEnd
    );
    blocks.push({
      tag: 'content',
      text: appendStandaloneNoticeLine(normalized.content, notice),
      truncation: null
    });
  }
  if (normalized.error) {
    blocks.push({
      tag: 'error',
      text: formatResponsesJsRuntimeErrorText(normalized.error)
    });
  }
  return buildXmlToolResultText('page_content_read_result', metadata, blocks);
}

function sanitizePdfOutlineInlineText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function formatPdfOutlineForToolOutput(outline) {
  const items = Array.isArray(outline) ? outline : [];
  return items
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const parts = [
        `chapter_id=${sanitizePdfOutlineInlineText(item.chapter_id || '')}`,
        item.parent_chapter_id ? `parent=${sanitizePdfOutlineInlineText(item.parent_chapter_id)}` : null,
        Number.isFinite(Number(item.level)) ? `level=${Number(item.level)}` : null,
        Number.isFinite(Number(item.page_number)) ? `page=${Number(item.page_number)}` : 'page=?',
        Number.isFinite(Number(item.char_count)) ? `chars=${Number(item.char_count)}` : null,
        Number.isFinite(Number(item.chunk_count)) ? `chunks=${Number(item.chunk_count)}` : null,
        Number.isFinite(Number(item.child_count)) ? `children=${Number(item.child_count)}` : null,
        `title=${sanitizePdfOutlineInlineText(item.title || '(untitled)')}`
      ].filter(Boolean);
      return parts.join(' | ');
    })
    .filter(Boolean)
    .join('\n');
}

function buildResponsesPdfContentToolOutputText(result) {
  const normalized = (result && typeof result === 'object' && !Array.isArray(result)) ? result : {};
  const selection = (normalized.selection && typeof normalized.selection === 'object' && !Array.isArray(normalized.selection))
    ? normalized.selection
    : null;
  const metadata = {
    ok: normalized.ok === true,
    mode: typeof normalized.mode === 'string' ? normalized.mode : null,
    title: typeof normalized.title === 'string' ? normalized.title : '',
    url: typeof normalized.url === 'string' ? normalized.url : '',
    is_pdf: normalized.is_pdf === true,
    total_chars: Number.isFinite(Number(normalized.total_chars)) ? Number(normalized.total_chars) : null,
    total_chapters: Number.isFinite(Number(normalized.total_chapters)) ? Number(normalized.total_chapters) : null,
    root_chapter_count: Number.isFinite(Number(normalized.root_chapter_count)) ? Number(normalized.root_chapter_count) : null,
    default_max_chars: Number.isFinite(Number(normalized.default_max_chars)) ? Number(normalized.default_max_chars) : null,
    outline_chunk_chars: Number.isFinite(Number(normalized.outline_chunk_chars)) ? Number(normalized.outline_chunk_chars) : null,
    max_chars_limit: Number.isFinite(Number(normalized.max_chars_limit)) ? Number(normalized.max_chars_limit) : null,
    document_chunk_count_default: Number.isFinite(Number(normalized.document_chunk_count_default)) ? Number(normalized.document_chunk_count_default) : null,
    chapter_id: typeof selection?.chapter_id === 'string' ? selection.chapter_id : null,
    chunk_index: Number.isFinite(Number(normalized.chunk_index)) ? Number(normalized.chunk_index) : null,
    max_chars: Number.isFinite(Number(normalized.max_chars)) ? Number(normalized.max_chars) : null,
    returned_chars: Number.isFinite(Number(normalized.returned_chars)) ? Number(normalized.returned_chars) : null,
    total_chunks: Number.isFinite(Number(normalized.total_chunks)) ? Number(normalized.total_chunks) : null,
    has_prev_chunk: normalized.has_prev_chunk === true,
    has_next_chunk: normalized.has_next_chunk === true,
    prev_chunk_index: Number.isFinite(Number(normalized.prev_chunk_index)) ? Number(normalized.prev_chunk_index) : null,
    next_chunk_index: Number.isFinite(Number(normalized.next_chunk_index)) ? Number(normalized.next_chunk_index) : null
  };

  const blocks = [];
  if (Array.isArray(normalized.outline) && normalized.outline.length > 0) {
    blocks.push({
      tag: 'outline',
      text: formatPdfOutlineForToolOutput(normalized.outline)
    });
  }
  if (selection) {
    blocks.push({
      tag: 'selection',
      text: stringifyResponsesToolOutputValue(selection)
    });
  }
  if (typeof normalized.guidance === 'string' && normalized.guidance.trim()) {
    blocks.push({
      tag: 'guidance',
      text: normalized.guidance
    });
  }
  if (typeof normalized.content === 'string' && normalized.content.trim()) {
    const scopeTotalChars = (() => {
      if (normalized.mode === 'chapter_chunk') {
        const chapterChars = Number(normalized?.selection?.char_count);
        if (Number.isFinite(chapterChars) && chapterChars > 0) return chapterChars;
      }
      const total = Number(normalized.total_chars);
      return Number.isFinite(total) && total > 0 ? total : 0;
    })();
    const rangeStart = Number.isFinite(Number(normalized.chunk_index)) && Number.isFinite(Number(normalized.max_chars))
      ? Math.max(0, Math.trunc(Number(normalized.chunk_index)) * Math.max(1, Math.trunc(Number(normalized.max_chars))))
      : 0;
    const returnedChars = Number.isFinite(Number(normalized.returned_chars))
      ? Number(normalized.returned_chars)
      : normalized.content.length;
    const notice = buildResponsesToolOutputSelectionNoticeText(
      scopeTotalChars,
      rangeStart,
      rangeStart + Math.max(0, returnedChars)
    );
    blocks.push({
      tag: 'content',
      text: appendStandaloneNoticeLine(normalized.content, notice),
      truncation: null
    });
  }
  if (normalized.error) {
    blocks.push({
      tag: 'error',
      text: formatResponsesJsRuntimeErrorText(normalized.error)
    });
  }
  return buildXmlToolResultText('pdf_content_read_result', metadata, blocks);
}

function buildHistorySearchResultMetadata(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return {};
  const metadata = { ...result };
  delete metadata.match;
  return metadata;
}

function buildResponsesHistorySearchToolOutputText(result) {
  const normalized = (result && typeof result === 'object' && !Array.isArray(result)) ? result : {};
  const metadata = {
    ok: normalized.ok === true,
    query: normalized.query && typeof normalized.query === 'object' ? normalized.query : {},
    max_results: Number.isFinite(Number(normalized.max_results)) ? Number(normalized.max_results) : null,
    result_mode: typeof normalized.result_mode === 'string' ? normalized.result_mode : null,
    total_matches: Number.isFinite(Number(normalized.total_matches)) ? Number(normalized.total_matches) : 0
  };

  const blocks = [];
  const results = Array.isArray(normalized.results) ? normalized.results : [];
  if (results.length > 0) {
    const resultsText = results.map((entry, index) => {
      const metadataBlock = buildXmlBlock('metadata', trimJsonMetadataValue(buildHistorySearchResultMetadata(entry)));
      const matchExcerpts = Array.isArray(entry?.match?.excerpts) ? entry.match.excerpts.filter((item) => typeof item === 'string' && item.trim()) : [];
      const matchLocations = Array.isArray(entry?.match?.locations) ? entry.match.locations : [];
      const matchMetadata = entry?.match && typeof entry.match === 'object'
        ? {
          reason: entry.match.reason || '',
          total_hit_count: Number(entry.match.total_hit_count) || 0,
          matched_message_count: Number(entry.match.matched_message_count) || 0,
          locations: matchLocations
        }
        : null;
      const parts = [metadataBlock];
      if (matchMetadata) {
        parts.push(buildXmlBlock('match', trimJsonMetadataValue(matchMetadata)));
      }
      if (matchExcerpts.length > 0) {
        parts.push(buildXmlBlock('match_excerpts', matchExcerpts.join('\n\n---\n\n')));
      }
      return `<conversation rank="${index + 1}">\n${parts.filter(Boolean).join('\n\n')}\n</conversation>`;
    }).join('\n\n');
    blocks.push({
      tag: 'results',
      text: resultsText,
      truncation: {
        mode: RESPONSES_TOOL_OUTPUT_TRUNCATION_MODE_TAIL,
        maxChars: RESPONSES_TOOL_OUTPUT_MAX_CHARS
      }
    });
  }
  if (normalized.error) {
    blocks.push({
      tag: 'error',
      text: formatResponsesJsRuntimeErrorText(normalized.error)
    });
  }
  return buildXmlToolResultText('history_search_result', metadata, blocks);
}

function buildResponsesHistoryReadToolOutputText(result) {
  const normalized = (result && typeof result === 'object' && !Array.isArray(result)) ? result : {};
  const metadata = { ...normalized };
  delete metadata.messages;
  const blocks = [];
  const messages = Array.isArray(normalized.messages) ? normalized.messages : [];
  if (messages.length > 0) {
    const messageText = messages.map((message) => {
      const indexName = Number.isFinite(Number(message?.msg_index)) ? 'msg_index' : 'thread_msg_index';
      const indexValue = Number.isFinite(Number(message?.[indexName])) ? Number(message[indexName]) : '';
      const role = typeof message?.role === 'string' ? message.role : '';
      const timestamp = Number.isFinite(Number(message?.timestamp)) ? Number(message.timestamp) : '';
      const attrs = [
        indexValue !== '' ? `${indexName}="${xmlAttributeEscape(indexValue)}"` : '',
        role ? `role="${xmlAttributeEscape(role)}"` : '',
        timestamp !== '' ? `timestamp="${xmlAttributeEscape(timestamp)}"` : ''
      ].filter(Boolean).join(' ');
      const content = typeof message?.content === 'string' ? message.content : '';
      const returnedChars = Number.isFinite(Number(message?.content_returned_chars))
        ? Number(message.content_returned_chars)
        : content.length;
      const totalChars = Number.isFinite(Number(message?.content_total_chars))
        ? Number(message.content_total_chars)
        : returnedChars;
      const notice = buildResponsesToolOutputSelectionNoticeText(totalChars, 0, Math.max(0, returnedChars));
      const contentWithNotice = appendStandaloneNoticeLine(content, notice);
      return `<message${attrs ? ` ${attrs}` : ''}>\n${contentWithNotice}\n</message>`;
    }).join('\n\n');
    blocks.push({
      tag: 'messages',
      text: messageText,
      truncation: null
    });
  }
  if (normalized.error) {
    blocks.push({
      tag: 'error',
      text: formatResponsesJsRuntimeErrorText(normalized.error)
    });
  }
  return buildXmlToolResultText('history_read_result', metadata, blocks);
}

function buildResponsesAskableModelsToolOutputText(result) {
  const normalized = (result && typeof result === 'object' && !Array.isArray(result)) ? result : {};
  const metadata = {
    ok: normalized.ok === true,
    total_models: Number.isFinite(Number(normalized.total_models)) ? Number(normalized.total_models) : 0
  };
  const blocks = [];
  if (typeof normalized.guidance === 'string' && normalized.guidance.trim()) {
    blocks.push({
      tag: 'guidance',
      text: normalized.guidance
    });
  }
  const models = Array.isArray(normalized.models) ? normalized.models : [];
  if (models.length > 0) {
    const modelsText = models.map((model, index) => {
      const displayName = (typeof model?.display_name === 'string' && model.display_name.trim())
        ? model.display_name.trim()
        : ((typeof model?.model_name === 'string' && model.model_name.trim()) ? model.model_name.trim() : '');
      const attrs = [
        `rank="${xmlAttributeEscape(index + 1)}"`,
        typeof model?.config_id === 'string' && model.config_id ? `config_id="${xmlAttributeEscape(model.config_id)}"` : '',
        displayName ? `display_name="${xmlAttributeEscape(displayName)}"` : ''
      ].filter(Boolean).join(' ');
      return `<model${attrs ? ` ${attrs}` : ''}>\n${displayName}\n</model>`;
    }).join('\n\n');
    blocks.push({
      tag: 'models',
      text: modelsText
    });
  }
  if (normalized.error) {
    blocks.push({
      tag: 'error',
      text: formatResponsesJsRuntimeErrorText(normalized.error)
    });
  }
  return buildXmlToolResultText('list_askable_models_result', metadata, blocks);
}

function buildResponsesAskOtherAiToolOutputText(result) {
  const normalized = (result && typeof result === 'object' && !Array.isArray(result)) ? result : {};
  const metadata = {
    ok: normalized.ok === true,
    total_requests: Number.isFinite(Number(normalized.total_requests)) ? Number(normalized.total_requests) : 0,
    success_count: Number.isFinite(Number(normalized.success_count)) ? Number(normalized.success_count) : 0,
    error_count: Number.isFinite(Number(normalized.error_count)) ? Number(normalized.error_count) : 0
  };
  const blocks = [];
  const answers = Array.isArray(normalized.answers) ? normalized.answers : [];
  if (answers.length > 0) {
    const answersText = answers.map((item, index) => {
      const displayName = (typeof item?.target?.display_name === 'string' && item.target.display_name.trim())
        ? item.target.display_name.trim()
        : ((typeof item?.display_name === 'string' && item.display_name.trim()) ? item.display_name.trim() : '');
      const attrs = [
        `rank="${index + 1}"`,
        typeof item?.status === 'string' && item.status ? `status="${xmlAttributeEscape(item.status)}"` : '',
        typeof item?.config_id === 'string' && item.config_id ? `config_id="${xmlAttributeEscape(item.config_id)}"` : '',
        displayName ? `display_name="${xmlAttributeEscape(displayName)}"` : ''
      ].filter(Boolean).join(' ');
      const innerBlocks = [];
      if (typeof item?.question === 'string' && item.question.trim()) {
        innerBlocks.push(buildXmlBlock('question', item.question));
      }
      if (item?.usage && typeof item.usage === 'object') {
        innerBlocks.push(buildXmlBlock('usage', trimJsonMetadataValue(item.usage)));
      }
      if (typeof item?.answer === 'string' && item.answer.trim()) {
        innerBlocks.push(buildXmlBlock('answer', item.answer));
      }
      if (typeof item?.error === 'string' && item.error.trim()) {
        innerBlocks.push(buildXmlBlock('error', item.error));
      }
      return `<response${attrs ? ` ${attrs}` : ''}>\n${innerBlocks.filter(Boolean).join('\n\n')}\n</response>`;
    }).join('\n\n');
    blocks.push({
      tag: 'responses',
      text: answersText
    });
  }
  if (normalized.error) {
    blocks.push({
      tag: 'error',
      text: formatResponsesJsRuntimeErrorText(normalized.error)
    });
  }
  return buildXmlToolResultText('ask_other_ai_result', metadata, blocks);
}

export function buildResponsesPageContentToolOutputContentItems(result, options = {}) {
  return buildResponsesXmlToolOutputContentItems(
    buildResponsesPageContentToolOutputText(result),
    options
  );
}

export function buildResponsesPdfContentToolOutputContentItems(result, options = {}) {
  return buildResponsesXmlToolOutputContentItems(
    buildResponsesPdfContentToolOutputText(result),
    options
  );
}

export function buildResponsesHistorySearchToolOutputContentItems(result, options = {}) {
  return buildResponsesXmlToolOutputContentItems(
    buildResponsesHistorySearchToolOutputText(result),
    options
  );
}

export function buildResponsesHistoryReadToolOutputContentItems(result, options = {}) {
  return buildResponsesXmlToolOutputContentItems(
    buildResponsesHistoryReadToolOutputText(result),
    options
  );
}

export function buildResponsesAskableModelsToolOutputContentItems(result, options = {}) {
  return buildResponsesXmlToolOutputContentItems(
    buildResponsesAskableModelsToolOutputText(result),
    options
  );
}

export function buildResponsesAskOtherAiToolOutputContentItems(result, options = {}) {
  return buildResponsesXmlToolOutputContentItems(
    buildResponsesAskOtherAiToolOutputText(result),
    options
  );
}

export function buildResponsesRequestUserInputToolOutputContentItems(result, options = {}) {
  const normalized = (result && typeof result === 'object' && !Array.isArray(result)) ? result : {};
  const fallbackAnswers = Array.isArray(normalized.questions)
    ? normalized.questions.reduce((acc, question) => {
      const id = (typeof question?.id === 'string') ? question.id.trim() : '';
      const answers = Array.isArray(question?.answers)
        ? question.answers.filter(answer => typeof answer === 'string' && answer.trim())
        : [];
      if (!id || answers.length <= 0) return acc;
      acc[id] = { answers };
      return acc;
    }, {})
    : {};
  const payload = {
    answers: (normalized.answers && typeof normalized.answers === 'object' && !Array.isArray(normalized.answers))
      ? normalized.answers
      : fallbackAnswers
  };
  if (typeof normalized.note === 'string' && normalized.note.trim()) {
    payload.note = normalized.note.trim();
  }
  if (normalized.error) {
    payload.error = normalized.error;
  }
  return buildResponsesToolOutputContentItems(payload, options);
}

function extractSkillActiveSkillNames(refreshResult) {
  if (Array.isArray(refreshResult?.active_skills)) {
    return refreshResult.active_skills
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
  }
  const names = new Set();
  const activeSkills = Array.isArray(refreshResult?.active_skills)
    ? refreshResult.active_skills
    : (Array.isArray(refreshResult?.value?.active_skills) ? refreshResult.value.active_skills : []);
  for (const item of activeSkills) {
    const name = typeof item === 'string' ? item.trim() : '';
    if (name) names.add(name);
  }
  return Array.from(names);
}

function extractSkillRefreshErrorMessage(refreshResult) {
  const message = typeof refreshResult?.error?.message === 'string'
    ? refreshResult.error.message.trim()
    : '';
  return message || '技能当前文档 refresh 失败。';
}

function buildSkillApplyPatchSummaryText(result) {
  const affected = (result?.affected_files && typeof result.affected_files === 'object') ? result.affected_files : {};
  const lines = [];
  const pushFiles = (prefix, values) => {
    for (const value of Array.isArray(values) ? values : []) {
      const path = typeof value === 'string' ? value.trim() : '';
      if (path) lines.push(`${prefix} ${path}`);
    }
  };
  pushFiles('A', affected.added);
  pushFiles('M', affected.modified);
  pushFiles('D', affected.deleted);
  if (lines.length <= 0) {
    return 'Patch applied successfully.';
  }
  return `Success. Updated the following files:\n${lines.join('\n')}`;
}

function buildSkillCreateTemplateSummaryText(result) {
  const skillName = typeof result?.normalized_name === 'string' && result.normalized_name.trim()
    ? result.normalized_name.trim()
    : (typeof result?.skill?.name === 'string' ? result.skill.name.trim() : '(unknown)');
  const revision = Number.isFinite(Number(result?.skill?.revision)) ? Number(result.skill.revision) : null;
  const createdFiles = Array.isArray(result?.created_files)
    ? result.created_files.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
    : [];
  const selectedResources = Array.isArray(result?.selected_resources)
    ? result.selected_resources.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
    : [];
  const nextSteps = Array.isArray(result?.next_steps)
    ? result.next_steps.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
    : [];

  const lines = [
    `Created skill scaffold ${skillName}${revision ? ` (revision ${revision})` : ''}.`
  ];
  if (createdFiles.length > 0) {
    lines.push('', 'Created files:');
    for (const filePath of createdFiles) {
      lines.push(`- ${filePath}`);
    }
  }
  if (selectedResources.length > 0) {
    lines.push('', `Selected resources: ${selectedResources.join(', ')}`);
  }
  lines.push('', `Examples created: ${result?.examples_created === true ? 'yes' : 'no'}`);
  if (nextSteps.length > 0) {
    lines.push('', 'Next steps:');
    nextSteps.forEach((step, index) => {
      lines.push(`${index + 1}. ${step}`);
    });
  }
  return lines.join('\n');
}

function buildSkillMutationSummaryText(result) {
  const normalized = (result && typeof result === 'object' && !Array.isArray(result)) ? result : {};
  const action = typeof normalized.action === 'string' ? normalized.action.trim() : '';
  const skillName = typeof normalized?.skill?.name === 'string'
    ? normalized.skill.name.trim()
    : (typeof normalized.skill_name === 'string' ? normalized.skill_name.trim() : '');
  const revision = Number.isFinite(Number(normalized?.skill?.revision)) ? Number(normalized.skill.revision) : null;
  const filePath = typeof normalized?.file?.path === 'string'
    ? normalized.file.path.trim()
    : (typeof normalized.deleted_file_path === 'string' ? normalized.deleted_file_path.trim() : '');
  const totalFiles = Number.isFinite(Number(normalized?.files?.total_count)) ? Number(normalized.files.total_count) : null;
  const activeSkillNames = extractSkillActiveSkillNames(normalized.refresh_result);

  let summary = '';
  switch (action) {
    case 'apply_patch':
      summary = buildSkillApplyPatchSummaryText(normalized);
      break;
    case 'delete_file':
      summary = filePath
        ? `Deleted file ${filePath}${skillName ? ` from skill ${skillName}` : ''}${revision ? ` (revision ${revision})` : ''}.`
        : `Deleted file from skill ${skillName || '(unknown)'}.`;
      break;
    case 'create':
    case 'create_skill':
      summary = normalized.create_mode === 'template'
        ? buildSkillCreateTemplateSummaryText(normalized)
        : `Created skill ${skillName || '(unknown)'}${revision ? ` (revision ${revision})` : ''}${totalFiles ? ` with ${totalFiles} files` : ''}.`;
      break;
    case 'update':
      summary = `Updated skill ${skillName || '(unknown)'}${revision ? ` to revision ${revision}` : ''}.`;
      break;
    case 'enable':
    case 'enable_skill':
      summary = `Enabled skill ${skillName || '(unknown)'}${revision ? ` (revision ${revision})` : ''}.`;
      break;
    case 'disable':
    case 'disable_skill':
      summary = `Disabled skill ${skillName || '(unknown)'}${revision ? ` (revision ${revision})` : ''}.`;
      break;
    case 'delete':
    case 'delete_skill':
      summary = `Deleted skill ${skillName || '(unknown)'}.`;
      break;
    case 'mount_on_current_page':
      summary = `Mounted skill ${skillName || '(unknown)'} on current page.`;
      break;
    case 'refresh_current_document':
      summary = activeSkillNames.length > 0
        ? `Refreshed current document. Active skills: ${activeSkillNames.join(', ')}.`
        : 'Refreshed current document. No active skills are mounted.';
      break;
    default:
      return null;
  }

  if (normalized.refreshed_current_document === true && normalized.refresh_result?.ok !== true) {
    return `${summary}\n\nCurrent document refresh failed: ${extractSkillRefreshErrorMessage(normalized.refresh_result)}`;
  }
  if (action !== 'refresh_current_document' && normalized.refreshed_current_document === true && activeSkillNames.length > 0) {
    return `${summary}\n\nMounted on current document: ${activeSkillNames.join(', ')}`;
  }
  return summary;
}

export function buildResponsesSkillRegistryToolOutputContentItems(result, options = {}) {
  const normalized = (result && typeof result === 'object' && !Array.isArray(result)) ? result : {};
  if (normalized.ok === true) {
    const summaryText = buildSkillMutationSummaryText(normalized);
    if (summaryText) {
      return buildResponsesXmlToolOutputContentItems(summaryText, options);
    }
  }
  if (String(normalized.action || '').trim() === 'read_file') {
    return buildResponsesXmlToolOutputContentItems(
      buildResponsesFileReadToolOutputText('skill_registry_result', normalized, {
        file: normalized?.skill?.file,
        defaultTargetKind: 'skill',
        omitMetadataPaths: []
      }),
      options
    );
  }
  if (String(normalized.action || '').trim() === 'list_files') {
    return buildResponsesXmlToolOutputContentItems(
      buildResponsesFileListToolOutputText('skill_registry_result', normalized, {
        files: normalized.files,
        defaultTargetKind: 'skill'
      }),
      options
    );
  }
  if (String(normalized.action || '').trim() === 'search_files') {
    return buildResponsesXmlToolOutputContentItems(
      buildResponsesFileSearchToolOutputText('skill_registry_result', normalized, {
        matches: normalized.matches,
        defaultTargetKind: 'skill'
      }),
      options
    );
  }
  if (['copy_file', 'move_file', 'delete_file'].includes(String(normalized.action || '').trim())) {
    return buildResponsesXmlToolOutputContentItems(
      buildResponsesFileOperationToolOutputText('skill_registry_result', normalized, {
        defaultTargetKind: 'skill',
        toolName: String(normalized.action || '').trim()
      }),
      options
    );
  }
  if (String(normalized.action || '').trim() === 'read_detail') {
    return buildResponsesXmlToolOutputContentItems(
      buildResponsesSkillReadDetailToolOutputText(normalized),
      options
    );
  }
  if (String(normalized.action || '').trim() === 'read_package') {
    return buildResponsesXmlToolOutputContentItems(
      buildResponsesSkillReadPackageToolOutputText(normalized),
      options
    );
  }
  return buildResponsesGenericXmlToolOutputContentItems('skill_registry_result', normalized, options);
}

export function buildResponsesConversationDocumentToolOutputContentItems(toolName, result, options = {}) {
  const normalized = (result && typeof result === 'object' && !Array.isArray(result)) ? result : {};
  const normalizedToolName = String(toolName || '').trim();
  const rootTag = `${normalizedToolName || 'virtual_file'}_result`;
  if (normalizedToolName === 'read_file') {
    return buildResponsesXmlToolOutputContentItems(
      buildResponsesFileReadToolOutputText(rootTag, normalized, {
        file: normalized.file
      }),
      options
    );
  }
  if (normalizedToolName === 'list_files') {
    return buildResponsesXmlToolOutputContentItems(
      buildResponsesFileListToolOutputText(rootTag, normalized, {
        files: normalized.files
      }),
      options
    );
  }
  if (normalizedToolName === 'search_files') {
    return buildResponsesXmlToolOutputContentItems(
      buildResponsesFileSearchToolOutputText(rootTag, normalized, {
        matches: normalized.matches
      }),
      options
    );
  }
  if (
    ['copy_file', 'move_file', 'delete_file'].includes(normalizedToolName)
  ) {
    return buildResponsesXmlToolOutputContentItems(
      buildResponsesFileOperationToolOutputText(rootTag, normalized, {
        toolName: normalizedToolName
      }),
      options
    );
  }
  if (normalizedToolName === 'apply_patch' && normalized.ok !== true) {
    const errorText = normalized.error
      ? `Error: ${formatResponsesJsRuntimeErrorText(normalized.error)}`
      : 'Patch failed.';
    return buildResponsesXmlToolOutputContentItems(errorText, options);
  }
  if (normalized.ok === true && normalizedToolName === 'apply_patch') {
    const affected = (normalized?.affected_files && typeof normalized.affected_files === 'object') ? normalized.affected_files : {};
    const changedLines = [];
    for (const value of Array.isArray(affected.added) ? affected.added : []) {
      const path = typeof value === 'string' ? value.trim() : '';
      if (path) {
        changedLines.push(`A ${path}`);
      }
    }
    for (const value of Array.isArray(affected.modified) ? affected.modified : []) {
      const path = typeof value === 'string' ? value.trim() : '';
      if (path) {
        changedLines.push(`M ${path}`);
      }
    }
    for (const value of Array.isArray(affected.deleted) ? affected.deleted : []) {
      const path = typeof value === 'string' ? value.trim() : '';
      if (path) changedLines.push(`D ${path}`);
    }
    const summaryText = changedLines.length > 0
      ? `Success. Updated the following files:\n${changedLines.join('\n')}`
      : 'Patch applied successfully.';
    return buildResponsesXmlToolOutputContentItems(summaryText, options);
  }
  return buildResponsesGenericXmlToolOutputContentItems(rootTag, normalized, options);
}

export function buildResponsesGenericXmlToolOutputContentItems(rootTag, result, options = {}) {
  const normalized = (result && typeof result === 'object' && !Array.isArray(result)) ? result : { value: result };
  const metadata = {
    ok: normalized.ok === true
  };
  const blocks = [];
  const hasExplicitValue = Object.prototype.hasOwnProperty.call(normalized, 'value');
  const fallbackResult = (() => {
    if (hasExplicitValue) return undefined;
    const payload = { ...normalized };
    delete payload.ok;
    delete payload.error;
    return Object.keys(payload).length > 0 ? payload : undefined;
  })();
  if (hasExplicitValue || fallbackResult !== undefined) {
    blocks.push({
      tag: 'result',
      text: stringifyResponsesToolOutputValue(hasExplicitValue ? normalized.value : fallbackResult)
    });
  }
  if (normalized.error) {
    blocks.push({
      tag: 'error',
      text: formatResponsesJsRuntimeErrorText(normalized.error)
    });
  }
  const text = buildXmlToolResultText(rootTag, metadata, blocks, options);
  return buildResponsesXmlToolOutputContentItems(text, options);
}

function extractDataUrlMimeType(value) {
  if (typeof value !== 'string') return '';
  const match = value.match(/^data:([^;,]+)(?:;base64)?,/i);
  return match ? String(match[1] || '').toLowerCase() : '';
}

function estimateDataUrlBytes(value) {
  if (typeof value !== 'string') return 0;
  const commaIndex = value.indexOf(',');
  const base64 = commaIndex >= 0 ? value.slice(commaIndex + 1) : value;
  if (!base64) return 0;
  return Math.round((base64.length * 3) / 4);
}

function normalizeResponsesInputImageItem(item, index = 0) {
  const imageUrl = (typeof item?.image_url === 'string') ? item.image_url.trim() : '';
  if (!imageUrl) return null;
  const detail = (typeof item?.detail === 'string' && item.detail.trim()) ? item.detail.trim() : '';
  const mimeType = extractDataUrlMimeType(imageUrl) || 'image';
  const approxBytes = estimateDataUrlBytes(imageUrl);
  return {
    index,
    imageUrl,
    detail,
    mimeType,
    approxBytes
  };
}

function buildResponsesInputImageSignature(value) {
  const text = (typeof value === 'string') ? value : '';
  if (!text) return '0:0:0:0';

  // 这里只取头/中/尾三个窗口做签名，避免把整段超大 base64 再复制进快照签名里。
  const windowSize = Math.min(256, text.length);
  const middleStart = Math.max(0, Math.floor((text.length - windowSize) / 2));
  const samples = [
    text.slice(0, windowSize),
    text.slice(middleStart, middleStart + windowSize),
    text.slice(Math.max(0, text.length - windowSize))
  ];

  const hashSample = (sample) => {
    let hash = 2166136261;
    for (let index = 0; index < sample.length; index += 1) {
      hash ^= sample.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  };

  return `${text.length}:${samples.map(hashSample).join(':')}`;
}

function normalizeResponsesToolOutputBodyForInspection(body) {
  if (Array.isArray(body)) return body;
  if (typeof body !== 'string') return null;
  const text = body.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

export function extractResponsesToolOutputInputImages(body) {
  const items = normalizeResponsesToolOutputBodyForInspection(body);
  if (!Array.isArray(items) || items.length <= 0) return [];

  const images = [];
  for (let index = 0; index < items.length; index += 1) {
    const normalized = normalizeResponsesInputImageItem(items[index], index);
    if (!normalized) continue;
    images.push({
      ...normalized,
      signature: `${normalized.detail || 'default'}:${normalized.mimeType}:${normalized.approxBytes}:${buildResponsesInputImageSignature(normalized.imageUrl)}`
    });
  }
  return images;
}

function formatResponsesInputImageItemForDisplay(item, index = 0) {
  const normalized = normalizeResponsesInputImageItem(item, index);
  if (!normalized) return '';
  const lines = [
    `[input_image #${normalized.index + 1}]`,
    `mime_type: ${normalized.mimeType}`,
    `detail: ${normalized.detail || 'default'}`
  ];
  if (normalized.approxBytes > 0) {
    lines.push(`approx_bytes: ${normalized.approxBytes}`);
  }
  return lines.join('\n');
}

function formatResponsesContentItemArrayForDisplay(body) {
  const items = Array.isArray(body) ? body : [];
  if (items.length <= 0) return '';

  if (items.every((item) => item && typeof item === 'object' && item.type === 'input_text' && typeof item.text === 'string')) {
    return items.map((item) => item.text).join('');
  }

  const blocks = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || typeof item !== 'object') return '';
    if (item.type === 'input_text' && typeof item.text === 'string') {
      blocks.push(item.text);
      continue;
    }
    if (item.type === 'input_image' && typeof item.image_url === 'string') {
      blocks.push(formatResponsesInputImageItemForDisplay(item, index));
      continue;
    }
    return '';
  }

  return blocks.join('\n\n').trim();
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
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const contentItemText = formatResponsesContentItemArrayForDisplay(parsed);
        if (contentItemText) {
          return contentItemText;
        }
      }
      return stringifyResponsesToolOutputValue(parsed);
    } catch (_) {
      return text;
    }
  }

  if (Array.isArray(body)) {
    const contentItemText = formatResponsesContentItemArrayForDisplay(body);
    if (contentItemText) {
      return contentItemText;
    }

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
        return stringifyResponsesToolOutputValue(JSON.parse(joined));
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
