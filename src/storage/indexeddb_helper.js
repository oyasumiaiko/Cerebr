/**
 * IndexedDB 工具模块，用于存储聊天记录
 */

const CONVERSATION_DOCUMENT_STORE = 'conversation_documents';
const LOCAL_FILE_MOUNT_STORE = 'local_file_mounts';

/**
 * 打开或创建 "ChatHistoryDB" 数据库以及 "conversations" 对象存储
 * @returns {Promise<IDBDatabase>}
 */
let cachedDbPromise = null;
export function openChatHistoryDB() {
  // 说明：
  // - 全文搜索/历史列表会频繁调用 IndexedDB API；
  // - 若每次都 indexedDB.open，会产生大量重复的打开请求与事件回调开销；
  // - 这里缓存同一个连接（按上下文/页面粒度），显著降低高频读场景的额外开销。
  if (cachedDbPromise) return cachedDbPromise;

  cachedDbPromise = new Promise((resolve, reject) => {
    // v4: 新增按会话归属的 conversation_documents store，用于保存“对话级虚拟文档”。
    // v5: 新增 local_file_mounts store，只保存用户授权的 FileSystemHandle 与虚拟挂载点。
    // - conversations.endTime/url 仍用于历史列表与 URL 筛选；
    // - conversation_documents 采用 [conversation_id, path] 复合主键，便于级联删除与全文列举。
    // - endTime：用于快速按“最近对话”分页加载（避免全量扫描 + 排序）
    // - url：用于“按当前 URL 快速筛选历史会话”（按前缀范围查询）
    const request = indexedDB.open('ChatHistoryDB', 5);
    request.onerror = () => {
      cachedDbPromise = null;
      reject(request.error);
    };
    request.onsuccess = () => {
      const db = request.result;

      // 当数据库版本发生变化（例如扩展更新/多标签页同时打开）时，关闭旧连接并允许重新打开。
      db.onversionchange = () => {
        try { db.close(); } catch (_) {}
        cachedDbPromise = null;
      };

      resolve(db);
    };
    request.onupgradeneeded = event => {
      const db = event.target.result;
      const tx = event.target.transaction;
      
      // 创建或确保存在对话存储
      if (!db.objectStoreNames.contains('conversations')) {
        const store = db.createObjectStore('conversations', { keyPath: 'id' });
        store.createIndex('startTime', 'startTime', { unique: false });
        store.createIndex('endTime', 'endTime', { unique: false });
        store.createIndex('url', 'url', { unique: false });
      } else {
        // 既有数据库升级：补齐缺失索引（必须在 onupgradeneeded 的 transaction 内完成）
        try {
          const store = tx.objectStore('conversations');
          if (store && !store.indexNames.contains('startTime')) {
            store.createIndex('startTime', 'startTime', { unique: false });
          }
          if (store && !store.indexNames.contains('endTime')) {
            store.createIndex('endTime', 'endTime', { unique: false });
          }
          if (store && !store.indexNames.contains('url')) {
            store.createIndex('url', 'url', { unique: false });
          }
        } catch (e) {
          console.warn('升级 conversations 索引失败（可能由浏览器兼容性/事务状态导致）:', e);
        }
      }

      if (!db.objectStoreNames.contains(CONVERSATION_DOCUMENT_STORE)) {
        const store = db.createObjectStore(CONVERSATION_DOCUMENT_STORE, {
          keyPath: ['conversation_id', 'path']
        });
        store.createIndex('conversation_id', 'conversation_id', { unique: false });
        store.createIndex('conversation_id_updated_at', ['conversation_id', 'updated_at'], { unique: false });
      } else {
        try {
          const store = tx.objectStore(CONVERSATION_DOCUMENT_STORE);
          if (store && !store.indexNames.contains('conversation_id')) {
            store.createIndex('conversation_id', 'conversation_id', { unique: false });
          }
          if (store && !store.indexNames.contains('conversation_id_updated_at')) {
            store.createIndex('conversation_id_updated_at', ['conversation_id', 'updated_at'], { unique: false });
          }
        } catch (e) {
          console.warn('升级 conversation_documents 索引失败（可能由浏览器兼容性/事务状态导致）:', e);
        }
      }

      if (!db.objectStoreNames.contains(LOCAL_FILE_MOUNT_STORE)) {
        const store = db.createObjectStore(LOCAL_FILE_MOUNT_STORE, {
          keyPath: ['conversation_id', 'mount_path']
        });
        store.createIndex('conversation_id', 'conversation_id', { unique: false });
        store.createIndex('conversation_id_updated_at', ['conversation_id', 'updated_at'], { unique: false });
      } else {
        try {
          const store = tx.objectStore(LOCAL_FILE_MOUNT_STORE);
          if (store && !store.indexNames.contains('conversation_id')) {
            store.createIndex('conversation_id', 'conversation_id', { unique: false });
          }
          if (store && !store.indexNames.contains('conversation_id_updated_at')) {
            store.createIndex('conversation_id_updated_at', ['conversation_id', 'updated_at'], { unique: false });
          }
        } catch (e) {
          console.warn('升级 local_file_mounts 索引失败（可能由浏览器兼容性/事务状态导致）:', e);
        }
      }
      
      if (event.oldVersion < 3) {
        console.log('升级数据库：为 conversations 增加 endTime/url 索引（提升历史列表与 URL 筛选性能）');
      }
      if (event.oldVersion < 4) {
        console.log('升级数据库：新增 conversation_documents store（用于对话级文档虚拟文件）');
      }
      if (event.oldVersion < 5) {
        console.log('升级数据库：新增 local_file_mounts store（用于只读本地文件映射）');
      }
    };
  });

  return cachedDbPromise;
}

