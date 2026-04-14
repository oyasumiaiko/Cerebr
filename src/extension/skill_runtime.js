import {
  CEREBR_SKILL_MOUNT_SURFACE,
  buildSkillContextSummary,
  normalizeStoredSkillRecord
} from '../agent_tools/skill/registry_tool.js';

export const CEREBR_SKILL_WORLD_ID = 'cerebr-skills';
export const CEREBR_SKILL_SCRIPT_ID_PREFIX = 'cerebr-skill--';

function encodeInlineJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
}

function indentCodeBlock(code, indent = '        ') {
  const text = (typeof code === 'string') ? code : '';
  if (!text) return '';
  return text
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');
}

export function buildRegisteredSkillScriptId(skillName) {
  return `${CEREBR_SKILL_SCRIPT_ID_PREFIX}${encodeURIComponent(String(skillName || ''))}`;
}

function buildRuntimeBootstrapSource() {
  return `
const __cerebrEnsureSkillRuntime = () => {
  const existing = globalThis.__cerebrSkills;
  if (existing && typeof existing === 'object' && existing.__cerebrRuntime === true) {
    return existing;
  }

  const runtime = {
    __cerebrRuntime: true,
    skills: Object.create(null),
    skillMeta: Object.create(null),
    list() {
      return Object.keys(this.skills).sort();
    },
    has(name) {
      return Object.prototype.hasOwnProperty.call(this.skills, String(name || ''));
    },
    get(name) {
      return this.skills[String(name || '')] || null;
    },
    methods(name) {
      const skill = this.get(name);
      if (!skill || typeof skill !== 'object') return [];
      return Object.keys(skill)
        .filter((key) => typeof skill[key] === 'function')
        .sort();
    },
    async unmount(name) {
      const key = String(name || '');
      const current = this.skills[key];
      if (!current) return false;
      if (current && typeof current.dispose === 'function') {
        await current.dispose();
      }
      delete this.skills[key];
      delete this.skillMeta[key];
      return true;
    },
    mount(name, exports, meta) {
      const key = String(name || '');
      if (!key) {
        throw new Error('Skill mount requires a non-empty name.');
      }
      this.skills[key] = exports && typeof exports === 'object' ? exports : { default: exports };
      this.skillMeta[key] = meta && typeof meta === 'object' ? meta : {};
      return this.skills[key];
    },
    resolveInvocation(skillName, methodName, rawPath = '') {
      const normalizedSkillName = String(skillName || '').trim();
      const normalizedMethodName = String(methodName || '').trim();
      if (!normalizedSkillName) {
        if (rawPath) {
          throw new Error(\`Invalid skill path: \${rawPath}\`);
        }
        throw new Error('Skill invocation requires a non-empty skill name.');
      }
      if (!normalizedMethodName) {
        if (rawPath) {
          throw new Error(\`Invalid skill path: \${rawPath}\`);
        }
        throw new Error('Skill invocation requires a non-empty method name.');
      }
      const skill = this.skills[normalizedSkillName];
      if (!skill) {
        throw new Error(\`Skill not mounted: \${normalizedSkillName}\`);
      }
      const method = skill[normalizedMethodName];
      if (typeof method !== 'function') {
        throw new Error(\`Mounted skill method not found: \${normalizedSkillName}.\${normalizedMethodName}\`);
      }
      return {
        skill,
        method,
        skillName: normalizedSkillName,
        methodName: normalizedMethodName
      };
    },
    async invokeMethod(skillName, methodName, ...args) {
      const resolved = this.resolveInvocation(skillName, methodName);
      return await resolved.method(...args);
    },
    async invoke(path, ...args) {
      const rawPath = String(path || '');
      const firstDot = rawPath.indexOf('.');
      if (firstDot <= 0 || firstDot >= rawPath.length - 1) {
        throw new Error(\`Invalid skill path: \${rawPath}\`);
      }
      const skillName = rawPath.slice(0, firstDot);
      const methodName = rawPath.slice(firstDot + 1);
      return await this.invokeMethod(skillName, methodName, ...args);
    }
  };

  globalThis.__cerebrSkills = runtime;
  globalThis.$skill = (name) => __cerebrEnsureSkillRuntime().get(name);
  globalThis.$methods = (name) => __cerebrEnsureSkillRuntime().methods(name);
  globalThis.$invoke = async (skillName, methodName, ...args) => {
    const normalizedSkillName = String(skillName || '').trim();
    if (!normalizedSkillName) {
      throw new Error('Skill facade $invoke() requires a non-empty skill name.');
    }
    const normalizedMethodName = String(methodName || '').trim();
    if (!normalizedMethodName) {
      throw new Error('Skill facade $invoke() requires a non-empty method name.');
    }
    return await __cerebrEnsureSkillRuntime().invokeMethod(
      normalizedSkillName,
      normalizedMethodName,
      ...args
    );
  };
  return runtime;
};
const __cerebrSkillRuntime = __cerebrEnsureSkillRuntime();
`.trim();
}

