const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const EXPECTED_MODEL_TOOL_NAMES = Object.freeze([
  'js_runtime_execute',
  'read_tool_output',
  'apply_patch',
  'list_files',
  'read_file',
  'search_files',
  'copy_file',
  'skill_registry',
  'request_user_input',
  'view_image',
  'list_askable_models',
  'ask_other_ai',
  'history_search',
  'history_read',
  'webpage_screenshot',
  'pdf_content_read',
  'page_content_read'
]);

function importSourceModule(relativePath) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  return import(pathToFileURL(filePath).href);
}

async function loadModelToolModules() {
  const [
    jsRuntime,
    readToolOutput,
    virtualFiles,
    skillRegistry,
    requestUserInput,
    viewImage,
    askOtherAi,
    chatHistory,
    webpageScreenshot,
    pdfContentRead,
    pageContentRead,
    pageToolEnvironment,
    extensionToolSpecs,
    extensionToolRegistry
  ] = await Promise.all([
    importSourceModule('src/agent_tools/js_runtime_execute/tool.js'),
    importSourceModule('src/agent_tools/read_tool_output/tool.js'),
    importSourceModule('src/agent_tools/virtual_file_io/index.js'),
    importSourceModule('src/agent_tools/skill/registry_tool.js'),
    importSourceModule('src/agent_tools/request_user_input/tool.js'),
    importSourceModule('src/agent_tools/view_image/tool.js'),
    importSourceModule('src/agent_tools/ask_other_ai/tool.js'),
    importSourceModule('src/agent_tools/chat_history/tool.js'),
    importSourceModule('src/agent_tools/webpage_screenshot/tool.js'),
    importSourceModule('src/agent_tools/pdf_content_read/tool.js'),
    importSourceModule('src/agent_tools/page_content_read/tool.js'),
    importSourceModule('src/agent_tools/shared/page_tool_environment.js'),
    importSourceModule('src/api/responses_extension_tools.js'),
    importSourceModule('src/agent_tools/shared/responses_extension_tool_registry.js')
  ]);

  return {
    jsRuntime,
    readToolOutput,
    virtualFiles,
    skillRegistry,
    requestUserInput,
    viewImage,
    askOtherAi,
    chatHistory,
    webpageScreenshot,
    pdfContentRead,
    pageContentRead,
    pageToolEnvironment,
    extensionToolSpecs,
    extensionToolRegistry
  };
}

function buildAllModelToolDefinitions(modules, pageToolEnvironment = null) {
  const {
    jsRuntime,
    readToolOutput,
    virtualFiles,
    skillRegistry,
    requestUserInput,
    viewImage,
    askOtherAi,
    chatHistory,
    webpageScreenshot,
    pdfContentRead,
    pageContentRead
  } = modules;

  return [
    jsRuntime.buildJsRuntimeExecuteFunctionToolDefinition(pageToolEnvironment),
    readToolOutput.buildReadToolOutputFunctionToolDefinition(),
    virtualFiles.buildVirtualFileApplyPatchCustomToolDefinition(),
    virtualFiles.buildVirtualFileListFilesFunctionToolDefinition(),
    virtualFiles.buildVirtualFileReadFileFunctionToolDefinition(),
    virtualFiles.buildVirtualFileSearchFilesFunctionToolDefinition(),
    virtualFiles.buildVirtualFileCopyFileFunctionToolDefinition(),
    skillRegistry.buildSkillRegistryFunctionToolDefinition(pageToolEnvironment),
    requestUserInput.buildRequestUserInputFunctionToolDefinition(),
    viewImage.buildViewImageFunctionToolDefinition(),
    askOtherAi.buildListAskableModelsFunctionToolDefinition(),
    askOtherAi.buildAskOtherAiFunctionToolDefinition(),
    chatHistory.buildHistorySearchFunctionToolDefinition(pageToolEnvironment),
    chatHistory.buildHistoryReadFunctionToolDefinition(),
    webpageScreenshot.buildWebpageScreenshotFunctionToolDefinition(),
    pdfContentRead.buildPdfContentReadFunctionToolDefinition(),
    pageContentRead.buildPageContentReadFunctionToolDefinition()
  ];
}

function indexDefinitionsByName(definitions) {
  return Object.fromEntries(definitions.map(definition => [definition.name, definition]));
}

function isObjectSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  if (schema.type === 'object') return true;
  return Array.isArray(schema.type) && schema.type.includes('object');
}

