import { buildJsSandboxFrameSnapshot } from '../../utils/js_sandbox_transport.js';

const SANDBOX_MESSAGE_FLAG = '__cerebrJsSandbox';
const SANDBOX_READY_TIMEOUT_MS = 10000;

/**
 * 在侧栏页面内部创建一个隔离 JS 沙箱运行时。
 *
 * 设计目标：
 * - 不访问宿主标签页；
 * - 保留基础 DOM / Web API，可用于纯对话模式下的轻量 JS 试验；
 * - 通过隐藏 sandbox iframe 提供独立执行上下文；
 * - 不对外暴露父页面对象，也不偷偷 fallback 到宿主页。
 *
 * @param {{
 *   ownerWindow?: Window,
 *   ownerDocument?: Document,
 *   sandboxFrameUrl?: string
 * }} [options]
 * @returns {{
 *   getAvailability: () => Promise<Object>,
 *   listFrames: () => Promise<{ok:boolean, frames:Array<Object>}>,
 *   execute: (request?: {code?:string}) => Promise<Object>
 * }}
 */
export function createSidebarJsSandboxRuntime(options = {}) {
  const ownerWindow = options?.ownerWindow || window;
  const ownerDocument = options?.ownerDocument || document;
  const sandboxFrameUrl = options?.sandboxFrameUrl
    || new URL('./js_sandbox_frame.html', import.meta.url).toString();

  let sandboxFrame = null;
  let sandboxReadyPromise = null;
  let resolveSandboxReady = null;
  let rejectSandboxReady = null;
  let readyTimeoutId = null;
  let messageListenerBound = false;
  let requestSeq = 0;
  const pendingRequests = new Map();

  function createSandboxAbortError() {
    const error = new Error('执行隔离 JS Sandbox 已取消。');
    error.name = 'AbortError';
    return error;
  }

  function normalizeWorkspaceFileBridgeError(error) {
    return {
      message: (typeof error?.message === 'string' && error.message.trim())
        ? error.message.trim()
        : String(error || '文件桥接操作失败。'),
      name: (typeof error?.name === 'string' && error.name.trim())
        ? error.name.trim()
        : 'WorkspaceFileBridgeError',
      stack: (typeof error?.stack === 'string') ? error.stack : ''
    };
  }

  function postWorkspaceFileResponse(requestId, payload) {
    const targetWindow = sandboxFrame?.contentWindow || null;
    if (!targetWindow || !requestId) return;
    try {
      targetWindow.postMessage({
        [SANDBOX_MESSAGE_FLAG]: true,
        type: 'workspace_file_response',
        requestId,
        payload
      }, '*');
    } catch (_) {}
  }

  function addUniquePath(targetSet, value) {
    const text = (typeof value === 'string') ? value.trim() : '';
    if (text) targetSet.add(text);
  }

  function collectWorkspaceFileChangeSummary(summary, operation, result) {
    if (!summary) return;
    summary.operationsCount += 1;
    const normalizedOperation = (typeof operation === 'string' && operation.trim())
      ? operation.trim()
      : 'unknown';
    summary.operationCounts[normalizedOperation] = Number(summary.operationCounts[normalizedOperation] || 0) + 1;

    const affected = (result?.affected_files && typeof result.affected_files === 'object')
      ? result.affected_files
      : {};
    (Array.isArray(affected.added) ? affected.added : []).forEach((path) => addUniquePath(summary.affectedFiles.added, path));
    (Array.isArray(affected.modified) ? affected.modified : []).forEach((path) => addUniquePath(summary.affectedFiles.modified, path));
    (Array.isArray(affected.deleted) ? affected.deleted : []).forEach((path) => addUniquePath(summary.affectedFiles.deleted, path));

    const changeEvent = (result?.change_event && typeof result.change_event === 'object')
      ? result.change_event
      : {};
    (Array.isArray(changeEvent.updated_paths) ? changeEvent.updated_paths : []).forEach((path) => addUniquePath(summary.updatedPaths, path));
    (Array.isArray(changeEvent.deleted_paths) ? changeEvent.deleted_paths : []).forEach((path) => addUniquePath(summary.deletedPaths, path));
  }

  function buildWorkspaceFileSummary(summary) {
    if (!summary) return null;
    return {
      enabled: true,
      operations_count: summary.operationsCount,
      operation_counts: { ...summary.operationCounts },
      affected_files: {
        added: Array.from(summary.affectedFiles.added),
        modified: Array.from(summary.affectedFiles.modified),
        deleted: Array.from(summary.affectedFiles.deleted)
      },
      updated_paths: Array.from(summary.updatedPaths),
      deleted_paths: Array.from(summary.deletedPaths)
    };
  }

  async function handleWorkspaceFileRequest(data) {
    const requestId = (typeof data?.requestId === 'string') ? data.requestId : '';
    const executionRequestId = (typeof data?.executionRequestId === 'string') ? data.executionRequestId : '';
    const operation = (typeof data?.operation === 'string') ? data.operation.trim() : '';
    const pending = pendingRequests.get(executionRequestId);

    try {
      if (!requestId) {
        throw new Error('workspace file request 缺少 requestId。');
      }
      if (!pending || pending.workspaceFiles !== true) {
        throw new Error('当前 JS Runtime 调用未启用 workspace_files，不能访问 files API。');
      }
      if (typeof pending.handleWorkspaceFileRequest !== 'function') {
        throw new Error('当前客户端没有可用的 workspace 文件桥接入口。');
      }
      if (!operation) {
        throw new Error('files API 请求缺少 operation。');
      }

      const result = await pending.handleWorkspaceFileRequest({
        operation,
        args: data?.args
      });
      collectWorkspaceFileChangeSummary(pending.workspaceFileSummary, operation, result);
      postWorkspaceFileResponse(requestId, {
        ok: true,
        result
      });
    } catch (error) {
      postWorkspaceFileResponse(requestId, {
        ok: false,
        error: normalizeWorkspaceFileBridgeError(error)
      });
    }
  }

  function settleSandboxReadyAsError(error) {
    if (typeof rejectSandboxReady === 'function') {
      rejectSandboxReady(error);
    }
    resolveSandboxReady = null;
    rejectSandboxReady = null;
    if (readyTimeoutId) {
      clearTimeout(readyTimeoutId);
      readyTimeoutId = null;
    }
  }

  function settleSandboxReadyAsSuccess() {
    if (typeof resolveSandboxReady === 'function') {
      resolveSandboxReady(true);
    }
    resolveSandboxReady = null;
    rejectSandboxReady = null;
    if (readyTimeoutId) {
      clearTimeout(readyTimeoutId);
      readyTimeoutId = null;
    }
  }

  function ensureMessageListener() {
    if (messageListenerBound) return;
    ownerWindow.addEventListener('message', (event) => {
      if (!sandboxFrame || event.source !== sandboxFrame.contentWindow) return;
      const data = event.data || {};
      if (data?.[SANDBOX_MESSAGE_FLAG] !== true) return;

      if (data.type === 'ready') {
        settleSandboxReadyAsSuccess();
        return;
      }

      if (data.type === 'execute_result') {
        const requestId = (typeof data.requestId === 'string') ? data.requestId : '';
        const pending = pendingRequests.get(requestId);
        if (!pending) return;
        pendingRequests.delete(requestId);
        const payload = data.payload || {
          ok: false,
          value: null,
          items: [],
          error: {
            name: 'SandboxProtocolError',
            message: 'JS Sandbox 返回了空 payload。',
            stack: ''
          }
        };
        if (pending.workspaceFiles === true && payload && typeof payload === 'object' && !Array.isArray(payload)) {
          payload.workspace_files = buildWorkspaceFileSummary(pending.workspaceFileSummary);
        }
        pending.resolve(payload);
        return;
      }

      if (data.type === 'workspace_file_request') {
        handleWorkspaceFileRequest(data);
      }
    });
    messageListenerBound = true;
  }

  function createSandboxFrame() {
    const iframe = ownerDocument.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.src = sandboxFrameUrl;
    iframe.className = 'cerebr-js-sandbox-frame';
    Object.assign(iframe.style, {
      position: 'fixed',
      width: '0',
      height: '0',
      opacity: '0',
      pointerEvents: 'none',
      border: '0',
      inset: '0',
      zIndex: '-1'
    });
    iframe.addEventListener('error', () => {
      settleSandboxReadyAsError(new Error('加载 JS 沙箱 iframe 失败。'));
    }, { once: true });
    return iframe;
  }

  function ensureSandboxFrameMounted() {
    if (sandboxFrame && sandboxFrame.isConnected) return sandboxFrame;

    sandboxFrame = createSandboxFrame();
    sandboxReadyPromise = new Promise((resolve, reject) => {
      resolveSandboxReady = resolve;
      rejectSandboxReady = reject;
      readyTimeoutId = ownerWindow.setTimeout(() => {
        settleSandboxReadyAsError(new Error('等待 JS 沙箱就绪超时。'));
      }, SANDBOX_READY_TIMEOUT_MS);
    });

    const mountTarget = ownerDocument.body || ownerDocument.documentElement;
    if (!mountTarget) {
      settleSandboxReadyAsError(new Error('当前文档尚未准备好挂载 JS 沙箱 iframe。'));
      throw new Error('当前文档尚未准备好挂载 JS 沙箱 iframe。');
    }
    mountTarget.appendChild(sandboxFrame);
    return sandboxFrame;
  }

  async function ensureSandboxReady() {
    ensureMessageListener();
    ensureSandboxFrameMounted();
    await sandboxReadyPromise;
    return sandboxFrame;
  }

  async function getAvailability() {
    return {
      available: true,
      hasUserScriptsApi: false,
      hasExecute: true,
      environment: 'sandbox_iframe',
      reason: ''
    };
  }

  async function listFrames() {
    await ensureSandboxReady();
    return {
      ok: true,
      frames: [buildJsSandboxFrameSnapshot(sandboxFrameUrl)]
    };
  }

  async function execute(request = {}) {
    const code = (typeof request?.code === 'string') ? request.code : '';
    const timeoutMs = (() => {
      const raw = Number(request?.timeoutMs);
      return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0;
    })();
    const workspaceFiles = request?.workspaceFiles === true;
    if (!code.trim()) {
      throw new Error('执行隔离 JS Sandbox 失败：代码内容为空。');
    }

    const iframe = await ensureSandboxReady();
    const targetWindow = iframe?.contentWindow || null;
    if (!targetWindow) {
      throw new Error('执行隔离 JS Sandbox 失败：未获取到 sandbox 窗口。');
    }

    requestSeq += 1;
    const requestId = `sandbox_${Date.now()}_${requestSeq}`;

    const abortExecution = () => {
      try {
        targetWindow.postMessage({
          [SANDBOX_MESSAGE_FLAG]: true,
          type: 'abort',
          requestId
        }, '*');
      } catch (_) {}
    };

    return await new Promise((resolve, reject) => {
      let timeoutId = null;
      let abortListener = null;
      const cleanup = () => {
        if (timeoutId) ownerWindow.clearTimeout(timeoutId);
        if (abortListener) {
          try { request?.signal?.removeEventListener?.('abort', abortListener); } catch (_) {}
        }
        pendingRequests.delete(requestId);
      };
      pendingRequests.set(requestId, {
        workspaceFiles,
        handleWorkspaceFileRequest: typeof request?.handleWorkspaceFileRequest === 'function'
          ? request.handleWorkspaceFileRequest
          : null,
        workspaceFileSummary: workspaceFiles
          ? {
              operationsCount: 0,
              operationCounts: {},
              affectedFiles: {
                added: new Set(),
                modified: new Set(),
                deleted: new Set()
              },
              updatedPaths: new Set(),
              deletedPaths: new Set()
            }
          : null,
        resolve: (payload) => {
          cleanup();
          resolve(payload);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        }
      });
      if (timeoutMs > 0) {
        timeoutId = ownerWindow.setTimeout(() => {
          cleanup();
          abortExecution();
          reject(new Error(`执行隔离 JS Sandbox 超时（${timeoutMs}ms）。`));
        }, timeoutMs);
      }
      if (request?.signal) {
        abortListener = () => {
          cleanup();
          abortExecution();
          reject(createSandboxAbortError());
        };
        if (request.signal.aborted) {
          abortListener();
          return;
        }
        try { request.signal.addEventListener?.('abort', abortListener, { once: true }); } catch (_) {}
      }
      try {
        targetWindow.postMessage({
          [SANDBOX_MESSAGE_FLAG]: true,
          type: 'execute',
          requestId,
          code,
          workspaceFiles
        }, '*');
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  return {
    getAvailability,
    listFrames,
    execute
  };
}
