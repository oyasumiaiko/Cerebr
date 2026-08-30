import {
  buildSkillContextSummary,
  buildSkillFileIndexPayload,
  buildSkillFileManifest,
  buildSkillFilePayload,
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
  serializeSkillVirtualManifest,
  normalizeStoredSkillRecord,
  saveStoredSkillPackage
} from '../agent_tools/skill/registry_tool.js';
import {
  normalizeSkillVirtualFileActionArguments
} from '../agent_tools/skill/virtual_file_action.js';
import {
  prepareSkillPackagePatch,
  resolveSkillApplyPatchTarget
} from '../agent_tools/skill/skill_apply_patch.js';
import {
  CEREBR_SKILL_SCRIPT_ID_PREFIX,
  buildSkillDocumentRefreshSource,
  buildSkillMountOnCurrentPageSource,
  buildSkillUnmountFromCurrentPageSource
} from './skill_runtime.js';
import { createIndexedDbSkillStore } from '../storage/skill_store.js';
import { buildSkillScaffoldInput } from '../agent_tools/skill/skill_scaffold.js';
import { normalizeApplyPatchVerificationError } from '../agent_tools/shared/apply_patch_core.js';

function normalizeTabId(value) {
  if (value == null) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

function sortSkillRecords(records) {
  return (Array.isArray(records) ? records : [])
    .map((record) => normalizeStoredSkillRecord(record))
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
    const existing = normalizeStoredSkillRecord(existingRecord);
    if (!existing) {
      throw new Error('无法提交缺少当前 revision 的 Skill 修改。');
    }
    return await saveStoredSkillPackage(nextRecord, store, {
      expectedRevision: existing.revision
    });
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

  async function createSkill(skillInput) {
    const requestedName = String(skillInput?.requested_name || '').trim();
    const scaffoldedInput = buildSkillScaffoldInput({
      skillName: skillInput?.name,
      description: skillInput?.description,
      displayName: skillInput?.interface?.display_name,
      shortDescription: skillInput?.interface?.short_description,
      defaultPrompt: skillInput?.interface?.default_prompt,
      enabled: skillInput?.enabled === true,
      resources: skillInput?.resources,
      examples: skillInput?.examples === true
    });
    const nextRecord = buildStoredSkillRecord(scaffoldedInput, null);
    if (getBuiltinSkillRecord(nextRecord.name)) {
      throw new Error(`技能 ${nextRecord.name} 是内置保留名称，不能 create。`);
    }
    const existing = await getStoredSkillPackage(nextRecord.name, store);
    if (existing) {
      throw new Error(`技能 ${nextRecord.name} 已存在，不能重复 create。`);
    }
    await saveStoredSkillPackage(nextRecord, store, { expectedRevision: null });
    const createdFiles = Array.isArray(nextRecord.files)
      ? nextRecord.files.map((file) => file.path)
      : [];
    return {
      ok: true,
      action: 'create_skill',
      requested_name: requestedName || nextRecord.name,
      normalized_name: nextRecord.name,
      created_files: createdFiles,
      skill: buildSkillSummary(nextRecord)
    };
  }

  async function setSkillEnabled(skillName, enabled) {
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
      skill: buildSkillSummary(persistedRecord)
    };
  }

  function findSkillPackageFileIndex(skill, filePath) {
    return skill.files.findIndex((file) => file.path === filePath);
  }

  function assertSkillFileOperationDestinationIsMutable(filePath, action) {
    if (normalizeSkillFilePath(filePath) === SKILL_VIRTUAL_MANIFEST_PATH) {
      throw new Error(`manifest.json 是保留虚拟文件，不能作为 ${action} 的目标路径。`);
    }
  }

  function assertDifferentSkillFileOperationPaths(sourcePath, destinationPath, action) {
    if (sourcePath === destinationPath) {
      throw new Error(`skill_registry 参数错误：${action} 的源路径与目标路径不能相同。`);
    }
  }

  async function copySkillFile(skillName, sourceFilePath, destinationFilePath) {
    const existing = await getMutableStoredSkillRecord(skillName, 'copy_file');
    const normalizedExisting = normalizeStoredSkillRecord(existing);
    if (!normalizedExisting) {
      throw new Error(`技能 ${skillName} 不存在，无法复制文件。`);
    }

    const sourcePath = normalizeSkillFilePath(sourceFilePath);
    const destinationPath = normalizeSkillFilePath(destinationFilePath);
    assertDifferentSkillFileOperationPaths(sourcePath, destinationPath, 'copy_file');
    assertSkillFileOperationDestinationIsMutable(destinationPath, 'copy_file');

    const sourceIndex = sourcePath === SKILL_VIRTUAL_MANIFEST_PATH
      ? -1
      : findSkillPackageFileIndex(normalizedExisting, sourcePath);
    if (sourcePath !== SKILL_VIRTUAL_MANIFEST_PATH && sourceIndex < 0) {
      throw new Error(`技能 ${skillName} 中不存在文件 ${sourcePath}。`);
    }

    const sourceFile = sourcePath === SKILL_VIRTUAL_MANIFEST_PATH
      ? {
          path: SKILL_VIRTUAL_MANIFEST_PATH,
          kind: null,
          content: serializeSkillVirtualManifest(normalizedExisting)
        }
      : normalizedExisting.files[sourceIndex];
    const destinationIndex = findSkillPackageFileIndex(normalizedExisting, destinationPath);
    const copiedFile = {
      path: destinationPath,
      kind: sourceFile.kind || null,
      content: sourceFile.content || ''
    };
    const nextFiles = normalizedExisting.files.map((file) => ({ ...file }));
    if (destinationIndex >= 0) {
      nextFiles[destinationIndex] = copiedFile;
    } else {
      nextFiles.push(copiedFile);
    }
    const nextRecord = buildStoredSkillRecord({
      ...normalizedExisting,
      files: nextFiles
    }, normalizedExisting);
    const persistedRecord = await persistMutatedSkillRecord(normalizedExisting, nextRecord);

    return {
      ok: true,
      action: 'copy_file',
      source_path: sourcePath,
      destination_path: destinationPath,
      skill: buildSkillSummary(persistedRecord),
      files: buildSkillFileManifest(persistedRecord, { includeContent: false }),
      affected_files: {
        added: destinationIndex >= 0 ? [] : [destinationPath],
        modified: destinationIndex >= 0 ? [destinationPath] : [],
        deleted: []
      }
    };
  }

  async function applySkillPatch(patch, options = {}) {
    // 目标环境只认 patch 内的 Environment ID；这里先选择目标，再读取其当前 revision。
    const target = resolveSkillApplyPatchTarget(patch);
    const expectedEnvironmentId = typeof options?.expectedEnvironmentId === 'string'
      ? options.expectedEnvironmentId.trim()
      : '';
    if (expectedEnvironmentId && expectedEnvironmentId !== target.environment_id) {
      const error = new Error(
        `Patch environment ${target.environment_id} does not match internal context ${expectedEnvironmentId}.`
      );
      error.code = 'APPLY_PATCH_ENVIRONMENT_CONTEXT_MISMATCH';
      throw normalizeApplyPatchVerificationError(error, {
        stage: 'select_environment',
        environment_id: target.environment_id,
        skill_name: target.skill_name
      });
    }
    const existing = await getMutableStoredSkillRecord(target.skill_name, 'apply_patch');
    const normalizedExisting = normalizeStoredSkillRecord(existing);
    if (!normalizedExisting) {
      const error = new Error(`技能 ${target.skill_name} 不存在，无法应用补丁。`);
      error.code = 'APPLY_PATCH_ENVIRONMENT_NOT_FOUND';
      error.stage = 'select_environment';
      error.environment_id = target.environment_id;
      error.skill_name = target.skill_name;
      error.state_changed = false;
      throw error;
    }

    // prepare 完整成功前不触碰 IndexedDB；persistMutatedSkillRecord 是唯一 commit 点。
    const patched = prepareSkillPackagePatch(normalizedExisting, patch);
    const persistedRecord = await persistMutatedSkillRecord(normalizedExisting, patched.record);

    return {
      ok: true,
      action: 'apply_patch',
      environment_id: patched.environment_id,
      skill: buildSkillSummary(persistedRecord),
      files: buildSkillFileManifest(persistedRecord, { includeContent: false }),
      affected_files: patched.affected_files
    };
  }

  async function deleteSkill(skillName) {
    const existing = await getMutableStoredSkillRecord(skillName, 'delete');
    if (!existing) {
      throw new Error(`技能 ${skillName} 不存在，无法删除。`);
    }

    await deleteStoredSkillPackage(existing.name, store, {
      expectedRevision: existing.revision
    });

    return {
      ok: true,
      action: 'delete_skill',
      deleted: true,
      skill: buildSkillSummary(existing)
    };
  }

  async function executeVirtualFileAction(rawArgs) {
    const normalizedArgs = normalizeSkillVirtualFileActionArguments(rawArgs);
    const skillName = normalizedArgs.environment.skill_name;

    if (normalizedArgs.action === 'apply_patch') {
      return await applySkillPatch(normalizedArgs.patch, {
        expectedEnvironmentId: normalizedArgs.environment.environment_id
      });
    }
    if (normalizedArgs.action === 'copy_file') {
      return await copySkillFile(
        skillName,
        normalizedArgs.source_path,
        normalizedArgs.destination_path
      );
    }

    const record = await getSkillRecord(skillName);
    if (!record) {
      throw new Error(`技能 ${skillName} 不存在。`);
    }
    if (normalizedArgs.action === 'list_files') {
      return {
        ok: true,
        action: 'list_files',
        environment_id: normalizedArgs.environment.environment_id,
        ...buildSkillFileIndexPayload([record], {
          requestedSkillName: skillName,
          path_glob: normalizedArgs.path_glob
        })
      };
    }
    if (normalizedArgs.action === 'read_file') {
      const payload = buildSkillFilePayload(record, normalizedArgs.file_path, {
        contentReadArgs: normalizedArgs.read_options
      });
      return {
        ok: true,
        action: 'read_file',
        environment_id: normalizedArgs.environment.environment_id,
        file: payload.file
      };
    }
    if (normalizedArgs.action === 'search_files') {
      return {
        ok: true,
        action: 'search_files',
        environment_id: normalizedArgs.environment.environment_id,
        ...searchSkillFiles([record], normalizedArgs)
      };
    }
    throw new Error(`未处理的 Skill 文件 action：${normalizedArgs.action}`);
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
      case 'create_skill':
        return await createSkill(normalizedArgs.skill);
      case 'delete_skill':
        return await deleteSkill(normalizedArgs.skill_name);
      case 'enable_skill':
        return await setSkillEnabled(normalizedArgs.skill_name, true);
      case 'disable_skill':
        return await setSkillEnabled(normalizedArgs.skill_name, false);
      case 'mount_on_current_page':
        return {
          action: 'mount_on_current_page',
          ...(await mountSkillOnCurrentPage(normalizedArgs.skill_name, { tabId: options?.tabId }))
        };
      default:
        throw new Error(`未处理的 skill_registry action：${normalizedArgs.action}`);
    }
  }

  return {
    createSkill,
    deleteSkill,
    executeRegistryAction,
    executeVirtualFileAction,
    getSkillRecord,
    initialize: reconcileRegisteredSkills,
    listMatchingSkillSummariesForTab,
    listSkillRecords,
    mountSkillOnCurrentPage,
    reconcileRegisteredSkills,
    setSkillEnabled,
    syncCurrentDocumentSkills
  };
}
