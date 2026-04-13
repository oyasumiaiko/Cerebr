/**
 * 统一管理浏览器 skill 脚手架模板。
 *
 * 这里承载三类“必须长期保持一致”的内容：
 * 1. `create_skill` 真正生成的新 skill 模板文件；
 * 2. 内置 `skill-creator` 展示给模型查看的模板示例；
 * 3. 创建完成后返回给模型的 `next_steps`。
 *
 * 这样后续只需要维护这一份模板源，就不会出现：
 * - skill-creator 教模型看的是一套模板；
 * - create_skill 实际创建出来的是另一套模板；
 * - tool output 里提示的下一步又是第三套说法。
 */

export const SKILL_SCAFFOLD_ALLOWED_RESOURCES = Object.freeze(['scripts', 'references', 'assets']);
export const SKILL_SCAFFOLD_INSTRUCTION_PATH = 'SKILL.md';
export const SKILL_SCAFFOLD_RUNTIME_ENTRY_PATH = 'src/main.js';
export const SKILL_SCAFFOLD_DOM_HELPER_PATH = 'src/helpers/dom.js';

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

function formatMatchPatterns(match) {
  const patterns = Array.isArray(match) ? match : [];
  if (patterns.length <= 0) {
    return '- `TODO: add match patterns`';
  }
  return patterns.map((pattern) => `- \`${String(pattern || '').trim()}\``).join('\n');
}

function buildResourceHintLine(resources) {
  const selected = Array.isArray(resources) ? resources : [];
  if (selected.length <= 0) {
    return '- Resource directories: add concrete files under `scripts/`, `references/`, or `assets/` only when needed.';
  }
  return `- Selected resource directories: ${selected.map((value) => `\`${value}/\``).join(', ')}.`;
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
 * 统一的浏览器 runtime 调用约定说明。
 *
 * 这份文案会同时被：
 * - 自动注入给模型的 skill summary；
 * - 新建 skill 的 `SKILL.md` 模板；
 * - 内置 `skill-creator` 展示的模板示例；
 *
 * 所以这里保持“短而准”，只写模型真正需要知道的调用面与 runtime 约束。
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
  const displayName = normalizeSingleLineText(options.displayName) || titleCaseSkillName(skillName);
  const description = normalizeSingleLineText(options.description) || 'Describe when this skill should be used.';
  const shortDescription = normalizeSingleLineText(options.shortDescription) || description;
  const defaultPrompt = normalizeSingleLineText(options.defaultPrompt);
  const matchPatterns = formatMatchPatterns(options.match);
  const resources = Array.isArray(options.resources) ? options.resources : [];
  const mountContract = buildDefaultMicroSkillMountContract()
    .split('\n')
    .map((line) => `- ${line}`)
    .join('\n');

  return [
    '---',
    `name: ${toYamlQuotedString(skillName)}`,
    `description: ${toYamlQuotedString(description)}`,
    'metadata:',
    `  short-description: ${toYamlQuotedString(shortDescription)}`,
    '---',
    '',
    `# ${displayName}`,
    '',
    '## Overview',
    'This scaffold was generated automatically by `skill_registry(action="create_skill")`.',
    'Replace the TODO sections below with instructions that another model can actually execute, not design notes.',
    `Current trigger description: ${description}`,
    '',
    '## Scope',
    'Current `match` patterns:',
    matchPatterns,
    buildResourceHintLine(resources),
    '',
    '## Inputs',
    '- `args`: TODO. Document the exposed methods, argument shapes, required inputs, optional inputs, and defaults.',
    '- Page prerequisites: TODO. Describe required URL patterns, login state, visible regions, or data preparation steps.',
    defaultPrompt
      ? `- Suggested default prompt: \`${defaultPrompt}\``
      : '- Suggested default prompt: TODO. Describe the most typical invocation in one natural-language sentence.',
    '',
    '## Quick start',
    '```js',
    `await $methods("${skillName}");`,
    `await $invoke("${skillName}", "readSummary");`,
    '```',
    '',
    '## Usage examples',
    '```js',
    `await $invoke("${skillName}", "readSummary");`,
    `await $skill("${skillName}");`,
    '```',
    '',
    '## Workflow',
    '1. Confirm that the current URL and page state satisfy `match` and all prerequisites.',
    '2. If extra site notes or structure explanations are needed, move non-runtime content into `references/` and explain when to read it here.',
    '3. Keep the runtime entry thin and orchestration-focused; move brittle DOM-reading logic into `src/helpers/` first.',
    '4. Put real side-effectful actions such as clicks or submits into dedicated helpers or `src/actions/` only when needed.',
    '',
    '## Runtime Contract',
    mountContract,
    '',
    '## Editing Checklist',
    '- Rename `readSummary()` to method names that better match the actual task.',
    '- Check whether `description`, `short-description`, and `default_prompt` really help with triggering and usage.',
    '- If additional resources are needed, add concrete files with top-level `apply_patch` instead of relying on empty-directory intent.'
  ].join('\n');
}

function buildSkillScaffoldRuntimeEntryContent() {
  return [
    '// Keep the entry file thin: orchestrate helpers and export the final methods.',
    '// Convention: use async require() for helpers instead of inlining everything into one file.',
    '',
    'const dom = await require("./helpers/dom.js");',
    '',
    'return {',
    '  readSummary() {',
    '    return {',
    '      title: dom.readTitle(),',
    '      href: location.href',
    '    };',
    '  }',
    '};'
  ].join('\n');
}

