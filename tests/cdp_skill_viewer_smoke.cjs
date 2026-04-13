const fsp = require('fs/promises');
const path = require('path');
const {
  buildSendContentMessageExpression,
  launchFixedSidebarContext,
  loadPlaywright,
  reloadUnpackedExtension,
  resolveFixedSidebarProfileDir,
  resolveStableChromeExecutablePath,
  shouldRunHeadless,
  waitFor,
  waitForSidebarFrame
} = require('./lib/stable_chrome_sidebar_harness.cjs');
const {
  launchWorktreeUnpackedChromiumContext,
  resolveWorktreeUnpackedProfileDir,
  waitForWorktreeExtensionWorker
} = require('./lib/worktree_unpacked_extension_harness.cjs');

const [rawRepoRoot, rawOutputDir, rawArg3 = '', rawArg4 = '', rawArg5 = ''] = process.argv.slice(2);
const repoRoot = rawRepoRoot ? path.resolve(rawRepoRoot) : '';
const outputDir = rawOutputDir ? path.resolve(rawOutputDir) : '';
const launchMode = (rawArg3 === 'stable' || rawArg3 === 'worktree_unpacked')
  ? rawArg3
  : ((rawArg4 === 'stable' || rawArg4 === 'worktree_unpacked') ? rawArg4 : 'stable');
const chromePath = (launchMode === rawArg3) ? '' : rawArg3;
const targetUrl = String(
  (launchMode === rawArg4)
    ? rawArg5
    : rawArg4
  || 'https://example.com/'
).trim() || 'https://example.com/';

if (!repoRoot || !outputDir) {
  throw new Error(
    'Usage: node tests/cdp_skill_viewer_smoke.cjs <repoRoot> <outputDir> [chromePath] [mode=stable|worktree_unpacked] [targetUrl=https://example.com/]'
  );
}

const runHeadless = shouldRunHeadless();
const { chromium } = loadPlaywright(repoRoot);
const skillName = `example-dom-skill-${Date.now()}`;

function buildStorageSeed() {
  const sourceId = 'src_skill_viewer_smoke';
  const config = {
    id: 'cfg_skill_viewer_smoke',
    connectionSourceId: sourceId,
    displayName: 'Skill Viewer Smoke',
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
    name: 'Skill Viewer Smoke Source',
    connectionType: 'openai_responses',
    baseUrl: 'http://127.0.0.1:9',
    apiKey: 'smoke-key',
    apiKeyFilePath: ''
  };
  return {
    apiConfigs_chunk_0: JSON.stringify({ v: 2, items: [config], connectionSources: [source] }),
    apiConfigs_chunks_meta: { count: 1, updatedAt: Date.now() },
    selectedConfigIndex: 0,
    sendChatHistory: true,
    showThoughtProcess: true,
    queueCurrentConversationMessages: true,
    autoGenerateConversationTitle: false
  };
}

function buildSkillInput(urlString) {
  return {
    name: skillName,
    description: 'Read example.com title and href for smoke verification.',
    interface: {
      display_name: 'Example DOM Skill',
      short_description: 'Smoke skill for the Skill 管理 panel',
      default_prompt: 'Read the current example.com page title.'
    },
    resources: ['references'],
    examples: true
  };
}

async function writeResult(output) {
  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.writeFile(path.join(outputDir, 'result.json'), JSON.stringify(output, null, 2), 'utf8');
}

async function cleanupSmokeSkills(sidebarFrame, prefix) {
  return await sidebarFrame.evaluate(async (skillPrefix) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tabId = typeof tab?.id === 'number' ? tab.id : null;
    const listed = await chrome.runtime.sendMessage({
      type: 'MICRO_SKILL_REGISTRY_ACTION',
      tabId,
      payload: {
        action: 'list'
      }
    });
    const deleted = [];
    const skills = Array.isArray(listed?.skills) ? listed.skills : [];
    for (const skill of skills) {
      const name = typeof skill?.name === 'string' ? skill.name.trim() : '';
      if (!name || !name.startsWith(skillPrefix)) continue;
      await chrome.runtime.sendMessage({
        type: 'MICRO_SKILL_REGISTRY_ACTION',
        tabId,
        payload: {
          action: 'delete_skill',
          skill_name: name
        }
      });
      deleted.push(name);
    }
    return deleted;
  }, prefix);
}

