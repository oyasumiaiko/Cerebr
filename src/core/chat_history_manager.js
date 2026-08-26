/**
 * @file Manages a tree-structured chat history, including creating messages,
 *       finding nodes, and retrieving conversation chains.
 * @since 1.0.0
 */

import { normalizeResponsesPromptCacheKey } from '../utils/responses_prompt_cache.js';

/**
 * 用于表示单条消息的类型
 * @typedef {Object} MessageNode
 * @property {string} id - 唯一的消息ID
 * @property {string} role - 消息角色 (e.g. 'user', 'ai', 'system')
 * @property {string} content - 消息内容
 * @property {string|null} parentId - 父节点ID
 * @property {Array<string>} children - 子节点ID列表
 * @property {number} timestamp - 消息时间戳
 * @property {string} [thoughtsRaw] - AI思考过程的原始文本 (可选)
 * @property {string|null} [thoughtSignature] - 推理签名（Thought Signature / thoughtSignature，可选）
 * @property {string|null} [thoughtSignatureSource] - 签名来源（'gemini' | 'openai'，可选），用于避免跨 API 误回传导致上游报错
 * @property {string|null} [reasoning_content] - OpenAI 兼容：需要原样回传的推理原文（与 thoughtSignature 配对，可选）
 * @property {Array<any>|null} [tool_calls] - OpenAI 兼容：assistant.tool_calls（可能包含 thoughtSignature，可选）
 * @property {string|null} [phase] - Responses API assistant message phase（如 commentary，可选）
 * @property {Array<any>|null} [response_activity_timeline] - Responses API：按顺序记录 commentary / reasoning summary / 工具调用的活动时间线（可选）
 * @property {number|null} [response_activity_duration_ms] - Responses API：思考/工具活动总耗时（毫秒，可选，仅在完成后写入）
 * @property {Array<any>|null} [response_input_items] - Responses API：后续 turn 可直接重放进 input 的历史 item（可选）
 * @property {string|null} [response_reasoning_summary] - Responses API：reasoning summary 文本（仅用于展示/存档，可选）
 * @property {Array<any>|null} [response_tool_calls] - Responses API：output item 级工具调用记录（如 web_search_call，可选）
 * @property {string|null} [apiUuid] - 使用的 API 配置 UUID（配置的 id），用于回溯显示 (可选)
 * @property {string} [apiDisplayName] - 创建消息时记录的 API 显示名称快照 (可选)
 * @property {string} [apiModelId] - 创建消息时记录的模型名（modelName）快照 (可选)
 * @property {{promptTokens:number|null,completionTokens:number|null,totalTokens:number|null,cachedInputTokens?:number|null,reasoningTokens?:number|null}|null} [apiUsage] - API 返回的 token 用量元数据（可选）
 * @property {{startedAtMs:number|null,firstVisibleOutputAtMs:number|null,completedAtMs:number|null,generationDurationMs:number|null,thinkingDurationMs:number|null,outputDurationMs:number|null}|null} [responseTiming] - AI 响应时序元数据（可选）
 * @property {boolean} [hasInlineImages] - 是否包含内联图片 (可选)
 * @property {string|null} [promptType] - 发送时记录的“指令/提示词类型”（如 summary/selection/query 等，可选）
 * @property {Object|null} [promptMeta] - 与 promptType 配套的元信息（例如 { selectionText }，可选）
 * @property {string|null} [preprocessOriginalText] - 用户消息预处理前的原始文本（可选）
 * @property {string|null} [preprocessRenderedText] - 预处理后的文本快照（可选）
 * @property {{url: string, title: string}|null} [pageMeta] - 首条用户消息发出时的页面元数据快照（仅 url/title，用于固定会话来源）
 * @property {string|Array<any>|null} [outboundContent] - 发送给模型时使用的稳定正文快照（例如已拼接页面内容的用户消息，可选）
 * @property {Array<any>|null} [contextual_input_items_before] - 仅供模型可见、位于该消息前面的隐藏 contextual input items（不参与 UI 渲染，可选）
 * @property {string|null} [pageRuntimeContextSignature] - 页面运行环境隐藏上下文的稳定签名；为空表示沿用更早一次已生效的上下文（可选）
 * @property {string|null} [environmentContextSignature] - 通用 environment_context 的稳定签名；为空表示沿用更早一次已生效的上下文（可选）
 * @property {{entries:Array<{type:string,status:string,reason?:string,itemCount?:number}>,updatedAt:number|null}|null} [contextualInputDebug] - 隐藏上下文注入调试信息，仅供 UI 观察，不发送给模型（可选）
 * @property {{source:string,sourceAssistantMessageId:string|null,promptTokensBefore:number|null,compactedAt:number|null}|null} [contextCompactionMarker] - 本地 Responses compact marker（可选）
 * @property {{state:string,phase:string,attempt:number|null,totalAttempts:number|null,requestBytes:number|null,inputCount:number|null,toolCount:number|null,responseStatus:number|null,responseBytes:number|null,outputCount:number|null,errorMessage:string|null,updatedAt:number|null}|null} [responsesLocalCompactionStatus] - Responses compact v2 UI 状态元信息，仅用于消息流展示与诊断（可选）
 */

