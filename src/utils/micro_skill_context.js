/**
 * 隐藏的 micro_skill_context。
 *
 * 设计目标：
 * - 尽量贴近官方 Codex skills section，只注入轻量 skill 摘要；
 * - 每轮只统一注入一次 how-to-use，而不是给每个 skill 都重复一遍调用说明；
 * - 具体细节仍然由模型按需去读目标 skill 的 `SKILL.md` 与相关文件。
 */

function escapeXmlText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildMicroSkillContextHowToUseText() {
  return [
    'Skills are local instructions stored in `SKILL.md`.',
    'When a listed skill looks relevant, read that skill\'s `SKILL.md` before using it.',
    'Only continue to read `references/`, `scripts/`, or other files when the main instruction points you there or the task truly needs more detail.'
  ].join('\n');
}

function normalizeMicroSkillContextSkills(skills) {
  return (Array.isArray(skills) ? skills : [])
    .map((skill, index) => {
      if (!skill || typeof skill !== 'object' || Array.isArray(skill)) return null;
      const name = typeof skill.name === 'string' ? skill.name.trim() : '';
      const shortDescription = typeof skill.short_description === 'string' ? skill.short_description.trim() : '';
      const instructionPath = typeof skill.instruction_path === 'string' ? skill.instruction_path.trim() : '';
      const priority = Number.isFinite(Number(skill.priority)) ? Number(skill.priority) : 1000;
      if (!name || !shortDescription || !instructionPath) return null;
      return {
        _index: index,
        priority,
        name,
        short_description: shortDescription,
        instruction_path: instructionPath
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
    how_to_use: buildMicroSkillContextHowToUseText(),
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
  const howToUse = typeof payload.how_to_use === 'string' ? payload.how_to_use.trim() : '';
  const lines = ['<micro_skill_context>'];
  if (payload.url) {
    lines.push(`  <url>${escapeXmlText(payload.url)}</url>`);
  }
  if (howToUse) {
    lines.push('  <how_to_use>');
    for (const line of howToUse.split('\n')) {
      lines.push(`    ${escapeXmlText(line)}`);
    }
    lines.push('  </how_to_use>');
  }
  lines.push('  <skills>');
  skills.forEach((skill) => {
    lines.push(`    <skill name="${escapeXmlText(skill.name)}">`);
    lines.push(`      <short_description>${escapeXmlText(skill.short_description)}</short_description>`);
    lines.push(`      <instruction_path>${escapeXmlText(skill.instruction_path)}</instruction_path>`);
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
