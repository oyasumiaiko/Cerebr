const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readRepoFile(relativePath) {
  return fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

function extractFunctionBody(source, functionName) {
  const needle = `function ${functionName}`;
  const start = source.indexOf(needle);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, `${functionName} should have a body`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open + 1, index);
      }
    }
  }
  assert.fail(`${functionName} body should close`);
}

test('content script creates embedded sidebar iframes with explicit instanceId query', async () => {
  const source = await readRepoFile('src/extension/content.js');

  assert.match(source, /class CerebrSidebarManager/);
  assert.match(source, /generateInstanceId\(\)/);
  assert.match(
    source,
    /sidebar\.html\?instanceId=\$\{encodeURIComponent\(this\.instanceId\)\}&isPrimary=\$\{this\.isPrimary \? '1' : '0'\}/
  );
  assert.match(source, /case 'CREATE_ADDITIONAL_SIDEBAR':/);
  assert.match(source, /case 'CLOSE_SIDEBAR':/);
});

test('sidebar app context reads instance metadata without using shared storage', async () => {
  const source = await readRepoFile('src/ui/sidebar/sidebar_app_context.js');

  assert.match(source, /function resolveSidebarInstanceIdFromLocation\(\)/);
  assert.match(source, /function resolveSidebarIsPrimaryFromLocation\(\)/);
  assert.match(source, /sidebarInstanceId: resolveSidebarInstanceIdFromLocation\(\)/);
  assert.match(source, /isPrimarySidebar: resolveSidebarIsPrimaryFromLocation\(\)/);

  const instanceBody = extractFunctionBody(source, 'resolveSidebarInstanceIdFromLocation');
  const primaryBody = extractFunctionBody(source, 'resolveSidebarIsPrimaryFromLocation');
  assert.match(instanceBody, /searchParams\.get\('instanceId'\)/);
  assert.match(primaryBody, /searchParams\.get\('isPrimary'\)/);
  assert.doesNotMatch(instanceBody, /localStorage|sessionStorage|chrome\.storage/);
  assert.doesNotMatch(primaryBody, /localStorage|sessionStorage|chrome\.storage/);
});

test('parallel sidebar button closes non-primary sidebars', async () => {
  const source = await readRepoFile('src/ui/sidebar/sidebar_events.js');

  assert.match(source, /isPrimarySidebar \? 'CREATE_ADDITIONAL_SIDEBAR' : 'CLOSE_SIDEBAR'/);
  assert.match(source, /isPrimarySidebar \? 'far fa-window-restore' : 'far fa-window-close'/);
  assert.match(source, /button\.title = isPrimarySidebar \? '新建并行侧栏' : '关闭此侧栏'/);
});

