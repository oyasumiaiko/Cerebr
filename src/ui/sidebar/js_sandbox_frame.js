const SANDBOX_MESSAGE_FLAG = '__cerebrJsSandbox';
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const activeExecutionAborters = new Map();
const JS_SANDBOX_DOCUMENT_ID = 'cerebr-js-sandbox';

function isDomLikeValue(value) {
  return !!(
    value
    && typeof value === 'object'
    && Number.isFinite(Number(value.nodeType))
    && typeof value.nodeName === 'string'
  );
}

function isErrorLikeValue(value) {
  return !!(
    value
    && typeof value === 'object'
    && typeof value.message === 'string'
    && typeof value.name === 'string'
  );
}

function normalizeDomLikeValue(value) {
  return {
    type: 'dom_node',
    nodeType: Number.isFinite(Number(value?.nodeType)) ? Number(value.nodeType) : null,
    nodeName: (typeof value?.nodeName === 'string') ? value.nodeName : '',
    id: (typeof value?.id === 'string') ? value.id : '',
    className: (typeof value?.className === 'string') ? value.className : '',
    textContent: typeof value?.textContent === 'string' ? value.textContent : '',
    outerHTML: typeof value?.outerHTML === 'string' ? value.outerHTML : ''
  };
}

function normalizeErrorLikeValue(value) {
  return {
    name: (typeof value?.name === 'string' && value.name.trim()) ? value.name.trim() : 'Error',
    message: (typeof value?.message === 'string' && value.message.trim())
      ? value.message.trim()
      : String(value || '未知错误'),
    stack: (typeof value?.stack === 'string') ? value.stack : ''
  };
}

// 这个文件必须保持 classic script：manifest sandbox page 是唯一源环境，
// module script 在这里会触发跨源加载限制，导致父级一直等不到 ready 握手。
function normalizeJsSandboxTransferValue(value, seen = new WeakSet()) {
  if (value == null) return value;

  const primitiveType = typeof value;
  if (primitiveType === 'string' || primitiveType === 'number' || primitiveType === 'boolean') {
    return value;
  }
  if (primitiveType === 'bigint') {
    return {
      type: 'bigint',
      value: value.toString()
    };
  }
  if (primitiveType === 'function') {
    return {
      type: 'function',
      name: (typeof value.name === 'string') ? value.name : ''
    };
  }
  if (primitiveType !== 'object') {
    try {
      return String(value);
    } catch (_) {
      return '[unserializable]';
    }
  }

  if (isDomLikeValue(value)) {
    return normalizeDomLikeValue(value);
  }
  if (isErrorLikeValue(value)) {
    return normalizeErrorLikeValue(value);
  }
  if (seen.has(value)) {
    return {
      type: 'circular_ref'
    };
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeJsSandboxTransferValue(item, seen));
    }

    const entries = Object.entries(value);
    const result = {};
    for (const [key, child] of entries) {
      result[key] = normalizeJsSandboxTransferValue(child, seen);
    }
    return result;
  } catch (error) {
    return {
      type: 'normalization_error',
      error: normalizeErrorLikeValue(error)
    };
  } finally {
    seen.delete(value);
  }
}

function normalizeJsSandboxConsoleLogs(logs, fallbackFrameId = 0) {
  if (!Array.isArray(logs) || logs.length <= 0) return [];
  return logs.map((entry) => {
      const log = (entry && typeof entry === 'object' && !Array.isArray(entry)) ? entry : {};
      const level = (typeof log.level === 'string' && log.level.trim()) ? log.level.trim().toLowerCase() : 'log';
      const frameId = Number.isFinite(Number(log.frameId)) ? Number(log.frameId) : fallbackFrameId;
      const text = typeof log.text === 'string'
        ? log.text
        : String(log.text ?? '');
      return {
        frameId,
        level,
        text
      };
    });
}

function buildJsSandboxSuccessEnvelope(value, logs = []) {
  const normalizedValue = normalizeJsSandboxTransferValue(value);
  const normalizedLogs = normalizeJsSandboxConsoleLogs(logs, 0);
  return {
    ok: true,
    value: normalizedValue,
    logs: normalizedLogs,
    items: [{
      frameId: 0,
      documentId: JS_SANDBOX_DOCUMENT_ID,
      result: normalizedValue,
      logs: normalizedLogs,
      error: null
    }],
    error: null
  };
}

function buildJsSandboxErrorEnvelope(error, logs = []) {
  const normalizedError = normalizeErrorLikeValue(error);
  const normalizedLogs = normalizeJsSandboxConsoleLogs(logs, 0);
  return {
    ok: false,
    value: null,
    logs: normalizedLogs,
    items: [{
      frameId: 0,
      documentId: JS_SANDBOX_DOCUMENT_ID,
      result: null,
      logs: normalizedLogs,
      error: normalizedError
    }],
    error: normalizedError
  };
}

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
