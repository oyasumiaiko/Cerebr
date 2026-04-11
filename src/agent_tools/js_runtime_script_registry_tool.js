/**
 * JS Runtime 脚本注册表工具。
 *
 * 目标：
 * - 把“常用 JS 片段 / helper bootstrap”持久化到扩展侧存储；
 * - 允许模型通过统一工具对脚本做 save/get/list/delete/refresh；
 * - refresh 明确表示“把已保存脚本重新执行到当前 JS Runtime 环境”，
 *   而不是偷偷做自动注入或隐式 fallback。
 *
 * 说明：
 * - 这里把“扩展 localStorage”语义统一落到 `chrome.storage.local`：
 *   Manifest V3 的 background/service worker 没有稳定可用的 window.localStorage，
 *   但 `chrome.storage.local` 在整个扩展内可达、可备份、也更适合脚本对象管理。
 * - scope 目前只作为脚本元数据保存，便于后续扩展成按域 / 按 match 自动装载；
 *   这次先不引入自动注入路径，避免把“注册表”和“调度器”一次性耦合在一起。
 */

export const JS_RUNTIME_SCRIPT_REGISTRY_TOOL_NAME = 'js_runtime_script_registry';
export const JS_RUNTIME_SCRIPT_REGISTRY_STORAGE_KEY = 'js_runtime_script_registry_v1';
const JS_RUNTIME_SCRIPT_REGISTRY_VERSION = 1;

function normalizeString(value) {
  return (typeof value === 'string') ? value.trim() : '';
}

function normalizeOptionalString(value) {
  const text = normalizeString(value);
  return text || null;
}

function normalizeBoolean(value, fallback = false) {
  return (typeof value === 'boolean') ? value : fallback;
}

