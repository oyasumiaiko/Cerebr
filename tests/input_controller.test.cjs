const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadInputControllerModule() {
  const filePath = path.resolve(__dirname, '../src/ui/input_controller.js');
  return import(`${pathToFileURL(filePath).href}?test=${Date.now()}`);
}

function createTextNode(value) {
  return {
    nodeType: 3,
    nodeValue: value,
    textContent: value
  };
}

function createElementNode(tagName, childNodes = []) {
  return {
    nodeType: 1,
    tagName,
    childNodes,
    textContent: childNodes.map((node) => node.textContent || node.nodeValue || '').join(''),
    innerText: childNodes.map((node) => node.textContent || node.nodeValue || '').join('')
  };
}

test('extractPlainTextFromContenteditable 不会把 Shift+Enter 生成的顶层换行文本节点重复计算', async () => {
  const { extractPlainTextFromContenteditable } = await loadInputControllerModule();
  const input = {
    childNodes: [
      createTextNode('line1'),
      createTextNode('\n'),
      createTextNode('line2')
    ],
    innerText: 'line1\nline2',
    textContent: 'line1\nline2'
  };

  assert.equal(
    extractPlainTextFromContenteditable(input),
    'line1\nline2'
  );
});

test('extractPlainTextFromContenteditable 保留块级空行容器的逻辑空行', async () => {
  const { extractPlainTextFromContenteditable } = await loadInputControllerModule();
  const input = {
    childNodes: [
      createElementNode('DIV', [createTextNode('line1')]),
      createElementNode('DIV', [createElementNode('BR')]),
      createElementNode('DIV', [createTextNode('line2')])
    ],
    innerText: 'line1\n\nline2',
    textContent: 'line1line2'
  };

  assert.equal(
    extractPlainTextFromContenteditable(input),
    'line1\n\nline2'
  );
});
