import {
  WEBPAGE_SCREENSHOT_PROMPT_JPEG_QUALITY,
  WEBPAGE_SCREENSHOT_PROMPT_MAX_HEIGHT,
  WEBPAGE_SCREENSHOT_PROMPT_MAX_WIDTH
} from '../agent_tools/webpage_screenshot_tool.js';

const DATA_URL_PATTERN = /^data:([^;,]+)(;base64)?,/i;

function extractMimeTypeFromDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return 'image/png';
  const match = dataUrl.match(DATA_URL_PATTERN);
  return (match?.[1] || 'image/png').toLowerCase();
}

function clampJpegQuality(quality) {
  const numeric = Number(quality);
  if (!Number.isFinite(numeric)) return WEBPAGE_SCREENSHOT_PROMPT_JPEG_QUALITY;
  return Math.max(0.1, Math.min(1, numeric));
}

function estimateDataUrlBytes(dataUrl) {
  if (typeof dataUrl !== 'string') return 0;
  const commaIndex = dataUrl.indexOf(',');
  const base64 = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
  if (!base64) return 0;
  return Math.round((base64.length * 3) / 4);
}

function computeResizeToFitSize(width, height) {
  const safeWidth = Number(width);
  const safeHeight = Number(height);
  if (!Number.isFinite(safeWidth) || !Number.isFinite(safeHeight) || safeWidth <= 0 || safeHeight <= 0) {
    return {
      width: WEBPAGE_SCREENSHOT_PROMPT_MAX_WIDTH,
      height: WEBPAGE_SCREENSHOT_PROMPT_MAX_HEIGHT,
      resized: true
    };
  }

  if (safeWidth <= WEBPAGE_SCREENSHOT_PROMPT_MAX_WIDTH && safeHeight <= WEBPAGE_SCREENSHOT_PROMPT_MAX_HEIGHT) {
    return {
      width: Math.round(safeWidth),
      height: Math.round(safeHeight),
      resized: false
    };
  }

  const scale = Math.min(
    WEBPAGE_SCREENSHOT_PROMPT_MAX_WIDTH / safeWidth,
    WEBPAGE_SCREENSHOT_PROMPT_MAX_HEIGHT / safeHeight
  );
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
    resized: true
  };
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  if (!response.ok) {
    throw new Error(`读取截图 data URL 失败：HTTP ${response.status}`);
  }
  return await response.blob();
}

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function blobToDataUrl(blob, fallbackMimeType) {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const mimeType = (typeof blob.type === 'string' && blob.type) ? blob.type : fallbackMimeType;
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

/**
 * 将截图 data URL 压成更适合 prompt 的图片。
 *
 * 和 Codex `view_image` 的相同点：
 * - 默认把图片控制在 2048x768 的可消费上限内；
 * - `detail: original` 代表保留原始分辨率。
 *
 * 针对网页截图的差异：
 * - 截图源天然来自浏览器生成的 PNG；
 * - 默认优先转成 JPEG(quality=0.85)，显著降低 data URL 体积；
 * - 只有显式请求 `original` 时，才保留原始截图字节。
 *
 * @param {{
 *   dataUrl:string,
 *   detail:'original'|null,
 *   jpegQuality?:number
 * }} options
 * @returns {Promise<{
 *   image_url:string,
 *   detail:'original'|null,
 *   mime_type:string,
 *   original_mime_type:string,
 *   width:number|null,
 *   height:number|null,
 *   original_width:number|null,
 *   original_height:number|null,
 *   resized:boolean,
 *   approximate_bytes:number
 * }>}
 */
export async function buildPromptImageResultFromScreenshotDataUrl(options = {}) {
  const dataUrl = (typeof options?.dataUrl === 'string') ? options.dataUrl.trim() : '';
  if (!dataUrl) {
    throw new Error('截图数据为空，无法构造 prompt 图片。');
  }

  const detail = options?.detail === 'original' ? 'original' : null;
  const originalMimeType = extractMimeTypeFromDataUrl(dataUrl);

  if (detail === 'original') {
    return {
      image_url: dataUrl,
      detail: 'original',
      mime_type: originalMimeType,
      original_mime_type: originalMimeType,
      width: null,
      height: null,
      original_width: null,
      original_height: null,
      resized: false,
      approximate_bytes: estimateDataUrlBytes(dataUrl)
    };
  }

  const sourceBlob = await dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(sourceBlob);

  try {
    const targetSize = computeResizeToFitSize(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(targetSize.width, targetSize.height);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) {
      throw new Error('无法创建截图压缩所需的 2D canvas 上下文。');
    }

    context.clearRect(0, 0, targetSize.width, targetSize.height);
    context.drawImage(bitmap, 0, 0, targetSize.width, targetSize.height);

    const outputBlob = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: clampJpegQuality(options?.jpegQuality)
    });
    const outputMimeType = (typeof outputBlob.type === 'string' && outputBlob.type)
      ? outputBlob.type
      : 'image/jpeg';

    return {
      image_url: await blobToDataUrl(outputBlob, outputMimeType),
      detail: null,
      mime_type: outputMimeType,
      original_mime_type: originalMimeType,
      width: targetSize.width,
      height: targetSize.height,
      original_width: bitmap.width,
      original_height: bitmap.height,
      resized: targetSize.resized,
      approximate_bytes: outputBlob.size
    };
  } finally {
    bitmap.close();
  }
}
