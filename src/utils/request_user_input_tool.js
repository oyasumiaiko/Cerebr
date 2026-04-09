/**
 * request_user_input 工具的纯函数辅助模块。
 *
 * 设计目标：
 * - 把参数校验、问题结构规范化、答案结果整理从 sender / UI 层里拆出来；
 * - 尽量贴近 Codex 当前 `request_user_input` 的参数契约，避免同类工具出现两套语义；
 * - 让后续 UI 或输出格式继续迭代时，工具协议本身仍有稳定单测兜底。
 */

export const REQUEST_USER_INPUT_MIN_QUESTIONS = 1;
export const REQUEST_USER_INPUT_MAX_QUESTIONS = 3;
export const REQUEST_USER_INPUT_MIN_OPTIONS = 2;
export const REQUEST_USER_INPUT_MAX_OPTIONS = 3;
export const REQUEST_USER_INPUT_HEADER_MAX_CHARS = 12;

function normalizeString(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

function countTextChars(text) {
  return Array.from(String(text ?? '')).length;
}

function normalizeAnswerList(rawValue) {
  const source = Array.isArray(rawValue)
    ? rawValue
    : (typeof rawValue === 'string' ? [rawValue] : []);
  const answers = source
    .map(value => normalizeString(value))
    .filter(Boolean);
  return Array.from(new Set(answers));
}

function normalizeQuestionOption(rawOption, questionIndex, optionIndex) {
  const option = (rawOption && typeof rawOption === 'object' && !Array.isArray(rawOption))
    ? rawOption
    : {};
  const label = normalizeString(option.label);
  const description = normalizeString(option.description);

  if (!label) {
    throw new Error(`request_user_input 参数错误：第 ${questionIndex + 1} 个问题的第 ${optionIndex + 1} 个选项缺少非空 label。`);
  }
  if (!description) {
    throw new Error(`request_user_input 参数错误：第 ${questionIndex + 1} 个问题的第 ${optionIndex + 1} 个选项缺少非空 description。`);
  }
  if (/^(other|其他)$/i.test(label)) {
    throw new Error(`request_user_input 参数错误：第 ${questionIndex + 1} 个问题不要显式提供 Other/其他 选项，客户端会自动追加。`);
  }

  return { label, description };
}

function normalizeQuestion(rawQuestion, questionIndex) {
  const question = (rawQuestion && typeof rawQuestion === 'object' && !Array.isArray(rawQuestion))
    ? rawQuestion
    : {};
  const header = normalizeString(question.header);
  const id = normalizeString(question.id);
  const prompt = normalizeString(question.question);
  const rawOptions = Array.isArray(question.options) ? question.options : [];

  if (!header) {
    throw new Error(`request_user_input 参数错误：第 ${questionIndex + 1} 个问题缺少非空 header。`);
  }
  if (countTextChars(header) > REQUEST_USER_INPUT_HEADER_MAX_CHARS) {
    throw new Error(`request_user_input 参数错误：问题 ${header} 的 header 不能超过 ${REQUEST_USER_INPUT_HEADER_MAX_CHARS} 个字符。`);
  }
  if (!id) {
    throw new Error(`request_user_input 参数错误：第 ${questionIndex + 1} 个问题缺少非空 id。`);
  }
  if (!/^[a-z][a-z0-9_]*$/.test(id)) {
    throw new Error(`request_user_input 参数错误：问题 ${header} 的 id 必须使用 snake_case。`);
  }
  if (!prompt) {
    throw new Error(`request_user_input 参数错误：问题 ${header} 缺少非空 question。`);
  }
  if (rawOptions.length < REQUEST_USER_INPUT_MIN_OPTIONS || rawOptions.length > REQUEST_USER_INPUT_MAX_OPTIONS) {
    throw new Error(`request_user_input 参数错误：问题 ${header} 需要提供 ${REQUEST_USER_INPUT_MIN_OPTIONS} 到 ${REQUEST_USER_INPUT_MAX_OPTIONS} 个选项。`);
  }

  const options = rawOptions.map((option, optionIndex) => normalizeQuestionOption(option, questionIndex, optionIndex));
  const optionLabels = options.map(option => option.label);
  if (new Set(optionLabels).size !== optionLabels.length) {
    throw new Error(`request_user_input 参数错误：问题 ${header} 的 options.label 不能重复。`);
  }
  const recommendedIndex = options.findIndex(option => /\(Recommended\)$/i.test(option.label));
  if (recommendedIndex > 0) {
    throw new Error(`request_user_input 参数错误：问题 ${header} 中带有 "(Recommended)" 的选项必须放在第一位。`);
  }

  return {
    header,
    id,
    question: prompt,
    options
  };
}

export function normalizeRequestUserInputArguments(rawArgs) {
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs))
    ? rawArgs
    : {};
  const rawQuestions = Array.isArray(args.questions) ? args.questions : [];

  if (rawQuestions.length < REQUEST_USER_INPUT_MIN_QUESTIONS || rawQuestions.length > REQUEST_USER_INPUT_MAX_QUESTIONS) {
    throw new Error(`request_user_input 参数错误：questions 需要提供 ${REQUEST_USER_INPUT_MIN_QUESTIONS} 到 ${REQUEST_USER_INPUT_MAX_QUESTIONS} 个问题。`);
  }

  const questions = rawQuestions.map((question, index) => normalizeQuestion(question, index));
  const ids = questions.map(question => question.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('request_user_input 参数错误：questions.id 不能重复。');
  }

  return { questions };
}

