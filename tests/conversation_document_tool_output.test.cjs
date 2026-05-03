const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadToolOutputModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/shared/responses_tool_output.js');
  return import(`${pathToFileURL(filePath).href}?test=${Date.now()}`);
}

test('apply_patch 的对话文档工具输出会压成简洁变更摘要', async () => {
  const { buildResponsesConversationDocumentToolOutputContentItems } = await loadToolOutputModule();

  const items = buildResponsesConversationDocumentToolOutputContentItems('apply_patch', {
    ok: true,
    affected_files: {
      added: ['docs/a.md'],
      modified: ['docs/b.md'],
      deleted: ['docs/c.md']
    }
  });

  const text = items.map(item => item.text).join('\n');
  assert.match(text, /apply_patch_result/);
  assert.match(text, /A docs\/a\.md/);
  assert.match(text, /M docs\/b\.md/);
  assert.match(text, /D docs\/c\.md/);
});

test('read_file 的对话文档工具输出会把定位信息压到属性并只保留原文 content 块', async () => {
  const { buildResponsesConversationDocumentToolOutputContentItems } = await loadToolOutputModule();

  const items = buildResponsesConversationDocumentToolOutputContentItems('read_file', {
    ok: true,
    conversation_id: 'conv-1',
    file: {
      path: 'docs/spec.md',
      updated_at: '2026-04-14T10:00:00.000Z',
      size_chars: 11,
      content: 'hello\nworld',
      content_read: {
        mode: 'preview',
        total_chars: 11,
        returned_chars: 11
      }
    }
  });

  const text = items.map(item => item.text).join('\n');
  assert.match(text, /<read_file_result ok="true" target="conversation_document" path="docs\/spec\.md" range="chars 0-11\/11">/);
  assert.match(text, /<content>\s*hello/);
  assert.doesNotMatch(text, /<metadata>/);
  assert.doesNotMatch(text, /"content": "hello\\nworld"/);
});

test('read_file 带行号时只输出 numbered_content，且显式行范围读取不追加截断提示', async () => {
  const { buildResponsesConversationDocumentToolOutputContentItems } = await loadToolOutputModule();

  const items = buildResponsesConversationDocumentToolOutputContentItems('read_file', {
    ok: true,
    conversation_id: 'conv-1',
    file: {
      path: 'docs/spec.md',
      updated_at: '2026-04-14T10:00:00.000Z',
      size_chars: 17,
      content: 'line2\nline3',
      numbered_content: '2 | line2\n3 | line3',
      content_read: {
        mode: 'line_range',
        total_chars: 17,
        total_lines: 4,
        start_line: 2,
        end_line: 3,
        returned_line_count: 2,
        returned_chars: 11,
        omitted_chars: 6,
        omitted_pct: '35.29',
        truncated: true,
        has_more_after_range: true
      }
    }
  });

  const text = items.map(item => item.text).join('\n');
  assert.match(text, /<numbered_content>\s*2 \| line2/);
  assert.doesNotMatch(text, /<content>\s*line2/);
  assert.doesNotMatch(text, /output too long; truncated/);
});

test('list_files 的对话文档工具输出会把文件列表压成低噪声纯文本行', async () => {
  const { buildResponsesConversationDocumentToolOutputContentItems } = await loadToolOutputModule();

  const items = buildResponsesConversationDocumentToolOutputContentItems('list_files', {
    ok: true,
    conversation_id: 'conv-2',
    total_files: 2,
    returned_file_count: 2,
    files: [
      {
        path: 'docs/a.md',
        size_chars: 10,
        updated_at: '2026-04-14T10:00:00.000Z'
      },
      {
        path: 'docs/b.md',
        size_chars: 20,
        updated_at: '2026-04-14T10:05:00.000Z'
      }
    ]
  });

  const text = items.map(item => item.text).join('\n');
  assert.match(text, /<list_files_result ok="true" target="conversation_document" total="2" returned="2">/);
  assert.match(text, /<files>/);
  assert.match(text, /docs\/a\.md  10 chars/);
  assert.match(text, /docs\/b\.md  20 chars/);
  assert.doesNotMatch(text, /updated_at=/);
  assert.doesNotMatch(text, /"files": \[/);
});

test('search_files 的对话文档工具输出会把命中上下文渲染成 rg 风格行', async () => {
  const { buildResponsesConversationDocumentToolOutputContentItems } = await loadToolOutputModule();

  const items = buildResponsesConversationDocumentToolOutputContentItems('search_files', {
    ok: true,
    conversation_id: 'conv-3',
    pattern: 'token',
    total_matches: 1,
    returned_match_count: 1,
    matches: [
      {
        match_id: 'm1',
        file_path: 'docs/spec.md',
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

  const text = items.map(item => item.text).join('\n');
  assert.match(text, /<search_files_result ok="true" target="conversation_document" pattern="token" total="1" returned="1">/);
  assert.match(text, /<matches>/);
  assert.match(text, /docs\/spec\.md-1-before line/);
  assert.match(text, /docs\/spec\.md:2:7:alpha token beta/);
  assert.match(text, /docs\/spec\.md-3-after line/);
  assert.doesNotMatch(text, /<match rank="1">/);
  assert.doesNotMatch(text, /"before": \[/);
});
