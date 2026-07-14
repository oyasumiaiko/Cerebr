/**
 * Responses 本地扩展工具的定义注册表。
 *
 * 这个模块只负责把三类纯信息组合起来：
 * - `responses_extension_tools.js` 中稳定、可供设置 UI 读取的声明式 manifest；
 * - 各工具目录内真正的 Responses function definition builder；
 * - 当前请求的页面工具环境与 JS Runtime 可用性。
 *
 * 执行器仍保留在 `message_sender.js` 的闭包中。本模块不依赖 sender、UI、storage
 * 或具体服务实例，避免为了集中注册信息而引入反向依赖或循环引用。
 */

import { RESPONSES_EXTENSION_TOOL_SPECS } from '../../api/responses_extension_tools.js';
import {
  JS_RUNTIME_EXECUTE_TOOL_NAME,
  buildJsRuntimeExecuteFunctionToolDefinition
} from '../js_runtime_execute/tool.js';
import {
  PAGE_CONTENT_READ_TOOL_NAME,
  buildPageContentReadFunctionToolDefinition
} from '../page_content_read/tool.js';
import {
  PDF_CONTENT_READ_TOOL_NAME,
  buildPdfContentReadFunctionToolDefinition
} from '../pdf_content_read/tool.js';
import {
  WEBPAGE_SCREENSHOT_TOOL_NAME,
  buildWebpageScreenshotFunctionToolDefinition
} from '../webpage_screenshot/tool.js';
import {
  VIEW_IMAGE_TOOL_NAME,
  buildViewImageFunctionToolDefinition
} from '../view_image/tool.js';
import {
  HISTORY_READ_TOOL_NAME,
  HISTORY_SEARCH_TOOL_NAME,
  buildHistoryReadFunctionToolDefinition,
  buildHistorySearchFunctionToolDefinition
} from '../chat_history/tool.js';
import {
  ASK_OTHER_AI_TOOL_NAME,
  LIST_ASKABLE_MODELS_TOOL_NAME,
  buildAskOtherAiFunctionToolDefinition,
  buildListAskableModelsFunctionToolDefinition
} from '../ask_other_ai/tool.js';
import {
  REQUEST_USER_INPUT_TOOL_NAME,
  buildRequestUserInputFunctionToolDefinition
} from '../request_user_input/tool.js';
import {
  SKILL_REGISTRY_TOOL_NAME,
  buildSkillRegistryFunctionToolDefinition
} from '../skill/registry_tool.js';
import {
  CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME,
  CONVERSATION_DOCUMENT_COPY_FILE_TOOL_NAME,
  CONVERSATION_DOCUMENT_DELETE_FILE_TOOL_NAME,
  CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME,
  CONVERSATION_DOCUMENT_MOVE_FILE_TOOL_NAME,
  CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME,
  CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME,
  buildVirtualFileApplyPatchFunctionToolDefinition,
  buildVirtualFileCopyFileFunctionToolDefinition,
  buildVirtualFileDeleteFileFunctionToolDefinition,
  buildVirtualFileListFilesFunctionToolDefinition,
  buildVirtualFileMoveFileFunctionToolDefinition,
  buildVirtualFileReadFileFunctionToolDefinition,
  buildVirtualFileSearchFilesFunctionToolDefinition
} from '../virtual_file_io/index.js';

/**
 * definition builder 统一接收同一个纯上下文对象，避免调用方重新知道哪些工具需要
 * `pageToolEnvironment`、哪些工具没有参数。
 */
