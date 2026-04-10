const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadResponsesToolOutputModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/responses_tool_output.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('stringifyResponsesToolOutputValue 默认把对象转成 pretty JSON', async () => {
  const { stringifyResponsesToolOutputValue } = await loadResponsesToolOutputModule();
  const text = stringifyResponsesToolOutputValue({ ok: true, value: { a: 1 } });
  assert.match(text, /"ok": true/);
  assert.match(text, /"a": 1/);
});

test('stringifyResponsesToolOutputValue 能处理循环引用与 bigint', async () => {
  const { stringifyResponsesToolOutputValue } = await loadResponsesToolOutputModule();
  const value = { count: 123n };
  value.self = value;
  const text = stringifyResponsesToolOutputValue(value);
  assert.match(text, /123n/);
  assert.match(text, /\[Circular\]/);
});

test('stringifyResponsesToolOutputValue 对超过 1000 字符的 JSON 使用紧凑格式', async () => {
  const { stringifyResponsesToolOutputValue } = await loadResponsesToolOutputModule();
  const value = {
    long: 'x'.repeat(1200),
    nested: { ok: true }
  };
  const text = stringifyResponsesToolOutputValue(value);
  assert.doesNotMatch(text, /\n  "nested"/);
  assert.match(text, /^\{"long":"x+/);
});

test('truncateResponsesToolOutputText 使用统一的字符截断提示', async () => {
  const { truncateResponsesToolOutputText } = await loadResponsesToolOutputModule();
  const source = `${'A'.repeat(6000)}${'B'.repeat(6000)}`;
  const truncated = truncateResponsesToolOutputText(source, 5000);
  assert.notEqual(truncated, source);
  assert.match(truncated, /truncated \d+ chars out of 12000 total chars/);
  assert.match(truncated, /omitted range \[\d+, \d+\)/);
  assert.match(truncated, /^A+/);
  assert.match(truncated, /B+$/);
});

test('buildResponsesToolOutputContentItems 会把长文本切成多个 input_text item', async () => {
  const { buildResponsesToolOutputContentItems } = await loadResponsesToolOutputModule();
  const items = buildResponsesToolOutputContentItems('x'.repeat(7000), { maxChars: 5000, chunkChars: 2000 });
  assert.equal(Array.isArray(items), true);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], {
    type: 'input_text',
    text: 'x'.repeat(2000)
  });
});

