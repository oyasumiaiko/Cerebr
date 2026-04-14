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

/**
 * 对话文档 viewer。
 *
 * 设计目标：
 * - 把消息内行内文档卡片的 DOM 逻辑从 message_processor 中抽离出来；
 * - 后续消息尾部附件区、渲染模式切换、字号控制都复用这一层；
 * - 当前 v1 先保持“全文以纯文本 pre 展示”的现有行为，只整理结构与图标按钮。
 *
 * @param {{
 *   executeAction: (action: string, payload?: Record<string, any>) => Promise<any>,
 *   resolveConversationId: () => string
 * }} options
 */
export function createConversationDocumentViewer(options = {}) {
  const executeAction = typeof options.executeAction === 'function'
    ? options.executeAction
    : (async () => ({ ok: false }));
  const resolveConversationId = typeof options.resolveConversationId === 'function'
    ? options.resolveConversationId
    : (() => '');

  const conversationDocumentCardState = new WeakMap();
  let changeListenerInstalled = false;

  function getConversationDocumentCardState(card) {
    let state = conversationDocumentCardState.get(card);
    if (!state) {
      state = {
        loadingPromise: null,
        content: '',
        loaded: false,
        editing: false,
        missing: false,
        refs: {
          meta: null,
          body: null
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
      return;
    }

    const pre = document.createElement('pre');
    pre.className = 'conversation-document-card__content';
    pre.textContent = file.content || '';
    state.refs.body.appendChild(pre);
    card.classList.remove('is-missing');
    state.missing = false;
    state.loaded = true;
    state.content = file.content || '';

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
    if (state.loaded && options.force !== true) {
      return {
        ok: true,
        file: {
          path: card.dataset.documentPath || '',
          content: state.content,
          size_chars: Array.from(state.content || '').length
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

  function autoResizeConversationDocumentEditor(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(520, Math.max(textarea.scrollHeight, 140))}px`;
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
      renderConversationDocumentCardContent(card, {
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

    const state = getConversationDocumentCardState(card);
    state.refs.meta = meta;
    state.refs.body = body;

    card.appendChild(summary);
    card.appendChild(meta);
    card.appendChild(body);
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
    installConversationDocumentChangeListener,
    loadConversationDocumentCard
  };
}
