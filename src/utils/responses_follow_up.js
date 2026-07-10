import { mergeResponsesInputItems } from './responses_input_items.js';

function normalizeString(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

function normalizeApplyPatchOperation(rawOperation) {
  if (!rawOperation || typeof rawOperation !== 'object' || Array.isArray(rawOperation)) {
    return null;
  }

  const type = normalizeString(rawOperation.type).toLowerCase();
  const path = normalizeString(rawOperation.path);
  if (!path || !['create_file', 'update_file', 'delete_file'].includes(type)) {
    return null;
  }

  const operation = { type, path };
  if (type === 'create_file' || type === 'update_file') {
    if (typeof rawOperation.diff !== 'string') return null;
    operation.diff = rawOperation.diff;
  }
  return operation;
}

function buildResponsesReplayFunctionCallItem(record) {
  if (!record || typeof record !== 'object') return null;
  if (normalizeString(record.type).toLowerCase() !== 'function_call') return null;

  const callId = normalizeString(record.call_id);
  if (!callId) return null;

  const item = {
    type: 'function_call',
    call_id: callId,
    name: (typeof record.name === 'string') ? record.name : '',
    arguments: (typeof record.arguments === 'string') ? record.arguments : ''
  };
  const namespace = normalizeString(record.namespace);
  if (namespace) {
    item.namespace = namespace;
  }
  const itemId = normalizeString(record.item_id);
  if (itemId) {
    item.item_id = itemId;
  }
  return item;
}

function buildResponsesReplayApplyPatchCallItem(record) {
  if (!record || typeof record !== 'object') return null;
  if (normalizeString(record.type).toLowerCase() !== 'apply_patch_call') return null;

  const callId = normalizeString(record.call_id);
  const operation = normalizeApplyPatchOperation(record.operation);
  if (!callId || !operation) return null;

  const normalizedStatus = normalizeString(record.status).toLowerCase();
  const item = {
    type: 'apply_patch_call',
    call_id: callId,
    status: normalizedStatus === 'in_progress' ? 'in_progress' : 'completed',
    operation
  };
  if (record.caller && typeof record.caller === 'object' && !Array.isArray(record.caller)) {
    item.caller = { ...record.caller };
  }
  const itemId = normalizeString(record.item_id || record.id);
  if (itemId) {
    item.item_id = itemId;
  }
  return item;
}

/**
 * 把 timeline / 工具记录里的 function_call 重新转成可直接放回 `/responses.input`
 * 的 replay item。
 *
 * 背景：
 * - 某些兼容端点会稳定返回本地需要执行的 function_call 事件，
 *   但不一定把同样的 function_call item 原样带回到最终 output 数组里；
 * - 若后续 follow-up request 只附加了 `function_call_output`，却没附上对应的
 *   `function_call`，服务端会报：
 *   `No tool call found for function call output with call_id ...`
 *
 * 因此这里要基于“已经确定存在的 function_call 记录”补齐 replay item。
 *
 * @param {Array<any>|null|undefined} toolCallRecords
 * @returns {Array<Object>}
 */
export function buildResponsesReplayFunctionCallItems(toolCallRecords) {
  return (Array.isArray(toolCallRecords) ? toolCallRecords : [])
    .map(record => buildResponsesReplayFunctionCallItem(record))
    .filter((item) => item && typeof item === 'object');
}

/**
 * 把工具记录中的官方 apply_patch_call 重新构造成可重放 input item。
 * operation 与 status 都是该协议的必需字段，不能像普通 function_call 那样只保留
 * name/arguments。
 */
export function buildResponsesReplayApplyPatchCallItems(toolCallRecords) {
  return (Array.isArray(toolCallRecords) ? toolCallRecords : [])
    .map(record => buildResponsesReplayApplyPatchCallItem(record))
    .filter((item) => item && typeof item === 'object');
}

/**
 * 按原始工具调用顺序构造所有由 Cerebr 客户端负责闭环的 replay call item。
 * 未识别的服务端 hosted call 会被忽略，避免错误地把它们伪装成本地工具调用。
 */
export function buildResponsesReplayClientToolCallItems(toolCallRecords) {
  return (Array.isArray(toolCallRecords) ? toolCallRecords : [])
    .map((record) => {
      const type = normalizeString(record?.type).toLowerCase();
      if (type === 'function_call') return buildResponsesReplayFunctionCallItem(record);
      if (type === 'apply_patch_call') return buildResponsesReplayApplyPatchCallItem(record);
      return null;
    })
    .filter((item) => item && typeof item === 'object');
}

/**
 * 确保下一 hop 要重放的 output items 中包含所有本地要回传 output 的 function_call。
 *
 * 说明：
 * - 若上游已经带了对应 function_call，则 merge 会按 `type + call_id` 去重；
 * - 若上游没带，则这里补进去，保证 `function_call_output` 总能在同一请求里
 *   找到前置的 `function_call`。
 *
 * @param {Array<any>|null|undefined} responseOutputItems
 * @param {Array<any>|null|undefined} toolCallRecords
 * @returns {Array<Object>}
 */
export function ensureResponsesReplayOutputItemsIncludeClientToolCalls(responseOutputItems, toolCallRecords) {
  const clientToolCallItems = buildResponsesReplayClientToolCallItems(toolCallRecords);
  return mergeResponsesInputItems(responseOutputItems, clientToolCallItems);
}

/**
 * 旧导出名保留给现有 sender 与外部调用方。函数现在是协议级超集：除 function_call 外，
 * 也会补齐官方 apply_patch_call；这保证 message_sender 尚未改名时就能正确生成 follow-up。
 */
export function ensureResponsesReplayOutputItemsIncludeFunctionCalls(responseOutputItems, toolCallRecords) {
  return ensureResponsesReplayOutputItemsIncludeClientToolCalls(responseOutputItems, toolCallRecords);
}
