import { renderMarkdownSafe } from './markdown_renderer.js';
import {
  clampConversationDocumentFontSizePercent,
  CONVERSATION_DOCUMENT_VIEW_MODE_CODE_HIGHLIGHT,
  CONVERSATION_DOCUMENT_VIEW_MODE_HTML_PREVIEW,
  CONVERSATION_DOCUMENT_VIEW_MODE_MARKDOWN,
  CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN,
  DOCUMENT_VIEWER_SETTING_FONT_SIZE_PERCENT,
  DOCUMENT_VIEWER_SETTING_MODE_OVERRIDES,
  DOCUMENT_VIEWER_SETTING_RENDER_MARKDOWN_FOR_MD,
  getConversationDocumentFileExtension,
  isConversationDocumentHtmlPreviewPath,
  resolveConversationDocumentCodeLanguage,
  resolveConversationDocumentRenderState
} from './conversation_document_viewer_state.js';
import {
  CONVERSATION_DOCUMENT_CHANGE_EVENT_NAME,
  CONVERSATION_DOCUMENT_INTERNAL_READ_FILE_FULL_ACTION,
  CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION,
  normalizeConversationDocumentHrefPath
} from '../agent_tools/virtual_file_io/index.js';

const HTML_PREVIEW_RENDER_MESSAGE = 'CEREBR_HTML_PREVIEW_RENDER';
const HTML_PREVIEW_READY_MESSAGE = 'CEREBR_HTML_PREVIEW_READY';
const HTML_PREVIEW_RENDERED_MESSAGE = 'CEREBR_HTML_PREVIEW_RENDERED';
const HTML_PREVIEW_SANDBOX_FRAME_URL = new URL(
  '../ui/html_preview_sandbox/html_preview_sandbox.html',
  import.meta.url
).toString();

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

function resolveConversationDocumentDownloadMimeType(path) {
  return isConversationDocumentHtmlPreviewPath(path)
    ? 'text/html;charset=utf-8'
    : 'text/plain;charset=utf-8';
}

function resolveConversationDocumentFileIconClass(path) {
  const extension = getConversationDocumentFileExtension(path);
  if (extension === 'html' || extension === 'htm') return 'fa-brands fa-html5';
  if (extension === 'md' || extension === 'markdown') return 'fa-brands fa-markdown';
  if (resolveConversationDocumentCodeLanguage(path)) return 'fa-solid fa-code';
  return 'fa-solid fa-file-lines';
}

function buildDocumentViewModeDescriptor(mode) {
  if (mode === CONVERSATION_DOCUMENT_VIEW_MODE_HTML_PREVIEW) {
    return {
      iconClass: 'fa-brands fa-html5',
      label: 'HTML 渲染预览'
    };
  }
  if (mode === CONVERSATION_DOCUMENT_VIEW_MODE_CODE_HIGHLIGHT) {
    return {
      iconClass: 'fa-solid fa-code',
      label: '源码高亮'
    };
  }
  if (mode === CONVERSATION_DOCUMENT_VIEW_MODE_MARKDOWN) {
    return {
      iconClass: 'fa-brands fa-markdown',
      label: 'Markdown 渲染'
    };
  }
  return {
    iconClass: 'fa-solid fa-file-lines',
    label: '纯文本'
  };
}

