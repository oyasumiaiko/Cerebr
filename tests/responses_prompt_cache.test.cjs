const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadPromptCacheModule() {
  const filePath = path.resolve(__dirname, '../src/utils/responses_prompt_cache.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

async function loadResponsesInputItemsModule() {
  const filePath = path.resolve(__dirname, '../src/utils/responses_input_items.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

async function loadMessageComposerModule() {
  const filePath = path.resolve(__dirname, '../src/core/message_composer.js');
  let source = await fs.readFile(filePath, 'utf8');
  source = source.replace(
    "import { extractThinkingFromText } from '../utils/thoughts_parser.js';",
    "const extractThinkingFromText = (text) => ({ cleanText: text, thoughtsText: '' });"
  );
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('buildDefaultResponsesPromptCacheKey reuses existing key first', async () => {
  const { buildDefaultResponsesPromptCacheKey } = await loadPromptCacheModule();
  assert.equal(
    buildDefaultResponsesPromptCacheKey({
      existingKey: '  fixed-key  ',
      conversationId: 'conv-1',
      draftConversationKey: '__draft_queue_1'
    }),
    'fixed-key'
  );
});

test('buildDefaultResponsesPromptCacheKey prefers conversation id over draft key', async () => {
  const { buildDefaultResponsesPromptCacheKey } = await loadPromptCacheModule();
  assert.equal(
    buildDefaultResponsesPromptCacheKey({
      conversationId: 'conversation-123',
      draftConversationKey: '__draft_queue_1'
    }),
    'conv:conversation-123'
  );
});

test('buildDefaultResponsesPromptCacheKey falls back to draft key only when conversation id is missing', async () => {
  const { buildDefaultResponsesPromptCacheKey } = await loadPromptCacheModule();
  assert.equal(
    buildDefaultResponsesPromptCacheKey({
      draftConversationKey: '__draft_queue_7'
    }),
    'draft:__draft_queue_7'
  );
});

test('resolveDefaultResponsesPromptCacheRetention upgrades keyed requests to 24h by default', async () => {
  const { resolveDefaultResponsesPromptCacheRetention } = await loadPromptCacheModule();
  assert.equal(
    resolveDefaultResponsesPromptCacheRetention({
      promptCacheKey: 'conv:conversation-123',
      promptCacheRetention: null
    }),
    '24h'
  );
});

test('resolveDefaultResponsesPromptCacheRetention preserves explicit retention choice', async () => {
  const { resolveDefaultResponsesPromptCacheRetention } = await loadPromptCacheModule();
  assert.equal(
    resolveDefaultResponsesPromptCacheRetention({
      promptCacheKey: 'conv:conversation-123',
      promptCacheRetention: 'in-memory'
    }),
    'in-memory'
  );
});

test('composeMessages uses outboundContent for historical user messages', async () => {
  const { composeMessages } = await loadMessageComposerModule();

  const messages = composeMessages({
    prompts: { system: { prompt: '' } },
    injectedSystemMessages: [],
    pageContent: null,
    imageContainsScreenshot: false,
    omitDefaultSystemPrompt: true,
    currentPromptType: 'none',
    regenerateMode: false,
    messageId: null,
    conversationChain: [
      {
        id: 'u1',
        role: 'user',
        content: '用户界面里显示的内容',
        outboundContent: '真正发送给模型的内容\\n\\n当前网页内容：标题：Example'
      },
      {
        id: 'a1',
        role: 'assistant',
        content: '好的'
      }
    ],
    sendChatHistory: true,
    maxHistory: 16,
    maxUserHistory: 16,
    maxAssistantHistory: 16
  });

  assert.equal(messages[0].content, '真正发送给模型的内容\\n\\n当前网页内容：标题：Example');
});

test('composeMessages last-user fallback path also uses outboundContent', async () => {
  const { composeMessages } = await loadMessageComposerModule();

  const messages = composeMessages({
    prompts: { system: { prompt: '' } },
    injectedSystemMessages: [],
    pageContent: null,
    imageContainsScreenshot: false,
    omitDefaultSystemPrompt: true,
    currentPromptType: 'none',
    regenerateMode: false,
    messageId: null,
    conversationChain: [
      {
        id: 'u1',
        role: 'user',
        content: '原始输入',
        outboundContent: '原始输入\\n\\n当前网页内容：标题：Example'
      }
    ],
    sendChatHistory: false,
    maxHistory: 0,
    maxUserHistory: 0,
    maxAssistantHistory: 0
  });

  assert.equal(messages[0].content, '原始输入\\n\\n当前网页内容：标题：Example');
});

test('mergeResponsesInputItems de-duplicates identical reasoning items without stable ids', async () => {
  const { mergeResponsesInputItems } = await loadResponsesInputItemsModule();

  const reasoningItem = {
    type: 'reasoning',
    summary: [
      { type: 'summary_text', text: 'same reasoning summary' }
    ]
  };

  const merged = mergeResponsesInputItems([reasoningItem], [reasoningItem]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], reasoningItem);
});