/**
 * Responses strict mode 对每一层对象都有相同要求，不能只验证最外层 parameters。
 * 这里递归覆盖属性、数组元素与组合 schema，防止后续新增嵌套参数时漏掉 required
 * 或重新放开 additionalProperties，导致服务端拒绝定义或模型产生未声明字段。
 */
function assertStrictObjectSchemaRecursively(schema, schemaPath) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;

  if (isObjectSchema(schema)) {
    assert.equal(
      schema.additionalProperties,
      false,
      `${schemaPath}.additionalProperties 必须为 false`
    );
    assert.ok(
      schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties),
      `${schemaPath}.properties 必须是对象`
    );
    assert.deepEqual(
      schema.required,
      Object.keys(schema.properties),
      `${schemaPath}.required 必须完整覆盖 properties`
    );

    for (const [propertyName, propertySchema] of Object.entries(schema.properties)) {
      assertStrictObjectSchemaRecursively(propertySchema, `${schemaPath}.properties.${propertyName}`);
    }
  }

  if (schema.items) {
    assertStrictObjectSchemaRecursively(schema.items, `${schemaPath}.items`);
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    if (!Array.isArray(schema[keyword])) continue;
    schema[keyword].forEach((childSchema, index) => {
      assertStrictObjectSchemaRecursively(childSchema, `${schemaPath}.${keyword}[${index}]`);
    });
  }
  for (const keyword of ['$defs', 'definitions']) {
    if (!schema[keyword] || typeof schema[keyword] !== 'object') continue;
    for (const [definitionName, childSchema] of Object.entries(schema[keyword])) {
      assertStrictObjectSchemaRecursively(childSchema, `${schemaPath}.${keyword}.${definitionName}`);
    }
  }
}

const NON_PORTABLE_FINE_TUNED_SCHEMA_KEYWORDS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'pattern'
]);

function assertPortableFineTunedSchemaRecursively(schema, schemaPath, options = {}) {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema)) {
    schema.forEach((item, index) => assertPortableFineTunedSchemaRecursively(item, `${schemaPath}[${index}]`));
    return;
  }
  for (const [key, value] of Object.entries(schema)) {
    assert.equal(
      options?.preservePropertyNames === true ? false : NON_PORTABLE_FINE_TUNED_SCHEMA_KEYWORDS.has(key),
      false,
      `${schemaPath}.${key} 不是 fine-tuned 模型可移植 strict schema 关键字`
    );
    assertPortableFineTunedSchemaRecursively(value, `${schemaPath}.${key}`, {
      preservePropertyNames: key === 'properties'
    });
  }
}

test('全部 17 个模型工具具有唯一稳定名称和可独立判读的描述', async () => {
  const modules = await loadModelToolModules();
  const definitions = buildAllModelToolDefinitions(modules);
  const names = definitions.map(definition => definition.name);

  assert.equal(definitions.length, 17);
  assert.deepEqual(names, EXPECTED_MODEL_TOOL_NAMES);
  assert.equal(new Set(names).size, definitions.length, '模型工具名称不得重复');

  for (const definition of definitions) {
    if (definition.name === 'apply_patch') {
      assert.equal(definition.type, 'custom');
      assert.deepEqual(Object.keys(definition).sort(), ['description', 'format', 'name', 'type']);
      assert.equal(definition.format.type, 'grammar');
      assert.equal(definition.format.syntax, 'lark');
      assert.match(definition.format.definition, /environment_id: "\*\*\* Environment ID: " filename LF/);
      continue;
    }
    assert.equal(definition.type, 'function', `${definition.name} 必须是 function tool`);
    assert.equal(definition.strict, true, `${definition.name} 必须启用 strict mode`);
    assert.match(definition.description, /(?:^|\n)用途：\S/u, `${definition.name} 缺少“用途”说明`);
    assert.match(definition.description, /(?:^|\n)返回：\S/u, `${definition.name} 缺少“返回”说明`);
    if (definition.name === 'js_runtime_execute') {
      assert.equal(definition.parameters.properties.max_output_chars, undefined);
      assert.match(definition.description, /最多 5000 个字符/);
      assert.match(definition.description, /\$toolOutput/);
      assert.match(definition.description, /不要对 JS 输出调用 read_tool_output/);
      continue;
    }
    if (definition.name === 'copy_file') {
      assert.equal(definition.parameters.properties.max_output_chars, undefined);
      continue;
    }
    assert.deepEqual(
      definition.parameters.properties.max_output_chars.type,
      ['integer', 'null'],
      `${definition.name} 缺少统一 max_output_chars 参数`
    );
    const expectedDefault = ['read_file', 'page_content_read'].includes(definition.name) ? 20000 : 5000;
    assert.match(
      definition.parameters.properties.max_output_chars.description,
      new RegExp(`null (?:时)?默认 ${expectedDefault}`)
    );
  }
});

