/**
 * request_user_input 工具的纯函数辅助模块。
 *
 * 这里刻意参考了最新 `openai/codex` Rust 源码里的拆分方式：
 * - tool 描述 / schema 由独立模块统一生成；
 * - 参数规范化做“最小必要修正”，而不是把描述层建议一股脑做成强校验；
 * - 结果对象保留一个极小、稳定、便于直接 JSON 序列化的核心结构。
 *
 * 参考入口：
 * - `codex-rs/tools/src/request_user_input_tool.rs`
 * - `codex-rs/core/src/tools/handlers/request_user_input.rs`
 * - `codex-rs/core/tests/suite/request_user_input.rs`
 */

export const REQUEST_USER_INPUT_TOOL_NAME = 'request_user_input';

function normalizeString(value) {
  return (typeof value === 'string') ? value.trim() : '';
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
  if (!id) {
    throw new Error(`request_user_input 参数错误：第 ${questionIndex + 1} 个问题缺少非空 id。`);
  }
  if (!prompt) {
    throw new Error(`request_user_input 参数错误：问题 ${header} 缺少非空 question。`);
  }
  if (rawOptions.length <= 0) {
    throw new Error(`request_user_input 参数错误：问题 ${header} 需要提供非空 options。`);
  }

  const options = rawOptions.map((option, optionIndex) => normalizeQuestionOption(option, questionIndex, optionIndex));

  return {
    header,
    id,
    question: prompt,
    is_other: true,
    options
  };
}

export function normalizeRequestUserInputArguments(rawArgs) {
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs))
    ? rawArgs
    : {};
  const rawQuestions = Array.isArray(args.questions) ? args.questions : [];

  if (rawQuestions.length <= 0) {
    throw new Error('request_user_input 参数错误：questions 需要至少提供 1 个问题。');
  }

  const questions = rawQuestions.map((question, index) => normalizeQuestion(question, index));

  return { questions };
}

export function buildRequestUserInputToolDescription() {
  return 'Request user input for questions and wait for the response.';
}

export function buildRequestUserInputFunctionToolDefinition() {
  const optionProperties = {
    label: {
      type: 'string',
      description: 'User-facing label (1-5 words).'
    },
    description: {
      type: 'string',
      description: 'One short sentence explaining impact/tradeoff if selected.'
    }
  };
  const questionProperties = {
    id: {
      type: 'string',
      description: 'Stable identifier for mapping answers (snake_case).'
    },
    header: {
      type: 'string',
      description: 'Short header label shown in the UI (12 or fewer chars).'
    },
    question: {
      type: 'string',
      description: 'Single-sentence prompt shown to the user.'
    },
    options: {
      type: 'array',
      description: 'Provide 2-3 mutually exclusive choices. Do not include an "Other" option in this list; the client will add a free-form "Other" option automatically.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: optionProperties,
        required: Object.keys(optionProperties)
      }
    }
  };

  return {
    type: 'function',
    name: REQUEST_USER_INPUT_TOOL_NAME,
    description: buildRequestUserInputToolDescription(),
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        questions: {
          type: 'array',
          description: 'Questions to show the user.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: questionProperties,
            required: Object.keys(questionProperties)
          }
        }
      },
      required: ['questions']
    }
  };
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
 *   answers:Record<string, {answers:string[]}>
 *   ok:boolean,
 *   cancelled:boolean,
 *   note?:string,
 *   question_count:number,
 *   answered_count:number,
 *   questions:Array<{id:string,header:string,question:string,answers:string[]}>
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

  const result = {
    ok: !cancelled && normalizedQuestions.length > 0 && answeredCount === normalizedQuestions.length,
    cancelled,
    question_count: normalizedQuestions.length,
    answered_count: answeredCount,
    questions: questionItems,
    answers
  };
  if (cancelled) {
    result.note = 'User chose to skip these questions.';
  }
  return result;
}
