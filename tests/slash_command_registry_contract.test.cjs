const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('slash command registry 移除了 help，并把 new 设为用户可见的新对话命令', async () => {
  const source = await readWorkspaceFile('src/core/message_sender.js');

  assert.doesNotMatch(source, /name:\s*'help'/);
  assert.doesNotMatch(source, /usage:\s*'\/help'/);
  assert.match(
    source,
    /name:\s*'new'[\s\S]*?aliases:\s*\['clear', 'cls'\][\s\S]*?usage:\s*'\/new'[\s\S]*?description:\s*'开始新对话'/s
  );
  assert.doesNotMatch(source, /name:\s*name\s*\|\|\s*'help'/);
  assert.match(
    source,
    /if\s*\(!body\)\s*\{\s*return\s*\{\s*type:\s*'command',\s*name:\s*'',\s*args:\s*\[\],\s*raw:\s*trimmed,\s*argsText:\s*''\s*\};\s*\}/s
  );
});

test('slash command 默认菜单按真实命令名字母顺序排序，不按 api alias 排', async () => {
  const source = await readWorkspaceFile('src/core/message_sender.js');

  assert.match(source, /function sortSlashCommandsForMenu\(commands\) \{/);
  assert.match(source, /leftName\.localeCompare\(rightName, 'en', \{ sensitivity: 'base' \}\)/);
  assert.match(source, /return sortSlashCommandsForMenu\(slashCommandRegistry\)\.map\(\(item\) => \(\{/);
  assert.match(source, /const registry = sortSlashCommandsForMenu\(slashCommandRegistry\);/);
});

test('slash command 空命令和未知命令提示不再依赖 help', async () => {
  const source = await readWorkspaceFile('src/core/message_sender.js');

  assert.match(source, /showNotification\(\{ message: '请输入或选择一个斜杠命令', type: 'info' \}\);/);
  assert.match(source, /showNotification\(\{ message: `未知命令：\/\$\{normalized\}，输入 \/ 打开命令菜单`, type: 'warning' \}\);/);
});
