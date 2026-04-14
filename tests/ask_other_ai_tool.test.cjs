const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadAskOtherAiToolModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/ask_other_ai/tool.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('buildAskOtherAiCatalog 只返回偏好设置中显式选中的且配置完整的候选模型', async () => {
  const { buildAskOtherAiCatalog } = await loadAskOtherAiToolModule();
  const result = buildAskOtherAiCatalog([
    {
      id: 'cfg-current',
      modelName: 'gpt-5.4',
      displayName: 'Current',
      baseUrl: 'https://example.com/responses'
    },
    {
      id: 'cfg-a',
      modelName: 'gpt-4.1',
      displayName: 'Reviewer',
      baseUrl: 'https://example.com/chat/completions',
      connectionType: 'openai',
      connectionSourceName: 'OpenAI Proxy',
      isFavorite: true,
      customSystemPrompt: 'be strict'
    },
    {
      id: 'cfg-b',
      modelName: 'gemini-2.5-pro',
      displayName: '',
      baseUrl: 'https://generativelanguage.googleapis.com'
    }
  ], {
    enabledConfigIds: ['cfg-current', 'cfg-a']
  });

  assert.equal(result.ok, true);
  assert.equal(result.total_models, 2);
  assert.equal(result.models[0].config_id, 'cfg-current');
  assert.equal(result.models[1].config_id, 'cfg-a');
  assert.equal(result.models[1].display_name, 'Reviewer');
  assert.equal(result.models[1].is_favorite, true);
  assert.equal(result.models[1].has_custom_system_prompt, true);
  assert.match(result.guidance, /list_askable_models/);
});

test('buildAskOtherAiFunctionToolDefinition 包含更明确的使用边界说明', async () => {
  const {
    ASK_OTHER_AI_TOOL_NAME,
    LIST_ASKABLE_MODELS_TOOL_NAME,
    buildAskOtherAiFunctionToolDefinition,
    buildListAskableModelsFunctionToolDefinition
  } = await loadAskOtherAiToolModule();

  const askSpec = buildAskOtherAiFunctionToolDefinition();
  assert.equal(askSpec.type, 'function');
  assert.equal(askSpec.name, ASK_OTHER_AI_TOOL_NAME);
  assert.match(askSpec.description, /何时使用/);
  assert.match(askSpec.description, /不该怎么用/);

  const listSpec = buildListAskableModelsFunctionToolDefinition();
  assert.equal(listSpec.name, LIST_ASKABLE_MODELS_TOOL_NAME);
  assert.equal(listSpec.parameters.required.length, 0);
});

test('normalizeAskOtherAiArguments 支持多 request 且严格校验必填字段', async () => {
  const { normalizeAskOtherAiArguments } = await loadAskOtherAiToolModule();
  const normalized = normalizeAskOtherAiArguments({
    requests: [
      { config_id: 'cfg-a', question: '  first?  ' },
      { config_id: 'cfg-b', question: 'second?' }
    ]
  });

  assert.deepEqual(normalized, {
    requests: [
      { config_id: 'cfg-a', question: 'first?' },
      { config_id: 'cfg-b', question: 'second?' }
    ]
  });

  assert.throws(() => normalizeAskOtherAiArguments({ requests: [] }), /至少需要 1 条/);
  assert.throws(() => normalizeAskOtherAiArguments({ requests: [{ config_id: '', question: 'x' }] }), /config_id/);
  assert.throws(() => normalizeAskOtherAiArguments({ requests: [{ config_id: 'cfg', question: '   ' }] }), /question/);
});

test('buildAskOtherAiUserMessage 使用显式文本区块而不是 XML 包裹', async () => {
  const { buildAskOtherAiUserMessage } = await loadAskOtherAiToolModule();
  const text = buildAskOtherAiUserMessage('帮我反驳一下这个结论');
  assert.match(text, /Question:/);
  assert.match(text, /帮我反驳一下这个结论/);
  assert.doesNotMatch(text, /Additional context:/);
  assert.doesNotMatch(text, /<question>/);
});
