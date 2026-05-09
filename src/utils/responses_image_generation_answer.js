/**
 * Responses 生图结果的正文内容工具（纯函数）。
 *
 * 这里刻意不把 `<img>` HTML 拼进 assistant answer 字符串：
 * - answer 只表达模型真正输出的可见文本；
 * - 生图结果作为结构化 `image_url` part 存入 assistant message content；
 * - Responses replay 仍然由原始 `image_generation_call` item 承载，避免把图片改写成
 *   额外的历史消息，从而破坏 Responses prompt cache 与官方 replay 语义。
 */

function normalizeString(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

function isRenderableImageUrl(value) {
  const text = normalizeString(value);
  if (!text) return false;
  return /^(file:\/\/|https?:\/\/|blob:|data:image\/)/i.test(text);
}

export function normalizeResponsesImageGenerationAnswerImageUrl(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
  if (String(item.type || '').trim().toLowerCase() !== 'image_generation_call') return '';

  const localUrl = normalizeString(item.result_image_url);
  if (isRenderableImageUrl(localUrl)) return localUrl;

  const explicitImageUrl = normalizeString(item.image_url);
  if (isRenderableImageUrl(explicitImageUrl)) return explicitImageUrl;

  // 仅兼容已经带 MIME 的 data URL。裸 result Base64 必须先走本地化保存流程，
  // 否则正文和历史里都会被写入超大的图片字符串。
  const result = normalizeString(item.result);
  if (/^data:image\//i.test(result)) return result;

  return '';
}

function imageKey(imageUrlObject) {
  if (!imageUrlObject || typeof imageUrlObject !== 'object') return '';
  const hash = normalizeString(imageUrlObject.hash);
  if (hash) return `hash:${hash}`;
  const path = normalizeString(imageUrlObject.path);
  if (path) return `path:${path}`;
  const url = normalizeString(imageUrlObject.url);
  if (url) return `url:${url}`;
  return '';
}

function normalizeAnswerImageObject(imageUrlObject) {
  if (!imageUrlObject) return null;
  if (typeof imageUrlObject === 'string') {
    const url = normalizeString(imageUrlObject);
    return isRenderableImageUrl(url) ? { url } : null;
  }
  if (typeof imageUrlObject !== 'object' || Array.isArray(imageUrlObject)) return null;

  const next = { ...imageUrlObject };
  const url = normalizeString(next.url);
  const path = normalizeString(next.path);

  if (url && isRenderableImageUrl(url)) next.url = url;
  else delete next.url;

  if (path) next.path = path;
  else delete next.path;

  return (next.url || next.path) ? next : null;
}

export function dedupeResponsesImageGenerationAnswerImages(images) {
  const list = Array.isArray(images) ? images : [];
  const seen = new Set();
  const out = [];
  for (const image of list) {
    const normalized = normalizeAnswerImageObject(image);
    if (!normalized) continue;
    const key = imageKey(normalized);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

export function extractResponsesImageGenerationAnswerImages(outputItems) {
  const items = Array.isArray(outputItems) ? outputItems : [];
  const images = [];

  for (const item of items) {
    const imageUrl = normalizeResponsesImageGenerationAnswerImageUrl(item);
    if (!imageUrl) continue;

    const revisedPrompt = normalizeString(item?.revised_prompt);
    const image = {
      url: imageUrl,
      source: 'responses_image_generation'
    };
    if (revisedPrompt) image.revised_prompt = revisedPrompt;
    images.push(image);
  }

  return dedupeResponsesImageGenerationAnswerImages(images);
}

export function mergeResponsesImageGenerationAnswerImages(existingImages, incomingImages) {
  return dedupeResponsesImageGenerationAnswerImages([
    ...(Array.isArray(existingImages) ? existingImages : []),
    ...(Array.isArray(incomingImages) ? incomingImages : [])
  ]);
}

export function buildAssistantContentWithGeneratedImages(text, images) {
  const cleanText = (typeof text === 'string') ? text : '';
  const normalizedImages = dedupeResponsesImageGenerationAnswerImages(images);
  if (normalizedImages.length <= 0) return cleanText;

  const parts = normalizedImages.map((image) => ({
    type: 'image_url',
    image_url: image
  }));

  if (cleanText.trim()) {
    parts.push({
      type: 'text',
      text: cleanText
    });
  }

  return parts;
}
