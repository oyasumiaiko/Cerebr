import {
  buildSkillContextSummary,
  buildSkillDetail,
  buildSkillFileIndexPayload,
  buildSkillFileManifest,
  buildSkillFilePayload,
  buildSkillPackagePayload,
  buildSkillSummary,
  buildStoredSkillRecord,
  deleteStoredSkillPackage,
  getBuiltinSkillRecord,
  getStoredSkillPackage,
  listBuiltinSkillRecords,
  listMatchingStoredSkillPackagesForUrl,
  listStoredSkillManifests,
  SKILL_VIRTUAL_MANIFEST_PATH,
  skillMatchesUrl,
  normalizeSkillFilePath,
  normalizeSkillRegistryToolArguments,
  searchSkillFiles,
  normalizeStoredSkillRecord,
  saveStoredSkillPackage
} from '../agent_tools/skill/registry_tool.js';
import { applySkillPackagePatch } from '../agent_tools/skill/skill_apply_patch.js';
import {
  CEREBR_SKILL_SCRIPT_ID_PREFIX,
  buildSkillDocumentRefreshSource,
  buildSkillMountOnCurrentPageSource,
  buildSkillUnmountFromCurrentPageSource
} from './skill_runtime.js';
import { createIndexedDbSkillStore } from '../storage/skill_store.js';
import { buildSkillScaffoldInput, buildSkillScaffoldNextSteps } from '../agent_tools/skill/skill_scaffold.js';

function normalizeTabId(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

function sortSkillRecords(records) {
  return (Array.isArray(records) ? records : [])
    .map((record) => normalizeStoredSkillRecord(record))
    .filter(Boolean)
    .sort((left, right) => {
      const leftTs = Date.parse(left.updated_at || '') || 0;
      const rightTs = Date.parse(right.updated_at || '') || 0;
      if (leftTs !== rightTs) return rightTs - leftTs;
      return left.name.localeCompare(right.name);
    });
}

// 这里单独提取 runtime 回报的 active skill 名单，避免后续把“URL 命中”误当成“真实已挂载”。
function extractActiveSkillNamesFromRefreshValue(value) {
  const names = [];
  const activeSkills = Array.isArray(value?.active_skills) ? value.active_skills : [];
  for (const item of activeSkills) {
    const name = typeof item === 'string' ? item.trim() : '';
    if (name) names.push(name);
  }
  return Array.from(new Set(names));
}

async function normalizeRefreshExecutionResult(rawResult, matchedRecords) {
  const matchedSkills = sortSkillRecords(matchedRecords)
    .map((record) => buildSkillSummary(record))
    .filter(Boolean);
  const result = (rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult))
    ? rawResult
    : {};
  const activeSkillNames = extractActiveSkillNamesFromRefreshValue(result?.value);
  const firstItemErrorMessage = (() => {
    for (const item of Array.isArray(result?.items) ? result.items : []) {
      const message = typeof item?.error?.message === 'string' ? item.error.message.trim() : '';
      if (message) return message;
    }
    return '';
  })();

  return {
    ok: result.ok === true,
    tab_id: normalizeTabId(result?.tabId),
    matched_skills: matchedSkills,
    active_skills: activeSkillNames,
    value: result?.value ?? null,
    logs: Array.isArray(result?.logs) ? result.logs : [],
    items: Array.isArray(result?.items) ? result.items : [],
    error: (result?.success === false || result?.ok !== true)
      ? {
          message: (typeof result?.error === 'string' && result.error.trim())
            ? result.error.trim()
            : firstItemErrorMessage
              ? firstItemErrorMessage
            : '技能当前文档 refresh 失败。',
          name: 'SkillRefreshError',
          stack: ''
        }
      : null
  };
}

function buildSingleSkillMountErrorMessage(skillName, requestedStatus, runtimeMessage = '') {
  if (runtimeMessage) return runtimeMessage;
  switch (String(requestedStatus || '').trim()) {
    case 'disabled':
      return `技能 ${skillName} 已停用，不能挂载到当前页。`;
    case 'not_page_runtime':
      return `技能 ${skillName} 不是页面 runtime skill，不能挂载到当前页。`;
    case 'url_not_matched':
      return `技能 ${skillName} 与当前页 URL 不匹配，不能挂载到当前页。`;
    default:
      return `技能 ${skillName} 挂载到当前页失败。`;
  }
}

