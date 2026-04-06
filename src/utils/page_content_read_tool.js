/**
 * “页面内容快速读取”工具的纯函数逻辑。
 *
 * 设计边界：
 * - 它只处理“已经抽取出来的页面文本”；
 * - 文本会做轻量归一化：逐行 trim，并把多余空白折叠成单个空格；
 * - 它适合快速通读页面 + 可访问 iframe 文本；
 * - 它不做 DOM 级结构化定位，因此不替代 js_runtime_execute。
 */

export const PAGE_CONTENT_READ_DEFAULT_PREVIEW_CHARS = 5000;
export const PAGE_CONTENT_READ_DEFAULT_RANGE_CHARS = 5000;
export const PAGE_CONTENT_READ_MAX_CHARS = 5000;

function clampNonNegativeInt(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.trunc(numeric));
}

function formatPercent(numerator, denominator) {
  const safeNumerator = Number(numerator);
  const safeDenominator = Number(denominator);
  if (!Number.isFinite(safeNumerator) || !Number.isFinite(safeDenominator) || safeDenominator <= 0) {
    return 0;
  }
  return Number(((safeNumerator / safeDenominator) * 100).toFixed(2));
}

/**
 * 将抽取文本压成更适合“快速阅读”的单行正文。
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizePageContentReadText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildMiddlePreview(text, maxChars) {
  const content = typeof text === 'string' ? text : '';
  const safeMaxChars = Math.max(1, clampNonNegativeInt(maxChars, PAGE_CONTENT_READ_DEFAULT_PREVIEW_CHARS));
  if (content.length <= safeMaxChars) {
    return {
      content,
      truncated: false,
      omittedChars: 0,
      omittedPct: 0
    };
  }

  const omittedChars = content.length - safeMaxChars;
  const omittedPct = formatPercent(omittedChars, content.length);
  const omittedStart = Math.ceil(safeMaxChars / 2);
  const omittedEnd = content.length - (safeMaxChars - omittedStart);
  const marker = `\n[... truncated ${omittedChars} chars out of ${content.length} total chars (${omittedPct}%); omitted range [${omittedStart}, ${omittedEnd}) ...]\n`;
  const available = Math.max(0, safeMaxChars - marker.length);
  const prefixLen = Math.floor(available / 2);
  const suffixLen = available - prefixLen;

  return {
    content: `${content.slice(0, prefixLen)}${marker}${content.slice(content.length - suffixLen)}`,
    truncated: true,
    omittedChars,
    omittedPct
  };
}

function normalizePageContentReadArgs(rawArgs) {
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs))
    ? rawArgs
    : {};
  const skipChars = clampNonNegativeInt(args.skip_chars, 0);
  const maxChars = (args.max_chars == null)
    ? null
    : Math.max(1, Math.min(PAGE_CONTENT_READ_MAX_CHARS, clampNonNegativeInt(args.max_chars, PAGE_CONTENT_READ_DEFAULT_RANGE_CHARS)));
  return {
    skipChars,
    maxChars
  };
}

/**
 * 基于抽取后的页面内容，构造给模型看的快速读取结果。
 *
 * 规则：
 * - 默认（未显式指定 skip/max）走中间截断预览；
 * - 一旦显式指定 skip 或 max_chars，则按连续区间读取；
 * - 返回值带上总长度、跳过量与截断比例，方便模型决定是否继续读取下一段。
 *
 * @param {{title?:string, url?:string, content?:string}|null|undefined} pageContent
 * @param {any} rawArgs
 * @returns {Object}
 */
export function buildPageContentReadResult(pageContent, rawArgs) {
  const title = typeof pageContent?.title === 'string' ? pageContent.title.trim() : '';
  const url = typeof pageContent?.url === 'string' ? pageContent.url.trim() : '';
  const normalizedText = normalizePageContentReadText(pageContent?.content || '');
  const totalChars = normalizedText.length;
  const { skipChars, maxChars } = normalizePageContentReadArgs(rawArgs);
  const hasExplicitRange = skipChars > 0 || maxChars !== null;

  if (!normalizedText) {
    return {
      ok: false,
      title,
      url,
      total_chars: 0,
      error: {
        message: '当前页面未提取到可读文本。',
        name: 'EmptyPageContentError'
      }
    };
  }

  if (!hasExplicitRange) {
    const preview = buildMiddlePreview(normalizedText, PAGE_CONTENT_READ_DEFAULT_PREVIEW_CHARS);
    return {
      ok: true,
      mode: 'preview',
      title,
      url,
      normalized_whitespace: true,
      extraction_scope: 'page_plus_accessible_iframe_text',
      total_chars: totalChars,
      returned_chars: preview.content.length,
      omitted_chars: preview.omittedChars,
      omitted_pct: preview.omittedPct,
      truncated: preview.truncated,
      content: preview.content
    };
  }

  const effectiveMaxChars = maxChars ?? PAGE_CONTENT_READ_DEFAULT_RANGE_CHARS;
  const start = Math.min(skipChars, totalChars);
  const end = Math.min(totalChars, start + effectiveMaxChars);
  const content = normalizedText.slice(start, end);
  const omittedChars = Math.max(0, totalChars - content.length);

  return {
    ok: true,
    mode: 'range',
    title,
    url,
    normalized_whitespace: true,
    extraction_scope: 'page_plus_accessible_iframe_text',
    total_chars: totalChars,
    skip_chars: start,
    max_chars: effectiveMaxChars,
    returned_chars: content.length,
    omitted_chars: omittedChars,
    omitted_pct: formatPercent(omittedChars, totalChars),
    truncated: omittedChars > 0,
    has_more_after_range: end < totalChars,
    content
  };
}
