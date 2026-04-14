import { renderMarkdownSafe } from './markdown_renderer.js';
import {
  buildNextConversationDocumentRenderMode,
  CONVERSATION_DOCUMENT_VIEW_MODE_CODE_HIGHLIGHT,
  CONVERSATION_DOCUMENT_VIEW_MODE_MARKDOWN,
  CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN,
  DOCUMENT_VIEWER_SETTING_HIGHLIGHT_CODE_BY_EXTENSION,
  DOCUMENT_VIEWER_SETTING_MODE_OVERRIDES,
  DOCUMENT_VIEWER_SETTING_RENDER_MARKDOWN_FOR_MD,
  DOCUMENT_VIEWER_SETTING_RENDER_MARKDOWN_FOR_TXT,
  resolveConversationDocumentRenderState
} from './conversation_document_viewer_state.js';
import {
  CONVERSATION_DOCUMENT_CHANGE_EVENT_NAME,
  CONVERSATION_DOCUMENT_INTERNAL_READ_FILE_FULL_ACTION,
  CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION,
  normalizeConversationDocumentHrefPath
} from '../agent_tools/virtual_file_io/index.js';

function normalizeViewerString(value) {
  return (typeof value === 'string' || typeof value === 'number')
    ? String(value).trim()
    : '';
}

function buildConversationDocumentDownloadName(path) {
  const normalized = normalizeViewerString(path);
  if (!normalized) return 'document.txt';
  return normalized.replace(/[\\/]+/g, '__');
}

function createDocumentActionIconButton({
  iconClass = '',
  title = '',
  ariaLabel = '',
  className = '',
  onClick = null
} = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `conversation-document-card__tool-button ${className}`.trim();
  button.title = title || ariaLabel || '';
  button.setAttribute('aria-label', ariaLabel || title || '');

  const icon = document.createElement('i');
  icon.className = iconClass;
  icon.setAttribute('aria-hidden', 'true');
  button.appendChild(icon);

  if (typeof onClick === 'function') {
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await onClick();
    });
  }
  return button;
}

function applyToolButtonVisualState(button, { iconClass = '', active = false, title = '', ariaLabel = '' } = {}) {
  if (!button) return;
  const icon = button.querySelector('i');
  if (icon) {
    icon.className = iconClass;
  }
  button.classList.toggle('is-active', active === true);
  button.title = title || ariaLabel || '';
  button.setAttribute('aria-label', ariaLabel || title || '');
}

/**
 * 对话文档 viewer。
 *
 * 设计目标：
 * - 把消息内行内文档卡片的 DOM 逻辑从 message_processor 中抽离出来；
 * - 文档显示模式、编辑、复制、下载、后续附件区共用同一套状态层；
 * - 让“扩展名推断 + 默认偏好 + 每文档 override”只在一处实现。
 *
 * @param {{
 *   executeAction: (action: string, payload?: Record<string, any>) => Promise<any>,
 *   resolveConversationId: () => string,
 *   settingsManager?: {
 *     getSetting?: (key: string) => any,
 *     setSettingValue?: (key: string, value: any) => void
 *   }
 * }} options
 */
