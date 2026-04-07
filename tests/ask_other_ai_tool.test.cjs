const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadAskOtherAiToolModule() {
  const filePath = path.resolve(__dirname, '../src/utils/ask_other_ai_tool.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('buildAskOtherAiCatalog 只返回启用且配置完整的候选模型', async () => {
  const { buildAskOtherAiCatalog } = await loadAskOtherAiToolModule();
  const result = buildAskOtherAiCatalog([
    {
      id: 'cfg-current',
      modelName: 'gpt-5.4',
      displayName: 'Current',
      baseUrl: 'https://example.com/responses',
      enableAskOtherAiTool: true
    },
    {
      id: 'cfg-a',
      modelName: 'gpt-4.1',
      displayName: 'Reviewer',
      baseUrl: 'https://example.com/chat/completions',
      connectionType: 'openai',
      connectionSourceName: 'OpenAI Proxy',
      isFavorite: true,
      customSystemPrompt: 'be strict',
      enableAskOtherAiTool: true
    },
    {
      id: 'cfg-b',
      modelName: 'gemini-2.5-pro',
      displayName: '',
      baseUrl: 'https://generativelanguage.googleapis.com',
      enableAskOtherAiTool: false
    }
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.total_models, 2);
  assert.equal(result.models[0].config_id, 'cfg-current');
  assert.equal(result.models[1].config_id, 'cfg-a');
  assert.equal(result.models[1].display_name, 'Reviewer');
  assert.equal(result.models[1].is_favorite, true);
  assert.equal(result.models[1].has_custom_system_prompt, true);
  assert.match(result.guidance, /list_askable_models/);
});

test('normalizeAskOtherAiArguments 支持多 request 且严格校验必填字段', async () => {
  const { normalizeAskOtherAiArguments } = await loadAskOtherAiToolModule();
  const normalized = normalizeAskOtherAiArguments({
    requests: [
      { config_id: 'cfg-a', question: '  first?  ', context: '  alpha  ' },
      { config_id: 'cfg-b', question: 'second?', context: null }
    ]
  });

  assert.deepEqual(normalized, {
    requests: [
      { config_id: 'cfg-a', question: 'first?', context: 'alpha' },
      { config_id: 'cfg-b', question: 'second?', context: null }
    ]
  });

  assert.throws(() => normalizeAskOtherAiArguments({ requests: [] }), /至少需要 1 条/);
  assert.throws(() => normalizeAskOtherAiArguments({ requests: [{ config_id: '', question: 'x', context: null }] }), /config_id/);
  assert.throws(() => normalizeAskOtherAiArguments({ requests: [{ config_id: 'cfg', question: '   ', context: null }] }), /question/);
});

test('buildAskOtherAiUserMessage 使用隐藏 XML 块组织 context 与 question', async () => {
  const { buildAskOtherAiUserMessage } = await loadAskOtherAiToolModule();
  const text = buildAskOtherAiUserMessage('帮我反驳一下这个结论', '当前模型认为图表可能是 Vega-Lite。');
  assert.match(text, /<context>/);
  assert.match(text, /当前模型认为图表可能是 Vega-Lite/);
  assert.match(text, /<question>/);
  assert.match(text, /帮我反驳一下这个结论/);
});
