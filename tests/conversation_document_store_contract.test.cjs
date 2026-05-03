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

  assert.match(source, /indexedDB\.open\('ChatHistoryDB', 5\)/);
  assert.match(source, /const CONVERSATION_DOCUMENT_STORE = 'conversation_documents';/);
  assert.match(source, /const LOCAL_FILE_MOUNT_STORE = 'local_file_mounts';/);
  assert.match(source, /db\.createObjectStore\(CONVERSATION_DOCUMENT_STORE, \{\s*keyPath: \['conversation_id', 'path'\]/s);
  assert.match(source, /db\.createObjectStore\(LOCAL_FILE_MOUNT_STORE, \{\s*keyPath: \['conversation_id', 'mount_path'\]/s);
  assert.match(source, /const transaction = db\.transaction\(\['conversations', CONVERSATION_DOCUMENT_STORE, LOCAL_FILE_MOUNT_STORE\], 'readwrite'\);/);
  assert.match(source, /const index = documentStore\.index\('conversation_id'\);/);
  assert.match(source, /const localIndex = localMountStore\.index\('conversation_id'\);/);
});

test('conversation_document_store 会在发起请求前先绑定 transaction 完成监听，避免错过 oncomplete', async () => {
  const source = await readWorkspaceFile('src/storage/conversation_document_store.js');

  assert.match(
    source,
    /const transaction = db\.transaction\(CONVERSATION_DOCUMENT_STORE, 'readonly'\);[\s\S]*?const donePromise = transactionDone\(transaction\);[\s\S]*?await collectDocumentsByConversationId\(store, conversationId\);[\s\S]*?await donePromise;/s
  );
  assert.match(
    source,
    /const transaction = db\.transaction\(CONVERSATION_DOCUMENT_STORE, 'readonly'\);[\s\S]*?const donePromise = transactionDone\(transaction\);[\s\S]*?await requestToPromise\(store\.get\(\[String\(conversationId \|\| ''\), String\(path \|\| ''\)\]\)\);[\s\S]*?await donePromise;/s
  );
});
