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
      'apply_patch',
      'list_files',
      'read_file',
      'search_files',
      'copy_file',
      'move_file',
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
    assert.ok(['function', 'apply_patch'].includes(spec.protocol));
    assert.equal(typeof spec.exposure, 'string');
    assert.equal(typeof spec.handlerKey, 'string');
    assert.equal(typeof spec.outputKind, 'string');
    assert.equal(typeof spec.sideEffect, 'string');
    assert.equal(typeof spec.deferLoading, 'boolean');
  }
  assert.equal(RESPONSES_EXTENSION_TOOL_SPECS.find(spec => spec.id === 'view_image').sideEffect, 'network');
});

test('manifest 的 handlerKey 与 outputKind 均有 sender 执行和序列化分支', async () => {
  const { RESPONSES_EXTENSION_TOOL_SPECS } = await loadResponsesExtensionToolsModule();
  const senderSource = await fs.readFile(
    path.resolve(__dirname, '../src/core/message_sender.js'),
    'utf8'
  );
  const functionSpecs = RESPONSES_EXTENSION_TOOL_SPECS.filter(spec => spec.protocol === 'function');
  const handlerKeys = new Set(functionSpecs.map(spec => spec.handlerKey));
  const outputKinds = new Set(functionSpecs.map(spec => spec.outputKind));

  for (const handlerKey of handlerKeys) {
    assert.match(senderSource, new RegExp(`case '${handlerKey}':\\s*outputPayload =`, 's'));
  }
  for (const outputKind of outputKinds) {
    assert.match(senderSource, new RegExp(`case '${outputKind}':\\s*serializedOutput =`, 's'));
  }
  assert.match(senderSource, /async function executeResponsesApplyPatchToolCall\(/);
  assert.match(senderSource, /type:\s*OPENAI_APPLY_PATCH_CALL_OUTPUT_TYPE/);
  assert.match(senderSource, /status:\s*'completed'/);
  assert.match(senderSource, /status:\s*'failed'/);
});

test('resolveResponsesExtensionToolSpecForCall 不会把 namespace 内同名函数路由到本地 handler', async () => {
  const {
    resolveAuthorizedResponsesExtensionToolSpec,
    resolveResponsesExtensionToolSpecForCall
  } = await loadResponsesExtensionToolsModule();

  assert.equal(resolveResponsesExtensionToolSpecForCall('copy_file', '').handlerKey, 'virtual_file');
  assert.equal(resolveResponsesExtensionToolSpecForCall('copy_file', 'external'), null);
  assert.equal(resolveResponsesExtensionToolSpecForCall('apply_patch', ''), null);
  assert.equal(resolveResponsesExtensionToolSpecForCall('delete_file', ''), null);
  assert.equal(resolveResponsesExtensionToolSpecForCall('unknown_tool', ''), null);
  assert.equal(resolveAuthorizedResponsesExtensionToolSpec('delete_file', '', []), null);
  assert.equal(resolveAuthorizedResponsesExtensionToolSpec('delete_file', '', [
    { type: 'function', name: 'delete_file' }
  ]), null);
});

test('reconcileResponsesAllowedToolChoice 会同步当前不可用的本地工具', async () => {
  const {
    isAuthorizedResponsesApplyPatchTool,
    reconcileResponsesAllowedToolChoice
  } = await loadResponsesExtensionToolsModule();
  const finalTools = [
    { type: 'apply_patch' },
    { type: 'function', name: 'history_search' },
    { type: 'web_search' }
  ];

  assert.deepEqual(
    reconcileResponsesAllowedToolChoice({
      type: 'allowed_tools',
      mode: 'auto',
      tools: [
        'page_content_read',
        'delete_file',
        'apply_patch',
        { type: 'function', name: 'apply_patch' },
        { type: 'apply_patch' },
        'history_search',
        'web_search'
      ]
    }, finalTools),
    {
      type: 'allowed_tools',
      mode: 'auto',
      tools: [{ type: 'apply_patch' }, 'history_search', 'web_search']
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
    reconcileResponsesAllowedToolChoice({ type: 'apply_patch' }, finalTools),
    { type: 'apply_patch' }
  );
  assert.deepEqual(
    reconcileResponsesAllowedToolChoice({ type: 'function', name: 'apply_patch' }, finalTools),
    { type: 'apply_patch' }
  );
  assert.throws(
    () => reconcileResponsesAllowedToolChoice({ type: 'function', name: 'delete_file' }, finalTools),
    /当前不可用的本地 function：delete_file/
  );
  assert.equal(isAuthorizedResponsesApplyPatchTool(finalTools), true);
  assert.equal(isAuthorizedResponsesApplyPatchTool([{ type: 'function', name: 'apply_patch' }]), false);
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
  assert.equal(isResponsesExtensionToolEnabled({}, 'delete_file'), false);
});

test('官方 apply_patch 只对明确支持模型自动开启，并允许兼容端点显式覆盖', async () => {
  const {
    isResponsesApplyPatchModelSupported,
    isResponsesApplyPatchToolAvailable
  } = await loadResponsesExtensionToolsModule();

  assert.equal(isResponsesApplyPatchModelSupported('gpt-5.4'), true);
  assert.equal(isResponsesApplyPatchModelSupported('gpt-5.5-codex'), true);
  assert.equal(isResponsesApplyPatchModelSupported('gpt-5.6'), true);
  assert.equal(isResponsesApplyPatchModelSupported('gpt-4.1'), false);
  assert.equal(isResponsesApplyPatchToolAvailable({
    modelName: 'gpt-5.4',
    baseUrl: 'https://api.openai.com/v1/responses'
  }), true);
  assert.equal(isResponsesApplyPatchToolAvailable({
    modelName: 'gpt-5.4',
    baseUrl: 'https://responses.example.com/v1/responses'
  }), false);
  assert.equal(isResponsesApplyPatchToolAvailable({ modelName: 'third-party-model' }), false);
  assert.equal(isResponsesApplyPatchToolAvailable({
    modelName: 'third-party-model',
    responsesApiSettings: {
      extension_tools: {
        apply_patch: { enabled: true }
      }
    }
  }), true);
  assert.equal(isResponsesApplyPatchToolAvailable({
    modelName: 'gpt-5.4',
    responsesApiSettings: {
      extension_tools: {
        apply_patch: { enabled: false }
      }
    }
  }), false);
});

test('filterResponsesExtensionFunctionTools 会过滤被关闭的同名 function tools，并保持原数组不被就地修改', async () => {
  const { filterResponsesExtensionFunctionTools } = await loadResponsesExtensionToolsModule();

  const tools = [
    { type: 'function', name: 'view_image', parameters: { type: 'object' } },
    { type: 'function', namespace: 'external', name: 'view_image', parameters: { type: 'object' } },
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
      { type: 'function', namespace: 'external', name: 'view_image', parameters: { type: 'object' } },
      { type: 'function', name: 'page_content_read', parameters: { type: 'object' } },
      { type: 'web_search' }
    ]
  );
  assert.deepEqual(
    tools,
    [
      { type: 'function', name: 'view_image', parameters: { type: 'object' } },
      { type: 'function', namespace: 'external', name: 'view_image', parameters: { type: 'object' } },
      { type: 'function', name: 'page_content_read', parameters: { type: 'object' } },
      { type: 'web_search' }
    ]
  );
  assert.notEqual(filtered[0], tools[1]);
});

test('filterUnavailableResponsesExtensionTools 会阻止手写同名函数和退役工具绕过本轮暴露环境', async () => {
  const { filterUnavailableResponsesExtensionTools } = await loadResponsesExtensionToolsModule();
  const tools = [
    { type: 'apply_patch', description: 'invalid custom fields' },
    { type: 'function', name: 'apply_patch', description: 'retired custom schema' },
    { type: 'function', name: 'delete_file', description: 'retired collision' },
    { type: 'function', namespace: 'external', name: 'apply_patch', description: 'external namespace tool' },
    { type: 'function', name: 'page_content_read', description: 'raw collision' },
    { type: 'function', name: 'history_search', description: 'raw collision' },
    { type: 'function', name: 'external_custom', description: 'user handler' },
    { type: 'web_search' }
  ];
  const available = [
    { type: 'apply_patch' },
    { type: 'function', name: 'history_search', description: 'cerebr definition' }
  ];

  assert.deepEqual(
    filterUnavailableResponsesExtensionTools(tools, available),
    [
      { type: 'apply_patch', description: 'invalid custom fields' },
      { type: 'function', namespace: 'external', name: 'apply_patch', description: 'external namespace tool' },
      { type: 'function', name: 'history_search', description: 'raw collision' },
      { type: 'function', name: 'external_custom', description: 'user handler' },
      { type: 'web_search' }
    ]
  );
});

test('removeRetiredResponsesExtensionToolSettings 会清理旧 delete_file 开关', async () => {
  const { removeRetiredResponsesExtensionToolSettings } = await loadResponsesExtensionToolsModule();
  const original = {
    extension_tools: {
      delete_file: { enabled: true },
      copy_file: { enabled: false }
    }
  };

  assert.deepEqual(removeRetiredResponsesExtensionToolSettings(original), {
    extension_tools: {
      copy_file: { enabled: false }
    }
  });
  assert.ok(Object.prototype.hasOwnProperty.call(original.extension_tools, 'delete_file'));
});
