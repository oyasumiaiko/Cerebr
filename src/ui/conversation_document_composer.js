import {
  buildConversationDocumentCollisionPath,
  CONVERSATION_DOCUMENT_CHANGE_EVENT_NAME,
  CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION,
  CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME,
  executeConversationDocumentAction,
  normalizeConversationDocumentPath
} from '../agent_tools/virtual_file_io/index.js';

function normalizeComposerString(value) {
  return (typeof value === 'string' || typeof value === 'number')
    ? String(value).trim()
    : '';
}

function deriveDocumentLinkLabel(filePath) {
  const normalized = normalizeComposerString(filePath).replace(/\\/g, '/');
  const basename = normalized.split('/').pop() || normalized;
  const lastDotIndex = basename.lastIndexOf('.');
  return lastDotIndex > 0 ? basename.slice(0, lastDotIndex) : basename;
}

function sanitizeDocumentFileSegment(value) {
  const source = String(value || '')
    .replace(/[\u0000-\u001F<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/g, '')
    .trim();
  return source || '';
}

function buildTimestampSuffix() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join('');
}

function buildSuggestedConversationDocumentPath(content) {
  const lines = String(content || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const firstLine = lines[0] || '';
  const heading = firstLine.replace(/^#+\s*/, '').trim();
  const candidate = sanitizeDocumentFileSegment(heading || firstLine);
  const filename = candidate || `file-${buildTimestampSuffix()}`;
  return `workspace/${filename}.md`;
}

function buildSuggestedConversationDocumentPathFromUploadName(fileName) {
  const normalizedName = sanitizeDocumentFileSegment(fileName);
  const filename = normalizedName || 'untitled';
  return `workspace/${filename}`;
}

function buildUploadedFileEventId() {
  return `${buildTimestampSuffix()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getComposerAccessoryMount(dom) {
  const host = dom?.composerAccessoryRegion || dom?.inputContainer || null;
  if (!host) return { host: null, anchor: null };
  return {
    host,
    anchor: dom?.scrollToBottomAnchor || null
  };
}

/**
 * 输入区对话文档创建器。
 *
 * 当前职责：
 * - 提供显式“新建文档”面板；
 * - 确保当前有可归属文档的会话 ID；
 * - 创建文档后把 Markdown 链接插回输入框，而不是自动发送。
 */
export function createConversationDocumentComposer(appContext) {
  const { dom, services, utils } = appContext;

  let panel = null;
  let pathInput = null;
  let contentTextarea = null;
  let uploadInput = null;
  let importedLocalFileDraft = null;
  let pendingUploadedFileEnvironmentEntries = [];

  function dispatchDocumentChangeEvent(changeEvent) {
    if (!changeEvent) return;
    try {
      document.dispatchEvent(new CustomEvent(CONVERSATION_DOCUMENT_CHANGE_EVENT_NAME, {
        detail: changeEvent
      }));
    } catch (_) {}
  }

  async function ensureDocumentConversationId() {
    const existingId = normalizeComposerString(services.chatHistoryUI?.getCurrentConversationId?.());
    if (existingId) return existingId;
    const nextId = await services.chatHistoryUI?.ensureCurrentConversationId?.({
      summary: '文件草稿'
    });
    const normalized = normalizeComposerString(nextId);
    if (!normalized) {
      throw new Error('当前无法为文件创建可用会话。');
    }
    services.messageSender?.setCurrentConversationId?.(normalized);
    return normalized;
  }

  async function resolveDocumentCreationPath(conversationId, requestedPath, content) {
    const candidatePath = normalizeComposerString(requestedPath)
      ? normalizeConversationDocumentPath(requestedPath)
      : normalizeConversationDocumentPath(buildSuggestedConversationDocumentPath(content));
    const listResult = await executeConversationDocumentAction(
      CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME,
      {},
      { conversationId }
    );
    const occupiedPaths = Array.isArray(listResult?.files)
      ? listResult.files.map((file) => file?.path).filter(Boolean)
      : [];
    return buildConversationDocumentCollisionPath(candidatePath, occupiedPaths);
  }

  async function createDocumentAndInsertLink(options = {}) {
    const requestedPath = normalizeComposerString(options.requestedPath);
    const content = typeof options.content === 'string' ? options.content : '';
    const replaceComposerText = options.replaceComposerText === true;
    const explicitLinkLabel = normalizeComposerString(options.linkLabel);

    const conversationId = await ensureDocumentConversationId();
    const filePath = await resolveDocumentCreationPath(conversationId, requestedPath, content);
    const result = await executeConversationDocumentAction(
      CONVERSATION_DOCUMENT_INTERNAL_WRITE_FILE_ACTION,
      {
        file_path: filePath,
        content
      },
      {
        conversationId,
        allowInternalActions: true
      }
    );
    if (result?.ok !== true || !result?.file?.path) {
      throw new Error(result?.error?.message || '文件创建失败。');
    }

    // 仅把“用户刚导入的本地文件”转成下一条消息前的隐藏环境提示；
    // 普通手动新建文件、长文本转文件都不附带这段额外说明。
    if (importedLocalFileDraft) {
      pendingUploadedFileEnvironmentEntries.push({
        path: result.file.path,
        source_name: importedLocalFileDraft.source_name,
        file_name_was_missing: importedLocalFileDraft.file_name_was_missing === true,
        upload_event_id: importedLocalFileDraft.upload_event_id
      });
      importedLocalFileDraft = null;
    }

    dispatchDocumentChangeEvent(result.change_event);

    const label = explicitLinkLabel || deriveDocumentLinkLabel(result.file.path);
    const markdownLink = `[${label}](${result.file.path})`;
    if (replaceComposerText) {
      services.inputController?.setInputText?.(markdownLink);
    } else {
      services.inputController?.insertTextAtCursor?.(markdownLink);
    }
    services.inputController?.focusToEnd?.();
    services.uiManager?.updateSendButtonState?.();
    utils.showNotification?.({ message: `已创建文件：${result.file.path}`, type: 'success', duration: 1800 });
    return {
      conversationId,
      filePath: result.file.path,
      markdownLink
    };
  }

  async function importLocalDocumentFile(file) {
    if (!file || typeof file.text !== 'function') return;
    const text = await file.text();
    const sourceName = normalizeComposerString(file.name);
    const normalizedUploadName = sanitizeDocumentFileSegment(sourceName);
    importedLocalFileDraft = {
      source_name: sourceName,
      file_name_was_missing: !normalizedUploadName,
      upload_event_id: buildUploadedFileEventId()
    };
    if (contentTextarea) {
      contentTextarea.value = text;
    }
    if (pathInput && !normalizeComposerString(pathInput.value)) {
      pathInput.value = buildSuggestedConversationDocumentPathFromUploadName(sourceName);
    }
  }

  function consumePendingUploadedFileEnvironmentEntries(messageText) {
    const normalizedMessageText = typeof messageText === 'string' ? messageText : '';
    if (!normalizedMessageText.trim()) return [];
    if (!Array.isArray(pendingUploadedFileEnvironmentEntries) || pendingUploadedFileEnvironmentEntries.length <= 0) {
      return [];
    }
    const matched = [];
    const remaining = [];
    pendingUploadedFileEnvironmentEntries.forEach((entry) => {
      const filePath = normalizeComposerString(entry?.path);
      if (filePath && normalizedMessageText.includes(filePath)) {
        matched.push({ ...entry });
      } else {
        remaining.push(entry);
      }
    });
    pendingUploadedFileEnvironmentEntries = remaining;
    return matched;
  }

  function removePanel() {
    panel?.remove();
    panel = null;
    pathInput = null;
    contentTextarea = null;
    uploadInput = null;
    importedLocalFileDraft = null;
  }

  function closeCreatePanel() {
    removePanel();
  }

  function ensureCreatePanel() {
    if (panel) return panel;

    panel = document.createElement('section');
    panel.className = 'composer-accessory-drawer composer-document-panel';

    const surface = document.createElement('div');
    surface.className = 'composer-accessory-drawer-surface composer-document-surface';

    const header = document.createElement('div');
    header.className = 'composer-document-panel__header';
    const title = document.createElement('div');
    title.className = 'composer-document-panel__title';
    title.textContent = '新建文件';
    const hint = document.createElement('div');
    hint.className = 'composer-document-panel__hint';
    hint.textContent = '创建完成后会把 Markdown 相对路径链接插入当前输入框，不会自动发送。支持 .md、.txt、.html、.js 等纯文本文件。';
    header.appendChild(title);
    header.appendChild(hint);

    const pathField = document.createElement('div');
    pathField.className = 'composer-document-panel__field';
    const pathLabel = document.createElement('label');
    pathLabel.className = 'composer-document-panel__label';
    pathLabel.textContent = '文件路径（可选）';
    pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.className = 'composer-document-panel__input';
    pathInput.placeholder = '留空时默认生成 workspace/<标题>.md；也可以自定义 .txt / .html / .js 等纯文本路径';
    pathField.appendChild(pathLabel);
    pathField.appendChild(pathInput);

    const contentField = document.createElement('div');
    contentField.className = 'composer-document-panel__field';
    const contentLabel = document.createElement('label');
    contentLabel.className = 'composer-document-panel__label';
    contentLabel.textContent = '文件内容';
    contentTextarea = document.createElement('textarea');
    contentTextarea.className = 'composer-document-panel__textarea';
    contentTextarea.placeholder = '输入纯文本文件内容；可以是笔记、Markdown、代码、HTML 等。若首行是 # 标题，会优先用它生成默认文件名。';
    contentField.appendChild(contentLabel);
    contentField.appendChild(contentTextarea);

    uploadInput = document.createElement('input');
    uploadInput.type = 'file';
    uploadInput.className = 'composer-document-panel__upload-input';
    uploadInput.hidden = true;
    uploadInput.addEventListener('change', async () => {
      const file = uploadInput?.files?.[0] || null;
      if (!file) return;
      try {
        await importLocalDocumentFile(file);
      } catch (error) {
        console.error('导入本地文件失败:', error);
        utils.showNotification?.({
          message: `导入文件失败：${error?.message || '未知错误'}`,
          type: 'error',
          duration: 2600
        });
      } finally {
        uploadInput.value = '';
      }
    });

    const actions = document.createElement('div');
    actions.className = 'composer-document-panel__actions';
    const importButton = document.createElement('button');
    importButton.type = 'button';
    importButton.className = 'composer-document-panel__button';
    importButton.textContent = '导入本地文件';
    importButton.addEventListener('click', () => uploadInput?.click?.());

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'composer-document-panel__button';
    cancelButton.textContent = '取消';
    cancelButton.addEventListener('click', () => closeCreatePanel());

    const createButton = document.createElement('button');
    createButton.type = 'button';
    createButton.className = 'composer-document-panel__button is-primary';
    createButton.textContent = '创建并插入链接';
    createButton.addEventListener('click', async () => {
      try {
        await createDocumentAndInsertLink({
          requestedPath: pathInput?.value || '',
          content: contentTextarea?.value || ''
        });
        closeCreatePanel();
      } catch (error) {
        console.error('创建对话文件失败:', error);
        utils.showNotification?.({
          message: `创建文件失败：${error?.message || '未知错误'}`,
          type: 'error',
          duration: 2600
        });
      }
    });

    contentTextarea.addEventListener('keydown', async (event) => {
      if (!(event.ctrlKey && event.key === 'Enter')) return;
      event.preventDefault();
      createButton.click();
    });

    actions.appendChild(importButton);
    actions.appendChild(cancelButton);
    actions.appendChild(createButton);
    surface.appendChild(header);
    surface.appendChild(pathField);
    surface.appendChild(contentField);
    surface.appendChild(uploadInput);
    surface.appendChild(actions);
    panel.appendChild(surface);

    const { host, anchor } = getComposerAccessoryMount(dom);
    if (host) {
      if (anchor && anchor.parentElement === host) {
        host.insertBefore(panel, anchor.nextSibling);
      } else {
        host.appendChild(panel);
      }
    }
    return panel;
  }

  function openCreatePanel() {
    const nextPanel = ensureCreatePanel();
    pathInput.value = '';
    contentTextarea.value = '';
    if (uploadInput) {
      uploadInput.value = '';
    }
    importedLocalFileDraft = null;
    window.setTimeout(() => {
      try {
        contentTextarea?.focus?.();
      } catch (_) {}
    }, 0);
    return nextPanel;
  }

  function toggleCreatePanel() {
    if (panel) {
      closeCreatePanel();
      return false;
    }
    openCreatePanel();
    return true;
  }

  return {
    openCreatePanel,
    closeCreatePanel,
    toggleCreatePanel,
    createDocumentAndInsertLink,
    consumePendingUploadedFileEnvironmentEntries,
    buildSuggestedDocumentPath: buildSuggestedConversationDocumentPath
  };
}
