import { createBrowserJsReplKernel } from '../utils/browser_js_repl.js';

/**
 * 基于 chrome.userScripts 的最小可用 JS Runtime。
 *
 * 设计目标：
 * 1. 保留一次性执行能力；
 * 2. 新增可 reset 的持久化 JS REPL；
 * 2. 默认运行在 USER_SCRIPT world，而不是 MAIN world；
 * 3. 不向页面注入任何宿主扩展桥，执行环境保持为“纯页面 JS”；
 * 4. 遇到 Chrome 版本 / 用户侧开关不满足时，返回明确错误，而不是偷偷 fallback。
 */

const JS_REPL_KERNEL_GLOBAL_KEY = '__cerebrJsReplKernelV1__';

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
 * 将 webNavigation 返回的 frame 元数据压成稳定快照。
 *
 * 为什么这里不再用 `userScripts.execute({ allFrames: true })` 做 frame 发现：
 * - frame 枚举本质上是“导航树元数据”问题，不应该依赖“每个 frame 都能成功执行一段 JS”；
 * - 在 `op.gg` 这类会快速创建/销毁空白 iframe 的页面里，allFrames 批量执行会把“发现 frame”与“在 frame 里跑代码”绑定在一起，
 *   一旦某个子 frame 处于不稳定状态，整次枚举就可能被拖挂；
 * - `chrome.webNavigation.getAllFrames()` 正是为“列出当前 tab 的 frame 树”准备的原语，更符合这里的需求。
 *
 * @param {any} item
 * @returns {{frameId:number|null, documentId:string|null, url:string, title:string, isTop:boolean, error:any}}
 */
function normalizeNavigationFrameSnapshotItem(item) {
  const frameId = Number.isFinite(Number(item?.frameId)) ? Number(item.frameId) : null;
  const url = (typeof item?.url === 'string') ? item.url : '';
  return {
    frameId,
    documentId: (typeof item?.documentId === 'string' && item.documentId) ? item.documentId : null,
    url,
    title: '',
    isTop: frameId === 0,
    error: item?.errorOccurred === true
      ? {
          message: '该 frame 最近一次导航以错误结束。',
          name: 'FrameNavigationError',
          stack: ''
        }
      : null
  };
}

/**
 * 判断某个 frame URL 是否值得暴露给模型作为可选目标。
 *
 * 说明：
 * - 保留顶层 frame（frameId=0）以便始终有一个稳定默认目标；
 * - 过滤扩展自身 / 浏览器内部页，避免把不可能作为宿主页执行目标的 frame 暴露给模型；
 * - 其余普通网页 frame（包括 about:blank / data: 等）先保留，让导航层枚举尽量忠实反映当前结构。
 *
 * @param {{frameId:number|null,url:string}} frame
 * @returns {boolean}
 */
