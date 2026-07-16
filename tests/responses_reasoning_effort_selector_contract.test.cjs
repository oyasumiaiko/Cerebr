const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  return fs.readFile(path.resolve(__dirname, '..', relativePath), 'utf8');
}

test('Responses 推理强度选择器固定在输入框与文件按钮之间', async () => {
  const sidebarHtml = await readWorkspaceFile('src/ui/sidebar/sidebar.html');
  const messageInputIndex = sidebarHtml.indexOf('id="message-input"');
  const reasoningControlIndex = sidebarHtml.indexOf('id="reasoning-effort-control"');
  const documentButtonIndex = sidebarHtml.indexOf('id="document-button"');

  assert.ok(messageInputIndex >= 0);
  assert.ok(reasoningControlIndex > messageInputIndex);
  assert.ok(documentButtonIndex > reasoningControlIndex);
  assert.match(sidebarHtml, /id="reasoning-effort-button"[\s\S]*fa-regular fa-microchip-ai/);
  assert.doesNotMatch(sidebarHtml, /fa-brain/);
  assert.match(
    sidebarHtml,
    /id="reasoning-effort-slider"[^>]*type="range"[^>]*min="0"[^>]*max="4"[^>]*step="1"[^>]*value="0"/
  );
});

test('设置默认显示四档且 slider 从官方全集动态组装可见档位', async () => {
  const apiSettingsSource = await readWorkspaceFile('src/api/api_settings.js');
  const appContextSource = await readWorkspaceFile('src/ui/sidebar/sidebar_app_context.js');
  const sidebarEventsSource = await readWorkspaceFile('src/ui/sidebar/sidebar_events.js');
  const settingsSource = await readWorkspaceFile('src/ui/settings_manager.js');

  for (const id of [
    'reasoning-effort-control',
    'reasoning-effort-button',
    'reasoning-effort-slider',
    'reasoning-effort-value',
    'reasoning-effort-dots'
  ]) {
    assert.match(appContextSource, new RegExp(`getElementById\\('${id}'\\)`));
  }

  assert.match(
    appContextSource,
    /resolveComposerApiLabel[\s\S]*isResponsesApiConfig[\s\S]*getResponsesReasoningEffort[\s\S]*'default'[\s\S]*`\$\{fallbackName\}-\$\{effort\}`/
  );
  assert.match(
    sidebarEventsSource,
    /resolveActiveConversationApiConfig[\s\S]*displayConfig[\s\S]*setResponsesReasoningEffort\?\.\(displayConfig, effort, \{ persist \}\)/
  );
  assert.match(sidebarEventsSource, /addEventListener\('input',[\s\S]*updateReasoningEffortFromSlider\(false\)/);
  assert.match(sidebarEventsSource, /addEventListener\('change',[\s\S]*updateReasoningEffortFromSlider\(true\)/);
  assert.match(sidebarEventsSource, /reasoningControl\.hidden = !isResponsesConfig/);
  assert.match(apiSettingsSource, /RESPONSES_REASONING_EFFORT_OPTIONS = Object\.freeze\(\['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'\]\)/);
  assert.match(settingsSource, /responsesReasoningEffortSliderOptions:\s*\['low', 'medium', 'high', 'xhigh'\]/);
  assert.match(settingsSource, /key: 'responsesReasoningEffortSliderOptions'[\s\S]*type: 'multi_select_dropdown'[\s\S]*getResponsesReasoningEffortOptions/);
  assert.match(settingsSource, /normalizeResponsesReasoningEffortSliderOptions[\s\S]*officialOptions\.filter/);
  assert.match(sidebarEventsSource, /const nextOptions = \['default', \.\.\.visibleOfficialOptions\]/);
  assert.match(sidebarEventsSource, /configuredSet\.has\(effort\) \|\| effort === currentEffort/);
  assert.match(sidebarEventsSource, /settingsManager\?\.subscribe\?\.\(reasoningEffortSettingKey, updateAll\)/);
  assert.match(sidebarEventsSource, /reasoningEffortOptions\.map[\s\S]*reasoning-effort-dot/);
  assert.match(apiSettingsSource, /rawEffort === 'default'[\s\S]*deleteNestedValue\(nextSettings, \['reasoning', 'effort'\]\)/);
  assert.match(apiSettingsSource, /reasoningEffortSaveQueue = reasoningEffortSaveQueue[\s\S]*\.then\(\(\) => saveAPIConfigs\(\)\)/);
});

test('面板按当前档位在鼠标处展开，文字置于上方并在离开时关闭', async () => {
  const sidebarCss = await readWorkspaceFile('src/ui/styles/sidebar.css');
  const sidebarEventsSource = await readWorkspaceFile('src/ui/sidebar/sidebar_events.js');

  assert.match(sidebarCss, /\.reasoning-effort-control\s*\{[\s\S]*--reasoning-effort-track-width:\s*16em[\s\S]*--reasoning-effort-panel-padding:\s*1\.8em[\s\S]*font-size:\s*var\(--cerebr-font-size/);
  assert.match(sidebarCss, /#reasoning-effort-button[\s\S]*font-size:\s*calc\(var\(--cerebr-font-size, 14px\) \* 1\.15\)/);
  assert.match(sidebarCss, /\.reasoning-effort-slider-panel\s*\{[\s\S]*left:\s*calc\(var\(--reasoning-effort-pointer-anchor\) - var\(--reasoning-effort-panel-padding\) - var\(--reasoning-effort-open-offset\)\)[\s\S]*clip-path:/);
  assert.match(sidebarCss, /\.reasoning-effort-control\.is-open \.reasoning-effort-slider-panel[\s\S]*clip-path:\s*inset\(0 round 999px\)/);
  assert.match(sidebarCss, /\.reasoning-effort-value\s*\{[\s\S]*left:\s*calc\(var\(--reasoning-effort-panel-padding\) \+ var\(--reasoning-effort-current-offset\)\)[\s\S]*bottom:\s*calc\(50% \+ 0\.72em\)/);
  assert.match(sidebarCss, /transparent var\(--reasoning-effort-official-start\)[\s\S]*var\(--reasoning-effort-progress\)/);
  assert.match(sidebarCss, /\.reasoning-effort-dot\.is-default\s*\{[\s\S]*background:\s*transparent/);
  assert.match(sidebarCss, /\.reasoning-effort-dots[\s\S]*justify-content:\s*space-between/);
  assert.match(sidebarCss, /#reasoning-effort-slider[\s\S]*-webkit-appearance:\s*none/);
  assert.match(sidebarEventsSource, /addEventListener\('pointerenter', openReasoningEffortControl\)/);
  assert.match(sidebarEventsSource, /addEventListener\('pointerleave', closeReasoningEffortControl\)/);
  assert.match(sidebarEventsSource, /document\.activeElement === reasoningSlider[\s\S]*reasoningSlider\.blur\(\)/);
  assert.match(sidebarCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*reasoning-effort-slider-panel/);
});
