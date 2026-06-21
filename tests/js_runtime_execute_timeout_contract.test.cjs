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
  assert.deepEqual(toolDefinition.parameters.required, ['code', 'timeout_ms', 'frame_ids', 'workspace_files']);
  assert.deepEqual(
    jsRuntimeToolModule.normalizeJsRuntimeExecuteToolArguments({
      code: 'return 1;',
      timeout_ms: 1234,
      frame_ids: [1, '2', 'x'],
      workspace_files: true
    }),
    {
      code: 'return 1;',
      timeoutMs: 1234,
      frameIds: [1, 2],
      workspaceFiles: true
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

test('js_runtime_execute workspace_files 会链接当前会话文件区且不强制改变运行环境', async () => {
  const jsRuntimeToolModule = await importWorkspaceModule('src/agent_tools/js_runtime_execute/tool.js');
  const toolDefinition = jsRuntimeToolModule.buildJsRuntimeExecuteFunctionToolDefinition();
  const messageSenderSource = await readWorkspaceFile('src/core/message_sender.js');
  const sidebarAppContextSource = await readWorkspaceFile('src/ui/sidebar/sidebar_app_context.js');
  const backgroundSource = await readWorkspaceFile('src/extension/background.js');
  const contentSource = await readWorkspaceFile('src/extension/content.js');
  const hostRuntimeSource = await readWorkspaceFile('src/extension/js_runtime_manager.js');
  const sidebarEventsSource = await readWorkspaceFile('src/ui/sidebar/sidebar_events.js');
  const sandboxRuntimeSource = await readWorkspaceFile('src/ui/sidebar/js_sandbox_runtime.js');
  const sandboxFrameSource = await readWorkspaceFile('src/ui/sidebar/js_sandbox_frame.js');

  assert.match(toolDefinition.description, /workspace_files=true/);
  assert.match(toolDefinition.description, /files\.read/);
  assert.match(toolDefinition.parameters.properties.workspace_files.description, /当前会话文件区/);
  assert.doesNotMatch(toolDefinition.description, /会切到侧栏隔离 sandbox/);
  assert.doesNotMatch(toolDefinition.parameters.properties.workspace_files.description, /frame_ids 会被忽略/);
  assert.equal(
    jsRuntimeToolModule.normalizeJsRuntimeExecuteToolArguments({
      code: 'return await files.list();',
      timeout_ms: null,
      frame_ids: null,
      workspace_files: true
    }).workspaceFiles,
    true
  );

  assert.match(messageSenderSource, /const workspaceFiles = normalizedArgs\.workspaceFiles === true;/);
  assert.doesNotMatch(messageSenderSource, /workspaceFiles\s*\?\s*JS_RUNTIME_ENV_ISOLATED_SANDBOX/);
  assert.match(messageSenderSource, /frameIds: normalizedArgs\.frameIds/);
  assert.match(messageSenderSource, /conversationId,\s*signal:/s);

  assert.match(sidebarAppContextSource, /executeWorkspaceFileBridgeRequest/);
  assert.match(sidebarAppContextSource, /CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION/);
  assert.match(sidebarAppContextSource, /path_glob: args\.glob \?\? args\.path_glob \?\? null/);
  assert.match(sidebarAppContextSource, /executeWorkspaceFileBridgeRequest = executeWorkspaceFileBridgeRequest/);
  assert.match(sidebarAppContextSource, /workspaceFiles: options\?\.workspaceFiles === true/);
  assert.match(sidebarAppContextSource, /workspaceConversationId: \(typeof options\?\.conversationId === 'string'\)/);
  assert.match(sidebarAppContextSource, /sidebarInstanceId: appContext\.state\.sidebarInstanceId/);
  assert.match(sidebarAppContextSource, /handleWorkspaceFileRequest:/);
  assert.match(sidebarAppContextSource, /dispatchConversationDocumentChange\(result\.change_event\)/);

  assert.match(backgroundSource, /JS_RUNTIME_WORKSPACE_FILE_REQUEST/);
  assert.match(backgroundSource, /registerJsRuntimeWorkspaceFileSession/);
  assert.match(backgroundSource, /workspace_files: buildWorkspaceFileBridgeSummary/);
  assert.match(contentSource, /JS_RUNTIME_WORKSPACE_FILE_REQUEST_INTERNAL/);
  assert.match(contentSource, /requestWorkspaceFileFromSidebar/);
  assert.match(sidebarEventsSource, /JS_RUNTIME_WORKSPACE_FILE_REQUEST_FROM_HOST/);
  assert.match(sidebarEventsSource, /executeWorkspaceFileBridgeRequest/);
  assert.match(hostRuntimeSource, /const files = __cerebrCreateWorkspaceFilesApi\(\)/);
  assert.match(hostRuntimeSource, /chrome\.runtime\.sendMessage/);

  assert.match(sandboxRuntimeSource, /data\.type === 'workspace_file_request'/);
  assert.match(sandboxRuntimeSource, /type: 'workspace_file_response'/);
  assert.match(sandboxRuntimeSource, /payload\.workspace_files = buildWorkspaceFileSummary/);

  assert.match(sandboxFrameSource, /function createWorkspaceFilesApi/);
  assert.match(sandboxFrameSource, /write\(path, content\)/);
  assert.match(sandboxFrameSource, /applyPatch\(patch\)/);
  assert.match(sandboxFrameSource, /new AsyncFunction\('files', 'workspace', body\)/);
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
