/**
 * 侧栏内部隔离 JS 沙箱与主界面之间共享的协议辅助函数。
 *
 * 这层只处理“如何把执行结果变成稳定、可跨 postMessage 传输的结构”，
 * 不依赖具体 DOM 挂载位置，因此既能被 sandbox iframe 运行时代码复用，
 * 也能在 Node 单元测试里直接验证。
 */

export const JS_SANDBOX_DOCUMENT_ID = 'cerebr-js-sandbox';
export const JS_SANDBOX_TITLE = 'Cerebr JS Sandbox';

/**
 * 构造隔离沙箱的伪 frame 快照。
 *
 * @param {string} frameUrl
 * @returns {{frameId:number, documentId:string, url:string, title:string, isTop:boolean}}
 */
export function buildJsSandboxFrameSnapshot(frameUrl = 'about:blank') {
  return {
    frameId: 0,
    documentId: JS_SANDBOX_DOCUMENT_ID,
    url: frameUrl || 'about:blank',
    title: JS_SANDBOX_TITLE,
    isTop: true
  };
}

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

/**
 * 把 sandbox 中的任意 JS 返回值归一化为稳定、可传输、可显示的结构。
 *
 * 约束：
 * - 必须可被 postMessage/structured clone 传输；
 * - 不能因为函数、循环引用、DOM 节点、bigint 等值直接炸掉；
 * - 这里只做“稳定化”，最终给模型的超长截断仍由 Responses 工具输出层负责。
 *
 * @param {any} value
 * @param {WeakSet<object>} [seen]
 * @returns {any}
 */
export function normalizeJsSandboxTransferValue(value, seen = new WeakSet()) {
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

function normalizeJsSandboxConsoleLogEntry(entry, fallbackFrameId = 0) {
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
}

export function normalizeJsSandboxConsoleLogs(logs, fallbackFrameId = 0) {
  if (!Array.isArray(logs) || logs.length <= 0) return [];
  return logs.map((entry) => normalizeJsSandboxConsoleLogEntry(entry, fallbackFrameId));
}

/**
 * 构造 sandbox JS 成功执行时的稳定返回包。
 *
 * @param {any} value
 * @param {Array<Object>} [logs]
 * @returns {{ok:boolean, value:any, items:Array<Object>, error:null}}
 */
export function buildJsSandboxSuccessEnvelope(value, logs = []) {
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

/**
 * 构造 sandbox JS 执行失败时的稳定返回包。
 *
 * @param {any} error
 * @param {Array<Object>} [logs]
 * @returns {{ok:boolean, value:null, items:Array<Object>, error:Object}}
 */
export function buildJsSandboxErrorEnvelope(error, logs = []) {
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
