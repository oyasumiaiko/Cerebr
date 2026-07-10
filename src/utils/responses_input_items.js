/**
 * Responses 可重放 input item 工具（纯函数）。
 *
 * 设计目标：
 * - 把“可再次放回 `/responses.input` 的 item”抽成共享逻辑，避免发送链路与请求构造链路各写一份；
 * - 允许我们像 Codex 那样，把模型输出 item 与本地 `function_call_output` 一起记进历史，再在后续 turn 重放；
 * - 统一做轻量清洗，去掉服务端运行态字段，避免把仅对单次响应有效的噪音字段重新发回去。
 */

/**
 * 尽量安全地克隆 JSON 风格数据。
 *
 * 说明：
 * - Responses output / input item 本身就是 JSON 风格对象；
 * - 优先使用 `structuredClone`，在旧环境下再退回 JSON 序列化；
 * - 若克隆失败，返回 null，由调用方决定是否丢弃。
 *
 * @param {any} value
 * @returns {any}
 */
function cloneDataSafely(value) {
  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(value);
    }
  } catch (_) {}

  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return null;
  }
}

/**
 * 这些 Responses item 的 `status` 不是一次响应内的展示噪音，而是无状态重放协议的
 * 必需字段。普通 message / function_call 等 item 仍沿用旧策略移除 status，避免扩大
 * 历史体积；官方 apply_patch call/output 则必须原样保留，才能再次放回 `/responses.input`。
 */
const RESPONSES_REPLAY_ITEM_TYPES_WITH_REQUIRED_STATUS = new Set([
  'apply_patch_call',
  'apply_patch_call_output'
]);

/**
 * 本地负责闭环的 Responses 工具协议。
 *
 * family 用于避免极端情况下不同协议复用同一个 call_id 时互相误配；side 则统一描述
 * call/output 两端，让未闭环过滤不再随着每种工具新增一组布尔字段。
 */
const RESPONSES_REPLAY_TOOL_PAIR_DESCRIPTOR_BY_TYPE = Object.freeze({
  function_call: Object.freeze({ family: 'function', side: 'call' }),
  function_call_output: Object.freeze({ family: 'function', side: 'output' }),
  custom_tool_call: Object.freeze({ family: 'custom_tool', side: 'call' }),
  custom_tool_call_output: Object.freeze({ family: 'custom_tool', side: 'output' }),
  apply_patch_call: Object.freeze({ family: 'apply_patch', side: 'call' }),
  apply_patch_call_output: Object.freeze({ family: 'apply_patch', side: 'output' })
});

/**
 * 为可重放 item 生成稳定去重键。
 *
 * 优先级：
 * - `type + call_id`：function_call / function_call_output / custom_tool_call 等；
 * - `type + id/item_id`：message / reasoning 等带稳定 id 的 item；
 * - 最后退回到索引。
 *
 * @param {any} item
 * @param {number} [fallbackIndex=0]
 * @returns {string}
 */
export function getResponsesReplayItemKey(item, fallbackIndex = 0) {
  if (!item || typeof item !== 'object') {
    return `unknown:${fallbackIndex}`;
  }

  const type = (typeof item.type === 'string' && item.type.trim())
    ? item.type.trim().toLowerCase()
    : 'unknown';
  const callId = (typeof item.call_id === 'string' && item.call_id.trim())
    ? item.call_id.trim()
    : '';
  if (callId) {
    return `${type}:call:${callId}`;
  }

  const itemId = (typeof item.id === 'string' && item.id.trim())
    ? item.id.trim()
    : ((typeof item.item_id === 'string' && item.item_id.trim()) ? item.item_id.trim() : '');
  if (itemId) {
    return `${type}:id:${itemId}`;
  }

  try {
    const serialized = JSON.stringify(item);
    if (serialized) {
      return `${type}:json:${serialized}`;
    }
  } catch (_) {}

  return `${type}:idx:${fallbackIndex}`;
}

