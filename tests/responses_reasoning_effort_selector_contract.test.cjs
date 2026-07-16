const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  return fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

test('Responses 推理强度上拉菜单固定在输入框与文件按钮之间', async () => {
  const sidebarHtml = await readWorkspaceFile('src/ui/sidebar/sidebar.html');
  const messageInputIndex = sidebarHtml.indexOf('id="message-input"');
  const reasoningControlIndex = sidebarHtml.indexOf('id="reasoning-effort-control"');
  const documentButtonIndex = sidebarHtml.indexOf('id="document-button"');

  assert.ok(messageInputIndex >= 0);
  assert.ok(reasoningControlIndex > messageInputIndex);
  assert.ok(documentButtonIndex > reasoningControlIndex);
  assert.match(sidebarHtml, /id="reasoning-effort-button"[\s\S]*far fa-gauge-simple/);
  assert.doesNotMatch(sidebarHtml, /fa-brain/);
  assert.doesNotMatch(sidebarHtml, /fa-microchip-ai/);
  assert.match(sidebarHtml, /id="reasoning-effort-button"[^>]*aria-haspopup="menu"[^>]*aria-controls="reasoning-effort-menu"[^>]*aria-expanded="false"/);
  assert.match(sidebarHtml, /id="reasoning-effort-menu"[^>]*role="menu"[^>]*aria-label="推理强度"/);
  assert.doesNotMatch(sidebarHtml, /id="reasoning-effort-slider"/);
  assert.doesNotMatch(sidebarHtml, /id="reasoning-effort-dots"/);
});

