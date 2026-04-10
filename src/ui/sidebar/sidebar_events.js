import { initTreeDebugger } from '../../debug/tree_debugger.js';
import { findMostRecentConversationMetadataByUrlCandidates } from '../../storage/indexeddb_helper.js';
import { packRemoteRepoViaApiExtension } from '../../utils/repomix.js';
import { generateCandidateUrls } from '../../utils/url_candidates.js';
import {
  buildPageToolModeStatusTitle,
  resolvePageToolEnvironment
} from '../../agent_tools/page_tool_environment.js';

// 全屏状态不再写入 sessionStorage，改由父页面在内存里同步，避免 F5 刷新仍保留旧布局。

/**
 * 注册侧边栏所需的事件绑定与交互逻辑。
 * 以 setup* 函数形式拆分，便于后续在个别功能上做替换或测试。
 *
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext - 侧边栏上下文对象。
 */
export function registerSidebarEventHandlers(appContext) {
  setupOpenStandaloneHandler(appContext);
  setupStatusDot(appContext);
  setupApiMenuWatcher(appContext);
  setupEmptyStateHandlers(appContext);
  setupRepomixButton(appContext);
  setupGlobalEscapeHandler(appContext);
  setupSlashFocusShortcut(appContext);
  setupClickAwayHandler(appContext);
  setupFullscreenToggle(appContext);
  setupDockModeToggle(appContext);
  setupScreenshotButton(appContext);
  setupWindowMessageHandlers(appContext);
  setupTempModeIndicator(appContext);
  setupMessageInputHandlers(appContext);
  setupSlashCommandHints(appContext);
  setupChatActionButtons(appContext);
  setupDebugButton(appContext);
  setupMemoryManagement(appContext);
  scheduleInitialRequests(appContext);
}

/**
 * 处理“打开独立页面”入口按钮。
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 */
function setupOpenStandaloneHandler(appContext) {
  if (appContext.dom.openStandalonePage && !appContext.state.isStandalone) {
    appContext.dom.openStandalonePage.addEventListener('click', async () => {
      try {
        await new Promise((resolve, reject) => {
          try {
            chrome.runtime.sendMessage({ type: 'OPEN_STANDALONE_CHAT' }, (response) => {
              const runtimeError = chrome.runtime.lastError;
              if (runtimeError) {
                reject(new Error(runtimeError.message));
                return;
              }
              if (response?.status === 'error') {
                reject(new Error(response.message || 'unknown error'));
                return;
              }
              resolve(response);
            });
          } catch (err) {
            reject(err);
          }
        });
        appContext.utils.showNotification('已在新标签页打开独立聊天');
      } catch (error) {
        console.error('打开独立聊天页面失败:', error);
        appContext.utils.showNotification({ message: '无法打开独立聊天页面', type: 'error' });
      }
      appContext.services.uiManager.toggleSettingsMenu(false);
    });
  }
}

/**
 * 管理左上角状态点（宿主页增强模式 / 纯对话隔离模式）的展示与交互。
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 */
function setupStatusDot(appContext) {
  const dot = appContext.dom.statusDot;
  if (!dot) return;
  if (appContext.state.isStandalone) {
    dot.style.display = 'none';
    return;
  }

  const sender = appContext.services.messageSender;
  const refresh = () => {
    const isTemp = sender.getTemporaryModeState?.() === true;
    const pageToolEnvironment = resolvePageToolEnvironment({
      isStandalone: appContext.state.isStandalone,
      isTemporaryMode: isTemp
    });
    if (pageToolEnvironment.exposeHostPageTools) {
      dot.classList.add('on');
    } else {
      dot.classList.remove('on');
    }
    dot.title = buildPageToolModeStatusTitle(pageToolEnvironment);
  };

  dot.addEventListener('click', () => {
    sender.toggleTemporaryMode();
    refresh();
  });

  refresh();
  window.addEventListener('message', (event) => {
    if (event?.data?.type === 'TOGGLE_TEMP_MODE_FROM_EXTENSION') {
      setTimeout(refresh, 0);
    }
  });
  document.addEventListener('TEMP_MODE_CHANGED', () => setTimeout(refresh, 0));
  if (appContext.dom.emptyStateTempMode && !appContext.state.isStandalone) {
    appContext.dom.emptyStateTempMode.addEventListener('click', () => setTimeout(refresh, 0));
  }
}

// 统一更新输入框占位符，保持 API 名称与模式提示一致。
function applyMessageInputPlaceholder(appContext, currentConfig) {
  const input = appContext?.dom?.messageInput;
  if (!input) return;
  const isTemporaryMode = appContext.services.messageSender?.getTemporaryModeState?.() === true;
  const buildPlaceholder = appContext.utils?.buildMessageInputPlaceholder;
  const placeholder = (typeof buildPlaceholder === 'function')
    ? buildPlaceholder(currentConfig, { isTemporaryMode })
    : (isTemporaryMode ? '纯对话模式，输入消息...' : '输入消息...');
  input.setAttribute('placeholder', placeholder);
}

