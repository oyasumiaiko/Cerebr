/**
 * prompt 图片类工具的共享合同。
 *
 * 目前仓库里有两类会把图片作为 `input_image` 回传给模型的工具：
 * 1. `webpage_screenshot`
 * 2. `view_image`
 *
 * 两者都约定：
 * - 默认返回更适合 prompt 的缩放图；
 * - 仅支持 `detail: "original"` 这一种显式大图模式；
 * - 无论默认还是 original，都统一输出 JPEG。
 */

export const PROMPT_IMAGE_MAX_WIDTH = 2048;
export const PROMPT_IMAGE_MAX_HEIGHT = 768;
export const PROMPT_IMAGE_JPEG_QUALITY = 0.85;
export const PROMPT_IMAGE_DETAIL_ORIGINAL = 'original';

function normalizeString(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

export function normalizePromptImageDetail(rawDetail, toolName) {
  const detail = normalizeString(rawDetail);
  if (!detail) return null;
  if (detail === PROMPT_IMAGE_DETAIL_ORIGINAL) {
    return PROMPT_IMAGE_DETAIL_ORIGINAL;
  }
  throw new Error(
    `${toolName}.detail 只支持 \`${PROMPT_IMAGE_DETAIL_ORIGINAL}\`；默认压缩模式请省略该字段，当前收到：\`${detail}\``
  );
}

export function buildPromptImageDetailSchemaDescription() {
  return 'Optional detail override. The only supported value is `original`; omit this field for default compressed behavior.';
}
