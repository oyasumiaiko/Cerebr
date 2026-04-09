/**
 * request_user_input 面板的交互辅助纯函数。
 *
 * 目标：
 * - 把“已回答什么”“跳过时如何回传”“什么时候可自动完成”从 DOM 事件里拆出来；
 * - 让 sidebar UI 只负责渲染和事件接线，关键语义可被单元测试覆盖。
 */

export const REQUEST_USER_INPUT_OTHER_OPTION_VALUE = '__other__';

function normalizeString(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

function getQuestionId(question) {
  return normalizeString(question?.id);
}

export function getRequestUserInputCommittedAnswer(questionState) {
  if (!questionState || typeof questionState !== 'object') return '';
  const selectedOptionValue = normalizeString(questionState.selectedOptionValue);
  if (selectedOptionValue === REQUEST_USER_INPUT_OTHER_OPTION_VALUE) {
    return normalizeString(questionState.freeformText);
  }
  return selectedOptionValue;
}

export function buildRequestUserInputAnswerMap(questions, questionStates) {
  const normalizedQuestions = Array.isArray(questions) ? questions : [];
  const states = Array.isArray(questionStates) ? questionStates : [];
  const answers = {};

  normalizedQuestions.forEach((question, index) => {
    const questionId = getQuestionId(question);
    if (!questionId) return;
    const answer = getRequestUserInputCommittedAnswer(states[index]);
    if (!answer) return;
    answers[questionId] = { answers: [answer] };
  });

  return answers;
}

export function buildRequestUserInputSkipPayload() {
  return {
    cancelled: true,
    answers: {}
  };
}

export function shouldAutoCompleteRequestUserInput(questionIndex, questions, questionStates) {
  const normalizedQuestions = Array.isArray(questions) ? questions : [];
  if (normalizedQuestions.length <= 0) return false;
  const numericIndex = Number.isFinite(Number(questionIndex)) ? Math.trunc(Number(questionIndex)) : -1;
  if (numericIndex !== normalizedQuestions.length - 1) return false;
  return !!getRequestUserInputCommittedAnswer(
    Array.isArray(questionStates) ? questionStates[numericIndex] : null
  );
}