function setupApiMenuWatcher(appContext) {
  const apiManager = appContext.services.apiManager;
  const chatHistoryUI = appContext.services.chatHistoryUI;
  const showNotification = appContext.utils?.showNotification;
  const messageInput = appContext.dom?.messageInput || null;

  const resolveConfigLabel = (config) => {
    if (!config) return 'API';
    return config.displayName || config.modelName || config.baseUrl || 'API';
  };

  const getFavoriteConfigItems = () => {
    const configs = apiManager.getAllConfigs?.() || [];
    return configs
      .map((config, index) => ({ config, index }))
      .filter(item => item.config && item.config.isFavorite);
  };

  const isEditableElement = (element) => {
    if (!element || !(element instanceof Element)) return false;
    if (element === messageInput) return false;
    if (element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return true;
    return element.getAttribute?.('contenteditable') === 'plaintext-only';
  };

  // Ctrl+↑ / Ctrl+↓ 在“收藏 API”集合里循环切换当前默认 API。
  // 规则：
  // - 仅在当前焦点不位于其它可编辑控件时触发（消息输入框除外）；
  // - 若当前 API 不在收藏中，向下从第一个开始，向上从最后一个开始；
  // - 始终按收藏列表顺序循环，避免用户感知与列表显示不一致。
  const cycleFavoriteApiSelection = (direction) => {
    const favoriteItems = getFavoriteConfigItems();
    if (!favoriteItems.length) return false;

    const normalizedDirection = direction > 0 ? 1 : -1;
    const selectedIndex = apiManager.getSelectedIndex?.();
    const currentFavoriteIndex = favoriteItems.findIndex(item => item.index === selectedIndex);
    const nextFavoriteIndex = (currentFavoriteIndex < 0)
      ? (normalizedDirection > 0 ? 0 : favoriteItems.length - 1)
      : (currentFavoriteIndex + normalizedDirection + favoriteItems.length) % favoriteItems.length;

    const targetItem = favoriteItems[nextFavoriteIndex];
    if (!targetItem) return false;
    const switched = apiManager.setSelectedIndex?.(targetItem.index);
    if (!switched) return false;

    const apiInfo = resolveConversationApiUiInfo().apiInfo;
    const apiLabel = resolveConfigLabel(targetItem.config);
    if (apiInfo?.hasLock) {
      showNotification?.({
        message: `已切换默认 API：${apiLabel}（当前对话已固定）`,
        type: 'info',
        duration: 1600
      });
    } else {
      showNotification?.({
        message: `已切换 API：${apiLabel}`,
        type: 'info',
        duration: 1200
      });
    }
    return true;
  };

  const handleFavoriteApiCycleShortcut = (e) => {
    if (!e || appContext.state.isComposing) return;
    if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;

    const activeElement = document.activeElement;
    if (isEditableElement(activeElement)) return;

    const handled = cycleFavoriteApiSelection(e.key === 'ArrowDown' ? 1 : -1);
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const resolveConversationApiUiInfo = () => {
    const apiInfo = (typeof chatHistoryUI?.resolveActiveConversationApiConfig === 'function')
      ? chatHistoryUI.resolveActiveConversationApiConfig()
      : null;
    const selectedConfig = apiInfo?.selectedConfig || apiManager.getSelectedConfig?.() || null;
    const displayConfig = apiInfo?.displayConfig || selectedConfig;
    return {
      apiInfo,
      selectedConfig,
      displayConfig
    };
  };

  const updateApiMenuText = (currentConfig, apiInfo = null) => {
    if (!currentConfig) return;
    const label = currentConfig.displayName || currentConfig.modelName || 'API 设置';
    appContext.dom.apiSettingsText.textContent = label;
    if (apiInfo?.hasLock) {
      appContext.dom.apiSettingsText.title = `该对话已固定：${label}`;
    } else {
      appContext.dom.apiSettingsText.title = label;
    }
  };

  const updateInputApiSwitcher = (apiContext) => {
    const switcher = appContext.dom.inputApiSwitcher;
    const currentEl = appContext.dom.inputApiCurrent;
    const listEl = appContext.dom.inputApiList;
    if (!switcher || !currentEl || !listEl) return;

    const apiInfo = apiContext?.apiInfo || null;
    const selectedConfig = apiContext?.selectedConfig || apiManager.getSelectedConfig?.() || null;
    const displayConfig = apiContext?.displayConfig || selectedConfig;
    const hasLock = !!apiInfo?.hasLock;
    const isLockValid = !!apiInfo?.isLockValid;

    const favoriteConfigs = getFavoriteConfigItems();

    const currentName = resolveConfigLabel(displayConfig);
    currentEl.textContent = '';
    const textSpan = document.createElement('span');
    textSpan.className = 'input-api-current-text';
    textSpan.textContent = currentName;
    if (hasLock) {
      const lockIcon = document.createElement('i');
      lockIcon.className = 'fa-solid fa-lock input-api-lock-icon';
      lockIcon.setAttribute('aria-hidden', 'true');
      currentEl.appendChild(lockIcon);
    }
    currentEl.appendChild(textSpan);
    currentEl.title = hasLock
      ? (isLockValid ? `已固定：${currentName}` : `已固定：${currentName}（已失效）`)
      : currentName;

    switcher.classList.toggle('locked', hasLock);
    switcher.classList.toggle('lock-invalid', hasLock && !isLockValid);

    listEl.innerHTML = '';
    const createOption = (label, onClick, options = {}) => {
      const entry = document.createElement('div');
      entry.className = 'input-api-option';
      if (options.variant) entry.classList.add(`input-api-option--${options.variant}`);
      entry.textContent = label;
      entry.title = options.title || label;
      if (typeof onClick === 'function') {
        entry.addEventListener('click', (e) => {
          e.stopPropagation();
          onClick(e);
        });
      } else {
        entry.classList.add('input-api-option--hint');
      }
      return entry;
    };

    const createDivider = () => {
      const divider = document.createElement('div');
      divider.className = 'input-api-divider';
      return divider;
    };

    if (favoriteConfigs.length === 0) {
      listEl.appendChild(createOption('暂无收藏 API', null, { variant: 'hint' }));
    } else {
      favoriteConfigs.forEach((item) => {
        const config = item.config;
        const index = item.index;
        if (!config) return;
        const label = resolveConfigLabel(config);
        const isSelected = !!(
          selectedConfig
          && (
            (selectedConfig.id && config.id && selectedConfig.id === config.id)
            || (
              !selectedConfig.id
              && !config.id
              && selectedConfig.baseUrl === config.baseUrl
              && selectedConfig.modelName === config.modelName
            )
          )
        );
        const displayLabel = isSelected ? `✓ ${label}` : label;
        listEl.appendChild(createOption(displayLabel, () => {
          apiManager.setSelectedIndex(index);
        }, { variant: 'action', title: label }));
      });
    }

    listEl.appendChild(createDivider());

    if (hasLock) {
      listEl.appendChild(createOption('取消固定（跟随当前）', () => {
        chatHistoryUI?.setConversationApiLock?.(null, null);
      }, { variant: 'action' }));

      if (!isLockValid) {
        listEl.appendChild(createOption('固定配置已失效，发送将回退', null, { variant: 'hint' }));
      }
    } else {
      listEl.appendChild(createOption('固定到当前对话', () => {
        if (!selectedConfig) {
          showNotification?.({ message: '当前没有可用的 API 配置', type: 'warning', duration: 2000 });
          return;
        }
        chatHistoryUI?.setConversationApiLock?.(null, selectedConfig);
      }, { variant: 'action' }));
    }

    const hasOptions = listEl.childElementCount > 0;
    switcher.classList.toggle('no-favorites', !hasOptions);
  };

  const updateAll = () => {
    const { apiInfo, selectedConfig, displayConfig } = resolveConversationApiUiInfo();
    updateApiMenuText(displayConfig, apiInfo);
    updateInputApiSwitcher({ apiInfo, selectedConfig, displayConfig });
    applyMessageInputPlaceholder(appContext, displayConfig);
  };

  updateAll();
  window.addEventListener('apiConfigsUpdated', updateAll);
  document.addEventListener('CONVERSATION_API_CONTEXT_CHANGED', updateAll);
  document.addEventListener('keydown', handleFavoriteApiCycleShortcut);
}

/**
 * 空态入口相关的按钮交互（历史、总结、加载会话等）。
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 */
function setupEmptyStateHandlers(appContext) {
  if (appContext.dom.emptyStateHistory) {
    appContext.dom.emptyStateHistory.addEventListener('click', () => {
      appContext.services.uiManager.closeExclusivePanels();
      appContext.services.chatHistoryUI.showChatHistoryPanel();
    });
  }

  if (appContext.dom.emptyStateSummary && !appContext.state.isStandalone) {
    appContext.dom.emptyStateSummary.addEventListener('click', () => {
      appContext.services.messageSender.performQuickSummary();
    });
  }

  if (appContext.dom.emptyStateTempMode && !appContext.state.isStandalone) {
    appContext.dom.emptyStateTempMode.addEventListener('click', () => {
      appContext.services.messageSender.toggleTemporaryMode();
      appContext.services.inputController.focusToEnd();
    });
  }

  if (appContext.dom.emptyStateLoadUrl && !appContext.state.isStandalone) {
    appContext.dom.emptyStateLoadUrl.addEventListener('click', async () => {
      const currentUrl = appContext.state.pageInfo?.url;
      if (!currentUrl) {
        appContext.utils.showNotification({ message: '未能获取当前页面URL', type: 'warning' });
        return;
      }
      const candidateUrls = generateCandidateUrls(currentUrl);

      // 性能优化：在游标遍历时直接完成“最匹配会话”的筛选，避免一次性拉取全部会话元数据并在 UI 层排序扫描。
      const matchingConversation = await findMostRecentConversationMetadataByUrlCandidates(candidateUrls);

      if (matchingConversation) {
        appContext.services.chatHistoryUI.loadConversationIntoChat(matchingConversation);
      } else {
        appContext.utils.showNotification('未找到本页面的相关历史对话');
      }
    });
  }

  if (appContext.dom.emptyStatePageContent && !appContext.state.isStandalone) {
    // 通过 background 触发 content script 提取网页内容，避免 iframe 无法直接访问页面 DOM。
    const requestPageContentSnapshot = async () => {
      if (!chrome?.runtime?.sendMessage) {
        appContext.utils.showNotification({ message: '无法获取页面内容（环境不支持）', type: 'error' });
        return null;
      }
      try {
        const targetTabId = await appContext.utils.resolveBoundSidebarTargetTabId?.();
        const payload = await new Promise((resolve, reject) => {
          try {
            chrome.runtime.sendMessage({
              type: 'GET_PAGE_CONTENT_READ_RESULT_FROM_SIDEBAR',
              tabId: Number.isFinite(Number(targetTabId)) ? Number(targetTabId) : null,
              args: null
            }, (response) => {
              const runtimeError = chrome.runtime.lastError;
              if (runtimeError) {
                reject(new Error(runtimeError.message));
                return;
              }
              resolve(response || null);
            });
          } catch (err) {
            reject(err);
          }
        });
        const title = typeof payload?.title === 'string' ? payload.title.trim() : '';
        const url = typeof payload?.url === 'string' ? payload.url.trim() : '';
        const content = typeof payload?.content === 'string' ? payload.content.trim() : '';
        if (payload?.ok !== true || !title || !url || !content) {
          appContext.utils.showNotification({ message: '未能提取到页面内容', type: 'warning' });
          return null;
        }
        return { title, url, content };
      } catch (error) {
        console.error('获取页面内容失败:', error);
        appContext.utils.showNotification({ message: '获取页面内容失败', type: 'error' });
        return null;
      }
    };

    const buildPageContentText = (snapshot, { withPrefix = true } = {}) => {
      if (!snapshot) return '';
      const prefix = withPrefix ? '已附加网页内容：\n' : '';
      return `${prefix}标题：${snapshot.title}\nURL：${snapshot.url}\n内容：${snapshot.content}`;
    };

    const appendPageContentToChat = async (text) => {
      try {
        appContext.services.messageProcessor.appendMessage(text, 'user', false, null, '');
        try {
          await appContext.services.chatHistoryUI.saveCurrentConversation(true);
          appContext.services.messageSender.setCurrentConversationId(
            appContext.services.chatHistoryUI.getCurrentConversationId()
          );
        } catch (_) {}
        appContext.utils.showNotification('已添加网页内容到历史（未发送）');
      } catch (error) {
        console.error('追加网页内容失败:', error);
        appContext.utils.showNotification({ message: '追加网页内容失败', type: 'error' });
      }
    };

    appContext.dom.emptyStatePageContent.addEventListener('click', async () => {
      const snapshot = await requestPageContentSnapshot();
      if (!snapshot) return;
      const text = buildPageContentText(snapshot, { withPrefix: true });
      await appendPageContentToChat(text);
    });

    appContext.dom.emptyStatePageContent.addEventListener('contextmenu', async (event) => {
      event.preventDefault();
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        appContext.utils.showNotification({ message: '当前环境不支持复制到剪贴板', type: 'warning' });
        return;
      }
      const snapshot = await requestPageContentSnapshot();
      if (!snapshot) return;
      const text = buildPageContentText(snapshot, { withPrefix: false });
      try {
        await navigator.clipboard.writeText(text);
        appContext.utils.showNotification({ message: '页面内容已复制到剪贴板', type: 'success' });
      } catch (error) {
        console.error('复制页面内容失败:', error);
        appContext.utils.showNotification({ message: '复制页面内容失败', type: 'error' });
      }
    });
  }

  const bindRandomBackgroundButton = (button) => {
    if (!button) return;
    if (button.dataset.randomBackgroundBound === 'true') return;
    button.dataset.randomBackgroundBound = 'true';

    const showNotification = appContext.utils?.showNotification;

    const resolveBackgroundImageUrl = (messages = {}) => {
      const {
        emptyMessage = '当前没有背景图片可用',
        invalidMessage = '无法解析当前背景图片地址'
      } = messages || {};
      const style = getComputedStyle(document.documentElement);
      const cssValue = (style.getPropertyValue('--cerebr-background-image') || '').trim();
      if (!cssValue || cssValue === 'none') {
        showNotification?.({
          message: emptyMessage,
          type: 'warning',
          duration: 2000
        });
        return '';
      }
      const match = cssValue.match(/url\(\s*(['"]?)(.*?)\1\s*\)/i);
      const imageUrl = match && match[2] ? match[2] : '';
      if (!imageUrl) {
        showNotification?.({
          message: invalidMessage,
          type: 'warning',
          duration: 2400
        });
        return '';
      }
      return imageUrl;
    };

    const fetchBackgroundBlob = async (imageUrl, failMessage) => {
      try {
        const response = await fetch(imageUrl);
        if (!response.ok) {
          throw new Error('请求失败: ' + response.status);
        }
        return await response.blob();
      } catch (error) {
        console.error('获取背景图片失败:', error);
        showNotification?.({
          message: failMessage,
          type: 'error',
          duration: 2600
        });
        return null;
      }
    };

    const ensurePngBlob = (inputBlob) => {
      if (inputBlob.type === 'image/png') return Promise.resolve(inputBlob);

      return new Promise((resolve, reject) => {
        try {
          const img = new Image();
          const objectUrl = URL.createObjectURL(inputBlob);
          img.onload = () => {
            try {
              const canvas = document.createElement('canvas');
              canvas.width = img.width;
              canvas.height = img.height;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(img, 0, 0);
              URL.revokeObjectURL(objectUrl);

              canvas.toBlob((pngBlob) => {
                if (pngBlob) {
                  resolve(pngBlob);
                } else {
                  reject(new Error('PNG 转码失败'));
                }
              }, 'image/png');
            } catch (e) {
              URL.revokeObjectURL(objectUrl);
              reject(e);
            }
          };
          img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('图片加载失败，无法转为 PNG'));
          };
          // 尝试避免跨域污染画布
          img.crossOrigin = 'anonymous';
          img.src = objectUrl;
        } catch (e) {
          reject(e);
        }
      });
    };

    const resolveDownloadExtension = (blob, imageUrl) => {
      const type = (blob?.type || '').toLowerCase();
      const typeMap = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'image/bmp': 'bmp'
      };
      if (typeMap[type]) return typeMap[type];
      const urlMatch = typeof imageUrl === 'string'
        ? imageUrl.match(/\.([a-z0-9]+)(?:$|[?#])/i)
        : null;
      const urlExt = urlMatch && urlMatch[1] ? urlMatch[1].toLowerCase() : '';
      if (urlExt && urlExt.length <= 5) return urlExt;
      return 'png';
    };

    const buildDownloadFilename = (extension) => {
      const stamp = new Date().toISOString().replace(/[^\d]/g, '').slice(0, 14);
      return `cerebr-background-${stamp}.${extension || 'png'}`;
    };

    // 左键：刷新随机背景图片
    button.addEventListener('click', () => {
      const settingsManager = appContext.services.settingsManager;
      if (!settingsManager?.refreshBackgroundImage) {
        console.warn('随机背景图片按钮点击时缺少 refreshBackgroundImage 方法');
        return;
      }
      settingsManager.refreshBackgroundImage();
    });

    // 中键：直接下载当前背景图片
    button.addEventListener('auxclick', async (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      const imageUrl = resolveBackgroundImageUrl({
        emptyMessage: '当前没有背景图片可下载',
        invalidMessage: '无法解析当前背景图片地址'
      });
      if (!imageUrl) return;
      const blob = await fetchBackgroundBlob(imageUrl, '获取背景图片失败，无法下载');
      if (!blob) return;
      try {
        const extension = resolveDownloadExtension(blob, imageUrl);
        const filename = buildDownloadFilename(extension);
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        showNotification?.({
          message: '已开始下载背景图片',
          type: 'success',
          duration: 2000
        });
      } catch (error) {
        console.error('下载背景图片失败:', error);
        showNotification?.({
          message: '下载背景图片失败',
          type: 'error',
          duration: 2600
        });
      }
    });

    // 右键：复制当前背景图片到剪贴板
    button.addEventListener('contextmenu', async (event) => {
      event.preventDefault();

      // 检查 Clipboard API 支持
      if (!navigator.clipboard || typeof navigator.clipboard.write !== 'function') {
        showNotification?.({
          message: '当前环境不支持复制图片到剪贴板',
          type: 'warning',
          duration: 2400
        });
        return;
      }

      const imageUrl = resolveBackgroundImageUrl({
        emptyMessage: '当前没有背景图片可以复制',
        invalidMessage: '无法解析当前背景图片地址'
      });
      if (!imageUrl) return;

      try {
        const blob = await fetchBackgroundBlob(imageUrl, '获取背景图片失败，无法复制到剪贴板');
        if (!blob) return;
        if (typeof ClipboardItem === 'undefined') {
          showNotification?.({
            message: '当前环境不支持图片剪贴板写入',
            type: 'error',
            duration: 2600
          });
          return;
        }

        const pngBlob = await ensurePngBlob(blob);
        const item = new ClipboardItem({ 'image/png': pngBlob });
        await navigator.clipboard.write([item]);

        showNotification?.({
          message: '已将背景图片以 PNG 格式复制到剪贴板',
          type: 'success',
          duration: 2000
        });
      } catch (error) {
        console.error('复制背景图片到剪贴板失败:', error);
        showNotification?.({
          message: '复制背景图片失败（可能是浏览器限制或跨域图片），请稍后重试',
          type: 'error',
          duration: 3200
        });
      }
    });
  };

  bindRandomBackgroundButton(appContext.dom.emptyStateRandomBackground);
  bindRandomBackgroundButton(appContext.dom.settingsRandomBackground);
}

/**
 * GitHub 仓库总结按钮：调用远端打包接口并把内容插入对话。
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 */
function setupRepomixButton(appContext) {
  if (appContext.dom.repomixButton && !appContext.state.isStandalone) {
    appContext.dom.repomixButton.addEventListener('click', async () => {
      const isGithubRepo = appContext.state.pageInfo?.url?.includes('github.com');
      if (!isGithubRepo) return;

      const repoUrl = appContext.state.pageInfo?.url;
      if (!repoUrl) return;

      const toast = appContext.utils.showNotification({
        message: '正在打包仓库...',
        showProgress: true,
        progress: 0.12,
        autoClose: false
      });

      let progressValue = 0.12;
      const progressTimer = setInterval(() => {
        progressValue = Math.min(0.6, progressValue + 0.07);
        toast.update({ progress: progressValue });
        if (progressValue >= 0.6) {
          clearInterval(progressTimer);
        }
      }, 700);

      try {
        const content = await packRemoteRepoViaApiExtension(repoUrl);
        clearInterval(progressTimer);

        if (!content) {
          toast.update({
            message: '未能打包仓库内容或内容为空。',
            type: 'warning',
            showProgress: false,
            autoClose: true,
            duration: 3200
          });
          return;
        }

        toast.update({ message: '仓库打包完成，正在插入内容...', progress: 0.85, progressMode: 'determinate' });

        const messageElement = appContext.services.messageProcessor.appendMessage(
          content,
          'user',
          false,
          null,
          null
        );

        if (!messageElement) {
          toast.update({
            message: '无法将仓库内容添加到对话中。',
            type: 'error',
            showProgress: false,
            autoClose: true,
            duration: 3200
          });
          return;
        }

        appContext.services.inputController.setInputText('全面分析介绍总结当前仓库的结构、内容、原理、核心逻辑的实现');
        appContext.dom.messageInput.focus();

        toast.update({
          message: '仓库内容已添加到当前对话。',
          progress: 1,
          autoClose: true,
          duration: 2200
        });
      } catch (error) {
        clearInterval(progressTimer);
        console.error('处理 repomixButton 点击事件失败:', error);
        toast.update({
          message: '打包仓库时发生错误。',
          type: 'error',
          showProgress: false,
          autoClose: true,
          duration: 3200
        });
      }
    });
  }
}

function setupGlobalEscapeHandler(appContext) {
  // ESC 打开聊天记录面板时，如果关闭超过 5 分钟未再次打开，则回退到默认“聊天记录”标签。
  const ESC_REOPEN_HISTORY_THRESHOLD_MS = 5 * 60 * 1000;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (appContext.state.isComposing) return;
    // 若存在统一确认对话框，交由对话框自身处理，不在此处影响面板状态
    if (document.querySelector('.confirm-overlay')) {
      return;
    }

    const chatOpen = appContext.services.chatHistoryUI.isChatHistoryPanelOpen();
    const anyPanelOpen = chatOpen;

    if (anyPanelOpen) {
      appContext.services.uiManager.closeExclusivePanels();
    } else {
      const lastClosedTab = appContext.services.chatHistoryUI.getLastClosedTabName?.();
      const lastClosedAt = appContext.services.chatHistoryUI.getLastClosedAt?.() || 0;
      const shouldFallbackToHistory = lastClosedAt > 0
        && (Date.now() - lastClosedAt) > ESC_REOPEN_HISTORY_THRESHOLD_MS;
      const targetTab = shouldFallbackToHistory
        ? 'history'
        : ((typeof lastClosedTab === 'string' && lastClosedTab.trim())
          ? lastClosedTab
          : 'history');
      appContext.services.chatHistoryUI.showChatHistoryPanel(targetTab);
    }
    e.preventDefault();
  });
}

function setupClickAwayHandler(appContext) {
  document.addEventListener('click', (e) => {
    // 若存在统一确认对话框，避免点击外部逻辑误关面板
    if (document.querySelector('.confirm-overlay')) {
      return;
    }
    const target = e.target;
    const previewModal = appContext.dom.previewModal || document.querySelector('.image-preview-modal');
    // 图片预览打开时，点击预览层只应关闭预览本身，不应触发“点击外部关闭聊天记录面板”。
    if (
      previewModal
      && previewModal.classList.contains('visible')
      && typeof previewModal.contains === 'function'
      && previewModal.contains(target)
    ) {
      return;
    }
    // 恢复经典交互：当聊天记录（Esc）面板打开时，点击面板外部应自动关闭。
    // 具体“是否点在面板内/触发按钮上”的判断由下方 managed 元素命中逻辑统一处理。

    const panelsAndToggles = [
      {
        panel: document.getElementById('chat-history-panel'),
        toggle: appContext.dom.chatHistoryMenuItem,
        openers: [
          appContext.dom.emptyStateHistory,
          appContext.dom.apiSettingsToggle,
          appContext.dom.promptSettingsToggle,
          appContext.dom.preferencesSettingsToggle
        ]
      }
    ];

    let clickInsideManagedElement = false;
    for (const pt of panelsAndToggles) {
      if (pt.panel && (pt.panel.classList.contains('visible') || pt.panel.style.display !== 'none') && pt.panel.contains(target)) {
        clickInsideManagedElement = true;
        break;
      }
      if (pt.toggle && pt.toggle.contains(target)) {
        clickInsideManagedElement = true;
        break;
      }
      if (pt.openers && pt.openers.some((opener) => opener && opener.contains(target))) {
        clickInsideManagedElement = true;
        break;
      }
    }

    if (!clickInsideManagedElement) {
      const chatHistoryPanelPinned = !!appContext.services.chatHistoryUI?.isChatHistoryPanelPinned?.();
      const chatHistoryPanelOpen = !!appContext.services.chatHistoryUI?.isChatHistoryPanelOpen?.();
      if (chatHistoryPanelOpen && chatHistoryPanelPinned) {
        return;
      }
      appContext.services.uiManager.closeExclusivePanels();
    }
  });
}

function setupSlashFocusShortcut(appContext) {
  // 处理侧栏全局“/”快捷键，未聚焦输入框时快速聚焦到输入框
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/') return;
    if (appContext.state.isComposing) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;

    const inputEl = appContext.dom.messageInput;
    if (!inputEl) return;
    if (document.activeElement === inputEl) return;

    const target = e.target;
    const isEditableTarget = (
      target &&
      (
        target.isContentEditable ||
        target.closest?.('[contenteditable="true"]') ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
      )
    );
    if (isEditableTarget) return;

    e.preventDefault();
    e.stopPropagation();

    appContext.services.inputController?.focusToEnd?.();
  });
}

/**
 * 将「全屏/侧栏」布局状态同步到 iframe 内部的 DOM，并更新相关入口的提示文案。
 *
 * 说明：
 * - 父页面（content script）负责真正把侧边栏容器扩展为 100vw/100vh；
 * - iframe 里只需要切换 html.fullscreen-mode，用来调整内部内容布局（居中宽度等）。
 * - 这里统一封装，避免不同入口（菜单项、左侧细长把手）各自维护一套状态导致漂移。
 *
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 * @param {boolean} isFullscreen
 */
let layoutModeSwitchTransitionTimer = null;
function applyFullscreenMode(appContext, isFullscreen) {
  const root = document.documentElement;
  // 切换布局模式时临时关闭背景层过渡，避免侧栏 <-> 全屏切换出现“模糊/缩放渐变”闪动。
  root.classList.add('layout-mode-switching');
  if (layoutModeSwitchTransitionTimer) {
    clearTimeout(layoutModeSwitchTransitionTimer);
  }
  appContext.state.isFullscreen = !!isFullscreen;
  root.classList.toggle('fullscreen-mode', appContext.state.isFullscreen);
  layoutModeSwitchTransitionTimer = setTimeout(() => {
    root.classList.remove('layout-mode-switching');
    layoutModeSwitchTransitionTimer = null;
  }, 220);
  updateFullscreenToggleHints(appContext);
}

/**
 * 将父页面同步的临时模式状态应用到 iframe 内部。
 * 说明：临时模式仅在父页面内存中保存，用于 iframe 右键重载时恢复，但 F5 刷新应回到默认状态。
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 * @param {boolean} isOn
 */
function applyTemporaryModeState(appContext, isOn) {
  const sender = appContext?.services?.messageSender;
  if (!sender || typeof sender.getTemporaryModeState !== 'function') return;
  const nextState = !!isOn;
  const currentState = sender.getTemporaryModeState() === true;
  if (currentState === nextState) return;
  if (nextState) {
    sender.enterTemporaryMode?.();
  } else {
    sender.exitTemporaryMode?.();
  }
}

/**
 * 根据当前布局模式刷新「全屏」菜单项与左侧把手的提示文案。
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 */
function updateFullscreenToggleHints(appContext) {
  const isFullscreen = !!appContext.state.isFullscreen;

  const collapseButton = appContext.dom.collapseButton;
  if (collapseButton) {
    const label = isFullscreen ? '退出全屏（侧栏模式）' : '切换全屏（沉浸模式）';
    collapseButton.title = label;
    collapseButton.setAttribute('aria-label', label);
  }

  const fullscreenToggle = appContext.dom.fullscreenToggle;
  if (fullscreenToggle) {
    const text = fullscreenToggle.querySelector('span');
    if (text) {
      text.textContent = isFullscreen ? '侧栏模式' : '全屏模式';
    }
    const icon = fullscreenToggle.querySelector('i');
    if (icon) {
      icon.classList.remove('fa-expand', 'fa-compress');
      icon.classList.add(isFullscreen ? 'fa-compress' : 'fa-expand');
    }
  }
}

/**
 * 由 iframe 主动发起全屏切换请求（通知父页面执行真实的全屏/退出全屏）。
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 */
function requestToggleFullscreen(appContext) {
  if (appContext.state.isStandalone) {
    appContext.utils.showNotification('独立聊天页面始终为全屏布局');
    return;
  }

  // 先在 iframe 内即时切换布局（避免等待父页面处理消息造成“闪一下/不跟手”）
  applyFullscreenMode(appContext, !appContext.state.isFullscreen);
  window.parent.postMessage({ type: 'TOGGLE_FULLSCREEN_FROM_IFRAME' }, '*');
}

function requestToggleDockMode(appContext) {
  if (appContext.state.isStandalone) {
    appContext.utils.showNotification('独立聊天页面不支持停靠模式');
    return;
  }
  window.parent.postMessage({ type: 'TOGGLE_DOCK_MODE_FROM_IFRAME' }, '*');
}

function setupFullscreenToggle(appContext) {
  // 初始化时仅用 DOM class 兜底，真实状态由父页面同步，避免 F5 刷新误继承旧状态。
  if (!appContext.state.isStandalone) {
    appContext.state.isFullscreen = document.documentElement.classList.contains('fullscreen-mode');
    updateFullscreenToggleHints(appContext);
  } else {
    updateFullscreenToggleHints(appContext);
  }

  if (appContext.dom.fullscreenToggle) {
    appContext.dom.fullscreenToggle.addEventListener('click', () => requestToggleFullscreen(appContext));
  }

  // 左侧（或左侧布局时出现在右侧）的细长把手：改为切换「全屏/侧栏」布局
  if (appContext.dom.collapseButton) {
    appContext.dom.collapseButton.addEventListener('click', () => requestToggleFullscreen(appContext));
    appContext.dom.collapseButton.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      requestToggleFullscreen(appContext);
    });
  }
}

