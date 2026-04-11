import { createJsRuntimeManager } from './js_runtime_manager.js';
import { createMicroSkillManager } from './micro_skill_manager.js';
import { buildPromptImageResultFromScreenshotDataUrl } from './prompt_image_capture.js';
import { resolveSidebarRequestTargetTabId } from '../utils/sidebar_target_tab.js';
import {
  normalizeWebpageScreenshotArguments
} from '../agent_tools/webpage_screenshot_tool.js';

// 确保 Service Worker 立即激活
self.addEventListener('install', (event) => {
  console.log('Service Worker 安装中...', new Date().toISOString());
  event.waitUntil(Promise.all([
    self.skipWaiting(),
    ensureMicroSkillManagerReady({ force: true })
  ]));
});

self.addEventListener('activate', (event) => {
  console.log('Service Worker 已激活', new Date().toISOString());
  event.waitUntil(Promise.all([
    self.clients.claim(),
    ensureMicroSkillManagerReady({ force: true })
  ]));
});

// 添加启动日志
console.log('Background script loaded at:', new Date().toISOString());

// ============================================================================
//  会话-标签页“存在性”注册表（用于避免同一会话被多标签页同时打开）
//
//  背景：
//  - 用户可以在“聊天记录”面板里打开历史会话；
//  - 若同一会话在多个标签页的侧栏/独立页同时打开，可能产生并发写入，导致保存冲突或覆盖；
//  - 这里由后台维护一份“当前有哪些 conversationId 正被哪些 tab 打开”的实时映射，
//    供 UI 显示“已打开”标记并提供“一键跳转到已打开标签页”按钮。
//
//  设计说明：
//  - 使用 chrome.runtime.connect 的 Port 作为“活跃实例”标识；
//  - Port 断开（标签页关闭/侧栏销毁/页面刷新）会触发 onDisconnect，从而自动清理映射；
//  - 映射仅保存在 Service Worker 内存中，不做持久化；SW 被回收后由客户端重连重建即可。
// ============================================================================

const CONVERSATION_PRESENCE_PORT_NAME = 'cerebr-conversation-presence';

/**
 * @typedef {Object} ConversationPresenceInfo
 * @property {number|null} tabId
 * @property {number|null} windowId
 * @property {number|null} frameId
 * @property {string|null} conversationId
 * @property {string} tabTitle
 * @property {string} tabUrl
 * @property {boolean} isStandalone
 * @property {number} lastUpdated
 */

/** @type {Set<chrome.runtime.Port>} */
const conversationPresencePorts = new Set();
/** @type {Map<chrome.runtime.Port, ConversationPresenceInfo>} */
const conversationPresenceByPort = new Map();
const PRESENCE_DISCONNECT_GRACE_MS = 2000;
const conversationPresenceDisconnectTimers = new Map();
let conversationPresenceSnapshotSeq = 0;

function getConversationPresenceSnapshotSeq(bump = false) {
  if (bump) {
    conversationPresenceSnapshotSeq += 1;
  }
  return conversationPresenceSnapshotSeq;
}

function normalizeConversationId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function buildOpenConversationSnapshot(conversationIds = null) {
  const filterSet = (() => {
    if (!Array.isArray(conversationIds) || conversationIds.length === 0) return null;
    const set = new Set();
    for (const raw of conversationIds) {
      const normalized = normalizeConversationId(raw);
      if (normalized) set.add(normalized);
    }
    return set.size ? set : null;
  })();

  // convId -> (tabId -> entry) 用于去重（同一 tab 可能出现多个 port/多次更新）
  const convToTabs = new Map();

  for (const info of conversationPresenceByPort.values()) {
    const convId = normalizeConversationId(info?.conversationId);
    if (!convId) continue;
    if (filterSet && !filterSet.has(convId)) continue;

    const tabId = Number.isFinite(Number(info?.tabId)) ? Number(info.tabId) : null;
    if (tabId === null) continue;

    if (!convToTabs.has(convId)) convToTabs.set(convId, new Map());
    const perTab = convToTabs.get(convId);

    const entry = {
      tabId,
      windowId: Number.isFinite(Number(info?.windowId)) ? Number(info.windowId) : null,
      title: typeof info?.tabTitle === 'string' ? info.tabTitle : '',
      url: typeof info?.tabUrl === 'string' ? info.tabUrl : '',
      isStandalone: !!info?.isStandalone,
      lastUpdated: Number.isFinite(Number(info?.lastUpdated)) ? Number(info.lastUpdated) : 0
    };

    const existing = perTab.get(tabId);
    if (!existing || entry.lastUpdated >= existing.lastUpdated) {
      perTab.set(tabId, entry);
    }
  }

  const out = {};
  for (const [convId, perTab] of convToTabs.entries()) {
    out[convId] = Array.from(perTab.values()).sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));
  }
  return out;
}

