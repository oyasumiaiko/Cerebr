const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

test('JS Runtime result formatting does not clone the full result in sidebar memory', async () => {
  const [source, outputFormatterSource] = await Promise.all([
    fs.readFile(path.resolve(__dirname, '../src/core/message_sender.js'), 'utf8'),
    fs.readFile(path.resolve(__dirname, '../src/agent_tools/shared/responses_tool_output.js'), 'utf8')
  ]);
  const compactBlock = source.match(
    /function compactResponsesJsRuntimeResult\(rawResult\) \{[\s\S]*?\n  \}/
  )?.[0] || '';
  const executeBlock = source.match(
    /async function executeResponsesJsRuntimeFunction\(rawArgs, options = \{\}\) \{[\s\S]*?\n  \}/
  )?.[0] || '';

  assert.match(compactBlock, /\? rawResult\s*: \{ ok: false/);
  assert.doesNotMatch(compactBlock, /cloneDataSafely/);
  assert.doesNotMatch(executeBlock, /cloneDataSafely\(result\?\.(?:logs|items)\)/);
  assert.doesNotMatch(outputFormatterSource, /itemResultSerialized/);
  assert.doesNotMatch(outputFormatterSource, /topValueSerialized/);
  assert.doesNotMatch(
    outputFormatterSource,
    /stringifyResponsesToolOutputValue\(item\.result\)[\s\S]{0,300}stringifyResponsesToolOutputValue\(normalized\.value\)/
  );
});
