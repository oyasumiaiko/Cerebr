import {
  buildJsSandboxSuccessEnvelope,
  buildJsSandboxErrorEnvelope
} from '../../utils/js_sandbox_transport.js';

const SANDBOX_MESSAGE_FLAG = '__cerebrJsSandbox';
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function postSandboxMessage(type, payload = {}) {
  try {
    window.parent?.postMessage({
      [SANDBOX_MESSAGE_FLAG]: true,
      type,
      ...payload
    }, '*');
  } catch (error) {
    console.error('[Cerebr JS Sandbox] 发送消息失败:', error);
  }
}

async function executeUserCode(code) {
  const body = (typeof code === 'string') ? code : '';
  const fn = new AsyncFunction(body);
  return await fn();
}

window.addEventListener('message', async (event) => {
  const data = event.data || {};
  if (data?.[SANDBOX_MESSAGE_FLAG] !== true) return;
  if (data.type !== 'execute') return;

  const requestId = (typeof data.requestId === 'string') ? data.requestId : '';
  try {
    const result = await executeUserCode(data.code);
    postSandboxMessage('execute_result', {
      requestId,
      payload: buildJsSandboxSuccessEnvelope(result)
    });
  } catch (error) {
    postSandboxMessage('execute_result', {
      requestId,
      payload: buildJsSandboxErrorEnvelope(error)
    });
  }
});

postSandboxMessage('ready');
