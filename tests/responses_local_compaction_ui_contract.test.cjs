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

test('/compact 在线程模式下写入线程容器并修复线程尾指针', async () => {
  const messageSenderSource = await readWorkspaceFile('src/core/message_sender.js');

  assert.match(
    messageSenderSource,
    /function prepareActiveThreadContextForAppend\(threadContext\) \{[\s\S]*container:\s*threadContainer[\s\S]*repairThreadAnnotation\?\.\(preparedContext\.threadId\)[\s\S]*preparedContext\.lastMessageId = preparedContext\.annotation\?\.lastMessageId \|\| null;/
  );
  assert.match(
    messageSenderSource,
    /const activeThreadContext = prepareActiveThreadContextForAppend\(resolveActiveThreadContext\(\)\);\s*const pendingMarkerResult = appendResponsesLocalCompactionMarker\(/
  );
  assert.match(
    messageSenderSource,
    /function resolveResponsesLocalCompactionInvocationContext\(\) \{[\s\S]*const activeThreadContext = prepareActiveThreadContextForAppend\(resolveActiveThreadContext\(\)\);[\s\S]*conversationChain = resolveConversationChainForAttempt\(/
  );
  assert.match(
    messageSenderSource,
    /container:\s*activeThreadContext\.container,\s*historyParentId,\s*preserveCurrentNode:\s*true,\s*historyPatch:\s*mergedHistoryPatch/
  );
});
