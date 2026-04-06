/**
 * 基于 chrome.userScripts 的最小可用 JS Runtime。
 *
 * 设计目标（Phase 1）：
 * 1. 只做一次性执行，不做长期会话态 REPL 管理；
 * 2. 默认运行在 USER_SCRIPT world，而不是 MAIN world；
 * 3. 不向页面注入任何宿主扩展桥，执行环境保持为“纯页面 JS”；
 * 4. 遇到 Chrome 版本 / 用户侧开关不满足时，返回明确错误，而不是偷偷 fallback。
 */

/**
 * 将错误对象压缩成适合 UI 展示的轻量结构。
 * @param {any} error
 * @returns {{message:string, name:string, stack:string}}
 */
function normalizeJsRuntimeError(error) {
  const message = (typeof error?.message === 'string' && error.message.trim())
    ? error.message.trim()
    : String(error || '未知错误');
  return {
    message,
    name: (typeof error?.name === 'string' && error.name.trim()) ? error.name.trim() : 'Error',
    stack: (typeof error?.stack === 'string') ? error.stack : ''
  };
}

function normalizeJsRuntimeLogEntry(entry, fallbackFrameId = null) {
  const log = (entry && typeof entry === 'object' && !Array.isArray(entry)) ? entry : {};
  return {
    frameId: Number.isFinite(Number(log?.frameId)) ? Number(log.frameId) : fallbackFrameId,
    level: (typeof log?.level === 'string' && log.level.trim()) ? log.level.trim().toLowerCase() : 'log',
    text: (typeof log?.text === 'string') ? log.text : String(log?.text ?? '')
  };
}

function isJsRuntimeEnvelope(value) {
  return !!(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.__cerebrJsRuntimeEnvelope === true
  );
}

/**
 * 用于把 execute() 返回值压成稳定结构，便于后续 UI / 工具层复用。
 * @param {any} item
 * @returns {{frameId:number|null, documentId:string|null, result:any, logs:Array<any>, error:any}}
 */
function normalizeExecuteResultItem(item) {
  const frameId = Number.isFinite(Number(item?.frameId)) ? Number(item.frameId) : null;
  const documentId = (typeof item?.documentId === 'string' && item.documentId) ? item.documentId : null;
  const rawEnvelope = isJsRuntimeEnvelope(item?.result) ? item.result : null;
  const envelopeError = rawEnvelope?.error ? normalizeJsRuntimeError(rawEnvelope.error) : null;
  return {
    frameId,
    documentId,
    result: rawEnvelope ? rawEnvelope.value : item?.result,
    logs: Array.isArray(rawEnvelope?.logs)
      ? rawEnvelope.logs.map((entry) => normalizeJsRuntimeLogEntry(entry, frameId))
      : [],
    error: item?.error ? normalizeJsRuntimeError(item.error) : envelopeError
  };
}

/**
 * 将 frame 探测结果压成适合注入模型上下文的轻量快照。
 * @param {any} item
 * @returns {{frameId:number|null, documentId:string|null, url:string, title:string, isTop:boolean, error:any}}
 */
function normalizeFrameSnapshotItem(item) {
  const normalized = normalizeExecuteResultItem(item);
  const result = (normalized?.result && typeof normalized.result === 'object' && !Array.isArray(normalized.result))
    ? normalized.result
    : {};
  return {
    frameId: normalized.frameId,
    documentId: normalized.documentId,
    url: (typeof result.url === 'string') ? result.url : '',
    title: (typeof result.title === 'string') ? result.title : '',
    isTop: result.isTop === true || normalized.frameId === 0,
    error: normalized.error
  };
}

/**
 * 构造注入到 userScripts world 里的代码。
 *
 * 实现方式：
 * - 整段代码作为字符串传给 `chrome.userScripts.execute()`；
 * - 将用户提供的代码作为 async IIFE 函数体执行；
 * - 因此模型/调用方可以直接写 `await` 与 `return`；
 * - 不向执行环境额外注入任何扩展对象，保持纯页面 JS 语义。
 *
 * @param {string} userCode
 * @returns {string}
 */
