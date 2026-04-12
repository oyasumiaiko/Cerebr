const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadModule() {
  const modulePath = path.resolve(__dirname, '../src/utils/steer_window.js');
  return import(pathToFileURL(modulePath).href);
}

test('buildSteerWindowPreviewItems keeps accumulated steer order stable', async () => {
  const { buildSteerWindowPreviewItems } = await loadModule();

  const previewItems = buildSteerWindowPreviewItems([
    { id: 'steer_1', textPreview: 'first steer' },
    { id: 'steer_2', textPreview: 'second steer', imageCount: 1, hasScreenshot: true }
  ]);

  assert.deepEqual(previewItems, [
    { id: 'steer_1', text: 'first steer', imageCount: 0, hasScreenshot: false },
    { id: 'steer_2', text: 'second steer', imageCount: 1, hasScreenshot: true }
  ]);
});

test('buildSteerWindowMarkdown renders multiple steers as one ordered window', async () => {
  const { buildSteerWindowMarkdown } = await loadModule();

  const markdown = buildSteerWindowMarkdown([
    { id: 'steer_1', textPreview: 'first steer' },
    { id: 'steer_2', textPreview: 'second steer', imageCount: 2 }
  ]);

  assert.equal(markdown, '1. first steer\n2. second steer（2 图）');
});

test('buildMergedResponsesSteerInputItem merges multiple steer messages into one user message', async () => {
  const { buildMergedResponsesSteerInputItem } = await loadModule();

  const merged = buildMergedResponsesSteerInputItem([
    {
      responseInputItem: {
        type: 'message',
        role: 'user',
        content: 'first steer'
      }
    },
    {
      responseInputItem: {
        type: 'message',
        role: 'user',
        content: 'second steer'
      }
    }
  ]);

  assert.deepEqual(merged, {
    type: 'message',
    role: 'user',
    content: 'first steer\nsecond steer'
  });
});

test('buildMergedResponsesSteerInputItem preserves image and text part order inside one steer window', async () => {
  const { buildMergedResponsesSteerInputItem } = await loadModule();

  const merged = buildMergedResponsesSteerInputItem([
    {
      responseInputItem: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'https://example.com/one.png' },
          { type: 'input_text', text: 'first steer' }
        ]
      }
    },
    {
      responseInputItem: {
        type: 'message',
        role: 'user',
        content: 'second steer'
      }
    }
  ]);

  assert.deepEqual(merged, {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_image', image_url: 'https://example.com/one.png' },
      { type: 'input_text', text: 'first steer\nsecond steer' }
    ]
  });
});
