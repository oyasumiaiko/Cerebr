const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('compact 成功态使用响应 usage 里的精确前后 token，非成功态保留尝试次数', async () => {
  const messageSenderSource = await readWorkspaceFile('src/core/message_sender.js');
  const messageProcessorSource = await readWorkspaceFile('src/core/message_processor.js');

  assert.match(
    messageSenderSource,
    /const compactUsage = normalizeApiUsageMeta\(compactPayload\?\.usage \|\| compactPayload\?\.response\?\.usage\);/
  );
  assert.match(
    messageSenderSource,
    /promptTokensBefore:\s*compactUsage\?\.promptTokens \?\? normalizedPayload\.promptTokensBefore \?\? null/
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
  assert.match(
    messageProcessorSource,
    /const attemptLabel = status\?\.totalAttempts\s*\? `第 \$\{status\.attempt\}\/\$\{status\.totalAttempts\} 次`\s*: `第 \$\{status\.attempt\} 次`;/ 
  );
});
