const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadSidebarAppContextSource() {
  const filePath = path.resolve(__dirname, '../src/ui/sidebar/sidebar_app_context.js');
  return fs.readFile(filePath, 'utf8');
}

test('request_user_input 的 other 输入框使用 textarea，保留 Enter 确认并允许 Shift+Enter 换行', async () => {
  const source = await loadSidebarAppContextSource();

  assert.match(
    source,
    /const otherInput = document\.createElement\('textarea'\);/
  );
  assert.doesNotMatch(
    source,
    /const otherInput = document\.createElement\('input'\);/
  );
  assert.match(
    source,
    /otherInput\.addEventListener\('keydown', \(event\) => \{\s*if \(event\.key === 'Enter' && !event\.shiftKey && !event\.altKey && !event\.ctrlKey && !event\.metaKey\) \{\s*event\.preventDefault\(\);\s*handlePrimaryAction\(\);/s
  );
  assert.match(
    source,
    /const syncOtherInputHeight = \(\) => \{[\s\S]*?otherInput\.style\.height = 'auto';[\s\S]*?otherInput\.style\.height = `\$\{Math\.max\(otherInput\.scrollHeight, 0\)\}px`;/s
  );
  assert.doesNotMatch(
    source,
    /document\.addEventListener\('keydown', onKeyDown, true\)/
  );
  assert.doesNotMatch(
    source,
    /removeKeyListener = \(\) => document\.removeEventListener\('keydown', onKeyDown, true\)/
  );
});