function buildSkillScaffoldDomHelperContent() {
  return [
    '// Helper files should isolate brittle DOM selectors and reusable read logic.',
    '// When the page structure changes, you can patch this file instead of rewriting the whole skill.',
    '',
    'module.exports = {',
    '  readTitle() {',
    '    return document.title;',
    '  }',
    '};'
  ].join('\n');
}

function buildSkillScaffoldExampleScriptContent() {
  return [
    '// Example scripts/ file generated by create_skill.',
    '// Use scripts/ for deterministic helpers, generators, or reusable draft code.',
    '// It is not mounted into the page runtime automatically; the real runtime entry stays in src/main.js.',
    '',
    'module.exports = {',
    '  describeExampleInput() {',
    '    return {',
    '      note: "Replace this placeholder with a deterministic helper script if you really need one."',
    '    };',
    '  }',
    '};'
  ].join('\n');
}

function buildSkillScaffoldExampleReferenceContent(options = {}) {
  const displayName = normalizeSingleLineText(options.displayName) || 'Example Skill';
  return [
    `# ${displayName} Reference`,
    '',
    'This is an example references/ file generated by create_skill.',
    '',
    '## What to put here',
    '- Site structure, API fields, business terminology, or known pitfalls.',
    '- Put content here only when it does not belong in the main `SKILL.md` and should be read on demand.',
    '',
    '## TODO',
    '- Replace this placeholder with real page structure notes or concise external documentation summaries.'
  ].join('\n');
}

function buildSkillScaffoldExampleAssetContent() {
  return [
    'This is a placeholder asset created by create_skill.',
    'Replace or delete it when the skill gets real assets.'
  ].join('\n');
}

export function buildSkillScaffoldFiles(options = {}) {
  const prefix = normalizeTemplatePathPrefix(options.pathPrefix);
  const skillName = normalizeSingleLineText(options.skillName) || 'example-skill';
  const displayName = normalizeSingleLineText(options.displayName) || titleCaseSkillName(skillName);
  const description = normalizeSingleLineText(options.description) || 'Describe when this skill should be used.';
  const shortDescription = normalizeSingleLineText(options.shortDescription) || description;
  const defaultPrompt = normalizeSingleLineText(options.defaultPrompt) || null;
  const resources = Array.isArray(options.resources) ? options.resources : [];
  const examples = options.examples === true;
  const withPrefix = (relativePath) => joinScaffoldPath(prefix, relativePath);

  const files = [
    {
      path: withPrefix(SKILL_SCAFFOLD_INSTRUCTION_PATH),
      content: buildSkillScaffoldInstructionContent({
        skillName,
        displayName,
        description,
        shortDescription,
        defaultPrompt,
        match: options.match,
        resources
      })
    },
    {
      path: withPrefix(SKILL_SCAFFOLD_RUNTIME_ENTRY_PATH),
      content: buildSkillScaffoldRuntimeEntryContent()
    },
    {
      path: withPrefix(SKILL_SCAFFOLD_DOM_HELPER_PATH),
      content: buildSkillScaffoldDomHelperContent()
    }
  ];

  if (examples === true) {
    if (resources.includes('scripts')) {
      files.push({
        path: withPrefix('scripts/example.js'),
        kind: prefix ? 'template' : 'reference',
        content: buildSkillScaffoldExampleScriptContent()
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
  const description = normalizeSingleLineText(options.description) || 'Describe when this skill should be used.';
  const displayName = normalizeSingleLineText(options.displayName) || titleCaseSkillName(skillName);
  const shortDescription = normalizeSingleLineText(options.shortDescription) || description;
  const defaultPrompt = normalizeSingleLineText(options.defaultPrompt) || null;
  const match = Array.isArray(options.match) ? options.match : [];
  const resources = Array.isArray(options.resources) ? options.resources : [];
  const examples = options.examples === true;

  return {
    kind: 'page_runtime',
    name: skillName,
    description,
    interface: {
      display_name: displayName,
      short_description: shortDescription,
      default_prompt: defaultPrompt
    },
    match,
    enabled: options.enabled === true,
    instruction: {
      path: SKILL_SCAFFOLD_INSTRUCTION_PATH
    },
    runtime: {
      entry_path: SKILL_SCAFFOLD_RUNTIME_ENTRY_PATH
    },
    files: buildSkillScaffoldFiles({
      skillName,
      displayName,
      description,
      shortDescription,
      defaultPrompt,
      match,
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
    'Edit SKILL.md to replace the TODO sections with real trigger rules, inputs, examples, and workflow.',
    examples
      ? `Replace or delete the placeholder files created under ${resourceText}.`
      : `Add concrete files under ${resourceText} only when the skill actually needs them.`,
    'Patch src/main.js and src/helpers/dom.js so the exported methods match the real task.',
    'Patch manifest.json if display_name, short_description, default_prompt, match, or enabled state should change.',
    enabled
      ? 'If immediate verification is needed on the active tab, call mount_on_current_page explicitly.'
      : 'When the scaffold is ready, call enable_skill and then mount_on_current_page only if immediate verification is needed.'
  ];
}
