const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadResponsesToolOutputModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/shared/responses_tool_output.js');
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
  assert.match(truncated, /output too long; truncated \d+ chars out of 12000 total chars/);
  assert.match(truncated, /returned range \[0, \d+\)/);
  assert.match(truncated, /^A+/);
  assert.doesNotMatch(truncated, /B+$/);
});

test('truncateResponsesToolOutputText 支持显式中间截断模式，供 js_runtime 使用', async () => {
  const { truncateResponsesToolOutputText } = await loadResponsesToolOutputModule();
  const source = `${'A'.repeat(6000)}${'B'.repeat(6000)}`;
  const truncated = truncateResponsesToolOutputText(source, { maxChars: 5000, mode: 'middle' });
  assert.notEqual(truncated, source);
  assert.match(truncated, /output too long; truncated \d+ chars out of 12000 total chars/);
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

test('formatResponsesToolOutputForDisplay 会把 image_generation_call 压成可读摘要并提取 PNG 预览', async () => {
  const { extractResponsesToolOutputInputImages, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const payload = {
    type: 'image_generation_call',
    status: 'completed',
    revised_prompt: '将一只蓝色钢笔放在白纸上',
    result: 'QUJDRA=='
  };
  const text = formatResponsesToolOutputForDisplay(payload);
  assert.match(text, /\[image_generation_call #1\]/);
  assert.match(text, /status: completed/);
  assert.match(text, /revised_prompt: 将一只蓝色钢笔放在白纸上/);
  assert.match(text, /result: image\/png/);
  assert.doesNotMatch(text, /QUJDRA==/);

  const images = extractResponsesToolOutputInputImages(payload);
  assert.equal(images.length, 1);
  assert.equal(images[0].imageUrl, 'data:image/png;base64,QUJDRA==');
  assert.equal(images[0].mimeType, 'image/png');
  assert.equal(images[0].approxBytes > 0, true);
});

test('image_generation_call 支持本地化后的 result_image_url 预览且不估算为 base64 字节', async () => {
  const { extractResponsesToolOutputInputImages, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const payload = {
    type: 'image_generation_call',
    status: 'completed',
    revised_prompt: '本地图片',
    result_image_url: 'file:///C:/Users/test/Downloads/Cerebr/Images/cerebr.png'
  };
  const text = formatResponsesToolOutputForDisplay(payload);
  assert.match(text, /\[image_generation_call #1\]/);
  assert.match(text, /result: image\/png/);
  assert.doesNotMatch(text, /file:\/\/\/C:\/Users\/test/);

  const images = extractResponsesToolOutputInputImages(payload);
  assert.equal(images.length, 1);
  assert.equal(images[0].imageUrl, payload.result_image_url);
  assert.equal(images[0].approxBytes, 0);
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

test('buildResponsesJsRuntimeToolOutputText 会输出 workspace_files 摘要', async () => {
  const { buildResponsesJsRuntimeToolOutputText } = await loadResponsesToolOutputModule();
  const text = buildResponsesJsRuntimeToolOutputText({
    ok: true,
    tabId: null,
    value: { changed: true },
    logs: [],
    items: [],
    workspace_files: {
      enabled: true,
      operations_count: 2,
      operation_counts: {
        read: 1,
        write: 1
      },
      affected_files: {
        added: ['summary.json'],
        modified: [],
        deleted: []
      },
      updated_paths: ['summary.json'],
      deleted_paths: []
    },
    error: null
  });

  assert.match(text, /<workspace_files>/);
  assert.match(text, /"operations_count": 2/);
  assert.match(text, /"summary\.json"/);
  assert.match(text, /<return_value>/);
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
    include_image_urls: true,
    image_reference_count: 1,
    content: 'Alpha <b>Beta</b>\nGamma'
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /<page_content_read_result>/);
  assert.match(text, /<metadata>/);
  assert.match(text, /"mode": "preview"/);
  assert.match(text, /"include_image_urls": true/);
  assert.match(text, /"image_reference_count": 1/);
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
  assert.match(text, /\[\.\.\. output too long; truncated 2000 chars out of 12000 total chars \(16\.67%\); returned range \[0, 10000\) \.\.\.\]/);
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
  const items = buildResponsesGenericXmlToolOutputContentItems('skill_registry_result', {
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
  assert.match(text, /<skill_registry_result>/);
  assert.match(text, /output too long; truncated \d+ chars out of \d+ total chars/);
  assert.match(text, /returned range \[0, \d+\)/);
});

test('buildResponsesSkillRegistryToolOutputContentItems 会把 apply_patch 压成简洁变更摘要', async () => {
  const { buildResponsesSkillRegistryToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesSkillRegistryToolOutputContentItems({
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
  assert.match(text, /Success\. Updated the following files:/);
  assert.match(text, /A references\/experiment-loop\.md/);
  assert.match(text, /M SKILL\.md/);
  assert.match(text, /Mounted on current document: worldquant-brain-sim-state/);
  assert.doesNotMatch(text, /<skill_registry_result>/);
  assert.doesNotMatch(text, /"affected_files"/);
  assert.doesNotMatch(text, /"match": \[/);
});

test('buildResponsesSkillRegistryToolOutputContentItems 会把文件管理操作压成单行摘要', async () => {
  const { buildResponsesSkillRegistryToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesSkillRegistryToolOutputContentItems({
    ok: true,
    action: 'copy_file',
    skill: {
      name: 'dom-probe'
    },
    source_file_path: 'references/a.md',
    destination_file_path: 'references/b.md'
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.doesNotMatch(text, /<skill_registry_result/);
  assert.match(text, /copy references\/a\.md -> references\/b\.md/);
  assert.doesNotMatch(text, /"source_file_path"/);
});

test('buildResponsesConversationDocumentToolOutputContentItems 不再把 workspace 展示规则重复写进工具结果', async () => {
  const {
    buildResponsesConversationDocumentToolOutputContentItems,
    buildResponsesSkillRegistryToolOutputContentItems,
    formatResponsesToolOutputForDisplay
  } = await loadResponsesToolOutputModule();

  const conversationItems = buildResponsesConversationDocumentToolOutputContentItems('apply_patch', {
    ok: true,
    action: 'apply_patch',
    affected_files: {
      added: ['plan.md'],
      modified: [],
      deleted: []
    }
  });
  const conversationText = formatResponsesToolOutputForDisplay(conversationItems);
  assert.match(conversationText, /Success\. Updated the following files:/);
  assert.match(conversationText, /A plan\.md/);
  assert.doesNotMatch(conversationText, /Reminder:/);
  assert.doesNotMatch(conversationText, /Markdown 相对路径链接/);
  assert.doesNotMatch(conversationText, /<apply_patch_result|<result>|<reminder>/);

  const deleteOnlyItems = buildResponsesConversationDocumentToolOutputContentItems('apply_patch', {
    ok: true,
    action: 'apply_patch',
    affected_files: {
      added: [],
      modified: [],
      deleted: ['plan.md']
    }
  });
  const deleteOnlyText = formatResponsesToolOutputForDisplay(deleteOnlyItems);
  assert.doesNotMatch(deleteOnlyText, /Reminder:/);

  const skillItems = buildResponsesSkillRegistryToolOutputContentItems({
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
    }
  });
  const skillText = formatResponsesToolOutputForDisplay(skillItems);
  assert.doesNotMatch(skillText, /会话文件/);
  assert.doesNotMatch(skillText, /Reminder:/);
});

test('buildResponsesSkillRegistryToolOutputContentItems 会把模板式 create_skill 渲染成脚手架摘要与 next steps', async () => {
  const { buildResponsesSkillRegistryToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesSkillRegistryToolOutputContentItems({
    ok: true,
    action: 'create_skill',
    create_mode: 'template',
    normalized_name: 'worldquant-dom-helper',
    created_files: [
      'SKILL.md',
      'references/api_reference.md'
    ],
    selected_resources: ['references'],
    examples_created: true,
    next_steps: [
      'Edit SKILL.md and replace the placeholder sections with real trigger rules, workflow, and concrete examples.',
      'If this skill later needs browser runtime code, patch manifest.json to add match and runtime.entry_path, then add the corresponding JS files with apply_patch.'
    ],
    skill: {
      name: 'worldquant-dom-helper',
      revision: 1
    },
    refreshed_current_document: false,
    refresh_result: null
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /Created skill scaffold worldquant-dom-helper/);
  assert.match(text, /Created files:/);
  assert.match(text, /- SKILL\.md/);
  assert.match(text, /Selected resources: references/);
  assert.match(text, /Examples created: yes/);
  assert.match(text, /Next steps:/);
  assert.match(text, /1\. Edit SKILL\.md/);
  assert.doesNotMatch(text, /Mounted on current document:/);
});

test('buildResponsesSkillRegistryToolOutputContentItems 只把真实 active skills 渲染为 mounted', async () => {
  const { buildResponsesSkillRegistryToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesSkillRegistryToolOutputContentItems({
    ok: true,
    action: 'create_skill',
    skill: {
      name: 'worldquant-brain-knowledge-cache',
      revision: 1
    },
    refreshed_current_document: true,
    refresh_result: {
      ok: true,
      matched_skills: [
        { name: 'worldquant-brain-knowledge-cache' },
        { name: 'worldquant-brain-sim-state' }
      ],
      active_skills: ['worldquant-brain-sim-state'],
      value: {
        active_skills: ['worldquant-brain-sim-state']
      }
    }
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /Created skill worldquant-brain-knowledge-cache/);
  assert.match(text, /Mounted on current document: worldquant-brain-sim-state/);
  assert.doesNotMatch(text, /Mounted on current document: .*worldquant-brain-knowledge-cache/);
});

test('buildResponsesSkillRegistryToolOutputContentItems 会显式提示 refresh 失败而不是伪造 mounted', async () => {
  const { buildResponsesSkillRegistryToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesSkillRegistryToolOutputContentItems({
    ok: true,
    action: 'create_skill',
    skill: {
      name: 'worldquant-brain-knowledge-cache',
      revision: 1
    },
    refreshed_current_document: true,
    refresh_result: {
      ok: false,
      matched_skills: [
        { name: 'worldquant-brain-knowledge-cache' }
      ],
      error: {
        message: 'Skill not mounted: worldquant-brain-knowledge-cache'
      }
    }
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /Current document refresh failed: Skill not mounted: worldquant-brain-knowledge-cache/);
  assert.doesNotMatch(text, /Mounted on current document:/);
});

test('buildResponsesSkillRegistryToolOutputContentItems 对 read_file 改为 shell 风格 header + 原文内容', async () => {
  const { buildResponsesSkillRegistryToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesSkillRegistryToolOutputContentItems({
    ok: true,
    action: 'read_file',
    skill: {
      name: 'skill-creator',
      file: {
        path: 'SKILL.md',
        content: 'Alpha',
        content_read: {
          mode: 'preview',
          total_chars: 5,
          returned_chars: 5
        }
      }
    }
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /^# skill-creator\/SKILL\.md \(chars 0-5\/5\)\nAlpha/m);
  assert.doesNotMatch(text, /<skill_registry_result/);
  assert.doesNotMatch(text, /<content>/);
  assert.doesNotMatch(text, /<metadata>/);
  assert.doesNotMatch(text, /"content": "Alpha"/);
});

test('buildResponsesSkillRegistryToolOutputContentItems 对带行号 read_file 只输出 numbered_content，且显式字符范围不追加截断提示', async () => {
  const { buildResponsesSkillRegistryToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesSkillRegistryToolOutputContentItems({
    ok: true,
    action: 'read_file',
    skill: {
      name: 'skill-creator',
      file: {
        path: 'SKILL.md',
        content: 'Alpha',
        numbered_content: '12 | Alpha',
        content_read: {
          mode: 'char_range',
          total_chars: 100,
          skip_chars: 11,
          max_chars: 5,
          returned_chars: 5,
          omitted_chars: 95,
          omitted_pct: '95.00',
          truncated: true,
          has_more_after_range: true
        }
      }
    }
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /^# skill-creator\/SKILL\.md \(chars 11-16\/100; more\)\n12 \| Alpha/m);
  assert.doesNotMatch(text, /<numbered_content>/);
  assert.doesNotMatch(text, /<content>/);
  assert.doesNotMatch(text, /output too long; truncated/);
});

test('buildResponsesSkillRegistryToolOutputContentItems 对 search_files 输出 rg 风格 matches 块', async () => {
  const { buildResponsesSkillRegistryToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesSkillRegistryToolOutputContentItems({
    ok: true,
    action: 'search_files',
    pattern: 'token',
    total_matches: 1,
    returned_match_count: 1,
    matches: [
      {
        match_id: 'm1',
        skill_name: 'dom-probe',
        file_path: 'src/main.js',
        line_number: 2,
        column_start: 7,
        column_end: 12,
        match_text: 'token',
        line_text: 'alpha token beta',
        before: [{ line_number: 1, text: 'before line' }],
        after: [{ line_number: 3, text: 'after line' }]
      }
    ]
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.doesNotMatch(text, /<skill_registry_result/);
  assert.doesNotMatch(text, /<matches>/);
  assert.match(text, /^dom-probe\/src\/main\.js\n1-before line\n2:7:alpha token beta\n3-after line/m);
  assert.equal((text.match(/dom-probe\/src\/main\.js/g) || []).length, 1);
  assert.doesNotMatch(text, /<match rank="1">/);
  assert.doesNotMatch(text, /"line_text": "alpha token beta"/);
});

test('buildResponsesSkillRegistryToolOutputContentItems 对 read_detail 输出说明正文和文件列表纯文本', async () => {
  const { buildResponsesSkillRegistryToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesSkillRegistryToolOutputContentItems({
    ok: true,
    action: 'read_detail',
    skill: {
      name: 'dom-probe',
      instruction: {
        path: 'SKILL.md',
        content: 'Instruction body',
        content_read: {
          mode: 'preview',
          total_chars: 16,
          returned_chars: 16
        }
      },
      files: {
        total_count: 2,
        returned_file_count: 2,
        files: [
          {
            path: 'SKILL.md',
            kind: 'instruction',
            is_instruction: true,
            size_chars: 16
          },
          {
            path: 'src/main.js',
            kind: 'runtime_source',
            size_chars: 18
          }
        ]
      }
    }
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /^# dom-probe\/SKILL\.md \(chars 0-16\/16\)\nInstruction body/m);
  assert.match(text, /Files:\nSKILL\.md  instruction  16 chars/);
  assert.match(text, /src\/main\.js  runtime_source  18 chars/);
  assert.doesNotMatch(text, /<skill_registry_result/);
  assert.doesNotMatch(text, /<files>/);
  assert.doesNotMatch(text, /<content>/);
});

test('buildResponsesSkillRegistryToolOutputContentItems 对 read_package 输出多文件原文块纯文本', async () => {
  const { buildResponsesSkillRegistryToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesSkillRegistryToolOutputContentItems({
    ok: true,
    action: 'read_package',
    skill: {
      name: 'dom-probe',
      revision: 3,
      files: {
        total_count: 2,
        returned_file_count: 2,
        files: [
          {
            path: 'SKILL.md',
            kind: 'instruction',
            content: 'Instruction body',
            content_read: {
              mode: 'preview',
              total_chars: 16,
              returned_chars: 16
            }
          },
          {
            path: 'src/main.js',
            kind: 'runtime_source',
            content: 'console.log("hi");',
            content_read: {
              mode: 'preview',
              total_chars: 18,
              returned_chars: 18
            }
          }
        ]
      }
    }
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /^# dom-probe\/SKILL\.md \(chars 0-16\/16\)\nInstruction body/m);
  assert.match(text, /^# dom-probe\/src\/main\.js \(chars 0-18\/18\)\nconsole\.log\("hi"\);/m);
  assert.match(text, /console\.log\("hi"\);/);
  assert.doesNotMatch(text, /<skill_registry_result/);
  assert.doesNotMatch(text, /<files>/);
  assert.doesNotMatch(text, /<file rank=/);
  assert.doesNotMatch(text, /<content>/);
  assert.doesNotMatch(text, /"content": "Instruction body"/);
});

test('buildResponsesSkillRegistryToolOutputContentItems 会把 mount_on_current_page 压成简洁挂载摘要', async () => {
  const { buildResponsesSkillRegistryToolOutputContentItems, formatResponsesToolOutputForDisplay } = await loadResponsesToolOutputModule();
  const items = buildResponsesSkillRegistryToolOutputContentItems({
    ok: true,
    action: 'mount_on_current_page',
    skill: {
      name: 'dom-probe',
      revision: 3
    },
    mounted_on_current_page: true,
    active_skills: ['dom-probe']
  });
  const text = formatResponsesToolOutputForDisplay(items);
  assert.match(text, /Mounted skill dom-probe on current page\./);
  assert.doesNotMatch(text, /"active_skills"/);
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
  assert.match(text, /\[\.\.\. output too long; truncated 2500 chars out of 4500 total chars \(55\.56%\); returned range \[2000, 4000\) \.\.\.\]/);
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
  assert.match(text, /output too long; truncated \d+ chars out of \d+ total chars \([\d.]+%\); returned range \[0, \d+\)/);
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
  assert.match(text, /output too long; truncated 1200 chars out of 6200 total chars \(19\.35%\); returned range \[0, 5000\)/);
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