/**
 * 统计会话消息的数量结构（主对话/线程）。
 *
 * 说明：
 * - 该统计只做轻量遍历，不做任何 DOM/IO；
 * - 线程消息以 threadId/threadHiddenSelection/threadRootId/threadAnchorId 作为识别信号。
 *
 * @param {Array<Object>} messages
 * @returns {{totalCount:number, mainMessageCount:number, threadMessageCount:number, threadCount:number}}
 */
function computeConversationMessageStats(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let totalCount = 0;
  let mainMessageCount = 0;
  let threadMessageCount = 0;
  const threadIds = new Set();

  for (const msg of list) {
    if (!msg) continue;
    totalCount += 1;

    const threadId = typeof msg.threadId === 'string' && msg.threadId.trim() ? msg.threadId.trim() : '';
    const threadRootId = typeof msg.threadRootId === 'string' && msg.threadRootId.trim() ? msg.threadRootId.trim() : '';
    const threadAnchorId = typeof msg.threadAnchorId === 'string' && msg.threadAnchorId.trim() ? msg.threadAnchorId.trim() : '';
    const isThreadMessage = !!(threadId || msg.threadHiddenSelection || threadRootId || threadAnchorId);

    if (isThreadMessage) {
      threadMessageCount += 1;
      if (threadId) threadIds.add(threadId);
      else if (threadRootId) threadIds.add(`root:${threadRootId}`);
      else if (threadAnchorId) threadIds.add(`anchor:${threadAnchorId}`);
    } else {
      mainMessageCount += 1;
    }
  }

  return {
    totalCount,
    mainMessageCount,
    threadMessageCount,
    threadCount: threadIds.size
  };
}

/**
 * 将 conversations 表中的完整会话对象压缩为“列表/筛选用”的轻量元数据。
 *
 * 注意：
 * - IndexedDB 的 cursor.value / store.get 会把整条记录结构化克隆出来（可能包含 messages 大数组）。
 *   这里做“压缩”主要是为了：
 *   1) 降低上层 UI 的内存占用；
 *   2) 避免上层误用 messages 导致额外遍历。
 * - 这不会减少数据库读取成本，但能显著减少 JS 堆里长期保留的数据量。
 *
 * @param {Object} conv
 * @returns {{id:string, url:string, title:string, summary:string, startTime:number, endTime:number, messageCount:number, mainMessageCount:number, threadMessageCount:number, threadCount:number, parentConversationId:string|null, forkedFromMessageId:string|null, apiLock:Object|null}}
 */
function compactConversationApiLock(rawLock) {
  if (!rawLock || typeof rawLock !== 'object') return null;
  const normalizeConnectionType = (value) => {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (normalized === 'gemini') return 'gemini';
    if (normalized === 'openai_responses') return 'openai_responses';
    if (normalized === 'openai') return 'openai';
    return '';
  };
  const id = typeof rawLock.id === 'string' ? rawLock.id.trim() : '';
  const connectionSourceId = typeof rawLock.connectionSourceId === 'string' ? rawLock.connectionSourceId.trim() : '';
  const displayName = typeof rawLock.displayName === 'string' ? rawLock.displayName.trim() : '';
  const modelName = typeof rawLock.modelName === 'string' ? rawLock.modelName.trim() : '';
  const baseUrl = typeof rawLock.baseUrl === 'string' ? rawLock.baseUrl.trim() : '';
  let connectionType = normalizeConnectionType(rawLock.connectionType);
  const normalizedBaseUrl = baseUrl.toLowerCase();
  if (!connectionType && (normalizedBaseUrl === 'genai' || normalizedBaseUrl.includes('generativelanguage.googleapis.com'))) {
    connectionType = 'gemini';
  } else if (!connectionType && /(^|\/)responses(?:\/[^/?#]+)?\/?$/.test(normalizedBaseUrl)) {
    connectionType = 'openai_responses';
  }
  if (!id && !connectionSourceId && !displayName && !modelName && !baseUrl) return null;
  return { id, connectionSourceId, displayName, modelName, baseUrl, connectionType };
}

function compactConversationToMetadata(conv) {
  const id = conv?.id || '';
  const url = typeof conv?.url === 'string' ? conv.url : '';
  const title = typeof conv?.title === 'string' ? conv.title : '';
  const summary = typeof conv?.summary === 'string' ? conv.summary : '';
  const startTime = Number(conv?.startTime) || 0;
  const endTime = Number(conv?.endTime) || 0;
  const storedMessageCount = Number(conv?.messageCount);
  const storedMainCount = Number(conv?.mainMessageCount);
  const storedThreadMessageCount = Number(conv?.threadMessageCount);
  const storedThreadCount = Number(conv?.threadCount);
  const hasStoredCounts = Number.isFinite(storedMainCount)
    && Number.isFinite(storedThreadMessageCount)
    && Number.isFinite(storedThreadCount);
  const stats = hasStoredCounts ? null : computeConversationMessageStats(conv?.messages);

  const messageCount = Number.isFinite(storedMessageCount)
    ? storedMessageCount
    : (stats ? stats.totalCount : (Array.isArray(conv?.messages) ? conv.messages.length : 0) || 0);
  const mainMessageCount = hasStoredCounts
    ? storedMainCount
    : (stats ? stats.mainMessageCount : Math.max(0, messageCount));
  const threadMessageCount = hasStoredCounts
    ? storedThreadMessageCount
    : (stats ? stats.threadMessageCount : 0);
  const threadCount = hasStoredCounts
    ? storedThreadCount
    : (stats ? stats.threadCount : 0);
  // 分支元信息：用于 UI 侧构建“会话分支树”
  const parentConversationId = typeof conv?.parentConversationId === 'string' && conv.parentConversationId.trim()
    ? conv.parentConversationId.trim()
    : null;
  const forkedFromMessageId = typeof conv?.forkedFromMessageId === 'string' && conv.forkedFromMessageId.trim()
    ? conv.forkedFromMessageId.trim()
    : null;
  return {
    id,
    url,
    title,
    summary,
    startTime,
    endTime,
    messageCount,
    mainMessageCount,
    threadMessageCount,
    threadCount,
    parentConversationId,
    forkedFromMessageId,
    apiLock: compactConversationApiLock(conv?.apiLock)
  };
}

/**
 * 获取全部对话记录元数据（列表/筛选用的“轻量字段”）。
 *
 * 注意：
 * - 由于 conversations 记录本身包含 messages 大数组，IndexedDB 在读取时仍会结构化克隆整条记录；
 * - 这里的“轻量化”主要是为了减少上层长期保留的 JS 对象体积（避免把 messages/messageIds 留在内存里）。
 *
 * @returns {Promise<Array<{id:string, url:string, title:string, summary:string, startTime:number, endTime:number, messageCount:number, mainMessageCount:number, threadMessageCount:number, threadCount:number, parentConversationId:string|null, forkedFromMessageId:string|null, apiLock:Object|null}>>}
 */
export async function getAllConversationMetadata() {
  const db = await openChatHistoryDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('conversations', 'readonly');
    const store = transaction.objectStore('conversations');
    const conversations = []; // 用于累积结果的数组
    const request = store.openCursor(); // 使用游标代替 getAll()

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        const conv = cursor.value;
        conversations.push(compactConversationToMetadata(conv));
        
        cursor.continue(); // 继续到下一条记录
      } else {
        // 没有更多记录了，游标遍历完成
        resolve(conversations);
      }
    };

    request.onerror = (event) => {
      // 处理游标请求期间的错误
      reject(event.target.error);
    };
  });
}

