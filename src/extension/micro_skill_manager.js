import {
  buildMicroSkillContextSummary,
  buildMicroSkillDetail,
  buildMicroSkillFileIndexPayload,
  buildMicroSkillFileManifest,
  buildMicroSkillFilePayload,
  buildMicroSkillPackagePayload,
  buildMicroSkillSummary,
  buildStoredMicroSkillRecord,
  deleteStoredMicroSkillPackage,
  getBuiltinMicroSkillRecord,
  getStoredMicroSkillPackage,
  listBuiltinMicroSkillRecords,
  listMatchingStoredMicroSkillPackagesForUrl,
  listStoredMicroSkillManifests,
  MICRO_SKILL_VIRTUAL_MANIFEST_PATH,
  microSkillMatchesUrl,
  normalizeMicroSkillFilePath,
  normalizeMicroSkillRegistryToolArguments,
  searchMicroSkillFiles,
  normalizeStoredMicroSkillRecord,
  saveStoredMicroSkillPackage
} from '../agent_tools/micro_skill_registry_tool.js';
import { applyMicroSkillPackagePatch } from '../agent_tools/micro_skill_apply_patch.js';
import {
  buildMicroSkillDocumentRefreshSource,
  buildRegisteredMicroSkillScriptId,
  buildRegisteredMicroSkillUserScript
} from './micro_skill_runtime.js';
import { createIndexedDbMicroSkillStore } from '../storage/micro_skill_store.js';

function normalizeTabId(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

function sortSkillRecords(records) {
  return (Array.isArray(records) ? records : [])
    .map((record) => normalizeStoredMicroSkillRecord(record))
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
    .map((record) => buildMicroSkillSummary(record))
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
          name: 'MicroSkillRefreshError',
          stack: ''
        }
      : null
  };
}

function cloneFiles(files) {
  return (Array.isArray(files) ? files : []).map((file) => ({ ...file }));
}

