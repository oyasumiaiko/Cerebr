/**
 * “页面内容快速读取”工具的纯函数逻辑。
 *
 * 设计边界：
 * - 它只处理“已经抽取出来的页面文本”；
 * - 文本会做轻量归一化：逐行 trim，并把多余空白折叠成单个空格；
 * - 当调用方显式要求包含图片 URL 时，它只负责把已编号的图片引用附录裁入本次结果；
 * - 它适合快速通读页面 + 可访问 iframe 文本；
 * - 它不做 DOM 级结构化定位，因此不替代 js_runtime_execute。
 */

export const PAGE_CONTENT_READ_TOOL_NAME = 'page_content_read';
export const PAGE_CONTENT_READ_DEFAULT_RANGE_CHARS = 10_000;
export const PAGE_CONTENT_READ_MAX_CHARS = 50_000;

/**
 * 构造给 Responses API 使用的 page_content_read 自定义函数工具定义。
 *
 * 工具定义与结果构造逻辑放在同目录里，后续若继续拆分页读取子模块时不会再回流到 sender。
 *
 * @returns {Object}
 */
export function buildPageContentReadFunctionToolDefinition() {
  const properties = {
    skip_chars: {
      type: ['integer', 'null'],
      description: '可选。要跳过的字符数，用于读取指定偏移后的连续片段。省略时默认从头开始。'
    },
    max_chars: {
      type: ['integer', 'null'],
      description: `可选。读取的连续字符长度。默认 ${PAGE_CONTENT_READ_DEFAULT_RANGE_CHARS}，最大 ${PAGE_CONTENT_READ_MAX_CHARS}。若与 skip_chars 一起提供，则返回从 skip_chars 开始的连续片段；若两者都省略，则返回默认从开头开始的截断预览。`
    },
    include_image_urls: {
      type: ['boolean', 'null'],
      description: '可选，默认 false。设为 true 时，页面正文中会按 DOM 原始顺序插入图片的 Markdown 引用链接，并在本次返回内容末尾附上实际出现引用对应的图片 URL。'
    }
  };
  return {
    type: 'function',
    name: PAGE_CONTENT_READ_TOOL_NAME,
    description: [
      '快速读取当前侧栏绑定网页标签页的预提取文本内容。',
      '它会返回页面正文与可访问 iframe 文本的预包装读取结果，并对多行做 trim 与空白折叠，更适合一次快速通读页面内容。',
      '默认不包含图片 URL；如需要让模型知道页面图文混排中的图片位置和 URL，可将 include_image_urls 设为 true，此时正文会出现如 `[图片标题][img-1]` 的引用，末尾附录会给出 `[img-1]: https://...`。',
      '若用户在对话开头说“这个”或未明确指代对象，默认指当前网页环境上下文，请先调用本工具读取页面再回答。',
      '这不是 DOM 结构化提取工具；若当前页面是 PDF 且需要按章节 / 片段读取，请优先使用 pdf_content_read；若需要按元素、选择器、属性进行结构化定位与提取，请优先使用 js_runtime_execute。',
      `默认返回从开头开始的 ${PAGE_CONTENT_READ_DEFAULT_RANGE_CHARS} 字符预览，最大单次读取 ${PAGE_CONTENT_READ_MAX_CHARS} 字符；正文若被截断，会在正文末尾附带统一的截断提示。也可通过 skip_chars 与 max_chars 读取指定连续片段。`
    ].join(' '),
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties,
      required: Object.keys(properties)
    }
  };
}

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
    maxChars,
    includeImageUrls: args.include_image_urls === true
  };
}

function normalizeImageReferenceList(value) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      const url = typeof item.url === 'string' ? item.url.trim() : '';
      const title = typeof item.title === 'string' ? item.title.trim() : '';
      if (!/^img-\d+$/.test(id) || !/^https?:\/\//i.test(url)) return null;
      return {
        id,
        title,
        url
      };
    })
    .filter(Boolean);
}

