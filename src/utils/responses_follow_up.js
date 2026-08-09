import { mergeResponsesInputItems } from './responses_input_items.js';

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
export function buildResponsesReplayToolCallItems(toolCallRecords) {
  return (Array.isArray(toolCallRecords) ? toolCallRecords : [])
    .map((record) => {
      if (!record || typeof record !== 'object') return null;
      const type = String(record.type || '').trim().toLowerCase();
      if (type !== 'function_call' && type !== 'custom_tool_call') return null;

      const callId = (typeof record.call_id === 'string' && record.call_id.trim())
        ? record.call_id.trim()
        : '';
      if (!callId) return null;

      const item = {
        type,
        call_id: callId,
        name: (typeof record.name === 'string') ? record.name : '',
        ...(type === 'custom_tool_call'
          ? { input: (typeof record.input === 'string') ? record.input : '' }
          : { arguments: (typeof record.arguments === 'string') ? record.arguments : '' })
      };
      const namespace = (typeof record.namespace === 'string' && record.namespace.trim())
        ? record.namespace.trim()
        : '';
      if (namespace) {
        item.namespace = namespace;
      }
      const itemId = (typeof record.item_id === 'string' && record.item_id.trim())
        ? record.item_id.trim()
        : '';
      if (itemId) {
        item.item_id = itemId;
      }
      return item;
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
export function ensureResponsesReplayOutputItemsIncludeToolCalls(responseOutputItems, toolCallRecords) {
  const toolCallItems = buildResponsesReplayToolCallItems(toolCallRecords);
  return mergeResponsesInputItems(responseOutputItems, toolCallItems);
}
