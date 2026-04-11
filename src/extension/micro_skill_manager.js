import {
  buildMicroSkillContextSummary,
  buildMicroSkillDetail,
  getBuiltinMicroSkillRecord,
  listBuiltinMicroSkillRecords,
  buildMicroSkillSourceFilePayload,
  buildMicroSkillSourceManifest,
  buildMicroSkillSourcePayload,
  buildMicroSkillSummary,
  buildStoredMicroSkillRecord,
  listMatchingMicroSkillRecordsForUrl,
  loadMicroSkillRegistrySnapshot,
  normalizeMicroSkillRegistryToolArguments,
  normalizeMicroSkillSource,
  normalizeStoredMicroSkillRecord,
  saveMicroSkillRegistrySnapshot
} from '../agent_tools/micro_skill_registry_tool.js';
import {
  buildMicroSkillDocumentRefreshSource,
  buildRegisteredMicroSkillScriptId,
  buildRegisteredMicroSkillUserScript
} from './micro_skill_runtime.js';

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

async function normalizeRefreshExecutionResult(rawResult, matchedRecords) {
  const matchedSkills = sortSkillRecords(matchedRecords)
    .map((record) => buildMicroSkillSummary(record))
    .filter(Boolean);
  const result = (rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult))
    ? rawResult
    : {};

  return {
    ok: result.ok === true,
    tab_id: normalizeTabId(result?.tabId),
    matched_skills: matchedSkills,
    value: result?.value ?? null,
    logs: Array.isArray(result?.logs) ? result.logs : [],
    items: Array.isArray(result?.items) ? result.items : [],
    error: (result?.success === false || result?.ok !== true)
      ? {
          message: (typeof result?.error === 'string' && result.error.trim())
            ? result.error.trim()
            : '微型 skill 当前文档 refresh 失败。',
          name: 'MicroSkillRefreshError',
          stack: ''
        }
      : null
  };
}

