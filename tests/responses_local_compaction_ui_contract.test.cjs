const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('compact 成功态使用响应 output_tokens 和紧凑前后对比文案', async () => {
  const messageSenderSource = await readWorkspaceFile('src/core/message_sender.js');
  const messageProcessorSource = await readWorkspaceFile('src/core/message_processor.js');

  assert.match(
    messageSenderSource,
    /const compactUsage = normalizeApiUsageMeta\(compactPayload\?\.usage \|\| compactPayload\?\.response\?\.usage\);/
  );
  assert.match(
    messageSenderSource,
    /compactedOutputTokens:\s*compactUsage\?\.completionTokens \?\? null/
  );

  assert.match(
    messageProcessorSource,
    /const flowArrow = '→';/
  );
  assert.match(
    messageProcessorSource,
    /metaParts\.push\(`上下文 \$\{tokenBeforeLabel\} \$\{flowArrow\} \$\{tokenAfterLabel\} tokens`\);/
  );
  assert.match(
    messageProcessorSource,
    /if \(state === 'error' && status\?\.responseStatus\) metaParts\.push\(`HTTP \$\{status\.responseStatus\}`\);/
  );
  assert.doesNotMatch(
    messageProcessorSource,
    /metaParts\.push\(`第 \$\{status\.attempt\}\/\$\{status\.totalAttempts\} 次`\);/
  );
});
