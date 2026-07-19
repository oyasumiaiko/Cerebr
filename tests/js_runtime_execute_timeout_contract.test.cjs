const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

async function importWorkspaceModule(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return import(`${pathToFileURL(filePath).href}?test=${Date.now()}`);
}

test('js_runtime_execute 暴露 timeout_ms 并把它接到 sidebar 与 background 执行链', async () => {
  const jsRuntimeToolModule = await importWorkspaceModule('src/agent_tools/js_runtime_execute/tool.js');
  const messageSenderSource = await readWorkspaceFile('src/core/message_sender.js');
  const sidebarAppContextSource = await readWorkspaceFile('src/ui/sidebar/sidebar_app_context.js');
  const backgroundSource = await readWorkspaceFile('src/extension/background.js');
  const toolDefinition = jsRuntimeToolModule.buildJsRuntimeExecuteFunctionToolDefinition();

  assert.equal(toolDefinition.name, 'js_runtime_execute');
  assert.equal(toolDefinition.strict, true);
  assert.match(toolDefinition.parameters.properties.timeout_ms.description, /超时毫秒数/);
  assert.match(toolDefinition.description, /AbortSignal 变量 `signal`/);
  assert.match(toolDefinition.description, /协作式取消/);
  assert.equal(Object.hasOwn(toolDefinition.parameters.properties.timeout_ms, 'minimum'), false);
  assert.deepEqual(toolDefinition.parameters.required, ['code', 'timeout_ms', 'frame_ids']);
  assert.deepEqual(
    jsRuntimeToolModule.normalizeJsRuntimeExecuteToolArguments({
      code: 'return 1;',
      timeout_ms: 1234,
      frame_ids: [1, '2', 'x']
    }),
    {
      code: 'return 1;',
      timeoutMs: 1234,
      frameIds: [1, 2]
    }
  );
  assert.throws(
    () => jsRuntimeToolModule.normalizeJsRuntimeExecuteToolArguments({
      code: 'return 1;',
      timeout_ms: null,
      frame_ids: [1, '2']
    }, { allowLegacy: false, allowFrameIds: true }),
    /非负安全整数/
  );
  assert.throws(
    () => jsRuntimeToolModule.normalizeJsRuntimeExecuteToolArguments({
      code: 'return 1;',
      timeout_ms: null,
      frame_ids: [1]
    }, { allowLegacy: false, allowFrameIds: false }),
    /隔离模式不支持 frame_ids/
  );
  assert.throws(
    () => jsRuntimeToolModule.normalizeJsRuntimeExecuteToolArguments({ code: 'return 1;', timeout_ms: 0 }),
    /timeout_ms 必须大于 0/
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

test('js_runtime_execute 在纯对话模式下的工具说明不再指向宿主页', async () => {
  const jsRuntimeToolModule = await importWorkspaceModule('src/agent_tools/js_runtime_execute/tool.js');
  const toolDefinition = jsRuntimeToolModule.buildJsRuntimeExecuteFunctionToolDefinition({
    exposeHostPageTools: false
  });

  assert.match(toolDefinition.description, /侧栏内部隔离沙箱/);
  assert.match(toolDefinition.description, /不要用它读取当前网页、URL、标题或 frame/);
  assert.match(toolDefinition.parameters.properties.frame_ids.description, /不绑定宿主页 frame/);
  assert.doesNotMatch(toolDefinition.description, /当前页面是单页应用/);
  assert.doesNotMatch(toolDefinition.description, /AbortSignal 变量 `signal`/);
  assert.doesNotMatch(toolDefinition.description, /协作式取消/);
});

test('纯对话 JS Runtime 使用 manifest sandbox classic script，避免 module 握手超时', async () => {
  const manifestSource = await readWorkspaceFile('manifest.json');
  const runtimeSource = await readWorkspaceFile('src/ui/sidebar/js_sandbox_runtime.js');
  const frameHtmlSource = await readWorkspaceFile('src/ui/sidebar/js_sandbox_frame.html');
  const frameSource = await readWorkspaceFile('src/ui/sidebar/js_sandbox_frame.js');

  assert.match(manifestSource, /"sandbox"\s*:\s*\{[\s\S]*src\/ui\/sidebar\/js_sandbox_frame\.html/);
  assert.match(manifestSource, /"web_accessible_resources"\s*:\s*\[[\s\S]*src\/ui\/sidebar\/js_sandbox_frame\.js/);
  assert.doesNotMatch(runtimeSource, /iframe\.setAttribute\('sandbox'/);
  assert.match(frameHtmlSource, /<script src="\.\/js_sandbox_frame\.js"><\/script>/);
  assert.doesNotMatch(frameHtmlSource, /type="module"/);
  assert.doesNotMatch(frameSource, /^\s*import\s/m);
  assert.match(frameSource, /postSandboxMessage\('ready'\);/);
});