function broadcastOpenConversationSnapshot() {
  const snapshot = buildOpenConversationSnapshot(null);
  const snapshotSeq = getConversationPresenceSnapshotSeq(true);
  for (const port of conversationPresencePorts) {
    try {
      port.postMessage({
        type: 'OPEN_CONVERSATIONS_SNAPSHOT',
        openConversations: snapshot,
        snapshotSeq,
        timestamp: Date.now()
      });
    } catch (_) {}
  }
}

function removeConversationPresencePort(port) {
  const timer = conversationPresenceDisconnectTimers.get(port);
  if (timer) {
    clearTimeout(timer);
    conversationPresenceDisconnectTimers.delete(port);
  }
  try { conversationPresencePorts.delete(port); } catch (_) {}
  try { conversationPresenceByPort.delete(port); } catch (_) {}
}

function registerConversationPresencePort(port) {
  conversationPresencePorts.add(port);

  /** @type {ConversationPresenceInfo} */
  const info = {
    tabId: Number.isFinite(Number(port?.sender?.tab?.id)) ? Number(port.sender.tab.id) : null,
    windowId: Number.isFinite(Number(port?.sender?.tab?.windowId)) ? Number(port.sender.tab.windowId) : null,
    frameId: Number.isFinite(Number(port?.sender?.frameId)) ? Number(port.sender.frameId) : null,
    conversationId: null,
    tabTitle: typeof port?.sender?.tab?.title === 'string' ? port.sender.tab.title : '',
    tabUrl: typeof port?.sender?.tab?.url === 'string' ? port.sender.tab.url : '',
    isStandalone: false,
    lastUpdated: Date.now()
  };

  conversationPresenceByPort.set(port, info);

  port.onDisconnect.addListener(() => {
    const timer = setTimeout(() => {
      conversationPresenceDisconnectTimers.delete(port);
      removeConversationPresencePort(port);
      broadcastOpenConversationSnapshot();
    }, PRESENCE_DISCONNECT_GRACE_MS);
    conversationPresenceDisconnectTimers.set(port, timer);
  });

  port.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'SET_ACTIVE_CONVERSATION') {
      const nextId = normalizeConversationId(message.conversationId);
      const current = conversationPresenceByPort.get(port);
      if (!current) return;

      current.conversationId = nextId;
      current.lastUpdated = Date.now();
      if (typeof message.isStandalone === 'boolean') current.isStandalone = message.isStandalone;

      // 扩展页(iframe/standalone)发来的 Port sender.tab 可能为空，这里允许客户端显式上报 tabId/windowId
      if (Number.isFinite(Number(message.tabId))) current.tabId = Number(message.tabId);
      if (Number.isFinite(Number(message.windowId))) current.windowId = Number(message.windowId);

      // 允许客户端在 URL_CHANGED 时同步 tab title/url（用于 UI tooltip 更友好）
      if (typeof message.tabTitle === 'string') current.tabTitle = message.tabTitle;
      if (typeof message.tabUrl === 'string') current.tabUrl = message.tabUrl;

      conversationPresenceByPort.set(port, current);
      broadcastOpenConversationSnapshot();
      return;
    }
  });

  // 连接建立后立刻回传一次快照，避免 UI 首次打开面板需要额外等待
  try {
    port.postMessage({
      type: 'PRESENCE_ACK',
      tabId: info.tabId,
      windowId: info.windowId,
      frameId: info.frameId,
      openConversations: buildOpenConversationSnapshot(null),
      snapshotSeq: getConversationPresenceSnapshotSeq(false),
      timestamp: Date.now()
    });
  } catch (_) {}
}

