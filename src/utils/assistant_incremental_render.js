import {
  getResponsesActivityTimelineEntryKey,
  getResponsesToolCallRecordKey
} from './responses_activity_keys.js';

/**
 * 计算两个有序序列的“公共前缀 + 公共后缀”窗口。
 *
 * 用途：
 * - Markdown 顶层 block diff：仅替换真正变化的连续区间；
 * - 其它顺序型 surface 也可以复用这套纯函数窗口规划，避免在 DOM 层做含糊的“整块清空再重建”。
 *
 * @param {Array<string>} previousSignatures
 * @param {Array<string>} nextSignatures
 * @returns {{
 *   hasChanges: boolean,
 *   prefixCount: number,
 *   suffixCount: number,
 *   previousRangeStart: number,
 *   previousRangeEnd: number,
 *   nextRangeStart: number,
 *   nextRangeEnd: number
 * }}
 */
export function computeContiguousDiffWindow(previousSignatures, nextSignatures) {
  const previous = Array.isArray(previousSignatures) ? previousSignatures : [];
  const next = Array.isArray(nextSignatures) ? nextSignatures : [];

  let prefixCount = 0;
  const maxPrefix = Math.min(previous.length, next.length);
  while (prefixCount < maxPrefix && previous[prefixCount] === next[prefixCount]) {
    prefixCount += 1;
  }

  let suffixCount = 0;
  const previousRemaining = previous.length - prefixCount;
  const nextRemaining = next.length - prefixCount;
  const maxSuffix = Math.min(previousRemaining, nextRemaining);
  while (
    suffixCount < maxSuffix
    && previous[previous.length - 1 - suffixCount] === next[next.length - 1 - suffixCount]
  ) {
    suffixCount += 1;
  }

  const previousRangeStart = prefixCount;
  const previousRangeEnd = previous.length - suffixCount;
  const nextRangeStart = prefixCount;
  const nextRangeEnd = next.length - suffixCount;

  return {
    hasChanges: previousRangeStart !== previousRangeEnd || nextRangeStart !== nextRangeEnd,
    prefixCount,
    suffixCount,
    previousRangeStart,
    previousRangeEnd,
    nextRangeStart,
    nextRangeEnd
  };
}

/**
 * 构建 response_activity 条目快照的稳定 key。
 *
 * 这里单独 re-export 一层，方便 message_processor 的视图快照层直接消费，
 * 也方便测试只加载一个 util 文件就能覆盖“增量渲染相关”的关键契约。
 *
 * @param {Object|null|undefined} entry
 * @param {number} [fallbackIndex=0]
 * @returns {string}
 */
export function getResponseActivityEntrySnapshotKey(entry, fallbackIndex = 0) {
  return getResponsesActivityTimelineEntryKey(entry, fallbackIndex);
}

/**
 * 构建 legacy tool_calls 列表项稳定 key。
 *
 * @param {Object|null|undefined} record
 * @param {number} [fallbackIndex=0]
 * @returns {string}
 */
export function getLegacyToolCallSnapshotKey(record, fallbackIndex = 0) {
  return getResponsesToolCallRecordKey(record, fallbackIndex);
}
