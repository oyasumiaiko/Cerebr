/**
 * 已序列化工具输出的内存分页缓存。
 *
 * 缓存保存的是原工具已经完成执行并序列化后的 content items。续读只改变字符窗口，
 * 不会再次调用原 handler。游标保持不透明，避免模型自行拼接 offset 并误读其它结果。
 */

import {
  paginateResponsesToolOutputContentItems
} from './responses_tool_output.js';

function createOpaqueToolOutputCursor() {
  try {
    if (typeof crypto?.randomUUID === 'function') {
      return `toolout_${crypto.randomUUID()}`;
    }
  } catch (_) {}
  return `toolout_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
}

export function createResponsesToolOutputPageCache(options = {}) {
  const entries = new Map();
  const createCursor = typeof options?.createCursor === 'function'
    ? options.createCursor
    : createOpaqueToolOutputCursor;

  function createUniqueCursor() {
    const base = String(createCursor() || '').trim();
    if (!base) {
      throw new Error('工具输出分页缓存无法生成有效 cursor。');
    }
    let cursor = base;
    let suffix = 1;
    while (entries.has(cursor)) {
      cursor = `${base}_${suffix}`;
      suffix += 1;
    }
    return cursor;
  }

  function paginateSource(contentItems, maxOutputChars, rangeStart = 0, format = 'xml') {
    const nextCursor = createUniqueCursor();
    const page = paginateResponsesToolOutputContentItems(contentItems, {
      maxOutputChars,
      rangeStart,
      nextCursor,
      format
    });
    if (page.nextCursor) {
      entries.set(page.nextCursor, {
        contentItems,
        rangeStart: page.rangeEnd,
        maxOutputChars,
        format
      });
    }
    return page;
  }

  return Object.freeze({
    paginate(contentItems, maxOutputChars, options = {}) {
      return paginateSource(contentItems, maxOutputChars, 0, options?.format || 'xml');
    },

    read(cursor, maxOutputChars = null) {
      const normalizedCursor = typeof cursor === 'string' ? cursor.trim() : '';
      const entry = normalizedCursor ? entries.get(normalizedCursor) : null;
      if (!entry) return null;
      return paginateSource(
        entry.contentItems,
        maxOutputChars == null ? entry.maxOutputChars : maxOutputChars,
        entry.rangeStart,
        entry.format
      );
    },

    has(cursor) {
      const normalizedCursor = typeof cursor === 'string' ? cursor.trim() : '';
      return !!normalizedCursor && entries.has(normalizedCursor);
    }
  });
}
