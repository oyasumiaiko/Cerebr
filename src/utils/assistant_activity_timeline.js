/**
 * assistant 活动时间线归一化工具。
 *
 * 目标：
 * - 把传统 `thoughtsRaw` 思考块与 Responses 的 reasoning/tool timeline 收敛到一套数据结构；
 * - 让 UI 只关心“narrative + tool entries”的统一 timeline，而不再分支处理多种历史字段；
 * - 继续保留现有语义：若存在 commentary，则隐藏同轮 reasoning_summary，避免两份近似文案叠加。
 */

function normalizeText(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

/**
 * 从旧字段构造统一 timeline。
 *
 * @param {Object|null} node
 * @returns {Array<Object>}
 */
export function buildLegacyAssistantActivityTimeline(node) {
  if (!node || typeof node !== 'object') return [];
  const timeline = [];

  const thoughtsRaw = normalizeText(node.thoughtsRaw);
  if (thoughtsRaw) {
    timeline.push({
      kind: 'commentary',
      id: 'legacy_thoughts',
      status: 'completed',
      text: thoughtsRaw
    });
  }

  const reasoningSummary = normalizeText(node.response_reasoning_summary);
  if (reasoningSummary) {
    timeline.push({
      kind: 'reasoning_summary',
      id: 'legacy_reasoning_summary',
      status: 'completed',
      text: reasoningSummary
    });
  }

  if (Array.isArray(node.response_tool_calls)) {
    node.response_tool_calls.forEach((record, index) => {
      if (!record || typeof record !== 'object') return;
      timeline.push({
        kind: 'tool_call',
        id: record.id || `legacy_tool_${index}`,
        ...record
      });
    });
  }

  return timeline;
}

/**
 * 获取 assistant 统一活动时间线。
 *
 * 优先级：
 * 1. 若已有 `response_activity_timeline`，直接使用；
 * 2. 否则回退到 `thoughtsRaw` / `response_reasoning_summary` / `response_tool_calls` 的 legacy 映射。
 *
 * @param {Object|null} node
 * @returns {Array<Object>}
 */
export function getAssistantActivityTimeline(node) {
  if (!node || typeof node !== 'object') return [];
  const source = Array.isArray(node.response_activity_timeline) && node.response_activity_timeline.length > 0
    ? node.response_activity_timeline
    : buildLegacyAssistantActivityTimeline(node);
  const timeline = Array.isArray(source)
    ? source.filter(entry => entry && typeof entry === 'object' && typeof entry.kind === 'string')
    : [];
  const hasCommentary = timeline.some(entry => String(entry?.kind || '').toLowerCase() === 'commentary');
  return hasCommentary
    ? timeline.filter(entry => String(entry?.kind || '').toLowerCase() !== 'reasoning_summary')
    : timeline;
}

/**
 * 判定 UI 是否应该使用 response_activity 面板渲染 assistant 附加信息。
 *
 * 普通 Google/Gemini 的 `thoughtsRaw` 也应进入统一活动面板：
 * - UI 层不再把 Responses reasoning 与普通 API thoughts 分成两套面板；
 * - 流式阶段的稳定性由调用方保持同一个 assistant 节点持续同步，不能用空 preview 节点
 *   把已经出现的 `thoughtsRaw` 清掉。
 *
 * @param {Object|null} node
 * @returns {boolean}
 */
export function shouldRenderAssistantActivityTimeline(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node.response_activity_timeline) && node.response_activity_timeline.length > 0) {
    return true;
  }
  if (normalizeText(node.thoughtsRaw)) {
    return true;
  }
  if (normalizeText(node.response_reasoning_summary)) {
    return true;
  }
  if (Array.isArray(node.response_tool_calls) && node.response_tool_calls.length > 0) {
    return true;
  }
  return false;
}
