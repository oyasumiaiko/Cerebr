export const BUILTIN_MICRO_SKILL_CREATOR_NAME = 'skill-creator';

function buildSkillCreatorInstruction() {
  return [
    '---',
    'name: skill-creator',
    'description: Guide for creating or updating Cerebr browser micro skills with OpenAI-aligned interface semantics, validation requirements, and file-oriented package editing.',
    'metadata:',
    '  short-description: Create or validate a Cerebr micro skill package',
    '---',
    '',
    '# Skill Creator',
    '',
    '这是 Cerebr 内置的只读指导 skill，用来教模型如何在当前扩展里正确创建、更新、校验浏览器微型 skill package。',
    '它不是页面 runtime skill，不会自动挂载到 `globalThis.__cerebrMicroSkills`；它的作用是提供制作方法、OpenAI interface 字段语义、模板文件与测试要求。',
    '',
    '## 什么时候应该先读这个 skill',
    '- 用户要求创建、重构、拆分、修复、更新微型 skill。',
    '- 你准备把一段重复执行的页面脚本沉淀成可复用 skill。',
    '- 你不确定 `description`、`SKILL.md`、manifest.interface、dependencies、policy、runtime 入口文件应该分别承载什么信息。',
    '- 你需要把一个大脚本拆成多个文件，并且希望后续模型能稳定维护。',
    '',
    '## 当前 Cerebr 版 creator 的核心原则',
    '1. manifest 是唯一真相源：不要手写 `agents/openai.yaml`；要在 manifest 里维护与 OpenAI interface 对齐的字段语义。',
    '2. 渐进式披露：默认上下文只看 summary；需要工作流时再 `read_detail`；只有要改具体逻辑时才 `read_file` 或 `read_package`。',
    '3. 元数据负责触发，`SKILL.md` 负责方法，runtime 源码负责确定性执行：把这三层分清楚，skill 才会稳定。',
    '4. 按文件编辑优先：如果只改一部分逻辑，优先 `read_file` + `write_file` 修改该文件，而不是整 skill 全量重写。',
    '5. create/update/write_file/delete_file 之前都要考虑 validator 是否会把它判成无效。',
    '',
    '## Manifest 与 OpenAI interface 的语义分工',
    '- `description`: 这是触发/发现元数据。写清“什么时候应该用这个 skill”，而不是写实现细节。',
    '- `interface.display_name`: 人类可读名称，显示在 UI 列表和摘要里。',
    '- `interface.short_description`: 面向 UI 的短描述。当前 Cerebr validator 按官方参考要求 25-64 个字符。',
    '- `interface.icon_small` / `interface.icon_large`: 指向 skill 内 kind=`asset` 的文件路径。',
    '- `interface.brand_color`: Hex 颜色字符串，例如 `#3B82F6`。',
    '- `interface.default_prompt`: 推荐起手提示词。当前 validator 要求它显式包含 `$skill-name` 形式，建议直接写成 `$实际技能名`。',
    '- `dependencies.tools[]`: 只表达依赖，不自动安装；当前只允许 `type=\"mcp\"`。',
    '- `policy.allow_implicit_invocation`: 为 `false` 时，该 skill 不会自动进入 `micro_skill_context`，但仍可显式读取、refresh 或调用。',
    '- `instruction.path`: 指向 `SKILL.md`。这里写工作流、边界条件、读取顺序、常见坑、挂载说明。',
    '- `runtime.entry_path`: 入口 runtime 文件路径。它应该薄，负责组织 helper 和导出最终 methods。',
    '- `files[]`: 虚拟文件树。既可以包含 runtime 源码，也可以包含 references、template、asset、UI metadata。',
    '',
    '## 推荐的文件组织方式',
    '- `SKILL.md`: 工作流入口，告诉模型什么时候触发、先读什么、常见坑是什么。',
    '- `src/main.js`: 入口文件，只负责编排 helper、导出 methods、必要时调用 `ctx.mount(...)`。',
    '- `src/helpers/*.js`: 选择器、解析、格式化、动作等复用逻辑。',
    '- `references/*.md`: 只在需要时再读的站点结构、接口约束、测试要求、字段语义说明。',
    '- `assets/*`: 图标、logo、模板资源；若被 `interface.icon_*` 引用，必须使用 kind=`asset`。',
    '',
    '## 推荐工作流',
    '1. 先 `list` 看是否已有类似 skill；如果是更新，先 `read_detail` + 必要的 `read_file` 了解现状。',
    '2. 创建新 skill 时，先定 metadata：`name`、`description`、`interface.*`、`dependencies`、`policy`、`match`、`instruction.path`、`runtime.entry_path`。',
    '3. 先建一个最小可工作的文件包，再继续拆 helper；不要一开始就过度设计。',
    '4. 如果只是改一两个 helper，优先 `read_file` + `write_file`，不要整体覆写全部文件。',
    '5. 在 create/update 前先显式跑 `validate`；如果 validator 仍报错，不要继续落库。',
    '6. 改完后，如果当前会话绑定了宿主页且这个 skill 应该立即生效，再 `refresh_current_document`。',
    '',
    '## `SKILL.md` 应该写什么',
    '- 触发场景：模型在什么用户请求下应该考虑这个 skill。',
    '- 读取顺序：先看哪个 method、哪个文件、哪个 helper。',
    '- 范围边界：哪个 URL、哪个页面状态、哪个 DOM 前置条件才可靠。',
    '- 风险提示：哪些 DOM 选择器脆弱、哪些操作有副作用、哪些地方要先判空。',
    '- 挂载说明：页面里可用的 runtime surface、`ctx` 的约定、entry/helper 的加载方式、调用示例。',
    '',
    '## `SKILL.md` 不应该写什么',
    '- 大段复制外部官网文档。',
    '- 和 `src/**` 完全重复的长代码。',
    '- 模型常识级 JavaScript 教程。',
    '- 当前页面的一次性临时观察记录。',
    '',
    '## 编写 runtime 文件的约束',
    '- 入口文件优先 `return { methods... }`；确实需要手动挂载时再用 `ctx.mount(exports)`。',
    '- helper 文件通过 `await require("./helper.js")` 加载，避免把所有逻辑内联进 entry。',
    '- 顶层尽量只做定义与导出，不要在文件加载时立刻执行动作。',
    '- 导出面向模型的 method 名称要稳定、语义明确，例如 `readSummary`、`collectCards`、`openPanel`。',
    '- 优先返回结构化对象，不要把重要信息只塞进一大段拼接字符串里。',
    '',
    '## 什么时候应该读附加参考文件',
    '- 需要对齐 manifest 与 OpenAI interface 字段语义时，读 `references/openai-interface.md`。',
    '- 需要确认 validator 会检查什么、manual smoke 应该怎么做时，读 `references/testing-requirements.md`。',
    '- 需要复制一个最小可工作的 skill 骨架时，读 `template/SKILL.md` 和 `template/src/**`。',
    '',
    '## 常见错误',
    '- 用一个巨大的 `src/main.js` 承载全部逻辑，导致后续无法精确修改。',
    '- `description` 写成实现细节，导致模型不会在正确场景触发 skill。',
    '- `interface.short_description` 太短或太长，导致 validator 拒绝通过。',
    '- `interface.default_prompt` 没有显式提到 `$skill-name` 形式。',
    '- `interface.icon_small` / `icon_large` 指向了不存在文件，或者指向了非 asset 文件。',
    '- `SKILL.md` frontmatter 的 `name/description` 与 manifest 不一致。',
    '- 明明只改一个 helper，却整体 `update` 重写整 skill。',
    '- 在 mount 时直接执行副作用，导致页面一加载就被点击或改 DOM。',
    '',
    '## 当你需要真正创建或更新 skill 时的推荐顺序',
    '1. 先 `read_detail(skill_name=\"skill-creator\")`，确认工作流和字段职责。',
    '2. 如果是修改已有 skill，再读目标 skill 的 `read_detail`，必要时读相关 `read_file`。',
    '3. 若只是修改局部逻辑，优先使用 `write_file`。',
    '4. 若 metadata 或多个文件都要一起改，再用 `update`。',
    '5. 改完先 `validate`，通过后再视需要 `refresh_current_document`。',
    '',
    '## 判断一个 skill 是否“做对了”',
    '- summary 足够短，但能让模型知道何时该触发它。',
    '- `SKILL.md` 足够具体，但不会把上下文吃爆。',
    '- manifest.interface / dependencies / policy 语义清晰且能通过 validator。',
    '- 文件树按职责拆开，能针对单个文件稳定迭代。',
    '- 当前 URL 命中时，模型能从摘要得知它可用；需要细节时再主动读取。',
    '- 后续维护者只看 `SKILL.md` + 文件列表 + validator 结果，就能快速定位该改哪里。'
  ].join('\n');
}

