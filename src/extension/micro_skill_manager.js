import {
  buildMicroSkillContextSummary,
  buildMicroSkillDetail,
  buildMicroSkillFileManifest,
  buildMicroSkillFilePayload,
  buildMicroSkillPackagePayload,
  validateMicroSkillRecord,
  buildMicroSkillSummary,
  buildStoredMicroSkillRecord,
  deleteStoredMicroSkillPackage,
  getBuiltinMicroSkillRecord,
  getStoredMicroSkillPackage,
  listBuiltinMicroSkillRecords,
  listMatchingStoredMicroSkillPackagesForUrl,
  listStoredMicroSkillManifests,
  microSkillMatchesUrl,
  normalizeMicroSkillFilePath,
  normalizeMicroSkillRegistryToolArguments,
  normalizeStoredMicroSkillRecord,
  saveStoredMicroSkillPackage
} from '../agent_tools/micro_skill_registry_tool.js';
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

function cloneFiles(files) {
  return (Array.isArray(files) ? files : []).map((file) => ({ ...file }));
}

function buildValidationFailureResult(action, validation) {
  const firstErrorMessage = Array.isArray(validation?.errors) && validation.errors.length > 0
    ? validation.errors[0]?.message
    : '微型 skill 校验失败。';
  return {
    ok: false,
    action,
    valid: false,
    validation,
    error: {
      name: 'MicroSkillValidationError',
      message: firstErrorMessage || '微型 skill 校验失败。',
      stack: ''
    }
  };
}

