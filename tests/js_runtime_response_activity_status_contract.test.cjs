const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('js_runtime_execute 在进行中时显示运行中，完成后才显示已运行', async () => {
  const messageProcessorSource = await readWorkspaceFile('src/core/message_processor.js');

  assert.match(
    messageProcessorSource,
    /const isInProgress = options\?\.isInProgress === true \|\| isResponseActivityEntryInProgress\(record\);/
  );
  assert.match(
    messageProcessorSource,
    /\? \(isInProgress \? '运行中' : '已运行'\)/
  );
  assert.match(
    messageProcessorSource,
    /: \(isInProgress\s*\? `正在\$\{meta\.frameIds\.length\}个iframe中运行`\s*:\s*`已在\$\{meta\.frameIds\.length\}个iframe运行`\)/
  );
  assert.match(
    messageProcessorSource,
    /buildResponseToolCallPrimaryParts\(entry, \{ isInProgress \}\)/
  );
});
