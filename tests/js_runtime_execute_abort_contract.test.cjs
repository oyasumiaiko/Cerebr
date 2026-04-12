const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('js_runtime_execute 中止链会把 AbortSignal 贯穿到 sender/sidebar/background/runtime/sandbox', async () => {
  const messageSenderSource = await readWorkspaceFile('src/core/message_sender.js');
  const sidebarAppContextSource = await readWorkspaceFile('src/ui/sidebar/sidebar_app_context.js');
  const backgroundSource = await readWorkspaceFile('src/extension/background.js');
  const jsRuntimeManagerSource = await readWorkspaceFile('src/extension/js_runtime_manager.js');
  const jsSandboxRuntimeSource = await readWorkspaceFile('src/ui/sidebar/js_sandbox_runtime.js');
  const jsSandboxFrameSource = await readWorkspaceFile('src/ui/sidebar/js_sandbox_frame.js');

  assert.match(
    messageSenderSource,
    /signal: options\?\.attemptState\?\.controller\?\.signal \|\| null/
  );
  assert.match(
    messageSenderSource,
    /if \(error\?\.name === 'AbortError'\) \{\s*throw error;\s*\}/
  );

  assert.match(
    sidebarAppContextSource,
    /const executionId = `jsrt_\$\{Date\.now\(\)\}_\$\{Math\.random\(\)\.toString\(36\)\.slice\(2, 10\)\}`;/
  );
  assert.match(
    sidebarAppContextSource,
    /type: 'ABORT_JS_RUNTIME'/
  );
  assert.match(
    sidebarAppContextSource,
    /signal: options\?\.signal \|\| null|signal/
  );

  assert.match(
    backgroundSource,
    /if \(message\?\.type === 'ABORT_JS_RUNTIME'\)/
  );
  assert.match(
    backgroundSource,
    /const result = await jsRuntimeManager\.abort\(\{/
  );

  assert.match(
    jsRuntimeManagerSource,
    /const __cerebrExecutionId = /
  );
  assert.match(
    jsRuntimeManagerSource,
    /const __cerebrAbortRegistry = globalThis\.__cerebrJsRuntimeAbortRegistry \?\?= new Set\(\);/
  );
  assert.match(
    jsRuntimeManagerSource,
    /const __cerebrAbortPromise = !__cerebrExecutionId/
  );
  assert.match(
    jsRuntimeManagerSource,
    /async function abort\(request = \{\}\)/
  );

  assert.match(
    jsSandboxRuntimeSource,
    /type: 'abort'/
  );
  assert.match(
    jsSandboxRuntimeSource,
    /reject\(createSandboxAbortError\(\)\);/
  );

  assert.match(
    jsSandboxFrameSource,
    /const activeExecutionAborters = new Map\(\);/
  );
  assert.match(
    jsSandboxFrameSource,
    /if \(data\.type === 'abort'\)/
  );
  assert.match(
    jsSandboxFrameSource,
    /const execution = await Promise\.race\(\[\s*executeUserCodeWithCapturedConsole\(data\.code\),\s*abortPromise\s*\]\);/s
  );
});