function shouldExposeNavigationFrameSnapshot(frame) {
  if (!frame || !Number.isFinite(frame.frameId)) return false;
  if (frame.frameId === 0) return true;
  const url = (typeof frame.url === 'string') ? frame.url.trim() : '';
  if (!url) return true;
  return !(
    url.startsWith('chrome-extension://')
    || url.startsWith('chrome://')
    || url.startsWith('devtools://')
    || url.startsWith('edge://')
    || url.startsWith('about:srcdoc')
  );
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

function buildUserScriptReplExecuteSource(userCode) {
  const code = (typeof userCode === 'string') ? userCode : '';
  const createKernelSource = createBrowserJsReplKernel.toString();
  return `
  (async () => {
    const __cerebrKernelKey = ${JSON.stringify(JS_REPL_KERNEL_GLOBAL_KEY)};
    const __cerebrCreateKernel = ${createKernelSource};
    if (
      !globalThis[__cerebrKernelKey]
      || typeof globalThis[__cerebrKernelKey].execute !== 'function'
      || typeof globalThis[__cerebrKernelKey].reset !== 'function'
    ) {
      globalThis[__cerebrKernelKey] = __cerebrCreateKernel(globalThis);
    }
    const __cerebrKernel = globalThis[__cerebrKernelKey];
    const __cerebrResult = await __cerebrKernel.execute(${JSON.stringify(code)});
    return {
      __cerebrJsRuntimeEnvelope: true,
      ok: __cerebrResult?.ok === true,
      value: __cerebrResult?.ok === true ? (__cerebrResult?.value ?? null) : null,
      logs: Array.isArray(__cerebrResult?.logs) ? __cerebrResult.logs : [],
      error: __cerebrResult?.ok === true
        ? null
        : (__cerebrResult?.error || {
            name: 'JsReplExecutionError',
            message: 'JS REPL 执行失败。',
            stack: ''
          })
    };
  })();
`.trim();
}

function buildUserScriptReplResetSource() {
  const createKernelSource = createBrowserJsReplKernel.toString();
  return `
  (() => {
    const __cerebrKernelKey = ${JSON.stringify(JS_REPL_KERNEL_GLOBAL_KEY)};
    const __cerebrCreateKernel = ${createKernelSource};
    try {
      delete globalThis[__cerebrKernelKey];
    } catch (_) {
      globalThis[__cerebrKernelKey] = null;
    }
    globalThis[__cerebrKernelKey] = __cerebrCreateKernel(globalThis);
    return {
      __cerebrJsRuntimeEnvelope: true,
      ok: true,
      value: 'js_repl kernel reset',
      logs: [],
      error: null
    };
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
   * 执行持久化 JS REPL 单元。
   *
   * @param {Object} request
   * @param {number} request.tabId
   * @param {string} request.code
   * @param {number[]|null} [request.frameIds]
   * @returns {Promise<{ok:boolean, items:Array<Object>, value:any, logs:Array<Object>}>}
   */
  async function executeRepl(request = {}) {
    const tabId = Number(request?.tabId);
    const code = (typeof request?.code === 'string') ? request.code : '';
    if (!Number.isFinite(tabId)) {
      throw new Error('执行 JS REPL 失败：缺少有效 tabId。');
    }
    if (!code.trim()) {
      throw new Error('执行 JS REPL 失败：代码内容为空。');
    }

    const availability = await getAvailability();
    if (!availability.available) {
      throw new Error(availability.reason || 'JS REPL 当前不可用');
    }

    /** @type {chrome.userScripts.UserScriptInjectionTarget} */
    const target = { tabId };
    if (Array.isArray(request?.frameIds) && request.frameIds.length > 0) {
      target.frameIds = request.frameIds
        .map(value => Number(value))
        .filter(value => Number.isFinite(value));
    }

    const rawItems = await chrome.userScripts.execute({
      target,
      injectImmediately: request?.injectImmediately === true,
      js: [
        {
          code: buildUserScriptReplExecuteSource(code)
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
   * 重置持久化 JS REPL 内核。
   *
   * @param {Object} request
   * @param {number} request.tabId
   * @param {number[]|null} [request.frameIds]
   * @returns {Promise<{ok:boolean, items:Array<Object>, value:any, logs:Array<Object>}>}
   */
  async function resetRepl(request = {}) {
    const tabId = Number(request?.tabId);
    if (!Number.isFinite(tabId)) {
      throw new Error('重置 JS REPL 失败：缺少有效 tabId。');
    }

    const availability = await getAvailability();
    if (!availability.available) {
      throw new Error(availability.reason || 'JS REPL 当前不可用');
    }

    /** @type {chrome.userScripts.UserScriptInjectionTarget} */
    const target = { tabId };
    if (Array.isArray(request?.frameIds) && request.frameIds.length > 0) {
      target.frameIds = request.frameIds
        .map(value => Number(value))
        .filter(value => Number.isFinite(value));
    }

    const rawItems = await chrome.userScripts.execute({
      target,
      injectImmediately: true,
      js: [
        {
          code: buildUserScriptReplResetSource()
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

    if (typeof chrome?.webNavigation?.getAllFrames !== 'function') {
      throw new Error('获取 JS Runtime frame 快照失败：当前扩展未启用 webNavigation 能力，请重载扩展后重试。');
    }

    const rawFrames = await chrome.webNavigation.getAllFrames({ tabId });
    const frames = Array.isArray(rawFrames)
      ? rawFrames
        .map(normalizeNavigationFrameSnapshotItem)
        .filter((item) => !item.error && shouldExposeNavigationFrameSnapshot(item))
        .sort((a, b) => {
          if (a.isTop !== b.isTop) return a.isTop ? -1 : 1;
          return (a.frameId ?? Number.MAX_SAFE_INTEGER) - (b.frameId ?? Number.MAX_SAFE_INTEGER);
        })
      : [];

    if (frames.length > 0) {
      try {
        const tab = await chrome.tabs.get(tabId);
        const topFrame = frames.find(item => item.isTop) || null;
        if (topFrame) {
          const topTitle = (typeof tab?.title === 'string') ? tab.title.trim() : '';
          if (topTitle) {
            topFrame.title = topTitle;
          }
          if (!topFrame.url && typeof tab?.url === 'string') {
            topFrame.url = tab.url;
          }
        }
      } catch (_) {
        // 标签页标题只用于补足展示信息，不应影响 frame 枚举主流程。
      }
    }

    return {
      ok: true,
      frames
    };
  }

  return {
    getAvailability,
    listFrames,
    execute,
    executeRepl,
    resetRepl
  };
}
