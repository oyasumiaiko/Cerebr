const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('上下文菜单的异步动作会先关闭菜单再继续执行', async () => {
  const source = await readWorkspaceFile('src/ui/context_menu_manager.js');

  assert.match(
    source,
    /async function copyMessageContent\(\) \{\s*const messageElement = currentMessageElement;[\s\S]*?hideContextMenu\(\);\s*await utils\.writeClipboardText\(originalText\)/s
  );
  assert.match(
    source,
    /async function copyCodeContent\(\) \{\s*const codeBlock = currentCodeBlock;[\s\S]*?hideContextMenu\(\);\s*await utils\.writeClipboardText\(codeContent\)/s
  );
  assert.match(
    source,
    /async function regenerateMessage\(targetMessageElement = null, apiOverride = null\) \{[\s\S]*?const baseElement = elementArg \|\| currentMessageElement;\s*hideContextMenu\(\);/s
  );
  assert.match(
    source,
    /async function copyMessageAsImage\(\) \{\s*const messageElement = currentMessageElement;[\s\S]*?const originalText = copyAsImageButton\.innerHTML;\s*hideContextMenu\(\);/s
  );
  assert.match(
    source,
    /clearChatContextButton\.addEventListener\(MENU_ACTIVATE_EVENT, async \(\) => \{\s*hideContextMenu\(\);\s*await clearChatHistory\(\);/s
  );
});
