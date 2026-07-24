const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadResponsesExtensionToolsModule() {
  const filePath = path.resolve(__dirname, '../src/api/responses_extension_tools.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('RESPONSES_EXTENSION_TOOL_SPECS 以稳定顺序登记扩展提供工具', async () => {
  const { RESPONSES_EXTENSION_TOOL_SPECS } = await loadResponsesExtensionToolsModule();

  assert.deepEqual(
    RESPONSES_EXTENSION_TOOL_SPECS.map(spec => spec.id),
    [
      'js_runtime_execute',
      'read_tool_output',
      'apply_patch',
      'list_files',
      'read_file',
      'search_files',
      'copy_file',
      'move_file',
      'delete_file',
      'skill_registry',
      'request_user_input',
      'view_image',
      'list_askable_models',
      'ask_other_ai',
      'history_search',
      'history_read',
      'webpage_screenshot',
      'pdf_content_read',
      'page_content_read'
    ]
  );
  for (const spec of RESPONSES_EXTENSION_TOOL_SPECS) {
    assert.equal(typeof spec.exposure, 'string');
    assert.equal(typeof spec.handlerKey, 'string');
    assert.equal(typeof spec.outputKind, 'string');
    assert.equal(typeof spec.sideEffect, 'string');
    assert.equal(typeof spec.deferLoading, 'boolean');
  }
  assert.equal(RESPONSES_EXTENSION_TOOL_SPECS.find(spec => spec.id === 'view_image').sideEffect, 'network');
  const readToolOutputSpec = RESPONSES_EXTENSION_TOOL_SPECS.find(spec => spec.id === 'read_tool_output');
  assert.equal(readToolOutputSpec.alwaysEnabled, true);
  assert.equal(readToolOutputSpec.configurable, false);
  assert.equal(readToolOutputSpec.deferLoading, false);
});

test('manifest 的 handlerKey 与 outputKind 均有 sender 执行和序列化分支', async () => {
  const { RESPONSES_EXTENSION_TOOL_SPECS } = await loadResponsesExtensionToolsModule();
  const senderSource = await fs.readFile(
    path.resolve(__dirname, '../src/core/message_sender.js'),
    'utf8'
  );
  const handlerKeys = new Set(RESPONSES_EXTENSION_TOOL_SPECS.map(spec => spec.handlerKey));
  const outputKinds = new Set(RESPONSES_EXTENSION_TOOL_SPECS.map(spec => spec.outputKind));

  for (const handlerKey of handlerKeys) {
    assert.match(senderSource, new RegExp(`case '${handlerKey}':\\s*outputPayload =`, 's'));
  }
  for (const outputKind of outputKinds) {
    assert.match(senderSource, new RegExp(`case '${outputKind}':`, 's'));
  }
});

test('resolveResponsesExtensionToolSpecForCall 不会把 namespace 内同名函数路由到本地 handler', async () => {
  const {
    resolveAuthorizedResponsesExtensionToolSpec,
    resolveResponsesExtensionToolSpecForCall
  } = await loadResponsesExtensionToolsModule();

  assert.equal(resolveResponsesExtensionToolSpecForCall('delete_file', '').handlerKey, 'virtual_file');
  assert.equal(resolveResponsesExtensionToolSpecForCall('delete_file', 'external'), null);
  assert.equal(resolveResponsesExtensionToolSpecForCall('unknown_tool', ''), null);
  assert.equal(resolveAuthorizedResponsesExtensionToolSpec('delete_file', '', []), null);
  assert.equal(
    resolveAuthorizedResponsesExtensionToolSpec('delete_file', '', [
      { type: 'function', name: 'delete_file' }
    ]).handlerKey,
    'virtual_file'
  );
});

