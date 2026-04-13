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
        priority: 0,
        display_name: 'Skill Creator',
        short_description: '创建或更新微型 skill 时先读的内置指导 skill',
        default_prompt: 'Read built-in skill creator detail first.',
        mount_surface: 'Instruction-only skill.'
      },
      {
        name: 'dom-probe',
        display_name: 'DOM Probe',
        short_description: '读取页面标题和 URL',
        default_prompt: 'Read the current page title and URL.',
        mount_surface: '$invoke("dom-probe", "read", { includeUrl: true })'
      }
    ]
  });

  const items = buildMicroSkillContextInputItems(payload);
  assert.equal(items.length, 1);
  const text = items[0].content[0].text;
  assert.match(text, /<micro_skill_context/);
  assert.doesNotMatch(text, /mode=/);
  assert.match(text, /DOM Probe/);
  assert.ok(text.indexOf('Skill Creator') < text.indexOf('DOM Probe'));
  assert.doesNotMatch(text, /source\.code/);
  assert.match(text, /\$invoke\(&quot;dom-probe&quot;/);

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