/**
 * 批量按 id 读取会话“轻量元数据”。
 * @param {string[]} ids
 * @returns {Promise<Array<{id:string, url:string, title:string, summary:string, startTime:number, endTime:number, messageCount:number, mainMessageCount:number, threadMessageCount:number, threadCount:number, parentConversationId:string|null, forkedFromMessageId:string|null, apiLock:Object|null}>>}
 */
export async function getConversationMetadataByIds(ids) {
  const idList = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (idList.length === 0) return [];

  const db = await openChatHistoryDB();
  const transaction = db.transaction('conversations', 'readonly');
  const store = transaction.objectStore('conversations');

  const tasks = idList.map((id) => new Promise((resolve) => {
    try {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result ? compactConversationToMetadata(request.result) : null);
      request.onerror = () => resolve(null);
    } catch (_) {
      resolve(null);
    }
  }));

  const results = await Promise.all(tasks);
  return results.filter(Boolean);
}

/**
 * 按 endTime 倒序分页读取会话“轻量元数据”。
 *
 * 说明：
 * - 优先使用 conversations.endTime 索引；若索引不存在，则回退为全量扫描（仅作为兜底）。
 * - 该分页 cursor 设计为“尽量稳定”：用 endTime + seenIds 解决同一 endTime 重复值导致的翻页重复/遗漏问题。
 *
 * @param {Object} options
 * @param {number} [options.limit=50]
 * @param {{endTime:number, seenIds:string[]}|null} [options.cursor=null]
 * @param {string[]|Set<string>} [options.excludeIds=[]] - 需要跳过的会话 id（例如置顶会话）
 * @returns {Promise<{items: Array<{id:string, url:string, title:string, summary:string, startTime:number, endTime:number, messageCount:number, mainMessageCount:number, threadMessageCount:number, threadCount:number, parentConversationId:string|null, forkedFromMessageId:string|null, apiLock:Object|null}>, cursor: {endTime:number, seenIds:string[]} | null, hasMore: boolean}>}
 */
