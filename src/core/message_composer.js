/**
 * 消息构造模块（纯函数）
 * 将提示词、会话历史、网页内容等输入组合为标准的 messages 数组，
 * 不依赖 DOM、不触发副作用，便于测试与复用。
 * @since 1.2.0
 */

/**
 * @typedef {Object} ConversationNode
 * @property {string} id 唯一ID
 * @property {('user'|'assistant'|'system')} role 角色
 * @property {string} content 文本内容
 * @property {string|null} [thoughtSignature] 推理签名（Thought Signature / thoughtSignature，可选）
 * @property {string|null} [thoughtSignatureSource] 签名来源（'gemini' | 'openai'，可选）
 * @property {string|null} [reasoning_content] OpenAI 兼容：需要原样回传的推理原文（与 thoughtSignature 配对，可选）
 * @property {Array<any>|null} [tool_calls] OpenAI 兼容：assistant.tool_calls（可能包含 thoughtSignature，可选）
 * @property {Array<any>|null} [response_input_items] Responses API：后续 turn 可直接重放的 input item 历史（可选）
 * @property {string|Array<any>|null} [outboundContent] 当历史节点曾以“不同于显示内容”的正文发送时，这里保存稳定发送快照（可选）
 * @property {Array<any>|null} [contextual_input_items_before] 仅供模型可见、位于该消息前面的隐藏 contextual input items（可选）
 * @property {string|null} [pageRuntimeContextSignature] 页面运行环境隐藏上下文的稳定签名（可选）
 * @property {string|null} [environmentContextSignature] 通用 environment_context 的稳定签名（可选）
 */

/**
 * @typedef {Object} PromptsConfigItem
 * @property {string} prompt 提示词文本
 * @property {string} model 偏好模型或 'follow_current'
 */

/**
 * @typedef {Object<string, PromptsConfigItem>} PromptsConfig
 */

/**
 * @typedef {Object} ComposeMessagesArgs
 * @property {PromptsConfig} prompts 提示词配置对象
 * @property {Array<string>} injectedSystemMessages 额外注入的系统消息
 * @property {{title: string, url: string, content: string}|null} pageContent 网页内容（可空）
 * @property {boolean} imageContainsScreenshot 是否包含截图
 * @property {boolean|undefined} [omitDefaultSystemPrompt] 是否跳过“提示词设置”中的默认系统提示词
 * @property {string|null} currentPromptType 当前提示词类型
 * @property {boolean} regenerateMode 是否为重新生成模式
 * @property {string|null} messageId 重新生成目标消息ID
 * @property {ConversationNode[]} conversationChain 当前会话链（按时间顺序）
 * @property {boolean} sendChatHistory 是否发送历史（已根据业务规则计算好）
 * @property {number} maxHistory 最大发送的历史条目数（旧字段：按总条目计数）
 * @property {number|null|undefined} [maxUserHistory] 新字段：最大发送的历史 user 消息条数（0 表示仅发送当前用户消息）
 * @property {number|null|undefined} [maxAssistantHistory] 新字段：最大发送的历史 assistant 消息条数
 */

/**
 * 构造标准的 messages 数组
 * @param {ComposeMessagesArgs} args 参数
 * @returns {Array<{role: string, content: string}>} messages
 * @example
 * const messages = composeMessages({
 *   prompts,
 *   injectedSystemMessages: [],
 *   pageContent: { title, url, content },
 *   imageContainsScreenshot: false,
 *   omitDefaultSystemPrompt: false,
 *   currentPromptType: 'summary',
 *   regenerateMode: false,
 *   messageId: null,
 *   conversationChain,
 *   sendChatHistory: true,
 *   maxHistory: 16,
 *   maxUserHistory: 16,
 *   maxAssistantHistory: 16
 * });
 */
import { extractThinkingFromText } from '../utils/thoughts_parser.js';

