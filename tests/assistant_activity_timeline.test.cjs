const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadModule() {
  const modulePath = path.resolve(__dirname, '../src/utils/assistant_activity_timeline.js');
  return import(pathToFileURL(modulePath).href);
}

test('thoughtsRaw 会被映射为 commentary entry', async () => {
  const { getAssistantActivityTimeline } = await loadModule();
  const timeline = getAssistantActivityTimeline({
    thoughtsRaw: '  传统思考内容  '
  });

  assert.deepEqual(timeline, [{
    kind: 'commentary',
    id: 'legacy_thoughts',
    status: 'completed',
    text: '传统思考内容'
  }]);
});

test('legacy reasoning summary 与 tool calls 会被保留到统一 timeline', async () => {
  const { getAssistantActivityTimeline } = await loadModule();
  const timeline = getAssistantActivityTimeline({
    response_reasoning_summary: 'summary text',
    response_tool_calls: [
      { id: 'tool_1', type: 'function_call', name: 'foo', status: 'completed' }
    ]
  });

  assert.deepEqual(timeline, [
    {
      kind: 'reasoning_summary',
      id: 'legacy_reasoning_summary',
      status: 'completed',
      text: 'summary text'
    },
    {
      kind: 'tool_call',
      id: 'tool_1',
      type: 'function_call',
      name: 'foo',
      status: 'completed'
    }
  ]);
});

test('存在 commentary 时会过滤 reasoning_summary，避免双份思考文案', async () => {
  const { getAssistantActivityTimeline } = await loadModule();
  const timeline = getAssistantActivityTimeline({
    thoughtsRaw: 'full thoughts',
    response_reasoning_summary: 'summary text'
  });

  assert.deepEqual(timeline, [{
    kind: 'commentary',
    id: 'legacy_thoughts',
    status: 'completed',
    text: 'full thoughts'
  }]);
});

test('response_activity_timeline 优先于 legacy 字段', async () => {
  const { getAssistantActivityTimeline } = await loadModule();
  const timeline = getAssistantActivityTimeline({
    thoughtsRaw: 'legacy thoughts',
    response_activity_timeline: [
      { kind: 'commentary', id: 'resp_commentary', status: 'streaming', text: 'responses commentary' }
    ]
  });

  assert.deepEqual(timeline, [
    { kind: 'commentary', id: 'resp_commentary', status: 'streaming', text: 'responses commentary' }
  ]);
});
