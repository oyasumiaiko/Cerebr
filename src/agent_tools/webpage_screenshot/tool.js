import {
  PROMPT_IMAGE_DETAIL_ORIGINAL,
  PROMPT_IMAGE_JPEG_QUALITY,
  PROMPT_IMAGE_MAX_HEIGHT,
  PROMPT_IMAGE_MAX_WIDTH,
  buildPromptImageDetailSchemaDescription,
  normalizePromptImageDetail
} from '../shared/prompt_image_tool_shared.js';
import {
  buildModelToolDescription,
  buildStrictFunctionToolDefinition
} from '../shared/model_tool_contract.js';

/**
 * 网页截图工具定义。
 *
 * 设计目标：
 * - 契约尽量贴近 Codex 的 `view_image`：默认给模型一张可直接消费的图片；
 * - 这把工具不接收路径，而是固定读取“当前侧栏绑定网页”的可见区域截图；
 * - 默认走 prompt 友好的压缩路径，避免把大尺寸 PNG data URL 原样塞进上下文；
 * - 仅保留一个极小参数面：`detail`，目前只支持 `original`。
 */

export const WEBPAGE_SCREENSHOT_TOOL_NAME = 'webpage_screenshot';
export const WEBPAGE_SCREENSHOT_PROMPT_MAX_WIDTH = PROMPT_IMAGE_MAX_WIDTH;
export const WEBPAGE_SCREENSHOT_PROMPT_MAX_HEIGHT = PROMPT_IMAGE_MAX_HEIGHT;
export const WEBPAGE_SCREENSHOT_PROMPT_JPEG_QUALITY = PROMPT_IMAGE_JPEG_QUALITY;

/**
 * 规范化截图工具参数。
 *
 * 当前规则刻意保持和 Codex `view_image` 一致：
 * - 省略 / null：走默认压缩路径；
 * - `"original"`：请求保留原始分辨率；
 * - 其它值一律视为显式错误，而不是私自猜测。
 *
 * @param {any} rawArgs
 * @returns {{detail:'original'|null}}
 */
export function normalizeWebpageScreenshotArguments(rawArgs) {
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs))
    ? rawArgs
    : {};
  return {
    detail: normalizePromptImageDetail(args.detail, WEBPAGE_SCREENSHOT_TOOL_NAME)
  };
}

export function buildWebpageScreenshotFunctionToolDefinition() {
  return buildStrictFunctionToolDefinition({
    name: WEBPAGE_SCREENSHOT_TOOL_NAME,
    description: buildModelToolDescription({
      purpose: '截取当前侧栏绑定网页的可见区域，让模型直接检查布局、图像和无法可靠提取的视觉细节。',
      useWhen: [
        '用户询问当前页面“看起来怎样”、布局位置、图表、画布或图片内容',
        'page_content_read 的文本不足以回答视觉问题'
      ],
      avoidWhen: '只需要网页正文时使用 page_content_read；要读取指定图片文件或 URL 时使用 view_image；截图不是整页滚动捕获。',
      input: 'detail=null 使用压缩后的 prompt 友好 JPEG；detail=`original` 保留原始分辨率但仍统一为 JPEG。',
      output: '成功时 function_call_output 只返回一项 input_image，模型会在下一轮直接看到截图；失败时返回 <webpage_screenshot_result> 与错误信息。',
      notes: '截图前会临时隐藏侧栏，避免把 Cerebr 对话 UI 自己拍进网页。'
    }),
    properties: {
      detail: {
        type: ['string', 'null'],
        enum: [PROMPT_IMAGE_DETAIL_ORIGINAL, null],
        description: buildPromptImageDetailSchemaDescription()
      }
    }
  });
}