export function composeMessages(args) {
  const {
    prompts,
    injectedSystemMessages,
    pageContent,
    imageContainsScreenshot,
    omitDefaultSystemPrompt,
    currentPromptType,
    regenerateMode,
    messageId,
    conversationChain,
    sendChatHistory,
    maxHistory,
    maxUserHistory,
    maxAssistantHistory
  } = args;

  const messages = [];

  // 纯函数：将历史节点转换为可发送的 message 对象（保留必要的签名/推理字段）
  // 说明：
  // - content 会剔除 <think> 段落，避免隐式思考内容被重新发送；
  // - OpenAI 兼容的 reasoning_content 必须“原样回传”，因此这里直接使用节点上保存的 reasoning_content；
  // - thoughtSignatureSource 用于让下游 buildRequest 决定：哪些签名该发给 Gemini，哪些该发给 OpenAI 兼容接口。
  const nodeToMessage = (node) => {
    const role = mapRole(node?.role);
    const thoughtSignature = node?.thoughtSignature || null;
    const thoughtSignatureSource = node?.thoughtSignatureSource || null;
    const hasThoughtSignature = (typeof thoughtSignature === 'string') && !!thoughtSignature;
    const apiModelId = (typeof node?.apiModelId === 'string' && node.apiModelId.trim()) ? node.apiModelId.trim() : null;

    const messageContent = (role === 'user' && node?.outboundContent != null)
      ? node.outboundContent
      : node?.content;

    const msg = {
      role,
      content: sanitizeContentForSend(messageContent),
      thoughtSignature,
      thoughtSignatureSource,
      // 记录该条历史消息生成时的模型ID快照，供下游决定是否可回传 signature（避免跨模型导致校验失败）。
      apiModelId
    };

    if (role === 'assistant' && thoughtSignatureSource === 'openai') {
      // OpenAI 兼容：reasoning_content 必须与 message-level thoughtSignature 成对出现，否则上游可能校验失败。
      // tool_calls 的签名位于 tool_calls[i].thoughtSignature，可独立于 message-level thoughtSignature 存在。
      if (hasThoughtSignature && typeof node?.reasoning_content === 'string') {
        msg.reasoning_content = node.reasoning_content;
      }
      if (Array.isArray(node?.tool_calls) && node.tool_calls.length > 0) {
        msg.tool_calls = node.tool_calls;
      }
    }

    if (Array.isArray(node?.response_input_items) && node.response_input_items.length > 0) {
      // Responses API：这里不做结构改写，只把“可再次放进 input 的 item”挂到消息对象上，
      // 交给下游 buildRequest 在 Responses 模式下直接展开。
      msg.response_input_items = node.response_input_items;
    }

    if (Array.isArray(node?.contextual_input_items_before) && node.contextual_input_items_before.length > 0) {
      // 与 `response_input_items` 不同，这些 item 不是“assistant 历史重放”，
      // 而是放在该条消息之前的隐藏上下文（例如页面运行环境）。
      msg.contextual_input_items_before = node.contextual_input_items_before;
    }

    if (typeof node?.pageRuntimeContextSignature === 'string' && node.pageRuntimeContextSignature) {
      msg.pageRuntimeContextSignature = node.pageRuntimeContextSignature;
    }
    if (typeof node?.environmentContextSignature === 'string' && node.environmentContextSignature) {
      msg.environmentContextSignature = node.environmentContextSignature;
    }

    return msg;
  };

  // 1) 系统消息：系统提示词 + 注入系统消息 + 截图提示
  //
  // 说明：
  // - 网页内容不再默认混进 system / user 消息；
  // - 若模型需要快速阅读抽取后的页面正文，应显式调用 `page_content_read` 工具；
  // - 这样可以把“行为要求/提示词”和“按需读取的页面事实”分离，避免页面正文每轮都默认挤占上下文。
  let systemMessageContent = (omitDefaultSystemPrompt === true) ? '' : (prompts.system?.prompt || '');
  if (imageContainsScreenshot) {
    systemMessageContent += "\n用户附加了当前页面的屏幕截图";
  }
  if (Array.isArray(injectedSystemMessages) && injectedSystemMessages.length > 0) {
    systemMessageContent += "\n" + injectedSystemMessages.join('\n');
  }

  const hasSystemMessage = typeof systemMessageContent === 'string' && systemMessageContent.trim() !== '';
  if (hasSystemMessage) {
    // 如果系统提示为空则不推送 system 消息，避免在请求载荷中出现空占位
    messages.push({ role: 'system', content: systemMessageContent });
  }

  // 2) 历史消息选择
  const chain = Array.isArray(conversationChain) ? conversationChain.slice() : [];

  // 重新生成模式：裁剪到目标消息
  let effectiveChain = chain;
  if (regenerateMode && messageId) {
    const targetIndex = chain.findIndex(msg => msg.id === messageId);
    if (targetIndex !== -1) {
      effectiveChain = chain.slice(0, targetIndex + 1);
    }
  }

  if (sendChatHistory) {
    const normalizedMaxUserHistory = normalizeOptionalNonNegativeInt(maxUserHistory);
    const normalizedMaxAssistantHistory = normalizeOptionalNonNegativeInt(maxAssistantHistory);
    const useRoleBasedLimits = (normalizedMaxUserHistory !== null) || (normalizedMaxAssistantHistory !== null);

    if (useRoleBasedLimits) {
      const limited = selectConversationNodesByRole(effectiveChain, {
        maxUserMessages: normalizedMaxUserHistory,
        maxAssistantMessages: normalizedMaxAssistantHistory
      });
      messages.push(...limited.map(nodeToMessage));
    } else {
      // 旧逻辑：单一 maxHistory，按总条目数裁剪
      // 当 maxHistory 为 0 时，不发送任何历史消息
      if (maxHistory === 0) {
        // 不添加任何历史消息
      } else if (maxHistory && maxHistory > 0) {
        // 限制历史消息数量
        const limited = effectiveChain.slice(-maxHistory);
        messages.push(...limited.map(nodeToMessage));
      } else {
        // 发送全部历史消息
        messages.push(...effectiveChain.map(nodeToMessage));
      }
    }
  } else {
    // 只发送最后一条
    if (effectiveChain.length > 0) {
      const last = effectiveChain[effectiveChain.length - 1];
      const lastContent = (mapRole(last.role) === 'user' && last?.outboundContent != null)
        ? last.outboundContent
        : last.content;
      messages.push({ role: mapRole(last.role), content: sanitizeContentForSend(lastContent) });
    }
  }

  // 3) 旧逻辑兜底：当 maxHistory 为 0 时，确保至少包含“当前用户消息”
  // 说明：新逻辑（按角色裁剪）在 selectConversationNodesByRole 内已保证最后一条 user 会被包含。
  if (maxHistory === 0 && effectiveChain.length > 0) {
    const hasAnyUser = messages.some(m => m && m.role === 'user');
    if (!hasAnyUser) {
      // 查找最后一条用户消息
      for (let i = effectiveChain.length - 1; i >= 0; i--) {
        const message = effectiveChain[i];
        if (message.role === 'user') {
          messages.push(nodeToMessage(message));
          break; // 只添加最后一条用户消息
        }
      }
    }
  }

  return applyUserMessageSpacing(messages);
}