/**
 * 聊天历史记录的数据结构
 * @typedef {Object} ChatHistory
 * @property {Array<MessageNode>} messages - 所有消息节点列表
 * @property {string|null} root - 根节点ID
 * @property {string|null} currentNode - 当前节点ID
 * @property {number} conversationRevision - 线性会话的“历史修改版本号”
 * @property {string} promptCacheKey - 当前会话绑定的 Responses prompt_cache_key
 */

/**
 * 创建一个新的 MessageNode 对象
 * @param {string} role - 消息角色 (e.g. 'user', 'ai')
 * @param {string} content - 消息文本内容
 * @param {string|null} [parentId=null] - 父节点ID
 * @returns {MessageNode} - 新的消息节点
 * @example
 * const node = createMessageNode('user', 'Hello world');
 * console.log(node);
 */
function createMessageNode(role, content, parentId = null) {
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    role,
    content,
    parentId,
    children: [],
    timestamp: Date.now(),
    thoughtsRaw: null, // 初始化思考过程文本
    // 用于“推理签名”（Gemini/OpenAI 兼容），帮助上游在多轮对话中恢复内部推理上下文
    thoughtSignature: null,
    // 记录该签名来自哪个 API 体系：避免把 Gemini 的签名发给 OpenAI 兼容接口（反之亦然）
    thoughtSignatureSource: null,
    // OpenAI 兼容：需要原样回传的 reasoning_content（与 thoughtSignature 配对）
    reasoning_content: null,
    // OpenAI 兼容：assistant.tool_calls（可能包含 tool_calls[i].thoughtSignature）
    tool_calls: null,
    // Responses API：保存 assistant phase 以及按事件顺序记录 commentary / reasoning summary / 工具调用活动
    phase: null,
    response_activity_timeline: null,
    response_activity_duration_ms: null,
    response_input_items: null,
    // --- API 元信息（用于消息 footer 显示与持久化）---
    apiUuid: null,
    apiDisplayName: '',
    apiModelId: '',
    apiUsage: null,
    responseTiming: null,
    hasInlineImages: false,
    // --- 指令元信息（用于“对话标题/摘要”等需要知道指令类型的场景）---
    // 设计说明：
    // - 过去通过“字符串/正则”去猜测 prompt 类型，容易被用户自定义提示词破坏（例如模板以 <SELECTION> 开头时前缀为空）。
    // - 这里在发送时把类型与关键变量显式落在消息节点上，后续任何功能（标题、统计、过滤等）都可直接读取，避免重复解析。
    promptType: null,
    promptMeta: null,
    preprocessOriginalText: null,
    preprocessRenderedText: null,
    // 当“实际发送给模型的正文”与界面展示内容不同（例如拼接了页面内容）时，
    // 这里保存那份稳定的发送快照，供后续多轮重放时精确复现。
    outboundContent: null,
    // 独立隐藏上下文通道：
    // - 不污染用户正文；
    // - 仅在 Responses input 组装时插在该条用户消息之前；
    // - 典型场景：页面运行环境 / frame 快照等工具辅助上下文。
    contextual_input_items_before: null,
    // 稳定签名用于“只有发生变化时才再写一条隐藏上下文”，避免每轮重复注入相同环境。
    pageRuntimeContextSignature: null,
    environmentContextSignature: null,
    // 调试隐藏上下文是否注入/沿用。该字段只用于 UI 和历史复盘，不参与模型请求组装。
    contextualInputDebug: null,
    // 本地 Responses compact 成功后会插入一条可见 marker；
    // 该字段用于让 composeMessages 只截取“最新 marker 及其之后”的模型可见历史。
    contextCompactionMarker: null,
    // compact v2 的“构建载荷 / 已发送 / 成功 / 失败”状态展示元信息。
    // 注意：pending / error 这类仅用于 UI 的节点不会重新发给模型，composeMessages 会显式跳过。
    responsesLocalCompactionStatus: null,
    // --- 页面元信息（用于固定“会话来源页”，避免生成过程中切换标签页导致 URL/标题错绑）---
    // 说明：
    // - 仅在“首条用户消息”创建时写入；后续消息不重复写，避免冗余。
    // - 只保存 url/title，不保存 pageInfo.content 等大字段，防止 IndexedDB 膨胀。
    pageMeta: null
  };
}

