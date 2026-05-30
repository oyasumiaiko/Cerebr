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

test('response_activity_timeline 中的 steer entry 会被原样保留', async () => {
  const { getAssistantActivityTimeline } = await loadModule();
  const timeline = getAssistantActivityTimeline({
    response_activity_timeline: [
      { kind: 'steer', id: 'steer_1', status: 'pending', count: 2, text: '1. 请转向到新的约束\n2. 请优先看最新工具输出' },
      { kind: 'reasoning_summary', id: 'reasoning_1', status: 'completed', text: 'summary text' }
    ]
  });

  assert.deepEqual(timeline, [
    { kind: 'steer', id: 'steer_1', status: 'pending', count: 2, text: '1. 请转向到新的约束\n2. 请优先看最新工具输出' },
    { kind: 'reasoning_summary', id: 'reasoning_1', status: 'completed', text: 'summary text' }
  ]);
});

test('纯 thoughtsRaw 会要求 UI 使用统一 response_activity 面板', async () => {
  const { shouldRenderAssistantActivityTimeline } = await loadModule();

  assert.equal(shouldRenderAssistantActivityTimeline({
    thoughtsRaw: '普通 Google 流式思考'
  }), true);
});

test('显式 Responses timeline 与 legacy reasoning/tool 字段会要求 UI 使用 activity 面板', async () => {
  const { shouldRenderAssistantActivityTimeline } = await loadModule();

  assert.equal(shouldRenderAssistantActivityTimeline({
    response_activity_timeline: [
      { kind: 'commentary', id: 'resp_commentary', status: 'streaming', text: 'responses commentary' }
    ]
  }), true);
  assert.equal(shouldRenderAssistantActivityTimeline({
    response_reasoning_summary: 'summary text'
  }), true);
  assert.equal(shouldRenderAssistantActivityTimeline({
    response_tool_calls: [
      { id: 'tool_1', type: 'function_call', name: 'foo', status: 'completed' }
    ]
  }), true);
});
