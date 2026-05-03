import {
  JS_RUNTIME_ENV_BOUND_HOST_PAGE,
  JS_RUNTIME_ENV_ISOLATED_SANDBOX
} from '../agent_tools/shared/page_tool_environment.js';

/**
 * 规范化 frame 快照，确保签名稳定且字段顺序固定。
 *
 * @param {Array<any>|null|undefined} frames
 * @returns {Array<{frame_id:number, is_top:boolean, url:string, title:string}>}
 */
function tryParseFrameUrl(url) {
  const text = (typeof url === 'string') ? url.trim() : '';
  if (!text) return null;
  try {
    return new URL(text);
  } catch (_) {
    return null;
  }
}

/**
 * 判断某个 frame 是否属于“已知高噪声挑战 iframe”。
 *
 * 这里的目标不是屏蔽真实业务 iframe，而是过滤掉：
 * - reCAPTCHA / hCaptcha / Turnstile 这类会频繁重建、URL query 高度动态的挑战 frame；
 * - 它们几乎不会成为模型应主动选择的 JS Runtime 目标；
 * - 但如果直接进 `page_runtime_context`，会导致签名抖动、prompt 膨胀、历史里充满无意义差异。
 *
 * 因此这层只影响“注入模型的隐藏上下文”，不影响底层真实 frame 枚举接口。
 *
 * @param {{url?:string, is_top?:boolean}} frame
 * @returns {boolean}
 */
function isHighChurnChallengeFrame(frame) {
  if (frame?.is_top === true) return false;
  const parsed = tryParseFrameUrl(frame?.url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();

  const isRecaptcha = (
    (host === 'www.google.com' || host === 'www.recaptcha.net')
    && pathname.startsWith('/recaptcha/')
  );
  const isHcaptcha = host === 'hcaptcha.com'
    || host.endsWith('.hcaptcha.com');
  const isTurnstile = host === 'challenges.cloudflare.com'
    && pathname.includes('/turnstile/');

  return isRecaptcha || isHcaptcha || isTurnstile;
}

/**
 * 过滤对模型几乎没有选择价值、但会显著增加噪声的辅助 frame。
 *
 * 当前策略：
 * - 保留顶层 frame；
 * - 过滤已知 challenge frame；
 * - 过滤没有标题、URL 又只是 `about:blank` / `about:srcdoc` / `data:` / `blob:` 的辅助 frame。
 *
 * 最后一类 frame 在现代站点里经常是 challenge / telemetry / sandbox 中转壳，
 * 只会制造 prompt 抖动；如果后续遇到真实业务依赖，再针对性放宽，而不是继续默认全量暴露。
 *
 * @param {{url?:string, title?:string, is_top?:boolean}} frame
 * @returns {boolean}
 */
function shouldIncludePageRuntimeContextFrame(frame) {
  if (!frame) return false;
  if (frame.is_top === true) return true;
  if (isHighChurnChallengeFrame(frame)) return false;

  const url = (typeof frame.url === 'string') ? frame.url.trim().toLowerCase() : '';
  const title = (typeof frame.title === 'string') ? frame.title.trim() : '';
  if (!url) return !!title;

  const isAuxiliaryBlankFrame = (
    url === 'about:blank'
    || url === 'about:srcdoc'
    || url.startsWith('data:')
    || url.startsWith('blob:')
  );
  if (isAuxiliaryBlankFrame && !title) {
    return false;
  }
  return true;
}

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
    .filter((item) => shouldIncludePageRuntimeContextFrame(item))
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
 * - 纯对话/隔离模式下直接返回 null，避免把“当前没有页面工具”这种运行页状态也写进对话。
 *   已经存在于历史中的旧上下文保持原样，避免破坏 Responses prompt cache 的前缀一致性。
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
  if (pageToolEnvironment?.exposeHostPageTools === false) {
    return null;
  }

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
  if (jsRuntimeEnvironment !== JS_RUNTIME_ENV_BOUND_HOST_PAGE) {
    return null;
  }

  const exposePageContentTool = pageToolEnvironment?.exposePageContentTool === true;
  const mode = 'host_page';

  if (!url && !title && normalizedFrames.length === 0) {
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

function escapeXmlText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildHostPageRuntimeContextText(payload) {
  const lines = [
    `<page_runtime_context mode="${escapeXmlText(payload.mode)}">`,
    `  <page_content_tool>${escapeXmlText(payload.page_content_tool)}</page_content_tool>`,
    `  <js_runtime_environment>${escapeXmlText(payload.js_runtime_environment)}</js_runtime_environment>`
  ];
  if (payload.url) lines.push(`  <url>${escapeXmlText(payload.url)}</url>`);
  if (payload.title) lines.push(`  <title>${escapeXmlText(payload.title)}</title>`);
  if (Array.isArray(payload.frames) && payload.frames.length > 0) {
    lines.push('  <frames>');
    payload.frames.forEach((item) => {
      lines.push(`    <frame id="${escapeXmlText(item.frame_id)}" top="${item.is_top ? 'true' : 'false'}">`);
      if (item.url) lines.push(`      <url>${escapeXmlText(item.url)}</url>`);
      if (item.title) lines.push(`      <title>${escapeXmlText(item.title)}</title>`);
      lines.push('    </frame>');
    });
    lines.push('  </frames>');
  }
  lines.push('</page_runtime_context>');
  return lines.join('\n');
}

/**
 * 将页面运行上下文负载转成可直接插入 Responses `input` 的隐藏 contextual items。
 *
 * @param {Object|null|undefined} payload
 * @returns {Array<Object>}
 */
export function buildPageRuntimeContextInputItems(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (payload.mode !== 'host_page') return [];
  const text = buildHostPageRuntimeContextText(payload);
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
