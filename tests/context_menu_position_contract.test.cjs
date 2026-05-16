const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  return fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

test('右键菜单和子菜单统一使用 zoom-aware 布局坐标定位', async () => {
  const source = await readWorkspaceFile('src/ui/context_menu_manager.js');

  assert.match(
    source,
    /from '\.\.\/utils\/coordinate_space\.js';/
  );
  assert.match(
    source,
    /function resolveSubmenuPlacement\(menuItem, submenu, placementOptions = null\) \{[\s\S]*?const zoomFactor = getDocumentZoomFactor\(\);[\s\S]*?getElementLayoutRect\(menuItem, \{ zoomFactor \}\)[\s\S]*?getLayoutViewportSize\(\{ zoomFactor \}\)[\s\S]*?toLayoutPixels\(SUBMENU_EDGE_GAP_PX, zoomFactor\)/s
  );
  assert.match(
    source,
    /const menuPlacement = resolveFixedOverlayPositionFromClientPoint\(e, contextMenu\);[\s\S]*?contextMenu\.style\.left = `\$\{Math\.round\(menuPlacement\.left\)\}px`;[\s\S]*?contextMenu\.style\.top = `\$\{Math\.round\(menuPlacement\.top\)\}px`;/s
  );
  assert.doesNotMatch(
    source,
    /let x = e\.clientX;[\s\S]*?contextMenu\.style\.left = x \+ 'px';/
  );
});
