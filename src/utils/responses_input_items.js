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
 * - 删除 `id` / `item_id` / `status` 这类服务端运行态字段；
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

  delete cloned.id;
  delete cloned.item_id;
  delete cloned.status;

  const type = String(cloned.type || '').trim().toLowerCase();
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
export function filterIncompleteResponsesToolCallReplayItems(items) {
  const normalizedItems = cloneResponsesInputItems(items);
  if (normalizedItems.length <= 0) {
    return [];
  }

  const callPairStateById = new Map();
  normalizedItems.forEach((item) => {
    const type = getNormalizedResponsesReplayItemType(item);
    const callId = getNormalizedResponsesReplayCallId(item);
    if (!callId) return;

    if (
      type !== 'function_call'
      && type !== 'function_call_output'
      && type !== 'custom_tool_call'
      && type !== 'custom_tool_call_output'
    ) {
      return;
    }

    const pairState = callPairStateById.get(callId) || {
      hasFunctionCall: false,
      hasFunctionCallOutput: false,
      hasCustomToolCall: false,
      hasCustomToolCallOutput: false
    };

    if (type === 'function_call') {
      pairState.hasFunctionCall = true;
    } else if (type === 'function_call_output') {
      pairState.hasFunctionCallOutput = true;
    } else if (type === 'custom_tool_call') {
      pairState.hasCustomToolCall = true;
    } else if (type === 'custom_tool_call_output') {
      pairState.hasCustomToolCallOutput = true;
    }

    callPairStateById.set(callId, pairState);
  });

  return normalizedItems.filter((item) => {
    const type = getNormalizedResponsesReplayItemType(item);
    const callId = getNormalizedResponsesReplayCallId(item);
    if (!callId) return true;

    const pairState = callPairStateById.get(callId);
    if (!pairState) return true;

    if (type === 'function_call' || type === 'function_call_output') {
      return pairState.hasFunctionCall && pairState.hasFunctionCallOutput;
    }

    if (type === 'custom_tool_call' || type === 'custom_tool_call_output') {
      return pairState.hasCustomToolCall && pairState.hasCustomToolCallOutput;
    }

    return true;
  });
}
