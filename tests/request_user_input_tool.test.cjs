const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadRequestUserInputToolModule() {
  const filePath = path.resolve(__dirname, '../src/utils/request_user_input_tool.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('normalizeRequestUserInputArguments 会规范化问题结构并保留推荐项顺序', async () => {
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
        options: [
          { label: '并行出V2 (Recommended)', description: '保留旧版，再新增 v2。' },
          { label: '直接覆盖旧版', description: '复用现有文件名。' },
          { label: '单一新版', description: '以后只维护一套。' }
        ]
      }
    ]
  });
});

test('normalizeRequestUserInputArguments 会拒绝超范围问题数、非法 id 与显式 Other 选项', async () => {
  const { normalizeRequestUserInputArguments } = await loadRequestUserInputToolModule();

  assert.throws(() => normalizeRequestUserInputArguments({ questions: [] }), /1 到 3 个问题/);
  assert.throws(() => normalizeRequestUserInputArguments({
    questions: [
      {
        header: 'A',
        id: 'bad-id',
        question: 'x',
        options: [
          { label: 'One', description: '1' },
          { label: 'Two', description: '2' }
        ]
      }
    ]
  }), /snake_case/);
  assert.throws(() => normalizeRequestUserInputArguments({
    questions: [
      {
        header: '输出方式',
        id: 'output_mode',
        question: 'x',
        options: [
          { label: 'Other', description: '客户端不该看到这个' },
          { label: '直接覆盖旧版', description: '复用现有文件名。' }
        ]
      }
    ]
  }), /Other\/其他/);
  assert.throws(() => normalizeRequestUserInputArguments({
    questions: [
      {
        header: '输出方式',
        id: 'output_mode',
        question: 'x',
        options: [
          { label: '直接覆盖旧版', description: '复用现有文件名。' },
          { label: '并行出V2 (Recommended)', description: '保留旧版，再新增 v2。' }
        ]
      }
    ]
  }), /\(Recommended\)/);
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
});