export function createMicroSkillManager(options = {}) {
  const storageArea = options?.storageArea || globalThis?.chrome?.storage?.local || null;
  const userScriptsApi = options?.userScriptsApi || globalThis?.chrome?.userScripts || null;
  const tabsApi = options?.tabsApi || globalThis?.chrome?.tabs || null;
  const jsRuntimeManager = options?.jsRuntimeManager || null;

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

  async function getSkillSnapshot() {
    return await loadMicroSkillRegistrySnapshot(storageArea);
  }

  async function listSkillRecords() {
    const snapshot = await getSkillSnapshot();
    return [
      ...listBuiltinMicroSkillRecords(),
      ...sortSkillRecords(Object.values(snapshot.skills_by_name))
    ];
  }

  async function getSkillRecord(skillName) {
    const builtin = getBuiltinMicroSkillRecord(skillName);
    if (builtin) {
      return builtin;
    }
    const snapshot = await getSkillSnapshot();
    return snapshot.skills_by_name[String(skillName || '')] || null;
  }

  async function getMutableStoredSkillRecord(skillName, actionLabel) {
    const builtin = getBuiltinMicroSkillRecord(skillName);
    if (builtin) {
      throw new Error(`微型 skill ${skillName} 是内置只读指导 skill，不能执行 ${actionLabel}。`);
    }
    const snapshot = await getSkillSnapshot();
    return {
      snapshot,
      record: snapshot.skills_by_name[String(skillName || '')] || null
    };
  }

  function buildRevisedSkillRecord(existingRecord, updates = {}) {
    const existing = normalizeStoredMicroSkillRecord(existingRecord);
    if (!existing) {
      throw new Error('无法基于无效 skill 记录生成修订版本。');
    }

    return normalizeStoredMicroSkillRecord({
      ...existing,
      ...updates,
      updated_at: new Date().toISOString(),
      revision: Number(existing.revision || 0) + 1
    });
  }

  async function persistMutatedSkillRecord(snapshot, existingRecord, nextRecord) {
    const normalizedExisting = normalizeStoredMicroSkillRecord(existingRecord);
    const normalizedNext = normalizeStoredMicroSkillRecord(nextRecord);
    if (!normalizedNext) {
      throw new Error('写入 skill 记录失败：新记录无效。');
    }

    snapshot.skills_by_name[normalizedNext.name] = normalizedNext;
    await persistSnapshot(snapshot);

    if (normalizedNext.enabled) {
      if (normalizedExisting?.enabled === true) {
        await updateSkillRecordRegistration(normalizedNext);
      } else {
        await registerSkillRecord(normalizedNext);
      }
    } else if (normalizedExisting?.enabled === true) {
      await unregisterSkillName(normalizedNext.name);
    }

    return normalizedNext;
  }

  async function registerSkillRecord(record) {
    const skill = normalizeStoredMicroSkillRecord(record);
    if (!skill || skill.enabled !== true) return null;
    const api = ensureUserScriptsApi();
    const definition = buildRegisteredMicroSkillUserScript(skill);
    await api.register([definition]);
    return definition;
  }

  async function updateSkillRecordRegistration(record) {
    const skill = normalizeStoredMicroSkillRecord(record);
    if (!skill || skill.enabled !== true) return null;
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

  async function reconcileRegisteredSkills() {
    const api = ensureUserScriptsApi();
    const snapshot = await getSkillSnapshot();
    const desiredRecords = sortSkillRecords(
      Object.values(snapshot.skills_by_name).filter((record) => record?.enabled === true)
    );
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
    if (definitionsToRegister.length > 0) {
      await api.register(definitionsToRegister);
    }
    if (definitionsToUpdate.length > 0) {
      await api.update(definitionsToUpdate);
    }

    return {
      ok: true,
      registered_count: definitionsToRegister.length,
      updated_count: definitionsToUpdate.length,
      unregistered_count: idsToUnregister.length
    };
  }

  async function getTabUrl(tabId) {
    const normalizedTabId = normalizeTabId(tabId);
    if (normalizedTabId === null) {
      throw new Error('缺少有效的目标标签页，无法刷新当前文档微型 skill。');
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
      throw new Error('当前标签页没有可用 URL，无法计算匹配的微型 skill。');
    }

    const matchingRecords = await listMatchingMicroSkillRecordsForUrl(url, storageArea);
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
    const matchingRecords = await listMatchingMicroSkillRecordsForUrl(url, storageArea);
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

  async function persistSnapshot(snapshot) {
    return await saveMicroSkillRegistrySnapshot(snapshot, storageArea);
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
    const snapshot = await getSkillSnapshot();
    const nextRecord = buildStoredMicroSkillRecord(skillInput, null);
    if (getBuiltinMicroSkillRecord(nextRecord.name)) {
      throw new Error(`微型 skill ${nextRecord.name} 是内置保留名称，不能 create。`);
    }
    if (snapshot.skills_by_name[nextRecord.name]) {
      throw new Error(`微型 skill ${nextRecord.name} 已存在，不能重复 create。`);
    }
    snapshot.skills_by_name[nextRecord.name] = nextRecord;
    await persistSnapshot(snapshot);
    if (nextRecord.enabled) {
      await registerSkillRecord(nextRecord);
    }
    return {
      ok: true,
      action: 'create',
      skill: buildMicroSkillSummary(nextRecord),
      ...(await maybeRefreshCurrentDocument(options?.tabId))
    };
  }

  async function updateSkill(skillInput, options = {}) {
    const { snapshot, record: existing } = await getMutableStoredSkillRecord(skillInput?.name, 'update');
    if (!existing) {
      throw new Error(`微型 skill ${skillInput?.name || '(unknown)'} 不存在，无法 update。`);
    }
    const nextRecord = buildStoredMicroSkillRecord(skillInput, existing);
    const persistedRecord = await persistMutatedSkillRecord(snapshot, existing, nextRecord);

    return {
      ok: true,
      action: 'update',
      skill: buildMicroSkillSummary(persistedRecord),
      ...(await maybeRefreshCurrentDocument(options?.tabId))
    };
  }

  async function setSkillEnabled(skillName, enabled, options = {}) {
    const { snapshot, record: existing } = await getMutableStoredSkillRecord(skillName, enabled === true ? 'enable' : 'disable');
    if (!existing) {
      throw new Error(`微型 skill ${skillName} 不存在，无法切换启用状态。`);
    }
    const nextRecord = buildRevisedSkillRecord(existing, {
      enabled: enabled === true,
    });
    const persistedRecord = await persistMutatedSkillRecord(snapshot, existing, nextRecord);

    return {
      ok: true,
      action: enabled === true ? 'enable' : 'disable',
      skill: buildMicroSkillSummary(persistedRecord),
      ...(await maybeRefreshCurrentDocument(options?.tabId))
    };
  }

  async function upsertSkillSourceFile(skillName, fileInput, options = {}) {
    const { snapshot, record: existing } = await getMutableStoredSkillRecord(skillName, 'upsert_source_file');
    const normalizedExisting = normalizeStoredMicroSkillRecord(existing);
    if (!normalizedExisting) {
      throw new Error(`微型 skill ${skillName} 不存在，无法写入源码文件。`);
    }

    const incomingFile = {
      path: fileInput.path,
      code: fileInput.code
    };
    const nextFiles = normalizedExisting.source.files.map((file) => ({ ...file }));
    const existingIndex = nextFiles.findIndex((file) => file.path === incomingFile.path);
    if (existingIndex >= 0) {
      nextFiles[existingIndex] = incomingFile;
    } else {
      nextFiles.push(incomingFile);
    }

    const nextSource = normalizeMicroSkillSource({
      entry: options?.setAsEntry === true ? incomingFile.path : normalizedExisting.source.entry,
      files: nextFiles
    }, {
      requireFiles: true,
      requireCode: true
    });
    const nextRecord = buildRevisedSkillRecord(normalizedExisting, {
      source: nextSource
    });
    const persistedRecord = await persistMutatedSkillRecord(snapshot, normalizedExisting, nextRecord);

    return {
      ok: true,
      action: 'upsert_source_file',
      skill: buildMicroSkillSummary(persistedRecord),
      source: buildMicroSkillSourceManifest(persistedRecord, { includeCode: false }),
      file: buildMicroSkillSourceFilePayload(persistedRecord, incomingFile.path)?.source?.files?.[0] || null,
      ...(await maybeRefreshCurrentDocument(options?.tabId))
    };
  }

  async function deleteSkillSourceFile(skillName, filePath, options = {}) {
    const { snapshot, record: existing } = await getMutableStoredSkillRecord(skillName, 'delete_source_file');
    const normalizedExisting = normalizeStoredMicroSkillRecord(existing);
    if (!normalizedExisting) {
      throw new Error(`微型 skill ${skillName} 不存在，无法删除源码文件。`);
    }

    const existingFile = normalizedExisting.source.files.find((file) => file.path === filePath) || null;
    if (!existingFile) {
      throw new Error(`微型 skill ${skillName} 中不存在源码文件 ${filePath}。`);
    }
    if (normalizedExisting.source.files.length <= 1) {
      throw new Error(`微型 skill ${skillName} 只剩最后一个源码文件，不能删除。`);
    }

    const nextFiles = normalizedExisting.source.files
      .filter((file) => file.path !== filePath)
      .map((file) => ({ ...file }));
    const deletingEntry = normalizedExisting.source.entry === filePath;
    const nextEntry = deletingEntry
      ? (options?.nextEntryPath || nextFiles[0]?.path || null)
      : normalizedExisting.source.entry;

    if (!nextFiles.some((file) => file.path === nextEntry)) {
      throw new Error(`删除源码文件 ${filePath} 后，新的 entry 文件 ${nextEntry || '(empty)'} 无效。`);
    }

    const nextSource = normalizeMicroSkillSource({
      entry: nextEntry,
      files: nextFiles
    }, {
      requireFiles: true,
      requireCode: true
    });
    const nextRecord = buildRevisedSkillRecord(normalizedExisting, {
      source: nextSource
    });
    const persistedRecord = await persistMutatedSkillRecord(snapshot, normalizedExisting, nextRecord);

    return {
      ok: true,
      action: 'delete_source_file',
      deleted_file_path: filePath,
      skill: buildMicroSkillSummary(persistedRecord),
      source: buildMicroSkillSourceManifest(persistedRecord, { includeCode: false }),
      ...(await maybeRefreshCurrentDocument(options?.tabId))
    };
  }

  async function deleteSkill(skillName, options = {}) {
    const { snapshot, record: existing } = await getMutableStoredSkillRecord(skillName, 'delete');
    if (!existing) {
      throw new Error(`微型 skill ${skillName} 不存在，无法删除。`);
    }

    delete snapshot.skills_by_name[existing.name];
    await persistSnapshot(snapshot);
    if (existing.enabled === true) {
      await unregisterSkillName(existing.name);
    }

    return {
      ok: true,
      action: 'delete',
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
      case 'read_detail': {
        const record = await getSkillRecord(normalizedArgs.skill_name);
        if (!record) {
          throw new Error(`微型 skill ${normalizedArgs.skill_name} 不存在。`);
        }
        return {
          ok: true,
          action: 'read_detail',
          skill: buildMicroSkillDetail(record)
        };
      }
      case 'read_source': {
        const record = await getSkillRecord(normalizedArgs.skill_name);
        if (!record) {
          throw new Error(`微型 skill ${normalizedArgs.skill_name} 不存在。`);
        }
        return {
          ok: true,
          action: 'read_source',
          skill: buildMicroSkillSourcePayload(record)
        };
      }
      case 'read_source_file': {
        const record = await getSkillRecord(normalizedArgs.skill_name);
        if (!record) {
          throw new Error(`微型 skill ${normalizedArgs.skill_name} 不存在。`);
        }
        return {
          ok: true,
          action: 'read_source_file',
          skill: buildMicroSkillSourceFilePayload(record, normalizedArgs.file_path)
        };
      }
      case 'create':
        return await createSkill(normalizedArgs.skill, { tabId: options?.tabId });
      case 'update':
        return await updateSkill(normalizedArgs.skill, { tabId: options?.tabId });
      case 'upsert_source_file':
        return await upsertSkillSourceFile(normalizedArgs.skill_name, normalizedArgs.file, {
          tabId: options?.tabId,
          setAsEntry: normalizedArgs.set_as_entry === true
        });
      case 'delete_source_file':
        return await deleteSkillSourceFile(normalizedArgs.skill_name, normalizedArgs.file_path, {
          tabId: options?.tabId,
          nextEntryPath: normalizedArgs.next_entry_path
        });
      case 'delete':
        return await deleteSkill(normalizedArgs.skill_name, { tabId: options?.tabId });
      case 'enable':
        return await setSkillEnabled(normalizedArgs.skill_name, true, { tabId: options?.tabId });
      case 'disable':
        return await setSkillEnabled(normalizedArgs.skill_name, false, { tabId: options?.tabId });
      case 'refresh_current_document': {
        if (normalizedArgs.skill_name) {
          const record = await getSkillRecord(normalizedArgs.skill_name);
          if (!record) {
            throw new Error(`微型 skill ${normalizedArgs.skill_name} 不存在。`);
          }
        }
        return {
          ok: true,
          action: 'refresh_current_document',
          requested_skill_name: normalizedArgs.skill_name,
          refreshed_current_document: true,
          refresh_result: await syncCurrentDocumentSkills(options?.tabId)
        };
      }
      default:
        throw new Error(`未处理的 micro skill action：${normalizedArgs.action}`);
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
