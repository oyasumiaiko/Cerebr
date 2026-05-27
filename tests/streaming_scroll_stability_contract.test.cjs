const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');

async function readWorkspaceFile(relativePath) {
  return fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

test('流式回答滚动稳定性：用户意图、自动跟随和 Markdown 高度抖动相互隔离', async () => {
  const [
    autoScrollSource,
    uiManagerSource,
    sidebarAppContextSource,
    messageProcessorSource,
    sidebarCss
  ] = await Promise.all([
    readWorkspaceFile('src/utils/auto_scroll_follow_state.js'),
    readWorkspaceFile('src/ui/ui_manager.js'),
    readWorkspaceFile('src/ui/sidebar/sidebar_app_context.js'),
    readWorkspaceFile('src/core/message_processor.js'),
    readWorkspaceFile('src/ui/styles/sidebar.css')
  ]);

  assert.match(autoScrollSource, /userScrollIntent/);
  assert.match(autoScrollSource, /if \(userScrollIntent\) \{\s*return false;\s*\}/s);

  assert.match(uiManagerSource, /function setupScrollableContainerEventListeners\(container\)/);
  assert.match(uiManagerSource, /markUserScrollIntent/);
  assert.match(uiManagerSource, /userScrollIntent:\s*hasRecentUserScrollIntent\(\)/);
  assert.match(uiManagerSource, /effectiveDeltaY > 0[\s\S]*?messageSender\.setShouldAutoScroll\(false\);/);
  assert.doesNotMatch(uiManagerSource, /e\.offsetX < container\.clientWidth[\s\S]*?setShouldAutoScroll\(false\)/);

  assert.match(sidebarAppContextSource, /const behavior = scrollOptions\.behavior === 'smooth' \? 'smooth' : 'auto';/);
  assert.match(sidebarAppContextSource, /chatContainer\.scrollTop = top;/);

  assert.match(messageProcessorSource, /runWithTemporaryMarkdownSurfaceHeightFloor/);
  assert.match(messageProcessorSource, /stabilizeHeightDuringUpdate:\s*messageDiv\.classList\.contains\('updating'\)/);
  assert.match(messageProcessorSource, /function isInsideUpdatingMessage\(element\)/);
  assert.match(messageProcessorSource, /if \(isInsideUpdatingMessage\(wrapper\)\) \{[\s\S]*?wrapper\.classList\.remove\('is-collapsible', 'is-expanded'\);/s);
  assert.match(messageProcessorSource, /if \(messageWrapperDiv && !messageWrapperDiv\.classList\.contains\('updating'\)\) \{\s*enhanceRenderedMarkdownCodeBlocks\(messageWrapperDiv\);/s);

  assert.match(sidebarCss, /\.message\.updating,[\s\S]*?overflow-anchor:\s*none;/);
});
