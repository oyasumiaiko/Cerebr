import {
  PROMPT_IMAGE_JPEG_QUALITY,
  PROMPT_IMAGE_MAX_HEIGHT,
  PROMPT_IMAGE_MAX_WIDTH
} from '../agent_tools/shared/prompt_image_tool_shared.js';

const SOURCE_FALLBACK_MIME_TYPE = 'image/png';
const OUTPUT_JPEG_MIME_TYPE = 'image/jpeg';
const DATA_URL_PATTERN = /^data:([^;,]+)(;base64)?,/i;

function extractMimeTypeFromDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return SOURCE_FALLBACK_MIME_TYPE;
  const match = dataUrl.match(DATA_URL_PATTERN);
  return (match?.[1] || SOURCE_FALLBACK_MIME_TYPE).toLowerCase();
}

function clampJpegQuality(quality) {
  const numeric = Number(quality);
  if (!Number.isFinite(numeric)) return PROMPT_IMAGE_JPEG_QUALITY;
  return Math.max(0.1, Math.min(1, numeric));
}

function computeResizeToFitSize(width, height) {
  const safeWidth = Number(width);
  const safeHeight = Number(height);
  if (!Number.isFinite(safeWidth) || !Number.isFinite(safeHeight) || safeWidth <= 0 || safeHeight <= 0) {
    return {
      width: PROMPT_IMAGE_MAX_WIDTH,
      height: PROMPT_IMAGE_MAX_HEIGHT,
      resized: true
    };
  }

  if (safeWidth <= PROMPT_IMAGE_MAX_WIDTH && safeHeight <= PROMPT_IMAGE_MAX_HEIGHT) {
    return {
      width: Math.round(safeWidth),
      height: Math.round(safeHeight),
      resized: false
    };
  }

  const scale = Math.min(
    PROMPT_IMAGE_MAX_WIDTH / safeWidth,
    PROMPT_IMAGE_MAX_HEIGHT / safeHeight
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

function buildTargetSizeForBitmap(bitmap, detail) {
  const width = Math.round(Number(bitmap?.width));
  const height = Math.round(Number(bitmap?.height));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('截图尺寸无效，无法生成 prompt 图片。');
  }

  if (detail === 'original') {
    return {
      width,
      height,
      resized: false
    };
  }
  return computeResizeToFitSize(width, height);
}

async function renderBitmapToJpegBlob(bitmap, targetSize, jpegQuality) {
  const canvas = new OffscreenCanvas(targetSize.width, targetSize.height);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    throw new Error('无法创建截图压缩所需的 2D canvas 上下文。');
  }

  context.clearRect(0, 0, targetSize.width, targetSize.height);
  context.drawImage(bitmap, 0, 0, targetSize.width, targetSize.height);

  const outputBlob = await canvas.convertToBlob({
    type: OUTPUT_JPEG_MIME_TYPE,
    quality: clampJpegQuality(jpegQuality)
  });
  const outputMimeType = (typeof outputBlob.type === 'string' && outputBlob.type)
    ? outputBlob.type
    : OUTPUT_JPEG_MIME_TYPE;
  return {
    outputBlob,
    outputMimeType
  };
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
 * - 不论默认还是 `detail: original`，最终都统一转成 JPEG，避免上层再分 MIME；
 * - `detail: original` 只保留原始分辨率，不再保留原始截图字节。
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

  const sourceBlob = await dataUrlToBlob(dataUrl);
  return buildPromptImageResultFromImageBlob({
    sourceBlob,
    detail: options?.detail === 'original' ? 'original' : null,
    jpegQuality: options?.jpegQuality,
    originalMimeType: extractMimeTypeFromDataUrl(dataUrl)
  });
}

/**
 * 将任意已读取到内存中的图片 Blob 规范化成 prompt 友好的 JPEG。
 *
 * 说明：
 * - 这里不关心图片来自截图、URL 还是本地文件；
 * - 只负责尺寸控制、JPEG 转码和最终 `input_image` 需要的 data URL 结构；
 * - 因此网页截图工具与 `view_image` 都复用这一层。
 *
 * @param {{
 *   sourceBlob:Blob|{type?:string,arrayBuffer:()=>Promise<ArrayBuffer>},
 *   detail:'original'|null,
 *   jpegQuality?:number,
 *   originalMimeType?:string
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
export async function buildPromptImageResultFromImageBlob(options = {}) {
  const sourceBlob = options?.sourceBlob;
  if (!sourceBlob || typeof sourceBlob !== 'object' || typeof sourceBlob.arrayBuffer !== 'function') {
    throw new Error('图片数据为空，无法构造 prompt 图片。');
  }

  const detail = options?.detail === 'original' ? 'original' : null;
  const explicitOriginalMimeType = (typeof options?.originalMimeType === 'string' && options.originalMimeType.trim())
    ? options.originalMimeType.trim().toLowerCase()
    : '';
  const originalMimeType = explicitOriginalMimeType
    || ((typeof sourceBlob.type === 'string' && sourceBlob.type.trim())
      ? sourceBlob.type.trim().toLowerCase()
      : SOURCE_FALLBACK_MIME_TYPE);
  const bitmap = await createImageBitmap(sourceBlob);

  try {
    const targetSize = buildTargetSizeForBitmap(bitmap, detail);
    const { outputBlob, outputMimeType } = await renderBitmapToJpegBlob(
      bitmap,
      targetSize,
      options?.jpegQuality
    );

    return {
      image_url: await blobToDataUrl(outputBlob, outputMimeType),
      detail,
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
