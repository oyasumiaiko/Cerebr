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

test('formatEnvironmentCurrentDate 在默认 now=null 时使用当前时间而不是 Unix epoch', async () => {
  const { formatEnvironmentCurrentDate } = await loadEnvironmentContextModule();

  const before = new Date();
  const actual = formatEnvironmentCurrentDate('Asia/Shanghai', null);
  const after = new Date();

  const expectedCandidates = [];
  for (const candidate of [before, after]) {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const parts = formatter.formatToParts(candidate);
    const year = parts.find((item) => item.type === 'year')?.value || '';
    const month = parts.find((item) => item.type === 'month')?.value || '';
    const day = parts.find((item) => item.type === 'day')?.value || '';
    expectedCandidates.push(`${year}-${month}-${day}`);
  }

  assert.ok(expectedCandidates.includes(actual), `unexpected current_date: ${actual}`);
  assert.notEqual(actual, '1970-01-01');
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

test('buildEnvironmentContextInputItems 会在用户上传文件时附带文件处理与命名规范', async () => {
  const {
    buildEnvironmentContextPayload,
    buildEnvironmentContextInputItems
  } = await loadEnvironmentContextModule();

  const payload = buildEnvironmentContextPayload({
    timezone: 'Asia/Shanghai',
    currentDate: '2026-04-20',
    uploadedFiles: [
      {
        path: 'workspace/untitled',
        source_name: '',
        file_name_was_missing: true,
        upload_event_id: 'upload-1'
      }
    ]
  });

  assert.equal(Array.isArray(payload.uploaded_files), true);
  assert.equal(payload.uploaded_files.length, 1);
  const text = buildEnvironmentContextInputItems(payload)[0].content[0].text;
  assert.match(text, /<user_uploaded_files>/);
  assert.match(text, /<path>workspace\/untitled<\/path>/);
  assert.match(text, /<file_name_was_missing>true<\/file_name_was_missing>/);
  assert.match(text, /untitled/);
  assert.match(text, /Markdown 相对路径链接/);
  assert.match(text, /apply_patch 的 \*\*\* Move to:/);
});

test('buildEnvironmentContextInputItems 会声明 local mount 是只读实时映射', async () => {
  const {
    buildEnvironmentContextPayload,
    buildEnvironmentContextInputItems
  } = await loadEnvironmentContextModule();

  const payload = buildEnvironmentContextPayload({
    timezone: 'Asia/Shanghai',
    currentDate: '2026-04-20',
    localMounts: [
      {
        path: 'local/project',
        kind: 'directory',
        source_name: 'project',
        mount_event_id: 'mount-1'
      }
    ]
  });

  assert.equal(Array.isArray(payload.local_mounts), true);
  assert.equal(payload.local_mounts.length, 1);
  const text = buildEnvironmentContextInputItems(payload)[0].content[0].text;
  assert.match(text, /<local_file_mounts>/);
  assert.match(text, /<path>local\/project<\/path>/);
  assert.match(text, /<kind>directory<\/kind>/);
  assert.match(text, /<read_only>true<\/read_only>/);
  assert.match(text, /copy_file 把 local\/\.\.\. 复制到 workspace\/\.\.\./);
  assert.match(text, /list_files 或 search_files/);
});