export function createMicroSkillManager(options = {}) {
  const store = options?.store || createIndexedDbMicroSkillStore();
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

  async function listStoredRecords() {
    return await listStoredMicroSkillManifests(store);
  }

  async function listSkillRecords() {
    return [
      ...listBuiltinMicroSkillRecords(),
      ...(await listStoredRecords())
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
      throw new Error(`微型 skill ${skillName} 是内置只读指导 skill，不能执行 ${actionLabel}。`);
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
    await api.register([definition]);
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

  async function reconcileRegisteredSkills() {
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
      .filter((record) => record?.policy?.allow_implicit_invocation !== false)
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

  function validatePersistedCandidate(record) {
    return validateMicroSkillRecord(record);
  }

  async function createSkill(skillInput, options = {}) {
    const nextRecord = buildStoredMicroSkillRecord(skillInput, null);
    if (getBuiltinMicroSkillRecord(nextRecord.name)) {
      throw new Error(`微型 skill ${nextRecord.name} 是内置保留名称，不能 create。`);
    }
    const existing = await getStoredMicroSkillPackage(nextRecord.name, store);
    if (existing) {
      throw new Error(`微型 skill ${nextRecord.name} 已存在，不能重复 create。`);
    }
    const validation = validatePersistedCandidate(nextRecord);
    if (validation.valid !== true) {
      return buildValidationFailureResult('create', validation);
    }
    await saveStoredMicroSkillPackage(nextRecord, store);
    if (nextRecord.enabled && nextRecord.kind === 'page_runtime') {
      await registerSkillRecord(nextRecord);
    }
    return {
      ok: true,
      action: 'create',
      skill: buildMicroSkillSummary(nextRecord),
      validation,
      ...(await maybeRefreshCurrentDocument(options?.tabId))
    };
  }

  async function updateSkill(skillInput, options = {}) {
    const existing = await getMutableStoredSkillRecord(skillInput?.name, 'update');
    if (!existing) {
      throw new Error(`微型 skill ${skillInput?.name || '(unknown)'} 不存在，无法 update。`);
    }
    const nextRecord = buildStoredMicroSkillRecord(skillInput, existing);
    const validation = validatePersistedCandidate(nextRecord);
    if (validation.valid !== true) {
      return buildValidationFailureResult('update', validation);
    }
    const persistedRecord = await persistMutatedSkillRecord(existing, nextRecord);

    return {
      ok: true,
      action: 'update',
      skill: buildMicroSkillSummary(persistedRecord),
      validation,
      ...(await maybeRefreshCurrentDocument(options?.tabId))
    };
  }

  async function setSkillEnabled(skillName, enabled, options = {}) {
    const existing = await getMutableStoredSkillRecord(skillName, enabled === true ? 'enable' : 'disable');
    if (!existing) {
      throw new Error(`微型 skill ${skillName} 不存在，无法切换启用状态。`);
    }
    const nextRecord = buildRevisedSkillRecord(existing, {
      enabled: enabled === true
    });
    const persistedRecord = await persistMutatedSkillRecord(existing, nextRecord);

    return {
      ok: true,
      action: enabled === true ? 'enable' : 'disable',
      skill: buildMicroSkillSummary(persistedRecord),
      ...(await maybeRefreshCurrentDocument(options?.tabId))
    };
  }

  async function writeSkillFile(skillName, fileInput, options = {}) {
    const existing = await getMutableStoredSkillRecord(skillName, 'write_file');
    const normalizedExisting = normalizeStoredMicroSkillRecord(existing);
    if (!normalizedExisting) {
      throw new Error(`微型 skill ${skillName} 不存在，无法写入文件。`);
    }

    const nextFiles = cloneFiles(normalizedExisting.files);
    const existingIndex = nextFiles.findIndex((file) => file.path === fileInput.path);
    const existingFile = existingIndex >= 0 ? nextFiles[existingIndex] : null;
    const nextFile = {
      path: fileInput.path,
      kind: fileInput.kind || existingFile?.kind || null,
      content: fileInput.content
    };
    if (!nextFile.kind) {
      throw new Error(`微型 skill ${skillName} 的新文件 ${fileInput.path} 必须显式提供 kind。`);
    }

    if (existingIndex >= 0) {
      nextFiles[existingIndex] = nextFile;
    } else {
      nextFiles.push(nextFile);
    }

    const nextRecord = buildStoredMicroSkillRecord({
      ...normalizedExisting,
      instruction: {
        path: options?.setAsInstruction === true ? nextFile.path : normalizedExisting.instruction.path
      },
      runtime: {
        entry_path: options?.setAsRuntimeEntry === true ? nextFile.path : normalizedExisting.runtime.entry_path
      },
      files: nextFiles
    }, normalizedExisting);
    const validation = validatePersistedCandidate(nextRecord);
    if (validation.valid !== true) {
      return buildValidationFailureResult('write_file', validation);
    }
    const persistedRecord = await persistMutatedSkillRecord(normalizedExisting, nextRecord);

    return {
      ok: true,
      action: 'write_file',
      skill: buildMicroSkillSummary(persistedRecord),
      validation,
      files: buildMicroSkillFileManifest(persistedRecord, { includeContent: false }),
      file: buildMicroSkillFilePayload(persistedRecord, nextFile.path)?.file || null,
      ...(await maybeRefreshCurrentDocument(options?.tabId))
    };
  }

  async function deleteSkillFile(skillName, filePath, options = {}) {
    const existing = await getMutableStoredSkillRecord(skillName, 'delete_file');
    const normalizedExisting = normalizeStoredMicroSkillRecord(existing);
    if (!normalizedExisting) {
      throw new Error(`微型 skill ${skillName} 不存在，无法删除文件。`);
    }

    const normalizedPath = normalizeMicroSkillFilePath(filePath);
    const existingFile = normalizedExisting.files.find((file) => file.path === normalizedPath) || null;
    if (!existingFile) {
      throw new Error(`微型 skill ${skillName} 中不存在文件 ${normalizedPath}。`);
    }
    if (normalizedExisting.files.length <= 1) {
      throw new Error(`微型 skill ${skillName} 只剩最后一个文件，不能删除。`);
    }

    const nextFiles = normalizedExisting.files
      .filter((file) => file.path !== normalizedPath)
      .map((file) => ({ ...file }));
    const deletingInstruction = normalizedExisting.instruction.path === normalizedPath;
    const deletingRuntimeEntry = normalizedExisting.runtime.entry_path === normalizedPath;
    const nextInstructionPath = deletingInstruction
      ? (options?.nextInstructionPath || nextFiles.find((file) => file.kind === 'instruction')?.path || null)
      : normalizedExisting.instruction.path;
    const nextRuntimeEntryPath = deletingRuntimeEntry
      ? (options?.nextRuntimeEntryPath || nextFiles.find((file) => file.kind === 'runtime_source')?.path || null)
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
    const validation = validatePersistedCandidate(nextRecord);
    if (validation.valid !== true) {
      return buildValidationFailureResult('delete_file', validation);
    }
    const persistedRecord = await persistMutatedSkillRecord(normalizedExisting, nextRecord);

    return {
      ok: true,
      action: 'delete_file',
      deleted_file_path: normalizedPath,
      skill: buildMicroSkillSummary(persistedRecord),
      validation,
      files: buildMicroSkillFileManifest(persistedRecord, { includeContent: false }),
      ...(await maybeRefreshCurrentDocument(options?.tabId))
    };
  }

  async function deleteSkill(skillName, options = {}) {
    const existing = await getMutableStoredSkillRecord(skillName, 'delete');
    if (!existing) {
      throw new Error(`微型 skill ${skillName} 不存在，无法删除。`);
    }

    await deleteStoredMicroSkillPackage(existing.name, store);
    if (existing.enabled === true && existing.kind === 'page_runtime') {
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
      case 'validate': {
        const record = normalizedArgs.skill
          ? normalizedArgs.skill
          : await getSkillRecord(normalizedArgs.skill_name);
        if (!record) {
          throw new Error(`微型 skill ${normalizedArgs.skill_name} 不存在。`);
        }
        const validation = validateMicroSkillRecord(record);
        return {
          ok: true,
          action: 'validate',
          skill_name: normalizedArgs.skill_name || validation.normalized_skill?.name || null,
          ...validation
        };
      }
      case 'read_package': {
        const record = await getSkillRecord(normalizedArgs.skill_name);
        if (!record) {
          throw new Error(`微型 skill ${normalizedArgs.skill_name} 不存在。`);
        }
        return {
          ok: true,
          action: 'read_package',
          skill: buildMicroSkillPackagePayload(record)
        };
      }
      case 'read_file': {
        const record = await getSkillRecord(normalizedArgs.skill_name);
        if (!record) {
          throw new Error(`微型 skill ${normalizedArgs.skill_name} 不存在。`);
        }
        return {
          ok: true,
          action: 'read_file',
          skill: buildMicroSkillFilePayload(record, normalizedArgs.file_path)
        };
      }
      case 'create':
        return await createSkill(normalizedArgs.skill, { tabId: options?.tabId });
      case 'update':
        return await updateSkill(normalizedArgs.skill, { tabId: options?.tabId });
      case 'write_file':
        return await writeSkillFile(normalizedArgs.skill_name, normalizedArgs.file, {
          tabId: options?.tabId,
          setAsInstruction: normalizedArgs.set_as_instruction === true,
          setAsRuntimeEntry: normalizedArgs.set_as_runtime_entry === true
        });
      case 'delete_file':
        return await deleteSkillFile(normalizedArgs.skill_name, normalizedArgs.file_path, {
          tabId: options?.tabId,
          nextInstructionPath: normalizedArgs.next_instruction_path,
          nextRuntimeEntryPath: normalizedArgs.next_runtime_entry_path
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