function buildOpenAiInterfaceReference() {
  return [
    '# OpenAI Interface Mapping',
    '',
    '本文件解释 Cerebr manifest 字段如何对齐官方 `openai.yaml` / `SkillInterface` 语义，同时说明哪些地方是“语义对齐但不再保留 YAML 文件”。',
    '',
    '## 核心结论',
    '- Cerebr 不把 `agents/openai.yaml` 当成真相源；manifest 才是唯一真相源。',
    '- 但 manifest 中 `interface` / `dependencies` / `policy` 的字段语义，必须与官方参考保持一致。',
    '',
    '## 字段映射',
    '- `manifest.interface.display_name` -> `openai.yaml interface.display_name`',
    '- `manifest.interface.short_description` -> `openai.yaml interface.short_description`',
    '- `manifest.interface.icon_small` -> `openai.yaml interface.icon_small`',
    '- `manifest.interface.icon_large` -> `openai.yaml interface.icon_large`',
    '- `manifest.interface.brand_color` -> `openai.yaml interface.brand_color`',
    '- `manifest.interface.default_prompt` -> `openai.yaml interface.default_prompt`',
    '- `manifest.dependencies.tools[]` -> `openai.yaml dependencies.tools[]`',
    '- `manifest.policy.allow_implicit_invocation` -> `openai.yaml policy.allow_implicit_invocation`',
    '',
    '## Cerebr 额外约束',
    '- `interface.short_description` 需要通过长度约束，当前按官方参考使用 25-64 个字符。',
    '- `interface.default_prompt` 必须显式包含 `$skill-name` 形式；在 Cerebr 中推荐直接写成 `$实际技能名`。',
    '- `icon_small` / `icon_large` 必须指向 skill 内 kind=`asset` 的文件。',
    '- `dependencies.tools[].type` 当前只允许 `mcp`。',
    '- `policy.allow_implicit_invocation=false` 时，skill 仍可显式读取和调用，但不会自动进入 `micro_skill_context`。',
    '',
    '## 不要做的事',
    '- 不要手写或维护一份单独的 `agents/openai.yaml`。',
    '- 不要让 `SKILL.md` frontmatter、manifest.description、manifest.interface.short_description` 三者互相漂移。',
    '- 不要让 `default_prompt` 变成泛泛的自然语言句子而没有 `$skill-name`。'
  ].join('\n');
}