function setupDockModeToggle(appContext) {
  if (!appContext.dom.dockModeToggle) return;
  appContext.dom.dockModeToggle.addEventListener('click', () => requestToggleDockMode(appContext));
}

function setupScreenshotButton(appContext) {
  if (!appContext.dom.screenshotButton) return;
  appContext.dom.screenshotButton.addEventListener('click', () => {
    appContext.utils.requestScreenshot();
  });
}

/**
 * 监听来自 content script / background 的消息，完成状态同步与快捷操作。
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 */
function setupWindowMessageHandlers(appContext) {
  window.addEventListener('message', (event) => {
    const { data } = event;
    if (!data?.type) {
      return;
    }

    switch (data.type) {
      case 'ADD_TEXT_TO_CONTEXT':
        if (appContext.state.isStandalone) {
          break;
        }
        (async () => {
          try {
            const text = (data.text || '').trim();
            if (!text) return;

            appContext.services.messageProcessor.appendMessage(
              text,
              'user',
              false,
              null,
              ''
            );

            try {
              await appContext.services.chatHistoryUI.saveCurrentConversation(true);
              appContext.services.messageSender.setCurrentConversationId(
                appContext.services.chatHistoryUI.getCurrentConversationId()
              );
            } catch (_) {}

            appContext.utils.showNotification('已添加网页内容到历史（未发送）');
          } catch (err) {
            console.error('添加文本到上下文失败:', err);
          }
        })();
        break;
      case 'DROP_IMAGE':
        if (data.imageData?.data) {
          appContext.utils.addImageToContainer(data.imageData.data, data.imageData.name);
        }
        if (data.explain) {
          appContext.services.messageSender.sendMessage();
        }
        break;
      case 'FOCUS_INPUT':
        appContext.services.inputController.focusToEnd();
        break;
      case 'URL_CHANGED':
        if (appContext.state.isStandalone) {
          break;
        }
        appContext.state.pageInfo = data;
        window.cerebr.pageInfo = data;
        appContext.services.chatHistoryUI.updatePageInfo(data);
        if (appContext.dom.repomixButton) {
          const isGithubRepo = data.url?.includes('github.com');
          appContext.dom.repomixButton.style.display = isGithubRepo ? 'block' : 'none';
        }
        break;
      case 'UPDATE_PLACEHOLDER':
        if (appContext.dom.messageInput) {
          appContext.dom.messageInput.setAttribute('placeholder', data.placeholder);
          if (data.timeout) {
            setTimeout(() => {
              const apiInfo = appContext.services.chatHistoryUI?.resolveActiveConversationApiConfig?.();
              const displayConfig = apiInfo?.displayConfig || appContext.services.apiManager?.getSelectedConfig?.() || null;
              applyMessageInputPlaceholder(appContext, displayConfig);
            }, data.timeout);
          }
        }
        break;
      case 'QUICK_SUMMARY_COMMAND':
        if (appContext.state.isStandalone) {
          appContext.utils.showNotification({ message: '独立聊天页面不支持网页总结', type: 'warning' });
          break;
        }
        appContext.services.messageSender.performQuickSummary(data.selectedContent);
        break;
      case 'QUICK_SUMMARY_COMMAND_QUERY':
        if (appContext.state.isStandalone) {
          appContext.utils.showNotification({ message: '独立聊天页面不支持网页总结', type: 'warning' });
          break;
        }
        appContext.services.messageSender.performQuickSummary(data.selectedContent, true);
        break;
      case 'TOGGLE_TEMP_MODE_FROM_EXTENSION':
        if (appContext.state.isStandalone) {
          break;
        }
        appContext.services.messageSender.toggleTemporaryMode();
        if (appContext.dom.modeIndicator) {
          setTimeout(() => {
            const isOn = appContext.services.messageSender.getTemporaryModeState?.();
            appContext.dom.modeIndicator.style.display = isOn ? 'inline-flex' : 'none';
          }, 0);
        }
        break;
      case 'FULLSCREEN_STATE_CHANGED':
        if (appContext.state.isStandalone) {
          break;
        }
        applyFullscreenMode(appContext, data.isFullscreen);
        break;
      case 'TEMP_MODE_STATE_SYNC':
        if (appContext.state.isStandalone) {
          break;
        }
        if (!Object.prototype.hasOwnProperty.call(data, 'isOn')) {
          break;
        }
        applyTemporaryModeState(appContext, data.isOn);
        break;
      default:
        break;
    }
  });
}

