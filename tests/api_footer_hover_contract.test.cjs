const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readRepoFile(relativePath) {
  return fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

test('AI footer tooltip 只挂载到实际文本元素，避免整行空白 hover 触发详情', async () => {
  const helperSource = await readRepoFile('src/utils/api_footer_dom.js');
  const cssSource = await readRepoFile('src/ui/styles/sidebar.css');

  assert.match(helperSource, /footer\.removeAttribute\('title'\)/);
  assert.match(helperSource, /textElement\.title = title/);
  assert.match(helperSource, /textElement\.removeAttribute\('title'\)/);
  assert.match(helperSource, /className = 'api-footer__text'/);

  assert.match(cssSource, /\.api-footer \{[\s\S]*?display:\s*flex;[\s\S]*?justify-content:\s*flex-end;[\s\S]*?pointer-events:\s*none;/);
  assert.match(cssSource, /\.api-footer__text \{[\s\S]*?white-space:\s*pre-line;[\s\S]*?pointer-events:\s*auto;/);
});

test('AI footer 三条渲染路径统一使用文本级 tooltip helper', async () => {
  const [processorSource, historySource, threadSource] = await Promise.all([
    readRepoFile('src/core/message_processor.js'),
    readRepoFile('src/ui/chat_history_ui.js'),
    readRepoFile('src/ui/selection_thread_manager.js')
  ]);

  for (const source of [processorSource, historySource, threadSource]) {
    assert.match(source, /renderApiFooterDom\(footer, renderData\)/);
    assert.doesNotMatch(source, /footer\.title\s*=\s*renderData\.title/);
    assert.doesNotMatch(source, /footer\.textContent\s*=\s*renderData\.text/);
  }
});