/**
 * 纯函数：将输入规范化为“非负整数”，用于 slider/配置读取。
 * @param {any} value
 * @returns {number|null} - 返回整数；若值不可用则返回 null（表示“未设置/沿用旧逻辑”）
 */
function normalizeOptionalNonNegativeInt(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.floor(n));
}

/**
 * 纯函数：按“角色分别计数”裁剪会话链。
 *
 * 需求背景（超长对话）：
 * - 用户消息往往更短且包含指令/约束；AI 消息常更长，最容易把上下文窗口撑爆；
 * - 因此允许用户分别设置：
 *   - 最多发送多少条历史 user 消息；
 *   - 最多发送多少条历史 assistant 消息；
 * - 计数方式：从最新消息开始向上回溯，分别累计 user/assistant 的条数；两者取并集后按原顺序发送。
 *
 * 关键约束：
 * - 即使 maxUserMessages 为 0，也必须保证“当前用户消息”会被包含，否则模型无法响应；
 * - system 消息不计入上限：若落在裁剪窗口内会保留（通常很少，用于维持指令上下文）。
 *
 * @param {Array<any>} chain - 已裁剪（如 regenerateMode）后的会话链（按时间顺序）
 * @param {{maxUserMessages: number|null, maxAssistantMessages: number|null}} limits
 * @returns {Array<any>} - 选中的节点（按时间顺序）
 */
