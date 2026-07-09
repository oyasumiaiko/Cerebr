const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

async function loadChatHistoryToolModule() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cerebr-chat-history-tool-'));
  await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  await fs.mkdir(path.join(tempDir, 'src', 'utils'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'src', 'agent_tools', 'shared'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'src', 'agent_tools', 'chat_history'), { recursive: true });
  await fs.copyFile(
    path.resolve(__dirname, '../src/utils/chat_history_search_shared.js'),
    path.join(tempDir, 'src', 'utils', 'chat_history_search_shared.js')
  );
  await fs.copyFile(
    path.resolve(__dirname, '../src/utils/url_candidates.js'),
    path.join(tempDir, 'src', 'utils', 'url_candidates.js')
  );
  await fs.copyFile(
    path.resolve(__dirname, '../src/agent_tools/shared/model_tool_contract.js'),
    path.join(tempDir, 'src', 'agent_tools', 'shared', 'model_tool_contract.js')
  );
  await fs.copyFile(
    path.resolve(__dirname, '../src/agent_tools/chat_history/tool.js'),
    path.join(tempDir, 'src', 'agent_tools', 'chat_history', 'tool.js')
  );
  return import(pathToFileURL(path.join(tempDir, 'src', 'agent_tools', 'chat_history', 'tool.js')).href);
}

function buildSampleConversations() {
  return [
    {
      id: 'conv_alpha',
      title: 'Alpha session',
      url: 'https://alpha.example.com',
      summary: 'alpha summary',
      startTime: 1700000001000,
      endTime: 1700000002000,
      messageCount: 5,
      mainMessageCount: 2,
      threadCount: 1,
      messages: [
        { id: 'm1', role: 'user', timestamp: 1700000001000, content: 'alpha intro' },
        {
          id: 'm2_hidden',
          role: 'user',
          timestamp: 1700000001100,
          content: 'secret needle',
          threadId: 'thread-a',
          threadAnchorId: 'm1',
          threadHiddenSelection: true
        },
        {
          id: 'm3_thread',
          role: 'assistant',
          timestamp: 1700000001200,
          content: 'thread alpha detail',
          threadId: 'thread-a',
          threadAnchorId: 'm1'
        },
        { id: 'm4', role: 'assistant', timestamp: 1700000001300, content: 'beta context' }
      ]
    },
    {
      id: 'conv_beta',
      title: 'Beta session',
      url: 'https://beta.example.com',
      summary: 'beta summary',
      startTime: 1700000003000,
      endTime: 1700000004000,
      messageCount: 3,
      mainMessageCount: 3,
      threadCount: 0,
      messages: [
        { id: 'b1', role: 'user', timestamp: 1700000003000, content: 'gamma' },
        { id: 'b2', role: 'assistant', timestamp: 1700000003100, content: 'delta' },
        { id: 'b3', role: 'user', timestamp: 1700000003200, content: 'gamma delta' }
      ]
    },
    {
      id: 'conv_recent',
      title: 'Recent session',
      url: 'https://recent.example.com',
      summary: 'recent summary',
      startTime: 1700000005000,
      endTime: 1700000006000,
      messageCount: 2,
      mainMessageCount: 2,
      threadCount: 0,
      messages: [
        { id: 'r1', role: 'user', timestamp: 1700000005000, content: 'latest alpha beta' },
        { id: 'r2', role: 'assistant', timestamp: 1700000005100, content: 'wrap up' }
      ]
    }
  ];
}

function toMetas(conversations) {
  return conversations.map((item) => ({
    id: item.id,
    title: item.title,
    url: item.url,
    summary: item.summary,
    startTime: item.startTime,
    endTime: item.endTime,
    messageCount: item.messageCount,
    mainMessageCount: item.mainMessageCount,
    threadCount: item.threadCount
  }));
}

function assertLocalIsoString(value) {
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
}

