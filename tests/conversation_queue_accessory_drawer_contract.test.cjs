const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('queue preview 走 composer accessory drawer 壳层，而不是裸节点直接挂载', async () => {
  const senderSource = await readWorkspaceFile('src/core/message_sender.js');
  const cssSource = await readWorkspaceFile('src/ui/styles/sidebar.css');

  assert.match(
    senderSource,
    /container\.className = 'conversation-send-queue-preview composer-accessory-drawer composer-queue-preview-panel';/
  );
  assert.match(
    senderSource,
    /function ensureConversationQueuedSendPreviewSurface\(container\) \{/
  );
  assert.match(
    senderSource,
    /surface\.className = 'conversation-send-queue-preview__surface composer-accessory-drawer-surface composer-queue-preview-surface';/
  );
  assert.match(
    senderSource,
    /const surface = ensureConversationQueuedSendPreviewSurface\(container\);\s*if \(!surface\) return;\s*[\s\S]*?surface\.textContent = '';/s
  );
  assert.match(
    senderSource,
    /surface\.appendChild\(list\);/
  );

  assert.match(
    cssSource,
    /\.conversation-send-queue-preview\s*\{[\s\S]*?pointer-events:\s*auto;/s
  );
  assert.match(
    cssSource,
    /\.conversation-send-queue-preview__surface\s*\{/
  );
  assert.match(
    cssSource,
    /\.composer-queue-preview-panel\s*\{/
  );
  assert.match(
    cssSource,
    /\.composer-queue-preview-surface\s*\{/
  );
});
