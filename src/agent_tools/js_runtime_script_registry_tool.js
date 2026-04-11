/**
 * 兼容层：
 * - 旧实现把浏览器微型 skill 叫作 `js_runtime_script_registry`；
 * - 新实现已经收敛为 `micro_skill_registry`；
 * - 这里保留一轮别名导出，避免当前仓库里仍引用旧文件路径或旧符号名的代码立刻断裂。
 */

export * from './micro_skill_registry_tool.js';

export {
  MICRO_SKILL_REGISTRY_TOOL_NAME as JS_RUNTIME_SCRIPT_REGISTRY_TOOL_NAME,
  MICRO_SKILL_REGISTRY_STORAGE_KEY as JS_RUNTIME_SCRIPT_REGISTRY_STORAGE_KEY,
  buildMicroSkillRegistryFunctionToolDefinition as buildJsRuntimeScriptRegistryFunctionToolDefinition,
  normalizeMicroSkillRegistryToolArguments as normalizeJsRuntimeScriptRegistryArguments
} from './micro_skill_registry_tool.js';