function getRuntimeFiles(skill) {
  return Array.isArray(skill?.files)
    ? skill.files.filter((file) => file.kind === 'runtime_source')
    : [];
}

function buildSkillModuleFactoriesSource(skill) {
  return `{
${getRuntimeFiles(skill).map((file) => {
    const body = indentCodeBlock(file.content, '      ');
    return `  ${encodeInlineJson(file.path)}: async (ctx, module, exports, require) => {\n${body}\n  }`;
  }).join(',\n')}
}`;
}

function buildModuleLoaderHelpersSource() {
  return `
const __normalizeModulePath = (input) => {
  const raw = String(input || '').replace(/\\\\/g, '/').replace(/^(?:\\.\\/)+/, '');
  const normalized = raw.startsWith('/') ? raw.slice(1) : raw;
  if (!normalized) {
    throw new Error('Skill module path cannot be empty.');
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(\`Invalid skill module path: \${normalized}\`);
  }
  return normalized;
};

const __dirnameOfModule = (modulePath) => {
  const normalized = __normalizeModulePath(modulePath);
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex >= 0 ? normalized.slice(0, slashIndex) : '';
};

const __joinModulePath = (baseDir, requestPath) => {
  const baseSegments = baseDir ? baseDir.split('/').filter(Boolean) : [];
  const requestSegments = String(requestPath || '').split('/');
  const output = [...baseSegments];
  for (const segment of requestSegments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (output.length <= 0) {
        throw new Error(\`Skill module path escapes bundle root: \${requestPath}\`);
      }
      output.pop();
      continue;
    }
    output.push(segment);
  }
  return __normalizeModulePath(output.join('/'));
};

const __resolveRequestedModulePath = (requestPath, fromPath) => {
  const rawRequest = String(requestPath || '').trim();
  if (!rawRequest) {
    throw new Error('Skill require() needs a non-empty request path.');
  }
  if (rawRequest.startsWith('./') || rawRequest.startsWith('../')) {
    return __joinModulePath(__dirnameOfModule(fromPath), rawRequest);
  }
  if (rawRequest.startsWith('/')) {
    return __normalizeModulePath(rawRequest);
  }
  return __normalizeModulePath(rawRequest);
};
`.trim();
}

export function buildSkillMountSource(record, options = {}) {
  const skill = normalizeStoredSkillRecord(record);
  if (!skill) {
    throw new Error('无法为无效的skill 构造挂载源码。');
  }
  if (skill.kind !== 'page_runtime') {
    throw new Error(`skill ${skill.name} 不是页面 runtime skill，不能构造挂载源码。`);
  }
  if (!skill.runtime?.entry_path) {
    throw new Error(`skill ${skill.name} 缺少 runtime.entry_path，不能构造挂载源码。`);
  }

  const metaJson = encodeInlineJson({
    name: skill.name,
    revision: skill.revision,
    summary: buildSkillContextSummary(skill),
    entry: skill.runtime.entry_path,
    files: getRuntimeFiles(skill).map((file) => file.path)
  });
  const moduleFactoriesSource = buildSkillModuleFactoriesSource(skill);
  const includeBootstrap = options?.includeBootstrap !== false;

  return `
await (async () => {
  ${includeBootstrap ? buildRuntimeBootstrapSource() : ''}
  const __skillMeta = ${metaJson};
  const __existingMeta = __cerebrSkillRuntime.skillMeta[__skillMeta.name];
  if (__existingMeta && Number(__existingMeta.revision) === Number(__skillMeta.revision)) {
    return;
  }

  if (__cerebrSkillRuntime.has(__skillMeta.name)) {
    await __cerebrSkillRuntime.unmount(__skillMeta.name);
  }

  let __mountedExplicitly = false;
  const __moduleFactories = ${moduleFactoriesSource};
  const __moduleCache = new Map();
  ${buildModuleLoaderHelpersSource()}

  const __ctx = {
    name: __skillMeta.name,
    summary: __skillMeta.summary,
    runtime: __cerebrSkillRuntime,
    skills: __cerebrSkillRuntime.skills,
    entry_path: __skillMeta.entry,
    files: [...__skillMeta.files],
    list: () => __cerebrSkillRuntime.list(),
    has: (name) => __cerebrSkillRuntime.has(name),
    invoke: (path, ...args) => __cerebrSkillRuntime.invoke(path, ...args),
    mount: (exports) => {
      __mountedExplicitly = true;
      return __cerebrSkillRuntime.mount(__skillMeta.name, exports, __skillMeta);
    }
  };

  const __runModule = async (modulePath) => {
    const __normalizedModulePath = __normalizeModulePath(modulePath);
    if (__moduleCache.has(__normalizedModulePath)) {
      return __moduleCache.get(__normalizedModulePath).exports;
    }
    const __factory = __moduleFactories[__normalizedModulePath];
    if (typeof __factory !== 'function') {
      throw new Error(\`Skill module not found: \${__normalizedModulePath}\`);
    }

    const __module = { exports: {} };
    __moduleCache.set(__normalizedModulePath, __module);
    const __localRequire = async (requestPath) => {
      const __resolvedPath = __resolveRequestedModulePath(requestPath, __normalizedModulePath);
      return await __runModule(__resolvedPath);
    };
    const __localCtx = {
      ...__ctx,
      file_path: __normalizedModulePath,
      require: __localRequire
    };
    const __returned = await __factory(__localCtx, __module, __module.exports, __localRequire);
    if (__returned !== undefined) {
      __module.exports = __returned;
    }
    return __module.exports;
  };

  __ctx.require = async (requestPath) => {
    const __resolvedPath = __resolveRequestedModulePath(requestPath, __skillMeta.entry);
    return await __runModule(__resolvedPath);
  };

  const __returned = await __runModule(__skillMeta.entry);
  if (!__mountedExplicitly) {
    __cerebrSkillRuntime.mount(__skillMeta.name, __returned ?? {}, __skillMeta);
  }
})();
`.trim();
}

