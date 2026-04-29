const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readRepoFile(relativePath) {
  return fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

function extractFunctionBody(source, functionName) {
  const needle = `function ${functionName}`;
  const start = source.indexOf(needle);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, `${functionName} should have a body`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open + 1, index);
      }
    }
  }
  assert.fail(`${functionName} body should close`);
}

test('content script creates embedded sidebar iframes with explicit instanceId query', async () => {
  const source = await readRepoFile('src/extension/content.js');

  assert.match(source, /class CerebrSidebarManager/);
  assert.match(source, /generateInstanceId\(\)/);
  assert.match(
    source,
    /sidebar\.html\?instanceId=\$\{encodeURIComponent\(this\.instanceId\)\}/
  );
  assert.match(source, /case 'CREATE_ADDITIONAL_SIDEBAR':/);
});

test('sidebar app context reads instanceId without using shared storage', async () => {
  const source = await readRepoFile('src/ui/sidebar/sidebar_app_context.js');

  assert.match(source, /function resolveSidebarInstanceIdFromLocation\(\)/);
  assert.match(source, /sidebarInstanceId: resolveSidebarInstanceIdFromLocation\(\)/);

  const body = extractFunctionBody(source, 'resolveSidebarInstanceIdFromLocation');
  assert.match(body, /searchParams\.get\('instanceId'\)/);
  assert.doesNotMatch(body, /localStorage|sessionStorage|chrome\.storage/);
});

test('host page tool requests carry sidebarInstanceId through sender and background relay', async () => {
  const messageSenderSource = await readRepoFile('src/core/message_sender.js');
  const sidebarEventsSource = await readRepoFile('src/ui/sidebar/sidebar_events.js');
  const backgroundSource = await readRepoFile('src/extension/background.js');

  assert.match(messageSenderSource, /GET_PAGE_CONTENT_READ_RESULT_FROM_SIDEBAR[\s\S]*sidebarInstanceId: typeof state\?\.sidebarInstanceId === 'string'/);
  assert.match(messageSenderSource, /GET_PDF_CONTENT_READ_RESULT_FROM_SIDEBAR[\s\S]*sidebarInstanceId: typeof state\?\.sidebarInstanceId === 'string'/);
  assert.match(messageSenderSource, /GET_WEBPAGE_SCREENSHOT_RESULT_FROM_SIDEBAR[\s\S]*sidebarInstanceId: typeof state\?\.sidebarInstanceId === 'string'/);
  assert.match(sidebarEventsSource, /GET_PAGE_CONTENT_READ_RESULT_FROM_SIDEBAR[\s\S]*sidebarInstanceId: appContext\.state\.sidebarInstanceId/);
  assert.match(backgroundSource, /GET_PAGE_CONTENT_READ_RESULT_INTERNAL[\s\S]*sidebarInstanceId: typeof message\?\.sidebarInstanceId === 'string'/);
  assert.match(backgroundSource, /GET_PDF_CONTENT_READ_RESULT_INTERNAL[\s\S]*sidebarInstanceId: typeof message\?\.sidebarInstanceId === 'string'/);
  assert.match(backgroundSource, /GET_WEBPAGE_SCREENSHOT_RESULT_INTERNAL[\s\S]*sidebarInstanceId: typeof message\?\.sidebarInstanceId === 'string'/);
});