test('设置默认显示四档且快捷菜单从官方全集动态组装可见档位', async () => {
  const apiSettingsSource = await readWorkspaceFile('src/api/api_settings.js');
  const appContextSource = await readWorkspaceFile('src/ui/sidebar/sidebar_app_context.js');
  const sidebarEventsSource = await readWorkspaceFile('src/ui/sidebar/sidebar_events.js');
  const settingsSource = await readWorkspaceFile('src/ui/settings_manager.js');

  for (const id of [
    'reasoning-effort-control',
    'reasoning-effort-button',
    'reasoning-effort-menu'
  ]) {
    assert.match(appContextSource, new RegExp(`getElementById\\('${id}'\\)`));
  }

  assert.match(
    appContextSource,
    /resolveComposerApiLabel[\s\S]*isResponsesApiConfig[\s\S]*getResponsesReasoningEffort[\s\S]*'default'[\s\S]*`\$\{fallbackName\}-\$\{effort\}`/
  );
  assert.match(
    sidebarEventsSource,
    /resolveActiveConversationApiConfig[\s\S]*displayConfig[\s\S]*setResponsesReasoningEffort\?\.\(displayConfig, effort, \{ persist: true \}\)/
  );
  assert.match(sidebarEventsSource, /reasoningControl\.hidden = !isResponsesConfig/);
  assert.match(apiSettingsSource, /RESPONSES_REASONING_EFFORT_OPTIONS = Object\.freeze\(\['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'\]\)/);
  assert.match(settingsSource, /responsesReasoningEffortSliderOptions:\s*\['low', 'medium', 'high', 'xhigh'\]/);
  assert.match(settingsSource, /key: 'responsesReasoningEffortSliderOptions'[\s\S]*type: 'multi_select_dropdown'[\s\S]*label: 'Responses 推理强度快捷菜单'[\s\S]*getResponsesReasoningEffortOptions/);
  assert.match(settingsSource, /placeholder: '选择快捷菜单显示的推理强度'/);
  assert.match(settingsSource, /normalizeResponsesReasoningEffortSliderOptions[\s\S]*officialOptions\.filter/);
  assert.match(sidebarEventsSource, /reasoningEffortOptions = \['default', \.\.\.visibleOfficialOptions\]/);
  assert.match(sidebarEventsSource, /configuredSet\.has\(effort\) \|\| effort === currentEffort/);
  assert.match(sidebarEventsSource, /settingsManager\?\.subscribe\?\.\(reasoningEffortSettingKey, updateAll\)/);
  assert.match(sidebarEventsSource, /reasoningEffortOptions\.flatMap[\s\S]*role', 'menuitemradio'[\s\S]*aria-checked[\s\S]*option\.tabIndex = effort === currentEffort \? 0 : -1[\s\S]*reasoning-effort-option-check/);
  assert.match(sidebarEventsSource, /index !== 0[\s\S]*reasoning-effort-divider[\s\S]*role', 'separator'/);
  assert.match(apiSettingsSource, /rawEffort === 'default'[\s\S]*deleteNestedValue\(nextSettings, \['reasoning', 'effort'\]\)/);
  assert.match(apiSettingsSource, /reasoningEffortSaveQueue = reasoningEffortSaveQueue[\s\S]*\.then\(\(\) => saveAPIConfigs\(\)\)/);
});

test('推理强度使用常规上拉菜单，并支持 hover、点击与键盘操作', async () => {
  const sidebarCss = await readWorkspaceFile('src/ui/styles/sidebar.css');
  const sidebarEventsSource = await readWorkspaceFile('src/ui/sidebar/sidebar_events.js');

  assert.match(sidebarCss, /#reasoning-effort-button\s*\{[\s\S]*width:\s*44px[\s\S]*padding:\s*12px[\s\S]*opacity:\s*0\.6/);
  assert.match(sidebarCss, /\.reasoning-effort-menu\s*\{[\s\S]*position:\s*absolute[\s\S]*right:\s*0[\s\S]*bottom:\s*calc\(100% \+ 6px\)[\s\S]*min-width:\s*132px/);
  assert.match(sidebarCss, /\.reasoning-effort-menu\s*\{[\s\S]*opacity:\s*0[\s\S]*visibility:\s*hidden[\s\S]*pointer-events:\s*none[\s\S]*transform:\s*translateY\(4px\)/);
  assert.match(sidebarCss, /\.reasoning-effort-control\.is-open \.reasoning-effort-menu[\s\S]*opacity:\s*1[\s\S]*visibility:\s*visible[\s\S]*pointer-events:\s*auto[\s\S]*transform:\s*translateY\(0\)/);
  assert.match(sidebarCss, /\.reasoning-effort-option\s*\{[\s\S]*width:\s*100%[\s\S]*font-family:\s*inherit[\s\S]*text-align:\s*left/);
  assert.match(sidebarCss, /\.reasoning-effort-option\.is-selected \.reasoning-effort-option-check[\s\S]*opacity:\s*0\.8/);
  assert.match(sidebarCss, /\.reasoning-effort-divider\s*\{[\s\S]*height:\s*1px[\s\S]*background:\s*color-mix/);
  assert.match(sidebarEventsSource, /addEventListener\('mouseenter', openReasoningEffortControl\)/);
  assert.match(sidebarEventsSource, /addEventListener\('mouseleave', closeReasoningEffortControl\)/);
  assert.match(sidebarEventsSource, /addEventListener\('focusout',[\s\S]*reasoningControl\.contains\(nextTarget\)[\s\S]*closeReasoningEffortControl\(\)/);
  assert.match(sidebarEventsSource, /reasoningMenu\?\.addEventListener\('click',[\s\S]*selectReasoningEffort\(option\.dataset\.effort \|\| ''\)[\s\S]*closeReasoningEffortControl\(\)/);
  assert.match(sidebarEventsSource, /event\.key !== 'Escape'[\s\S]*closeReasoningEffortControl\(\)[\s\S]*focusReasoningEffortButton\(\)/);
  assert.match(sidebarEventsSource, /focusReasoningEffortButton[\s\S]*setTimeout[\s\S]*reasoningButton\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(sidebarEventsSource, /event\.key === 'Enter' \|\| event\.key === ' '[\s\S]*focusCurrentReasoningEffortOption\(\)/);
  assert.match(sidebarEventsSource, /focusReasoningEffortOption[\s\S]*item\.tabIndex = item === option \? 0 : -1[\s\S]*option\.focus\(\)/);
  assert.match(sidebarEventsSource, /event\.key !== 'ArrowUp' && event\.key !== 'ArrowDown'[\s\S]*focusReasoningEffortOption\(options\[\(currentIndex \+ direction \+ options\.length\) % options\.length\]\)/);
  assert.match(sidebarCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*reasoning-effort-menu/);
});
