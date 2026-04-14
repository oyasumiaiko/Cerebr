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
  await fs.mkdir(path.join(tempDir, 'src', 'agent_tools', 'shared'), { recursive: true });
  await fs.copyFile(
    path.resolve(__dirname, '../src/utils/page_runtime_context.js'),
    path.join(tempDir, 'src', 'utils', 'page_runtime_context.js')
  );
  await fs.copyFile(
    path.resolve(__dirname, '../src/agent_tools/shared/page_tool_environment.js'),
    path.join(tempDir, 'src', 'agent_tools', 'shared', 'page_tool_environment.js')
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
  assert.match(text, /<page_runtime_context mode="host_page">/);
  assert.match(text, /<url>https:\/\/example\.com\/page<\/url>/);
  assert.match(text, /<frame id="2" top="false">/);
});

test('isolated sandbox runtime context 使用紧凑 XML 结构', async () => {
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
  assert.match(text, /<page_runtime_context mode="isolated_sandbox">/);
  assert.match(text, /<js_runtime_environment>isolated_sandbox_iframe<\/js_runtime_environment>/);
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

test('resolvePageRuntimeContextAttachment 在纯对话模式且此前没有上下文时不主动插入说明', async () => {
  const {
    buildPageRuntimeContextPayload,
    resolvePageRuntimeContextAttachment,
    buildPageRuntimeContextSignature
  } = await loadPageRuntimeContextModule();

  const isolatedPayload = buildPageRuntimeContextPayload({
    pageToolEnvironment: {
      exposePageContentTool: false,
      jsRuntimeEnvironment: 'isolated_sandbox_iframe'
    },
    pageMeta: null,
    frames: null
  });

  const firstPureTurn = resolvePageRuntimeContextAttachment({
    payload: isolatedPayload,
    previousEffectiveSignature: ''
  });
  assert.equal(firstPureTurn.signature, null);
  assert.equal(firstPureTurn.inputItems, null);

  const priorHostPayload = buildPageRuntimeContextPayload({
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
  const switchedFromHost = resolvePageRuntimeContextAttachment({
    payload: isolatedPayload,
    previousEffectiveSignature: buildPageRuntimeContextSignature(priorHostPayload)
  });
  assert.equal(typeof switchedFromHost.signature, 'string');
  assert.ok(Array.isArray(switchedFromHost.inputItems));
});

test('page runtime context 会过滤高频挑战 iframe 与无描述 blank 辅助 frame', async () => {
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
      url: 'https://platform.worldquantbrain.com/simulate',
      title: 'WorldQuant BRAIN'
    },
    frames: [
      { frameId: 0, isTop: true, url: 'https://platform.worldquantbrain.com/simulate', title: 'WorldQuant BRAIN' },
      { frameId: 18141, isTop: false, url: 'https://www.google.com/recaptcha/api2/anchor?ar=1&k=abc&cb=foo', title: '' },
      { frameId: 18149, isTop: false, url: 'https://www.google.com/recaptcha/api2/bframe?hl=zh-CN&v=test', title: '' },
      { frameId: 18143, isTop: false, url: 'about:blank', title: '' },
      { frameId: 22, isTop: false, url: 'https://platform.worldquantbrain.com/embed/panel', title: 'Research Panel' }
    ]
  });

  assert.equal(payload.frames.length, 2);
  assert.deepEqual(payload.frames.map((item) => item.frame_id), [0, 22]);

  const text = buildPageRuntimeContextInputItems(payload)[0].content[0].text;
  assert.doesNotMatch(text, /recaptcha/);
  assert.doesNotMatch(text, /about:blank/);
  assert.match(text, /Research Panel/);
});

test('仅挑战 iframe query 变化不会导致 page runtime context 签名抖动', async () => {
  const {
    buildPageRuntimeContextPayload,
    buildPageRuntimeContextSignature
  } = await loadPageRuntimeContextModule();

  const left = buildPageRuntimeContextPayload({
    pageToolEnvironment: {
      exposePageContentTool: true,
      jsRuntimeEnvironment: 'bound_host_page'
    },
    pageMeta: {
      url: 'https://platform.worldquantbrain.com/simulate',
      title: 'WorldQuant BRAIN'
    },
    frames: [
      { frameId: 0, isTop: true, url: 'https://platform.worldquantbrain.com/simulate', title: 'WorldQuant BRAIN' },
      { frameId: 18141, isTop: false, url: 'https://www.google.com/recaptcha/api2/anchor?ar=1&cb=foo', title: '' },
      { frameId: 18143, isTop: false, url: 'about:blank', title: '' }
    ]
  });
  const right = buildPageRuntimeContextPayload({
    pageToolEnvironment: {
      exposePageContentTool: true,
      jsRuntimeEnvironment: 'bound_host_page'
    },
    pageMeta: {
      url: 'https://platform.worldquantbrain.com/simulate',
      title: 'WorldQuant BRAIN'
    },
    frames: [
      { frameId: 0, isTop: true, url: 'https://platform.worldquantbrain.com/simulate', title: 'WorldQuant BRAIN' },
      { frameId: 18162, isTop: false, url: 'https://www.google.com/recaptcha/api2/anchor?ar=2&cb=bar', title: '' },
      { frameId: 18164, isTop: false, url: 'about:blank', title: '' }
    ]
  });

  assert.equal(buildPageRuntimeContextSignature(left), buildPageRuntimeContextSignature(right));
});
