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
  assert.equal(
    toolDefinition.parameters.properties.timeout_ms.description,
    'The timeout for the execution in milliseconds.'
  );
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

  assert.match(toolDefinition.description, /纯对话\/隔离模式/);
  assert.match(toolDefinition.description, /不能访问宿主页 DOM、URL、标题或 frame/);
  assert.match(toolDefinition.parameters.properties.frame_ids.description, /忽略宿主页 frame/);
  assert.doesNotMatch(toolDefinition.description, /当前页面是单页应用/);
});
