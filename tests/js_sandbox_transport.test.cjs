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

test('normalizeJsSandboxTransferValue 会完整保留 DOM-like 文本', async () => {
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

test('normalizeJsSandboxTransferValue 不再按深度、数组项或对象键隐藏截断', async () => {
  const { normalizeJsSandboxTransferValue } = await loadJsSandboxTransportModule();
  const deep = { value: 'leaf' };
  for (let index = 0; index < 12; index += 1) {
    deep.value = { index, child: deep.value };
  }
  const input = {
    deep,
    items: Array.from({ length: 120 }, (_, index) => index),
    keys: Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`key_${index}`, index])),
    node: {
      nodeType: 1,
      nodeName: 'DIV',
      textContent: 'T'.repeat(800),
      outerHTML: `<div>${'H'.repeat(1600)}</div>`
    }
  };

  const normalized = normalizeJsSandboxTransferValue(input);
  assert.equal(normalized.items.length, 120);
  assert.equal(Object.keys(normalized.keys).length, 120);
  assert.equal(normalized.node.textContent.length, 800);
  assert.equal(normalized.node.outerHTML.length, 1611);
  assert.doesNotMatch(JSON.stringify(normalized), /truncated_(?:array|object|items)|__truncated_keys__/);
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

test('buildJsSandboxSuccessEnvelope 会保留 console logs', async () => {
  const { buildJsSandboxSuccessEnvelope } = await loadJsSandboxTransportModule();
  const logs = Array.from({ length: 55 }, (_, index) => ({
    level: index === 54 ? 'warn' : 'log',
    text: index === 54 ? 'Z'.repeat(5000) : `entry-${index}`
  }));
  const envelope = buildJsSandboxSuccessEnvelope('done', logs);
  assert.equal(envelope.logs.length, 55);
  assert.equal(envelope.logs[54].text, 'Z'.repeat(5000));
  assert.deepEqual(envelope.items[0].logs, envelope.logs);
});
