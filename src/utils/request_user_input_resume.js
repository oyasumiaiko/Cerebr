/**
 * request_user_input 历史恢复辅助纯函数。
 *
 * 目标：
 * - 只识别“当前对话最后一条主 assistant 消息”上是否残留了未完成的 request_user_input；
 * - 不尝试恢复中途已选答案，也不在这里承担 follow-up continuation 的职责；
 * - 让会话加载逻辑只消费一个极小、稳定的恢复结果对象。
 */

import { REQUEST_USER_INPUT_TOOL_NAME, normalizeRequestUserInputArguments } from '../agent_tools/request_user_input_tool.js';
import { getAssistantActivityTimeline } from './assistant_activity_timeline.js';

function normalizeString(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

function isAssistantMessage(message) {
  return normalizeString(message?.role).toLowerCase() === 'assistant';
}

function isMainConversationMessage(message) {
  if (!message || typeof message !== 'object') return false;
  return !message.threadId && !message.threadHiddenSelection;
}

/**
 * 本地 function_call_output 合并回 timeline 后，`output` 会挂在同一条 tool_call entry 上。
 * 这里只要发现存在非空 output，就视为这次 request_user_input 已经有结果，不再重弹。
 */
function hasResolvedToolOutput(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(entry, 'output')) return false;
  const output = entry.output;
  if (Array.isArray(output)) return output.length > 0;
  if (typeof output === 'string') return normalizeString(output).length > 0;
  if (output && typeof output === 'object') return Object.keys(output).length > 0;
  return Boolean(output);
}

function parseRequestUserInputQuestions(rawArguments) {
  const text = normalizeString(rawArguments);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return normalizeRequestUserInputArguments(parsed).questions;
  } catch (_) {
    return [];
  }
}

/**
 * 从单条 assistant 消息里抽出“最新一个未完成 request_user_input”。
 *
 * 约束：
 * - 只看这条消息自己的 timeline；
 * - 若最新的 request_user_input 已有 output，则视为已完成，直接返回 null；
 * - 若参数无法正常解析，也直接放弃恢复，避免弹出坏面板。
 */
export function extractPendingRequestUserInputFromAssistantMessage(message) {
  if (!isAssistantMessage(message)) return null;

  const timeline = getAssistantActivityTimeline(message);
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (!entry || entry.kind !== 'tool_call') continue;
    if (normalizeString(entry.type).toLowerCase() !== 'function_call') continue;
    if (normalizeString(entry.name) !== REQUEST_USER_INPUT_TOOL_NAME) continue;
    if (hasResolvedToolOutput(entry)) return null;

    const questions = parseRequestUserInputQuestions(entry.arguments);
    if (questions.length <= 0) return null;

    return {
      messageId: normalizeString(message.id),
      callId: normalizeString(entry.call_id),
      questions
    };
  }

  return null;
}

/**
 * 从整条会话消息链里提取最后一个主消息上的待恢复 request_user_input。
 *
 * 这里故意只检查“最后一条主消息”，因为用户要求的是：
 * - 仅当对话结尾停在一个未回答提问上时，重新加载会话才重新弹出该提问。
 */
export function findPendingRequestUserInputFromConversationMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (!isMainConversationMessage(message)) continue;
    return extractPendingRequestUserInputFromAssistantMessage(message);
  }
  return null;
}
