/**
 * 根据 Responses API SSE 事件，推导适合展示给用户的“当前状态文案”。
 *
 * 设计原则：
 * - 文案要反映“服务器已经开始处理”这一事实，而不是继续停留在本地请求构造阶段；
 * - 只描述已经发生的阶段，不假装知道更多内部细节；
 * - 这里是纯函数，便于单元测试与后续继续迭代映射。
 */

function normalizePhase(value) {
  return (typeof value === 'string') ? value.trim().toLowerCase() : '';
}

function buildStatus(text, stage, note = '') {
  return {
    text,
    meta: {
      stage,
      note
    }
  };
}

/**
 * @param {string} eventType
 * @param {any} data
 * @returns {{text:string, meta:{stage:string, note?:string}}|null}
 */
export function deriveResponsesSseLoadingStatus(eventType, data = {}) {
  const type = (typeof eventType === 'string') ? eventType.trim().toLowerCase() : '';
  if (!type) return null;

  if (type === 'response.created' || type === 'response.in_progress') {
    return buildStatus(
      '服务器已收到请求，模型正在思考...',
      'responses_in_progress',
      '此时模型可能正在推理、生成摘要或准备工具调用。'
    );
  }

  if (
    type === 'response.reasoning_text.delta'
    || type === 'response.reasoning_summary_text.delta'
    || type === 'response.reasoning_text.done'
    || type === 'response.reasoning_summary_text.done'
  ) {
    return buildStatus(
      '模型正在思考...',
      'responses_reasoning',
      '服务器已开始返回推理相关事件，首个可见正文可能尚未出现。'
    );
  }

  if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
    return buildStatus(
      '模型正在生成工具调用参数...',
      'responses_function_arguments',
      '当前轮很可能即将进入工具调用。'
    );
  }

  if (type === 'response.output_text.delta' || type === 'response.output_text.done') {
    return buildStatus(
      '模型正在生成回复...',
      'responses_output_text'
    );
  }

  if (type === 'response.completed') {
    return buildStatus(
      '当前轮已完成，正在整理结果...',
      'responses_completed'
    );
  }

  if (type === 'response.output_item.added' || type === 'response.output_item.done') {
    const item = (data?.item && typeof data.item === 'object') ? data.item : null;
    const itemType = (typeof item?.type === 'string') ? item.type.trim().toLowerCase() : '';
    const phase = normalizePhase(item?.phase);

    if (itemType === 'reasoning' || (itemType === 'message' && phase === 'commentary')) {
      return buildStatus(
        '模型正在思考...',
        'responses_reasoning_item',
        '服务器已返回推理/摘要类 output item。'
      );
    }

    if (itemType === 'function_call' || itemType === 'web_search_call') {
      return buildStatus(
        '模型正在准备工具调用...',
        'responses_tool_call'
      );
    }

    if (itemType === 'message') {
      return buildStatus(
        '模型正在组织回复...',
        'responses_message_item'
      );
    }

    return buildStatus(
      '服务器正在继续处理当前轮...',
      'responses_output_item'
    );
  }

  return null;
}
