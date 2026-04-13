/**
 * 统一管理浏览器 skill 脚手架模板。
 *
 * 这里承载三类“必须长期保持一致”的内容：
 * 1. `create_skill` 真正生成的新 skill 模板文件；
 * 2. 内置 `skill-creator` 展示给模型查看的模板示例；
 * 3. 创建完成后返回给模型的 `next_steps`。
 *
 * 当前目标不是继续强化 Cerebr 专用 page runtime 模板，
 * 而是尽量贴近官方 Codex `init_skill.py` 的通用 skill 骨架：
 * - 默认先生成通用 `SKILL.md`；
 * - `scripts/` / `references/` / `assets/` 只在需要时再添加；
 * - 是否演进成有 JS runtime 的页面 skill，交给后续 patch。
 */

export const SKILL_SCAFFOLD_ALLOWED_RESOURCES = Object.freeze(['scripts', 'references', 'assets']);
export const SKILL_SCAFFOLD_INSTRUCTION_PATH = 'SKILL.md';

function normalizeSingleLineText(value) {
  return (typeof value === 'string') ? value.replace(/\s+/g, ' ').trim() : '';
}

function toYamlQuotedString(value) {
  return JSON.stringify(normalizeSingleLineText(value));
}

function normalizeTemplatePathPrefix(value) {
  const normalized = (typeof value === 'string' ? value : '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  return normalized ? `${normalized}/` : '';
}

function joinScaffoldPath(prefix, relativePath) {
  return `${normalizeTemplatePathPrefix(prefix)}${String(relativePath || '').trim()}`;
}

export function normalizeSkillScaffoldName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export function titleCaseSkillName(skillName) {
  const normalized = normalizeSkillScaffoldName(skillName);
  if (!normalized) return 'New Skill';
  return normalized
    .split('-')
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

/**
 * 统一维护浏览器 runtime facade 约定。
 *
 * 虽然新通用 scaffold 默认不直接写入这段说明，
 * 但后续当某个 skill 真正加入 JS runtime 时，
 * 仍然需要一份稳定、统一、可复用的调用约定。
 */
export function buildDefaultMicroSkillMountContract() {
  return [
    'Recommended helpers: `globalThis.$skill(name)`, `globalThis.$invoke(skillName, methodName, ...args)`, `globalThis.$methods(name)`.',
    '`$skill(name)` returns mounted exports or `null`.',
    '`$methods(name)` returns the callable top-level method names exposed by the mounted exports.',
    '`$invoke(skillName, methodName, ...args)` calls a mounted top-level method with clearer parameter boundaries.',
    'Compatibility runtime registry: `globalThis.__cerebrMicroSkills`.',
    'Runtime source files run as async CommonJS-like bodies with `ctx`, `module`, `exports`, `require` available.',
    '`require()` is async in this runtime, so helper imports should use `await require("./helper.js")`.',
    'Entry file can `return { methods... }`, or assign `module.exports = { ... }`; advanced style: call `ctx.mount(exports)` manually.',
    'If a mounted exports object exposes `dispose()`, Cerebr may call it before unmount / remount.'
  ].join('\n');
}

function buildSkillScaffoldInstructionContent(options = {}) {
  const skillName = normalizeSingleLineText(options.skillName) || 'example-skill';
  const skillTitle = normalizeSingleLineText(options.displayName) || titleCaseSkillName(skillName);
  const description = normalizeSingleLineText(options.description)
    || '[TODO: Complete and informative explanation of what the skill does and when to use it. Include WHEN to use this skill - specific scenarios, file types, or tasks that trigger it.]';
  const shortDescription = normalizeSingleLineText(options.shortDescription) || description;

  return [
    '---',
    `name: ${toYamlQuotedString(skillName)}`,
    `description: ${toYamlQuotedString(description)}`,
    'metadata:',
    `  short-description: ${toYamlQuotedString(shortDescription)}`,
    '---',
    '',
    `# ${skillTitle}`,
    '',
    '## Overview',
    '',
    '[TODO: 1-2 sentences explaining what this skill enables]',
    '',
    '## Structuring This Skill',
    '',
    '[TODO: Choose the structure that best fits this skill\'s purpose. Common patterns:',
    '',
    '**1. Workflow-Based** (best for sequential processes)',
    '- Works well when there are clear step-by-step procedures.',
    '- Structure: `## Overview -> ## Workflow Decision Tree -> ## Step 1 -> ## Step 2...`',
    '',
    '**2. Task-Based** (best for tool collections)',
    '- Works well when the skill offers different operations or capabilities.',
    '- Structure: `## Overview -> ## Quick Start -> ## Task Category 1 -> ## Task Category 2...`',
    '',
    '**3. Reference / Guidelines** (best for standards or specifications)',
    '- Works well for policies, coding standards, or operating guidance.',
    '- Structure: `## Overview -> ## Guidelines -> ## Specifications -> ## Usage...`',
    '',
    '**4. Capabilities-Based** (best for integrated systems)',
    '- Works well when the skill provides multiple interrelated features.',
    '- Structure: `## Overview -> ## Core Capabilities -> ### 1. Feature -> ### 2. Feature...`',
    '',
    'Patterns can be mixed and matched as needed.',
    '',
    'Delete this entire "Structuring This Skill" section when done - it is only guidance.]',
    '',
    '## [TODO: Replace with the first main section based on chosen structure]',
    '',
    '[TODO: Add the first real section here. Prefer concrete examples, decision points, or references to specific files over abstract design notes.]',
    '',
    '## Resources (optional)',
    '',
    'Create only the resource directories this skill actually needs. Delete this section if no resources are required.',
    '',
    '### scripts/',
    'Executable code (Python, Bash, or other deterministic helpers) that can be run directly to perform specific operations.',
    '',
    '**Appropriate for:** scripts that do automation, data processing, generation, or deterministic transformations.',
    '',
    '### references/',
    'Documentation and reference material intended to be loaded into context to inform the model\'s process and decisions.',
    '',
    '**Appropriate for:** API references, site structure notes, schemas, workflow guides, and detailed background that should not live in the main `SKILL.md`.',
    '',
    '### assets/',
    'Files that are not intended to be loaded into context, but should instead be copied or reused in the final output.',
    '',
    '**Appropriate for:** templates, boilerplate code, images, fonts, icons, starter directories, or other output artifacts.',
    '',
    '---',
    '',
    '**Not every skill requires all three types of resources.**'
  ].join('\n');
}

function buildSkillScaffoldExampleScriptContent(options = {}) {
  const skillName = normalizeSingleLineText(options.skillName) || 'example-skill';
  return [
    '#!/usr/bin/env python3',
    '"""',
    `Example helper script for ${skillName}`,
    '',
    'This is a placeholder script that can be executed directly.',
    'Replace with actual implementation or delete it if not needed.',
    '"""',
    '',
    'def main():',
    `    print("This is an example script for ${skillName}")`,
    '    # TODO: Add actual script logic here.',
    '',
    'if __name__ == "__main__":',
    '    main()'
  ].join('\n');
}

function buildSkillScaffoldExampleReferenceContent(options = {}) {
  const skillTitle = normalizeSingleLineText(options.displayName) || 'Example Skill';
  return [
    `# Reference Documentation for ${skillTitle}`,
    '',
    'This is a placeholder for detailed reference documentation.',
    'Replace it with real reference content or delete it if not needed.',
    '',
    '## When Reference Docs Are Useful',
    '',
    'Reference docs are ideal for:',
    '- Comprehensive API documentation',
    '- Detailed workflow guides',
    '- Complex multi-step processes',
    '- Information too lengthy for main SKILL.md',
    '- Content that is only needed for specific use cases',
    '',
    '## Structure Suggestions',
    '',
    '### API Reference Example',
    '- Overview',
    '- Authentication',
    '- Endpoints with examples',
    '- Error codes',
    '- Rate limits',
    '',
    '### Workflow Guide Example',
    '- Prerequisites',
    '- Step-by-step instructions',
    '- Common patterns',
    '- Troubleshooting',
    '- Best practices'
  ].join('\n');
}

function buildSkillScaffoldExampleAssetContent() {
  return [
    '# Example Asset File',
    '',
    'This placeholder represents where asset files would be stored.',
    'Replace it with actual asset files or delete it if not needed.',
    '',
    'Asset files are not intended to be loaded into context, but rather used within the final output.',
    '',
    'Common examples:',
    '- Templates',
    '- Images',
    '- Fonts',
    '- Boilerplate code',
    '- Icons'
  ].join('\n');
}

export function buildSkillScaffoldFiles(options = {}) {
  const prefix = normalizeTemplatePathPrefix(options.pathPrefix);
  const skillName = normalizeSingleLineText(options.skillName) || 'example-skill';
  const displayName = normalizeSingleLineText(options.displayName) || titleCaseSkillName(skillName);
  const description = normalizeSingleLineText(options.description)
    || '[TODO: Complete and informative explanation of what the skill does and when to use it. Include WHEN to use this skill - specific scenarios, file types, or tasks that trigger it.]';
  const shortDescription = normalizeSingleLineText(options.shortDescription) || description;
  const resources = Array.isArray(options.resources) ? options.resources : [];
  const examples = options.examples === true;
  const withPrefix = (relativePath) => joinScaffoldPath(prefix, relativePath);

  const files = [{
    path: withPrefix(SKILL_SCAFFOLD_INSTRUCTION_PATH),
    content: buildSkillScaffoldInstructionContent({
      skillName,
      displayName,
      description,
      shortDescription
    })
  }];

  if (examples === true) {
    if (resources.includes('scripts')) {
      files.push({
        path: withPrefix('scripts/example.py'),
        kind: prefix ? 'template' : 'reference',
        content: buildSkillScaffoldExampleScriptContent({ skillName })
      });
    }
    if (resources.includes('references')) {
      files.push({
        path: withPrefix('references/api_reference.md'),
        kind: prefix ? 'template' : 'reference',
        content: buildSkillScaffoldExampleReferenceContent({ displayName })
      });
    }
    if (resources.includes('assets')) {
      files.push({
        path: withPrefix('assets/example_asset.txt'),
        kind: prefix ? 'template' : 'reference',
        content: buildSkillScaffoldExampleAssetContent()
      });
    }
  }

  return files;
}

export function buildSkillScaffoldInput(options = {}) {
  const skillName = normalizeSingleLineText(options.skillName) || 'example-skill';
  const description = normalizeSingleLineText(options.description)
    || '[TODO: Complete and informative explanation of what the skill does and when to use it. Include WHEN to use this skill - specific scenarios, file types, or tasks that trigger it.]';
  const displayName = normalizeSingleLineText(options.displayName) || titleCaseSkillName(skillName);
  const shortDescription = normalizeSingleLineText(options.shortDescription) || description;
  const defaultPrompt = normalizeSingleLineText(options.defaultPrompt) || null;
  const resources = Array.isArray(options.resources) ? options.resources : [];
  const examples = options.examples === true;

  return {
    name: skillName,
    description,
    interface: {
      display_name: displayName,
      short_description: shortDescription,
      default_prompt: defaultPrompt
    },
    match: Array.isArray(options.match) ? options.match : [],
    enabled: options.enabled === true,
    instruction: {
      path: SKILL_SCAFFOLD_INSTRUCTION_PATH
    },
    runtime: {
      entry_path: null
    },
    files: buildSkillScaffoldFiles({
      skillName,
      displayName,
      description,
      shortDescription,
      resources,
      examples
    })
  };
}

export function buildSkillScaffoldNextSteps(options = {}) {
  const resources = Array.isArray(options.resources) ? options.resources : [];
  const enabled = options.enabled === true;
  const examples = options.examples === true;
  const resourceText = resources.length > 0 ? resources.map((value) => `${value}/`).join(', ') : 'scripts/, references/, assets/';

  return [
    'Edit SKILL.md and replace the placeholder sections with real trigger rules, workflow, and concrete examples.',
    examples
      ? `Replace or delete the placeholder files created under ${resourceText}.`
      : `Add concrete files under ${resourceText} only when the skill actually needs them.`,
    'If this skill later needs browser runtime code, patch manifest.json to add match and runtime.entry_path, then add the corresponding JS files with apply_patch.',
    'Keep references and scripts on-demand; do not turn the scaffold into a large package before the real workflow is clear.',
    enabled
      ? 'If you intentionally enabled the skill already, verify the summary and files first; only call mount_on_current_page after the skill truly becomes a page runtime skill.'
      : 'When the skill is ready, call enable_skill; only call mount_on_current_page after the skill truly becomes a page runtime skill.'
  ];
}
