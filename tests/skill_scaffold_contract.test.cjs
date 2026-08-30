const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadSkillScaffoldModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/skill/skill_scaffold.js');
  return import(`${pathToFileURL(filePath).href}?test=${Date.now()}`);
}

async function loadBuiltinSkillCreatorModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/skill/builtin_creator.js');
  return import(`${pathToFileURL(filePath).href}?test=${Date.now()}`);
}

test('通用 skill scaffold 的 scripts 示例已适配为 js_runtime_execute 代码片段', async () => {
  const {
    buildDefaultSkillMountContract,
    buildSkillScaffoldFiles,
    buildSkillScaffoldNextSteps
  } = await loadSkillScaffoldModule();

  const files = buildSkillScaffoldFiles({
    skillName: 'example-skill',
    displayName: 'Example Skill',
    description: 'Explain when this skill should be used.',
    resources: ['scripts'],
    examples: true
  });

  const scriptFile = files.find((file) => file.path === 'scripts/example.js') || null;
  assert.ok(scriptFile);
  assert.match(scriptFile.content, /js_runtime_execute/);
  assert.match(scriptFile.content, /async function body/);
  assert.doesNotMatch(scriptFile.content, /python3/i);
  assert.doesNotMatch(scriptFile.content, /if __name__ == "__main__"/);

  const instruction = files.find((file) => file.path === 'SKILL.md') || null;
  assert.ok(instruction);
  const frontmatter = instruction.content.match(/^---\n([\s\S]*?)\n---/u)?.[1] || '';
  assert.match(frontmatter, /^name:/m);
  assert.match(frontmatter, /^description:/m);
  assert.doesNotMatch(frontmatter, /^metadata:/m);
  assert.match(instruction.content, /js_runtime_execute/);
  assert.match(instruction.content, /under 500 lines/);
  assert.match(instruction.content, /README\.md/);
  assert.doesNotMatch(instruction.content, /Python, Bash/);
  assert.doesNotMatch(instruction.content, /run directly/);

  const assetFiles = buildSkillScaffoldFiles({
    skillName: 'example-skill',
    displayName: 'Example Skill',
    description: 'Explain when this skill should be used.',
    resources: ['assets'],
    examples: true
  });
  const assetFile = assetFiles.find((file) => file.path === 'assets/example_asset.txt') || null;
  assert.ok(assetFile);
  assert.match(assetFile.content, /edited as text/);
  assert.match(assetFile.content, /Do not use apply_patch to fabricate binary/);

  const mountContract = buildDefaultSkillMountContract();
  assert.match(mountContract, /only available inside `js_runtime_execute`/);
  assert.match(mountContract, /return await \$invoke\("skill-name", "methodName", args\)/);
  assert.match(mountContract, /mounts it automatically/);
  assert.match(mountContract, /not a prerequisite for `\$invoke`/);

  const nextSteps = buildSkillScaffoldNextSteps({ resources: ['scripts'], examples: true });
  assert.equal(nextSteps.some((step) => /manifest\.json\.description/.test(step)), true);
  assert.equal(nextSteps.some((step) => /Forward-test complex skills/.test(step)), true);
  assert.equal(nextSteps.some((step) => /no separate mount step is required/.test(step)), true);
});

test('内置 skill-creator 指导不再把 scripts 描述成 shell 或 python 可直接运行入口', async () => {
  const { buildBuiltinSkillCreatorRecord } = await loadBuiltinSkillCreatorModule();
  const record = buildBuiltinSkillCreatorRecord();
  const instructionFile = record.files.find((file) => file.path === 'SKILL.md') || null;
  assert.ok(instructionFile);
  const frontmatter = instructionFile.content.match(/^---\n([\s\S]*?)\n---/u)?.[1] || '';
  assert.doesNotMatch(frontmatter, /^metadata:/m);
  assert.equal(instructionFile.content.split('\n').length < 500, true);
  assert.match(instructionFile.content, /js_runtime_execute/);
  assert.match(instructionFile.content, /高自由度文字指导/);
  assert.match(instructionFile.content, /500 行以内/);
  assert.match(instructionFile.content, /超过 100 行的 reference/);
  assert.match(instructionFile.content, /README\.md/);
  assert.match(instructionFile.content, /预期答案、已知 bug 或拟定修复/);
  assert.match(instructionFile.content, /最长 64 个字符/);
  assert.match(instructionFile.content, /manifest\.json\.interface/);
  assert.match(instructionFile.content, /缺省为 null/);
  assert.match(instructionFile.content, /当前 URL 匹配的 page runtime skill/);
  assert.match(instructionFile.content, /guidance skill 没有单独的执行 action/);
  assert.match(instructionFile.content, /至少用 2-3 个有代表性的真实请求/);
  assert.match(instructionFile.content, /await require\("\.\/helper\.js"\)/);
  assert.match(instructionFile.content, /只让它进入显式 skill_registry 可见列表/);
  assert.match(instructionFile.content, /return await \$invoke\("<skill-name>", "methodName", args\)/);
  assert.match(instructionFile.content, /不需要预先执行 `mount_on_current_page`/);
  assert.match(instructionFile.content, /正常调用由 `\$invoke` 自动处理挂载/);
  assert.match(instructionFile.content, /不是可直接运行的 Python、Bash 或 shell 入口/);
  assert.match(instructionFile.content, /整体替换默认 `SKILL\.md`，显式使用 `\*\*\* Add File: SKILL\.md`/);
  assert.match(instructionFile.content, /多个 chunk 必须按源文件从上到下排列/);
  assert.match(instructionFile.content, /流式 preview 不是成功证据/);
  assert.match(instructionFile.content, /不存在“patch 太大就自动拆分”/);
  assert.doesNotMatch(instructionFile.content, /可执行辅助脚本/);
  assert.doesNotMatch(instructionFile.content, /init_skill\.py|generate_openai_yaml\.py|quick_validate\.py|\$CODEX_HOME|agents\/openai\.yaml/);
  assert.equal(record.revision, 4);
});
