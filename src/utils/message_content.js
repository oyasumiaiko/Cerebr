/**
 * @file 消息内容（文本 + 图片）规范化工具（偏纯函数）
 *
 * 目标：
 * - 统一「图片附件」在内存/存储/渲染之间的数据结构，避免散落在各处的正则与 DOM 解析；
 * - 解决历史遗留/脏数据：重复图片、仅含 text 的数组结构、image_url 字段形态不一致等；
 * - 避免把用户纯文本中的 `<img=.../>` 之类内容当作 HTML 解析，导致文本丢失或误判。
 *
 * 约定的内容结构（与 OpenAI multimodal 兼容）：
 * - 纯文本：string
 * - 多模态：Array<{type:'image_url', image_url:{url?:string, path?:string, hash?:string, ...}} | {type:'text', text:string}>
 */

/**
 * @typedef {{ type: 'image_url', image_url: any } | { type: 'text', text: string }} MessagePart
 */

function safeTrimString(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

function decodeHtmlEntities(input) {
  if (typeof input !== 'string' || !input) return '';
  // 仅处理我们在 src/alt 中最常见的实体，避免引入 DOM 解析副作用。
  return input
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function getHtmlTagAttribute(tag, attrName) {
  if (typeof tag !== 'string' || !tag) return '';
  const name = String(attrName || '').trim();
  if (!name) return '';
  const re = new RegExp(`\\b${name}\\s*=\\s*(['\"])(.*?)\\1`, 'i');
  const m = tag.match(re);
  return m ? decodeHtmlEntities(m[2] || '') : '';
}

function hasClass(classAttr, className) {
  if (typeof classAttr !== 'string' || !classAttr.trim()) return false;
  const target = String(className || '').trim();
  if (!target) return false;
  return classAttr.split(/\s+/).includes(target);
}

function splitByCodeFences(text) {
  if (!text) return [];
  return String(text).split(/```/);
}

function extractAiInlineImgTagsFromText(text) {
  const input = (typeof text === 'string') ? text : '';
  // 快速剪枝：仅处理我们自己注入的内联图片（ai-inline-image）。
  if (!input || !input.includes('<img') || !input.includes('ai-inline-image')) {
    return { imageUrls: [], text: input };
  }

  const imageUrls = [];
  const parts = splitByCodeFences(input);

  for (let i = 0; i < parts.length; i++) {
    // 奇数段在代码块内，必须原样保留，避免误删示例代码。
    if (i % 2 === 1) continue;

    parts[i] = parts[i].replace(/<img\b[^>]*>/gi, (tag) => {
      const classAttr = getHtmlTagAttribute(tag, 'class');
      if (!hasClass(classAttr, 'ai-inline-image')) return tag;

      const src = getHtmlTagAttribute(tag, 'src');
      const safeSrc = safeTrimString(src);
      if (!safeSrc) return tag;

      imageUrls.push(safeSrc);
      return '';
    });
  }

  return { imageUrls, text: parts.join('```') };
}

function extractImageUrlsFromImagesHTML(imagesHTML) {
  const html = (typeof imagesHTML === 'string') ? imagesHTML : '';
  if (!html || !html.trim()) return [];

  const container = document.createElement('div');
  container.innerHTML = html;

  // 先抽取 .image-tag（避免把其内部 <img> 缩略图当成另一张图片重复抽取）。
  const tags = Array.from(container.querySelectorAll('.image-tag'));
  const urls = [];
  for (const tag of tags) {
    if (!tag) continue;
    let url = tag.getAttribute('data-image') || '';
    if (!url) {
      const img = tag.querySelector('img');
      url = img?.getAttribute('src') || '';
    }
    url = safeTrimString(url);
    if (url) urls.push(url);
  }

  // assistant 结构化图片会渲染成独立的 img.ai-inline-image，而不是可编辑输入框里的
  // .image-tag。这里补充抽取这类图片，避免后续 updateAIMessage 只更新文本时把
  // 已经显示在正文里的生成图片从历史 content 中抹掉。
  const inlineImgs = Array.from(container.querySelectorAll('img.ai-inline-image'));
  for (const img of inlineImgs) {
    if (!img || img.closest('.image-tag')) continue;
    const url = safeTrimString(img.getAttribute('src') || '');
    if (url) urls.push(url);
  }
  return urls;
}

function normalizeImageUrlObject(imageUrl) {
  if (!imageUrl) return null;
  if (typeof imageUrl === 'string') {
    const url = safeTrimString(imageUrl);
    return url ? { url } : null;
  }
  if (typeof imageUrl !== 'object') return null;

  const next = { ...imageUrl };
  const url = safeTrimString(next.url);
  const path = safeTrimString(next.path);

  if (url) next.url = url;
  else delete next.url;

  if (path) next.path = path;
  else delete next.path;

  return (next.url || next.path) ? next : null;
}

function imageKey(imageUrlObj) {
  if (!imageUrlObj || typeof imageUrlObj !== 'object') return '';
  const hash = safeTrimString(imageUrlObj.hash);
  if (hash) return `hash:${hash}`;
  const path = safeTrimString(imageUrlObj.path);
  if (path) return `path:${path}`;
  const url = safeTrimString(imageUrlObj.url);
  if (url) return `url:${url}`;
  return '';
}

function dedupeImageUrlObjects(imageUrlObjects) {
  const list = Array.isArray(imageUrlObjects) ? imageUrlObjects : [];
  const seen = new Set();
  const out = [];
  for (const img of list) {
    const normalized = normalizeImageUrlObject(img);
    if (!normalized) continue;
    const key = imageKey(normalized);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

/**
 * 从「文本 + 图片容器 HTML」构造要写入历史记录/IndexedDB 的 content。
 * @param {string} text
 * @param {string|null} imagesHTML
 * @returns {string|MessagePart[]}
 */
export function buildStoredMessageContent(text, imagesHTML) {
  const inputText = (typeof text === 'string') ? text : '';
  const containerUrls = extractImageUrlsFromImagesHTML(imagesHTML);
  const inline = extractAiInlineImgTagsFromText(inputText);

  const imageUrlObjects = dedupeImageUrlObjects([
    ...containerUrls.map((url) => ({ url })),
    ...inline.imageUrls.map((url) => ({ url }))
  ]);

  if (imageUrlObjects.length === 0) {
    return inputText;
  }

  const parts = imageUrlObjects.map((img) => ({ type: 'image_url', image_url: img }));
  const cleanText = inline.text;
  if (typeof cleanText === 'string' && cleanText.trim()) {
    parts.push({ type: 'text', text: cleanText });
  }
  return parts;
}

/**
 * 规范化（去重/修形）已存储的消息 content。
 * - 若数组结构中不包含任何图片，则回退为 string（避免 fork/渲染时被当作多模态而触发错误逻辑）。
 * @param {any} content
 * @returns {string|MessagePart[]}
 */
export function normalizeStoredMessageContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const imageUrlObjects = [];
  const textParts = [];

  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'image_url') {
      const img = normalizeImageUrlObject(part.image_url);
      if (img) imageUrlObjects.push(img);
    } else if (part.type === 'text') {
      if (typeof part.text === 'string') textParts.push(part.text);
    }
  }

  const dedupedImages = dedupeImageUrlObjects(imageUrlObjects);
  const combinedText = textParts.join('');

  if (dedupedImages.length === 0) {
    return combinedText || '';
  }

  const parts = dedupedImages.map((img) => ({ type: 'image_url', image_url: img }));
  if (combinedText && combinedText.trim()) {
    parts.push({ type: 'text', text: combinedText });
  }
  return parts;
}

/**
 * 将 content 拆解为「文本 + 图片引用」，用于 UI 渲染。
 * @param {any} content
 * @returns {{ text: string, images: Array<any> }}
 */
export function splitStoredMessageContent(content) {
  const normalized = normalizeStoredMessageContent(content);
  if (typeof normalized === 'string') {
    return { text: normalized, images: [] };
  }

  const images = [];
  let text = '';
  for (const part of normalized) {
    if (!part) continue;
    if (part.type === 'image_url' && part.image_url) {
      images.push(part.image_url);
    } else if (part.type === 'text' && typeof part.text === 'string') {
      text += part.text;
    }
  }

  return { text, images };
}
