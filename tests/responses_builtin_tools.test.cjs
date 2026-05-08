const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadResponsesBuiltinToolsModule() {
  const filePath = path.resolve(__dirname, '../src/api/responses_builtin_tools.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('RESPONSES_BUILTIN_TOOL_SPECS 以稳定顺序集中声明 Responses 内置工具', async () => {
  const { RESPONSES_BUILTIN_TOOL_SPECS } = await loadResponsesBuiltinToolsModule();

  assert.deepEqual(
    RESPONSES_BUILTIN_TOOL_SPECS.map(spec => spec.id),
    ['web_search', 'code_interpreter', 'image_generation', 'tool_search']
  );
});

test('buildResponsesBuiltinToolOverrides 会生成 web_search 的工具定义与 include', async () => {
  const {
    RESPONSES_WEB_SEARCH_SOURCE_INCLUDE,
    buildResponsesBuiltinToolOverrides
  } = await loadResponsesBuiltinToolsModule();

  assert.deepEqual(
    buildResponsesBuiltinToolOverrides({
      builtin_tools: {
        web_search: {
          enabled: true,
          external_web_access: false,
          include_sources: true,
          filters: {
            allowed_domains: [' openai.com ', 'openai.com', '', 'developers.openai.com']
          },
          user_location: {
            type: 'approximate',
            country: 'US',
            city: 'San Francisco'
          }
        }
      }
    }),
    {
      tools: [
        {
          type: 'web_search',
          external_web_access: false,
          filters: {
            allowed_domains: ['openai.com', 'developers.openai.com']
          },
          user_location: {
            type: 'approximate',
            country: 'US',
            city: 'San Francisco'
          }
        }
      ],
      include: [RESPONSES_WEB_SEARCH_SOURCE_INCLUDE]
    }
  );
});

test('buildResponsesBuiltinToolOverrides 会生成 code_interpreter 与 tool_search 的稳定工具定义', async () => {
  const { buildResponsesBuiltinToolOverrides } = await loadResponsesBuiltinToolsModule();

  assert.deepEqual(
    buildResponsesBuiltinToolOverrides({
      builtin_tools: {
        code_interpreter: { enabled: true },
        tool_search: { enabled: true }
      }
    }),
    {
      tools: [
        {
          type: 'code_interpreter',
          container: { type: 'auto' }
        },
        {
          type: 'tool_search'
        }
      ],
      include: []
    }
  );
});

test('buildResponsesBuiltinToolOverrides 会生成 image_generation 的稳定工具定义', async () => {
  const { buildResponsesBuiltinToolOverrides } = await loadResponsesBuiltinToolsModule();

  assert.deepEqual(
    buildResponsesBuiltinToolOverrides({
      builtin_tools: {
        image_generation: { enabled: true }
      }
    }),
    {
      tools: [
        {
          type: 'image_generation',
          output_format: 'png'
        }
      ],
      include: []
    }
  );
});