export const definitionBuildersById = Object.freeze({
  [JS_RUNTIME_EXECUTE_TOOL_NAME]: ({ pageToolEnvironment }) => (
    buildJsRuntimeExecuteFunctionToolDefinition(pageToolEnvironment)
  ),
  [CONVERSATION_DOCUMENT_APPLY_PATCH_TOOL_NAME]: () => buildVirtualFileApplyPatchFunctionToolDefinition(),
  [CONVERSATION_DOCUMENT_LIST_FILES_TOOL_NAME]: () => buildVirtualFileListFilesFunctionToolDefinition(),
  [CONVERSATION_DOCUMENT_READ_FILE_TOOL_NAME]: () => buildVirtualFileReadFileFunctionToolDefinition(),
  [CONVERSATION_DOCUMENT_SEARCH_FILES_TOOL_NAME]: () => buildVirtualFileSearchFilesFunctionToolDefinition(),
  [CONVERSATION_DOCUMENT_COPY_FILE_TOOL_NAME]: () => buildVirtualFileCopyFileFunctionToolDefinition(),
  [CONVERSATION_DOCUMENT_MOVE_FILE_TOOL_NAME]: () => buildVirtualFileMoveFileFunctionToolDefinition(),
  [CONVERSATION_DOCUMENT_DELETE_FILE_TOOL_NAME]: () => buildVirtualFileDeleteFileFunctionToolDefinition(),
  [SKILL_REGISTRY_TOOL_NAME]: ({ pageToolEnvironment }) => (
    buildSkillRegistryFunctionToolDefinition(pageToolEnvironment)
  ),
  [REQUEST_USER_INPUT_TOOL_NAME]: () => buildRequestUserInputFunctionToolDefinition(),
  [VIEW_IMAGE_TOOL_NAME]: () => buildViewImageFunctionToolDefinition(),
  [LIST_ASKABLE_MODELS_TOOL_NAME]: () => buildListAskableModelsFunctionToolDefinition(),
  [ASK_OTHER_AI_TOOL_NAME]: () => buildAskOtherAiFunctionToolDefinition(),
  [HISTORY_SEARCH_TOOL_NAME]: ({ pageToolEnvironment }) => (
    buildHistorySearchFunctionToolDefinition(pageToolEnvironment)
  ),
  [HISTORY_READ_TOOL_NAME]: () => buildHistoryReadFunctionToolDefinition(),
  [WEBPAGE_SCREENSHOT_TOOL_NAME]: () => buildWebpageScreenshotFunctionToolDefinition(),
  [PDF_CONTENT_READ_TOOL_NAME]: () => buildPdfContentReadFunctionToolDefinition(),
  [PAGE_CONTENT_READ_TOOL_NAME]: () => buildPageContentReadFunctionToolDefinition()
});

/**
 * hosted `tool_search` 应按需加载的本地工具名称。
 *
 * 名单直接由 manifest 派生，新增或调整工具时不再需要同步维护 sender 内的第二份数组。
 */
export const RESPONSES_HOSTED_TOOL_SEARCH_SEARCHABLE_TOOL_NAMES = Object.freeze(
  RESPONSES_EXTENSION_TOOL_SPECS
    .filter(spec => spec?.deferLoading === true)
    .map(spec => spec.id)
);

/**
 * 判断 manifest 中的一把工具是否适合当前请求环境。
 *
 * @param {Object} spec
 * @param {{pageToolEnvironment?:Object|null, hasJsRuntime?:boolean}} [options]
 * @returns {boolean}
 */
export function isResponsesExtensionToolExposureAvailable(spec, options = {}) {
  const exposure = typeof spec?.exposure === 'string' ? spec.exposure.trim() : '';
  const pageToolEnvironment = options?.pageToolEnvironment || {};

  switch (exposure) {
    case 'always':
      return true;
    case 'js_runtime':
      return options?.hasJsRuntime === true;
    case 'host_page':
      return pageToolEnvironment?.exposeHostPageTools === true;
    case 'html_page':
      // 与旧 sender 的 `if PDF ... else if HTML ...` 保持一致：即使上游环境对象
      // 异常地同时打开两种读取能力，也只暴露语义更具体的 PDF 工具。
      return pageToolEnvironment?.exposePageContentTool === true
        && pageToolEnvironment?.exposePdfContentTool !== true;
    case 'pdf_page':
      return pageToolEnvironment?.exposePdfContentTool === true;
    default:
      throw new Error(`Responses 扩展工具 ${spec?.id || '(unknown)'} 使用了未知 exposure：${exposure || '(empty)'}`);
  }
}

/**
 * 按 manifest 的稳定顺序，为当前请求构造实际可暴露的 function definitions。
 *
 * 这里只判断运行环境是否具备能力；用户在 API 设置中显式关闭工具的过滤仍由
 * `filterResponsesExtensionFunctionTools` 统一处理。
 *
 * @param {{pageToolEnvironment?:Object|null, hasJsRuntime?:boolean}} [options]
 * @returns {Array<Object>}
 */
export function buildResponsesExtensionFunctionTools(options = {}) {
  const pageToolEnvironment = options?.pageToolEnvironment || null;
  const definitions = [];

  for (const spec of RESPONSES_EXTENSION_TOOL_SPECS) {
    if (!isResponsesExtensionToolExposureAvailable(spec, options)) continue;

    const builder = definitionBuildersById[spec.id];
    if (typeof builder !== 'function') {
      throw new Error(`Responses 扩展工具 ${spec.id} 缺少 function definition builder。`);
    }

    const definition = builder({ pageToolEnvironment });
    const definitionName = typeof definition?.name === 'string' ? definition.name.trim() : '';
    if (!definition || definition.type !== 'function' || definitionName !== spec.id) {
      throw new Error(`Responses 扩展工具 ${spec.id} 的 definition 与 manifest 不一致。`);
    }
    definitions.push(definition);
  }

  return definitions;
}