function toIsoTimestamp(value) {
  const text = normalizeString(value);
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeStoredRevision(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 1;
}

function normalizeFrameIds(rawValue) {
  if (!Array.isArray(rawValue)) return null;
  const values = rawValue
    .map(value => Number(value))
    .filter(value => Number.isFinite(value))
    .map(value => Math.trunc(value));
  return values.length > 0 ? values : null;
}

function ensureStorageArea(storageArea = null) {
  const area = storageArea || globalThis?.chrome?.storage?.local || null;
  if (!area || typeof area.get !== 'function' || typeof area.set !== 'function' || typeof area.remove !== 'function') {
    throw new Error('当前环境没有可用的 chrome.storage.local，无法管理 JS 脚本注册表。');
  }
  return area;
}

function normalizeScriptInput(rawScript, options = {}) {
  const script = (rawScript && typeof rawScript === 'object' && !Array.isArray(rawScript))
    ? rawScript
    : {};
  const id = normalizeString(script.id);
  const rawCode = (typeof script.code === 'string') ? script.code : '';
  const requireCode = options?.requireCode !== false;

  if (!id) {
    throw new Error('js_runtime_script_registry 参数错误：script.id 不能为空。');
  }
  if (requireCode && !rawCode.trim()) {
    throw new Error(`js_runtime_script_registry 参数错误：脚本 ${id} 的 code 不能为空。`);
  }

  return {
    id,
    name: normalizeOptionalString(script.name),
    description: normalizeOptionalString(script.description),
    scope: normalizeOptionalString(script.scope),
    enabled: normalizeBoolean(script.enabled, true),
    code: rawCode
  };
}

function normalizeStoredScriptRecord(rawRecord) {
  const record = (rawRecord && typeof rawRecord === 'object' && !Array.isArray(rawRecord))
    ? rawRecord
    : {};
  const id = normalizeString(record.id);
  const code = (typeof record.code === 'string') ? record.code : '';
  if (!id || !code.trim()) return null;

  const createdAt = toIsoTimestamp(record.created_at) || new Date(0).toISOString();
  const updatedAt = toIsoTimestamp(record.updated_at) || createdAt;

  return {
    id,
    name: normalizeOptionalString(record.name) || id,
    description: normalizeOptionalString(record.description),
    scope: normalizeOptionalString(record.scope),
    enabled: normalizeBoolean(record.enabled, true),
    code,
    created_at: createdAt,
    updated_at: updatedAt,
    revision: normalizeStoredRevision(record.revision)
  };
}

function buildStoredScriptRecord(scriptInput, existingRecord = null) {
  const now = new Date().toISOString();
  const existing = normalizeStoredScriptRecord(existingRecord);
  return {
    id: scriptInput.id,
    name: scriptInput.name || existing?.name || scriptInput.id,
    description: scriptInput.description,
    scope: scriptInput.scope,
    enabled: scriptInput.enabled,
    code: scriptInput.code,
    created_at: existing?.created_at || now,
    updated_at: now,
    revision: existing ? existing.revision + 1 : 1
  };
}

function buildScriptSummary(record) {
  const normalized = normalizeStoredScriptRecord(record);
  if (!normalized) return null;
  return {
    id: normalized.id,
    name: normalized.name,
    description: normalized.description,
    scope: normalized.scope,
    enabled: normalized.enabled,
    created_at: normalized.created_at,
    updated_at: normalized.updated_at,
    revision: normalized.revision,
    code_length: normalized.code.length
  };
}

function buildScriptDetail(record) {
  const normalized = normalizeStoredScriptRecord(record);
  if (!normalized) return null;
  return {
    ...buildScriptSummary(normalized),
    code: normalized.code
  };
}

async function loadRegistrySnapshot(storageArea = null) {
  const area = ensureStorageArea(storageArea);
  const wrap = await area.get([JS_RUNTIME_SCRIPT_REGISTRY_STORAGE_KEY]);
  const rawSnapshot = wrap?.[JS_RUNTIME_SCRIPT_REGISTRY_STORAGE_KEY];
  const rawScriptsById = (rawSnapshot && typeof rawSnapshot === 'object' && !Array.isArray(rawSnapshot))
    ? (
        (rawSnapshot.scripts_by_id && typeof rawSnapshot.scripts_by_id === 'object' && !Array.isArray(rawSnapshot.scripts_by_id))
          ? rawSnapshot.scripts_by_id
          : ((rawSnapshot.scripts && typeof rawSnapshot.scripts === 'object' && !Array.isArray(rawSnapshot.scripts)) ? rawSnapshot.scripts : {})
      )
    : {};

  const scripts_by_id = {};
  for (const value of Object.values(rawScriptsById)) {
    const normalized = normalizeStoredScriptRecord(value);
    if (!normalized) continue;
    scripts_by_id[normalized.id] = normalized;
  }

  return {
    version: JS_RUNTIME_SCRIPT_REGISTRY_VERSION,
    scripts_by_id
  };
}

async function saveRegistrySnapshot(snapshot, storageArea = null) {
  const area = ensureStorageArea(storageArea);
  const normalizedSnapshot = {
    version: JS_RUNTIME_SCRIPT_REGISTRY_VERSION,
    scripts_by_id: {}
  };

  const source = (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot))
    ? snapshot.scripts_by_id
    : null;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const value of Object.values(source)) {
      const normalized = normalizeStoredScriptRecord(value);
      if (!normalized) continue;
      normalizedSnapshot.scripts_by_id[normalized.id] = normalized;
    }
  }

  await area.set({
    [JS_RUNTIME_SCRIPT_REGISTRY_STORAGE_KEY]: normalizedSnapshot
  });
  return normalizedSnapshot;
}

async function upsertScriptRecord(scriptInput, storageArea = null) {
  const snapshot = await loadRegistrySnapshot(storageArea);
  const nextRecord = buildStoredScriptRecord(scriptInput, snapshot.scripts_by_id[scriptInput.id] || null);
  snapshot.scripts_by_id[nextRecord.id] = nextRecord;
  await saveRegistrySnapshot(snapshot, storageArea);
  return nextRecord;
}

async function getScriptRecord(scriptId, storageArea = null) {
  const snapshot = await loadRegistrySnapshot(storageArea);
  return snapshot.scripts_by_id[scriptId] || null;
}

async function listScriptRecords(storageArea = null) {
  const snapshot = await loadRegistrySnapshot(storageArea);
  return Object.values(snapshot.scripts_by_id)
    .sort((left, right) => {
      const leftTs = Date.parse(left.updated_at || '') || 0;
      const rightTs = Date.parse(right.updated_at || '') || 0;
      if (leftTs !== rightTs) return rightTs - leftTs;
      return left.id.localeCompare(right.id);
    });
}

