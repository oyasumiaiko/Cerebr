import { buildSkillScaffoldFiles } from './skill_scaffold.js';

export const BUILTIN_SKILL_CREATOR_NAME = 'skill-creator';

function buildSkillCreatorInstruction() {
  return [
    '---',
    'name: skill-creator',
    'description: Guide for creating or updating Cerebr skills with concise metadata, progressive disclosure, and file-oriented package editing.',
    'metadata:',
    '  short-description: Create or update a Cerebr skill',
    '---',
    '',
    '# Skill Creator',
    '',
    '这是 Cerebr 内置的只读指导 skill，用来教模型如何在当前扩展里正确创建或更新 skill package。',
    '它本身不是页面 runtime skill；它的职责是告诉模型：什么时候先生成通用骨架、什么时候再读 `SKILL.md`、以及何时才应该把一个 skill 演进成带 JS runtime 的页面能力。',
    '',
    '## 什么时候应该先读这个 skill',
    '- 用户要求创建、重构、拆分、修复或更新 skill。',
    '- 你准备把一段重复执行的页面脚本、工作流说明或参考资料沉淀成可复用 skill。',
    '- 你不确定 `description`、`SKILL.md`、`references/`、`scripts/`、`assets/` 应该分别承载什么信息。',
    '- 你不确定某个 skill 是否真的需要 JS runtime，而不是只需要一份高质量指导文档。',
    '',
    '## 核心原则',
    '1. 默认先创建通用骨架：新 skill 应先用 `skill_registry(action="create_skill", skill={...})` 生成通用 `SKILL.md` scaffold，再按需要增量 patch。',
    '2. skill 不是原生 function tool：自动上下文只暴露轻量摘要；真正使用某个 skill 时，先读它的 `SKILL.md`，再按需读 `references/`、`scripts/` 或其他文件。',
    '3. 渐进式披露：默认不要把整包文件一次性读进上下文。优先 `list_files` / `search_files` / `read_file` 精读需要的文件。',
    '4. 文件编辑统一走顶层文件工具：对 skill 文件的读取、搜索和修改都用 `list_files` / `search_files` / `read_file` / `apply_patch`，并传 `target: { kind: "skill", name: "<skill-name>" }`。',
    '5. runtime 是后续演进，不是默认前提：只有当 skill 真的需要在页面里挂载 JS 能力时，才给它补 `manifest.json` 的 `match`、`runtime.entry_path` 和对应 JS 文件。',
    '6. 当前浏览器里模型唯一可直接执行代码的路径是 `js_runtime_execute`：它的 `code` 会作为 async 函数体执行，可直接写 `await` / `return` / `console.log`。',
    '7. 保持低耦合：`SKILL.md` 负责工作流与触发说明；`references/` 负责按需加载的细节；`scripts/` 负责可复用的 JS 片段或待迁移到 runtime 的代码草稿；`assets/` 负责输出素材。',
    '',
    '## 推荐工作流',
    '1. 如果是更新已有 skill，先 `skill_registry(action="list")` 找到目标，再 `read_file(target={kind:"skill",name}, file_path="SKILL.md")` 读说明入口。',
    '2. 如果是新建 skill，先调用 `skill_registry(action="create_skill", skill={ name, description, interface?, resources?, examples? })` 生成官方风格通用骨架。',
    '3. scaffold 创建完成后，先 patch `SKILL.md`，把 `Overview`、`Structuring This Skill`、主章节占位符和 `Resources (optional)` 改成真实内容。',
    '4. 如果需要资源文件，再对 `scripts/`、`references/`、`assets/` 下的示例文件做增量修改或删除；不要把 `scripts/` 里的文件当成 shell/python 可直接执行命令。',
    '5. 只有当 skill 真的需要页面 runtime 时，才继续 patch `manifest.json` 增加 `match` 与 `runtime.entry_path`，并新增 JS 文件。',
    '6. runtime 验证时统一走 `js_runtime_execute`，在 `code` 里写 async 函数体片段；只有它已经成为页面 runtime skill 时，才通过 `return await $invoke("<skill-name>", "methodName", args)` 这类方式去调用已挂载方法。',
    '7. 是否启用与挂载放在最后：准备好后再 `enable_skill`；只有它已经成为页面 runtime skill 时，才 `mount_on_current_page`。',
    '',
    '## create_skill 模板入口参数',
    '- `name`：必填。输入名可以带空格或大写；系统会自动归一化成 hyphen-case 稳定 key。',
    '- `description`：必填。写清“什么时候该触发这个 skill”，不是实现细节。',
    '- `interface.display_name` / `short_description` / `default_prompt`：可选；不填时会自动补默认值。',
    '- `enabled`：可选，默认 `false`。建议先补完 scaffold，再显式启用。',
    '- `resources`：可选，只支持 `scripts` / `references` / `assets`。',
    '- `examples`：可选；为 `true` 时会给已选 resources 生成示例文件，且必须先提供 `resources`。',
    '- 返回值会带 `created_files` 与 `next_steps`；创建后按这些 next steps 继续 patch，而不是重新手工拼完整 skill 包。',
    '',
    '## `SKILL.md` 应该写什么',
    '- 触发场景：什么用户请求、文件类型、页面状态或任务会触发这个 skill。',
    '- 结构选择：删掉 `Structuring This Skill` 占位指导前，先选定最合适的结构模式。',
    '- 主体章节：用真实 workflow、任务分类、参考规范或能力列表替换占位段落。',
    '- 读取顺序：什么时候先看 `SKILL.md`，什么时候再读 `references/` 或参考 `scripts/` 里的 JS 片段。',
    '- 风险与边界：哪些前置条件、限制、常见错误或副作用必须先说明。',
    '- 如果后来加入 runtime：在 `SKILL.md` 里补一小段 runtime notes，说明有哪些 method、典型输入是什么，并给出放在 `js_runtime_execute.code` 里的 async 函数体示例。',
    '',
    '## `SKILL.md` 不应该写什么',
    '- 大段复制外部文档。',
    '- 与具体源码重复的大块实现细节。',
    '- 一次性调试记录或临时页面观察。',
    '- 在还没确认真的需要 runtime 前，就先写死一堆页面注入细节。',
    '',
    '## 什么时候才该给 skill 加 JS runtime',
    '- 只有当纯文字指导不够，确实需要在页面中执行确定性读取、解析或动作时，才添加 runtime。',
    '- 添加 runtime 时，再 patch `manifest.json` 增加 `match` 与 `runtime.entry_path`，并新增对应 JS 文件。',
    '- 这时才需要在 `SKILL.md` 里补充 runtime notes，例如在 `js_runtime_execute` 中写 `return await $invoke("<skill-name>", "methodName", args);` 之类的调用方式。',
    '',
    '## 常见错误',
    '- 一上来就把 skill 设计成页面 runtime，而没有先确认通用指导是否已足够。',
    '- 直接手工拼完整 `files[]`，而不是先走 `create_skill` scaffold。',
    '- 把所有信息都塞进 `SKILL.md`，却不把冗长细节拆到 `references/`。',
    '- 还没确定需要时，就预创建大量空目录和空文件。',
    '- 把 `scripts/` 误当成 Python/Bash/shell 可直接运行入口，而不是浏览器里的 JS 代码素材。',
    '- 修改已有 skill 时整体重写整包，而不是用 `search_files` + `read_file` + `apply_patch` 精确增量修改。',
    '',
    '## 当你需要真正创建或更新 skill 时的推荐顺序',
    '1. 先 `read_file(target={kind:"skill",name:"skill-creator"}, file_path="SKILL.md")`，确认工作流和字段职责。',
    '2. 如果是修改已有 skill，再读目标 skill 的 `SKILL.md`，必要时继续读相关文件。',
    '3. 若是新建 skill，先调用 `skill_registry(action="create_skill", skill={ name, description, interface?, resources?, examples? })` 生成通用模板。',
    '4. 模板生成后，按返回的 `next_steps` 继续：优先 patch `SKILL.md`，再处理资源文件；如果以后真的需要 runtime，再补 `manifest.json` 与 JS 文件。',
    '5. 若只是修改局部逻辑，优先 `search_files(target={kind:"skill",name}, ...)` -> `read_file(target={kind:"skill",name}, include_line_numbers=true)` -> `apply_patch(target={kind:"skill",name}, ...)`。',
    '6. skill lifecycle 动作用 `skill_registry`；文件编辑继续使用顶层文件工具，不要把文件改动塞回 registry action。',
    '',
    '## 判断一个 skill 是否“做对了”',
    '- summary 足够短，但能让模型知道何时该触发它。',
    '- `SKILL.md` 先作为指导入口，而不是源码替代品。',
    '- 资源目录按需存在，而不是默认堆满占位文件。',
    '- 只有真正需要页面能力时，才演进成带 runtime 的 skill。',
    '- 后续维护者只看 `SKILL.md` 和文件列表，就能快速知道该继续改哪里。'
  ].join('\n');
}

