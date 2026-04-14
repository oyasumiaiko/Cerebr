/**
 * js_runtime_execute 工具契约。
 *
 * 这里只放“模型可见的工具面”和纯参数校验：
 * - sender 只负责把执行入口接上；
 * - 这样工具定义、参数错误文案、后续拆分子模块都会回到工具目录内维护。
 */

export const JS_RUNTIME_EXECUTE_TOOL_NAME = 'js_runtime_execute';

/**
 * 构造给 Responses API 使用的 js_runtime_execute 自定义函数工具定义。
 *
 * @param {any} [_pageToolEnvironment]
 * @returns {Object}
 */
export function buildJsRuntimeExecuteFunctionToolDefinition(_pageToolEnvironment = null) {
  const descriptionLines = [
    '在浏览器脚本环境中执行一次性 JavaScript。',
    'code 字段会作为 async 函数体运行，可直接使用 await 和 return。',
    '若需要跨多次调用复用状态，请显式把对象或值挂到 globalThis；同一页面环境未刷新时，后续 IIFE 可继续读取这些 globalThis 字段。',
    '除非能确定当前页面是单页应用且不会销毁当前运行环境，否则禁止刷新页面或导航到其他网址；这会直接中断当前宿主页里的会话执行。',
    '可访问当前执行环境的 DOM / Web API，不要假设能直接访问页面主世界里的自定义 JS 对象。',
    'console.log/info/warn/error/debug 的输出会被捕获并一并回传，可用于调试或分步观察。',
    '若需要回传大量长字符串或多行文本，优先使用 console.log 输出；为避免长字符串作为 return 值时变成 JSON 字符串表现，return 更适合简洁结果值。',
    '工具返回结果采用 XML 分块文本：通常包含 <metadata>、<return_value>、<console_logs>、<error>；多 frame 时还可能包含 <frame_results>。',
    '其中 metadata 是小型 JSON，其余正文块是纯文本；过长块会自动截断。请尽量返回紧凑、可序列化的小结果。'
  ];
  const frameDescription = '可选的 frame ID 数组。省略、传空数组或 null 时，默认在顶层 frame 执行；若当前请求附带 page_runtime_context，可从中读取可用 frame_id。';
  return {
    type: 'function',
    name: JS_RUNTIME_EXECUTE_TOOL_NAME,
    description: descriptionLines.join(' '),
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: {
          type: 'string',
          description: '要执行的 JavaScript 代码片段。它会作为 async 函数体执行，可直接使用 await、return 和 console.log/info/warn/error/debug。若需要回传大量长字符串或多行文本，优先使用 console.log 输出；return 更适合简洁结果值。'
        },
        timeout_ms: {
          type: ['integer', 'null'],
          description: 'The timeout for the execution in milliseconds.'
        },
        frame_ids: {
          type: ['array', 'null'],
          description: frameDescription,
          items: {
            type: 'integer'
          }
        }
      },
      required: ['code', 'timeout_ms', 'frame_ids']
    }
  };
}

/**
 * 规范化 js_runtime_execute 的参数。
 *
 * @param {any} rawArgs
 * @returns {{code:string, timeoutMs:number|null, frameIds:number[]|null}}
 */
export function normalizeJsRuntimeExecuteToolArguments(rawArgs) {
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs))
    ? rawArgs
    : {};
  const code = (typeof args.code === 'string') ? args.code : '';
  if (!code.trim()) {
    throw new Error('js_runtime_execute 参数错误：code 不能为空。');
  }
  const timeoutMs = (() => {
    if (args.timeout_ms === null || typeof args.timeout_ms === 'undefined') return null;
    const parsed = Number(args.timeout_ms);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      throw new Error('js_runtime_execute 参数错误：timeout_ms 必须是整数。');
    }
    if (parsed <= 0) {
      throw new Error('js_runtime_execute 参数错误：timeout_ms 必须大于 0。');
    }
    return Math.trunc(parsed);
  })();

  const frameIds = Array.isArray(args.frame_ids)
    ? args.frame_ids
      .map(value => Number(value))
      .filter(value => Number.isFinite(value))
      .map(value => Math.trunc(value))
    : null;

  return {
    code,
    timeoutMs,
    frameIds: (Array.isArray(frameIds) && frameIds.length > 0) ? frameIds : null
  };
}
