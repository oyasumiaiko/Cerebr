const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  return fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

test('内嵌侧栏的文本和图片复制统一通过宿主页剪贴板通道', async () => {
  const [appContextSource, contentSource, documentViewerSource, contextMenuSource] = await Promise.all([
    readWorkspaceFile('src/ui/sidebar/sidebar_app_context.js'),
    readWorkspaceFile('src/extension/content.js'),
    readWorkspaceFile('src/utils/conversation_document_viewer.js'),
    readWorkspaceFile('src/ui/context_menu_manager.js')
  ]);

  assert.match(appContextSource, /appContext\.utils\.writeClipboardText = \(text\) => writeClipboard\(\{ text:/);
  assert.match(appContextSource, /appContext\.utils\.copyImageToHostClipboard = \(blob\) => writeClipboard\(\{ blob \}\)/);
  assert.match(contentSource, /case 'WRITE_CLIPBOARD':[\s\S]*?navigator\.clipboard\.writeText\(data\.text\)[\s\S]*?navigator\.clipboard\.write/);
  assert.match(documentViewerSource, /await writeClipboardText\(result\.file\.content \|\| ''\)/);
  assert.doesNotMatch(documentViewerSource, /navigator\.clipboard/);
  assert.match(contextMenuSource, /await utils\.writeClipboardText\(originalText\)/);
  assert.match(contextMenuSource, /await utils\.writeClipboardText\(codeContent\)/);
});