function collectReferencedImageIds(text) {
  const source = typeof text === 'string' ? text : '';
  const ids = [];
  const seen = new Set();
  const pattern = /\[[^\]\n]{1,200}\]\[(img-\d+)\]/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function appendImageReferenceAppendix(content, imageReferences) {
  const body = typeof content === 'string' ? content : '';
  const references = normalizeImageReferenceList(imageReferences);
  if (!body || references.length <= 0) {
    return {
      content: body,
      imageReferenceCount: 0
    };
  }

  const referencedIds = new Set(collectReferencedImageIds(body));
  if (referencedIds.size <= 0) {
    return {
      content: body,
      imageReferenceCount: 0
    };
  }

  const lines = references
    .filter((item) => referencedIds.has(item.id))
    .map((item) => `[${item.id}]: ${item.url}`);
  if (lines.length <= 0) {
    return {
      content: body,
      imageReferenceCount: 0
    };
  }

  return {
    content: `${body}\n\n${lines.join('\n')}`,
    imageReferenceCount: lines.length
  };
}

/**
 * 基于抽取后的页面内容，构造给模型看的快速读取结果。
 *
 * 规则：
 * - 默认（未显式指定 skip/max）返回从头开始的安全预览；
 * - 一旦显式指定 skip 或 max_chars，则按连续区间读取；
 * - preview / range 两种模式都会显式返回 returned / omitted 元信息；
 * - 这样即使页面很长，也不会把整篇正文都塞进一次工具结果里。
 *
 * @param {{title?:string, url?:string, content?:string}|null|undefined} pageContent
 * @param {any} rawArgs
 * @returns {Object}
 */
export function buildPageContentReadResult(pageContent, rawArgs) {
  const title = typeof pageContent?.title === 'string' ? pageContent.title.trim() : '';
  const url = typeof pageContent?.url === 'string' ? pageContent.url.trim() : '';
  const { skipChars, maxChars, includeImageUrls } = normalizePageContentReadArgs(rawArgs);
  const contentSource = includeImageUrls && typeof pageContent?.content_with_image_refs === 'string'
    ? pageContent.content_with_image_refs
    : pageContent?.content || '';
  const normalizedText = normalizePageContentReadText(contentSource);
  const totalChars = normalizedText.length;
  const hasExplicitRange = skipChars > 0 || maxChars !== null;
  const sourceImageReferences = includeImageUrls ? pageContent?.image_references : [];

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
    const effectiveMaxChars = PAGE_CONTENT_READ_DEFAULT_RANGE_CHARS;
    const end = Math.min(totalChars, effectiveMaxChars);
    const selectedContent = normalizedText.slice(0, end);
    const appendixResult = appendImageReferenceAppendix(selectedContent, sourceImageReferences);
    const omittedChars = Math.max(0, totalChars - selectedContent.length);
    return {
      ok: true,
      mode: 'preview',
      title,
      url,
      normalized_whitespace: true,
      extraction_scope: 'page_plus_accessible_iframe_text',
      total_chars: totalChars,
      max_chars: effectiveMaxChars,
      returned_chars: selectedContent.length,
      omitted_chars: omittedChars,
      omitted_pct: formatPercent(omittedChars, totalChars),
      truncated: omittedChars > 0,
      has_more_after_range: end < totalChars,
      include_image_urls: includeImageUrls,
      image_reference_count: appendixResult.imageReferenceCount,
      content: appendixResult.content
    };
  }

  const effectiveMaxChars = maxChars ?? PAGE_CONTENT_READ_DEFAULT_RANGE_CHARS;
  const start = Math.min(skipChars, totalChars);
  const end = Math.min(totalChars, start + effectiveMaxChars);
  const selectedContent = normalizedText.slice(start, end);
  const appendixResult = appendImageReferenceAppendix(selectedContent, sourceImageReferences);
  const omittedChars = Math.max(0, totalChars - selectedContent.length);

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
    returned_chars: selectedContent.length,
    omitted_chars: omittedChars,
    omitted_pct: formatPercent(omittedChars, totalChars),
    truncated: omittedChars > 0,
    has_more_after_range: end < totalChars,
    include_image_urls: includeImageUrls,
    image_reference_count: appendixResult.imageReferenceCount,
    content: appendixResult.content
  };
}
