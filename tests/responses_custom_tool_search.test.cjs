const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadResponsesCustomToolSearchModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/shared/responses_custom_tool_search.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('hasResponsesHostedToolSearchTool 能识别最终请求体里的 hosted tool_search', async () => {
  const { hasResponsesHostedToolSearchTool } = await loadResponsesCustomToolSearchModule();

  assert.equal(
    hasResponsesHostedToolSearchTool([
      { type: 'web_search' },
      { type: 'tool_search' }
    ]),
    true
  );
  assert.equal(
    hasResponsesHostedToolSearchTool([
      { type: 'function', name: 'page_content_read' }
    ]),
    false
  );
});

test('adaptResponsesCustomFunctionToolsForHostedToolSearch 只在 hosted tool_search 启用时标记指定 function 为 defer_loading', async () => {
  const { adaptResponsesCustomFunctionToolsForHostedToolSearch } = await loadResponsesCustomToolSearchModule();

  const tools = [
    {
      type: 'function',
      name: 'page_content_read',
      description: 'read page',
      parameters: { type: 'object' }
    },
    {
      type: 'function',
      name: 'view_image',
      description: 'view image',
      parameters: { type: 'object' }
    },
    {
      type: 'web_search'
    }
  ];

  const adapted = adaptResponsesCustomFunctionToolsForHostedToolSearch(tools, {
    hostedToolSearchEnabled: true,
    searchableToolNames: ['page_content_read']
  });

  assert.equal(adapted[0].defer_loading, true);
  assert.equal(Object.prototype.hasOwnProperty.call(adapted[1], 'defer_loading'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(adapted[2], 'defer_loading'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(tools[0], 'defer_loading'), false);
});

test('adaptResponsesCustomFunctionToolsForHostedToolSearch 在未启用 hosted tool_search 时保持原契约', async () => {
  const { adaptResponsesCustomFunctionToolsForHostedToolSearch } = await loadResponsesCustomToolSearchModule();

  const tools = [
    {
      type: 'function',
      name: 'history_search',
      parameters: { type: 'object' }
    }
  ];

  const adapted = adaptResponsesCustomFunctionToolsForHostedToolSearch(tools, {
    hostedToolSearchEnabled: false,
    searchableToolNames: ['history_search']
  });

  assert.deepEqual(adapted, tools);
  assert.notEqual(adapted[0], tools[0]);
});
