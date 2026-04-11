import {
  CEREBR_MICRO_SKILL_MOUNT_SURFACE,
  buildMicroSkillContextSummary,
  normalizeStoredMicroSkillRecord
} from '../agent_tools/micro_skill_registry_tool.js';

export const CEREBR_MICRO_SKILL_WORLD_ID = 'cerebr-micro-skills';
export const CEREBR_MICRO_SKILL_SCRIPT_ID_PREFIX = 'cerebr-micro-skill--';

function encodeInlineJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
}

export function buildRegisteredMicroSkillScriptId(skillName) {
  return `${CEREBR_MICRO_SKILL_SCRIPT_ID_PREFIX}${encodeURIComponent(String(skillName || ''))}`;
}

function buildRuntimeBootstrapSource() {
  return `
const __cerebrEnsureMicroSkillRuntime = () => {
  const existing = globalThis.__cerebrMicroSkills;
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
        throw new Error('Micro skill mount requires a non-empty name.');
      }
      this.skills[key] = exports && typeof exports === 'object' ? exports : { default: exports };
      this.skillMeta[key] = meta && typeof meta === 'object' ? meta : {};
      return this.skills[key];
    },
    async invoke(path, ...args) {
      const rawPath = String(path || '');
      const firstDot = rawPath.indexOf('.');
      if (firstDot <= 0 || firstDot >= rawPath.length - 1) {
        throw new Error(\`Invalid micro skill path: \${rawPath}\`);
      }
      const skillName = rawPath.slice(0, firstDot);
      const methodName = rawPath.slice(firstDot + 1);
      const skill = this.skills[skillName];
      if (!skill) {
        throw new Error(\`Micro skill not mounted: \${skillName}\`);
      }
      const method = skill[methodName];
      if (typeof method !== 'function') {
        throw new Error(\`Mounted micro skill method not found: \${rawPath}\`);
      }
      return await method(...args);
    }
  };

  globalThis.__cerebrMicroSkills = runtime;
  return runtime;
};
const __cerebrMicroSkillRuntime = __cerebrEnsureMicroSkillRuntime();
`.trim();
}

export function buildMicroSkillMountSource(record, options = {}) {
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) {
    throw new Error('无法为无效的微型 skill 构造挂载源码。');
  }

  const metaJson = encodeInlineJson({
    name: skill.name,
    revision: skill.revision,
    summary: buildMicroSkillContextSummary(skill)
  });
  const userCode = skill.source.code || '';
  const includeBootstrap = options?.includeBootstrap !== false;

  return `
await (async () => {
  ${includeBootstrap ? buildRuntimeBootstrapSource() : ''}
  const __skillMeta = ${metaJson};
  const __existingMeta = __cerebrMicroSkillRuntime.skillMeta[__skillMeta.name];
  if (__existingMeta && Number(__existingMeta.revision) === Number(__skillMeta.revision)) {
    return;
  }

  if (__cerebrMicroSkillRuntime.has(__skillMeta.name)) {
    await __cerebrMicroSkillRuntime.unmount(__skillMeta.name);
  }

  let __mountedExplicitly = false;
  const __ctx = {
    name: __skillMeta.name,
    summary: __skillMeta.summary,
    runtime: __cerebrMicroSkillRuntime,
    skills: __cerebrMicroSkillRuntime.skills,
    list: () => __cerebrMicroSkillRuntime.list(),
    has: (name) => __cerebrMicroSkillRuntime.has(name),
    invoke: (path, ...args) => __cerebrMicroSkillRuntime.invoke(path, ...args),
    mount: (exports) => {
      __mountedExplicitly = true;
      return __cerebrMicroSkillRuntime.mount(__skillMeta.name, exports, __skillMeta);
    }
  };

  const __returned = await (async (ctx) => {
${userCode}
  })(__ctx);

  if (!__mountedExplicitly) {
    __cerebrMicroSkillRuntime.mount(__skillMeta.name, __returned ?? {}, __skillMeta);
  }
})();
`.trim();
}

export function buildMicroSkillDocumentRefreshSource(records) {
  const skills = Array.isArray(records)
    ? records.map((record) => normalizeStoredMicroSkillRecord(record)).filter(Boolean)
    : [];
  const desiredNamesJson = encodeInlineJson(skills.map((skill) => skill.name));
  const mountBlocks = skills
    .map((skill) => buildMicroSkillMountSource(skill, { includeBootstrap: false }))
    .join('\n');

  return `
${buildRuntimeBootstrapSource()}
const __desiredMicroSkillNames = new Set(${desiredNamesJson});
for (const __name of Object.keys(__cerebrMicroSkillRuntime.skills)) {
  const __meta = __cerebrMicroSkillRuntime.skillMeta[__name];
  if (!__meta || !__desiredMicroSkillNames.has(__name)) {
    await __cerebrMicroSkillRuntime.unmount(__name);
  }
}
${mountBlocks}
return {
  mount_surface: ${encodeInlineJson(CEREBR_MICRO_SKILL_MOUNT_SURFACE)},
  active_skills: __cerebrMicroSkillRuntime.list()
};
`.trim();
}

export function buildRegisteredMicroSkillUserScript(record) {
  const skill = normalizeStoredMicroSkillRecord(record);
  if (!skill) {
    throw new Error('无法为无效的微型 skill 构造动态 userScripts 注册项。');
  }

  return {
    id: buildRegisteredMicroSkillScriptId(skill.name),
    matches: [...skill.match],
    js: [{
      code: `
(async () => {
  ${buildMicroSkillMountSource(skill)}
})();
`.trim()
    }],
    runAt: 'document_start',
    world: 'USER_SCRIPT',
    worldId: CEREBR_MICRO_SKILL_WORLD_ID
  };
}
