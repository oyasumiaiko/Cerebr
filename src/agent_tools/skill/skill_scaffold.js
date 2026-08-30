/**
 * 统一管理浏览器 skill 脚手架模板。
 *
 * 这里承载两类“必须长期保持一致”的内容：
 * 1. `create_skill` 真正生成的新 skill 模板文件；
 * 2. 内置 `skill-creator` 展示给模型查看的模板示例；
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
export function buildDefaultSkillMountContract() {
  return [
    'These helpers are only available inside `js_runtime_execute`; that tool runs your `code` as an async function body, so you can write `await` and `return` directly.',
    'Recommended helpers: `globalThis.$skill(name)`, `globalThis.$invoke(skillName, methodName, ...args)`, `globalThis.$methods(name)`.',
    '`$skill(name)` returns mounted exports or `null`.',
    '`$methods(name)` returns the callable top-level method names exposed by the mounted exports.',
    '`$invoke(skillName, methodName, ...args)` calls a top-level method; if an enabled matching page runtime skill is not mounted yet, Cerebr mounts it automatically and continues the same call.',
    'Typical call shape inside `js_runtime_execute`: `return await $invoke("skill-name", "methodName", args);`',
    '`mount_on_current_page` is not a prerequisite for `$invoke`; reserve it for explicit remounting or diagnostics.',
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

  return [
    '---',
    `name: ${toYamlQuotedString(skillName)}`,
    `description: ${toYamlQuotedString(description)}`,
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
    '- Example: a document skill with `Workflow Decision Tree` -> `Reading` -> `Creating` -> `Editing`.',
    '- Structure: `## Overview -> ## Workflow Decision Tree -> ## Step 1 -> ## Step 2...`',
    '',
    '**2. Task-Based** (best for tool collections)',
    '- Works well when the skill offers different operations or capabilities.',
    '- Example: a PDF skill with `Quick Start` -> `Merge PDFs` -> `Split PDFs` -> `Extract Text`.',
    '- Structure: `## Overview -> ## Quick Start -> ## Task Category 1 -> ## Task Category 2...`',
    '',
    '**3. Reference / Guidelines** (best for standards or specifications)',
    '- Works well for policies, coding standards, or operating guidance.',
    '- Example: brand rules with `Colors` -> `Typography` -> `Components`.',
    '- Structure: `## Overview -> ## Guidelines -> ## Specifications -> ## Usage...`',
    '',
    '**4. Capabilities-Based** (best for integrated systems)',
    '- Works well when the skill provides multiple interrelated features.',
    '- Example: product management with a numbered list of connected capabilities.',
    '- Structure: `## Overview -> ## Core Capabilities -> ### 1. Feature -> ### 2. Feature...`',
    '',
    'Patterns can be mixed and matched as needed. Most skills combine a primary structure with smaller workflows for complex operations.',
    '',
    'Delete this entire "Structuring This Skill" section when done - it is only guidance.]',
    '',
    '## [TODO: Replace with the first main section based on chosen structure]',
    '',
    '[TODO: Add real content here: code samples for technical skills, decision trees for fragile workflows, realistic user requests, and direct links to scripts/templates/references as needed.]',
    '',
    '## Resources (optional)',
    '',
    'Create only the resource directories this skill actually needs. Delete this section if no resources are required.',
    '',
    '### scripts/',
    'Browser-side JavaScript snippets or deterministic helper code that should be copied or adapted into `js_runtime_execute` or future runtime files.',
    '',
    '**Appropriate for:** reusable JS snippets, selector probes, parser drafts, or logic you expect to paste into `js_runtime_execute.code` or later promote into `runtime.entry_path` / helper files.',
    '',
    '**Important:** these files are not executed automatically by the extension. Test representative JavaScript by reading it and running the adapted code through `js_runtime_execute`, whose `code` field is an async function body.',
    '',
    '### references/',
    'Documentation and reference material intended to be loaded into context to inform the model\'s process and decisions.',
    '',
    '**Appropriate for:** API references, site structure notes, schemas, workflow guides, and detailed background that should not live in the main `SKILL.md`. Keep references one level below SKILL.md; add a table of contents to files longer than 100 lines.',
    '',
    '### assets/',
    'Files that are not intended to be loaded into context, but should instead be copied or reused in the final output.',
    '',
    '**Appropriate for:** text templates, boilerplate code, starter files, or existing output artifacts. Do not use text patches to fabricate binary images, fonts, or archives.',
    '',
    '---',
    '',
    '**Not every skill requires all three types of resources. Keep SKILL.md under 500 lines, avoid duplicating reference content, and do not add README.md, QUICK_REFERENCE.md, or CHANGELOG.md.**'
  ].join('\n');
}

function buildSkillScaffoldExampleScriptContent(options = {}) {
  const skillName = normalizeSingleLineText(options.skillName) || 'example-skill';
  return [
    `// Example browser-side JS snippet for ${skillName}`,
    '// This file is source material, not something the extension executes automatically.',
    '// If you want to try it, copy or adapt it into `js_runtime_execute`.',
    '// That tool runs `code` as an async function body, so top-level await/return work directly.',
    '',
    'return {',
    '  title: document.title,',
    '  href: location.href',
    '};'
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
    'This placeholder represents text-based output material that should be copied or adapted, not loaded as instructions.',
    'Replace it with a real text template or delete it if not needed.',
    '',
    'Cerebr virtual skill files are edited as text. Do not use apply_patch to fabricate binary images, fonts, archives, or document files.',
    '',
    'Common examples:',
    '- Markdown or HTML templates',
    '- CSS or JavaScript boilerplate',
    '- JSON or YAML starter files',
    '- Text snippets intended for final output'
  ].join('\n');
}

export function buildSkillScaffoldFiles(options = {}) {
  const prefix = normalizeTemplatePathPrefix(options.pathPrefix);
  const skillName = normalizeSingleLineText(options.skillName) || 'example-skill';
  const displayName = normalizeSingleLineText(options.displayName) || titleCaseSkillName(skillName);
  const description = normalizeSingleLineText(options.description)
    || '[TODO: Complete and informative explanation of what the skill does and when to use it. Include WHEN to use this skill - specific scenarios, file types, or tasks that trigger it.]';
  const resources = Array.isArray(options.resources) ? options.resources : [];
  const examples = options.examples === true;
  const withPrefix = (relativePath) => joinScaffoldPath(prefix, relativePath);

  const files = [{
    path: withPrefix(SKILL_SCAFFOLD_INSTRUCTION_PATH),
    content: buildSkillScaffoldInstructionContent({
      skillName,
      displayName,
      description
    })
  }];

    if (examples === true) {
      if (resources.includes('scripts')) {
        files.push({
        path: withPrefix('scripts/example.js'),
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
