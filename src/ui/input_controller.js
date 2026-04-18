/**
 * 输入控制器模块
 * 负责统一管理侧边栏输入框与图片容器的读写、状态查询和清理，降低业务逻辑与 DOM 的耦合。
 * @since 1.2.0
 */

/**
 * 创建输入控制器
 * @param {Object} appContext - 应用上下文，提供 DOM 与服务访问
 * @param {Object} appContext.dom - DOM 引用集合
 * @param {HTMLElement} appContext.dom.messageInput - 消息输入框元素
 * @param {HTMLElement} appContext.dom.imageContainer - 图片容器元素
 * @param {Object} appContext.services - 服务集合
 * @param {Object} appContext.services.uiManager - UI 管理器（用于重置高度等）
 * @returns {Object} 输入控制器实例
 * @property {() => string} getInputText 获取输入框文本内容（去除首尾空白）
 * @property {(text: string) => void} setInputText 设置输入框文本内容
 * @property {() => boolean} hasImages 输入区域是否包含图片
 * @property {() => string} getImagesHTML 获取输入区域图片的 HTML 片段
 * @property {() => boolean} hasScreenshot 是否包含页面截图图片（alt="page-screenshot.png"）
 * @property {() => void} clear 清空输入与图片，并重置输入高度
 * @property {() => void} focusToEnd 聚焦输入框并将光标移动到末尾
 * @property {(text: string) => void} insertTextAtCursor 在当前光标处插入文本
 */
const TEXT_NODE = (typeof Node !== 'undefined' && Number.isFinite(Node.TEXT_NODE)) ? Node.TEXT_NODE : 3;
const ELEMENT_NODE = (typeof Node !== 'undefined' && Number.isFinite(Node.ELEMENT_NODE)) ? Node.ELEMENT_NODE : 1;

function isContenteditableLineContainer(node) {
  if (!node || node.nodeType !== ELEMENT_NODE) return false;
  const tagName = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';
  return tagName === 'DIV' || tagName === 'P' || tagName === 'LI';
}

function extractContenteditableNodeText(node) {
  if (!node) return '';
  if (node.nodeType === TEXT_NODE) {
    return node.nodeValue || '';
  }
  if (node.nodeType !== ELEMENT_NODE) {
    return '';
  }
  if ((node.tagName || '').toUpperCase() === 'BR') {
    return '\n';
  }
  return Array.from(node.childNodes || [])
    .map((child) => extractContenteditableNodeText(child))
    .join('');
}

/**
 * 按照顶层节点的“语义边界”恢复 contenteditable 的逻辑文本。
 *
 * 这里不能简单地对所有顶层节点 `join('\n')`：
 * - Chrome 的 `plaintext-only` 输入框在 Shift+Enter 后，可能直接生成
 *   `["line1", "\n", "line2"]` 这样的顶层文本节点序列；
 * - 如果再人为在节点之间补一个 `\n`，同一处换行会被重复计算成多行空白。
 *
 * 因此这里改为“增量拼接”：
 * - 普通文本 / `<br>` 节点按原样直接追加；
 * - 只有块级容器（DIV/P/LI）才视为一条独立逻辑行；
 * - 对块级容器继续保留空行语义，避免 `<div><br></div>` 这种结构被压扁。
 *
 * @param {ArrayLike<Node>|Node[]} topLevelNodes
 * @returns {string}
 */
function extractContenteditableTopLevelText(topLevelNodes) {
  const nodes = Array.from(topLevelNodes || []);
  if (nodes.length === 0) return '';
  let result = '';
  nodes.forEach((node, index) => {
    if (isContenteditableLineContainer(node)) {
      const lineText = extractContenteditableNodeText(node).replace(/\n+$/g, '');
      if (result && !result.endsWith('\n')) {
        result += '\n';
      }
      result += lineText;
      if (index < nodes.length - 1) {
        result += '\n';
      }
      return;
    }
    result += extractContenteditableNodeText(node);
  });
  return result;
}

/**
 * 提取并规整 contenteditable 输入框里的逻辑纯文本。
 *
 * @param {HTMLElement|Object|null} targetInput
 * @returns {string}
 */
