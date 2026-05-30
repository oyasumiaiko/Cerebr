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
  assert.deepEqual(payload.frames.map((item) => item.frame_id), [2]);
  const items = buildPageRuntimeContextInputItems(payload);
  assert.equal(items.length, 1);
  const text = items[0].content[0].text;
  assert.match(text, /<page_runtime_context mode="host_page">/);
  assert.match(text, /<page_content_tool>available<\/page_content_tool>/);
  assert.match(text, /<pdf_content_tool>unavailable<\/pdf_content_tool>/);
  assert.match(text, /<url>https:\/\/example\.com\/page<\/url>/);
  assert.match(text, /<frame id="2" top="false">/);
  assert.doesNotMatch(text, /<frame id="0" top="true">/);
});

test('顶层 frame 只补足 URL 和 Title，不写入 frames 隐藏列表', async () => {
  const {
    buildPageRuntimeContextPayload,
    buildPageRuntimeContextInputItems
  } = await loadPageRuntimeContextModule();

  const payload = buildPageRuntimeContextPayload({
    pageToolEnvironment: {
      exposePageContentTool: true,
      jsRuntimeEnvironment: 'bound_host_page'
    },
    pageMeta: null,
    frames: [
      { frameId: '', isTop: true, url: 'https://example.com/from-empty-id', title: 'Top From Empty ID' },
      { frameId: 0, isTop: true, url: 'https://example.com/from-zero', title: 'Top From Zero' }
    ]
  });

  assert.equal(payload.url, 'https://example.com/from-zero');
  assert.equal(payload.title, 'Top From Zero');
  assert.deepEqual(payload.frames, []);

  const text = buildPageRuntimeContextInputItems(payload)[0].content[0].text;
  assert.match(text, /<url>https:\/\/example\.com\/from-zero<\/url>/);
  assert.match(text, /<title>Top From Zero<\/title>/);
  assert.doesNotMatch(text, /<frames>/);
  assert.doesNotMatch(text, /id=""/);

  const legacyText = buildPageRuntimeContextInputItems({
    ...payload,
    frames: [
      { frame_id: '', is_top: true, url: 'https://example.com/legacy-top', title: 'Legacy Top' }
    ]
  })[0].content[0].text;
  assert.doesNotMatch(legacyText, /<frames>/);
  assert.doesNotMatch(legacyText, /id=""/);
});

test('PDF runtime context 会标记 PDF 读取工具可用且页面读取工具不可用', async () => {
  const { buildPageRuntimeContextPayload } = await loadPageRuntimeContextModule();

  const payload = buildPageRuntimeContextPayload({
    pageToolEnvironment: {
      exposePageContentTool: false,
      exposePdfContentTool: true,
      jsRuntimeEnvironment: 'bound_host_page'
    },
    pageMeta: {
      url: 'https://example.com/file.pdf',
      title: 'Example PDF'
    },
    frames: []
  });

  assert.equal(payload.page_content_tool, 'unavailable');
  assert.equal(payload.pdf_content_tool, 'available');
});

test('isolated sandbox runtime context 不再生成隐藏页面上下文', async () => {
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

  assert.equal(payload, null);
  const items = buildPageRuntimeContextInputItems(payload);
  assert.deepEqual(items, []);
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

test('resolvePageRuntimeContextAttachment 在纯对话模式下不会追加覆盖性页面说明', async () => {
  const {
    buildPageRuntimeContextPayload,
    resolvePageRuntimeContextAttachment
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

  const switchedFromHost = resolvePageRuntimeContextAttachment({
    payload: isolatedPayload,
    previousEffectiveSignature: '{"type":"page_runtime_context","mode":"host_page"}'
  });
  assert.equal(switchedFromHost.signature, null);
  assert.equal(switchedFromHost.inputItems, null);
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

  assert.equal(payload.frames.length, 1);
  assert.deepEqual(payload.frames.map((item) => item.frame_id), [22]);

  const text = buildPageRuntimeContextInputItems(payload)[0].content[0].text;
  assert.doesNotMatch(text, /recaptcha/);
  assert.doesNotMatch(text, /about:blank/);
  assert.doesNotMatch(text, /<frame id="0" top="true">/);
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
