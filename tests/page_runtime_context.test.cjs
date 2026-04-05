const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

async function loadPageRuntimeContextModule() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cerebr-page-runtime-context-'));
  await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  await fs.mkdir(path.join(tempDir, 'src', 'utils'), { recursive: true });
  await fs.copyFile(
    path.resolve(__dirname, '../src/utils/page_runtime_context.js'),
    path.join(tempDir, 'src', 'utils', 'page_runtime_context.js')
  );
  await fs.copyFile(
    path.resolve(__dirname, '../src/utils/page_tool_environment.js'),
    path.join(tempDir, 'src', 'utils', 'page_tool_environment.js')
  );
  return import(pathToFileURL(path.join(tempDir, 'src', 'utils', 'page_runtime_context.js')).href);
}

test('host page runtime context 会包含 URL、Title 与 frame 列表', async () => {
  const {
    buildPageRuntimeContextPayload,
    buildPageRuntimeContextInputItems
  } = await loadPageRuntimeContextModule();

  const payload = buildPageRuntimeContextPayload({
    pageToolEnvironment: {
      exposePageContentTool: true,
      jsRuntimeEnvironment: 'bound_host_page'
    },
    pageMeta: {
      url: 'https://example.com/page',
      title: 'Example Page'
    },
    frames: [
      { frameId: 0, isTop: true, url: 'https://example.com/page', title: 'Example Page' },
      { frameId: 2, isTop: false, url: 'https://example.com/embed', title: 'Embed' }
    ]
  });

  assert.equal(payload.mode, 'host_page');
  const items = buildPageRuntimeContextInputItems(payload);
  assert.equal(items.length, 1);
  const text = items[0].content[0].text;
  assert.match(text, /Page URL: https:\/\/example\.com\/page/);
  assert.match(text, /frame_id=2/);
});

test('isolated sandbox runtime context 会明确说明不访问宿主标签页', async () => {
  const {
    buildPageRuntimeContextPayload,
    buildPageRuntimeContextInputItems
  } = await loadPageRuntimeContextModule();

  const payload = buildPageRuntimeContextPayload({
    pageToolEnvironment: {
      exposePageContentTool: false,
      jsRuntimeEnvironment: 'isolated_sandbox_iframe'
    },
    pageMeta: null,
    frames: null
  });

  assert.equal(payload.mode, 'isolated_sandbox');
  const items = buildPageRuntimeContextInputItems(payload);
  const text = items[0].content[0].text;
  assert.match(text, /隔离 sandbox iframe/);
  assert.match(text, /不访问宿主标签页/);
});

test('resolvePageRuntimeContextAttachment 在签名未变化时不重复追加上下文', async () => {
  const {
    buildPageRuntimeContextPayload,
    buildPageRuntimeContextSignature,
    resolvePageRuntimeContextAttachment
  } = await loadPageRuntimeContextModule();

  const payload = buildPageRuntimeContextPayload({
    pageToolEnvironment: {
      exposePageContentTool: true,
      jsRuntimeEnvironment: 'bound_host_page'
    },
    pageMeta: {
      url: 'https://example.com/page',
      title: 'Example Page'
    },
    frames: [{ frameId: 0, isTop: true, url: 'https://example.com/page', title: 'Example Page' }]
  });
  const signature = buildPageRuntimeContextSignature(payload);

  const unchanged = resolvePageRuntimeContextAttachment({
    payload,
    previousEffectiveSignature: signature
  });
  assert.equal(unchanged.signature, null);
  assert.equal(unchanged.inputItems, null);

  const changed = resolvePageRuntimeContextAttachment({
    payload,
    previousEffectiveSignature: ''
  });
  assert.equal(typeof changed.signature, 'string');
  assert.ok(Array.isArray(changed.inputItems));
});
