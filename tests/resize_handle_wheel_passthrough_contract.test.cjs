const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  return fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

test('全屏宽度调整条默认 wheel 穿透，同时保留坐标捕获拖宽', async () => {
  const [sidebarCss, selectionThreadManagerSource] = await Promise.all([
    readWorkspaceFile('src/ui/styles/sidebar.css'),
    readWorkspaceFile('src/ui/selection_thread_manager.js')
  ]);

  assert.match(
    sidebarCss,
    /--cerebr-resize-handle-hover-opacity:\s*0\.32;/
  );
  assert.match(
    sidebarCss,
    /--cerebr-resize-handle-active-opacity:\s*0\.72;/
  );
  assert.match(
    sidebarCss,
    /\.fullscreen-mode body\.thread-mode-active #thread-splitter,[\s\S]*?#thread-resize-edge-right\s*\{[\s\S]*?pointer-events:\s*none;/s
  );
  assert.match(
    sidebarCss,
    /\.fullscreen-mode body:not\(\.thread-mode-active\) #thread-resize-edge-left,[\s\S]*?#thread-resize-edge-right\s*\{[\s\S]*?pointer-events:\s*none;/s
  );
  assert.match(
    sidebarCss,
    /#thread-resize-edge-left\.resize-hit-hover[\s\S]*?opacity:\s*var\(--cerebr-resize-handle-hover-opacity, 0\.32\);/s
  );
  assert.match(
    sidebarCss,
    /body\.resize-hit-hover,[\s\S]*?body\.resize-hit-hover #chat-layout \*[\s\S]*?cursor:\s*col-resize !important;/s
  );

  assert.match(
    selectionThreadManagerSource,
    /function resolveResizeHandleHit\(clientX, clientY\) \{[\s\S]*?isThreadResizeEnabled\(\)[\s\S]*?kind: 'thread', mode: 'split'[\s\S]*?isFullscreenWidthResizeEnabled\(\)[\s\S]*?kind: 'fullscreen', mode: 'edge-left'/s
  );
  assert.match(
    selectionThreadManagerSource,
    /function handleResizeHandleMouseDown\(event\) \{[\s\S]*?if \(event\.button !== 0\) return;[\s\S]*?startThreadResize\(event, hit\.mode\);[\s\S]*?startFullscreenWidthResize\(event, hit\.mode\);/s
  );
  assert.match(
    selectionThreadManagerSource,
    /document\.addEventListener\('mousemove', handleResizeHandleMouseMove, true\);/
  );
  assert.match(
    selectionThreadManagerSource,
    /document\.addEventListener\('mousedown', handleResizeHandleMouseDown, true\);/
  );
});
