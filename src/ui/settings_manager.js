/**
 * 设置管理模块
 * 负责管理应用程序的所有用户界面设置，如主题、尺寸、字体大小等
 */

import { createThemeManager } from './theme_manager.js';
import { queueStorageSet, queueStoragePrime } from '../utils/storage_write_queue_bridge.js';
import {
  DEFAULT_AI_FOOTER_TEMPLATE,
  DEFAULT_AI_FOOTER_INLINE_SEPARATOR,
  DEFAULT_AI_FOOTER_TOOLTIP_TEMPLATE,
  AI_FOOTER_TEMPLATE_VARIABLES
} from '../utils/api_footer_template.js';
import {
  clampConversationDocumentFontSizePercent,
  DOCUMENT_VIEWER_SETTING_FONT_SIZE_PERCENT,
  DOCUMENT_VIEWER_SETTING_MODE_OVERRIDES,
  DOCUMENT_VIEWER_SETTING_RENDER_MARKDOWN_FOR_MD,
  normalizeConversationDocumentViewModeOverridesSetting
} from '../utils/conversation_document_viewer_state.js';
import { takeBackgroundImageBlob } from '../storage/background_image_blob_store.js';

const AI_FOOTER_SHARED_VARIABLE_PANEL_KEY = 'ai-footer-shared-variables';

/**
 * 创建设置管理器
 * @param {Object} appContext - 应用程序上下文对象
 * @param {HTMLElement} appContext.dom.themeSwitch - 主题切换开关元素
 * @param {HTMLElement} appContext.dom.themeSelect - 主题选择下拉框元素
 * @param {HTMLElement} appContext.dom.sidebarWidthSlider - 侧边栏宽度滑块元素
 * @param {HTMLElement} appContext.dom.widthValueDisplay - 宽度显示值元素
 * @param {HTMLElement} appContext.dom.fontSizeSlider - 字体大小滑块元素
 * @param {HTMLElement} appContext.dom.fontSizeValueDisplay - 字体大小显示值元素
 * @param {HTMLElement} appContext.dom.scaleFactorSlider - 缩放比例滑块元素
 * @param {HTMLElement} appContext.dom.scaleValueDisplay - 缩放比例显示值元素
 * @param {HTMLElement} appContext.dom.autoScrollSwitch - 自动滚动开关元素
 * @param {HTMLElement} appContext.dom.sidebarPositionSwitch - 侧边栏位置开关元素
 * @param {HTMLElement} appContext.dom.stopAtTopSwitch - 滚动到顶部时停止开关元素
 * @param {HTMLElement} appContext.dom.showThoughtProcessSwitch - 显示思考过程开关元素
 * @param {HTMLElement} appContext.dom.resetSettingsButton - 重置设置按钮元素
 * @param {HTMLElement} appContext.dom.settingsMenu - 侧栏“...”下拉菜单容器
 * @param {HTMLElement} appContext.dom.escSettingsMenu - Esc 面板内的设置容器
 * @param {HTMLElement} appContext.dom.settingsToggle - 设置面板切换按钮元素
 * @param {HTMLElement} appContext.dom.settingsBackButton - 设置面板返回按钮元素
 * @param {Function} appContext.services.uiManager.closeExclusivePanels - 关闭独占面板的函数
 * @returns {Object} 设置管理器实例
 */
