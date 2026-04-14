export const CHAT_HISTORY_PANEL_LAYOUT_STORAGE_VERSION = 2;
export const CHAT_HISTORY_PANEL_LAYOUT_MODE_FULLSCREEN = 'fullscreen';
export const CHAT_HISTORY_PANEL_LAYOUT_MODE_SIDEBAR = 'sidebar';

function normalizeFiniteInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric);
}

function normalizeBoolean(value) {
  return value === true;
}

function normalizeLayoutEntry(rawEntry, { allowPosition }) {
  if (!rawEntry || typeof rawEntry !== 'object') return null;

  const width = normalizeFiniteInteger(rawEntry.width);
  const height = normalizeFiniteInteger(rawEntry.height);
  const left = allowPosition ? normalizeFiniteInteger(rawEntry.left) : null;
  const top = allowPosition ? normalizeFiniteInteger(rawEntry.top) : null;
  const sizeCustomized = normalizeBoolean(rawEntry.sizeCustomized);
  const dragPositioned = allowPosition ? normalizeBoolean(rawEntry.dragPositioned) : false;
  const updatedAt = normalizeFiniteInteger(rawEntry.updatedAt);

  return {
    width,
    height,
    left,
    top,
    sizeCustomized,
    dragPositioned,
    updatedAt
  };
}

export function normalizeChatHistoryPanelStoredLayout(rawLayout) {
  if (!rawLayout || typeof rawLayout !== 'object') {
    return {
      version: CHAT_HISTORY_PANEL_LAYOUT_STORAGE_VERSION,
      fullscreen: null,
      sidebar: null
    };
  }

  const version = Number(rawLayout.version);
  if (version === 1) {
    return {
      version: CHAT_HISTORY_PANEL_LAYOUT_STORAGE_VERSION,
      fullscreen: normalizeLayoutEntry(rawLayout, { allowPosition: true }),
      sidebar: null
    };
  }

  return {
    version: CHAT_HISTORY_PANEL_LAYOUT_STORAGE_VERSION,
    fullscreen: normalizeLayoutEntry(rawLayout.fullscreen, { allowPosition: true }),
    sidebar: normalizeLayoutEntry(rawLayout.sidebar, { allowPosition: false })
  };
}

export function readChatHistoryPanelLayoutEntry(layout, mode) {
  if (mode === CHAT_HISTORY_PANEL_LAYOUT_MODE_FULLSCREEN) {
    return layout?.fullscreen || null;
  }
  if (mode === CHAT_HISTORY_PANEL_LAYOUT_MODE_SIDEBAR) {
    return layout?.sidebar || null;
  }
  return null;
}

export function buildChatHistoryPanelStoredLayout({ existingLayout, mode, entry }) {
  const normalizedLayout = normalizeChatHistoryPanelStoredLayout(existingLayout);
  const normalizedEntry = normalizeLayoutEntry(entry, {
    allowPosition: mode === CHAT_HISTORY_PANEL_LAYOUT_MODE_FULLSCREEN
  });

  if (mode === CHAT_HISTORY_PANEL_LAYOUT_MODE_FULLSCREEN) {
    return {
      ...normalizedLayout,
      version: CHAT_HISTORY_PANEL_LAYOUT_STORAGE_VERSION,
      fullscreen: normalizedEntry
    };
  }

  if (mode === CHAT_HISTORY_PANEL_LAYOUT_MODE_SIDEBAR) {
    return {
      ...normalizedLayout,
      version: CHAT_HISTORY_PANEL_LAYOUT_STORAGE_VERSION,
      sidebar: normalizedEntry
    };
  }

  return normalizedLayout;
}

export function resolveChatHistoryPanelInteractionScale({
  documentZoomFactor,
  hostEmbedScale
}) {
  const safeDocumentZoom = Number(documentZoomFactor);
  const safeHostEmbedScale = Number(hostEmbedScale);
  const documentScale = Number.isFinite(safeDocumentZoom) && safeDocumentZoom > 0 ? safeDocumentZoom : 1;
  const embedScale = Number.isFinite(safeHostEmbedScale) && safeHostEmbedScale > 0 ? safeHostEmbedScale : 1;
  return documentScale * embedScale;
}