function selectConversationNodesByRole(chain, limits) {
  const safeChain = Array.isArray(chain) ? chain : [];
  const maxUserMessages = limits ? limits.maxUserMessages : null;
  const maxAssistantMessages = limits ? limits.maxAssistantMessages : null;

  const userLimit = Number.isFinite(maxUserMessages) ? Math.max(0, maxUserMessages) : Infinity;
  const assistantLimit = Number.isFinite(maxAssistantMessages) ? Math.max(0, maxAssistantMessages) : Infinity;

  let userCount = 0;
  let assistantCount = 0;
  const selectedIndices = new Set();

  for (let i = safeChain.length - 1; i >= 0; i--) {
    const node = safeChain[i];
    const role = mapRole(node?.role);
    if (role === 'user') {
      if (userCount < userLimit) {
        selectedIndices.add(i);
        userCount++;
      }
    } else if (role === 'assistant') {
      if (assistantCount < assistantLimit) {
        selectedIndices.add(i);
        assistantCount++;
      }
    } else if (role === 'system') {
      // system 消息通常很少：不计入上限，但如果落在裁剪窗口内则保留
      selectedIndices.add(i);
    }

    const userDone = userCount >= userLimit;
    const assistantDone = assistantCount >= assistantLimit;
    if (userDone && assistantDone && Number.isFinite(userLimit) && Number.isFinite(assistantLimit)) {
      break;
    }
  }

  // 兜底：确保最后一条 user 消息一定被包含（对应“当前用户消息”）
  for (let i = safeChain.length - 1; i >= 0; i--) {
    if (mapRole(safeChain[i]?.role) === 'user') {
      selectedIndices.add(i);
      break;
    }
  }

  const indices = Array.from(selectedIndices).sort((a, b) => a - b);
  return indices.map(i => safeChain[i]);
}

/**
 * 纯函数：移除消息正文中的 <think> 段落，避免隐式思考内容被重新发送。
 * @param {string|Array} content - 历史消息正文
 * @returns {string|Array} 去除思考段落后的正文
 */
function sanitizeContentForSend(content) {
  if (typeof content !== 'string') return content;
  const { cleanText } = extractThinkingFromText(content);
  return cleanText;
}

/**
 * 角色映射为 API 兼容的 role 值
 * @param {string} role 原始角色
 * @returns {'user'|'assistant'|'system'}
 */
function mapRole(role) {
  if (role === 'user' || role === 'assistant' || role === 'system') return role;
  // 兼容历史记录内部命名
  if (role === 'ai') return 'assistant';
  return 'user';
}

/**
 * 为连续的用户消息插入 Markdown 分隔线（---），保证上下文可读性。
 *
 * 背景：
 * - 某些场景下用户会连续发送多条消息（例如补充信息/分段提问），会在会话链里形成 user->user 的连续片段；
 * - 如果只用换行分隔，模型在阅读上下文时容易把多条用户消息“粘连”为同一段落，降低理解准确度；
 * - 因为需求明确指出“只在发送时添加，不需要存储”，所以这里仅在 composeMessages 的最后一步做纯函数格式化，
 *   不修改历史记录/不落库，避免副作用与技术债。
 *
 * 实现细节：
 * - 分隔线插在“后一条 user 消息”的开头（即对第 2 条及之后的连续 user 消息做前置），形成：
 *   「上一条 user ...」 + 「\n\n---\n\n下一条 user ...」。
 * - This keeps sender-side trailing marker cleanup stable (for example ratio markers like [16:9]).
 * - 使用 `\n\n---\n\n` 以满足 Markdown 对分隔线的常见解析要求（前后留空行）。
 *
 * @param {Array<{role: string, content: any}>} messages - 已构造好的消息数组（content 可能为 string 或旧格式 array）
 * @returns {Array<{role: string, content: any}>} - 处理后的消息数组（原数组就地修改并返回）
 */
function applyUserMessageSpacing(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  const USER_MESSAGE_SEPARATOR = '\n\n---\n\n';
  let previousIsUser = false;
  for (const message of messages) {
    const isUser = message && message.role === 'user';
    if (isUser && previousIsUser && typeof message.content === 'string') {
      // 仅前置一次分隔符；正常情况下 composeMessages 每次都会生成新数组，不会累计叠加，但这里仍做兜底判断。
      if (!message.content.startsWith(USER_MESSAGE_SEPARATOR)) {
        message.content = USER_MESSAGE_SEPARATOR + message.content;
      }
    }
    previousIsUser = !!isUser;
  }

  return messages;
}
