import { PromptSettings } from '../../core/prompt_settings.js';
import { createChatHistoryManager } from '../../core/chat_history_manager.js';
import { createConversationRuntimeStore } from '../../core/conversation_runtime_store.js';
import { createMessageProcessor } from '../../core/message_processor.js';
import { createImageHandler } from '../../utils/image_handler.js';
import { createChatHistoryUI } from '../chat_history_ui.js';
import { createApiManager } from '../../api/api_settings.js';
import { createMessageSender } from '../../core/message_sender.js';
import { createSettingsManager } from '../settings_manager.js';
import { createContextMenuManager } from '../context_menu_manager.js';
import { createUIManager } from '../ui_manager.js';
import { createInputController } from '../input_controller.js';
import { createConversationDocumentComposer } from '../conversation_document_composer.js';
import { createSelectionThreadManager } from '../selection_thread_manager.js';
import { createConversationPresence } from '../../utils/conversation_presence.js';
import { applyStandaloneAdjustments } from './sidebar_app_context.js';

/**
 * 初始化侧边栏依赖的各类服务，并将实例挂载到 appContext。
 * 该流程维持原始初始化顺序，以确保服务之间的依赖关系不变。
 *
 * @param {ReturnType<import('./sidebar_app_context.js').createSidebarAppContext>} appContext - 侧边栏上下文对象。
 * @returns {Promise<void>} 初始化完成。
 */
export async function initializeSidebarServices(appContext) {
  const {
    chatHistory,
    addMessageToTree,
    addMessageToTreeWithOptions,
    getCurrentConversationChain,
    clearHistory,
    deleteMessage,
    insertMessageAfter
  } = createChatHistoryManager(appContext);
  appContext.services.chatHistoryManager = {
    chatHistory,
    addMessageToTree,
    addMessageToTreeWithOptions,
    getCurrentConversationChain,
    clearHistory,
    deleteMessage,
    insertMessageAfter
  };

  appContext.services.promptSettingsManager = new PromptSettings(appContext);
  appContext.services.settingsManager = createSettingsManager(appContext);
  appContext.services.imageHandler = createImageHandler(appContext);
  appContext.services.apiManager = createApiManager(appContext);
  appContext.services.conversationRuntimeStore = createConversationRuntimeStore();

  appContext.services.messageProcessor = createMessageProcessor(appContext);

  // 会话-标签页存在性：用于“聊天记录”面板标注“已在其它标签页打开”并提供跳转
  // 注意：需要在 chatHistoryUI 创建前初始化，便于其内部订阅快照并渲染右侧按钮
  appContext.services.conversationPresence = createConversationPresence(appContext);

  appContext.services.chatHistoryUI = createChatHistoryUI(appContext);
  appContext.services.inputController = createInputController(appContext);
  appContext.services.conversationDocumentComposer = createConversationDocumentComposer(appContext);

  appContext.services.messageSender = createMessageSender(appContext);
  appContext.services.messageSender.setCurrentConversationId(appContext.services.chatHistoryUI.getCurrentConversationId());
  if (appContext.state.isStandalone) {
    try {
      appContext.services.messageSender.enterTemporaryMode();
    } catch (error) {
      console.error('独立聊天页面初始化临时模式失败:', error);
    }
  }

  appContext.services.uiManager = createUIManager(appContext);
  appContext.services.contextMenuManager = createContextMenuManager(appContext);
  appContext.services.selectionThreadManager = createSelectionThreadManager(appContext);

  // 初始化 UI/上下文菜单管理器，确保后续事件注册时可立即使用。
  appContext.services.contextMenuManager.init();
  appContext.services.uiManager.init();
  appContext.services.selectionThreadManager.init();

  try {
    await appContext.utils.ensureApplyPatchRuntimeContract?.({ force: true });
  } catch (error) {
    // 错位状态已经由 appContext 显式渲染并禁用发送；初始化其它只读/UI 能力仍继续。
    console.error('apply_patch 运行时契约检查失败:', error);
  }

  await appContext.services.settingsManager.init();
  applyStandaloneAdjustments(appContext);

  appContext.services.apiManager.setupUIEventHandlers(appContext);
  await appContext.services.apiManager.init();
}
