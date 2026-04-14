const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadSkillScaffoldModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/micro_skill/skill_scaffold.js');
  return import(`${pathToFileURL(filePath).href}?test=${Date.now()}`);
}

async function loadBuiltinSkillCreatorModule() {
  const filePath = path.resolve(__dirname, '../src/agent_tools/micro_skill/builtin_creator.js');
  return import(`${pathToFileURL(filePath).href}?test=${Date.now()}`);
}

test('通用 skill scaffold 的 scripts 示例已适配为 js_runtime_execute 代码片段', async () => {
  const {
    buildDefaultMicroSkillMountContract,
    buildSkillScaffoldFiles
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
  assert.match(instruction.content, /js_runtime_execute/);
  assert.doesNotMatch(instruction.content, /Python, Bash/);
  assert.doesNotMatch(instruction.content, /run directly/);

  const mountContract = buildDefaultMicroSkillMountContract();
  assert.match(mountContract, /only available inside `js_runtime_execute`/);
  assert.match(mountContract, /return await \$invoke\("skill-name", "methodName", args\)/);
});

test('内置 skill-creator 指导不再把 scripts 描述成 shell 或 python 可直接运行入口', async () => {
  const { buildBuiltinSkillCreatorRecord } = await loadBuiltinSkillCreatorModule();
  const record = buildBuiltinSkillCreatorRecord();
  const instructionFile = record.files.find((file) => file.path === 'SKILL.md') || null;
  assert.ok(instructionFile);
  assert.match(instructionFile.content, /js_runtime_execute/);
  assert.match(instructionFile.content, /唯一可直接执行代码的路径/);
  assert.match(instructionFile.content, /return await \$invoke\("<skill-name>", "methodName", args\)/);
  assert.match(instructionFile.content, /不要把 `scripts\/` 里的文件当成 shell\/python 可直接执行命令/);
  assert.doesNotMatch(instructionFile.content, /可执行辅助脚本/);
});
