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

test('truncateResponsesToolOutputText 默认使用统一的结尾截断提示', async () => {
  const { truncateResponsesToolOutputText } = await loadResponsesToolOutputModule();
  const source = `${'A'.repeat(6000)}${'B'.repeat(6000)}`;
  const truncated = truncateResponsesToolOutputText(source, 5000);
  assert.notEqual(truncated, source);
  assert.match(truncated, /truncated \d+ chars out of 12000 total chars/);
  assert.match(truncated, /returned range \[0, \d+\)/);
  assert.match(truncated, /^A+/);
  assert.doesNotMatch(truncated, /B+$/);
});

test('truncateResponsesToolOutputText 支持显式中间截断模式，供 js_runtime 使用', async () => {
  const { truncateResponsesToolOutputText } = await loadResponsesToolOutputModule();
  const source = `${'A'.repeat(6000)}${'B'.repeat(6000)}`;
  const truncated = truncateResponsesToolOutputText(source, { maxChars: 5000, mode: 'middle' });
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

test('formatResponsesToolOutputForDisplay 会把 input_image 输出压成摘要，避免直接展示 base64', async () => {
  const { extractResponsesToolOutputInputImages, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const text = formatResponsesToolOutputForDisplay([
    {
      type: 'input_image',
      image_url: 'data:image/jpeg;base64,aGVsbG8=',
      detail: 'original'
    }
  ]);
  assert.match(text, /\[input_image #1\]/);
  assert.match(text, /mime_type: image\/jpeg/);
  assert.match(text, /detail: original/);
  assert.doesNotMatch(text, /aGVsbG8=/);
  const images = extractResponsesToolOutputInputImages([
    {
      type: 'input_image',
      image_url: 'data:image/jpeg;base64,aGVsbG8=',
      detail: 'original'
    }
  ]);
  assert.equal(images.length, 1);
  assert.equal(images[0].imageUrl, 'data:image/jpeg;base64,aGVsbG8=');
  assert.equal(images[0].detail, 'original');
  assert.equal(images[0].mimeType, 'image/jpeg');
  assert.equal(images[0].approxBytes > 0, true);
  assert.equal(typeof images[0].signature, 'string');
});

test('formatResponsesToolOutputForDisplay 处理 JSON 字符串态 input_image 时也不会直接展示 base64', async () => {
  const { formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const text = formatResponsesToolOutputForDisplay(JSON.stringify([
    {
      type: 'input_image',
      image_url: 'data:image/png;base64,QUJDRA=='
    }
  ]));
  assert.match(text, /\[input_image #1\]/);
  assert.match(text, /mime_type: image\/png/);
  assert.doesNotMatch(text, /QUJDRA==/);
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

test('buildResponsesPageContentToolOutputContentItems 复用页面工具自身的截断结果并附带统一提示', async () => {
  const { buildResponsesPageContentToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesPageContentToolOutputContentItems({
    ok: true,
    mode: 'preview',
    title: 'Example',
    url: 'https://example.com',
    total_chars: 12000,
    skip_chars: 0,
    max_chars: 10000,
    returned_chars: 10000,
    omitted_chars: 2000,
    omitted_pct: 16.67,
    truncated: true,
    content: 'A'.repeat(10000)
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /<content>/);
  assert.match(text, /\[\.\.\. truncated 2000 chars out of 12000 total chars \(16\.67%\); returned range \[0, 10000\) \.\.\.\]/);
});

test('buildResponsesGenericXmlToolOutputContentItems 在没有 value 字段时仍会显示其余 payload', async () => {
  const { buildResponsesGenericXmlToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesGenericXmlToolOutputContentItems('tool_result', {
    ok: true,
    action: 'read_detail',
    skill: {
      name: 'skill-creator',
      builtin: true
    }
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /<tool_result>/);
  assert.match(text, /<metadata>/);
  assert.match(text, /<result>/);
  assert.match(text, /"action": "read_detail"/);
  assert.match(text, /"name": "skill-creator"/);
});

test('buildResponsesGenericXmlToolOutputContentItems 支持按调用方放宽正文截断上限', async () => {
  const { buildResponsesGenericXmlToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesGenericXmlToolOutputContentItems('micro_skill_registry_result', {
    ok: true,
    action: 'read_file',
    skill: {
      file: {
        path: 'src/main.js',
        content: 'X'.repeat(12000)
      }
    }
  }, {
    blockTruncation: {
      maxChars: 10000,
      mode: 'tail'
    }
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /<micro_skill_registry_result>/);
  assert.match(text, /truncated \d+ chars out of \d+ total chars/);
  assert.match(text, /returned range \[0, \d+\)/);
});

test('buildResponsesMicroSkillRegistryToolOutputContentItems 会把 apply_patch 压成简洁变更摘要', async () => {
  const { buildResponsesMicroSkillRegistryToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesMicroSkillRegistryToolOutputContentItems({
    ok: true,
    action: 'apply_patch',
    skill: {
      name: 'worldquant-brain-sim-state',
      revision: 8
    },
    affected_files: {
      added: ['references/experiment-loop.md'],
      modified: ['SKILL.md'],
      deleted: []
    },
    refreshed_current_document: true,
    refresh_result: {
      ok: true,
      value: {
        active_skills: ['worldquant-brain-sim-state']
      }
    }
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /<micro_skill_registry_result>/);
  assert.match(text, /Success\. Updated the following files:/);
  assert.match(text, /A references\/experiment-loop\.md/);
  assert.match(text, /M SKILL\.md/);
  assert.match(text, /Mounted on current document: worldquant-brain-sim-state/);
  assert.doesNotMatch(text, /"affected_files"/);
  assert.doesNotMatch(text, /"match": \[/);
});

test('buildResponsesMicroSkillRegistryToolOutputContentItems 对 read_file 仍保留结构化详情', async () => {
  const { buildResponsesMicroSkillRegistryToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesMicroSkillRegistryToolOutputContentItems({
    ok: true,
    action: 'read_file',
    skill: {
      name: 'skill-creator',
      file: {
        path: 'SKILL.md',
        content: 'Alpha'
      }
    }
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /"action": "read_file"/);
  assert.match(text, /"path": "SKILL\.md"/);
  assert.match(text, /"content": "Alpha"/);
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
      level: 1,
      char_count: 4500
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
  assert.match(text, /\[\.\.\. truncated 2500 chars out of 4500 total chars \(55\.56%\); returned range \[2000, 4000\) \.\.\.\]/);
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

test('buildResponsesHistorySearchToolOutputContentItems 对过长正文结果块使用结尾截断提示', async () => {
  const { buildResponsesHistorySearchToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesHistorySearchToolOutputContentItems({
    ok: true,
    query: { text_all: ['alpha'], result_mode: 'matches' },
    max_results: 5,
    result_mode: 'matches',
    total_matches: 1,
    results: [
      {
        conv_ref: 1,
        page_title: 'Long Page',
        conversation_title: 'Long Conversation',
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
          total_hit_count: 1,
          matched_message_count: 1,
          locations: [{ msg_index: 1 }],
          excerpts: ['X'.repeat(6000)]
        }
      }
    ]
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /<results>/);
  assert.match(text, /truncated \d+ chars out of \d+ total chars \([\d.]+%\); returned range \[0, \d+\)/);
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

test('buildResponsesHistoryReadToolOutputContentItems 在单条消息末尾附默认 5000 字截断提示', async () => {
  const { buildResponsesHistoryReadToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesHistoryReadToolOutputContentItems({
    ok: true,
    conv_ref: 9,
    page_title: 'Repo',
    conversation_title: 'Long read',
    url: 'https://example.com/repo',
    created_at: '2026-04-07T00:00:00+08:00',
    updated_at: '2026-04-07T00:02:00+08:00',
    message_count: 1,
    main_message_count: 1,
    thread_message_count: 0,
    thread_count: 0,
    has_threads: false,
    is_branch: false,
    parent_conv_ref: null,
    has_api_lock: false,
    scope: 'main',
    read_full_messages: false,
    message_truncation_max_chars: 5000,
    start: 1,
    end: 1,
    messages: [
      {
        msg_index: 1,
        role: 'user',
        timestamp: 1775458218025,
        content: 'A'.repeat(5000),
        content_total_chars: 6200,
        content_returned_chars: 5000,
        content_omitted_chars: 1200,
        content_omitted_pct: 19.35,
        content_truncated: true
      }
    ]
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /<messages>/);
  assert.match(text, /truncated 1200 chars out of 6200 total chars \(19\.35%\); returned range \[0, 5000\)/);
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
