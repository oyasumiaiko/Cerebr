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

import {
  buildModelToolDescription,
  buildStrictFunctionToolDefinition,
  buildStrictObjectSchema
} from '../shared/model_tool_contract.js';

export const REQUEST_USER_INPUT_TOOL_NAME = 'request_user_input';
export const REQUEST_USER_INPUT_MAX_QUESTIONS = 3;
export const REQUEST_USER_INPUT_MIN_OPTIONS = 2;
export const REQUEST_USER_INPUT_MAX_OPTIONS = 3;
const REQUEST_USER_INPUT_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

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

function normalizeQuestion(rawQuestion, questionIndex, options = {}) {
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
  const allowLegacy = options?.allowLegacy === true;
  const minimumOptions = allowLegacy ? 1 : REQUEST_USER_INPUT_MIN_OPTIONS;
  const maximumOptions = allowLegacy ? Number.POSITIVE_INFINITY : REQUEST_USER_INPUT_MAX_OPTIONS;
  if (rawOptions.length < minimumOptions || rawOptions.length > maximumOptions) {
    throw new Error(`request_user_input 参数错误：问题 ${header} 必须提供 ${REQUEST_USER_INPUT_MIN_OPTIONS}-${REQUEST_USER_INPUT_MAX_OPTIONS} 个选项。`);
  }
  if (!allowLegacy && !REQUEST_USER_INPUT_ID_PATTERN.test(id)) {
    throw new Error(`request_user_input 参数错误：问题 ${header} 的 id 必须是 snake_case，且以小写字母开头。`);
  }

  const normalizedOptions = rawOptions.map((option, optionIndex) => normalizeQuestionOption(option, questionIndex, optionIndex));

  return {
    header,
    id,
    question: prompt,
    is_other: true,
    options: normalizedOptions
  };
}

export function normalizeRequestUserInputArguments(rawArgs, options = {}) {
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs))
    ? rawArgs
    : {};
  const rawQuestions = Array.isArray(args.questions) ? args.questions : [];

  if (rawQuestions.length <= 0) {
    throw new Error('request_user_input 参数错误：questions 需要至少提供 1 个问题。');
  }
  const allowLegacy = options?.allowLegacy === true;
  if (!allowLegacy && rawQuestions.length > REQUEST_USER_INPUT_MAX_QUESTIONS) {
    throw new Error(`request_user_input 参数错误：questions 最多提供 ${REQUEST_USER_INPUT_MAX_QUESTIONS} 个问题。`);
  }

  const questions = rawQuestions.map((question, index) => normalizeQuestion(question, index, { allowLegacy }));
  const uniqueIds = new Set(questions.map(question => question.id));
  if (!allowLegacy && uniqueIds.size !== questions.length) {
    throw new Error('request_user_input 参数错误：每个问题的 id 必须唯一。');
  }

  return { questions };
}

export function buildRequestUserInputToolDescription() {
  return buildModelToolDescription({
    purpose: `向用户展示 1-${REQUEST_USER_INPUT_MAX_QUESTIONS} 个结构化选择题，并暂停当前工具链等待回答。`,
    useWhen: '缺失的用户选择会实质改变结果、权限或安全边界，无法用现有上下文和合理默认值继续时。',
    avoidWhen: [
      '信息只是有帮助但不阻塞时，应采用合理假设继续',
      '不要询问密码、API key、验证码或其他秘密',
      '不要用它征求泛泛确认或把本可直接完成的工作推回给用户'
    ],
    input: `questions 必须有 1-${REQUEST_USER_INPUT_MAX_QUESTIONS} 项；每项使用唯一 snake_case id、短 header、单句 question 和 ${REQUEST_USER_INPUT_MIN_OPTIONS}-${REQUEST_USER_INPUT_MAX_OPTIONS} 个互斥选项。不要手工添加 Other，客户端会自动提供自由填写项。`,
    output: '返回 JSON：status 为 answered/cancelled/incomplete，answers 按问题 id 映射；cancelled 不是执行错误。'
  });
}

export function buildRequestUserInputFunctionToolDefinition() {
  const optionProperties = {
    label: {
      type: 'string',
      description: '显示给用户的简短选项标签，建议 1-5 个词。'
    },
    description: {
      type: 'string',
      description: '一句话说明选择该项的影响或取舍。'
    }
  };
  const questionProperties = {
    id: {
      type: 'string',
      pattern: '^[a-z][a-z0-9_]{0,63}$',
      description: '用于答案映射的唯一 snake_case 标识；以小写字母开头。'
    },
    header: {
      type: 'string',
      description: '显示在 UI 中的短标签，建议不超过 12 个字符。'
    },
    question: {
      type: 'string',
      description: '直接展示给用户的单句问题。'
    },
    options: {
      type: 'array',
      minItems: REQUEST_USER_INPUT_MIN_OPTIONS,
      maxItems: REQUEST_USER_INPUT_MAX_OPTIONS,
      description: `互斥选项，必须有 ${REQUEST_USER_INPUT_MIN_OPTIONS}-${REQUEST_USER_INPUT_MAX_OPTIONS} 项。推荐项放第一位，并可在 label 后标记 \`(Recommended)\`；不要添加 Other。`,
      items: buildStrictObjectSchema(optionProperties)
    }
  };

  return buildStrictFunctionToolDefinition({
    name: REQUEST_USER_INPUT_TOOL_NAME,
    description: buildRequestUserInputToolDescription(),
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: REQUEST_USER_INPUT_MAX_QUESTIONS,
        description: `按显示顺序提交 1-${REQUEST_USER_INPUT_MAX_QUESTIONS} 个问题。优先只问一个真正阻塞的问题。`,
        items: buildStrictObjectSchema(questionProperties)
      }
    }
  });
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
    status: cancelled
      ? 'cancelled'
      : (normalizedQuestions.length > 0 && answeredCount === normalizedQuestions.length ? 'answered' : 'incomplete'),
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
