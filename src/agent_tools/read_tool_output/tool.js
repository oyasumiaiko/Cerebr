/**
 * 统一工具输出续读工具。
 *
 * 支持分页的原工具结果超过 max_output_chars 时，最终输出出口会缓存已经完成序列化的完整文本，
 * 并在当前页返回不透明 cursor。模型用本工具读取下一页时只访问缓存，不会重新执行
 * 原工具，因此不会重复网络请求、脚本执行或文件扫描。js_runtime_execute 使用独立的
 * 固定 5000 字符与运行时内筛选契约，不进入本续读缓存。
 */

import {
  buildModelToolDescription,
  buildStrictFunctionToolDefinition
} from '../shared/model_tool_contract.js';

export const READ_TOOL_OUTPUT_TOOL_NAME = 'read_tool_output';

export function buildReadToolOutputFunctionToolDefinition() {
  return buildStrictFunctionToolDefinition({
    name: READ_TOOL_OUTPUT_TOOL_NAME,
    description: buildModelToolDescription({
      purpose: '使用上一个支持分页的超长工具结果返回的 cursor 继续读取下一页，不重新执行原工具。',
      useWhen: '工具结果中的 <tool_output_page> 含 next_cursor，且还需要查看后续内容。',
      avoidWhen: '不要用于 js_runtime_execute；不要猜测 cursor；需要读取新的源范围或刷新实时数据时重新调用原工具。',
      input: 'cursor 必须原样复制 next_cursor；max_output_chars 传正整数可调整本页大小，传 null 沿用上一页大小。',
      output: '返回下一段 <tool_output_page>；仍有后续时再次提供 next_cursor，最后一页 has_more=false。',
      notes: 'cursor 只引用已经生成的本地工具输出缓存，不会触发原工具副作用。'
    }),
    properties: {
      cursor: {
        type: 'string',
        description: '从上一页 next_cursor 原样复制的不透明续读游标。'
      }
    }
  });
}

export function normalizeReadToolOutputArguments(rawArgs) {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? rawArgs
    : {};
  const cursor = typeof args.cursor === 'string' ? args.cursor.trim() : '';
  if (!cursor) {
    throw new Error('read_tool_output 参数错误：cursor 不能为空。');
  }
  return { cursor };
}