async function focusConversationTab(conversationId, options = {}) {
  const convId = normalizeConversationId(conversationId);
  if (!convId) return { status: 'error', message: 'invalid_conversation_id' };

  const excludeTabId = Number.isFinite(Number(options?.excludeTabId)) ? Number(options.excludeTabId) : null;
  const snapshot = buildOpenConversationSnapshot([convId]);
  const entries = Array.isArray(snapshot?.[convId]) ? snapshot[convId] : [];

  const target = entries.find((e) => excludeTabId === null || e.tabId !== excludeTabId) || entries[0] || null;
  if (!target) return { status: 'not_found' };

  try {
    const tab = await chrome.tabs.get(target.tabId);
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
    await chrome.tabs.update(tab.id, { active: true });
    return { status: 'ok', tabId: tab.id, windowId: tab.windowId };
  } catch (error) {
    // 理论上 Port 断开会清理映射；这里再做一次兜底，防止 tabId 失效导致 UI 长期误判
    for (const [port, info] of conversationPresenceByPort.entries()) {
      if (Number(info?.tabId) === Number(target.tabId)) {
        removeConversationPresencePort(port);
      }
    }
    broadcastOpenConversationSnapshot();
    return { status: 'error', message: error?.message || 'focus_failed' };
  }
}

function checkCustomShortcut(callback) {
  chrome.commands.getAll((commands) => {
      const toggleCommand = commands.find(command => command.name === '_execute_action' || command.name === '_execute_browser_action');
      if (toggleCommand && toggleCommand.shortcut) {
          console.log('当前设置的快捷键:', toggleCommand.shortcut);
          // 直接获取最后一个字符并转换为小写
          const lastLetter = toggleCommand.shortcut.charAt(toggleCommand.shortcut.length - 1).toLowerCase();
          callback(lastLetter);
      }
  });
}

// 处理标签页连接和消息发送的通用函数
async function handleTabCommand(commandType) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      console.log('没有找到活动标签页');
      return;
    }

    // 检查标签页是否已连接
    const isConnected = await isTabConnected(tab.id);
    if (!isConnected) {
      console.log('标签页未连接，等待重试...');
      // 等待一段时间后重试
      await new Promise(resolve => setTimeout(resolve, 500));
      const retryConnection = await isTabConnected(tab.id);
      if (!retryConnection) {
        console.log('重试失败，标签页仍未连接');
        return;
      }
    }

    await chrome.tabs.sendMessage(tab.id, { type: commandType });
  } catch (error) {
    console.error(`处理${commandType}命令失败:`, error);
  }
}

async function openStandaloneChatPage() {
  try {
    const url = chrome.runtime.getURL('src/ui/sidebar/sidebar.html#standalone');
    await chrome.tabs.create({ url });
  } catch (error) {
    console.error('打开独立聊天页面失败:', error);
  }
}