export function buildSkillDocumentRefreshSource(records) {
  const skills = Array.isArray(records)
    ? records.map((record) => normalizeStoredSkillRecord(record)).filter(Boolean)
    : [];
  const desiredNamesJson = encodeInlineJson(skills.map((skill) => skill.name));
  const mountBlocks = skills
    .map((skill) => buildSkillMountSource(skill, { includeBootstrap: false }))
    .join('\n');

  return `
${buildRuntimeBootstrapSource()}
const __desiredSkillNames = new Set(${desiredNamesJson});
for (const __name of Object.keys(__cerebrSkillRuntime.skills)) {
  const __meta = __cerebrSkillRuntime.skillMeta[__name];
  if (!__meta || !__desiredSkillNames.has(__name)) {
    await __cerebrSkillRuntime.unmount(__name);
  }
}
${mountBlocks}
return {
  mount_surface: ${encodeInlineJson(CEREBR_SKILL_MOUNT_SURFACE)},
  active_skills: __cerebrSkillRuntime.list()
};
`.trim();
}

export function buildSkillMountOnCurrentPageSource(record) {
  const skill = normalizeStoredSkillRecord(record);
  if (!skill) {
    throw new Error('无法为无效的技能构造当前页挂载源码。');
  }
  if (skill.kind !== 'page_runtime') {
    throw new Error(`技能 ${skill.name} 不是页面 runtime skill，不能构造当前页挂载源码。`);
  }

  return `
${buildRuntimeBootstrapSource()}
${buildSkillMountSource(skill, { includeBootstrap: false })}
return {
  mount_surface: ${encodeInlineJson(CEREBR_SKILL_MOUNT_SURFACE)},
  active_skills: __cerebrSkillRuntime.list()
};
`.trim();
}

export function buildSkillUnmountFromCurrentPageSource(skillName) {
  const normalizedSkillName = String(skillName || '').trim();
  if (!normalizedSkillName) {
    throw new Error('构造当前页卸载源码时 skillName 不能为空。');
  }

  return `
${buildRuntimeBootstrapSource()}
await __cerebrSkillRuntime.unmount(${encodeInlineJson(normalizedSkillName)});
return {
  mount_surface: ${encodeInlineJson(CEREBR_SKILL_MOUNT_SURFACE)},
  active_skills: __cerebrSkillRuntime.list()
};
`.trim();
}

export function buildRegisteredSkillUserScript(record) {
  const skill = normalizeStoredSkillRecord(record);
  if (!skill) {
    throw new Error('无法为无效的skill 构造动态 userScripts 注册项。');
  }
  if (skill.kind !== 'page_runtime') {
    throw new Error(`skill ${skill.name} 不是页面 runtime skill，不能注册 userScripts。`);
  }

  return {
    id: buildRegisteredSkillScriptId(skill.name),
    matches: [...skill.match],
    js: [{
      code: `
(async () => {
  ${buildSkillMountSource(skill)}
})();
`.trim()
    }],
    runAt: 'document_start',
    world: 'USER_SCRIPT',
    worldId: CEREBR_SKILL_WORLD_ID
  };
}