test('buildConversationReferenceSnapshot 使用 1-based 绝对编号且最新最大', async () => {
  const { buildConversationReferenceSnapshot } = await loadChatHistoryToolModule();
  const snapshot = buildConversationReferenceSnapshot([
    { id: 'old', startTime: 1, endTime: 10 },
    { id: 'new', startTime: 5, endTime: 30 },
    { id: 'mid', startTime: 3, endTime: 20 }
  ]);

  assert.equal(snapshot.convRefById.get('old'), 1);
  assert.equal(snapshot.convRefById.get('mid'), 2);
  assert.equal(snapshot.convRefById.get('new'), 3);
});

test('buildConversationReadReferenceMap 会把主线与线程分开编号并排除隐藏线程占位', async () => {
  const { buildConversationReadReferenceMap } = await loadChatHistoryToolModule();
  const [conversation] = buildSampleConversations();
  const refs = buildConversationReadReferenceMap(conversation);

  assert.equal(refs.mainMessages.length, 2);
  assert.equal(refs.mainMessages[0].msg_index, 1);
  assert.equal(refs.mainMessages[1].msg_index, 2);
  assert.equal(refs.threads.length, 1);
  assert.equal(refs.threads[0].thread_ref, 1);
  assert.equal(refs.threads[0].thread_message_count, 1);
  assert.equal(refs.threads[0].thread_anchor_msg_index, 1);
  assert.equal(refs.threads[0].messages[0].thread_msg_index, 1);
  assert.equal(refs.threads[0].messages[0].content, 'thread alpha detail');
});