export function createSettingsManager(appContext) {
  // 从options中提取UI元素
  const {
    dom,
    services,
    utils
  } = appContext;

  // UI elements from appContext.dom
  const themeSwitch = dom.themeSwitch;
  const themeSelect = dom.themeSelect;
  const sidebarWidthSlider = dom.sidebarWidth;
  const widthValueDisplay = dom.widthValue;
  const fontSizeSlider = dom.fontSize;
  const fontSizeValueDisplay = dom.fontSizeValue;
  const scaleFactorSlider = dom.scaleFactor;
  const scaleValueDisplay = dom.scaleValue;
  const autoScrollSwitch = dom.autoScrollSwitch;
  const autoRetrySwitch = dom.autoRetrySwitch;
  const sidebarPositionSwitch = dom.sidebarPositionSwitch;
  const stopAtTopSwitch = dom.stopAtTopSwitch;
  const showThoughtProcessSwitch = dom.showThoughtProcessSwitch;
  const resetSettingsButton = dom.resetSettingsButton;
  const settingsMenu = dom.settingsMenu;
  const settingsToggle = dom.settingsButton;
  const settingsBackButton = dom.settingsBackButton;
  const getEscSettingsMenu = () => dom.escSettingsMenu || document.getElementById('esc-settings-menu');
  const ensureEscSettingsMenu = () => {
    const existing = getEscSettingsMenu();
    if (existing) return existing;
    const container = document.createElement('div');
    container.id = 'esc-settings-menu';
    container.className = 'esc-settings-menu';
    dom.escSettingsMenu = container;
    return container;
  };

  // Services from appContext.services
  // 注意：settingsManager 早于 messageSender 创建，不能在这里捕获“当下值”。
  // 必须按需读取 services.messageSender，才能拿到后续初始化完成后的真实实例。
  const getMessageSender = () => services.messageSender;
  // const themeManagerService = services.themeManager; // If themeManager is a shared service
  const uiManager = services.uiManager; // For closeExclusivePanels

  // Utils
  const showNotification = utils.showNotification;
  const closeExclusivePanels = utils.closeExclusivePanels;

  // 创建主题管理器 (could be a service in appContext too)
  const themeManager = createThemeManager();
  const isStandalone = !!appContext?.state?.isStandalone;

  // 默认设置
  const DEFAULT_SETTINGS = {
    theme: 'auto',  // 默认为自动跟随系统
    sidebarWidth: 800,
    // 全屏模式下的“内容列宽度”（影响全屏布局下消息与输入框的最大宽度）
    // 说明：历史版本中全屏布局复用了 sidebarWidth；这里新增独立配置以便分别调整。
    fullscreenWidth: 800,
    fontSize: 14,
    documentFontSizePercent: 100,
    documentRenderMarkdownForMd: true,
    documentViewModeOverrides: {},
    renderMarkdownForUserMessages: false,
    showCodeBlockToolbar: true,
    collapseLongCodeBlocks: false,
    lineHeight: 1.5, // Added for better text readability control
    chatWidth: 100, // Percentage of sidebar width
    autoScroll: true,
    // 对话标题生成：默认关闭，避免未配置时触发额外请求
    autoGenerateConversationTitle: false,
    // 对话标题生成：是否覆盖总结类标题（保留[总结]前缀）
    autoGenerateTitleForSummary: true,
    // 对话标题生成：是否覆盖划词解释类标题（保留[划词解释]前缀）
    autoGenerateTitleForSelection: true,
    // 对话标题生成：默认跟随当前 API
    conversationTitleApi: 'follow_current',
    // ask_other_ai / list_askable_models 可见的 API 配置 ID 列表。
    // 这里单独放到偏好设置，避免把“全局工具可见性”误做成单张 API 卡片里的本地字段。
    askOtherAiEnabledApiIds: [],
    // 对话标题生成：默认提示词（用户可在设置中修改）
    conversationTitlePrompt: '请根据以下对话生成一个简短标题，尽量在20字以内，仅输出标题本身，不要任何前缀或引号。',
    // 是否在发送请求时回传 thoughtSignature 等签名字段（用于部分代理的推理校验/连续性）。
    // 说明：即使关闭该开关，Cerebr 仍会在接收响应时照常把 signature 存入历史，便于用户随时重新开启。
    shouldSendSignature: true,
    autoRetry: false,
    // 同一会话内若已有流式回复，后续发送默认进入 FIFO 队列；
    // 关闭后恢复为“中断当前会话生成并立即发送下一条”。
    queueCurrentConversationMessages: true,
    sidebarPosition: 'right', // 'left' 或 'right'
    stopAtTop: true, // 滚动到顶部时停止
    scaleFactor: 1, // Added default scaleFactor
    backgroundImageUrl: '',
    backgroundImageIntensity: 0.6,
    // 仅在“已有聊天消息”时追加到原图层(body::after)的模糊半径（单位 px）。
    // 0 表示关闭该效果。
    backgroundMessageBlurRadius: 0,
    fullscreenBackgroundCover: false,
    // 全屏模式下当聊天区已有消息时，是否隐藏背景“原图层”，仅保留氛围层。
    fullscreenHideOriginalOnChat: false,
    backgroundOverallOpacity: 1,
    // 全屏滚动迷你图（MiniMap）：显示开关、滚轮行为、宽度与透明度
    enableScrollMinimap: true,
    // 关闭时，鼠标悬停缩略图滚轮仍按聊天容器的原生像素滚动处理；
    // 开启后才恢复“一格滚轮跳到上一条/下一条消息”的导航语义。
    scrollMinimapWheelMessageStep: false,
    scrollMinimapWidth: 24,
    scrollMinimapOpacity: 0.94,
    scrollMinimapAutoHide: false,
    scrollMinimapMessageMode: 'proportional',
    // 在全屏/独立页面布局中隐藏原生滚动条（保留滚动能力）
    hideNativeScrollbarInFullscreen: false,
    // 是否启用 $ / $$ 作为数学公式分隔符（默认开启以保持兼容）
    enableDollarMath: true,
    // 是否在输入框 placeholder 中显示当前模型名
    showModelNameInPlaceholder: true,
    // Responses 输入区快捷菜单默认只展示最常用的四档；default 与其它档位一样
    // 由这份偏好控制，默认不显示。
    responsesReasoningEffortSliderOptions: ['low', 'medium', 'high', 'xhigh'],
    // AI 消息末尾的 API 元数据模板（支持 {{var}} 占位）
    aiFooterTemplate: DEFAULT_AI_FOOTER_TEMPLATE,
    // AI 消息尾注：仅在同一行内用于拼接非空片段的分隔符。
    aiFooterInlineSeparator: DEFAULT_AI_FOOTER_INLINE_SEPARATOR,
    // AI 消息末尾 tooltip 模板（支持 {{var}} 占位）
    aiFooterTooltipTemplate: DEFAULT_AI_FOOTER_TOOLTIP_TEMPLATE,
    // 主题透明度拆分：背景层与元素层独立控制
    backgroundOpacity: 0.8,
    elementOpacity: 0.8,
    // 主界面（菜单/输入区/Esc 面板等）背景模糊强度（单位 px）
    mainUiBlurRadius: 0,
    // 消息气泡背景模糊强度（单位 px）
    messageBlurRadius: 0,
    // 兼容旧版本（聊天/输入模糊），仅用于迁移；新版本请使用 mainUiBlurRadius/messageBlurRadius
    chatInputBlurRadius: 0,
    // 消息“复制为图片”导出参数（0 表示跟随当前消息样式）
    copyImageWidth: 0,
    copyImageFontSize: 0,
    copyImageScale: 1,
    copyImagePadding: 15,
    copyImageFontFamily: 'inherit',
    // 是否启用“自定义配色覆盖主题”
    enableCustomThemeColors: false,
    customThemeBgColor: '#262b33',
    customThemeTextColor: '#abb2bf',
    customThemeUserMessageColor: '#3e4451',
    customThemeAiMessageColor: '#2c313c',
    customThemeInputColor: '#21252b',
    customThemeBorderColor: '#30363d',
    customThemeIconColor: '#abb2bf',
    customThemeHighlightColor: '#61afef',
    customThemeSuccessColor: '#34c759',
    customThemeWarningColor: '#ff9500',
    customThemeErrorColor: '#ff3b30',
    customThemeCodeBgColor: '#282c34',
    customThemeCodeTextColor: '#abb2bf'
  };
  // 不需要持久化到 sync 的设置（大文本/临时值）
  const NON_SYNC_SETTINGS_KEYS = new Set(['backgroundImageUrl']);

  const CUSTOM_THEME_COLOR_SETTING_KEYS = new Set([
    'customThemeBgColor',
    'customThemeTextColor',
    'customThemeUserMessageColor',
    'customThemeAiMessageColor',
    'customThemeInputColor',
    'customThemeBorderColor',
    'customThemeIconColor',
    'customThemeHighlightColor',
    'customThemeSuccessColor',
    'customThemeWarningColor',
    'customThemeErrorColor',
    'customThemeCodeBgColor',
    'customThemeCodeTextColor'
  ]);
  // 这三项支持 RGBA（含 Alpha）调色，Alpha 直接作为控件最终透明度使用。
  const CUSTOM_THEME_RGBA_SETTING_KEYS = new Set([
    'customThemeUserMessageColor',
    'customThemeAiMessageColor',
    'customThemeInputColor'
  ]);

  const CUSTOM_THEME_OVERRIDE_VARIABLES = [
    '--cerebr-bg-color',
    '--cerebr-text-color',
    '--cerebr-message-user-bg',
    '--cerebr-message-ai-bg',
    '--cerebr-input-bg',
    '--cerebr-icon-color',
    '--cerebr-border-color',
    '--cerebr-hover-color',
    '--cerebr-tooltip-bg',
    '--cerebr-highlight',
    '--cerebr-green',
    '--cerebr-orange',
    '--cerebr-red',
    '--cerebr-code-bg',
    '--cerebr-code-color',
    '--cerebr-code-border'
  ];

  // 当前设置
  let currentSettings = {...DEFAULT_SETTINGS};
  let backgroundImageLoadToken = 0;
  let backgroundImageQueueState = { signature: '', pool: [], index: 0 };
  let currentBackgroundImageObjectUrl = '';

  const getConversationTitleApiOptions = () => {
    const options = [{ label: '跟随当前 API', value: 'follow_current' }];
    const apiConfigs = services.apiManager?.getAllConfigs?.() || [];
    if (!Array.isArray(apiConfigs) || apiConfigs.length === 0) return options;

    apiConfigs.forEach((config) => {
      if (!config) return;
      const fallbackValue = `${config.connectionType || ''}|${config.baseUrl || ''}|${config.modelName || ''}`;
      const value = config.id || fallbackValue;
      const label = (config.displayName && String(config.displayName).trim())
        || (config.modelName && String(config.modelName).trim())
        || (config.baseUrl && String(config.baseUrl).trim())
        || value;
      options.push({ label, value });
    });

    return options;
  };

  function refreshConversationTitleApiOptions() {
    const select = dynamicElements.get('conversationTitleApi');
    if (!select) return;
    const currentValue = select.value
      || currentSettings.conversationTitleApi
      || DEFAULT_SETTINGS.conversationTitleApi;
    const options = getConversationTitleApiOptions();
    select.textContent = '';
    options.forEach((opt) => {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      select.appendChild(option);
    });
    if (currentValue && !options.some(opt => opt.value === currentValue)) {
      const extra = document.createElement('option');
      extra.value = currentValue;
      extra.textContent = currentValue;
      select.appendChild(extra);
    }
    select.value = currentValue || DEFAULT_SETTINGS.conversationTitleApi;
  }

  function normalizeStringArraySetting(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const next = [];
    value.forEach((item) => {
      const text = (typeof item === 'string') ? item.trim() : '';
      if (!text || seen.has(text)) return;
      seen.add(text);
      next.push(text);
    });
    return next;
  }

  function getResponsesReasoningEffortMenuOptions() {
    return ['default', ...(services.apiManager?.getResponsesReasoningEffortOptions?.() || [])];
  }

  /**
   * 将 Responses 快捷菜单的可见档位限定在菜单支持的固定顺序内。
   * 设置面板可以任意勾选，但持久化时会过滤旧版残留值与重复项。
   */
  function normalizeResponsesReasoningEffortSliderOptions(value) {
    const selected = new Set(normalizeStringArraySetting(value));
    return getResponsesReasoningEffortMenuOptions().filter((effort) => selected.has(effort));
  }

  function getAskOtherAiApiOptions() {
    const apiConfigs = services.apiManager?.getAllConfigs?.() || [];
    return apiConfigs
      .map((config, index) => {
        if (!config || typeof config !== 'object') return null;
        const value = (typeof config.id === 'string') ? config.id.trim() : '';
        if (!value) return null;
        const displayName = (typeof config.displayName === 'string') ? config.displayName.trim() : '';
        const modelName = (typeof config.modelName === 'string') ? config.modelName.trim() : '';
        const label = displayName || modelName || `API ${index + 1}`;
        const meta = [];
        if (displayName && modelName && displayName !== modelName) {
          meta.push(modelName);
        }
        const connectionSourceName = (typeof config.connectionSourceName === 'string')
          ? config.connectionSourceName.trim()
          : '';
        if (connectionSourceName) {
          meta.push(connectionSourceName);
        }
        return {
          value,
          label,
          description: meta.join(' · ')
        };
      })
      .filter(Boolean);
  }

  function formatMultiSelectSelectionSummary(selectedIds, options, placeholder, selectedCountNoun = '项') {
    const optionByValue = new Map(
      (Array.isArray(options) ? options : [])
        .map((item) => {
          if (typeof item === 'string') {
            return [item, item];
          }
          return [item?.value, item?.label || item?.value || ''];
        })
        .filter(([value]) => typeof value === 'string' && value.trim())
    );
    const labels = normalizeStringArraySetting(selectedIds)
      .map((value) => optionByValue.get(value) || '')
      .filter(Boolean);
    if (labels.length <= 0) return placeholder || '选择 API';
    if (labels.length === 1) return labels[0];
    if (labels.length === 2) return labels.join('、');
    return `已选 ${labels.length} ${selectedCountNoun}`;
  }

  function writeMultiSelectDropdownControl(control, def, value) {
    if (!control) return;
    const toggleButton = control.querySelector('.settings-multiselect-toggle');
    const optionsContainer = control.querySelector('.settings-multiselect-options');
    if (!toggleButton || !optionsContainer) return;

    const options = typeof def.options === 'function' ? def.options() : (def.options || []);
    const selectedValues = normalizeStringArraySetting(value);
    const selectedSet = new Set(selectedValues);
    optionsContainer.textContent = '';

    if (Array.isArray(options) && options.length > 0) {
      options.forEach((opt) => {
        const optionValue = (typeof opt === 'string') ? opt : opt?.value;
        const optionLabel = (typeof opt === 'string') ? opt : (opt?.label || opt?.value || '');
        const optionDescription = (typeof opt === 'object' && opt?.description)
          ? String(opt.description).trim()
          : '';
        const normalizedValue = (typeof optionValue === 'string') ? optionValue.trim() : '';
        if (!normalizedValue) return;

        const optionLabelWrap = document.createElement('label');
        optionLabelWrap.className = 'settings-multiselect-option';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = normalizedValue;
        checkbox.checked = selectedSet.has(normalizedValue);

        const textWrap = document.createElement('div');
        textWrap.className = 'settings-multiselect-option-text';

        const title = document.createElement('span');
        title.className = 'settings-multiselect-option-title';
        title.textContent = optionLabel;
        textWrap.appendChild(title);

        if (optionDescription) {
          const meta = document.createElement('span');
          meta.className = 'settings-multiselect-option-meta';
          meta.textContent = optionDescription;
          textWrap.appendChild(meta);
        }

        optionLabelWrap.appendChild(checkbox);
        optionLabelWrap.appendChild(textWrap);
        optionsContainer.appendChild(optionLabelWrap);
      });
    }

    if (optionsContainer.childElementCount <= 0) {
      const empty = document.createElement('div');
      empty.className = 'settings-multiselect-empty';
      empty.textContent = def.emptyText || '暂无可选项';
      optionsContainer.appendChild(empty);
    }

    const summary = formatMultiSelectSelectionSummary(
      selectedValues,
      options,
      def.placeholder,
      def.selectedCountNoun
    );
    toggleButton.textContent = summary;
    toggleButton.title = summary;
  }

  function refreshAskOtherAiApiOptions() {
    const control = dynamicElements.get('askOtherAiEnabledApiIds');
    if (!control) return;
    const def = getActiveRegistry().find((item) => item.key === 'askOtherAiEnabledApiIds');
    if (!def) return;
    writeMultiSelectDropdownControl(control, def, currentSettings.askOtherAiEnabledApiIds ?? def.defaultValue);
  }

  function appendTextToInputEnd(input, text) {
    if (!input) return false;
    const safeText = String(text ?? '');
    if (!safeText) return false;
    const previous = (typeof input.value === 'string') ? input.value : '';
    const nextValue = `${previous}${safeText}`;
    input.value = nextValue;
    try {
      input.focus();
      if (typeof input.setSelectionRange === 'function') {
        input.setSelectionRange(nextValue.length, nextValue.length);
      }
    } catch (_) {}
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function groupTemplateVariableEntries(entries) {
    const groupedVariables = new Map();
    const groupOrder = [];
    (Array.isArray(entries) ? entries : []).forEach((entry) => {
      const variableKey = (typeof entry === 'string' ? entry : entry?.key || '').trim();
      if (!variableKey) return;
      const groupName = (typeof entry === 'object' && entry?.group)
        ? String(entry.group).trim()
        : '';
      const normalizedGroup = groupName || '__default__';
      if (!groupedVariables.has(normalizedGroup)) {
        groupedVariables.set(normalizedGroup, []);
        groupOrder.push(normalizedGroup);
      }
      groupedVariables.get(normalizedGroup).push(entry);
    });
    return { groupedVariables, groupOrder };
  }

  function createTemplateVariablePanel({
    title,
    hint,
    copyableVariables,
    targets
  }) {
    const normalizedTargets = (Array.isArray(targets) ? targets : [])
      .filter((target) => target && typeof target === 'object' && target.input);
    const { groupedVariables, groupOrder } = groupTemplateVariableEntries(copyableVariables);
    if (groupOrder.length <= 0 || normalizedTargets.length <= 0) return null;

    const details = document.createElement('details');
    details.className = 'settings-template-variable-tooltip settings-template-variable-tooltip--collapsible';

    const summary = document.createElement('summary');
    summary.className = 'settings-template-variable-tooltip-summary';

    const summaryTitle = document.createElement('span');
    summaryTitle.className = 'settings-template-variable-tooltip-title';
    summaryTitle.textContent = title || '可用变量';
    summary.appendChild(summaryTitle);
    details.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'settings-template-variable-tooltip-body';
    details.appendChild(body);

    let activeTargetKey = normalizedTargets[0]?.key || '';
    const targetButtons = [];
    let targetStatus = null;

    const resolveActiveTarget = () => (
      normalizedTargets.find((target) => target.key === activeTargetKey && target.input)
      || normalizedTargets.find((target) => target.input)
      || null
    );

    const updateTargetUi = () => {
      const activeTarget = resolveActiveTarget();
      targetButtons.forEach(({ key, button }) => {
        button.classList.toggle('is-active', key === activeTarget?.key);
      });
      if (targetStatus) {
        targetStatus.textContent = activeTarget
          ? `当前插入目标：${activeTarget.label}`
          : '当前插入目标不可用';
      }
    };

    const setActiveTarget = (key, { focusInput = false } = {}) => {
      if (!key) return;
      activeTargetKey = key;
      updateTargetUi();
      if (focusInput) {
        const activeTarget = resolveActiveTarget();
        try {
          activeTarget?.input?.focus?.();
        } catch (_) {}
      }
    };

    if (normalizedTargets.length > 1) {
      const targetSection = document.createElement('div');
      targetSection.className = 'settings-template-variable-targets';

      const targetLabel = document.createElement('span');
      targetLabel.className = 'settings-template-variable-targets-label';
      targetLabel.textContent = '插入到';
      targetSection.appendChild(targetLabel);

      const targetButtonList = document.createElement('div');
      targetButtonList.className = 'settings-template-variable-target-list';
      normalizedTargets.forEach((target) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'settings-template-variable-target-button';
        button.textContent = target.label || target.key;
        button.addEventListener('click', (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          setActiveTarget(target.key, { focusInput: true });
        });
        targetButtonList.appendChild(button);
        targetButtons.push({ key: target.key, button });
        target.input.addEventListener('focus', () => {
          setActiveTarget(target.key);
        });
      });
      targetSection.appendChild(targetButtonList);
      body.appendChild(targetSection);

      targetStatus = document.createElement('div');
      targetStatus.className = 'settings-template-variable-target-hint';
      body.appendChild(targetStatus);
    }

    const shouldShowGroupTitle = groupOrder.length > 1;
    groupOrder.forEach((groupName) => {
      const entries = groupedVariables.get(groupName) || [];
      if (!entries.length) return;
      const groupSection = document.createElement('div');
      groupSection.className = 'settings-template-variable-group';

      if (shouldShowGroupTitle) {
        const groupTitle = document.createElement('div');
        groupTitle.className = 'settings-template-variable-group-title';
        groupTitle.textContent = (groupName === '__default__') ? '其它' : groupName;
        groupSection.appendChild(groupTitle);
      }

      const variableList = document.createElement('div');
      variableList.className = 'settings-template-variable-list';

      entries.forEach((entry) => {
        const variableKey = (typeof entry === 'string' ? entry : entry?.key || '').trim();
        if (!variableKey) return;
        const description = (typeof entry === 'object' && entry?.description)
          ? String(entry.description).trim()
          : '';
        const variableToken = `{{${variableKey}}}`;
        const variableButton = document.createElement('button');
        variableButton.type = 'button';
        variableButton.className = 'settings-template-variable-chip';
        variableButton.textContent = variableToken;
        if (description) {
          variableButton.title = `${variableKey}：${description}`;
        }
        variableButton.addEventListener('click', (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          const activeTarget = resolveActiveTarget();
          if (!activeTarget?.input) return;
          appendTextToInputEnd(activeTarget.input, variableToken);
        });
        variableList.appendChild(variableButton);
      });

      if (variableList.childElementCount > 0) {
        groupSection.appendChild(variableList);
        body.appendChild(groupSection);
      }
    });

    const hintText = (typeof hint === 'string') ? hint.trim() : '';
    if (hintText) {
      const tooltipHint = document.createElement('div');
      tooltipHint.className = 'settings-template-variable-tooltip-hint';
      tooltipHint.textContent = hintText;
      body.appendChild(tooltipHint);
    }

    updateTargetUi();
    return details;
  }

  // 动态设置注册表：新增设置仅需在此处登记即可自动渲染与持久化
  // type: 'toggle' | 'range' | 'select' | 'multi_select_dropdown' | 'color' | 'text' | 'textarea'
  const SETTINGS_REGISTRY = [
    // 主题（复用现有隐藏下拉框，不额外渲染）
    {
      key: 'theme',
      type: 'select',
      id: 'theme-select',
      label: '主题选择',
      uiHidden: true,
      options: () => (themeManager.getAvailableThemes?.() || []).map(t => ({ label: t.name, value: t.id })),
      defaultValue: DEFAULT_SETTINGS.theme,
      apply: (v) => applyTheme(v)
    },
    {
      key: 'backgroundOpacity',
      type: 'range',
      id: 'theme-background-opacity',
      label: '背景底色强度',
      group: 'theme',
      min: 0.2,
      max: 1,
      step: 0.05,
      defaultValue: DEFAULT_SETTINGS.backgroundOpacity,
      apply: () => applyThemeOpacityOverrides(),
      formatValue: (value) => `${Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)}%`
    },
    {
      key: 'elementOpacity',
      type: 'range',
      id: 'theme-element-opacity',
      label: '主界面透明度',
      group: 'theme',
      min: 0.2,
      max: 1,
      step: 0.05,
      defaultValue: DEFAULT_SETTINGS.elementOpacity,
      apply: () => applyThemeOpacityOverrides(),
      formatValue: (value) => `${Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)}%`
    },
    {
      key: 'mainUiBlurRadius',
      type: 'range',
      id: 'theme-main-ui-blur-radius',
      label: '主界面模糊',
      group: 'theme',
      min: 0,
      max: 100,
      step: 1,
      defaultValue: DEFAULT_SETTINGS.mainUiBlurRadius,
      apply: (v) => applyMainUiBlurRadius(v),
      formatValue: (value) => `${clampBlurRadiusPx(value)}px`
    },
    {
      key: 'messageBlurRadius',
      type: 'range',
      id: 'theme-message-blur-radius',
      label: '消息气泡模糊',
      group: 'theme',
      min: 0,
      max: 100,
      step: 1,
      defaultValue: DEFAULT_SETTINGS.messageBlurRadius,
      apply: (v) => applyMessageBlurRadius(v),
      formatValue: (value) => `${clampBlurRadiusPx(value)}px`
    },
    {
      key: 'enableCustomThemeColors',
      type: 'toggle',
      id: 'enable-custom-theme-colors',
      label: '启用自定义配色（覆盖主题）',
      group: 'theme',
      defaultValue: DEFAULT_SETTINGS.enableCustomThemeColors,
      apply: () => applyCustomThemeColorOverrides()
    },
    {
      key: 'customThemeBgColor',
      type: 'color',
      id: 'custom-theme-bg-color',
      label: '界面底色',
      group: 'theme',
      section: 'theme-core',
      defaultValue: DEFAULT_SETTINGS.customThemeBgColor,
      apply: () => applyCustomThemeColorOverrides()
    },
    {
      key: 'customThemeTextColor',
      type: 'color',
      id: 'custom-theme-text-color',
      label: '主文字色',
      group: 'theme',
      section: 'theme-core',
      defaultValue: DEFAULT_SETTINGS.customThemeTextColor,
      apply: () => applyCustomThemeColorOverrides()
    },
    {
      key: 'customThemeBorderColor',
      type: 'color',
      id: 'custom-theme-border-color',
      label: '边框/分隔线',
      group: 'theme',
      section: 'theme-core',
      defaultValue: DEFAULT_SETTINGS.customThemeBorderColor,
      apply: () => applyCustomThemeColorOverrides()
    },
    {
      key: 'customThemeInputColor',
      type: 'color',
      id: 'custom-theme-input-color',
      label: '输入区底色',
      group: 'theme',
      section: 'theme-core',
      defaultValue: DEFAULT_SETTINGS.customThemeInputColor,
      alphaEnabled: true,
      apply: () => applyCustomThemeColorOverrides()
    },
    {
      key: 'customThemeUserMessageColor',
      type: 'color',
      id: 'custom-theme-user-message-color',
      label: '用户气泡色',
      group: 'theme',
      section: 'theme-chat',
      defaultValue: DEFAULT_SETTINGS.customThemeUserMessageColor,
      alphaEnabled: true,
      apply: () => applyCustomThemeColorOverrides()
    },
    {
      key: 'customThemeAiMessageColor',
      type: 'color',
      id: 'custom-theme-ai-message-color',
      label: 'AI气泡色',
      group: 'theme',
      section: 'theme-chat',
      defaultValue: DEFAULT_SETTINGS.customThemeAiMessageColor,
      alphaEnabled: true,
      apply: () => applyCustomThemeColorOverrides()
    },
    {
      key: 'customThemeIconColor',
      type: 'color',
      id: 'custom-theme-icon-color',
      label: '图标颜色',
      group: 'theme',
      section: 'theme-accent',
      defaultValue: DEFAULT_SETTINGS.customThemeIconColor,
      apply: () => applyCustomThemeColorOverrides()
    },
    {
      key: 'customThemeHighlightColor',
      type: 'color',
      id: 'custom-theme-highlight-color',
      label: '强调色',
      group: 'theme',
      section: 'theme-accent',
      defaultValue: DEFAULT_SETTINGS.customThemeHighlightColor,
      apply: () => applyCustomThemeColorOverrides()
    },
    {
      key: 'customThemeSuccessColor',
      type: 'color',
      id: 'custom-theme-success-color',
      label: '成功状态色',
      group: 'theme',
      section: 'theme-status',
      uiHidden: true,
      defaultValue: DEFAULT_SETTINGS.customThemeSuccessColor,
      apply: () => applyCustomThemeColorOverrides()
    },
    {
      key: 'customThemeWarningColor',
      type: 'color',
      id: 'custom-theme-warning-color',
      label: '警告状态色',
      group: 'theme',
      section: 'theme-status',
      uiHidden: true,
      defaultValue: DEFAULT_SETTINGS.customThemeWarningColor,
      apply: () => applyCustomThemeColorOverrides()
    },
    {
      key: 'customThemeErrorColor',
      type: 'color',
      id: 'custom-theme-error-color',
      label: '错误状态色',
      group: 'theme',
      section: 'theme-status',
      uiHidden: true,
      defaultValue: DEFAULT_SETTINGS.customThemeErrorColor,
      apply: () => applyCustomThemeColorOverrides()
    },
    {
      key: 'customThemeCodeBgColor',
      type: 'color',
      id: 'custom-theme-code-bg-color',
      label: '代码背景色',
      group: 'theme',
      section: 'theme-code',
      uiHidden: true,
      defaultValue: DEFAULT_SETTINGS.customThemeCodeBgColor,
      apply: () => applyCustomThemeColorOverrides()
    },
    {
      key: 'customThemeCodeTextColor',
      type: 'color',
      id: 'custom-theme-code-text-color',
      label: '代码文字色',
      group: 'theme',
      section: 'theme-code',
      uiHidden: true,
      defaultValue: DEFAULT_SETTINGS.customThemeCodeTextColor,
      apply: () => applyCustomThemeColorOverrides()
    },
    {
      key: 'backgroundImageUrl',
      type: 'text',
      id: 'background-image-url',
      label: '背景图片',
      group: 'background',
      placeholder: '可粘贴多行，每行一个 URL/本机路径',
      defaultValue: DEFAULT_SETTINGS.backgroundImageUrl,
      apply: (v) => applyBackgroundImage(v),
      readFromUI: (el) => (el?.value ?? ''),
      writeToUI: (el, value) => {
        const val = (value ?? '');
        el.value = val;
        const container = el.closest('.background-image-setting');
        if (container) {
          container.classList.toggle('has-background-image', !!String(val).trim());
        }
      }
    },
    {
      key: 'backgroundImageIntensity',
      type: 'range',
      id: 'background-image-intensity',
      label: '图片氛围(模糊)',
      group: 'background',
      min: 0,
      max: 1,
      step: 0.05,
      defaultValue: DEFAULT_SETTINGS.backgroundImageIntensity,
      apply: (v) => applyBackgroundImageIntensity(v),
      formatValue: (value) => `${Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)}%`
    },
    {
      key: 'backgroundMessageBlurRadius',
      type: 'range',
      id: 'background-message-blur-radius',
      label: '消息态原图模糊',
      group: 'background',
      min: 0,
      max: 120,
      step: 1,
      defaultValue: DEFAULT_SETTINGS.backgroundMessageBlurRadius,
      apply: (v) => applyBackgroundMessageBlurRadius(v),
      formatValue: (value) => `${clampBackgroundMessageBlurRadius(value)}px`
    },
    {
      key: 'backgroundOverallOpacity',
      type: 'range',
      id: 'background-overall-opacity',
      label: '图片透明度',
      group: 'background',
      min: 0,
      max: 1,
      step: 0.05,
      defaultValue: DEFAULT_SETTINGS.backgroundOverallOpacity,
      apply: (v) => applyBackgroundOverallOpacity(v),
      formatValue: (value) => `${Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)}%`
    },
    {
      key: 'fullscreenBackgroundCover',
      type: 'toggle',
      id: 'fullscreen-background-cover',
      label: '全屏背景铺满屏幕',
      group: 'background',
      defaultValue: DEFAULT_SETTINGS.fullscreenBackgroundCover,
      apply: (v) => applyFullscreenBackgroundCover(v)
    },
    {
      key: 'fullscreenHideOriginalOnChat',
      type: 'toggle',
      id: 'fullscreen-hide-original-on-chat',
      label: '全屏消息态隐藏原图',
      group: 'background',
      defaultValue: DEFAULT_SETTINGS.fullscreenHideOriginalOnChat,
      apply: (v) => applyFullscreenHideOriginalOnChat(v)
    },
    // 自动滚动
    {
      key: 'autoScroll',
      type: 'toggle',
      id: 'auto-scroll-switch',
      label: '自动滚动',
      group: 'behavior',
      defaultValue: DEFAULT_SETTINGS.autoScroll,
      apply: (v) => applyAutoScroll(v)
    },
    // 滚动到顶部时停止
    {
      key: 'stopAtTop',
      type: 'toggle',
      id: 'stop-at-top-switch',
      label: '滚动到顶部时停止',
      group: 'behavior',
      defaultValue: DEFAULT_SETTINGS.stopAtTop,
      apply: (v) => applyStopAtTop(v)
    },
    {
      key: 'autoGenerateConversationTitle',
      type: 'toggle',
      id: 'auto-generate-conversation-title',
      label: '自动生成对话标题',
      group: 'title',
      defaultValue: DEFAULT_SETTINGS.autoGenerateConversationTitle
    },
    {
      key: 'autoGenerateTitleForSummary',
      type: 'toggle',
      id: 'auto-generate-title-summary',
      label: '对[总结]自动生成标题',
      group: 'title',
      defaultValue: DEFAULT_SETTINGS.autoGenerateTitleForSummary
    },
    {
      key: 'autoGenerateTitleForSelection',
      type: 'toggle',
      id: 'auto-generate-title-selection',
      label: '对[划词解释]自动生成标题',
      group: 'title',
      defaultValue: DEFAULT_SETTINGS.autoGenerateTitleForSelection
    },
    {
      key: 'conversationTitleApi',
      type: 'select',
      id: 'conversation-title-api',
      label: '对话标题生成 API',
      group: 'title',
      options: () => getConversationTitleApiOptions(),
      defaultValue: DEFAULT_SETTINGS.conversationTitleApi
    },
    {
      key: 'askOtherAiEnabledApiIds',
      type: 'multi_select_dropdown',
      id: 'ask-other-ai-enabled-api-ids',
      label: '向其他AI提问可用 API',
      group: 'advanced',
      options: () => getAskOtherAiApiOptions(),
      defaultValue: DEFAULT_SETTINGS.askOtherAiEnabledApiIds,
      placeholder: '选择可用于 ask_other_ai 的 API',
      emptyText: '暂无可选 API',
      selectedCountNoun: '个 API',
      readFromUI: (el) => normalizeStringArraySetting(
        Array.from(el?.querySelectorAll?.('.settings-multiselect-option input[type="checkbox"]:checked') || [])
          .map((input) => input.value)
      ),
      writeToUI: (el, value) => {
        writeMultiSelectDropdownControl(el, {
          options: () => getAskOtherAiApiOptions(),
          placeholder: '选择可用于 ask_other_ai 的 API',
          emptyText: '暂无可选 API',
          selectedCountNoun: '个 API'
        }, value);
      }
    },
    {
      key: 'conversationTitlePrompt',
      type: 'textarea',
      id: 'conversation-title-prompt',
      label: '对话标题提示词',
      placeholder: '输入用于生成对话标题的提示词（系统提示词）',
      rows: 4,
      group: 'title',
      defaultValue: DEFAULT_SETTINGS.conversationTitlePrompt,
      readFromUI: (el) => (el?.value || '').trim(),
      writeToUI: (el, value) => { if (el) el.value = value || ''; }
    },
    // 发送 signature（推理签名透传）
    {
      key: 'shouldSendSignature',
      type: 'toggle',
      id: 'send-signature-switch',
      label: '发送 signature（推理签名）',
      group: 'advanced',
      defaultValue: DEFAULT_SETTINGS.shouldSendSignature
    },
    {
      key: 'autoRetry',
      type: 'toggle',
      id: 'auto-retry-switch',
      label: '自动重试',
      group: 'behavior',
      defaultValue: DEFAULT_SETTINGS.autoRetry,
      apply: (v) => applyAutoRetry(v)
    },
    {
      key: 'queueCurrentConversationMessages',
      type: 'toggle',
      id: 'queue-current-conversation-messages-switch',
      label: '同对话发送排队',
      group: 'behavior',
      defaultValue: DEFAULT_SETTINGS.queueCurrentConversationMessages,
      apply: (v) => applyQueueCurrentConversationMessages(v)
    },
    {
      key: 'showModelNameInPlaceholder',
      type: 'toggle',
      label: '输入框占位符显示模型名',
      group: 'input',
      defaultValue: DEFAULT_SETTINGS.showModelNameInPlaceholder,
      apply: (v) => applyShowModelNameInPlaceholder(v)
    },
    {
      key: 'responsesReasoningEffortSliderOptions',
      type: 'multi_select_dropdown',
      id: 'responses-reasoning-effort-slider-options',
      label: 'Responses 推理强度快捷菜单',
      group: 'input',
      options: getResponsesReasoningEffortMenuOptions,
      defaultValue: DEFAULT_SETTINGS.responsesReasoningEffortSliderOptions,
      placeholder: '选择快捷菜单显示的推理强度',
      emptyText: '暂无可选推理强度',
      selectedCountNoun: '档',
      readFromUI: (el) => normalizeResponsesReasoningEffortSliderOptions(
        Array.from(el?.querySelectorAll?.('.settings-multiselect-option input[type="checkbox"]:checked') || [])
          .map((input) => input.value)
      ),
      writeToUI: (el, value) => {
        writeMultiSelectDropdownControl(el, {
          options: getResponsesReasoningEffortMenuOptions,
          placeholder: '选择快捷菜单显示的推理强度',
          emptyText: '暂无可选推理强度',
          selectedCountNoun: '档'
        }, value);
      }
    },
    {
      key: 'aiFooterTemplate',
      type: 'textarea',
      label: 'AI 消息尾注模板',
      group: 'display',
      rows: 5,
      placeholder: '示例：{{display_label}} · {{datetime}} · {{total_tokens_k}}\n换行后会作为第二行单独处理',
      copyableVariables: AI_FOOTER_TEMPLATE_VARIABLES,
      sharedCopyableVariablesPanelKey: AI_FOOTER_SHARED_VARIABLE_PANEL_KEY,
      sharedCopyableVariablesTitle: '可用变量',
      sharedCopyableVariablesHint: '尾注模板会按“同行分隔符”拆段后智能拼接：同一行里只有非空变量之间才会插入分隔符；不同行只保留换行。',
      sharedCopyableVariablesTargetLabel: '尾注文本',
      hideClearButton: true,
      defaultValue: DEFAULT_SETTINGS.aiFooterTemplate,
      readFromUI: (el) => (typeof el?.value === 'string' ? el.value : ''),
      writeToUI: (el, value) => {
        if (el) el.value = (typeof value === 'string') ? value : '';
      }
    },
    {
      key: 'aiFooterInlineSeparator',
      type: 'text',
      label: '尾注同行分隔符',
      group: 'display',
      placeholder: '例如  ·  或  | ',
      defaultValue: DEFAULT_SETTINGS.aiFooterInlineSeparator,
      readFromUI: (el) => (typeof el?.value === 'string') ? el.value : '',
      writeToUI: (el, value) => {
        if (el) el.value = (typeof value === 'string') ? value : '';
      }
    },
    {
      key: 'aiFooterTooltipTemplate',
      type: 'textarea',
      label: 'AI 尾注 Tooltip 模板',
      group: 'display',
      rows: 5,
      placeholder: '示例：{{tooltip_api_line}}\n{{tooltip_signature_line}}\n{{tooltip_usage_lines}}',
      copyableVariables: AI_FOOTER_TEMPLATE_VARIABLES,
      sharedCopyableVariablesPanelKey: AI_FOOTER_SHARED_VARIABLE_PANEL_KEY,
      sharedCopyableVariablesTitle: '可用变量',
      sharedCopyableVariablesHint: '先点上面的尾注或 Tooltip 文本框，再点变量会追加到当前文本框末尾。',
      sharedCopyableVariablesTargetLabel: 'Tooltip 文本',
      sharedCopyableVariablesHost: true,
      hideClearButton: true,
      defaultValue: DEFAULT_SETTINGS.aiFooterTooltipTemplate,
      readFromUI: (el) => (typeof el?.value === 'string' ? el.value : ''),
      writeToUI: (el, value) => {
        if (el) el.value = (typeof value === 'string') ? value : '';
      }
    },
    {
      key: 'renderMarkdownForUserMessages',
      type: 'toggle',
      group: 'display',
      label: '用户消息启用 Markdown 渲染',
      defaultValue: DEFAULT_SETTINGS.renderMarkdownForUserMessages
    },
    {
      key: 'showCodeBlockToolbar',
      type: 'toggle',
      group: 'display',
      label: '显示代码块工具条',
      defaultValue: DEFAULT_SETTINGS.showCodeBlockToolbar
    },
    {
      key: 'collapseLongCodeBlocks',
      type: 'toggle',
      group: 'display',
      label: '折叠过长代码块',
      defaultValue: DEFAULT_SETTINGS.collapseLongCodeBlocks
    },
    {
      key: 'copyImageWidth',
      type: 'range',
      group: 'capture',
      label: '导出宽度',
      min: 0,
      max: 1600,
      step: 10,
      defaultValue: DEFAULT_SETTINGS.copyImageWidth,
      formatValue: (value) => {
        const normalized = clampCopyImageWidth(value);
        return normalized <= 0 ? '跟随消息宽度' : `${normalized}px`;
      }
    },
    {
      key: 'copyImageFontSize',
      type: 'range',
      group: 'capture',
      label: '导出字号',
      min: 0,
      max: 32,
      step: 1,
      defaultValue: DEFAULT_SETTINGS.copyImageFontSize,
      formatValue: (value) => {
        const normalized = clampCopyImageFontSize(value);
        return normalized <= 0 ? '跟随消息字号' : `${normalized}px`;
      }
    },
    {
      key: 'copyImageScale',
      type: 'range',
      group: 'capture',
      label: '导出分辨率',
      min: 1,
      max: 4,
      step: 0.25,
      defaultValue: DEFAULT_SETTINGS.copyImageScale,
      formatValue: (value) => `${clampCopyImageScale(value).toFixed(2)}x`
    },
    {
      key: 'copyImagePadding',
      type: 'range',
      group: 'capture',
      label: '图片边距',
      min: 0,
      max: 64,
      step: 1,
      defaultValue: DEFAULT_SETTINGS.copyImagePadding,
      formatValue: (value) => `${clampCopyImagePadding(value)}px`
    },
    {
      key: 'copyImageFontFamily',
      type: 'select',
      group: 'capture',
      label: '图片字体',
      options: [
        { label: '跟随当前界面', value: 'inherit' },
        { label: '系统无衬线', value: 'system-sans' },
        { label: '衬线体', value: 'serif' },
        { label: '等宽体', value: 'monospace' }
      ],
      defaultValue: DEFAULT_SETTINGS.copyImageFontFamily
    },
    // 快捷设置：保留在“...”菜单中便于快速调整
    // 数学公式：是否使用 $ / $$ 作为分隔符
    {
      key: 'enableDollarMath',
      type: 'toggle',
      menu: 'quick',
      group: 'display',
      label: '使用 $ / $$ 作为公式分隔符',
      defaultValue: DEFAULT_SETTINGS.enableDollarMath
    },
    // 侧边栏位置（使用切换表示右侧）
    {
      key: 'sidebarPosition',
      type: 'toggle',
      menu: 'quick',
      group: 'layout',
      id: 'sidebar-position-switch',
      label: '侧栏在右侧显示',
      defaultValue: DEFAULT_SETTINGS.sidebarPosition,
      readFromUI: (el) => el?.checked ? 'right' : 'left',
      writeToUI: (el, v) => { if (el) el.checked = (v === 'right'); },
      apply: (v) => applySidebarPosition(v),
      standaloneHidden: true
    },
    // 侧边栏宽度
    {
      key: 'sidebarWidth',
      type: 'range',
      uiHidden: true,
      group: 'layout',
      id: 'sidebar-width',
      label: '侧栏宽度',
      min: 500,
      max: 2000,
      step: 50,
      unit: 'px',
      defaultValue: DEFAULT_SETTINGS.sidebarWidth,
      apply: (v) => applySidebarWidth(v)
    },
    // 全屏模式内容宽度（仅影响全屏布局的居中内容区，不影响侧栏本身宽度）
    {
      key: 'fullscreenWidth',
      type: 'range',
      menu: 'quick',
      id: 'fullscreen-width',
      label: '全屏宽度',
      group: 'layout',
      min: 500,
      max: 2400,
      step: 50,
      unit: 'px',
      defaultValue: DEFAULT_SETTINGS.fullscreenWidth,
      apply: (v) => applyFullscreenWidth(v)
    },
    {
      key: 'enableScrollMinimap',
      type: 'toggle',
      group: 'layout',
      label: '启用滚动迷你图',
      defaultValue: DEFAULT_SETTINGS.enableScrollMinimap,
      apply: (v) => applyScrollMinimapEnabled(v)
    },
    {
      key: 'scrollMinimapWheelMessageStep',
      type: 'toggle',
      group: 'layout',
      label: '迷你图滚轮按消息滚动',
      defaultValue: DEFAULT_SETTINGS.scrollMinimapWheelMessageStep,
      apply: (v) => applyScrollMinimapWheelMessageStep(v)
    },
    {
      key: 'scrollMinimapWidth',
      type: 'range',
      group: 'layout',
      label: '迷你图宽度',
      min: 14,
      max: 100,
      step: 1,
      unit: 'px',
      defaultValue: DEFAULT_SETTINGS.scrollMinimapWidth,
      apply: (v) => applyScrollMinimapWidth(v)
    },
    {
      key: 'scrollMinimapOpacity',
      type: 'range',
      group: 'layout',
      label: '迷你图透明度',
      min: 0.2,
      max: 1,
      step: 0.05,
      defaultValue: DEFAULT_SETTINGS.scrollMinimapOpacity,
      formatValue: (v) => `${Math.round(Number(v) * 100)}%`,
      apply: (v) => applyScrollMinimapOpacity(v)
    },
    {
      key: 'scrollMinimapAutoHide',
      type: 'toggle',
      group: 'layout',
      label: '迷你图自动隐藏',
      defaultValue: DEFAULT_SETTINGS.scrollMinimapAutoHide,
      apply: (v) => applyScrollMinimapAutoHide(v)
    },
    {
      key: 'scrollMinimapMessageMode',
      type: 'select',
      group: 'layout',
      label: '迷你图消息模式',
      options: [
        { label: '按实际高度比例', value: 'proportional' },
        { label: '固定消息高度', value: 'fixed' }
      ],
      defaultValue: DEFAULT_SETTINGS.scrollMinimapMessageMode,
      apply: (v) => applyScrollMinimapMessageMode(v)
    },
    {
      key: 'hideNativeScrollbarInFullscreen',
      type: 'toggle',
      group: 'layout',
      label: '全屏隐藏原生滚动条',
      defaultValue: DEFAULT_SETTINGS.hideNativeScrollbarInFullscreen,
      apply: (v) => applyHideNativeScrollbarInFullscreen(v)
    },
    // 字体大小
    {
      key: 'fontSize',
      type: 'range',
      menu: 'quick',
      group: 'display',
      id: 'font-size',
      label: '字体大小',
      min: 12,
      max: 24,
      step: 1,
      unit: 'px',
      defaultValue: DEFAULT_SETTINGS.fontSize,
      apply: (v) => applyFontSize(v)
    },
    {
      key: DOCUMENT_VIEWER_SETTING_FONT_SIZE_PERCENT,
      type: 'range',
      menu: 'quick',
      group: 'display',
      label: '文件预览字体大小',
      min: 85,
      max: 150,
      step: 5,
      unit: '%',
      defaultValue: DEFAULT_SETTINGS[DOCUMENT_VIEWER_SETTING_FONT_SIZE_PERCENT],
      apply: (v) => applyDocumentFontSizePercent(v)
    },
    {
      key: DOCUMENT_VIEWER_SETTING_RENDER_MARKDOWN_FOR_MD,
      type: 'toggle',
      group: 'display',
      label: 'Markdown 文件默认渲染',
      defaultValue: DEFAULT_SETTINGS[DOCUMENT_VIEWER_SETTING_RENDER_MARKDOWN_FOR_MD]
    },
    // 缩放比例
    {
      key: 'scaleFactor',
      type: 'range',
      menu: 'quick',
      group: 'layout',
      id: 'scale-factor',
      label: '缩放比例',
      min: 0.5,
      max: 2,
      step: 0.1,
      unit: 'x',
      defaultValue: DEFAULT_SETTINGS.scaleFactor,
      apply: (v) => applyScaleFactor(v)
    },
    // // 行距（示例：页面原本没有控件则自动渲染）
    // {
    //   key: 'lineHeight',
    //   type: 'range',
    //   label: '行距',
    //   min: 1.2,
    //   max: 2.0,
    //   step: 0.1,
    //   unit: 'x',
    //   defaultValue: DEFAULT_SETTINGS.lineHeight,
    //   apply: (v) => { document.documentElement.style.setProperty('--cerebr-line-height', String(v)); }
    // }
  ];

  function getActiveRegistry() {
    return SETTINGS_REGISTRY.filter(def => !(isStandalone && def.standaloneHidden));
  }

  // 动态生成的元素映射（仅对注册表项）
  const dynamicElements = new Map(); // key -> HTMLInputElement | HTMLSelectElement
  
  // 订阅者注册表：用于跨模块监听设置变化
  /** @type {Map<string, Set<(value:any)=>void>>} */
  const subscribers = new Map();

  // 基于 schema 的通用设置定义（保留为空，统一由注册表生成）
  const SETTINGS_SCHEMA = {};

  // 由注册表构建 schema（仅针对动态生成的元素）
  let generatedSchema = {};
  function buildSchemaFromRegistry() {
    const map = {};
    for (const def of getActiveRegistry()) {
      // 如果页面已有同名控件（通过固定ID），则跳过自动生成schema（避免重复绑定）
      if (document.getElementById(def.id || `setting-${def.key}`)) {
        // 将其纳入schema（使用动态元素映射）
        map[def.key] = createSchemaEntryForDef(def);
        continue;
      }
      // 若未生成UI，稍后renderSettingsFromRegistry会创建元素并填充dynamicElements
      map[def.key] = createSchemaEntryForDef(def);
    }
    generatedSchema = map;
    return map;
  }

  function createSchemaEntryForDef(def) {
    return {
      element: () => dynamicElements.get(def.key) || null,
      readFromUI: (el) => {
        if (!el) return currentSettings[def.key];
        if (typeof def.readFromUI === 'function') return def.readFromUI(el);
        if (def.type === 'toggle') return !!el.checked;
        if (def.type === 'range') return parseFloat(el.value);
        if (def.type === 'select') return el.value;
        if (def.type === 'color') return readColorControlValue(def, el);
        return el.value;
      },
      writeToUI: (el, v) => {
        if (!el) return;
        if (typeof def.writeToUI === 'function') { def.writeToUI(el, v); }
        else if (def.type === 'toggle') el.checked = !!v;
        else if (def.type === 'color') {
          writeColorControlValue(def, el, v);
          return;
        } else el.value = v;
        // 同步右侧显示值
        const valueSpan = el.closest('.menu-item')?.querySelector('.setting-value');
        if (valueSpan) {
          valueSpan.textContent = formatDisplayValue(def, v);
        }
      },
      apply: (v) => { if (typeof def.apply === 'function') def.apply(v); }
    };
  }

  function getSchemaMap() {
    return { ...SETTINGS_SCHEMA, ...generatedSchema };
  }

  /**
   * 统一设置更新入口
   * @param {string} key - 设置键
   * @param {any} value - 新值
   */
  function normalizeSettingValue(key, value) {
    if (key === 'backgroundOpacity' || key === 'elementOpacity') {
      return clamp01(value, DEFAULT_SETTINGS[key]);
    }
    if (key === 'mainUiBlurRadius' || key === 'messageBlurRadius' || key === 'chatInputBlurRadius') {
      return clampBlurRadiusPx(value);
    }
    if (key === 'copyImageWidth') {
      return clampCopyImageWidth(value);
    }
    if (key === 'copyImageFontSize') {
      return clampCopyImageFontSize(value);
    }
    if (key === 'copyImageScale') {
      return clampCopyImageScale(value);
    }
    if (key === 'copyImagePadding') {
      return clampCopyImagePadding(value);
    }
    if (key === DOCUMENT_VIEWER_SETTING_FONT_SIZE_PERCENT) {
      return clampConversationDocumentFontSizePercent(value, DEFAULT_SETTINGS[DOCUMENT_VIEWER_SETTING_FONT_SIZE_PERCENT]);
    }
    if (key === 'copyImageFontFamily') {
      return normalizeCopyImageFontFamily(value);
    }
    if (key === 'backgroundMessageBlurRadius') {
      return clampBackgroundMessageBlurRadius(value);
    }
    if (key === 'fullscreenHideOriginalOnChat') {
      return !!value;
    }
    if (key === 'enableCustomThemeColors') {
      return !!value;
    }
    if (CUSTOM_THEME_COLOR_SETTING_KEYS.has(key)) {
      if (CUSTOM_THEME_RGBA_SETTING_KEYS.has(key)) {
        return normalizeRgbaColor(value, DEFAULT_SETTINGS[key] || '#000000');
      }
      return normalizeHexColor(value, DEFAULT_SETTINGS[key] || '#000000');
    }
    if (key === 'fullscreenWidth') {
      return clampFullscreenWidth(value);
    }
    if (key === 'scrollMinimapWidth') {
      return clampScrollMinimapWidth(value);
    }
    if (key === 'scrollMinimapOpacity') {
      return clamp01(value, DEFAULT_SETTINGS.scrollMinimapOpacity);
    }
    if (key === 'scrollMinimapAutoHide') {
      return !!value;
    }
    if (key === 'scrollMinimapWheelMessageStep') {
      return !!value;
    }
    if (key === DOCUMENT_VIEWER_SETTING_RENDER_MARKDOWN_FOR_MD) {
      return !!value;
    }
    if (key === DOCUMENT_VIEWER_SETTING_MODE_OVERRIDES) {
      return normalizeConversationDocumentViewModeOverridesSetting(value);
    }
    if (key === 'scrollMinimapMessageMode') {
      return normalizeScrollMinimapMessageMode(value);
    }
    if (key === 'hideNativeScrollbarInFullscreen') {
      return !!value;
    }
    if (key === 'askOtherAiEnabledApiIds') {
      return normalizeStringArraySetting(value);
    }
    if (key === 'responsesReasoningEffortSliderOptions') {
      return normalizeResponsesReasoningEffortSliderOptions(value);
    }
    return value;
  }

  function hasExplicitAlphaInColorText(value) {
    const source = String(value || '').trim().toLowerCase();
    if (!source) return false;
    if (source.startsWith('rgba(')) return true;
    if (source.startsWith('hsla(')) return true;
    if (source.startsWith('#') && (source.length === 5 || source.length === 9)) return true;
    if (source.startsWith('color(') && source.includes('/')) return true;
    if (source.startsWith('rgb(') && source.includes('/')) return true;
    if (source.startsWith('hsl(') && source.includes('/')) return true;
    return false;
  }

  let nativeColorPickerAlphaSupport = null;
  function supportsNativeColorPickerAlpha() {
    if (nativeColorPickerAlphaSupport !== null) return nativeColorPickerAlphaSupport;
    const probe = document.createElement('input');
    probe.type = 'color';
    probe.setAttribute('alpha', '');
    probe.setAttribute('colorspace', 'srgb');
    let supported = false;
    try {
      probe.value = 'rgba(17, 34, 51, 0.4)';
      supported = hasExplicitAlphaInColorText(probe.value);
    } catch (_) {
      supported = false;
    }
    if (!supported) {
      try {
        probe.value = '#11223366';
        supported = hasExplicitAlphaInColorText(probe.value) || String(probe.value || '').toLowerCase() === '#11223366';
      } catch (_) {
        supported = false;
      }
    }
    nativeColorPickerAlphaSupport = supported;
    return supported;
  }

  function getLinkedColorAlphaInput(colorInput) {
    if (!colorInput) return null;
    const container = colorInput.closest('.menu-item');
    if (container) {
      const scopedInput = container.querySelector('.settings-color-alpha');
      if (scopedInput) return scopedInput;
    }
    return null;
  }

  function getLinkedColorAlphaValueLabel(colorInput) {
    if (!colorInput) return null;
    const container = colorInput.closest('.menu-item');
    if (container) {
      const scopedLabel = container.querySelector('.settings-color-alpha-value');
      if (scopedLabel) return scopedLabel;
    }
    return null;
  }

  function isColorInputNativeAlphaEnabled(colorInput) {
    return colorInput?.dataset?.nativeAlpha === 'true';
  }

  function formatAlphaPercent(alpha) {
    const numeric = clamp01(alpha, 1);
    return `${Math.round(numeric * 100)}%`;
  }

  function readColorControlValue(def, colorInput) {
    if (!colorInput) return currentSettings[def.key];
    const fallbackColor = def.defaultValue || '#000000';
    const baseHex = normalizeHexColor(colorInput.value, fallbackColor);
    if (!def.alphaEnabled) return baseHex;
    const parsedInput = parseCssColorRgbaChannels(colorInput.value, fallbackColor);
    const rawInputValue = String(colorInput.value || '');
    if (isColorInputNativeAlphaEnabled(colorInput)) {
      const fallbackAlpha = parseCssColorRgbaChannels(currentSettings[def.key], fallbackColor).a;
      const storedAlpha = parseCssAlphaToken(colorInput.dataset.alphaValue, fallbackAlpha);
      const alpha = hasExplicitAlphaInColorText(rawInputValue) ? parsedInput.a : storedAlpha;
      colorInput.dataset.alphaValue = formatCssAlpha(alpha);
      return `rgba(${parsedInput.r}, ${parsedInput.g}, ${parsedInput.b}, ${formatCssAlpha(alpha)})`;
    }
    const alphaInput = getLinkedColorAlphaInput(colorInput);
    const alphaValue = alphaInput ? alphaInput.value : colorInput.dataset.alphaValue;
    const alpha = parseCssAlphaToken(alphaValue, parsedInput.a);
    colorInput.dataset.alphaValue = formatCssAlpha(alpha);
    const alphaValueLabel = getLinkedColorAlphaValueLabel(colorInput);
    if (alphaValueLabel) alphaValueLabel.textContent = formatAlphaPercent(alpha);
    return `rgba(${parsedInput.r}, ${parsedInput.g}, ${parsedInput.b}, ${formatCssAlpha(alpha)})`;
  }

  function writeColorControlValue(def, colorInput, value) {
    if (!colorInput) return;
    const fallbackColor = def.defaultValue || '#000000';
    if (!def.alphaEnabled) {
      const normalizedHex = normalizeHexColor(value, fallbackColor);
      colorInput.value = normalizedHex;
      const valueSpan = colorInput.closest('.menu-item')?.querySelector('.setting-value');
      if (valueSpan) valueSpan.textContent = normalizedHex.toUpperCase();
      return;
    }
    const normalizedColor = normalizeRgbaColor(value, fallbackColor);
    const parsedChannels = parseCssColorRgbaChannels(normalizedColor, fallbackColor);
    let normalizedAlpha = parsedChannels.a;
    if (isColorInputNativeAlphaEnabled(colorInput)) {
      // 原生 RGBA color picker：让浏览器自己维护颜色与 alpha。
      colorInput.value = normalizedColor;
      const parsedFromInput = parseCssColorRgbaChannels(colorInput.value, fallbackColor);
      normalizedAlpha = hasExplicitAlphaInColorText(colorInput.value)
        ? parsedFromInput.a
        : parsedChannels.a;
    } else {
      // 兼容回退：浏览器只支持 RGB 时，alpha 通过旁路滑条维护。
      colorInput.value = rgbChannelsToHex(parsedChannels);
      const alphaInput = getLinkedColorAlphaInput(colorInput);
      if (alphaInput) alphaInput.value = String(clamp01(parsedChannels.a, 1));
      const alphaValueLabel = getLinkedColorAlphaValueLabel(colorInput);
      if (alphaValueLabel) alphaValueLabel.textContent = formatAlphaPercent(parsedChannels.a);
    }
    colorInput.dataset.alphaValue = formatCssAlpha(normalizedAlpha);
    const valueSpan = colorInput.closest('.menu-item')?.querySelector('.setting-value');
    if (valueSpan) {
      valueSpan.textContent = `rgba(${parsedChannels.r}, ${parsedChannels.g}, ${parsedChannels.b}, ${formatCssAlpha(normalizedAlpha)})`;
    }
  }

  function applyDirectRgbaThemeVariable(settingKey, colorValue) {
    const root = document.documentElement;
    if (!root || !root.style) return;
    const normalized = normalizeRgbaColor(colorValue, DEFAULT_SETTINGS[settingKey] || '#000000');
    if (settingKey === 'customThemeUserMessageColor') {
      root.style.setProperty('--cerebr-message-user-bg', normalized);
      return;
    }
    if (settingKey === 'customThemeAiMessageColor') {
      root.style.setProperty('--cerebr-message-ai-bg', normalized);
      return;
    }
    if (settingKey === 'customThemeInputColor') {
      root.style.setProperty('--cerebr-input-bg', normalized);
      root.style.setProperty('--cerebr-panel-inline-bg', normalized);
    }
  }

  function setSetting(key, value) {
    if (!(key in DEFAULT_SETTINGS)) return;
    const normalizedValue = normalizeSettingValue(key, value);
    currentSettings[key] = normalizedValue;
    if (currentSettings.enableCustomThemeColors && CUSTOM_THEME_RGBA_SETTING_KEYS.has(key)) {
      // 在主流程之外增加一次直接变量写入，确保拖动 alpha 时视觉反馈立即可见。
      applyDirectRgbaThemeVariable(key, normalizedValue);
    }
    // 应用
    const schema = getSchemaMap();
    if (schema[key]?.apply) {
      schema[key].apply(normalizedValue);
    }
    // 持久化
    saveSetting(key, normalizedValue);
    // 通知订阅者
    const set = subscribers.get(key);
    if (set) {
      set.forEach((cb) => {
        try { cb(normalizedValue); } catch (e) { console.error('订阅回调异常', e); }
      });
    }
  }

  /**
   * 从 schema 绑定 DOM 事件（统一 change 入口）
   */
  function bindSettingsFromSchema() {
    const schema = getSchemaMap();
    const registryMap = new Map(getActiveRegistry().map((item) => [item.key, item]));
    Object.keys(schema).forEach((key) => {
      const def = schema[key];
      const el = def.element?.();
      if (!el) return;
      const registryDef = registryMap.get(key);
      const ensureCustomThemeColorModeEnabled = () => {
        if (registryDef?.type !== 'color') return;
        if (!CUSTOM_THEME_COLOR_SETTING_KEYS.has(key)) return;
        if (currentSettings.enableCustomThemeColors) return;
        setSetting('enableCustomThemeColors', true);
      };
      // 避免重复绑定：先移除已存在的监听（若实现上无此需求，可忽略）
      el.addEventListener('change', (e) => {
        ensureCustomThemeColorModeEnabled();
        const newValue = def.readFromUI ? def.readFromUI(el) : e.target?.value;
        setSetting(key, newValue);
      });
      if (registryDef?.type === 'color') {
        // 颜色选择器在拖动/取色时持续触发 input，使用实时应用可明显提升调色反馈。
        el.addEventListener('input', (e) => {
          ensureCustomThemeColorModeEnabled();
          const newValue = def.readFromUI ? def.readFromUI(el) : e.target?.value;
          setSetting(key, newValue);
          if (def.writeToUI) def.writeToUI(el, newValue);
        });
        if (registryDef.alphaEnabled) {
          const alphaInput = getLinkedColorAlphaInput(el);
          if (alphaInput) {
            const syncAlphaColor = () => {
              ensureCustomThemeColorModeEnabled();
              const newValue = def.readFromUI ? def.readFromUI(el) : readColorControlValue(registryDef, el);
              setSetting(key, newValue);
              if (def.writeToUI) def.writeToUI(el, newValue);
            };
            alphaInput.addEventListener('input', syncAlphaColor);
            alphaInput.addEventListener('change', syncAlphaColor);
          }
        }
      }
      // 初始 UI 同步
      if (def.writeToUI) def.writeToUI(el, currentSettings[key]);
    });
  }

  // 渲染注册表定义到设置菜单
  function renderSettingsFromRegistry() {
    const quickContainer = settingsMenu || document.getElementById('settings-menu');
    const panelContainer = ensureEscSettingsMenu();
    if (!quickContainer && !panelContainer) return;
    const sharedTemplateVariablePanels = new Map();

    const getElementId = (def) => def.id || `setting-${def.key}`;
    // 避免 Esc 设置容器未挂载时重复渲染导致控件重复
    const normalizeExistingElement = (elementId, preferredContainer) => {
      if (!elementId) return null;
      const candidates = [];
      if (quickContainer) candidates.push(...quickContainer.querySelectorAll(`#${elementId}`));
      if (panelContainer) candidates.push(...panelContainer.querySelectorAll(`#${elementId}`));
      if (!candidates.length) {
        const docEl = document.getElementById(elementId);
        if (docEl) candidates.push(docEl);
      }
      if (!candidates.length) return null;
      let keep = null;
      if (preferredContainer) {
        keep = preferredContainer.querySelector(`#${elementId}`);
      }
      if (!keep) keep = candidates[0];
      for (const el of candidates) {
        if (el === keep) continue;
        const item = el.closest('.menu-item');
        if (item && item.parentElement) {
          item.parentElement.removeChild(item);
        } else if (el.parentElement) {
          el.parentElement.removeChild(el);
        }
      }
      return keep;
    };

    if (quickContainer && panelContainer) {
      const themeSelector = panelContainer.querySelector('#theme-selector');
      if (themeSelector && !quickContainer.contains(themeSelector)) {
        quickContainer.insertBefore(themeSelector, quickContainer.firstChild);
      }
    }

    const ensureAutoSection = (container, scope) => {
      if (!container) return null;
      const selector = `.settings-auto-section[data-scope="${scope}"]`;
      let autoSection = container.querySelector(selector);
      if (!autoSection) {
        autoSection = document.createElement('div');
        autoSection.className = 'settings-auto-section';
        autoSection.dataset.scope = scope;
        if (scope === 'quick') {
          // 让主题/随机背景/停靠模式固定在菜单上方，快捷项放在其后，避免把按钮挤到列表下方。
          const anchor = container.querySelector('#dock-mode-toggle')
            || container.querySelector('#settings-random-background')
            || container.querySelector('#theme-selector');
          if (anchor?.nextSibling) {
            container.insertBefore(autoSection, anchor.nextSibling);
          } else {
            container.appendChild(autoSection);
          }
        } else {
          container.appendChild(autoSection);
        }
      }
      if (scope === 'quick') {
        const anchor = container.querySelector('#dock-mode-toggle')
          || container.querySelector('#settings-random-background')
          || container.querySelector('#theme-selector');
        if (anchor && anchor.nextSibling !== autoSection) {
          container.insertBefore(autoSection, anchor.nextSibling);
        }
      }
      return autoSection;
    };
    const GROUP_LABELS = {
      theme: '主题与配色',
      background: '背景',
      display: '显示',
      layout: '布局',
      behavior: '行为',
      input: '输入',
      capture: '图片导出',
      title: '对话标题',
      advanced: '高级',
      other: '其他'
    };
    const THEME_SECTION_LABELS = {
      'theme-core': '基础颜色',
      'theme-chat': '对话气泡',
      'theme-accent': '强调与图标',
      'theme-status': '状态语义色',
      'theme-code': '代码块'
    };
    const normalizeGroupKey = (def) => {
      if (def && typeof def.group === 'string' && def.group.trim()) {
        return def.group.trim();
      }
      return 'other';
    };
    const ensureGroupSection = (autoSection, groupKey) => {
      if (!autoSection) return null;
      const key = groupKey || 'other';
      let groupEl = autoSection.querySelector(`.settings-group[data-group="${key}"]`);
      if (!groupEl) {
        groupEl = document.createElement('div');
        groupEl.className = 'settings-group';
        groupEl.dataset.group = key;

        const title = document.createElement('div');
        title.className = 'settings-group-title';
        title.textContent = GROUP_LABELS[key] || GROUP_LABELS.other;

        groupEl.appendChild(title);
        autoSection.appendChild(groupEl);
      }
      return groupEl;
    };
    const ensureThemeSubgroupSection = (groupSection, def) => {
      if (!groupSection || normalizeGroupKey(def) !== 'theme') return groupSection;
      const sectionKey = (typeof def.section === 'string' && def.section.trim())
        ? def.section.trim()
        : '';
      if (!sectionKey) return groupSection;
      let subgroupEl = groupSection.querySelector(`.settings-subgroup[data-section="${sectionKey}"]`);
      if (!subgroupEl) {
        subgroupEl = document.createElement('div');
        subgroupEl.className = 'settings-subgroup';
        subgroupEl.dataset.section = sectionKey;
        const title = document.createElement('div');
        title.className = 'settings-subgroup-title';
        title.textContent = THEME_SECTION_LABELS[sectionKey] || sectionKey;
        subgroupEl.appendChild(title);
        groupSection.appendChild(subgroupEl);
      }
      return subgroupEl;
    };
    const resolveContainer = (def) => {
      const wantsQuick = def.menu === 'quick';
      if (wantsQuick) {
        const target = quickContainer || panelContainer;
        if (!target) return { container: null, scope: null };
        const scope = target === quickContainer ? 'quick' : 'panel';
        return { container: target, scope };
      }
      if (!panelContainer) return { container: null, scope: null };
      return { container: panelContainer, scope: 'panel' };
    };

    // 为每个注册项生成控件（若页面已存在同ID控件则跳过；uiHidden=true 时不渲染控件）
    for (const def of getActiveRegistry()) {
      const elementId = getElementId(def);
      const preferredContainer = (def.menu === 'quick' && quickContainer) ? quickContainer : panelContainer;
      const existing = normalizeExistingElement(elementId, preferredContainer);
      if (def.uiHidden === true) {
        if (existing) {
          dynamicElements.set(def.key, existing);
        }
        // 不渲染 UI，但该设置仍会被加载/保存/应用（通过 applyAllSettings）
        continue;
      }
      const { container, scope } = resolveContainer(def);
      const autoSection = ensureAutoSection(container, scope);
      const targetSection = (scope === 'panel')
        ? ensureGroupSection(autoSection, normalizeGroupKey(def))
        : autoSection;
      const targetBucket = (scope === 'panel')
        ? ensureThemeSubgroupSection(targetSection, def)
        : targetSection;
      if (existing) {
        dynamicElements.set(def.key, existing);
        const existingItem = existing.closest('.menu-item');
        if (targetBucket && existingItem && existingItem.parentElement !== targetBucket) {
          targetBucket.appendChild(existingItem);
        }
        continue;
      }
      if (!autoSection || !targetBucket) continue;

      const item = document.createElement('div');
      item.className = 'menu-item';

      const labelSpan = document.createElement('span');
      labelSpan.textContent = def.label || def.key;
      item.appendChild(labelSpan);

      if (def.type === 'toggle') {
        item.classList.add('menu-item--toggle');
        const wrap = document.createElement('label');
        wrap.className = 'switch';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = def.id || `setting-${def.key}`;
        const slider = document.createElement('span');
        slider.className = 'slider';
        wrap.appendChild(input);
        wrap.appendChild(slider);
        item.appendChild(wrap);
        targetBucket.appendChild(item);
        dynamicElements.set(def.key, input);
      } else if (def.type === 'range') {
        item.classList.add('menu-item--range');
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(def.min ?? 0);
        input.max = String(def.max ?? 100);
        input.step = String(def.step ?? 1);
        input.id = def.id || `setting-${def.key}`;
        const valueSpan = document.createElement('span');
        valueSpan.className = 'setting-value';
        valueSpan.textContent = formatDisplayValue(def, currentSettings[def.key] ?? def.defaultValue);
        input.addEventListener('input', (e) => {
          valueSpan.textContent = formatDisplayValue(def, parseFloat(input.value));
        });
        item.appendChild(input);
        item.appendChild(valueSpan);
        targetBucket.appendChild(item);
        dynamicElements.set(def.key, input);
      } else if (def.type === 'color') {
        item.classList.add('menu-item--color');
        const input = document.createElement('input');
        input.type = 'color';
        input.id = def.id || `setting-${def.key}`;

        const valueSpan = document.createElement('span');
        valueSpan.className = 'setting-value';
        if (def.alphaEnabled) {
          const useNativeAlphaPicker = supportsNativeColorPickerAlpha();
          input.dataset.nativeAlpha = useNativeAlphaPicker ? 'true' : 'false';
          if (useNativeAlphaPicker) {
            // 支持时优先使用浏览器原生 RGBA 取色面板（单控件完成颜色+透明度）。
            input.setAttribute('alpha', '');
            input.setAttribute('colorspace', 'srgb');
          } else {
            // 回退到“颜色 + Alpha 滑条”组合，确保旧浏览器也能调透明度。
            item.classList.add('menu-item--color-rgba');
            const alphaInput = document.createElement('input');
            alphaInput.type = 'range';
            alphaInput.min = '0';
            alphaInput.max = '1';
            alphaInput.step = '0.01';
            alphaInput.className = 'settings-color-alpha';
            const alphaValue = document.createElement('span');
            alphaValue.className = 'settings-color-alpha-value';
            item.appendChild(input);
            item.appendChild(alphaInput);
            item.appendChild(alphaValue);
            item.appendChild(valueSpan);
            targetBucket.appendChild(item);
            dynamicElements.set(def.key, input);
            writeColorControlValue(def, input, currentSettings[def.key] ?? def.defaultValue);
            continue;
          }
        }
        item.appendChild(input);
        item.appendChild(valueSpan);
        targetBucket.appendChild(item);
        dynamicElements.set(def.key, input);
        writeColorControlValue(def, input, currentSettings[def.key] ?? def.defaultValue);
      } else if (def.type === 'text' || def.type === 'textarea') {
        if (def.type === 'text' && def.id === 'background-image-url') {
          item.classList.add('background-image-setting');
          labelSpan.classList.add('background-image-label');

          const actions = document.createElement('div');
          actions.className = 'background-image-actions';

          const setWrapper = document.createElement('div');
          setWrapper.className = 'background-image-set-wrapper';

          const setButton = document.createElement('button');
          setButton.type = 'button';
          setButton.className = 'background-image-button background-image-button--set';
          setButton.textContent = '设置';
          setWrapper.appendChild(setButton);

          const popover = document.createElement('div');
          popover.className = 'background-image-popover';

          const input = document.createElement('textarea');
          input.id = def.id || `setting-${def.key}`;
          input.placeholder = def.placeholder || '';
          input.className = 'background-image-input';
          input.rows = 6;
          popover.appendChild(input);
          setWrapper.appendChild(popover);

          actions.appendChild(setWrapper);

          const clearBtn = document.createElement('button');
          clearBtn.type = 'button';
          clearBtn.className = 'background-image-button background-image-button--clear';
          clearBtn.textContent = '清除';
          clearBtn.addEventListener('click', (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            input.value = '';
            item.classList.remove('has-background-image');
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.focus();
          });
          actions.appendChild(clearBtn);

          item.appendChild(actions);
          targetBucket.appendChild(item);

          dynamicElements.set(def.key, input);

          if (typeof def.writeToUI === 'function') {
            try { def.writeToUI(input, currentSettings[def.key]); } catch (_) {}
          }

          setButton.addEventListener('click', (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            input.focus();
            input.select();
          });

          popover.addEventListener('click', (evt) => evt.stopPropagation());

          input.addEventListener('keydown', (evt) => {
            if (evt.key === 'Escape') {
              evt.stopPropagation();
              input.blur();
            }
          });

          input.addEventListener('input', () => {
            item.classList.toggle('has-background-image', !!input.value.trim());
          });

        } else {
          item.classList.add('menu-item--stack');
          let deferredTemplateTooltip = null;
          const input = (def.type === 'textarea')
            ? document.createElement('textarea')
            : document.createElement('input');
          if (def.type !== 'textarea') {
            input.type = 'text';
          }
          input.id = def.id || `setting-${def.key}`;
          input.placeholder = def.placeholder || '';
          input.className = def.type === 'textarea'
            ? 'settings-text-input settings-textarea'
            : 'settings-text-input';
          if (def.type === 'textarea' && def.rows) {
            input.rows = Number(def.rows) || 3;
          }
          item.appendChild(input);

          if (def.key !== 'conversationTitlePrompt' && def.hideClearButton !== true) {
            const actionBar = document.createElement('div');
            actionBar.className = 'settings-input-actions';
            const clearBtn = document.createElement('button');
            clearBtn.type = 'button';
            clearBtn.className = 'settings-input-clear';
            clearBtn.textContent = '清除';
            clearBtn.addEventListener('click', (evt) => {
              evt.preventDefault();
              evt.stopPropagation();
              input.value = '';
              input.dispatchEvent(new Event('change', { bubbles: true }));
            });
            actionBar.appendChild(clearBtn);
            item.appendChild(actionBar);
          }

          if (Array.isArray(def.copyableVariables) && def.copyableVariables.length > 0) {
            const sharedPanelKey = (typeof def.sharedCopyableVariablesPanelKey === 'string')
              ? def.sharedCopyableVariablesPanelKey.trim()
              : '';
            if (sharedPanelKey) {
              const state = sharedTemplateVariablePanels.get(sharedPanelKey) || {
                targets: [],
                title: '',
                hint: '',
                copyableVariables: [],
                hostRendered: false
              };
              if (!state.title && typeof def.sharedCopyableVariablesTitle === 'string') {
                state.title = def.sharedCopyableVariablesTitle.trim();
              }
              if (!state.hint && typeof def.sharedCopyableVariablesHint === 'string') {
                state.hint = def.sharedCopyableVariablesHint.trim();
              }
              if ((!Array.isArray(state.copyableVariables) || state.copyableVariables.length <= 0)
                && Array.isArray(def.copyableVariables)
                && def.copyableVariables.length > 0) {
                state.copyableVariables = def.copyableVariables;
              }
              state.targets.push({
                key: def.key,
                label: (typeof def.sharedCopyableVariablesTargetLabel === 'string' && def.sharedCopyableVariablesTargetLabel.trim())
                  ? def.sharedCopyableVariablesTargetLabel.trim()
                  : (def.label || def.key),
                input
              });
              sharedTemplateVariablePanels.set(sharedPanelKey, state);

              if (def.sharedCopyableVariablesHost === true && state.hostRendered !== true) {
                const sharedPanel = createTemplateVariablePanel({
                  title: state.title || '可用变量',
                  hint: state.hint,
                  copyableVariables: state.copyableVariables,
                  targets: state.targets
                });
                if (sharedPanel) {
                  sharedPanel.classList.add('settings-template-variable-tooltip--detached');
                  const tooltipPanel = document.createElement('div');
                  tooltipPanel.className = 'menu-item menu-item--stack menu-item--template-variables';
                  tooltipPanel.dataset.sharedPanelKey = sharedPanelKey;
                  tooltipPanel.appendChild(sharedPanel);
                  deferredTemplateTooltip = tooltipPanel;
                  state.hostRendered = true;
                }
              }
            } else {
              const tooltip = createTemplateVariablePanel({
                title: def.copyableVariablesTitle || '可用变量（点击追加到末尾）',
                hint: def.copyableVariablesHint,
                copyableVariables: def.copyableVariables,
                targets: [{
                  key: def.key,
                  label: def.label || def.key,
                  input
                }]
              });
              if (tooltip) {
                if (def.copyableVariablesPlacement === 'after-item') {
                  tooltip.classList.add('settings-template-variable-tooltip--detached');
                  const tooltipPanel = document.createElement('div');
                  tooltipPanel.className = 'menu-item menu-item--stack menu-item--template-variables';
                  tooltipPanel.appendChild(tooltip);
                  deferredTemplateTooltip = tooltipPanel;
                } else {
                  item.appendChild(tooltip);
                }
              }
            }
          }

          targetBucket.appendChild(item);
          if (deferredTemplateTooltip) {
            targetBucket.appendChild(deferredTemplateTooltip);
          }
          dynamicElements.set(def.key, input);
        }
      } else if (def.type === 'select') {
        item.classList.add('menu-item--select');
        const select = document.createElement('select');
        select.id = def.id || `setting-${def.key}`;
        const optionsArr = typeof def.options === 'function' ? def.options() : (def.options || []);
        optionsArr.forEach(opt => {
          const o = document.createElement('option');
          if (typeof opt === 'string') {
            o.value = opt; o.textContent = opt;
          } else {
            o.value = opt.value; o.textContent = opt.label;
          }
          select.appendChild(o);
        });
        item.appendChild(select);
        targetBucket.appendChild(item);
        dynamicElements.set(def.key, select);
      } else if (def.type === 'multi_select_dropdown') {
        item.classList.add('menu-item--select', 'menu-item--multi-select');

        const control = document.createElement('div');
        control.className = 'settings-multiselect';
        control.id = def.id || `setting-${def.key}`;

        const toggleButton = document.createElement('button');
        toggleButton.type = 'button';
        toggleButton.className = 'settings-multiselect-toggle';
        toggleButton.setAttribute('aria-haspopup', 'true');
        toggleButton.setAttribute('aria-expanded', 'false');

        const panel = document.createElement('div');
        panel.className = 'settings-multiselect-panel';

        const optionsWrap = document.createElement('div');
        optionsWrap.className = 'settings-multiselect-options';
        panel.appendChild(optionsWrap);

        const setOpen = (open) => {
          const nextOpen = open === true;
          if (nextOpen) {
            document.querySelectorAll('.settings-multiselect.is-open').forEach((node) => {
              if (node !== control) {
                node.classList.remove('is-open');
                const button = node.querySelector('.settings-multiselect-toggle');
                if (button) button.setAttribute('aria-expanded', 'false');
              }
            });
          }
          control.classList.toggle('is-open', nextOpen);
          toggleButton.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
        };

        toggleButton.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(!control.classList.contains('is-open'));
        });
        panel.addEventListener('click', (event) => {
          event.stopPropagation();
        });
        control.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            setOpen(false);
            toggleButton.focus();
          }
        });
        document.addEventListener('click', (event) => {
          if (!control.contains(event.target)) {
            setOpen(false);
          }
        });

        control.appendChild(toggleButton);
        control.appendChild(panel);
        item.appendChild(control);
        targetBucket.appendChild(item);
        dynamicElements.set(def.key, control);
        if (typeof def.writeToUI === 'function') {
          try { def.writeToUI(control, currentSettings[def.key] ?? def.defaultValue); } catch (_) {}
        }
      }
    }
  }

  /**
   * 根据当前布局模式（侧栏 / 全屏）控制“宽度滑条”的显隐。
   *
   * 背景：历史版本只有一个 sidebarWidth，既用于侧栏宽度，也用于全屏布局的内容列宽度。
   * 本次新增 fullscreenWidth 后，为避免用户同时看到两个滑条造成困惑，需要按模式只展示一个：
   * - 侧栏模式：显示「侧栏宽度」，隐藏「全屏宽度」
   * - 全屏模式：显示「全屏宽度」，隐藏「侧栏宽度」
   *
   * 这里不移除节点，只切换 menu-item 的 display，避免重新渲染/重新绑定事件带来的状态抖动。
   */
  function updateWidthSlidersVisibility() {
    const root = document.documentElement;
    const isFullscreenLayout = isStandalone || !!root?.classList?.contains('fullscreen-mode');

    const sidebarWidthEl = dynamicElements.get('sidebarWidth') || document.getElementById('sidebar-width');
    const fullscreenWidthEl = dynamicElements.get('fullscreenWidth') || document.getElementById('fullscreen-width');

    const sidebarItem = sidebarWidthEl?.closest?.('.menu-item') || null;
    const fullscreenItem = fullscreenWidthEl?.closest?.('.menu-item') || null;

    if (sidebarItem) sidebarItem.style.display = isFullscreenLayout ? 'none' : '';
    if (fullscreenItem) fullscreenItem.style.display = isFullscreenLayout ? '' : 'none';
    syncFullscreenWidthControlBounds();
  }

  /**
   * 监听全屏模式 class 的变化，确保用户在切换全屏时设置面板能即时刷新显示的滑条。
   * 说明：全屏状态由 sidebar_events.js 通过切换 html.fullscreen-mode 实现，监听 class 最稳定。
   */
  function setupFullscreenModeObserver() {
    updateWidthSlidersVisibility();

    try {
      const root = document.documentElement;
      if (!root) return;

      const observer = new MutationObserver(() => {
        updateWidthSlidersVisibility();
      });

      observer.observe(root, {
        attributes: true,
        attributeFilter: ['class']
      });
    } catch (e) {
      console.warn('注册全屏模式监听失败（忽略）:', e);
    }
  }

  function formatDisplayValue(def, value) {
    if (def.type === 'color') {
      if (def.alphaEnabled) {
        return normalizeRgbaColor(value, def.defaultValue || '#000000');
      }
      return normalizeHexColor(value, def.defaultValue || '#000000').toUpperCase();
    }
    if (typeof def.formatValue === 'function') {
      try {
        return def.formatValue(value);
      } catch (error) {
        console.error('格式化设置值失败', def.key, error);
      }
    }
    if (def.unit === 'px') return `${value}px`;
    if (def.unit === 'x') return `${Number(value).toFixed(1)}x`;
    if (def.unit) return `${value}${def.unit}`;
    return String(value);
  }
  
  // 初始化所有设置
  async function initSettings() {
    try {
      console.log('初始化设置...');
      const syncKeys = Object.keys(DEFAULT_SETTINGS).filter((key) => !NON_SYNC_SETTINGS_KEYS.has(key));
      const result = await chrome.storage.sync.get(syncKeys);
      let localResult = {};
      if (NON_SYNC_SETTINGS_KEYS.size) {
        localResult = await chrome.storage.local.get([...NON_SYNC_SETTINGS_KEYS]);
      }
      
      // 合并默认设置和已保存的设置
      currentSettings = {...DEFAULT_SETTINGS, ...result, ...localResult};
      // 用已持久化值初始化写入队列快照，避免重复写入
      queueStoragePrime('sync', result);
      queueStoragePrime('local', localResult);

      // 清理不应存入 sync 的大字段，避免占用同步配额
      if (NON_SYNC_SETTINGS_KEYS.size) {
        try {
          await chrome.storage.sync.remove([...NON_SYNC_SETTINGS_KEYS]);
        } catch (e) {
          console.warn('清理非同步设置失败（忽略）:', e);
        }
      }

      // 兼容旧版本：首次引入 fullscreenWidth 时，用已有的 sidebarWidth 作为初始值。
      // 这样升级后不会出现“全屏宽度突然变窄/变宽”的跳变体验。
      if (!Object.prototype.hasOwnProperty.call(result, 'fullscreenWidth')) {
        currentSettings.fullscreenWidth = currentSettings.sidebarWidth;
        try {
          await queueStorageSet('sync', { fullscreenWidth: currentSettings.fullscreenWidth }, { flush: 'now' });
        } catch (e) {
          console.warn('写入 fullscreenWidth 默认值失败（忽略）:', e);
        }
      }

      // 兼容旧版本“聊天/输入模糊”拆分：
      // - 旧键：chatInputBlurRadius（同时作用于主界面和消息）
      // - 新键：mainUiBlurRadius / messageBlurRadius（分别控制）
      // 迁移策略：仅在新键缺失时，用旧值补齐，确保升级后视觉不突变。
      const hasLegacyBlur = Object.prototype.hasOwnProperty.call(result, 'chatInputBlurRadius');
      const hasMainUiBlur = Object.prototype.hasOwnProperty.call(result, 'mainUiBlurRadius');
      const hasMessageBlur = Object.prototype.hasOwnProperty.call(result, 'messageBlurRadius');
      if (hasLegacyBlur && (!hasMainUiBlur || !hasMessageBlur)) {
        const legacyBlur = clampBlurRadiusPx(result.chatInputBlurRadius);
        const blurPatch = {};
        if (!hasMainUiBlur) {
          currentSettings.mainUiBlurRadius = legacyBlur;
          blurPatch.mainUiBlurRadius = legacyBlur;
        }
        if (!hasMessageBlur) {
          currentSettings.messageBlurRadius = legacyBlur;
          blurPatch.messageBlurRadius = legacyBlur;
        }
        if (Object.keys(blurPatch).length > 0) {
          try {
            await queueStorageSet('sync', blurPatch, { flush: 'now' });
          } catch (e) {
            console.warn('迁移模糊拆分设置失败（忽略）:', e);
          }
        }
      }
      
      // 应用所有设置到UI
      applyAllSettings();
      
      console.log('设置初始化完成');
    } catch (error) {
      console.error('初始化设置失败:', error);
    }

    // 监听跨标签页 storage 变更，按键增量应用，避免状态漂移
    try {
      if (!chrome?.storage?.onChanged) return;
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'sync' && areaName !== 'local') return;
        let mutated = false;
        Object.keys(changes).forEach((key) => {
          if (!(key in DEFAULT_SETTINGS)) return;
          if (areaName === 'sync' && NON_SYNC_SETTINGS_KEYS.has(key)) return;
          if (areaName === 'local' && !NON_SYNC_SETTINGS_KEYS.has(key)) return;
          const { newValue } = changes[key] || {};
          // 仅在值确实变化时应用
          if (typeof newValue === 'undefined') return;
          const normalizedValue = normalizeSettingValue(key, newValue);
          if (currentSettings[key] === normalizedValue) return;
          currentSettings[key] = normalizedValue;
          queueStoragePrime(areaName, { [key]: normalizedValue });
          // 按注册项 apply 与 UI 同步
          const def = getActiveRegistry().find(d => d.key === key);
          if (def) {
            try { if (typeof def.apply === 'function') def.apply(normalizedValue); } catch (e) { console.warn('应用存储变更失败', key, e); }
            const el = dynamicElements.get(key);
            try {
              const entry = generatedSchema[key];
              if (el && entry?.writeToUI) entry.writeToUI(el, normalizedValue);
            } catch (_) {}
          }
          mutated = true;
        });
        if (mutated) {
          // 某些 UI 派生项（如宽度/字体显示文本）需要刷新显示值
          try { applyAllSettings(); } catch (_) {}
        }
      });
    } catch (e) {
      console.warn('注册 storage 变更监听失败（忽略）：', e);
    }
  }
  
  // 保存单个设置（统一走写入队列）
  function saveSetting(key, value) {
    try {
      currentSettings[key] = value;
      const area = NON_SYNC_SETTINGS_KEYS.has(key) ? 'local' : 'sync';
      queueStorageSet(area, { [key]: value });
    } catch (error) {
      console.error(`保存设置${key}失败:`, error);
    }
  }
  
  // 应用所有设置到UI
  function applyAllSettings() {
    // 应用所有注册项设置（有 apply 的会被调用），并同步 UI
    getActiveRegistry().forEach(def => {
      const value = currentSettings[def.key] ?? def.defaultValue;
      const effectiveValue = normalizeSettingValue(def.key, value);
      if (typeof def.apply === 'function') {
        try { def.apply(effectiveValue); } catch (e) { console.error('应用设置失败', def.key, e); }
      }
      const el = dynamicElements.get(def.key);
      if (el) {
        const entry = generatedSchema[def.key];
        if (entry?.writeToUI) entry.writeToUI(el, effectiveValue);
      }
    });
  }

  const colorParseCanvas = document.createElement('canvas');
  colorParseCanvas.width = 1;
  colorParseCanvas.height = 1;
  let colorParseCtx = null;
  try {
    colorParseCtx = colorParseCanvas.getContext('2d', { willReadFrequently: true });
  } catch (_) {
    colorParseCtx = colorParseCanvas.getContext('2d');
  }

  function normalizeHexColor(value, fallback = '#000000') {
    const fallbackColor = String(fallback || '#000000').trim().toLowerCase();
    const raw = String(value || '').trim().toLowerCase();
    const candidate = raw.startsWith('#') ? raw : `#${raw}`;
    if (/^#[0-9a-f]{6}$/.test(candidate)) return candidate;
    if (/^#[0-9a-f]{3}$/.test(candidate)) {
      return `#${candidate[1]}${candidate[1]}${candidate[2]}${candidate[2]}${candidate[3]}${candidate[3]}`;
    }
    return /^#[0-9a-f]{6}$/.test(fallbackColor) ? fallbackColor : '#000000';
  }

  function hexToRgbChannels(hexColor) {
    const normalized = normalizeHexColor(hexColor, '#000000');
    const intVal = Number.parseInt(normalized.slice(1), 16);
    return {
      r: (intVal >> 16) & 255,
      g: (intVal >> 8) & 255,
      b: intVal & 255
    };
  }

  function resolveCssVarTokens(rawValue, computedStyle, depth = 0) {
    const source = String(rawValue || '').trim();
    if (!source || !source.includes('var(') || depth > 6) {
      return source;
    }
    const resolved = source.replace(/var\(\s*(--[a-zA-Z0-9-_]+)\s*(?:,\s*([^)]+))?\)/g, (_, variableName, fallbackValue = '') => {
      const variableRaw = computedStyle?.getPropertyValue(variableName)?.trim();
      if (variableRaw) return variableRaw;
      return String(fallbackValue || '').trim();
    });
    if (!resolved.includes('var(')) {
      return resolved;
    }
    return resolveCssVarTokens(resolved, computedStyle, depth + 1);
  }

  function clampColorChannel(value) {
    const numeric = Number.parseInt(String(value), 10);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(255, numeric));
  }

  function formatCssAlpha(value) {
    const normalized = clamp01(value, 1);
    return Number.parseFloat(normalized.toFixed(3)).toString();
  }

  function parseCssAlphaToken(value, fallback = 1) {
    const raw = String(value ?? '').trim();
    if (!raw) return clamp01(fallback, 1);
    if (raw.endsWith('%')) {
      const percent = Number.parseFloat(raw.slice(0, -1));
      if (!Number.isFinite(percent)) return clamp01(fallback, 1);
      return clamp01(percent / 100, fallback);
    }
    const numeric = Number.parseFloat(raw);
    if (!Number.isFinite(numeric)) return clamp01(fallback, 1);
    return clamp01(numeric, fallback);
  }

  function parseExplicitRgbFunction(colorValue) {
    // 优先解析形如 rgb()/rgba() 的直接字面量，避免经过 canvas 后 Alpha 被量化到 8bit 导致数值跳变。
    const source = String(colorValue || '').trim();
    const match = source.match(
      /^rgba?\(\s*([+\-]?\d*\.?\d+)\s*,\s*([+\-]?\d*\.?\d+)\s*,\s*([+\-]?\d*\.?\d+)(?:\s*(?:,|\/)\s*([+\-]?\d*\.?\d+%?))?\s*\)$/i
    );
    if (!match) return null;
    return {
      r: clampColorChannel(Math.round(Number.parseFloat(match[1]))),
      g: clampColorChannel(Math.round(Number.parseFloat(match[2]))),
      b: clampColorChannel(Math.round(Number.parseFloat(match[3]))),
      a: parseCssAlphaToken(match[4], 1)
    };
  }

  function rgbChannelsToHex({ r, g, b }) {
    const toHex = (channel) => clampColorChannel(channel).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  function parseCssColorRgbaChannels(colorValue, fallbackColor = '#000000') {
    const literalColor = parseExplicitRgbFunction(colorValue);
    if (literalColor) return literalColor;
    if (!colorParseCtx) {
      const fallbackLiteral = parseExplicitRgbFunction(fallbackColor);
      if (fallbackLiteral) return fallbackLiteral;
      const fallbackHex = normalizeHexColor(fallbackColor, '#000000');
      const fallback = hexToRgbChannels(fallbackHex);
      return { ...fallback, a: 1 };
    }
    const rootComputedStyle = getComputedStyle(document.documentElement);
    colorParseCtx.clearRect(0, 0, 1, 1);
    const assignColor = (candidateValue) => {
      const resolved = resolveCssVarTokens(candidateValue, rootComputedStyle);
      if (!resolved) return false;
      try {
        colorParseCtx.fillStyle = resolved;
        return true;
      } catch (_) {
        return false;
      }
    };
    if (!assignColor(fallbackColor) && !assignColor('#000000')) {
      colorParseCtx.fillStyle = '#000000';
    }
    assignColor(colorValue);
    colorParseCtx.fillRect(0, 0, 1, 1);
    const data = colorParseCtx.getImageData(0, 0, 1, 1).data;
    return {
      r: data[0],
      g: data[1],
      b: data[2],
      a: clamp01(data[3] / 255, 1)
    };
  }

  function normalizeRgbaColor(value, fallback = '#000000') {
    const { r, g, b, a } = parseCssColorRgbaChannels(value, fallback);
    return `rgba(${r}, ${g}, ${b}, ${formatCssAlpha(a)})`;
  }

  function parseCssColorChannels(colorValue, fallbackColor = '#000000') {
    const data = parseCssColorRgbaChannels(colorValue, fallbackColor);
    return {
      r: data.r,
      g: data.g,
      b: data.b
    };
  }

  function toOpacityColor(hexColor, alphaToken = '1') {
    const { r, g, b } = hexToRgbChannels(hexColor);
    return `rgba(${r}, ${g}, ${b}, ${alphaToken})`;
  }

  function composeRgbaFromCssColor(colorValue, alphaValue, fallbackColor = '#000000', options = {}) {
    const { r, g, b, a: sourceAlpha } = parseCssColorRgbaChannels(colorValue, fallbackColor);
    const alpha = options.preserveSourceAlpha
      ? clamp01(sourceAlpha, 1)
      : clamp01(alphaValue, 1);
    return `rgba(${r}, ${g}, ${b}, ${formatCssAlpha(alpha)})`;
  }

  function computeRelativeLuminanceFromRgbChannels(r, g, b) {
    const toLinear = (channel) => {
      const normalized = Math.max(0, Math.min(1, Number(channel) / 255));
      if (normalized <= 0.04045) return normalized / 12.92;
      return ((normalized + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  }

  function composeOpaqueBaseColor(colorValue, strengthValue, fallbackColor = '#000000') {
    const { r, g, b } = parseCssColorChannels(colorValue, fallbackColor);
    const strength = clamp01(strengthValue, 1);
    // 底色保持不透明：用同明暗方向的锚点色（黑/白）与主题色做混合，
    // 强度越高越接近主题原色，越低越接近锚点色，但 alpha 始终为 1。
    const luminance = computeRelativeLuminanceFromRgbChannels(r, g, b);
    const anchor = luminance >= 0.5 ? 255 : 0;
    const mix = (channel) => Math.round(anchor + (channel - anchor) * strength);
    return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
  }

  function computeThemeOpacityProfile({ backgroundOpacity, elementOpacity }) {
    const baseStrength = clamp01(
      backgroundOpacity,
      DEFAULT_SETTINGS.backgroundOpacity
    );
    const uiOpacity = clamp01(
      elementOpacity,
      DEFAULT_SETTINGS.elementOpacity
    );
    // 默认情况下，消息与输入框的透明度跟随 elementOpacity。
    // 若启用自定义 RGBA 颜色，会在 applyThemeOpacityOverrides 中改为保留颜色自身 Alpha。
    const messageUserOpacity = uiOpacity;
    const messageAiOpacity = uiOpacity;
    const inputOpacity = uiOpacity;
    // 面板保持轻微“保底抬升”以提升 blur 可读性。
    const panelSurfaceOpacity = clamp01(uiOpacity + (1 - uiOpacity) * 0.35, uiOpacity);
    const panelSurfaceStrongOpacity = clamp01(uiOpacity + (1 - uiOpacity) * 0.45, uiOpacity);
    const panelInlineOpacity = clamp01(uiOpacity + (1 - uiOpacity) * 0.28, uiOpacity);
    return {
      baseStrength,
      uiOpacity,
      messageUserOpacity,
      messageAiOpacity,
      inputOpacity,
      panelSurfaceOpacity,
      panelSurfaceStrongOpacity,
      panelInlineOpacity
    };
  }

  function applyThemeOpacityProfileVariables(root, profile) {
    root.style.setProperty('--cerebr-opacity-background-base-strength', String(profile.baseStrength));
    root.style.setProperty('--cerebr-opacity-element', String(profile.uiOpacity));
    root.style.setProperty('--cerebr-opacity-message-user', String(profile.messageUserOpacity));
    root.style.setProperty('--cerebr-opacity-message-ai', String(profile.messageAiOpacity));
    root.style.setProperty('--cerebr-opacity-input', String(profile.inputOpacity));
    root.style.setProperty('--cerebr-opacity-panel-surface', String(profile.panelSurfaceOpacity));
    root.style.setProperty('--cerebr-opacity-panel-surface-strong', String(profile.panelSurfaceStrongOpacity));
    root.style.setProperty('--cerebr-opacity-panel-inline', String(profile.panelInlineOpacity));
  }

  function computeRelativeLuminanceFromHex(hexColor) {
    const { r, g, b } = hexToRgbChannels(hexColor);
    const toLinear = (channel) => {
      const normalized = Math.max(0, Math.min(1, channel / 255));
      if (normalized <= 0.04045) return normalized / 12.92;
      return ((normalized + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  }

  function clearCustomThemeColorOverrides() {
    const root = document.documentElement;
    if (!root || !root.style) return;
    CUSTOM_THEME_OVERRIDE_VARIABLES.forEach((variableName) => {
      root.style.removeProperty(variableName);
    });
    root.classList.remove('custom-theme-colors-enabled');
  }

  function applyThemeOpacityOverrides() {
    const root = document.documentElement;
    if (!root || !root.style) return;
    const computed = getComputedStyle(root);

    const opacityProfile = computeThemeOpacityProfile({
      backgroundOpacity: currentSettings.backgroundOpacity,
      elementOpacity: currentSettings.elementOpacity
    });
    applyThemeOpacityProfileVariables(root, opacityProfile);

    const bgColor = computed.getPropertyValue('--cerebr-bg-color').trim() || '#262b33';
    const userColor = computed.getPropertyValue('--cerebr-message-user-bg').trim() || '#3e4451';
    const aiColor = computed.getPropertyValue('--cerebr-message-ai-bg').trim() || '#2c313c';
    const inputColor = computed.getPropertyValue('--cerebr-input-bg').trim() || '#21252b';
    const customThemeEnabled = !!currentSettings.enableCustomThemeColors;

    // 背景底色改为“始终不透明”，避免 iframe 后网页参与合成导致的清晰透出问题。
    // 该滑条语义调整为“底色强度”：控制主题底色的显著程度，不再控制 alpha 透出。
    const opaqueBaseColor = composeOpaqueBaseColor(bgColor, opacityProfile.baseStrength, '#262b33');
    root.style.setProperty('--cerebr-chat-background-color', opaqueBaseColor);
    root.style.setProperty('--cerebr-chat-background-solid-color', opaqueBaseColor);
    // 元素透明度单独控制 UI 组件层，包括消息气泡、输入框、面板等。
    // 当启用自定义配色时，消息/输入框会优先使用 RGBA 自身 Alpha，不再二次叠乘 elementOpacity。
    const preserveMessageAndInputAlpha = customThemeEnabled;
    root.style.setProperty('--cerebr-bg-color', composeRgbaFromCssColor(bgColor, opacityProfile.uiOpacity, '#262b33'));
    if (customThemeEnabled) {
      // 自定义配色开启时，消息/输入颜色直接使用设置里的 RGBA 值，
      // 避免经过“计算样式 -> 再解析”链路时出现 Alpha 被覆盖的问题。
      root.style.setProperty('--cerebr-message-user-bg', normalizeRgbaColor(currentSettings.customThemeUserMessageColor, DEFAULT_SETTINGS.customThemeUserMessageColor));
      root.style.setProperty('--cerebr-message-ai-bg', normalizeRgbaColor(currentSettings.customThemeAiMessageColor, DEFAULT_SETTINGS.customThemeAiMessageColor));
      root.style.setProperty('--cerebr-input-bg', normalizeRgbaColor(currentSettings.customThemeInputColor, DEFAULT_SETTINGS.customThemeInputColor));
    } else {
      root.style.setProperty('--cerebr-message-user-bg', composeRgbaFromCssColor(userColor, opacityProfile.messageUserOpacity, '#3e4451', { preserveSourceAlpha: preserveMessageAndInputAlpha }));
      root.style.setProperty('--cerebr-message-ai-bg', composeRgbaFromCssColor(aiColor, opacityProfile.messageAiOpacity, '#2c313c', { preserveSourceAlpha: preserveMessageAndInputAlpha }));
      root.style.setProperty('--cerebr-input-bg', composeRgbaFromCssColor(inputColor, opacityProfile.inputOpacity, '#21252b', { preserveSourceAlpha: preserveMessageAndInputAlpha }));
    }
    // 玻璃态面板使用单独的“稳定底色”变量，避免 backdrop-filter 在明暗背景图上出现
    // “亮区过实 / 暗区过透”的视觉漂移。
    // 这里不再用“固定最小值”硬钳制，而是按 elementOpacity 做线性抬升：
    // - elementOpacity 越低，越需要一点保底遮罩来稳定观感；
    // - elementOpacity 越高，面板透明度越接近用户原始设置，保证“跟手”。
    root.style.setProperty('--cerebr-panel-surface-bg', composeRgbaFromCssColor(bgColor, opacityProfile.panelSurfaceOpacity, '#262b33'));
    root.style.setProperty('--cerebr-panel-surface-bg-strong', composeRgbaFromCssColor(bgColor, opacityProfile.panelSurfaceStrongOpacity, '#262b33'));
    const panelInlineColor = customThemeEnabled
      ? normalizeRgbaColor(currentSettings.customThemeInputColor, DEFAULT_SETTINGS.customThemeInputColor)
      : composeRgbaFromCssColor(inputColor, opacityProfile.panelInlineOpacity, '#21252b');
    root.style.setProperty('--cerebr-panel-inline-bg', panelInlineColor);
  }

  function applyCustomThemeColorOverrides() {
    const root = document.documentElement;
    if (!root || !root.style) return;
    if (!currentSettings.enableCustomThemeColors) {
      const hadCustomOverrides = root.classList.contains('custom-theme-colors-enabled');
      if (hadCustomOverrides) {
        clearCustomThemeColorOverrides();
        // 关闭自定义配色后立即恢复当前主题变量，避免出现“透明度变化了但主题色没回来”。
        themeManager.applyTheme(currentSettings.theme || DEFAULT_SETTINGS.theme);
      }
      applyThemeOpacityOverrides();
      return;
    }

    const bgColor = normalizeHexColor(currentSettings.customThemeBgColor, DEFAULT_SETTINGS.customThemeBgColor);
    const textColor = normalizeHexColor(currentSettings.customThemeTextColor, DEFAULT_SETTINGS.customThemeTextColor);
    const userMessageColor = normalizeRgbaColor(currentSettings.customThemeUserMessageColor, DEFAULT_SETTINGS.customThemeUserMessageColor);
    const aiMessageColor = normalizeRgbaColor(currentSettings.customThemeAiMessageColor, DEFAULT_SETTINGS.customThemeAiMessageColor);
    const inputColor = normalizeRgbaColor(currentSettings.customThemeInputColor, DEFAULT_SETTINGS.customThemeInputColor);
    const borderColor = normalizeHexColor(currentSettings.customThemeBorderColor, DEFAULT_SETTINGS.customThemeBorderColor);
    const iconColor = normalizeHexColor(currentSettings.customThemeIconColor, DEFAULT_SETTINGS.customThemeIconColor);
    const highlightColor = normalizeHexColor(currentSettings.customThemeHighlightColor, DEFAULT_SETTINGS.customThemeHighlightColor);
    const successColor = normalizeHexColor(currentSettings.customThemeSuccessColor, DEFAULT_SETTINGS.customThemeSuccessColor);
    const warningColor = normalizeHexColor(currentSettings.customThemeWarningColor, DEFAULT_SETTINGS.customThemeWarningColor);
    const errorColor = normalizeHexColor(currentSettings.customThemeErrorColor, DEFAULT_SETTINGS.customThemeErrorColor);
    const codeBgColor = normalizeHexColor(currentSettings.customThemeCodeBgColor, DEFAULT_SETTINGS.customThemeCodeBgColor);
    const codeTextColor = normalizeHexColor(currentSettings.customThemeCodeTextColor, DEFAULT_SETTINGS.customThemeCodeTextColor);

    const isDarkPalette = computeRelativeLuminanceFromHex(bgColor) < 0.45;
    const { r: textR, g: textG, b: textB } = hexToRgbChannels(textColor);
    const hoverAlpha = isDarkPalette ? 0.08 : 0.05;

    root.classList.add('custom-theme-colors-enabled');
    root.style.setProperty('--cerebr-bg-color', toOpacityColor(bgColor));
    root.style.setProperty('--cerebr-text-color', textColor);
    root.style.setProperty('--cerebr-message-user-bg', userMessageColor);
    root.style.setProperty('--cerebr-message-ai-bg', aiMessageColor);
    root.style.setProperty('--cerebr-input-bg', inputColor);
    root.style.setProperty('--cerebr-icon-color', iconColor);
    root.style.setProperty('--cerebr-border-color', borderColor);
    root.style.setProperty('--cerebr-hover-color', `rgba(${textR}, ${textG}, ${textB}, ${hoverAlpha})`);
    root.style.setProperty('--cerebr-tooltip-bg', inputColor);
    root.style.setProperty('--cerebr-highlight', highlightColor);
    // 语义状态色与基础语义变量绑定，避免通知/错误态与全局状态色割裂。
    root.style.setProperty('--cerebr-green', successColor);
    root.style.setProperty('--cerebr-orange', warningColor);
    root.style.setProperty('--cerebr-red', errorColor);
    root.style.setProperty('--cerebr-code-bg', codeBgColor);
    root.style.setProperty('--cerebr-code-color', codeTextColor);
    root.style.setProperty('--cerebr-code-border', borderColor);
    applyThemeOpacityOverrides();
  }

  function getThemeType(themeId) {
    const theme = themeManager.getThemeById?.(themeId);
    if (theme?.type) return theme.type;
    return '';
  }

  function isDarkThemeId(themeId) {
    const themeType = getThemeType(themeId);
    if (themeType === 'dark') return true;
    if (themeType === 'light') return false;
    if (themeType === 'auto') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    // 兜底：兼容历史自定义主题 ID（未注册在主题管理器中）。
    const normalized = String(themeId || '').toLowerCase();
    return normalized.includes('dark')
      || normalized.includes('night')
      || normalized.includes('black')
      || normalized.includes('monokai')
      || normalized.includes('dracula');
  }

  function resolveThemeIdForTargetType(currentThemeId, targetType) {
    const normalizedTargetType = targetType === 'dark' ? 'dark' : 'light';
    const currentTheme = themeManager.getThemeById?.(currentThemeId);
    const allThemes = themeManager.getAvailableThemes?.() || [];
    const themeById = new Map(allThemes.map((theme) => [theme.id, theme]));
    if (!currentTheme) {
      return normalizedTargetType === 'dark' ? 'dark' : 'light';
    }
    if (currentTheme.type === normalizedTargetType) {
      return currentTheme.id;
    }

    // 优先按“同前缀 + light/dark 后缀”寻找配对主题。
    const candidateIds = [];
    const themeId = currentTheme.id;
    if (themeId.endsWith('-light')) {
      candidateIds.push(`${themeId.slice(0, -6)}-dark`);
    }
    if (themeId.endsWith('-dark')) {
      candidateIds.push(`${themeId.slice(0, -5)}-light`);
    }
    if (themeId.includes('-light-')) {
      candidateIds.push(themeId.replace('-light-', '-dark-'));
    }
    if (themeId.includes('-dark-')) {
      candidateIds.push(themeId.replace('-dark-', '-light-'));
    }

    // 对诸如 tokyo-night / tokyo-night-light 这类命名做“去后缀后匹配”。
    const baseId = themeId.replace(/-(light|dark)$/i, '');
    allThemes.forEach((theme) => {
      if (!theme || theme.type !== normalizedTargetType) return;
      const candidateBaseId = String(theme.id || '').replace(/-(light|dark)$/i, '');
      if (candidateBaseId === baseId) {
        candidateIds.push(theme.id);
      }
    });

    for (const candidateId of candidateIds) {
      const candidateTheme = themeById.get(candidateId);
      if (candidateTheme?.type === normalizedTargetType) {
        return candidateTheme.id;
      }
    }

    return normalizedTargetType === 'dark' ? 'dark' : 'light';
  }
  
  // 应用主题
  function applyTheme(themeValue) {
    // 使用主题管理器应用主题
    themeManager.applyTheme(themeValue);
    
    // 更新主题选择下拉框
    if (themeSelect) {
      themeSelect.value = themeValue;
    }
    
    // 更新开关状态：基于主题元数据判断深浅色，避免硬编码主题 ID 列表。
    if (themeSwitch) {
      const isAuto = themeValue === 'auto';
      
      if (isAuto) {
        // 如果是自动模式，根据系统设置决定开关状态
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        themeSwitch.checked = prefersDark;
      } else {
        themeSwitch.checked = isDarkThemeId(themeValue);
      }
    }

    // 若启用了“自定义配色覆盖主题”，需要在主题切换后再次覆盖关键变量。
    applyCustomThemeColorOverrides();
    
    // 更新主题预览卡片活动状态（不会重新渲染导致菜单关闭）
    updateThemePreviewActiveState(themeValue);
  }
  
  // 应用侧边栏宽度
  function applySidebarWidth(width) {
    document.documentElement.style.setProperty('--cerebr-sidebar-width', `${width}px`);
    
    // 更新UI元素
    if (sidebarWidthSlider) {
      sidebarWidthSlider.value = width;
    }
    
    if (widthValueDisplay) {
      widthValueDisplay.textContent = `${width}px`;
    }
    
    // 通知父窗口宽度变化
    notifySidebarWidthChange(width);
  }

  function getSafeScaleFactor(value) {
    const numericValue = Number(value);
    return (Number.isFinite(numericValue) && numericValue > 0) ? numericValue : 1;
  }

  function getStandaloneBaseScale() {
    const dpr = Number(window.devicePixelRatio);
    return (Number.isFinite(dpr) && dpr > 0) ? 1 / dpr : 1;
  }

  function updateStandaloneScaleStyles(scaleFactor) {
    if (!isStandalone) return;
    const safeScaleFactor = getSafeScaleFactor(scaleFactor);
    const baseScale = getStandaloneBaseScale();
    const zoom = safeScaleFactor * baseScale;
    // 这里使用 zoom 而不是 transform，避免影响已有基于 transform 的动效
    document.documentElement.style.zoom = String(zoom);

    // 独立页面缩放会影响布局尺寸，用“虚拟视口”变量保持视觉填充与居中逻辑一致
    const viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;
    const inverseZoom = zoom > 0 ? 1 / zoom : 1;
    document.documentElement.style.setProperty('--cerebr-viewport-width', `${viewportW * inverseZoom}px`);
    document.documentElement.style.setProperty('--cerebr-viewport-height', `${viewportH * inverseZoom}px`);
  }

  function getCurrentViewportWidthForFullscreenSetting() {
    if (isStandalone) {
      // 独立页的 fullscreenWidth 对用户保持“可见像素”语义；
      // --cerebr-viewport-width 是 zoom 反算后的布局视口，不能拿它当滑条上限，
      // 否则 DPR/缩放越大，聊天列越容易被允许超过真实窗口宽度。
      const visualViewportWidth = Number(window.visualViewport?.width);
      if (Number.isFinite(visualViewportWidth) && visualViewportWidth > 0) {
        return visualViewportWidth;
      }
      const innerWidth = Number(window.innerWidth);
      if (Number.isFinite(innerWidth) && innerWidth > 0) {
        return innerWidth;
      }
      const clientWidth = Number(document.documentElement?.clientWidth);
      return Number.isFinite(clientWidth) && clientWidth > 0 ? clientWidth : 0;
    }

    const cssViewportWidthRaw = document.documentElement?.style?.getPropertyValue?.('--cerebr-viewport-width')
      || getComputedStyle(document.documentElement || document.body).getPropertyValue('--cerebr-viewport-width');
    const cssViewportWidth = parseFloat(cssViewportWidthRaw || '');
    if (Number.isFinite(cssViewportWidth) && cssViewportWidth > 0) {
      // 该变量在 standalone 下已包含缩放校正（含 DPR 维度），不要再重复乘 DPR。
      return cssViewportWidth;
    }

    // 嵌入模式没有 --cerebr-viewport-width 时，回退为“页面可视宽度 × DPR”，
    // 让滑条最大值与设置项的“物理像素语义”保持一致。
    const fallbackCssWidth = document.documentElement?.clientWidth || window.innerWidth || 0;
    if (!Number.isFinite(fallbackCssWidth) || fallbackCssWidth <= 0) return 0;
    const dpr = Number(window.devicePixelRatio);
    const safeDpr = (Number.isFinite(dpr) && dpr > 0) ? dpr : 1;
    return fallbackCssWidth * safeDpr;
  }

  function getFullscreenWidthBounds() {
    const fullscreenDef = SETTINGS_REGISTRY.find((def) => def.key === 'fullscreenWidth') || null;
    const configuredMin = Number(fullscreenDef?.min);
    const configuredMax = Number(fullscreenDef?.max);
    const min = Number.isFinite(configuredMin) ? Math.max(0, Math.round(configuredMin)) : 500;

    // 最大值跟随当前页面可见宽度（扣除左右各 15px 内边距），避免出现“视觉上无效”的超大像素值。
    const viewportWidth = Math.floor(getCurrentViewportWidthForFullscreenSetting());
    const viewportLimitedMax = viewportWidth - 30;
    const fallbackMax = Number.isFinite(configuredMax) ? Math.max(min, Math.round(configuredMax)) : Math.max(min, 2400);
    const max = Number.isFinite(viewportLimitedMax) && viewportLimitedMax > 0
      ? Math.max(min, viewportLimitedMax)
      : fallbackMax;

    return { min, max };
  }

  function clampFullscreenWidth(width) {
    const { min, max } = getFullscreenWidthBounds();
    const rawWidth = Number(width);
    const fallback = Number(currentSettings.fullscreenWidth);
    const base = Number.isFinite(rawWidth)
      ? rawWidth
      : (Number.isFinite(fallback) ? fallback : DEFAULT_SETTINGS.fullscreenWidth);
    return Math.round(Math.min(max, Math.max(min, base)));
  }

  function syncFullscreenWidthControlBounds(displayValue) {
    const fullscreenWidthEl = dynamicElements.get('fullscreenWidth') || document.getElementById('fullscreen-width');
    if (!fullscreenWidthEl) return;

    const { min, max } = getFullscreenWidthBounds();
    fullscreenWidthEl.min = String(min);
    fullscreenWidthEl.max = String(max);

    const targetValue = clampFullscreenWidth(
      displayValue !== undefined ? displayValue : currentSettings.fullscreenWidth
    );
    fullscreenWidthEl.value = String(targetValue);

    const valueSpan = fullscreenWidthEl.closest('.menu-item')?.querySelector('.setting-value');
    if (valueSpan) {
      valueSpan.textContent = `${targetValue}px`;
    }
  }

  // 应用全屏模式内容宽度
  // 说明：全屏布局通过 CSS 变量 --cerebr-fullscreen-width 控制“居中内容列”的最大宽度，
  // 与侧栏实际宽度（--cerebr-sidebar-width）拆分后可分别调整。
  function applyFullscreenWidth(width) {
    // 重要：全屏内容宽度需要与侧栏宽度保持相同的“缩放语义”：
    // - 侧栏宽度在 content.js 中会做缩放校正，确保宽度数值不随 scaleFactor 改变
    // - 全屏布局的内容列宽度如果直接使用 width，会随着 scaleFactor 一起被放大/缩小
    // 因此这里需要用 scaleFactor 进行反向校正，让用户看到/设置的「全屏宽度」保持“绝对像素”语义。
    const effectiveScaleFactor = getSafeScaleFactor(currentSettings.scaleFactor);
    const safeWidth = clampFullscreenWidth(width);
    const baseScale = isStandalone ? getStandaloneBaseScale() : 1;
    const correctionScale = effectiveScaleFactor * baseScale;
    const correctedWidth = safeWidth / (correctionScale || 1);
    document.documentElement.style.setProperty('--cerebr-fullscreen-width', `${correctedWidth}px`);
    syncFullscreenWidthControlBounds(safeWidth);
  }

  function previewFullscreenWidth(width) {
    const safeWidth = clampFullscreenWidth(width);
    applyFullscreenWidth(safeWidth);
    return safeWidth;
  }
  
  // 应用字体大小
  function applyFontSize(size) {
    document.documentElement.style.setProperty('--cerebr-font-size', `${size}px`);
    
    // 更新UI元素
    if (fontSizeSlider) {
      fontSizeSlider.value = size;
    }
    
    if (fontSizeValueDisplay) {
      fontSizeValueDisplay.textContent = `${size}px`;
    }
  }

  function applyDocumentFontSizePercent(value) {
    document.documentElement.style.setProperty(
      '--cerebr-document-font-size-scale',
      String(clampConversationDocumentFontSizePercent(value, DEFAULT_SETTINGS[DOCUMENT_VIEWER_SETTING_FONT_SIZE_PERCENT]) / 100)
    );
  }
  
  // 应用缩放比例
  function applyScaleFactor(value) {
    // 更新UI元素
    if (scaleFactorSlider) {
      scaleFactorSlider.value = value;
    }

    if (scaleValueDisplay) {
      scaleValueDisplay.textContent = `${value.toFixed(1)}x`;
    }

    // 在独立聊天页面中，本地直接应用缩放，保持与网页侧栏相同的视觉大小语义
    if (isStandalone) {
      updateStandaloneScaleStyles(value);
    }

    // 通知父窗口缩放比例变化（嵌入模式由 content.js 接管处理）
    notifyScaleFactorChange(value);

    // scaleFactor 变化会影响全屏内容宽度的“实际像素表现”，因此需要重新应用一次校正后的全屏宽度
    // 说明：这里不改变设置值本身（仍以“绝对像素”存储/显示），只刷新 CSS 变量。
    try {
      applyFullscreenWidth(currentSettings.fullscreenWidth);
    } catch (e) {
      console.warn('缩放变化后重新应用全屏宽度失败（忽略）:', e);
    }
  }

  function applyBackgroundImage(url, options = {}) {
    const {
      cacheBustToken = null,
      forceNextListItem = false
    } = options || {};
    const normalizedInput = typeof url === 'string' ? url.trim() : '';
    const token = ++backgroundImageLoadToken;

    if (!normalizedInput) {
      updateBackgroundImageCss('none', false, token);
      return;
    }

    if (/^\s*url\(/i.test(normalizedInput)) {
      const extracted = extractUrlFromCss(normalizedInput);
      if (extracted) void loadBackgroundImageCandidate(extracted, token);
      else updateBackgroundImageCss('none', false, token);
      return;
    }

    const normalizedSource = normalizeBackgroundSource(normalizedInput);

    if (normalizedSource.kind === 'list') {
      loadBackgroundImageFromList(normalizedSource.url, token, { forceNext: !!forceNextListItem });
      return;
    }

    if (normalizedSource.kind === 'inline_list') {
      loadBackgroundImageFromInlineList(normalizedSource.list, token, { forceNext: !!forceNextListItem });
      return;
    }

    if (normalizedSource.kind === 'direct') {
      const targetUrl = maybeAppendCacheBuster(normalizedSource.url, cacheBustToken);
      void loadBackgroundImageCandidate(targetUrl, token);
      return;
    }

    updateBackgroundImageCss('none', false, token);
  }

  function normalizeBackgroundSource(input) {
    const rawInput = typeof input === 'string' ? input : '';
    if (isInlineListSource(rawInput)) {
      return { kind: 'inline_list', list: parseBackgroundList(rawInput) };
    }
    const converted = convertPotentialWindowsPath(rawInput);
    if (isTxtListSource(converted)) {
      return { kind: 'list', url: converted };
    }
    return { kind: 'direct', url: converted };
  }

  function isInlineListSource(value) {
    if (!value || typeof value !== 'string') return false;
    return value.includes('\n');
  }

  function convertPotentialWindowsPath(input) {
    if (!input) return input;
    if (/^file:\/\//i.test(input)) return input;
    if (/^https?:\/\//i.test(input)) return input;
    if (/^data:/i.test(input)) return input;

    if (/^[a-zA-Z]:[\\/]/.test(input)) {
      const replaced = input.replace(/\\/g, '/');
      return `file:///${replaced}`;
    }

    if (/^\\\\/.test(input)) {
      const cleaned = input.replace(/\\/g, '/').replace(/^\/+/, '');
      return `file:////${cleaned}`;
    }

    return input;
  }

  function isTxtListSource(value) {
    if (!value) return false;
    const stripped = stripQueryAndHash(value).toLowerCase();
    return stripped.endsWith('.txt');
  }

  function stripQueryAndHash(value) {
    const idx = value.search(/[?#]/);
    return idx === -1 ? value : value.slice(0, idx);
  }

  function maybeAppendCacheBuster(resourceUrl, cacheBustToken) {
    if (!cacheBustToken) return resourceUrl;
    if (!/^(https?:)/i.test(resourceUrl)) return resourceUrl;
    const separator = resourceUrl.includes('?') ? '&' : '?';
    return `${resourceUrl}${separator}__cerebr_bg=${encodeURIComponent(String(cacheBustToken))}`;
  }

  async function loadBackgroundImageFromList(listUrl, token, options = {}) {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'FETCH_BACKGROUND_TEXT', url: listUrl });
      if (!result?.success) throw new Error(result?.error || 'background 读取列表失败');
      const text = result.text || '';
      if (token !== backgroundImageLoadToken) return;

      const rawCandidates = parseBackgroundList(text);
      const candidates = normalizeListCandidates(rawCandidates, listUrl);
      if (!candidates.length) {
        console.warn('背景图片列表为空:', listUrl);
        updateBackgroundImageCss('none', false, token);
        return;
      }

      const signature = computeListSignature(candidates, listUrl);
      await tryLoadQueuedBackground(candidates, signature, token, options);
    } catch (error) {
      if (token !== backgroundImageLoadToken) return;
      console.error('加载背景图片列表失败:', listUrl, error);
      updateBackgroundImageCss('none', false, token);
    }
  }

  async function loadBackgroundImageFromInlineList(list, token, options = {}) {
    if (token !== backgroundImageLoadToken) return;
    const candidates = normalizeListCandidates(list);
    if (!candidates.length) {
      console.warn('背景图片列表为空');
      updateBackgroundImageCss('none', false, token);
      return;
    }
    const signature = computeListSignature(candidates, 'inline');
    await tryLoadQueuedBackground(candidates, signature, token, options);
  }

  async function tryLoadQueuedBackground(candidates, signature, token, options = {}) {
    if (!Array.isArray(candidates) || !candidates.length) return;
    const forceNext = !!options?.forceNext;
    if (!forceNext && backgroundImageQueueState.signature === signature) {
      const currentBackgroundUrl = getCurrentBackgroundImageUrlFromCss();
      if (currentBackgroundUrl && candidates.includes(currentBackgroundUrl)) {
        const cssValue = createCssUrlValue(currentBackgroundUrl);
        updateBackgroundImageCss(cssValue, true, token, currentBackgroundUrl);
        return;
      }
    }
    const total = candidates.length;
    let attempts = 0;
    while (attempts < total && token === backgroundImageLoadToken) {
      const candidate = getNextBackgroundCandidate(signature, candidates);
      attempts += 1;
      if (!candidate) continue;
      let objectUrl = '';
      try {
        objectUrl = await fetchBackgroundImageObjectUrl(candidate);
        await ensureImageLoad(objectUrl);
        setBackgroundImageObjectUrl(objectUrl, token, candidate);
        return;
      } catch (error) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        console.warn('背景图片加载失败，尝试下一张:', candidate, error);
      }
    }

    if (token === backgroundImageLoadToken) {
      console.warn('列表中的背景图片均无法加载');
      updateBackgroundImageCss('none', false, token);
    }
  }

  function parseBackgroundList(text) {
    if (!text) return [];
    return text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !/^\s*(#|\/\/)/.test(line))
      .map(entry => sanitizeListEntry(entry))
      .filter(Boolean);
  }

  function normalizeListCandidates(list, baseUrl = null) {
    if (!Array.isArray(list)) return [];
    return list
      .map((entry) => (baseUrl ? resolveAgainstBase(entry, baseUrl) : entry))
      .map((entry) => convertPotentialWindowsPath(entry))
      .filter(Boolean);
  }

  function computeListSignature(list, sourceKey) {
    const seed = String(sourceKey || 'inline');
    let hash = 0;
    const push = (str) => {
      for (let i = 0; i < str.length; i += 1) {
        hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
      }
    };
    push(seed);
    push('|');
    list.forEach((entry) => {
      push(String(entry));
      push('|');
    });
    return `${seed}:${list.length}:${hash.toString(16)}`;
  }

  function shuffleArray(list) {
    const arr = Array.isArray(list) ? [...list] : [];
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function getNextBackgroundCandidate(signature, candidates) {
    if (backgroundImageQueueState.signature !== signature || backgroundImageQueueState.pool.length === 0) {
      backgroundImageQueueState.signature = signature;
      backgroundImageQueueState.pool = shuffleArray(candidates);
      backgroundImageQueueState.index = 0;
    } else if (backgroundImageQueueState.index >= backgroundImageQueueState.pool.length) {
      backgroundImageQueueState.pool = shuffleArray(candidates);
      backgroundImageQueueState.index = 0;
    }
    const candidate = backgroundImageQueueState.pool[backgroundImageQueueState.index];
    backgroundImageQueueState.index += 1;
    return candidate;
  }

  function sanitizeListEntry(entry) {
    if (!entry) return '';
    if (/^\s*url\(/i.test(entry)) {
      return extractUrlFromCss(entry) || '';
    }
    return entry;
  }

  function resolveAgainstBase(candidate, baseUrl) {
    if (!candidate) return candidate;
    // Already absolute
    if (/^(https?:|file:|data:)/i.test(candidate)) return candidate;
    try {
      return new URL(candidate, baseUrl).href;
    } catch (_) {
      return candidate;
    }
  }

  function ensureImageLoad(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const cleanup = () => {
        img.onload = null;
        img.onerror = null;
      };
      img.onload = () => {
        cleanup();
        resolve(url);
      };
      img.onerror = (event) => {
        cleanup();
        reject(new Error(`无法加载图片: ${url}`));
      };
      img.src = url;
    });
  }

  async function fetchBackgroundImageObjectUrl(resourceUrl) {
    const result = await chrome.runtime.sendMessage({ type: 'FETCH_BACKGROUND_IMAGE', url: resourceUrl });
    if (!result?.success || !result.blobKey) throw new Error(result?.error || 'background 读取图片失败');
    const blob = await takeBackgroundImageBlob(result.blobKey);
    if (!blob.type.toLowerCase().startsWith('image/')) throw new Error(`background 暂存内容不是图片: ${blob.type || 'unknown'}`);
    return URL.createObjectURL(blob);
  }

  async function loadBackgroundImageCandidate(resourceUrl, token) {
    let objectUrl = '';
    try {
      objectUrl = await fetchBackgroundImageObjectUrl(resourceUrl);
      await ensureImageLoad(objectUrl);
      setBackgroundImageObjectUrl(objectUrl, token, resourceUrl);
    } catch (error) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (token !== backgroundImageLoadToken) return;
      console.error('加载背景图片失败:', resourceUrl, error);
      updateBackgroundImageCss('none', false, token);
    }
  }

  function setBackgroundImageObjectUrl(objectUrl, token, debugUrl) {
    if (token !== backgroundImageLoadToken) {
      URL.revokeObjectURL(objectUrl);
      return;
    }
    const previousObjectUrl = currentBackgroundImageObjectUrl;
    currentBackgroundImageObjectUrl = objectUrl;
    updateBackgroundImageCss(createCssUrlValue(objectUrl), true, token, debugUrl);
    if (previousObjectUrl && previousObjectUrl !== objectUrl) URL.revokeObjectURL(previousObjectUrl);
  }

  function createCssUrlValue(resourceUrl) {
    const escaped = String(resourceUrl).replace(/['"\\]/g, '\\$&');
    return `url("${escaped}")`;
  }

  function extractUrlFromCss(cssValue) {
    if (!cssValue) return '';
    const match = cssValue.match(/url\(\s*(['"]?)(.*?)\1\s*\)/i);
    return match ? match[2] : '';
  }

  function getCurrentBackgroundImageUrlFromCss() {
    try {
      const style = getComputedStyle(document.documentElement);
      const cssValue = (style.getPropertyValue('--cerebr-background-image') || '').trim();
      return extractUrlFromCss(cssValue);
    } catch (_) {
      return '';
    }
  }

  function updateBackgroundImageCss(cssValue, hasImage, token, debugUrl) {
    if (token !== backgroundImageLoadToken) return;
    if (!hasImage && currentBackgroundImageObjectUrl) {
      URL.revokeObjectURL(currentBackgroundImageObjectUrl);
      currentBackgroundImageObjectUrl = '';
    }
    document.documentElement.style.setProperty('--cerebr-background-image', cssValue || 'none');

    const syncBackgroundClass = () => {
      if (token !== backgroundImageLoadToken) return;
      const targets = [document.documentElement, document.body];
      targets.forEach((node) => {
        if (!node) return;
        if (hasImage) {
          node.classList.add('has-custom-background-image');
        } else {
          node.classList.remove('has-custom-background-image');
        }
      });
    };
    syncBackgroundClass();
    // 兜底：极少数初始化时机下 body 可能尚未就绪，导致背景图 class 未及时同步。
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', syncBackgroundClass, { once: true });
    }

    if (hasImage && debugUrl) {
      console.log('[Cerebr] 已加载背景图片:', debugUrl);
    }
  }

  function applyBackgroundImageIntensity(value) {
    const numeric = clamp01(value, DEFAULT_SETTINGS.backgroundImageIntensity);
    // 语义：控制背景图“模糊氛围层”的浓度（遮罩混合 + filter），
    // 不直接改氛围层 opacity，也不影响主体图片层透明度。
    document.documentElement.style.setProperty('--cerebr-background-image-intensity', numeric);
  }

  function applyBackgroundOverallOpacity(value) {
    const numeric = clamp01(value, DEFAULT_SETTINGS.backgroundOverallOpacity);
    // 仅控制“背景图片层”透明度，避免与主题面板里的“背景透明度”语义重叠。
    document.documentElement.style.setProperty('--cerebr-background-image-opacity', numeric);
  }

  function applyBackgroundMessageBlurRadius(value) {
    const radius = clampBackgroundMessageBlurRadius(value);
    // 仅在“存在聊天消息”时由 CSS 类启用该变量，避免空欢迎态被额外模糊。
    document.documentElement.style.setProperty('--cerebr-background-message-blur-radius', `${radius}px`);
  }

  function applyMainUiBlurRadius(value) {
    const radius = clampBlurRadiusPx(value);
    // 主界面（输入区、菜单、Esc 面板等）统一读取 main-ui 变量。
    document.documentElement.style.setProperty('--cerebr-main-ui-blur-radius', `${radius}px`);
    // 兼容旧样式变量：逐步迁移期间继续同步写入，避免漏改样式点位。
    document.documentElement.style.setProperty('--cerebr-chat-input-blur-radius', `${radius}px`);
  }

  function applyMessageBlurRadius(value) {
    const radius = clampBlurRadiusPx(value);
    // 消息气泡单独读取 message 变量，实现与主界面模糊强度解耦。
    document.documentElement.style.setProperty('--cerebr-message-blur-radius', `${radius}px`);
  }

  // 兼容旧调用：旧键“chatInputBlurRadius”映射到“主界面模糊”。
  function applyChatInputBlurRadius(value) {
    applyMainUiBlurRadius(value);
  }

  /**
   * 全屏模式背景铺满开关：
   * - 关闭：主图保持 contain
   * - 开启：主图使用 cover
   * 说明：氛围层现在固定走 cover + filter，不再被该开关直接关闭。
   * @param {boolean} enabled
   */
  function applyFullscreenBackgroundCover(enabled) {
    const useCover = !!enabled;
    document.documentElement.style.setProperty('--cerebr-fullscreen-bg-size', useCover ? 'cover' : 'contain');
    document.documentElement.style.setProperty('--cerebr-fullscreen-blur-opacity', '1');
  }

  function applyFullscreenHideOriginalOnChat(enabled) {
    // 这里只写入 0/1 开关值，具体“仅在全屏+有消息时生效”的条件放在 CSS 里统一控制。
    document.documentElement.style.setProperty('--cerebr-fullscreen-hide-original-on-chat', enabled ? '1' : '0');
  }

  function refreshBackgroundImage(options = {}) {
    const { silent = false } = options || {};
    const source = currentSettings.backgroundImageUrl || '';
    const trimmedSource = String(source).trim();

    if (!trimmedSource) {
      if (!silent && typeof showNotification === 'function') {
        showNotification({
          message: '请先在设置中配置背景图片来源',
          type: 'warning',
          duration: 2400
        });
      }
      return;
    }

    if (isInlineListSource(source)) {
      applyBackgroundImage(source, { forceNextListItem: true });
      return;
    }

    const normalizedForCheck = convertPotentialWindowsPath(trimmedSource);
    if (isTxtListSource(normalizedForCheck)) {
      applyBackgroundImage(trimmedSource, { forceNextListItem: true });
      return;
    }

    const cacheBustToken = Date.now().toString(36);
    applyBackgroundImage(trimmedSource, { cacheBustToken });
  }

  function clamp01(input, fallback = 0) {
    const n = Number(input);
    if (Number.isNaN(n)) return fallback;
    return Math.min(1, Math.max(0, n));
  }

  function clampBlurRadiusPx(input) {
    const n = Number(input);
    if (!Number.isFinite(n)) return DEFAULT_SETTINGS.mainUiBlurRadius;
    return Math.round(Math.min(100, Math.max(0, n)));
  }

  // 兼容旧逻辑：保留旧函数名，统一转发到新的通用 clamp。
  function clampChatInputBlurRadius(input) {
    return clampBlurRadiusPx(input);
  }

  function clampBackgroundMessageBlurRadius(input) {
    const n = Number(input);
    if (!Number.isFinite(n)) return DEFAULT_SETTINGS.backgroundMessageBlurRadius;
    return Math.round(Math.min(120, Math.max(0, n)));
  }

  function clampCopyImageWidth(input) {
    const n = Number(input);
    if (!Number.isFinite(n)) return DEFAULT_SETTINGS.copyImageWidth;
    return Math.round(Math.min(1600, Math.max(0, n)));
  }

  function clampCopyImageFontSize(input) {
    const n = Number(input);
    if (!Number.isFinite(n)) return DEFAULT_SETTINGS.copyImageFontSize;
    return Math.round(Math.min(32, Math.max(0, n)));
  }

  function clampCopyImageScale(input) {
    const n = Number(input);
    if (!Number.isFinite(n)) return DEFAULT_SETTINGS.copyImageScale;
    const clamped = Math.min(4, Math.max(1, n));
    const stepped = Math.round(clamped * 4) / 4;
    return Number(stepped.toFixed(2));
  }

  function clampCopyImagePadding(input) {
    const n = Number(input);
    if (!Number.isFinite(n)) return DEFAULT_SETTINGS.copyImagePadding;
    return Math.round(Math.min(64, Math.max(0, n)));
  }

  function normalizeCopyImageFontFamily(input) {
    const normalized = String(input || '').trim().toLowerCase();
    if (normalized === 'system-sans') return 'system-sans';
    if (normalized === 'serif') return 'serif';
    if (normalized === 'monospace') return 'monospace';
    return 'inherit';
  }

  function getScrollMinimapWidthBounds() {
    const def = SETTINGS_REGISTRY.find((item) => item.key === 'scrollMinimapWidth') || null;
    const configuredMin = Number(def?.min);
    const configuredMax = Number(def?.max);
    const min = Number.isFinite(configuredMin) ? Math.max(8, Math.round(configuredMin)) : 14;
    const max = Number.isFinite(configuredMax) ? Math.max(min, Math.round(configuredMax)) : 100;
    return { min, max };
  }

  function clampScrollMinimapWidth(value) {
    const { min, max } = getScrollMinimapWidthBounds();
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_SETTINGS.scrollMinimapWidth;
    return Math.round(Math.min(max, Math.max(min, numeric)));
  }

  function normalizeScrollMinimapMessageMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'fixed') return 'fixed';
    return 'proportional';
  }

  function computeMinimapIdleOpacity(_opacity) {
    // 自动隐藏语义：非悬停时完全透明，仅在 hover/focus/drag 时恢复可见。
    return 0;
  }

  function applyScrollMinimapEnabled(enabled) {
    const useMinimap = !!enabled;
    document.documentElement.style.setProperty('--cerebr-scroll-minimap-enabled', useMinimap ? '1' : '0');
  }

  function applyScrollMinimapWheelMessageStep(enabled) {
    document.documentElement.classList.toggle('scroll-minimap-wheel-message-step', !!enabled);
    document.documentElement.style.setProperty(
      '--cerebr-scroll-minimap-wheel-message-step',
      enabled ? '1' : '0'
    );
  }

  function applyScrollMinimapWidth(value) {
    const width = clampScrollMinimapWidth(value);
    document.documentElement.style.setProperty('--cerebr-scroll-minimap-width', `${width}px`);
  }

  function applyScrollMinimapOpacity(value) {
    const opacity = clamp01(value, DEFAULT_SETTINGS.scrollMinimapOpacity);
    document.documentElement.style.setProperty('--cerebr-scroll-minimap-opacity', String(opacity));
    document.documentElement.style.setProperty(
      '--cerebr-scroll-minimap-idle-opacity',
      String(computeMinimapIdleOpacity(opacity))
    );
  }

  function applyScrollMinimapAutoHide(enabled) {
    const autoHide = !!enabled;
    document.documentElement.style.setProperty('--cerebr-scroll-minimap-autohide', autoHide ? '1' : '0');
  }

  function applyScrollMinimapMessageMode(value) {
    const mode = normalizeScrollMinimapMessageMode(value);
    document.documentElement.style.setProperty('--cerebr-scroll-minimap-message-mode', mode);
  }

  function applyHideNativeScrollbarInFullscreen(enabled) {
    document.documentElement.classList.toggle('hide-native-scrollbar-fullscreen', !!enabled);
  }

  // 应用自动滚动设置
  function applyAutoScroll(enabled) {
    // 更新UI元素
    if (autoScrollSwitch) {
      autoScrollSwitch.checked = enabled;
    }
  }
  
  // 应用滚动到顶部时停止设置
  function applyStopAtTop(enabled) {
    // 更新UI元素
    if (stopAtTopSwitch) {
      stopAtTopSwitch.checked = enabled;
    }
  }
  
  function applyAutoRetry(enabled) {
    const normalized = !!enabled;
    if (autoRetrySwitch) {
      autoRetrySwitch.checked = normalized;
    }

    const messageSender = getMessageSender();
    if (messageSender && typeof messageSender.setAutoRetry === 'function') {
      messageSender.setAutoRetry(normalized);
    }
  }

  function applyQueueCurrentConversationMessages(enabled) {
    const normalized = enabled !== false;
    const messageSender = getMessageSender();
    if (messageSender && typeof messageSender.setQueueCurrentConversationMessages === 'function') {
      messageSender.setQueueCurrentConversationMessages(normalized);
    }
  }
  
  // 应用“输入框占位符显示模型名”设置
  function applyShowModelNameInPlaceholder(enabled) {
    // 这里主要用于立即刷新占位符文案
    if (utils?.updateMessageInputPlaceholder) {
      utils.updateMessageInputPlaceholder();
    }
  }
  
  // 应用侧边栏位置设置
  function applySidebarPosition(position) {
    // 更新UI元素
    if (sidebarPositionSwitch) {
      sidebarPositionSwitch.checked = position === 'right';
    }
    
    const collapseButton = document.getElementById('collapse-button');
    if (collapseButton) {
      if (position === 'left') {
        collapseButton.classList.add('position-left');
      } else {
        collapseButton.classList.remove('position-left');
      }
    }
    
    // 通知父窗口侧边栏位置变化
    notifySidebarPositionChange(position);
  }
  
  // 通知侧边栏宽度变化
  function notifySidebarWidthChange(width) {
    appContext.utils.postHostMessage({
      type: 'SIDEBAR_WIDTH_CHANGE',
      width: parseInt(width)
    });
  }
  
  // 通知缩放比例变化
  function notifyScaleFactorChange(value) {
    appContext.utils.postHostMessage({
      type: 'SCALE_FACTOR_CHANGE',
      value: value
    });
  }
  
  // 通知侧边栏位置变化
  function notifySidebarPositionChange(position) {
    console.log(`发送侧边栏位置变化通知: ${position}`);
    appContext.utils.postHostMessage({
      type: 'SIDEBAR_POSITION_CHANGE',
      position: position
    });
  }
  
  // 监听系统主题变化
  function setupSystemThemeListener() {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (currentSettings.theme === 'auto') {
        applyTheme('auto');
      }
    });
  }
  
  // 设置UI元素事件处理
  function setupEventListeners() {
    // 主题切换监听
    if (themeSwitch) {
      themeSwitch.addEventListener('change', function() {
        // 获取当前选择的主题
        const currentTheme = themeSelect ? themeSelect.value : 'auto';
        
        if (currentTheme === 'auto') {
          // 自动模式下不改变主题，仅调整反馈UI
          applyTheme('auto');
          return;
        }
        const currentIsDark = isDarkThemeId(currentTheme);
        const targetType = this.checked ? 'dark' : 'light';
        const shouldSwitch = (targetType === 'dark' && !currentIsDark)
          || (targetType === 'light' && currentIsDark);
        const newTheme = shouldSwitch
          ? resolveThemeIdForTargetType(currentTheme, targetType)
          : currentTheme;
        
        if (newTheme !== currentTheme) {
          setTheme(newTheme);
          if (themeSelect) {
            themeSelect.value = newTheme;
          }
        }
      });
    }
    
    // 主题选择下拉框监听
    if (themeSelect) {
      // 初始化主题选项
      populateThemeOptions();
      // 选择变化由 schema 通用绑定处理
    }
    
    // 侧边栏宽度滑块（仅负责即时 UI 显示，实际保存由 schema 绑定处理）
    if (sidebarWidthSlider) {
      sidebarWidthSlider.addEventListener('input', (e) => {
        if (widthValueDisplay) {
          widthValueDisplay.textContent = `${e.target.value}px`;
        }
      });
    }
    
    // 字体大小滑块（仅负责即时 UI 显示，实际保存由 schema 绑定处理）
    if (fontSizeSlider) {
      fontSizeSlider.addEventListener('input', (e) => {
        if (fontSizeValueDisplay) {
          fontSizeValueDisplay.textContent = `${e.target.value}px`;
        }
      });
    }
    
    // 缩放比例滑块（仅负责即时 UI 显示，实际保存由 schema 绑定处理）
    if (scaleFactorSlider) {
      scaleFactorSlider.addEventListener('input', (e) => {
        if (scaleValueDisplay) {
          scaleValueDisplay.textContent = `${parseFloat(e.target.value).toFixed(1)}x`;
        }
      });
    }
    
    // 通用绑定（保存+应用+广播）
    bindSettingsFromSchema();

    // API 配置更新后刷新“对话标题生成 API”的下拉选项
    refreshConversationTitleApiOptions();
    refreshAskOtherAiApiOptions();
    window.addEventListener('apiConfigsUpdated', () => {
      refreshConversationTitleApiOptions();
      refreshAskOtherAiApiOptions();
    });
  }
  
  // 填充主题选项
  function populateThemeOptions() {
    if (!themeSelect) return;
    
    // 清空现有选项
    themeSelect.innerHTML = '';
    
    // 获取所有可用主题
    const themes = themeManager.getAvailableThemes();
    
    // 添加主题选项
    themes.forEach(theme => {
      const option = document.createElement('option');
      option.value = theme.id;
      option.textContent = theme.name;
      if (theme.description) {
        option.title = theme.description;
      }
      themeSelect.appendChild(option);
    });
    
    // 设置当前选中的主题
    themeSelect.value = currentSettings.theme;
    
    // 渲染主题预览卡片
    updateThemePreview();
  }
  
  // 更新主题预览，在主题变更后调用
  function updateThemePreview() {
    const previewContainer = document.querySelector('.theme-preview-grid');
    if (previewContainer) {
      themeManager.renderThemePreview(previewContainer, (themeId) => {
        setTheme(themeId);
        if (themeSelect) {
          themeSelect.value = themeId;
        }
      });
    }
  }
  
  // 只更新主题预览卡片的active状态，不重新渲染预览网格
  function updateThemePreviewActiveState(themeId) {
    const previewCards = document.querySelectorAll('.theme-preview-card');
    if (previewCards.length === 0) return; // 如果没有预览卡片，不做任何操作
    
    // 移除所有卡片的active类
    previewCards.forEach(card => {
      card.classList.remove('active');
    });
    
    // 为当前主题的卡片添加active类
    const activeCard = document.querySelector(`.theme-preview-card[data-theme-id="${themeId}"]`);
    if (activeCard) {
      activeCard.classList.add('active');
    }
  }
  
  // ===== 设置操作方法 =====
  
  // 设置主题（保留定制逻辑，下一步纳入 schema）
  function setTheme(theme) {
    const themeValue = theme === true ? 'dark' : theme === false ? 'light' : theme;
    currentSettings.theme = themeValue;
    applyTheme(themeValue);
    saveSetting('theme', themeValue);
    const set = subscribers.get('theme');
    if (set) set.forEach(cb => { try { cb(themeValue); } catch(e){ console.error(e);} });
  }
  
  // 设置侧边栏宽度
  function setSidebarWidth(width) { setSetting('sidebarWidth', width); }

  // 设置全屏内容宽度
  function setFullscreenWidth(width) { setSetting('fullscreenWidth', width); }
  
  // 设置字体大小
  function setFontSize(size) { setSetting('fontSize', size); }
  
  // 设置缩放比例
  function setScaleFactor(value) { setSetting('scaleFactor', value); }

  // 通用设置入口：供文档 viewer 等“非设置面板直接交互”模块写回偏好使用。
  function setSettingValue(key, value) { setSetting(key, value); }
  
  // 设置自动滚动
  function setAutoScroll(enabled) { setSetting('autoScroll', enabled); }
  
  // 设置滚动到顶部时停止
  function setStopAtTop(enabled) { setSetting('stopAtTop', enabled); }
  
  
  function setAutoRetry(enabled) { setSetting('autoRetry', enabled); }

  function setQueueCurrentConversationMessages(enabled) { setSetting('queueCurrentConversationMessages', enabled); }
  
  // 设置侧边栏位置
  function setSidebarPosition(position) { console.log(`设置侧边栏位置: ${position}`); setSetting('sidebarPosition', position); }
  
  // 获取当前设置
  function getSettings() {
    return {...currentSettings};
  }
  
  // 获取单个设置
  function getSetting(key) {
    return currentSettings[key];
  }

  /**
   * 订阅设置变化
   * @param {string} key - 设置键
   * @param {(value:any)=>void} callback - 回调
   * @returns {() => void} 取消订阅函数
   */
  function subscribe(key, callback) {
    if (!subscribers.has(key)) subscribers.set(key, new Set());
    subscribers.get(key).add(callback);
    return () => {
      const set = subscribers.get(key);
      if (set) set.delete(callback);
    };
  }
  
  // 初始化
  function init() {
    // 先初始化主题管理器
    themeManager.init();
    
    // 先渲染基于注册表的动态设置项
    renderSettingsFromRegistry();
    // 基于注册表构建schema
    buildSchemaFromRegistry();

    // 设置面板：按布局模式展示对应的宽度滑条（侧栏/全屏）
    setupFullscreenModeObserver();

    setupEventListeners();
    setupSystemThemeListener();
    window.addEventListener('resize', () => {
      if (isStandalone) {
        updateStandaloneScaleStyles(currentSettings.scaleFactor);
      }
      syncFullscreenWidthControlBounds();
      applyFullscreenWidth(currentSettings.fullscreenWidth);
    });
    return initSettings();
  }

  // Esc 面板初始化后同步设置项位置（保持菜单分区一致）
  function refreshSettingsContainers() {
    renderSettingsFromRegistry();
  }
  
  // 公开的API
  return {
    init,
    refreshSettingsContainers,
    getSettings,
    getSetting,
    subscribe,
    setTheme,
    setSidebarWidth,
    setFullscreenWidth,
    previewFullscreenWidth,
    getFullscreenWidthBounds,
    clampFullscreenWidth,
    setFontSize,
    setScaleFactor,
    setSettingValue,
    setAutoScroll,
    setStopAtTop,
    setAutoRetry,
    setQueueCurrentConversationMessages,
    setSidebarPosition,
    refreshBackgroundImage,
    applyTheme
  };
}
