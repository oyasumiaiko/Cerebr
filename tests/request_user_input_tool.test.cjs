const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadRequestUserInputToolModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/request_user_input/tool.js');
  return import(`${pathToFileURL(filePath).href}?test=${Date.now()}`);
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

test('normalizeRequestUserInputArguments 对新调用执行严格题数、选项与 id 校验，同时保留历史兼容入口', async () => {
  const { normalizeRequestUserInputArguments } = await loadRequestUserInputToolModule();

  assert.throws(() => normalizeRequestUserInputArguments({ questions: [] }), /至少提供 1 个问题/);
  assert.throws(() => normalizeRequestUserInputArguments({
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
  }), /snake_case/);
  const legacy = normalizeRequestUserInputArguments({
    questions: [{
      header: 'A',
      id: 'legacy-id',
      question: 'x',
      options: [{ label: 'One', description: '1' }]
    }]
  }, { allowLegacy: true });
  assert.equal(legacy.questions[0].id, 'legacy-id');
  assert.throws(() => normalizeRequestUserInputArguments({
    questions: [
      {
        header: '输出方式',
        id: 'output_mode',
        question: 'x',
        options: []
      }
    ]
  }), /必须提供 2-3 个选项/);
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
  assert.equal(spec.strict, true);
  assert.equal(spec.description, buildRequestUserInputToolDescription());
  assert.match(spec.description, /用途：/);
  assert.match(spec.description, /不要询问密码/);
  assert.equal(Object.hasOwn(spec.parameters.properties.questions, 'minItems'), false);
  assert.equal(Object.hasOwn(spec.parameters.properties.questions, 'maxItems'), false);
  assert.match(spec.parameters.properties.questions.description, /1-3/);
  assert.equal(Object.hasOwn(spec.parameters.properties.questions.items.properties.options, 'minItems'), false);
  assert.equal(Object.hasOwn(spec.parameters.properties.questions.items.properties.options, 'maxItems'), false);
  assert.match(spec.parameters.properties.questions.items.properties.options.description, /2-3/);
  assert.match(spec.parameters.properties.questions.items.properties.options.description, /不要添加 Other/);
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
  assert.equal(answered.status, 'answered');
  assert.equal(answered.answered_count, 2);
  assert.deepEqual(answered.answers, {
    output_mode: { answers: ['并行出V2 (Recommended)'] },
    window_scope: { answers: ['只看当前窗口 (Recommended)'] }
  });

  const cancelled = buildRequestUserInputResult(questions, {
    output_mode: { answers: ['并行出V2 (Recommended)'] }
  }, { cancelled: true });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.answered_count, 1);
  assert.equal(cancelled.note, 'User chose to skip these questions.');
});