/**
 * 斜杠命令提示面板：在输入框中输入 "/" 时显示提示列表。
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 */
function setupSlashCommandHints(appContext) {
  const input = appContext.dom.messageInput;
  const sender = appContext.services.messageSender;

  if (!input) return;
  if (!sender || typeof sender.getSlashCommandHints !== 'function') return;

  let isPointerInside = false;
  let panel = null;
  let header = null;
  let list = null;
  let closeTimer = 0;
  const hintState = {
    items: [],
    activeIndex: -1,
    isVisible: false,
    lastActiveKey: ''
  };

  const clearCloseTimer = () => {
    if (!closeTimer) return;
    window.clearTimeout(closeTimer);
    closeTimer = 0;
  };

  const clearList = () => {
    if (!list) return;
    while (list.firstChild) {
      list.removeChild(list.firstChild);
    }
  };

  const getAccessoryHost = () => {
    return appContext.utils.getComposerAccessoryRegion?.()
      || appContext.dom.composerAccessoryRegion
      || appContext.dom.inputContainer
      || null;
  };

  const detachPanel = () => {
    if (!panel) return;
    panel.classList.remove('is-closing');
    panel.setAttribute('aria-hidden', 'true');
    if (panel.isConnected) {
      panel.remove();
      appContext.utils.refreshComposerAccessoryLayout?.();
    }
  };

  const ensurePanel = () => {
    const host = getAccessoryHost();
    if (!host) return null;

    clearCloseTimer();

    if (!panel) {
      panel = document.createElement('section');
      panel.className = 'composer-accessory-drawer composer-slash-command-panel';
      panel.setAttribute('aria-hidden', 'true');
      panel.setAttribute('aria-label', '斜杠命令');

      const surface = document.createElement('div');
      surface.className = 'composer-accessory-drawer-surface composer-slash-command-surface';

      header = document.createElement('div');
      header.className = 'slash-command-hints-header';
      surface.appendChild(header);

      list = document.createElement('div');
      list.className = 'slash-command-hints-list';
      surface.appendChild(list);

      panel.appendChild(surface);

      panel.addEventListener('pointerenter', () => { isPointerInside = true; });
      panel.addEventListener('pointerleave', () => { isPointerInside = false; });
      panel.addEventListener('mousemove', (e) => {
        const item = e.target?.closest?.('.slash-command-hint-item');
        if (!item || !list) return;
        const items = list.querySelectorAll('.slash-command-hint-item');
        const index = Array.from(items).indexOf(item);
        if (index >= 0) setActiveIndex(index);
      });
      panel.addEventListener('mousedown', (e) => {
        // 阻止点击提示面板时输入框失焦，保证点击选择不会先触发 blur 关闭。
        e.preventDefault();
      });
      panel.addEventListener('click', (e) => {
        const item = e.target?.closest?.('.slash-command-hint-item');
        if (!item) return;
        if (!executeHintIfNeeded(item)) {
          applyHintToInput(item);
        }
      });
    }

    panel.classList.remove('is-closing');
    panel.setAttribute('aria-hidden', 'false');
    hintState.isVisible = true;

    if (panel.parentElement !== host || host.lastElementChild !== panel) {
      host.appendChild(panel);
      appContext.utils.refreshComposerAccessoryLayout?.();
    }

    return panel;
  };

  const hideHints = () => {
    clearCloseTimer();
    clearList();
    hintState.items = [];
    hintState.activeIndex = -1;
    hintState.lastActiveKey = '';
    hintState.isVisible = false;

    if (!panel) return;
    panel.setAttribute('aria-hidden', 'true');
    if (!panel.isConnected) {
      panel.classList.remove('is-closing');
      return;
    }
    panel.classList.add('is-closing');
    closeTimer = window.setTimeout(() => {
      closeTimer = 0;
      detachPanel();
    }, 140);
  };

  const buildEmptyItem = (keyword) => {
    const item = document.createElement('div');
    item.className = 'slash-command-hint-item slash-command-hint-item--empty';
    item.textContent = keyword ? `未找到匹配 “${keyword}” 的命令` : '暂无可用命令';
    return item;
  };

  const buildHintItem = (hintItem) => {
    const itemEl = document.createElement('div');
    itemEl.className = 'slash-command-hint-item';
    itemEl.dataset.key = hintItem.key || '';
    itemEl.dataset.kind = hintItem.kind || 'command';
    itemEl.dataset.apply = hintItem.applyText || '';
    itemEl.dataset.execute = hintItem.executeOnEnter ? '1' : '0';

    // 斜杠菜单改为紧凑单行：左边保留完整命令模板，右边保留灰字说明，
    // 避免同一命令在左右两侧重复显示并浪费垂直空间。
    const command = document.createElement('div');
    command.className = 'slash-command-hint-command';
    command.textContent = hintItem.usage || hintItem.applyText || hintItem.label || '';

    const desc = document.createElement('div');
    desc.className = 'slash-command-hint-desc';
    desc.textContent = hintItem.description || '';

    itemEl.appendChild(command);
    itemEl.appendChild(desc);
    return itemEl;
  };

  const setActiveIndex = (index) => {
    if (!list) {
      hintState.activeIndex = -1;
      return;
    }
    const items = list.querySelectorAll('.slash-command-hint-item');
    const total = items.length;
    if (!total) {
      hintState.activeIndex = -1;
      return;
    }
    const clamped = Math.max(0, Math.min(index, total - 1));
    items.forEach((el, idx) => {
      if (idx === clamped) {
        el.classList.add('is-active');
        el.setAttribute('aria-selected', 'true');
        hintState.lastActiveKey = el.dataset.key || '';
      } else {
        el.classList.remove('is-active');
        el.setAttribute('aria-selected', 'false');
      }
    });
    hintState.activeIndex = clamped;
    try {
      const activeEl = items[clamped];
      activeEl?.scrollIntoView?.({ block: 'nearest' });
    } catch (_) {}
  };

  const resolveDefaultActiveIndex = () => {
    if (!list) return -1;
    const items = list.querySelectorAll('.slash-command-hint-item');
    if (!items.length) return -1;
    if (hintState.lastActiveKey) {
      for (let i = 0; i < items.length; i += 1) {
        if (items[i].dataset.key === hintState.lastActiveKey) return i;
      }
    }
    return 0;
  };

  const updateHints = () => {
    const text = input.textContent || '';
    const result = sender.getSlashCommandHints(text);
    if (!result || !result.isActive) {
      hideHints();
      return;
    }

    const items = Array.isArray(result.items) ? result.items : [];
    const keyword = result.keyword || '';

    if (!ensurePanel() || !header || !list) {
      hideHints();
      return;
    }

    clearList();
    const title = keyword ? `斜杠命令 · 匹配 "${keyword}"` : '斜杠命令';
    header.textContent = title;

    if (items.length === 0) {
      list.appendChild(buildEmptyItem(keyword));
      hintState.items = [];
      hintState.activeIndex = -1;
      return;
    }

    items.forEach((hintItem) => {
      list.appendChild(buildHintItem(hintItem));
    });

    hintState.items = items;
    const nextIndex = resolveDefaultActiveIndex();
    if (nextIndex >= 0) {
      setActiveIndex(nextIndex);
    }
  };

  const applyHintToInput = (itemEl) => {
    if (!itemEl) return;
    const applyText = itemEl.dataset.apply || '';
    if (!applyText) return;
    input.textContent = applyText;
    appContext.services.inputController?.focusToEnd?.();
    appContext.services.uiManager?.updateSendButtonState?.();
    updateHints();
  };

  const executeHintIfNeeded = (itemEl) => {
    if (!itemEl) return false;
    const shouldExecute = itemEl.dataset.execute === '1';
    if (!shouldExecute) return false;
    const applyText = itemEl.dataset.apply || '';
    if (!applyText) return false;
    input.textContent = applyText;
    appContext.services.inputController?.focusToEnd?.();
    appContext.services.uiManager?.updateSendButtonState?.();
    hideHints();
    appContext.services.messageSender.sendMessage();
    return true;
  };

  input.addEventListener('input', updateHints);
  input.addEventListener('focus', updateHints);
  input.addEventListener('blur', () => {
    // 如果鼠标停留在提示面板上，稍后再决定是否关闭
    setTimeout(() => {
      if (isPointerInside) return;
      hideHints();
    }, 80);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    hideHints();
  });

  // 供其他逻辑（发送、清空等）主动关闭提示面板
  appContext.utils.hideSlashCommandHints = hideHints;
  appContext.utils.updateSlashCommandHints = updateHints;
  appContext.utils.handleSlashCommandKeydown = (e) => {
    if (!hintState.isVisible) return false;
    if (!list || list.children.length === 0) return false;

    const hasActionableItem = () => {
      const items = list.querySelectorAll('.slash-command-hint-item');
      return Array.from(items).some(el => (el.dataset.apply || '').trim());
    };

    if (!hasActionableItem()) return false;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const delta = (e.key === 'ArrowDown') ? 1 : -1;
      const nextIndex = hintState.activeIndex < 0 ? 0 : hintState.activeIndex + delta;
      setActiveIndex(nextIndex);
      return true;
    }

    if (e.key === 'Enter') {
      const items = list.querySelectorAll('.slash-command-hint-item');
      if (!items.length) return false;
      const idx = hintState.activeIndex >= 0 ? hintState.activeIndex : 0;
      const activeItem = items[idx];
      if (!activeItem) return false;
      if (!(activeItem.dataset.apply || '').trim()) return false;
      e.preventDefault();
      e.stopPropagation();
      if (!executeHintIfNeeded(activeItem)) {
        applyHintToInput(activeItem);
      }
      return true;
    }

    return false;
  };
}