test('统一输出控制参数会解析默认值、从业务参数剥离并严格校验', async () => {
  const { splitResponsesToolOutputControl } = await importSourceModule('src/agent_tools/shared/model_tool_contract.js');

  assert.deepEqual(splitResponsesToolOutputControl({ query: 'x', max_output_chars: 12000 }), {
    toolArgs: { query: 'x' },
    maxOutputChars: 12000
  });
  assert.deepEqual(splitResponsesToolOutputControl({ query: 'x', max_output_chars: null }), {
    toolArgs: { query: 'x' },
    maxOutputChars: 5000
  });
  assert.deepEqual(splitResponsesToolOutputControl({ query: 'x' }, { toolName: 'page_content_read' }), {
    toolArgs: { query: 'x' },
    maxOutputChars: 20000
  });
  assert.deepEqual(splitResponsesToolOutputControl({ path: 'x', max_output_chars: null }, { toolName: 'read_file' }), {
    toolArgs: { path: 'x' },
    maxOutputChars: 20000
  });
  assert.deepEqual(splitResponsesToolOutputControl({ max_output_chars: null }, { toolName: 'pdf_content_read' }), {
    toolArgs: {},
    maxOutputChars: 5000
  });
  assert.throws(
    () => splitResponsesToolOutputControl({ max_output_chars: 0 }),
    /必须是至少 256 的安全整数或 null/
  );
});

test('全部模型工具的每一层 object schema 都遵循 Responses strict 契约', async () => {
  const modules = await loadModelToolModules();
  const definitions = buildAllModelToolDefinitions(modules);

  for (const definition of definitions.filter(item => item.type === 'function')) {
    assertStrictObjectSchemaRecursively(definition.parameters, `${definition.name}.parameters`);
    assertPortableFineTunedSchemaRecursively(definition.parameters, `${definition.name}.parameters`);
  }
});

test('关键枚举保持闭合，范围与数量通过 description 暴露且不污染可移植 strict schema', async () => {
  const modules = await loadModelToolModules();
  const definitions = indexDefinitionsByName(buildAllModelToolDefinitions(modules));
  const propertiesOf = name => definitions[name].parameters.properties;

  assert.match(propertiesOf('js_runtime_execute').timeout_ms.description, /正整数/);
  assert.match(propertiesOf('js_runtime_execute').frame_ids.description, /非负 frame ID/);

  for (const name of [
    'list_files',
    'read_file',
    'search_files',
    'copy_file'
  ]) {
    assert.deepEqual(
      propertiesOf(name).environment_id.type,
      ['string', 'null'],
      `${name}.environment_id 的选择器类型发生漂移`
    );
    assert.match(propertiesOf(name).environment_id.description, /skill:<stable-key>/);
    assert.equal(propertiesOf(name).target, undefined);
    assert.doesNotMatch(JSON.stringify(definitions[name]), /workspace/i);
  }
  assert.doesNotMatch(JSON.stringify(definitions.apply_patch), /workspace/i);

  assert.equal(propertiesOf('read_file').max_chars, undefined);
  assert.match(propertiesOf('search_files').context_lines.description, /0-20/);
  assert.equal(propertiesOf('search_files').context, undefined);
  assert.equal(propertiesOf('search_files').limit, undefined);

  const requestQuestions = propertiesOf('request_user_input').questions;
  assert.match(requestQuestions.description, /1-3/);
  assert.match(requestQuestions.items.properties.id.description, /snake_case/);
  assert.match(requestQuestions.items.properties.options.description, /2-3/);

  assert.deepEqual(propertiesOf('view_image').detail.enum, ['original', null]);
  assert.deepEqual(propertiesOf('webpage_screenshot').detail.enum, ['original', null]);

  const askRequests = propertiesOf('ask_other_ai').requests;
  assert.match(askRequests.description, /至少 1 条/);
  assert.match(askRequests.description, /建议每批不超过 4 条/);

  assert.deepEqual(propertiesOf('history_search').scope.enum, ['message', 'session', null]);
  assert.deepEqual(
    propertiesOf('history_search').result_mode.enum,
    ['matches', 'metadata_only', null]
  );
  assert.match(propertiesOf('history_search').max_results.description, /1-100/);
  assert.match(propertiesOf('history_read').conv_ref.description, /1-based/);
  assert.equal(propertiesOf('pdf_content_read').max_chars, undefined);
  assert.equal(propertiesOf('page_content_read').max_chars, undefined);
  assert.equal(propertiesOf('history_read').read_full_messages, undefined);

  const skillProperties = propertiesOf('skill_registry');
  assert.deepEqual(
    skillProperties.action.enum,
    ['list', 'create_skill', 'delete_skill', 'enable_skill', 'disable_skill', 'mount_on_current_page']
  );
  assert.deepEqual(
    skillProperties.skill.properties.resources.items.enum,
    ['scripts', 'references', 'assets']
  );
});

