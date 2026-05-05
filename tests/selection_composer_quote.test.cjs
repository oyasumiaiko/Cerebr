const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadSelectionThreadManagerModule() {
  const filePath = path.resolve(__dirname, '../src/ui/selection_thread_manager.js');
  return import(`${pathToFileURL(filePath).href}?test=${Date.now()}`);
}

test('buildSelectionComposerQuote 会把单行划词转换为 Markdown 引用行', async () => {
  const { buildSelectionComposerQuote } = await loadSelectionThreadManagerModule();

  assert.equal(
    buildSelectionComposerQuote('  需要引用的片段  '),
    '> 需要引用的片段'
  );
});

test('buildSelectionComposerQuote 会逐行引用多行划词内容', async () => {
  const { buildSelectionComposerQuote } = await loadSelectionThreadManagerModule();

  assert.equal(
    buildSelectionComposerQuote('第一行\r\n  第二行\n\n第三行'),
    '> 第一行\n>   第二行\n> \n> 第三行'
  );
});

test('prependSelectionQuoteToComposerText 会把引用插入到已有输入开头', async () => {
  const { prependSelectionQuoteToComposerText } = await loadSelectionThreadManagerModule();

  assert.equal(
    prependSelectionQuoteToComposerText('继续输入的问题', '选中的内容'),
    '> 选中的内容\n继续输入的问题'
  );
});

test('prependSelectionQuoteToComposerText 在空输入时保留可继续输入的新行锚点', async () => {
  const { prependSelectionQuoteToComposerText } = await loadSelectionThreadManagerModule();

  assert.equal(
    prependSelectionQuoteToComposerText('', '选中的内容'),
    '> 选中的内容\n\n'
  );
});
