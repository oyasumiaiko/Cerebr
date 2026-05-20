const HTML_PREVIEW_RENDER_MESSAGE = 'CEREBR_HTML_PREVIEW_RENDER';
const HTML_PREVIEW_READY_MESSAGE = 'CEREBR_HTML_PREVIEW_READY';
const HTML_PREVIEW_RENDERED_MESSAGE = 'CEREBR_HTML_PREVIEW_RENDERED';

function postParentMessage(type, payload = {}) {
  try {
    window.parent?.postMessage({
      type,
      source: 'cerebr-html-preview-sandbox',
      ...payload
    }, '*');
  } catch (_) {}
}

function normalizeMessagePayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.type !== HTML_PREVIEW_RENDER_MESSAGE) return null;
  return {
    requestId: typeof data.requestId === 'string' ? data.requestId : '',
    html: typeof data.html === 'string' ? data.html : '',
    title: typeof data.title === 'string' ? data.title : '',
    path: typeof data.path === 'string' ? data.path : ''
  };
}

function renderHtmlPreview(payload) {
  const frame = document.getElementById('html-preview-frame');
  if (!(frame instanceof HTMLIFrameElement)) return;
  if (payload.title || payload.path) {
    frame.title = `${payload.title || payload.path} 预览`;
  }
  // 用户 HTML 在更内层 iframe 执行：允许脚本运行，但不授予同源能力，避免触达外层 sandbox 页。
  frame.addEventListener('load', () => {
    postParentMessage(HTML_PREVIEW_RENDERED_MESSAGE, {
      requestId: payload.requestId,
      path: payload.path
    });
  }, { once: true });
  frame.srcdoc = payload.html || '';
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  const payload = normalizeMessagePayload(event.data);
  if (!payload) return;
  renderHtmlPreview(payload);
});

// 外层 viewer 等到 ready 后再投递 HTML，避免 iframe load 事件与 sandbox 脚本初始化之间出现竞态。
postParentMessage(HTML_PREVIEW_READY_MESSAGE);