function buildTestingRequirementsReference() {
  return [
    '# Testing Requirements',
    '',
    '每个新建或修改后的 Cerebr 微型 skill，都应该至少通过以下检查。',
    '',
    '## Pre-save Validator Checklist',
    '- `SKILL.md` 存在，且 YAML frontmatter 的 `name` / `description` 与 manifest 一致。',
    '- `interface.display_name` 非空。',
    '- `interface.short_description` 长度符合约束。',
    '- `interface.default_prompt` 显式包含 `$skill-name` 形式。',
    '- `brand_color` 为合法 hex（若声明）。',
    '- `icon_small` / `icon_large` 指向存在的 asset 文件（若声明）。',
    '- `dependencies.tools[]` 结构合法，当前仅允许 `type=\"mcp\"`。',
    '- `policy.allow_implicit_invocation` 为布尔值。',
    '- page runtime skill 的 `runtime.entry_path` 存在且指向 runtime_source 文件。',
    '',
    '## Manual Smoke Expectations',
    '- `read_detail` 能返回完整 manifest + `SKILL.md` 内容 + validation 结果。',
    '- `read_package` 能返回完整文件包。',
    '- 若 skill 为 page runtime，命中 URL 上执行 `refresh_current_document` 后，`js_runtime_execute` 能调用已挂载的方法。',
    '- 若 `policy.allow_implicit_invocation=false`，它不应自动进入 `micro_skill_context`。',
    '- 若 URL 不匹配，该 skill 不应出现在当前页面匹配摘要中。',
    '',
    '## Authoring Recommendations',
    '- 改 metadata 前先读 `references/openai-interface.md`。',
    '- 只改局部 helper 时，优先 `read_file` + `write_file`。',
    '- 只有 metadata 或多个文件一起变化时，才使用 `update`。',
    '- 每次大改之后先跑 `validate`，再决定是否 `refresh_current_document`。'
  ].join('\n');
}

function buildSkillCreatorTemplateSkillMarkdown() {
  return [
    '---',
    'name: example-page-skill',
    'description: Read structured data from a target page and expose a small set of stable browser runtime methods.',
    'metadata:',
    '  short-description: Read page data and expose stable runtime methods for Cerebr',
    '---',
    '',
    '# Example Page Skill',
    '',
    '## Trigger',
    '- Use this skill when the user asks to read structured data from the target site.',
    '',
    '## Reading order',
    '- Read `src/main.js` first to see exported methods.',
    '- Read helper files only when adjusting selectors or parsing behavior.',
    '',
    '## Runtime notes',
    '- Mounted surface: `globalThis.__cerebrMicroSkills`.',
    '- Call methods through `globalThis.__cerebrMicroSkills.invoke(\"example-page-skill.readSummary\")`.',
    '',
    '## Risks',
    '- DOM selectors may be brittle when the site changes.',
    '- Do not execute destructive actions during mount.'
  ].join('\n');
}