/**
 * 清洗一个可重放 item。
 *
 * 当前策略：
 * - 删除 `id` / `item_id` 这类服务端运行态字段；
 * - 普通 item 删除 `status`，但官方 apply_patch call/output 必须保留协议要求的 status；
 * - 保留 `call_id` / `name` / `arguments` / `output` 等真正有上下文意义的字段；
 * - 丢弃“完全空”的 reasoning item，避免把无意义占位继续带进后续 prompt。
 *
 * @param {any} item
 * @returns {Object|null}
 */
export function sanitizeResponsesReplayItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return null;
  }

  const cloned = cloneDataSafely(item);
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
    return null;
  }

  const type = String(cloned.type || '').trim().toLowerCase();
  delete cloned.id;
  delete cloned.item_id;
  if (!RESPONSES_REPLAY_ITEM_TYPES_WITH_REQUIRED_STATUS.has(type)) {
    delete cloned.status;
  }
  if (type === 'apply_patch_call' || type === 'apply_patch_call_output') {
    // created_by 只存在于服务端输出 item，不属于 ResponseInputItem 的官方输入形状。
    delete cloned.created_by;
  }

  if (type === 'image_generation_call') {
    // 生图结果本身可能是很大的 base64 PNG，也可能已被本地化成 file:// 引用；
    // 历史重放不保存图片字节，但保留本地化引用，供请求构造阶段在同一个
    // `image_generation_call` item 上按 Codex 的 Responses item 语义水合回 `result`。
    delete cloned.result;
  }
  if (type === 'reasoning') {
    const hasSummary = Array.isArray(cloned.summary)
      && cloned.summary.some(part => typeof part?.text === 'string' && part.text.trim());
    const hasEncryptedContent = typeof cloned.encrypted_content === 'string'
      && cloned.encrypted_content.trim();
    if (!hasSummary && !hasEncryptedContent) {
      return null;
    }
  }

  return cloned;
}

/**
 * 合并多批可重放 item，去重后保留稳定顺序。
 *
 * 规则：
 * - 先保留已有顺序；
 * - 后到 item 若键相同，则覆盖原位置；
 * - 新键直接追加到末尾。
 *
 * 这样可以同时满足：
 * - SSE 中 `output_item.done` 与 `response.completed` 的重复回传去重；
 * - 同一 turn 内多次 tool follow-up 逐步累积历史；
 * - 后续 turn 直接使用本字段重放。
 *
 * @param {any} existingItems
 * @param {any} incomingItems
 * @returns {Array<Object>}
 */
export function mergeResponsesInputItems(existingItems, incomingItems) {
  const merged = Array.isArray(existingItems)
    ? existingItems
      .map(item => sanitizeResponsesReplayItem(item))
      .filter(item => item && typeof item === 'object' && !Array.isArray(item))
    : [];

  const keyToIndex = new Map();
  merged.forEach((item, index) => {
    keyToIndex.set(getResponsesReplayItemKey(item, index), index);
  });

  (Array.isArray(incomingItems) ? incomingItems : []).forEach((item, index) => {
    const sanitized = sanitizeResponsesReplayItem(item);
    if (!sanitized) return;

    const key = getResponsesReplayItemKey(sanitized, merged.length + index);
    const existingIndex = keyToIndex.get(key);
    if (typeof existingIndex === 'number' && existingIndex >= 0) {
      merged[existingIndex] = sanitized;
      return;
    }

    keyToIndex.set(key, merged.length);
    merged.push(sanitized);
  });

  return merged;
}

/**
 * 复制一批已规整的可重放 item。
 *
 * @param {any} items
 * @returns {Array<Object>}
 */
export function cloneResponsesInputItems(items) {
  return mergeResponsesInputItems([], items);
}

function getNormalizedResponsesReplayCallId(item) {
  return (typeof item?.call_id === 'string' && item.call_id.trim())
    ? item.call_id.trim()
    : '';
}

function getNormalizedResponsesReplayItemType(item) {
  return (typeof item?.type === 'string' && item.type.trim())
    ? item.type.trim().toLowerCase()
    : '';
}

