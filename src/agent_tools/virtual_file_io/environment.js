import {
  assertCanonicalSkillName
} from '../skill/registry_tool.js';
import {
  VIRTUAL_FILE_ENVIRONMENT_KIND_ROOT,
  VIRTUAL_FILE_ENVIRONMENT_KIND_SKILL
} from './shared.js';

/**
 * 解析模型可见的虚拟文件环境选择器。
 *
 * `null` 始终表示当前对话文件根；Skill 必须使用完整且已经规范化的
 * `skill:<stable-key>`。选择器只负责选根，文件路径仍始终是根相对路径。
 */
export function normalizeVirtualFileEnvironmentId(value) {
  if (value == null) {
    return {
      kind: VIRTUAL_FILE_ENVIRONMENT_KIND_ROOT,
      environment_id: null,
      skill_name: null
    };
  }
  if (typeof value !== 'string') {
    throw new Error('virtual_file 参数错误：environment_id 必须是字符串或 null。');
  }
  const environmentId = value.trim();
  if (value !== environmentId) {
    throw new Error('virtual_file 参数错误：environment_id 不能包含首尾空白。');
  }
  if (!environmentId.startsWith('skill:')) {
    throw new Error('virtual_file 参数错误：environment_id 只支持 `skill:<stable-key>` 或 null。');
  }
  const skillName = assertCanonicalSkillName(environmentId.slice('skill:'.length), {
    label: 'environment_id'
  });
  const canonicalEnvironmentId = `skill:${skillName}`;
  if (environmentId !== canonicalEnvironmentId) {
    throw new Error(`virtual_file 参数错误：environment_id 必须精确写为 \`${canonicalEnvironmentId}\`。`);
  }
  return {
    kind: VIRTUAL_FILE_ENVIRONMENT_KIND_SKILL,
    environment_id: canonicalEnvironmentId,
    skill_name: skillName
  };
}

export function buildVirtualFileEnvironmentIdSchema() {
  return {
    type: ['string', 'null'],
    description: '目标文件根。null 表示当前对话文件；Skill 使用精确的 `skill:<stable-key>`。'
  };
}

export function summarizeVirtualFileEnvironment(environment) {
  if (environment?.kind === VIRTUAL_FILE_ENVIRONMENT_KIND_SKILL) {
    return {
      kind: VIRTUAL_FILE_ENVIRONMENT_KIND_SKILL,
      environment_id: environment.environment_id,
      skill_name: environment.skill_name
    };
  }
  return {
    kind: VIRTUAL_FILE_ENVIRONMENT_KIND_ROOT,
    environment_id: null,
    skill_name: null
  };
}
