import { buildSkillScaffoldFiles } from './skill_scaffold.js';

export const BUILTIN_SKILL_CREATOR_NAME = 'skill-creator';

function buildSkillCreatorInstruction() {
  return [
    '---',
    'name: skill-creator',
    'description: Guide for creating, updating, repairing, splitting, or evaluating Cerebr skills with concise trigger metadata, progressive disclosure, reusable resources, and validation.',
    '---',
    '',
    '# Skill Creator',
    '',
    '这是 Cerebr 内置的只读指导 skill。它以当前官方 Skill Creator 的原则为基准，并把文件系统脚本、UI 元数据和验证流程映射到 Cerebr 真实提供的 skill registry、虚拟文件与浏览器 JS runtime。',
    '不要虚构本环境没有暴露的初始化脚本、Python/Bash 执行器、自动验证器或隐式 skill 调用语法。',
    '',
    '## 核心原则',
    '1. 简洁优先：上下文窗口是公共资源。只写模型无法可靠自行推断的程序性知识，优先短例子，不复述常识。',
    '2. 设置适当自由度：多种方案都可行时给高自由度文字指导；存在推荐模式时给中自由度伪代码或带参数片段；脆弱、易错且必须一致时给低自由度的固定步骤或确定性 JS。',
    '3. 渐进式披露：先暴露短 description，触发后读 `SKILL.md`，再按任务需要读取 `references/`、`scripts/` 或其他文件。不要一次加载整包。',
    '4. 保护验证完整性：前向测试只提供真实请求、原始文件、输出、diff、日志或 trace，不要把预期答案、已知 bug 或拟定修复泄漏给验证者。',
    '5. 只保留直接服务 skill 的文件。不要创建 README.md、INSTALLATION_GUIDE.md、QUICK_REFERENCE.md、CHANGELOG.md 或记录制作过程的旁支文档。',
    '6. runtime 是后续演进，不是默认前提。只有文字指导和按需资源不足以完成确定性页面任务时，才添加页面 JS runtime。',
    '',
    '## Cerebr skill package 结构',
    '- `SKILL.md`：必需的说明入口。正文承载工作流、决策规则、边界和资源导航。',
    '- `manifest.json`：Cerebr 的权威元数据与生命周期配置，包含 `description`、`interface`、`match`、`enabled`、`instruction.path` 和 `runtime.entry_path`；它是可用 read_file/apply_patch 读取和修改的虚拟文本文件。',
    '- `scripts/`：可复用的浏览器 JavaScript 片段或待演进为 runtime 的源码素材，不会被自动执行。',
    '- `references/`：仅在相关任务中按需读取的详细文档、schema、API 说明或流程指南。',
    '- `assets/`：供最终输出复用的文本模板或已有素材。不要用文本补丁伪造图片、字体等二进制内容。',
    '- Cerebr 不消费额外的产品专用 agents 配置文件；UI 元数据以 `manifest.json.interface` 为准。',
    '',
    '## 命名与元数据',
    '- 名称只使用小写字母、数字和连字符，最长 64 个字符；优先短、动词导向、能表达动作的名称。Cerebr 会把 create_skill 输入归一化为 hyphen-case 稳定 key。',
    '- skill key 创建后视为稳定标识。`SKILL.md` frontmatter 的 name 应与它一致；当前没有原地重命名 action，需要改名时创建新 skill 并迁移文件。',
    '- `description` 是模型发现 skill 的主要依据，必须同时写明“做什么”和“什么请求、文件、页面状态或任务应使用它”。不要只在正文里放一个 When to Use 章节。',
    '- Cerebr 不解析 `SKILL.md` frontmatter 来更新 registry。修改 description 时，同时 patch `SKILL.md` frontmatter 与 `manifest.json.description`，避免两套元数据漂移。',
    '- `interface.display_name` 是 UI 标题；`short_description` 保持便于扫描，建议 25-64 个字符；`default_prompt` 是可选展示字段，缺省为 null，当前不会自动插入对话。',
    '- 普通 skill 的 `SKILL.md` frontmatter 只生成 name 与 description；Cerebr UI 元数据统一放在 `manifest.json.interface`。',
    '',
    '## 渐进式披露与资源组织',
    '- 尽量让 `SKILL.md` 保持在 500 行以内；接近上限时，把变体细节、schema 和长示例拆到 references。',
    '- references 只从 `SKILL.md` 直接链接一层，避免深层引用链；超过 100 行的 reference 在开头加目录。',
    '- 超过约 10,000 词的 reference，应在 `SKILL.md` 中给出可用于 `search_files` 的关键词或正则模式。',
    '- 同一信息只放一处。核心步骤留在 `SKILL.md`，详细事实放 references，确定性代码放 scripts 或 runtime，输出素材放 assets。',
    '- 多框架、多站点或多变体 skill 只在 `SKILL.md` 保留选择逻辑，把各变体细节拆成平级 reference 文件。',
    '',
    '## 创建或更新流程',
    '1. 用具体例子理解需求：列出真实用户会怎么问、哪些请求应触发、哪些相近请求不应触发。只有用法已经明确时才跳过。',
    '2. 规划可复用内容：逐个例子推演从零完成任务需要什么，把反复重写的 JS、详细文档和输出模板分别规划到 scripts、references、assets。',
    '3. 初始化或定位：新 skill 调用 `skill_registry(action="create_skill", skill={ name, description, interface, enabled:false, resources, examples })`；更新已有 skill 先 `skill_registry(action="list", include_all_sites=true)` 找到稳定 key。',
    '4. 实现：修改任何已有文件前，必须在当前 revision 上重新 `read_file`；不能根据更早看过的内容、记忆中的 scaffold 或流式预览构造整文件 `Update File`。Freeform `apply_patch` 必须在 `*** Begin Patch` 后写 `*** Environment ID: skill:<stable-key>`。',
    '5. 选择正确 hunk：新建 skill 后若要整体替换默认 `SKILL.md`，显式使用 `*** Add File: SKILL.md` 覆盖；其它新文件也使用 Add File。`Update File` 只用于基于刚读取内容的局部改动，context 保持短且足以唯一定位。`manifest.json` 只能做最小、精确的 Update File，禁止 Add/Delete/Move。',
    '6. 验证：每次 apply_patch 成功后，用 `read_file` 或 `list_files` 回读真正持久化的结果；流式 preview 不是成功证据。检查 frontmatter 与 manifest 同步、TODO 和占位文件已清理、引用路径存在、说明足够短且可执行。',
    '7. 迭代：至少用 2-3 个有代表性的真实请求执行 skill，记录卡点，只修复可复现的问题；复杂 skill 在条件允许时做独立前向测试。',
    '',
    '## Cerebr 执行与验证边界',
    '- guidance skill 没有单独的执行 action。验证时在新任务中显式 read_file 读取它的 `SKILL.md`，再按指导完成真实请求并检查结果。',
    '- `scripts/` 中的文件是源码素材，不是可直接运行的 Python、Bash 或 shell 入口。需要执行时，读取 JavaScript 后放进 `js_runtime_execute.code`；该字段按 async 函数体运行，可直接使用 await、return 和 console.log。',
    '- 只有 2-3 个代表性页面任务都出现可复现的确定性提取失败，并且稳定 DOM 规则能够解决时，才 patch `manifest.json` 的 `match` 与 `runtime.entry_path` 并新增 JS 入口。',
    '- runtime 入口按 async CommonJS-like 函数体运行，可 `return { methods... }` 或赋值 `module.exports`；本地 helper 使用 `await require("./helper.js")`。在 `SKILL.md` 写明导出方法、输入和调用示例。',
    '- runtime 验证使用 `js_runtime_execute`，直接在其 code 中写 `return await $invoke("<skill-name>", "methodName", args);`。若目标 skill 尚未挂载，runtime 会按名称自动挂载并继续调用，不需要预先执行 `mount_on_current_page`。',
    '- 当前没有独立的 skill validator。保存时的结构校验不能代替内容验证；必须通过 read/list/search 回读和真实任务测试完成检查。',
    '- 不存在“patch 太大就自动拆分”、context 不匹配就整文件覆盖、忽略错误 hunk 或自动改用 Add File 的隐式行为。可以主动拆成多次调用，但每次调用都必须独立正确，并且只在完整验证后提交一次。',
    '- 若当前运行端明确提供独立代理、新会话或其他模型复核能力，可用原始任务和产物做前向测试；不要提供预期答案或拟定修复。会耗时、需要额外授权或可能改动真实系统时先征得用户同意。',
    '- 是否启用放在最后：guidance 的 `enable_skill` 只让它进入显式 skill_registry 可见列表，不会自动执行或进入隐藏上下文；page runtime skill 完成验证后启用即可，正常调用由 `$invoke` 自动处理挂载。`mount_on_current_page` 只用于显式重挂载或诊断。',
    '- 自动隐藏上下文只包含当前 URL 匹配的 page runtime skill 摘要；内置和普通 guidance skill 通过 `skill_registry` 显式发现和读取。',
    '',
    '## 常见错误',
    '- 把所有触发规则留在正文，导致模型只看到 summary 时无法判断是否该读 skill。',
    '- 修改 `SKILL.md` description 却不更新 `manifest.json.description`，或修改 UI 元数据却只写进普通文件。',
    '- 为了显得完整而创建额外文档、深层 reference 树、大量空占位文件或未验证的 speculative runtime。',
    '- 把所有细节塞进 `SKILL.md`，或在 `SKILL.md` 和 references 重复同一内容。',
    '- 把 scripts 当成可直接运行的 Python/Bash，或没有实际执行就声称脚本已经验证。',
    '- 前向测试时把预期答案、已知 bug 或修复方案告诉验证者，得到失真的成功结果。',
    '- 修改已有 skill 时整体重写整包，而不是先 search/read，再用 apply_patch 精确增量修改。',
    '- 用整份旧 scaffold 作为 `Update File` context，或把 preview 当成已写入；这两种做法都会把版本漂移隐藏到提交阶段。',
    '- 未完成内容验证就 enable，或把 `mount_on_current_page` 误当成调用 runtime 方法前的必需步骤。'
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
    description: 'Guide for creating, updating, repairing, splitting, or evaluating Cerebr skills with concise trigger metadata, progressive disclosure, reusable resources, and validation.',
    interface: {
      display_name: 'Skill Creator',
      short_description: '创建、更新和验证 Cerebr skill 的内置指导',
      default_prompt: 'Create or update a Cerebr skill from concrete trigger examples, keep the package minimal, and validate it before enabling.'
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
    updated_at: '2026-08-30T00:00:00.000Z',
    revision: 4
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
    short_description: '创建、更新或验证 skill 时，先读这条内置指导，再规划最小文件集、验证方式和 runtime 边界。',
    instruction_path: 'SKILL.md'
  };
}
