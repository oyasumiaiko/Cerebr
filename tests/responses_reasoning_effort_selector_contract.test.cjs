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
  assert.match(sidebarHtml, /id="reasoning-effort-button"[\s\S]*fa-solid fa-brain/);
  assert.match(
    sidebarHtml,
    /id="reasoning-effort-slider"[^>]*type="range"[^>]*min="0"[^>]*max="7"[^>]*step="1"[^>]*value="0"/
  );
});

test('侧栏事件把 default 加七个官方档位绑定到当前会话实际使用的 Responses 配置', async () => {
  const apiSettingsSource = await readWorkspaceFile('src/api/api_settings.js');
  const appContextSource = await readWorkspaceFile('src/ui/sidebar/sidebar_app_context.js');
  const sidebarEventsSource = await readWorkspaceFile('src/ui/sidebar/sidebar_events.js');

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
  assert.match(sidebarEventsSource, /const reasoningEffortOptions = \[[\s\S]*'default'[\s\S]*getResponsesReasoningEffortOptions/);
  assert.match(sidebarEventsSource, /reasoningEffortOptions\.map[\s\S]*reasoning-effort-dot/);
  assert.match(apiSettingsSource, /rawEffort === 'default'[\s\S]*deleteNestedValue\(nextSettings, \['reasoning', 'effort'\]\)/);
  assert.match(apiSettingsSource, /reasoningEffortSaveQueue = reasoningEffortSaveQueue[\s\S]*\.then\(\(\) => saveAPIConfigs\(\)\)/);
});

test('推理强度面板通过 hover 与键盘焦点平滑向左展开并保留吸附点', async () => {
  const sidebarCss = await readWorkspaceFile('src/ui/styles/sidebar.css');

  assert.match(sidebarCss, /\.reasoning-effort-slider-panel\s*\{[\s\S]*position:\s*absolute[\s\S]*right:\s*34px[\s\S]*width:\s*0/);
  assert.match(
    sidebarCss,
    /\.reasoning-effort-control:hover \.reasoning-effort-slider-panel,[\s\S]*\.reasoning-effort-control:focus-within \.reasoning-effort-slider-panel[\s\S]*width:\s*176px/
  );
  assert.match(sidebarCss, /width 230ms cubic-bezier\(0\.22, 1, 0\.36, 1\)/);
  assert.match(sidebarCss, /\.reasoning-effort-dots[\s\S]*justify-content:\s*space-between/);
  assert.match(sidebarCss, /#reasoning-effort-slider[\s\S]*-webkit-appearance:\s*none/);
  assert.match(sidebarCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*reasoning-effort-slider-panel/);
});
