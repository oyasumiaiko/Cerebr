import {
  JS_RUNTIME_ENV_BOUND_HOST_PAGE,
  JS_RUNTIME_ENV_ISOLATED_SANDBOX
} from './page_tool_environment.js';

/**
 * 规范化 frame 快照，确保签名稳定且字段顺序固定。
 *
 * @param {Array<any>|null|undefined} frames
 * @returns {Array<{frame_id:number, is_top:boolean, url:string, title:string}>}
 */
export function normalizePageRuntimeContextFrames(frames) {
  const source = Array.isArray(frames) ? frames : [];
  return source
    .map((item) => ({
      frame_id: Number.isFinite(Number(item?.frameId)) ? Number(item.frameId) : null,
      is_top: item?.isTop === true || Number(item?.frameId) === 0,
      url: (typeof item?.url === 'string') ? item.url.trim() : '',
      title: (typeof item?.title === 'string') ? item.title.trim() : ''
    }))
    .filter((item) => Number.isFinite(item.frame_id))
    .sort((left, right) => {
      if (left.is_top !== right.is_top) return left.is_top ? -1 : 1;
      return left.frame_id - right.frame_id;
    });
}

/**
 * 构造本轮请求应暴露给模型的“页面/运行环境隐藏上下文”负载。
 *
 * 设计原则：
 * - 这是独立的隐藏 contextual item，不污染用户正文；
 * - 同时承载“当前是否宿主页增强模式”与“宿主页 frame 列表”等信息；
 * - 在纯对话/隔离模式下也保留一条简短上下文，防止历史里旧的宿主页上下文误导模型。
 *
 * @param {{
 *   pageToolEnvironment?: {
 *     exposeHostPageTools?: boolean,
 *     exposePageContentTool?: boolean,
 *     jsRuntimeEnvironment?: string
 *   }|null,
 *   pageMeta?: {url?:string, title?:string}|null,
 *   frames?: Array<any>|null
 * }} options
 * @returns {Object|null}
 */
export function buildPageRuntimeContextPayload(options = {}) {
  const pageToolEnvironment = (options?.pageToolEnvironment && typeof options.pageToolEnvironment === 'object')
    ? options.pageToolEnvironment
    : null;
  const normalizedFrames = normalizePageRuntimeContextFrames(options?.frames);
  const rawPageMeta = (options?.pageMeta && typeof options.pageMeta === 'object')
    ? options.pageMeta
    : null;

  const topFrame = normalizedFrames.find((item) => item.is_top) || null;
  const url = topFrame?.url
    || ((typeof rawPageMeta?.url === 'string') ? rawPageMeta.url.trim() : '');
  const title = topFrame?.title
    || ((typeof rawPageMeta?.title === 'string') ? rawPageMeta.title.trim() : '');
  const jsRuntimeEnvironment = (typeof pageToolEnvironment?.jsRuntimeEnvironment === 'string')
    ? pageToolEnvironment.jsRuntimeEnvironment
    : JS_RUNTIME_ENV_ISOLATED_SANDBOX;
  const exposePageContentTool = pageToolEnvironment?.exposePageContentTool === true;
  const mode = jsRuntimeEnvironment === JS_RUNTIME_ENV_BOUND_HOST_PAGE
    ? 'host_page'
    : 'isolated_sandbox';

  if (!url && !title && normalizedFrames.length === 0 && mode !== 'isolated_sandbox') {
    return null;
  }

  return {
    type: 'page_runtime_context',
    mode,
    page_content_tool: exposePageContentTool ? 'available' : 'unavailable',
    js_runtime_environment: jsRuntimeEnvironment,
    url,
    title,
    frames: normalizedFrames
  };
}

/**
 * 为页面运行上下文生成稳定签名，供“仅在变化时追加”使用。
 *
 * @param {Object|null|undefined} payload
 * @returns {string}
 */
export function buildPageRuntimeContextSignature(payload) {
  if (!payload || typeof payload !== 'object') return '';
  try {
    return JSON.stringify(payload);
  } catch (_) {
    return '';
  }
}

function buildHostPageRuntimeContextText(payload) {
  const lines = [
    '[Page Runtime Context]',
    '以下是当前请求对应的宿主页工具运行环境隐藏上下文，不是用户输入正文。',
    `page_content_read: ${payload.page_content_tool === 'available' ? 'available' : 'unavailable'}`,
    'js_runtime_execute: 当前侧栏绑定网页标签页'
  ];
  if (payload.url) lines.push(`Page URL: ${payload.url}`);
  if (payload.title) lines.push(`Page Title: ${payload.title}`);
  if (Array.isArray(payload.frames) && payload.frames.length > 0) {
    lines.push('Frames:');
    payload.frames.forEach((item) => {
      lines.push(
        `- frame_id=${item.frame_id}; is_top=${item.is_top ? 'true' : 'false'}; url=${item.url || ''}; title=${item.title || ''}`
      );
    });
  }
  return lines.join('\n');
}

function buildIsolatedSandboxRuntimeContextText(payload) {
  return [
    '[Page Runtime Context]',
    '以下是当前请求对应的运行环境隐藏上下文，不是用户输入正文。',
    `page_content_read: ${payload.page_content_tool === 'available' ? 'available' : 'unavailable'}`,
    'js_runtime_execute: 侧栏内部隔离 sandbox iframe',
    '当前请求不访问宿主标签页，因此没有宿主页 URL / Title / Frame 列表。'
  ].join('\n');
}

/**
 * 将页面运行上下文负载转成可直接插入 Responses `input` 的隐藏 contextual items。
 *
 * @param {Object|null|undefined} payload
 * @returns {Array<Object>}
 */
export function buildPageRuntimeContextInputItems(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const text = payload.mode === 'host_page'
    ? buildHostPageRuntimeContextText(payload)
    : buildIsolatedSandboxRuntimeContextText(payload);
  if (!text.trim()) return [];
  return [{
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text
      }
    ]
  }];
}

/**
 * 根据上一条已生效签名，决定当前节点是否需要真正挂载新的隐藏上下文。
 *
 * @param {{
 *   payload?: Object|null,
 *   previousEffectiveSignature?: string|null
 * }} options
 * @returns {{signature:string|null, inputItems:Array<Object>|null}}
 */
export function resolvePageRuntimeContextAttachment(options = {}) {
  const payload = (options?.payload && typeof options.payload === 'object') ? options.payload : null;
  const previousEffectiveSignature = (typeof options?.previousEffectiveSignature === 'string')
    ? options.previousEffectiveSignature
    : '';
  const signature = buildPageRuntimeContextSignature(payload);
  const inputItems = buildPageRuntimeContextInputItems(payload);

  if (!signature || inputItems.length <= 0) {
    return {
      signature: null,
      inputItems: null
    };
  }

  if (previousEffectiveSignature && previousEffectiveSignature === signature) {
    return {
      signature: null,
      inputItems: null
    };
  }

  return {
    signature,
    inputItems
  };
}