function setupTempModeIndicator(appContext) {
  document.addEventListener('TEMP_MODE_CHANGED', (e) => {
    const isOn = !!e?.detail?.isOn;
    if (appContext?.dom?.modeIndicator) {
      appContext.dom.modeIndicator.style.display = isOn ? 'inline-flex' : 'none';
      appContext.dom.modeIndicator.title = isOn ? '仅对话模式中，点击退出' : '点击进入仅对话模式';
    }
    // 将临时模式变更同步给父页面，由父页面在内存里缓存，供 iframe 右键重载时恢复。
    if (!appContext.state.isStandalone) {
      try {
        window.parent.postMessage({ type: 'TEMP_MODE_STATE_CHANGED', isOn }, '*');
      } catch (_) {}
    }
  });
}

/**
 * 统一处理输入框的组合键、重新生成等逻辑。
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 */
function setupMessageInputHandlers(appContext) {
  const input = appContext.dom.messageInput;
  if (!input) return;

  input.addEventListener('compositionstart', () => { appContext.state.isComposing = true; });
  input.addEventListener('compositionend', () => { appContext.state.isComposing = false; });

  input.addEventListener('keydown', async function (e) {
    if (appContext.utils.handleSlashCommandKeydown?.(e)) return;
    if (e.key !== 'Enter') return;
    // Shift+Enter 始终保留为原生换行，不进入发送/转向逻辑。
    if (e.shiftKey) return;
    if (appContext.state.isComposing) return;
    // 阻止默认行为，避免触发表单提交或换行等浏览器默认处理
    e.preventDefault();
    // 阻止事件传播，避免其他监听器（如全局或父级）误判为普通 Enter 而触发发送
    // 特别是 Alt+Enter 仅用于“添加到历史（未发送）”，不应触发其他逻辑
    e.stopPropagation();
    // 按下 Enter 后优先关闭斜杠命令提示面板，避免残留
    appContext.utils.hideSlashCommandHints?.();

    // 兼容右 Alt（AltGr）：
    // - 在部分键盘布局/浏览器实现中，右 Alt 会表现为 AltGraph；
    // - 此时 event.altKey 可能为 false，导致“右 Alt + Enter”被当作普通 Enter 直接发送；
    // - 因此这里将 AltGraph 也视为 Alt 修饰键，确保左右 Alt 行为一致。
    const hasAltGraph = typeof e.getModifierState === 'function' && e.getModifierState('AltGraph');
    const hasAltModifier = e.altKey || hasAltGraph;

    if (hasAltModifier) {
      // Alt+Enter：只添加到历史，不发送
      // 说明：有些环境下可能还存在捕获阶段/冒泡阶段的监听，显式阻断
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      if (appContext.state.isComposing) return;
      const text = (this.textContent || '').trim();
      const imagesHTML = appContext.dom.imageContainer?.innerHTML || '';
      const hasImages = !!appContext.dom.imageContainer?.querySelector('.image-tag');
      if (!text && !hasImages) {
        // 没有任何内容时，不进行添加，给出轻提示
        appContext.utils?.showNotification?.({ message: '没有可添加的内容', type: 'warning' });
        return;
      }

      const selectionThreadManager = appContext.services.selectionThreadManager;
      const isThreadModeActive = selectionThreadManager?.isThreadModeActive?.();
      let appendedToThread = false;

      if (isThreadModeActive) {
        // 线程模式下的 Alt+Enter：附加到线程链路，避免误写入主对话。
        const threadId = selectionThreadManager?.getActiveThreadId?.() || '';
        const threadInfo = selectionThreadManager?.findThreadById?.(threadId);
        const threadAnnotation = threadInfo?.annotation || null;
        const anchorMessageId = threadInfo?.anchorMessageId || '';

        if (!threadId || !threadAnnotation || !anchorMessageId) {
          appContext.utils?.showNotification?.({ message: '划词线程状态异常，未能添加消息', type: 'warning' });
          selectionThreadManager?.exitThread?.();
          return;
        }

        const chatHistoryManager = appContext.services.chatHistoryManager;
        const anchorNode = chatHistoryManager?.chatHistory?.messages?.find(m => m.id === anchorMessageId) || null;
        if (!anchorNode) {
          appContext.utils?.showNotification?.({ message: '划词线程锚点已丢失，未能添加消息', type: 'warning' });
          selectionThreadManager?.exitThread?.();
          return;
        }

        let rootMessageId = threadAnnotation.rootMessageId || null;
        if (!rootMessageId) {
          const selectionText = threadAnnotation.selectionText || '';
          const content = selectionText ? `> ${selectionText}` : '>';
          const rootNode = chatHistoryManager.addMessageToTreeWithOptions(
            'user',
            content,
            anchorMessageId,
            { preserveCurrentNode: true }
          );
          if (!rootNode) {
            appContext.utils?.showNotification?.({ message: '创建划词线程锚点失败', type: 'warning' });
            return;
          }
          rootNode.threadId = threadId;
          rootNode.threadAnchorId = anchorMessageId;
          rootNode.threadSelectionText = selectionText;
          rootNode.threadHiddenSelection = true;
          rootNode.threadMatchIndex = Number.isFinite(threadAnnotation.matchIndex)
            ? threadAnnotation.matchIndex
            : 0;
          threadAnnotation.rootMessageId = rootNode.id;
          threadAnnotation.lastMessageId = rootNode.id;
          rootMessageId = rootNode.id;
        }

        const historyParentId = threadAnnotation.lastMessageId || rootMessageId || anchorMessageId;
        const threadHistoryPatch = {
          threadId,
          threadAnchorId: anchorMessageId,
          threadSelectionText: threadAnnotation.selectionText || '',
          threadRootId: rootMessageId
        };

        const newMessage = appContext.services.messageProcessor.appendMessage(
          text,
          'user',
          false,
          null,
          imagesHTML,
          null,
          null,
          null,
          {
            container: appContext.dom.threadContainer,
            historyParentId,
            preserveCurrentNode: true,
            historyPatch: threadHistoryPatch
          }
        );
        const newMessageId = newMessage?.getAttribute?.('data-message-id') || '';
        if (newMessageId) {
          threadAnnotation.lastMessageId = newMessageId;
        }
        if (appContext.dom.threadContainer) {
          appContext.dom.threadContainer.scrollTop = appContext.dom.threadContainer.scrollHeight;
        }
        appendedToThread = true;
      } else {
        appContext.services.messageProcessor.appendMessage(
          text,
          'user',
          false,
          null,
          imagesHTML
        );
      }

      try { appContext.dom.messageInput.innerHTML = ''; } catch (_) {}
      try { appContext.dom.imageContainer.innerHTML = ''; } catch (_) {}
      try { appContext.services.uiManager.resetInputHeight(); } catch (_) {}

      try {
        await appContext.services.chatHistoryUI.saveCurrentConversation(true);
        appContext.services.messageSender.setCurrentConversationId(
          appContext.services.chatHistoryUI.getCurrentConversationId()
        );
      } catch (_) {}

      appContext.utils.showNotification(appendedToThread ? '已添加到线程（未发送）' : '已添加到历史（未发送）');
      return;
    }

    const text = this.textContent.trim();
    const hasImagesInInput = !!appContext.dom.imageContainer?.querySelector('.image-tag');

    if (!text && !hasImagesInInput) {
      try {
        const lastMessage = appContext.dom.chatContainer.querySelector('.message:last-child');
        if (!lastMessage) {
          appContext.utils.showNotification({ message: '没有可用的历史用户消息', type: 'warning' });
          return;
        }
        if (!lastMessage.classList?.contains('user-message')) {
          appContext.utils.showNotification({ message: '最后一条消息不是用户消息，未发送', type: 'warning' });
          return;
        }
        appContext.services.messageSender.sendMessage({
          originalMessageText: '',
          forceSendFullHistory: true
        });
      } catch (err) {
        console.error('空输入触发生成失败:', err);
      }
      return;
    }

    if (e.ctrlKey) {
      // Ctrl+Enter：标准 steer。
      // - 仅在当前存在 active turn 时才成立；
      // - 不会自动回退为普通发送，避免把“标准 steer”悄悄降级成别的语义；
      // - 若当前没有正在生成的请求，messageSender 会给出轻提示并保持输入框原状。
      appContext.services.messageSender.sendSteerMessage();
      return;
    }
    // 兜底保护：若仍检测到 Alt/Ctrl/Meta 修饰键，则不发送，避免误发
    if (e.altKey || hasAltGraph || e.ctrlKey || e.metaKey) {
      return;
    }
    appContext.services.messageSender.sendMessage();
  });
}