function buildUserScriptSource(userCode) {
  const body = (typeof userCode === 'string') ? userCode : '';
  return `
  (async () => {
    const __cerebrMaxLogs = 50;
    const __cerebrMaxLogChars = 4000;
    const __cerebrBuildReplacer = () => {
      const seen = new WeakSet();
      return (_key, value) => {
        if (typeof value === 'bigint') return \`\${value.toString()}n\`;
        if (typeof value === 'function') return \`[Function\${value.name ? \`: \${value.name}\` : ''}]\`;
        if (value instanceof Error) {
          return {
            name: value.name || 'Error',
            message: value.message || '',
            stack: typeof value.stack === 'string' ? value.stack : ''
          };
        }
        if (
          value
          && typeof value === 'object'
          && Number.isFinite(Number(value.nodeType))
          && typeof value.nodeName === 'string'
        ) {
          const id = typeof value.id === 'string' && value.id ? \`#\${value.id}\` : '';
          const className = typeof value.className === 'string' && value.className.trim()
            ? \`.\${value.className.trim().split(/\\s+/).join('.')}\`
            : '';
          return \`[DOM \${String(value.nodeName).toLowerCase()}\${id}\${className}]\`;
        }
        if (value && typeof value === 'object') {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
        }
        return value;
      };
    };
    const __cerebrNormalizeError = (error) => ({
      message: (typeof error?.message === 'string' && error.message.trim())
        ? error.message.trim()
        : String(error || '未知错误'),
      name: (typeof error?.name === 'string' && error.name.trim()) ? error.name.trim() : 'Error',
      stack: (typeof error?.stack === 'string') ? error.stack : ''
    });
    const __cerebrFormatLogArg = (value) => {
      if (typeof value === 'string') return value;
      if (value == null || typeof value === 'number' || typeof value === 'boolean') return String(value);
      if (typeof value === 'bigint') return \`\${value.toString()}n\`;
      if (typeof value === 'function') return \`[Function\${value.name ? \`: \${value.name}\` : ''}]\`;
      if (value instanceof Error) {
        return \`\${value.name || 'Error'}: \${value.message || ''}\`.trim();
      }
      try {
        return JSON.stringify(value, __cerebrBuildReplacer(), 2);
      } catch (_) {
        try {
          return String(value);
        } catch (_) {
          return '[unserializable]';
        }
      }
    };
    const __cerebrLogs = [];
    let __cerebrOmittedLogs = 0;
    const __cerebrPushLog = (level, args) => {
      if (__cerebrLogs.length >= __cerebrMaxLogs) {
        __cerebrOmittedLogs += 1;
        return;
      }
      const text = args.map((arg) => __cerebrFormatLogArg(arg)).join(' ');
      __cerebrLogs.push({
        level,
        text: text.length <= __cerebrMaxLogChars ? text : \`\${text.slice(0, __cerebrMaxLogChars)}…\`
      });
    };
    const __cerebrOriginalConsole = globalThis.console;
    const __cerebrConsole = Object.create(__cerebrOriginalConsole || {});
    ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
      __cerebrConsole[level] = (...args) => __cerebrPushLog(level, args);
    });
    const console = __cerebrConsole;
    try {
      globalThis.console = __cerebrConsole;
      const __cerebrValue = await (async () => {
${body}
      })();
      if (__cerebrOmittedLogs > 0) {
        __cerebrLogs.push({
          level: 'info',
          text: \`[… \${__cerebrOmittedLogs} console entries omitted …]\`
        });
      }
      return {
        __cerebrJsRuntimeEnvelope: true,
        ok: true,
        value: __cerebrValue,
        logs: __cerebrLogs,
        error: null
      };
    } catch (error) {
      if (__cerebrOmittedLogs > 0) {
        __cerebrLogs.push({
          level: 'info',
          text: \`[… \${__cerebrOmittedLogs} console entries omitted …]\`
        });
      }
      return {
        __cerebrJsRuntimeEnvelope: true,
        ok: false,
        value: null,
        logs: __cerebrLogs,
        error: __cerebrNormalizeError(error)
      };
    } finally {
      globalThis.console = __cerebrOriginalConsole;
    }
  })();
`.trim();
}

/**
 * 构造一个最小 JS Runtime manager。
 *
 * @returns {Object}
 */
