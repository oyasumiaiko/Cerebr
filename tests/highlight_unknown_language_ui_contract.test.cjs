const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('未知语言高亮会被前置短路，并使用 Cerebr 自己的幂等状态而不是依赖 hljs 内部标记', async () => {
  const messageProcessorSource = await readWorkspaceFile('src/core/message_processor.js');

  assert.match(messageProcessorSource, /function enhanceCodeHighlightBlocks\(rootElement\)/);
  assert.match(messageProcessorSource, /block\.dataset\.cerebrHighlightState/);
  assert.match(messageProcessorSource, /if \(declaredLanguage && !hljs\.getLanguage\(declaredLanguage\)\)/);
  assert.match(messageProcessorSource, /markCodeBlockHighlightState\(block, nextSignature, 'unsupported'\)/);
  assert.doesNotMatch(messageProcessorSource, /block\.dataset\.highlighted === 'yes'/);
});

test('assistant metadata 同步不再整块重扫 message wrapper，而是在变更的 tool item 上局部增强', async () => {
  const messageProcessorSource = await readWorkspaceFile('src/core/message_processor.js');

  assert.match(
    messageProcessorSource,
    /reconcileResponseActivityApplyPatchBody\(toolBodyInner, snapshot\)[\s\S]*?renderResponseActivityToolBodyContent\(toolBodyInner, snapshot\);[\s\S]*?enhanceMarkdownContent\(item\);/
  );
  assert.doesNotMatch(messageProcessorSource, /enhanceMarkdownContent\(messageWrapperDiv\);/);
});