test('executeHistorySearchTool 复用 query 语法并返回外部数字引用', async () => {
  const {
    buildConversationReferenceSnapshot,
    executeHistorySearchTool
  } = await loadChatHistoryToolModule();
  const conversations = buildSampleConversations();
  const snapshot = buildConversationReferenceSnapshot(toMetas(conversations));

  const result = await executeHistorySearchTool(
    {
      text_all: ['alpha'],
      scope: 'message',
      max_results: 10
    },
    {
      snapshot,
      loadConversationsByIds: async (ids) => conversations.filter(item => ids.includes(item.id))
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.total_matches, 2);
  assert.deepEqual(result.query.text_all, ['alpha']);
  assert.equal(result.query.scope, 'message');
  assert.equal(result.result_mode, 'matches');
  assert.equal(result.results[0].conv_ref, 3);
  assert.equal(result.results[0].page_title, 'Recent session');
  assert.equal(result.results[0].conversation_title, 'recent summary');
  assertLocalIsoString(result.results[0].created_at);
  assertLocalIsoString(result.results[0].updated_at);
  assert.equal(result.results[0].message_count, 2);
  assert.equal(result.results[0].thread_message_count, 0);
  assert.deepEqual(result.results[0].match.locations, [{ msg_index: 1 }]);
  assert.equal(result.results[1].conv_ref, 1);
  assert.equal(result.results[1].page_title, 'Alpha session');
  assert.equal(result.results[1].conversation_title, 'alpha summary');
  assert.equal(result.results[1].thread_message_count, 1);
  assert.equal(result.results[1].has_threads, true);
  assert.deepEqual(result.results[1].match.locations, [{ msg_index: 1 }, { thread_ref: 1, thread_msg_index: 1 }]);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /conv_alpha|conv_beta|conv_recent|\"m1\"|\"m3_thread\"|\"b3\"|\"r1\"/);
});

test('executeHistorySearchTool 的 scope:session 允许不同消息共同满足正向条件', async () => {
  const {
    buildConversationReferenceSnapshot,
    executeHistorySearchTool
  } = await loadChatHistoryToolModule();
  const conversations = buildSampleConversations();
  const snapshot = buildConversationReferenceSnapshot(toMetas(conversations));

  const sessionResult = await executeHistorySearchTool(
    {
      text_all: ['gamma', 'delta'],
      max_results: 10
    },
    {
      snapshot,
      loadConversationsByIds: async (ids) => conversations.filter(item => ids.includes(item.id))
    }
  );
  assert.equal(sessionResult.total_matches, 1);

  const messageScopeResult = await executeHistorySearchTool(
    {
      text_all: ['gamma', 'delta'],
      scope: 'message',
      max_results: 10
    },
    {
      snapshot,
      loadConversationsByIds: async (ids) => conversations.filter(item => ids.includes(item.id))
    }
  );
  assert.equal(messageScopeResult.total_matches, 1);
  assert.deepEqual(messageScopeResult.results[0].match.locations, [{ msg_index: 3 }]);
});

test('executeHistorySearchTool 不会命中隐藏线程占位文本', async () => {
  const {
    buildConversationReferenceSnapshot,
    executeHistorySearchTool
  } = await loadChatHistoryToolModule();
  const conversations = buildSampleConversations();
  const snapshot = buildConversationReferenceSnapshot(toMetas(conversations));

  const result = await executeHistorySearchTool(
    {
      text_all: ['secret'],
      max_results: 10
    },
    {
      snapshot,
      loadConversationsByIds: async (ids) => conversations.filter(item => ids.includes(item.id))
    }
  );

  assert.equal(result.total_matches, 0);
});

test('executeHistorySearchTool 支持 url/count/date 过滤语法', async () => {
  const {
    buildConversationReferenceSnapshot,
    executeHistorySearchTool
  } = await loadChatHistoryToolModule();
  const conversations = buildSampleConversations();
  const snapshot = buildConversationReferenceSnapshot(toMetas(conversations));

  const result = await executeHistorySearchTool(
    {
      url_contains: 'recent',
      min_message_count: 2,
      date_from: '1970-01-01',
      max_results: 10
    },
    {
      snapshot,
      loadConversationsByIds: async (ids) => conversations.filter(item => ids.includes(item.id))
    }
  );

  assert.equal(result.total_matches, 1);
  assert.equal(result.results[0].conv_ref, 3);
});

test('executeHistorySearchTool 支持 metadata_only 模式列出最近对话元数据', async () => {
  const {
    buildConversationReferenceSnapshot,
    executeHistorySearchTool
  } = await loadChatHistoryToolModule();
  const conversations = buildSampleConversations();
  const snapshot = buildConversationReferenceSnapshot(toMetas(conversations));

  const result = await executeHistorySearchTool(
    {
      recent_within: '999y',
      result_mode: 'metadata_only',
      max_results: 10
    },
    {
      snapshot,
      loadConversationsByIds: async (ids) => conversations.filter(item => ids.includes(item.id))
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.result_mode, 'metadata_only');
  assert.equal(result.total_matches, 3);
  assert.equal(result.results[0].conv_ref, 3);
  assertLocalIsoString(result.results[0].updated_at);
  assert.equal(result.results[0].thread_count, 0);
  assert.equal(result.results[0].page_title, 'Recent session');
  assert.equal(result.results[0].conversation_title, 'recent summary');
  assert.equal(result.results[1].conv_ref, 2);
  assert.equal(result.results[1].has_threads, false);
  assert.equal(result.results[2].conv_ref, 1);
  assert.equal(result.results[2].thread_message_count, 1);
  assert.equal(typeof result.results[0].match, 'undefined');
});

test('executeHistorySearchTool 支持 current_page_only 复用本页 URL 前缀匹配并回传匹配等级', async () => {
  const {
    buildConversationReferenceSnapshot,
    executeHistorySearchTool
  } = await loadChatHistoryToolModule();
  const conversations = [
    {
      id: 'conv_origin',
      title: 'Origin match',
      url: 'https://example.com/other',
      summary: 'origin summary',
      startTime: 1700000100000,
      endTime: 1700000101000,
      messageCount: 2,
      mainMessageCount: 2,
      threadCount: 0,
      messages: [
        { id: 'o1', role: 'user', timestamp: 1700000100000, content: 'origin' },
        { id: 'o2', role: 'assistant', timestamp: 1700000100100, content: 'match' }
      ]
    },
    {
      id: 'conv_path',
      title: 'Path match',
      url: 'https://example.com/docs/guide',
      summary: 'path summary',
      startTime: 1700000102000,
      endTime: 1700000103000,
      messageCount: 2,
      mainMessageCount: 2,
      threadCount: 0,
      messages: [
        { id: 'p1', role: 'user', timestamp: 1700000102000, content: 'path' },
        { id: 'p2', role: 'assistant', timestamp: 1700000102100, content: 'match' }
      ]
    },
    {
      id: 'conv_exact',
      title: 'Exact match',
      url: 'https://example.com/docs/guide?tab=1#frag',
      summary: 'exact summary',
      startTime: 1700000104000,
      endTime: 1700000105000,
      messageCount: 2,
      mainMessageCount: 2,
      threadCount: 0,
      messages: [
        { id: 'e1', role: 'user', timestamp: 1700000104000, content: 'exact' },
        { id: 'e2', role: 'assistant', timestamp: 1700000104100, content: 'match' }
      ]
    },
    {
      id: 'conv_other_site',
      title: 'Other site',
      url: 'https://other.example.com/docs/guide',
      summary: 'other summary',
      startTime: 1700000106000,
      endTime: 1700000107000,
      messageCount: 2,
      mainMessageCount: 2,
      threadCount: 0,
      messages: [
        { id: 'x1', role: 'user', timestamp: 1700000106000, content: 'other' },
        { id: 'x2', role: 'assistant', timestamp: 1700000106100, content: 'site' }
      ]
    }
  ];
  const snapshot = buildConversationReferenceSnapshot(toMetas(conversations));

  const result = await executeHistorySearchTool(
    {
      current_page_only: true,
      result_mode: 'metadata_only',
      max_results: 10
    },
    {
      snapshot,
      currentPageUrl: 'https://example.com/docs/guide?tab=1#frag',
      loadConversationsByIds: async (ids) => conversations.filter(item => ids.includes(item.id))
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.total_matches, 3);
  assert.equal(result.query.current_page_only, true);
  assert.equal(result.query.current_page_url, 'https://example.com/docs/guide?tab=1#frag');
  assert.deepEqual(
    result.results.map((item) => ({
      conv_ref: item.conv_ref,
      url_match_level: item.url_match_level,
      url_match_prefix: item.url_match_prefix
    })),
    [
      {
        conv_ref: 3,
        url_match_level: 0,
        url_match_prefix: 'https://example.com/docs/guide?tab=1#frag'
      },
      {
        conv_ref: 2,
        url_match_level: 2,
        url_match_prefix: 'https://example.com/docs/guide'
      },
      {
        conv_ref: 1,
        url_match_level: 4,
        url_match_prefix: 'https://example.com'
      }
    ]
  );
});

test('executeHistorySearchTool 在没有任何条件时会报明确错误', async () => {
  const {
    buildConversationReferenceSnapshot,
    executeHistorySearchTool
  } = await loadChatHistoryToolModule();
  const conversations = buildSampleConversations();
  const snapshot = buildConversationReferenceSnapshot(toMetas(conversations));

  await assert.rejects(
    () => executeHistorySearchTool(
      { max_results: 10 },
      {
        snapshot,
        loadConversationsByIds: async (ids) => conversations.filter(item => ids.includes(item.id))
      }
    ),
    /至少需要提供一个搜索条件/
  );
});

test('executeHistorySearchTool 在 current_page_only=true 且当前页面 URL 不可用时会报明确错误', async () => {
  const {
    buildConversationReferenceSnapshot,
    executeHistorySearchTool
  } = await loadChatHistoryToolModule();
  const conversations = buildSampleConversations();
  const snapshot = buildConversationReferenceSnapshot(toMetas(conversations));

  await assert.rejects(
    () => executeHistorySearchTool(
      { current_page_only: true, max_results: 10 },
      {
        snapshot,
        loadConversationsByIds: async (ids) => conversations.filter(item => ids.includes(item.id))
      }
    ),
    /current_page_only=true 时当前页面 URL 不可用/
  );
});

test('executeHistoryReadTool 支持主线与线程窗口读取', async () => {
  const {
    buildConversationReferenceSnapshot,
    executeHistoryReadTool
  } = await loadChatHistoryToolModule();
  const conversations = buildSampleConversations();
  const snapshot = buildConversationReferenceSnapshot(toMetas(conversations));

  const mainResult = await executeHistoryReadTool(
    { conv_ref: 1, start: 1, end: 2, thread_ref: null },
    {
      snapshot,
      loadConversationById: async (id) => conversations.find(item => item.id === id) || null
    }
  );
  assert.equal(mainResult.ok, true);
  assert.equal(mainResult.scope, 'main');
  assert.equal(mainResult.page_title, 'Alpha session');
  assert.equal(mainResult.conversation_title, 'alpha summary');
  assertLocalIsoString(mainResult.created_at);
  assert.equal(mainResult.messages.length, 2);
  assert.equal(mainResult.messages[0].msg_index, 1);

  const threadResult = await executeHistoryReadTool(
    { conv_ref: 1, start: 1, end: 1, thread_ref: 1 },
    {
      snapshot,
      loadConversationById: async (id) => conversations.find(item => item.id === id) || null
    }
  );
  assert.equal(threadResult.ok, true);
  assert.equal(threadResult.scope, 'thread');
  assert.equal(threadResult.page_title, 'Alpha session');
  assert.equal(threadResult.conversation_title, 'alpha summary');
  assertLocalIsoString(threadResult.updated_at);
  assert.equal(threadResult.thread_anchor_msg_index, 1);
  assert.equal(threadResult.messages[0].thread_msg_index, 1);
  assert.equal(threadResult.messages[0].content, 'thread alpha detail');
  const serialized = JSON.stringify(threadResult);
  assert.doesNotMatch(serialized, /conv_alpha|conv_beta|conv_recent|\"m1\"|\"m3_thread\"|\"b3\"|\"r1\"/);
});

test('executeHistoryReadTool 默认按每条消息 5000 字符截断，但允许 read_full_messages 读取完整正文', async () => {
  const {
    buildConversationReferenceSnapshot,
    executeHistoryReadTool
  } = await loadChatHistoryToolModule();
  const longContent = 'L'.repeat(6200);
  const conversations = [
    {
      id: 'conv_long',
      title: 'Long session',
      url: 'https://example.com/long',
      summary: 'long summary',
      startTime: 1700000010000,
      endTime: 1700000011000,
      messageCount: 1,
      mainMessageCount: 1,
      threadCount: 0,
      messages: [
        { id: 'long_1', role: 'user', timestamp: 1700000010000, content: longContent }
      ]
    }
  ];
  const snapshot = buildConversationReferenceSnapshot(toMetas(conversations));

  const truncatedResult = await executeHistoryReadTool(
    { conv_ref: 1, start: 1, end: 1, thread_ref: null, read_full_messages: false },
    {
      snapshot,
      loadConversationById: async (id) => conversations.find(item => item.id === id) || null
    }
  );
  assert.equal(truncatedResult.ok, true);
  assert.equal(truncatedResult.read_full_messages, false);
  assert.equal(truncatedResult.message_truncation_max_chars, 5000);
  assert.equal(truncatedResult.messages[0].content.length, 5000);
  assert.equal(truncatedResult.messages[0].content_total_chars, 6200);
  assert.equal(truncatedResult.messages[0].content_returned_chars, 5000);
  assert.equal(truncatedResult.messages[0].content_omitted_chars, 1200);
  assert.equal(truncatedResult.messages[0].content_omitted_pct, 19.35);
  assert.equal(truncatedResult.messages[0].content_truncated, true);

  const fullResult = await executeHistoryReadTool(
    { conv_ref: 1, start: 1, end: 1, thread_ref: null, read_full_messages: true },
    {
      snapshot,
      loadConversationById: async (id) => conversations.find(item => item.id === id) || null
    }
  );
  assert.equal(fullResult.ok, true);
  assert.equal(fullResult.read_full_messages, true);
  assert.equal(fullResult.message_truncation_max_chars, null);
  assert.equal(fullResult.messages[0].content.length, 6200);
  assert.equal(fullResult.messages[0].content_truncated, false);
  assert.equal(fullResult.messages[0].content_omitted_chars, 0);
});