export async function getConversationMetadataPageByEndTimeDesc(options = {}) {
  const limit = Math.max(0, Number(options.limit) || 50);
  if (limit === 0) return { items: [], cursor: null, hasMore: false };

  const cursorIn = options.cursor && typeof options.cursor === 'object' ? options.cursor : null;
  const cursorEndTime = cursorIn && Number.isFinite(Number(cursorIn.endTime)) ? Number(cursorIn.endTime) : null;
  const cursorSeenIds = new Set(Array.isArray(cursorIn?.seenIds) ? cursorIn.seenIds : []);

  const excludeIds = (() => {
    if (options.excludeIds instanceof Set) return options.excludeIds;
    if (Array.isArray(options.excludeIds)) return new Set(options.excludeIds.filter(Boolean));
    return new Set();
  })();

  const db = await openChatHistoryDB();
  const transaction = db.transaction('conversations', 'readonly');
  const store = transaction.objectStore('conversations');

  // 优先走 endTime 索引（v3+）
  let endTimeIndex = null;
  try {
    if (store.indexNames.contains('endTime')) {
      endTimeIndex = store.index('endTime');
    }
  } catch (_) {
    endTimeIndex = null;
  }

  // --- 索引不可用：兜底为全量扫描（仅保证功能正确，不保证性能） ---
  if (!endTimeIndex) {
    const all = await new Promise((resolve, reject) => {
      const out = [];
      const req = store.openCursor();
      req.onsuccess = (event) => {
        const c = event.target.result;
        if (!c) {
          resolve(out);
          return;
        }
        out.push(compactConversationToMetadata(c.value));
        c.continue();
      };
      req.onerror = (event) => reject(event.target.error);
    });

    const filtered = all.filter((item) => item && item.id && !excludeIds.has(item.id));
    filtered.sort((a, b) => (Number(b.endTime) || 0) - (Number(a.endTime) || 0));
    const items = filtered.slice(0, limit);
    return { items, cursor: null, hasMore: filtered.length > items.length };
  }

  const keyRange = cursorEndTime != null ? IDBKeyRange.upperBound(cursorEndTime) : null;
  const items = [];
  let hasMore = false;

  // 分页：记录“最后一条返回记录的 endTime”以及该 endTime 下已返回过的 id 集合
  let lastReturnedEndTime = null;
  let lastReturnedIdsAtEndTime = [];

  return await new Promise((resolve, reject) => {
    const request = endTimeIndex.openCursor(keyRange, 'prev');
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) {
        resolve({ items, cursor: null, hasMore: false });
        return;
      }

      const conv = cursor.value;
      const meta = compactConversationToMetadata(conv);

      // 跳过：置顶/排除项
      if (!meta.id || excludeIds.has(meta.id)) {
        cursor.continue();
        return;
      }

      // 跳过：同一个 endTime 下已返回过的 id（用于稳定翻页）
      const metaEndTime = Number(meta.endTime) || 0;
      if (cursorEndTime != null && metaEndTime === cursorEndTime && cursorSeenIds.has(meta.id)) {
        cursor.continue();
        return;
      }

      items.push(meta);

      if (lastReturnedEndTime == null || metaEndTime !== lastReturnedEndTime) {
        lastReturnedEndTime = metaEndTime;
        lastReturnedIdsAtEndTime = [meta.id];
      } else {
        lastReturnedIdsAtEndTime.push(meta.id);
      }

      if (items.length >= limit) {
        hasMore = true;

        // 生成下一页 cursor
        const nextEndTime = lastReturnedEndTime == null ? metaEndTime : lastReturnedEndTime;
        const nextSeenIds = (() => {
          // 若下一页仍停留在同一个 endTime，需要把旧 seenIds 合并进去，避免重复
          if (cursorEndTime != null && nextEndTime === cursorEndTime) {
            const merged = new Set(cursorSeenIds);
            lastReturnedIdsAtEndTime.forEach((id) => merged.add(id));
            return Array.from(merged);
          }
          return lastReturnedIdsAtEndTime.slice();
        })();

        resolve({
          items,
          cursor: { endTime: nextEndTime, seenIds: nextSeenIds },
          hasMore
        });
        return;
      }

      cursor.continue();
    };

    request.onerror = (event) => reject(event.target.error);
  });
}

/**
 * 按“URL 前缀候选列表”筛选出匹配的会话元数据，并标注匹配等级。
 *
 * 说明：
 * - 若存在 conversations.url 索引（v3+），则用前缀范围查询以避免全库扫描；
 * - 匹配等级以 candidateUrls 的索引为准：越靠前越“严格/具体”；
 * - 同一会话只会分配到最严格的那个等级（去重逻辑：先处理更严格的 candidate）。
 *
 * @param {string[]} candidateUrls
 * @returns {Promise<Array<{id:string, url:string, title:string, summary:string, startTime:number, endTime:number, messageCount:number, mainMessageCount:number, threadMessageCount:number, threadCount:number, parentConversationId:string|null, forkedFromMessageId:string|null, urlMatchLevel:number, urlMatchPrefix:string}>>}
 */
export async function listConversationMetadataByUrlCandidates(candidateUrls) {
  const candidates = Array.isArray(candidateUrls)
    ? candidateUrls.filter((c) => typeof c === 'string' && c.length > 0)
    : [];
  if (candidates.length === 0) return [];

  const db = await openChatHistoryDB();
  const transaction = db.transaction('conversations', 'readonly');
  const store = transaction.objectStore('conversations');

  let urlIndex = null;
  try {
    if (store.indexNames.contains('url')) {
      urlIndex = store.index('url');
    }
  } catch (_) {
    urlIndex = null;
  }

  // v3+：优先用 url 索引按前缀查
  if (urlIndex) {
    const seenIds = new Set();
    const results = [];

    // 逐个 candidate 查询：先严格后宽松，确保“等级”分配稳定
    for (let level = 0; level < candidates.length; level += 1) {
      const prefix = candidates[level];
      const upper = `${prefix}\uffff`;
      const range = IDBKeyRange.bound(prefix, upper, false, false);

      await new Promise((resolve, reject) => {
        const req = urlIndex.openCursor(range);
        req.onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor) {
            resolve();
            return;
          }
          const conv = cursor.value;
          const meta = compactConversationToMetadata(conv);
          if (meta.id && !seenIds.has(meta.id)) {
            seenIds.add(meta.id);
            results.push({
              ...meta,
              urlMatchLevel: level,
              urlMatchPrefix: prefix
            });
          }
          cursor.continue();
        };
        req.onerror = (event) => reject(event.target.error);
      });
    }

    return results;
  }

  // 兜底：全量扫描（仅保证功能正确，不保证性能）
  return await new Promise((resolve, reject) => {
    const out = [];
    const req = store.openCursor();
    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) {
        resolve(out);
        return;
      }
      const conv = cursor.value;
      const meta = compactConversationToMetadata(conv);
      const url = meta.url || '';
      const level = candidates.findIndex((prefix) => url.startsWith(prefix));
      if (level >= 0) {
        out.push({
          ...meta,
          urlMatchLevel: level,
          urlMatchPrefix: candidates[level]
        });
      }
      cursor.continue();
    };
    req.onerror = (event) => reject(event.target.error);
  });
}