// 简化后的命令监听器
chrome.commands.onCommand.addListener(async (command) => {
  // console.log('onCommand:', command);

  if (command === 'open_sidebar') {
    await handleTabCommand('OPEN_SIDEBAR');
  } else if (command === 'close_sidebar') {
    await handleTabCommand('CLOSE_SIDEBAR');
  } else if (command === 'clear_chat') {
    await handleTabCommand('CLEAR_CHAT');
  } else if (command === 'quick_summary') {
    await handleTabCommand('QUICK_SUMMARY');
  } else if (command === 'quick_summary_query') {
    await handleTabCommand('QUICK_SUMMARY_QUERY');
  } else if (command === 'toggle_temp_mode') {
    await handleTabCommand('TOGGLE_TEMP_MODE');
  } else if (command === 'capture_screenshot') {
    await handleTabCommand('CAPTURE_SCREENSHOT');
  } else if (command === 'toggle_fullscreen') {
    await handleTabCommand('TOGGLE_FULLSCREEN_FROM_BACKGROUND');
  } else if (command === 'add_page_content_to_context') {
    await handleTabCommand('ADD_PAGE_CONTENT_TO_CONTEXT');
  } else if (command === 'open_standalone_chat') {
    await openStandaloneChatPage();
  }
});

// 监听扩展图标点击
chrome.action.onClicked.addListener(async (tab) => {
  // console.log('扩展图标被点击');
  try {
    // 检查标签页是否已连接
    const isConnected = await isTabConnected(tab.id);
    if (!isConnected) {
      console.log('标签页未连接，等待重试...');
      // 等待一段时间后重试
      await new Promise(resolve => setTimeout(resolve, 500));
      const retryConnection = await isTabConnected(tab.id);
      if (!retryConnection) {
        console.log('重试失败，标签页仍未连接');
        return;
      }
    }

    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR_onClicked' });
  } catch (error) {
    console.error('处理切换失败:', error);
  }
});

// 创建一个持久连接
let port = null;
chrome.runtime.onConnect.addListener((p) => {
  // 会话存在性专用连接：用于维护 conversationId -> tabId 映射
  if (p?.name === CONVERSATION_PRESENCE_PORT_NAME) {
    registerConversationPresencePort(p);
    return;
  }

  // 兼容旧逻辑：保留一个连接引用（主要用于保持 Service Worker 活跃）
  port = p;
  port.onDisconnect.addListener(() => {
    port = null;
  });
});

