const MESSAGE_FLAG = '__cerebrJsRuntimeRunner';
const ALLOWED_MESSAGE_TYPES = new Set([
  'GET_JS_RUNTIME_STATUS',
  'GET_JS_RUNTIME_FRAMES',
  'EXECUTE_JS_RUNTIME',
  'ABORT_JS_RUNTIME'
]);

function resolveRunnerIdentity() {
  try {
    const url = new URL(window.location.href);
    const generation = Number(url.searchParams.get('generation'));
    return {
      generation: Number.isSafeInteger(generation) && generation > 0 ? generation : 0,
      channelId: url.searchParams.get('channelId') || ''
    };
  } catch (_) {
    return { generation: 0, channelId: '' };
  }
}

const identity = resolveRunnerIdentity();
let hostPort = null;

function postToHost(type, payload = {}) {
  hostPort?.postMessage({
    [MESSAGE_FLAG]: true,
    type,
    generation: identity.generation,
    channelId: identity.channelId,
    ...payload
  });
}

async function handleRuntimeRequest(data = {}) {
  if (data?.[MESSAGE_FLAG] !== true || data.type !== 'request') return;
  if (data.generation !== identity.generation || data.channelId !== identity.channelId) return;
  const requestId = typeof data.requestId === 'string' ? data.requestId : '';
  const runtimeMessage = data.runtimeMessage;
  const runtimeMessageType = typeof runtimeMessage?.type === 'string' ? runtimeMessage.type : '';
  if (!requestId || !ALLOWED_MESSAGE_TYPES.has(runtimeMessageType)) return;

  try {
    const response = await chrome.runtime.sendMessage(runtimeMessage);
    postToHost('response', { requestId, response });
  } catch (error) {
    postToHost('response', {
      requestId,
      response: {
        success: false,
        error: error?.message || '隐藏 JS Runtime runner 请求失败。'
      }
    });
  }
}

window.addEventListener('message', (event) => {
  if (hostPort || event.source !== window.parent) return;
  const data = event.data || {};
  if (data?.[MESSAGE_FLAG] !== true || data.type !== 'connect') return;
  if (data.generation !== identity.generation || data.channelId !== identity.channelId) return;
  const port = event.ports?.[0];
  if (!port) return;
  hostPort = port;
  hostPort.onmessage = (portEvent) => {
    handleRuntimeRequest(portEvent?.data).catch((error) => {
      console.error('[Cerebr JS Runtime Runner] 处理请求失败:', error);
    });
  };
  hostPort.start?.();
  postToHost('ready');
});
