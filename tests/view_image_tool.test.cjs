const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

async function loadViewImageToolModule() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cerebr-view-image-tool-'));
  await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  await fs.mkdir(path.join(tempDir, 'src', 'agent_tools', 'shared'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'src', 'agent_tools', 'view_image'), { recursive: true });
  await fs.copyFile(
    path.resolve(__dirname, '../src/agent_tools/shared/prompt_image_tool_shared.js'),
    path.join(tempDir, 'src', 'agent_tools', 'shared', 'prompt_image_tool_shared.js')
  );
  await fs.copyFile(
    path.resolve(__dirname, '../src/agent_tools/shared/model_tool_contract.js'),
    path.join(tempDir, 'src', 'agent_tools', 'shared', 'model_tool_contract.js')
  );
  await fs.copyFile(
    path.resolve(__dirname, '../src/agent_tools/view_image/tool.js'),
    path.join(tempDir, 'src', 'agent_tools', 'view_image', 'tool.js')
  );
  return import(`${pathToFileURL(path.join(tempDir, 'src', 'agent_tools', 'view_image', 'tool.js')).href}?test=${Date.now()}`);
}

test('normalizeViewImageArguments 支持 path 与 original detail', async () => {
  const { normalizeViewImageArguments } = await loadViewImageToolModule();

  assert.deepEqual(
    normalizeViewImageArguments({ path: 'C:\\tmp\\demo.png' }),
    { path: 'C:\\tmp\\demo.png', detail: null }
  );
  assert.deepEqual(
    normalizeViewImageArguments({ path: 'https://example.com/demo.png', detail: 'original' }),
    { path: 'https://example.com/demo.png', detail: 'original' }
  );
  assert.deepEqual(
    normalizeViewImageArguments({ url: 'Images/demo.png' }),
    { path: 'Images/demo.png', detail: null }
  );
});

test('normalizeViewImageArguments 对空 path 与未知 detail 返回明确错误', async () => {
  const { normalizeViewImageArguments } = await loadViewImageToolModule();

  assert.throws(
    () => normalizeViewImageArguments({}),
    /path 需要提供非空字符串/
  );
  assert.throws(
    () => normalizeViewImageArguments({ path: 'demo.png', detail: 'high' }),
    /只支持 `original`/
  );
});

test('buildViewImageFunctionToolDefinition 与 Codex 风格保持一致并声明 URL/本地路径支持', async () => {
  const {
    VIEW_IMAGE_TOOL_NAME,
    buildViewImageFunctionToolDefinition
  } = await loadViewImageToolModule();

  const spec = buildViewImageFunctionToolDefinition();
  assert.equal(spec.type, 'function');
  assert.equal(spec.name, VIEW_IMAGE_TOOL_NAME);
  assert.equal(spec.strict, true);
  assert.equal(spec.parameters.type, 'object');
  assert.equal(spec.parameters.additionalProperties, false);
  assert.deepEqual(spec.parameters.required, ['path', 'detail']);
  assert.match(spec.parameters.properties.path.description, /http\(s\)\/data URL/);
  assert.deepEqual(spec.parameters.properties.detail.enum, ['original', null]);
  assert.match(spec.parameters.properties.detail.description, /唯一可选字符串值是 `original`/);
  assert.match(spec.description, /用户明确指定/);
  assert.match(spec.description, /input_image/);
});
