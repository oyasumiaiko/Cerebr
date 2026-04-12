import {
  buildJsSandboxSuccessEnvelope,
  buildJsSandboxErrorEnvelope
} from '../../utils/js_sandbox_transport.js';

const SANDBOX_MESSAGE_FLAG = '__cerebrJsSandbox';
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const activeExecutionAborters = new Map();

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

function normalizeConsoleArg(value) {
  if (typeof value === 'string') return value;
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'function') return `[Function${value.name ? `: ${value.name}` : ''}]`;
  if (value instanceof Error) {
    return `${value.name || 'Error'}: ${value.message || ''}`.trim();
  }
  if (
    value
    && typeof value === 'object'
    && Number.isFinite(Number(value.nodeType))
    && typeof value.nodeName === 'string'
  ) {
    const id = typeof value.id === 'string' && value.id ? `#${value.id}` : '';
    const className = typeof value.className === 'string' && value.className.trim()
      ? `.${value.className.trim().split(/\s+/).join('.')}`
      : '';
    return `[DOM ${String(value.nodeName).toLowerCase()}${id}${className}]`;
  }
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, child) => {
      if (typeof child === 'bigint') return `${child.toString()}n`;
      if (typeof child === 'function') return `[Function${child.name ? `: ${child.name}` : ''}]`;
      if (child instanceof Error) {
        return {
          name: child.name || 'Error',
          message: child.message || '',
          stack: typeof child.stack === 'string' ? child.stack : ''
        };
      }
      if (child && typeof child === 'object') {
        if (seen.has(child)) return '[Circular]';
        seen.add(child);
      }
      return child;
    }, 2);
  } catch (_) {
    try {
      return String(value);
    } catch (_) {
      return '[unserializable]';
    }
  }
}

async function executeUserCodeWithCapturedConsole(code) {
  const logs = [];
  const originalConsole = globalThis.console;
  const capturedConsole = Object.create(originalConsole || {});
  ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
    capturedConsole[level] = (...args) => {
      logs.push({
        level,
        text: args.map((arg) => normalizeConsoleArg(arg)).join(' ')
      });
    };
  });

  try {
    globalThis.console = capturedConsole;
    const result = await executeUserCode(code);
    return {
      ok: true,
      value: result,
      logs
    };
  } catch (error) {
    return {
      ok: false,
      value: null,
      error,
      logs
    };
  } finally {
    globalThis.console = originalConsole;
  }
}

function createSandboxAbortError() {
  const error = new Error('执行隔离 JS Sandbox 已取消。');
  error.name = 'AbortError';
  return error;
}

window.addEventListener('message', async (event) => {
  const data = event.data || {};
  if (data?.[SANDBOX_MESSAGE_FLAG] !== true) return;

  const requestId = (typeof data.requestId === 'string') ? data.requestId : '';
  if (data.type === 'abort') {
    const abortExecution = activeExecutionAborters.get(requestId);
    if (typeof abortExecution === 'function') {
      abortExecution();
    }
    return;
  }
  if (data.type !== 'execute') return;

  try {
    let abort = null;
    const abortPromise = new Promise((_, reject) => {
      abort = () => reject(createSandboxAbortError());
    });
    if (typeof abort === 'function') {
      activeExecutionAborters.set(requestId, abort);
    }
    const execution = await Promise.race([
      executeUserCodeWithCapturedConsole(data.code),
      abortPromise
    ]);
    if (execution.ok !== true) {
      postSandboxMessage('execute_result', {
        requestId,
        payload: buildJsSandboxErrorEnvelope(execution.error, execution.logs)
      });
      return;
    }
    postSandboxMessage('execute_result', {
      requestId,
      payload: buildJsSandboxSuccessEnvelope(execution.value, execution.logs)
    });
  } catch (error) {
    postSandboxMessage('execute_result', {
      requestId,
      payload: buildJsSandboxErrorEnvelope(error)
    });
  } finally {
    activeExecutionAborters.delete(requestId);
  }
});

postSandboxMessage('ready');