test('js_runtime_execute 与 skill_registry 明确区分宿主页和隔离沙箱能力', async () => {
  const modules = await loadModelToolModules();
  const hostDefinitions = indexDefinitionsByName(buildAllModelToolDefinitions(modules));
  const isolatedDefinitions = indexDefinitionsByName(buildAllModelToolDefinitions(modules, {
    exposeHostPageTools: false
  }));

  const hostJs = hostDefinitions.js_runtime_execute;
  const isolatedJs = isolatedDefinitions.js_runtime_execute;
  assert.notEqual(hostJs.description, isolatedJs.description);
  assert.match(hostJs.description, /当前侧栏绑定网页/u);
  assert.match(hostJs.description, /DOM/u);
  assert.match(isolatedJs.description, /隔离沙箱/u);
  assert.match(isolatedJs.description, /不要用它读取当前网页/u);
  assert.notEqual(
    hostJs.parameters.properties.frame_ids.description,
    isolatedJs.parameters.properties.frame_ids.description
  );
  assert.deepEqual(hostJs.parameters.properties.frame_ids.type, ['array', 'null']);
  assert.equal(isolatedJs.parameters.properties.frame_ids.type, 'null');

  const hostHistory = hostDefinitions.history_search;
  const isolatedHistory = isolatedDefinitions.history_search;
  assert.deepEqual(hostHistory.parameters.properties.current_page_only.type, ['boolean', 'null']);
  assert.deepEqual(isolatedHistory.parameters.properties.current_page_only.enum, [false, null]);
  assert.match(isolatedHistory.description, /不能使用 current_page_only/);

  const hostSkill = hostDefinitions.skill_registry;
  const isolatedSkill = isolatedDefinitions.skill_registry;
  assert.notEqual(hostSkill.description, isolatedSkill.description);
  assert.match(hostSkill.description, /当前页可见/u);
  assert.match(isolatedSkill.description, /内置和 guidance Skill/u);
  assert.deepEqual(
    hostSkill.parameters.properties.action.enum,
    ['list', 'create_skill', 'delete_skill', 'enable_skill', 'disable_skill', 'mount_on_current_page']
  );
  assert.deepEqual(
    isolatedSkill.parameters.properties.action.enum,
    ['list', 'create_skill', 'delete_skill', 'enable_skill', 'disable_skill']
  );
});

test('统一 registry 与 17 个 definition builder 和 manifest 保持逐项一致', async () => {
  const modules = await loadModelToolModules();
  const {
    RESPONSES_EXTENSION_TOOL_SPECS
  } = modules.extensionToolSpecs;
  const {
    definitionBuildersById
  } = modules.extensionToolRegistry;
  const htmlEnvironment = modules.pageToolEnvironment.resolvePageToolEnvironment({
    isPdfPage: false
  });
  const directDefinitions = indexDefinitionsByName(
    buildAllModelToolDefinitions(modules, htmlEnvironment)
  );
  const manifestNames = RESPONSES_EXTENSION_TOOL_SPECS.map(spec => spec.id);
  const registryNames = Object.keys(definitionBuildersById);

  assert.deepEqual(manifestNames, EXPECTED_MODEL_TOOL_NAMES);
  assert.deepEqual(registryNames, EXPECTED_MODEL_TOOL_NAMES);
  assert.equal(new Set(registryNames).size, 17);

  for (const toolName of EXPECTED_MODEL_TOOL_NAMES) {
    const registryDefinition = definitionBuildersById[toolName]({
      pageToolEnvironment: htmlEnvironment
    });
    assert.equal(registryDefinition.name, toolName, `${toolName} definition.name 与 registry key 不一致`);
    assert.equal(
      registryDefinition.type,
      RESPONSES_EXTENSION_TOOL_SPECS.find(spec => spec.id === toolName).toolType,
      `${toolName} definition.type 与 manifest 不一致`
    );
    assert.deepEqual(
      registryDefinition,
      directDefinitions[toolName],
      `${toolName} registry builder 与工具模块公开 builder 发生漂移`
    );
  }
});

