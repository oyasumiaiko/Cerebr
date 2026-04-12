const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('js_runtime_execute 暴露 timeout_ms 并把它接到 sidebar 与 background 执行链', async () => {
  const messageSenderSource = await readWorkspaceFile('src/core/message_sender.js');
  const sidebarAppContextSource = await readWorkspaceFile('src/ui/sidebar/sidebar_app_context.js');
  const backgroundSource = await readWorkspaceFile('src/extension/background.js');

  assert.match(
    messageSenderSource,
    /timeout_ms:\s*\{\s*type: \['integer', 'null'\],\s*description: 'The timeout for the execution in milliseconds\.'/s
  );
  assert.match(
    messageSenderSource,
    /required: \['code', 'timeout_ms', 'frame_ids'\]/
  );
  assert.match(
    messageSenderSource,
    /timeoutMs,\s*frameIds: \(Array\.isArray\(frameIds\) && frameIds\.length > 0\) \? frameIds : null/s
  );
  assert.match(
    messageSenderSource,
    /timeoutMs: normalizedArgs\.timeoutMs,\s*frameIds: normalizedArgs\.frameIds/s
  );

  assert.match(
    sidebarAppContextSource,
    /const timeoutMs = \(\(\) => \{[\s\S]*?return JS_RUNTIME_EXECUTION_TIMEOUT_MS;[\s\S]*?\}\)\(\);/s
  );
  assert.match(
    sidebarAppContextSource,
    /timeoutMs,\s*frameIds: Array\.isArray\(options\?\.frameIds\) \? options\.frameIds : null/s
  );
  assert.match(
    sidebarAppContextSource,
    /timeoutMs,\s*'执行 JS Runtime 超时'/
  );

  assert.match(
    backgroundSource,
    /timeoutMs: message\?\.timeoutMs,/
  );
});