async function normalizeSingleSkillMountExecutionResult(rawResult, skillRecord, options = {}) {
  const skill = normalizeStoredSkillRecord(skillRecord);
  const result = (rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult))
    ? rawResult
    : {};
  const requestedSkillName = skill?.name || String(options?.requestedSkillName || '').trim();
  const activeSkillNames = extractActiveSkillNamesFromRefreshValue(result?.value);
  const mountedOnCurrentPage = requestedSkillName ? activeSkillNames.includes(requestedSkillName) : false;
  const firstItemErrorMessage = (() => {
    for (const item of Array.isArray(result?.items) ? result.items : []) {
      const message = typeof item?.error?.message === 'string' ? item.error.message.trim() : '';
      if (message) return message;
    }
    return '';
  })();

  let requestedSkillStatus = String(options?.requestedSkillStatus || '').trim();
  if (!requestedSkillStatus) {
    requestedSkillStatus = mountedOnCurrentPage ? 'mounted' : 'runtime_failed';
  } else if (requestedSkillStatus === 'mounted' && !mountedOnCurrentPage) {
    requestedSkillStatus = 'runtime_failed';
  }

  const ok = result.ok === true && requestedSkillStatus === 'mounted' && mountedOnCurrentPage;
  const errorMessage = ok
    ? ''
    : buildSingleSkillMountErrorMessage(
        requestedSkillName,
        requestedSkillStatus,
        (typeof result?.error === 'string' && result.error.trim())
          ? result.error.trim()
          : firstItemErrorMessage
      );

  return {
    ok,
    tab_id: normalizeTabId(result?.tabId),
    skill: skill ? buildSkillSummary(skill) : null,
    requested_skill_name: requestedSkillName || null,
    requested_skill_status: requestedSkillStatus || 'runtime_failed',
    mounted_on_current_page: mountedOnCurrentPage,
    active_skills: activeSkillNames,
    current_page_url: typeof options?.currentPageUrl === 'string' ? options.currentPageUrl : '',
    value: result?.value ?? null,
    logs: Array.isArray(result?.logs) ? result.logs : [],
    items: Array.isArray(result?.items) ? result.items : [],
    error: ok
      ? null
      : {
          message: errorMessage,
          name: 'SkillMountError',
          stack: ''
        }
  };
}

function cloneFiles(files) {
  return (Array.isArray(files) ? files : []).map((file) => ({ ...file }));
}

