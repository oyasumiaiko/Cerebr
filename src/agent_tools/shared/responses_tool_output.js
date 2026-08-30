/**
 * Responses 自定义工具输出工具。
 *
 * 这里统一解决三件事：
 * 1. JS 工具返回对象 / 数组时，默认转成稳定、可读的 JSON 文本；
 * 2. 各工具只负责生成完整输出，最终字符预算由统一出口应用一次；
 * 3. 需要时把长文本切成多个 input_text content item，避免“大块 JSON 字符串二次转义”。
 */
import { formatApplyPatchVerificationError } from './apply_patch_core.js';

export const RESPONSES_TOOL_OUTPUT_CHUNK_CHARS = 3_000;
export const RESPONSES_TOOL_OUTPUT_PRETTY_JSON_MAX_CHARS = 1_000;
// message_sender 会显式传入 js_runtime_execute 的公开固定预算；这里保留同值默认值，
// 使序列化器被 UI、测试或其它纯调用方直接使用时仍不会意外返回无界 JS 文本。
const RESPONSES_JS_RUNTIME_DEFAULT_MAX_CHARS = 5_000;

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
        ...(typeof value.code === 'string' && value.code.trim() ? { code: value.code.trim() } : {}),
        name: value.name || 'Error',
        message: value.message || '',
        ...(typeof value.retryable === 'boolean' ? { retryable: value.retryable } : {})
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
 * @param {{chunkChars?:number}} [options]
 * @returns {Array<{type:'input_text', text:string}>}
 */
export function buildResponsesToolOutputContentItems(value, options = {}) {
  const serialized = stringifyResponsesToolOutputValue(value);
  const chunks = chunkTextByChars(
    serialized,
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

/**
 * 对工具返回中的外部文本做 XML 文本节点转义。
 *
 * 页面正文、PDF、历史消息、JS 日志与其他模型回答都属于不可信数据；如果直接拼进
 * 伪 XML，内容可以伪造闭合标签并让模型误判 status/error。转义只发生在正文已经
 * 完成选段与截断之后，因此不会把 entity 截成半段。
 */
function xmlTextEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function collectResponsesToolOutputText(contentItems) {
  return (Array.isArray(contentItems) ? contentItems : [])
    .filter(item => item?.type === 'input_text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('');
}

function buildResponsesToolOutputPageEnvelope(sourceChars, rangeStart, returnedChars, nextCursor = '') {
  const rangeEnd = rangeStart + returnedChars;
  const hasMore = rangeEnd < sourceChars.length;
  const cursorAttribute = hasMore && nextCursor
    ? ` next_cursor="${xmlAttributeEscape(nextCursor)}"`
    : '';
  const content = xmlTextEscape(sourceChars.slice(rangeStart, rangeEnd).join(''));
  return `<tool_output_page total_chars="${sourceChars.length}" range_start="${rangeStart}" range_end="${rangeEnd}" has_more="${hasMore}"${cursorAttribute}>\n<content>\n${content}\n</content>\n</tool_output_page>`;
}

/**
 * 在唯一出口把完整工具文本切成一个可续读页。
 *
 * 该函数保持纯函数：调用方负责生成和缓存 nextCursor 对应的完整 contentItems。
 * 第一页会保留图片；后续页只返回尚未读取的文本，避免视觉输入被重复塞入上下文。
 *
 * @param {Array<Object>} contentItems
 * @param {{maxOutputChars:number, rangeStart?:number, nextCursor?:string}} options
 * @returns {{contentItems:Array<Object>, totalChars:number, rangeStart:number, rangeEnd:number, hasMore:boolean, nextCursor:string}}
 */
export function paginateResponsesToolOutputContentItems(contentItems, options = {}) {
  const items = Array.isArray(contentItems) ? contentItems : [];
  const sourceChars = Array.from(collectResponsesToolOutputText(items));
  const totalChars = sourceChars.length;
  const maxOutputChars = Math.max(1, Math.trunc(Number(options?.maxOutputChars) || 0));
  const rangeStart = Math.max(0, Math.min(
    Math.trunc(Number(options?.rangeStart) || 0),
    totalChars
  ));
  const nextCursor = typeof options?.nextCursor === 'string' ? options.nextCursor.trim() : '';

  if (rangeStart === 0 && totalChars <= maxOutputChars) {
    return {
      contentItems: items,
      totalChars,
      rangeStart: 0,
      rangeEnd: totalChars,
      hasMore: false,
      nextCursor: ''
    };
  }

  const remainingChars = totalChars - rangeStart;
  const finalEnvelope = buildResponsesToolOutputPageEnvelope(
    sourceChars,
    rangeStart,
    remainingChars
  );
  let pageText = finalEnvelope;
  let returnedChars = remainingChars;
  let cursorExposed = false;

  if (Array.from(finalEnvelope).length > maxOutputChars) {
    const buildEnvelope = returned => buildResponsesToolOutputPageEnvelope(
      sourceChars,
      rangeStart,
      returned,
      nextCursor
    );
    const emptyEnvelope = buildEnvelope(0);
    if (Array.from(emptyEnvelope).length <= maxOutputChars) {
      let low = 0;
      let high = Math.min(remainingChars, maxOutputChars);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Array.from(buildEnvelope(middle)).length <= maxOutputChars) {
          low = middle;
        } else {
          high = middle - 1;
        }
      }
      returnedChars = low;
      pageText = buildEnvelope(returnedChars);
      cursorExposed = !!nextCursor;
    } else {
      // 极小预算放不下完整 XML 时，优先保留一个紧凑续读游标，再填充剩余正文。
      const compactCursor = nextCursor ? `next_cursor=${nextCursor}\n` : '';
      const compactCursorChars = Array.from(compactCursor);
      if (compactCursorChars.length <= maxOutputChars && nextCursor) {
        const availableContentChars = maxOutputChars - compactCursorChars.length;
        returnedChars = Math.min(remainingChars, availableContentChars);
        pageText = `${compactCursor}${sourceChars.slice(rangeStart, rangeStart + returnedChars).join('')}`;
        cursorExposed = true;
      } else {
        returnedChars = Math.min(remainingChars, maxOutputChars);
        pageText = sourceChars.slice(rangeStart, rangeStart + returnedChars).join('');
      }
    }
  }

  const rangeEnd = rangeStart + returnedChars;
  const hasMore = rangeEnd < totalChars;
  const textItems = chunkTextByChars(pageText).map(text => ({ type: 'input_text', text }));
  const preservedNonTextItems = rangeStart === 0
    ? items.filter(item => item?.type !== 'input_text')
    : [];
  return {
    contentItems: [...textItems, ...preservedNonTextItems],
    totalChars,
    rangeStart,
    rangeEnd,
    hasMore,
    nextCursor: hasMore && cursorExposed ? nextCursor : ''
  };
}

function buildXmlTextBlock(tagName, body) {
  const text = trimTrailingWhitespace(body);
  if (!text) return '';
  return `<${tagName}>\n${xmlTextEscape(text)}\n</${tagName}>`;
}

/**
 * 仅用于本模块自己生成、且其中所有外部叶子文本都已经转义过的嵌套 XML。
 * 调用方不得把页面/用户/模型原文直接传入这里。
 */
function buildTrustedXmlBlock(tagName, trustedMarkup) {
  const text = trimTrailingWhitespace(trustedMarkup);
  if (!text) return '';
  return `<${tagName}>\n${text}\n</${tagName}>`;
}

/**
 * 连接已完成叶子转义的 XML 子节点。
 *
 * @param {string[]} blocks 已经完成叶子转义的完整 XML 子节点
 * @returns {string}
 */
function joinTrustedXmlBlocks(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .map(block => trimTrailingWhitespace(block))
    .filter(Boolean)
    .join('\n\n');
}

function trimJsonMetadataValue(value) {
  return trimTrailingWhitespace(stringifyResponsesToolOutputValue(value));
}

function formatResponsesJsRuntimeSpecialValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  switch (value.type) {
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
    if (typeof error.code === 'string' && error.code.trim()) {
      lines.push(`code: ${error.code.trim()}`);
    }
    if (typeof error.name === 'string' && error.name.trim()) {
      lines.push(`name: ${error.name.trim()}`);
    }
    if (typeof error.message === 'string' && error.message.trim()) {
      lines.push(`message: ${error.message.trim()}`);
    }
    if (typeof error.retryable === 'boolean') {
      lines.push(`retryable: ${error.retryable}`);
    }
    if (lines.length > 0) return lines.join('\n');
    return 'Unknown tool error.';
  }
  return stringifyResponsesToolOutputValue(error);
}