async function main() {
  const result = {
    startedAt: new Date().toISOString(),
    targetUrl,
    launchMode,
    headless: runHeadless,
    steps: [],
    errors: []
  };

  const profileDir = launchMode === 'worktree_unpacked'
    ? resolveWorktreeUnpackedProfileDir(repoRoot, 'skill-viewer-smoke')
    : resolveFixedSidebarProfileDir(repoRoot);
  await fsp.mkdir(profileDir, { recursive: true });
  result.profileDir = profileDir;

  let context = null;
  try {
    context = launchMode === 'worktree_unpacked'
      ? await launchWorktreeUnpackedChromiumContext({
          chromium,
          repoRoot,
          profileDir,
          headless: runHeadless
        })
      : await launchFixedSidebarContext({
          chromium,
          profileDir,
          executablePath: chromePath || resolveStableChromeExecutablePath(),
          headless: runHeadless
        });
    result.steps.push('browser_ready');

    const extensionWorker = launchMode === 'worktree_unpacked'
      ? await waitForWorktreeExtensionWorker(context, { timeoutMs: 30_000 })
      : await reloadUnpackedExtension(context, { timeoutMs: 30_000 });
    const extensionId = new URL(extensionWorker.url()).host;
    result.extensionId = extensionId;
    result.steps.push('extension_ready');

    await extensionWorker.evaluate(`(async () => {
      await chrome.storage.sync.clear();
      await chrome.storage.sync.set(${JSON.stringify(buildStorageSeed())});
      return true;
    })()`);
    result.steps.push('storage_seeded');

    const page = context.pages()[0] || await context.newPage();
    page.on('pageerror', (error) => {
      result.errors.push(String(error?.stack || error?.message || error));
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        result.errors.push(msg.text());
      }
    });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    result.steps.push('page_loaded');

    const openSidebarResponse = await extensionWorker.evaluate(
      buildSendContentMessageExpression(JSON.stringify({ type: 'OPEN_SIDEBAR' }))
    );
    result.openSidebarResponse = openSidebarResponse;
    result.steps.push('sidebar_open_requested');

    await waitFor(async () => {
      const payload = await extensionWorker.evaluate(
        buildSendContentMessageExpression(JSON.stringify({ type: 'GET_SIDEBAR_DEBUG_STATE' }))
      );
      return payload?.response?.debugState?.isActuallyVisible ? payload.response.debugState : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: 'sidebar visibility' });
    result.steps.push('sidebar_visible');

    const sidebarFrame = await waitForSidebarFrame(page, extensionId, { timeoutMs: 30_000 });
    await sidebarFrame.locator('#message-input').waitFor({ state: 'visible', timeout: 30_000 });
    await waitFor(
      () => sidebarFrame.evaluate(() => Array.isArray(window.apiConfigs) && window.apiConfigs.length > 0),
      { timeoutMs: 20_000, intervalMs: 250, label: 'sidebar api configs ready' }
    );
    result.steps.push('sidebar_ready');

    result.precleanDeletedSkills = await cleanupSmokeSkills(sidebarFrame, 'example-dom-skill');
    result.steps.push('preclean_completed');

    const created = await sidebarFrame.evaluate(async (skill) => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return await chrome.runtime.sendMessage({
        type: 'MICRO_SKILL_REGISTRY_ACTION',
        tabId: typeof tab?.id === 'number' ? tab.id : null,
        payload: {
          action: 'create_skill',
          skill
        }
      });
    }, buildSkillInput(targetUrl));
    if (!created?.success || created?.ok !== true) {
      throw new Error(`create_skill failed: ${JSON.stringify(created)}`);
    }
    if (created?.create_mode !== 'template') {
      throw new Error(`expected template create_mode, got: ${JSON.stringify(created)}`);
    }
    if (created?.skill?.enabled !== false) {
      throw new Error(`expected created template to stay disabled by default: ${JSON.stringify(created)}`);
    }
    if (created?.refreshed_current_document !== false) {
      throw new Error(`template create should not refresh current document: ${JSON.stringify(created)}`);
    }
    result.createdSkill = created?.skill?.name || skillName;
    result.createResult = {
      createMode: created?.create_mode || '',
      createdFiles: Array.isArray(created?.created_files) ? created.created_files : [],
      nextSteps: Array.isArray(created?.next_steps) ? created.next_steps : []
    };
    result.steps.push('skill_created');

    await waitFor(async () => {
      const ready = await sidebarFrame.evaluate(() => Boolean(window.cerebr?.debug?.chatHistoryUI));
      return ready ? true : null;
    }, { timeoutMs: 30_000, intervalMs: 200, label: 'sidebar debug chatHistoryUI ready' });

    await sidebarFrame.evaluate(async () => {
      await window.cerebr.debug.chatHistoryUI.showChatHistoryPanel('micro-skills');
    });
    const historyPanel = sidebarFrame.locator('#chat-history-panel');
    await historyPanel.waitFor({ state: 'visible', timeout: 30_000 });
    await sidebarFrame.locator('.history-tab[data-tab="micro-skills"]').waitFor({ state: 'visible', timeout: 30_000 });
    result.steps.push('history_panel_opened');

    const skillListItem = sidebarFrame.locator('.micro-skill-list-item', {
      has: sidebarFrame.locator('.micro-skill-list-item-title', { hasText: 'Example DOM Skill' })
    }).first();
    await skillListItem.waitFor({ state: 'visible', timeout: 30_000 });
    await skillListItem.click();
    result.steps.push('skill_selected');

    const detailTitle = sidebarFrame.locator('.micro-skill-detail-title');
    await waitFor(async () => {
      const text = await detailTitle.textContent().catch(() => '');
      return String(text || '').includes('Example DOM Skill') ? text : null;
    }, { timeoutMs: 30_000, intervalMs: 200, label: 'skill detail title' });
    result.detailTitle = await detailTitle.textContent();

    const skillInstruction = sidebarFrame.locator('.micro-skill-text-block').first();
    await skillInstruction.waitFor({ state: 'visible', timeout: 30_000 });
    result.skillInstructionExcerpt = await skillInstruction.textContent();
    result.steps.push('skill_detail_loaded');

    await sidebarFrame.getByRole('button', { name: '加载文件包' }).click();
    await sidebarFrame.locator('.micro-skill-source-file').first().waitFor({ state: 'visible', timeout: 30_000 });
    result.steps.push('skill_source_loaded');

    await sidebarFrame.locator('body').screenshot({ path: path.join(outputDir, 'skill-viewer.png') });

    const runtimeFilePatched = await sidebarFrame.evaluate(async (skillNameValue) => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return await chrome.runtime.sendMessage({
        type: 'MICRO_SKILL_REGISTRY_ACTION',
        tabId: typeof tab?.id === 'number' ? tab.id : null,
        payload: {
          action: 'apply_patch',
          skill_name: skillNameValue,
          patch: [
            '*** Begin Patch',
            '*** Add File: src/main.js',
            '+return {',
            '+  readSummary() {',
            '+    return { title: document.title, href: location.href };',
            '+  }',
            '+};',
            '*** End Patch'
          ].join('\n')
        }
      });
    }, skillName);
    if (!runtimeFilePatched?.success || runtimeFilePatched?.ok !== true) {
      throw new Error(`add runtime file failed: ${JSON.stringify(runtimeFilePatched)}`);
    }
    result.steps.push('runtime_file_added');

    const runtimeManifestPatched = await sidebarFrame.evaluate(async ({ skillNameValue, urlString }) => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const url = new URL(urlString);
      return await chrome.runtime.sendMessage({
        type: 'MICRO_SKILL_REGISTRY_ACTION',
        tabId: typeof tab?.id === 'number' ? tab.id : null,
        payload: {
          action: 'apply_patch',
          skill_name: skillNameValue,
          patch: [
            '*** Begin Patch',
            '*** Update File: manifest.json',
            '@@',
            '-  "match": [],',
            '+  "match": [',
            `+    "${url.origin}/*"`,
            '+  ],',
            '@@',
            '-    "entry_path": null',
            '+    "entry_path": "src/main.js"',
            '*** End Patch'
          ].join('\n')
        }
      });
    }, { skillNameValue: skillName, urlString: targetUrl });
    if (!runtimeManifestPatched?.success || runtimeManifestPatched?.ok !== true || runtimeManifestPatched?.skill?.kind !== 'page_runtime') {
      throw new Error(`patch runtime manifest failed: ${JSON.stringify(runtimeManifestPatched)}`);
    }
    result.steps.push('runtime_manifest_patched');

    const enabledState = await sidebarFrame.evaluate(async (skillNameValue) => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return await chrome.runtime.sendMessage({
        type: 'MICRO_SKILL_REGISTRY_ACTION',
        tabId: typeof tab?.id === 'number' ? tab.id : null,
        payload: {
          action: 'enable_skill',
          skill_name: skillNameValue
        }
      });
    }, skillName);
    if (!enabledState?.success || enabledState?.ok !== true || enabledState?.skill?.enabled !== true) {
      throw new Error(`enable_skill failed: ${JSON.stringify(enabledState)}`);
    }
    result.steps.push('skill_enabled');

    const refreshState = await sidebarFrame.evaluate(async (skillName) => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return await chrome.runtime.sendMessage({
        type: 'MICRO_SKILL_REGISTRY_ACTION',
        tabId: typeof tab?.id === 'number' ? tab.id : null,
        payload: {
          action: 'mount_on_current_page',
          skill_name: skillName
        }
      });
    }, skillName);
    if (!refreshState?.success || refreshState?.ok !== true || refreshState?.mounted_on_current_page !== true) {
      throw new Error(`mount_on_current_page failed after UI click: ${JSON.stringify(refreshState)}`);
    }
    const activeSkills = Array.isArray(refreshState?.active_skills)
      ? refreshState.active_skills
      : [];
    if (!activeSkills.includes(skillName)) {
      throw new Error(`${skillName} not mounted after refresh: ${JSON.stringify(refreshState)}`);
    }
    result.activeSkills = activeSkills;
    result.steps.push('runtime_mount_verified');

    result.postRunDeletedSkills = await cleanupSmokeSkills(sidebarFrame, skillName);
    result.steps.push('postclean_completed');

    result.ok = true;
  } catch (error) {
    result.ok = false;
    result.error = String(error?.stack || error?.message || error);
    throw error;
  } finally {
    result.finishedAt = new Date().toISOString();
    try {
      await writeResult(result);
    } catch (_) {}
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
