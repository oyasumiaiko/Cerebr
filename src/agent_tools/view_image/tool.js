import {
  PROMPT_IMAGE_DETAIL_ORIGINAL,
  buildPromptImageDetailSchemaDescription,
  normalizePromptImageDetail
} from '../shared/prompt_image_tool_shared.js';

/**
 * 读取图片工具定义。
 *
 * 目标：
 * - 尽量贴近 Codex `view_image` 的参数面与 `detail` 语义；
 * - 允许模型读取“用户显式指定”的图片来源，而不是只局限在当前网页截图；
 * - 传给模型前统一走 prompt 友好的 JPEG 转码链路。
 */

export const VIEW_IMAGE_TOOL_NAME = 'view_image';

function normalizeString(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

function resolveRawImagePath(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  return normalizeString(args.path || args.url || args.image_url);
}

export function normalizeViewImageArguments(rawArgs) {
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs))
    ? rawArgs
    : {};
  const path = resolveRawImagePath(args);
  const detail = normalizePromptImageDetail(args.detail, VIEW_IMAGE_TOOL_NAME);

  if (!path) {
    throw new Error('view_image 参数错误：path 需要提供非空字符串。');
  }

  return { path, detail };
}

export function buildViewImageFunctionToolDefinition() {
  return {
    type: 'function',
    name: VIEW_IMAGE_TOOL_NAME,
    description: [
      'Read a specific image so the model can inspect visual content directly.',
      'Use this when the user points to an image file or image URL that should be examined in detail.',
      'The `path` field may be a local filesystem path, file URL, http(s) URL, data URL, or a saved `Images/...` relative path.',
      `The only supported detail override is \`${PROMPT_IMAGE_DETAIL_ORIGINAL}\`; omit it for the default compressed prompt-friendly image.`
    ].join(' '),
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description: 'Image source to read. Supports local filesystem paths, file URLs, http(s) URLs, data URLs, and saved `Images/...` relative paths.'
        },
        detail: {
          type: ['string', 'null'],
          description: buildPromptImageDetailSchemaDescription()
        }
      },
      required: ['path']
    }
  };
}