export function createMicroSkillManager(options = {}) {
  const store = options?.store || createIndexedDbMicroSkillStore();
  const userScriptsApi = options?.userScriptsApi || globalThis?.chrome?.userScripts || null;
  const tabsApi = options?.tabsApi || globalThis?.chrome?.tabs || null;
  const jsRuntimeManager = options?.jsRuntimeManager || null;
  let reconcilePromise = null;
  let reconcileRerunRequested = false;

  function ensureUserScriptsApi() {
    if (
      !userScriptsApi
      || typeof userScriptsApi.getScripts !== 'function'
      || typeof userScriptsApi.register !== 'function'
      || typeof userScriptsApi.update !== 'function'
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

  function isDuplicateScriptIdError(error, scriptId = '') {
    const message = (typeof error?.message === 'string' && error.message.trim())
      ? error.message.trim()
      : '';
    if (!message) return false;
    if (!message.includes('Duplicate script ID')) return false;
    return !scriptId || message.includes(scriptId);
  }

  async function listStoredRecords() {
    return await listStoredMicroSkillManifests(store);
  }

  async function listSkillRecords() {
    return [
      ...listBuiltinMicroSkillRecords(),
      ...(await listStoredRecords())
    ];
  }

  async function listFullSkillRecords() {
    const storedManifests = await listStoredRecords();
    const storedPackages = (await Promise.all(
      storedManifests.map((record) => getStoredMicroSkillPackage(record.name, store))
    )).filter(Boolean);
    return [
      ...listBuiltinMicroSkillRecords(),
      ...storedPackages
    ];
  }

  async function getSkillRecord(skillName) {
    const builtin = getBuiltinMicroSkillRecord(skillName);
    if (builtin) {
      return builtin;
    }
    return await getStoredMicroSkillPackage(skillName, store);
  }

  async function getMutableStoredSkillRecord(skillName, actionLabel) {
    const builtin = getBuiltinMicroSkillRecord(skillName);
    if (builtin) {
      throw new Error(`技能 ${skillName} 是内置只读指导 skill，不能执行 ${actionLabel}。`);
    }
    return await getStoredMicroSkillPackage(skillName, store);
  }

  function buildRevisedSkillRecord(existingRecord, updates = {}) {
    const existing = normalizeStoredMicroSkillRecord(existingRecord);
    if (!existing) {
      throw new Error('无法基于无效 skill 记录生成修订版本。');
    }
    return buildStoredMicroSkillRecord({
      ...existing,
      ...updates
    }, existing);
  }

  async function persistMutatedSkillRecord(existingRecord, nextRecord) {
    const normalizedExisting = normalizeStoredMicroSkillRecord(existingRecord);
    const normalizedNext = await saveStoredMicroSkillPackage(nextRecord, store);

    if (normalizedNext.enabled && normalizedNext.kind === 'page_runtime') {
      if (normalizedExisting?.enabled === true && normalizedExisting?.kind === 'page_runtime') {
        await updateSkillRecordRegistration(normalizedNext);
      } else {
        await registerSkillRecord(normalizedNext);
      }
    } else if (normalizedExisting?.enabled === true && normalizedExisting?.kind === 'page_runtime') {
      await unregisterSkillName(normalizedExisting.name);
    }

    return normalizedNext;
  }

  async function registerSkillRecord(record) {
    const skill = normalizeStoredMicroSkillRecord(record);
    if (!skill || skill.enabled !== true || skill.kind !== 'page_runtime') return null;
    const api = ensureUserScriptsApi();
    const definition = buildRegisteredMicroSkillUserScript(skill);
    try {
      await api.register([definition]);
    } catch (error) {
      if (!isDuplicateScriptIdError(error, definition.id)) {
        throw error;
      }
      await api.update([definition]);
    }
    return definition;
  }

  async function updateSkillRecordRegistration(record) {
    const skill = normalizeStoredMicroSkillRecord(record);
    if (!skill || skill.enabled !== true || skill.kind !== 'page_runtime') return null;
    const api = ensureUserScriptsApi();
    const definition = buildRegisteredMicroSkillUserScript(skill);
    await api.update([definition]);
    return definition;
  }

  async function unregisterSkillName(skillName) {
    const api = ensureUserScriptsApi();
    await api.unregister({
      ids: [buildRegisteredMicroSkillScriptId(skillName)]
    });
  }

  async function runReconcileRegisteredSkillsPass() {
    const api = ensureUserScriptsApi();
    const desiredManifests = (await listStoredRecords())
      .filter((record) => record.enabled === true && record.kind === 'page_runtime');
    const desiredRecords = (await Promise.all(
      desiredManifests.map((record) => getStoredMicroSkillPackage(record.name, store))
    )).filter(Boolean);
    const desiredById = new Map(
      desiredRecords.map((record) => [buildRegisteredMicroSkillScriptId(record.name), buildRegisteredMicroSkillUserScript(record)])
    );

    const existingDefinitions = await api.getScripts();
    const existingById = new Map(
      (Array.isArray(existingDefinitions) ? existingDefinitions : [])
        .filter((definition) => String(definition?.id || '').startsWith('cerebr-micro-skill--'))
        .map((definition) => [String(definition.id), definition])
    );

    const idsToUnregister = Array.from(existingById.keys()).filter((id) => !desiredById.has(id));
    const definitionsToRegister = Array.from(desiredById.entries())
      .filter(([id]) => !existingById.has(id))
      .map(([, definition]) => definition);
    const definitionsToUpdate = Array.from(desiredById.entries())
      .filter(([id]) => existingById.has(id))
      .map(([, definition]) => definition);

    if (idsToUnregister.length > 0) {
      await api.unregister({ ids: idsToUnregister });
    }
    let registeredCount = 0;
    let updatedCount = 0;
    for (const definition of definitionsToRegister) {
      try {
        await api.register([definition]);
        registeredCount += 1;
      } catch (error) {
        if (!isDuplicateScriptIdError(error, definition.id)) {
          throw error;
        }
        await api.update([definition]);
        updatedCount += 1;
      }
    }
    if (definitionsToUpdate.length > 0) {
      await api.update(definitionsToUpdate);
      updatedCount += definitionsToUpdate.length;
    }

    return {
      ok: true,
      registered_count: registeredCount,
      updated_count: updatedCount,
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

    const matchingRecords = await listMatchingStoredMicroSkillPackagesForUrl(url, store);
    const refreshSource = buildMicroSkillDocumentRefreshSource(matchingRecords);
    const rawResult = await jsRuntimeManager.execute({
      tabId: tab_id,
      code: refreshSource,
      injectImmediately: true
    });

    return await normalizeRefreshExecutionResult(rawResult, matchingRecords);
  }

  async function listMatchingSkillSummariesForTab(tabId) {
    const normalizedTabId = normalizeTabId(tabId);
    const builtinSummaries = listBuiltinMicroSkillRecords()
      .map((record) => buildMicroSkillContextSummary(record))
      .filter(Boolean);
    if (normalizedTabId === null) {
      return {
        ok: true,
        tab_id: null,
        url: '',
        title: '',
        total_skills: builtinSummaries.length,
        skills: builtinSummaries
      };
    }

    const { url, title, tab_id } = await getTabUrl(normalizedTabId);
    const matchingRecords = (await listStoredRecords()).filter((record) => microSkillMatchesUrl(record, url));
    const pageSkillSummaries = matchingRecords
      .map((record) => buildMicroSkillContextSummary(record))
      .filter(Boolean);
    return {
      ok: true,
      tab_id,
      url,
      title,
      total_skills: builtinSummaries.length + pageSkillSummaries.length,
      skills: [
        ...builtinSummaries,
        ...pageSkillSummaries
      ]
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
    const nextRecord = buildStoredMicroSkillRecord(skillInput, null);
    if (getBuiltinMicroSkillRecord(nextRecord.name)) {
      throw new Error(`技能 ${nextRecord.name} 是内置保留名称，不能 create。`);
    }
    const existing = await getStoredMicroSkillPackage(nextRecord.name, store);
    if (existing) {
      throw new Error(`技能 ${nextRecord.name} 已存在，不能重复 create。`);
    }
    await saveStoredMicroSkillPackage(nextRecord, store);
    if (nextRecord.enabled && nextRecord.kind === 'page_runtime') {
      await registerSkillRecord(nextRecord);
    }
    return {
      ok: true,
      action: 'create_skill',
      skill: buildMicroSkillSummary(nextRecord),
      ...(await maybeRefreshCurrentDocument(options?.tabId))
    };
  }

  async function updateSkill(skillInput, options = {}) {
    const existing = await getMutableStoredSkillRecord(skillInput?.name, 'update');
    if (!existing) {
      throw new Error(`技能 ${skillInput?.name || '(unknown)'} 不存在，无法 update。`);
    }
    const nextRecord = buildStoredMicroSkillRecord(skillInput, existing);
    const persistedRecord = await persistMutatedSkillRecord(existing, nextRecord);

    return {
      ok: true,
      action: 'update',
      skill: buildMicroSkillSummary(persistedRecord),
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
      skill: buildMicroSkillSummary(persistedRecord),
      ...(await maybeRefreshCurrentDocument(options?.tabId))
    };
  }

  async function deleteSkillFile(skillName, filePath, options = {}) {
    const existing = await getMutableStoredSkillRecord(skillName, 'delete_file');
    const normalizedExisting = normalizeStoredMicroSkillRecord(existing);
    if (!normalizedExisting) {
      throw new Error(`技能 ${skillName} 不存在，无法删除文件。`);
    }

    const normalizedPath = normalizeMicroSkillFilePath(filePath);
    if (normalizedPath === MICRO_SKILL_VIRTUAL_MANIFEST_PATH) {
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

    const nextRecord = buildStoredMicroSkillRecord({
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
      skill: buildMicroSkillSummary(persistedRecord),
      files: buildMicroSkillFileManifest(persistedRecord, { includeContent: false }),
      ...(await maybeRefreshCurrentDocument(options?.tabId))
    };
  }

  async function applySkillPatch(skillName, patch, options = {}) {
    const existing = await getMutableStoredSkillRecord(skillName, 'apply_patch');
    const normalizedExisting = normalizeStoredMicroSkillRecord(existing);
    if (!normalizedExisting) {
      throw new Error(`技能 ${skillName} 不存在，无法应用补丁。`);
    }

    const patched = applyMicroSkillPackagePatch(normalizedExisting, patch);
    const persistedRecord = await persistMutatedSkillRecord(normalizedExisting, patched.record);

    return {
      ok: true,
      action: 'apply_patch',
      skill: buildMicroSkillSummary(persistedRecord),
      files: buildMicroSkillFileManifest(persistedRecord, { includeContent: false }),
      affected_files: patched.affected_files,
      ...(await maybeRefreshCurrentDocument(options?.tabId))
    };
  }

  async function deleteSkill(skillName, options = {}) {
    const existing = await getMutableStoredSkillRecord(skillName, 'delete');
    if (!existing) {
      throw new Error(`技能 ${skillName} 不存在，无法删除。`);
    }

    await deleteStoredMicroSkillPackage(existing.name, store);
    if (existing.enabled === true && existing.kind === 'page_runtime') {
      await unregisterSkillName(existing.name);
    }

    return {
      ok: true,
      action: 'delete_skill',
      deleted: true,
      skill: buildMicroSkillSummary(existing),
      ...(await maybeRefreshCurrentDocument(options?.tabId))
    };
  }

  async function executeRegistryAction(rawArgs, options = {}) {
    const normalizedArgs = normalizeMicroSkillRegistryToolArguments(rawArgs);
    switch (normalizedArgs.action) {
      case 'list': {
        const skills = (await listSkillRecords())
          .map((record) => buildMicroSkillSummary(record))
          .filter(Boolean);
        return {
          ok: true,
          action: 'list',
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
          ...buildMicroSkillFileIndexPayload(records, {
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
          ...searchMicroSkillFiles(records, {
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
          skill: buildMicroSkillDetail(record, {
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
          skill: buildMicroSkillPackagePayload(record, {
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
          skill: buildMicroSkillFilePayload(record, normalizedArgs.file_path, {
            contentReadArgs: normalizedArgs.read_options,
            includeLineNumbers: normalizedArgs.include_line_numbers
          })
        };
      }
      case 'create_skill':
        return await createSkill(normalizedArgs.skill, { tabId: options?.tabId });
      case 'update':
        return await updateSkill(normalizedArgs.skill, { tabId: options?.tabId });
      case 'apply_patch':
        return await applySkillPatch(normalizedArgs.skill_name, normalizedArgs.patch, {
          tabId: options?.tabId
        });
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
    reconcileRegisteredSkills,
    setSkillEnabled,
    syncCurrentDocumentSkills,
    updateSkill
  };
}
