const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadRequestUserInputToolModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/request_user_input/tool.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('normalizeRequestUserInputArguments 会保留问题结构并自动标记 is_other', async () => {
  const { normalizeRequestUserInputArguments } = await loadRequestUserInputToolModule();
  const normalized = normalizeRequestUserInputArguments({
    questions: [
      {
        header: '输出方式',
        id: 'output_mode',
        question: '这次你更希望我怎么落地？',
        options: [
          { label: '并行出V2 (Recommended)', description: '保留旧版，再新增 v2。' },
          { label: '直接覆盖旧版', description: '复用现有文件名。' },
          { label: '单一新版', description: '以后只维护一套。' }
        ]
      }
    ]
  });

  assert.deepEqual(normalized, {
    questions: [
      {
        header: '输出方式',
        id: 'output_mode',
        question: '这次你更希望我怎么落地？',
        is_other: true,
        options: [
          { label: '并行出V2 (Recommended)', description: '保留旧版，再新增 v2。' },
          { label: '直接覆盖旧版', description: '复用现有文件名。' },
          { label: '单一新版', description: '以后只维护一套。' }
        ]
      }
    ]
  });
});

test('normalizeRequestUserInputArguments 只对空 questions 或空 options 做必要校验', async () => {
  const { normalizeRequestUserInputArguments } = await loadRequestUserInputToolModule();

  assert.throws(() => normalizeRequestUserInputArguments({ questions: [] }), /至少提供 1 个问题/);
  const relaxed = normalizeRequestUserInputArguments({
    questions: [
      {
        header: 'A',
        id: 'not_snake_case-but-still-accepted',
        question: 'x',
        options: [
          { label: 'One', description: '1' },
          { label: 'Two', description: '2' }
        ]
      }
    ]
  });
  assert.equal(relaxed.questions[0].id, 'not_snake_case-but-still-accepted');
  assert.throws(() => normalizeRequestUserInputArguments({
    questions: [
      {
        header: '输出方式',
        id: 'output_mode',
        question: 'x',
        options: []
      }
    ]
  }), /非空 options/);
});

test('buildRequestUserInputFunctionToolDefinition 与 Codex 风格保持一致', async () => {
  const {
    REQUEST_USER_INPUT_TOOL_NAME,
    buildRequestUserInputFunctionToolDefinition,
    buildRequestUserInputToolDescription
  } = await loadRequestUserInputToolModule();

  const spec = buildRequestUserInputFunctionToolDefinition();
  assert.equal(spec.type, 'function');
  assert.equal(spec.name, REQUEST_USER_INPUT_TOOL_NAME);
  assert.equal(spec.strict, false);
  assert.equal(spec.description, buildRequestUserInputToolDescription());
  assert.equal(spec.description, 'Request user input for questions and wait for the response.');
  assert.equal(spec.parameters.properties.questions.description, 'Questions to show the user.');
  assert.match(spec.parameters.properties.questions.items.properties.options.description, /Provide 2-3 mutually exclusive choices/);
  assert.match(spec.parameters.properties.questions.items.properties.options.description, /Do not include an "Other" option/);
});

test('buildRequestUserInputResult 会整理答案映射并保留取消态', async () => {
  const { buildRequestUserInputResult } = await loadRequestUserInputToolModule();
  const questions = [
    {
      header: '输出方式',
      id: 'output_mode',
      question: '这次你更希望我怎么落地？'
    },
    {
      header: '窗口范围',
      id: 'window_scope',
      question: '下一步默认还只看当前窗口吗？'
    }
  ];

  const answered = buildRequestUserInputResult(questions, {
    output_mode: { answers: ['并行出V2 (Recommended)'] },
    window_scope: '只看当前窗口 (Recommended)'
  });
  assert.equal(answered.ok, true);
  assert.equal(answered.answered_count, 2);
  assert.deepEqual(answered.answers, {
    output_mode: { answers: ['并行出V2 (Recommended)'] },
    window_scope: { answers: ['只看当前窗口 (Recommended)'] }
  });

  const cancelled = buildRequestUserInputResult(questions, {
    output_mode: { answers: ['并行出V2 (Recommended)'] }
  }, { cancelled: true });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.answered_count, 1);
  assert.equal(cancelled.note, 'User chose to skip these questions.');
});
