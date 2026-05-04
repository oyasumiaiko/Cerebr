const PICKER_RESULT_TYPE = 'CEREBR_LOCAL_FILE_PICKER_RESULT';

const params = new URLSearchParams(window.location.search || '');
const pickerKind = params.get('kind') === 'directory' ? 'directory' : 'file';
const requestId = params.get('requestId') || '';
const openerOrigin = window.location.origin;

const titleEl = document.getElementById('picker-title');
const descriptionEl = document.getElementById('picker-description');
const statusEl = document.getElementById('picker-status');
const pickButton = document.getElementById('pick-button');
const cancelButton = document.getElementById('cancel-button');

function setStatus(message) {
  if (statusEl) statusEl.textContent = message || '';
}

function setBusy(isBusy) {
  if (pickButton) pickButton.disabled = !!isBusy;
  if (cancelButton) cancelButton.disabled = !!isBusy;
}

function sendPickerResult(payload) {
  if (!window.opener || window.opener.closed) {
    setStatus('原 sidebar 窗口不可用，无法回传选择结果。');
    return false;
  }
  window.opener.postMessage({
    type: PICKER_RESULT_TYPE,
    requestId,
    kind: pickerKind,
    ...payload
  }, openerOrigin);
  return true;
}

function closeSoon() {
  window.setTimeout(() => {
    try {
      window.close();
    } catch (_) {}
  }, 80);
}

function normalizePickerError(error) {
  return {
    name: error?.name || 'LocalFilePickerError',
    message: error?.message || '本地文件选择失败。'
  };
}

async function runPicker({ automatic = false } = {}) {
  if (!requestId) {
    setStatus('缺少选择请求 ID，请关闭后重试。');
    return;
  }

  const isDirectory = pickerKind === 'directory';
  const pickerApiName = isDirectory ? 'showDirectoryPicker' : 'showOpenFilePicker';
  if (typeof window[pickerApiName] !== 'function') {
    const message = isDirectory
      ? '当前浏览器环境不支持选择本地文件夹。'
      : '当前浏览器环境不支持选择本地文件。';
    sendPickerResult({
      status: 'error',
      error: {
        name: 'NotSupportedError',
        message
      }
    });
    setStatus(message);
    return;
  }

  setBusy(true);
  setStatus(isDirectory ? '正在打开文件夹选择器...' : '正在打开文件选择器...');
  try {
    const handle = isDirectory
      ? await window.showDirectoryPicker({ mode: 'read' })
      : (await window.showOpenFilePicker({ multiple: false }))?.[0];
    if (!handle) {
      sendPickerResult({ status: 'aborted' });
      closeSoon();
      return;
    }
    const sent = sendPickerResult({
      status: 'selected',
      handle
    });
    if (sent) {
      setStatus('已选择，正在返回 Cerebr...');
      closeSoon();
    }
  } catch (error) {
    // 自动尝试可能没有继承用户激活；这种情况只显示按钮，不把失败回传给 sidebar。
    if (automatic && error?.name === 'NotAllowedError') {
      setBusy(false);
      setStatus('请点击“选择”继续。');
      return;
    }
    if (error?.name === 'AbortError') {
      sendPickerResult({ status: 'aborted' });
      closeSoon();
      return;
    }
    sendPickerResult({
      status: 'error',
      error: normalizePickerError(error)
    });
    setStatus(error?.message || '本地文件选择失败。');
  } finally {
    setBusy(false);
  }
}

function cancelPicker() {
  sendPickerResult({ status: 'aborted' });
  closeSoon();
}

if (titleEl) {
  titleEl.textContent = pickerKind === 'directory' ? '选择本地文件夹' : '选择本地文件';
}
if (descriptionEl) {
  descriptionEl.textContent = pickerKind === 'directory'
    ? '选择的文件夹会以 local/... 挂载到当前对话，模型读取时实时访问本机内容。'
    : '选择的文件会以 local/... 挂载到当前对话，模型读取时实时访问本机内容。';
}
if (pickButton) {
  pickButton.textContent = pickerKind === 'directory' ? '选择文件夹' : '选择文件';
  pickButton.addEventListener('click', () => {
    runPicker({ automatic: false });
  });
}
if (cancelButton) {
  cancelButton.addEventListener('click', cancelPicker);
}
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    cancelPicker();
  }
});

if (window.opener && requestId && window.navigator?.userActivation?.isActive) {
  runPicker({ automatic: true });
} else {
  setStatus('请点击“选择”继续。');
}
