const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadSearchModule() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cerebr-chat-search-projection-'));
  await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  const targetPath = path.join(tempDir, 'chat_history_search_shared.js');
  await fs.copyFile(
    path.resolve(__dirname, '../src/utils/chat_history_search_shared.js'),
    targetPath
  );
  return import(pathToFileURL(targetPath).href);
}

test('聊天搜索投影只保留可搜索正文并按调用方决定是否包含隐藏线程占位', async () => {
  const { buildConversationSearchProjection } = await loadSearchModule();
  const conversation = {
    id: 'conv_projection',
    messages: [
      { id: 'm1', content: 'Visible Alpha', toolOutput: 'internal-secret' },
      { id: 'm2', content: 'Hidden Beta', threadHiddenSelection: true },
      { id: 'm3', content: [{ type: 'text', text: 'Image context' }, { type: 'image_url' }] }
    ]
  };

  const visibleOnly = buildConversationSearchProjection(conversation);
  assert.equal(visibleOnly.id, 'conv_projection');
  assert.match(visibleOnly.textLower, /visible alpha/);
  assert.match(visibleOnly.textLower, /image context \[图片\]/);
  assert.doesNotMatch(visibleOnly.textLower, /hidden beta|internal-secret/);

  const withHidden = buildConversationSearchProjection(
    conversation,
    { includeHiddenThreadSelection: true }
  );
  assert.match(withHidden.textLower, /hidden beta/);
});

test('session scope 投影可提前排除缺少正向词或命中否定词的会话', async () => {
  const {
    buildChatHistorySearchPlan,
    buildChatHistoryTextPlan,
    canConversationSearchProjectionMatch
  } = await loadSearchModule();
  const textPlan = buildChatHistoryTextPlan(buildChatHistorySearchPlan('alpha beta !blocked'));

  assert.equal(
    canConversationSearchProjectionMatch({ textLower: 'alpha beta clean' }, textPlan),
    true
  );
  assert.equal(
    canConversationSearchProjectionMatch({ textLower: 'alpha only' }, textPlan),
    false
  );
  assert.equal(
    canConversationSearchProjectionMatch({ textLower: 'alpha beta blocked' }, textPlan),
    false
  );
});

test('message scope 投影只做无假阴性的粗筛，最终仍由完整消息规则确认', async () => {
  const {
    buildChatHistorySearchPlan,
    buildChatHistoryTextPlan,
    buildConversationSearchProjection,
    canConversationSearchProjectionMatch,
    scanConversationMessagesForSearch
  } = await loadSearchModule();
  const conversation = {
    id: 'conv_message_scope',
    messages: [
      { id: 'm1', content: 'alpha clean' },
      { id: 'm2', content: 'beta blocked' }
    ]
  };
  const textPlan = buildChatHistoryTextPlan(buildChatHistorySearchPlan('scope:message alpha !blocked'));
  const projection = buildConversationSearchProjection(conversation);

  assert.equal(canConversationSearchProjectionMatch(projection, textPlan), true);
  assert.equal(
    scanConversationMessagesForSearch(conversation, textPlan, null).matched,
    true
  );
});
