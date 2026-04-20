const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

function toDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
}

async function loadMessagePreprocessorModule() {
  const promptResolverPath = path.resolve(__dirname, '../src/core/prompt_resolver.js');
  const promptResolverSource = await fs.readFile(promptResolverPath, 'utf8');
  const promptResolverUrl = toDataUrl(promptResolverSource);

  const preprocessorPath = path.resolve(__dirname, '../src/core/message_preprocessor.js');
  let preprocessorSource = await fs.readFile(preprocessorPath, 'utf8');
  preprocessorSource = preprocessorSource.replace("'./prompt_resolver.js'", `'${promptResolverUrl}'`);
  return import(toDataUrl(preprocessorSource));
}

async function loadMessageComposerModule() {
  const inlineModuleSource = (source) => source
    .replace(/export function /g, 'function ')
    .replace(/export const /g, 'const ')
    .replace(/export \{[\s\S]*?\};?/g, '');
  const thoughtsParserPath = path.resolve(__dirname, '../src/utils/thoughts_parser.js');
  const thoughtsParserSource = await fs.readFile(thoughtsParserPath, 'utf8');
  const thoughtsParserUrl = toDataUrl(thoughtsParserSource);
  const compactionSourcePath = path.resolve(__dirname, '../src/utils/responses_local_compaction.js');
  const compactionSource = inlineModuleSource(await fs.readFile(compactionSourcePath, 'utf8'));

  const composerPath = path.resolve(__dirname, '../src/core/message_composer.js');
  let composerSource = await fs.readFile(composerPath, 'utf8');
  composerSource = composerSource.replace("'../utils/thoughts_parser.js'", `'${thoughtsParserUrl}'`);
  composerSource = composerSource.replace(
    /import\s*\{\s*isUsableResponsesLocalCompactionMarker,\s*sliceConversationChainAfterLatestCompactionMarker\s*\}\s*from '\.\.\/utils\/responses_local_compaction\.js';/,
    `${compactionSource}\n`
  );
  return import(toDataUrl(composerSource));
}

test('resolveUserMessageTemplateControls strips no_system_prompt marker', async () => {
  const { resolveUserMessageTemplateControls } = await loadMessagePreprocessorModule();
  const result = resolveUserMessageTemplateControls('  {{no_system_prompt}}\n{{input}}');

  assert.equal(result.omitDefaultSystemPrompt, true);
  assert.equal(result.templateText.includes('no_system_prompt'), false);
  assert.equal(result.templateText.trim(), '{{input}}');
});

test('renderUserMessageTemplateWithInjection treats marker-only template as empty', async () => {
  const { renderUserMessageTemplateWithInjection } = await loadMessagePreprocessorModule();
  const result = renderUserMessageTemplateWithInjection({
    template: ' \n {{no_system_prompt}} \n ',
    inputText: '原始输入'
  });

  assert.equal(result.omitDefaultSystemPrompt, true);
  assert.equal(result.hasTemplate, false);
  assert.equal(result.renderedText, '原始输入');
  assert.deepEqual(result.injectedMessages, []);
  assert.equal(result.hasInjectedBlocks, false);
  assert.equal(result.injectOnly, false);
});

test('renderUserMessageTemplateWithInjection 对仅 system 角色块不吞掉原始 user 上下文', async () => {
  const { renderUserMessageTemplateWithInjection } = await loadMessagePreprocessorModule();
  const result = renderUserMessageTemplateWithInjection({
    template: '{{#system}}请只输出 JSON。{{/system}}',
    inputText: '分析一下这个页面'
  });

  assert.equal(result.hasTemplate, true);
  assert.equal(result.hasInjectedBlocks, true);
  assert.equal(result.injectOnly, false);
  assert.deepEqual(result.injectedMessages, [
    { role: 'system', content: '请只输出 JSON。' }
  ]);
});

test('renderUserMessageTemplateWithInjection 只有显式 user 块时才接管原始 user 消息', async () => {
  const { renderUserMessageTemplateWithInjection } = await loadMessagePreprocessorModule();
  const result = renderUserMessageTemplateWithInjection({
    template: '{{#system}}你是量化分析师。{{/system}}\n{{#user}}{{input}}{{/user}}',
    inputText: '分析一下这个页面'
  });

  assert.equal(result.hasInjectedBlocks, true);
  assert.equal(result.injectOnly, true);
  assert.deepEqual(result.injectedMessages, [
    { role: 'system', content: '你是量化分析师。' },
    { role: 'user', content: '分析一下这个页面' }
  ]);
});

test('composeMessages omits default system prompt when requested', async () => {
  const { composeMessages } = await loadMessageComposerModule();
  const messages = composeMessages({
    prompts: { system: { prompt: '默认系统提示词' } },
    injectedSystemMessages: ['额外系统消息'],
    pageContent: null,
    imageContainsScreenshot: false,
    omitDefaultSystemPrompt: true,
    currentPromptType: 'none',
    regenerateMode: false,
    messageId: null,
    conversationChain: [{ id: 'u1', role: 'user', content: 'hello' }],
    maxHistory: 16,
    maxUserHistory: null,
    maxAssistantHistory: null
  });

  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content.includes('默认系统提示词'), false);
  assert.equal(messages[0].content.includes('额外系统消息'), true);
});

test('composeMessages drops system message when only default system prompt exists and marker is enabled', async () => {
  const { composeMessages } = await loadMessageComposerModule();
  const messages = composeMessages({
    prompts: { system: { prompt: '默认系统提示词' } },
    injectedSystemMessages: [],
    pageContent: null,
    imageContainsScreenshot: false,
    omitDefaultSystemPrompt: true,
    currentPromptType: 'none',
    regenerateMode: false,
    messageId: null,
    conversationChain: [{ id: 'u1', role: 'user', content: 'hello' }],
    maxHistory: 16,
    maxUserHistory: null,
    maxAssistantHistory: null
  });

  assert.equal(messages[0].role, 'user');
  assert.equal(messages.some((item) => item.role === 'system'), false);
});
