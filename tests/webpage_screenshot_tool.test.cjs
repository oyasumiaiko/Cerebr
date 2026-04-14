const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

async function loadWebpageScreenshotToolModule() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cerebr-webpage-screenshot-tool-'));
  await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  await fs.mkdir(path.join(tempDir, 'src', 'agent_tools', 'shared'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'src', 'agent_tools', 'webpage_screenshot'), { recursive: true });
  await fs.copyFile(
    path.resolve(__dirname, '../src/agent_tools/shared/prompt_image_tool_shared.js'),
    path.join(tempDir, 'src', 'agent_tools', 'shared', 'prompt_image_tool_shared.js')
  );
  await fs.copyFile(
    path.resolve(__dirname, '../src/agent_tools/webpage_screenshot/tool.js'),
    path.join(tempDir, 'src', 'agent_tools', 'webpage_screenshot', 'tool.js')
  );
  return import(`${pathToFileURL(path.join(tempDir, 'src', 'agent_tools', 'webpage_screenshot', 'tool.js')).href}?test=${Date.now()}`);
}

test('normalizeWebpageScreenshotArguments 默认走压缩模式，并允许 original', async () => {
  const { normalizeWebpageScreenshotArguments } = await loadWebpageScreenshotToolModule();

  assert.deepEqual(
    normalizeWebpageScreenshotArguments({}),
    { detail: null }
  );
  assert.deepEqual(
    normalizeWebpageScreenshotArguments({ detail: 'original' }),
    { detail: 'original' }
  );
  assert.deepEqual(
    normalizeWebpageScreenshotArguments({ detail: '  original  ' }),
    { detail: 'original' }
  );
});

test('normalizeWebpageScreenshotArguments 对未知 detail 返回明确错误', async () => {
  const { normalizeWebpageScreenshotArguments } = await loadWebpageScreenshotToolModule();

  assert.throws(
    () => normalizeWebpageScreenshotArguments({ detail: 'low' }),
    /只支持 `original`/
  );
});

test('buildWebpageScreenshotFunctionToolDefinition 与 Codex 风格保持一致', async () => {
  const {
    WEBPAGE_SCREENSHOT_TOOL_NAME,
    buildWebpageScreenshotFunctionToolDefinition
  } = await loadWebpageScreenshotToolModule();

  const spec = buildWebpageScreenshotFunctionToolDefinition();
  assert.equal(spec.type, 'function');
  assert.equal(spec.name, WEBPAGE_SCREENSHOT_TOOL_NAME);
  assert.equal(spec.strict, false);
  assert.match(spec.description, /Capture a screenshot of the currently bound webpage/);
  assert.equal(spec.parameters.type, 'object');
  assert.equal(spec.parameters.additionalProperties, false);
  assert.equal(Array.isArray(spec.parameters.properties.detail.type), true);
  assert.match(spec.parameters.properties.detail.description, /only supported value is `original`/);
});
