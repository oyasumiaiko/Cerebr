const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadPageToolEnvironmentModule() {
  const filePath = path.resolve(__dirname, '../src/utils/page_tool_environment.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('宿主页嵌入模式下暴露页面工具并绑定宿主页 JS 环境', async () => {
  const {
    resolvePageToolEnvironment,
    JS_RUNTIME_ENV_BOUND_HOST_PAGE
  } = await loadPageToolEnvironmentModule();
  const result = resolvePageToolEnvironment({
    isStandalone: false,
    isTemporaryMode: false
  });

  assert.equal(result.exposeHostPageTools, true);
  assert.equal(result.exposePageContentTool, true);
  assert.equal(result.shouldInjectJsRuntimeFrameContext, true);
  assert.equal(result.jsRuntimeEnvironment, JS_RUNTIME_ENV_BOUND_HOST_PAGE);
});

test('纯对话模式下隐藏页面工具并切到隔离沙箱', async () => {
  const {
    resolvePageToolEnvironment,
    JS_RUNTIME_ENV_ISOLATED_SANDBOX,
    buildPageToolModeStatusTitle
  } = await loadPageToolEnvironmentModule();
  const result = resolvePageToolEnvironment({
    isStandalone: false,
    isTemporaryMode: true
  });

  assert.equal(result.exposeHostPageTools, false);
  assert.equal(result.exposePageContentTool, false);
  assert.equal(result.shouldInjectJsRuntimeFrameContext, false);
  assert.equal(result.jsRuntimeEnvironment, JS_RUNTIME_ENV_ISOLATED_SANDBOX);
  assert.match(buildPageToolModeStatusTitle(result), /隔离沙箱/);
});

test('独立页模式下即使未开纯对话也仍使用隔离沙箱', async () => {
  const {
    resolvePageToolEnvironment,
    JS_RUNTIME_ENV_ISOLATED_SANDBOX
  } = await loadPageToolEnvironmentModule();
  const result = resolvePageToolEnvironment({
    isStandalone: true,
    isTemporaryMode: false
  });

  assert.equal(result.exposeHostPageTools, false);
  assert.equal(result.exposePageContentTool, false);
  assert.equal(result.jsRuntimeEnvironment, JS_RUNTIME_ENV_ISOLATED_SANDBOX);
});
