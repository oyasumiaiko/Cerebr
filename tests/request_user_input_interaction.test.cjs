const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadRequestUserInputInteractionModule() {
  const filePath = path.resolve(__dirname, '../src/utils/request_user_input_interaction.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('buildRequestUserInputAnswerMap 会抽取普通选项与其他输入答案', async () => {
  const {
    REQUEST_USER_INPUT_OTHER_OPTION_VALUE,
    buildRequestUserInputAnswerMap
  } = await loadRequestUserInputInteractionModule();

  const answers = buildRequestUserInputAnswerMap(
    [
      { id: 'output_mode' },
      { id: 'detail_level' },
      { id: 'empty_one' }
    ],
    [
      { selectedOptionValue: '直接实现' },
      { selectedOptionValue: REQUEST_USER_INPUT_OTHER_OPTION_VALUE, freeformText: '  先给截图  ' },
      { selectedOptionValue: '', freeformText: '  ' }
    ]
  );

  assert.deepEqual(answers, {
    output_mode: { answers: ['直接实现'] },
    detail_level: { answers: ['先给截图'] }
  });
});

test('buildRequestUserInputSkipPayload 始终返回纯跳过结果', async () => {
  const {
    buildRequestUserInputSkipPayload
  } = await loadRequestUserInputInteractionModule();

  const skipped = buildRequestUserInputSkipPayload(
    [{ id: 'output_mode' }, { id: 'window_scope' }],
    [{ selectedOptionValue: '并行出V2' }, { selectedOptionValue: '只看当前窗口' }]
  );
  assert.deepEqual(skipped, {
    cancelled: true,
    answers: {}
  });
});

test('shouldAutoCompleteRequestUserInput 只在最后一题已有有效答案时返回 true', async () => {
  const {
    REQUEST_USER_INPUT_OTHER_OPTION_VALUE,
    shouldAutoCompleteRequestUserInput
  } = await loadRequestUserInputInteractionModule();

  const questions = [{ id: 'q1' }, { id: 'q2' }];
  assert.equal(
    shouldAutoCompleteRequestUserInput(0, questions, [{ selectedOptionValue: 'A' }, { selectedOptionValue: '' }]),
    false
  );
  assert.equal(
    shouldAutoCompleteRequestUserInput(1, questions, [{ selectedOptionValue: 'A' }, { selectedOptionValue: 'B' }]),
    true
  );
  assert.equal(
    shouldAutoCompleteRequestUserInput(1, questions, [{ selectedOptionValue: 'A' }, {
      selectedOptionValue: REQUEST_USER_INPUT_OTHER_OPTION_VALUE,
      freeformText: '  '
    }]),
    false
  );
});