function buildSkillCreatorTemplateFiles() {
  return [
    {
      path: 'template/SKILL.md',
      kind: 'template',
      content: buildSkillCreatorTemplateSkillMarkdown()
    },
    {
      path: 'template/src/main.js',
      kind: 'template',
      content: [
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
      ].join('\n')
    },
    {
      path: 'template/src/helpers/dom.js',
      kind: 'template',
      content: [
        '// helper 文件负责脆弱的 DOM 选择器和可复用读取逻辑。',
        '// 这样页面结构变化时，只需要局部读取/修改这个文件。',
        '',
        'module.exports = {',
        '  readTitle() {',
        '    return document.title;',
        '  }',
        '};'
      ].join('\n')
    },
    {
      path: 'template/references/openai-interface.md',
      kind: 'template',
      content: [
        '# OpenAI Interface Notes',
        '',
        '- `short_description` 应保持 25-64 个字符。',
        '- `default_prompt` 应显式写出 `$example-page-skill`。',
        '- `icon_small` / `icon_large` 需要指向 kind=`asset` 的文件。'
      ].join('\n')
    },
    {
      path: 'template/references/testing-requirements.md',
      kind: 'template',
      content: [
        '# Testing Requirements',
        '',
        '- 先跑 `validate`。',
        '- 再在匹配页面上 `refresh_current_document`。',
        '- 最后用 `js_runtime_execute` 调挂载方法。'
      ].join('\n')
    },
    {
      path: 'template/assets/icon-small.svg',
      kind: 'template',
      content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#3B82F6"/><path d="M18 32h28" stroke="#fff" stroke-width="6" stroke-linecap="round"/></svg>'
    },
    {
      path: 'template/assets/icon-large.svg',
      kind: 'template',
      content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="24" fill="#3B82F6"/><circle cx="64" cy="64" r="30" fill="#fff"/></svg>'
    }
  ];
}

export function buildBuiltinSkillCreatorRecord() {
  return {
    builtin: true,
    read_only: true,
    kind: 'builtin_guidance',
    name: BUILTIN_MICRO_SKILL_CREATOR_NAME,
    description: 'Guide for creating or updating Cerebr browser micro skills with OpenAI-aligned interface semantics, validation requirements, and file-oriented package editing.',
    interface: {
      display_name: 'Skill Creator',
      short_description: '创建或更新浏览器微型 skill 前必须先读的内置制作与校验指导',
      icon_small: null,
      icon_large: null,
      brand_color: '#0F172A',
      default_prompt: 'Use $skill-creator to create or validate a Cerebr micro skill package before editing other skill files.'
    },
    dependencies: {
      tools: []
    },
    policy: {
      allow_implicit_invocation: true
    },
    match: ['<all_urls>'],
    enabled: true,
    instruction: {
      path: 'SKILL.md'
    },
    runtime: {
      entry_path: null
    },
    files: [
      {
        path: 'SKILL.md',
        kind: 'instruction',
        content: buildSkillCreatorInstruction()
      },
      {
        path: 'references/openai-interface.md',
        kind: 'reference',
        content: buildOpenAiInterfaceReference()
      },
      {
        path: 'references/testing-requirements.md',
        kind: 'reference',
        content: buildTestingRequirementsReference()
      },
      ...buildSkillCreatorTemplateFiles()
    ],
    created_at: '2026-04-12T00:00:00.000Z',
    updated_at: '2026-04-12T00:00:00.000Z',
    revision: 1
  };
}

export function getBuiltinMicroSkillRecords() {
  return [buildBuiltinSkillCreatorRecord()];
}

export function getBuiltinMicroSkillRecordByName(skillName) {
  const normalized = String(skillName || '').trim();
  if (!normalized) return null;
  return getBuiltinMicroSkillRecords().find((record) => record.name === normalized) || null;
}

export function buildBuiltinSkillCreatorContextSummary() {
  return {
    priority: 0,
    kind: 'builtin_guidance',
    name: BUILTIN_MICRO_SKILL_CREATOR_NAME,
    display_name: 'Skill Creator',
    short_description: '创建或更新浏览器微型 skill 前必须先读的内置制作与校验指导',
    default_prompt: 'Use $skill-creator to create or validate a Cerebr micro skill package before editing other skill files.',
    allow_implicit_invocation: true,
    mount_surface: 'Instruction-only skill. Read detail with micro_skill_registry(action="read_detail", skill_name="skill-creator"), then use validate/create/update/write_file/delete_file to build the real skill.'
  };
}
