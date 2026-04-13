const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadToolOutputModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/responses_tool_output.js');
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