/**
 * 根据一组 URL 候选前缀，从 IndexedDB 中找出“最适合继续对话”的会话元数据。
 *
 * 设计背景：
 * - “继续本页对话”只需要定位到一个会话（通常是最近的一条），不需要把所有会话都搬到内存里再排序；
 * - 旧实现会先取出全部会话元数据并在 UI 层做排序/扫描；
 * - 这里将匹配逻辑下沉到游标遍历过程中，避免：
 *   - 额外的数组构建与排序开销；
 *   - 为每条会话计算 messageIds（这在会话很多/消息很多时会显著拖慢）。
 *
 * 匹配规则：
 * - candidateUrls 为“从严格到宽松”的前缀列表；
 * - 优先命中更严格的 candidate；
 * - 在同一个 candidate 下，选择 endTime 最大的会话；
 * - endTime 相同则保留更早遇到的记录（等价于稳定排序后的选择结果）。
 *
 * 返回值：
 * - 返回一个“精简版”会话对象（仅包含 id/url/startTime/endTime/title），以降低对象复制与内存占用；
 * - 调用方如需完整 messages，请再用 getConversationById 加载。
 *
 * @param {string[]} candidateUrls
 * @returns {Promise<({id:string, url?:string, startTime?:number, endTime?:number, title?:string}|null)>}
 */
