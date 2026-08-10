const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function importSource(relativePath) {
  return import(pathToFileURL(path.resolve(__dirname, '..', relativePath)).href);
}

const EXPECTED_GRAMMAR = `start: begin_patch environment_id? hunk+ end_patch
environment_id: "*** Environment ID: " filename LF
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

test('请求 registry 只暴露 custom apply_patch 且 grammar 固定到上游版本', async () => {
  const { buildResponsesExtensionTools } = await importSource(
    'src/agent_tools/shared/responses_extension_tool_registry.js'
  );
  const definitions = buildResponsesExtensionTools({
    pageToolEnvironment: {},
    hasJsRuntime: false
  });
  const applyDefinitions = definitions.filter(item => item.name === 'apply_patch');

  assert.equal(applyDefinitions.length, 1);
  assert.equal(applyDefinitions[0].type, 'custom');
  assert.equal(definitions.some(item => item.type === 'function' && item.name === 'apply_patch'), false);
  assert.deepEqual(applyDefinitions[0].format, {
    type: 'grammar',
    syntax: 'lark',
    definition: EXPECTED_GRAMMAR
  });
});

test('Freeform Environment ID 只允许缺省会话区或 skill:<stable-key>', async () => {
  const {
    normalizeVirtualFileApplyPatchCustomInput,
    normalizeVirtualFileToolArguments
  } = await importSource(
    'src/agent_tools/virtual_file_io/index.js'
  );
  const root = normalizeVirtualFileApplyPatchCustomInput(
    '*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch'
  );
  assert.deepEqual(root.target, { kind: 'root', name: null });

  const skill = normalizeVirtualFileApplyPatchCustomInput(
    '*** Begin Patch\n*** Environment ID: skill:stable-key\n*** Add File: a.txt\n+x\n*** End Patch'
  );
  assert.deepEqual(skill.target, { kind: 'skill', name: 'stable-key' });

  assert.throws(
    () => normalizeVirtualFileApplyPatchCustomInput(
      '*** Begin Patch\n*** Environment ID: remote\n*** Add File: a.txt\n+x\n*** End Patch'
    ),
    /仅允许 skill:<stable-key>/
  );
  const localPatch = normalizeVirtualFileApplyPatchCustomInput(
    '*** Begin Patch\n*** Environment ID: skill:stable-key\n*** Add File: local/a.txt\n+x\n*** End Patch'
  );
  assert.equal(localPatch.target.kind, 'skill');
  assert.equal(localPatch.patch.includes('*** Add File: local/a.txt'), true);
  assert.throws(
    () => normalizeVirtualFileToolArguments('apply_patch', {
      patch: '*** Begin Patch\n*** Add File: local/a.txt\n+x\n*** End Patch'
    }),
    /不能直接修改 local 映射路径/
  );
  assert.throws(
    () => normalizeVirtualFileToolArguments('apply_patch', {
      patch: '*** Begin Patch\n*** Add File: ./local/a.txt\n+x\n*** End Patch'
    }),
    /不能直接修改 local 映射路径/
  );
});

test('sender 使用完整 Custom Tool SSE 与 follow-up 生命周期且没有协议回退', async () => {
  const source = await fs.readFile(
    path.resolve(__dirname, '../src/core/message_sender.js'),
    'utf8'
  );
  assert.match(source, /response\.custom_tool_call_input\.delta/);
  assert.match(source, /response\.custom_tool_call_input\.done/);
  assert.match(source, /type:\s*'custom_tool_call'/);
  assert.match(source, /type:\s*'custom_tool_call_output'/);
  assert.match(source, /call_id:\s*callId/);
  assert.match(source, /normalizeVirtualFileApplyPatchCustomInput/);
  assert.match(source, /splitResponsesToolOutputControl\(\{\},\s*\{/);
  assert.doesNotMatch(source, /paginate\(serializedOutput,\s*null\)/);
  assert.doesNotMatch(source, /apply_patch[\s\S]{0,200}(?:fallback|回退)[\s\S]{0,200}function_call/i);
});

test('历史回放仍同时识别旧 function_call 与新 custom_tool_call', async () => {
  const { isVirtualFileToolCall } = await importSource(
    'src/utils/conversation_document_tool_summary.js'
  );
  assert.equal(isVirtualFileToolCall({ type: 'function_call', name: 'apply_patch' }), true);
  assert.equal(isVirtualFileToolCall({ type: 'custom_tool_call', name: 'apply_patch' }), true);
  assert.equal(isVirtualFileToolCall({ type: 'custom_tool_call', name: 'read_file' }), false);
});
