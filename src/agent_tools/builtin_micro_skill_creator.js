export const BUILTIN_MICRO_SKILL_CREATOR_NAME = 'skill-creator';

function buildSkillCreatorInstruction() {
  return [
    '---',
    'name: skill-creator',
    'description: Guide for creating or updating Cerebr browser skills with concise metadata, progressive disclosure, and file-oriented package editing.',
    'metadata:',
    '  short-description: Create or update a Cerebr skill',
    '---',
    '',
    '# Skill Creator',
    '',
    '这是 Cerebr 内置的只读指导 skill，用来教模型如何在当前扩展里正确创建或更新浏览器 skill package。',
    '它不是页面 runtime skill，不会自动暴露到浏览器 runtime facade（如 `$skill()` / `$invoke()`）；它的作用是提供制作 skill 的方法论、字段分工和推荐编辑流程。',
    '',
    '## 什么时候应该先读这个 skill',
    '- 用户要求创建、重构、拆分、修复、更新 skill。',
    '- 你准备把一段重复执行的页面脚本沉淀成可复用 skill。',
    '- 你不确定 `description`、`SKILL.md`、runtime 入口文件、reference 文件应该分别承载什么信息。',
    '- 你需要把一个大脚本拆成多个文件并保持后续易改。',
    '',
    '## 核心原则',
    '1. 简洁优先：上下文窗口是公共资源。不要把模型本来就知道的常识、长篇外部文档、页面内容复述塞进 skill。',
    '2. 渐进式披露：默认上下文只看 summary；先用 `skill_registry(action="list")` 看摘要，再用顶层 `list_files` / `search_files` / `read_file` 精读目标文件，不要一次性把整包全部读进上下文。',
    '3. 元数据负责触发，`SKILL.md` 负责方法，runtime 源码负责确定性执行：把这三层分清楚，skill 才会稳定。',
    '4. 低耦合文件组织：entry 负责 orchestration，helper 文件负责选择器、解析、动作、格式化，不要把所有东西塞在一个文件里。',
    '5. 文件编辑统一走顶层 `apply_patch`：如果只改一部分逻辑，优先 `search_files` + `read_file` + `apply_patch` 精确修改该文件，并尽量增量更新，不要整文件重写。',
    '6. 顶层文件工具操作 skill 时，统一传 `target: { kind: "skill", name: "<skill-name>" }`。',
    '7. 挂载期尽量无副作用：skill 被装载时应该主要做导出和注册，不要在 mount 时立刻点击、提交表单或触发重 DOM 副作用。',
    '',
    '## Cerebr 版 skill package 的字段分工',
    '- `description`: 这是触发/发现元数据。写清“什么时候应该用这个 skill”，而不是写实现细节。',
    '- `interface.display_name`: 面向 UI 和列表的可读名称。',
    '- `interface.short_description`: 面向列表/摘要的一句话能力说明，应比 `description` 更短。',
    '- `interface.default_prompt`: 当用户想直接调用这个 skill 时，最自然的默认提问方式。',
    '- `match[]`: 页面范围。只写真正需要的 URL 范围，不要默认滥用 `<all_urls>`。',
    '- `instruction.path`: 指向 `SKILL.md`。这里写工作流、边界条件、读取顺序、常见坑、挂载说明。',
    '- `runtime.entry_path`: 入口 runtime 文件路径。它应该薄，负责组织 helper 和导出最终 methods。',
    '- `files[]`: 虚拟文件树。既可以包含 runtime 源码，也可以包含 references、template、UI metadata。',
    '',
    '## 推荐的文件组织方式',
    '- `SKILL.md`: 工作流入口，告诉模型什么时候触发、先读什么、常见坑是什么，并明确写 `Inputs / Quick start / Usage examples / Workflow`。',
    '- `src/main.js`: 入口文件，只负责编排 helper、导出 methods、必要时调用 `ctx.mount(...)`。',
    '- `src/helpers/dom.js`: 选择器和基础 DOM 读取。',
    '- `src/helpers/parse.js`: 文本解析、结构化抽取、格式化。',
    '- `src/actions/*.js`: 点击、提交、展开面板等副作用动作。',
    '- `references/*.md`: 只在需要时再读的变体说明、站点结构、已知坑。',
    '',
    '## 推荐工作流',
    '1. 先 `skill_registry(action="list")` 看是否已有类似 skill；如果是更新，先 `list_files(target={kind:"skill",name})` / `search_files(target={kind:"skill",name})` 找目标，再 `read_file(target={kind:"skill",name}, file_path="SKILL.md")` 和必要的源码文件了解现状。',
    '2. 创建新 skill 时，先定 metadata：`name`、`description`、`interface.*`、`match`、`instruction.path`、`runtime.entry_path`。',
    '3. 先建一个最小可工作的文件包，再继续拆 helper；不要一开始就过度设计。',
    '4. 如果只是改一两个 helper，优先 `search_files` + `read_file` + `apply_patch`，不要整体覆写全部文件。',
    '5. 需要新增文件时，也统一使用 `apply_patch` 的 `*** Add File:`；需要修改 metadata 时，直接 patch `manifest.json`。',
    '6. 改完后，如果当前会话绑定了宿主页且这个 skill 应该立即生效，再 `skill_registry(action="mount_on_current_page", skill_name="<skill-name>")`。',
    '',
    '## 什么时候该拆文件',
    '- 同一个文件同时承担“选 DOM + 解析文本 + 点击动作 + 导出接口”时，应该拆。',
    '- 某段解析/选择器逻辑可能在多个 methods 里复用时，应该拆。',
    '- 页面结构非常脆弱、将来 likely 频繁修改时，应该把脆弱部分单独放到 helper 文件里。',
    '- 只是 20 行以内的局部逻辑且不会复用时，不必为了形式而拆。',
    '',
    '## `SKILL.md` 应该写什么',
    '- 触发场景：模型在什么用户请求下应该考虑这个 skill。',
    '- Inputs：模型应提供哪些输入、哪些参数是必填或常见可选项。',
    '- Quick start：一两个最短可跑的调用示例；页面 runtime skill 优先写 `$invoke("<skill-name>", "methodName", args)` 风格示例。',
    '- Usage examples：列 2-3 个代表性调用例子，让模型知道典型参数形状与返回目标。',
    '- Workflow：先做什么、后做什么、什么时候读取 references 或执行 actions。',
    '- 读取顺序：先看哪个 method、哪个文件、哪个 helper。',
    '- 范围边界：哪个 URL、哪个页面状态、哪个 DOM 前置条件才可靠。',
    '- 风险提示：哪些 DOM 选择器脆弱、哪些操作有副作用、哪些地方要先判空。',
    '- 挂载说明：优先写模型真正会用的 facade（`$skill` / `$invoke` / `$methods`），再补充 `ctx` 约定、entry/helper 加载方式和兼容说明。',
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
    '- 页面 runtime skill 的 `SKILL.md` 应优先教模型使用 `$invoke("<skill-name>", "methodName", args)`；只有在确实需要直接观察导出时再提 `$skill("<skill-name>")` 或 `$methods("<skill-name>")`。',
    '',
    '## 常见错误',
    '- 用一个巨大的 `src/main.js` 承载全部逻辑，导致后续无法精确修改。',
    '- `description` 写成实现细节，导致模型不会在正确场景触发 skill。',
    '- `SKILL.md` 写成冗长设计文档，而不是操作指导。',
    '- 明明只改一个 helper，却整体重写整 skill，而不是定点 patch 目标文件。',
    '- 在 mount 时直接执行副作用，导致页面一加载就被点击或改 DOM。',
    '',
    '## 当你需要真正创建或更新 skill 时的推荐顺序',
    '1. 先 `read_file(target={kind:"skill",name:"skill-creator"}, file_path="SKILL.md")`，确认工作流和字段职责。',
    '2. 如果是修改已有 skill，再读目标 skill 的 `SKILL.md`，必要时读相关 `read_file`。',
    '3. 若只是修改局部逻辑，优先 `search_files(target={kind:"skill",name}, ...)` -> `read_file(target={kind:"skill",name}, include_line_numbers=true)` -> `apply_patch(target={kind:"skill",name}, ...)`。',
    '4. 需要新增文件、修改已有文件，或调整 `manifest.json` 时，统一继续使用顶层 `apply_patch`；skill lifecycle 动作用 `skill_registry`，不要把文件编辑塞回 registry。',
    '5. 创建全新 skill 时，用 `skill_registry(action="create_skill", skill=...)` 做 bootstrap；删除、启停也分别用 `delete_skill` / `enable_skill` / `disable_skill`。',
    '6. 改完仅在需要时 `mount_on_current_page`，不要无意义挂载。',
    '',
    '## 判断一个 skill 是否“做对了”',
    '- summary 足够短，但能让模型知道何时该触发它。',
    '- `SKILL.md` 足够具体，但不会把上下文吃爆。',
    '- 文件树按职责拆开，能针对单个文件稳定迭代。',
    '- 当前 URL 命中时，模型能从摘要得知它可用；需要细节时再主动读取。',
    '- 后续维护者只看 `SKILL.md` + 文件列表，就能快速定位该改哪里。'
  ].join('\n');
}

function buildSkillCreatorTemplateFiles() {
  return [
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
    }
  ];
}

export function buildBuiltinSkillCreatorRecord() {
  return {
    builtin: true,
    read_only: true,
    kind: 'builtin_guidance',
    name: BUILTIN_MICRO_SKILL_CREATOR_NAME,
    description: 'Guide for creating or updating Cerebr browser skills with concise metadata, progressive disclosure, and file-oriented package editing.',
    interface: {
      display_name: 'Skill Creator',
      short_description: '创建或更新 skill 时先读的内置指导 skill',
      default_prompt: 'When asked to create or update a Cerebr skill, first read the built-in skill-creator instruction, then inspect the target skill and edit only the necessary files.'
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
    name: BUILTIN_MICRO_SKILL_CREATOR_NAME,
    display_name: 'Skill Creator',
    short_description: '创建或更新 skill 时，先读这条内置指导 skill，再决定 metadata、SKILL.md 和 runtime 文件树怎么改。',
    default_prompt: 'Before creating or updating a Cerebr skill, read the built-in skill-creator instruction and then edit only the necessary files.',
    mount_surface: 'Read SKILL.md first, then read files or edit the target skill as needed.'
  };
}
