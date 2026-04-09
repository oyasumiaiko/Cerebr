const fs = require('fs/promises');
const http = require('http');
const net = require('net');
const path = require('path');
const {
  buildSendContentMessageExpression,
  launchFixedSidebarContext,
  loadPlaywright,
  resolveFixedSidebarProfileDir,
  resolveStableChromeExecutablePath,
  shouldRunHeadless,
  waitFor,
  waitForExtensionWorker,
  waitForSidebarFrame
} = require('./lib/stable_chrome_sidebar_harness.cjs');

const [repoRoot, outputDir, chromePathArg] = process.argv.slice(2);

if (!repoRoot || !outputDir) {
  throw new Error(
    'Usage: node tests/cdp_response_activity_auto_collapse_regression.cjs <repoRoot> <outputDir> [chromePath]'
  );
}

const chromePath = chromePathArg || resolveStableChromeExecutablePath();
const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
    server.on('error', reject);
  });
}

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function createMessageItem(messageId, text) {
  return {
    id: messageId,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [
      {
        type: 'output_text',
        text
      }
    ]
  };
}

async function runMockResponsesServer() {
  const finalAnswerText = 'AUTO_COLLAPSE_BODY_ANSWER_20260410';
  const reasoningChunks = Array.from({ length: 10 }, (_, index) => (
    `第${index + 1}步：为了验证思考窗口只在内部滚动，这里持续追加一段足够长的推理文本，`
    + '确保 peek 窗口会出现真实的内部溢出与内部滚动，而不是依赖外层聊天容器补偿。'
    + '我们要观察最新 assistant 消息的顶部锚点在整个流式阶段保持稳定。\n'
  ));
  const reasoningText = reasoningChunks.join('');
  const requestLog = [];

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/v1/responses') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }

      const body = await new Promise((resolve, reject) => {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => resolve(raw));
        req.on('error', reject);
      });
      requestLog.push({
        receivedAt: new Date().toISOString(),
        body
      });

      const messageItem = createMessageItem('msg_auto_collapse', finalAnswerText);
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive'
      });

      writeSseEvent(res, { type: 'response.created', response: { id: 'resp_auto_collapse' } });
      writeSseEvent(res, { type: 'response.in_progress', response: { id: 'resp_auto_collapse' } });
      await sleep(120);
      for (const chunk of reasoningChunks) {
        writeSseEvent(res, {
          type: 'response.reasoning_summary_text.delta',
          item_id: 'reasoning_auto_collapse',
          delta: chunk
        });
        await sleep(120);
      }
      await sleep(600);
      writeSseEvent(res, { type: 'response.output_item.added', item: messageItem });
      writeSseEvent(res, {
        type: 'response.output_text.delta',
        item_id: 'msg_auto_collapse',
        output_item_id: 'msg_auto_collapse',
        output_index: 0,
        content_index: 0,
        delta: finalAnswerText
      });
      writeSseEvent(res, {
        type: 'response.output_text.done',
        item_id: 'msg_auto_collapse',
        output_item_id: 'msg_auto_collapse',
        output_index: 0,
        content_index: 0,
        text: finalAnswerText
      });
      writeSseEvent(res, { type: 'response.output_item.done', item: messageItem });
      // 刻意保留“正文已经可见但请求尚未 completed”的观察窗口，
      // 让浏览器回归能稳定采到 thinking 中的 peek 窗口。
      await sleep(1800);
      writeSseEvent(res, {
        type: 'response.completed',
        response: {
          id: 'resp_auto_collapse',
          output: [messageItem],
          usage: {
            input_tokens: 40,
            output_tokens: 20,
            total_tokens: 60,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 }
          }
        }
      });
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });

  const port = await getFreePort();
  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', (error) => error ? reject(error) : resolve());
  });

  return {
    origin: `http://127.0.0.1:${port}`,
    requestLog,
    finalAnswerText,
    reasoningText,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

function buildStorageSeed(baseUrl) {
  return {
    apiConfigs: [{
      id: 'cfg_response_activity_auto_collapse',
      displayName: 'Response Activity Auto Collapse Regression',
      modelName: 'gpt-5.4',
      baseUrl,
      connectionType: 'openai_responses',
      apiKey: 'mock-key',
      customParams: '',
      customSystemPrompt: '',
      temperature: 1,
      useStreaming: true,
      isFavorite: false,
      enableAskOtherAiTool: false,
      maxChatHistory: 500,
      maxChatHistoryUser: 2147483647,
      maxChatHistoryAssistant: 2147483647,
      userMessagePreprocessorTemplate: '',
      userMessagePreprocessorIncludeInHistory: false,
      responsesApiSettings: {
        reasoning: {
          effort: 'medium',
          generate_summary: 'concise',
          summary: 'concise'
        },
        text: {
          verbosity: 'low'
        },
        parallel_tool_calls: true,
        store: false,
        builtin_tools: {
          web_search: { enabled: false }
        }
      }
    }],
    selectedConfigIndex: 0,
    sendChatHistory: true,
    showThoughtProcess: true,
    queueCurrentConversationMessages: true,
    autoGenerateConversationTitle: false
  };
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const result = {
    startedAt: new Date().toISOString(),
    outputDir,
    chromePath,
    headless: runHeadless,
    steps: [],
    console: []
  };

  const mockServer = await runMockResponsesServer();
  result.mockOrigin = mockServer.origin;
  result.finalAnswerText = mockServer.finalAnswerText;
  result.profileDir = resolveFixedSidebarProfileDir(repoRoot);

  let context = null;
  let page = null;
  let sidebarFrame = null;
  try {
    await fs.mkdir(result.profileDir, { recursive: true });
    context = await launchFixedSidebarContext({
      chromium,
      profileDir: result.profileDir,
      executablePath: chromePath,
      headless: runHeadless
    });
    result.steps.push('browser_ready');

    const extensionWorker = await waitForExtensionWorker(context, { timeoutMs: 30_000 });
    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;
    result.steps.push('background_ready');

    await extensionWorker.evaluate(`(async () => {
      await chrome.storage.sync.clear();
      await chrome.storage.local.clear();
      await chrome.storage.sync.set(${JSON.stringify(buildStorageSeed(`${mockServer.origin}/v1/responses`))});
      return true;
    })()`);
    result.steps.push('storage_seeded');

    page = context.pages().find((entry) => entry.url().startsWith('https://example.com/')) || await context.newPage();
    page.on('console', (msg) => {
      result.console.push({ type: msg.type(), text: msg.text() });
    });
    page.on('pageerror', (error) => {
      result.console.push({ type: 'pageerror', text: String(error && (error.stack || error.message || error)) });
    });
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    result.steps.push('page_loaded');

    await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      return payload?.response?.debugState?.initialized ? payload : null;
    }, { timeoutMs: 15_000, intervalMs: 250, label: 'sidebar initialized before open' });
    result.steps.push('sidebar_initialized');

    const openSidebarResponse = await extensionWorker.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'OPEN_SIDEBAR' }))
    );
    result.openSidebarResponse = openSidebarResponse;
    if (!openSidebarResponse?.response?.success || openSidebarResponse?.response?.status !== true) {
      throw new Error(`OPEN_SIDEBAR did not report visible=true: ${JSON.stringify(openSidebarResponse)}`);
    }
    result.steps.push('sidebar_open_requested');

    await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      return payload?.response?.debugState?.isActuallyVisible ? payload : null;
    }, { timeoutMs: 15_000, intervalMs: 250, label: 'sidebar actual visibility' });
    result.steps.push('sidebar_visible_confirmed');

    sidebarFrame = await waitForSidebarFrame(page, extensionId, { timeoutMs: 30_000 });
    await sidebarFrame.locator('#message-input').waitFor({ state: 'visible', timeout: 30_000 });
    result.steps.push('sidebar_frame_ready');

    result.apiConfigState = await waitFor(async () => {
      return await sidebarFrame.evaluate(() => {
        const configs = Array.isArray(window.apiConfigs) ? window.apiConfigs : [];
        const first = configs[0] || null;
        if (!first || !first.baseUrl) return null;
        return {
          count: configs.length,
          baseUrl: first.baseUrl,
          modelName: first.modelName || '',
          connectionType: first.connectionType || ''
        };
      });
    }, { timeoutMs: 15_000, intervalMs: 250, label: 'sidebar api config ready' });
    result.steps.push('api_config_ready');

    const prompt = '请先思考，再给出一句简短结论。';
    await sidebarFrame.locator('#message-input').fill(prompt);
    await sidebarFrame.locator('#message-input').press('Enter');
    result.steps.push('prompt_sent');

    result.mockRequestCount = await waitFor(async () => (
      mockServer.requestLog.length >= 1 ? mockServer.requestLog.length : null
    ), { timeoutMs: 10_000, intervalMs: 100, label: 'mock request observed' });
    result.steps.push('mock_request_observed');

    result.reasoningState = await waitFor(async () => {
      return await sidebarFrame.evaluate(() => {
        const chatContainer = document.querySelector('#chat-container');
        const aiMessages = Array.from(document.querySelectorAll('.message.ai-message'));
        const latest = aiMessages[aiMessages.length - 1];
        if (!latest || !chatContainer) return null;
        const timeline = latest.querySelector('.response-activity-timeline');
        const statusText = latest.querySelector('.text-content')?.innerText || '';
        const panelBodyInner = timeline?.querySelector('.response-activity-panel-body-inner') || null;
        const chatRect = chatContainer.getBoundingClientRect();
        const latestRect = latest.getBoundingClientRect();
        const panelScrollHeight = panelBodyInner?.scrollHeight || 0;
        const panelClientHeight = panelBodyInner?.clientHeight || 0;
        const panelScrollTop = panelBodyInner?.scrollTop || 0;
        if (!timeline || /AUTO_COLLAPSE_BODY_ANSWER_20260410/.test(statusText)) {
          return null;
        }
        if (panelScrollHeight <= panelClientHeight + 16 || panelScrollTop <= 0) {
          return null;
        }
        return {
          statusText,
          panelExpanded: timeline.classList.contains('is-expanded'),
          isUpdating: latest.classList.contains('updating'),
          timelineClassName: timeline.className || '',
          panelBodyHeight: timeline.querySelector('.response-activity-panel-body')?.getBoundingClientRect?.().height || 0,
          panelScrollTop,
          panelScrollHeight,
          panelClientHeight,
          chatScrollTop: chatContainer.scrollTop || 0,
          latestTopInContainer: latestRect.top - chatRect.top,
          distanceToBottom: Math.max(
            0,
            (chatContainer.scrollHeight || 0) - (chatContainer.scrollTop || 0) - (chatContainer.clientHeight || 0)
          )
        };
      });
    }, { timeoutMs: 20_000, intervalMs: 100, label: 'reasoning state with inner overflow visible' });
    result.steps.push('reasoning_state_captured');

    const answerStartedStatePromise = sidebarFrame.evaluate((expectedText) => {
      return new Promise((resolve) => {
        const readSnapshot = () => {
          const chatContainer = document.querySelector('#chat-container');
          const aiMessages = Array.from(document.querySelectorAll('.message.ai-message'));
          const latest = aiMessages[aiMessages.length - 1];
          if (!latest) return null;
          const timeline = latest.querySelector('.response-activity-timeline');
          const statusText = latest.querySelector('.text-content')?.innerText || '';
          if (!timeline || !statusText.includes(expectedText)) {
            return null;
          }
          return {
            statusText,
            panelExpanded: timeline.classList.contains('is-expanded'),
            isUpdating: latest.classList.contains('updating'),
            timelineClassName: timeline.className || '',
            panelBodyHeight: timeline.querySelector('.response-activity-panel-body')?.getBoundingClientRect?.().height || 0,
            panelScrollTop: timeline.querySelector('.response-activity-panel-body-inner')?.scrollTop || 0,
            panelScrollHeight: timeline.querySelector('.response-activity-panel-body-inner')?.scrollHeight || 0,
            panelClientHeight: timeline.querySelector('.response-activity-panel-body-inner')?.clientHeight || 0,
            chatScrollTop: chatContainer.scrollTop || 0,
            latestTopInContainer: latest.getBoundingClientRect().top - chatContainer.getBoundingClientRect().top,
            distanceToBottom: chatContainer
              ? Math.max(0, (chatContainer.scrollHeight || 0) - (chatContainer.scrollTop || 0) - (chatContainer.clientHeight || 0))
              : null
          };
        };
        const maybeResolve = () => {
          const snapshot = readSnapshot();
          if (!snapshot) return;
          cleanup();
          resolve(snapshot);
        };
        const observer = new MutationObserver(() => {
          maybeResolve();
        });
        const cleanup = () => {
          try { observer.disconnect(); } catch (_) {}
          try { clearTimeout(timeoutId); } catch (_) {}
        };
        const timeoutId = setTimeout(() => {
          const snapshot = readSnapshot();
          cleanup();
          resolve(snapshot);
        }, 4000);
        const chatRoot = document.querySelector('#chat-container') || document.body;
        observer.observe(chatRoot, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['class']
        });
        maybeResolve();
      });
    }, mockServer.finalAnswerText);

    result.answerStartedState = await answerStartedStatePromise;
    if (!result.answerStartedState) {
      throw new Error('Timed out waiting for answer-start state visible');
    }
    result.steps.push('answer_started_state_captured');

    result.finalState = await waitFor(async () => {
      return await sidebarFrame.evaluate((expectedText) => {
        const chatContainer = document.querySelector('#chat-container');
        const aiMessages = Array.from(document.querySelectorAll('.message.ai-message'));
        const latest = aiMessages[aiMessages.length - 1];
        if (!latest || latest.classList.contains('updating')) return null;
        const timeline = latest.querySelector('.response-activity-timeline');
        const statusText = latest.querySelector('.text-content')?.innerText || '';
        if (!statusText.includes(expectedText)) return null;
        const timelineClassName = timeline?.className || '';
        const panelBodyHeight = timeline?.querySelector('.response-activity-panel-body')?.getBoundingClientRect?.().height || 0;
        if (/\bis-peek\b/.test(timelineClassName) || /\bis-streaming\b/.test(timelineClassName) || panelBodyHeight > 1) {
          return null;
        }
        return {
          statusText,
          panelExpanded: timeline ? timeline.classList.contains('is-expanded') : null,
          isUpdating: latest.classList.contains('updating'),
          timelineClassName,
          panelBodyHeight,
          chatScrollTop: chatContainer.scrollTop || 0,
          latestTopInContainer: latest.getBoundingClientRect().top - chatContainer.getBoundingClientRect().top,
          distanceToBottom: chatContainer
            ? Math.max(0, (chatContainer.scrollHeight || 0) - (chatContainer.scrollTop || 0) - (chatContainer.clientHeight || 0))
            : null
        };
      }, mockServer.finalAnswerText);
    }, { timeoutMs: 20_000, intervalMs: 100, label: 'final settled state visible' });
    result.steps.push('final_state_captured');

    result.anchorDrift = {
      reasoningToAnswerPx: Math.abs(
        Number(result.answerStartedState?.latestTopInContainer || 0)
        - Number(result.reasoningState?.latestTopInContainer || 0)
      ),
      reasoningToFinalPx: Math.abs(
        Number(result.finalState?.latestTopInContainer || 0)
        - Number(result.reasoningState?.latestTopInContainer || 0)
      ),
      reasoningToAnswerScrollPx: Math.abs(
        Number(result.answerStartedState?.chatScrollTop || 0)
        - Number(result.reasoningState?.chatScrollTop || 0)
      ),
      reasoningToFinalScrollPx: Math.abs(
        Number(result.finalState?.chatScrollTop || 0)
        - Number(result.reasoningState?.chatScrollTop || 0)
      )
    };

    await sidebarFrame.locator('body').screenshot({
      path: path.join(outputDir, 'sidebar-body-final.png')
    });
    await page.screenshot({
      path: path.join(outputDir, 'host-page-final.png'),
      fullPage: true
    });

    if (!result.reasoningState.isUpdating) {
      throw new Error('Expected reasoning state to still be updating');
    }
    if (result.reasoningState.panelExpanded) {
      throw new Error('Expected response activity panel to stay in peek mode while reasoning is visible');
    }
    if ((result.reasoningState.panelScrollHeight ?? 0) <= (result.reasoningState.panelClientHeight ?? 0) + 16) {
      throw new Error('Expected peek thought window to overflow internally during reasoning');
    }
    if ((result.reasoningState.panelScrollTop ?? 0) <= 0) {
      throw new Error('Expected peek thought window to scroll internally during reasoning');
    }
    if (result.answerStartedState.panelExpanded) {
      throw new Error('Response activity panel should not fully expand when answer text starts');
    }
    if (!/\bis-peek\b/.test(result.answerStartedState.timelineClassName || '')) {
      throw new Error(`Expected thought window to stay in peek mode while turn is still streaming: ${result.answerStartedState.timelineClassName}`);
    }
    if ((result.answerStartedState.panelBodyHeight ?? 0) <= 0) {
      throw new Error('Expected peek thought window body to stay visible while turn is still streaming');
    }
    if ((result.anchorDrift?.reasoningToAnswerPx ?? Infinity) > 12) {
      throw new Error(`Latest assistant top anchor drifted during answer start: ${result.anchorDrift?.reasoningToAnswerPx}px`);
    }
    if ((result.anchorDrift?.reasoningToAnswerScrollPx ?? Infinity) > 12) {
      throw new Error(`Outer chat scrollTop drifted during answer start: ${result.anchorDrift?.reasoningToAnswerScrollPx}px`);
    }
    if (result.finalState.panelExpanded) {
      throw new Error('Response activity panel re-expanded after completion');
    }
    if (/\bis-peek\b/.test(result.finalState.timelineClassName || '')) {
      throw new Error(`Expected peek thought window to auto-collapse after thinking completed: ${result.finalState.timelineClassName}`);
    }
    if (/\bis-streaming\b/.test(result.finalState.timelineClassName || '')) {
      throw new Error(`Expected response activity timeline to leave streaming state after completion: ${result.finalState.timelineClassName}`);
    }
    if ((result.finalState.panelBodyHeight ?? 0) > 1) {
      throw new Error(`Expected thought window body to collapse after completion, got height ${result.finalState.panelBodyHeight}`);
    }
    if ((result.anchorDrift?.reasoningToFinalPx ?? Infinity) > 12) {
      throw new Error(`Latest assistant top anchor drifted by completion: ${result.anchorDrift?.reasoningToFinalPx}px`);
    }
    if ((result.anchorDrift?.reasoningToFinalScrollPx ?? Infinity) > 12) {
      throw new Error(`Outer chat scrollTop drifted by completion: ${result.anchorDrift?.reasoningToFinalScrollPx}px`);
    }
    if (mockServer.requestLog.length !== 1) {
      throw new Error(`Expected exactly 1 mock request, got ${mockServer.requestLog.length}`);
    }
  } finally {
      result.mockRequestCount = mockServer.requestLog.length;
      try {
        if (sidebarFrame) {
          result.latestAssistantSnapshot = await sidebarFrame.evaluate(() => {
            const aiMessages = Array.from(document.querySelectorAll('.message.ai-message'));
            const latest = aiMessages[aiMessages.length - 1] || null;
            const timeline = latest?.querySelector?.('.response-activity-timeline') || null;
            const chatContainer = document.querySelector('#chat-container');
            return {
              aiCount: aiMessages.length,
              latestClassName: latest?.className || '',
              latestText: latest?.querySelector?.('.text-content')?.innerText || '',
              hasTimeline: !!timeline,
              panelExpanded: !!timeline?.classList?.contains?.('is-expanded'),
              timelineClassName: timeline?.className || '',
              distanceToBottom: chatContainer
                ? Math.max(0, (chatContainer.scrollHeight || 0) - (chatContainer.scrollTop || 0) - (chatContainer.clientHeight || 0))
                : null,
              latestHtml: latest?.innerHTML || ''
            };
          });
          await sidebarFrame.locator('body').screenshot({
            path: path.join(outputDir, 'sidebar-body-final.png')
          });
        }
      } catch (_) {}
      try {
        if (page) {
          await page.screenshot({
            path: path.join(outputDir, 'host-page-final.png'),
            fullPage: true
          });
        }
      } catch (_) {}
      result.finishedAt = new Date().toISOString();
      try {
        await fs.writeFile(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
      } catch (_) {}
    try {
      await context?.close?.();
    } catch (_) {}
    try {
      await mockServer.close();
    } catch (_) {}
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
