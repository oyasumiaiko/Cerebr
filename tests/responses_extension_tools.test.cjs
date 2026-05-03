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