/**
 * 在聊天历史中查找节点
 * @param {ChatHistory} chatHistory - 聊天历史对象
 * @param {string} nodeId - 待查找的节点ID
 * @returns {MessageNode|undefined} - 找到的节点或undefined
 */
function findMessageNode(chatHistory, nodeId) {
  return chatHistory.messages.find(msg => msg.id === nodeId);
}

/**
 * 将新消息添加到聊天历史中
 * @param {ChatHistory} chatHistory - 聊天历史对象
 * @param {string} role - 消息角色
 * @param {string} content - 消息内容
 * @param {string|null} [parentId=null] - 父节点ID
 * @returns {MessageNode} - 新添加的消息节点
 * @example
 * const node = addMessageToTree(chatHistory, 'user', 'Hello');
 */
function addMessageToTree(chatHistory, role, content, parentId = null) {
  const node = createMessageNode(role, content, parentId);
  chatHistory.messages.push(node);

  if (parentId) {
    const parentNode = findMessageNode(chatHistory, parentId);
    if (parentNode) {
      parentNode.children.push(node.id);
    }
  }

  if (!chatHistory.root) {
    chatHistory.root = node.id;
  }

  chatHistory.currentNode = node.id;
  return node;
}

/**
 * 新增：在聊天历史中添加消息节点，并允许控制是否更新 currentNode。
 *
 * 设计用途：
 * - 划词线程等“分支消息”需要挂到指定 parentId，但不希望影响主对话的 currentNode；
 * - 通过 preserveCurrentNode 保持主链指针不变，避免影响后续正常对话。
 *
 * @param {ChatHistory} chatHistory
 * @param {string} role
 * @param {any} content
 * @param {string|null} [parentId=null]
 * @param {{preserveCurrentNode?: boolean}} [options]
 * @returns {MessageNode}
 */
function addMessageToTreeWithOptions(chatHistory, role, content, parentId = null, options = {}) {
  const node = createMessageNode(role, content, parentId);
  chatHistory.messages.push(node);

  if (parentId) {
    const parentNode = findMessageNode(chatHistory, parentId);
    if (parentNode) {
      parentNode.children.push(node.id);
    }
  }

  if (!chatHistory.root) {
    chatHistory.root = node.id;
  }

  if (!options?.preserveCurrentNode) {
    chatHistory.currentNode = node.id;
  }

  return node;
}

/**
 * 获取当前对话的完整消息链（从根节点到当前节点）
 * @param {ChatHistory} chatHistory - 聊天历史对象
 * @returns {Array<MessageNode>} - 从最早到最新的消息节点数组
 * @example
 * const chain = getCurrentConversationChain(chatHistory);
 * console.log(chain);
 */
function getCurrentConversationChain(chatHistory) {
  const chain = [];
  let currentId = chatHistory.currentNode;

  while (currentId) {
    const node = findMessageNode(chatHistory, currentId);
    if (!node) break;
    chain.unshift(node);
    currentId = node.parentId;
  }

  return chain;
}

/**
 * 清空聊天历史记录
 * @param {ChatHistory} chatHistory - 聊天历史对象
 * @example
 * clearChatHistory(chatHistory);
 */
function clearChatHistory(chatHistory) {
  chatHistory.messages = [];
  chatHistory.root = null;
  chatHistory.currentNode = null;
  chatHistory.conversationRevision = 0;
  chatHistory.promptCacheKey = '';
}

function normalizeConversationRevision(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.floor(numeric);
}

/**
 * 新增：删除指定消息节点，并维护消息的继承关系
 * 如果删除的消息存在父节点，则：
 *   - 从父节点的 children 数组中移除该消息的 id
 *   - 将删除消息的子节点重新分派到该父节点（即更新子节点的 parentId 为父节点 id，并添加到父节点的 children 列表中）
 * 如果删除的消息为根节点，则：
 *   - 若只有一个子节点，将其设为新根；若有多个子节点，则将所有子节点的 parentId 设为 null，并选第一个作为新根
 * 同时，如果当前节点是被删除的消息，则更新为父节点或 null。
 * @param {ChatHistory} chatHistory - 聊天历史对象
 * @param {string} messageId - 待删除消息的ID
 * @returns {boolean} - 删除成功返回 true，否则返回 false
 */