// 监听来自 content script 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // console.log('收到消息:', message, '来自:', sender.tab?.id);

  if (message?.type === 'GET_JS_RUNTIME_STATUS') {
    (async () => {
      try {
        const status = await jsRuntimeManager.getAvailability();
        sendResponse({ success: true, status });
      } catch (error) {
        sendResponse({ success: false, error: error?.message || '获取 JS Runtime 状态失败' });
      }
    })();
    return true;
  }

  if (message?.type === 'EXECUTE_JS_RUNTIME') {
    (async () => {
      try {
        if (typeof sender?.url === 'string' && sender.url.includes('#standalone')) {
          sendResponse({
            success: false,
            error: '独立聊天页面当前没有稳定的目标网页标签页，暂不支持直接执行 JS Runtime。'
          });
          return;
        }

        const targetTabId = resolveSidebarRequestTargetTabId({
          explicitTabId: message?.tabId,
          senderTabId: sender?.tab?.id
        });
        if (!Number.isFinite(targetTabId)) {
          sendResponse({ success: false, error: '未找到与当前侧栏实例绑定的目标标签页。' });
          return;
        }

        const result = await jsRuntimeManager.execute({
          tabId: targetTabId,
          code: message?.code || '',
          frameIds: Array.isArray(message?.frameIds) ? message.frameIds : null,
          allFrames: message?.allFrames === true,
          injectImmediately: message?.injectImmediately === true
        });
        sendResponse({
          success: true,
          tabId: targetTabId,
          ...result
        });
      } catch (error) {
        sendResponse({ success: false, error: error?.message || '执行 JS Runtime 失败' });
      }
    })();
    return true;
  }

  if (message?.type === 'GET_JS_RUNTIME_FRAMES') {
    (async () => {
      try {
        if (typeof sender?.url === 'string' && sender.url.includes('#standalone')) {
          sendResponse({
            success: false,
            error: '独立聊天页面当前没有稳定的目标网页标签页，暂不支持读取 JS Runtime frame 快照。'
          });
          return;
        }

        const targetTabId = resolveSidebarRequestTargetTabId({
          explicitTabId: message?.tabId,
          senderTabId: sender?.tab?.id
        });
        if (!Number.isFinite(targetTabId)) {
          sendResponse({ success: false, error: '未找到与当前侧栏实例绑定的目标标签页。' });
          return;
        }

        const result = await jsRuntimeManager.listFrames({ tabId: targetTabId });
        sendResponse({
          success: true,
          tabId: targetTabId,
          ...result
        });
      } catch (error) {
        sendResponse({ success: false, error: error?.message || '获取 JS Runtime frame 快照失败' });
      }
    })();
    return true;
  }

  if (message?.type === 'MICRO_SKILL_REGISTRY_ACTION') {
    (async () => {
      try {
        await ensureMicroSkillManagerReady();
        const targetTabId = Number.isFinite(Number(message?.tabId))
          ? Number(message.tabId)
          : null;
        const result = await microSkillManager.executeRegistryAction(message?.payload || {}, {
          tabId: targetTabId
        });
        sendResponse({ success: true, ...result });
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || '微型 skill 注册表操作失败。'
        });
      }
    })();
    return true;
  }

  if (message?.type === 'GET_MATCHING_MICRO_SKILL_SUMMARIES') {
    (async () => {
      try {
        await ensureMicroSkillManagerReady();
        if (typeof sender?.url === 'string' && sender.url.includes('#standalone')) {
          sendResponse({
            success: true,
            tab_id: null,
            url: '',
            title: '',
            total_skills: 0,
            skills: []
          });
          return;
        }

        const targetTabId = resolveSidebarRequestTargetTabId({
          explicitTabId: message?.tabId,
          senderTabId: sender?.tab?.id
        });
        if (!Number.isFinite(targetTabId)) {
          sendResponse({
            success: true,
            tab_id: null,
            url: '',
            title: '',
            total_skills: 0,
            skills: []
          });
          return;
        }

        const result = await microSkillManager.listMatchingSkillSummariesForTab(targetTabId);
        sendResponse({
          success: true,
          ...result
        });
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || '读取当前页面匹配的微型 skill 摘要失败。'
        });
      }
    })();
    return true;
  }

  if (message?.type === 'GET_OPEN_CONVERSATION_TABS') {
    const ids = Array.isArray(message.conversationIds) ? message.conversationIds : null;
    const snapshot = buildOpenConversationSnapshot(ids);
    sendResponse({
      status: 'ok',
      openConversations: snapshot,
      snapshotSeq: getConversationPresenceSnapshotSeq(false),
      requesterTabId: Number.isFinite(Number(sender?.tab?.id)) ? Number(sender.tab.id) : null,
      timestamp: Date.now()
    });
    return false;
  }

  if (message?.type === 'FOCUS_CONVERSATION_TAB') {
    (async () => {
      const result = await focusConversationTab(message.conversationId, {
        excludeTabId: message.excludeTabId
      });
      sendResponse(result);
    })();
    return true;
  }

  if (message.type === 'CONTENT_LOADED') {
    // console.log('内容脚本已加载:', message.url);
    sendResponse({ status: 'ok', timestamp: new Date().toISOString() });
    return false;
  }

  if (message.type === 'OPEN_STANDALONE_CHAT') {
    (async () => {
      try {
        await openStandaloneChatPage();
        sendResponse({ status: 'ok' });
      } catch (error) {
        sendResponse({ status: 'error', message: error.message });
      }
    })();
    return true;
  }

  if (message.type === 'GET_PAGE_CONTENT_READ_RESULT_FROM_SIDEBAR') {
    (async () => {
      const result = await relaySidebarContentRequestToTab({
        message,
        sender,
        logLabel: '获取 page_content_read 结果失败',
        contentMessage: {
          type: 'GET_PAGE_CONTENT_READ_RESULT_INTERNAL',
          args: message?.args ?? null
        }
      });
      sendResponse(result);
    })();
    return true;
  }

  if (message.type === 'GET_PDF_CONTENT_READ_RESULT_FROM_SIDEBAR') {
    (async () => {
      const result = await relaySidebarContentRequestToTab({
        message,
        sender,
        logLabel: '获取 pdf_content_read 结果失败',
        contentMessage: {
          type: 'GET_PDF_CONTENT_READ_RESULT_INTERNAL',
          args: message?.args ?? null
        }
      });
      sendResponse(result);
    })();
    return true;
  }

  if (message.type === 'GET_WEBPAGE_SCREENSHOT_RESULT_FROM_SIDEBAR') {
    (async () => {
      const result = await relaySidebarContentRequestToTab({
        message,
        sender,
        logLabel: '获取网页截图工具结果失败',
        contentMessage: {
          type: 'GET_WEBPAGE_SCREENSHOT_RESULT_INTERNAL',
          args: message?.args ?? null
        }
      });
      sendResponse(result);
    })();
    return true;
  }

  // 处理PDF下载请求
  if (message.action === 'downloadPDF') {
    (async () => {
      try {
        const response = await downloadPDF(message.url);
        sendResponse(response);
      } catch (error) {
        sendResponse({success: false, error: error.message});
      }
    })();
    return true;
  }

  // 处理获取PDF块的请求
  if (message.action === 'getPDFChunk') {
    (async () => {
      try {
        const response = await getPDFChunk(message.url, message.chunkIndex);
        sendResponse(response);
      } catch (error) {
        sendResponse({success: false, error: error.message});
      }
    })();
    return true;
  }

  // 处理截屏请求
  if (message.action === 'capture_visible_tab') {
    (async () => {
      const result = await captureVisibleTab(sender?.tab?.windowId ?? null);
      sendResponse(result);
    })();
    return true; // 指明 sendResponse 将异步调用
  }

  if (message.action === 'capture_visible_tab_for_prompt') {
    (async () => {
      const result = await captureVisibleTabForPrompt(sender?.tab?.windowId ?? null, message?.args);
      sendResponse(result);
    })();
    return true;
  }

  return false;
});

