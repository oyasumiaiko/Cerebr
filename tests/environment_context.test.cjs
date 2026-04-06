const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

async function loadEnvironmentContextModule() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cerebr-environment-context-'));
  await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  await fs.mkdir(path.join(tempDir, 'src', 'utils'), { recursive: true });
  await fs.copyFile(
    path.resolve(__dirname, '../src/utils/environment_context.js'),
    path.join(tempDir, 'src', 'utils', 'environment_context.js')
  );
  return import(pathToFileURL(path.join(tempDir, 'src', 'utils', 'environment_context.js')).href);
}

test('buildEnvironmentContextPayload 会生成 current_date 与 timezone', async () => {
  const {
    buildEnvironmentContextPayload,
    buildEnvironmentContextInputItems
  } = await loadEnvironmentContextModule();

  const payload = buildEnvironmentContextPayload({
    timezone: 'Asia/Shanghai',
    now: Date.UTC(2026, 3, 7, 10, 30, 0)
  });

  assert.deepEqual(payload, {
    type: 'environment_context',
    current_date: '2026-04-07',
    timezone: 'Asia/Shanghai'
  });

  const items = buildEnvironmentContextInputItems(payload);
  assert.equal(items.length, 1);
  const text = items[0].content[0].text;
  assert.match(text, /<environment_context>/);
  assert.match(text, /<current_date>2026-04-07<\/current_date>/);
  assert.match(text, /<timezone>Asia\/Shanghai<\/timezone>/);
});

test('resolveEnvironmentContextAttachment 在签名未变化时不重复追加', async () => {
  const {
    buildEnvironmentContextPayload,
    buildEnvironmentContextSignature,
    resolveEnvironmentContextAttachment
  } = await loadEnvironmentContextModule();

  const payload = buildEnvironmentContextPayload({
    timezone: 'Asia/Shanghai',
    currentDate: '2026-04-07'
  });
  const signature = buildEnvironmentContextSignature(payload);

  const unchanged = resolveEnvironmentContextAttachment({
    payload,
    previousEffectiveSignature: signature
  });
  assert.equal(unchanged.signature, null);
  assert.equal(unchanged.inputItems, null);

  const changed = resolveEnvironmentContextAttachment({
    payload,
    previousEffectiveSignature: ''
  });
  assert.equal(typeof changed.signature, 'string');
  assert.ok(Array.isArray(changed.inputItems));
});
