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
export const WEBPAGE_SCREENSHOT_PROMPT_MAX_WIDTH = 2048;
export const WEBPAGE_SCREENSHOT_PROMPT_MAX_HEIGHT = 768;
export const WEBPAGE_SCREENSHOT_PROMPT_JPEG_QUALITY = 0.85;

function normalizeString(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

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
  const detail = normalizeString(args.detail);

  if (!detail) {
    return { detail: null };
  }
  if (detail === 'original') {
    return { detail: 'original' };
  }

  throw new Error(
    `webpage_screenshot.detail 只支持 \`original\`；默认压缩模式请省略该字段，当前收到：\`${detail}\``
  );
}

export function buildWebpageScreenshotFunctionToolDefinition() {
  return {
    type: 'function',
    name: WEBPAGE_SCREENSHOT_TOOL_NAME,
    description: [
      'Capture a screenshot of the currently bound webpage so the model can inspect visual layout and non-text details.',
      'Use this when the user refers to what is visible on the page, or when text extraction alone is insufficient.',
      'The only supported detail override is `original`; omit it for the default compressed prompt-friendly screenshot.'
    ].join(' '),
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        detail: {
          type: ['string', 'null'],
          description: 'Optional detail override. The only supported value is `original`; omit this field for default compressed behavior.'
        }
      }
    }
  };
}