// 监听存储变化
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.webpageSwitchDomains) {
        const { newValue = {}, oldValue = {} } = changes.webpageSwitchDomains;
        const domains = { ...oldValue, ...newValue };
        chrome.storage.local.set({ webpageSwitchDomains: domains });
    }
});

// 简化Service Worker活跃保持
const HEARTBEAT_INTERVAL = 20000;
const keepAliveInterval = setInterval(() => {
    // console.log('Service Worker 心跳:', new Date().toISOString());
}, HEARTBEAT_INTERVAL);

self.addEventListener('beforeunload', () => clearInterval(keepAliveInterval));

// 简化初始化检查
chrome.runtime.onInstalled.addListener(() => {
    console.log('扩展已安装/更新:', new Date().toISOString());

    // 创建右键菜单
    chrome.contextMenus.create({
        id: 'explain-image',
        title: '使用 Cerebr 解释图片',
        contexts: ['image']
    });
});

// 处理右键菜单点击
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'explain-image') {
        try {
            // 检查标签页是否已连接
            const isConnected = await isTabConnected(tab.id);
            if (!isConnected) {
                console.log('标签页未连接，等待重试...');
                await new Promise(resolve => setTimeout(resolve, 500));
                const retryConnection = await isTabConnected(tab.id);
                if (!retryConnection) {
                    console.log('重试失败，标签页仍未连接');
                    return;
                }
            }

            // 获取图片数据
            const response = await fetch(info.srcUrl);
            const blob = await response.blob();
            const reader = new FileReader();
            
            reader.onloadend = async () => {
                const base64Data = reader.result;
                const imageData = {
                    type: 'image',
                    data: base64Data,
                    name: 'right-click-image'
                };

                // 先打开侧边栏
                await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_SIDEBAR' });

                // 等待一下确保侧边栏已打开
                setTimeout(async () => {
                    // 发送图片数据到content script
                    await chrome.tabs.sendMessage(tab.id, {
                        type: 'EXPLAIN_IMAGE',
                        imageData: imageData
                    });
                }, 500);
            };

            reader.readAsDataURL(blob);
        } catch (error) {
            console.error('处理图片失败:', error);
        }
    }
});

