import { createJsRuntimeManager } from '../../extension/js_runtime_manager.js';

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
const jsRuntimeManager = createJsRuntimeManager();
let hostTabIdPromise = null;
let hostPort = null;

async function resolveHostTabId() {
  if (!hostTabIdPromise) {
    hostTabIdPromise = chrome.tabs.getCurrent().then((tab) => {
      const tabId = Number(tab?.id);
      if (!Number.isSafeInteger(tabId) || tabId < 0) {
        throw new Error('隐藏 JS Runtime runner 无法解析所在宿主 tab。');
      }
      return tabId;
    }).catch((error) => {
      hostTabIdPromise = null;
      throw error;
    });
  }
  return await hostTabIdPromise;
}

async function executeRuntimeMessage(runtimeMessage) {
  switch (runtimeMessage?.type) {
    case 'GET_JS_RUNTIME_STATUS':
      return {
        success: true,
        status: await jsRuntimeManager.getAvailability()
      };
    case 'GET_JS_RUNTIME_FRAMES': {
      const tabId = await resolveHostTabId();
      return {
        success: true,
        tabId,
        ...(await jsRuntimeManager.listFrames({ tabId }))
      };
    }
    case 'EXECUTE_JS_RUNTIME': {
      const tabId = await resolveHostTabId();
      return {
        success: true,
        tabId,
        ...(await jsRuntimeManager.execute({
          tabId,
          code: runtimeMessage?.code || '',
          executionId: runtimeMessage?.executionId || '',
          savedOutputRef: runtimeMessage?.savedOutputRef || '',
          timeoutMs: runtimeMessage?.timeoutMs,
          frameIds: Array.isArray(runtimeMessage?.frameIds) ? runtimeMessage.frameIds : null,
          allFrames: runtimeMessage?.allFrames === true,
          injectImmediately: runtimeMessage?.injectImmediately === true
        }))
      };
    }
    case 'ABORT_JS_RUNTIME': {
      const tabId = await resolveHostTabId();
      return {
        success: true,
        tabId,
        ...(await jsRuntimeManager.abort({
          tabId,
          executionId: runtimeMessage?.executionId || '',
          frameIds: Array.isArray(runtimeMessage?.frameIds) ? runtimeMessage.frameIds : null,
          allFrames: runtimeMessage?.allFrames === true
        }))
      };
    }
    default:
      throw new Error(`隐藏 JS Runtime runner 不支持消息类型：${runtimeMessage?.type || 'unknown'}`);
  }
}

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
    // 长任务直接由持久的 runner iframe 等待 userScripts.execute，避免把一次
    // runtime.sendMessage 事件悬挂数分钟后被 MV3 service worker 生命周期切断。
    const response = await executeRuntimeMessage(runtimeMessage);
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
