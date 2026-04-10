const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function readWorkspaceFile(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return fs.readFile(filePath, 'utf8');
}

test('slash command hints 复用 composer accessory drawer，而不是独立静态面板', async () => {
  const sidebarHtmlSource = await readWorkspaceFile('src/ui/sidebar/sidebar.html');
  const sidebarAppContextSource = await readWorkspaceFile('src/ui/sidebar/sidebar_app_context.js');
  const sidebarEventsSource = await readWorkspaceFile('src/ui/sidebar/sidebar_events.js');
  const sidebarCssSource = await readWorkspaceFile('src/ui/styles/sidebar.css');

  assert.doesNotMatch(
    sidebarHtmlSource,
    /id="slash-command-hints"/
  );
  assert.doesNotMatch(
    sidebarAppContextSource,
    /slashCommandHints/
  );
  assert.match(
    sidebarAppContextSource,
    /appContext\.utils\.getComposerAccessoryRegion = getComposerAccessoryRegion;/
  );
  assert.match(
    sidebarAppContextSource,
    /appContext\.utils\.refreshComposerAccessoryLayout = refreshComposerAccessoryLayout;/
  );

  assert.match(
    sidebarEventsSource,
    /const getAccessoryHost = \(\) => \{/
  );
  assert.match(
    sidebarEventsSource,
    /panel = document\.createElement\('section'\);\s*panel\.className = 'composer-accessory-drawer composer-slash-command-panel';/s
  );
  assert.match(
    sidebarEventsSource,
    /surface\.className = 'composer-accessory-drawer-surface composer-slash-command-surface';/
  );
  assert.match(
    sidebarEventsSource,
    /command\.className = 'slash-command-hint-command';/
  );
  assert.match(
    sidebarEventsSource,
    /host\.appendChild\(panel\);/
  );
  assert.doesNotMatch(
    sidebarEventsSource,
    /const panel = appContext\.dom\.slashCommandHints;/
  );

  assert.match(
    sidebarCssSource,
    /\.composer-accessory-drawer \{/
  );
  assert.match(
    sidebarCssSource,
    /\.composer-slash-command-panel \{/
  );
  assert.match(
    sidebarCssSource,
    /\.composer-slash-command-surface \{/
  );
  assert.match(
    sidebarCssSource,
    /\.slash-command-hints-list \{[\s\S]*?max-height: 340px;/s
  );
  assert.match(
    sidebarCssSource,
    /\.slash-command-hint-item \{[\s\S]*?grid-template-columns: max-content minmax\(0, 1fr\);/s
  );
  assert.match(
    sidebarCssSource,
    /\.slash-command-hint-command \{/
  );
  assert.doesNotMatch(
    sidebarCssSource,
    /#slash-command-hints\s*\{/
  );
  assert.doesNotMatch(
    sidebarCssSource,
    /\.slash-command-hint-main \{/
  );
});
