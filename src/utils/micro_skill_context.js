/**
 * 隐藏的 micro_skill_context。
 *
 * 设计目标：
 * - 只向模型暴露“当前 URL 下有哪些微型 skill 可用”的轻量摘要；
 * - 不默认暴露完整 `SKILL.md`、references 或 runtime 源码；
 * - 使用与 page/environment context 一致的签名去重策略，避免每轮重复注入同样摘要。
 */

function escapeXmlText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeMicroSkillContextSkills(skills) {
  return (Array.isArray(skills) ? skills : [])
    .map((skill, index) => {
      if (!skill || typeof skill !== 'object' || Array.isArray(skill)) return null;
      const name = typeof skill.name === 'string' ? skill.name.trim() : '';
      const displayName = typeof skill.display_name === 'string' ? skill.display_name.trim() : '';
      const shortDescription = typeof skill.short_description === 'string' ? skill.short_description.trim() : '';
      const defaultPrompt = typeof skill.default_prompt === 'string' ? skill.default_prompt.trim() : '';
      const mountSurface = typeof skill.mount_surface === 'string' ? skill.mount_surface.trim() : '';
      const kind = typeof skill.kind === 'string' ? skill.kind.trim() : '';
      const priority = Number.isFinite(Number(skill.priority)) ? Number(skill.priority) : 1000;
      if (!name || !shortDescription || !mountSurface) return null;
      return {
        _index: index,
        priority,
        kind: kind || 'page_runtime',
        name,
        display_name: displayName || name,
        short_description: shortDescription,
        default_prompt: defaultPrompt,
        mount_surface: mountSurface
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority;
      if (left._index !== right._index) return left._index - right._index;
      return left.name.localeCompare(right.name);
    })
    .map((skill) => {
      const { _index, ...rest } = skill;
      return rest;
    });
}

export function buildMicroSkillContextPayload(options = {}) {
  const mode = options?.mode === 'host_page' ? 'host_page' : 'isolated_sandbox';
  const url = (typeof options?.url === 'string') ? options.url.trim() : '';
  return {
    type: 'micro_skill_context',
    mode,
    url,
    skills: normalizeMicroSkillContextSkills(options?.skills)
  };
}

export function buildMicroSkillContextSignature(payload) {
  if (!payload || typeof payload !== 'object') return '';
  try {
    return JSON.stringify(payload);
  } catch (_) {
    return '';
  }
}

export function buildMicroSkillContextInputItems(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const skills = normalizeMicroSkillContextSkills(payload.skills);
  const lines = [
    `<micro_skill_context mode="${escapeXmlText(payload.mode || 'isolated_sandbox')}">`
  ];
  if (payload.url) {
    lines.push(`  <url>${escapeXmlText(payload.url)}</url>`);
  }
  lines.push('  <skills>');
  skills.forEach((skill) => {
    lines.push(`    <skill name="${escapeXmlText(skill.name)}">`);
    lines.push(`      <kind>${escapeXmlText(skill.kind || 'page_runtime')}</kind>`);
    lines.push(`      <display_name>${escapeXmlText(skill.display_name)}</display_name>`);
    lines.push(`      <short_description>${escapeXmlText(skill.short_description)}</short_description>`);
    if (skill.default_prompt) {
      lines.push(`      <default_prompt>${escapeXmlText(skill.default_prompt)}</default_prompt>`);
    }
    lines.push(`      <mount_surface>${escapeXmlText(skill.mount_surface)}</mount_surface>`);
    lines.push('    </skill>');
  });
  lines.push('  </skills>');
  lines.push('</micro_skill_context>');

  return [{
    type: 'message',
    role: 'user',
    content: [{
      type: 'input_text',
      text: lines.join('\n')
    }]
  }];
}

export function resolveMicroSkillContextAttachment(options = {}) {
  const payload = (options?.payload && typeof options.payload === 'object') ? options.payload : null;
  const previousEffectiveSignature = (typeof options?.previousEffectiveSignature === 'string')
    ? options.previousEffectiveSignature
    : '';
  const signature = buildMicroSkillContextSignature(payload);
  const inputItems = buildMicroSkillContextInputItems(payload);

  if (!signature || inputItems.length <= 0) {
    return {
      signature: null,
      inputItems: null
    };
  }

  const currentSkills = Array.isArray(payload?.skills) ? payload.skills : [];
  if (currentSkills.length <= 0 && !previousEffectiveSignature) {
    return {
      signature: null,
      inputItems: null
    };
  }

  if (previousEffectiveSignature && previousEffectiveSignature === signature) {
    return {
      signature: null,
      inputItems: null
    };
  }

  return {
    signature,
    inputItems
  };
}