function deleteMessageFromHistory(chatHistory, messageId) {
  const index = chatHistory.messages.findIndex(msg => msg.id === messageId);
  if (index === -1) return false;
  const message = chatHistory.messages[index];

  if (message.parentId) {
    const parent = chatHistory.messages.find(msg => msg.id === message.parentId);
    if (parent) {
      parent.children = parent.children.filter(childId => childId !== messageId);
      // 将删除节点的所有子节点重新分派给其父节点
      message.children.forEach(childId => {
        const child = chatHistory.messages.find(msg => msg.id === childId);
        if (child) {
          child.parentId = parent.id;
          parent.children.push(child.id);
        }
      });
    }
  } else {
    // 如果删除的是根节点
    if (message.children.length > 0) {
      if (message.children.length === 1) {
        const newRoot = chatHistory.messages.find(msg => msg.id === message.children[0]);
        chatHistory.root = newRoot ? newRoot.id : null;
        if (newRoot) newRoot.parentId = null;
      } else {
        const firstChild = chatHistory.messages.find(msg => msg.id === message.children[0]);
        chatHistory.root = firstChild ? firstChild.id : null;
        message.children.forEach(childId => {
          const child = chatHistory.messages.find(msg => msg.id === childId);
          if (child) {
            child.parentId = null;
          }
        });
      }
    } else {
      chatHistory.root = null;
    }
  }

  if (chatHistory.currentNode === messageId) {
    chatHistory.currentNode = message.parentId || null;
  }
  chatHistory.messages.splice(index, 1);
  return true;
}

/**
 * 新增：在指定消息之后插入一条新消息，并尽量保持“当前对话链/界面顺序”一致。
 *
 * 设计目标：
 * - 允许在任意消息下方插入一条空白 user/assistant 消息（用于补位/手工编辑/后续重生成等）；
 * - 插入后不应该打乱其他消息：
 *   - 父子关系：默认让新节点成为 afterMessageId 的子节点；
 *   - 若提供 nextMessageId（UI 中 afterMessageId 的下一条消息），则把 nextMessageId 迁移为新节点的子节点，形成：A -> 新节点 -> B；
 * - 重要：messages 数组的顺序决定了会话回放时的渲染顺序（chat_history_ui 会按 messages 顺序逐条 append），
 *   因此这里必须把新节点插入到数组的“正确位置”（通常是 afterMessageId 之后、nextMessageId 之前），
 *   否则保存/重载会导致插入消息跑到末尾。
 *
 * 说明：
 * - 这是对“线性链”场景的优化；若遇到分支（after 节点有多个 children），只有命中的 nextMessageId 会被迁移，其他分支保持不变。
 *
 * @param {ChatHistory} chatHistory
 * @param {string} afterMessageId - 要插入到哪条消息之后
 * @param {string} role - 'user' | 'assistant' | 'system'
 * @param {any} content - 新消息内容（允许 string 或多模态数组）
 * @param {{ nextMessageId?: string|null }} [options]
 * @returns {MessageNode|null} 新插入的节点；失败返回 null
 */