export function createSkillManager(options = {}) {
  const store = options?.store || createIndexedDbSkillStore();
  const userScriptsApi = options?.userScriptsApi || globalThis?.chrome?.userScripts || null;
  const tabsApi = options?.tabsApi || globalThis?.chrome?.tabs || null;
  const jsRuntimeManager = options?.jsRuntimeManager || null;
  let reconcilePromise = null;
  let reconcileRerunRequested = false;

  function ensureUserScriptsApi() {
    if (
      !userScriptsApi
      || typeof userScriptsApi.getScripts !== 'function'
      || typeof userScriptsApi.unregister !== 'function'
    ) {
      throw new Error('当前扩展环境没有可用的 chrome.userScripts 注册能力。');
    }
    return userScriptsApi;
  }

  function ensureTabsApi() {
    if (!tabsApi || typeof tabsApi.get !== 'function') {
      throw new Error('当前扩展环境没有可用的 chrome.tabs 能力。');
    }
    return tabsApi;
  }

  async function listStoredRecords() {
    return await listStoredSkillManifests(store);
  }

  async function listSkillRecords() {
    return [
      ...listBuiltinSkillRecords(),
      ...(await listStoredRecords())
    ];
  }

  async function listFullSkillRecords() {
    const storedManifests = await listStoredRecords();
    const storedPackages = (await Promise.all(
      storedManifests.map((record) => getStoredSkillPackage(record.name, store))
    )).filter(Boolean);
    return [
      ...listBuiltinSkillRecords(),
      ...storedPackages
    ];
  }

  async function getSkillRecord(skillName) {
    const builtin = getBuiltinSkillRecord(skillName);
    if (builtin) {
      return builtin;
    }
    return await getStoredSkillPackage(skillName, store);
  }

  async function getMutableStoredSkillRecord(skillName, actionLabel) {
    const builtin = getBuiltinSkillRecord(skillName);
    if (builtin) {
      throw new Error(`技能 ${skillName} 是内置只读指导 skill，不能执行 ${actionLabel}。`);
    }
    return await getStoredSkillPackage(skillName, store);
  }

  function buildRevisedSkillRecord(existingRecord, updates = {}) {
    const existing = normalizeStoredSkillRecord(existingRecord);
    if (!existing) {
      throw new Error('无法基于无效 skill 记录生成修订版本。');
    }
    return buildStoredSkillRecord({
      ...existing,
      ...updates
    }, existing);
  }

  async function persistMutatedSkillRecord(existingRecord, nextRecord) {
    return await saveStoredSkillPackage(nextRecord, store);
  }

  async function runReconcileRegisteredSkillsPass() {
    const api = ensureUserScriptsApi();
    const existingDefinitions = await api.getScripts();
    const idsToUnregister = (Array.isArray(existingDefinitions) ? existingDefinitions : [])
      .map((definition) => String(definition?.id || ''))
      .filter((id) => id.startsWith(CEREBR_SKILL_SCRIPT_ID_PREFIX));

    if (idsToUnregister.length > 0) {
      await api.unregister({ ids: idsToUnregister });
    }

    return {
      ok: true,
      registered_count: 0,
      updated_count: 0,
      unregistered_count: idsToUnregister.length
    };
  }

  async function reconcileRegisteredSkills() {
    if (reconcilePromise) {
      reconcileRerunRequested = true;
      return reconcilePromise;
    }

    reconcilePromise = (async () => {
      let lastResult = null;
      do {
        reconcileRerunRequested = false;
        lastResult = await runReconcileRegisteredSkillsPass();
      } while (reconcileRerunRequested);
      return lastResult;
    })().finally(() => {
      reconcilePromise = null;
    });

    return reconcilePromise;
  }

  async function getTabUrl(tabId) {
    const normalizedTabId = normalizeTabId(tabId);
    if (normalizedTabId === null) {
      throw new Error('缺少有效的目标标签页，无法刷新当前文档技能。');
    }
    const api = ensureTabsApi();
    const tab = await api.get(normalizedTabId);
    return {
      tab_id: normalizedTabId,
      url: (typeof tab?.url === 'string') ? tab.url : '',
      title: (typeof tab?.title === 'string') ? tab.title : ''
    };
  }

  async function syncCurrentDocumentSkills(tabId, explicitUrl = null) {
    if (!jsRuntimeManager || typeof jsRuntimeManager.execute !== 'function') {
      throw new Error('当前扩展没有可用的 JS Runtime 执行入口，无法 refresh 当前文档技能。');
    }

    const { tab_id, url } = explicitUrl
      ? { tab_id: normalizeTabId(tabId), url: explicitUrl }
      : await getTabUrl(tabId);
    if (!url) {
      throw new Error('当前标签页没有可用 URL，无法计算匹配的技能。');
    }

    const matchingRecords = await listMatchingStoredSkillPackagesForUrl(url, store);
    const refreshSource = buildSkillDocumentRefreshSource(matchingRecords);
    const rawResult = await jsRuntimeManager.execute({
      tabId: tab_id,
      code: refreshSource,
      injectImmediately: true
    });

    return await normalizeRefreshExecutionResult(rawResult, matchingRecords);
  }

  async function listCurrentPageVisibleSkillRecordsForTab(tabId) {
    const normalizedTabId = normalizeTabId(tabId);
    const builtinRecords = listBuiltinSkillRecords();
    const storedRecords = await listStoredRecords();
    const guidanceRecords = storedRecords.filter((record) => record.enabled === true && record.kind === 'guidance');
    if (normalizedTabId === null) {
      return {
        tab_id: null,
        url: '',
        title: '',
        builtinRecords,
        guidanceRecords,
        pageRuntimeRecords: []
      };
    }

    const { url, title, tab_id } = await getTabUrl(normalizedTabId);
    return {
      tab_id,
      url,
      title,
      builtinRecords,
      guidanceRecords,
      pageRuntimeRecords: storedRecords.filter((record) => skillMatchesUrl(record, url))
    };
  }

  async function performSkillMountOnCurrentPage(skillName, options = {}) {
    if (!jsRuntimeManager || typeof jsRuntimeManager.execute !== 'function') {
      throw new Error('当前扩展没有可用的 JS Runtime 执行入口，无法将技能挂载到当前页。');
    }

    const record = await getSkillRecord(skillName);
    if (!record) {
      throw new Error(`技能 ${skillName} 不存在。`);
    }
    const normalizedRecord = normalizeStoredSkillRecord(record);
    const { tab_id, url } = options?.explicitUrl
      ? { tab_id: normalizeTabId(options?.tabId), url: options.explicitUrl }
      : await getTabUrl(options?.tabId);
    if (!url) {
      throw new Error('当前标签页没有可用 URL，无法判断技能是否可挂载。');
    }

    let requestedSkillStatus = 'mounted';
    let code = '';
    if (normalizedRecord?.enabled !== true) {
      requestedSkillStatus = 'disabled';
      code = buildSkillUnmountFromCurrentPageSource(normalizedRecord?.name || skillName);
    } else if (normalizedRecord?.kind !== 'page_runtime') {
      requestedSkillStatus = 'not_page_runtime';
      code = buildSkillUnmountFromCurrentPageSource(normalizedRecord?.name || skillName);
    } else if (!skillMatchesUrl(normalizedRecord, url)) {
      requestedSkillStatus = 'url_not_matched';
      code = buildSkillUnmountFromCurrentPageSource(normalizedRecord.name);
    } else {
      code = buildSkillMountOnCurrentPageSource(normalizedRecord);
    }

    const rawResult = await jsRuntimeManager.execute({
      tabId: tab_id,
      code,
      documentIds: Array.isArray(options?.documentIds) ? options.documentIds : null,
      frameIds: Array.isArray(options?.frameIds) ? options.frameIds : null,
      injectImmediately: true
    });

    return await normalizeSingleSkillMountExecutionResult(rawResult, normalizedRecord, {
      requestedSkillStatus,
      requestedSkillName: normalizedRecord?.name || skillName,
      currentPageUrl: url
    });
  }

  async function mountSkillOnCurrentPage(skillName, options = {}) {
    const normalizedSkillName = String(skillName || '').trim();
    const normalizedTabId = normalizeTabId(options?.tabId);
    const normalizedDocumentIds = Array.isArray(options?.documentIds)
      ? Array.from(new Set(options.documentIds
        .map((value) => String(value || '').trim())
        .filter(Boolean)))
        .sort()
      : [];
    const normalizedFrameIds = Array.isArray(options?.frameIds)
      ? Array.from(new Set(options.frameIds
        .map((value) => normalizeTabId(value))
        .filter((value) => value !== null && value >= 0)))
        .sort((left, right) => left - right)
      : [];
    return await performSkillMountOnCurrentPage(normalizedSkillName, {
      ...options,
      tabId: normalizedTabId,
      documentIds: normalizedDocumentIds.length > 0 ? normalizedDocumentIds : null,
      frameIds: normalizedDocumentIds.length > 0
        ? null
        : (normalizedFrameIds.length > 0 ? normalizedFrameIds : null)
    });
  }

  async function listMatchingSkillSummariesForTab(tabId) {
    const {
      tab_id,
      url,
      title,
      pageRuntimeRecords
    } = await listCurrentPageVisibleSkillRecordsForTab(tabId);
    // 隐藏 skill_context 只暴露“当前页面 URL 实际命中的页面 runtime skill”。
    // 内置 skill-creator 与普通 guidance skill 仍可通过 skill_registry 显式读取，
    // 但它们不代表当前页面能力，自动注入会让无关对话也背上 skill 段落。
    const pageSkillSummaries = tab_id === null
      ? []
      : pageRuntimeRecords
        .map((record) => buildSkillContextSummary(record))
        .filter(Boolean);
    if (tab_id === null) {
      return {
        ok: true,
        tab_id: null,
        url: '',
        title: '',
        total_skills: 0,
        skills: []
      };
    }

    return {
      ok: true,
      tab_id,
      url,
      title,
      total_skills: pageSkillSummaries.length,
      skills: pageSkillSummaries
    };
  }

  async function maybeRefreshCurrentDocument(tabId) {
    const normalizedTabId = normalizeTabId(tabId);
    if (normalizedTabId === null) {
      return {
        refreshed_current_document: false,
        refresh_result: null
      };
    }
    return {
      refreshed_current_document: true,
      refresh_result: await syncCurrentDocumentSkills(normalizedTabId)
    };
  }

  async function createSkill(skillInput, options = {}) {
    const createMode = options?.createMode === 'template' ? 'template' : 'package_compat';
    const requestedName = createMode === 'template'
      ? String(skillInput?.requested_name || '').trim()
      : '';
    const scaffoldedInput = createMode === 'template'
      ? buildSkillScaffoldInput({
          skillName: skillInput?.name,
          description: skillInput?.description,
          displayName: skillInput?.interface?.display_name,
          shortDescription: skillInput?.interface?.short_description,
          defaultPrompt: skillInput?.interface?.default_prompt,
          enabled: skillInput?.enabled === true,
          resources: skillInput?.resources,
          examples: skillInput?.examples === true
        })
      : skillInput;
    const nextRecord = buildStoredSkillRecord(scaffoldedInput, null);
    if (getBuiltinSkillRecord(nextRecord.name)) {
      throw new Error(`技能 ${nextRecord.name} 是内置保留名称，不能 create。`);
    }
    const existing = await getStoredSkillPackage(nextRecord.name, store);
    if (existing) {
      throw new Error(`技能 ${nextRecord.name} 已存在，不能重复 create。`);
    }
    await saveStoredSkillPackage(nextRecord, store);
    if (createMode === 'template') {
      const createdFiles = Array.isArray(nextRecord.files)
        ? nextRecord.files.map((file) => file.path)
        : [];
      return {
        ok: true,
        action: 'create_skill',
        create_mode: 'template',
        requested_name: requestedName || nextRecord.name,
        normalized_name: nextRecord.name,
        created_files: createdFiles,
        selected_resources: Array.isArray(skillInput?.resources) ? [...skillInput.resources] : [],
        examples_created: skillInput?.examples === true,
        next_steps: buildSkillScaffoldNextSteps({
          enabled: nextRecord.enabled === true,
          resources: skillInput?.resources,
          examples: skillInput?.examples === true
        }),
        skill: buildSkillSummary(nextRecord),
        refreshed_current_document: false,
        refresh_result: null
      };
    }
    return {
      ok: true,
      action: 'create_skill',
      skill: buildSkillSummary(nextRecord),
      ...(await maybeRefreshCurrentDocument(options?.tabId))
    };
  }

  async function updateSkill(skillInput, options = {}) {
    const existing = await getMutableStoredSkillRecord(skillInput?.name, 'update');
    if (!existing) {
      throw new Error(`技能 ${skillInput?.name || '(unknown)'} 不存在，无法 update。`);
    }
    const nextRecord = buildStoredSkillRecord(skillInput, existing);
    const persistedRecord = await persistMutatedSkillRecord(existing, nextRecord);

    return {
      ok: true,
      action: 'update',
      skill: buildSkillSummary(persistedRecord),
      ...(await maybeRefreshCurrentDocument(options?.tabId))
    };
  }

  async function setSkillEnabled(skillName, enabled, options = {}) {
    const existing = await getMutableStoredSkillRecord(skillName, enabled === true ? 'enable' : 'disable');
    if (!existing) {
      throw new Error(`技能 ${skillName} 不存在，无法切换启用状态。`);
    }
    const nextRecord = buildRevisedSkillRecord(existing, {
      enabled: enabled === true
    });
    const persistedRecord = await persistMutatedSkillRecord(existing, nextRecord);

    return {
      ok: true,
      action: enabled === true ? 'enable_skill' : 'disable_skill',
      skill: buildSkillSummary(persistedRecord),
      ...(await maybeRefreshCurrentDocument(options?.tabId))
    };
  }

  function findSkillPackageFileIndex(skill, filePath) {
    return skill.files.findIndex((file) => file.path === filePath);
  }

  function assertSkillFileOperationPathIsMutable(filePath, action) {
    if (normalizeSkillFilePath(filePath) === SKILL_VIRTUAL_MANIFEST_PATH) {
      throw new Error(`manifest.json 是保留虚拟文件，不能用于 ${action}。`);
    }
  }

  function assertDifferentSkillFileOperationPaths(sourcePath, destinationPath, action) {
    if (sourcePath === destinationPath) {
      throw new Error(`skill_registry 参数错误：${action} 的源路径与目标路径不能相同。`);
    }
  }

  async function copySkillFile(skillName, sourceFilePath, destinationFilePath, options = {}) {
    const existing = await getMutableStoredSkillRecord(skillName, 'copy_file');
    const normalizedExisting = normalizeStoredSkillRecord(existing);
    if (!normalizedExisting) {
      throw new Error(`技能 ${skillName} 不存在，无法复制文件。`);
    }

    const sourcePath = normalizeSkillFilePath(sourceFilePath);
    const destinationPath = normalizeSkillFilePath(destinationFilePath);
    assertDifferentSkillFileOperationPaths(sourcePath, destinationPath, 'copy_file');
    assertSkillFileOperationPathIsMutable(sourcePath, 'copy_file');
    assertSkillFileOperationPathIsMutable(destinationPath, 'copy_file');

    const sourceIndex = findSkillPackageFileIndex(normalizedExisting, sourcePath);
    if (sourceIndex < 0) {
      throw new Error(`技能 ${skillName} 中不存在文件 ${sourcePath}。`);
    }
    if (findSkillPackageFileIndex(normalizedExisting, destinationPath) >= 0) {
      throw new Error(`技能 ${skillName} 中已存在文件 ${destinationPath}。`);
    }

    const sourceFile = normalizedExisting.files[sourceIndex];
    const nextFiles = [
      ...normalizedExisting.files.map((file) => ({ ...file })),
      {
        path: destinationPath,
        kind: sourceFile.kind || null,
        content: sourceFile.content || ''
      }
    ];
    const nextRecord = buildStoredSkillRecord({
      ...normalizedExisting,
      files: nextFiles
    }, normalizedExisting);
    const persistedRecord = await persistMutatedSkillRecord(normalizedExisting, nextRecord);

    return {
      ok: true,
      action: 'copy_file',
      source_file_path: sourcePath,
      destination_file_path: destinationPath,
      skill: buildSkillSummary(persistedRecord),
      files: buildSkillFileManifest(persistedRecord, { includeContent: false }),
      affected_files: {
        added: [destinationPath],
        modified: [],
        deleted: []
      },
      ...(await maybeRefreshCurrentDocument(options?.tabId))
    };
  }

  async function moveSkillFile(skillName, sourceFilePath, destinationFilePath, options = {}) {
    const existing = await getMutableStoredSkillRecord(skillName, 'move_file');
    const normalizedExisting = normalizeStoredSkillRecord(existing);
    if (!normalizedExisting) {
      throw new Error(`技能 ${skillName} 不存在，无法移动文件。`);
    }

    const sourcePath = normalizeSkillFilePath(sourceFilePath);
    const destinationPath = normalizeSkillFilePath(destinationFilePath);
    assertDifferentSkillFileOperationPaths(sourcePath, destinationPath, 'move_file');
    assertSkillFileOperationPathIsMutable(sourcePath, 'move_file');
    assertSkillFileOperationPathIsMutable(destinationPath, 'move_file');

    const sourceIndex = findSkillPackageFileIndex(normalizedExisting, sourcePath);
    if (sourceIndex < 0) {
      throw new Error(`技能 ${skillName} 中不存在文件 ${sourcePath}。`);
    }
    if (findSkillPackageFileIndex(normalizedExisting, destinationPath) >= 0) {
      throw new Error(`技能 ${skillName} 中已存在文件 ${destinationPath}。`);
    }

    const sourceFile = normalizedExisting.files[sourceIndex];
    const nextFiles = normalizedExisting.files.map((file) => ({ ...file }));
    nextFiles[sourceIndex] = {
      path: destinationPath,
      kind: sourceFile.kind || null,
      content: sourceFile.content || ''
    };

    const nextInstructionPath = normalizedExisting.instruction.path === sourcePath
      ? destinationPath
      : normalizedExisting.instruction.path;
    const nextRuntimeEntryPath = normalizedExisting.runtime.entry_path === sourcePath
      ? destinationPath
      : normalizedExisting.runtime.entry_path;

    const nextRecord = buildStoredSkillRecord({
      ...normalizedExisting,
      instruction: {
        path: nextInstructionPath
      },
      runtime: {
        entry_path: nextRuntimeEntryPath
      },
      files: nextFiles
    }, normalizedExisting);
    const persistedRecord = await persistMutatedSkillRecord(normalizedExisting, nextRecord);

    return {
      ok: true,
      action: 'move_file',
      source_file_path: sourcePath,
      destination_file_path: destinationPath,
      skill: buildSkillSummary(persistedRecord),
      files: buildSkillFileManifest(persistedRecord, { includeContent: false }),
      affected_files: {
        added: [],
        modified: [destinationPath],
        deleted: [sourcePath]
      },
      ...(await maybeRefreshCurrentDocument(options?.tabId))
    };
  }

  async function deleteSkillFile(skillName, filePath, options = {}) {
    const existing = await getMutableStoredSkillRecord(skillName, 'delete_file');
    const normalizedExisting = normalizeStoredSkillRecord(existing);
    if (!normalizedExisting) {
      throw new Error(`技能 ${skillName} 不存在，无法删除文件。`);
    }

    const normalizedPath = normalizeSkillFilePath(filePath);
    if (normalizedPath === SKILL_VIRTUAL_MANIFEST_PATH) {
      throw new Error('manifest.json 是保留虚拟文件，不能删除。');
    }
    const existingFile = normalizedExisting.files.find((file) => file.path === normalizedPath) || null;
    if (!existingFile) {
      throw new Error(`技能 ${skillName} 中不存在文件 ${normalizedPath}。`);
    }
    if (normalizedExisting.files.length <= 1) {
      throw new Error(`技能 ${skillName} 只剩最后一个文件，不能删除。`);
    }

    const nextFiles = normalizedExisting.files
      .filter((file) => file.path !== normalizedPath)
      .map((file) => ({ ...file }));
    const deletingInstruction = normalizedExisting.instruction.path === normalizedPath;
    const deletingRuntimeEntry = normalizedExisting.runtime.entry_path === normalizedPath;
    const nextInstructionPath = deletingInstruction
      ? (options?.nextInstructionPath || null)
      : normalizedExisting.instruction.path;
    const nextRuntimeEntryPath = deletingRuntimeEntry
      ? (options?.nextRuntimeEntryPath || null)
      : normalizedExisting.runtime.entry_path;

    const nextRecord = buildStoredSkillRecord({
      ...normalizedExisting,
      instruction: {
        path: nextInstructionPath
      },
      runtime: {
        entry_path: nextRuntimeEntryPath
      },
      files: nextFiles
    }, normalizedExisting);
    const persistedRecord = await persistMutatedSkillRecord(normalizedExisting, nextRecord);

    return {
      ok: true,
      action: 'delete_file',
      deleted_file_path: normalizedPath,
      skill: buildSkillSummary(persistedRecord),
      files: buildSkillFileManifest(persistedRecord, { includeContent: false }),
      affected_files: {
        added: [],
        modified: [],
        deleted: [normalizedPath]
      },
      ...(await maybeRefreshCurrentDocument(options?.tabId))
    };
  }

  async function applySkillPatch(skillName, patch, options = {}) {
    const existing = await getMutableStoredSkillRecord(skillName, 'apply_patch');
    const normalizedExisting = normalizeStoredSkillRecord(existing);
    if (!normalizedExisting) {
      throw new Error(`技能 ${skillName} 不存在，无法应用补丁。`);
    }

    const patched = applySkillPackagePatch(normalizedExisting, patch);
    const persistedRecord = await persistMutatedSkillRecord(normalizedExisting, patched.record);

    return {
      ok: true,
      action: 'apply_patch',
      skill: buildSkillSummary(persistedRecord),
      files: buildSkillFileManifest(persistedRecord, { includeContent: false }),
      affected_files: patched.affected_files,
      ...(await maybeRefreshCurrentDocument(options?.tabId))
    };
  }

  async function deleteSkill(skillName, options = {}) {
    const existing = await getMutableStoredSkillRecord(skillName, 'delete');
    if (!existing) {
      throw new Error(`技能 ${skillName} 不存在，无法删除。`);
    }

    await deleteStoredSkillPackage(existing.name, store);

    return {
      ok: true,
      action: 'delete_skill',
      deleted: true,
      skill: buildSkillSummary(existing),
      ...(await maybeRefreshCurrentDocument(options?.tabId))
    };
  }

  async function executeRegistryAction(rawArgs, options = {}) {
    const normalizedArgs = normalizeSkillRegistryToolArguments(rawArgs);
    switch (normalizedArgs.action) {
      case 'list': {
        if (normalizedArgs.include_all_sites === true) {
          const skills = (await listSkillRecords())
            .map((record) => buildSkillSummary(record))
            .filter(Boolean);
          return {
            ok: true,
            action: 'list',
            scope: 'all_sites',
            include_all_sites: true,
            total_skills: skills.length,
            skills
          };
        }

        const {
          tab_id,
          url,
          title,
          builtinRecords,
          guidanceRecords,
          pageRuntimeRecords
        } = await listCurrentPageVisibleSkillRecordsForTab(options?.tabId);
        const skills = [
          ...builtinRecords,
          ...guidanceRecords,
          ...pageRuntimeRecords
        ]
          .map((record) => buildSkillSummary(record))
          .filter(Boolean);
        return {
          ok: true,
          action: 'list',
          scope: 'current_page',
          include_all_sites: false,
          tab_id,
          url,
          title,
          total_skills: skills.length,
          skills
        };
      }
      case 'list_files': {
        const records = normalizedArgs.skill_name
          ? [await getSkillRecord(normalizedArgs.skill_name)].filter(Boolean)
          : await listFullSkillRecords();
        if (records.length <= 0 && normalizedArgs.skill_name) {
          throw new Error(`技能 ${normalizedArgs.skill_name} 不存在。`);
        }
        return {
          ok: true,
          action: 'list_files',
          ...buildSkillFileIndexPayload(records, {
            requestedSkillName: normalizedArgs.skill_name
          })
        };
      }
      case 'search_files': {
        const records = normalizedArgs.skill_name
          ? [await getSkillRecord(normalizedArgs.skill_name)].filter(Boolean)
          : await listFullSkillRecords();
        if (records.length <= 0 && normalizedArgs.skill_name) {
          throw new Error(`技能 ${normalizedArgs.skill_name} 不存在。`);
        }
        return {
          ok: true,
          action: 'search_files',
          ...searchSkillFiles(records, {
            requestedSkillName: normalizedArgs.skill_name,
            pattern: normalizedArgs.pattern,
            regex: normalizedArgs.regex,
            case_mode: normalizedArgs.case_mode,
            path_glob: normalizedArgs.path_glob,
            context_before: normalizedArgs.context_before,
            context_after: normalizedArgs.context_after,
            max_results: normalizedArgs.max_results
          })
        };
      }
      case 'read_detail': {
        const record = await getSkillRecord(normalizedArgs.skill_name);
        if (!record) {
          throw new Error(`技能 ${normalizedArgs.skill_name} 不存在。`);
        }
        return {
          ok: true,
          action: 'read_detail',
          skill: buildSkillDetail(record, {
            contentReadArgs: normalizedArgs.read_options,
            includeLineNumbers: normalizedArgs.include_line_numbers
          })
        };
      }
      case 'read_package': {
        const record = await getSkillRecord(normalizedArgs.skill_name);
        if (!record) {
          throw new Error(`技能 ${normalizedArgs.skill_name} 不存在。`);
        }
        return {
          ok: true,
          action: 'read_package',
          skill: buildSkillPackagePayload(record, {
            contentReadArgs: normalizedArgs.read_options
          })
        };
      }
      case 'read_file': {
        const record = await getSkillRecord(normalizedArgs.skill_name);
        if (!record) {
          throw new Error(`技能 ${normalizedArgs.skill_name} 不存在。`);
        }
        return {
          ok: true,
          action: 'read_file',
          skill: buildSkillFilePayload(record, normalizedArgs.file_path, {
            contentReadArgs: normalizedArgs.read_options,
            includeLineNumbers: normalizedArgs.include_line_numbers
          })
        };
      }
      case 'create_skill':
        return await createSkill(normalizedArgs.skill, {
          tabId: options?.tabId,
          createMode: normalizedArgs.create_mode
        });
      case 'update':
        return await updateSkill(normalizedArgs.skill, { tabId: options?.tabId });
      case 'apply_patch':
        return await applySkillPatch(normalizedArgs.skill_name, normalizedArgs.patch, {
          tabId: options?.tabId
        });
      case 'copy_file':
        return await copySkillFile(
          normalizedArgs.skill_name,
          normalizedArgs.source_file_path,
          normalizedArgs.destination_file_path,
          { tabId: options?.tabId }
        );
      case 'move_file':
        return await moveSkillFile(
          normalizedArgs.skill_name,
          normalizedArgs.source_file_path,
          normalizedArgs.destination_file_path,
          { tabId: options?.tabId }
        );
      case 'delete_file':
        return await deleteSkillFile(normalizedArgs.skill_name, normalizedArgs.file_path, {
          tabId: options?.tabId,
          nextInstructionPath: normalizedArgs.next_instruction_path,
          nextRuntimeEntryPath: normalizedArgs.next_runtime_entry_path
        });
      case 'delete_skill':
        return await deleteSkill(normalizedArgs.skill_name, { tabId: options?.tabId });
      case 'enable_skill':
        return await setSkillEnabled(normalizedArgs.skill_name, true, { tabId: options?.tabId });
      case 'disable_skill':
        return await setSkillEnabled(normalizedArgs.skill_name, false, { tabId: options?.tabId });
      case 'mount_on_current_page':
        return {
          action: 'mount_on_current_page',
          ...(await mountSkillOnCurrentPage(normalizedArgs.skill_name, { tabId: options?.tabId }))
        };
      case 'refresh_current_document': {
        if (normalizedArgs.skill_name) {
          const record = await getSkillRecord(normalizedArgs.skill_name);
          if (!record) {
            throw new Error(`技能 ${normalizedArgs.skill_name} 不存在。`);
          }
        }
        const refreshResult = await syncCurrentDocumentSkills(options?.tabId);
        return {
          ok: refreshResult.ok === true,
          action: 'refresh_current_document',
          requested_skill_name: normalizedArgs.skill_name,
          refreshed_current_document: true,
          refresh_result: refreshResult,
          error: refreshResult.ok === true ? null : refreshResult.error
        };
      }
      default:
        throw new Error(`未处理的 skill_registry action：${normalizedArgs.action}`);
    }
  }

  return {
    createSkill,
    deleteSkill,
    executeRegistryAction,
    getSkillRecord,
    initialize: reconcileRegisteredSkills,
    listMatchingSkillSummariesForTab,
    listSkillRecords,
    mountSkillOnCurrentPage,
    reconcileRegisteredSkills,
    setSkillEnabled,
    syncCurrentDocumentSkills,
    updateSkill
  };
}