async function deleteScriptRecord(scriptId, storageArea = null) {
  const snapshot = await loadRegistrySnapshot(storageArea);
  const existing = snapshot.scripts_by_id[scriptId] || null;
  if (!existing) return null;
  delete snapshot.scripts_by_id[scriptId];
  await saveRegistrySnapshot(snapshot, storageArea);
  return existing;
}

function normalizeRuntimeExecutionResult(rawResult) {
  const result = (rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult))
    ? rawResult
    : {};
  if (result.success !== true) {
    return {
      success: false,
      ok: false,
      tab_id: Number.isFinite(Number(result?.tabId)) ? Number(result.tabId) : null,
      value: null,
      logs: [],
      items: [],
      error: {
        message: normalizeString(result?.error) || '执行保存脚本失败。',
        name: 'StoredScriptRefreshError',
        stack: ''
      }
    };
  }

  return {
    success: true,
    ok: result.ok === true,
    tab_id: Number.isFinite(Number(result?.tabId)) ? Number(result.tabId) : null,
    value: result?.value ?? null,
    logs: Array.isArray(result?.logs) ? result.logs : [],
    items: Array.isArray(result?.items) ? result.items : [],
    error: null
  };
}

async function refreshStoredScript(record, dependencies = {}, executionOptions = {}) {
  const normalizedRecord = normalizeStoredScriptRecord(record);
  if (!normalizedRecord) {
    throw new Error('无法刷新不存在或无效的脚本记录。');
  }
  if (normalizedRecord.enabled !== true) {
    throw new Error(`脚本 ${normalizedRecord.id} 当前已禁用，无法 refresh。`);
  }
  if (typeof dependencies?.executeJsRuntime !== 'function') {
    throw new Error('当前客户端没有可用的 JS Runtime 执行入口，无法 refresh 已保存脚本。');
  }

  const rawResult = await dependencies.executeJsRuntime(normalizedRecord.code, {
    frameIds: executionOptions.frameIds,
    injectImmediately: executionOptions.injectImmediately === true,
    runtimeEnvironment: normalizeString(executionOptions.runtimeEnvironment) || undefined
  });
  return normalizeRuntimeExecutionResult(rawResult);
}

export function normalizeJsRuntimeScriptRegistryArguments(rawArgs) {
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs))
    ? rawArgs
    : {};
  const action = normalizeString(args.action).toLowerCase();
  const scriptId = normalizeString(args.script_id);
  const frameIds = normalizeFrameIds(args.frame_ids);
  const injectImmediately = args.inject_immediately === true;
  const runtimeEnvironment = normalizeOptionalString(args.runtime_environment);

  if (!action) {
    throw new Error('js_runtime_script_registry 参数错误：action 不能为空。');
  }

  if (!['save', 'get', 'list', 'delete', 'refresh'].includes(action)) {
    throw new Error(`js_runtime_script_registry 参数错误：不支持的 action \`${action}\`。`);
  }

  if (action === 'list') {
    return { action, scriptId: null, script: null, refreshAfterSave: false, frameIds, injectImmediately, runtimeEnvironment };
  }

  if (action === 'save') {
    return {
      action,
      scriptId: null,
      script: normalizeScriptInput(args.script, { requireCode: true }),
      refreshAfterSave: args.refresh_after_save === true,
      frameIds,
      injectImmediately,
      runtimeEnvironment
    };
  }

  if (!scriptId) {
    throw new Error(`js_runtime_script_registry 参数错误：action=${action} 时 script_id 不能为空。`);
  }

  return {
    action,
    scriptId,
    script: null,
    refreshAfterSave: false,
    frameIds,
    injectImmediately,
    runtimeEnvironment
  };
}