function insertMessageAfterInHistory(chatHistory, afterMessageId, role, content, options = {}) {
  if (!chatHistory || !afterMessageId) return null;
  const afterNode = findMessageNode(chatHistory, afterMessageId);
  if (!afterNode) return null;

  const safeNextId = (typeof options?.nextMessageId === 'string' && options.nextMessageId.trim())
    ? options.nextMessageId.trim()
    : null;

  // 1) 创建新节点（parentId 指向 afterMessageId）
  const newNode = createMessageNode(role, content, afterMessageId);

  // 2) 计算插入到 messages 数组中的位置：
  //    - 默认插在 afterMessageId 之后；
  //    - 若提供 nextMessageId 且其在数组中位于 after 之后，则插到 next 之前（保持 UI 顺序）。
  const afterIndex = chatHistory.messages.findIndex(msg => msg.id === afterMessageId);
  let insertIndex = (afterIndex >= 0) ? (afterIndex + 1) : chatHistory.messages.length;
  if (safeNextId) {
    const nextIndex = chatHistory.messages.findIndex(msg => msg.id === safeNextId);
    if (nextIndex !== -1 && afterIndex !== -1 && nextIndex > afterIndex) {
      insertIndex = nextIndex;
    }
  }
  chatHistory.messages.splice(insertIndex, 0, newNode);

  // 3) 维护 children/parentId 关系：若 nextMessageId 命中，则把它“挪到新节点下面”
  if (safeNextId) {
    const nextNode = findMessageNode(chatHistory, safeNextId);
    const canRewire = !!(nextNode && nextNode.parentId === afterMessageId);
    if (canRewire) {
      // 用新节点替换 afterNode.children 中的 next（若未找到则追加）
      const idx = Array.isArray(afterNode.children) ? afterNode.children.indexOf(safeNextId) : -1;
      if (idx >= 0) {
        afterNode.children.splice(idx, 1, newNode.id);
      } else {
        afterNode.children.push(newNode.id);
      }
      // nextNode 变为 newNode 的子节点
      newNode.children = [safeNextId];
      nextNode.parentId = newNode.id;
    } else {
      // 无法确认 next 是 after 的直系子节点：保守策略，不强行改写 next 的 parentId，仅把新节点作为 after 的新增 child。
      afterNode.children.push(newNode.id);
    }
  } else {
    // 没有 next：直接挂到 after 的 children 上
    afterNode.children.push(newNode.id);
  }

  // 4) currentNode 更新策略：
  // - 仅当插入点就是当前末尾（afterMessageId === currentNode 且没有 next）时，把 currentNode 推进到新节点；
  // - 其它情况保持不变，避免把“正在聊天的末尾指针”跳到中间。
  if (!safeNextId && chatHistory.currentNode === afterMessageId) {
    chatHistory.currentNode = newNode.id;
  }

  return newNode;
}

export function deleteMessageFromChatHistory(chatHistory, messageId) {
  return deleteMessageFromHistory(chatHistory, messageId);
}

export function insertMessageAfterInChatHistory(chatHistory, afterMessageId, role, content, options = {}) {
  return insertMessageAfterInHistory(chatHistory, afterMessageId, role, content, options);
}

/**
 * 创建一个新的 ChatHistory 对象以及相关操作函数
 * @returns {{
 *   chatHistory: ChatHistory,
 *   addMessageToTree: (role: string, content: string, parentId?: string|null) => MessageNode,
 *   getCurrentConversationChain: () => Array<MessageNode>,
 *   clearHistory: () => void,
 *   deleteMessage: (messageId: string) => boolean,
 *   getConversationRevision: () => number,
 *   setConversationRevision: (revision: number) => number,
 *   bumpConversationRevision: () => number
 * }} - 工厂函数返回一组管理函数
 * @example
 * const { chatHistory, addMessageToTree, getCurrentConversationChain } = createChatHistoryManager();
 * addMessageToTree('user', 'Hello');
 */
export function createChatHistoryManager() {
  const chatHistory = {
    messages: [],
    root: null,
    currentNode: null,
    conversationRevision: 0,
    promptCacheKey: ''
  };

  return {
    chatHistory,
    addMessageToTree: (role, content, parentId = null) => addMessageToTree(chatHistory, role, content, parentId),
    addMessageToTreeWithOptions: (role, content, parentId = null, options = {}) =>
      addMessageToTreeWithOptions(chatHistory, role, content, parentId, options),
    getCurrentConversationChain: () => getCurrentConversationChain(chatHistory),
    clearHistory: () => clearChatHistory(chatHistory),
    deleteMessage: (messageId) => deleteMessageFromHistory(chatHistory, messageId),
    insertMessageAfter: (afterMessageId, role, content, options = {}) =>
      insertMessageAfterInHistory(chatHistory, afterMessageId, role, content, options),
    getConversationRevision: () => normalizeConversationRevision(chatHistory.conversationRevision),
    getConversationPromptCacheKey: () => normalizeResponsesPromptCacheKey(chatHistory.promptCacheKey),
    setConversationPromptCacheKey: (value) => {
      const nextKey = normalizeResponsesPromptCacheKey(value);
      chatHistory.promptCacheKey = nextKey;
      return nextKey;
    },
    clearConversationPromptCacheKey: () => {
      chatHistory.promptCacheKey = '';
      return '';
    },
    setConversationRevision: (revision) => {
      const nextRevision = normalizeConversationRevision(revision);
      chatHistory.conversationRevision = nextRevision;
      return nextRevision;
    },
    bumpConversationRevision: () => {
      const nextRevision = normalizeConversationRevision(chatHistory.conversationRevision) + 1;
      chatHistory.conversationRevision = nextRevision;
      return nextRevision;
    }
  };
} 
