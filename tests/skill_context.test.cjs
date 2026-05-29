const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadSkillContextModule() {
  const filePath = path.resolve(__dirname, '../src/utils/skill_context.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('resolveSkillContextAttachment 只在首次页面命中时注入官方风格说明与最小 skill 摘要', async () => {
  const {
    buildSkillContextPayload,
    buildSkillContextInputItems,
    resolveSkillContextAttachment
  } = await loadSkillContextModule();

  const payload = buildSkillContextPayload({
    mode: 'host_page',
    url: 'https://example.com/app',
    skills: [
      {
        name: 'dom-probe',
        short_description: '读取页面标题和 URL',
        instruction_path: 'SKILL.md'
      },
      {
        name: 'link-reader',
        short_description: '读取当前页面链接列表',
        instruction_path: 'SKILL.md'
      }
    ]
  });

  const items = buildSkillContextInputItems(payload);
  assert.equal(items.length, 1);
  const text = items[0].content[0].text;
  assert.match(text, /<skill_context/);
  assert.match(text, /<how_to_use>/);
  assert.match(text, /Skills are local instructions stored in `SKILL\.md`\./);
  assert.match(text, /read that skill&apos;s `SKILL\.md` before using it\./i);
  assert.match(text, /<instruction_path>SKILL\.md<\/instruction_path>/);
  assert.doesNotMatch(text, /mode=/);
  assert.doesNotMatch(text, /<display_name>/);
  assert.doesNotMatch(text, /<default_prompt>/);
  assert.doesNotMatch(text, /<mount_surface>/);
  assert.doesNotMatch(text, /skill-creator/);
  assert.ok(text.indexOf('dom-probe') < text.indexOf('link-reader'));

  const first = resolveSkillContextAttachment({ payload, previousEffectiveSignature: '' });
  assert.ok(first.signature);
  assert.equal(first.inputItems.length, 1);

  const laterPayload = buildSkillContextPayload({
    mode: 'host_page',
    url: 'https://another.example.com/app',
    skills: [
      {
        name: 'another-page-skill',
        short_description: '读取另一个页面的状态',
        instruction_path: 'SKILL.md'
      }
    ]
  });
  const second = resolveSkillContextAttachment({
    payload: laterPayload,
    previousEffectiveSignature: first.signature
  });
  assert.equal(second.signature, null);
  assert.equal(second.inputItems, null);
  assert.equal(second.status, 'reused');
  assert.equal(second.reason, 'skill_context_already_injected');
});

test('空 skill 集始终不注入 skill_context', async () => {
  const {
    buildSkillContextPayload,
    buildSkillContextInputItems,
    resolveSkillContextAttachment
  } = await loadSkillContextModule();

  const emptyPayload = buildSkillContextPayload({
    mode: 'host_page',
    url: 'https://example.com/app',
    skills: []
  });

  assert.deepEqual(buildSkillContextInputItems(emptyPayload), []);

  const first = resolveSkillContextAttachment({
    payload: emptyPayload,
    previousEffectiveSignature: ''
  });
  assert.equal(first.signature, null);
  assert.equal(first.inputItems, null);
  assert.equal(first.status, 'empty');
  assert.equal(first.reason, 'no_matching_skills');

  const second = resolveSkillContextAttachment({
    payload: emptyPayload,
    previousEffectiveSignature: 'old-signature'
  });
  assert.equal(second.signature, null);
  assert.equal(second.inputItems, null);
  assert.equal(second.status, 'empty');
  assert.equal(second.reason, 'no_matching_skills');
});
