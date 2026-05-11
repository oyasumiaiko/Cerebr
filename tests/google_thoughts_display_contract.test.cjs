const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

test('普通 Google thoughtsRaw 保持 legacy thoughts 面板，不被 metadata 同步刷成空 activity', async () => {
  const source = await fs.readFile(path.resolve(__dirname, '../src/core/message_processor.js'), 'utf8');

  assert.match(source, /shouldRenderAssistantActivityTimeline\(node\)/);
  assert.match(source, /const legacyThoughtsRaw = \(!shouldUseActivityTimeline && typeof node\?\.thoughtsRaw === 'string'\)/);
  assert.match(source, /const responseTimeline = \(node && shouldUseActivityTimeline\)/);
  assert.match(source, /setupThoughtsDisplay\(messageWrapperDiv, legacyThoughtsRaw, processMathAndMarkdown\)/);
});
