const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadMicroSkillContextModule() {
  const filePath = path.resolve(__dirname, '../src/utils/micro_skill_context.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('resolveMicroSkillContextAttachment 只注入摘要并在签名不变时跳过重复注入', async () => {
  const {
    buildMicroSkillContextPayload,
    buildMicroSkillContextInputItems,
    resolveMicroSkillContextAttachment
  } = await loadMicroSkillContextModule();

  const payload = buildMicroSkillContextPayload({
    mode: 'host_page',
    url: 'https://example.com/app',
    skills: [
      {
        name: 'skill-creator',
        kind: 'builtin_guidance',
        priority: 0,
        display_name: 'Skill Creator',
        short_description: '创建或更新微型 skill 时先读的内置指导 skill',
        default_prompt: 'Read built-in skill creator detail first.',
        mount_surface: 'Instruction-only skill.'
      },
      {
        name: 'dom-probe',
        kind: 'page_runtime',
        display_name: 'DOM Probe',
        short_description: '读取页面标题和 URL',
        default_prompt: 'Read the current page title and URL.',
        mount_surface: 'globalThis.__cerebrMicroSkills.skills["dom-probe"]'
      }
    ]
  });

  const items = buildMicroSkillContextInputItems(payload);
  assert.equal(items.length, 1);
  const text = items[0].content[0].text;
  assert.match(text, /<micro_skill_context/);
  assert.match(text, /<kind>builtin_guidance<\/kind>/);
  assert.match(text, /DOM Probe/);
  assert.ok(text.indexOf('Skill Creator') < text.indexOf('DOM Probe'));
  assert.doesNotMatch(text, /source\.code/);

  const first = resolveMicroSkillContextAttachment({ payload, previousEffectiveSignature: '' });
  assert.ok(first.signature);
  assert.equal(first.inputItems.length, 1);

  const second = resolveMicroSkillContextAttachment({
    payload,
    previousEffectiveSignature: first.signature
  });
  assert.equal(second.signature, null);
  assert.equal(second.inputItems, null);
});

test('空 skill 集只在需要覆盖旧签名时注入', async () => {
  const {
    buildMicroSkillContextPayload,
    resolveMicroSkillContextAttachment
  } = await loadMicroSkillContextModule();

  const emptyPayload = buildMicroSkillContextPayload({
    mode: 'host_page',
    url: 'https://example.com/app',
    skills: []
  });

  const first = resolveMicroSkillContextAttachment({
    payload: emptyPayload,
    previousEffectiveSignature: ''
  });
  assert.equal(first.signature, null);
  assert.equal(first.inputItems, null);

  const second = resolveMicroSkillContextAttachment({
    payload: emptyPayload,
    previousEffectiveSignature: 'old-signature'
  });
  assert.ok(second.signature);
  assert.equal(second.inputItems.length, 1);
});

test('allow_implicit_invocation=false 的摘要不会进入 micro_skill_context', async () => {
  const {
    buildMicroSkillContextPayload,
    buildMicroSkillContextInputItems
  } = await loadMicroSkillContextModule();

  const payload = buildMicroSkillContextPayload({
    mode: 'host_page',
    url: 'https://example.com/app',
    skills: [
      {
        name: 'hidden-skill',
        kind: 'page_runtime',
        display_name: 'Hidden Skill',
        short_description: 'This hidden skill should not appear in injected context.',
        default_prompt: 'Use $hidden-skill to do something.',
        allow_implicit_invocation: false,
        mount_surface: 'globalThis.__cerebrMicroSkills.skills["hidden-skill"]'
      }
    ]
  });

  const items = buildMicroSkillContextInputItems(payload);
  const text = items[0].content[0].text;
  assert.doesNotMatch(text, /hidden-skill/);
});
