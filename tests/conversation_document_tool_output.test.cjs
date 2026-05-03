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
      added: ['workspace/a.md'],
      modified: ['workspace/b.md'],
      deleted: ['workspace/c.md']
    }
  });

  const text = items.map(item => item.text).join('\n');
  assert.match(text, /A workspace\/a\.md/);
  assert.match(text, /M workspace\/b\.md/);
  assert.match(text, /D workspace\/c\.md/);
  assert.doesNotMatch(text, /<apply_patch_result/);
});

test('read_file 的对话文档工具输出会改成 shell 风格 header + 原文内容', async () => {
  const { buildResponsesConversationDocumentToolOutputContentItems } = await loadToolOutputModule();

  const items = buildResponsesConversationDocumentToolOutputContentItems('read_file', {
    ok: true,
    conversation_id: 'conv-1',
    file: {
      path: 'workspace/spec.md',
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
  assert.match(text, /^# workspace\/spec\.md \(chars 0-11\/11\)\nhello/m);
  assert.match(text, /world/);
  assert.doesNotMatch(text, /<read_file_result/);
  assert.doesNotMatch(text, /<content>/);
  assert.doesNotMatch(text, /<metadata>/);
  assert.doesNotMatch(text, /"content": "hello\\nworld"/);
});

test('read_file 带行号时只输出 numbered_content，且显式行范围读取不追加截断提示', async () => {
  const { buildResponsesConversationDocumentToolOutputContentItems } = await loadToolOutputModule();

  const items = buildResponsesConversationDocumentToolOutputContentItems('read_file', {
    ok: true,
    conversation_id: 'conv-1',
    file: {
      path: 'workspace/spec.md',
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
  assert.match(text, /^# workspace\/spec\.md \(lines 2-3\/4; more\)\n2 \| line2/m);
  assert.doesNotMatch(text, /<numbered_content>/);
  assert.doesNotMatch(text, /<content>/);
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
        path: 'workspace/a.md',
        size_chars: 10,
        updated_at: '2026-04-14T10:00:00.000Z'
      },
      {
        path: 'workspace/b.md',
        size_chars: 20,
        updated_at: '2026-04-14T10:05:00.000Z'
      }
    ]
  });

  const text = items.map(item => item.text).join('\n');
  assert.doesNotMatch(text, /<list_files_result/);
  assert.doesNotMatch(text, /<files>/);
  assert.match(text, /workspace\/a\.md  10 chars/);
  assert.match(text, /workspace\/b\.md  20 chars/);
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
        file_path: 'workspace/spec.md',
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
  assert.doesNotMatch(text, /<search_files_result/);
  assert.doesNotMatch(text, /<matches>/);
  assert.match(text, /workspace\/spec\.md-1-before line/);
  assert.match(text, /workspace\/spec\.md:2:7:alpha token beta/);
  assert.match(text, /workspace\/spec\.md-3-after line/);
  assert.doesNotMatch(text, /<match rank="1">/);
  assert.doesNotMatch(text, /"before": \[/);
});

test('copy_file/move_file/delete_file 的对话文档工具输出会压成单行操作摘要', async () => {
  const { buildResponsesConversationDocumentToolOutputContentItems } = await loadToolOutputModule();

  const copyItems = buildResponsesConversationDocumentToolOutputContentItems('copy_file', {
    ok: true,
    action: 'copy_file',
    target: { kind: 'workspace' },
    source_path: 'local/project/src/a.js',
    destination_path: 'workspace/project/src/a.js'
  });
  const copyText = copyItems.map(item => item.text).join('\n');
  assert.doesNotMatch(copyText, /<copy_file_result/);
  assert.match(copyText, /copy local\/project\/src\/a\.js -> workspace\/project\/src\/a\.js/);
  assert.match(copyText, /Reminder: /);
  assert.doesNotMatch(copyText, /"source_path"/);

  const moveItems = buildResponsesConversationDocumentToolOutputContentItems('move_file', {
    ok: true,
    action: 'move_file',
    target: { kind: 'skill', name: 'dom-probe' },
    source_path: 'references/old.md',
    destination_path: 'references/new.md',
    skill: { name: 'dom-probe' }
  });
  const moveText = moveItems.map(item => item.text).join('\n');
  assert.doesNotMatch(moveText, /<move_file_result/);
  assert.match(moveText, /move references\/old\.md -> references\/new\.md/);
  assert.doesNotMatch(moveText, /Reminder:/);

  const deleteItems = buildResponsesConversationDocumentToolOutputContentItems('delete_file', {
    ok: true,
    action: 'delete_file',
    deleted_path: 'workspace/project/src/a.js'
  });
  const deleteText = deleteItems.map(item => item.text).join('\n');
  assert.doesNotMatch(deleteText, /<delete_file_result/);
  assert.match(deleteText, /delete workspace\/project\/src\/a\.js/);
});

test('对话文档文件工具失败时也保持纯文本错误输出', async () => {
  const { buildResponsesConversationDocumentToolOutputContentItems } = await loadToolOutputModule();

  const readItems = buildResponsesConversationDocumentToolOutputContentItems('read_file', {
    ok: false,
    error: '文件不存在'
  });
  const readText = readItems.map(item => item.text).join('\n');
  assert.match(readText, /Error: 文件不存在/);
  assert.doesNotMatch(readText, /<read_file_result|<error>/);

  const patchItems = buildResponsesConversationDocumentToolOutputContentItems('apply_patch', {
    ok: false,
    error: 'patch failed'
  });
  const patchText = patchItems.map(item => item.text).join('\n');
  assert.match(patchText, /Error: patch failed/);
  assert.doesNotMatch(patchText, /<apply_patch_result|<error>/);
});
