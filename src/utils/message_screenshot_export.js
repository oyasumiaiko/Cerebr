export const MESSAGE_SCREENSHOT_CANVAS_MAX_DIMENSION_PX = 65535;

function normalizePositiveNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

/**
 * 按当前 dom-to-image + padding 管线的实际取整规则，计算最终 Canvas 像素尺寸。
 *
 * dom-to-image 会把 CSS 尺寸乘以 scale 后直接赋给 canvas.width / canvas.height，
 * 浏览器对正数会截断为整数；截图外边距则在现有实现中使用 Math.round。
 * 这里必须复用同一套规则，不能只用 `(size + padding * 2) * scale` 粗略估计，
 * 否则在 65535px 的硬边界附近会出现 1px 的误判。
 */
export function calculateMessageScreenshotPixelGeometry({
  width,
  height,
  paddingPx = 0,
  scale = 1
} = {}) {
  const sourceWidth = normalizePositiveNumber(width, 1);
  const sourceHeight = normalizePositiveNumber(height, 1);
  const logicalPadding = Math.max(0, Number.isFinite(Number(paddingPx)) ? Number(paddingPx) : 0);
  const resolutionScale = normalizePositiveNumber(scale, 1);

  const renderedWidth = Math.max(1, Math.floor(sourceWidth * resolutionScale));
  const renderedHeight = Math.max(1, Math.floor(sourceHeight * resolutionScale));
  const paddingPixels = Math.max(0, Math.round(logicalPadding * resolutionScale));

  return {
    renderedWidth,
    renderedHeight,
    paddingPixels,
    finalWidth: renderedWidth + 2 * paddingPixels,
    finalHeight: renderedHeight + 2 * paddingPixels
  };
}

function fitsCanvasDimensionLimit(geometry, maxDimensionPx) {
  return geometry.finalWidth <= maxDimensionPx && geometry.finalHeight <= maxDimensionPx;
}

/**
 * 为消息截图解析实际渲染倍率。
 *
 * Chromium 151 的 Canvas PNG 编码在任一边达到 65536px 时，`toBlob()` 不抛异常，
 * 而是把 null 传给回调；65535px 仍可正常编码。长消息或多消息截图在 4x 导出时
 * 很容易踩到这个边界。这里在渲染前求出不超过硬上限的最大倍率，完整保留内容，
 * 并把“是否调整倍率”作为显式结果交给 UI 展示，避免静默降级。
 */
export function resolveMessageScreenshotRenderPlan({
  width,
  height,
  paddingPx = 0,
  requestedScale = 1,
  maxDimensionPx = MESSAGE_SCREENSHOT_CANVAS_MAX_DIMENSION_PX
} = {}) {
  const normalizedWidth = normalizePositiveNumber(width, 1);
  const normalizedHeight = normalizePositiveNumber(height, 1);
  const normalizedPadding = Math.max(0, Number.isFinite(Number(paddingPx)) ? Number(paddingPx) : 0);
  const normalizedRequestedScale = normalizePositiveNumber(requestedScale, 1);
  const normalizedMaxDimension = Math.max(1, Math.floor(normalizePositiveNumber(maxDimensionPx, MESSAGE_SCREENSHOT_CANVAS_MAX_DIMENSION_PX)));

  const requestedGeometry = calculateMessageScreenshotPixelGeometry({
    width: normalizedWidth,
    height: normalizedHeight,
    paddingPx: normalizedPadding,
    scale: normalizedRequestedScale
  });

  if (fitsCanvasDimensionLimit(requestedGeometry, normalizedMaxDimension)) {
    return {
      requestedScale: normalizedRequestedScale,
      appliedScale: normalizedRequestedScale,
      scaleAdjusted: false,
      maxDimensionPx: normalizedMaxDimension,
      ...requestedGeometry
    };
  }

  // 二分求“仍满足最终取整尺寸限制”的最大倍率。
  // 直接套比例公式会在 padding 的 Math.round 边界上产生 1px 偏差，因此这里用
  // 与真实 Canvas 完全一致的像素几何函数判定，计算成本固定且极低。
  let low = 0;
  let high = normalizedRequestedScale;
  let bestGeometry = null;

  for (let iteration = 0; iteration < 48; iteration += 1) {
    const midpoint = (low + high) / 2;
    const geometry = calculateMessageScreenshotPixelGeometry({
      width: normalizedWidth,
      height: normalizedHeight,
      paddingPx: normalizedPadding,
      scale: midpoint
    });
    if (fitsCanvasDimensionLimit(geometry, normalizedMaxDimension)) {
      low = midpoint;
      bestGeometry = geometry;
    } else {
      high = midpoint;
    }
  }

  const appliedScale = low;
  const geometry = bestGeometry || calculateMessageScreenshotPixelGeometry({
    width: normalizedWidth,
    height: normalizedHeight,
    paddingPx: normalizedPadding,
    scale: appliedScale
  });

  if (!(appliedScale > 0) || !fitsCanvasDimensionLimit(geometry, normalizedMaxDimension)) {
    throw new Error(
      `截图尺寸无法适配单张 PNG：内容 ${Math.round(normalizedWidth)}×${Math.round(normalizedHeight)} CSS px，` +
      `Canvas 单边上限 ${normalizedMaxDimension}px`
    );
  }

  return {
    requestedScale: normalizedRequestedScale,
    appliedScale,
    scaleAdjusted: appliedScale < normalizedRequestedScale,
    maxDimensionPx: normalizedMaxDimension,
    ...geometry
  };
}
