const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadModule() {
  const modulePath = path.resolve(__dirname, '../src/utils/response_activity_tool_summary.js');
  return import(pathToFileURL(modulePath).href);
}

test('skill_registry read_file 摘要会显示技能 action、文件路径和技能名', async () => {
  const {
    buildSkillRegistrySummaryParts,
    buildSkillRegistryPrimaryText,
    getSkillRegistryToolTypeLabel
  } = await loadModule();

  const record = {
    type: 'function_call',
    name: 'skill_registry',
    arguments: JSON.stringify({
      action: 'read_file',
      skill_name: 'dom-probe',
      file_path: 'src/helpers/dom.js'
    })
  };

  const parts = buildSkillRegistrySummaryParts(record);
  assert.deepEqual(parts, {
    action: '读取文件',
    value: 'src/helpers/dom.js',
    valueUrl: '',
    meta: 'dom-probe',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
  assert.equal(buildSkillRegistryPrimaryText(record), '读取文件 src/helpers/dom.js dom-probe');
  assert.equal(getSkillRegistryToolTypeLabel(record), '技能');
});

test('skill_registry read_file 在按行范围读取时会把 Lx-Ly 追加到文件路径摘要', async () => {
  const {
    buildSkillRegistrySummaryParts,
    buildSkillRegistryPrimaryText
  } = await loadModule();

  const record = {
    type: 'function_call',
    name: 'skill_registry',
    arguments: JSON.stringify({
      action: 'read_file',
      skill_name: 'worldquant-brain-knowledge-cache',
      file_path: 'src/cache.js',
      start_line: 1,
      end_line: 260,
      include_line_numbers: true
    })
  };

  const parts = buildSkillRegistrySummaryParts(record);
  assert.deepEqual(parts, {
    action: '读取文件',
    value: 'src/cache.js L1-L260',
    valueUrl: '',
    meta: 'worldquant-brain-knowledge-cache',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
  assert.equal(
    buildSkillRegistryPrimaryText(record),
    '读取文件 src/cache.js L1-L260 worldquant-brain-knowledge-cache'
  );
});

test('skill_registry apply_patch 摘要会显示首个文件和汇总增删行数', async () => {
  const {
    buildSkillRegistrySummaryParts,
    buildSkillRegistryPrimaryText
  } = await loadModule();

  const record = {
    type: 'function_call',
    name: 'skill_registry',
    arguments: JSON.stringify({
      action: 'apply_patch',
      skill_name: 'dom-probe',
      patch: [
        '*** Begin Patch',
        '*** Update File: src/main.js',
        '@@',
        ' old',
        '+new',
        '-old',
        '*** Add File: references/notes.md',
        '+hello',
        '*** End Patch'
      ].join('\n')
    })
  };

  const parts = buildSkillRegistrySummaryParts(record);
  assert.deepEqual(parts, {
    action: '修改了',
    value: 'src/main.js',
    valueUrl: '',
    meta: '+2 · -1 · 另 1 个文件',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
  assert.equal(buildSkillRegistryPrimaryText(record), '修改了 src/main.js +2 · -1 · 另 1 个文件');
});

test('skill_registry search_files 摘要会优先显示 action、pattern 和技能名', async () => {
  const { buildSkillRegistrySummaryParts } = await loadModule();

  const record = {
    type: 'function_call',
    name: 'skill_registry',
    arguments: JSON.stringify({
      action: 'search_files',
      skill_name: 'dom-probe',
      pattern: 'document.title',
      path_glob: 'src/**/*.js'
    })
  };

  const parts = buildSkillRegistrySummaryParts(record);
  assert.deepEqual(parts, {
    action: '搜索文件',
    value: 'document.title',
    valueUrl: '',
    meta: 'dom-probe · src/**/*.js',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
});

test('skill_registry create_skill 摘要会显示创建模板动作与技能名', async () => {
  const { buildSkillRegistrySummaryParts, buildSkillRegistryPrimaryText } = await loadModule();

  const record = {
    type: 'function_call',
    name: 'skill_registry',
    arguments: JSON.stringify({
      action: 'create_skill',
      skill: {
        name: 'DOM Probe Template',
        description: '读取页面标题和链接'
      }
    })
  };

  const parts = buildSkillRegistrySummaryParts(record);
  assert.deepEqual(parts, {
    action: '创建技能模板',
    value: 'DOM Probe Template',
    valueUrl: '',
    meta: '',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
  assert.equal(buildSkillRegistryPrimaryText(record), '创建技能模板 DOM Probe Template');
});

test('skill_registry mount_on_current_page 摘要会显示当前页挂载动作与技能名', async () => {
  const { buildSkillRegistrySummaryParts, buildSkillRegistryPrimaryText } = await loadModule();

  const record = {
    type: 'function_call',
    name: 'skill_registry',
    arguments: JSON.stringify({
      action: 'mount_on_current_page',
      skill_name: 'dom-probe'
    })
  };

  const parts = buildSkillRegistrySummaryParts(record);
  assert.deepEqual(parts, {
    action: '挂载到当前页',
    value: 'dom-probe',
    valueUrl: '',
    meta: '',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
  assert.equal(buildSkillRegistryPrimaryText(record), '挂载到当前页 dom-probe');
});

test('skill_registry list 摘要会区分当前页面技能与全量技能', async () => {
  const { buildSkillRegistrySummaryParts, buildSkillRegistryPrimaryText } = await loadModule();

  const currentPageRecord = {
    type: 'function_call',
    name: 'skill_registry',
    arguments: JSON.stringify({
      action: 'list'
    })
  };
  assert.deepEqual(buildSkillRegistrySummaryParts(currentPageRecord), {
    action: '查看技能列表',
    value: '当前页面技能',
    valueUrl: '',
    meta: '',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });

  const allSitesRecord = {
    type: 'function_call',
    name: 'skill_registry',
    arguments: JSON.stringify({
      action: 'list',
      include_all_sites: true
    })
  };
  assert.deepEqual(buildSkillRegistrySummaryParts(allSitesRecord), {
    action: '查看技能列表',
    value: '全部技能',
    valueUrl: '',
    meta: '',
    locationAction: '',
    locationValue: '',
    locationUrl: ''
  });
  assert.equal(buildSkillRegistryPrimaryText(allSitesRecord), '查看技能列表 全部技能');
});

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
    getResponseActivityCustomToolTypeLabel,
    isResponseActivityImagePreviewToolCall
  } = await loadModule();

  const screenshotRecord = {
    type: 'function_call',
    name: 'webpage_screenshot',
    arguments: JSON.stringify({
      detail: 'original'
    })
  };
  assert.equal(getResponseActivityCustomToolTypeLabel(screenshotRecord), '页面');
  assert.equal(isResponseActivityImagePreviewToolCall(screenshotRecord), true);
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
  assert.equal(isResponseActivityImagePreviewToolCall(viewImageRecord), true);
  assert.equal(buildResponseActivityCustomToolPrimaryText(viewImageRecord), '查看 diagram.png 原始分辨率');
});

test('未知 function_call 不会被误判为专有工具摘要', async () => {
  const {
    buildResponseActivityCustomToolSummaryParts,
    getResponseActivityCustomToolTypeLabel,
    isResponseActivityCustomToolCall,
    isResponseActivityImagePreviewToolCall
  } = await loadModule();

  const record = {
    type: 'function_call',
    name: 'unknown_custom_tool',
    arguments: '{}'
  };

  assert.equal(isResponseActivityCustomToolCall(record), false);
  assert.equal(isResponseActivityImagePreviewToolCall(record), false);
  assert.equal(getResponseActivityCustomToolTypeLabel(record), '');
  assert.equal(buildResponseActivityCustomToolSummaryParts(record), null);
});