function isValidApplyPatchReplayItem(item, type) {
  const status = (typeof item?.status === 'string') ? item.status.trim().toLowerCase() : '';
  if (type === 'apply_patch_call_output') {
    const hasValidStatus = status === 'completed' || status === 'failed';
    const hasValidOutput = !Object.prototype.hasOwnProperty.call(item || {}, 'output')
      || item.output == null
      || typeof item.output === 'string';
    return hasValidStatus && hasValidOutput;
  }
  if (type !== 'apply_patch_call') return true;
  if (status !== 'in_progress' && status !== 'completed') return false;

  const operation = item?.operation;
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return false;
  const operationType = (typeof operation.type === 'string') ? operation.type.trim().toLowerCase() : '';
  const operationPath = (typeof operation.path === 'string') ? operation.path.trim() : '';
  if (!operationPath || !['create_file', 'update_file', 'delete_file'].includes(operationType)) {
    return false;
  }
  if ((operationType === 'create_file' || operationType === 'update_file') && typeof operation.diff !== 'string') {
    return false;
  }
  if (
    Object.prototype.hasOwnProperty.call(item, 'caller')
    && item.caller != null
    && (
      typeof item.caller !== 'object'
      || Array.isArray(item.caller)
      || String(item.caller.type || '').trim().toLowerCase() !== 'direct'
    )
  ) {
    return false;
  }
  return true;
}

function isValidResponsesReplayClientToolItem(item, type, descriptor) {
  if (!descriptor) return true;
  if (!getNormalizedResponsesReplayCallId(item)) return false;
  return descriptor.family !== 'apply_patch' || isValidApplyPatchReplayItem(item, type);
}

/**
 * 过滤“跨 turn 历史重放”里未闭环的本地工具调用 item。
 *
 * 背景：
 * - Responses 本地工具链路会先收到 `function_call`，再由客户端执行并回传
 *   `function_call_output`；
 * - 如果会话在这两步之间被中止，历史节点里可能残留“只有 call、没有 output”的
 *   半成品 replay items；
 * - 下一轮把这类半成品重新塞回 `/responses.input` 时，服务端会把它视为一个尚未完成的
 *   工具调用，从而报 `No tool output found for function call ...`。
 *
 * 设计约束：
 * - 这个过滤器只用于“把历史消息重新转成下一轮 `/responses.input`”的场景；
 * - 不用于当前 turn 的运行时累积，否则会把本轮尚未执行完的 tool call 过早裁掉。
 *
 * @param {any} items
 * @returns {Array<Object>}
 */
export function filterIncompleteResponsesClientToolReplayItems(items) {
  const normalizedItems = cloneResponsesInputItems(items);
  if (normalizedItems.length <= 0) {
    return [];
  }

  const callPairStateByKey = new Map();
  normalizedItems.forEach((item) => {
    const type = getNormalizedResponsesReplayItemType(item);
    const descriptor = RESPONSES_REPLAY_TOOL_PAIR_DESCRIPTOR_BY_TYPE[type];
    if (!descriptor || !isValidResponsesReplayClientToolItem(item, type, descriptor)) return;
    const callId = getNormalizedResponsesReplayCallId(item);

    const pairKey = `${descriptor.family}:${callId}`;
    const pairState = callPairStateByKey.get(pairKey) || {
      hasCall: false,
      hasOutput: false
    };
    if (descriptor.side === 'call') {
      pairState.hasCall = true;
    } else {
      pairState.hasOutput = true;
    }
    callPairStateByKey.set(pairKey, pairState);
  });

  return normalizedItems.filter((item) => {
    const type = getNormalizedResponsesReplayItemType(item);
    const descriptor = RESPONSES_REPLAY_TOOL_PAIR_DESCRIPTOR_BY_TYPE[type];
    if (!descriptor) return true;
    if (!isValidResponsesReplayClientToolItem(item, type, descriptor)) return false;
    const callId = getNormalizedResponsesReplayCallId(item);
    const pairState = callPairStateByKey.get(`${descriptor.family}:${callId}`);
    return !!(pairState?.hasCall && pairState?.hasOutput);
  });
}

/**
 * 旧导出名继续保留，避免 API 请求构建链与第三方调用方在协议扩展后被迫同步改名。
 * 实际过滤范围已经覆盖 function/custom/apply_patch 三类客户端工具闭环。
 */
export function filterIncompleteResponsesToolCallReplayItems(items) {
  return filterIncompleteResponsesClientToolReplayItems(items);
}
