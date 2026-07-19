export const CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN = 'plain';
export const CONVERSATION_DOCUMENT_VIEW_MODE_MARKDOWN = 'markdown';
export const CONVERSATION_DOCUMENT_VIEW_MODE_CODE_HIGHLIGHT = 'code-highlight';
export const CONVERSATION_DOCUMENT_VIEW_MODE_HTML_PREVIEW = 'html-preview';

export const DOCUMENT_VIEWER_SETTING_RENDER_MARKDOWN_FOR_MD = 'documentRenderMarkdownForMd';
export const DOCUMENT_VIEWER_SETTING_MODE_OVERRIDES = 'documentViewModeOverrides';
export const DOCUMENT_VIEWER_SETTING_FONT_SIZE_PERCENT = 'documentFontSizePercent';

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);
const HTML_PREVIEW_EXTENSIONS = new Set(['html', 'htm']);
const CODE_LANGUAGE_BY_EXTENSION = Object.freeze({
  js: 'javascript',
  cjs: 'javascript',
  mjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  py: 'python',
  rb: 'ruby',
  php: 'php',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  conf: 'ini',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  swift: 'swift',
  dart: 'dart',
  lua: 'lua',
  vue: 'xml',
  svelte: 'xml'
});

function normalizeViewerString(value) {
  return (typeof value === 'string' || typeof value === 'number')
    ? String(value).trim()
    : '';
}

export function getConversationDocumentFileExtension(path) {
  const normalizedPath = normalizeViewerString(path).replace(/\\/g, '/');
  const baseName = normalizedPath.split('/').pop() || '';
  const lastDotIndex = baseName.lastIndexOf('.');
  if (lastDotIndex < 0 || lastDotIndex === baseName.length - 1) {
    return '';
  }
  return baseName.slice(lastDotIndex + 1).toLowerCase();
}

export function normalizeConversationDocumentViewMode(mode, fallback = CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN) {
  const normalized = normalizeViewerString(mode).toLowerCase();
  if (
    normalized === CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN
    || normalized === CONVERSATION_DOCUMENT_VIEW_MODE_MARKDOWN
    || normalized === CONVERSATION_DOCUMENT_VIEW_MODE_CODE_HIGHLIGHT
    || normalized === CONVERSATION_DOCUMENT_VIEW_MODE_HTML_PREVIEW
  ) {
    return normalized;
  }
  return fallback;
}

export function normalizeConversationDocumentViewModeOverridesSetting(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const result = {};
  Object.entries(value).forEach(([rawPath, rawMode]) => {
    const path = normalizeViewerString(rawPath);
    if (!path) return;
    const mode = normalizeConversationDocumentViewMode(rawMode, '');
    if (!mode) return;
    result[path] = mode;
  });
  return result;
}

export function clampConversationDocumentFontSizePercent(value, fallback = 100) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const clamped = Math.max(85, Math.min(150, numeric));
  return Math.round(clamped / 5) * 5;
}

export function resolveConversationDocumentCodeLanguage(path) {
  const extension = getConversationDocumentFileExtension(path);
  return CODE_LANGUAGE_BY_EXTENSION[extension] || '';
}

export function isConversationDocumentHtmlPreviewPath(path) {
  return HTML_PREVIEW_EXTENSIONS.has(getConversationDocumentFileExtension(path));
}

function normalizeConversationDocumentViewerSettings(settings = {}) {
  const safeSettings = (settings && typeof settings === 'object') ? settings : {};
  return {
    [DOCUMENT_VIEWER_SETTING_RENDER_MARKDOWN_FOR_MD]:
      safeSettings[DOCUMENT_VIEWER_SETTING_RENDER_MARKDOWN_FOR_MD] !== false,
    [DOCUMENT_VIEWER_SETTING_MODE_OVERRIDES]:
      normalizeConversationDocumentViewModeOverridesSetting(
        safeSettings[DOCUMENT_VIEWER_SETTING_MODE_OVERRIDES]
      )
  };
}

export function resolveConversationDocumentRenderState(path, settings = {}) {
  const normalizedPath = normalizeViewerString(path);
  const extension = getConversationDocumentFileExtension(normalizedPath);
  const language = resolveConversationDocumentCodeLanguage(normalizedPath);
  const normalizedSettings = normalizeConversationDocumentViewerSettings(settings);
  const overrides = normalizedSettings[DOCUMENT_VIEWER_SETTING_MODE_OVERRIDES];

  let allowedModes = [CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN];
  let defaultMode = CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN;

  // HTML 文件默认作为可视化交付物预览，同时保留源码高亮与纯文本路径，方便用户检查模型生成的真实源码。
  if (HTML_PREVIEW_EXTENSIONS.has(extension)) {
    allowedModes = [
      CONVERSATION_DOCUMENT_VIEW_MODE_HTML_PREVIEW,
      CONVERSATION_DOCUMENT_VIEW_MODE_CODE_HIGHLIGHT,
      CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN
    ];
    defaultMode = CONVERSATION_DOCUMENT_VIEW_MODE_HTML_PREVIEW;
  } else if (MARKDOWN_EXTENSIONS.has(extension)) {
    allowedModes = [
      CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN,
      CONVERSATION_DOCUMENT_VIEW_MODE_MARKDOWN
    ];
    defaultMode = normalizedSettings[DOCUMENT_VIEWER_SETTING_RENDER_MARKDOWN_FOR_MD]
      ? CONVERSATION_DOCUMENT_VIEW_MODE_MARKDOWN
      : CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN;
  } else if (extension === 'txt') {
    allowedModes = [CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN];
    defaultMode = CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN;
  } else if (language) {
    allowedModes = [
      CONVERSATION_DOCUMENT_VIEW_MODE_PLAIN,
      CONVERSATION_DOCUMENT_VIEW_MODE_CODE_HIGHLIGHT
    ];
    defaultMode = CONVERSATION_DOCUMENT_VIEW_MODE_CODE_HIGHLIGHT;
  }

  const overrideMode = normalizeConversationDocumentViewMode(overrides[normalizedPath], '');
  const mode = allowedModes.includes(overrideMode) ? overrideMode : defaultMode;

  return {
    path: normalizedPath,
    extension,
    language,
    defaultMode,
    mode,
    allowedModes,
    allowHtmlPreviewToggle: allowedModes.includes(CONVERSATION_DOCUMENT_VIEW_MODE_HTML_PREVIEW),
    allowMarkdownToggle: allowedModes.includes(CONVERSATION_DOCUMENT_VIEW_MODE_MARKDOWN),
    allowCodeHighlightToggle: allowedModes.includes(CONVERSATION_DOCUMENT_VIEW_MODE_CODE_HIGHLIGHT)
  };
}
