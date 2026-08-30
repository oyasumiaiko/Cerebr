const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..');

function importSource(relativePath) {
  return import(`${pathToFileURL(path.join(repoRoot, relativePath)).href}?test=${Date.now()}-${Math.random()}`);
}

test('apply_patch grammar 与 description 固定到 Codex 63d2138 fixture，仅增加 Environment ID', async () => {
  const contract = await importSource('src/agent_tools/shared/apply_patch_contract.js');
  const upstreamGrammar = await fs.readFile(
    path.join(repoRoot, 'tests/fixtures/codex_apply_patch_63d2138.lark'),
    'utf8'
  );
  const upstreamDescription = (await fs.readFile(
    path.join(repoRoot, 'tests/fixtures/codex_apply_patch_63d2138_description.txt'),
    'utf8'
  )).trimEnd();
  const expectedCerebrGrammar = upstreamGrammar.replace(
    'start: begin_patch hunk+ end_patch\n',
    'start: begin_patch environment_id? hunk+ end_patch\nenvironment_id: "*** Environment ID: " filename LF\n'
  );

  assert.equal(
    contract.APPLY_PATCH_UPSTREAM_REVISION,
    '63d213884daea50e4f74efc192cdc44f549b67d5'
  );
  assert.equal(contract.APPLY_PATCH_CUSTOM_TOOL_DESCRIPTION, upstreamDescription);
  assert.equal(contract.APPLY_PATCH_LARK_GRAMMAR, expectedCerebrGrammar);
});

test('runtime contract 对缺失和任意字段漂移都 fail closed，并返回稳定无副作用错误', async () => {
  const contract = await importSource('src/agent_tools/shared/apply_patch_contract.js');
  const expected = contract.buildApplyPatchRuntimeContractPayload();

  assert.equal(contract.compareApplyPatchRuntimeContract(null).ok, false);
  for (const key of ['contract_id', 'wire_version', 'parser_revision', 'grammar_revision', 'upstream_revision']) {
    const changed = { ...expected };
    changed[key] = key === 'wire_version' ? expected[key] + 1 : `${expected[key]}-old`;
    assert.equal(contract.compareApplyPatchRuntimeContract(changed).ok, false, key);
  }
  assert.equal(contract.compareApplyPatchRuntimeContract(expected).ok, true);

  const error = contract.createApplyPatchRuntimeMismatchError(null, { local_role: 'sidebar' });
  assert.equal(error.code, 'APPLY_PATCH_RUNTIME_VERSION_MISMATCH');
  assert.equal(error.reload_required, true);
  assert.equal(error.state_changed, false);
  assert.equal(error.retryable, false);
  assert.equal(error.skipConversationAutoRetry, true);
  assert.equal(error.sidebar_contract.contract_id, expected.contract_id);
  assert.equal(error.background_contract, null);
});

test('Skill 写 payload 不再携带独立 skill_name，只携带一致性上下文与精确 runtime contract', async () => {
  const virtualFiles = await importSource('src/agent_tools/virtual_file_io/index.js');
  const registry = await importSource('src/agent_tools/skill/registry_tool.js');
  const contract = await importSource('src/agent_tools/shared/apply_patch_contract.js');
  const patch = [
    '*** Begin Patch',
    '*** Environment ID: skill:stable-key',
    '*** Add File: notes.md',
    '+hello',
    '*** End Patch'
  ].join('\n');
  const normalized = virtualFiles.normalizeVirtualFileApplyPatchCustomInput(patch);
  const payload = virtualFiles.buildSkillRegistryFileActionPayloadFromVirtualFileAction(
    'apply_patch',
    normalized
  );

  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'skill_name'), false);
  assert.equal(payload.expected_environment_id, 'skill:stable-key');
  assert.deepEqual(payload.runtime_contract, contract.buildApplyPatchRuntimeContractPayload());

  const normalizedRegistryArgs = registry.normalizeSkillRegistryToolArguments(payload);
  assert.equal(normalizedRegistryArgs.skill_name, null);
  assert.equal(normalizedRegistryArgs.expected_environment_id, 'skill:stable-key');
  assert.throws(
    () => registry.normalizeSkillRegistryToolArguments({
      ...payload,
      skill_name: 'different-key'
    }),
    /内部环境上下文冲突/
  );
});

test('sidebar/background 门禁位于 Responses 网络请求和 Skill 持久化之前', async () => {
  const [backgroundSource, sidebarSource, bootstrapSource, senderSource] = await Promise.all([
    fs.readFile(path.join(repoRoot, 'src/extension/background.js'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'src/ui/sidebar/sidebar_app_context.js'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'src/ui/sidebar/sidebar_bootstrap.js'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'src/core/message_sender.js'), 'utf8')
  ]);

  assert.match(backgroundSource, /GET_APPLY_PATCH_RUNTIME_CONTRACT|APPLY_PATCH_RUNTIME_CONTRACT_MESSAGE_TYPE/);
  const backgroundCompare = backgroundSource.indexOf('compareApplyPatchRuntimeContract(rawPayload.runtime_contract)');
  const backgroundWrite = backgroundSource.indexOf('skillManager.executeRegistryAction(registryPayload');
  assert.ok(backgroundCompare >= 0 && backgroundWrite > backgroundCompare);

  assert.match(bootstrapSource, /ensureApplyPatchRuntimeContract\?\.\(\{ force: true \}\)/);
  assert.match(sidebarSource, /runtimeContractBlocked/);
  assert.match(sidebarSource, /chrome\?\.runtime\?\.reload|chrome\.runtime\.reload/);

  const requestPreflight = senderSource.indexOf(
    'await appContext.utils.ensureApplyPatchRuntimeContract({ force: true })'
  );
  const networkSend = senderSource.indexOf('response = await apiManager.sendRequest({', requestPreflight);
  assert.ok(requestPreflight >= 0 && networkSend > requestPreflight);
  assert.match(senderSource, /EMPTY_TOOL_FOLLOWUP_RESPONSE/);
});