export function createJsRuntimeManager() {
  /**
   * 探测当前环境是否真的可执行 userScripts。
   * 这里既检查 API 是否存在，也检查 execute / getScripts 是否可用。
   *
   * @returns {Promise<{available:boolean, hasUserScriptsApi:boolean, hasExecute:boolean, reason:string}>}
   */
  async function getAvailability() {
    const hasUserScriptsApi = !!chrome?.userScripts;
    const hasExecute = typeof chrome?.userScripts?.execute === 'function';

    if (!hasUserScriptsApi) {
      return {
        available: false,
        hasUserScriptsApi,
        hasExecute,
        reason: '当前 Chrome 扩展环境不支持 chrome.userScripts。'
      };
    }

    if (!hasExecute) {
      return {
        available: false,
        hasUserScriptsApi,
        hasExecute,
        reason: '当前 Chrome 版本不支持 chrome.userScripts.execute（需要 Chrome 135+）。'
      };
    }

    try {
      await chrome.userScripts.getScripts();
      return {
        available: true,
        hasUserScriptsApi,
        hasExecute,
        reason: ''
      };
    } catch (error) {
      return {
        available: false,
        hasUserScriptsApi,
        hasExecute,
        reason: `userScripts 当前不可用：${normalizeJsRuntimeError(error).message}。请检查扩展详情页里的 Allow User Scripts / 开发者模式设置。`
      };
    }
  }

  /**
   * 执行一段运行时生成的 JS 代码。
   *
   * @param {Object} request
   * @param {number} request.tabId
   * @param {string} request.code
   * @param {number[]|null} [request.frameIds]
   * @param {boolean} [request.allFrames]
   * @param {boolean} [request.injectImmediately]
   * @returns {Promise<{ok:boolean, items:Array<Object>, value:any, logs:Array<Object>}>}
   */
  async function execute(request = {}) {
    const tabId = Number(request?.tabId);
    const code = (typeof request?.code === 'string') ? request.code : '';
    if (!Number.isFinite(tabId)) {
      throw new Error('执行 JS Runtime 失败：缺少有效 tabId。');
    }
    if (!code.trim()) {
      throw new Error('执行 JS Runtime 失败：代码内容为空。');
    }

    const availability = await getAvailability();
    if (!availability.available) {
      throw new Error(availability.reason || 'JS Runtime 当前不可用');
    }

    /** @type {chrome.userScripts.UserScriptInjectionTarget} */
    const target = { tabId };
    if (Array.isArray(request?.frameIds) && request.frameIds.length > 0) {
      target.frameIds = request.frameIds
        .map(value => Number(value))
        .filter(value => Number.isFinite(value));
    } else if (request?.allFrames === true) {
      target.allFrames = true;
    }

    const rawItems = await chrome.userScripts.execute({
      target,
      injectImmediately: request?.injectImmediately === true,
      js: [
        {
          code: buildUserScriptSource(code)
        }
      ]
    });

    const items = Array.isArray(rawItems)
      ? rawItems.map(normalizeExecuteResultItem)
      : [];
    const successfulItems = items.filter(item => !item.error);
    const logs = items.flatMap((item) => {
      if (!Array.isArray(item?.logs)) return [];
      return item.logs.map((log) => normalizeJsRuntimeLogEntry(log, item.frameId));
    });

    return {
      ok: items.every(item => !item.error),
      items,
      logs,
      value: successfulItems.length === 1
        ? successfulItems[0].result
        : successfulItems.map(item => item.result)
    };
  }

  /**
   * 枚举当前标签页所有可注入 frame 的快照。
   *
   * 说明：
   * - 这里在扩展侧主动做一次 allFrames 探测；
   * - 目的是把 frameId/url/title/isTop 注入模型上下文，帮助模型在一次工具调用里直接选择目标 frame；
   * - 不是为了让模型再额外走一次“发现 frame”工具调用。
   *
   * @param {{tabId:number}} request
   * @returns {Promise<{ok:boolean, frames:Array<Object>}>}
   */
  async function listFrames(request = {}) {
    const tabId = Number(request?.tabId);
    if (!Number.isFinite(tabId)) {
      throw new Error('获取 JS Runtime frame 快照失败：缺少有效 tabId。');
    }

    const probeResult = await execute({
      tabId,
      allFrames: true,
      code: `
        let isTop = false;
        try {
          isTop = globalThis === globalThis.top;
        } catch (_) {
          isTop = false;
        }
        return {
          url: location.href,
          title: document.title || '',
          isTop
        };
      `
    });

    const frames = Array.isArray(probeResult?.items)
      ? probeResult.items
        .map(normalizeFrameSnapshotItem)
        .filter(item => !item.error && Number.isFinite(item.frameId))
        .sort((a, b) => {
          if (a.isTop !== b.isTop) return a.isTop ? -1 : 1;
          return (a.frameId ?? Number.MAX_SAFE_INTEGER) - (b.frameId ?? Number.MAX_SAFE_INTEGER);
        })
      : [];

    return {
      ok: probeResult?.ok === true,
      frames
    };
  }

  return {
    getAvailability,
    listFrames,
    execute
  };
}
