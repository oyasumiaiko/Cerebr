const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadJsSandboxTransportModule() {
  const filePath = path.resolve(__dirname, '../src/utils/js_sandbox_transport.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('normalizeJsSandboxTransferValue 能稳定处理循环引用与 bigint', async () => {
  const { normalizeJsSandboxTransferValue } = await loadJsSandboxTransportModule();
  const sample = { count: 3n };
  sample.self = sample;

  const normalized = normalizeJsSandboxTransferValue(sample);
  assert.deepEqual(normalized.count, { type: 'bigint', value: '3' });
  assert.deepEqual(normalized.self, { type: 'circular_ref' });
});

test('normalizeJsSandboxTransferValue 会把 DOM-like 值压成可显示预览', async () => {
  const { normalizeJsSandboxTransferValue } = await loadJsSandboxTransportModule();
  const normalized = normalizeJsSandboxTransferValue({
    nodeType: 1,
    nodeName: 'DIV',
    id: 'demo',
    className: 'card primary',
    textContent: 'hello world',
    outerHTML: '<div id="demo" class="card primary">hello world</div>'
  });

  assert.equal(normalized.type, 'dom_node');
  assert.equal(normalized.nodeName, 'DIV');
  assert.equal(normalized.id, 'demo');
});

test('buildJsSandboxSuccessEnvelope 会生成稳定 frame 结果', async () => {
  const {
    buildJsSandboxSuccessEnvelope,
    buildJsSandboxFrameSnapshot,
    JS_SANDBOX_DOCUMENT_ID
  } = await loadJsSandboxTransportModule();

  const envelope = buildJsSandboxSuccessEnvelope({ ok: true });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.items[0].documentId, JS_SANDBOX_DOCUMENT_ID);

  const frame = buildJsSandboxFrameSnapshot('chrome-extension://example/sandbox.html');
  assert.equal(frame.documentId, JS_SANDBOX_DOCUMENT_ID);
  assert.equal(frame.frameId, 0);
  assert.equal(frame.isTop, true);
});
