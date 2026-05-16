/**
 * DOM 坐标空间工具。
 *
 * 背景：
 * - 独立聊天页会在 documentElement 上设置 `zoom`，用于把 DPR 与用户缩放合并到同一套布局；
 * - MouseEvent.clientX/clientY 与 getBoundingClientRect() 返回的是视觉视口坐标；
 * - fixed/absolute 元素的 left/top、offsetWidth/offsetHeight 使用的是 zoom 之前的布局坐标。
 *
 * 因此凡是“从鼠标位置或 DOM rect 定位浮层/拖拽命中区”的代码，都应该先显式做坐标空间转换，
 * 避免在 standalone、DPR、用户缩放变化后出现菜单或气泡偏移。
 */

function getDefaultDocument() {
  return typeof document !== 'undefined' ? document : null;
}

function getDefaultWindow(doc = null) {
  return doc?.defaultView || (typeof window !== 'undefined' ? window : null);
}

function getDocumentFromOptions(options = {}) {
  return options.document || options.doc || getDefaultDocument();
}

function getWindowFromOptions(options = {}, doc = null) {
  return options.window || options.win || getDefaultWindow(doc);
}

function parsePositiveNumber(value) {
  const numeric = Number.parseFloat(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function getRootZoomValue(root, win) {
  const inlineZoom = parsePositiveNumber(root?.style?.zoom || '');
  if (inlineZoom > 0) return inlineZoom;
  const computedZoom = parsePositiveNumber(win?.getComputedStyle?.(root)?.zoom || '');
  if (computedZoom > 0) return computedZoom;
  return 1;
}

/**
 * 获取当前文档根节点实际使用的 CSS zoom。
 * @param {Object} [options]
 * @returns {number}
 */
export function getDocumentZoomFactor(options = {}) {
  const doc = getDocumentFromOptions(options);
  const win = getWindowFromOptions(options, doc);
  const root = doc?.documentElement || null;
  if (!root) return 1;
  return getRootZoomValue(root, win);
}

/**
 * 将视觉坐标/尺寸换算成布局坐标/尺寸。
 * @param {number} value
 * @param {number} [zoomFactor]
 * @returns {number}
 */
export function toLayoutPixels(value, zoomFactor = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const safeZoom = Number(zoomFactor);
  if (!Number.isFinite(safeZoom) || safeZoom <= 0) return numeric;
  return numeric / safeZoom;
}

function resolveZoomFactor(options = {}) {
  const provided = Number(options.zoomFactor);
  return Number.isFinite(provided) && provided > 0
    ? provided
    : getDocumentZoomFactor(options);
}

/**
 * 把 getBoundingClientRect() 的视觉 rect 转为布局 rect。
 * @param {DOMRect|Object|null} rect
 * @param {Object} [options]
 * @returns {{left:number, top:number, right:number, bottom:number, width:number, height:number}}
 */
export function toLayoutRect(rect, options = {}) {
  const zoomFactor = resolveZoomFactor(options);
  const left = toLayoutPixels(rect?.left, zoomFactor);
  const top = toLayoutPixels(rect?.top, zoomFactor);
  const width = toLayoutPixels(rect?.width, zoomFactor);
  const height = toLayoutPixels(rect?.height, zoomFactor);
  const right = Number.isFinite(Number(rect?.right)) ? toLayoutPixels(rect.right, zoomFactor) : left + width;
  const bottom = Number.isFinite(Number(rect?.bottom)) ? toLayoutPixels(rect.bottom, zoomFactor) : top + height;
  return { left, top, right, bottom, width, height };
}

/**
 * 读取元素在布局坐标空间中的 rect。
 * @param {Element|null} element
 * @param {Object} [options]
 * @returns {{left:number, top:number, right:number, bottom:number, width:number, height:number}}
 */
export function getElementLayoutRect(element, options = {}) {
  const rect = element?.getBoundingClientRect?.() || null;
  return toLayoutRect(rect, options);
}

/**
 * 读取元素的布局尺寸。优先使用 offsetWidth/offsetHeight，因为它们本来就是布局坐标；
 * 只有在元素还未形成稳定布局时才回退到 rect 换算。
 * @param {Element|null} element
 * @param {Object} [options]
 * @returns {{width:number, height:number}}
 */
export function getElementLayoutSize(element, options = {}) {
  const offsetWidth = Number(element?.offsetWidth);
  const offsetHeight = Number(element?.offsetHeight);
  if (Number.isFinite(offsetWidth) && offsetWidth > 0 && Number.isFinite(offsetHeight) && offsetHeight >= 0) {
    return { width: offsetWidth, height: offsetHeight };
  }
  const rect = getElementLayoutRect(element, options);
  return { width: rect.width, height: rect.height };
}

/**
 * 获取 fixed 元素可用的布局视口尺寸。
 * 注意：visualViewport/window.innerWidth 是视觉坐标，需要除以 zoom；没有 window 时再退回 docEl.clientWidth。
 * @param {Object} [options]
 * @returns {{width:number, height:number}}
 */
export function getLayoutViewportSize(options = {}) {
  const doc = getDocumentFromOptions(options);
  const win = getWindowFromOptions(options, doc);
  const root = doc?.documentElement || null;
  const zoomFactor = resolveZoomFactor({ ...options, document: doc, window: win });

  const visualWidth = parsePositiveNumber(win?.visualViewport?.width)
    || parsePositiveNumber(win?.innerWidth);
  const visualHeight = parsePositiveNumber(win?.visualViewport?.height)
    || parsePositiveNumber(win?.innerHeight);

  const fallbackWidth = parsePositiveNumber(root?.clientWidth);
  const fallbackHeight = parsePositiveNumber(root?.clientHeight);
  const width = visualWidth > 0 ? toLayoutPixels(visualWidth, zoomFactor) : fallbackWidth;
  const height = visualHeight > 0 ? toLayoutPixels(visualHeight, zoomFactor) : fallbackHeight;
  return { width, height };
}

/**
 * 将鼠标事件点从视觉坐标换成布局坐标。
 * @param {MouseEvent|PointerEvent|Object|null} event
 * @param {Object} [options]
 * @returns {{x:number, y:number}}
 */
export function getClientPointLayoutPosition(event, options = {}) {
  const zoomFactor = resolveZoomFactor(options);
  return {
    x: toLayoutPixels(event?.clientX, zoomFactor),
    y: toLayoutPixels(event?.clientY, zoomFactor)
  };
}

/**
 * 在布局视口内夹紧 fixed 浮层位置。
 * @param {{left:number, top:number, width:number, height:number}} placement
 * @param {Object} [options]
 * @returns {{left:number, top:number}}
 */
export function clampLayoutOverlayPosition(placement, options = {}) {
  const viewport = options.viewport || getLayoutViewportSize(options);
  const zoomFactor = resolveZoomFactor(options);
  const margin = toLayoutPixels(options.viewportMarginPx || 0, zoomFactor);
  const width = Math.max(0, Number(placement?.width) || 0);
  const height = Math.max(0, Number(placement?.height) || 0);
  const viewportWidth = Math.max(0, Number(viewport?.width) || 0);
  const viewportHeight = Math.max(0, Number(viewport?.height) || 0);
  const minLeft = margin;
  const minTop = margin;
  const maxLeft = Math.max(minLeft, viewportWidth - width - margin);
  const maxTop = Math.max(minTop, viewportHeight - height - margin);
  const rawLeft = Number(placement?.left);
  const rawTop = Number(placement?.top);
  const left = Math.min(maxLeft, Math.max(minLeft, Number.isFinite(rawLeft) ? rawLeft : minLeft));
  const top = Math.min(maxTop, Math.max(minTop, Number.isFinite(rawTop) ? rawTop : minTop));
  return { left, top };
}

/**
 * 从鼠标事件计算 fixed 浮层位置，常用于右键菜单。
 * @param {MouseEvent|PointerEvent|Object|null} event
 * @param {Element|null} overlay
 * @param {Object} [options]
 * @returns {{left:number, top:number, width:number, height:number, zoomFactor:number}}
 */
export function resolveFixedOverlayPositionFromClientPoint(event, overlay, options = {}) {
  const zoomFactor = resolveZoomFactor(options);
  const point = getClientPointLayoutPosition(event, { ...options, zoomFactor });
  const size = getElementLayoutSize(overlay, { ...options, zoomFactor });
  const clamped = clampLayoutOverlayPosition({
    left: point.x,
    top: point.y,
    width: size.width,
    height: size.height
  }, { ...options, zoomFactor });
  return {
    ...clamped,
    width: size.width,
    height: size.height,
    zoomFactor
  };
}
