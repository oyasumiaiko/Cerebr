const fsp = require('fs/promises');
const http = require('http');
const net = require('net');
const path = require('path');
const {
  buildSendContentMessageExpression,
  launchFixedSidebarContext,
  loadPlaywright,
  resolveFixedSidebarProfileDir,
  sleep,
  shouldRunHeadless,
  waitFor,
  waitForExtensionWorker,
  waitForSidebarFrame
} = require('./lib/stable_chrome_sidebar_harness.cjs');

const [repoRoot, outputDir, chromePath] = process.argv.slice(2);

if (!repoRoot || !outputDir || !chromePath) {
  throw new Error(
    'Usage: node tests/cdp_steer_tool_loop_regression.cjs <repoRoot> <outputDir> <chromePath>'
  );
}

const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);

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


function buildStorageSeed(baseUrl) {
  const sourceId = 'src_steer_tool_loop_regression';
  const config = {
    id: 'cfg_steer_tool_loop_regression',
    connectionSourceId: sourceId,
    displayName: 'Steer Tool Loop Regression',
    modelName: 'gpt-5.4-mini',
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
        web_search: {
          enabled: false
        }
      }
    }
  };
  const source = {
    id: sourceId,
    name: 'Mock Responses Source',
    connectionType: 'openai_responses',
    baseUrl,
    apiKey: 'mock-key',
    apiKeyFilePath: ''
  };
  return {
    apiConfigs_chunk_0: JSON.stringify({ v: 2, items: [config], connectionSources: [source] }),
    apiConfigs_chunks_meta: { count: 1, updatedAt: Date.now() },
    selectedConfigIndex: 0,
    showThoughtProcess: true,
    queueCurrentConversationMessages: true,
    autoGenerateConversationTitle: false
  };
}

function createPageHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Steer tool loop regression</title>
  </head>
  <body>
    <main>
      <h1>Steer tool loop regression</h1>
      <p>This page only exists to host the Cerebr sidebar during the regression test.</p>
    </main>
  </body>
