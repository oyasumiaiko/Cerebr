console.log('Cerebr content script loaded at:', new Date().toISOString());
console.log('Window location:', window.location.href);
console.log('Document readyState:', document.readyState);

// 全局变量，用于存储当前选中的文本（网页 + 侧栏）
let currentSelection = "";
// 存储已附加监听器的 iframe 窗口，防止重复操作
const monitoredFrames = new WeakSet();

const JS_RUNTIME_RUNNER_MESSAGE_FLAG = '__cerebrJsRuntimeRunner';
const JS_RUNTIME_RUNNER_READY_TIMEOUT_MS = 10000;
const JS_RUNTIME_RUNNER_WATCHDOG_GRACE_MS = 1500;
const JS_RUNTIME_RUNNER_DEFAULT_TIMEOUT_MS = 5000;
const JS_RUNTIME_RUNNER_ALLOWED_MESSAGE_TYPES = new Set([
    'GET_JS_RUNTIME_STATUS',
    'GET_JS_RUNTIME_FRAMES',
    'EXECUTE_JS_RUNTIME',
    'ABORT_JS_RUNTIME'
]);

function createOpaqueChannelId(prefix) {
    try {
        if (typeof crypto?.randomUUID === 'function') {
            return `${prefix}_${crypto.randomUUID()}`;
        }
    } catch (_) {}
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

function buildSidebarFrameUrl(instanceId, isPrimary, bridgeChannelId) {
    const safeInstanceId = (typeof instanceId === 'string' && instanceId.trim())
        ? instanceId.trim()
        : `sidebar_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const safeBridgeChannelId = (typeof bridgeChannelId === 'string' && bridgeChannelId.trim())
        ? bridgeChannelId.trim()
        : createOpaqueChannelId('sidebar_bridge');
    return chrome.runtime.getURL(
        `src/ui/sidebar/sidebar.html?instanceId=${encodeURIComponent(safeInstanceId)}&isPrimary=${isPrimary ? '1' : '0'}&bridgeChannelId=${encodeURIComponent(safeBridgeChannelId)}`
    );
}

function buildJsRuntimeRunnerFrameUrl(generation, channelId) {
    return chrome.runtime.getURL(
        `src/ui/js_runtime_runner/js_runtime_runner.html?generation=${encodeURIComponent(String(generation))}&channelId=${encodeURIComponent(channelId)}`
    );
}

/**
 * 在宿主页中维护一个可牺牲的隐藏 JS Runtime runner iframe。
 *
 * runner 直接通过 chrome.userScripts.execute() 把用户代码注入宿主页，避免长任务把
 * MV3 service worker 的单次消息事件悬挂数分钟；现有 DOM 能力与 frame_ids 语义不变。
 * runner 失联时直接替换该 iframe，侧栏对话与 UI 状态不会被销毁。
 */
class CerebrJsRuntimeRunner {
    constructor(options = {}) {
        this.resolveSidebarById = typeof options?.resolveSidebarById === 'function'
            ? options.resolveSidebarById
            : () => null;
        this.container = null;
        this.shadowRoot = null;
        this.iframe = null;
        this.messagePort = null;
        this.generation = 0;
        this.channelId = '';
        this.readyPromise = null;
        this.resolveReady = null;
        this.rejectReady = null;
        this.readyTimeoutId = null;
        this.pendingRequests = new Map();
    }

    clearReadyState() {
        if (this.readyTimeoutId) {
            clearTimeout(this.readyTimeoutId);
            this.readyTimeoutId = null;
        }
        this.readyPromise = null;
        this.resolveReady = null;
        this.rejectReady = null;
    }

    settleReadySuccess() {
        const resolve = this.resolveReady;
        this.clearReadyState();
        resolve?.(true);
    }

    settleReadyError(error) {
        const reject = this.rejectReady;
        this.clearReadyState();
        reject?.(error);
    }

    createFrame() {
        this.generation += 1;
        const generation = this.generation;
        this.channelId = createOpaqueChannelId('js_runtime_runner');

        const container = document.createElement('cerebr-js-runtime-root');
        container.dataset.cerebrJsRuntimeRunner = 'true';
        Object.assign(container.style, {
            position: 'fixed',
            width: '0',
            height: '0',
            overflow: 'hidden',
            pointerEvents: 'none',
            opacity: '0'
        });
        const shadow = container.attachShadow({ mode: 'closed' });
        const iframe = document.createElement('iframe');
        iframe.className = 'cerebr-js-runtime-runner__iframe';
        iframe.dataset.cerebrJsRuntimeRunner = 'true';
        iframe.setAttribute('aria-hidden', 'true');
        iframe.tabIndex = -1;
        iframe.src = buildJsRuntimeRunnerFrameUrl(this.generation, this.channelId);
        Object.assign(iframe.style, {
            width: '0',
            height: '0',
            border: '0',
            visibility: 'hidden'
        });
        iframe.addEventListener('error', () => {
            if (generation !== this.generation || iframe !== this.iframe) return;
            this.reset(new Error('隐藏 JS Runtime runner iframe 加载失败。'), { recreate: true });
        }, { once: true });
        iframe.addEventListener('load', () => {
            if (generation !== this.generation || iframe !== this.iframe) return;
            const channel = new MessageChannel();
            this.messagePort?.close?.();
            this.messagePort = channel.port1;
            this.messagePort.onmessage = (event) => this.handlePortMessage(event?.data);
            this.messagePort.start?.();
            iframe.contentWindow?.postMessage({
                [JS_RUNTIME_RUNNER_MESSAGE_FLAG]: true,
                type: 'connect',
                generation,
                channelId: this.channelId
            }, '*', [channel.port2]);
        }, { once: true });

        shadow.appendChild(iframe);
        (document.documentElement || document.body).appendChild(container);

        this.container = container;
        this.shadowRoot = shadow;
        this.iframe = iframe;
        this.readyPromise = new Promise((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
            this.readyTimeoutId = window.setTimeout(() => {
                this.reset(new Error('等待隐藏 JS Runtime runner 就绪超时。'));
            }, JS_RUNTIME_RUNNER_READY_TIMEOUT_MS);
        });
        return iframe;
    }

    ensureReady() {
        if (!this.iframe?.isConnected || !this.container?.isConnected) {
            this.createFrame();
        }
        return this.readyPromise || Promise.resolve(true);
    }

    postResponseToSidebar(sidebarInstanceId, requestId, response) {
        const sidebar = this.resolveSidebarById(sidebarInstanceId);
        if (!sidebar) return;
        sidebar.postToIframe({
            [JS_RUNTIME_RUNNER_MESSAGE_FLAG]: true,
            type: 'response',
            requestId,
            response
        });
    }

    rejectPendingRequests(error) {
        const message = error?.message || '隐藏 JS Runtime runner 已重建。';
        for (const [requestId, pending] of this.pendingRequests.entries()) {
            if (pending.timeoutId) clearTimeout(pending.timeoutId);
            this.postResponseToSidebar(pending.sidebarInstanceId, requestId, {
                success: false,
                error: message
            });
        }
        this.pendingRequests.clear();
    }

    reset(error = new Error('隐藏 JS Runtime runner 已重建。'), options = {}) {
        this.rejectPendingRequests(error);
        this.settleReadyError(error);
        try { this.container?.remove?.(); } catch (_) {}
        try { this.messagePort?.close?.(); } catch (_) {}
        this.container = null;
        this.shadowRoot = null;
        this.iframe = null;
        this.messagePort = null;
        this.channelId = '';
        if (options?.recreate === true) {
            queueMicrotask(() => {
                if (this.iframe || this.container) return;
                this.ensureReady().catch(() => null);
            });
        }
    }

    async forwardRequest(sidebar, data = {}) {
        const requestId = typeof data?.requestId === 'string' ? data.requestId.trim() : '';
        const runtimeMessage = data?.runtimeMessage;
        const runtimeMessageType = typeof runtimeMessage?.type === 'string' ? runtimeMessage.type : '';
        if (!sidebar || !requestId || data?.bridgeChannelId !== sidebar.bridgeChannelId) return;
        if (!JS_RUNTIME_RUNNER_ALLOWED_MESSAGE_TYPES.has(runtimeMessageType)) {
            this.postResponseToSidebar(sidebar.instanceId, requestId, {
                success: false,
                error: '不支持的 JS Runtime runner 请求。'
            });
            return;
        }
        if (
            (this.iframe && !this.iframe.isConnected)
            || (this.container && !this.container.isConnected)
        ) {
            this.reset(new Error('隐藏 JS Runtime runner 已从宿主页分离。'));
        }

        const requestedTimeoutMs = Number(data?.timeoutMs);
        const timeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
            ? Math.trunc(requestedTimeoutMs) + JS_RUNTIME_RUNNER_WATCHDOG_GRACE_MS
            : JS_RUNTIME_RUNNER_DEFAULT_TIMEOUT_MS + JS_RUNTIME_RUNNER_WATCHDOG_GRACE_MS;
        const generation = this.generation + ((!this.iframe?.isConnected || !this.container?.isConnected) ? 1 : 0);
        const timeoutId = window.setTimeout(() => {
            if (generation !== this.generation) return;
            this.reset(new Error(`隐藏 JS Runtime runner 响应超时（${timeoutMs}ms）。`), { recreate: true });
        }, timeoutMs);
        this.pendingRequests.set(requestId, {
            sidebarInstanceId: sidebar.instanceId,
            timeoutId,
            generation
        });

        try {
            await this.ensureReady();
            const pending = this.pendingRequests.get(requestId);
            if (!pending || pending.generation !== this.generation) return;
            this.messagePort?.postMessage({
                [JS_RUNTIME_RUNNER_MESSAGE_FLAG]: true,
                type: 'request',
                generation: this.generation,
                channelId: this.channelId,
                requestId,
                runtimeMessage
            });
        } catch (error) {
            if (this.pendingRequests.has(requestId)) {
                this.reset(error);
            }
        }
    }

    handlePortMessage(data = {}) {
        if (data?.[JS_RUNTIME_RUNNER_MESSAGE_FLAG] !== true) return;
        if (data.generation !== this.generation || data.channelId !== this.channelId) return;

        if (data.type === 'ready') {
            this.settleReadySuccess();
            return;
        }
        if (data.type !== 'response') return;

        const requestId = typeof data.requestId === 'string' ? data.requestId : '';
        const pending = this.pendingRequests.get(requestId);
        if (!pending || pending.generation !== this.generation) return;
        if (pending.timeoutId) clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(requestId);
        this.postResponseToSidebar(pending.sidebarInstanceId, requestId, data.response);
    }
}

// 统一的 sync 写入入口：优先走写入队列，避免高频触发配额
const storageWriteQueue = globalThis.CerebrStorageWriteQueue || null;
function queueSyncSet(payload) {
    if (storageWriteQueue?.set) {
        storageWriteQueue.set('sync', payload);
        return;
    }
    try {
        chrome.storage.sync.set(payload);
    } catch (error) {
        console.warn('sync 写入失败（已忽略）：', error);
    }
}

/**
 * 统一的选区变化处理函数
 * 当任何地方的选区发生变化时被调用
 */
function handleGlobalSelectionChange() {
    setTimeout(() => {
        let activeSelectionText = "";
        let activeSelectionSource = "main"; // 默认来源是主窗口

        // 1. 遍历页面上所有 iframe，检查它们的选区
        document.querySelectorAll('iframe').forEach(iframe => {
            // 精准排除您自己的侧边栏 iframe
            if (iframe.classList.contains('cerebr-sidebar__iframe')) {
                return; // 跳过
            }

            try {
                const iframeWindow = iframe.contentWindow;
                if (iframeWindow) {
                    const iframeSelection = iframeWindow.getSelection();
                    if (iframeSelection && !iframeSelection.isCollapsed) {
                        const text = iframeSelection.toString().trim();
                        if (text) {
                            activeSelectionText = text;
                            activeSelectionSource = iframe.src || "iframe"; // 记录来源
                        }
                    }
                }
            } catch (e) {
                // 忽略跨域等错误
            }
        });

        // 2. 如果所有 iframe 内都没有选区，再检查主窗口的选区
        if (!activeSelectionText) {
            try {
                const mainSelection = window.getSelection();
                if (mainSelection && !mainSelection.isCollapsed) {
                    activeSelectionText = mainSelection.toString().trim();
                    activeSelectionSource = "main";
                }
            } catch (e) {
                // 忽略错误
            }
        }
        
        // 3. 只有在文本内容确实发生变化时才更新状态并打印日志
        if (activeSelectionText !== currentSelection) {
            currentSelection = activeSelectionText;
            // console.log(`[Cerebr Selection] Updated from "${activeSelectionSource}":`, `"${currentSelection}"`);
            
            // 在这里可以触发您插件的其他逻辑，例如：
            // if (currentSelection) {
            //   showMyPopup(currentSelection);
            // } else {
            //   hideMyPopup();
            // }
        }
    }, 0);
}

/**
 * 扫描并为新出现的 iframe 附加监听器
 */
function monitorNewFrames() {
  document.querySelectorAll('iframe').forEach(iframe => {
      // 排除您自己的侧边栏 iframe
      if (iframe.classList.contains('cerebr-sidebar__iframe')) {
          return;
      }

      try {
          const iframeWindow = iframe.contentWindow;
          // 确保 iframe 可访问且尚未被监控
          if (iframeWindow && !monitoredFrames.has(iframeWindow)) {
              console.log('[Cerebr Selection] New generic iframe found, attaching listener to:', iframe.src || 'inline frame');
              monitoredFrames.add(iframeWindow);
              // 为 iframe 内部的 document 附加监听器
              iframeWindow.document.addEventListener('selectionchange', handleGlobalSelectionChange);
          }
      } catch (e) {
          // 忽略因跨域策略而无法访问的 iframe
      }
  });
}

/**
 * 规范化 pathname，避免“尾部斜杠差异”导致的同页误判。
 * @param {string} pathname
 * @returns {string}
 */
function normalizePathname(pathname) {
  if (typeof pathname !== 'string' || !pathname) return '/';
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

/**
 * 从 text fragment 中提取用于定位的文本（取 text= 的第一个主片段）。
 * 只覆盖最常见的形态：#:~:text=片段
 * @param {string} fragment - URL hash（包含 #）
 * @returns {string}
 */
function extractTextFragmentTarget(fragment) {
  if (typeof fragment !== 'string' || !fragment.includes(':~:text=')) return '';
  const match = fragment.match(/:~:text=([^&]+)/i);
  if (!match || !match[1]) return '';
  const raw = match[1].replace(/\+/g, '%20');
  let decoded = '';
  try {
    decoded = decodeURIComponent(raw);
  } catch (_) {
    decoded = raw;
  }
  const parts = decoded.split(',');
  for (const part of parts) {
    const trimmed = (part || '').trim();
    if (!trimmed) continue;
    const isPrefix = trimmed.endsWith('-');
    const isSuffix = trimmed.startsWith('-');
    if (!isPrefix && !isSuffix) {
      return trimmed;
    }
  }
  return (decoded || '').trim();
}

/**
 * 尝试在页面内定位 text fragment。
 * @param {string} fragment - URL hash（包含 #）
 * @returns {boolean} 是否找到并定位到目标文本
 */
function scrollToTextFragment(fragment) {
  const targetText = extractTextFragmentTarget(fragment);
  if (!targetText) return false;

  try {
    window.getSelection?.()?.removeAllRanges?.();
  } catch (_) {}

  try {
    window.scrollTo(0, 0);
  } catch (_) {}

  let found = false;
  try {
    found = window.find(targetText, false, false, true, false, false, false);
  } catch (_) {
    found = false;
  }
  return !!found;
}

/**
 * 尝试根据 hash 定位到页面内锚点。
 * @param {string} hash - URL hash（包含 #）
 * @returns {boolean} 是否找到并定位到锚点
 */
function scrollToHashAnchor(hash) {
  if (typeof hash !== 'string') return false;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return false;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch (_) {}

  let target = document.getElementById(decoded);
  if (!target) {
    const safe = (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
      ? CSS.escape(decoded)
      : decoded.replace(/["\\]/g, '\\$&');
    target = document.querySelector(`[name="${safe}"]`);
  }

  if (!target) return false;
  try {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (_) {
    target.scrollIntoView(true);
  }
  return true;
}

/**
 * 处理来自侧栏的“同页 Markdown 链接”打开请求。
 * @param {string} url
 */
function openMarkdownLinkInPage(url) {
  if (typeof url !== 'string' || !url.trim()) return;
  let resolved = null;
  let current = null;
  try {
    resolved = new URL(url, window.location.href);
    current = new URL(window.location.href);
  } catch (_) {
    return;
  }

  const sameOrigin = resolved.origin === current.origin;
  const samePath = normalizePathname(resolved.pathname) === normalizePathname(current.pathname);

  if (!sameOrigin || !samePath) {
    window.location.href = resolved.href;
    return;
  }

  const hash = resolved.hash || '';
  const hasTextFragment = hash.includes(':~:text=');

  if (hasTextFragment) {
    const handled = scrollToTextFragment(hash);
    try {
      history.replaceState(null, '', resolved.href);
    } catch (_) {}
    if (handled) return;
    // 若未命中，强制一次顶层导航，触发浏览器原生 text fragment 解析
    window.location.href = resolved.href;
    return;
  }

  if (hash) {
    const handled = scrollToHashAnchor(hash);
    try {
      history.replaceState(null, '', resolved.href);
    } catch (_) {}
    if (!handled) {
      return;
    }
    return;
  }

  // 无 hash 的同页链接（如 ?t= 这种时间跳转），交给浏览器正常导航
  window.location.href = resolved.href;
}

class CerebrSidebar {
  constructor(options = {}) {
    this.manager = options?.manager || null;
    this.instanceId = (typeof options?.instanceId === 'string' && options.instanceId.trim())
      ? options.instanceId.trim()
      : `sidebar_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.bridgeChannelId = createOpaqueChannelId('sidebar_bridge');
    this.isPrimary = options?.isPrimary === true;
    this.stackOffsetPx = 0;
    this.readyPromise = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
    this.isVisible = false;
    this.sidebarWidth = 800;  // 默认值改为800px
    this.scaleFactor = 1.0;
    this.initialized = false;
    this.lastUrl = window.location.href;
    this.isFullscreen = false;
    this.isDisposed = false;
    this.container = null;
    this.sidebarBridgePort = null;
    this.pendingBridgeMessages = [];
    this.restoreObserver = null;
    this.restoreTimeoutId = null;
    // 临时模式状态由父页面内存维护，用于 iframe 右键重载恢复，F5 刷新时自动重置。
    // 它现在不再控制“是否自动注入网页内容”，而是控制：
    // 1. 是否暴露宿主页增强工具；
    // 2. JS 工具默认连接宿主页，还是退回侧栏内部隔离沙箱。
    this.isTemporaryMode = false;
    // 宿主页侧维护 Alt 是否按下，用来把“父页面焦点下的修饰键状态”同步给 iframe。
    // 这样侧栏滚轮加速不再要求 iframe 自己先拿到键盘焦点，但我们仍不拦截宿主页原有 Alt 行为。
    this.isAltKeyPressed = false;
    this.isDocked = false;
    this.sidebarPosition = 'right'; // 默认侧边栏位置为右侧
    this.dockStyleElement = null;
    // console.log('CerebrSidebar 实例创建');
    this.initializeSidebar();
  }

  getIframe() {
    return this.sidebar?.querySelector('.cerebr-sidebar__iframe') || null;
  }

  postToIframe(message) {
    if (!this.sidebarBridgePort) {
      this.pendingBridgeMessages.push(message);
      return true;
    }
    this.sidebarBridgePort.postMessage(message);
    return true;
  }

  connectSidebarBridge() {
    const iframe = this.getIframe();
    if (!iframe?.contentWindow) return false;
    try { this.sidebarBridgePort?.close?.(); } catch (_) {}
    const channel = new MessageChannel();
    this.sidebarBridgePort = channel.port1;
    this.sidebarBridgePort.onmessage = (event) => {
      this.manager?.handleSidebarBridgeMessage?.(this, event?.data);
    };
    this.sidebarBridgePort.start?.();
    iframe.contentWindow.postMessage({
      [JS_RUNTIME_RUNNER_MESSAGE_FLAG]: true,
      type: 'connect_sidebar',
      bridgeChannelId: this.bridgeChannelId
    }, '*', [channel.port2]);
    this.pendingBridgeMessages.splice(0).forEach((message) => {
      this.sidebarBridgePort.postMessage(message);
    });
    return true;
  }

  reloadIframe() {
    const iframe = this.getIframe();
    if (!iframe) {
      return {
        success: false,
        instanceId: this.instanceId,
        error: 'Sidebar iframe not found'
      };
    }

    const frameUrl = iframe.src || buildSidebarFrameUrl(this.instanceId, this.isPrimary, this.bridgeChannelId);

    try {
      // 从宿主页侧直接重载 iframe，不依赖 iframe 内部 JS；即使侧栏页面脚本崩溃，
      // 父页面仍然可以像浏览器原生“重新加载框架”一样触发同一个 frame 导航。
      const frameLocation = iframe.contentWindow?.location;
      if (frameLocation && typeof frameLocation.reload === 'function') {
        frameLocation.reload();
      } else {
        iframe.src = frameUrl;
      }
    } catch (error) {
      console.warn('通过 contentWindow 重载侧栏 iframe 失败，改为重新设置 iframe src:', error);
      iframe.src = frameUrl;
    }

    return {
      success: true,
      instanceId: this.instanceId,
      src: frameUrl
    };
  }

  setStackOffsetPx(offsetPx) {
    const numeric = Number(offsetPx);
    const nextOffset = Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : 0;
    if (this.stackOffsetPx === nextOffset) return;
    this.stackOffsetPx = nextOffset;
    this.updatePosition(this.sidebarPosition, { persist: false });
  }

  // 添加统一的宽度更新方法
  updateWidth(width, options = {}) {
    const shouldPersist = options?.persist !== false;
    this.sidebarWidth = width;
    this.sidebar.style.width = `calc(${this.sidebarWidth}px * var(--scale-ratio, 1) / ${this.scaleFactor})`;
    if (shouldPersist) {
      queueSyncSet({ sidebarWidth: this.sidebarWidth });
    }
    this.updateDockLayout();
  }

  getSidebarResizeScale() {
    const dpr = Number(window.devicePixelRatio);
    const safeDpr = (Number.isFinite(dpr) && dpr > 0) ? dpr : 1;
    const scale = this.scaleFactor / safeDpr;
    return (Number.isFinite(scale) && scale > 0) ? scale : 1;
  }

  resolveSidebarWidthFromPointerDelta(startWidth, pointerDelta) {
    const numericStartWidth = Number(startWidth);
    const safeStartWidth = Number.isFinite(numericStartWidth) ? numericStartWidth : this.sidebarWidth;
    const numericDelta = Number(pointerDelta);
    const safeDelta = Number.isFinite(numericDelta) ? numericDelta : 0;
    const nextWidth = safeStartWidth + safeDelta / this.getSidebarResizeScale();
    return Math.min(Math.max(500, nextWidth), 2000);
  }

  // 添加更新侧边栏位置的方法
  updatePosition(position, options = {}) {
    const shouldPersist = options?.persist !== false;
    this.sidebarPosition = position;
    if (!this.sidebar) return; // 确保sidebar已经创建
    if (this.isFullscreen) return; // 全屏模式不改变位置

    const style = this.sidebar.style;
    // 移除两侧的定位
    style.left = '';
    style.right = '';
    const baseOffset = this.isDocked ? '0px' : 'calc(10px * var(--scale-ratio, 1))';
    const instanceOffset = this.stackOffsetPx > 0 ? `${this.stackOffsetPx}px` : '0px';
    const offset = this.isDocked ? '0px' : `calc(${baseOffset} + ${instanceOffset})`;
    const hiddenOffset = this.isDocked ? '0px' : 'calc(10px * var(--scale-ratio, 1))';
    
    // 设置新的定位和变换
    if (position === 'left') {
      this.sidebar.classList.add('position-left');
      this.sidebar.classList.remove('position-right');
      style.left = offset;
      // 更新进入和退出动画的变换
      this.sidebar.style.setProperty('--transform-hidden', `translateX(calc(-100% - ${hiddenOffset}))`);
      this.sidebar.style.setProperty('--box-shadow-visible', this.isDocked ? 'none' : `2px 0 15px rgba(0,0,0,0.1)`);
    } else {
      this.sidebar.classList.add('position-right');
      this.sidebar.classList.remove('position-left');
      style.right = offset;
      // 更新进入和退出动画的变换
      this.sidebar.style.setProperty('--transform-hidden', `translateX(calc(100% + ${hiddenOffset}))`);
      this.sidebar.style.setProperty('--box-shadow-visible', this.isDocked ? 'none' : `-2px 0 15px rgba(0,0,0,0.1)`);
    }
    
    // 如果侧边栏没有显示，立即应用隐藏的变换
    if (!this.isVisible) {
      this.sidebar.style.transform = `var(--transform-hidden)`;
    }

    if (shouldPersist) {
      queueSyncSet({ sidebarPosition: this.sidebarPosition });
    }
    this.updateDockLayout();
    
    // console.log(`侧边栏位置已更新为: ${position}, 可见状态: ${this.isVisible}`);
  }

  // 停靠模式：通过页面 padding 预留侧栏布局空间
  ensureDockStyle() {
    if (this.dockStyleElement) return;
    const existing = document.querySelector('style[data-cerebr-dock-style="true"]');
    if (existing) {
      this.dockStyleElement = existing;
      return;
    }
    const style = document.createElement('style');
    style.dataset.cerebrDockStyle = 'true';
    style.textContent = `
      html.cerebr-dock-mode {
        overflow-x: hidden !important;
      }
      html.cerebr-dock-mode,
      html.cerebr-dock-mode body {
        box-sizing: border-box !important;
      }
      html.cerebr-dock-mode body {
        width: 100% !important;
      }
      html.cerebr-dock-mode[data-cerebr-dock-position="right"] body {
        padding-right: var(--cerebr-dock-width, 0px) !important;
      }
      html.cerebr-dock-mode[data-cerebr-dock-position="left"] body {
        padding-left: var(--cerebr-dock-width, 0px) !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
    this.dockStyleElement = style;
  }

  getDockWidth() {
    const dpr = Number(window.devicePixelRatio);
    const safeDpr = (Number.isFinite(dpr) && dpr > 0) ? dpr : 1;
    let width = this.sidebarWidth / safeDpr;
    if (this.sidebar) {
      const rect = this.sidebar.getBoundingClientRect();
      if (rect && rect.width > 0) {
        width = rect.width;
      }
    }
    return Math.max(0, Math.round(width));
  }

  applyDockLayout() {
    if (!this.sidebar) return;
    this.ensureDockStyle();
    const root = document.documentElement;
    if (!root) return;
    root.classList.add('cerebr-dock-mode');
    root.dataset.cerebrDockPosition = this.sidebarPosition === 'left' ? 'left' : 'right';
    root.style.setProperty('--cerebr-dock-width', `${this.getDockWidth()}px`);
  }

  clearDockLayout() {
    const root = document.documentElement;
    if (!root) return;
    root.classList.remove('cerebr-dock-mode');
    root.removeAttribute('data-cerebr-dock-position');
    root.style.removeProperty('--cerebr-dock-width');
  }

  updateDockLayout() {
    if (!this.isDocked || this.isFullscreen || !this.isVisible) return;
    this.applyDockLayout();
  }

  /**
   * 返回用于自动化 smoke / 调试的侧栏可见性快照。
   *
   * 设计说明：
   * - 侧栏宿主放在 closed shadow root 中，普通页面脚本与外部自动化很难直接检查真实可见态；
   * - 但我们做端到端验证时，不能只靠“iframe 存在且内部 input 可访问”就判定通过，
   *   否则 display:none / opacity:0 / 未进入 visible 状态时，脚本仍可能误操作成功；
   * - 因此这里集中给出一份只读诊断快照，专门服务于自动化与问题定位，
   *   避免把测试逻辑建立在脆弱的 DOM 猜测上。
   *
   * 注意：
   * - 这是显式的调试接口，不用于产品逻辑分支；
   * - 只暴露简单的可见性/布局状态，不泄露任何页面敏感数据。
   *
   * @returns {Object}
   */
  getDebugState() {
    if (!this.sidebar) {
      return {
        initialized: !!this.initialized,
        exists: false,
        isVisible: !!this.isVisible,
        isActuallyVisible: false
      };
    }

    const computedStyle = window.getComputedStyle(this.sidebar);
    const rect = this.sidebar.getBoundingClientRect();
    const inlineDisplay = (typeof this.sidebar.style?.display === 'string')
      ? this.sidebar.style.display
      : '';
    const inlineTransform = (typeof this.sidebar.style?.transform === 'string')
      ? this.sidebar.style.transform
      : '';
    const hasVisibleClass = this.sidebar.classList.contains('visible');
    const hasIframe = !!this.sidebar.querySelector('.cerebr-sidebar__iframe');
    const computedOpacity = Number.parseFloat(computedStyle.opacity || '0');
    const isActuallyVisible = !!(
      this.isVisible
      && hasVisibleClass
      && inlineDisplay !== 'none'
      && computedStyle.display !== 'none'
      && computedStyle.visibility !== 'hidden'
      && computedOpacity > 0
      && rect.width > 0
      && rect.height > 0
    );

    return {
      initialized: !!this.initialized,
      exists: true,
      isVisible: !!this.isVisible,
      isActuallyVisible,
      isFullscreen: !!this.isFullscreen,
      isDocked: !!this.isDocked,
      sidebarPosition: this.sidebarPosition || 'right',
      stackOffsetPx: this.stackOffsetPx,
      sidebarWidth: Math.round(Number(this.sidebarWidth) || 0),
      fullscreenSplitIndex: Number.isFinite(Number(this.sidebar.dataset.cerebrFullscreenSplitIndex))
        ? Number(this.sidebar.dataset.cerebrFullscreenSplitIndex)
        : null,
      fullscreenSplitRatio: Number.isFinite(Number(this.sidebar.dataset.cerebrFullscreenSplitRatio))
        ? Number(this.sidebar.dataset.cerebrFullscreenSplitRatio)
        : null,
      hasFullscreenDivider: this.sidebar.classList.contains('has-fullscreen-divider'),
      hasLegacyResizer: !!this.sidebar.querySelector('.cerebr-sidebar__resizer'),
      hasVisibleClass,
      hasIframe,
      inlineDisplay,
      inlineTransform,
      computedDisplay: computedStyle.display,
      computedVisibility: computedStyle.visibility,
      computedOpacity: computedStyle.opacity,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  }

  setDockMode(isDocked) {
    const next = !!isDocked;
    if (this.isDocked === next) {
      this.updateDockLayout();
      this.notifyIframeDockModeState();
      return;
    }
    this.isDocked = next;
    if (this.sidebar) {
      this.sidebar.classList.toggle('docked', this.isDocked && !this.isFullscreen);
    }
    if (this.isDocked && !this.isFullscreen && this.isVisible) {
      this.applyDockLayout();
    } else {
      this.clearDockLayout();
    }
    if (!this.isFullscreen) {
      this.updatePosition(this.sidebarPosition);
    }
    this.manager?.layoutSidebars?.();
    this.notifyIframeDockModeState();
  }

  async initializeSidebar() {
    try {
      // console.log('开始初始化侧边栏');

      // 从存储中加载宽度、缩放因子和位置
      const result = await chrome.storage.sync.get(['sidebarWidth', 'scaleFactor', 'sidebarPosition']);
      this.sidebarWidth = result.sidebarWidth || 800; // 确保默认值一致
      this.scaleFactor = result.scaleFactor || 1.0;
      this.sidebarPosition = result.sidebarPosition || 'right';
      
      // console.log(`初始化侧边栏: 宽度=${this.sidebarWidth}, 缩放=${this.scaleFactor}, 位置=${this.sidebarPosition}`);

      const container = document.createElement('cerebr-root');
      this.container = container;
      container.dataset.cerebrSidebarInstanceId = this.instanceId;
      container.style.display = 'contents'; // 让容器内元素透出

      // 防止外部JavaScript访问和修改我们的元素
      Object.defineProperty(container, 'remove', {
        configurable: false,
        writable: false,
        value: () => {
          console.log('阻止移除侧边栏');
          return false;
        }
      });

      // 使用closed模式的shadowRoot以增加隔离性
      const shadow = container.attachShadow({ mode: 'closed' });

      const style = document.createElement('style');
      style.textContent = `
        :host {
          all: initial;
          contain: style layout size;
        }
          
        .cerebr-sidebar {
          --transform-hidden: translateX(calc(100% + calc(20px * var(--scale-ratio, 1))));
          --box-shadow-visible: -2px 0 15px rgba(0,0,0,0.1);
          
          position: fixed;
          top: calc(10px * var(--scale-ratio, 1));
          width: calc(${this.sidebarWidth}px * var(--scale-ratio, 1) / ${this.scaleFactor});
          height: calc(100vh - calc(20px * var(--scale-ratio, 1)));
          color: var(--cerebr-text-color, #000000);
          z-index: 2147483647;
          border-radius: calc(12px * var(--scale-ratio, 1));
          overflow: hidden;
          visibility: hidden;
          opacity: 0;
          transform: var(--transform-hidden);
          pointer-events: none;
          isolation: isolate;
          /* border: 1px solid rgba(255, 255, 255, 0.1); */
          contain: layout style;
          /* Delay visibility toggle so content stays rendered throughout the slide animation */
          transition: transform 0.3s ease, box-shadow 0.3s ease, opacity 0.3s ease, visibility 0s linear 0.3s;
        }

        .cerebr-sidebar.visible {
          pointer-events: auto;
          visibility: visible;
          opacity: 1;
          transform: translateX(0) !important;
          box-shadow: var(--box-shadow-visible);
          transition: transform 0.3s ease, box-shadow 0.3s ease, opacity 0.3s ease, visibility 0s linear 0s;
        }

        .cerebr-sidebar.dragging {
          transition: none !important;
          opacity: 0.92;
        }

        .cerebr-sidebar.resizing {
          transition: none !important;
        }

        .cerebr-sidebar.fullscreen-split-resizing {
          transition: none !important;
        }

        .cerebr-sidebar__header {
          position: absolute;
          top: 0;
          left: 50%;
          transform: translateX(-50%);
          width: min(160px, calc(100% - 80px));
          height: 16px;
          z-index: 2;
          cursor: grab;
          pointer-events: auto;
        }

        .cerebr-sidebar__header::before {
          content: '';
          position: absolute;
          left: 50%;
          top: 5px;
          transform: translateX(-50%);
          width: 56px;
          height: 5px;
          border-radius: 999px;
          background: rgba(120, 120, 120, 0.36);
          opacity: 0;
          transition: opacity 0.16s ease, background 0.16s ease;
        }

        .cerebr-sidebar__header:hover::before,
        .cerebr-sidebar.dragging .cerebr-sidebar__header::before {
          opacity: 1;
          background: rgba(120, 120, 120, 0.62);
        }

        .cerebr-sidebar.dragging .cerebr-sidebar__header {
          cursor: grabbing;
        }

        .cerebr-sidebar__content {
          height: 100%;
          overflow: auto;
          border-radius: calc(12px * var(--scale-ratio, 1));
          position: relative;
          background: rgba(255, 255, 255, 0);
          backdrop-filter: none;
          -webkit-backdrop-filter: none;
          contain: layout style;
          pointer-events: auto;
        }
        .cerebr-sidebar__content {
          height: 100%;
          overflow: hidden;
          border-radius: 0;
          contain: style layout size;
        }

        .cerebr-sidebar.docked {
          top: 0;
          height: 100vh;
          border-radius: 0;
          box-shadow: none;
        }
        .cerebr-sidebar.docked.visible {
          box-shadow: none;
        }
        .cerebr-sidebar.docked .cerebr-sidebar__content {
          border-radius: 0;
        }

        .cerebr-sidebar__fullscreen-divider {
          position: absolute;
          top: 0;
          right: 0;
          bottom: 0;
          width: 14px;
          z-index: 4;
          display: none;
          cursor: col-resize;
          pointer-events: auto;
          opacity: 0;
          transition: opacity 0.16s ease;
        }

        .cerebr-sidebar__fullscreen-divider::before {
          content: '';
          position: absolute;
          top: 0;
          bottom: 0;
          right: 5px;
          width: 2px;
          background: rgba(120, 120, 120, 0.42);
        }

        .cerebr-sidebar.fullscreen.fullscreen-split.has-fullscreen-divider .cerebr-sidebar__fullscreen-divider {
          display: block;
        }

        .cerebr-sidebar.fullscreen.fullscreen-split.has-fullscreen-divider .cerebr-sidebar__fullscreen-divider:hover,
        .cerebr-sidebar.fullscreen.fullscreen-split-resizing .cerebr-sidebar__fullscreen-divider {
          opacity: 1;
        }

        .cerebr-sidebar.fullscreen {
          transition: all 0s !important;

          top: 0px;
          left: 0px !important;
          right: 0px !important;
          width: 100vw !important;
          height: 100vh;
          margin-right: 0;
          margin-left: 0;
          border-radius: 0;
          transform: translateX(0) !important;
        }
        .cerebr-sidebar.fullscreen.fullscreen-split {
          left: var(--cerebr-fullscreen-left, 0px) !important;
          right: auto !important;
          width: var(--cerebr-fullscreen-width, 100vw) !important;
        }
        .cerebr-sidebar.fullscreen.visible {
          transform: translateX(0) !important;
          box-shadow: none !important;
        }
        .cerebr-sidebar.fullscreen .cerebr-sidebar__header {
          display: none;
        }
        .cerebr-sidebar.fullscreen .cerebr-sidebar__content {
          border-radius: 0;
        }


        .cerebr-sidebar__iframe {
          width: 100%;
          height: 100%;
          border: none;
          background: transparent;
          position: relative;
          transform-origin: top left;
          box-sizing: border-box;
          /* 避免在深色宿主页面被强制套白底（Chrome 的“可读性”行为） */
          color-scheme: auto;
        }
      `;

      this.sidebar = document.createElement('div');
      this.sidebar.className = 'cerebr-sidebar';
      this.sidebar.dataset.cerebrSidebarInstanceId = this.instanceId;
      if (this.isDocked) {
        this.sidebar.classList.add('docked');
      }

      // 防止外部JavaScript访问和修改侧边栏
      Object.defineProperty(this.sidebar, 'remove', {
        configurable: false,
        writable: false,
        value: () => {
          console.log('阻止移除侧边栏');
          return false;
        }
      });

      const header = document.createElement('div');
      header.className = 'cerebr-sidebar__header';

      const fullscreenDivider = document.createElement('div');
      fullscreenDivider.className = 'cerebr-sidebar__fullscreen-divider';

      const content = document.createElement('div');
      content.className = 'cerebr-sidebar__content';

      const iframe = document.createElement('iframe');
      iframe.className = 'cerebr-sidebar__iframe';
      iframe.dataset.cerebrSidebarInstanceId = this.instanceId;
      iframe.src = buildSidebarFrameUrl(this.instanceId, this.isPrimary, this.bridgeChannelId);
      iframe.allow = 'clipboard-write; file-system-access; fullscreen';

      // 重要：当用户在 DevTools 中对 iframe 执行「重新加载框架」时，iframe 内部状态会被重置；
      // 但父页面仍持有全屏/临时模式状态，因此需要在 iframe 每次 load 完成后同步一次，
      // 以便右键重载时保留状态，同时在 F5 刷新页面时由父页面自动回到默认值。
      iframe.addEventListener('load', () => {
        try {
          this.connectSidebarBridge();
        } catch (e) {
          console.warn('连接隐藏 JS Runtime runner 通道失败（忽略）:', e);
        }
        try {
          this.notifyIframeFullscreenState(this.isFullscreen);
        } catch (e) {
          console.warn('同步 iframe 全屏状态失败（忽略）:', e);
        }
        try {
          this.notifyIframeDockModeState();
        } catch (e) {
          console.warn('同步 iframe 停靠状态失败（忽略）:', e);
        }
        try {
          this.notifyIframeTempModeState(this.isTemporaryMode);
        } catch (e) {
          console.warn('同步 iframe 临时模式状态失败（忽略）:', e);
        }
        try {
          this.notifyIframeAltKeyState(this.isAltKeyPressed);
        } catch (e) {
          console.warn('同步 iframe Alt 状态失败（忽略）:', e);
        }
        try {
          this.notifyIframeEmbedScale();
        } catch (e) {
          console.warn('同步 iframe 嵌入缩放失败（忽略）:', e);
        }
      });

      content.appendChild(iframe);
      this.sidebar.appendChild(header);
      this.sidebar.appendChild(fullscreenDivider);
      this.sidebar.appendChild(content);

      // 添加侧边栏到DOM
      shadow.appendChild(style);
      shadow.appendChild(this.sidebar);

      // 添加到文档并保护它
      const root = document.documentElement;
      root.appendChild(container);

      // 设置侧边栏位置 - 在添加到DOM之后设置
      this.updatePosition(this.sidebarPosition);

      // 初始化缩放设置：根据当前设备像素比和用户缩放因子计算一次
      this.updateScale();
      // 记录当前 DPR，用于后续检测浏览器缩放变化（Ctrl + / Ctrl -）
      this._lastDevicePixelRatio = window.devicePixelRatio || 1;
      // 当浏览器缩放比例变化时（通常会伴随 DPR 变化），重新应用一次缩放，保持侧栏视觉尺寸稳定
      window.addEventListener('resize', () => {
        try {
          const currentDpr = window.devicePixelRatio || 1;
          if (currentDpr === this._lastDevicePixelRatio) return;
          this._lastDevicePixelRatio = currentDpr;
          this.updateScale();
        } catch (e) {
          console.warn('更新侧边栏缩放时出错:', e);
        }
      });

      // 使用MutationObserver确保我们的元素不会被移除
      const scheduleRestore = () => {
        if (this.isDisposed || this.restoreTimeoutId) return;

        this.restoreTimeoutId = setTimeout(() => {
          this.restoreTimeoutId = null;
          if (this.isDisposed) return;

          if (!root.contains(container)) {
            console.log('检测到侧边栏被移除，正在恢复...');
            root.appendChild(container);
          }
        }, 500);
      };

      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'childList') {
            const removedNodes = Array.from(mutation.removedNodes);
            if (removedNodes.includes(container)) {
              scheduleRestore();
            }
          }
        }
      });

      observer.observe(root, {
        childList: true
      });
      this.restoreObserver = observer;

      // console.log('侧边栏已添加到文档');

      this.setupEventListeners(header, fullscreenDivider);

      // 使用 requestAnimationFrame 确保状态已经应用
      requestAnimationFrame(() => {
        this.sidebar.classList.add('initialized');
        this.initialized = true;
        this._resolveReady?.(this);
        // console.log('侧边栏初始化完成');
      });

      // 延迟发送 URL_CHANGED 消息，等待 iframe 加载完毕
      iframe.addEventListener('load', () => {
        this.postToIframe({
           type: 'URL_CHANGED',
           url: window.location.href,
           title: document.title,
           referrer: document.referrer,
           lastModified: document.lastModified,
           lang: document.documentElement.lang,
           charset: document.characterSet
        });
      });
    } catch (error) {
      console.error('初始化侧边栏失败:', error);
    }
  }

  setupEventListeners(header, fullscreenDivider) {
    header?.addEventListener('mousedown', (event) => {
      if (this.isFullscreen || this.isDocked) return;
      event.preventDefault();
      event.stopPropagation();
      this.manager?.startSidebarDrag?.(this, event);
    });

    fullscreenDivider?.addEventListener('mousedown', (event) => {
      if (!this.isFullscreen) return;
      event.preventDefault();
      event.stopPropagation();
      this.manager?.startFullscreenSplitResize?.(this, event);
    });

  }

  // 添加聚焦方法
  focusInput() {
    this.postToIframe({ type: 'FOCUS_INPUT' });
  }
  /**
   * 切换侧边栏的显示状态
   * @param {boolean|null} forceShow - 明确指定显示(true)或隐藏(false)，或为null时取反当前状态
   */
  toggle(forceShow = null) {
    if (!this.initialized) {
      // 背景命令可能早于 iframe 初始化完成到达；这里在实例内部重放显隐命令，
      // 避免调用方到处感知 readyPromise，也避免早期 OPEN_SIDEBAR 被静默丢弃。
      this.readyPromise
        .then(() => this.toggle(forceShow))
        .catch((error) => {
          console.warn('侧栏初始化后重放显隐命令失败:', error);
        });
      return;
    }

    try {
      const wasVisible = this.isVisible;

      // 根据 forceShow 参数分别处理
      if (forceShow === null) {
        // 没有指定强制显示/隐藏时，切换当前状态
        this.isVisible = !this.isVisible;
      } else {
        // 明确指定了显示/隐藏状态
        this.isVisible = forceShow;
      }

      // 如果之前和现在都是显示状态，无需操作
      if (wasVisible && this.isVisible && !this.isFullscreen) return;

      // console.log(`切换侧边栏: ${wasVisible} -> ${this.isVisible}, 位置: ${this.sidebarPosition}`);

      // 根据当前显示状态更新侧边栏
      if (this.isVisible) {
        // 显示侧边栏前，先将 display 设为 'block'
        this.sidebar.style.display = 'block';
        // 强制重排（读取 offsetWidth ）以确保初始状态被应用
        this.sidebar.offsetWidth;
        this.updateDockLayout();
        this.sidebar.classList.add('visible');

        // 如果当前为全屏模式，则隐藏滚动条
        if (this.isFullscreen) {
          document.documentElement.style.overflow = 'hidden';
        }

        // 如果之前是隐藏状态，则聚焦输入框
        if (!wasVisible) {
          this.focusInput();
        }
      } else {
        // 隐藏侧边栏：先移除 visible 类
        this.sidebar.classList.remove('visible');
        
        // 恢复隐藏时的变换
        setTimeout(() => {
          if (!this.isVisible) {
            this.sidebar.style.transform = `var(--transform-hidden)`;
          }
        }, 50);

        // 如果当前为全屏模式，关闭侧边栏时需要还原滚动条状态
        if (this.isFullscreen) {
          document.documentElement.style.overflow = '';
        }

        // 当侧边栏关闭时，确保不聚焦侧栏内的输入框
        this.postToIframe({ type: 'BLUR_INPUT' });
        // 当动画过渡结束后，再把 display 设置为 none
        this.sidebar.addEventListener('transitionend', (e) => {
          if (!this.sidebar.classList.contains('visible')) {
            this.sidebar.style.display = 'none';
            if (this.isDocked) {
              this.clearDockLayout();
            }
            this.manager?.layoutSidebars?.();
          }
        }, { once: true });
      }
    } catch (error) {
      console.error('切换侧边栏失败:', error);
    }
  }

  getIframeEmbedScale() {
    const dpr = Number(window.devicePixelRatio);
    const baseScale = (Number.isFinite(dpr) && dpr > 0) ? (1 / dpr) : 1;
    return baseScale * this.scaleFactor;
  }

  updateScale() {
    const iframe = this.getIframe();
    if (iframe) {
      const scale = this.getIframeEmbedScale();
      iframe.style.transformOrigin = 'top left';
      iframe.style.zoom = `${scale}`;
      iframe.style.width = `${100}%`;
      iframe.style.height = `${100}%`;
      this.sidebar.style.setProperty('--scale-ratio', scale);
      this.notifyIframeEmbedScale(scale);
      this.updateWidth(this.sidebarWidth);
    }
  }

  // 添加全屏模式切换方法
  toggleFullscreen(isFullscreen) {
    const shouldRestoreVisibility = !this.isVisible;
    // 如果isFullscreen为undefined，则根据当前状态切换
    if (isFullscreen === undefined) {
      isFullscreen = !this.isFullscreen;
    }
    console.log('切换全屏模式:', isFullscreen);
    this.isFullscreen = isFullscreen;

    // 在全屏模式下，为了让侧边栏覆盖整个页面并"忽视"父窗口滚动条，
    // 可以强制隐藏父页面的滚动条
    if (this.isFullscreen) {
      // 将侧边栏切换为全屏
      this.sidebar.classList.add('fullscreen');
      if (this.isDocked) {
        this.sidebar.classList.remove('docked');
        this.clearDockLayout();
      }
      
      // 清除位置相关的样式
      this.sidebar.style.left = '';
      this.sidebar.style.right = '';
      
      // 清除变换，确保侧边栏可见
      this.sidebar.style.transform = 'translateX(0)';

      // 隐藏父文档滚动条
      document.documentElement.style.overflow = 'hidden';
      
      // 通知iframe进入全屏模式
      this.notifyIframeFullscreenState(true);
    } else {
      // 退出全屏模式
      this.sidebar.classList.remove('fullscreen');
      
      // 恢复侧边栏位置
      this.updatePosition(this.sidebarPosition);
      if (this.isDocked) {
        this.sidebar.classList.add('docked');
        if (this.isVisible) {
          this.applyDockLayout();
        }
      }

      // 恢复父文档滚动条
      document.documentElement.style.overflow = '';

      // 如果侧边栏在全屏时是打开的，此时并不会自动关闭，
      // 只有在用户显式调用 toggle(false) 时才会关闭。
      
      // 通知iframe退出全屏模式
      this.notifyIframeFullscreenState(false);
    }

    // 统一行为：如果用户在“隐藏状态”下触发全屏快捷键，
    // 无论是进入全屏还是退出全屏，都应把侧栏打开并展示切换后的布局。
    if (shouldRestoreVisibility) {
      this.toggle(true);
    }

    // 如果是全屏模式，确保侧边栏可见
    if (this.isFullscreen && !this.sidebar.classList.contains('visible')) {
      this.sidebar.classList.add('visible');
      this.isVisible = true;
    }
    this.manager?.layoutSidebars?.();
  }

  applyFullscreenSplitLayout(index, total, layout = null) {
    if (!this.sidebar || !this.isFullscreen) return;
    const safeTotal = Math.max(1, Number(total) || 1);
    const safeIndex = Math.min(Math.max(0, Number(index) || 0), safeTotal - 1);
    const layoutLeftRatio = Number(layout?.leftRatio);
    const layoutWidthRatio = Number(layout?.widthRatio);
    const leftRatio = Number.isFinite(layoutLeftRatio)
      ? Math.max(0, layoutLeftRatio)
      : safeIndex / safeTotal;
    const widthRatio = Number.isFinite(layoutWidthRatio) && layoutWidthRatio > 0
      ? layoutWidthRatio
      : 1 / safeTotal;
    const widthExpression = `${(widthRatio * 100).toFixed(6)}vw`;
    const leftExpression = `${(leftRatio * 100).toFixed(6)}vw`;
    this.sidebar.classList.add('fullscreen-split');
    this.sidebar.classList.toggle('has-fullscreen-divider', layout?.hasDivider === true);
    this.sidebar.style.setProperty('--cerebr-fullscreen-left', leftExpression);
    this.sidebar.style.setProperty('--cerebr-fullscreen-width', widthExpression);
    this.sidebar.dataset.cerebrFullscreenSplitIndex = String(safeIndex);
    this.sidebar.dataset.cerebrFullscreenSplitRatio = widthRatio.toFixed(8);
  }

  clearFullscreenSplitLayout() {
    if (!this.sidebar) return;
    this.sidebar.classList.remove('fullscreen-split');
    this.sidebar.classList.remove('has-fullscreen-divider');
    this.sidebar.classList.remove('fullscreen-split-resizing');
    this.sidebar.style.removeProperty('--cerebr-fullscreen-left');
    this.sidebar.style.removeProperty('--cerebr-fullscreen-width');
    delete this.sidebar.dataset.cerebrFullscreenSplitIndex;
    delete this.sidebar.dataset.cerebrFullscreenSplitRatio;
  }
  
  // 通知iframe全屏状态变化
  notifyIframeFullscreenState(isFullscreen) {
    try {
      this.postToIframe({
        type: 'FULLSCREEN_STATE_CHANGED',
        isFullscreen: isFullscreen
      });
    } catch (error) {
      console.log('通知iframe全屏状态失败:', error);
    }
  }

  notifyIframeDockModeState() {
    try {
      this.postToIframe({
        type: 'DOCK_MODE_STATE_SYNC',
        isDocked: !!this.isDocked
      });
    } catch (error) {
      console.log('通知 iframe 停靠状态失败:', error);
    }
  }

  // 通知 iframe 临时模式状态变化
  notifyIframeTempModeState(isOn) {
    try {
      this.postToIframe({
        type: 'TEMP_MODE_STATE_SYNC',
        isOn: !!isOn
      });
    } catch (error) {
      console.log('通知iframe临时模式状态失败:', error);
    }
  }

  // 通知 iframe 当前从宿主页观察到的 Alt 状态。
  // iframe 侧只据此切换滚轮监听模式，不会反向修改宿主页事件流。
  notifyIframeAltKeyState(isPressed) {
    this.isAltKeyPressed = !!isPressed;
    try {
      this.postToIframe({
        type: 'ALT_KEY_STATE_SYNC',
        isPressed: !!isPressed
      });
    } catch (error) {
      console.log('通知 iframe Alt 状态失败:', error);
    }
  }

  notifyIframeEmbedScale(scale = this.getIframeEmbedScale()) {
    try {
      this.postToIframe({
        type: 'HOST_EMBED_SCALE_SYNC',
        scale
      });
    } catch (error) {
      console.log('通知 iframe 嵌入缩放失败:', error);
    }
  }

  dispose() {
    this.isDisposed = true;
    try {
      this.restoreObserver?.disconnect?.();
    } catch (_) {}
    this.restoreObserver = null;

    if (this.restoreTimeoutId) {
      clearTimeout(this.restoreTimeoutId);
      this.restoreTimeoutId = null;
    }

    try {
      if (this.isDocked) this.clearDockLayout();
    } catch (_) {}

    try {
      this.postToIframe({ type: 'BLUR_INPUT' });
    } catch (_) {}

    try { this.sidebarBridgePort?.close?.(); } catch (_) {}
    this.sidebarBridgePort = null;
    this.pendingBridgeMessages.length = 0;

    try {
      if (this.container?.parentNode) {
        this.container.parentNode.removeChild(this.container);
      }
    } catch (error) {
      console.warn('销毁侧栏实例失败:', error);
    }

    this.sidebar = null;
    this.container = null;
    this.initialized = false;
  }
}

class CerebrSidebarManager {
  constructor() {
    this.sidebars = [];
    this.sidebarById = new Map();
    this.activeSidebarId = null;
    this.lastUrl = window.location.href;
    this.lastImageData = null;
    this.isAltKeyPressed = false;
    this.nextInstanceSeq = 1;
    this.multiFullscreenRestoreStateById = null;
    // 全屏分栏比例只服务当前页面当前生命周期，不写入 chrome.storage；
    // 这样用户可以临时拖出适合本次阅读/对话的比例，刷新页面后自然回到默认平分。
    this.fullscreenSplitRatioById = new Map();
    this.jsRuntimeRunner = new CerebrJsRuntimeRunner({
      resolveSidebarById: (instanceId) => this.getSidebarById(instanceId)
    });
    this.createSidebar({ show: false, isPrimary: true });
    this.setupUrlChangeListener();
    this.setupHostEventListeners();
    this.setupDragAndDrop();
  }

  generateInstanceId() {
    const timestamp = Date.now().toString(36);
    const seq = this.nextInstanceSeq++;
    const random = Math.random().toString(36).slice(2, 8);
    return `sidebar_${timestamp}_${seq}_${random}`;
  }

  createSidebar(options = {}) {
    const instanceId = this.generateInstanceId();
    const sidebarInstance = new CerebrSidebar({
      manager: this,
      instanceId,
      isPrimary: options?.isPrimary === true
    });
    this.sidebars.push(sidebarInstance);
    this.sidebarById.set(instanceId, sidebarInstance);
    this.setActiveSidebar(sidebarInstance);
    sidebarInstance.readyPromise.then(() => {
      sidebarInstance.notifyIframeAltKeyState(this.isAltKeyPressed);
      this.sendPageInfoToSidebar(sidebarInstance);
      if (this.shouldAttachNewSidebarToFullscreenLayout(sidebarInstance, options)) {
        this.attachNewSidebarToFullscreenLayout(sidebarInstance);
        return;
      }

      this.layoutSidebars();
      if (options?.show === true) {
        sidebarInstance.toggle(true);
      }
    }).catch((error) => {
      console.warn('侧栏实例初始化完成回调失败:', error);
    });
    return sidebarInstance;
  }

  shouldAttachNewSidebarToFullscreenLayout(sidebarInstance, options = {}) {
    return options?.show === true
      && this.sidebars.length > 1
      && this.sidebars.some((item) => item !== sidebarInstance && item?.isFullscreen);
  }

  attachNewSidebarToFullscreenLayout(sidebarInstance) {
    if (!sidebarInstance) return;

    if (!this.multiFullscreenRestoreStateById) {
      this.multiFullscreenRestoreStateById = this.buildMultiFullscreenRestoreState();
    }

    // 在全屏中点击“新建侧栏”代表用户显式增加一个并行工作区。
    // 因此退出全屏时，新实例应保持可见，而不是按 ready 前的隐藏初始态恢复。
    this.multiFullscreenRestoreStateById.set(sidebarInstance.instanceId, {
      wasVisible: true,
      wasDocked: false
    });
    sidebarInstance.toggle(true);
    this.enterMultiSidebarFullscreen(sidebarInstance);
  }

  getPrimarySidebar() {
    return this.sidebars[0] || null;
  }

  getActiveSidebar() {
    return this.sidebarById.get(this.activeSidebarId) || this.getPrimarySidebar();
  }

  getSidebarById(instanceId) {
    if (typeof instanceId !== 'string' || !instanceId.trim()) return null;
    return this.sidebarById.get(instanceId.trim()) || null;
  }

  handleJsRuntimeBridgeMessage(sidebar, data = {}) {
    if (!sidebar || data?.[JS_RUNTIME_RUNNER_MESSAGE_FLAG] !== true) return;
    if (data.type !== 'request') return;
    this.jsRuntimeRunner?.forwardRequest?.(sidebar, data);
  }

  handleSidebarBridgeMessage(sourceSidebar, data = {}) {
    if (!sourceSidebar || !data || typeof data !== 'object') return;
    if (data?.[JS_RUNTIME_RUNNER_MESSAGE_FLAG] === true) {
      this.handleJsRuntimeBridgeMessage(sourceSidebar, data);
      return;
    }
    if (!data.type) return;
    this.setActiveSidebar(sourceSidebar);

    switch (data.type) {
      case 'SIDEBAR_WIDTH_CHANGE':
        this.applyWidthToAll(data.width);
        break;
      case 'SCALE_FACTOR_CHANGE':
        this.applyScaleToAll(data.value);
        break;
      case 'SIDEBAR_POSITION_CHANGE':
        this.applyPositionToAll(data.position);
        break;
      case 'SIDEBAR_EDGE_CONTROL_POINTER_DOWN':
        this.startSidebarEdgeControlInteraction(sourceSidebar, data);
        break;
      case 'SET_DOCK_MODE_FROM_IFRAME':
        {
          const nextDocked = data.isDocked === true;
          if (nextDocked) {
            this.sidebars.forEach((item) => {
              if (item !== sourceSidebar) item.setDockMode(false);
            });
          }
          sourceSidebar.setDockMode(nextDocked);
        }
        this.layoutSidebars();
        break;
      case 'CLOSE_SIDEBAR':
        if (sourceSidebar.isPrimary) {
          sourceSidebar.toggle(false);
          this.layoutSidebars();
        } else {
          this.destroySidebar(sourceSidebar);
        }
        break;
      case 'TOGGLE_FULLSCREEN_FROM_IFRAME':
        console.log('处理全屏切换消息:', data.isFullscreen);
        this.toggleFullscreenForSidebar(sourceSidebar);
        break;
      case 'CREATE_ADDITIONAL_SIDEBAR':
        this.createSidebar({ show: true });
        break;
      case 'CAPTURE_SCREENSHOT':
        captureAndDropScreenshot(sourceSidebar);
        break;
      case 'COPY_IMAGE_TO_CLIPBOARD':
        (async () => {
          const requestId = typeof data.requestId === 'string' ? data.requestId : '';
          try {
            if (!(data.blob instanceof Blob) || data.blob.type !== 'image/png') {
              throw new Error('截图数据无效');
            }
            await navigator.clipboard.write([
              new ClipboardItem({ 'image/png': data.blob })
            ]);
            sourceSidebar.postToIframe({ type: 'COPY_IMAGE_TO_CLIPBOARD_RESULT', requestId, success: true });
          } catch (error) {
            sourceSidebar.postToIframe({
              type: 'COPY_IMAGE_TO_CLIPBOARD_RESULT',
              requestId,
              success: false,
              error: error?.message || '复制截图失败'
            });
          }
        })();
        break;
      case 'OPEN_MARKDOWN_LINK':
        openMarkdownLinkInPage(data.url);
        break;
      case 'REQUEST_PAGE_INFO':
        this.sendPageInfoToSidebar(sourceSidebar);
        break;
      case 'REQUEST_FULLSCREEN_STATE':
        sourceSidebar.notifyIframeFullscreenState(sourceSidebar.isFullscreen);
        break;
      case 'REQUEST_TEMP_MODE_STATE':
        sourceSidebar.notifyIframeTempModeState(sourceSidebar.isTemporaryMode);
        break;
      case 'REQUEST_ALT_KEY_STATE':
        sourceSidebar.notifyIframeAltKeyState(this.isAltKeyPressed);
        break;
      case 'REQUEST_HOST_EMBED_SCALE':
        sourceSidebar.notifyIframeEmbedScale();
        break;
      case 'TEMP_MODE_STATE_CHANGED':
        sourceSidebar.isTemporaryMode = !!data?.isOn;
        break;
      case 'SIDEBAR_SELECTION_CHANGED':
        if (!data.source || data.source === 'cerebr-sidebar') {
          currentSelection = (data.text || '').toString().trim();
        }
        break;
      default:
        break;
    }
  }

  destroySidebar(sidebarInstance) {
    if (!sidebarInstance) return;
    const index = this.sidebars.indexOf(sidebarInstance);
    if (index === -1) return;

    this.sidebars.splice(index, 1);
    this.sidebarById.delete(sidebarInstance.instanceId);
    this.multiFullscreenRestoreStateById?.delete?.(sidebarInstance.instanceId);
    this.fullscreenSplitRatioById?.delete?.(sidebarInstance.instanceId);
    sidebarInstance.dispose();

    if (this.activeSidebarId === sidebarInstance.instanceId) {
      this.activeSidebarId = null;
      const nextActive = this.sidebars[Math.min(index, this.sidebars.length - 1)] || this.getPrimarySidebar();
      if (nextActive) this.setActiveSidebar(nextActive);
    }

    if (this.sidebars.length <= 1) {
      this.multiFullscreenRestoreStateById = null;
      this.fullscreenSplitRatioById.clear();
    }
    this.layoutSidebars();
  }

  setActiveSidebar(sidebarInstance) {
    if (!sidebarInstance) return;
    this.activeSidebarId = sidebarInstance.instanceId;
    this.sidebars.forEach((item) => {
      const isActive = item === sidebarInstance;
      if (item.sidebar) {
        item.sidebar.classList.toggle('active', isActive);
        item.sidebar.style.zIndex = String(isActive ? 2147483647 : 2147483640);
      }
    });
  }

  getVisibleSidebars() {
    return this.sidebars.filter((item) => item?.isVisible && item?.sidebar);
  }

  getVisibleSidebarsByPosition(position) {
    const normalizedPosition = position === 'left' ? 'left' : 'right';
    return this.sidebars.filter((item) => (
      item?.isVisible
      && item?.sidebar
      && !item.isFullscreen
      && (item.sidebarPosition === 'left' ? 'left' : 'right') === normalizedPosition
    ));
  }

  createInteractionOverlay(cursor = 'default') {
    const overlay = document.createElement('div');
    overlay.dataset.cerebrInteractionOverlay = 'true';
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      cursor,
      background: 'transparent',
      pointerEvents: 'auto'
    });
    document.documentElement.appendChild(overlay);
    return overlay;
  }

  setAllSidebarsVisible(isVisible) {
    const nextVisible = !!isVisible;
    this.sidebars.forEach((item) => item.toggle(nextVisible));
    this.layoutSidebars();
  }

  toggleAllSidebars() {
    const shouldHideAll = this.sidebars.some((item) => item?.isVisible);
    this.setAllSidebarsVisible(!shouldHideAll);
  }

  reloadActiveSidebarIframe() {
    const target = this.getActiveSidebar();
    if (!target) {
      return {
        success: false,
        error: 'Active sidebar instance not found'
      };
    }
    this.setActiveSidebar(target);
    return target.reloadIframe();
  }

  isMultiSidebarFullscreenActive() {
    return this.sidebars.length > 1
      && this.sidebars.some((item) => item?.isFullscreen);
  }

  getFullscreenLayoutSidebars() {
    return this.sidebars.filter((item) => (
      item?.isVisible
      && item?.isFullscreen
      && item?.sidebar
    ));
  }

  getViewportWidth() {
    return Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
  }

  getFullscreenSplitMinRatio(count, viewportWidth = this.getViewportWidth()) {
    const safeCount = Math.max(1, Number(count) || 1);
    const safeViewportWidth = Math.max(1, Number(viewportWidth) || 1);
    const averagePaneWidth = safeViewportWidth / safeCount;
    const minPaneWidth = Math.min(320, Math.max(80, averagePaneWidth * 0.8));
    return Math.min(0.45, minPaneWidth / safeViewportWidth);
  }

  normalizeRatiosWithMinimum(ratios, minRatio) {
    const safeRatios = Array.isArray(ratios) ? ratios : [];
    const count = safeRatios.length;
    if (count <= 0) return [];

    const equalRatio = 1 / count;
    const safeMinRatio = Math.min(Math.max(0, Number(minRatio) || 0), equalRatio * 0.9);
    const positiveRatios = safeRatios.map((value) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
    });
    const total = positiveRatios.reduce((sum, value) => sum + value, 0);
    const normalizedRatios = total > 0
      ? positiveRatios.map((value) => value / total)
      : safeRatios.map(() => equalRatio);
    const minimumTotal = safeMinRatio * count;
    if (minimumTotal <= 0) return normalizedRatios;
    if (minimumTotal >= 1) return safeRatios.map(() => equalRatio);

    const excessRatios = normalizedRatios.map((value) => Math.max(0, value - safeMinRatio));
    const excessTotal = excessRatios.reduce((sum, value) => sum + value, 0);
    if (excessTotal <= 0) return safeRatios.map(() => equalRatio);

    const adjustableTotal = 1 - minimumTotal;
    return excessRatios.map((value) => safeMinRatio + (value / excessTotal) * adjustableTotal);
  }

  ensureFullscreenSplitRatios(fullscreenSidebars) {
    const sidebars = Array.isArray(fullscreenSidebars) ? fullscreenSidebars : [];
    const count = sidebars.length;
    if (count <= 0) return [];

    const activeIds = new Set(sidebars.map((item) => item.instanceId));
    for (const instanceId of Array.from(this.fullscreenSplitRatioById.keys())) {
      if (!activeIds.has(instanceId)) {
        this.fullscreenSplitRatioById.delete(instanceId);
      }
    }

    const equalRatio = 1 / count;
    const rawRatios = sidebars.map((item) => {
      const ratio = Number(this.fullscreenSplitRatioById.get(item.instanceId));
      return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
    });
    const knownRatios = rawRatios.filter((value) => value !== null);
    let nextRatios;

    if (knownRatios.length === 0) {
      nextRatios = sidebars.map(() => equalRatio);
    } else {
      const knownTotal = knownRatios.reduce((sum, value) => sum + value, 0);
      const missingCount = count - knownRatios.length;
      if (knownTotal <= 0) {
        nextRatios = sidebars.map(() => equalRatio);
      } else if (missingCount > 0) {
        const missingTotal = equalRatio * missingCount;
        const knownTargetTotal = Math.max(0, 1 - missingTotal);
        nextRatios = rawRatios.map((value) => (
          value === null
            ? equalRatio
            : (value / knownTotal) * knownTargetTotal
        ));
      } else {
        nextRatios = rawRatios.map((value) => value / knownTotal);
      }
    }

    const minRatio = this.getFullscreenSplitMinRatio(count);
    const normalizedRatios = this.normalizeRatiosWithMinimum(nextRatios, minRatio);
    this.setFullscreenSplitRatios(sidebars, normalizedRatios);
    return normalizedRatios;
  }

  setFullscreenSplitRatios(fullscreenSidebars, ratios) {
    const sidebars = Array.isArray(fullscreenSidebars) ? fullscreenSidebars : [];
    const normalizedRatios = this.normalizeRatiosWithMinimum(
      Array.isArray(ratios) ? ratios : [],
      this.getFullscreenSplitMinRatio(sidebars.length)
    );
    sidebars.forEach((item, index) => {
      const ratio = normalizedRatios[index];
      if (Number.isFinite(ratio) && ratio > 0) {
        this.fullscreenSplitRatioById.set(item.instanceId, ratio);
      }
    });
    return normalizedRatios;
  }

  buildFullscreenSplitLayouts(fullscreenSidebars) {
    const ratios = this.ensureFullscreenSplitRatios(fullscreenSidebars);
    let leftRatio = 0;
    return ratios.map((widthRatio, index) => {
      const layout = {
        leftRatio,
        widthRatio,
        hasDivider: index < ratios.length - 1
      };
      leftRatio += widthRatio;
      return layout;
    });
  }

  buildMultiFullscreenRestoreState() {
    const restoreStateById = new Map();
    this.sidebars.forEach((item) => {
      restoreStateById.set(item.instanceId, {
        wasVisible: !!item.isVisible,
        wasDocked: !!item.isDocked
      });
    });
    return restoreStateById;
  }

  enterMultiSidebarFullscreen(sourceSidebar) {
    if (this.sidebars.length <= 1) {
      sourceSidebar?.toggleFullscreen?.();
      return;
    }

    const wasMultiFullscreenActive = this.isMultiSidebarFullscreenActive();
    if (!this.multiFullscreenRestoreStateById) {
      this.multiFullscreenRestoreStateById = this.buildMultiFullscreenRestoreState();
    }
    if (!wasMultiFullscreenActive) {
      this.fullscreenSplitRatioById.clear();
    }

    // 多侧栏全屏是一个页面级布局状态：所有实例一起进入全屏并平分视口。
    // 这里主动显示隐藏实例，退出时再按进入前快照恢复，避免快捷键状态依赖当前 active 侧栏。
    this.sidebars.forEach((item) => {
      if (item.isDocked) item.setDockMode(false);
      item.toggle(true);
      item.toggleFullscreen(true);
    });
    if (sourceSidebar) this.setActiveSidebar(sourceSidebar);
    this.layoutSidebars();
  }

  exitMultiSidebarFullscreen() {
    const restoreStateById = this.multiFullscreenRestoreStateById;
    this.sidebars.forEach((item) => {
      item.clearFullscreenSplitLayout();
      item.toggleFullscreen(false);
    });

    if (restoreStateById) {
      this.sidebars.forEach((item) => {
        const restoreState = restoreStateById.get(item.instanceId);
        if (!restoreState) return;
        item.setDockMode(!!restoreState.wasDocked);
        item.toggle(!!restoreState.wasVisible);
      });
    }

    this.multiFullscreenRestoreStateById = null;
    this.fullscreenSplitRatioById.clear();
    document.documentElement.style.overflow = '';
    this.layoutSidebars();
  }

  toggleFullscreenForSidebar(sidebarInstance) {
    const target = sidebarInstance || this.getActiveSidebar();
    if (!target) return;

    if (this.sidebars.length > 1) {
      if (this.isMultiSidebarFullscreenActive()) {
        this.exitMultiSidebarFullscreen();
      } else {
        this.enterMultiSidebarFullscreen(target);
      }
      return;
    }

    target.toggleFullscreen();
    this.layoutSidebars();
  }

  moveSidebarBefore(sidebarInstance, beforeSidebar) {
    if (!sidebarInstance || sidebarInstance === beforeSidebar) return;
    const currentIndex = this.sidebars.indexOf(sidebarInstance);
    if (currentIndex === -1) return;
    this.sidebars.splice(currentIndex, 1);
    if (!beforeSidebar) {
      this.sidebars.push(sidebarInstance);
      return;
    }
    const nextIndex = this.sidebars.indexOf(beforeSidebar);
    if (nextIndex === -1) {
      this.sidebars.push(sidebarInstance);
      return;
    }
    this.sidebars.splice(nextIndex, 0, sidebarInstance);
  }

  reorderSidebarFromPointer(sidebarInstance, clientX) {
    if (!sidebarInstance || !sidebarInstance.sidebar || sidebarInstance.isFullscreen || sidebarInstance.isDocked) return;
    const viewportMidpoint = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1) / 2;
    const targetPosition = clientX < viewportMidpoint ? 'left' : 'right';
    if (sidebarInstance.sidebarPosition !== targetPosition) {
      sidebarInstance.updatePosition(targetPosition, { persist: false });
    }
    const peers = this.getVisibleSidebarsByPosition(targetPosition)
      .filter((item) => item !== sidebarInstance);
    let beforeSidebar = null;
    if (targetPosition === 'right') {
      for (const item of peers) {
        const rect = item.sidebar.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        if (clientX > centerX) {
          beforeSidebar = item;
          break;
        }
      }
    } else {
      for (const item of peers) {
        const rect = item.sidebar.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        if (clientX < centerX) {
          beforeSidebar = item;
          break;
        }
      }
    }
    this.moveSidebarBefore(sidebarInstance, beforeSidebar);
    this.layoutSidebars();
  }

  startSidebarDrag(sidebarInstance, startEvent) {
    if (!sidebarInstance || sidebarInstance.isFullscreen || sidebarInstance.isDocked) return;
    this.setActiveSidebar(sidebarInstance);
    sidebarInstance.sidebar?.classList.add('dragging');
    const interactionOverlay = this.createInteractionOverlay('grabbing');
    const handleMouseMove = (event) => {
      this.reorderSidebarFromPointer(sidebarInstance, event.clientX);
    };
    const cleanupDrag = (event) => {
      sidebarInstance.sidebar?.classList.remove('dragging');
      if (Number.isFinite(Number(event?.clientX))) {
        this.reorderSidebarFromPointer(sidebarInstance, event.clientX);
      }
      this.layoutSidebars();
      interactionOverlay.removeEventListener('mousemove', handleMouseMove, true);
      interactionOverlay.removeEventListener('mouseup', cleanupDrag, true);
      window.removeEventListener('blur', cleanupDrag, true);
      interactionOverlay.remove();
    };
    interactionOverlay.addEventListener('mousemove', handleMouseMove, true);
    interactionOverlay.addEventListener('mouseup', cleanupDrag, true);
    window.addEventListener('blur', cleanupDrag, true);
    this.reorderSidebarFromPointer(sidebarInstance, startEvent.clientX);
  }

  resolveEdgeControlPointerX(sidebarInstance, payload = {}) {
    const screenX = Number(payload?.screenX);
    if (Number.isFinite(screenX)) return screenX;

    const clientX = Number(payload?.clientX);
    if (!Number.isFinite(clientX)) return NaN;

    // iframe 发来的 clientX 是 iframe 视口坐标；只有 screenX 不可用时才退回到
    // “iframe 外框位置 + iframe 内坐标”的换算，避免跨层坐标混用导致拖拽跳变。
    const iframe = sidebarInstance?.getIframe?.();
    const rect = iframe?.getBoundingClientRect?.();
    if (!rect) return clientX;

    const scale = sidebarInstance?.getIframeEmbedScale?.();
    const safeScale = (Number.isFinite(Number(scale)) && Number(scale) > 0) ? Number(scale) : 1;
    return rect.left + clientX * safeScale;
  }

  getMouseEventPointerX(event, fallback = NaN) {
    const screenX = Number(event?.screenX);
    if (Number.isFinite(screenX)) return screenX;
    const clientX = Number(event?.clientX);
    return Number.isFinite(clientX) ? clientX : fallback;
  }

  startSidebarEdgeControlInteraction(sidebarInstance, payload = {}) {
    if (!sidebarInstance?.sidebar) return;
    if (Number(payload?.button || 0) !== 0) return;

    this.setActiveSidebar(sidebarInstance);
    if (sidebarInstance.isFullscreen) {
      this.toggleFullscreenForSidebar(sidebarInstance);
      return;
    }

    const startPointerX = this.resolveEdgeControlPointerX(sidebarInstance, payload);
    if (!Number.isFinite(startPointerX)) {
      this.toggleFullscreenForSidebar(sidebarInstance);
      return;
    }

    const startWidth = sidebarInstance.sidebarWidth;
    const startPosition = sidebarInstance.sidebarPosition === 'left' ? 'left' : 'right';
    const interactionOverlay = this.createInteractionOverlay('col-resize');
    const dragThresholdPx = 4;
    let hasResized = false;

    const applyPointerX = (pointerX) => {
      const nextPointerX = Number(pointerX);
      if (!Number.isFinite(nextPointerX)) return;

      const pointerDelta = startPosition === 'left'
        ? nextPointerX - startPointerX
        : startPointerX - nextPointerX;

      if (!hasResized && Math.abs(pointerDelta) < dragThresholdPx) return;

      if (!hasResized) {
        hasResized = true;
        sidebarInstance.sidebar?.classList.add('resizing');
      }

      sidebarInstance.updateWidth(
        sidebarInstance.resolveSidebarWidthFromPointerDelta(startWidth, pointerDelta)
      );
      this.layoutSidebars();
    };

    const handleMouseMove = (event) => {
      applyPointerX(this.getMouseEventPointerX(event));
    };

    const cleanupInteraction = (event, options = {}) => {
      const allowClickToggle = options?.allowClickToggle !== false;
      if (hasResized) {
        applyPointerX(this.getMouseEventPointerX(event, startPointerX));
      } else if (allowClickToggle) {
        this.toggleFullscreenForSidebar(sidebarInstance);
      }

      sidebarInstance.sidebar?.classList.remove('resizing');
      interactionOverlay.removeEventListener('mousemove', handleMouseMove, true);
      interactionOverlay.removeEventListener('mouseup', cleanupInteraction, true);
      window.removeEventListener('blur', handleBlur, true);
      interactionOverlay.remove();
    };

    const handleBlur = () => cleanupInteraction(null, { allowClickToggle: false });

    interactionOverlay.addEventListener('mousemove', handleMouseMove, true);
    interactionOverlay.addEventListener('mouseup', cleanupInteraction, true);
    window.addEventListener('blur', handleBlur, true);
  }

  startFullscreenSplitResize(leftSidebar, startEvent) {
    if (!leftSidebar?.isFullscreen || !leftSidebar?.sidebar) return;
    const fullscreenSidebars = this.getFullscreenLayoutSidebars();
    const dividerIndex = fullscreenSidebars.indexOf(leftSidebar);
    if (dividerIndex < 0 || dividerIndex >= fullscreenSidebars.length - 1) return;

    const rightSidebar = fullscreenSidebars[dividerIndex + 1];
    const viewportWidth = this.getViewportWidth();
    const startX = Number(startEvent?.clientX);
    if (!Number.isFinite(startX)) return;

    const startRatios = this.ensureFullscreenSplitRatios(fullscreenSidebars);
    const pairTotal = startRatios[dividerIndex] + startRatios[dividerIndex + 1];
    const minRatio = Math.min(
      this.getFullscreenSplitMinRatio(fullscreenSidebars.length, viewportWidth),
      pairTotal / 2
    );
    const interactionOverlay = this.createInteractionOverlay('col-resize');

    leftSidebar.sidebar.classList.add('fullscreen-split-resizing');
    rightSidebar?.sidebar?.classList.add('fullscreen-split-resizing');

    const applyPointerX = (clientX) => {
      const nextClientX = Number(clientX);
      if (!Number.isFinite(nextClientX)) return;
      const deltaRatio = (nextClientX - startX) / viewportWidth;
      const unclampedLeftRatio = startRatios[dividerIndex] + deltaRatio;
      const nextLeftRatio = Math.min(
        Math.max(unclampedLeftRatio, minRatio),
        pairTotal - minRatio
      );
      const nextRatios = startRatios.slice();
      nextRatios[dividerIndex] = nextLeftRatio;
      nextRatios[dividerIndex + 1] = pairTotal - nextLeftRatio;
      this.setFullscreenSplitRatios(fullscreenSidebars, nextRatios);
      this.layoutSidebars();
    };

    const handleMouseMove = (event) => {
      applyPointerX(event.clientX);
    };
    const cleanupResize = (event) => {
      applyPointerX(event?.clientX);
      leftSidebar.sidebar?.classList.remove('fullscreen-split-resizing');
      rightSidebar?.sidebar?.classList.remove('fullscreen-split-resizing');
      interactionOverlay.removeEventListener('mousemove', handleMouseMove, true);
      interactionOverlay.removeEventListener('mouseup', cleanupResize, true);
      window.removeEventListener('blur', cleanupResize, true);
      interactionOverlay.remove();
    };

    interactionOverlay.addEventListener('mousemove', handleMouseMove, true);
    interactionOverlay.addEventListener('mouseup', cleanupResize, true);
    window.addEventListener('blur', cleanupResize, true);
  }

  layoutSidebars() {
    const gapPx = 12;
    const fullscreenSidebars = this.getFullscreenLayoutSidebars();
    if (fullscreenSidebars.length > 1) {
      const layouts = this.buildFullscreenSplitLayouts(fullscreenSidebars);
      fullscreenSidebars.forEach((item, index) => {
        item.setStackOffsetPx(0);
        item.applyFullscreenSplitLayout(index, fullscreenSidebars.length, layouts[index]);
      });
      this.sidebars.forEach((item) => {
        if (!fullscreenSidebars.includes(item)) item.clearFullscreenSplitLayout();
      });
      return;
    }

    const offsetByPosition = new Map();
    for (const item of this.sidebars) {
      const position = item.sidebarPosition === 'left' ? 'left' : 'right';
      item.clearFullscreenSplitLayout();
      if (!item.isVisible || item.isFullscreen) {
        item.setStackOffsetPx(0);
        continue;
      }
      const offset = offsetByPosition.get(position) || 0;
      item.setStackOffsetPx(offset);
      const rect = item.sidebar?.getBoundingClientRect?.();
      const width = rect && rect.width > 0 ? rect.width : item.getDockWidth();
      offsetByPosition.set(position, offset + Math.max(0, Math.round(width)) + gapPx);
    }
  }

  buildPageInfoMessage() {
    return {
      type: 'URL_CHANGED',
      url: window.location.href,
      title: document.title,
      contentType: document.contentType || '',
      isPdf: isCurrentPagePdfLike(),
      referrer: document.referrer,
      lastModified: document.lastModified,
      lang: document.documentElement.lang,
      charset: document.characterSet
    };
  }

  sendPageInfoToSidebar(sidebarInstance) {
    const target = sidebarInstance || this.getActiveSidebar();
    if (!target) return;
    target.postToIframe(this.buildPageInfoMessage());
  }

  broadcastPageInfo() {
    const message = this.buildPageInfoMessage();
    this.sidebars.forEach((item) => item.postToIframe(message));
  }

  syncHostAltKeyState(isPressed) {
    const nextPressed = !!isPressed;
    if (this.isAltKeyPressed === nextPressed) return;
    this.isAltKeyPressed = nextPressed;
    this.sidebars.forEach((item) => item.notifyIframeAltKeyState(nextPressed));
  }

  applyWidthToAll(width) {
    this.sidebars.forEach((item) => item.updateWidth(width));
    this.layoutSidebars();
  }

  applyScaleToAll(value) {
    this.sidebars.forEach((item) => {
      item.scaleFactor = value;
      item.updateScale();
    });
    queueSyncSet({ scaleFactor: value });
    this.layoutSidebars();
  }

  applyPositionToAll(position) {
    this.sidebars.forEach((item) => item.updatePosition(position));
    this.layoutSidebars();
  }

  setupUrlChangeListener() {
    let lastUrl = window.location.href;

    const hasUrlChanged = (currentUrl) => {
      if (currentUrl === lastUrl) return false;
      if (document.contentType === 'application/pdf') return false;

      const oldUrl = new URL(lastUrl);
      const newUrl = new URL(currentUrl);
      return oldUrl.pathname !== newUrl.pathname || oldUrl.search !== newUrl.search;
    };

    const handleUrlChange = () => {
      const currentUrl = window.location.href;
      if (!hasUrlChanged(currentUrl)) return;
      console.log('URL变化:', '从:', lastUrl, '到:', currentUrl);
      lastUrl = currentUrl;
      this.broadcastPageInfo();
    };

    window.addEventListener('popstate', () => {
      console.log('popstate事件触发');
      handleUrlChange();
    });

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function () {
      originalPushState.apply(this, arguments);
      console.log('pushState被调用');
      handleUrlChange();
    };

    history.replaceState = function () {
      originalReplaceState.apply(this, arguments);
      console.log('replaceState被调用');
      handleUrlChange();
    };

    setInterval(handleUrlChange, 1000);
  }

  setupHostEventListeners() {
    // 这里只观察父页面 Alt 状态并同步给所有侧栏实例，不拦截宿主页事件。
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Alt') {
        this.syncHostAltKeyState(true);
      }
    }, true);
    window.addEventListener('keyup', (event) => {
      if (event.key === 'Alt') {
        this.syncHostAltKeyState(false);
      }
    }, true);
    window.addEventListener('blur', () => {
      this.syncHostAltKeyState(false);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') {
        this.syncHostAltKeyState(false);
      }
    });

  }

  setupDragAndDrop() {
    document.addEventListener('dragstart', (event) => {
      console.log('拖动开始，目标元素:', event.target?.tagName);
      const img = event.target;
      if (!img || img.tagName !== 'IMG') return;
      console.log('检测到图片拖动，图片src:', img.src);
      try {
        console.log('尝试获取图片数据');
        fetch(img.src)
          .then(response => response.blob())
          .then(blob => {
            console.log('成功获取图片blob数据，大小:', blob.size);
            const reader = new FileReader();
            reader.onloadend = () => {
              const base64Data = reader.result;
              console.log('成功转换为base64数据');
              const imageData = {
                type: 'image',
                data: base64Data,
                name: img.alt || '拖放图片'
              };
              console.log('设置拖动数据:', imageData.name);
              this.lastImageData = imageData;
              event.dataTransfer?.setData?.('text/plain', JSON.stringify(imageData));
              if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
            };
            reader.readAsDataURL(blob);
          })
          .catch(error => {
            console.error('获取图片数据失败:', error);
            console.log('尝试使用Canvas方法获取图片数据');
            try {
              const canvas = document.createElement('canvas');
              canvas.width = img.naturalWidth;
              canvas.height = img.naturalHeight;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(img, 0, 0);
              const base64Data = canvas.toDataURL(img.src.match(/\.png$/i) ? 'image/png' : 'image/jpeg');
              console.log('成功使用Canvas获取图片数据');
              const imageData = {
                type: 'image',
                data: base64Data,
                name: img.alt || '拖放图片'
              };
              console.log('设置拖动数据:', imageData.name);
              this.lastImageData = imageData;
              event.dataTransfer?.setData?.('text/plain', JSON.stringify(imageData));
              if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
            } catch (canvasError) {
              console.error('Canvas获取图片数据失败:', canvasError);
            }
          });
      } catch (error) {
        console.error('处理图片拖动失败:', error);
      }
    });

    document.addEventListener('dragend', (event) => {
      const target = this.findVisibleSidebarAtPoint(event.clientX, event.clientY);
      console.log('拖动结束，命中的侧栏实例:', target?.instanceId || null, '坐标:', event.clientX, event.clientY);

      if (target && this.lastImageData && target.isVisible) {
        console.log('在侧边栏内放下，发送图片数据到iframe');
        target.postToIframe({
          type: 'DROP_IMAGE',
          imageData: this.lastImageData
        });
        this.setActiveSidebar(target);
      }
      this.lastImageData = null;
    });
  }

  findVisibleSidebarAtPoint(x, y) {
    for (let i = this.sidebars.length - 1; i >= 0; i -= 1) {
      const item = this.sidebars[i];
      if (!item?.isVisible || !item?.sidebar) continue;
      const rect = item.sidebar.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return item;
      }
    }
    return null;
  }

}

let sidebarManager;
let sidebar;
try {
  sidebarManager = new CerebrSidebarManager();
  sidebar = sidebarManager.getPrimarySidebar();
  // console.log('侧边栏实例已创建');
} catch (error) {
  console.error('创建侧边栏实例失败:', error);
}
// 创建选择器实例
const picker = new ElementPicker({
  highlightColor: 'rgba(255, 0, 0, 0.3)',
  zIndex: 10000
});

function getActiveSidebar() {
  return sidebarManager?.getActiveSidebar?.() || sidebar || null;
}

function getSidebarForInternalRequest(message) {
  const fromMessage = sidebarManager?.getSidebarById?.(message?.sidebarInstanceId);
  return fromMessage || getActiveSidebar();
}

// 修改消息监听器
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type != 'PING') {
    // console.log('content.js 收到消息:', message.type);
  }

  // 处理 PING 消息
  if (message.type === 'PING') {
    sendResponse(true);
    return true;
  }

  // 检查侧边栏实例是否存在
  if (!sidebar) {
    console.error('侧边栏实例不存在');
    sendResponse({ success: false, error: 'Sidebar instance not found' });
    return true;
  }

  // 处理获取页面类型请求
  if (message.type === 'GET_DOCUMENT_TYPE') {
    sendResponse({ contentType: document.contentType });
    return true;
  }

  if (message.type === 'GET_PAGE_CONTENT_READ_RESULT_INTERNAL') {
    console.log('收到 page_content_read 结果请求');
    const pageReadSidebar = getSidebarForInternalRequest(message);
    if (pageReadSidebar) sidebarManager?.setActiveSidebar?.(pageReadSidebar);
    isProcessing = true;

    extractPageContent(pageReadSidebar, message?.args).then((content) => {
      isProcessing = false;
      sendResponse(buildPageContentReadResultForTransport(content, message?.args));
    }).catch((error) => {
      console.error('构造 page_content_read 结果失败:', error);
      isProcessing = false;
      sendResponse({
        ok: false,
        error: {
          message: error?.message || '构造 page_content_read 结果失败',
          name: error?.name || 'PageContentReadTransportError'
        }
      });
    });

    return true;
  }

  if (message.type === 'GET_PDF_CONTENT_READ_RESULT_INTERNAL') {
    console.log('收到 pdf_content_read 结果请求');
    const pdfReadSidebar = getSidebarForInternalRequest(message);
    if (pdfReadSidebar) sidebarManager?.setActiveSidebar?.(pdfReadSidebar);
    isProcessing = true;

    extractPageContent(pdfReadSidebar).then((content) => {
      isProcessing = false;
      sendResponse(buildPdfContentReadResultForTransport(content, message?.args));
    }).catch((error) => {
      console.error('构造 pdf_content_read 结果失败:', error);
      isProcessing = false;
      sendResponse({
        ok: false,
        error: {
          message: error?.message || '构造 pdf_content_read 结果失败',
          name: error?.name || 'PdfContentReadTransportError'
        }
      });
    });

    return true;
  }

  if (message.type === 'GET_WEBPAGE_SCREENSHOT_RESULT_INTERNAL') {
    console.log('收到 webpage_screenshot 结果请求');
    const screenshotSidebar = getSidebarForInternalRequest(message);
    if (screenshotSidebar) sidebarManager?.setActiveSidebar?.(screenshotSidebar);
    isProcessing = true;

    capturePromptFriendlyScreenshot(message?.args, screenshotSidebar).then((result) => {
      isProcessing = false;
      sendResponse(result);
    }).catch((error) => {
      console.error('构造网页截图工具结果失败:', error);
      isProcessing = false;
      sendResponse({
        ok: false,
        error: {
          message: error?.message || '构造网页截图工具结果失败',
          name: error?.name || 'WebpageScreenshotTransportError'
        }
      });
    });

    return true;
  }

  try {
    // 接收来自background.js的消息
    const targetSidebar = getActiveSidebar();
    if (!targetSidebar) {
      sendResponse({ success: false, error: 'Active sidebar instance not found' });
      return true;
    }

    switch (message.type) {
      case 'TOGGLE_SIDEBAR_onClicked':
        sidebarManager?.toggleAllSidebars?.();
        break;
      case 'OPEN_SIDEBAR':
        sidebarManager?.setAllSidebarsVisible?.(true);
        break;
      case 'CLOSE_SIDEBAR':
        sidebarManager?.setAllSidebarsVisible?.(false);
        break;
      case 'RELOAD_SIDEBAR_IFRAME_FROM_BACKGROUND':
        {
          const reloadResult = sidebarManager?.reloadActiveSidebarIframe?.() || targetSidebar.reloadIframe();
          sendResponse({
            success: reloadResult?.success === true,
            status: targetSidebar.isVisible,
            activeSidebarId: reloadResult?.instanceId || targetSidebar.instanceId,
            reloadResult
          });
        }
        return true;
      case 'GET_SIDEBAR_DEBUG_STATE':
        {
          const activeDebugState = targetSidebar.getDebugState();
          const instances = (sidebarManager?.sidebars || [targetSidebar]).map((item) => ({
            instanceId: item.instanceId,
            isActive: item.instanceId === targetSidebar.instanceId,
            ...item.getDebugState()
          }));
        sendResponse({
          success: true,
          debugState: {
            ...activeDebugState,
            activeSidebarId: targetSidebar.instanceId,
            sidebarCount: sidebarManager?.sidebars?.length || 1,
            active: activeDebugState,
            instances
          }
        });
        }
        return true;
      case 'TOGGLE_FULLSCREEN_FROM_BACKGROUND':
        sidebarManager?.toggleFullscreenForSidebar?.(targetSidebar);
        break;
      case 'QUICK_SUMMARY':
        targetSidebar.toggle(true);  // 明确传入 true 表示打开
        let selectedContent = currentSelection;
        targetSidebar.postToIframe({
            type: 'QUICK_SUMMARY_COMMAND',
            selectedContent: selectedContent
        });
        break;
      case 'QUICK_SUMMARY_QUERY':
        targetSidebar.toggle(true);  // 明确传入 true 表示打开
        let selectedContentQuery = currentSelection;
        targetSidebar.postToIframe({
            type: 'QUICK_SUMMARY_COMMAND_QUERY',
            selectedContent: selectedContentQuery
        });
        break;
      case 'CLEAR_CHAT':
        targetSidebar.postToIframe({ type: 'CLEAR_CHAT_COMMAND' });
        break;
      case 'TOGGLE_TEMP_MODE':
        targetSidebar.postToIframe({ type: 'TOGGLE_TEMP_MODE_FROM_EXTENSION' });
        break;
      case 'EXPLAIN_IMAGE':
        if (message.imageData) {
          targetSidebar.postToIframe({
            type: 'DROP_IMAGE',
            imageData: message.imageData,
            explain: true
          });
        }
        break;
      case 'CAPTURE_SCREENSHOT':
        captureAndDropScreenshot(targetSidebar);
        break;
      case 'ADD_PAGE_CONTENT_TO_CONTEXT':
        try {
          // 确保侧边栏已打开
          targetSidebar.toggle(true);

          // 显示占位提示
          try { sendPlaceholderUpdate('正在获取网页内容...', 0, targetSidebar); } catch (_) {}

          // 复用现有提取函数
          extractPageContent(targetSidebar)
            .then(content => {
              if (!content || !content.title || !content.url || !content.content) return;

              const composed = `已附加网页内容：\n标题：${content.title}\nURL：${content.url}\n内容：${content.content}`;

              targetSidebar.postToIframe({
                type: 'ADD_TEXT_TO_CONTEXT',
                text: composed
              });

              // 恢复占位
              try { sendPlaceholderUpdate('已添加网页内容到历史（未发送）', 2000, targetSidebar); } catch (_) {}
            })
            .catch(err => {
              console.error('通过快捷键添加网页内容失败:', err);
              try { sendPlaceholderUpdate('提取网页内容失败', 2000, targetSidebar); } catch (_) {}
            });
        } catch (e) {
          console.error('处理 ADD_PAGE_CONTENT_TO_CONTEXT 失败:', e);
        }
        break;
    }

    sendResponse({ success: true, status: targetSidebar.isVisible, activeSidebarId: targetSidebar.instanceId });
  } catch (error) {
    console.error(`处理${message.type}命令失败:`, error);
    sendResponse({ success: false, error: error.message });
  }
  return true;
});

const port = chrome.runtime.connect({ name: 'cerebr-sidebar' });
port.onDisconnect.addListener(() => {
  console.log('与 background 的连接已断开');
});

function sendInitMessage(retryCount = 0) {
  const maxRetries = 10;
  const retryDelay = 1000;

  // console.log(`尝试发送初始化消息，第 ${retryCount + 1} 次尝试`);

  chrome.runtime.sendMessage({
    type: 'CONTENT_LOADED',
    url: window.location.href
  }).then(response => {
    // console.log('Background 响应:', response);
  }).catch(error => {
    console.log('发送消息失败:', error);
    if (retryCount < maxRetries) {
      // console.log(`${retryDelay}ms 后重试...`);
      setTimeout(() => sendInitMessage(retryCount + 1), retryDelay);
    } else {
      console.error('达最大重试次数，初始化消息发送失败');
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(sendInitMessage, 500);
  });
} else {
  setTimeout(sendInitMessage, 500);
}

// ========================================================================
//  启动选区监听 (添加到 content.js 文件末尾)
// ========================================================================

function startSelectionMonitoring() {
  // 1. 为顶层主窗口附加监听器
  console.log('[Cerebr Selection] Attaching listener to the main window.');
  document.addEventListener('selectionchange', handleGlobalSelectionChange);

  // 2. 启动一个定时器，持续扫描新出现的 iframe
  console.log('[Cerebr Selection] Starting generic iframe scanner...');
  setInterval(monitorNewFrames, 1500); // 每 1.5 秒扫描一次
}

// 确保在所有初始化逻辑后启动监听
startSelectionMonitoring();

// window.addEventListener('error', (event) => {
//   console.error('全局错误:', event.error);
// });

window.addEventListener('unhandledrejection', (event) => {
  console.error('未处理的 Promise 拒绝:', event.reason);
});

// PDF 内容缓存
const pdfContentCache = new Map();

/**
 * 提取重要的DOM结构（移除不需要的元素），仅保留对内容有意义的部分
 * @returns {string} 清理后的DOM结构的outerHTML
 */
function extractImportantDOM() {
  const clone = document.body.cloneNode(true);
  const selectorsToRemove = [
    'script', 'style', 'nav', 'header', 'footer',
    'iframe', 'noscript', 'video',
    '[role="complementary"]', '[role="navigation"]',
    '.sidebar', '.nav', '.footer', '.header',
    '.immersive-translate-target-inner', 'img', 'svg',
    '#pagetual-sideController'
  ];
  selectorsToRemove.forEach(selector => {
    clone.querySelectorAll(selector).forEach(el => el.remove());
  });
  
  // 遍历所有元素，清理每个节点的属性，仅保留允许的属性（例如只保留 id、class、href、title、placeholder、alt）
  const allowedAttributes = new Set(['id', 'class', 'href', 'title', 'placeholder', 'alt']);
  [clone, ...clone.querySelectorAll('*')].forEach(el => {
    for (let i = el.attributes.length - 1; i >= 0; i--) {
      const attr = el.attributes[i];
      if (!allowedAttributes.has(attr.name)) {
        el.removeAttribute(attr.name);
      }
    }
  });

  // 添加：删除所有注释节点（这些注释会被序列化为转义字符如 \x3C!--css-build:shady--> ）
  const commentWalker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT, null, false);
  let commentNode;
  while (commentNode = commentWalker.nextNode()) {
    commentNode.parentNode.removeChild(commentNode);
  }

  return clone.outerHTML;
}

function isCurrentPagePdfLike() {
  const currentUrl = typeof window.location?.href === 'string' ? window.location.href : '';
  const lowerUrl = currentUrl.toLowerCase();
  return document.contentType === 'application/pdf'
    || lowerUrl.includes('.pdf')
    || !!document.querySelector('iframe[src*="pdf.js"], iframe[src*=".pdf"]');
}

const PAGE_CONTENT_READ_DEFAULT_RANGE_CHARS = 10_000;
const PAGE_CONTENT_READ_MAX_CHARS = 50_000;
const PDF_CONTENT_READ_DEFAULT_MAX_CHARS = 10_000;
const PDF_CONTENT_READ_MAX_CHARS = 50_000;

function clampNonNegativeInt(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.trunc(numeric));
}

function clampPositiveInt(value, fallback, max = Infinity) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return Math.min(max, fallback);
  }
  return Math.max(1, Math.min(max, Math.trunc(numeric)));
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function formatPercent(numerator, denominator) {
  const safeNumerator = Number(numerator);
  const safeDenominator = Number(denominator);
  if (!Number.isFinite(safeNumerator) || !Number.isFinite(safeDenominator) || safeDenominator <= 0) {
    return 0;
  }
  return Number(((safeNumerator / safeDenominator) * 100).toFixed(2));
}

function normalizePageContentReadTextForTransport(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePageContentReadArgsForTransport(rawArgs) {
  const args = isPlainObject(rawArgs) ? rawArgs : {};
  const skipChars = clampNonNegativeInt(args.skip_chars, 0);
  const maxChars = (args.max_chars == null)
    ? null
    : Math.max(
      1,
      Math.min(
        PAGE_CONTENT_READ_MAX_CHARS,
        clampNonNegativeInt(args.max_chars, PAGE_CONTENT_READ_DEFAULT_RANGE_CHARS)
      )
    );
  return {
    skipChars,
    maxChars,
    includeImageUrls: args.include_image_urls === true
  };
}

function normalizeImageReferenceListForTransport(value) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      const url = typeof item.url === 'string' ? item.url.trim() : '';
      const title = typeof item.title === 'string' ? item.title.trim() : '';
      if (!/^img-\d+$/.test(id) || !/^https?:\/\//i.test(url)) return null;
      return { id, title, url };
    })
    .filter(Boolean);
}

function collectReferencedImageIdsForTransport(text) {
  const source = typeof text === 'string' ? text : '';
  const ids = [];
  const seen = new Set();
  const pattern = /\[[^\]\n]{1,200}\]\[(img-\d+)\]/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function appendImageReferenceAppendixForTransport(content, imageReferences) {
  const body = typeof content === 'string' ? content : '';
  const references = normalizeImageReferenceListForTransport(imageReferences);
  if (!body || references.length <= 0) {
    return {
      content: body,
      imageReferenceCount: 0
    };
  }

  const referencedIds = new Set(collectReferencedImageIdsForTransport(body));
  if (referencedIds.size <= 0) {
    return {
      content: body,
      imageReferenceCount: 0
    };
  }

  const lines = references
    .filter((item) => referencedIds.has(item.id))
    .map((item) => `[${item.id}]: ${item.url}`);
  if (lines.length <= 0) {
    return {
      content: body,
      imageReferenceCount: 0
    };
  }

  return {
    content: `${body}\n\n${lines.join('\n')}`,
    imageReferenceCount: lines.length
  };
}

function buildPageContentReadResultForTransport(pageContent, rawArgs) {
  const title = typeof pageContent?.title === 'string' ? pageContent.title.trim() : '';
  const url = typeof pageContent?.url === 'string' ? pageContent.url.trim() : '';
  const { skipChars, maxChars, includeImageUrls } = normalizePageContentReadArgsForTransport(rawArgs);
  const contentSource = includeImageUrls && typeof pageContent?.content_with_image_refs === 'string'
    ? pageContent.content_with_image_refs
    : pageContent?.content || '';
  const normalizedText = normalizePageContentReadTextForTransport(contentSource);
  const totalChars = normalizedText.length;
  const hasExplicitRange = skipChars > 0 || maxChars !== null;
  const sourceImageReferences = includeImageUrls ? pageContent?.image_references : [];

  if (!normalizedText) {
    return {
      ok: false,
      title,
      url,
      total_chars: 0,
      error: {
        message: '当前页面未提取到可读文本。',
        name: 'EmptyPageContentError'
      }
    };
  }

  if (!hasExplicitRange) {
    const effectiveMaxChars = PAGE_CONTENT_READ_DEFAULT_RANGE_CHARS;
    const end = Math.min(totalChars, effectiveMaxChars);
    const selectedContent = normalizedText.slice(0, end);
    const appendixResult = appendImageReferenceAppendixForTransport(selectedContent, sourceImageReferences);
    const omittedChars = Math.max(0, totalChars - selectedContent.length);
    return {
      ok: true,
      mode: 'preview',
      title,
      url,
      normalized_whitespace: true,
      extraction_scope: 'page_plus_accessible_iframe_text',
      total_chars: totalChars,
      max_chars: effectiveMaxChars,
      returned_chars: selectedContent.length,
      omitted_chars: omittedChars,
      omitted_pct: formatPercent(omittedChars, totalChars),
      truncated: omittedChars > 0,
      has_more_after_range: end < totalChars,
      next_skip_chars: end < totalChars ? end : null,
      include_image_urls: includeImageUrls,
      image_reference_count: appendixResult.imageReferenceCount,
      content: appendixResult.content
    };
  }

  const effectiveMaxChars = maxChars ?? PAGE_CONTENT_READ_DEFAULT_RANGE_CHARS;
  const start = Math.min(skipChars, totalChars);
  const end = Math.min(totalChars, start + effectiveMaxChars);
  const selectedContent = normalizedText.slice(start, end);
  const appendixResult = appendImageReferenceAppendixForTransport(selectedContent, sourceImageReferences);
  const omittedChars = Math.max(0, totalChars - selectedContent.length);

  return {
    ok: true,
    mode: 'range',
    title,
    url,
    normalized_whitespace: true,
    extraction_scope: 'page_plus_accessible_iframe_text',
    total_chars: totalChars,
    skip_chars: start,
    max_chars: effectiveMaxChars,
    returned_chars: selectedContent.length,
    omitted_chars: omittedChars,
    omitted_pct: formatPercent(omittedChars, totalChars),
    truncated: omittedChars > 0,
    has_more_after_range: end < totalChars,
    next_skip_chars: end < totalChars ? end : null,
    include_image_urls: includeImageUrls,
    image_reference_count: appendixResult.imageReferenceCount,
    content: appendixResult.content
  };
}

function normalizePdfContentReadTextForTransport(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trim().replace(/\s+/g, ' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizePdfContentReadArgsForTransport(rawArgs) {
  const args = isPlainObject(rawArgs) ? rawArgs : {};
  const chapterId = typeof args.chapter_id === 'string' ? args.chapter_id.trim() : '';
  const hasExplicitChunkRequest = !!chapterId || args.chunk_index != null || args.max_chars != null;
  return {
    chapterId: chapterId || null,
    chunkIndex: clampNonNegativeInt(args.chunk_index, 0),
    maxChars: clampPositiveInt(args.max_chars, PDF_CONTENT_READ_DEFAULT_MAX_CHARS, PDF_CONTENT_READ_MAX_CHARS),
    includeOutline: args.include_outline === true,
    hasExplicitChunkRequest
  };
}

function countPdfChunksByCharsForTransport(textLength, maxChars) {
  if (!Number.isFinite(textLength) || textLength <= 0) return 0;
  return Math.ceil(textLength / maxChars);
}

function normalizePdfChapterTreeForTransport(rawChapters, parentChapterId = null, level = 1) {
  const chapters = Array.isArray(rawChapters) ? rawChapters : [];
  return chapters
    .map((item, index) => {
      const chapterId = parentChapterId ? `${parentChapterId}.${index + 1}` : `${index + 1}`;
      const children = normalizePdfChapterTreeForTransport(item?.children, chapterId, level + 1);
      const content = normalizePdfContentReadTextForTransport(item?.content || '');
      const pageNumber = Number.isFinite(Number(item?.pageNumber)) && Number(item.pageNumber) >= 1
        ? Math.trunc(Number(item.pageNumber))
        : null;
      const title = typeof item?.chapterTitle === 'string' && item.chapterTitle.trim()
        ? item.chapterTitle.trim()
        : `未命名章节 ${chapterId}`;

      return {
        chapter_id: chapterId,
        parent_chapter_id: parentChapterId,
        level,
        title,
        page_number: pageNumber,
        content,
        char_count: content.length,
        children,
        child_count: children.length
      };
    })
    .filter(item => item.char_count > 0 || item.child_count > 0 || !!item.title);
}

function buildSyntheticFullDocumentChapterForTransport(fullText) {
  return [
    {
      chapter_id: '1',
      parent_chapter_id: null,
      level: 1,
      title: '全文',
      page_number: 1,
      content: fullText,
      char_count: fullText.length,
      children: [],
      child_count: 0
    }
  ];
}

function flattenPdfChapterTreeForTransport(chapters) {
  const flat = [];
  const walk = (items) => {
    for (const item of items) {
      flat.push(item);
      if (Array.isArray(item.children) && item.children.length > 0) {
        walk(item.children);
      }
    }
  };
  walk(Array.isArray(chapters) ? chapters : []);
  return flat;
}

function buildPdfContentReadErrorForTransport(pageContent, message, name) {
  const title = typeof pageContent?.title === 'string' ? pageContent.title.trim() : '';
  const url = typeof pageContent?.url === 'string' ? pageContent.url.trim() : '';
  return {
    ok: false,
    title,
    url,
    is_pdf: pageContent?.isPDF === true,
    error: {
      message,
      name
    }
  };
}

function buildPdfOutlineEntriesForTransport(flatOutline, maxChars) {
  return flatOutline.map((chapter) => ({
    chapter_id: chapter.chapter_id,
    parent_chapter_id: chapter.parent_chapter_id,
    level: chapter.level,
    title: chapter.title,
    page_number: chapter.page_number,
    child_count: chapter.child_count,
    char_count: chapter.char_count,
    chunk_count: countPdfChunksByCharsForTransport(chapter.char_count, maxChars)
  }));
}

function slicePdfChunkTextForTransport(text, chunkIndex, maxChars, errorName, scopeLabel) {
  const totalChars = text.length;
  const totalChunks = countPdfChunksByCharsForTransport(totalChars, maxChars);
  if (totalChunks <= 0) {
    return {
      ok: false,
      error: {
        message: `${scopeLabel}没有可读取的正文文本。`,
        name: errorName
      }
    };
  }
  if (chunkIndex >= totalChunks) {
    return {
      ok: false,
      error: {
        message: `${scopeLabel}片段索引越界：chunk_index=${chunkIndex}，但当前只存在 ${totalChunks} 个片段（0-${totalChunks - 1}）。`,
        name: errorName
      }
    };
  }

  const start = chunkIndex * maxChars;
  const end = Math.min(totalChars, start + maxChars);
  return {
    ok: true,
    chunk_index: chunkIndex,
    max_chars: maxChars,
    returned_chars: end - start,
    total_chunks: totalChunks,
    has_prev_chunk: chunkIndex > 0,
    has_next_chunk: chunkIndex < totalChunks - 1,
    prev_chunk_index: chunkIndex > 0 ? chunkIndex - 1 : null,
    next_chunk_index: chunkIndex < totalChunks - 1 ? chunkIndex + 1 : null,
    content: text.slice(start, end)
  };
}

function buildPdfContentReadResultForTransport(pageContent, rawArgs) {
  if (pageContent?.isPDF !== true) {
    return buildPdfContentReadErrorForTransport(pageContent, '当前页面不是 PDF，不能使用 pdf_content_read。', 'NotPdfPageError');
  }

  const title = typeof pageContent?.title === 'string' ? pageContent.title.trim() : '';
  const url = typeof pageContent?.url === 'string' ? pageContent.url.trim() : '';
  const fullText = normalizePdfContentReadTextForTransport(pageContent?.content || '');
  if (!fullText) {
    return buildPdfContentReadErrorForTransport(pageContent, '当前 PDF 未提取到可读文本。', 'EmptyPdfContentError');
  }

  const args = normalizePdfContentReadArgsForTransport(rawArgs);
  const normalizedTree = normalizePdfChapterTreeForTransport(pageContent?.chapters);
  const chapterTree = normalizedTree.length > 0 ? normalizedTree : buildSyntheticFullDocumentChapterForTransport(fullText);
  const flatOutline = flattenPdfChapterTreeForTransport(chapterTree);
  const outline = buildPdfOutlineEntriesForTransport(flatOutline, args.maxChars);
  const totalChars = fullText.length;

  if (!args.hasExplicitChunkRequest) {
    return {
      ok: true,
      mode: 'overview',
      title,
      url,
      is_pdf: true,
      total_chars: totalChars,
      total_chapters: outline.length,
      root_chapter_count: chapterTree.length,
      default_max_chars: args.maxChars,
      outline_chunk_chars: args.maxChars,
      max_chars_limit: PDF_CONTENT_READ_MAX_CHARS,
      document_chunk_count_default: countPdfChunksByCharsForTransport(totalChars, args.maxChars),
      outline,
      guidance: '先从 outline 里选择 chapter_id；读章节正文时传 chapter_id + chunk_index；顺序通读整篇 PDF 时只传 chunk_index。注意：父章节正文通常包含其子章节页范围。'
    };
  }

  if (args.chapterId) {
    const chapter = flatOutline.find(item => item.chapter_id === args.chapterId);
    if (!chapter) {
      return buildPdfContentReadErrorForTransport(pageContent, `chapter_id=${args.chapterId} 不存在，请先查看 overview 返回的 outline。`, 'PdfChapterNotFoundError');
    }

    const sliced = slicePdfChunkTextForTransport(
      chapter.content,
      args.chunkIndex,
      args.maxChars,
      'PdfChapterChunkOutOfRangeError',
      `章节 ${chapter.title}`
    );
    if (!sliced.ok) {
      return {
        ok: false,
        title,
        url,
        is_pdf: true,
        error: sliced.error
      };
    }

    return {
      ok: true,
      mode: 'chapter_chunk',
      title,
      url,
      is_pdf: true,
      total_chars: totalChars,
      max_chars: args.maxChars,
      outline_chunk_chars: args.includeOutline ? args.maxChars : undefined,
      chunk_index: sliced.chunk_index,
      returned_chars: sliced.returned_chars,
      total_chunks: sliced.total_chunks,
      has_prev_chunk: sliced.has_prev_chunk,
      has_next_chunk: sliced.has_next_chunk,
      prev_chunk_index: sliced.prev_chunk_index,
      next_chunk_index: sliced.next_chunk_index,
      selection: {
        chapter_id: chapter.chapter_id,
        parent_chapter_id: chapter.parent_chapter_id,
        level: chapter.level,
        title: chapter.title,
        page_number: chapter.page_number,
        char_count: chapter.char_count,
        chunk_count: countPdfChunksByCharsForTransport(chapter.char_count, args.maxChars),
        child_count: chapter.child_count
      },
      outline: args.includeOutline ? outline : undefined,
      content: sliced.content
    };
  }

  const sliced = slicePdfChunkTextForTransport(
    fullText,
    args.chunkIndex,
    args.maxChars,
    'PdfDocumentChunkOutOfRangeError',
    '整篇 PDF'
  );
  if (!sliced.ok) {
    return {
      ok: false,
      title,
      url,
      is_pdf: true,
      error: sliced.error
    };
  }

  return {
    ok: true,
    mode: 'document_chunk',
    title,
    url,
    is_pdf: true,
    total_chars: totalChars,
    max_chars: args.maxChars,
    outline_chunk_chars: args.includeOutline ? args.maxChars : undefined,
    chunk_index: sliced.chunk_index,
    returned_chars: sliced.returned_chars,
    total_chunks: sliced.total_chunks,
    has_prev_chunk: sliced.has_prev_chunk,
    has_next_chunk: sliced.has_next_chunk,
    prev_chunk_index: sliced.prev_chunk_index,
    next_chunk_index: sliced.next_chunk_index,
    outline: args.includeOutline ? outline : undefined,
    content: sliced.content
  };
}

async function extractPageContent(targetSidebar = null, rawArgs = null) {
  console.log('extractPageContent 开始提取页面内容');
  const pageReadArgs = normalizePageContentReadArgsForTransport(rawArgs);

  // 在提取开始时冻结页面元数据快照，保证 URL/标题 与本次内容抓取使用同一时间点。
  const snapshotUrl = window.location.href;
  const snapshotTitle = document.title || snapshotUrl;

  // 检查是否是PDF或者iframe中的PDF
  if (isCurrentPagePdfLike()) {
    console.log('检测到PDF文件，尝试提取PDF内容');
    
    let pdfUrl = window.location.href;
    
    // 如果是iframe中的PDF，尝试提取实际的PDF URL
    const pdfIframe = document.querySelector('iframe[src*="pdf.js"]') || document.querySelector('iframe[src*=".pdf"]');
    if (pdfIframe) {
      const iframeSrc = pdfIframe.src;
      // 尝试从iframe src中提取实际的PDF URL
      const urlMatch = iframeSrc.match(/[?&]file=([^&]+)/);
      if (urlMatch) {
        pdfUrl = decodeURIComponent(urlMatch[1]);
        console.log('从iframe中提取到PDF URL:', pdfUrl);
      }
    }

    // 检查缓存
    if (pdfContentCache.has(pdfUrl)) {
      console.log('从缓存中获取PDF内容');
      const cachedContent = pdfContentCache.get(pdfUrl);
      // 验证缓存内容是否有效
      if (cachedContent && typeof cachedContent.url === 'string' && typeof cachedContent.title === 'string' && typeof cachedContent.content === 'string') {
        return cachedContent;
      } else {
        console.warn('缓存的PDF内容无效，移除缓存并重新提取', cachedContent);
        pdfContentCache.delete(pdfUrl); // 移除无效条目
        // 继续执行提取逻辑
      }
    }

    console.log('缓存中没有找到PDF内容或缓存无效，开始提取');
    const pdfResult = await extractTextFromPDF(pdfUrl, targetSidebar); // pdfResult 是 { fullText, chapters } 或 null
    if (pdfResult && typeof pdfResult.fullText === 'string') {
      console.log('将PDF内容存入缓存');
      const resultToCache = {
        title: snapshotTitle || pdfUrl,
        url: pdfUrl,
        content: pdfResult.fullText, // 已知为字符串
        chapters: pdfResult.chapters || [], // 为章节提供备用值
        isPDF: true
      };
      pdfContentCache.set(pdfUrl, resultToCache);
      return resultToCache;
    } else {
      console.error(`extractTextFromPDF 对 ${pdfUrl} 返回 null 或无效结果。`);
      // 明确返回 null 以指示提取失败
      return null; 
    }
  }

  // 执行HTML页面内容提取逻辑
  console.log('非PDF，执行HTML页面内容提取逻辑（包含Shadow DOM支持）');


  const textSegments = [];
  const imageReferences = [];
  const imageReferenceByUrl = new Map();
  // 选择器，用于跳过不应提取文本的元素
  // 标签名选择器（小写）
  const tagSelectorsToSkip = [
    'script', 'style', 'noscript', 'canvas', 'video', 'audio', 'embed', 'object',
    'img', 'svg', 'map', 'area', 'track', 'applet',
    'nav', 'footer', 'header', 'aside', // 常见的非主要内容区域
    'iframe', // iframe 由后续的专用逻辑处理
    'cerebr-root' // 跳过扩展自身的UI根元素
  ];
  // CSS选择器 (用于 element.matches)
  const cssSelectorsToSkip = [
    '[role="complementary"]', '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="search"]',
    '[aria-hidden="true"]', // 跳过明确标记为隐藏的元素
    // '.sidebar', '.nav', '.menu', '.toc', '.pagination', '.breadcrumb', '.toolbar', '.status-bar',
    '.footer', '.header', // 常见的类名
    '.ad', '.ads', '.advertisement', '[class*="advert"]', '[id*="advert"]', // 广告
    // '.popup', '.modal', '.dialog', '[role="dialog"]', '[role="alertdialog"]', // 弹窗和对话框
    '.immersive-translate-target-inner', // 项目特定的类
    '[data-nosnippet]' // Google no-snippet attribute
  ];

  function sanitizeMarkdownReferenceTitle(value) {
    return String(value ?? '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[\[\]]/g, '')
      .trim();
  }

  function getImageFilenameFromUrl(url) {
    try {
      const parsed = new URL(url);
      const tail = parsed.pathname.split('/').filter(Boolean).pop() || '';
      return decodeURIComponent(tail).trim();
    } catch (_) {
      return '';
    }
  }

  function resolveReadableImageUrl(img) {
    if (!img || img.nodeType !== Node.ELEMENT_NODE) return '';
    const raw = img.currentSrc
      || img.src
      || img.getAttribute('src')
      || '';
    if (!raw || typeof raw !== 'string') return '';
    try {
      const baseUrl = img.ownerDocument?.baseURI || snapshotUrl;
      const resolved = new URL(raw, baseUrl);
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return '';
      return resolved.href;
    } catch (_) {
      return '';
    }
  }

  function resolveImageReferenceTitle(img, url) {
    const fromAttributes = [
      img?.getAttribute?.('alt'),
      img?.getAttribute?.('title'),
      img?.getAttribute?.('aria-label')
    ];
    for (const value of fromAttributes) {
      const title = sanitizeMarkdownReferenceTitle(value);
      if (title) return title;
    }

    try {
      const figcaption = img.closest('figure')?.querySelector?.('figcaption');
      const caption = sanitizeMarkdownReferenceTitle(figcaption?.textContent || '');
      if (caption) return caption;
    } catch (_) {}

    const filename = sanitizeMarkdownReferenceTitle(getImageFilenameFromUrl(url));
    return filename || 'Image';
  }

  function isElementVisiblyRendered(element, ownerWindow = window) {
    try {
      const computedStyle = ownerWindow.getComputedStyle(element);
      return computedStyle.display !== 'none' && computedStyle.visibility !== 'hidden';
    } catch (_) {
      return true;
    }
  }

  function appendImageReferenceSegment(img, segments, ownerWindow = window) {
    if (!pageReadArgs.includeImageUrls || !isElementVisiblyRendered(img, ownerWindow)) return;
    const url = resolveReadableImageUrl(img);
    if (!url) return;

    let reference = imageReferenceByUrl.get(url);
    if (!reference) {
      reference = {
        id: `img-${imageReferences.length + 1}`,
        title: resolveImageReferenceTitle(img, url),
        url
      };
      imageReferenceByUrl.set(url, reference);
      imageReferences.push(reference);
    }

    segments.push(`[${reference.title}][${reference.id}]`);
  }

  function shouldSkipElement(element, ownerWindow = window) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }
    const tagName = element.tagName.toLowerCase();
    if (tagSelectorsToSkip.includes(tagName)) {
      return true;
    }
    try {
      if (cssSelectorsToSkip.some(selector => element.matches(selector))) {
        return true;
      }
    } catch (e) {
      // console.warn('Error matching selector for skip:', element.tagName, e.message);
    }
    // 检查计算样式是否为 display: none
    if (!isElementVisiblyRendered(element, ownerWindow)) {
        // console.log('Skipping non-visible element:', element.tagName, element.id, element.className);
        return true;
    }
    return false;
  }

  function extractTextRecursively(node, ownerWindow = window, segments = textSegments) {
    if (node?.nodeType === Node.ELEMENT_NODE && node.tagName?.toLowerCase() === 'img') {
      appendImageReferenceSegment(node, segments, ownerWindow);
      return;
    }

    if (shouldSkipElement(node, ownerWindow)) {
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const trimmedText = node.textContent.trim();
      if (trimmedText) {
        segments.push(trimmedText);
      }
    } else if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      // 优先处理 Light DOM 子节点
      for (const child of node.childNodes) {
        extractTextRecursively(child, ownerWindow, segments);
      }
      // 然后处理 Shadow DOM (仅对 Element 节点)
      if (node.nodeType === Node.ELEMENT_NODE && node.shadowRoot && node.shadowRoot.mode === 'open') {
        // console.log('Extracting from open shadowRoot of:', node.tagName);
        for (const shadowChild of node.shadowRoot.childNodes) {
          extractTextRecursively(shadowChild, ownerWindow, segments);
        }
      }
    }
  }

  // 从 document.body 开始递归提取文本
  extractTextRecursively(document.body, window, textSegments);

  let mainContent = textSegments.join(' ').replace(/\s+/g, ' ').trim();

  // 新增：提取 iframe 内容 (此部分逻辑基本不变，但主内容提取已包含 Shadow DOM)
  let iframeContent = '';
  const iframes = document.querySelectorAll('iframe');
  console.log('页面中的iframe数量:', iframes.length);
  for (const iframe of iframes) {
    // 跳过Cerebr侧边栏的iframe
    if (iframe.classList.contains('cerebr-sidebar__iframe')) {
        console.log('跳过Cerebr侧边栏的iframe:', iframe.id || iframe.className);
        continue;
    }
    console.log('尝试处理iframe:', iframe.id || iframe.src);
    try {
      // 检查iframe是否可访问
      if (iframe.contentDocument || iframe.contentWindow) {
        const iframeDocument = iframe.contentDocument || iframe.contentWindow.document;
        // 确保iframe body存在
        if (iframeDocument && iframeDocument.body) {
          const iframeBodyStyle = iframe.contentWindow.getComputedStyle(iframeDocument.body);
          if (iframeBodyStyle.display === 'none' || iframeBodyStyle.visibility === 'hidden') {
            console.log('跳过隐藏或不可见的iframe body:', iframe.id || iframe.src);
            continue;
          }
          const iframeSegments = [];
          extractTextRecursively(iframeDocument.body, iframe.contentWindow, iframeSegments);
          const content = iframeSegments.join(' ').replace(/\s+/g, ' ').trim();
          if (content && content.trim()) {
            console.log('成功从iframe中提取内容 (前100字符):', content.substring(0,100) + "...");
            iframeContent += content.trim() + '\n\n'; // 添加换行符分隔不同iframe的内容
          } else {
            console.log('iframe内容为空:', iframe.id || iframe.src);
          }
        } else {
          console.log('无法访问iframe的body:', iframe.id || iframe.src);
        }
      } else {
         console.log('无法访问iframe的document或window对象:', iframe.id || iframe.src);
      }
    } catch (e) {
      console.warn('无法访问该iframe内容 (可能是跨域):', iframe.id || iframe.src, e.message);
    }
  }

  if (iframeContent) {
    mainContent += '\n\n--- iFrame Content ---\n\n' + iframeContent.trim();
  }
  
  const result = {
    title: snapshotTitle,
    url: snapshotUrl, // 使用提取开始时冻结的页面 URL
    content: mainContent,
    content_with_image_refs: pageReadArgs.includeImageUrls ? mainContent : '',
    image_references: pageReadArgs.includeImageUrls ? imageReferences : [],
    selectedText: currentSelection
  };
  
  // console.log('最终提取的内容 (前200字符):', result.content.substring(0,200));
  return result;
}


function sendPlaceholderUpdate(message, timeout = 0, targetSidebar = null) {
  console.log('发送placeholder更新:', message);
  const sidebarInstance = targetSidebar || getActiveSidebar();
  sidebarInstance?.postToIframe?.({
    type: 'UPDATE_PLACEHOLDER',
    placeholder: message,
    timeout: timeout
  });
};

// PDF.js 库的路径
const PDFJS_PATH = chrome.runtime.getURL('lib/pdf.js');
const PDFJS_WORKER_PATH = chrome.runtime.getURL('lib/pdf.worker.js');

// 设置 PDF.js worker 路径
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_PATH;

async function downloadPDFData(url, targetSidebar = null) {
  console.log('开始下载PDF:', url);
  // 获取PDF文件的初始信息
  const initResponse = await chrome.runtime.sendMessage({
    action: 'downloadPDF',
    url: url
  });

  if (!initResponse.success) {
    console.error('PDF初始化失败，响应:', initResponse);
    sendPlaceholderUpdate('PDF下载失败', 2000, targetSidebar);
    throw new Error('PDF初始化失败');
  }

  const { totalChunks, totalSize } = initResponse;
  console.log(`PDF文件大小: ${totalSize} bytes, 总块数: ${totalChunks}`);

  // 分块接收数据
  const chunks = new Array(totalChunks);
  for (let i = 0; i < totalChunks; i++) {
    sendPlaceholderUpdate(`正在下载PDF文件 (${Math.round((i + 1) / totalChunks * 100)}%)...`, 0, targetSidebar);

    const chunkResponse = await chrome.runtime.sendMessage({
      action: 'getPDFChunk',
      url: url,
      chunkIndex: i
    });

    if (!chunkResponse.success) {
      sendPlaceholderUpdate('PDF下载失败', 2000, targetSidebar);
      throw new Error(`获取PDF块 ${i} 失败`);
    }

    chunks[i] = new Uint8Array(chunkResponse.data);
  }

  // 合并所有块
  const completeData = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    completeData.set(chunk, offset);
    offset += chunk.length;
  }

  return completeData;
}

async function parsePDFData(completeData, targetSidebar = null) {
  console.log('开始解析PDF文件');
  const loadingTask = pdfjsLib.getDocument({ data: completeData });
  const pdf = await loadingTask.promise;
  console.log('PDF加载成功，总页数:', pdf.numPages);

  let fullText = '';
  // 遍历所有页面
  for (let i = 1; i <= pdf.numPages; i++) {
    sendPlaceholderUpdate(`正在提取文本 (${i}/${pdf.numPages})...`, 0, targetSidebar);
    console.log(`开始处理第 ${i}/${pdf.numPages} 页`);
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map(item => item.str).join(' ');
    console.log(`第 ${i} 页提取的文本长度:`, pageText.length);
    fullText += pageText + '\n';
  }

  return fullText;
}

async function extractTextFromPDF(url, targetSidebar = null) {
  try {
    // 下载PDF文件
    sendPlaceholderUpdate('正在下载PDF文件...', 0, targetSidebar);
    const completeData = await downloadPDFData(url, targetSidebar);
    console.log('PDF下载完成');

    // 克隆 PDF 数据，避免后续调用因 ArrayBuffer 被转移而失败
    const dataForText = new Uint8Array(completeData.buffer.slice(0));
    const dataForChapters = new Uint8Array(completeData.buffer.slice(0));

    // 解析PDF文本
    sendPlaceholderUpdate('正在解析PDF文件...', 0, targetSidebar);
    const fullText = await parsePDFData(dataForText, targetSidebar);

    // 解析PDF章节
    const chapters = await extractChaptersFromPDFData(dataForChapters, targetSidebar);

    console.log('PDF文本提取完成，总文本长度:', fullText.length);
    sendPlaceholderUpdate('PDF处理完成', 2000, targetSidebar);
    return { fullText, chapters };
  } catch (error) {
    console.error('PDF处理过程中出错:', error);
    console.error('错误堆栈:', error.stack);
    sendPlaceholderUpdate('PDF处理失败', 2000, targetSidebar);
    return null;
  }
}

// 新增：从PDF数据解析章节内容的辅助函数
async function extractChaptersFromPDFData(completeData, targetSidebar = null) {
  console.log('开始解析PDF章节内容');
  const fullPageTexts = await parsePDFToPageTexts(completeData, targetSidebar);
  console.log('成功提取每页文本, 页数:', fullPageTexts.length);
  
  // 克隆数据用于获取目录(书签)，不影响后续使用
  const freshDataForOutline = new Uint8Array(completeData);
  const loadingTask = pdfjsLib.getDocument({ data: freshDataForOutline });
  const pdf = await loadingTask.promise;
  
  // 获取目录书签
  let outline = await pdf.getOutline();
  if (!outline) {
    console.log('未检测到书签，使用默认章节');
    outline = [{ title: '全文', items: [] }];
  }
  const processedOutline = await processPdfOutlineEx(pdf, outline);
  const chapters = splitPdfTextByChapters(fullPageTexts, processedOutline);
  console.log('切分后的章节数据:', chapters);
  return chapters;
}

// ====================== 网页截图功能 ======================

/**
 * 捕获当前可见标签页的屏幕截图并发送到侧边栏。
 * 截图前会先隐藏侧边栏，并在等待两帧后再进行截图，最后恢复侧边栏显示。
 */
function captureVisibleTabWhileSidebarHidden(requestMessageBuilder) {
  const visibleSidebars = sidebarManager?.getVisibleSidebars?.() || [];
  const hiddenEntries = visibleSidebars
    .filter((item) => item?.sidebar)
    .map((item) => ({
      item,
      visibility: item.sidebar.style.visibility,
      transition: item.sidebar.style.transition
    }));
  hiddenEntries.forEach(({ item }) => {
    item.sidebar.style.transition = 'none';
    item.sidebar.style.visibility = 'hidden';
  });
  let restored = false;

  function restoreSidebarVisibility() {
    if (restored) return;
    restored = true;
    hiddenEntries.forEach(({ item, visibility, transition }) => {
      item.sidebar.style.visibility = visibility;
      item.sidebar.style.transition = transition;
    });
  }

  /**
   * 递归地执行 requestAnimationFrame，并在指定次数后执行截屏操作。
   * @param {number} waitFramesCount 递归层级，控制等待的帧数。
   */
  function waitCaptureWithAnimationFrame(waitFramesCount) {
    return new Promise((resolve, reject) => {
      requestAnimationFrame(() => {
        if (waitFramesCount > 0) {
          resolve(waitCaptureWithAnimationFrame(waitFramesCount - 1));
          return;
        }

        const requestMessage = (typeof requestMessageBuilder === 'function')
          ? requestMessageBuilder()
          : null;
        if (!requestMessage || typeof requestMessage !== 'object') {
          restoreSidebarVisibility();
          reject(new Error('截图请求构造失败：缺少有效的 request message。'));
          return;
        }

        chrome.runtime.sendMessage(requestMessage, (response) => {
          restoreSidebarVisibility();
          const lastError = chrome.runtime?.lastError;
          if (lastError) {
            reject(new Error(lastError.message || '发送截图请求失败'));
            return;
          }
          resolve(response);
        });
      });
    });
  }

  return waitCaptureWithAnimationFrame(5); // 初始调用，设置递归层级为 5，实现等待五帧的效果
}

function captureAndDropScreenshot(targetSidebar = null) {
  const sidebarInstance = targetSidebar || getActiveSidebar();
  captureVisibleTabWhileSidebarHidden(() => ({ action: 'capture_visible_tab' }), sidebarInstance)
    .then((response) => {
      if (response && response.success && response.dataURL) {
        console.log('页面截图完成，发送到侧边栏');
        sidebarInstance?.postToIframe?.({
          type: 'DROP_IMAGE',
          imageData: { data: response.dataURL, name: 'page-screenshot.png' },
        });
      } else {
        console.error('屏幕截图失败:', response && response.error);
      }
    })
    .catch((error) => {
      console.error('屏幕截图失败:', error);
    });
}

/**
 * 捕获一张供 agent tool 使用的网页截图。
 *
 * 行为要求：
 * - 和用户点击截图按钮保持同一截图边界：先隐藏侧边栏，再等待若干帧；
 * - 真正的压缩与 detail 处理放在后台模块完成，这里只负责“避免把侧栏自己拍进去”；
 * - 返回值直接对齐 message_sender 需要的 transport 结构。
 *
 * @param {any} rawArgs
 * @returns {Promise<Object>}
 */
function capturePromptFriendlyScreenshot(rawArgs, targetSidebar = null) {
  return captureVisibleTabWhileSidebarHidden(() => ({
    action: 'capture_visible_tab_for_prompt',
    args: rawArgs && typeof rawArgs === 'object' ? rawArgs : null
  }), targetSidebar).then((response) => {
    if (response && typeof response === 'object') {
      return response;
    }
    return {
      ok: false,
      error: {
        message: '网页截图工具未返回有效结果。',
        name: 'WebpageScreenshotEmptyResponseError'
      }
    };
  });
}

// ====================== 临时调试用 ======================

// 调试功能：暴露几个调试函数方便查看PDF提取和DOM提取结果
window.cerebrDebug = {
  /**
   * 调试提取PDF内容
   * @param {string} [pdfUrl] - 可选的PDF URL，默认为当前页面URL
   * @returns {Promise<string|undefined>} 提取的PDF文本内容
   */
  debugExtractPDF: async function(pdfUrl) {
    pdfUrl = pdfUrl || window.location.href;
    console.log(`Debug: 开始提取 PDF 内容, URL: ${pdfUrl}`);
    try {
      const pdfText = await extractTextFromPDF(pdfUrl);
      console.log("Debug: PDF 内容提取结果:", pdfText);
      return pdfText;
    } catch (error) {
      console.error("Debug: PDF 内容提取失败:", error);
    }
  },
  debugExtractPDFOutline: async function(pdfUrl) {
    pdfUrl = pdfUrl || window.location.href;
    console.log(`Debug: 开始提取 PDF 大纲, URL: ${pdfUrl}`);
    try {
      const outline = await extractPdfOutlineChapters(pdfUrl);
      console.log("Debug: PDF 大纲提取结果:", outline);
      return outline;
    } catch (error) {
      console.error("Debug: PDF 大纲提取失败:", error);
    }
  },
  debugExtractPdfChapters: async function(pdfUrl) {
    pdfUrl = pdfUrl || window.location.href;
    console.log(`Debug: 开始提取 PDF 章节, URL: ${pdfUrl}`);
    try {
      const chapters = await debugExtractPdfChapters(pdfUrl);
      console.log("Debug: PDF 章节提取结果:", chapters);
      return chapters;
    } catch (error) {
      console.error("Debug: PDF 章节提取失败:", error);
    }
  },
  /**
   * 调试提取重要DOM结构
   * @returns {string} 清理过的重要DOM结构
   */
  debugExtractDOM: function() {
    console.log("Debug: 开始提取重要的 DOM 结构");
    const dom = extractImportantDOM();
    console.log("Debug: 提取后的 DOM:", dom);
    return dom;
  },
  /**
   * 调试提取可见 DOM 树（JSON 格式）
   * @returns {Object} 可见 DOM 树的 JSON 结构
   */
  debugExtractVisibleDOM: function() {
    console.log("Debug: 开始提取可见 DOM 树（JSON 格式）");
    const domTree = extractVisibleDOMTree(document.body);
    console.log("Debug: 可见 DOM 树：", JSON.stringify(domTree, null, 2));
    return domTree;
  },
  /**
   * 将 JSON DOM 树转换为 HTML 字符串
   * @param {Object} jsonNode - 使用 extractVisibleDOMTree() 提取出的 JSON DOM 节点
   * @returns {string} 生成的 HTML 字符串
   */
  debugExtractVisibleHTMLString: function() {
    console.log("Debug: 开始生成清洁的可见 HTML 字符串");
    const domTree = extractVisibleDOMTree(document.body);
    const htmlString = jsonDomToHtml(domTree);
    console.log("Debug: 可见 HTML 字符串：", htmlString);
    return htmlString;
  },
};

/**
 * 遍历 DOM 并返回简化后的 JSON 结构，仅保留对用户可见的部分
 * @param {HTMLElement} root - 待遍历的根节点
 * @returns {Object|null} 简化后的 DOM 结构树
 */
function extractVisibleDOMTree(root) {
  const allowedAttributes = ['id', 'class', 'href', 'title', 'placeholder', 'alt'];
  
  function serializeNode(node) {
    const computedStyle = window.getComputedStyle(node);
    // 如果节点样式设置为不可见，则返回null
    if (computedStyle.display === 'none' || computedStyle.visibility === 'hidden') {
      return null;
    }
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return null;
    }

    const serialized = {
      tag: node.tagName.toLowerCase()
    };

    // 记录允许的属性
    if (node.attributes && node.attributes.length > 0) {
      serialized.attributes = {};
      Array.from(node.attributes).forEach(attr => {
        if (allowedAttributes.includes(attr.name)) {
          serialized.attributes[attr.name] = attr.value;
        }
      });
    }

    // 保存文本内容（仅当没有子元素时，认为是直接文本）
    const textContent = node.textContent.trim();
    if (textContent && node.children.length === 0) {
      serialized.text = textContent;
    }

    // 递归处理子元素
    const children = [];
    Array.from(node.children).forEach(child => {
      const childSerialized = serializeNode(child);
      if (childSerialized !== null) {
        children.push(childSerialized);
      }
    });
    if (children.length) {
      serialized.children = children;
    }
    return serialized;
  }

  return serializeNode(root);
}

// ====================== 新增：将 JSON DOM 树转换为 HTML 字符串 ======================

/**
 * 将 JSON DOM 树转换为 HTML 字符串
 * @param {Object} jsonNode - 使用 extractVisibleDOMTree() 提取出的 JSON DOM 节点
 * @returns {string} 生成的 HTML 字符串
 */
function jsonDomToHtml(jsonNode) {
  if (!jsonNode) return "";
  let attrStr = "";
  if (jsonNode.attributes) {
    for (const key in jsonNode.attributes) {
      attrStr += ` ${key}="${jsonNode.attributes[key]}"`;
    }
  }
  let innerHtml = "";
  // 如果节点有直接文本，则作为 inner HTML
  if (jsonNode.text) {
    innerHtml = jsonNode.text;
  }
  // 递归处理子节点
  if (jsonNode.children && jsonNode.children.length) {
    innerHtml += jsonNode.children.map(child => jsonDomToHtml(child)).join("");
  }
  return `<${jsonNode.tag}${attrStr}>${innerHtml}</${jsonNode.tag}>`;
}

// ====================== 新增：根据指定参数查询页面返回目标 DOM 片段 ======================

/**
 * 根据指定参数查询页面返回目标 DOM 片段。
 * @param {Object} params - 包含查询参数的对象，包括 query、target、maxDistance
 * @returns {string} 目标 DOM 片段的 outerHTML
 */
function extractDomByQuery(params) {
  const query = params.query || "";
  const targetSelector = params.target;
  const maxDistance = params.maxDistance;

  // 在页面中遍历所有可见元素，寻找首个 innerText 包含关键词 query 的锚点
  const allElements = Array.from(document.querySelectorAll("body *"));
  let anchorCandidate = null;
  for (const el of allElements) {
    // 仅考虑非空文本，并简单判断其 innerText 是否包含关键词（可扩展更复杂判定）
    if (el.innerText && el.innerText.includes(query)) {
      const style = window.getComputedStyle(el);
      if (style.display !== 'none' && style.visibility !== 'hidden') {
        anchorCandidate = el;
        break;
      }
    }
  }

  if (!anchorCandidate) {
    return `找不到包含关键词 "${query}" 的锚点元素。`;
  }

  // 获取锚点元素中心位置
  const anchorRect = anchorCandidate.getBoundingClientRect();
  const anchorCenter = {
    x: anchorRect.left + anchorRect.width / 2,
    y: anchorRect.top + anchorRect.height / 2
  };

  // 查找所有满足目标选择器的元素
  const candidates = Array.from(document.querySelectorAll(targetSelector));
  let bestCandidate = null;
  let bestDistance = Infinity;
  for (const cand of candidates) {
    const rect = cand.getBoundingClientRect();
    const candCenter = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
    const distance = Math.sqrt(Math.pow(anchorCenter.x - candCenter.x, 2) + Math.pow(anchorCenter.y - candCenter.y, 2));
    if (distance < bestDistance && distance <= maxDistance) {
      bestDistance = distance;
      bestCandidate = cand;
    }
  }

  if (bestCandidate) {
    return bestCandidate.outerHTML;
  } else {
    return `未在锚点 "${query}" 附近找到符合选择器 "${targetSelector}" 的目标元素。`;
  }
}

// ====================== 新增：提取当前视口内的 DOM 结构 ======================

/**
 * 判断元素是否至少部分位于视口中（只要有一部分可见就算）
 * @param {Element} el - 待检测的 DOM 元素
 * @returns {boolean} 如果元素至少部分可见返回 true，否则返回 false
 */
function isPartiallyInViewport(el) {
  const rect = el.getBoundingClientRect();
  // 如果元素的底部在视口上方、顶部在视口下方、右侧在视口左侧或左侧在视口右侧，则完全不可见
  return !(rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth);
}

/**
 * 递归提取当前视口内的 DOM 结构，只构建那些至少部分可见的节点。
 * 如果一个节点不在视口（即完全不可见），则直接返回 null，且不处理其子节点。
 *
 * 注意：对于文本节点，如果文本非空，则直接返回文本；其他节点只保留部分属性（如 id、class、href、title）。
 *
 * @param {Node} node - 待处理的节点
 * @returns {Object|string|null} 
 *   - 如果节点完全不可见则返回 null，
 *   - 如果是文本节点则返回文本内容，
 *   - 否则返回包含 tag、allowed attributes 以及 children（仅包含可见子节点）的结构化对象。
 */
function extractVisibleViewportDOMTree(node) {
  // 如果是文本节点，返回非空文本内容（否则忽略）
  if (node.nodeType === Node.TEXT_NODE) {
    const trimmed = node.textContent.trim();
    return trimmed ? trimmed : null;
  }
  
  // 非元素节点直接跳过
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }
  
  // 检查当前元素是否至少部分在视口中
  if (!isPartiallyInViewport(node)) {
    // 如果当前节点完全不在视口，则不进一步处理其子节点
    return null;
  }
  
  // 构造当前节点的结构化表示
  const obj = {
    tag: node.tagName.toLowerCase()
  };
  
  // 只保留部分允许的属性，避免信息过多
  const allowedAttrs = ['id', 'class', 'href', 'title'];
  if (node.attributes && node.attributes.length > 0) {
    obj.attributes = {};
    Array.from(node.attributes).forEach(attr => {
      if (allowedAttrs.includes(attr.name)) {
        obj.attributes[attr.name] = attr.value;
      }
    });
  }
  
  // 递归处理子节点：只包含那些至少部分可见的子元素
  const children = [];
  Array.from(node.childNodes).forEach(child => {
    const childData = extractVisibleViewportDOMTree(child);
    if (childData !== null) {
      children.push(childData);
    }
  });
  if (children.length > 0) {
    obj.children = children;
  }
  
  return obj;
}

// ====================== 新增：PDF结构章节工具函数 ======================

/**
 * 异步处理 PDF 书签，提取章节信息并获取页码
 * @param {Object} pdf - PDF.js 的 PDF 文档对象
 * @param {Array} outline - PDF.js 返回的书签数组
 * @returns {Promise<Array<{chapterTitle: string, pageNumber: (number|null), children: Array}>>}
 */
async function processPdfOutlineEx(pdf, outline) {
  if (!outline) return [];
  const result = [];
  for (const item of outline) {
    let pageNumber = null;
    if (item.dest) {
      try {
        // 如果 dest 是字符串，先通过 getDestination 获取数组，否则直接使用
        const destArray = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
        if (destArray) {
          const pageRef = destArray[0];
          const pageIndex = await pdf.getPageIndex(pageRef);
          // PDF 页码通常从1开始
          pageNumber = pageIndex + 1;
        }
      } catch (e) {
        console.error('获取页码失败:', e);
      }
    }
    const children = await processPdfOutlineEx(pdf, item.items);
    result.push({
      chapterTitle: item.title || '未命名章节',
      pageNumber: pageNumber,
      children: children
    });
  }
  return result;
}

/**
 * 异步提取PDF文件的元数据和结构信息，从PDF书签中分出章节，并获取章节页码。
 * 此函数复用已有的 downloadPDFData 函数处理PDF数据，并利用 PDF.js 获取PDF目录和元数据。
 * 
 * @param {string} pdfUrl - PDF文件的URL
 * @param {Object} [options] - 可选配置
 * @returns {Promise<{title: string, url: string, metadata: Object, outline: Array}>}
 * @example
 * extractPdfOutlineChapters('https://example.com/sample.pdf').then(result => {
 *   console.log(result.outline);
 * });
 */
async function extractPdfOutlineChapters(pdfUrl, options = {}) {
  // 复用已有的下载函数获取完整PDF数据
  const completeData = await downloadPDFData(pdfUrl);

  // 使用PDF.js加载PDF文档
  const loadingTask = pdfjsLib.getDocument({ data: completeData });
  const pdf = await loadingTask.promise;

  // 提取元数据
  let meta = {};
  try {
    const metaResult = await pdf.getMetadata();
    meta = {
      info: metaResult.info,
      metadata: metaResult.metadata
    };
  } catch (e) {
    console.error('获取PDF元数据失败:', e);
  }

  // 尝试获取PDF的目录（书签）
  let outline = await pdf.getOutline();
  if (!outline) {
    // 没有书签时，构造默认单章节
    outline = [{ title: '全文', items: [] }];
  }
  const processedOutline = await processPdfOutlineEx(pdf, outline);

  // 返回PDF的基本信息、元数据和章节结构
  return {
    title: meta.metadata ? meta.metadata.get('DC:title') || meta.info.Title || pdf.fingerprint || '未知标题' : pdf.fingerprint || '未知标题',
    url: pdfUrl,
    metadata: meta,
    outline: processedOutline
  };
}

// ====================== 结束：PDF结构章节工具函数 ======================

// ====================== 新增：根据章节切分PDF文本 ======================
/**
 * 根据完整的页文本数组和章节outline切分PDF文本，按章节层次返回结构化的章节内容
 * @param {string[]} fullPageTexts - PDF每页的文本数组，索引0对应页1
 * @param {Array<{chapterTitle: string, pageNumber: (number|null), children: Array}>} outline - 章节outline，章节的 pageNumber 为起始页（从1计数）
 * @returns {Array<{chapterTitle: string, pageNumber: number, content: string, children: Array}>} 切分后的章节内容数据
 * @example
 * const chapters = splitPdfTextByChapters(fullPageTexts, outline);
 */
function splitPdfTextByChapters(fullPageTexts, outline) {
  const totalPages = fullPageTexts.length;
  // 筛选出有效的章节（有pageNumber），并按pageNumber排序
  const sortedOutline = outline.filter(item => item.pageNumber !== null).sort((a, b) => a.pageNumber - b.pageNumber);
  const chapters = [];
  for (let i = 0; i < sortedOutline.length; i++) {
    const chapter = sortedOutline[i];
    const start = chapter.pageNumber; // 起始页
    // 下一个章节的起始页，或者若没有则取总页数+1
    const end = (i < sortedOutline.length - 1) ? sortedOutline[i + 1].pageNumber : totalPages + 1;
    // 截取从 start 到 end-1 页的内容
    const content = fullPageTexts.slice(start - 1, end - 1).join('\n');

    // 如果该章节有子章节，则递归切分
    let children = [];
    if (chapter.children && chapter.children.length > 0) {
      children = splitPdfTextByChapters(fullPageTexts, chapter.children);
    }

    chapters.push({
      chapterTitle: chapter.chapterTitle,
      pageNumber: chapter.pageNumber,
      content: content,
      children: children
    });
  }
  return chapters;
}

// ====================== 新增：从PDF数据解析每页文本 ======================
/**
 * 解析完整的PDF数据，返回每一页的文本数组，数组索引0对应第1页
 * @param {Uint8Array} completeData - 下载的PDF数据
 * @returns {Promise<string[]>} 每页的文本数组
 * @example
 * const pageTexts = await parsePDFToPageTexts(completeData);
 */
async function parsePDFToPageTexts(completeData, targetSidebar = null) {
  console.log('开始解析PDF为页文本数组');
  // 克隆数据，确保传递给pdf.js的ArrayBuffer是新的
  const freshData = new Uint8Array(completeData);
  const loadingTask = pdfjsLib.getDocument({ data: freshData });
  const pdf = await loadingTask.promise;
  console.log('PDF加载成功，总页数:', pdf.numPages);
  const pageTexts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    sendPlaceholderUpdate(`正在提取第 ${i} 页文本...`, 0, targetSidebar);
    console.log(`开始处理第 ${i} 页`);
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map(item => item.str).join(' ');
    console.log(`第 ${i} 页提取的文本长度:`, pageText.length);
    pageTexts.push(pageText);
  }
  return pageTexts;
}

// ====================== 新增：从PDF数据提取并切分章节文本 ======================
/**
 * 从给定的PDF URL中下载数据，提取每页文本，并结合目录将PDF文本按章节切分
 * @param {string} pdfUrl - PDF文件的URL
 * @returns {Promise<Array<{chapterTitle: string, pageNumber: number, content: string, children: Array}>>} 切分后的章节结构数据
 * @example
 * const chapters = await window.cerebrDebug.debugExtractPdfChapters('https://example.com/sample.pdf');
 */
async function debugExtractPdfChapters(pdfUrl) {
  pdfUrl = pdfUrl || window.location.href;
  console.log(`开始提取PDF章节数据, URL: ${pdfUrl}`);
  
  // 下载PDF数据
  const completeData = await downloadPDFData(pdfUrl);
  console.log('PDF下载完成，开始解析每页文本');
  
  // 获取每页文本数组；这里无需额外克隆，因为parsePDFToPageTexts内部会克隆数据
  const fullPageTexts = await parsePDFToPageTexts(completeData);
  console.log('成功提取每页文本, 页数:', fullPageTexts.length);
  
  // 为了获取目录和元数据，克隆PDF数据，不影响后续使用
  const freshDataForOutline = new Uint8Array(completeData);
  const loadingTask = pdfjsLib.getDocument({ data: freshDataForOutline });
  const pdf = await loadingTask.promise;
  
  // 获取目录(书签)
  let outline = await pdf.getOutline();
  if (!outline) {
    console.log('未检测到书签，使用默认章节');
    outline = [{ title: '全文', items: [] }];
  }
  const processedOutline = await processPdfOutlineEx(pdf, outline);
  console.log('目录处理结果:', processedOutline);
  
  // 根据章节信息切分文本，每个章节起始页由outline中的pageNumber获得
  const chapters = splitPdfTextByChapters(fullPageTexts, processedOutline);
  
  console.log('切分后的章节数据:', chapters);
  return chapters;
}