function createHtmlPreviewRenderPayload({ content = '', path = '', title = '' } = {}) {
  return {
    type: HTML_PREVIEW_RENDER_MESSAGE,
    requestId: `html_preview_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    html: typeof content === 'string' ? content : '',
    path: normalizeViewerString(path),
    title: normalizeViewerString(title)
  };
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
  button.setAttribute('aria-pressed', active === true ? 'true' : 'false');
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
 *   },
 *   writeClipboardText?: (text: string) => Promise<void>,
 *   enhanceMarkdownContent?: (rootElement: HTMLElement) => void
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
  const writeClipboardText = typeof options.writeClipboardText === 'function'
    ? options.writeClipboardText
    : null;
  const enhanceMarkdownContent = typeof options.enhanceMarkdownContent === 'function'
    ? options.enhanceMarkdownContent
    : null;

  const conversationDocumentCardState = new WeakMap();
  let changeListenerInstalled = false;
  let keyboardShortcutInstalled = false;
  let htmlPreviewPopoutShortcutInstalled = false;
  let activeHtmlPreviewPopout = null;

  function getViewerSettingsSnapshot() {
    return {
      [DOCUMENT_VIEWER_SETTING_FONT_SIZE_PERCENT]:
        clampConversationDocumentFontSizePercent(
          settingsManager?.getSetting?.(DOCUMENT_VIEWER_SETTING_FONT_SIZE_PERCENT),
          100
        ),
      [DOCUMENT_VIEWER_SETTING_RENDER_MARKDOWN_FOR_MD]:
        settingsManager?.getSetting?.(DOCUMENT_VIEWER_SETTING_RENDER_MARKDOWN_FOR_MD) !== false,
      [DOCUMENT_VIEWER_SETTING_MODE_OVERRIDES]:
        settingsManager?.getSetting?.(DOCUMENT_VIEWER_SETTING_MODE_OVERRIDES) || {}
    };
  }

  function setConversationDocumentFontSizePercent(value) {
    if (!settingsManager?.setSettingValue) return;
    settingsManager.setSettingValue(
      DOCUMENT_VIEWER_SETTING_FONT_SIZE_PERCENT,
      clampConversationDocumentFontSizePercent(value, 100)
    );
  }

  function getConversationDocumentFontSizePercent() {
    return getViewerSettingsSnapshot()[DOCUMENT_VIEWER_SETTING_FONT_SIZE_PERCENT];
  }

  function shouldHandleDocumentFontShortcut(target) {
    if (!(target instanceof HTMLElement)) return false;
    return !!target.closest('.conversation-document-card');
  }

  function normalizeDocumentFontShortcutStep(nextValue) {
    return clampConversationDocumentFontSizePercent(nextValue, getConversationDocumentFontSizePercent());
  }

  function installConversationDocumentKeyboardShortcuts() {
    if (keyboardShortcutInstalled) return;
    document.addEventListener('keydown', (event) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      if (!shouldHandleDocumentFontShortcut(event.target)) return;

      const key = String(event.key || '').trim();
      let nextValue = null;
      if (key === '+' || key === '=') {
        nextValue = normalizeDocumentFontShortcutStep(getConversationDocumentFontSizePercent() + 5);
      } else if (key === '-') {
        nextValue = normalizeDocumentFontShortcutStep(getConversationDocumentFontSizePercent() - 5);
      } else if (key === '0') {
        nextValue = 100;
      }
      if (nextValue == null) return;

      event.preventDefault();
      event.stopPropagation();
      setConversationDocumentFontSizePercent(nextValue);
    }, true);
    keyboardShortcutInstalled = true;
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
          modeButtons: new Map(),
          htmlFullscreenButton: null
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

  function syncConversationDocumentModeButtons(card) {
    const state = getConversationDocumentCardState(card);
    const renderState = resolveCardRenderState(card);
    state.refs.modeButtons.forEach((button, mode) => {
      const descriptor = buildDocumentViewModeDescriptor(mode);
      const active = renderState.mode === mode;
      applyToolButtonVisualState(button, {
        iconClass: descriptor.iconClass,
        active,
        title: active ? `当前为${descriptor.label}` : `切换为${descriptor.label}`,
        ariaLabel: active ? `当前为${descriptor.label}` : `切换为${descriptor.label}`
      });
    });
  }

  function syncConversationDocumentHtmlFullscreenButton(card) {
    const state = getConversationDocumentCardState(card);
    const button = state.refs.htmlFullscreenButton;
    if (!button) return;
    const isHtmlFile = isConversationDocumentHtmlPreviewPath(card?.dataset?.documentPath || '');
    button.hidden = !isHtmlFile;
    button.disabled = !isHtmlFile;
    if (!isHtmlFile) return;

    const isPopout = activeHtmlPreviewPopout?.card === card;
    applyToolButtonVisualState(button, {
      iconClass: isPopout ? 'fa-solid fa-compress' : 'fa-solid fa-expand',
      active: isPopout,
      title: isPopout ? '缩回 HTML 预览' : '放大 HTML 预览',
      ariaLabel: isPopout ? '缩回 HTML 预览' : '放大 HTML 预览'
    });
  }

  function renderPlainContent(content) {
    const pre = document.createElement('pre');
    pre.className = 'conversation-document-card__content conversation-document-card__content--plain';
    pre.tabIndex = 0;
    pre.textContent = content || '';
    return pre;
  }

  function renderMarkdownContent(content, enableDollarMath) {
    const container = document.createElement('div');
    container.className = 'conversation-document-card__content conversation-document-card__content--markdown';
    container.tabIndex = 0;
    container.innerHTML = renderMarkdownSafe(content || '', {
      allowDetails: true,
      enableDollarMath
    });
    return container;
  }

  function createHtmlPreviewSandboxFrame({ content = '', path = '', title = '', className = '' } = {}) {
    const frame = document.createElement('iframe');
    frame.className = className || 'conversation-document-card__html-frame';
    frame.title = `${title || path || 'HTML 文件'} 预览`;
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', 'fullscreen');

    const payload = createHtmlPreviewRenderPayload({ content, path, title });
    const cleanupMessageListener = () => {
      window.removeEventListener('message', handleSandboxMessage);
    };
    const postRenderPayload = () => {
      try {
        frame.contentWindow?.postMessage(payload, '*');
      } catch (_) {}
    };
    const handleSandboxMessage = (event) => {
      if (event.source !== frame.contentWindow) return;
      if (!event.data || typeof event.data !== 'object') return;
      if (event.data.source !== 'cerebr-html-preview-sandbox') return;
      if (event.data.type === HTML_PREVIEW_READY_MESSAGE) {
        postRenderPayload();
        return;
      }
      if (event.data.type === HTML_PREVIEW_RENDERED_MESSAGE && event.data.requestId === payload.requestId) {
        cleanupMessageListener();
      }
    };
    window.addEventListener('message', handleSandboxMessage);
    frame.addEventListener('load', postRenderPayload);
    frame.src = HTML_PREVIEW_SANDBOX_FRAME_URL;
    return frame;
  }

  function closeConversationDocumentHtmlPopout(card = null, options = {}) {
    if (!activeHtmlPreviewPopout) return;
    if (card && activeHtmlPreviewPopout.card !== card) return;

    const { card: activeCard, content, backdrop, restoreFocusTo } = activeHtmlPreviewPopout;
    activeHtmlPreviewPopout = null;

    content?.classList?.remove?.('is-popout');
    content?.removeAttribute?.('role');
    content?.removeAttribute?.('aria-modal');
    content?.removeAttribute?.('data-html-preview-popout');
    activeCard?.classList?.remove?.('is-html-popout');
    backdrop?.remove?.();
    document.body.classList.remove('conversation-document-html-popout-open');
    syncConversationDocumentHtmlFullscreenButton(activeCard);

    if (options.restoreFocus === true && restoreFocusTo instanceof HTMLElement) {
      try {
        restoreFocusTo.focus({ preventScroll: true });
      } catch (_) {
        restoreFocusTo.focus?.();
      }
    }
  }

  function installConversationDocumentHtmlPopoutShortcuts() {
    if (htmlPreviewPopoutShortcutInstalled) return;
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !activeHtmlPreviewPopout) return;
      event.preventDefault();
      event.stopPropagation();
      closeConversationDocumentHtmlPopout(null, { restoreFocus: true });
    }, true);
    htmlPreviewPopoutShortcutInstalled = true;
  }

  function renderHtmlPreviewContent(content, path, card) {
    const container = document.createElement('div');
    container.className = 'conversation-document-card__content conversation-document-card__content--html-preview';
    container.tabIndex = 0;

    // HTML 文件可能由模型生成，必须交给 manifest sandbox page 渲染；主扩展页 CSP 不应为此放宽 inline script。
    container.appendChild(createHtmlPreviewSandboxFrame({
      content,
      path
    }));
    container.appendChild(createDocumentActionIconButton({
      iconClass: 'fa-solid fa-compress',
      title: '缩回 HTML 预览',
      ariaLabel: '缩回 HTML 预览',
      className: 'conversation-document-html-popout__toggle',
      onClick: () => closeConversationDocumentHtmlPopout(card, { restoreFocus: true })
    }));
    return container;
  }

  function renderCodeContent(content, language) {
    const pre = document.createElement('pre');
    pre.className = 'conversation-document-card__content conversation-document-card__content--code';
    pre.tabIndex = 0;
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
    closeConversationDocumentHtmlPopout(card);
    state.refs.body.replaceChildren();

    if (!file) {
      const empty = document.createElement('div');
      empty.className = 'conversation-document-card__status';
      empty.textContent = '文件不存在';
      state.refs.body.appendChild(empty);
      card.classList.add('is-missing');
      state.missing = true;
      state.file = null;
      syncConversationDocumentModeButtons(card);
      syncConversationDocumentHtmlFullscreenButton(card);
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
    if (renderState.mode === CONVERSATION_DOCUMENT_VIEW_MODE_HTML_PREVIEW) {
      contentNode = renderHtmlPreviewContent(file.content || '', file.path || card.dataset.documentPath || '', card);
    } else if (renderState.mode === CONVERSATION_DOCUMENT_VIEW_MODE_MARKDOWN) {
      contentNode = renderMarkdownContent(file.content || '', enableDollarMath);
    } else if (renderState.mode === CONVERSATION_DOCUMENT_VIEW_MODE_CODE_HIGHLIGHT) {
      contentNode = renderCodeContent(file.content || '', renderState.language);
    } else {
      contentNode = renderPlainContent(file.content || '');
    }

    state.refs.body.appendChild(contentNode);
    if (renderState.mode === CONVERSATION_DOCUMENT_VIEW_MODE_MARKDOWN && contentNode instanceof HTMLElement) {
      try {
        enhanceMarkdownContent?.(contentNode);
      } catch (_) {}
    }
    card.classList.remove('is-missing');
    state.missing = false;
    syncConversationDocumentModeButtons(card);
    syncConversationDocumentHtmlFullscreenButton(card);

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

  async function setConversationDocumentViewMode(card, nextMode) {
    const renderState = resolveCardRenderState(card);
    if (nextMode === renderState.mode || !renderState.allowedModes.includes(nextMode)) return;

    persistConversationDocumentViewMode(card, nextMode);
    syncConversationDocumentModeButtons(card);
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
    if (result?.ok !== true || !result.file || !writeClipboardText) return;
    await writeClipboardText(result.file.content || '');
  }

  async function toggleConversationDocumentHtmlPopout(card) {
    if (activeHtmlPreviewPopout?.card === card) {
      closeConversationDocumentHtmlPopout(card, { restoreFocus: true });
      return;
    }

    const state = getConversationDocumentCardState(card);
    let file = state.file;
    if (!file) {
      const result = await loadConversationDocumentCard(card);
      if (result?.ok !== true || !result.file) return;
      file = result.file;
    }
    if (!isConversationDocumentHtmlPreviewPath(file.path || card?.dataset?.documentPath || '')) return;

    const renderState = resolveCardRenderState(card);
    if (renderState.mode !== CONVERSATION_DOCUMENT_VIEW_MODE_HTML_PREVIEW && state.file) {
      persistConversationDocumentViewMode(card, CONVERSATION_DOCUMENT_VIEW_MODE_HTML_PREVIEW);
      renderConversationDocumentCardContent(card, state.file);
    }

    const content = state.refs.body?.querySelector('.conversation-document-card__content--html-preview');
    if (!(content instanceof HTMLElement)) return;

    closeConversationDocumentHtmlPopout();
    activeHtmlPreviewPopout = {
      card,
      content,
      backdrop: null,
      restoreFocusTo: document.activeElement instanceof HTMLElement ? document.activeElement : null
    };
    document.body.classList.add('conversation-document-html-popout-open');
    card.classList.add('is-html-popout');
    content.classList.add('is-popout');
    content.setAttribute('role', 'dialog');
    content.setAttribute('aria-modal', 'true');
    content.setAttribute('data-html-preview-popout', 'true');
    content.setAttribute('aria-label', `${file.path || 'HTML 文件'} 放大预览`);
    installConversationDocumentHtmlPopoutShortcuts();
    syncConversationDocumentHtmlFullscreenButton(card);
  }

  async function downloadConversationDocumentCard(card) {
    const result = await loadConversationDocumentCard(card);
    if (result?.ok !== true || !result.file) return;
    const blob = new Blob([result.file.content || ''], {
      type: resolveConversationDocumentDownloadMimeType(result.file.path || '')
    });
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
    const initialRenderState = resolveCardRenderState(card);
    if (initialRenderState.allowedModes.length > 1) {
      initialRenderState.allowedModes.forEach((mode) => {
        const descriptor = buildDocumentViewModeDescriptor(mode);
        const modeButton = createDocumentActionIconButton({
          iconClass: descriptor.iconClass,
          title: `切换为${descriptor.label}`,
          ariaLabel: `切换为${descriptor.label}`,
          className: 'conversation-document-card__tool-button--mode',
          onClick: () => setConversationDocumentViewMode(card, mode)
        });
        modeButton.dataset.documentViewMode = mode;
        state.refs.modeButtons.set(mode, modeButton);
        actions.appendChild(modeButton);
      });
    }
    const htmlFullscreenButton = createDocumentActionIconButton({
      iconClass: 'fa-solid fa-expand',
      title: '全屏预览 HTML',
      ariaLabel: '全屏预览 HTML',
      className: 'conversation-document-card__tool-button--html-fullscreen',
      onClick: () => toggleConversationDocumentHtmlPopout(card)
    });
    state.refs.htmlFullscreenButton = htmlFullscreenButton;
    actions.appendChild(htmlFullscreenButton);
    actions.appendChild(createDocumentActionIconButton({
      iconClass: 'fa-regular fa-pen-to-square',
      title: '编辑文件',
      ariaLabel: '编辑文件',
      onClick: () => enterConversationDocumentEditMode(card)
    }));
    actions.appendChild(createDocumentActionIconButton({
      iconClass: 'fa-regular fa-copy',
      title: '复制文件内容',
      ariaLabel: '复制文件内容',
      onClick: () => copyConversationDocumentCard(card)
    }));
    actions.appendChild(createDocumentActionIconButton({
      iconClass: 'fa-solid fa-download',
      title: '下载文件',
      ariaLabel: '下载文件',
      onClick: () => downloadConversationDocumentCard(card)
    }));
    summary.appendChild(actions);

    const meta = document.createElement('div');
    meta.className = 'conversation-document-card__meta';
    meta.textContent = '展开后加载文件内容';
    const body = document.createElement('div');
    body.className = 'conversation-document-card__body';
    const status = document.createElement('div');
    status.className = 'conversation-document-card__status';
    status.textContent = conversationId
      ? '展开后加载文件内容'
      : '当前对话尚未持久化，暂时无法读取文件';
    body.appendChild(status);

    state.refs.meta = meta;
    state.refs.body = body;

    card.appendChild(summary);
    card.appendChild(meta);
    card.appendChild(body);
    syncConversationDocumentModeButtons(card);
    syncConversationDocumentHtmlFullscreenButton(card);
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
    button.setAttribute('aria-label', `打开文件 ${title || path}`);
    button.title = path;

    const icon = document.createElement('i');
    icon.className = `${resolveConversationDocumentFileIconClass(path)} conversation-document-attachments__tile-icon`;
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

  installConversationDocumentKeyboardShortcuts();

  return {
    createConversationDocumentCard,
    createConversationDocumentCardFromLink,
    syncConversationDocumentAttachmentStrip,
    installConversationDocumentChangeListener,
    loadConversationDocumentCard
  };
}