test('统一 registry 为 HTML、PDF 与隔离模式暴露精确且互斥的工具集合', async () => {
  const modules = await loadModelToolModules();
  const {
    buildResponsesExtensionTools
  } = modules.extensionToolRegistry;
  const {
    resolvePageToolEnvironment
  } = modules.pageToolEnvironment;
  const getExposedNames = pageToolEnvironment => buildResponsesExtensionTools({
    pageToolEnvironment,
    hasJsRuntime: true
  }).map(definition => definition.name);

  const htmlNames = getExposedNames(resolvePageToolEnvironment({
    isPdfPage: false
  }));
  assert.deepEqual(htmlNames, [
    'js_runtime_execute',
    'read_tool_output',
    'apply_patch',
    'list_files',
    'read_file',
    'search_files',
    'copy_file',
    'skill_registry',
    'request_user_input',
    'view_image',
    'list_askable_models',
    'ask_other_ai',
    'history_search',
    'history_read',
    'webpage_screenshot',
    'page_content_read'
  ]);

  const pdfNames = getExposedNames(resolvePageToolEnvironment({
    isPdfPage: true
  }));
  assert.deepEqual(pdfNames, [
    'js_runtime_execute',
    'read_tool_output',
    'apply_patch',
    'list_files',
    'read_file',
    'search_files',
    'copy_file',
    'skill_registry',
    'request_user_input',
    'view_image',
    'list_askable_models',
    'ask_other_ai',
    'history_search',
    'history_read',
    'webpage_screenshot',
    'pdf_content_read'
  ]);

  const isolatedNames = getExposedNames(resolvePageToolEnvironment({
    isTemporaryMode: true,
    isPdfPage: false
  }));
  assert.deepEqual(isolatedNames, [
    'js_runtime_execute',
    'read_tool_output',
    'apply_patch',
    'list_files',
    'read_file',
    'search_files',
    'copy_file',
    'skill_registry',
    'request_user_input',
    'view_image',
    'list_askable_models',
    'ask_other_ai',
    'history_search',
    'history_read'
  ]);

  assert.equal(htmlNames.includes('pdf_content_read'), false);
  assert.equal(pdfNames.includes('page_content_read'), false);
  assert.equal(isolatedNames.includes('webpage_screenshot'), false);
  assert.equal(isolatedNames.includes('page_content_read'), false);
  assert.equal(isolatedNames.includes('pdf_content_read'), false);
});

test('hosted tool_search 的 searchable names 完整派生自 deferLoading manifest', async () => {
  const modules = await loadModelToolModules();
  const {
    RESPONSES_EXTENSION_TOOL_SPECS
  } = modules.extensionToolSpecs;
  const {
    RESPONSES_HOSTED_TOOL_SEARCH_SEARCHABLE_TOOL_NAMES
  } = modules.extensionToolRegistry;
  const deferredManifestNames = RESPONSES_EXTENSION_TOOL_SPECS
    .filter(spec => spec.deferLoading === true && spec.toolType === 'function')
    .map(spec => spec.id);

  assert.deepEqual(
    RESPONSES_HOSTED_TOOL_SEARCH_SEARCHABLE_TOOL_NAMES,
    deferredManifestNames
  );
  assert.deepEqual(
    RESPONSES_HOSTED_TOOL_SEARCH_SEARCHABLE_TOOL_NAMES,
    [
      'js_runtime_execute',
      'copy_file',
      'skill_registry',
      'request_user_input',
      'view_image',
      'list_askable_models',
      'ask_other_ai',
      'history_search',
      'history_read',
      'webpage_screenshot',
      'pdf_content_read',
      'page_content_read'
    ]
  );
  assert.equal(
    new Set(RESPONSES_HOSTED_TOOL_SEARCH_SEARCHABLE_TOOL_NAMES).size,
    12
  );
});
