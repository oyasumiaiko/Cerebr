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
  const inlineModuleSource = (source) => source
    .replace(/export function /g, 'function ')
    .replace(/export const /g, 'const ')
    .replace(/export \{[\s\S]*?\};?/g, '');
  const filePath = path.resolve(__dirname, '../src/core/message_composer.js');
  let source = await fs.readFile(filePath, 'utf8');
  const compactionSourcePath = path.resolve(__dirname, '../src/utils/responses_local_compaction.js');
  const compactionSource = inlineModuleSource(await fs.readFile(compactionSourcePath, 'utf8'));
  source = source.replace(
    "import { extractThinkingFromText } from '../utils/thoughts_parser.js';",
    "const extractThinkingFromText = (text) => ({ cleanText: text, thoughtsText: '' });"
  );
  source = source.replace(
    /import\s*\{\s*isUsableResponsesLocalCompactionMarker,\s*sliceConversationChainAfterLatestCompactionMarker\s*\}\s*from '\.\.\/utils\/responses_local_compaction\.js';/,
    `${compactionSource}\n`
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

test('resolveDefaultResponsesPromptCacheRetention upgrades keyed official OpenAI requests to 24h by default', async () => {
  const { resolveDefaultResponsesPromptCacheRetention } = await loadPromptCacheModule();
  assert.equal(
    resolveDefaultResponsesPromptCacheRetention({
      promptCacheKey: 'conv:conversation-123',
      baseUrl: 'https://api.openai.com/v1/responses',
      promptCacheRetention: null
    }),
    '24h'
  );
});

test('resolveDefaultResponsesPromptCacheRetention does not auto-inject retention for third-party proxies', async () => {
  const { resolveDefaultResponsesPromptCacheRetention } = await loadPromptCacheModule();
  assert.equal(
    resolveDefaultResponsesPromptCacheRetention({
      promptCacheKey: 'conv:conversation-123',
      baseUrl: 'https://xynode1.xychatai.com/codex/responses',
      promptCacheRetention: null
    }),
    ''
  );
});

test('resolveDefaultResponsesPromptCacheRetention preserves explicit retention choice', async () => {
  const { resolveDefaultResponsesPromptCacheRetention } = await loadPromptCacheModule();
  assert.equal(
    resolveDefaultResponsesPromptCacheRetention({
      promptCacheKey: 'conv:conversation-123',
      baseUrl: 'https://xynode1.xychatai.com/codex/responses',
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

test('composeMessages 只让最新 compact marker 及其之后的历史进入模型上下文', async () => {
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
      { id: 'u1', role: 'user', content: '旧用户' },
      { id: 'a1', role: 'assistant', content: '旧助手' },
      {
        id: 'marker-old',
        role: 'assistant',
        content: '旧 marker',
        response_input_items: [{ type: 'compaction', encrypted_content: 'old-summary' }],
        contextCompactionMarker: { source: 'responses_local', compactedAt: 1 }
      },
      { id: 'u2', role: 'user', content: '旧 marker 之后的用户' },
      {
        id: 'marker-new',
        role: 'assistant',
        content: '新 marker',
        response_input_items: [{ type: 'compaction', encrypted_content: 'new-summary' }],
        contextCompactionMarker: { source: 'responses_local', compactedAt: 2 }
      },
      { id: 'u3', role: 'user', content: '最新 marker 之后的用户' }
    ],
    sendChatHistory: true,
    maxHistory: 16,
    maxUserHistory: 16,
    maxAssistantHistory: 16
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'assistant');
  assert.equal(messages[0].content, '新 marker');
  assert.equal(messages[1].content, '最新 marker 之后的用户');
});

test('composeMessages 在 maxHistory 裁剪后仍保留最新 compact marker', async () => {
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
        id: 'marker-new',
        role: 'assistant',
        content: '新 marker',
        response_input_items: [{ type: 'compaction', encrypted_content: 'new-summary' }],
        contextCompactionMarker: { source: 'responses_local', compactedAt: 2 }
      },
      { id: 'u3', role: 'user', content: '最新 marker 之后的用户' },
      { id: 'a3', role: 'assistant', content: '最新回答' }
    ],
    sendChatHistory: true,
    maxHistory: 1,
    maxUserHistory: null,
    maxAssistantHistory: null
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[0].content, '新 marker');
  assert.equal(messages[1].content, '最新回答');
});

test('composeMessages 在按角色裁剪时不把 compact marker 计入 assistant 上限', async () => {
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
        id: 'marker-new',
        role: 'assistant',
        content: '新 marker',
        response_input_items: [{ type: 'compaction', encrypted_content: 'new-summary' }],
        contextCompactionMarker: { source: 'responses_local', compactedAt: 2 }
      },
      { id: 'u3', role: 'user', content: '最新 marker 之后的用户' },
      { id: 'a3', role: 'assistant', content: '最新回答' }
    ],
    sendChatHistory: true,
    maxHistory: 16,
    maxUserHistory: 1,
    maxAssistantHistory: 1
  });

  assert.equal(messages.length, 3);
  assert.equal(messages[0].content, '新 marker');
  assert.equal(messages[1].content, '最新 marker 之后的用户');
  assert.equal(messages[2].content, '最新回答');
});

test('composeMessages skips local-only compact status messages without replay items', async () => {
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
      { id: 'u1', role: 'user', content: 'first user' },
      {
        id: 'c_pending',
        role: 'assistant',
        content: '上下文压缩中',
        responsesLocalCompactionStatus: { state: 'pending', phase: 'sending' }
      },
      {
        id: 'c_error',
        role: 'assistant',
        content: '上下文压缩失败',
        responsesLocalCompactionStatus: { state: 'error', phase: 'failed', errorMessage: 'empty body' }
      },
      { id: 'u2', role: 'user', content: 'latest user' }
    ],
    sendChatHistory: true,
    maxHistory: 20,
    maxUserHistory: null,
    maxAssistantHistory: null
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[0].content, 'first user');
  assert.ok(String(messages[1].content || '').includes('latest user'));
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