function setupChatActionButtons(appContext) {
  appContext.dom.clearChat.addEventListener('click', async () => {
    await appContext.services.chatHistoryUI.clearChatHistory();
    appContext.services.uiManager.toggleSettingsMenu(false);
    appContext.dom.messageInput.focus();
  });

  appContext.dom.quickSummary.addEventListener('click', () => appContext.services.messageSender.performQuickSummary());
  appContext.dom.sendButton.addEventListener('click', () => {
    appContext.utils.hideSlashCommandHints?.();
    appContext.services.messageSender.sendMessage();
  });

  if (appContext.dom.chatHistoryMenuItem) {
    appContext.dom.chatHistoryMenuItem.addEventListener('click', async () => {
      const chatHistoryUI = appContext.services.chatHistoryUI;
      const targetTab = 'history';
      const isPanelOpen = !!chatHistoryUI?.isChatHistoryPanelOpen?.();
      const activeTab = chatHistoryUI?.getActiveTabName?.();

      // 行为对齐提示词/API：同一标签再点一次关闭，否则切换到目标标签。
      if (isPanelOpen && activeTab === targetTab) {
        appContext.services.uiManager.closeExclusivePanels();
        return;
      }

      if (!isPanelOpen) {
        appContext.services.uiManager.closeExclusivePanels();
        await chatHistoryUI?.showChatHistoryPanel?.(targetTab);
      } else {
        await chatHistoryUI?.activateTab?.(targetTab);
      }
    });
  }
}