// 简化标签页连接检查
async function isTabConnected(tabId) {
    try {
        await chrome.tabs.sendMessage(tabId, { type: 'PING' });
        return true;
    } catch {
        return false;
    }
}

// 简化消息发送
async function sendMessageToTab(tabId, message) {
    if (await isTabConnected(tabId)) {
        return chrome.tabs.sendMessage(tabId, message);
    }
    return null;
}

async function relaySidebarContentRequestToTab({
    message,
    sender,
    contentMessage,
    logLabel = '转发侧栏请求失败'
}) {
    let retryCount = 0;
    const maxRetries = 3;
    const retryDelay = 1000;

    async function tryRelay() {
        try {
            const targetTabId = resolveSidebarRequestTargetTabId({
                explicitTabId: message?.tabId,
                senderTabId: sender?.tab?.id
            });
            if (!Number.isFinite(targetTabId)) {
                return null;
            }

            if (!sender?.url || !sender.url.includes('src/ui/sidebar/sidebar.html')) {
                return null;
            }

            if (await isTabConnected(targetTabId)) {
                return await chrome.tabs.sendMessage(targetTabId, contentMessage);
            }
            return null;
        } catch (error) {
            console.error(`${logLabel} (尝试 ${retryCount + 1}/${maxRetries}):`, error);
            return null;
        }
    }

    while (retryCount < maxRetries) {
        const result = await tryRelay();
        if (result) {
            return result;
        }
        retryCount++;
        if (retryCount < maxRetries) {
            console.log(`等待 ${retryDelay}ms 后进行第 ${retryCount + 1} 次重试...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }

    return null;
}

/**
 * 后台统一执行“可见区域截图”。
 * 抽成独立函数后，供现有截图能力统一复用。
 *
 * @param {number|null} windowId
 * @returns {Promise<{success:boolean, dataURL?:string, error?:string}>}
 */
async function captureVisibleTab(windowId = null, options = null) {
    try {
        const normalizedWindowId = Number.isFinite(Number(windowId)) ? Number(windowId) : undefined;
        const requestedFormat = String(options?.format || 'png').trim().toLowerCase();
        const captureOptions = {
            format: requestedFormat === 'jpeg' ? 'jpeg' : 'png'
        };
        if (captureOptions.format === 'jpeg') {
            const numericQuality = Number(options?.quality);
            captureOptions.quality = Number.isFinite(numericQuality)
                ? Math.max(0, Math.min(100, Math.trunc(numericQuality)))
                : 85;
        }
        const dataURL = await chrome.tabs.captureVisibleTab(normalizedWindowId, captureOptions);
        return { success: true, dataURL };
    } catch (error) {
        const message = (typeof error?.message === 'string' && error.message.trim())
            ? error.message.trim()
            : (chrome.runtime.lastError?.message || 'captureVisibleTab 失败');
        return { success: false, error: message };
    }
}

/**
 * 为 agent 工具捕获一张“适合 prompt”的网页截图。
 *
 * 这里分两段：
 * 1. 先沿用现有后台截图入口拿到原始可见区域截图；
 * 2. 再按工具参数转成更适合传给模型的图片结果。
 *
 * @param {number|null} windowId
 * @param {any} rawArgs
 * @returns {Promise<Object>}
 */
async function captureVisibleTabForPrompt(windowId = null, rawArgs = null) {
    try {
        const { detail } = normalizeWebpageScreenshotArguments(rawArgs);
        const captured = await captureVisibleTab(windowId, { format: 'png' });
        if (!captured?.success || typeof captured?.dataURL !== 'string' || !captured.dataURL.trim()) {
            return {
                ok: false,
                error: {
                    message: captured?.error || '网页截图捕获失败。',
                    name: 'WebpageScreenshotCaptureError'
                }
            };
        }

        const promptImage = await buildPromptImageResultFromScreenshotDataUrl({
            dataUrl: captured.dataURL,
            detail
        });
        return {
            ok: true,
            ...promptImage
        };
    } catch (error) {
        return {
            ok: false,
            error: {
                message: (typeof error?.message === 'string' && error.message.trim())
                    ? error.message.trim()
                    : '网页截图工具处理失败。',
                name: (typeof error?.name === 'string' && error.name.trim())
                    ? error.name.trim()
                    : 'WebpageScreenshotToolError'
            }
        };
    }
}

/**
 * JS Runtime manager：
 * - 只负责基于 userScripts 的一次性执行；
 * - 不向页面执行环境注入任何扩展桥或宿主对象。
 */
const jsRuntimeManager = createJsRuntimeManager();
const microSkillManager = createMicroSkillManager({ jsRuntimeManager });
let microSkillManagerReadyPromise = null;

function ensureMicroSkillManagerReady(options = {}) {
  if (!microSkillManagerReadyPromise || options?.force === true) {
    microSkillManagerReadyPromise = microSkillManager
      .initialize()
      .catch((error) => {
        console.error('初始化微型 skill manager 失败:', error);
        throw error;
      });
  }
  return microSkillManagerReadyPromise;
}

if (chrome?.runtime?.onStartup?.addListener) {
  chrome.runtime.onStartup.addListener(() => {
    void ensureMicroSkillManagerReady({ force: true });
  });
}

if (chrome?.webNavigation?.onHistoryStateUpdated?.addListener) {
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (Number(details?.frameId) !== 0) return;
    if (!Number.isFinite(Number(details?.tabId))) return;
    void ensureMicroSkillManagerReady()
      .then(() => microSkillManager.syncCurrentDocumentSkills(Number(details.tabId), details.url || ''))
      .catch((error) => {
        console.warn('同页导航后同步微型 skill 失败:', error);
      });
  });
}

void ensureMicroSkillManagerReady().catch(() => {});



// 添加公共的PDF文件获取函数
async function getPDFArrayBuffer(url) {
    if (url.startsWith('file://')) {
        // 处理本地文件
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error('无法读取本地PDF文件');
        }
        return response.arrayBuffer();
    } else {
        // 处理在线文件
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error('PDF文件下载失败');
        }
        return response.arrayBuffer();
    }
}

// 修改 downloadPDF 函数
async function downloadPDF(url) {
    try {
        console.log('开始下载PDF文件:', url);
        const arrayBuffer = await getPDFArrayBuffer(url);
        console.log('PDF文件下载完成，大小:', arrayBuffer.byteLength, 'bytes');

        // 将ArrayBuffer转换为Uint8Array
        const uint8Array = new Uint8Array(arrayBuffer);

        // 分块大小设为4MB
        const chunkSize = 4 * 1024 * 1024;
        const chunks = Math.ceil(uint8Array.length / chunkSize);

        // 发送第一个消息，包含总块数和文件大小信息
        return {
            success: true,
            type: 'init',
            totalChunks: chunks,
            totalSize: uint8Array.length
        };
    } catch (error) {
        console.error('PDF下载失败:', error);
        console.error('错误堆栈:', error.stack);
        throw new Error('PDF下载失败: ' + error.message);
    }
}

// 修改 getPDFChunk 函数
async function getPDFChunk(url, chunkIndex) {
    try {
        const arrayBuffer = await getPDFArrayBuffer(url);
        const uint8Array = new Uint8Array(arrayBuffer);
        const chunkSize = 4 * 1024 * 1024;
        const start = chunkIndex * chunkSize;
        const end = Math.min(start + chunkSize, uint8Array.length);

        return {
            success: true,
            type: 'chunk',
            chunkIndex: chunkIndex,
            data: Array.from(uint8Array.slice(start, end))
        };
    } catch (error) {
        console.error('获取PDF块数据失败:', error);
        return {
            success: false,
            error: error.message
        };
    }
}
