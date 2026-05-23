/**
 * AI 消息 footer 的 DOM 投影工具。
 *
 * 这里刻意把 tooltip/title 放在内部文本节点上，而不是放在整条 footer 容器上：
 * footer 容器通常占满整行用于右对齐，如果 title 挂在容器上，鼠标移到空白区域也会弹出详情。
 */
export function renderApiFooterDom(footer, renderData = {}) {
  if (!footer) return null;

  const text = typeof renderData.text === 'string' ? renderData.text : '';
  const title = typeof renderData.title === 'string' ? renderData.title : '';
  let textElement = footer.querySelector(':scope > .api-footer__text');

  if (!textElement) {
    const previousText = footer.textContent || '';
    textElement = document.createElement('span');
    textElement.className = 'api-footer__text';
    footer.textContent = '';
    footer.appendChild(textElement);
    if (previousText) {
      textElement.textContent = previousText;
    }
  }

  // 容器不能保留 title，否则右侧整行空白仍会触发浏览器原生 tooltip。
  footer.removeAttribute('title');

  if (textElement.textContent !== text) {
    textElement.textContent = text;
  }
  if (title) {
    textElement.title = title;
  } else {
    textElement.removeAttribute('title');
  }

  return textElement;
}