</html>`;
}

function createMessageItem(id, text) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    phase: 'answer',
    status: 'completed',
    content: [
      {
        type: 'output_text',
        text
      }
    ]
  };
}

function createFunctionCallItem(callId, codeText) {
  return {
    id: `fc_${callId}`,
    type: 'function_call',
    call_id: callId,
    name: 'js_runtime_execute',
    arguments: JSON.stringify({
      code: codeText,
      timeout_ms: null,
      frame_ids: null
    }),
    status: 'completed'
  };
}

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function runMockResponsesServer() {
  const requestLog = [];
  const steerTexts = [
    'STEER_TOOL_HOP_A_20260413',
    'STEER_TOOL_HOP_B_20260413'
  ];
  const stage2VisibleText = 'SECOND_HOP_VISIBLE_TEXT_20260408';
  const pageHtml = createPageHtml();
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store'
        });
        res.end(pageHtml);
        return;
      }

      if (req.method === 'POST' && req.url === '/v1/responses') {
        let body = '';
        req.on('data', (chunk) => {
          body += String(chunk);
        });
        req.on('end', async () => {
          let parsed = null;
          try {
            parsed = JSON.parse(body);
          } catch (error) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: { message: `invalid json: ${error.message}` } }));
            return;
          }

          requestLog.push(parsed);
          const inputItems = Array.isArray(parsed?.input) ? parsed.input : [];
          const inputTexts = inputItems.flatMap((item) => {
            if (!item || typeof item !== 'object') return [];
            if (typeof item.content === 'string') return [item.content];
            if (!Array.isArray(item.content)) return [];
            return item.content
              .map((part) => (typeof part?.text === 'string' ? part.text : ''))
              .filter(Boolean);
          });
          const allText = inputTexts.join('\n');
          const hasTool1Output = inputItems.some((item) => item?.type === 'function_call_output' && item?.call_id === 'call_1');
          const hasTool2Output = inputItems.some((item) => item?.type === 'function_call_output' && item?.call_id === 'call_2');
          const steerTextsInRequest = steerTexts.filter((text) => allText.includes(text));
          const hasAllSteers = steerTextsInRequest.length === steerTexts.length;

          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
            'access-control-allow-origin': '*'
          });

          if (!hasTool1Output) {
            const functionCall = createFunctionCallItem(
              'call_1',
              "await new Promise((resolve) => setTimeout(resolve, 250)); console.log('tool-1'); return 'tool-1-done';"
            );
            writeSseEvent(res, { type: 'response.created', response: { id: 'resp_1' } });
            writeSseEvent(res, { type: 'response.in_progress', response: { id: 'resp_1' } });
            writeSseEvent(res, { type: 'response.output_item.added', item: functionCall });
            writeSseEvent(res, { type: 'response.output_item.done', item: functionCall });
            writeSseEvent(res, {
              type: 'response.completed',
              response: {
                id: 'resp_1',
                output: [functionCall],
                usage: {
                  input_tokens: 100,
                  output_tokens: 10,
                  total_tokens: 110,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens_details: { reasoning_tokens: 0 }
                }
              }
            });
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }

          if (!hasTool2Output) {
            const messageItem = createMessageItem('msg_2', stage2VisibleText);
            const functionCall = createFunctionCallItem(
              'call_2',
              "await new Promise((resolve) => setTimeout(resolve, 2500)); console.log('tool-2'); return 'tool-2-done';"
            );
            writeSseEvent(res, { type: 'response.created', response: { id: 'resp_2' } });
            writeSseEvent(res, { type: 'response.in_progress', response: { id: 'resp_2' } });
            writeSseEvent(res, { type: 'response.output_item.added', item: messageItem });
            writeSseEvent(res, {
              type: 'response.output_text.delta',
              item_id: 'msg_2',
              output_item_id: 'msg_2',
              output_index: 0,
              content_index: 0,
              delta: stage2VisibleText
            });
            writeSseEvent(res, {
              type: 'response.output_text.done',
              item_id: 'msg_2',
              output_item_id: 'msg_2',
              output_index: 0,
              content_index: 0,
              text: stage2VisibleText
            });
            writeSseEvent(res, { type: 'response.output_item.done', item: messageItem });
            await sleep(1500);
            writeSseEvent(res, { type: 'response.output_item.added', item: functionCall });
            writeSseEvent(res, { type: 'response.output_item.done', item: functionCall });
            writeSseEvent(res, {
              type: 'response.completed',
              response: {
                id: 'resp_2',
                output: [messageItem, functionCall],
                usage: {
                  input_tokens: 120,
                  output_tokens: 20,
                  total_tokens: 140,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens_details: { reasoning_tokens: 0 }
                }
              }
            });
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }

          const finalText = hasAllSteers
            ? `STEER_APPLIED_20260408 ${steerTextsInRequest.join(' | ')}`
            : 'STEER_MISSING_20260408';
          const messageItem = createMessageItem('msg_3', finalText);
          writeSseEvent(res, { type: 'response.created', response: { id: 'resp_3' } });
          writeSseEvent(res, { type: 'response.in_progress', response: { id: 'resp_3' } });
          await sleep(1200);
          writeSseEvent(res, { type: 'response.output_item.added', item: messageItem });
          writeSseEvent(res, {
            type: 'response.output_text.delta',
            item_id: 'msg_3',
            output_item_id: 'msg_3',
            output_index: 0,
            content_index: 0,
            delta: finalText
          });
          writeSseEvent(res, {
            type: 'response.output_text.done',
            item_id: 'msg_3',
            output_item_id: 'msg_3',
            output_index: 0,
            content_index: 0,
            text: finalText
          });
          writeSseEvent(res, { type: 'response.output_item.done', item: messageItem });
          writeSseEvent(res, {
            type: 'response.completed',
            response: {
              id: 'resp_3',
              output: [messageItem],
              usage: {
                input_tokens: 150,
                output_tokens: 30,
                total_tokens: 180,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens_details: { reasoning_tokens: 0 }
              }
            }
          });
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
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
    port,
    origin: `http://127.0.0.1:${port}`,
    requestLog,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

