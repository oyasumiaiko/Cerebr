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

test('resolveMicroSkillContextAttachment 只注入官方风格的全局说明与最小 skill 摘要，并在签名不变时跳过重复注入', async () => {
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
        short_description: '创建或更新 skill 时先读的内置指导 skill',
        instruction_path: 'SKILL.md'
      },
      {
        name: 'dom-probe',
        short_description: '读取页面标题和 URL',
        instruction_path: 'SKILL.md'
      }
    ]
  });

  const items = buildMicroSkillContextInputItems(payload);
  assert.equal(items.length, 1);
  const text = items[0].content[0].text;
  assert.match(text, /<micro_skill_context/);
  assert.match(text, /<how_to_use>/);
  assert.match(text, /Skills are local instructions stored in `SKILL\.md`\./);
  assert.match(text, /read that skill&apos;s `SKILL\.md` before using it\./i);
  assert.match(text, /<instruction_path>SKILL\.md<\/instruction_path>/);
  assert.doesNotMatch(text, /mode=/);
  assert.doesNotMatch(text, /<display_name>/);
  assert.doesNotMatch(text, /<default_prompt>/);
  assert.doesNotMatch(text, /<mount_surface>/);
  assert.ok(text.indexOf('skill-creator') < text.indexOf('dom-probe'));

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
  assert.match(second.inputItems[0].content[0].text, /<how_to_use>/);
});