test('reconcileResponsesAllowedToolChoice 会同步当前不可用的本地工具', async () => {
  const { reconcileResponsesAllowedToolChoice } = await loadResponsesExtensionToolsModule();
  const finalTools = [
    { type: 'function', name: 'history_search' },
    { type: 'function', name: 'read_tool_output' },
    { type: 'web_search' }
  ];

  assert.deepEqual(
    reconcileResponsesAllowedToolChoice({
      type: 'allowed_tools',
      mode: 'auto',
      tools: ['page_content_read', 'history_search', 'web_search']
    }, finalTools),
    {
      type: 'allowed_tools',
      mode: 'auto',
      tools: ['history_search', 'web_search', 'read_tool_output']
    }
  );
  assert.equal(
    reconcileResponsesAllowedToolChoice({
      type: 'allowed_tools',
      mode: 'auto',
      tools: [{ type: 'function', name: 'page_content_read' }]
    }, finalTools),
    'none'
  );
  assert.throws(
    () => reconcileResponsesAllowedToolChoice({
      type: 'allowed_tools',
      mode: 'required',
      tools: ['page_content_read']
    }, finalTools),
    /当前不可用的本地工具：page_content_read/
  );

  assert.deepEqual(
    reconcileResponsesAllowedToolChoice({
      type: 'allowed_tools',
      mode: 'required',
      tools: [{ type: 'function', name: 'history_search' }]
    }, finalTools),
    {
      type: 'allowed_tools',
      mode: 'required',
      tools: [
        { type: 'function', name: 'history_search' },
        'read_tool_output'
      ]
    }
  );
});

test('isResponsesExtensionToolEnabled 默认全开，只有显式 false 才关闭', async () => {
  const { isResponsesExtensionToolEnabled } = await loadResponsesExtensionToolsModule();

  assert.equal(isResponsesExtensionToolEnabled({}, 'view_image'), true);
  assert.equal(
    isResponsesExtensionToolEnabled({
      extension_tools: {
        view_image: {
          enabled: false
        }
      }
    }, 'view_image'),
    false
  );
  assert.equal(
    isResponsesExtensionToolEnabled({
      extension_tools: {
        view_image: {
          enabled: true
        }
      }
    }, 'view_image'),
    true
  );
  assert.equal(isResponsesExtensionToolEnabled({}, 'future_custom_tool'), true);
  assert.equal(
    isResponsesExtensionToolEnabled({
      extension_tools: {
        read_tool_output: { enabled: false }
      }
    }, 'read_tool_output'),
    true
  );
});

test('filterResponsesExtensionFunctionTools 会过滤被关闭的同名 function tools，并保持原数组不被就地修改', async () => {
  const { filterResponsesExtensionFunctionTools } = await loadResponsesExtensionToolsModule();

  const tools = [
    { type: 'function', name: 'view_image', parameters: { type: 'object' } },
    { type: 'function', name: 'page_content_read', parameters: { type: 'object' } },
    { type: 'web_search' }
  ];

  const filtered = filterResponsesExtensionFunctionTools(tools, {
    extension_tools: {
      view_image: {
        enabled: false
      }
    }
  });

  assert.deepEqual(
    filtered,
    [
      { type: 'function', name: 'page_content_read', parameters: { type: 'object' } },
      { type: 'web_search' }
    ]
  );
  assert.deepEqual(
    tools,
    [
      { type: 'function', name: 'view_image', parameters: { type: 'object' } },
      { type: 'function', name: 'page_content_read', parameters: { type: 'object' } },
      { type: 'web_search' }
    ]
  );
  assert.notEqual(filtered[0], tools[1]);
});

test('filterUnavailableResponsesExtensionFunctionTools 会阻止手写同名函数绕过本轮暴露环境', async () => {
  const { filterUnavailableResponsesExtensionFunctionTools } = await loadResponsesExtensionToolsModule();
  const tools = [
    { type: 'function', name: 'page_content_read', description: 'raw collision' },
    { type: 'function', name: 'history_search', description: 'raw collision' },
    { type: 'function', name: 'external_custom', description: 'user handler' },
    { type: 'web_search' }
  ];
  const available = [
    { type: 'function', name: 'history_search', description: 'cerebr definition' }
  ];

  assert.deepEqual(
    filterUnavailableResponsesExtensionFunctionTools(tools, available),
    [
      { type: 'function', name: 'history_search', description: 'raw collision' },
      { type: 'function', name: 'external_custom', description: 'user handler' },
      { type: 'web_search' }
    ]
  );
});