function extractPlainTextFromContenteditable(targetInput) {
  if (!targetInput) return '';
  const topLevelNodes = Array.from(targetInput.childNodes || []);
  const rawFromStructure = extractContenteditableTopLevelText(topLevelNodes);
  const raw = rawFromStructure
    || ((typeof targetInput.innerText === 'string' && targetInput.innerText.length > 0)
      ? targetInput.innerText
      : (targetInput.textContent || ''));
  return raw
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .trim();
}

export function createInputController(appContext) {
  const { dom, services } = appContext;
  const messageInput = dom.messageInput;
  const imageContainer = dom.imageContainer;

  /**
   * 从 contenteditable 输入框中提取“逻辑纯文本”。
   *
   * 关键点：
   * - `textContent` 对 contenteditable 的多行输入并不可靠，常会把 `<div>/<br>` 之间的换行丢掉；
   * - `innerText` 会按浏览器的可见文本规则补回逻辑换行，更接近用户真实输入；
   * - 这里统一把 CRLF 规整为 LF，并裁掉首尾空白，避免后续路径推断/长文本判断失真。
   */
  function readMessageInputPlainText() {
    if (!messageInput) return '';
    try {
      return extractPlainTextFromContenteditable(messageInput);
    } catch (_) {
      return '';
    }
  }

  /**
   * 获取输入文本
   * @returns {string} 输入文本内容
   */
  function getInputText() {
    return readMessageInputPlainText();
  }

  /**
   * 设置输入文本
   * @param {string} text 文本内容
   * @returns {void}
   */
  function setInputText(text) {
    if (!messageInput) return;
    try {
      messageInput.textContent = text || '';
    } catch (_) {}
  }

  /**
   * 是否包含图片
   * @returns {boolean}
   */
  function hasImages() {
    try {
      return !!imageContainer?.querySelector('.image-tag');
    } catch (_) {
      return false;
    }
  }

  /**
   * 获取图片 HTML
   * @returns {string}
   */
  function getImagesHTML() {
    try {
      return imageContainer?.innerHTML || '';
    } catch (_) {
      return '';
    }
  }

  /**
   * 是否包含截图图片
   * @returns {boolean}
   */
  function hasScreenshot() {
    try {
      return !!imageContainer?.querySelector('img[alt="page-screenshot.png"]');
    } catch (_) {
      return false;
    }
  }

  /**
   * 清空输入与图片，并重置输入高度
   * @returns {void}
   */
  function clear() {
    try { if (messageInput) messageInput.innerHTML = ''; } catch (_) {}
    try { if (imageContainer) imageContainer.innerHTML = ''; } catch (_) {}
    try { services?.uiManager?.resetInputHeight?.(); } catch (_) {}
  }

  /**
   * 聚焦输入框并将光标移到末尾
   * @returns {void}
   */
  function focusToEnd() {
    if (!messageInput) return;
    try {
      messageInput.focus();
      const range = document.createRange();
      range.selectNodeContents(messageInput);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (_) {}
  }

  /**
   * 在输入框当前光标位置插入文本。
   * 若当前选区不在输入框内，则回退为追加到末尾。
   *
   * @param {string} text
   * @returns {void}
   */
  function insertTextAtCursor(text) {
    if (!messageInput) return;
    const nextText = String(text ?? '');
    try {
      messageInput.focus();
      const selection = window.getSelection();
      let range = null;
      if (selection && selection.rangeCount > 0) {
        const candidate = selection.getRangeAt(0);
        if (messageInput.contains(candidate.commonAncestorContainer)) {
          range = candidate.cloneRange();
        }
      }
      if (!range) {
        range = document.createRange();
        range.selectNodeContents(messageInput);
        range.collapse(false);
      }
      range.deleteContents();
      const textNode = document.createTextNode(nextText);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);
      selection?.removeAllRanges?.();
      selection?.addRange?.(range);
      messageInput.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (_) {
      setInputText((getInputText() ? `${getInputText()}\n` : '') + nextText);
      try {
        messageInput.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (_) {}
    }
  }

  return {
    getInputText,
    setInputText,
    insertTextAtCursor,
    hasImages,
    getImagesHTML,
    hasScreenshot,
    clear,
    focusToEnd
  };
}

export {
  extractPlainTextFromContenteditable
};


