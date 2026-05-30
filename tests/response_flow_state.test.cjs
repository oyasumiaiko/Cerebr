const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadResponseFlowStateModule() {
  const filePath = path.resolve(__dirname, '../src/core/response_flow_state.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('resolveResponseHandlingMode uses stream for Gemini by default', async () => {
  const { resolveResponseHandlingMode } = await loadResponseFlowStateModule();
  const mode = resolveResponseHandlingMode({ apiBase: 'genai' });
  assert.equal(mode, 'stream');
});

test('resolveResponseHandlingMode honors Gemini useStreaming=false', async () => {
  const { resolveResponseHandlingMode } = await loadResponseFlowStateModule();
  const mode = resolveResponseHandlingMode({ apiBase: 'genai', geminiUseStreaming: false });
  assert.equal(mode, 'non_stream');
});

test('resolveResponseHandlingMode follows requestBody.stream for non-Gemini APIs', async () => {
  const { resolveResponseHandlingMode } = await loadResponseFlowStateModule();

  assert.equal(
    resolveResponseHandlingMode({
      apiBase: 'https://api.openai.com/v1/chat/completions',
      requestBodyStream: true
    }),
    'stream'
  );

  assert.equal(
    resolveResponseHandlingMode({
      apiBase: 'https://api.openai.com/v1/chat/completions',
      requestBodyStream: false
    }),
    'non_stream'
  );
});

test('resolveResponseHandlingMode treats openai_responses as stream-gated by requestBody.stream', async () => {
  const { resolveResponseHandlingMode } = await loadResponseFlowStateModule();

  assert.equal(
    resolveResponseHandlingMode({
      apiBase: 'https://api.openai.com/v1/responses',
      connectionType: 'openai_responses',
      requestBodyStream: true
    }),
    'stream'
  );

  assert.equal(
    resolveResponseHandlingMode({
      apiBase: 'https://api.openai.com/v1/responses',
      connectionType: 'openai_responses',
      requestBodyStream: false
    }),
    'non_stream'
  );
});

test('planStreamingRenderTransition keeps state on noop events', async () => {
  const { planStreamingRenderTransition } = await loadResponseFlowStateModule();

  const result = planStreamingRenderTransition({
    hasDelta: false,
    hasStartedResponse: true,
    hasMessageId: true,
    hasAnswerContent: true,
    hasEverShownAnswerContent: true
  });

  assert.deepEqual(result, {
    action: 'noop',
    forceUiUpdate: false,
    nextState: {
      hasStartedResponse: true,
      hasEverShownAnswerContent: true
    }
  });
});

test('planStreamingRenderTransition enters first_chunk on first visible delta', async () => {
  const { planStreamingRenderTransition } = await loadResponseFlowStateModule();

  const result = planStreamingRenderTransition({
    hasDelta: true,
    hasStartedResponse: false,
    hasMessageId: false,
    hasAnswerContent: false,
    hasEverShownAnswerContent: false
  });

  assert.deepEqual(result, {
    action: 'first_chunk',
    forceUiUpdate: false,
    nextState: {
      hasStartedResponse: true,
      hasEverShownAnswerContent: false
    }
  });
});

test('planStreamingRenderTransition waits when no message target is available after start', async () => {
  const { planStreamingRenderTransition } = await loadResponseFlowStateModule();

  const result = planStreamingRenderTransition({
    hasDelta: true,
    hasStartedResponse: true,
    hasMessageId: false,
    hasAnswerContent: true,
    hasEverShownAnswerContent: false
  });

  assert.deepEqual(result, {
    action: 'wait_for_message',
    forceUiUpdate: false,
    nextState: {
      hasStartedResponse: true,
      hasEverShownAnswerContent: true
    }
  });
});

test('planStreamingRenderTransition triggers forced update when answer appears first time', async () => {
  const { planStreamingRenderTransition } = await loadResponseFlowStateModule();

  const result = planStreamingRenderTransition({
    hasDelta: true,
    hasStartedResponse: true,
    hasMessageId: true,
    hasAnswerContent: true,
    hasEverShownAnswerContent: false
  });

  assert.deepEqual(result, {
    action: 'update_existing',
    forceUiUpdate: true,
    nextState: {
      hasStartedResponse: true,
      hasEverShownAnswerContent: true
    }
  });
});

test('planStreamingRenderTransition skips forced update once answer has appeared', async () => {
  const { planStreamingRenderTransition } = await loadResponseFlowStateModule();

  const result = planStreamingRenderTransition({
    hasDelta: true,
    hasStartedResponse: true,
    hasMessageId: true,
    hasAnswerContent: true,
    hasEverShownAnswerContent: true
  });

  assert.deepEqual(result, {
    action: 'update_existing',
    forceUiUpdate: false,
    nextState: {
      hasStartedResponse: true,
      hasEverShownAnswerContent: true
    }
  });
});

test('resolveResponsesStreamClosureAction retries only before visible progress', async () => {
  const { resolveResponsesStreamClosureAction } = await loadResponseFlowStateModule();

  assert.equal(
    resolveResponsesStreamClosureAction({
      hasTerminalEvent: false,
      hasStartedResponse: false,
      hasRenderedAssistantMessage: false,
      hasVisibleAnswerContent: false
    }),
    'retry'
  );

  assert.equal(
    resolveResponsesStreamClosureAction({
      hasTerminalEvent: false,
      hasStartedResponse: true,
      hasRenderedAssistantMessage: true,
      hasVisibleAnswerContent: false
    }),
    'preserve_partial'
  );

  assert.equal(
    resolveResponsesStreamClosureAction({
      hasTerminalEvent: true,
      hasStartedResponse: true,
      hasRenderedAssistantMessage: true,
      hasVisibleAnswerContent: true
    }),
    'complete'
  );
});