async function main() {
  await fsp.mkdir(outputDir, { recursive: true });
  const result = {
    startedAt: new Date().toISOString(),
    outputDir,
    console: [],
    backgroundConsole: [],
    steps: []
  };

  const mockServer = await runMockResponsesServer();
  result.mockOrigin = mockServer.origin;
  const profileDir = path.join(outputDir, 'profile');
  const seedProfileDir = resolveFixedSidebarProfileDir(repoRoot);
  if (await fsp.stat(seedProfileDir).then(() => true).catch(() => false)) {
    await fsp.cp(seedProfileDir, profileDir, { recursive: true, force: true });
    result.seedProfileDir = seedProfileDir;
  } else {
    await fsp.mkdir(profileDir, { recursive: true });
  }
  result.profileDir = profileDir;

  let context = null;
  let extensionWorker = null;
  try {
    context = await launchFixedSidebarContext({
      chromium,
      profileDir,
      executablePath: chromePath,
      headless: runHeadless
    });
    result.steps.push('browser_ready');

    extensionWorker = await waitForExtensionWorker(context, { timeoutMs: 30_000 });
    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;
    result.steps.push('extension_id_resolved');

    await extensionWorker.evaluate(`(async () => {
      await chrome.storage.sync.clear();
      await chrome.storage.local.clear();
      await chrome.storage.sync.set(${JSON.stringify(buildStorageSeed(`${mockServer.origin}/v1/responses`))});
      return true;
    })()`);
    result.steps.push('storage_seeded');

    result.backgroundStorageSnapshot = await extensionWorker.evaluate(`(async () => {
      const syncSnapshot = await chrome.storage.sync.get(null);
      return {
        syncKeys: Object.keys(syncSnapshot).sort(),
        selectedConfigIndex: syncSnapshot.selectedConfigIndex || 0
      };
    })()`);
    result.steps.push('background_storage_checked');

    const hostPage = context.pages().find((page) => page.url().startsWith('https://example.com/')) || await context.newPage();
    hostPage.on('console', (msg) => {
      result.console.push({ type: msg.type(), text: msg.text() });
    });
    hostPage.on('pageerror', (error) => {
      result.console.push({ type: 'pageerror', text: String(error && (error.stack || error.message || error)) });
    });
    await hostPage.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    await hostPage.bringToFront();
    result.steps.push('host_page_ready');

    const openSidebarResponse = await extensionWorker.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'OPEN_SIDEBAR' }))
    );
    result.openSidebarResponse = openSidebarResponse;
    result.steps.push('sidebar_open_requested');

    const sidebarFrame = await waitForSidebarFrame(hostPage, extensionId, { timeoutMs: 30_000 });
    await sidebarFrame.locator('#message-input').waitFor({ state: 'visible', timeout: 30000 });
    result.sidebarStorageSnapshot = await sidebarFrame.evaluate(async () => {
      const syncSnapshot = await globalThis.chrome.storage.sync.get(null);
      return {
        syncKeys: Object.keys(syncSnapshot).sort(),
        apiConfigsLength: Array.isArray(window.apiConfigs) ? window.apiConfigs.length : null,
        apiConfigBaseUrls: Array.isArray(window.apiConfigs)
          ? window.apiConfigs.map((config) => config?.baseUrl || '')
          : []
      };
    });
    result.steps.push('sidebar_ready');

    async function fillSidebarInput(text) {
      const input = sidebarFrame.locator('#message-input');
      await input.focus();
      await hostPage.keyboard.press('Control+A');
      await hostPage.keyboard.press('Backspace');
      await hostPage.keyboard.type(text);
    }

    async function sendSidebarMessage(text, shortcut = 'Enter') {
      await fillSidebarInput(text);
      await hostPage.keyboard.press(shortcut);
    }

    await sendSidebarMessage('Start the steer regression test.');
    result.steps.push('first_message_sent');

    await waitFor(async () => mockServer.requestLog.length >= 2 ? true : null, {
      timeoutMs: 20000,
      intervalMs: 100,
      label: 'second request sent'
    });
    result.steps.push('second_request_observed');

    result.toolStateBeforeWrapperReplace = await waitFor(async () => {
      return await sidebarFrame.evaluate(() => {
        const aiMessages = Array.from(document.querySelectorAll('.message.ai-message[data-message-id]'));
        const latest = aiMessages[aiMessages.length - 1] || null;
        if (!latest) return null;
        const toolEntries = Array.from(latest.querySelectorAll('.response-activity-entry--tool.is-expanded'));
        if (toolEntries.length <= 0) return null;
        return {
          messageId: latest.getAttribute('data-message-id') || '',
          expandedToolCount: toolEntries.length,
          timelineClassName: latest.querySelector('.response-activity-timeline')?.className || ''
        };
      });
    }, { timeoutMs: 30000, intervalMs: 100, label: 'expanded tool entry visible' });
    result.steps.push('tool_entry_visible');

    result.wrapperReplaceResult = await sidebarFrame.evaluate((targetMessageId) => {
      const aiMessages = Array.from(document.querySelectorAll('.message.ai-message[data-message-id]'));
      const target = aiMessages.find((el) => (el.getAttribute('data-message-id') || '') === targetMessageId) || null;
      if (!target) {
        return {
          replaced: false,
          messageId: targetMessageId || ''
        };
      }
      const clone = target.cloneNode(true);
      target.replaceWith(clone);
      return {
        replaced: true,
        messageId: clone.getAttribute('data-message-id') || '',
        toolCount: clone.querySelectorAll('.response-activity-entry--tool').length
      };
    }, result.toolStateBeforeWrapperReplace.messageId);
    result.steps.push('assistant_wrapper_replaced');

    await sleep(300);
    await sendSidebarMessage('STEER_TOOL_HOP_A_20260413', 'Control+Enter');
    result.steps.push('steer_a_sent');
    await sleep(180);
    await sendSidebarMessage('STEER_TOOL_HOP_B_20260413', 'Control+Enter');
    result.steps.push('steer_b_sent');
    await sleep(500);
    result.pendingSteerPreview = await sidebarFrame.evaluate(() => {
      const panel = document.querySelector('.conversation-send-queue-preview');
      if (!panel) return null;
      return {
        text: (panel.innerText || '').trim(),
        steerWindowCount: panel.querySelectorAll('.conversation-send-queue-preview__pending-steer-window').length,
        steerItemCount: panel.querySelectorAll('.conversation-send-queue-preview__pending-steer-item').length
      };
    });
    result.steerTimelineEntry = await waitFor(async () => {
      return await sidebarFrame.evaluate((targetMessageId) => {
        const aiMessages = Array.from(document.querySelectorAll('.message.ai-message[data-message-id]'));
        const target = aiMessages.find((el) => (el.getAttribute('data-message-id') || '') === targetMessageId)
          || aiMessages[aiMessages.length - 1]
          || null;
        if (!target) return null;
        const steerEntry = target.querySelector('.response-activity-entry--steer');
        if (!steerEntry) return null;
        return {
          className: steerEntry.className || '',
          text: (steerEntry.innerText || '').trim(),
          label: (steerEntry.querySelector('.response-activity-entry-label--steer')?.innerText || '').trim(),
          title: (steerEntry.querySelector('.response-activity-entry-title--steer')?.innerText || '').trim(),
          itemCount: steerEntry.querySelectorAll('li').length
        };
      }, result.toolStateBeforeWrapperReplace.messageId);
    }, { timeoutMs: 10000, intervalMs: 150, label: 'steer timeline entry visible' });
    result.toastTextsAfterSteer = await sidebarFrame.evaluate(() => (
      Array.from(document.querySelectorAll('.notification-toast, .notification, .toast'))
        .map((el) => (el.innerText || '').trim())
        .filter(Boolean)
    ));
    await waitFor(async () => mockServer.requestLog.length >= 3 ? true : null, {
      timeoutMs: 15000,
      intervalMs: 100,
      label: 'third follow-up request observed'
    });
    result.steps.push('third_request_observed');
    result.pendingSteerPreviewAfterAcceptance = await sidebarFrame.evaluate(() => {
      const panel = document.querySelector('.conversation-send-queue-preview');
      if (!panel) {
        return {
          exists: false,
          steerWindowCount: 0,
          steerItemCount: 0,
          text: ''
        };
      }
      return {
        exists: true,
        steerWindowCount: panel.querySelectorAll('.conversation-send-queue-preview__pending-steer-window').length,
        steerItemCount: panel.querySelectorAll('.conversation-send-queue-preview__pending-steer-item').length,
        text: (panel.innerText || '').trim()
      };
    });

    const settled = await waitFor(async () => {
      return await sidebarFrame.evaluate(() => {
        const texts = Array.from(document.querySelectorAll('.message.ai-message'))
          .map((el) => (el.innerText || '').trim())
          .filter(Boolean);
        return texts.find((text) => text.includes('STEER_APPLIED_20260408') || text.includes('STEER_MISSING_20260408')) || null;
      });
    }, { timeoutMs: 30000, intervalMs: 250, label: 'final steer result' });
    result.finalAssistantText = settled;
    await sleep(2600);
    result.finalToolTimelineState = await sidebarFrame.evaluate((targetMessageId) => {
      const aiMessages = Array.from(document.querySelectorAll('.message.ai-message[data-message-id]'));
      const target = aiMessages.find((el) => (el.getAttribute('data-message-id') || '') === targetMessageId)
        || aiMessages[aiMessages.length - 1]
        || null;
      if (!target) return null;
      const timeline = target.querySelector('.response-activity-timeline');
      const toolEntries = Array.from(target.querySelectorAll('.response-activity-entry--tool'));
      return {
        messageId: target.getAttribute('data-message-id') || '',
        toolCount: toolEntries.length,
        expandedToolCount: toolEntries.filter((el) => el.classList.contains('is-expanded')).length,
        steerEntryCount: target.querySelectorAll('.response-activity-entry--steer').length,
        timelineClassName: timeline?.className || '',
        timelineDataset: timeline ? { ...timeline.dataset } : null,
        toolClassNames: toolEntries.map((el) => el.className || ''),
        toolStates: toolEntries.map((el) => ({
          key: el.dataset.responseActivityToolKey || '',
          className: el.className || '',
          summaryExpanded: el.querySelector('.response-activity-tool-summary')?.getAttribute?.('aria-expanded') || ''
        }))
      };
    }, result.toolStateBeforeWrapperReplace.messageId);
    result.requestLog = mockServer.requestLog;
    result.thirdRequestInputTexts = (Array.isArray(mockServer.requestLog?.[2]?.input) ? mockServer.requestLog[2].input : []).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      if (typeof item.content === 'string') return [item.content];
      if (!Array.isArray(item.content)) return [];
      return item.content
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .filter(Boolean);
    });

    await hostPage.screenshot({ path: path.join(outputDir, '01-final.png'), fullPage: true });

    const thirdRequestCombinedText = result.thirdRequestInputTexts.join('\n');
    if (!thirdRequestCombinedText.includes('STEER_TOOL_HOP_A_20260413\nSTEER_TOOL_HOP_B_20260413')) {
      throw new Error(`third follow-up request did not include merged steer window text in order: ${JSON.stringify(result.thirdRequestInputTexts)}`);
    }
    if (!String(settled || '').includes('STEER_APPLIED_20260408')) {
      throw new Error(`final assistant text did not confirm steer application: ${settled}`);
    }
    if (!String(result.steerTimelineEntry?.text || '').includes('STEER_TOOL_HOP_A_20260413')) {
      throw new Error(`steer timeline entry did not render the steer text: ${JSON.stringify(result.steerTimelineEntry)}`);
    }
    if (!String(result.steerTimelineEntry?.text || '').includes('STEER_TOOL_HOP_B_20260413')) {
      throw new Error(`steer timeline entry did not render the second steer text: ${JSON.stringify(result.steerTimelineEntry)}`);
    }
    if (String(result.steerTimelineEntry?.label || '').trim() !== '转向 ×2') {
      throw new Error(`steer timeline entry did not aggregate into one steer window label: ${JSON.stringify(result.steerTimelineEntry)}`);
    }
    if ((result.pendingSteerPreview?.steerWindowCount || 0) !== 1 || (result.pendingSteerPreview?.steerItemCount || 0) !== 2) {
      throw new Error(`queue preview did not aggregate pending steers into one window: ${JSON.stringify(result.pendingSteerPreview)}`);
    }
    if ((result.pendingSteerPreviewAfterAcceptance?.steerWindowCount || 0) !== 0) {
      throw new Error(`pending steer preview did not disappear after follow-up request accepted the steer window: ${JSON.stringify(result.pendingSteerPreviewAfterAcceptance)}`);
    }
    if (!result.wrapperReplaceResult?.replaced) {
      throw new Error(`failed to replace assistant wrapper for regression probe: ${JSON.stringify(result.wrapperReplaceResult)}`);
    }
    if ((result.finalToolTimelineState?.toolCount || 0) <= 0) {
      throw new Error(`expected tool entries to remain visible for auto-collapse verification: ${JSON.stringify(result.finalToolTimelineState)}`);
    }
    if ((result.finalToolTimelineState?.expandedToolCount || 0) > 0) {
      throw new Error(`tool entries stayed expanded after wrapper replacement and auto-collapse window: ${JSON.stringify(result.finalToolTimelineState)}`);
    }
    if ((result.finalToolTimelineState?.steerEntryCount || 0) !== 1) {
      throw new Error(`expected exactly one steer window in final response_activity timeline: ${JSON.stringify(result.finalToolTimelineState)}`);
    }
  } finally {
    result.finishedAt = new Date().toISOString();
    try {
      await fsp.writeFile(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    } catch (_) {}
    try {
      await context?.close?.();
    } catch (_) {}
    try {
      await mockServer.close();
    } catch (_) {}
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
