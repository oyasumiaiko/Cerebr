const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

test('普通 Google/Gemini thoughtsRaw 进入统一 activity 面板，pulse 不用空节点覆盖已出现的思考', async () => {
  const messageProcessorSource = await fs.readFile(path.resolve(__dirname, '../src/core/message_processor.js'), 'utf8');
  const messageSenderSource = await fs.readFile(path.resolve(__dirname, '../src/core/message_sender.js'), 'utf8');
  const timelineSource = await fs.readFile(path.resolve(__dirname, '../src/utils/assistant_activity_timeline.js'), 'utf8');

  assert.match(timelineSource, /if \(normalizeText\(node\.thoughtsRaw\)\) \{\s*return true;\s*\}/);
  assert.match(messageProcessorSource, /const responseTimeline = \(node && shouldUseActivityTimeline\)/);
  assert.match(messageProcessorSource, /setupResponseActivityTimelineDisplay\(/);
  assert.match(
    messageSenderSource,
    /const boundAssistantNode = liveMessageId[\s\S]*?resolveAttemptAiNode\(attemptState, liveMessageId\)[\s\S]*?const previewNode = boundAssistantNode[\s\S]*?\{ \.\.\.boundAssistantNode \}/,
    '预正文状态 pulse 必须继承真实 assistant 节点上的 thoughtsRaw'
  );
  assert.match(
    messageSenderSource,
    /普通 Gemini 的流式思考保存在 node\.thoughtsRaw[\s\S]*?metadata 同步会把统一思考面板误清空/,
    '代码注释应明确这条防闪烁边界'
  );
});
