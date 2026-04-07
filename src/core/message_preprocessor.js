/**
 * 用户消息预处理（纯函数）
 * - 负责将模板渲染为实际发送内容
 * - 支持在不修改历史结构的前提下替换消息文本
 */
import { replacePlaceholders } from './prompt_resolver.js';

const ROLE_BLOCK_REGEX = /{{#\s*message\b[^}]*\brole\s*=\s*["']?(user|assistant|system|ai|model)["']?[^}]*}}([\s\S]*?){{\/\s*message\s*}}|{{#\s*(user|assistant|system|ai|model)\s*}}([\s\S]*?){{\/\s*\3\s*}}/gi;
const OMIT_DEFAULT_SYSTEM_PROMPT_MARKER_REGEX = /{{\s*no_system_prompt\s*}}/gi;

/**
 * 解析并剥离模板里的“控制标记”。
 * 约定：
 * - {{no_system_prompt}}：仅控制发送行为（不发送默认系统提示词），本身不会发给模型。
 *
 * @param {string} template
 * @returns {{ templateText: string, omitDefaultSystemPrompt: boolean }}
 */
export function resolveUserMessageTemplateControls(template) {
  const rawTemplate = (typeof template === 'string') ? template : '';
  if (!rawTemplate) {
    return { templateText: '', omitDefaultSystemPrompt: false };
  }
  const omitDefaultSystemPrompt = /{{\s*no_system_prompt\s*}}/i.test(rawTemplate);
  const templateText = rawTemplate.replace(OMIT_DEFAULT_SYSTEM_PROMPT_MARKER_REGEX, '');
  return { templateText, omitDefaultSystemPrompt };
}

function renderTemplateText(template, inputText) {
  const rawTemplate = (typeof template === 'string') ? template : '';
  const safeInput = (typeof inputText === 'string') ? inputText : '';
  if (!rawTemplate.trim()) return safeInput;
  const withTime = replacePlaceholders(rawTemplate);
  return withTime.replace(/{{\s*(input|text|message)\s*}}/gi, () => safeInput);
}

function normalizeInjectedRole(role) {
  const normalized = String(role || '').trim().toLowerCase();
  if (normalized === 'assistant' || normalized === 'ai' || normalized === 'model') return 'assistant';
  if (normalized === 'user' || normalized === 'system') return normalized;
  return null;
}

function normalizeInjectedBlockText(text) {
  if (typeof text !== 'string') return '';
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let lines = normalized.split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (!lines.length) return '';
  let minIndent = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = line.match(/^[ \t]+/);
    const indent = match ? match[0].length : 0;
    minIndent = (minIndent === null) ? indent : Math.min(minIndent, indent);
    if (minIndent === 0) break;
  }
  if (minIndent && minIndent > 0) {
    lines = lines.map(line => line.slice(minIndent));
  }
  return lines.join('\n');
}

/**
 * 解析模板中的“角色块 + 普通文本”，输出按顺序排列的消息列表。
 *
 * 规则：
 * - {{#system}}/{{#assistant}}/{{#user}} 与 {{#message role="...}} 视为显式角色消息；
 * - 角色块外的文本 trim 后作为 user 消息插入（空白忽略）；
 * - 保持模板中的相对顺序，便于手写控制。
 *
 * @param {string} renderedText
 * @returns {{ messages: Array<{role: string, content: string}>, hasRoleBlocks: boolean }}
 */
function buildTemplateMessages(renderedText) {
  if (typeof renderedText !== 'string') {
    return { messages: [], hasRoleBlocks: false };
  }
  const messages = [];
  let hasRoleBlocks = false;
  let lastIndex = 0;
  ROLE_BLOCK_REGEX.lastIndex = 0;
  let match;
  while ((match = ROLE_BLOCK_REGEX.exec(renderedText)) !== null) {
    const before = renderedText.slice(lastIndex, match.index);
    if (before && before.trim()) {
      messages.push({ role: 'user', content: before.trim() });
    }
    const rawRole = match[1] || match[3] || '';
    const rawContent = match[2] || match[4] || '';
    const role = normalizeInjectedRole(rawRole);
    const content = normalizeInjectedBlockText(rawContent);
    if (role && content && content.trim()) {
      messages.push({ role, content });
    }
    hasRoleBlocks = true;
    lastIndex = ROLE_BLOCK_REGEX.lastIndex;
  }
  const tail = renderedText.slice(lastIndex);
  if (tail && tail.trim()) {
    messages.push({ role: 'user', content: tail.trim() });
  }
  return { messages, hasRoleBlocks };
}

/**
 * 渲染用户消息模板。
 *
 * 规则：
 * - {{input}} / {{text}} / {{message}} 代表用户原始输入；
 * - {{datetime}} / {{date}} / {{time}} 复用提示词占位符规则。
 *
 * @param {Object} args
 * @param {string} args.template
 * @param {string} args.inputText
 * @returns {string}
 */
export function renderUserMessageTemplate({ template, inputText }) {
  const { templateText } = resolveUserMessageTemplateControls(template);
  return renderTemplateText(templateText, inputText);
}

/**
 * 渲染用户消息模板，并解析“角色块 + 普通文本”为 API 注入消息。
 *
 * 语法与规则：
 * - 模板中直接写 {{#assistant}}/{{#user}}/{{#system}} 或 {{#message role="assistant"}}；
 * - 角色块外的文本 trim 后作为 user 消息插入（空白忽略）；
 * - 只有模板最终显式产出了 user 消息时，才由模板完全控制发送结构；
 *   若模板只注入 system/assistant，则仍保留原始 user 作为请求上下文。
 * - 所有内容都会应用 {{input}} / {{date}} / {{time}} 等占位符替换。
 *
 * @param {Object} args
 * @param {string} args.template
 * @param {string} args.inputText
 * @returns {{renderedText: string, injectedMessages: Array<{role: string, content: string}>, hasInjectedBlocks: boolean, injectOnly: boolean, hasTemplate: boolean, omitDefaultSystemPrompt: boolean}}
 */
export function renderUserMessageTemplateWithInjection({ template, inputText }) {
  const {
    templateText: rawTemplate,
    omitDefaultSystemPrompt
  } = resolveUserMessageTemplateControls(template);
  const renderedText = renderTemplateText(rawTemplate, inputText);
  if (!rawTemplate.trim()) {
    return {
      renderedText,
      injectedMessages: [],
      hasInjectedBlocks: false,
      injectOnly: false,
      hasTemplate: false,
      omitDefaultSystemPrompt
    };
  }

  const { messages, hasRoleBlocks } = buildTemplateMessages(renderedText);
  const hasInjectedBlocks = hasRoleBlocks;
  const hasExplicitUserMessage = messages.some((item) => item?.role === 'user' && typeof item.content === 'string' && item.content.trim());
  const injectOnly = hasRoleBlocks && hasExplicitUserMessage;
  const injectedMessages = hasRoleBlocks ? messages : [];

  return {
    renderedText,
    injectedMessages,
    hasInjectedBlocks,
    injectOnly,
    hasTemplate: true,
    omitDefaultSystemPrompt
  };
}

/**
 * 将渲染后的文本写回消息内容（兼容纯文本与多模态数组）。
 * @param {string|Array} content
 * @param {string} renderedText
 * @returns {string|Array}
 */
export function applyRenderedTextToMessageContent(content, renderedText) {
  const safeText = (typeof renderedText === 'string') ? renderedText : '';
  if (!Array.isArray(content)) return safeText;
  const nonTextParts = content.filter(part => part && part.type !== 'text');
  if (!safeText.trim()) {
    return nonTextParts;
  }
  return [...nonTextParts, { type: 'text', text: safeText }];
}
