/**
 * Markdown 安全渲染工具
 *
 * 目标：
 * - 禁止原始 HTML 在 Markdown 中直接生效（例如 <script>、<iframe> 等）
 * - 支持 KaTeX 数学公式（$...$ / $$...$$ / \(...\) / \[...\]）
 * - 支持 Mermaid fenced code block，占位输出后在 DOM 挂载阶段异步渲染
 * - 支持 GFM 与换行、代码高亮、表格样式
 * - 使用 DOMPurify 进行严格白名单清洗
 * - 尽量保持纯函数式：输入字符串 → 输出安全 HTML 字符串
 *
 * 依赖（通过 sidebar.html 全局引入）：
 * - marked (window.marked)
 * - highlight.js (window.hljs)
 * - katex (window.katex)
 * - DOMPurify (window.DOMPurify)
 *
 * @since 1.0.0
 */

/* global marked, hljs, katex, DOMPurify */

import { createMermaidBlockHtml, isMermaidLanguage } from './mermaid_renderer.js';

/**
 * 简单 HTML 转义（用于极小范围需要时）。
 * @param {string} input - 原始字符串
 * @returns {string} - 转义后的字符串
 */
function escapeHtml(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeCodeFenceLanguage(infostring) {
  const source = (typeof infostring === 'string') ? infostring.trim() : '';
  if (!source) return '';
  const [languageToken] = source.split(/\s+/, 1);
  return (languageToken || '').trim().toLowerCase();
}

/**
 * 预处理：修正粗体解析（与现有逻辑一致），但避免在代码块内添加零宽空格。
 * @param {string} text - 原始文本
 * @returns {string}
 */
function fixBoldParsingIssue(text) {
  if (!text) return '';
  
  // 按代码块分割文本，只在非代码块部分添加零宽空格
  const segments = splitByCodeFences(text);
  return segments.map((segment, index) => {
    if (segment.type === 'code') {
      // 代码块内部保持原样，不添加零宽空格
      return segment.content;
    } else {
      // 普通文本部分添加零宽空格来修正粗体解析
      return segment.content.replace(/\*\*/g, '\u200B**\u200B');
    }
  }).join('```');
}

/**
 * 清理渲染后的 HTML 中的零宽字符。
 * 这些字符仅用于修正 Markdown 粗体解析，渲染完成后移除可避免后续选区匹配偏移。
 * @param {string} html - 渲染后的 HTML 字符串
 * @returns {string} - 去除零宽字符后的 HTML
 */
function removeZeroWidthFromHtml(html) {
  if (typeof html !== 'string') return '';
  return html.replace(/[\u200B\u200C\u200D\uFEFF]/g, '');
}

/**
 * 处理未闭合的代码块（确保 ``` 成对）。
 * @param {string} text - 原始文本
 * @returns {string}
 */
function closeUnbalancedCodeFences(text) {
  const codeFenceRegex = /```/g;
  const count = ((text || '').match(codeFenceRegex) || []).length;
  if (count % 2 !== 0) {
    return text + "\n```";
  }
  return text;
}

/**
 * 将文本按三引号代码块切片，偶数段落为普通文本，奇数段落为代码块。
 * @param {string} text
 * @returns {Array<{ type: 'text'|'code', content: string }>} 段落数组
 */
