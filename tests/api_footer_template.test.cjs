const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadApiFooterTemplateModule() {
  const filePath = path.resolve(__dirname, '../src/utils/api_footer_template.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('normalizeApiUsageMeta keeps cached and reasoning token details', async () => {
  const { normalizeApiUsageMeta } = await loadApiFooterTemplateModule();
  const normalized = normalizeApiUsageMeta({
    input_tokens: 1200,
    output_tokens: 300,
    total_tokens: 1500,
    input_tokens_details: { cached_tokens: 768 },
    output_tokens_details: { reasoning_tokens: 64 }
  });

  assert.deepEqual(normalized, {
    promptTokens: 1200,
    completionTokens: 300,
    totalTokens: 1500,
    cachedInputTokens: 768,
    reasoningTokens: 64
  });
});

test('buildApiFooterContext exposes timing and detailed usage variables', async () => {
  const { buildApiFooterContext } = await loadApiFooterTemplateModule();
  const context = buildApiFooterContext({
    role: 'assistant',
    apiUuid: 'cfg-1',
    apiDisplayName: 'Responses',
    apiModelId: 'gpt-5.4-mini',
    timestamp: 1775410000000,
    apiUsage: {
      promptTokens: 1200,
      completionTokens: 300,
      totalTokens: 1500,
      cachedInputTokens: 768,
      reasoningTokens: 64
    },
    responseTiming: {
      startedAtMs: 1775410000000,
      firstVisibleOutputAtMs: 1775410001800,
      completedAtMs: 1775410002600,
      generationDurationMs: 2600,
      thinkingDurationMs: 1800,
      outputDurationMs: 800
    },
    response_activity_duration_ms: 1800
  }, null);

  assert.equal(context.cached_input_tokens, 768);
  assert.equal(context.reasoning_tokens, 64);
  assert.equal(context.generation_duration_ms, 2600);
  assert.equal(context.thinking_duration_ms, 1800);
  assert.equal(context.output_duration_ms, 800);
  assert.match(context.tooltip_usage_detail_lines, /cached_input_tokens: 768/);
  assert.match(context.tooltip_usage_detail_lines, /reasoning_tokens: 64/);
  assert.match(context.tooltip_timing_lines, /generation_duration:/);
  assert.match(context.tooltip_timing_lines, /thinking_duration:/);
  assert.match(context.tooltip_timing_lines, /output_duration:/);
});

test('renderApiFooterTemplate only applies inline separator joining within the same line', async () => {
  const { renderApiFooterTemplate } = await loadApiFooterTemplateModule();
  const rendered = renderApiFooterTemplate(
    '{{display_label}} · {{datetime}} · {{total_tokens_k}}\n{{signature}} · {{model}}',
    {
      display_label: 'gpt-5.4',
      datetime: '',
      total_tokens_k: '1.2k',
      signature: '',
      model: 'gpt-5.4'
    },
    {
      inlineSeparator: ' · '
    }
  );

  assert.equal(rendered, 'gpt-5.4 · 1.2k\ngpt-5.4');
});