export function createConversationDocumentViewer(options = {}) {
  const executeAction = typeof options.executeAction === 'function'
    ? options.executeAction
    : (async () => ({ ok: false }));
  const resolveConversationId = typeof options.resolveConversationId === 'function'
    ? options.resolveConversationId
    : (() => '');
  const settingsManager = options.settingsManager || null;

  const conversationDocumentCardState = new WeakMap();
  let changeListenerInstalled = false;

  function getViewerSettingsSnapshot() {
    return {
      [DOCUMENT_VIEWER_SETTING_RENDER_MARKDOWN_FOR_MD]:
        settingsManager?.getSetting?.(DOCUMENT_VIEWER_SETTING_RENDER_MARKDOWN_FOR_MD) !== false,
      [DOCUMENT_VIEWER_SETTING_RENDER_MARKDOWN_FOR_TXT]:
        settingsManager?.getSetting?.(DOCUMENT_VIEWER_SETTING_RENDER_MARKDOWN_FOR_TXT) === true,
      [DOCUMENT_VIEWER_SETTING_HIGHLIGHT_CODE_BY_EXTENSION]:
        settingsManager?.getSetting?.(DOCUMENT_VIEWER_SETTING_HIGHLIGHT_CODE_BY_EXTENSION) !== false,
      [DOCUMENT_VIEWER_SETTING_MODE_OVERRIDES]:
        settingsManager?.getSetting?.(DOCUMENT_VIEWER_SETTING_MODE_OVERRIDES) || {}
    };
  }

  function getConversationDocumentCardState(card) {
    let state = conversationDocumentCardState.get(card);
    if (!state) {
      state = {
        loadingPromise: null,
        content: '',
        file: null,
        loaded: false,
        editing: false,
        missing: false,
        refs: {
          meta: null,
          body: null,
          modeButton: null
        }
      };
      conversationDocumentCardState.set(card, state);
    }
    return state;
  }

  function setConversationDocumentCardMeta(card, text) {
    const state = getConversationDocumentCardState(card);
    if (state.refs.meta && state.refs.meta.textContent !== text) {
      state.refs.meta.textContent = text;
    }
  }

  function resolveCardRenderState(card) {
    return resolveConversationDocumentRenderState(
      card?.dataset?.documentPath || '',
      getViewerSettingsSnapshot()
    );
  }

  function syncConversationDocumentModeButton(card) {
    const state = getConversationDocumentCardState(card);
    const button = state.refs.modeButton;
    if (!button) return;

    const renderState = resolveCardRenderState(card);
    const hasToggle = renderState.allowMarkdownToggle || renderState.allowCodeHighlightToggle;
    button.hidden = !hasToggle;
    button.disabled = !hasToggle;
    if (!hasToggle) {
      return;
    }

    if (renderState.allowMarkdownToggle) {
      const isMarkdown = renderState.mode === CONVERSATION_DOCUMENT_VIEW_MODE_MARKDOWN;
      applyToolButtonVisualState(button, {
        iconClass: isMarkdown ? 'fa-brands fa-markdown' : 'fa-solid fa-paragraph',
        active: isMarkdown,
        title: isMarkdown ? '当前按 Markdown 渲染，点击切换为纯文本' : '当前按纯文本显示，点击切换为 Markdown 渲染',
        ariaLabel: isMarkdown ? '切换为纯文本视图' : '切换为 Markdown 视图'
      });
      return;
    }

    const isHighlighted = renderState.mode === CONVERSATION_DOCUMENT_VIEW_MODE_CODE_HIGHLIGHT;
    applyToolButtonVisualState(button, {
      iconClass: isHighlighted ? 'fa-solid fa-code' : 'fa-solid fa-file-lines',
      active: isHighlighted,
      title: isHighlighted ? '当前已启用代码高亮，点击切换为纯文本' : '当前按纯文本显示，点击切换为代码高亮',
      ariaLabel: isHighlighted ? '切换为纯文本视图' : '切换为代码高亮视图'
    });
  }

  function renderPlainContent(content) {
    const pre = document.createElement('pre');
    pre.className = 'conversation-document-card__content conversation-document-card__content--plain';
    pre.textContent = content || '';
    return pre;
  }

  function renderMarkdownContent(content, enableDollarMath) {
    const container = document.createElement('div');
    container.className = 'conversation-document-card__content conversation-document-card__content--markdown';
    container.innerHTML = renderMarkdownSafe(content || '', {
      allowDetails: true,
      enableDollarMath
    });
    return container;
  }

  function renderCodeContent(content, language) {
    const pre = document.createElement('pre');
    pre.className = 'conversation-document-card__content conversation-document-card__content--code';
    const code = document.createElement('code');
    code.textContent = content || '';
    if (language) {
      code.classList.add(`language-${language}`);
    }
    pre.appendChild(code);

    try {
      if (window.hljs?.highlightElement && language && window.hljs.getLanguage?.(language)) {
        window.hljs.highlightElement(code);
      }
    } catch (_) {}

    return pre;
  }

  function persistConversationDocumentViewMode(card, nextMode) {
    const path = normalizeViewerString(card?.dataset?.documentPath);
    if (!path || !settingsManager?.setSettingValue) return;

    const settingsSnapshot = getViewerSettingsSnapshot();
    const renderState = resolveConversationDocumentRenderState(path, settingsSnapshot);
    const nextOverrides = {
      ...(settingsSnapshot[DOCUMENT_VIEWER_SETTING_MODE_OVERRIDES] || {})
    };
    if (nextMode === renderState.defaultMode) {
      delete nextOverrides[path];
    } else {
      nextOverrides[path] = nextMode;
    }
    settingsManager.setSettingValue(DOCUMENT_VIEWER_SETTING_MODE_OVERRIDES, nextOverrides);
  }

  function renderConversationDocumentCardContent(card, file) {
    const state = getConversationDocumentCardState(card);
    if (!state.refs.body) return;
    state.refs.body.replaceChildren();

    if (!file) {
      const empty = document.createElement('div');
      empty.className = 'conversation-document-card__status';
      empty.textContent = '文档不存在';
      state.refs.body.appendChild(empty);
      card.classList.add('is-missing');
      state.missing = true;
      state.file = null;
      syncConversationDocumentModeButton(card);
      return;
    }

    state.file = {
      path: file.path,
      updated_at: file.updated_at,
      size_chars: file.size_chars,
      content: file.content || ''
    };
    state.loaded = true;
    state.content = file.content || '';

    const renderState = resolveCardRenderState(card);
    const enableDollarMath = settingsManager?.getSetting?.('enableDollarMath') !== false;
    let contentNode = null;
    if (renderState.mode === CONVERSATION_DOCUMENT_VIEW_MODE_MARKDOWN) {
      contentNode = renderMarkdownContent(file.content || '', enableDollarMath);
    } else if (renderState.mode === CONVERSATION_DOCUMENT_VIEW_MODE_CODE_HIGHLIGHT) {
      contentNode = renderCodeContent(file.content || '', renderState.language);
    } else {
      contentNode = renderPlainContent(file.content || '');
    }

    state.refs.body.appendChild(contentNode);
    card.classList.remove('is-missing');
    state.missing = false;
    syncConversationDocumentModeButton(card);

    const metaParts = [];
    if (Number.isFinite(Number(file.size_chars))) {
      metaParts.push(`${Number(file.size_chars).toLocaleString()} chars`);
    }
    if (typeof file.updated_at === 'string' && file.updated_at.trim()) {
      metaParts.push(new Date(file.updated_at).toLocaleString());
    }
    setConversationDocumentCardMeta(card, metaParts.join(' · ') || card.dataset.documentPath || '');
  }

  async function loadConversationDocumentCard(card, options = {}) {
    const state = getConversationDocumentCardState(card);
    if (!normalizeViewerString(card.dataset.conversationId)) {
      card.dataset.conversationId = resolveConversationId();
    }
    if (state.loadingPromise && options.force !== true) {
      return state.loadingPromise;
    }
    if (state.loaded && options.force !== true && state.file) {
      renderConversationDocumentCardContent(card, state.file);
      return {
        ok: true,
        file: {
          path: state.file.path || card.dataset.documentPath || '',
          content: state.file.content || '',
          size_chars: state.file.size_chars ?? Array.from(state.file.content || '').length,
          updated_at: state.file.updated_at || ''
        }
      };
    }

    card.classList.add('is-loading');
    const request = executeAction(CONVERSATION_DOCUMENT_INTERNAL_READ_FILE_FULL_ACTION, {
      file_path: card.dataset.documentPath || ''
    }).then((result) => {
      if (result?.ok === true && result?.file) {
        renderConversationDocumentCardContent(card, result.file);
      } else {
        renderConversationDocumentCardContent(card, null);
      }
      return result;
    }).finally(() => {
      card.classList.remove('is-loading');
      state.loadingPromise = null;
    });
    state.loadingPromise = request;
    return request;
  }

  function focusConversationDocumentCard(card) {
    if (!(card instanceof HTMLElement)) return;
    const state = getConversationDocumentCardState(card);
    if (!card.open) {
      card.open = true;
    } else if (!state.loaded && !state.editing) {
      void loadConversationDocumentCard(card);
    }
    const summary = card.querySelector('summary');
    try {
      summary?.focus?.({ preventScroll: true });
    } catch (_) {
      summary?.focus?.();
    }
    try {
      card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    } catch (_) {}
  }

  function autoResizeConversationDocumentEditor(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(520, Math.max(textarea.scrollHeight, 140))}px`;
  }

  async function cycleConversationDocumentViewMode(card) {
    const renderState = resolveCardRenderState(card);
    if ((renderState.allowedModes || []).length <= 1) return;

    const nextMode = buildNextConversationDocumentRenderMode(
      card.dataset.documentPath || '',
      renderState.mode,
      getViewerSettingsSnapshot()
    );
    if (nextMode === renderState.mode) return;

    persistConversationDocumentViewMode(card, nextMode);
    syncConversationDocumentModeButton(card);
    const state = getConversationDocumentCardState(card);
    if (state.file) {
      renderConversationDocumentCardContent(card, state.file);
      return;
    }
    await loadConversationDocumentCard(card);
  }

  async function enterConversationDocumentEditMode(card) {
    const state = getConversationDocumentCardState(card);
    if (state.editing) return;
    const loadResult = await loadConversationDocumentCard(card);
    if (loadResult?.ok !== true || !loadResult.file) return;

    state.editing = true;
    card.classList.add('is-editing');
    const body = state.refs.body;
    if (!body) return;
    body.replaceChildren();

    const textarea = document.createElement('textarea');
    textarea.className = 'conversation-document-card__editor';
    textarea.value = state.content || '';
    autoResizeConversationDocumentEditor(textarea);
    textarea.addEventListener('input', () => autoResizeConversationDocumentEditor(textarea));

    const actions = document.createElement('div');
    actions.className = 'conversation-document-card__editor-actions';

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'conversation-document-card__button is-primary';
    saveButton.textContent = 'Save';
    saveButton.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const result = await executeAction(CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION, {
        file_path: card.dataset.documentPath || '',
        content: textarea.value
      });
      if (result?.ok !== true || !result.file) return;
      state.editing = false;
      card.classList.remove('is-editing');
      renderConversationDocumentCardContent(card, result.file);
    });

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'conversation-document-card__button';
    cancelButton.textContent = 'Cancel';
    cancelButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.editing = false;
      card.classList.remove('is-editing');
      renderConversationDocumentCardContent(card, state.file || {
        path: card.dataset.documentPath || '',
        content: state.content,
        size_chars: Array.from(state.content || '').length
      });
    });

    actions.appendChild(saveButton);
    actions.appendChild(cancelButton);
    body.appendChild(textarea);
    body.appendChild(actions);
    textarea.focus({ preventScroll: true });
  }

  async function copyConversationDocumentCard(card) {
    const result = await loadConversationDocumentCard(card);
    if (result?.ok !== true || !result.file || !navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(result.file.content || '');
  }

  async function downloadConversationDocumentCard(card) {
    const result = await loadConversationDocumentCard(card);
    if (result?.ok !== true || !result.file) return;
    const blob = new Blob([result.file.content || ''], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = buildConversationDocumentDownloadName(result.file.path || '');
      document.body.appendChild(link);
      link.click();
      link.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function createConversationDocumentCard({ path, title, conversationId }) {
    const card = document.createElement('details');
    card.className = 'conversation-document-card';
    card.dataset.documentPath = path;
    card.dataset.conversationId = conversationId || '';

    const summary = document.createElement('summary');
    summary.className = 'conversation-document-card__summary';

    const titleWrap = document.createElement('span');
    titleWrap.className = 'conversation-document-card__title-wrap';

    const titleEl = document.createElement('span');
    titleEl.className = 'conversation-document-card__title';
    titleEl.textContent = title;
    titleWrap.appendChild(titleEl);

    const pathEl = document.createElement('span');
    pathEl.className = 'conversation-document-card__path';
    pathEl.textContent = path;
    titleWrap.appendChild(pathEl);
    summary.appendChild(titleWrap);

    const actions = document.createElement('span');
    actions.className = 'conversation-document-card__actions';

    const state = getConversationDocumentCardState(card);
    const modeButton = createDocumentActionIconButton({
      iconClass: 'fa-brands fa-markdown',
      title: '切换文档显示模式',
      ariaLabel: '切换文档显示模式',
      className: 'conversation-document-card__tool-button--mode',
      onClick: () => cycleConversationDocumentViewMode(card)
    });
    state.refs.modeButton = modeButton;
    actions.appendChild(modeButton);
    actions.appendChild(createDocumentActionIconButton({
      iconClass: 'fa-regular fa-pen-to-square',
      title: '编辑文档',
      ariaLabel: '编辑文档',
      onClick: () => enterConversationDocumentEditMode(card)
    }));
    actions.appendChild(createDocumentActionIconButton({
      iconClass: 'fa-regular fa-copy',
      title: '复制文档内容',
      ariaLabel: '复制文档内容',
      onClick: () => copyConversationDocumentCard(card)
    }));
    actions.appendChild(createDocumentActionIconButton({
      iconClass: 'fa-solid fa-download',
      title: '下载文档',
      ariaLabel: '下载文档',
      onClick: () => downloadConversationDocumentCard(card)
    }));
    summary.appendChild(actions);

    const meta = document.createElement('div');
    meta.className = 'conversation-document-card__meta';
    meta.textContent = '展开后加载文档内容';
    const body = document.createElement('div');
    body.className = 'conversation-document-card__body';
    const status = document.createElement('div');
    status.className = 'conversation-document-card__status';
    status.textContent = conversationId
      ? '展开后加载文档内容'
      : '当前对话尚未持久化，暂时无法读取文档';
    body.appendChild(status);

    state.refs.meta = meta;
    state.refs.body = body;

    card.appendChild(summary);
    card.appendChild(meta);
    card.appendChild(body);
    syncConversationDocumentModeButton(card);
    card.addEventListener('toggle', () => {
      if (card.open && !state.editing) {
        void loadConversationDocumentCard(card);
      }
    });
    return card;
  }

  function createConversationDocumentCardFromLink(link) {
    const path = normalizeConversationDocumentHrefPath(link.getAttribute('href') || '');
    const conversationId = resolveConversationId();
    const title = (link.textContent || '').trim() || path;
    return createConversationDocumentCard({
      path,
      title,
      conversationId
    });
  }

  function getMessageDocumentCards(messageElement) {
    if (!(messageElement instanceof HTMLElement)) return [];
    return Array.from(messageElement.querySelectorAll('.conversation-document-card[data-document-path]'))
      .filter((card) => !card.closest('.conversation-document-attachments__expanded'));
  }

  function createConversationDocumentAttachmentTile({ path, title, onClick }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'conversation-document-attachments__tile';
    button.setAttribute('aria-label', `打开文档 ${title || path}`);
    button.title = path;

    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-file-lines conversation-document-attachments__tile-icon';
    icon.setAttribute('aria-hidden', 'true');
    button.appendChild(icon);

    const labelWrap = document.createElement('span');
    labelWrap.className = 'conversation-document-attachments__tile-label-wrap';

    const titleEl = document.createElement('span');
    titleEl.className = 'conversation-document-attachments__tile-title';
    titleEl.textContent = title || path;
    labelWrap.appendChild(titleEl);

    const pathEl = document.createElement('span');
    pathEl.className = 'conversation-document-attachments__tile-path';
    pathEl.textContent = path;
    labelWrap.appendChild(pathEl);

    button.appendChild(labelWrap);
    if (typeof onClick === 'function') {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      });
    }
    return button;
  }

  function syncConversationDocumentAttachmentStrip(messageElement) {
    if (!(messageElement instanceof HTMLElement)) return;

    const documentCards = getMessageDocumentCards(messageElement);
    const existingContainer = Array.from(messageElement.children || []).find((child) => (
      child?.classList?.contains('conversation-document-attachments')
    )) || null;

    if (documentCards.length <= 0) {
      existingContainer?.remove();
      return;
    }

    const descriptors = [];
    const seenPaths = new Set();
    documentCards.forEach((card) => {
      const path = normalizeViewerString(card.getAttribute('data-document-path'));
      if (!path || seenPaths.has(path)) return;
      seenPaths.add(path);
      descriptors.push({
        path,
        title: normalizeViewerString(card.querySelector('.conversation-document-card__title')?.textContent) || path,
        card
      });
    });
    if (descriptors.length <= 0) {
      existingContainer?.remove();
      return;
    }

    const container = existingContainer || document.createElement('div');
    container.className = 'conversation-document-attachments';

    const tiles = document.createElement('div');
    tiles.className = 'conversation-document-attachments__tiles';

    const expandedHost = document.createElement('div');
    expandedHost.className = 'conversation-document-attachments__expanded';

    descriptors.forEach((descriptor) => {
      tiles.appendChild(createConversationDocumentAttachmentTile({
        path: descriptor.path,
        title: descriptor.title,
        onClick: () => {
          if (descriptor.card) {
            focusConversationDocumentCard(descriptor.card);
            return;
          }
          expandedHost.replaceChildren();
          const fallbackCard = createConversationDocumentCard({
            path: descriptor.path,
            title: descriptor.title,
            conversationId: resolveConversationId()
          });
          expandedHost.appendChild(fallbackCard);
          focusConversationDocumentCard(fallbackCard);
        }
      }));
    });

    container.replaceChildren(tiles, expandedHost);

    const apiFooter = Array.from(messageElement.children || []).find((child) => (
      child?.classList?.contains('api-footer')
    )) || null;
    if (container.parentElement !== messageElement) {
      if (apiFooter) {
        messageElement.insertBefore(container, apiFooter);
      } else {
        messageElement.appendChild(container);
      }
    } else if (apiFooter && container.nextElementSibling !== apiFooter) {
      messageElement.insertBefore(container, apiFooter);
    } else if (!apiFooter && messageElement.lastElementChild !== container) {
      messageElement.appendChild(container);
    }
  }

  function installConversationDocumentChangeListener() {
    if (changeListenerInstalled) return;
    document.addEventListener(CONVERSATION_DOCUMENT_CHANGE_EVENT_NAME, (event) => {
      const detail = event?.detail || {};
      const conversationId = normalizeViewerString(detail.conversation_id);
      const changedPaths = new Set([
        ...(Array.isArray(detail.updated_paths) ? detail.updated_paths : []),
        ...(Array.isArray(detail.deleted_paths) ? detail.deleted_paths : [])
      ].map((value) => normalizeViewerString(value)).filter(Boolean));
      if (!conversationId || changedPaths.size <= 0) return;

      document.querySelectorAll('.conversation-document-card').forEach((card) => {
        if (!(card instanceof HTMLElement)) return;
        if (!normalizeViewerString(card.dataset.conversationId)) {
          card.dataset.conversationId = resolveConversationId();
        }
        if (normalizeViewerString(card.dataset.conversationId) !== conversationId) return;
        if (!changedPaths.has(normalizeViewerString(card.dataset.documentPath))) return;
        const state = getConversationDocumentCardState(card);
        if (state.editing) return;
        state.loaded = false;
        if (card.open) {
          void loadConversationDocumentCard(card, { force: true });
        }
      });
    });
    changeListenerInstalled = true;
  }

  return {
    createConversationDocumentCard,
    createConversationDocumentCardFromLink,
    syncConversationDocumentAttachmentStrip,
    installConversationDocumentChangeListener,
    loadConversationDocumentCard
  };
}