function buildResponsesSafeErrorMetadata(error) {
  if (!error) return null;
  if (typeof error === 'string') {
    return { message: error };
  }
  if (!isResponsesToolOutputPlainObject(error)) {
    return { message: String(error) };
  }
  const payload = {};
  if (typeof error.code === 'string' && error.code.trim()) payload.code = error.code.trim();
  if (typeof error.name === 'string' && error.name.trim()) payload.name = error.name.trim();
  if (typeof error.message === 'string' && error.message.trim()) payload.message = error.message.trim();
  if (typeof error.retryable === 'boolean') payload.retryable = error.retryable;
  return Object.keys(payload).length > 0 ? payload : { message: 'Unknown tool error.' };
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
    status: successFrameCount > 0 && errorFrameCount > 0
      ? 'partial'
      : ((normalized.ok === true && errorFrameCount <= 0) ? 'succeeded' : 'failed'),
    tab_id: Number.isFinite(Number(normalized.tabId)) ? Number(normalized.tabId) : null,
    frame_count: items.length,
    success_frame_count: successFrameCount,
    error_frame_count: errorFrameCount,
    console_log_count: effectiveTopLevelLogs.length > 0
      ? effectiveTopLevelLogs.length
      : items.reduce((sum, item) => sum + (Array.isArray(item?.logs) ? item.logs.length : 0), 0)
  };

  const blocks = [];
  const metadataText = trimJsonMetadataValue(metadata);
  blocks.push(buildXmlTextBlock('metadata', metadataText));

  const returnValueText = trimTrailingWhitespace(formatResponsesJsRuntimeValueText(normalized.value));
  if (returnValueText && returnValueText !== 'null') {
    blocks.push(buildXmlTextBlock('return_value', returnValueText));
  }

  if (effectiveTopLevelLogs.length > 0 && items.length <= 1) {
    const consoleLogsText = trimTrailingWhitespace(
      effectiveTopLevelLogs.map((log) => formatResponsesJsRuntimeLogText(log)).filter(Boolean).join('\n')
    );
    if (consoleLogsText) {
      blocks.push(buildXmlTextBlock('console_logs', consoleLogsText));
    }
  }

  const topLevelErrorText = trimTrailingWhitespace(formatResponsesJsRuntimeErrorText(normalized.error));
  if (topLevelErrorText) {
    blocks.push(buildXmlTextBlock('error', topLevelErrorText));
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
        const frameErrorText = trimTrailingWhitespace(formatResponsesJsRuntimeErrorText(item.error));
        if (frameErrorText) innerBlocks.push(buildXmlTextBlock('error', frameErrorText));
      } else {
        // 单帧成功时 shouldRenderFrameResults 为 false，因此旧的 items.length === 1 比较分支不可达，
        // 却会在多帧结果中额外完整序列化 item.result 与 normalized.value。直接格式化当前帧即可保持输出不变。
        const frameReturnValueText = trimTrailingWhitespace(formatResponsesJsRuntimeValueText(item.result));
        if (frameReturnValueText && frameReturnValueText !== 'null') {
          innerBlocks.push(buildXmlTextBlock('return_value', frameReturnValueText));
        }
      }

      if (Array.isArray(item.logs) && item.logs.length > 0) {
        const frameLogsText = trimTrailingWhitespace(
          item.logs.map((log) => formatResponsesJsRuntimeLogText(log, Number.isFinite(Number(item.frameId)) ? Number(item.frameId) : null)).filter(Boolean).join('\n')
        );
        if (frameLogsText) innerBlocks.push(buildXmlTextBlock('console_logs', frameLogsText));
      }

      const innerText = joinTrustedXmlBlocks(innerBlocks);
      if (!innerText) return '';
      return `<frame_result${attrs ? ` ${attrs}` : ''}>\n${innerText}\n</frame_result>`;
    }).filter(Boolean);

    const frameResultsText = joinTrustedXmlBlocks(frameBlocks);
    if (frameResultsText) {
      blocks.push(buildTrustedXmlBlock('frame_results', frameResultsText));
    }
  }

  const body = blocks.filter(Boolean).join('\n\n');
  return `<js_runtime_result schema_version="2" trust="untrusted">\n${body}\n</js_runtime_result>`;
}

