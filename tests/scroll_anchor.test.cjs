const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadModule() {
  const filePath = path.resolve(__dirname, '../src/utils/scroll_anchor.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('computeStableScrollAnchorRatio 在只看到上边缘的长元素时返回 0', async () => {
  const { computeStableScrollAnchorRatio } = await loadModule();
  assert.equal(
    computeStableScrollAnchorRatio({
      elementTop: 60,
      elementHeight: 1000,
      viewportHeight: 800
    }),
    0
  );
});

test('computeStableScrollAnchorRatio 在只看到下边缘的长元素时返回 1', async () => {
  const { computeStableScrollAnchorRatio } = await loadModule();
  assert.equal(
    computeStableScrollAnchorRatio({
      elementTop: -200,
      elementHeight: 1000,
      viewportHeight: 800
    }),
    1
  );
});

test('computeStableScrollAnchorRatio 在长元素两边都看不到时按滚动进度平滑插值', async () => {
  const { computeStableScrollAnchorRatio } = await loadModule();
  assert.equal(
    computeStableScrollAnchorRatio({
      elementTop: -100,
      elementHeight: 1000,
      viewportHeight: 800
    }),
    0.5
  );
});

test('computeStableScrollAnchorRatio 在完整可见元素里按位置平滑插值', async () => {
  const { computeStableScrollAnchorRatio } = await loadModule();
  assert.equal(
    computeStableScrollAnchorRatio({
      elementTop: 300,
      elementHeight: 200,
      viewportHeight: 800
    }),
    0.5
  );
});

test('computeStableScrollCompensation 返回能保持同一锚点的 scrollTop 补偿量', async () => {
  const { computeStableScrollCompensation } = await loadModule();
  const compensation = computeStableScrollCompensation({
    beforeTop: 100,
    beforeHeight: 200,
    afterTop: 100,
    afterHeight: 400,
    viewportHeight: 800
  });
  assert.equal(compensation.anchorRatio, 100 / 600);
  assert.ok(Math.abs(compensation.scrollDelta - 33.33333333333334) < 1e-6);
});
