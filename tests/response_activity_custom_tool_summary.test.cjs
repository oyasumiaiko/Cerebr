const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadModule() {
  const modulePath = path.resolve(__dirname, '../src/utils/response_activity_custom_tool_summary.js');
  return import(pathToFileURL(modulePath).href);
}

test('page_content_read 摘要会显示页面预览或字符范围', async () => {
  const {
    buildResponseActivityCustomToolSummaryParts,
    buildResponseActivityCustomToolPrimaryText,
    getResponseActivityCustomToolTypeLabel
  } = await loadModule();

  const previewRecord = {
    type: 'function_call',
    name: 'page_content_read',
    arguments: JSON.stringify({})
  };
  assert.equal(getResponseActivityCustomToolTypeLabel(previewRecord), '页面');
  assert.deepEqual(buildResponseActivityCustomToolSummaryParts(previewRecord), {
    action: '读取',
    value: '当前页面',
    valueUrl: '',
    meta: '预览',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
  assert.equal(buildResponseActivityCustomToolPrimaryText(previewRecord), '读取 当前页面 预览');

  const rangeRecord = {
    type: 'function_call',
    name: 'page_content_read',
    arguments: JSON.stringify({
      skip_chars: 200,
      max_chars: 600
    })
  };
  assert.equal(buildResponseActivityCustomToolPrimaryText(rangeRecord), '读取 当前页面 C200-C800');
});

test('pdf_content_read 摘要会区分目录、章节和全文读取', async () => {
  const {
    buildResponseActivityCustomToolPrimaryText,
    getResponseActivityCustomToolTypeLabel
  } = await loadModule();

  const overviewRecord = {
    type: 'function_call',
    name: 'pdf_content_read',
    arguments: JSON.stringify({})
  };
  assert.equal(getResponseActivityCustomToolTypeLabel(overviewRecord), 'PDF');
  assert.equal(buildResponseActivityCustomToolPrimaryText(overviewRecord), '读取目录 当前PDF');

  const chapterRecord = {
    type: 'function_call',
    name: 'pdf_content_read',
    arguments: JSON.stringify({
      chapter_id: '2.1',
      chunk_index: 1,
      max_chars: 5000,
      include_outline: true
    })
  };
  assert.equal(buildResponseActivityCustomToolPrimaryText(chapterRecord), '读取章节 2.1 片段 1 · C5000-C10000 · 含目录');

  const documentRecord = {
    type: 'function_call',
    name: 'pdf_content_read',
    arguments: JSON.stringify({
      chunk_index: 2,
      max_chars: 4000
    })
  };
  assert.equal(buildResponseActivityCustomToolPrimaryText(documentRecord), '读取全文 片段 2 C8000-C12000');
});

test('history_search 摘要会显示搜索主体与关键过滤条件', async () => {
  const {
    buildResponseActivityCustomToolSummaryParts,
    buildResponseActivityCustomToolPrimaryText,
    getResponseActivityCustomToolTypeLabel
  } = await loadModule();

  const record = {
    type: 'function_call',
    name: 'history_search',
    arguments: JSON.stringify({
      text_all: ['alpha', 'beta'],
      current_page_only: true,
      recent_within: '5d',
      result_mode: 'metadata_only',
      max_results: 5
    })
  };

  assert.equal(getResponseActivityCustomToolTypeLabel(record), '历史');
  assert.deepEqual(buildResponseActivityCustomToolSummaryParts(record), {
    action: '搜索',
    value: 'alpha + beta',
    valueUrl: '',
    meta: '当前页面 · 最近 5d · 元数据 · ≤5条',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
  assert.equal(buildResponseActivityCustomToolPrimaryText(record), '搜索 alpha + beta 当前页面 · 最近 5d · 元数据 · ≤5条');
});

test('history_read 摘要会显示会话、线程与消息窗口', async () => {
  const {
    buildResponseActivityCustomToolPrimaryText,
    getResponseActivityCustomToolTypeLabel
  } = await loadModule();

  const record = {
    type: 'function_call',
    name: 'history_read',
    arguments: JSON.stringify({
      conv_ref: 7,
      thread_ref: 2,
      start: 1,
      end: 20,
      read_full_messages: true
    })
  };

  assert.equal(getResponseActivityCustomToolTypeLabel(record), '历史');
  assert.equal(buildResponseActivityCustomToolPrimaryText(record), '读取 会话 #7 线程 #2 · M1-M20 · 完整正文');
});

test('模型与用户类工具会显示请求目标与数量', async () => {
  const {
    buildResponseActivityCustomToolPrimaryText,
    getResponseActivityCustomToolTypeLabel
  } = await loadModule();

  const listModelsRecord = {
    type: 'function_call',
    name: 'list_askable_models',
    arguments: '{}'
  };
  assert.equal(getResponseActivityCustomToolTypeLabel(listModelsRecord), '模型');
  assert.equal(buildResponseActivityCustomToolPrimaryText(listModelsRecord), '列出 可问模型');

  const askOtherRecord = {
    type: 'function_call',
    name: 'ask_other_ai',
    arguments: JSON.stringify({
      requests: [
        {
          config_id: 'cfg_gpt5',
          question: 'Why is the spread widening after the earnings call?'
        }
      ]
    })
  };
  assert.match(
    buildResponseActivityCustomToolPrimaryText(askOtherRecord),
    /^询问 Why is the spread widening after the earn.* cfg_gpt5$/
  );

  const requestUserInputRecord = {
    type: 'function_call',
    name: 'request_user_input',
    arguments: JSON.stringify({
      questions: [
        { header: 'Budget', id: 'budget', question: 'Pick one', options: [] },
        { header: 'Risk', id: 'risk', question: 'Pick one', options: [] }
      ]
    })
  };
  assert.equal(getResponseActivityCustomToolTypeLabel(requestUserInputRecord), '用户');
  assert.equal(buildResponseActivityCustomToolPrimaryText(requestUserInputRecord), '请求 2个问题 Budget + Risk');
});

test('图片类工具会显示来源与原始分辨率提示', async () => {
  const {
    buildResponseActivityCustomToolPrimaryText,
    getResponseActivityCustomToolTypeLabel
  } = await loadModule();

  const screenshotRecord = {
    type: 'function_call',
    name: 'webpage_screenshot',
    arguments: JSON.stringify({
      detail: 'original'
    })
  };
  assert.equal(getResponseActivityCustomToolTypeLabel(screenshotRecord), '页面');
  assert.equal(buildResponseActivityCustomToolPrimaryText(screenshotRecord), '截图 当前页面 原始分辨率');

  const viewImageRecord = {
    type: 'function_call',
    name: 'view_image',
    arguments: JSON.stringify({
      path: 'C:\\Users\\wintermute\\Pictures\\diagram.png',
      detail: 'original'
    })
  };
  assert.equal(getResponseActivityCustomToolTypeLabel(viewImageRecord), '图片');
  assert.equal(buildResponseActivityCustomToolPrimaryText(viewImageRecord), '查看 diagram.png 原始分辨率');
});

test('未知 function_call 不会被误判为专有工具摘要', async () => {
  const {
    buildResponseActivityCustomToolSummaryParts,
    getResponseActivityCustomToolTypeLabel,
    isResponseActivityCustomToolCall
  } = await loadModule();

  const record = {
    type: 'function_call',
    name: 'unknown_custom_tool',
    arguments: '{}'
  };

  assert.equal(isResponseActivityCustomToolCall(record), false);
  assert.equal(getResponseActivityCustomToolTypeLabel(record), '');
  assert.equal(buildResponseActivityCustomToolSummaryParts(record), null);
});
