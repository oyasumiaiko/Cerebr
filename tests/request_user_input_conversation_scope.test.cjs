const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('request_user_input 使用按会话隔离的 session registry，并在会话切换/清空时重置 composer 辅助区', async () => {
  const sidebarAppContextSource = await readWorkspaceFile('src/ui/sidebar/sidebar_app_context.js');
  const chatHistoryUiSource = await readWorkspaceFile('src/ui/chat_history_ui.js');

  assert.match(
    sidebarAppContextSource,
    /const requestUserInputSessionsByConversationKey = new Map\(\);/
  );
  assert.match(
    sidebarAppContextSource,
    /appContext\.utils\.resetConversationScopedComposerState = \(options = \{\}\) => \{/
  );
  assert.match(
    sidebarAppContextSource,
    /const existingSession = requestUserInputSessionsByConversationKey\.get\(conversationKey\) \|\| null;/
  );
  assert.match(
    sidebarAppContextSource,
    /mountRequestUserInputSession\(existingSession\);\s*return existingSession\.promise;/
  );
  assert.match(
    sidebarAppContextSource,
    /if \(activeRequestUserInputSession && activeRequestUserInputSession !== existingSession\) \{\s*unmountRequestUserInputSession\(activeRequestUserInputSession\);/s
  );

  const resetCallMatches = chatHistoryUiSource.match(/utils\.resetConversationScopedComposerState\?\.\(\{ preservePendingRequestUserInput: true \}\);/g) || [];
  assert.equal(resetCallMatches.length, 2);
});
