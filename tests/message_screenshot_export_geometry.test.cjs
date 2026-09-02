const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadGeometryModule() {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, '..', 'src', 'utils', 'message_screenshot_export.js')
  );
  return import(`${moduleUrl.href}?test=${Date.now()}-${Math.random()}`);
}

test('消息截图在 Chromium 65535px 单边边界内保持请求倍率', async () => {
  const {
    MESSAGE_SCREENSHOT_CANVAS_MAX_DIMENSION_PX,
    resolveMessageScreenshotRenderPlan
  } = await loadGeometryModule();

  const plan = resolveMessageScreenshotRenderPlan({
    width: 1000,
    height: 65505,
    paddingPx: 15,
    requestedScale: 1
  });

  assert.equal(MESSAGE_SCREENSHOT_CANVAS_MAX_DIMENSION_PX, 65535);
  assert.equal(plan.scaleAdjusted, false);
  assert.equal(plan.appliedScale, 1);
  assert.equal(plan.finalHeight, 65535);
  assert.ok(plan.finalWidth <= 65535);
});

test('消息截图超过 65535px 时预先收敛到可编码的最大倍率', async () => {
  const { resolveMessageScreenshotRenderPlan } = await loadGeometryModule();

  const plan = resolveMessageScreenshotRenderPlan({
    width: 1200,
    height: 20000,
    paddingPx: 15,
    requestedScale: 4
  });

  assert.equal(plan.scaleAdjusted, true);
  assert.ok(plan.appliedScale < 4);
  assert.ok(plan.appliedScale > 3);
  assert.ok(plan.finalWidth <= 65535);
  assert.ok(plan.finalHeight <= 65535);
  assert.equal(plan.finalHeight, 65535);
});

test('默认 1x 的超长截图也完整缩放到单张 PNG 可编码范围', async () => {
  const { resolveMessageScreenshotRenderPlan } = await loadGeometryModule();

  const plan = resolveMessageScreenshotRenderPlan({
    width: 900,
    height: 70000,
    paddingPx: 15,
    requestedScale: 1
  });

  assert.equal(plan.scaleAdjusted, true);
  assert.ok(plan.appliedScale < 1);
  assert.ok(plan.appliedScale > 0);
  assert.ok(plan.finalWidth >= 1 && plan.finalWidth <= 65535);
  assert.ok(plan.finalHeight >= 1 && plan.finalHeight <= 65535);
});