function buildSkillCreatorTemplateFiles() {
  return buildSkillScaffoldFiles({
    pathPrefix: 'template',
    skillName: 'example-skill',
    displayName: 'Example Skill',
    description: 'Explain when this skill should be used and what it helps with.',
    shortDescription: 'Example generic skill scaffold',
    resources: ['scripts', 'references', 'assets'],
    examples: true
  }).map((file) => ({
    ...file,
    kind: 'template'
  }));
}

export function buildBuiltinSkillCreatorRecord() {
  return {
    builtin: true,
    read_only: true,
    kind: 'builtin_guidance',
    name: BUILTIN_SKILL_CREATOR_NAME,
    description: 'Guide for creating or updating Cerebr skills with concise metadata, progressive disclosure, and file-oriented package editing.',
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

export function getBuiltinSkillRecords() {
  return [buildBuiltinSkillCreatorRecord()];
}

export function getBuiltinSkillRecordByName(skillName) {
  const normalized = String(skillName || '').trim();
  if (!normalized) return null;
  return getBuiltinSkillRecords().find((record) => record.name === normalized) || null;
}

export function buildBuiltinSkillCreatorContextSummary() {
  return {
    priority: 0,
    name: BUILTIN_SKILL_CREATOR_NAME,
    short_description: '创建或更新 skill 时，先读这条内置指导，再决定 `SKILL.md`、资源文件和后续 runtime 是否真的需要。',
    instruction_path: 'SKILL.md'
  };
}
