/**
 * 统一决定 response-activity 面板底部状态行该显示什么。
 *
 * 设计目标：
 * - 思考进行中：继续显示 runtime/pre-response 的动态状态；
 * - 思考结束后：不再移除底部状态行，而是回退为“思考用时 X”；
 * - 完成态状态行本身可作为“收起思考块”的点击热区。
 *
 * @param {{
 *   activeStatus?: { text?: string, stage?: string, note?: string, showSpinner?: boolean } | null,
 *   completedDurationLabel?: string | null
 * }} [options]
 * @returns {{
 *   text: string,
 *   stage: string,
 *   note: string,
 *   showSpinner: boolean,
 *   collapsible: boolean
 * } | null}
 */
export function resolveResponseActivityPanelStatusState(options = {}) {
  const activeStatus = (options.activeStatus && typeof options.activeStatus === 'object' && !Array.isArray(options.activeStatus))
    ? options.activeStatus
    : null;
  const activeText = typeof activeStatus?.text === 'string' ? activeStatus.text.trim() : '';
  if (activeText) {
    return {
      text: activeText,
      stage: typeof activeStatus?.stage === 'string' ? activeStatus.stage.trim() : '',
      note: typeof activeStatus?.note === 'string' ? activeStatus.note.trim() : '',
      showSpinner: activeStatus?.showSpinner === true,
      collapsible: false
    };
  }

  const completedDurationLabel = typeof options.completedDurationLabel === 'string'
    ? options.completedDurationLabel.trim()
    : '';
  if (!completedDurationLabel) {
    return null;
  }

  return {
    text: `思考用时 ${completedDurationLabel}`,
    stage: 'completed_duration',
    note: '',
    showSpinner: false,
    collapsible: true
  };
}
