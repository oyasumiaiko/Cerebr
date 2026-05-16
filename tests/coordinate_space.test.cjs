const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadModule() {
  const filePath = path.resolve(__dirname, '../src/utils/coordinate_space.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('coordinate_space 将独立页 zoom 下的视觉坐标换算为布局坐标', async () => {
  const {
    getClientPointLayoutPosition,
    getDocumentZoomFactor,
    getLayoutViewportSize,
    toLayoutPixels
  } = await loadModule();

  const win = {
    innerWidth: 1200,
    innerHeight: 800,
    getComputedStyle: () => ({ zoom: '1' })
  };
  const doc = {
    defaultView: win,
    documentElement: {
      clientWidth: 1200,
      clientHeight: 800,
      style: { zoom: '0.5' }
    }
  };

  assert.equal(getDocumentZoomFactor({ document: doc, window: win }), 0.5);
  assert.equal(toLayoutPixels(240, 0.5), 480);
  assert.deepEqual(
    getClientPointLayoutPosition({ clientX: 300, clientY: 150 }, { zoomFactor: 0.5 }),
    { x: 600, y: 300 }
  );
  assert.deepEqual(
    getLayoutViewportSize({ document: doc, window: win, zoomFactor: 0.5 }),
    { width: 2400, height: 1600 }
  );
});

test('coordinate_space 使用布局尺寸夹紧 fixed 浮层位置', async () => {
  const {
    getElementLayoutRect,
    resolveFixedOverlayPositionFromClientPoint
  } = await loadModule();

  const overlay = {
    offsetWidth: 200,
    offsetHeight: 100,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 100,
      bottom: 50,
      width: 100,
      height: 50
    })
  };
  const win = {
    innerWidth: 1000,
    innerHeight: 800,
    getComputedStyle: () => ({ zoom: '0.5' })
  };
  const doc = {
    defaultView: win,
    documentElement: {
      clientWidth: 1000,
      clientHeight: 800,
      style: { zoom: '0.5' }
    }
  };

  assert.deepEqual(getElementLayoutRect(overlay, { zoomFactor: 0.5 }), {
    left: 0,
    top: 0,
    right: 200,
    bottom: 100,
    width: 200,
    height: 100
  });
  assert.deepEqual(
    resolveFixedOverlayPositionFromClientPoint(
      { clientX: 940, clientY: 780 },
      overlay,
      { document: doc, window: win, zoomFactor: 0.5 }
    ),
    { left: 1800, top: 1500, width: 200, height: 100, zoomFactor: 0.5 }
  );
});