function collectResponsesJsRuntimeSavedOutputRefs(result) {
  const normalized = (result && typeof result === 'object' && !Array.isArray(result)) ? result : {};
  const refs = [];
  const seen = new Set();
  const addRef = (rawRef, frameId = null, documentId = '') => {
    const ref = (typeof rawRef === 'string') ? rawRef.trim() : '';
    if (!ref) return;
    const normalizedFrameId = Number.isFinite(Number(frameId)) ? Number(frameId) : null;
    const normalizedDocumentId = (typeof documentId === 'string') ? documentId.trim() : '';
    const key = `${ref}\u0000${normalizedFrameId ?? ''}\u0000${normalizedDocumentId}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ ref, frameId: normalizedFrameId, documentId: normalizedDocumentId });
  };

  addRef(normalized.savedOutputRef, null, '');
  (Array.isArray(normalized.savedOutputRefs) ? normalized.savedOutputRefs : []).forEach((item) => {
    addRef(item?.ref, item?.frameId, item?.documentId);
  });
  (Array.isArray(normalized.items) ? normalized.items : []).forEach((item) => {
    addRef(item?.savedOutputRef, item?.frameId, item?.documentId);
  });
  return refs;
}

function buildResponsesJsRuntimeSavedOutputsBlock(savedOutputs) {
  const blocks = (Array.isArray(savedOutputs) ? savedOutputs : []).map((item) => {
    const attrs = [
      `ref="${xmlAttributeEscape(item.ref)}"`,
      item.frameId === null ? '' : `frame_id="${xmlAttributeEscape(item.frameId)}"`,
      item.documentId ? `document_id="${xmlAttributeEscape(item.documentId)}"` : ''
    ].filter(Boolean).join(' ');
    return `<saved_output ${attrs} />`;
  });
  if (blocks.length <= 0) return '';
  return `<saved_outputs>\n${blocks.join('\n')}\n</saved_outputs>`;
}

function buildResponsesJsRuntimeOverflowText(result, fullText, maxOutputChars) {
  const normalized = (result && typeof result === 'object' && !Array.isArray(result)) ? result : {};
  const fullChars = Array.from(fullText);
  const savedOutputs = collectResponsesJsRuntimeSavedOutputRefs(normalized);
  const savedOutputsBlock = buildResponsesJsRuntimeSavedOutputsBlock(savedOutputs);
  const primaryRef = savedOutputs[0]?.ref || '';
  const runtimeItems = Array.isArray(normalized.items) ? normalized.items : [];
  const successFrameCount = runtimeItems.filter(item => !item?.error).length;
  const errorFrameCount = runtimeItems.filter(item => item?.error).length;
  const guidance = primaryRef
    ? [
        '完整 JS 工具结果已保存在当前 JS Runtime，不提供 next_cursor，也不能用 read_tool_output 续读。',
        `再次调用 js_runtime_execute，在 code 中使用 const output = $toolOutput(${JSON.stringify(primaryRef)}); 取得 { ok, value, logs, error }。`,
        '请在 JavaScript 内搜索、筛选、map/reduce、排序或聚合，只返回与当前问题相关的紧凑结果；不要按字符顺序搬运全部原文。',
        savedOutputs.length > 1 || savedOutputs.some(item => item.frameId !== null && item.frameId !== 0)
          ? '保存结果属于 saved_outputs 标出的对应 frame；后续调用应传入相应 frame_ids，多 frame 调用会在各自 frame 中保存同一引用。'
          : '',
        '保存结果只存在于当前页面或当前隔离沙箱生命周期，且缓存有界；页面刷新、导航、沙箱重建或较新的调用可能使旧引用失效。'
      ].filter(Boolean).join('\n')
    : 'JS 工具结果超过固定字符上限，但本次执行没有返回可用 saved_output_ref；不能续读。请重新执行更聚焦的 JavaScript，并直接在代码中完成搜索、筛选或聚合。';
  const metadata = {
    ok: normalized.ok === true,
    status: successFrameCount > 0 && errorFrameCount > 0
      ? 'partial'
      : ((normalized.ok === true && errorFrameCount <= 0) ? 'succeeded' : 'failed'),
    output_truncated: true,
    total_serialized_chars: fullChars.length,
    max_output_chars: maxOutputChars,
    saved_output_count: savedOutputs.length
  };
  const buildEnvelope = (previewChars) => {
    const preview = fullChars.slice(0, previewChars).join('');
    const sections = [
      buildXmlTextBlock('metadata', trimJsonMetadataValue(metadata)),
      savedOutputsBlock,
      buildXmlTextBlock('guidance', guidance),
      preview
        ? `<preview format="escaped_js_runtime_result">\n${xmlTextEscape(preview)}\n</preview>`
        : ''
    ].filter(Boolean).join('\n\n');
    return `<js_runtime_result schema_version="3" trust="untrusted" output_truncated="true">\n${sections}\n</js_runtime_result>`;
  };

  const emptyEnvelope = buildEnvelope(0);
  if (Array.from(emptyEnvelope).length > maxOutputChars) {
    throw new Error(`JS Runtime 固定输出预算 ${maxOutputChars} 无法容纳截断诊断信封。`);
  }

  let low = 0;
  let high = Math.min(fullChars.length, maxOutputChars);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Array.from(buildEnvelope(middle)).length <= maxOutputChars) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return buildEnvelope(low);
}

export function buildResponsesJsRuntimeToolOutputContentItems(result, options = {}) {
  const maxOutputChars = Number.isSafeInteger(options?.maxOutputChars) && options.maxOutputChars > 0
    ? options.maxOutputChars
    : RESPONSES_JS_RUNTIME_DEFAULT_MAX_CHARS;
  const fullText = buildResponsesJsRuntimeToolOutputText(result, options);
  const text = Array.from(fullText).length <= maxOutputChars
    ? fullText
    : buildResponsesJsRuntimeOverflowText(result, fullText, maxOutputChars);
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
  const sections = [];
  if (metadata && typeof metadata === 'object') {
    const metadataWithStatus = {
      ...metadata,
      status: typeof metadata.status === 'string' && metadata.status.trim()
        ? metadata.status.trim()
        : (metadata.ok === true ? 'succeeded' : (metadata.ok === false ? 'failed' : undefined))
    };
    const metadataText = trimJsonMetadataValue(metadataWithStatus);
    if (metadataText) sections.push(buildXmlTextBlock('metadata', metadataText));
  }

  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== 'object') continue;
    const tag = (typeof block.tag === 'string' && block.tag.trim()) ? block.tag.trim() : '';
    if (!tag) continue;
    const rawText = trimTrailingWhitespace(block.text);
    if (!rawText) continue;
    sections.push(block.contentMode === 'trusted_xml'
      ? buildTrustedXmlBlock(tag, rawText)
      : buildXmlTextBlock(tag, rawText));
  }

  const rootAttributes = {
    schema_version: '2',
    trust: 'untrusted',
    ...((options?.rootAttributes && typeof options.rootAttributes === 'object' && !Array.isArray(options.rootAttributes))
      ? options.rootAttributes
      : {})
  };
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
  return preferredText;
}

function buildResponsesFileListLine(file, options = {}) {
  const normalized = isResponsesToolOutputPlainObject(file) ? file : {};
  const path = typeof normalized.path === 'string' ? normalized.path.trim() : '';
  const skillName = typeof normalized.skill_name === 'string' ? normalized.skill_name.trim() : '';
  if (!path) return skillName ? `skill:${skillName}` : '';
  return options?.includeSkillScope === true && skillName
    ? `skill:${skillName}\t${path}`
    : path;
}

function buildResponsesSearchLinePath(match, options = {}) {
  const normalized = isResponsesToolOutputPlainObject(match) ? match : {};
  const filePath = typeof normalized.file_path === 'string'
    ? normalized.file_path.trim()
    : (typeof normalized.path === 'string' ? normalized.path.trim() : '');
  const skillName = typeof normalized.skill_name === 'string' ? normalized.skill_name.trim() : '';
  if (!filePath) return skillName ? `skill:${skillName}` : '';
  return options?.includeSkillScope === true && skillName
    ? `skill:${skillName}\t${filePath}`
    : filePath;
}

function buildResponsesFileSearchContextLine(line, separator = '-') {
  const normalizedLine = isResponsesToolOutputPlainObject(line) ? line : {};
  const lineNumber = readPositiveInteger(normalizedLine.line_number);
  const text = typeof normalizedLine.text === 'string' ? normalizedLine.text : '';
  if (!lineNumber) return text;
  return `${lineNumber}${separator}${text}`;
}

function buildResponsesFileSearchMatchLine(match) {
  const normalized = isResponsesToolOutputPlainObject(match) ? match : {};
  const lineNumber = readPositiveInteger(normalized.line_number);
  const column = readPositiveInteger(normalized.column_start);
  const lineText = typeof normalized.line_text === 'string' ? normalized.line_text : '';
  if (!lineNumber) return lineText;
  if (!column) return `${lineNumber}:${lineText}`;
  return `${lineNumber}:${column}:${lineText}`;
}

function buildResponsesFileSearchContext(match) {
  const normalized = isResponsesToolOutputPlainObject(match) ? match : {};
  const lines = [];
  const before = Array.isArray(normalized.before) ? normalized.before : [];
  const after = Array.isArray(normalized.after) ? normalized.after : [];
  for (const line of before) {
    const text = buildResponsesFileSearchContextLine(line, '-');
    if (text) lines.push(text);
  }
  if (typeof normalized.line_text === 'string' && normalized.line_text.trim()) {
    lines.push(buildResponsesFileSearchMatchLine(normalized));
  }
  for (const line of after) {
    const text = buildResponsesFileSearchContextLine(line, '-');
    if (text) lines.push(text);
  }
  return lines.join('\n');
}

function groupResponsesFileSearchMatchesByPath(matches, options = {}) {
  const groups = [];
  const groupsByPath = new Map();
  for (const match of Array.isArray(matches) ? matches : []) {
    const displayPath = buildResponsesSearchLinePath(match, options);
    const groupKey = displayPath || '(unknown)';
    let group = groupsByPath.get(groupKey);
    if (!group) {
      group = {
        path: displayPath,
        matches: []
      };
      groupsByPath.set(groupKey, group);
      groups.push(group);
    }
    group.matches.push(match);
  }
  return groups;
}

function buildResponsesFileSearchGroupedText(matches, options = {}) {
  const groups = groupResponsesFileSearchMatchesByPath(matches, options);
  return groups
    .map((group) => {
      const contextText = group.matches
        .map((match) => buildResponsesFileSearchContext(match))
        .filter(Boolean)
        .join('\n--\n');
      if (!group.path) return contextText;
      // 对齐 `rg --heading --line-number --column -C`：文件路径只出现一次，
      // 后续上下文行只保留行号/列号/正文，避免同一文件多行命中重复完整路径。
      return [group.path, contextText].filter(Boolean).join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
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
  const errorText = normalized.error ? formatResponsesJsRuntimeErrorText(normalized.error) : '';
  const lines = [];
  if (files.length > 0) {
    const listText = files
      .map((file) => buildResponsesFileListLine(file, options))
      .filter(Boolean)
      .join('\n');
    if (listText) {
      lines.push(listText);
    }
  } else if (!errorText) {
    lines.push('No files found.');
  }
  const total = readNonNegativeInteger(normalized.total_files ?? normalized.total_count);
  const returned = readNonNegativeInteger(normalized.returned_file_count ?? files.length);
  if (total != null && returned != null && total > returned) {
    lines.push(`... returned ${returned} of ${total} files`);
  }
  if (errorText) {
    lines.push(`Error: ${errorText}`);
  }
  return lines.filter(Boolean).join('\n');
}

function buildResponsesFileSearchToolOutputText(rootTag, result, options = {}) {
  const normalized = isResponsesToolOutputPlainObject(result) ? result : {};
  void rootTag;
  const matches = Array.isArray(options?.matches) ? options.matches : [];
  const errorText = normalized.error ? formatResponsesJsRuntimeErrorText(normalized.error) : '';
  const lines = [];
  if (matches.length > 0) {
    // 这里刻意采用接近 `rg --heading --line-number --column` 的纯文本形状：
    // `path` heading 加 `line:column:text` 是模型后续 read_file / apply_patch 最常用的定位信息，
    // 省掉每条命中的 JSON metadata，避免搜索工具输出比真正的匹配内容更吵。
    const matchesText = buildResponsesFileSearchGroupedText(matches, options);
    if (matchesText) {
      lines.push(matchesText);
    }
  } else if (!errorText) {
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
  if (errorText) {
    lines.push(`Error: ${errorText}`);
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
  const errorText = normalized.error ? formatResponsesJsRuntimeErrorText(normalized.error) : '';
  if (errorText) return `Error: ${errorText}`;
  const resultLine = (() => {
    if (action === 'copy_file') return 'Success.';
    if (action === 'move_file') return sourcePath && destinationPath ? `move ${sourcePath} -> ${destinationPath}` : 'move complete';
    if (action === 'delete_file') return deletedPath ? `delete ${deletedPath}` : 'delete complete';
    return 'file operation complete';
  })();
  return resultLine;
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

function buildResponsesSkillListToolOutputText(result) {
  const normalized = isResponsesToolOutputPlainObject(result) ? result : {};
  const skills = Array.isArray(normalized.skills) ? normalized.skills : [];
  const metadata = {
    ok: normalized.ok === true,
    action: 'list',
    scope: typeof normalized.scope === 'string' ? normalized.scope : null,
    include_all_sites: normalized.include_all_sites === true,
    total_skills: Number.isFinite(Number(normalized.total_skills))
      ? Math.max(0, Math.trunc(Number(normalized.total_skills)))
      : skills.length,
    url: typeof normalized.url === 'string' ? normalized.url : '',
    title: typeof normalized.title === 'string' ? normalized.title : ''
  };
  const blocks = [];
  if (skills.length > 0) {
    const skillBlocks = skills.map((skill, index) => {
      const name = typeof skill?.name === 'string' ? skill.name.trim() : '';
      const attrs = [
        `rank="${index + 1}"`,
        name ? `name="${xmlAttributeEscape(name)}"` : '',
        typeof skill?.kind === 'string' && skill.kind ? `kind="${xmlAttributeEscape(skill.kind)}"` : '',
        `enabled="${skill?.enabled === true}"`,
        `builtin="${skill?.builtin === true}"`,
        `read_only="${skill?.read_only === true}"`,
        Number.isFinite(Number(skill?.revision)) ? `revision="${xmlAttributeEscape(Math.trunc(Number(skill.revision)))}"` : ''
      ].filter(Boolean).join(' ');
      const summary = {
        display_name: typeof skill?.interface?.display_name === 'string' ? skill.interface.display_name : name,
        short_description: typeof skill?.interface?.short_description === 'string'
          ? skill.interface.short_description
          : (typeof skill?.description === 'string' ? skill.description : ''),
        match: Array.isArray(skill?.match) ? skill.match : [],
        instruction_path: typeof skill?.instruction?.path === 'string' ? skill.instruction.path : null,
        runtime_entry_path: typeof skill?.runtime?.entry_path === 'string' ? skill.runtime.entry_path : null,
        file_count: Number.isFinite(Number(skill?.files?.total_count)) ? Number(skill.files.total_count) : null
      };
      const summaryText = trimJsonMetadataValue(summary);
      return `<skill ${attrs}>\n${xmlTextEscape(summaryText)}\n</skill>`;
    });
    const skillsText = joinTrustedXmlBlocks(skillBlocks);
    blocks.push({
      tag: 'skills',
      text: skillsText,
      contentMode: 'trusted_xml'
    });
  }
  if (normalized.error) {
    blocks.push({
      tag: 'error',
      text: formatResponsesJsRuntimeErrorText(normalized.error)
    });
  }
  return buildXmlToolResultText('skill_registry_result', metadata, blocks);
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
    returned_chars: Number.isFinite(Number(normalized.returned_chars)) ? Number(normalized.returned_chars) : null,
    omitted_chars: Number.isFinite(Number(normalized.omitted_chars)) ? Number(normalized.omitted_chars) : null,
    omitted_pct: Number.isFinite(Number(normalized.omitted_pct)) ? Number(normalized.omitted_pct) : null,
    truncated: normalized.truncated === true,
    has_more_after_range: normalized.has_more_after_range === true,
    next_skip_chars: Number.isFinite(Number(normalized.next_skip_chars)) ? Number(normalized.next_skip_chars) : null,
    include_image_urls: normalized.include_image_urls === true,
    image_reference_count: Number.isFinite(Number(normalized.image_reference_count))
      ? Number(normalized.image_reference_count)
      : null
  };
  const blocks = [];
  if (typeof normalized.content === 'string' && normalized.content.trim()) {
    blocks.push({
      tag: 'content',
      text: normalized.content
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
    chapter_id: typeof selection?.chapter_id === 'string' ? selection.chapter_id : null,
    returned_chars: Number.isFinite(Number(normalized.returned_chars)) ? Number(normalized.returned_chars) : null,
    read_document: normalized.mode === 'document'
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
    blocks.push({
      tag: 'content',
      text: normalized.content
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
    const conversationBlocks = results.map((entry, index) => {
      const metadataBlock = buildXmlTextBlock('metadata', trimJsonMetadataValue(buildHistorySearchResultMetadata(entry)));
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
        parts.push(buildXmlTextBlock('match', trimJsonMetadataValue(matchMetadata)));
      }
      if (matchExcerpts.length > 0) {
        parts.push(buildXmlTextBlock('match_excerpts', matchExcerpts.join('\n\n---\n\n')));
      }
      const innerText = joinTrustedXmlBlocks(parts.filter(Boolean));
      return `<conversation rank="${index + 1}">\n${innerText}\n</conversation>`;
    });
    const resultsText = joinTrustedXmlBlocks(conversationBlocks);
    blocks.push({
      tag: 'results',
      text: resultsText,
      contentMode: 'trusted_xml'
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
  delete metadata.error;
  const blocks = [];
  const messages = Array.isArray(normalized.messages) ? normalized.messages : [];
  if (messages.length > 0) {
    const messageBlocks = messages.map((message) => {
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
      return `<message${attrs ? ` ${attrs}` : ''}>\n${xmlTextEscape(content)}\n</message>`;
    });
    const messageText = joinTrustedXmlBlocks(messageBlocks);
    blocks.push({
      tag: 'messages',
      text: messageText,
      contentMode: 'trusted_xml'
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
    const modelBlocks = models.map((model, index) => {
      const displayName = (typeof model?.display_name === 'string' && model.display_name.trim())
        ? model.display_name.trim()
        : ((typeof model?.model_name === 'string' && model.model_name.trim()) ? model.model_name.trim() : '');
      const attrs = [
        `rank="${xmlAttributeEscape(index + 1)}"`,
        typeof model?.config_id === 'string' && model.config_id ? `config_id="${xmlAttributeEscape(model.config_id)}"` : '',
        displayName ? `display_name="${xmlAttributeEscape(displayName)}"` : ''
      ].filter(Boolean).join(' ');
      const modelMetadata = {
        display_name: displayName,
        model_name: typeof model?.model_name === 'string' ? model.model_name : '',
        connection_type: typeof model?.connection_type === 'string' ? model.connection_type : null,
        connection_source_name: typeof model?.connection_source_name === 'string' ? model.connection_source_name : null,
        is_favorite: model?.is_favorite === true,
        has_custom_system_prompt: model?.has_custom_system_prompt === true
      };
      const modelMetadataText = trimJsonMetadataValue(modelMetadata);
      return `<model${attrs ? ` ${attrs}` : ''}>\n${xmlTextEscape(modelMetadataText)}\n</model>`;
    });
    const modelsText = joinTrustedXmlBlocks(modelBlocks);
    blocks.push({
      tag: 'models',
      text: modelsText,
      contentMode: 'trusted_xml'
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
  const successCount = Number.isFinite(Number(normalized.success_count)) ? Number(normalized.success_count) : 0;
  const errorCount = Number.isFinite(Number(normalized.error_count)) ? Number(normalized.error_count) : 0;
  const metadata = {
    ok: normalized.ok === true,
    status: successCount > 0 && errorCount > 0
      ? 'partial'
      : (successCount > 0 ? 'succeeded' : 'failed'),
    total_requests: Number.isFinite(Number(normalized.total_requests)) ? Number(normalized.total_requests) : 0,
    success_count: successCount,
    error_count: errorCount
  };
  const blocks = [];
  const answers = Array.isArray(normalized.answers) ? normalized.answers : [];
  if (answers.length > 0) {
    const responseBlocks = answers.map((item, index) => {
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
        innerBlocks.push(buildXmlTextBlock('question', item.question));
      }
      if (item?.usage && typeof item.usage === 'object') {
        innerBlocks.push(buildXmlTextBlock('usage', trimJsonMetadataValue(item.usage)));
      }
      if (typeof item?.answer === 'string' && item.answer.trim()) {
        innerBlocks.push(buildXmlTextBlock('answer', item.answer));
      }
      if (typeof item?.error === 'string' && item.error.trim()) {
        innerBlocks.push(buildXmlTextBlock('error', item.error));
      }
      const innerText = joinTrustedXmlBlocks(innerBlocks.filter(Boolean));
      return `<response${attrs ? ` ${attrs}` : ''}>\n${innerText}\n</response>`;
    });
    const answersText = joinTrustedXmlBlocks(responseBlocks);
    blocks.push({
      tag: 'responses',
      text: answersText,
      contentMode: 'trusted_xml'
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
    ok: normalized.ok === true,
    status: typeof normalized.status === 'string' && normalized.status.trim()
      ? normalized.status.trim()
      : (normalized.cancelled === true ? 'cancelled' : 'incomplete'),
    cancelled: normalized.cancelled === true,
    question_count: Number.isFinite(Number(normalized.question_count))
      ? Math.max(0, Math.trunc(Number(normalized.question_count)))
      : Object.keys(fallbackAnswers).length,
    answered_count: Number.isFinite(Number(normalized.answered_count))
      ? Math.max(0, Math.trunc(Number(normalized.answered_count)))
      : Object.keys(fallbackAnswers).length,
    answers: (normalized.answers && typeof normalized.answers === 'object' && !Array.isArray(normalized.answers))
      ? normalized.answers
      : fallbackAnswers
  };
  if (typeof normalized.note === 'string' && normalized.note.trim()) {
    payload.note = normalized.note.trim();
  }
  if (normalized.error) {
    payload.error = buildResponsesSafeErrorMetadata(normalized.error);
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

export function buildResponsesApplyPatchToolOutputText(result) {
  const normalized = (result && typeof result === 'object' && !Array.isArray(result))
    ? result
    : { ok: false, error: result };
  if (normalized.ok !== true) {
    const error = normalized.error || normalized;
    if (typeof error?.tool_output === 'string' && error.tool_output.length > 0) {
      return error.tool_output;
    }
    return formatApplyPatchVerificationError(error);
  }

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
  return `Success. Updated the following files:\n${lines.join('\n')}`;
}

function buildSkillApplyPatchSummaryText(result) {
  return buildResponsesApplyPatchToolOutputText(result);
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
  if (String(normalized.action || '').trim() === 'list') {
    return buildResponsesXmlToolOutputContentItems(
      buildResponsesSkillListToolOutputText(normalized),
      options
    );
  }
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
        defaultTargetKind: 'skill',
        includeSkillScope: !normalized.requested_skill_name
      }),
      options
    );
  }
  if (String(normalized.action || '').trim() === 'search_files') {
    return buildResponsesXmlToolOutputContentItems(
      buildResponsesFileSearchToolOutputText('skill_registry_result', normalized, {
        matches: normalized.matches,
        defaultTargetKind: 'skill',
        includeSkillScope: !normalized.requested_skill_name
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
        files: normalized.files,
        includeSkillScope: normalized?.target?.kind === 'skill' && !normalized?.target?.name
      }),
      options
    );
  }
  if (normalizedToolName === 'search_files') {
    return buildResponsesXmlToolOutputContentItems(
      buildResponsesFileSearchToolOutputText(rootTag, normalized, {
        matches: normalized.matches,
        includeSkillScope: normalized?.target?.kind === 'skill' && !normalized?.target?.name
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
  if (!/^data:/i.test(value)) return 0;
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

function isResponsesImageGenerationCallItem(item) {
  return !!(
    item
    && typeof item === 'object'
    && !Array.isArray(item)
    && String(item.type || '').trim().toLowerCase() === 'image_generation_call'
  );
}

function normalizeResponsesImageGenerationResultImageUrl(result) {
  const text = (typeof result === 'string') ? result.trim() : '';
  if (!text) return '';
  if (/^(data:image\/|file:\/\/|https?:\/\/|blob:)/i.test(text)) return text;
  return `data:image/png;base64,${text}`;
}

function normalizeResponsesImageGenerationOutputItem(item, index = 0) {
  if (!isResponsesImageGenerationCallItem(item)) return null;
  const imageUrl = normalizeResponsesImageGenerationResultImageUrl(
    item.result_image_url || item.image_url || item.result
  );
  if (!imageUrl) return null;
  const mimeType = extractDataUrlMimeType(imageUrl) || 'image/png';
  return {
    index,
    imageUrl,
    detail: '',
    mimeType,
    approxBytes: estimateDataUrlBytes(imageUrl),
    status: typeof item.status === 'string' ? item.status.trim() : '',
    revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt.trim() : ''
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
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return isResponsesImageGenerationCallItem(body) ? [body] : null;
  }
  if (typeof body !== 'string') return null;
  const text = body.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    return isResponsesImageGenerationCallItem(parsed) ? [parsed] : null;
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
    const generated = normalized ? null : normalizeResponsesImageGenerationOutputItem(items[index], index);
    const image = normalized || generated;
    if (!image) continue;
    images.push({
      ...image,
      signature: `${image.detail || 'default'}:${image.mimeType}:${image.approxBytes}:${buildResponsesInputImageSignature(image.imageUrl)}`
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

function formatResponsesImageGenerationCallItemForDisplay(item, index = 0) {
  const normalized = normalizeResponsesImageGenerationOutputItem(item, index);
  if (!normalized) return '';
  const lines = [
    `[image_generation_call #${normalized.index + 1}]`
  ];
  if (normalized.status) {
    lines.push(`status: ${normalized.status}`);
  }
  if (normalized.revisedPrompt) {
    lines.push(`revised_prompt: ${normalized.revisedPrompt}`);
  }
  lines.push(`result: ${normalized.mimeType}`);
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
    if (isResponsesImageGenerationCallItem(item)) {
      const formatted = formatResponsesImageGenerationCallItemForDisplay(item, index);
      if (!formatted) return '';
      blocks.push(formatted);
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
      if (isResponsesImageGenerationCallItem(parsed)) {
        return formatResponsesImageGenerationCallItemForDisplay(parsed);
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
    if (isResponsesImageGenerationCallItem(body)) {
      return formatResponsesImageGenerationCallItemForDisplay(body);
    }
    return stringifyResponsesToolOutputValue(body);
  }

  return String(body);
}

export function hasResponsesToolOutputBody(body) {
  return formatResponsesToolOutputForDisplay(body).trim() !== '';
}