export async function findMostRecentConversationMetadataByUrlCandidates(candidateUrls) {
  const candidates = Array.isArray(candidateUrls)
    ? candidateUrls.filter((c) => typeof c === 'string' && c.length > 0)
    : [];
  if (candidates.length === 0) return null;

  const db = await openChatHistoryDB();
  const transaction = db.transaction('conversations', 'readonly');
  const store = transaction.objectStore('conversations');

  // v3+：若存在 url 索引，优先走“前缀范围查询”，避免全量扫描
  let urlIndex = null;
  try {
    if (store.indexNames.contains('url')) {
      urlIndex = store.index('url');
    }
  } catch (_) {
    urlIndex = null;
  }

  if (urlIndex) {
    for (let level = 0; level < candidates.length; level += 1) {
      const prefix = candidates[level];
      const upper = `${prefix}\uffff`;
      const range = IDBKeyRange.bound(prefix, upper, false, false);

      const best = await new Promise((resolve, reject) => {
        let bestMeta = null;
        let bestEndTime = -1;
        const req = urlIndex.openCursor(range);
        req.onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor) {
            resolve(bestMeta);
            return;
          }
          const conv = cursor.value;
          const endTime = Number(conv?.endTime) || 0;
          if (!bestMeta || endTime > bestEndTime) {
            bestMeta = {
              id: conv?.id,
              url: conv?.url,
              startTime: conv?.startTime,
              endTime: conv?.endTime,
              title: conv?.title
            };
            bestEndTime = endTime;
          }
          cursor.continue();
        };
        req.onerror = (event) => reject(event.target.error);
      });

      if (best) return best;
    }
    return null;
  }

  // 兜底：无 url 索引时，回退为全量扫描
  return await new Promise((resolve, reject) => {
    const bestByIndex = new Array(candidates.length).fill(null);
    const bestEndTimeByIndex = new Array(candidates.length).fill(-1);

    const request = store.openCursor();
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) {
        for (let i = 0; i < bestByIndex.length; i += 1) {
          if (bestByIndex[i]) {
            resolve(bestByIndex[i]);
            return;
          }
        }
        resolve(null);
        return;
      }

      const conv = cursor.value;
      const url = conv?.url;
      if (typeof url === 'string' && url.length > 0) {
        for (let i = 0; i < candidates.length; i += 1) {
          const candidate = candidates[i];
          if (!url.startsWith(candidate)) continue;

          const endTime = Number(conv?.endTime) || 0;
          if (!bestByIndex[i] || endTime > bestEndTimeByIndex[i]) {
            bestByIndex[i] = {
              id: conv?.id,
              url: conv?.url,
              startTime: conv?.startTime,
              endTime: conv?.endTime,
              title: conv?.title
            };
            bestEndTimeByIndex[i] = endTime;
          }
          break;
        }
      }

      cursor.continue();
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

/**
 * 获取全部对话记录
 * @param {boolean} [loadFullContent=true] - 兼容保留：已不再区分加载方式
 * @returns {Promise<Array<Object>>} 包含所有对话记录的数组
 */
export async function getAllConversations(loadFullContent = true) {
  const db = await openChatHistoryDB();
  
  // 获取所有会话基本信息
  const conversations = await new Promise((resolve, reject) => {
    const transaction = db.transaction('conversations', 'readonly');
    const store = transaction.objectStore('conversations');
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  void loadFullContent;
  return conversations;
}

/**
 * 添加或更新一条对话记录。
 *
 * 说明：
 * - separateContent 参数仅为历史兼容保留，不再生效；
 *
 * @param {Object} conversation - 对话记录对象
 * @param {boolean} [separateContent=false] - 已弃用：不再生效
 * @returns {Promise<void>}
 */
export async function putConversation(conversation, separateContent = false) {
  void separateContent;
  const db = await openChatHistoryDB();
  const transaction = db.transaction('conversations', 'readwrite');
  const conversationStore = transaction.objectStore('conversations');

  // 复制会话对象，避免修改原始对象
  const conversationToStore = { ...conversation };

  return new Promise((resolve, reject) => {
    const request = conversationStore.put(conversationToStore);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * 删除指定 id 的对话记录及其相关内容
 * @param {string} conversationId - 要删除的对话记录 id
 * @returns {Promise<void>}
 */
export async function deleteConversation(conversationId) {
  const db = await openChatHistoryDB();
  
  const transaction = db.transaction(['conversations', CONVERSATION_DOCUMENT_STORE, LOCAL_FILE_MOUNT_STORE], 'readwrite');
  const conversationStore = transaction.objectStore('conversations');
  const documentStore = transaction.objectStore(CONVERSATION_DOCUMENT_STORE);
  const localMountStore = transaction.objectStore(LOCAL_FILE_MOUNT_STORE);
  
  // 删除会话记录，并级联清理该会话的虚拟文档。
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
    const request = conversationStore.delete(conversationId);
    request.onsuccess = () => {
      try {
        const index = documentStore.index('conversation_id');
        const range = IDBKeyRange.only(String(conversationId || ''));
        const cursorRequest = index.openKeyCursor(range);
        cursorRequest.onerror = () => reject(cursorRequest.error);
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            return;
          }
          documentStore.delete(cursor.primaryKey);
          cursor.continue();
        };
        const localIndex = localMountStore.index('conversation_id');
        const localRange = IDBKeyRange.only(String(conversationId || ''));
        const localCursorRequest = localIndex.openKeyCursor(localRange);
        localCursorRequest.onerror = () => reject(localCursorRequest.error);
        localCursorRequest.onsuccess = () => {
          const cursor = localCursorRequest.result;
          if (!cursor) {
            return;
          }
          localMountStore.delete(cursor.primaryKey);
          cursor.continue();
        };
      } catch (error) {
        reject(error);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * 根据对话 ID 获取单条对话记录，可选择是否加载完整消息内容
 * @param {string} conversationId - 要查找的对话记录 id
 * @param {boolean} [loadFullContent=true] - 兼容保留：已不再区分加载方式
 * @returns {Promise<Object|null>} 返回匹配的对话记录对象，如果不存在则返回 null
 */
export async function getConversationById(conversationId, loadFullContent = true) {
  const db = await openChatHistoryDB();
  
  // 获取会话基本信息
  const conversation = await new Promise((resolve, reject) => {
    const transaction = db.transaction('conversations', 'readonly');
    const store = transaction.objectStore('conversations');
    const request = store.get(conversationId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  
  void loadFullContent;
  return conversation;
}

/**
 * 批量按 id 读取会话记录，可选择是否加载完整消息内容。
 *
 * 性能说明：
 * - 全文搜索会短时间内读取大量会话；若逐条调用 getConversationById，会产生大量 transaction 开销；
 * - 这里用“一次 transaction + 多个 store.get”来批量读取，显著减少事务次数。
 *
 * 注意：
 * - 返回数组会尽量保持与入参 ids 的顺序一致（缺失项返回 null 并在最终结果中过滤掉）。
 * - loadFullContent 参数仅为历史兼容保留，不再区分加载方式。
 *
 * @param {string[]} ids - 会话 id 列表
 * @param {boolean} [loadFullContent=true] - 是否加载完整消息内容
 * @returns {Promise<Array<Object>>} 会话对象数组（不包含 null）
 */
export async function getConversationsByIds(ids, loadFullContent = true) {
  const idList = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (idList.length === 0) return [];

  const db = await openChatHistoryDB();

  // 1) 批量读取 conversations
  const conversations = await new Promise((resolve) => {
    try {
      const transaction = db.transaction('conversations', 'readonly');
      const store = transaction.objectStore('conversations');

      const tasks = idList.map((id) => new Promise((taskResolve) => {
        try {
          const request = store.get(id);
          request.onsuccess = () => taskResolve(request.result || null);
          request.onerror = () => taskResolve(null);
        } catch (_) {
          taskResolve(null);
        }
      }));

      Promise.all(tasks)
        .then(resolve)
        .catch(() => resolve([]));
    } catch (_) {
      resolve([]);
    }
  });

  void loadFullContent;
  return Array.isArray(conversations) ? conversations.filter(Boolean) : [];
}

/**
 * 释放指定会话的内存（兼容接口）。
 *
 * 说明：
 * - 仅返回浅拷贝，保持调用端“不会直接修改原对象”的预期。
 *
 * @param {Object} conversation - 对话记录对象
 * @returns {Object} 处理后的会话对象
 */
export function releaseConversationMemory(conversation) {
  if (!conversation || !conversation.messages) {
    return conversation;
  }

  return {
    ...conversation,
    messages: conversation.messages.map((msg) => ({ ...msg }))
  };
}

/**
 * 获取数据库存储统计信息
 * @returns {Promise<Object>} 包含数据库统计信息的对象
 */
export async function getDatabaseStats() {
  try {
    const encoder = new TextEncoder();
    const calcJsonBytes = (value) => {
      if (value === null || value === undefined) return 0;
      if (typeof value === 'string') return encoder.encode(value).length;
      try {
        return encoder.encode(JSON.stringify(value)).length;
      } catch (_) {
        return 0;
      }
    };
    const metaFieldSizes = {
      thoughtsRaw: 0,
      thoughtSignature: 0,
      thoughtSignatureSource: 0,
      reasoning_content: 0,
      response_activity_timeline: 0,
      response_input_items: 0,
      response_reasoning_summary: 0,
      preprocessOriginalText: 0,
      preprocessRenderedText: 0,
      threadSelectionText: 0,
      pageRuntimeContextSignature: 0,
      environmentContextSignature: 0,
      tool_calls: 0,
      response_tool_calls: 0,
      groundingMetadata: 0,
      promptMeta: 0,
      pageMeta: 0,
      contextual_input_items_before: 0
    };
    const addMetaSize = (key, bytes) => {
      const size = Number(bytes) || 0;
      if (!size) return;
      if (metaFieldSizes[key] === undefined) metaFieldSizes[key] = 0;
      metaFieldSizes[key] += size;
    };
    const calcMessageMetaBytes = (msg) => {
      if (!msg || typeof msg !== 'object') return 0;
      let size = 0;
      if (typeof msg.thoughtsRaw === 'string' && msg.thoughtsRaw) {
        const bytes = encoder.encode(msg.thoughtsRaw).length;
        size += bytes;
        addMetaSize('thoughtsRaw', bytes);
      }
      if (typeof msg.thoughtSignature === 'string' && msg.thoughtSignature) {
        const bytes = encoder.encode(msg.thoughtSignature).length;
        size += bytes;
        addMetaSize('thoughtSignature', bytes);
      }
      if (typeof msg.thoughtSignatureSource === 'string' && msg.thoughtSignatureSource) {
        const bytes = encoder.encode(msg.thoughtSignatureSource).length;
        size += bytes;
        addMetaSize('thoughtSignatureSource', bytes);
      }
      if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) {
        const bytes = encoder.encode(msg.reasoning_content).length;
        size += bytes;
        addMetaSize('reasoning_content', bytes);
      }
      if (msg.response_activity_timeline) {
        const bytes = calcJsonBytes(msg.response_activity_timeline);
        size += bytes;
        addMetaSize('response_activity_timeline', bytes);
      }
      if (msg.response_input_items) {
        const bytes = calcJsonBytes(msg.response_input_items);
        size += bytes;
        addMetaSize('response_input_items', bytes);
      }
      if (typeof msg.response_reasoning_summary === 'string' && msg.response_reasoning_summary) {
        const bytes = encoder.encode(msg.response_reasoning_summary).length;
        size += bytes;
        addMetaSize('response_reasoning_summary', bytes);
      }
      if (typeof msg.preprocessOriginalText === 'string' && msg.preprocessOriginalText) {
        const bytes = encoder.encode(msg.preprocessOriginalText).length;
        size += bytes;
        addMetaSize('preprocessOriginalText', bytes);
      }
      if (typeof msg.preprocessRenderedText === 'string' && msg.preprocessRenderedText) {
        const bytes = encoder.encode(msg.preprocessRenderedText).length;
        size += bytes;
        addMetaSize('preprocessRenderedText', bytes);
      }
      if (typeof msg.threadSelectionText === 'string' && msg.threadSelectionText) {
        const bytes = encoder.encode(msg.threadSelectionText).length;
        size += bytes;
        addMetaSize('threadSelectionText', bytes);
      }
      if (typeof msg.pageRuntimeContextSignature === 'string' && msg.pageRuntimeContextSignature) {
        const bytes = encoder.encode(msg.pageRuntimeContextSignature).length;
        size += bytes;
        addMetaSize('pageRuntimeContextSignature', bytes);
      }
      if (typeof msg.environmentContextSignature === 'string' && msg.environmentContextSignature) {
        const bytes = encoder.encode(msg.environmentContextSignature).length;
        size += bytes;
        addMetaSize('environmentContextSignature', bytes);
      }
      if (msg.tool_calls) {
        const bytes = calcJsonBytes(msg.tool_calls);
        size += bytes;
        addMetaSize('tool_calls', bytes);
      }
      if (msg.response_tool_calls) {
        const bytes = calcJsonBytes(msg.response_tool_calls);
        size += bytes;
        addMetaSize('response_tool_calls', bytes);
      }
      if (msg.groundingMetadata) {
        const bytes = calcJsonBytes(msg.groundingMetadata);
        size += bytes;
        addMetaSize('groundingMetadata', bytes);
      }
      if (msg.promptMeta) {
        const bytes = calcJsonBytes(msg.promptMeta);
        size += bytes;
        addMetaSize('promptMeta', bytes);
      }
      if (msg.pageMeta) {
        const bytes = calcJsonBytes(msg.pageMeta);
        size += bytes;
        addMetaSize('pageMeta', bytes);
      }
      if (msg.contextual_input_items_before) {
        const bytes = calcJsonBytes(msg.contextual_input_items_before);
        size += bytes;
        addMetaSize('contextual_input_items_before', bytes);
      }
      return size;
    };
    // 仅将 data:image base64 计入“图片数据”，其余 URL/路径按文本大小统计
    const isImageDataUrl = (value) => {
      if (typeof value !== 'string') return false;
      return value.trim().toLowerCase().startsWith('data:image/');
    };
    const estimateBase64SizeFromDataUrl = (dataUrl) => {
      if (typeof dataUrl !== 'string' || !dataUrl) return 0;
      const commaIndex = dataUrl.indexOf(',');
      const base64 = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
      return Math.round((base64.length * 3) / 4);
    };
    const measureImageUrlBytes = (imageUrl) => {
      if (!imageUrl || typeof imageUrl !== 'object') {
        return { textSize: 0, imageSize: 0, hasImage: false };
      }
      let textSize = 0;
      let imageSize = 0;
      let hasImage = false;
      const url = (typeof imageUrl.url === 'string') ? imageUrl.url : '';
      const path = (typeof imageUrl.path === 'string') ? imageUrl.path : '';
      if (url) {
        hasImage = true;
        if (isImageDataUrl(url)) {
          imageSize += estimateBase64SizeFromDataUrl(url);
        } else {
          textSize += encoder.encode(url).length;
        }
      }
      if (path && path !== url) {
        hasImage = true;
        if (isImageDataUrl(path)) {
          imageSize += estimateBase64SizeFromDataUrl(path);
        } else {
          textSize += encoder.encode(path).length;
        }
      }
      return { textSize, imageSize, hasImage };
    };
    
    // 获取所有会话与对话级文档。
    const db = await openChatHistoryDB();
    const conversations = await getAllConversations(false);
    const conversationDocuments = await new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(CONVERSATION_DOCUMENT_STORE, 'readonly');
        const store = transaction.objectStore(CONVERSATION_DOCUMENT_STORE);
        const request = store.getAll();
        request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
        request.onerror = () => reject(request.error);
      } catch (error) {
        reject(error);
      }
    });
    
    // 计算统计信息
    let totalMessages = 0;
    let totalImageMessages = 0;
    let totalTextSize = 0;
    let totalImageSize = 0;
    let totalMetaSize = 0;
    let totalDocumentCount = 0;
    let totalDocumentSize = 0;
    let largestMessage = 0;
    let oldestMessageDate = Date.now();
    let newestMessageDate = 0;
    let conversationCount = 0;
    const domainCounts = new Map();
    
    // 分析会话数据
    conversations.forEach(conv => {
      conversationCount++;
      // 统计域名
      if (conv.url) {
        try {
          const u = new URL(conv.url);
          const host = u.hostname || 'unknown';
          domainCounts.set(host, (domainCounts.get(host) || 0) + 1);
        } catch {}
      }
      if (conv.messages) {
        totalMessages += conv.messages.length;
        
        conv.messages.forEach(msg => {
          // 计算时间范围
          if (msg.timestamp) {
            oldestMessageDate = Math.min(oldestMessageDate, msg.timestamp);
            newestMessageDate = Math.max(newestMessageDate, msg.timestamp);
          }
          
          // 检查内容类型和大小
          let msgSize = 0;
          if (msg.content) {
            if (typeof msg.content === 'string') {
              const size = encoder.encode(msg.content).length;
              totalTextSize += size;
              msgSize += size;
            } else if (Array.isArray(msg.content)) {
              // 处理图片和文本混合内容
              msg.content.forEach(part => {
                if (part.type === 'text' && part.text) {
                  const textSize = encoder.encode(part.text).length;
                  msgSize += textSize;
                  totalTextSize += textSize;
                } else if (part.type === 'image_url' && part.image_url) {
                  const sizes = measureImageUrlBytes(part.image_url);
                  if (sizes.hasImage) totalImageMessages++;
                  if (sizes.textSize) {
                    msgSize += sizes.textSize;
                    totalTextSize += sizes.textSize;
                  }
                  if (sizes.imageSize) {
                    msgSize += sizes.imageSize;
                    totalImageSize += sizes.imageSize;
                  }
                }
              });
            }
          }
          const metaSize = calcMessageMetaBytes(msg);
          totalMetaSize += metaSize;
          largestMessage = Math.max(largestMessage, msgSize + metaSize);
        });
      }
    });

    totalDocumentCount = Array.isArray(conversationDocuments) ? conversationDocuments.length : 0;
    (Array.isArray(conversationDocuments) ? conversationDocuments : []).forEach((doc) => {
      const content = typeof doc?.content === 'string' ? doc.content : '';
      totalDocumentSize += encoder.encode(content).length;
    });
    
    // 生成域名 Top 10
    const topDomains = Array.from(domainCounts.entries())
      .sort((a,b)=>b[1]-a[1])
      .slice(0, 10)
      .map(([domain, count]) => ({ domain, count }));

    // 格式化大小为人类可读格式
    const formatSize = (bytes) => {
      if (bytes === 0) return '0 B';
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(1024));
      return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
    };

    const metaTopItems = Object.entries(metaFieldSizes)
      .filter(([, size]) => (Number(size) || 0) > 0)
      .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0))
      .slice(0, 5)
      .map(([key, size]) => ({
        key,
        size,
        sizeFormatted: formatSize(Number(size) || 0)
      }));
    
    // 计算时间跨度
    const timeSpanDays = (newestMessageDate - oldestMessageDate) / (1000 * 60 * 60 * 24);
    
    const conversationsCount = conversations.length;
    const avgMessagesPerConversation = conversationsCount > 0 ? (totalMessages / conversationsCount) : 0;
    const avgTextBytesPerMessage = totalMessages > 0 ? (totalTextSize / totalMessages) : 0;
    const avgDocumentsPerConversation = conversationsCount > 0 ? (totalDocumentCount / conversationsCount) : 0;
    const avgDocumentBytes = totalDocumentCount > 0 ? (totalDocumentSize / totalDocumentCount) : 0;

    return {
      conversationsCount,
      messagesCount: totalMessages,
      imageMessagesCount: totalImageMessages,
      totalTextSize: totalTextSize,
      totalTextSizeFormatted: formatSize(totalTextSize),
      totalImageSize: totalImageSize,
      totalImageSizeFormatted: formatSize(totalImageSize),
      totalMetaSize,
      totalMetaSizeFormatted: formatSize(totalMetaSize),
      documentsCount: totalDocumentCount,
      totalDocumentSize,
      totalDocumentSizeFormatted: formatSize(totalDocumentSize),
      totalSize: totalTextSize + totalImageSize + totalMetaSize + totalDocumentSize,
      totalSizeFormatted: formatSize(totalTextSize + totalImageSize + totalMetaSize + totalDocumentSize),
      largestMessageSize: largestMessage,
      largestMessageSizeFormatted: formatSize(largestMessage),
      oldestMessageDate: oldestMessageDate !== Date.now() ? new Date(oldestMessageDate) : null,
      newestMessageDate: newestMessageDate !== 0 ? new Date(newestMessageDate) : null,
      timeSpanDays: timeSpanDays > 0 ? Math.round(timeSpanDays) : 0,
      avgMessagesPerConversation,
      avgDocumentsPerConversation,
      avgDocumentBytes,
      avgDocumentBytesFormatted: formatSize(Math.round(avgDocumentBytes)),
      avgTextBytesPerMessage,
      avgTextBytesPerMessageFormatted: formatSize(Math.round(avgTextBytesPerMessage)),
      topDomains,
      metaFieldSizes,
      metaTopItems
    };
  } catch (error) {
    console.error('获取数据库统计信息失败:', error);
    return {
      error: error.message,
      conversationsCount: 0,
      messagesCount: 0,
      totalSizeFormatted: '0 B'
    };
  }
} 