test('formatResponsesToolOutputForDisplay 能拼回 input_text 分块', async () => {
  const { formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const text = formatResponsesToolOutputForDisplay([
    { type: 'input_text', text: '{\n  "ok": true,' },
    { type: 'input_text', text: '\n  "value": 1\n}' }
  ]);
  assert.equal(text, '{\n  "ok": true,\n  "value": 1\n}');
});

test('buildResponsesJsRuntimeToolOutputText 使用 XML 分块且避免大 JSON 包裹主输出', async () => {
  const { buildResponsesJsRuntimeToolOutputText } = await loadResponsesToolOutputModule();
  const text = buildResponsesJsRuntimeToolOutputText({
    ok: true,
    tabId: 123,
    value: 'done',
    logs: [
      { level: 'log', text: 'alpha' },
      { level: 'warn', text: 'beta' }
    ],
    items: [
      { frameId: 0, documentId: 'doc-1', result: 'done', logs: [], error: null }
    ],
    error: null
  });
  assert.match(text, /<js_runtime_result>/);
  assert.match(text, /<metadata>/);
  assert.match(text, /"tab_id": 123/);
  assert.match(text, /<return_value>\s*done\s*<\/return_value>/);
  assert.match(text, /<console_logs>/);
  assert.match(text, /\[log\] alpha/);
  assert.doesNotMatch(text, /"items":/);
});

test('buildResponsesJsReplToolOutputContentItems 使用 js_repl_result root tag 并附带 tool 元数据', async () => {
  const {
    buildResponsesJsReplToolOutputContentItems,
    formatResponsesToolOutputForDisplay
  } = await loadResponsesToolOutputModule();
  const items = buildResponsesJsReplToolOutputContentItems({
    ok: true,
    tabId: 77,
    value: 42,
    logs: [{ level: 'log', text: 'repl ok' }],
    items: [{ frameId: 0, documentId: 'doc-1', result: 42, logs: [], error: null }],
    error: null
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /<js_repl_result>/);
  assert.match(text, /"tool": "js_repl"/);
  assert.match(text, /<return_value>\s*42\s*<\/return_value>/);
});

test('buildResponsesJsRuntimeToolOutputText 会在单 frame 且仅 item.logs 存在时仍显示 console_logs', async () => {
  const { buildResponsesJsRuntimeToolOutputText } = await loadResponsesToolOutputModule();
  const text = buildResponsesJsRuntimeToolOutputText({
    ok: true,
    tabId: 321,
    value: 60,
    logs: [],
    items: [
      {
        frameId: 0,
        documentId: 'doc-1',
        result: 60,
        logs: [{ frameId: 0, level: 'log', text: 'hello from item logs' }],
        error: null
      }
    ],
    error: null
  });
  assert.match(text, /"console_log_count": 1/);
  assert.match(text, /<console_logs>/);
  assert.match(text, /hello from item logs/);
});

test('buildResponsesJsRuntimeToolOutputText 在多 frame 时输出 frame_results 块', async () => {
  const { buildResponsesJsRuntimeToolOutputText } = await loadResponsesToolOutputModule();
  const text = buildResponsesJsRuntimeToolOutputText({
    ok: false,
    tabId: 5,
    value: ['a', null],
    logs: [],
    items: [
      { frameId: 0, documentId: 'doc-top', result: 'a', logs: [{ level: 'log', text: 'top ok' }], error: null },
      { frameId: 2, documentId: 'doc-sub', result: null, logs: [], error: { name: 'Error', message: 'boom', stack: '' } }
    ],
    error: { name: 'Error', message: 'one frame failed', stack: '' }
  });
  assert.match(text, /<frame_results>/);
  assert.match(text, /<frame_result frame_id="0" document_id="doc-top" status="ok">/);
  assert.match(text, /<frame_result frame_id="2" document_id="doc-sub" status="error">/);
  assert.match(text, /top ok/);
  assert.match(text, /one frame failed/);
});

test('buildResponsesPageContentToolOutputContentItems 使用 metadata + content XML 分块', async () => {
  const { buildResponsesPageContentToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesPageContentToolOutputContentItems({
    ok: true,
    mode: 'preview',
    title: 'Example',
    url: 'https://example.com',
    total_chars: 100,
    content: 'Alpha <b>Beta</b>\nGamma'
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /<page_content_read_result>/);
  assert.match(text, /<metadata>/);
  assert.match(text, /"mode": "preview"/);
  assert.match(text, /<content>\s*Alpha <b>Beta<\/b>/);
});

test('buildResponsesPageContentToolOutputContentItems 对长页面内容使用统一中间截断标记', async () => {
  const { buildResponsesPageContentToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesPageContentToolOutputContentItems({
    ok: true,
    mode: 'preview',
    title: 'Example',
    url: 'https://example.com',
    total_chars: 12000,
    returned_chars: 12000,
    omitted_chars: 0,
    omitted_pct: 0,
    truncated: false,
    content: 'A'.repeat(12000)
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /<content>/);
  assert.match(text, /\[\.\.\. truncated \d+ chars out of 12000 total chars \([\d.]+%\); omitted range \[\d+, \d+\) \.\.\.\]/);
});

test('buildResponsesPdfContentToolOutputContentItems 使用 overview / selection / content XML 分块', async () => {
  const { buildResponsesPdfContentToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesPdfContentToolOutputContentItems({
    ok: true,
    mode: 'chapter_chunk',
    title: 'PDF',
    url: 'https://example.com/a.pdf',
    is_pdf: true,
    total_chars: 9000,
    chunk_index: 1,
    max_chars: 2000,
    returned_chars: 2000,
    total_chunks: 3,
    has_next_chunk: true,
    outline: [
      {
        chapter_id: '1',
        parent_chapter_id: null,
        level: 1,
        title: '第一章',
        page_number: 1,
        char_count: 4500,
        chunk_count: 2,
        child_count: 0
      }
    ],
    selection: {
      chapter_id: '1',
      title: '第一章',
      level: 1
    },
    content: 'Alpha\nBeta'
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /<pdf_content_read_result>/);
  assert.match(text, /<outline>/);
  assert.match(text, /chapter_id=1/);
  assert.match(text, /<selection>/);
  assert.match(text, /"chapter_id": "1"/);
  assert.match(text, /<content>\s*Alpha/);
});

test('buildResponsesHistorySearchToolOutputContentItems 使用 conversation XML 分块', async () => {
  const { buildResponsesHistorySearchToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesHistorySearchToolOutputContentItems({
    ok: true,
    query: { recent_within: '5d', result_mode: 'matches' },
    max_results: 5,
    result_mode: 'matches',
    total_matches: 1,
    results: [
      {
        conv_ref: 7,
        page_title: 'Page',
        conversation_title: 'Hello',
        url: 'https://example.com',
        created_at: '2026-04-07T00:00:00+08:00',
        updated_at: '2026-04-07T00:01:00+08:00',
        message_count: 3,
        main_message_count: 3,
        thread_message_count: 0,
        thread_count: 0,
        has_threads: false,
        is_branch: false,
        parent_conv_ref: null,
        has_api_lock: false,
        match: {
          reason: 'message',
          total_hit_count: 2,
          matched_message_count: 1,
          locations: [{ msg_index: 2 }],
          excerpts: ['first excerpt', 'second excerpt']
        }
      }
    ]
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /<history_search_result>/);
  assert.match(text, /<conversation rank="1">/);
  assert.match(text, /<match_excerpts>/);
  assert.match(text, /first excerpt/);
  assert.doesNotMatch(text, /&lt;/);
});

test('buildResponsesHistoryReadToolOutputContentItems 使用 messages XML 分块', async () => {
  const { buildResponsesHistoryReadToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesHistoryReadToolOutputContentItems({
    ok: true,
    conv_ref: 8,
    page_title: 'Repo',
    conversation_title: 'Read me',
    url: 'https://example.com/repo',
    created_at: '2026-04-07T00:00:00+08:00',
    updated_at: '2026-04-07T00:02:00+08:00',
    message_count: 4,
    main_message_count: 4,
    thread_message_count: 0,
    thread_count: 0,
    has_threads: false,
    is_branch: false,
    parent_conv_ref: null,
    has_api_lock: false,
    scope: 'main',
    start: 1,
    end: 2,
    messages: [
      { msg_index: 1, role: 'user', timestamp: 1775458218025, content: 'Hello <xml>' },
      { msg_index: 2, role: 'assistant', timestamp: 1775458219000, content: 'World' }
    ]
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /<history_read_result>/);
  assert.match(text, /<messages>/);
  assert.match(text, /<message msg_index="1" role="user" timestamp="1775458218025">/);
  assert.match(text, /Hello <xml>/);
});

test('buildResponsesAskableModelsToolOutputContentItems 使用 guidance 与 models XML 分块', async () => {
  const { buildResponsesAskableModelsToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesAskableModelsToolOutputContentItems({
    ok: true,
    total_models: 1,
    guidance: '先看目录，再提问。',
    models: [
      {
        rank: 1,
        config_id: 'cfg-1',
        display_name: 'Reviewer',
        model_name: 'gpt-4.1',
        connection_type: 'openai',
        connection_source_name: 'Proxy',
        base_url: 'https://example.com/v1/chat/completions',
        is_favorite: false,
        has_custom_system_prompt: true
      }
    ]
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /<list_askable_models_result>/);
  assert.match(text, /<guidance>/);
  assert.match(text, /先看目录，再提问/);
  assert.match(text, /<model rank="1" config_id="cfg-1" display_name="Reviewer">/);
  assert.match(text, /Reviewer/);
});

test('buildResponsesAskOtherAiToolOutputContentItems 使用 responses XML 分块', async () => {
  const { buildResponsesAskOtherAiToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesAskOtherAiToolOutputContentItems({
    ok: true,
    total_requests: 2,
    success_count: 1,
    error_count: 1,
    answers: [
      {
        index: 1,
        config_id: 'cfg-a',
        status: 'ok',
        question: '这个方案靠谱吗？',
        target: {
          display_name: 'Reviewer',
          model_name: 'gpt-4.1',
          connection_type: 'openai'
        },
        usage: {
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30
        },
        answer: '我认为大体可行，但要补测试。'
      },
      {
        index: 2,
        config_id: 'cfg-b',
        status: 'error',
        question: '请给反对意见',
        answer: '',
        error: 'HTTP 500'
      }
    ]
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /<ask_other_ai_result>/);
  assert.match(text, /<responses>/);
  assert.match(text, /<response rank="1" status="ok" config_id="cfg-a" display_name="Reviewer">/);
  assert.match(text, /<question>/);
  assert.match(text, /这个方案靠谱吗/);
  assert.match(text, /<answer>/);
  assert.match(text, /补测试/);
  assert.match(text, /HTTP 500/);
  assert.doesNotMatch(text, /<target>/);
});

test('buildResponsesRequestUserInputToolOutputContentItems 使用紧凑 JSON 返回 answers', async () => {
  const { buildResponsesRequestUserInputToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesRequestUserInputToolOutputContentItems({
    ok: true,
    cancelled: false,
    question_count: 2,
    answered_count: 2,
    questions: [
      {
        id: 'output_mode',
        header: '输出方式',
        question: '新版宏观报告你希望怎么落地？',
        answers: ['并行出V2 (Recommended)']
      },
      {
        id: 'window_scope',
        header: '窗口范围',
        question: '下一步默认还只看当前窗口吗？',
        answers: ['只看当前窗口 (Recommended)']
      }
    ]
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /"answers": \{/);
  assert.match(text, /"output_mode": \{/);
  assert.match(text, /"window_scope": \{/);
  assert.match(text, /并行出V2 \(Recommended\)/);
  assert.doesNotMatch(text, /<request_user_input_result>/);
});

test('buildResponsesRequestUserInputToolOutputContentItems 会透出 skip note', async () => {
  const { buildResponsesRequestUserInputToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesRequestUserInputToolOutputContentItems({
    ok: false,
    cancelled: true,
    note: 'User chose to skip these questions.',
    answers: {}
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /"note": "User chose to skip these questions\."/);
});
