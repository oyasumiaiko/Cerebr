/**
 * 重新生成 / 手动重试目标判定相关纯函数。
 *
 * 设计目标：
 * - 把“是否允许原地复用目标 AI 消息”的规则从 sender 主流程里抽出来；
 * - 把“无 message-id 的临时错误气泡是否可被下一次 regenerate 复用”为 loading 占位
 *   的规则抽成纯判断，便于后续补测试与继续收口。
 */

/**
 * 判断本次 regenerate / retry 是否可以直接原地复用既有 AI 消息。
 *
 * 规则：
 * - 必须先拿到稳定的 targetAiMessageId；
 * - 只要“历史节点”或“当前可见 DOM 元素”至少存在一个，就允许走原地复用；
 * - 不再要求两者同时存在，避免出现“消息其实就在眼前，但 sender 误判成找不到目标，
 *   于是又新建一条 loading 占位”的分裂状态。
 *
 * @param {{
 *   targetAiMessageId?: string|null,
 *   hasTargetNode?: boolean,
 *   hasTargetElement?: boolean
 * }} options
 * @returns {boolean}
 */
export function canReplaceRetryOrRegenerateInPlace(options = {}) {
  const normalizedOptions = (options && typeof options === 'object') ? options : {};
  const targetAiMessageId = (typeof normalizedOptions.targetAiMessageId === 'string')
    ? normalizedOptions.targetAiMessageId.trim()
    : '';
  if (!targetAiMessageId) return false;
  return !!(normalizedOptions.hasTargetNode || normalizedOptions.hasTargetElement);
}

/**
 * 判断一个“紧跟在用户消息后面的 AI 气泡”是否属于可复用的临时占位。
 *
 * 典型场景：
 * - 请求在首个 token 前失败；
 * - UI 会留下一个无 message-id 的错误气泡，只负责显示错误与“重试”按钮；
 * - 用户随后从右键菜单对该用户消息执行 regenerate，如果不复用/移除这个临时气泡，
 *   就会再追加一条新的 loading，占位与旧错误提示并存。
 *
 * @param {{
 *   isAiMessage?: boolean,
 *   hasBoundMessageId?: boolean,
 *   isErrorMessage?: boolean,
 *   isLoadingMessage?: boolean,
 *   hasRetryActions?: boolean
 * }} options
 * @returns {boolean}
 */
export function shouldReuseTransientRegeneratePlaceholder(options = {}) {
  const normalizedOptions = (options && typeof options === 'object') ? options : {};
  if (!normalizedOptions.isAiMessage) return false;
  if (normalizedOptions.hasBoundMessageId) return false;
  return !!(
    normalizedOptions.isErrorMessage
    || normalizedOptions.isLoadingMessage
    || normalizedOptions.hasRetryActions
  );
}

/**
 * 判断一次 append_user_message 失败后，手动/自动重试是否应复用已经落库的用户消息。
 *
 * 规则刻意保持很窄：
 * - 只有“非 regenerate 的追加用户消息”才需要改写成 regenerate retry；
 * - 一旦用户消息已经拿到稳定 message-id，后续重试必须围绕这条历史节点继续生成，
 *   不能再追加一条同文本 user message。
 *
 * @param {{
 *   regenerateMode?: boolean,
 *   committedUserMessageId?: string|null
 * }} options
 * @returns {string} 需要复用的用户消息 id；为空表示不启用该策略。
 */
export function resolveCommittedUserMessageRetryId(options = {}) {
  const normalizedOptions = (options && typeof options === 'object') ? options : {};
  if (normalizedOptions.regenerateMode === true) return '';
  const committedUserMessageId = (typeof normalizedOptions.committedUserMessageId === 'string')
    ? normalizedOptions.committedUserMessageId.trim()
    : '';
  return committedUserMessageId;
}

/**
 * 判断队列任务失败后是否还应把任务放回 queue 里等待用户处理。
 *
 * 失败队列项只适合“还没有形成聊天区错误反馈”的前置失败，例如配置校验或后台快照缺失。
 * 如果聊天区已经有明确的 AI 错误气泡和重试按钮，再把同一任务放回 queue 会造成两个重试入口，
 * 也会让用户误以为同一条消息既已发送又仍待发送。
 *
 * @param {{
 *   retryScheduled?: boolean,
 *   aborted?: boolean,
 *   failureHandledByMessageUi?: boolean
 * }} options
 * @returns {boolean}
 */
export function shouldRetainFailedConversationQueueJob(options = {}) {
  const normalizedOptions = (options && typeof options === 'object') ? options : {};
  if (normalizedOptions.retryScheduled === true) return false;
  if (normalizedOptions.aborted === true) return false;
  if (normalizedOptions.failureHandledByMessageUi === true) return false;
  return true;
}