/**
 * 将 UI 层收集到的答案统一整理成稳定返回格式。
 *
 * 说明：
 * - 返回结构刻意贴近 Codex 当前 session 里 `function_call_output` 的 `answers` 形状；
 * - 即使未来 UI 改成 chips / 下拉 / 命令面板，这里对模型暴露的结果也不需要改。
 *
 * @param {Array<{id:string,header:string,question:string}>} questions
 * @param {Record<string, any>} rawAnswersById
 * @param {{cancelled?:boolean}} [options]
 * @returns {{
 *   ok:boolean,
 *   cancelled:boolean,
 *   question_count:number,
 *   answered_count:number,
 *   questions:Array<{id:string,header:string,question:string,answers:string[]}>,
 *   answers:Record<string, {answers:string[]}>
 * }}
 */
export function buildRequestUserInputResult(questions, rawAnswersById, options = {}) {
  const normalizedQuestions = Array.isArray(questions)
    ? questions
      .map((question) => {
        if (!question || typeof question !== 'object') return null;
        const id = normalizeString(question.id);
        const header = normalizeString(question.header);
        const prompt = normalizeString(question.question);
        if (!id || !header || !prompt) return null;
        return { id, header, question: prompt };
      })
      .filter(Boolean)
    : [];

  const sourceAnswers = (rawAnswersById && typeof rawAnswersById === 'object' && !Array.isArray(rawAnswersById))
    ? rawAnswersById
    : {};
  const answers = {};

  const questionItems = normalizedQuestions.map((question) => {
    const rawValue = sourceAnswers[question.id];
    const normalized = (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue))
      ? normalizeAnswerList(rawValue.answers)
      : normalizeAnswerList(rawValue);
    if (normalized.length > 0) {
      answers[question.id] = { answers: normalized };
    }
    return {
      ...question,
      answers: normalized
    };
  });

  const answeredCount = questionItems.filter(item => item.answers.length > 0).length;
  const cancelled = options?.cancelled === true;

  return {
    ok: !cancelled && normalizedQuestions.length > 0 && answeredCount === normalizedQuestions.length,
    cancelled,
    question_count: normalizedQuestions.length,
    answered_count: answeredCount,
    questions: questionItems,
    answers
  };
}