function setupDebugButton(appContext) {
  if (!appContext.dom.debugTreeButton) return;
  appContext.dom.debugTreeButton.addEventListener('click', () => {
    initTreeDebugger(appContext.services.chatHistoryManager.chatHistory);
  });
}

/**
 * 启动前端内存管理逻辑：统计用户活跃度并定期清理缓存。
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext
 */
function setupMemoryManagement(appContext) {
  const mmConfig = appContext.state.memoryManagement;

  const updateUserActivity = () => {
    appContext.state.memoryManagement.lastUserActivity = Date.now();
  };

  const throttle = (func, limit) => {
    let lastFunc;
    let lastRan;
    return function (...args) {
      const context = this;
      if (!lastRan) {
        func.apply(context, args);
        lastRan = Date.now();
      } else {
        clearTimeout(lastFunc);
        lastFunc = setTimeout(function () {
          if ((Date.now() - lastRan) >= limit) {
            func.apply(context, args);
            lastRan = Date.now();
          }
        }, limit - (Date.now() - lastRan));
      }
    };
  };

  const checkAndCleanupMemory = () => {
    const mmState = appContext.state.memoryManagement;
    if (!mmState.isEnabled) return;
    const idleTime = Date.now() - mmState.lastUserActivity;
    if (idleTime > mmState.USER_IDLE_THRESHOLD) {
      appContext.services.chatHistoryUI.clearMemoryCache();
    }
  };

  const forcedMemoryCleanup = () => {
    if (!appContext.state.memoryManagement.isEnabled) return;
    appContext.services.chatHistoryUI.clearMemoryCache();
  };

  document.addEventListener('click', updateUserActivity);
  document.addEventListener('keypress', updateUserActivity);
  document.addEventListener('mousemove', throttle(updateUserActivity, 5000));
  setInterval(checkAndCleanupMemory, mmConfig.IDLE_CLEANUP_INTERVAL);
  setInterval(forcedMemoryCleanup, mmConfig.FORCED_CLEANUP_INTERVAL);
}

function scheduleInitialRequests(appContext) {
  setTimeout(() => {
    if (!appContext.state.isStandalone) {
      window.parent.postMessage({ type: 'REQUEST_PAGE_INFO' }, '*');
      window.parent.postMessage({ type: 'REQUEST_FULLSCREEN_STATE' }, '*');
      window.parent.postMessage({ type: 'REQUEST_TEMP_MODE_STATE' }, '*');
    }

    if (appContext.state.isFullscreen) {
      applyFullscreenMode(appContext, true);
    }
  }, 500);
}