test('standalone chat keeps the parallel chat button visible and routes it through the standalone opener', async () => {
  const [eventsSource, cssSource] = await Promise.all([
    readRepoFile('src/ui/sidebar/sidebar_events.js'),
    readRepoFile('src/ui/styles/sidebar.css')
  ]);

  assert.match(
    eventsSource,
    /if \(appContext\.state\.isStandalone\) \{[\s\S]*?button\.style\.display = 'flex';[\s\S]*?button\.title = '新建并行独立聊天页';[\s\S]*?await requestOpenStandaloneChatPage\(\);/s
  );
  assert.doesNotMatch(
    cssSource,
    /body\.standalone-mode #add-sidebar-button,[\s\S]*?\{\s*display:\s*none !important;[\s\S]*?\}/
  );
});

test('global sidebar visibility commands operate on all instances', async () => {
  const source = await readRepoFile('src/extension/content.js');

  assert.match(source, /toggleAllSidebars\(\)/);
  assert.match(source, /setAllSidebarsVisible\(isVisible\)/);
  assert.match(source, /case 'TOGGLE_SIDEBAR_onClicked':[\s\S]*sidebarManager\?\.toggleAllSidebars\?\.\(\)/);
  assert.match(source, /case 'OPEN_SIDEBAR':[\s\S]*sidebarManager\?\.setAllSidebarsVisible\?\.\(true\)/);
  assert.match(source, /case 'CLOSE_SIDEBAR':[\s\S]*sidebarManager\?\.setAllSidebarsVisible\?\.\(false\)/);
});

test('embedded sidebar manager supports drag reorder and per-instance resize', async () => {
  const source = await readRepoFile('src/extension/content.js');
  const sidebarEventsSource = await readRepoFile('src/ui/sidebar/sidebar_events.js');
  const sidebarCssSource = await readRepoFile('src/ui/styles/sidebar.css');

  assert.match(source, /startSidebarDrag\(sidebarInstance, startEvent\)/);
  assert.match(source, /reorderSidebarFromPointer\(sidebarInstance, clientX\)/);
  assert.match(source, /moveSidebarBefore\(sidebarInstance, beforeSidebar\)/);
  assert.match(source, /startSidebarEdgeControlInteraction\(sidebarInstance, payload = \{\}\)/);
  assert.match(source, /resolveSidebarWidthFromPointerDelta\(startWidth, pointerDelta\)/);
  assert.match(source, /case 'SIDEBAR_EDGE_CONTROL_POINTER_DOWN':[\s\S]*this\.startSidebarEdgeControlInteraction\(sourceSidebar, data\)/);
  assert.match(source, /classList\.add\('dragging'\)/);
  assert.match(source, /classList\.add\('resizing'\)/);
  assert.match(source, /stackOffsetPx: this\.stackOffsetPx/);
  assert.match(source, /sidebarWidth: Math\.round\(Number\(this\.sidebarWidth\) \|\| 0\)/);
  assert.match(sidebarEventsSource, /requestSidebarEdgeControlPointerDown\(appContext, event\)/);
  assert.match(sidebarEventsSource, /type: 'SIDEBAR_EDGE_CONTROL_POINTER_DOWN'/);
  assert.match(sidebarEventsSource, /suppressNextClick = requestSidebarEdgeControlPointerDown\(appContext, event\)/);
  assert.match(source, /hasLegacyResizer: !!this\.sidebar\.querySelector\('\.cerebr-sidebar__resizer'\)/);
  assert.match(sidebarCssSource, /#collapse-button \{[\s\S]*?width:\s*5px;[\s\S]*?height:\s*200px;[\s\S]*?opacity:\s*0;/);
  assert.match(sidebarCssSource, /#collapse-button:hover \{[\s\S]*?opacity:\s*0\.6;/);
  assert.doesNotMatch(source, /className\s*=\s*'cerebr-sidebar__resizer'/);
});

test('multi-sidebar fullscreen is coordinated by manager and split across viewport', async () => {
  const source = await readRepoFile('src/extension/content.js');

  assert.match(source, /multiFullscreenRestoreStateById/);
  assert.match(source, /shouldAttachNewSidebarToFullscreenLayout\(sidebarInstance, options\)/);
  assert.match(source, /attachNewSidebarToFullscreenLayout\(sidebarInstance\)/);
  assert.match(source, /destroySidebar\(sidebarInstance\)/);
  assert.match(source, /dispose\(\)/);
  assert.match(source, /toggleFullscreenForSidebar\(sidebarInstance\)/);
  assert.match(source, /enterMultiSidebarFullscreen\(sourceSidebar\)/);
  assert.match(source, /exitMultiSidebarFullscreen\(\)/);
  assert.match(source, /applyFullscreenSplitLayout\(index, total, layout = null\)/);
  assert.match(source, /--cerebr-fullscreen-left/);
  assert.match(source, /--cerebr-fullscreen-width/);
  assert.match(source, /buildFullscreenSplitLayouts\(fullscreenSidebars\)/);
  assert.match(source, /case 'TOGGLE_FULLSCREEN_FROM_IFRAME':[\s\S]*this\.toggleFullscreenForSidebar\(sourceSidebar\)/);
  assert.match(source, /case 'TOGGLE_FULLSCREEN_FROM_BACKGROUND':[\s\S]*sidebarManager\?\.toggleFullscreenForSidebar\?\.\(targetSidebar\)/);
  assert.match(source, /case 'CLOSE_SIDEBAR':[\s\S]*this\.destroySidebar\(sourceSidebar\)/);
  assert.match(source, /this\.multiFullscreenRestoreStateById\.set\(sidebarInstance\.instanceId,[\s\S]*wasVisible: true/);
});

test('multi-sidebar fullscreen split dividers support temporary ratio resizing', async () => {
  const source = await readRepoFile('src/extension/content.js');

  assert.match(source, /fullscreenSplitRatioById = new Map\(\)/);
  assert.match(source, /cerebr-sidebar__fullscreen-divider/);
  assert.match(source, /startFullscreenSplitResize\(leftSidebar, startEvent\)/);
  assert.match(source, /getFullscreenSplitMinRatio\(count, viewportWidth = this\.getViewportWidth\(\)\)/);
  assert.match(source, /setFullscreenSplitRatios\(fullscreenSidebars, ratios\)/);
  assert.match(source, /this\.fullscreenSplitRatioById\.clear\(\)/);
  assert.match(source, /hasFullscreenDivider: this\.sidebar\.classList\.contains\('has-fullscreen-divider'\)/);
  assert.doesNotMatch(source, /queueSyncSet\(\{\s*fullscreenSplit/);
});

test('host page tool requests carry sidebarInstanceId through sender and background relay', async () => {
  const messageSenderSource = await readRepoFile('src/core/message_sender.js');
  const sidebarEventsSource = await readRepoFile('src/ui/sidebar/sidebar_events.js');
  const backgroundSource = await readRepoFile('src/extension/background.js');

  assert.match(messageSenderSource, /GET_PAGE_CONTENT_READ_RESULT_FROM_SIDEBAR[\s\S]*sidebarInstanceId: typeof state\?\.sidebarInstanceId === 'string'/);
  assert.match(messageSenderSource, /GET_PDF_CONTENT_READ_RESULT_FROM_SIDEBAR[\s\S]*sidebarInstanceId: typeof state\?\.sidebarInstanceId === 'string'/);
  assert.match(messageSenderSource, /GET_WEBPAGE_SCREENSHOT_RESULT_FROM_SIDEBAR[\s\S]*sidebarInstanceId: typeof state\?\.sidebarInstanceId === 'string'/);
  assert.match(sidebarEventsSource, /GET_PAGE_CONTENT_READ_RESULT_FROM_SIDEBAR[\s\S]*sidebarInstanceId: appContext\.state\.sidebarInstanceId/);
  assert.match(backgroundSource, /GET_PAGE_CONTENT_READ_RESULT_INTERNAL[\s\S]*sidebarInstanceId: typeof message\?\.sidebarInstanceId === 'string'/);
  assert.match(backgroundSource, /GET_PDF_CONTENT_READ_RESULT_INTERNAL[\s\S]*sidebarInstanceId: typeof message\?\.sidebarInstanceId === 'string'/);
  assert.match(backgroundSource, /GET_WEBPAGE_SCREENSHOT_RESULT_INTERNAL[\s\S]*sidebarInstanceId: typeof message\?\.sidebarInstanceId === 'string'/);
});