function splitByCodeFences(text) {
  if (!text) return [];
  const parts = text.split(/```/);
  return parts.map((content, index) => ({ type: index % 2 === 0 ? 'text' : 'code', content }));
}

/**
 * 生成数学占位符，使用纯 ASCII 避免在 DOMPurify 过程中被实体化。
 * @param {number} index - 自增索引
 * @returns {string}
 */
function createMathPlaceholder(index) {
  return `CEREBRMATHPLACEHOLDER${index}END`;
}

/**
 * 检查字符串中是否存在“位于 \\text{...} 之外的中文字符”。
 * 仅作为启发式：当发现中文且不在 TeX 的 \\text 片段内时，
 * 更倾向于认为整段 $...$ 是自然语言而非数学公式。
 *
 * 规则简化为：
 * - 识别形如 "\\text{...}" 的片段，允许内部出现任意中文；
 * - 只要在这些片段之外发现任意中文，即视为“包含非公式中文”。
 *
 * @param {string} input
 * @returns {boolean} 是否存在位于 \\text{...} 外部的中文字符
 */
function hasCjkOutsideTeXText(input) {
  if (!input) return false;
  let inText = false;
  let braceDepth = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (!inText) {
      // 检测 \text{ 起始
      if (ch === '\\' && input.slice(i, i + 6) === '\\text{') {
        inText = true;
        braceDepth = 1;
        i += 5; // 跳过 "text{"
        continue;
      }
      // 非 \text 段：若出现中文则认为在外部
      if (ch >= '\u4e00' && ch <= '\u9fff') {
        return true;
      }
    } else {
      // 处于 \text{...} 内部，简单跟踪大括号平衡
      if (ch === '{') {
        braceDepth++;
      } else if (ch === '}') {
        braceDepth--;
        if (braceDepth <= 0) {
          inText = false;
          braceDepth = 0;
        }
      }
    }
  }

  return false;
}

/**
 * 在非代码段中提取数学表达式为占位符。
 * 支持：
 * - \(...\) 行内
 * - \[...\] 块级
 * - $$...$$ 块级
 * - $...$ 行内（采用较严格启发式，减少与货币符号冲突）
 *
 * @param {string} text - 原始文本
 * @returns {{ text: string, mathTokens: Array<{ placeholder: string, content: string, display: boolean }> }}
 */
function extractMathPlaceholders(text, options = {}) {
  let work = text;
  const mathTokens = [];
  let counter = 0;
  const enableDollarMath = options.enableDollarMath !== false;

  // 1) \\[…\\] 块级
  work = work.replace(/\\\[([\s\S]+?)\\\]/g, (m, inner) => {
    const placeholder = createMathPlaceholder(counter++);
    mathTokens.push({ placeholder, content: inner, display: true });
    return placeholder;
  });

  // 2) \\\\\(...\\) 行内
  work = work.replace(/\\\(([\s\S]+?)\\\)/g, (m, inner) => {
    const placeholder = createMathPlaceholder(counter++);
    mathTokens.push({ placeholder, content: inner, display: false });
    return placeholder;
  });

  // 3) $$...$$ 块级（不跨越代码块，此函数只在纯文本段落上调用）
  if (enableDollarMath) {
    work = work.replace(/\$\$([\s\S]+?)\$\$/g, (m, inner) => {
      const placeholder = createMathPlaceholder(counter++);
      mathTokens.push({ placeholder, content: inner.trim(), display: true });
      return placeholder;
    });
  }

  // 4) $...$ 行内
  // 若关闭开关，则完全忽略 $ 作为数学分隔符，保留文本原样
  if (enableDollarMath) {
    (function () {
      const src = work;
      let out = '';
      let i = 0;

      while (i < src.length) {
        const ch = src[i];

        if (ch !== '$') {
          out += ch;
          i += 1;
          continue;
        }

        // 处理转义 \$：视为普通美元符号
        if (i > 0 && src[i - 1] === '\\') {
          if (out.endsWith('\\')) {
            out = out.slice(0, -1);
          }
          out += '$';
          i += 1;
          continue;
        }

        const startIndex = i;

        // 向后寻找与之成对的下一个 $（就近匹配），不跨越换行
        let j = i + 1;
        let foundNewline = false;
        while (j < src.length) {
          const ch2 = src[j];
          if (ch2 === '$') break;
          if (ch2 === '\n' || ch2 === '\r') {
            foundNewline = true;
            break;
          }
          j += 1;
        }

        // 没有找到匹配的 $，或中途遇到换行，则当前 $ 视为普通字符
        if (j >= src.length || foundNewline || src[j] !== '$') {
          out += ch;
          i += 1;
          continue;
        }

        const innerRaw = src.slice(i + 1, j);
        const trimmedInner = innerRaw.trim();

        // 空内容直接视为普通文本
        if (!trimmedInner) {
          out += src.slice(startIndex, j + 1);
          i = j + 1;
          continue;
        }

        // 不再做任何启发式判断：只要有成对的 $，就当作数学公式
        const placeholder = createMathPlaceholder(counter++);
        mathTokens.push({ placeholder, content: trimmedInner, display: false });
        out += placeholder;
        i = j + 1;
      }

      work = out;
    })();
  }

  return { text: work, mathTokens };
}

/**
 * 将数学占位符替换为 KaTeX HTML。
 * @param {string} html - 输入 HTML
 * @param {Array<{ placeholder: string, content: string, display: boolean }>} mathTokens - 占位符与内容
 * @returns {string}
 */
function restoreMath(html, mathTokens) {
  let out = html;
  for (const token of mathTokens) {
    let rendered = token.content;
    try {
      rendered = katex.renderToString(token.content, { displayMode: token.display, throwOnError: false });
    } catch (e) {
      // 保留原样以避免崩溃
      rendered = escapeHtml(token.content);
      if (token.display) rendered = `<pre class="math-error">${rendered}</pre>`;
      else rendered = `<span class="math-error">${rendered}</span>`;
    }
    out = out.split(token.placeholder).join(rendered);
  }
  return out;
}

/**
 * DOMPurify 配置（严格白名单）。
 * - 允许常见 Markdown 标签、KaTeX 必需标签、可选的 details/summary
 * - 禁止所有事件属性 on*
 * - 禁止危险标签
 */
const DEFAULT_PURIFY_CONFIG = {
//   ALLOWED_TAGS: [
//     'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'div', 'em', 'i', 'li', 'ol', 'p', 'pre', 'small', 'span', 'strong', 'sub', 'sup', 'u', 'ul', 'hr',
//     'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
//     'table', 'thead', 'tbody', 'tr', 'th', 'td',
//     'details', 'summary',
//     // KaTeX 可能用到
//     'math', 'annotation', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mtext', 'mover', 'munder'
//   ],
//   ALLOWED_ATTR: [
//     'href', 'title', 'target', 'rel',
//     'id', 'class', 'aria-hidden', 'aria-label', 'role', 'tabindex',
//     'colspan', 'rowspan', 'align'
//   ],
  FORBID_TAGS: [ 'script', 'style', 'iframe', 'object', 'embed', 'link', 'video', 'meta', 'form', 'input', 'button', 'textarea', 'select' ],
  FORBID_ATTR: [/^on/i],
  // 仅允许安全协议：
  // - http/https        普通网页链接
  // - mailto/tel        邮件和电话
  // - file              本地文件（用于扩展内展示下载到本地的图片）
  // - data:image/...    仅允许图片类型的 data URL，禁止其它 data: 方案
  // - 相对路径 / ? #    站内链接
  // - 额外允许“不带 scheme 的裸相对路径”，供虚拟文件链接如 `workspace/plan.md` / `local/project/a.md` 使用
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|file):|data:image\/[a-z0-9.+-]+;base64,|[\/\?#]|(?!\/\/)(?![a-z][a-z0-9+.-]*:).+)/i
};

/**
 * 生成 marked 渲染器，禁用原始 HTML 的直接输出（对 html token 统一转义）。
 * @returns {marked.Renderer}
 */
function createSafeMarkedRenderer() {
  const renderer = new marked.Renderer();
  const defaultCodeRenderer = renderer.code.bind(renderer);
  renderer.table = function(header, body) {
    return `<table class="markdown-table">\n<thead>\n${header}</thead>\n<tbody>\n${body}</tbody>\n</table>\n`;
  };
  renderer.code = function(code, infostring, escaped) {
    if (isMermaidLanguage(infostring)) {
      return createMermaidBlockHtml(code);
    }
    const rendered = defaultCodeRenderer(code, infostring, escaped);
    const language = normalizeCodeFenceLanguage(infostring);
    return `<div class="cerebr-markdown-code-block" data-code-language="${escapeHtml(language)}">${rendered}</div>`;
  };
  renderer.html = function(html) {
    // 直接透传，后续交由 DOMPurify 严格清洗
    return html;
  };
  return renderer;
}

/**
 * 将 Markdown 渲染为安全 HTML。
 *
 * 注意：函数为纯函数，不触碰 DOM。外部如需给链接添加 target/rel，建议在挂载后再做属性设置。
 *
 * @param {string} markdownText - 输入 Markdown 文本
 * @param {{ allowDetails?: boolean }} [options] - 可选项
 * @returns {string} 安全 HTML 字符串
 */
export function renderMarkdownSafe(markdownText, options = {}) {
  const allowDetails = options.allowDetails !== false; // 默认允许 details/summary
  const enableDollarMath = options.enableDollarMath !== false; // 默认启用 $ / $$ 数学

  // 1) 基本预处理
  const fixed = fixBoldParsingIssue(markdownText || '');
  const closed = closeUnbalancedCodeFences(fixed);

  // 2) 仅对“非代码块段落”抽取数学占位符，避免误伤代码
  const segments = splitByCodeFences(closed);
  let rebuilt = '';
  const collectedMathTokens = [];
  for (const seg of segments) {
    if (seg.type === 'code') {
      rebuilt += '```' + seg.content + '```';
    } else {
      const { text: out, mathTokens } = extractMathPlaceholders(seg.content, { enableDollarMath });
      collectedMathTokens.push(...mathTokens);
      rebuilt += out;
    }
  }

  // 3) marked 渲染（禁用原始 HTML）
  const renderer = createSafeMarkedRenderer();
  marked.setOptions({
    gfm: true,
    breaks: true,
    headerIds: false,
    mangle: false,
    renderer,
    highlight(code, lang) {
      try {
        if (lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value;
        }
        return hljs.highlightAuto(code).value;
      } catch (_) {
        return escapeHtml(code);
      }
    }
  });

  let html = marked.parse(rebuilt);
  html = html.replace(/<img\s*=/gi, '&lt;img=');

  // 4) DOMPurify 清洗（严格白名单）
  const purifyConfig = { ...DEFAULT_PURIFY_CONFIG };
  if (!allowDetails) {
    purifyConfig.FORBID_TAGS = Array.from(new Set([...(purifyConfig.FORBID_TAGS || []), 'details', 'summary']));
  }
  const safe = DOMPurify.sanitize(html, purifyConfig);

  // 5) 恢复数学（KaTeX 渲染）；KaTeX 输出不再经过二次清洗，确保保留其必需样式
  const restored = restoreMath(safe, collectedMathTokens);
  return removeZeroWidthFromHtml(restored);
}
