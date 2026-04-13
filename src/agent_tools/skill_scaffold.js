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
    return '- 资源目录：按需后续新增 `scripts/`、`references/`、`assets/` 文件。';
  }
  return `- 当前预留资源：${selected.map((value) => `\`${value}/\``).join('、')}。`;
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
    '这个模板由 `skill_registry(action="create_skill")` 自动生成。',
    '先把下面各节里的 TODO 改成“另一个模型未来真的能照做”的操作说明，而不是设计笔记。',
    `当前触发描述：${description}`,
    '',
    '## Scope',
    '当前 `match`：',
    matchPatterns,
    buildResourceHintLine(resources),
    '',
    '## Inputs',
    '- `args`：TODO. 明确这个 skill 暴露的方法、参数形状、必填/可选项和默认值。',
    '- 页面前置条件：TODO. 说明依赖的 URL、登录状态、页面区域或数据准备步骤。',
    defaultPrompt
      ? `- 建议默认 prompt：\`${defaultPrompt}\``
      : '- 建议默认 prompt：TODO. 用一句自然语言描述最典型的调用方式。',
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
    '1. 先确认当前 URL 与页面状态满足 `match` 和前置条件。',
    '2. 如需额外读取说明或站点结构，把非 runtime 内容放进 `references/`，并在这里写明何时需要读取。',
    '3. runtime 入口保持薄，只做 orchestration；脆弱 DOM 读取逻辑优先拆到 `src/helpers/`。',
    '4. 真正有副作用的点击/提交动作，只在需要时再拆到 `src/actions/` 或单独 helper 文件。',
    '',
    '## Runtime Contract',
    mountContract,
    '',
    '## Editing Checklist',
    '- 把 `readSummary()` 改成更贴近实际任务的方法名。',
    '- 检查 `description`、`short-description`、`default_prompt` 是否真的有助于触发和使用。',
    '- 如果需要额外资源文件，用顶层 `apply_patch` 新增具体文件，而不是依赖空目录占位。'
  ].join('\n');
}

function buildSkillScaffoldRuntimeEntryContent() {
  return [
    '// 入口文件应当尽量薄：负责组织 helper、导出最终 methods。',
    '// 约定：helper 文件使用异步 require，而不是把所有逻辑堆进一个文件。',
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
    '// helper 文件负责脆弱的 DOM 选择器和可复用读取逻辑。',
    '// 这样页面结构变化时，只需要局部读取/修改这个文件。',
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
    '// 这是 create_skill 生成的 scripts 示例文件。',
    '// scripts/ 适合放生成器、数据整理脚本或需要另存复用的草稿代码。',
    '// 它不会自动挂载到页面 runtime；真正的页面入口仍然是 src/main.js。',
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
    '这是 create_skill 自动生成的 references 示例文件。',
    '',
    '## What to put here',
    '- 站点结构、接口字段、业务术语或已知坑。',
    '- 只有在主 `SKILL.md` 里写不下、且需要按需读取时，才放进 `references/`。',
    '',
    '## TODO',
    '- 用真实页面结构或外部文档摘要替换这份占位内容。'
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