export function buildJsRuntimeScriptRegistryFunctionToolDefinition() {
  return {
    type: 'function',
    name: JS_RUNTIME_SCRIPT_REGISTRY_TOOL_NAME,
    description: [
      '管理扩展侧持久化保存的 JS Runtime 脚本对象。',
      '适合把常用 helper bootstrap、页面分析片段或可重复执行的函数体保存到扩展内部统一管理。',
      'action=save 会按 script.id 覆盖同名脚本；action=refresh 会把已保存脚本重新执行到当前 JS Runtime 环境。',
      'scope 当前只保存为脚本元数据，便于后续按站点组织；本工具本轮不会自动按域注入。'
    ].join(' '),
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          description: '必填。支持 save、get、list、delete、refresh。'
        },
        script_id: {
          type: ['string', 'null'],
          description: 'get/delete/refresh 时必填。要操作的脚本 id。'
        },
        script: {
          type: ['object', 'null'],
          description: 'save 时必填。脚本对象；相同 id 会执行覆盖更新。',
          additionalProperties: false,
          properties: {
            id: {
              type: 'string',
              description: '脚本唯一 id。推荐使用稳定的英文 snake_case 或 kebab-case。'
            },
            name: {
              type: ['string', 'null'],
              description: '可选。脚本显示名。'
            },
            description: {
              type: ['string', 'null'],
              description: '可选。脚本说明。'
            },
            scope: {
              type: ['string', 'null'],
              description: '可选。脚本作用域说明，例如某个 origin、域名或匹配模式；本轮只做元数据保存。'
            },
            enabled: {
              type: ['boolean', 'null'],
              description: '可选。默认 true。false 表示保留但不允许 refresh。'
            },
            code: {
              type: 'string',
              description: '必填。作为 async 函数体执行的 JS 代码。'
            }
          },
          required: ['id', 'code']
        },
        refresh_after_save: {
          type: ['boolean', 'null'],
          description: '可选。仅在 action=save 时生效；true 表示保存后立刻 refresh 到当前 JS Runtime 环境。'
        },
        frame_ids: {
          type: ['array', 'null'],
          description: '可选。refresh / refresh_after_save 时使用的目标 frame 列表。',
          items: {
            type: 'integer'
          }
        },
        inject_immediately: {
          type: ['boolean', 'null'],
          description: '可选。refresh / refresh_after_save 时透传给 JS Runtime。'
        },
        runtime_environment: {
          type: ['string', 'null'],
          description: '可选。refresh / refresh_after_save 时强制指定 runtime 环境；通常省略，让客户端使用当前默认环境。'
        }
      },
      required: ['action']
    }
  };
}

export async function executeJsRuntimeScriptRegistryTool(rawArgs, dependencies = {}) {
  const normalizedArgs = normalizeJsRuntimeScriptRegistryArguments(rawArgs);
  const storageArea = dependencies?.storageArea || null;

  if (normalizedArgs.action === 'list') {
    const scripts = await listScriptRecords(storageArea);
    return {
      ok: true,
      action: 'list',
      total_scripts: scripts.length,
      scripts: scripts.map(buildScriptSummary).filter(Boolean)
    };
  }

  if (normalizedArgs.action === 'get') {
    const script = await getScriptRecord(normalizedArgs.scriptId, storageArea);
    if (!script) {
      throw new Error(`未找到脚本 ${normalizedArgs.scriptId}。`);
    }
    return {
      ok: true,
      action: 'get',
      script: buildScriptDetail(script)
    };
  }

  if (normalizedArgs.action === 'delete') {
    const removed = await deleteScriptRecord(normalizedArgs.scriptId, storageArea);
    if (!removed) {
      throw new Error(`未找到脚本 ${normalizedArgs.scriptId}，无法删除。`);
    }
    return {
      ok: true,
      action: 'delete',
      deleted: true,
      script: buildScriptSummary(removed)
    };
  }

  if (normalizedArgs.action === 'save') {
    const saved = await upsertScriptRecord(normalizedArgs.script, storageArea);
    let refreshResult = null;
    if (normalizedArgs.refreshAfterSave) {
      refreshResult = await refreshStoredScript(saved, dependencies, normalizedArgs);
    }
    return {
      ok: true,
      action: 'save',
      saved: true,
      refreshed: normalizedArgs.refreshAfterSave,
      script: buildScriptSummary(saved),
      refresh_result: refreshResult
    };
  }

  if (normalizedArgs.action === 'refresh') {
    const script = await getScriptRecord(normalizedArgs.scriptId, storageArea);
    if (!script) {
      throw new Error(`未找到脚本 ${normalizedArgs.scriptId}，无法 refresh。`);
    }
    const refreshResult = await refreshStoredScript(script, dependencies, normalizedArgs);
    return {
      ok: refreshResult.ok === true,
      action: 'refresh',
      script: buildScriptSummary(script),
      refresh_result: refreshResult
    };
  }

  throw new Error(`未处理的 action：${normalizedArgs.action}`);
}
