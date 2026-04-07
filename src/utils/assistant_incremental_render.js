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
 * 为已挂载 surface 选择“本次 diff 应该信任哪一版前态签名”。
 *
 * 设计原因：
 * - surface 在多轮增量 patch 后，真正的当前 DOM 才是最可信的前态；
 * - 若继续盲信上一次缓存下来的 snapshot，前一次 patch 一旦有轻微漂移，
 *   下一轮就会在错误的 block 索引上继续插删，最终表现为段落重复、空标题、列表残片。
 *
 * 规则：
 * - 只要当前 DOM 已经有 block，就优先用 DOM 实况；
 * - 只有在容器还没挂载任何 block 时，才回退到上一版 snapshot。
 *
 * @param {Array<string>|null|undefined} previousSignatures
 * @param {Array<string>|null|undefined} currentDomSignatures
 * @returns {Array<string>}
 */
export function resolveRenderedSurfaceDiffBaseSignatures(previousSignatures, currentDomSignatures) {
  if (Array.isArray(currentDomSignatures) && currentDomSignatures.length > 0) {
    return currentDomSignatures.slice();
  }
  if (Array.isArray(previousSignatures)) {
    return previousSignatures.slice();
  }
  return [];
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
