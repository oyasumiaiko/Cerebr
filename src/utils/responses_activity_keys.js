/**
 * Responses 活动时间线稳定 key 工具。
 *
 * 设计说明：
 * - sender 侧会用稳定 key 合并 timeline，避免流式事件把同一条 tool/reasoning 追加成重复项；
 * - renderer 侧也必须复用完全相同的 key 规则，才能做到“按条目原地更新而不是整块重建”；
 * - 因此把这套 key 规则抽到共享 util，避免 sender / renderer 各自维护一份近似实现后逐渐漂移。
 */

/**
 * 为工具调用记录生成稳定 key。
 *
 * @param {Object|null|undefined} record
 * @param {number} [fallbackIndex=0]
 * @returns {string}
 */
export function getResponsesToolCallRecordKey(record, fallbackIndex = 0) {
  if (!record || typeof record !== 'object') {
    return `unknown:${fallbackIndex}`;
  }
  const type = (typeof record.type === 'string' && record.type) ? record.type : 'unknown';
  const id = (typeof record.id === 'string' && record.id) ? record.id : '';
  if (id) return `${type}:${id}`;
  if (type === 'function_call') {
    const namespace = (typeof record.namespace === 'string' && record.namespace) ? record.namespace : '';
    return `${type}:${namespace}:${record.name || ''}:${fallbackIndex}`;
  }
  if (type === 'web_search_call') {
    return `${type}:${record.action_type || ''}:${record.query || ''}:${record.url || ''}:${record.pattern || ''}:${fallbackIndex}`;
  }
  return `${type}:${fallbackIndex}`;
}

/**
 * 为 Responses 活动时间线条目生成稳定 key。
 *
 * @param {Object|null|undefined} entry
 * @param {number} [fallbackIndex=0]
 * @returns {string}
 */
export function getResponsesActivityTimelineEntryKey(entry, fallbackIndex = 0) {
  if (!entry || typeof entry !== 'object') {
    return `unknown:${fallbackIndex}`;
  }
  const kind = (typeof entry.kind === 'string' && entry.kind) ? entry.kind : 'unknown';
  if (kind === 'commentary') {
    const id = (typeof entry.id === 'string' && entry.id) ? entry.id : `commentary_${fallbackIndex}`;
    return `commentary:${id}`;
  }
  if (kind === 'steer') {
    const id = (typeof entry.id === 'string' && entry.id) ? entry.id : `steer_${fallbackIndex}`;
    return `steer:${id}`;
  }
  if (kind === 'reasoning_summary') {
    const id = (typeof entry.id === 'string' && entry.id) ? entry.id : `reasoning_${fallbackIndex}`;
    return `reasoning:${id}`;
  }
  if (kind === 'stream_error') {
    const id = (typeof entry.id === 'string' && entry.id) ? entry.id : `stream_error_${fallbackIndex}`;
    return `stream_error:${id}`;
  }
  if (kind === 'tool_call') {
    return `tool:${getResponsesToolCallRecordKey(entry, fallbackIndex)}`;
  }
  return `${kind}:${fallbackIndex}`;
}
