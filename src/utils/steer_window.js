/**
 * steer window 纯函数工具。
 *
 * 目标：
 * - 把“多条 pending steer 如何聚合成一个窗口”这层语义集中到一起；
 * - 让 queue preview、thinking timeline、Responses follow-up 注入共用同一套顺序与拼接规则；
 * - 保持纯函数，方便单元测试直接锁死“按顺序合并、不拆散窗口”的契约。
 */

function cloneSteerWindowData(value) {
  if (value == null) return value ?? null;
  try {
    return structuredClone(value);
  } catch (_) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  }
}

function normalizeString(value) {
  return (typeof value === 'string') ? value : '';
}

function normalizeText(value) {
  return normalizeString(value).trim();
}

function normalizeCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.floor(numeric));
}

function normalizeInputTextPart(text) {
  const normalized = normalizeString(text);
  return normalized ? { type: 'input_text', text: normalized } : null;
}

function normalizeInputImagePart(part) {
  const imageUrl = normalizeText(part?.image_url);
  if (!imageUrl) return null;
  return {
    type: 'input_image',
    image_url: imageUrl
  };
}

function normalizeResponsesMessageContentParts(item) {
  if (!item || typeof item !== 'object') return [];
  if (typeof item.content === 'string') {
    const textPart = normalizeInputTextPart(item.content);
    return textPart ? [textPart] : [];
  }
  if (!Array.isArray(item.content)) return [];
  return item.content
    .map((part) => {
      if (!part || typeof part !== 'object') return null;
      if (part.type === 'input_text') return normalizeInputTextPart(part.text);
      if (part.type === 'input_image') return normalizeInputImagePart(part);
      return null;
    })
    .filter(Boolean);
}

function appendInputTextPart(parts, text) {
  const normalized = normalizeString(text);
  if (!normalized) return;
  const last = parts[parts.length - 1] || null;
  if (last?.type === 'input_text') {
    last.text = `${normalizeString(last.text)}${normalized}`;
    return;
  }
  parts.push({
    type: 'input_text',
    text: normalized
  });
}

function formatSteerPreviewLine(item) {
  const normalizedItem = item && typeof item === 'object' ? item : {};
  const baseText = normalizeText(normalizedItem.text)
    || (normalizeCount(normalizedItem.imageCount) > 0 ? '（等待吸收的转向图片消息）' : '（等待吸收的转向消息）');
  const tags = [];
  if (normalizedItem.hasScreenshot === true) tags.push('截图');
  if (normalizeCount(normalizedItem.imageCount) > 0) tags.push(`${normalizeCount(normalizedItem.imageCount)} 图`);
  return tags.length > 0
    ? `${baseText}（${tags.join(' / ')}）`
    : baseText;
}

/**
 * 归一化当前 steer window 中的每一条消息预览。
 *
 * @param {Array<any>|null|undefined} pendingSteers
 * @returns {Array<{id:string,text:string,imageCount:number,hasScreenshot:boolean}>}
 */
export function buildSteerWindowPreviewItems(pendingSteers) {
  const list = Array.isArray(pendingSteers) ? pendingSteers : [];
  return list.map((pendingSteer, index) => {
    const steer = (pendingSteer && typeof pendingSteer === 'object') ? pendingSteer : {};
    const imageCount = normalizeCount(steer.imageCount);
    const text = normalizeText(steer.textPreview) || normalizeText(steer.rawText)
      || (imageCount > 0 ? '（等待吸收的转向图片消息）' : '（等待吸收的转向消息）');
    return {
      id: normalizeText(steer.id) || `steer_${index + 1}`,
      text,
      imageCount,
      hasScreenshot: steer.hasScreenshot === true
    };
  });
}

/**
 * 把一个 steer window 渲染成 timeline 中展示用的 markdown 文本。
 *
 * 说明：
 * - 单条 steer 保持原样，避免无意义地额外包一层序号；
 * - 多条 steer 使用有序列表，保证“按顺序积累并一次性插入”的语义直观可见。
 *
 * @param {Array<any>|null|undefined} pendingSteers
 * @returns {string}
 */
export function buildSteerWindowMarkdown(pendingSteers) {
  const previewItems = buildSteerWindowPreviewItems(pendingSteers);
  if (previewItems.length <= 0) return '';
  if (previewItems.length === 1) {
    return formatSteerPreviewLine(previewItems[0]);
  }
  return previewItems
    .map((item, index) => `${index + 1}. ${formatSteerPreviewLine(item)}`)
    .join('\n');
}

/**
 * 把当前 window 内的多条 steer 合并成一次 Responses user message 注入。
 *
 * 设计取向：
 * - 与 Codex pending steer window 语义一致：一个安全边界只提交一个 steer window；
 * - 文本 steer 之间显式插入换行，保留顺序边界；
 * - 图片 / 文本 part 按原顺序串接，不再把多条 steer 拆成多条 user message。
 *
 * @param {Array<any>|null|undefined} pendingSteers
 * @returns {Object|null}
 */
export function buildMergedResponsesSteerInputItem(pendingSteers) {
  const list = Array.isArray(pendingSteers) ? pendingSteers : [];
  const mergedParts = [];
  let hasAppendedSteer = false;

  list.forEach((pendingSteer) => {
    const parts = normalizeResponsesMessageContentParts(pendingSteer?.responseInputItem);
    if (parts.length <= 0) return;
    if (hasAppendedSteer) {
      appendInputTextPart(mergedParts, '\n');
    }
    parts.forEach((part) => {
      if (part.type === 'input_text') {
        appendInputTextPart(mergedParts, part.text);
        return;
      }
      mergedParts.push(cloneSteerWindowData(part));
    });
    hasAppendedSteer = true;
  });

  if (mergedParts.length <= 0) return null;
  if (mergedParts.length === 1 && mergedParts[0].type === 'input_text') {
    return {
      type: 'message',
      role: 'user',
      content: mergedParts[0].text
    };
  }
  return {
    type: 'message',
    role: 'user',
    content: mergedParts.map((part) => cloneSteerWindowData(part)).filter(Boolean)
  };
}
