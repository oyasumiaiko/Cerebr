/**
 * 向后兼容包装：
 * - 旧调用方仍使用 `deriveResponsesSseLoadingStatus` 名称；
 * - 真正的阶段映射已经迁移到统一的 assistant pre-response 状态模块。
 */
import { deriveAssistantPreResponseStatusFromResponsesSse } from './assistant_pre_response_status.js';

/**
 * @param {string} eventType
 * @param {any} data
 * @returns {{text:string, meta:{stage:string, note?:string}}|null}
 */
export function deriveResponsesSseLoadingStatus(eventType, data = {}) {
  const normalized = deriveAssistantPreResponseStatusFromResponsesSse(eventType, data);
  if (!normalized) return null;
  return {
    text: normalized.text,
    meta: {
      stage: normalized.stage,
      note: normalized.note || ''
    }
  };
}
