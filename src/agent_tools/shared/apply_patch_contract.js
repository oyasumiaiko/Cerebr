/**
 * Cerebr 与 Codex `apply_patch` 对齐时使用的唯一协议事实来源。
 *
 * 这里同时约束：
 * - 模型可见的 Freeform tool description 与 Lark grammar；
 * - sidebar / background 跨 MV3 上下文通信时的内部版本；
 * - parser 语义所同步的 OpenAI Codex 上游提交。
 *
 * 当 parser、grammar 或跨上下文 payload 发生不兼容变化时，必须显式更新
 * `APPLY_PATCH_RUNTIME_CONTRACT_ID`。旧上下文因此会 fail closed，而不是继续用
 * 不同版本的 parser 解释同一份 patch。
 */

export const APPLY_PATCH_UPSTREAM_REVISION = '63d213884daea50e4f74efc192cdc44f549b67d5';
export const APPLY_PATCH_RUNTIME_WIRE_VERSION = 3;
export const APPLY_PATCH_PARSER_REVISION = 'codex-63d2138-faithful-js-port';
export const APPLY_PATCH_GRAMMAR_REVISION = 'codex-63d2138-environment-id';
export const APPLY_PATCH_RUNTIME_CONTRACT_ID = 'codex-apply-patch@63d2138/cerebr-v3';

export const APPLY_PATCH_RUNTIME_CONTRACT_MESSAGE_TYPE = 'GET_APPLY_PATCH_RUNTIME_CONTRACT';
export const APPLY_PATCH_RUNTIME_MISMATCH_CODE = 'APPLY_PATCH_RUNTIME_VERSION_MISMATCH';

export const APPLY_PATCH_CUSTOM_TOOL_DESCRIPTION =
  'The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.';

// 与 Codex 上游 `codex-rs/core/assets/tools/apply_patch.lark` 保持逐字一致，
// 仅在 start 后加入 Cerebr 多虚拟环境需要的可选 Environment ID。
export const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch environment_id? hunk+ end_patch
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

export const APPLY_PATCH_RUNTIME_CONTRACT = Object.freeze({
  contract_id: APPLY_PATCH_RUNTIME_CONTRACT_ID,
  wire_version: APPLY_PATCH_RUNTIME_WIRE_VERSION,
  parser_revision: APPLY_PATCH_PARSER_REVISION,
  grammar_revision: APPLY_PATCH_GRAMMAR_REVISION,
  upstream_revision: APPLY_PATCH_UPSTREAM_REVISION
});

function normalizeOptionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeOptionalInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

export function buildApplyPatchRuntimeContractPayload() {
  return { ...APPLY_PATCH_RUNTIME_CONTRACT };
}

export function normalizeApplyPatchRuntimeContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    contract_id: normalizeOptionalText(value.contract_id),
    wire_version: normalizeOptionalInteger(value.wire_version),
    parser_revision: normalizeOptionalText(value.parser_revision),
    grammar_revision: normalizeOptionalText(value.grammar_revision),
    upstream_revision: normalizeOptionalText(value.upstream_revision)
  };
}

export function compareApplyPatchRuntimeContract(receivedValue) {
  const expected = buildApplyPatchRuntimeContractPayload();
  const received = normalizeApplyPatchRuntimeContract(receivedValue);
  const matches = !!received
    && received.contract_id === expected.contract_id
    && received.wire_version === expected.wire_version
    && received.parser_revision === expected.parser_revision
    && received.grammar_revision === expected.grammar_revision
    && received.upstream_revision === expected.upstream_revision;
  return {
    ok: matches,
    expected,
    received
  };
}

export function createApplyPatchRuntimeMismatchError(receivedValue = null, options = {}) {
  const comparison = compareApplyPatchRuntimeContract(receivedValue);
  const localRole = options?.local_role === 'background' ? 'background' : 'sidebar';
  const remoteRole = localRole === 'background' ? 'sidebar' : 'background';
  const localContract = comparison.expected;
  const remoteContract = comparison.received;
  const sidebarContract = localRole === 'sidebar' ? localContract : remoteContract;
  const backgroundContract = localRole === 'background' ? localContract : remoteContract;
  const error = new Error(
    `扩展 apply_patch 运行时版本不一致：sidebar=${sidebarContract?.contract_id || 'unavailable'}，background=${backgroundContract?.contract_id || 'unavailable'}。请重新加载扩展后再发送。`
  );
  error.name = 'ApplyPatchRuntimeMismatchError';
  error.code = APPLY_PATCH_RUNTIME_MISMATCH_CODE;
  error.reload_required = true;
  error.state_changed = false;
  error.retryable = false;
  error.skipConversationAutoRetry = true;
  error.local_role = localRole;
  error.remote_role = remoteRole;
  error.sidebar_contract = sidebarContract;
  error.background_contract = backgroundContract;
  error.expected_contract = comparison.expected;
  error.received_contract = comparison.received;
  return error;
}

export function requestExposesApplyPatchTool(requestBody) {
  const tools = Array.isArray(requestBody?.tools) ? requestBody.tools : [];
  return tools.some((tool) => {
    if (!tool || typeof tool !== 'object') return false;
    const name = normalizeOptionalText(tool.name);
    const type = normalizeOptionalText(tool.type)?.toLowerCase();
    return name === 'apply_patch' && type === 'custom';
  });
}
