const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('indexeddb_helper 已创建 conversation_documents store 并在删除会话时级联清理', async () => {
  const source = await readWorkspaceFile('src/storage/indexeddb_helper.js');

  assert.match(source, /indexedDB\.open\('ChatHistoryDB', 4\)/);
  assert.match(source, /const CONVERSATION_DOCUMENT_STORE = 'conversation_documents';/);
  assert.match(source, /db\.createObjectStore\(CONVERSATION_DOCUMENT_STORE, \{\s*keyPath: \['conversation_id', 'path'\]/s);
  assert.match(source, /const transaction = db\.transaction\(\['conversations', CONVERSATION_DOCUMENT_STORE\], 'readwrite'\);/);
  assert.match(source, /const index = documentStore\.index\('conversation_id'\);/);
});
