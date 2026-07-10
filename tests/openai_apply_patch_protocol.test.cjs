const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadProtocolModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/virtual_file_io/openai_apply_patch.js');
  return import(`${pathToFileURL(filePath).href}?test=${Date.now()}`);
}

test('normalizeOpenAIApplyPatchOperation 严格校验官方 operation 并逐字保留 diff', async () => {
  const { normalizeOpenAIApplyPatchOperation } = await loadProtocolModule();
  const diff = ' context with leading space  \n-old\n+new\n ';

  assert.deepEqual(normalizeOpenAIApplyPatchOperation({
    type: 'update_file',
    path: './notes.md',
    diff
  }), {
    type: 'update_file',
    path: 'notes.md',
    diff
  });
  assert.deepEqual(normalizeOpenAIApplyPatchOperation({
    type: 'delete_file',
    path: 'notes.md',
    diff: 'ignored'
  }), {
    type: 'delete_file',
    path: 'notes.md'
  });
  assert.throws(
    () => normalizeOpenAIApplyPatchOperation({ type: 'move_file', path: 'a.md' }),
    /不支持 operation\.type/
  );
  assert.throws(
    () => normalizeOpenAIApplyPatchOperation({ type: 'create_file', path: 'a.md' }),
    /operation\.diff 必须是字符串/
  );
});

test('resolveOpenAIApplyPatchVirtualTarget 使用显式 skill 命名空间并拒绝 local 与越界路径', async () => {
  const { resolveOpenAIApplyPatchVirtualTarget } = await loadProtocolModule();

  assert.deepEqual(resolveOpenAIApplyPatchVirtualTarget({
    type: 'create_file',
    path: 'plans/main.md',
    diff: '+plan'
  }), {
    target: { kind: 'workspace', name: null },
    operation: { type: 'create_file', path: 'plans/main.md', diff: '+plan' },
    display_path: 'plans/main.md'
  });

  assert.deepEqual(resolveOpenAIApplyPatchVirtualTarget({
    type: 'update_file',
    path: '@skill/dom-probe/src/main.js',
    diff: '-old\n+new'
  }), {
    target: { kind: 'skill', name: 'dom-probe' },
    operation: { type: 'update_file', path: 'src/main.js', diff: '-old\n+new' },
    display_path: '@skill/dom-probe/src/main.js'
  });

  assert.throws(
    () => resolveOpenAIApplyPatchVirtualTarget({
      type: 'update_file',
      path: 'local/project/a.js',
      diff: '-old\n+new'
    }),
    /不能直接修改 `local\/\.\.\.` 只读映射/
  );
  assert.throws(
    () => resolveOpenAIApplyPatchVirtualTarget({
      type: 'create_file',
      path: 'workspace/local/project/a.js',
      diff: '+ghost'
    }),
    /不接受旧 `workspace\/\.\.\.` 前缀/
  );
  assert.throws(
    () => resolveOpenAIApplyPatchVirtualTarget({
      type: 'create_file',
      path: 'workspace/@skill/demo/a.js',
      diff: '+wrong target'
    }),
    /不接受旧 `workspace\/\.\.\.` 前缀/
  );
  assert.throws(
    () => resolveOpenAIApplyPatchVirtualTarget({
      type: 'delete_file',
      path: '../secret.txt'
    }),
    /不能包含空段、"\." 或 "\.\."/
  );
});

test('buildOpenAIApplyPatchCallOutputText 返回官方 call output 可消费的稳定纯文本', async () => {
  const { buildOpenAIApplyPatchCallOutputText } = await loadProtocolModule();

  assert.equal(buildOpenAIApplyPatchCallOutputText({
    ok: true,
    operation: { type: 'create_file', path: 'notes.md', diff: '+hello' },
    displayPath: '@skill/demo/notes.md'
  }), 'Success. Updated the following files:\nA @skill/demo/notes.md');
  assert.equal(buildOpenAIApplyPatchCallOutputText({
    ok: false,
    operation: { type: 'delete_file', path: 'notes.md' },
    errorMessage: 'missing file'
  }), 'Error: missing file');
});
