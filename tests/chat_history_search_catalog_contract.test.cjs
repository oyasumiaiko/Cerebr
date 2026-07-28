const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  return fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

test('聊天全文搜索目录只读取 IndexedDB key，不复制 conversation value', async () => {
  const source = await readWorkspaceFile('src/storage/indexeddb_helper.js');
  const functionSource = source.match(/export async function getConversationSearchCatalog\(options = \{\}\) \{[\s\S]*?\n\}/)?.[0] || '';

  assert.match(functionSource, /store\.getAllKeys\(\)/);
  assert.match(functionSource, /store\.index\(indexName\)\.openKeyCursor\(\)/);
  assert.doesNotMatch(functionSource, /cursor\.value|getAll\(/);
  assert.match(functionSource, /includeUrl \? collectIndexValues\('url'\) : new Map\(\)/);
  assert.match(functionSource, /includeDate \? collectIndexValues\('startTime'\) : new Map\(\)/);
  assert.match(functionSource, /includeDate \? collectIndexValues\('endTime'\) : new Map\(\)/);
});

test('聊天历史 UI 的全文搜索使用轻量目录且不再空闲预热全量元数据', async () => {
  const source = await readWorkspaceFile('src/ui/chat_history_ui.js');

  assert.match(source, /baseHistories = await getConversationSearchCatalog\(\{[\s\S]*?includeUrl:[\s\S]*?includeDate:[\s\S]*?\}\);/s);
  assert.doesNotMatch(source, /scheduleConversationMetadataWarmup/);
  assert.doesNotMatch(source, /getConversationSearchProjectionsByIds|canConversationSearchProjectionMatch/);
});
