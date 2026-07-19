/**
 * 主题管理模块
 * 提供多种预设主题和主题切换功能
 * @module theme_manager
 */

/**
 * 创建主题管理器
 * @returns {Object} 主题管理器实例
 */
export function createThemeManager() {
  /**
   * 预设主题配置
   * 每个主题包含名称、描述和CSS变量配置
   * @type {Array<Object>}
   */
  const PREDEFINED_THEMES = [
    {
      id: 'auto',
      name: '跟随系统',
      description: '自动跟随系统深浅色模式设置',
      type: 'auto',
      variables: {} // 自动模式不需要变量，会根据系统设置选择light或dark
    },
    {
      id: 'light',
      name: '浅色',
      description: '默认浅色主题',
      type: 'light',
      variables: {
        '--cerebr-opacity': '0.6',
        '--cerebr-bg-color': 'rgba(255, 255, 255, var(--cerebr-opacity))',
        '--cerebr-text-color': '#24292e',
        '--cerebr-message-user-bg': 'rgba(227, 242, 253, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(245, 245, 245, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(248, 248, 248, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#586069',
        '--cerebr-border-color': '#e1e4e8',
        '--cerebr-hover-color': 'rgba(0, 0, 0, 0.03)',
        '--cerebr-tooltip-bg': '#ffffff',
        '--cerebr-highlight': '#0366d6',
        '--cerebr-code-bg': '#f6f8fa',
        '--cerebr-code-color': '#24292e',
        '--cerebr-code-border': '#e1e4e8'       
      }
    },
    {
      id: 'dark',
      name: '深色',
      description: '默认深色主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.8',
        '--cerebr-bg-color': 'rgba(38, 43, 51, var(--cerebr-opacity))',
        '--cerebr-text-color': '#abb2bf',
        '--cerebr-message-user-bg': 'rgba(62, 68, 81, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(44, 49, 60, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(33, 37, 43, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#abb2bf',
        '--cerebr-border-color': '#30363d',
        '--cerebr-hover-color': 'rgba(255, 255, 255, 0.05)',
        '--cerebr-tooltip-bg': '#21252b',
        '--cerebr-highlight': '#61afef',
        '--cerebr-code-bg': '#282c34',
        '--cerebr-code-color': '#abb2bf',
        '--cerebr-code-border': 'transparent'       
      }
    },
    {
      id: 'github-light',
      name: 'GitHub Light',
      description: 'GitHub 风格浅色主题',
      type: 'light',
      variables: {
        '--cerebr-opacity': '0.7',
        '--cerebr-bg-color': 'rgba(246, 248, 250, var(--cerebr-opacity))',
        '--cerebr-text-color': '#24292e',
        '--cerebr-message-user-bg': 'rgba(241, 248, 255, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(255, 255, 255, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(255, 255, 255, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#6a737d',
        '--cerebr-border-color': '#e1e4e8',
        '--cerebr-hover-color': 'rgba(3, 102, 214, 0.05)',
        '--cerebr-tooltip-bg': '#f6f8fa',
        '--cerebr-highlight': '#0366d6',
        '--cerebr-code-bg': '#f6f8fa',
        '--cerebr-code-color': '#24292e',
        '--cerebr-code-border': '#e1e4e8'       
      }
    },
    {
      id: 'github-dark',
      name: 'GitHub Dark',
      description: 'GitHub 风格深色主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.8',
        '--cerebr-bg-color': 'rgba(13, 17, 23, var(--cerebr-opacity))',
        '--cerebr-text-color': '#c9d1d9',
        '--cerebr-message-user-bg': 'rgba(33, 38, 45, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(22, 27, 34, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(13, 17, 23, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#8b949e',
        '--cerebr-border-color': '#30363d',
        '--cerebr-hover-color': 'rgba(56, 139, 253, 0.1)',
        '--cerebr-tooltip-bg': '#0d1117',
        '--cerebr-highlight': '#58a6ff',
        '--cerebr-code-bg': '#161b22',
        '--cerebr-code-color': '#c9d1d9',
        '--cerebr-code-border': '#30363d'       
      }
    },
    {
      id: 'vscode-dark',
      name: 'VS Code Dark+',
      description: 'Visual Studio Code 深色主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.8',
        '--cerebr-bg-color': 'rgba(30, 30, 30, var(--cerebr-opacity))',
        '--cerebr-text-color': '#cccccc',
        '--cerebr-message-user-bg': 'rgba(37, 37, 38, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(45, 45, 45, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(51, 51, 51, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#cccccc',
        '--cerebr-border-color': '#454545',
        '--cerebr-hover-color': 'rgba(255, 255, 255, 0.1)',
        '--cerebr-tooltip-bg': '#1e1e1e',
        '--cerebr-highlight': '#007acc',
        '--cerebr-code-bg': '#1e1e1e',
        '--cerebr-code-color': '#d4d4d4',
        '--cerebr-code-border': '#454545'       
      }
    },
    {
      id: 'night-blue',
      name: '夜空蓝',
      description: '深蓝色夜间主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.8',
        '--cerebr-bg-color': 'rgba(25, 30, 42, var(--cerebr-opacity))',
        '--cerebr-text-color': '#e3e9f0',
        '--cerebr-message-user-bg': 'rgba(44, 52, 73, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(32, 39, 55, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(21, 25, 36, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#8badc1',
        '--cerebr-border-color': '#2d384a',
        '--cerebr-hover-color': 'rgba(100, 149, 237, 0.15)',
        '--cerebr-tooltip-bg': '#192132',
        '--cerebr-highlight': '#61afef',
        '--cerebr-code-bg': '#151a26',
        '--cerebr-code-color': '#e3e9f0',
        '--cerebr-code-border': '#2d384a'       
      }
    },
    {
      id: 'monokai',
      name: 'Monokai',
      description: '经典 Monokai 主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.8',
        '--cerebr-bg-color': 'rgba(39, 40, 34, var(--cerebr-opacity))',
        '--cerebr-text-color': '#f8f8f2',
        '--cerebr-message-user-bg': 'rgba(73, 72, 62, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(49, 50, 43, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(29, 30, 25, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#a6e22e',
        '--cerebr-border-color': '#49483e',
        '--cerebr-hover-color': 'rgba(166, 226, 46, 0.1)',
        '--cerebr-tooltip-bg': '#272822',
        '--cerebr-highlight': '#f92672',
        '--cerebr-code-bg': '#272822',
        '--cerebr-code-color': '#f8f8f2',
        '--cerebr-code-border': '#49483e'       
      }
    },
    {
      id: 'solarized-light',
      name: 'Solarized Light',
      description: '护眼浅色主题',
      type: 'light',
      variables: {
        '--cerebr-opacity': '0.7',
        '--cerebr-bg-color': 'rgba(253, 246, 227, var(--cerebr-opacity))',
        '--cerebr-text-color': '#657b83',
        '--cerebr-message-user-bg': 'rgba(238, 232, 213, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(253, 246, 227, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(238, 232, 213, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#839496',
        '--cerebr-border-color': '#eee8d5',
        '--cerebr-hover-color': 'rgba(38, 139, 210, 0.1)',
        '--cerebr-tooltip-bg': '#fdf6e3',
        '--cerebr-highlight': '#2aa198',
        '--cerebr-code-bg': '#eee8d5',
        '--cerebr-code-color': '#657b83',
        '--cerebr-code-border': '#d5d2be'       
      }
    },
    {
      id: 'solarized-dark',
      name: 'Solarized Dark',
      description: '护眼深色主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.8',
        '--cerebr-bg-color': 'rgba(0, 43, 54, var(--cerebr-opacity))',
        '--cerebr-text-color': '#93a1a1',
        '--cerebr-message-user-bg': 'rgba(7, 54, 66, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(0, 43, 54, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(0, 33, 43, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#839496',
        '--cerebr-border-color': '#073642',
        '--cerebr-hover-color': 'rgba(38, 139, 210, 0.1)',
        '--cerebr-tooltip-bg': '#002b36',
        '--cerebr-highlight': '#2aa198',
        '--cerebr-code-bg': '#073642',
        '--cerebr-code-color': '#93a1a1',
        '--cerebr-code-border': '#094352'       
      }
    },
    {
      id: 'nord',
      name: 'Nord',
      description: '北欧风格主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.8',
        '--cerebr-bg-color': 'rgba(46, 52, 64, var(--cerebr-opacity))',
        '--cerebr-text-color': '#d8dee9',
        '--cerebr-message-user-bg': 'rgba(59, 66, 82, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(67, 76, 94, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(46, 52, 64, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#88c0d0',
        '--cerebr-border-color': '#3b4252',
        '--cerebr-hover-color': 'rgba(136, 192, 208, 0.1)',
        '--cerebr-tooltip-bg': '#2e3440',
        '--cerebr-highlight': '#81a1c1',
        '--cerebr-code-bg': '#3b4252',
        '--cerebr-code-color': '#e5e9f0',
        '--cerebr-code-border': '#434c5e'       
      }
    },
    {
      id: 'dracula',
      name: 'Dracula',
      description: '经典吸血鬼深色主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(40, 42, 54, var(--cerebr-opacity))',
        '--cerebr-text-color': '#f8f8f2',
        '--cerebr-message-user-bg': 'rgba(68, 71, 90, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(56, 58, 75, var(--cerebr-opacity))', 
        '--cerebr-input-bg': 'rgba(34, 35, 48, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#bd93f9',
        '--cerebr-border-color': '#44475a',
        '--cerebr-hover-color': 'rgba(189, 147, 249, 0.1)',
        '--cerebr-tooltip-bg': '#282a36',
        '--cerebr-highlight': '#ff79c6',
        '--cerebr-code-bg': '#282a36',
        '--cerebr-code-color': '#f8f8f2',
        '--cerebr-code-border': '#44475a'       
      }
    },
    {
      id: 'tokyo-night',
      name: 'Tokyo Night',
      description: '东京之夜深色主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(26, 27, 38, var(--cerebr-opacity))',
        '--cerebr-text-color': '#a9b1d6',
        '--cerebr-message-user-bg': 'rgba(36, 40, 59, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(32, 34, 48, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(24, 25, 36, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#bb9af7',
        '--cerebr-border-color': '#292e42',
        '--cerebr-hover-color': 'rgba(103, 110, 149, 0.1)',
        '--cerebr-tooltip-bg': '#1a1b26',
        '--cerebr-highlight': '#7aa2f7',
        '--cerebr-code-bg': '#24283b',
        '--cerebr-code-color': '#a9b1d6',
        '--cerebr-code-border': '#292e42'       
      }
    },
    {
      id: 'tokyo-night-light',
      name: 'Tokyo Night Day',
      description: '东京白日浅色主题',
      type: 'light',
      variables: {
        '--cerebr-opacity': '0.75',
        '--cerebr-bg-color': 'rgba(213, 214, 219, var(--cerebr-opacity))',
        '--cerebr-text-color': '#343b58',
        '--cerebr-message-user-bg': 'rgba(196, 204, 229, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(210, 212, 228, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(229, 233, 240, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#5a4a78',
        '--cerebr-border-color': '#9699a3',
        '--cerebr-hover-color': 'rgba(90, 74, 120, 0.05)',
        '--cerebr-tooltip-bg': '#d5d6db',
        '--cerebr-highlight': '#34548a',
        '--cerebr-code-bg': '#e1e2e7',
        '--cerebr-code-color': '#343b58',
        '--cerebr-code-border': '#cbccd1'       
      }
    },
    {
      id: 'material-ocean',
      name: 'Material Ocean',
      description: '深海蓝材质主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(15, 17, 26, var(--cerebr-opacity))',
        '--cerebr-text-color': '#8f93a2',
        '--cerebr-message-user-bg': 'rgba(35, 40, 52, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(28, 32, 43, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(20, 23, 31, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#80cbc4',
        '--cerebr-border-color': '#1f2233',
        '--cerebr-hover-color': 'rgba(84, 207, 216, 0.1)',
        '--cerebr-tooltip-bg': '#0f111a',
        '--cerebr-highlight': '#82aaff',
        '--cerebr-code-bg': '#0f111a',
        '--cerebr-code-color': '#8f93a2',
        '--cerebr-code-border': '#1f2233'       
      }
    },
    {
      id: 'material-lighter',
      name: 'Material Lighter',
      description: '浅色材质主题',
      type: 'light',
      variables: {
        '--cerebr-opacity': '0.7',
        '--cerebr-bg-color': 'rgba(250, 250, 250, var(--cerebr-opacity))',
        '--cerebr-text-color': '#546e7a',
        '--cerebr-message-user-bg': 'rgba(227, 242, 253, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(240, 240, 240, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(245, 245, 245, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#00bcd4',
        '--cerebr-border-color': '#e7eaec',
        '--cerebr-hover-color': 'rgba(0, 188, 212, 0.05)',
        '--cerebr-tooltip-bg': '#fafafa',
        '--cerebr-highlight': '#2196f3',
        '--cerebr-code-bg': '#f5f5f5',
        '--cerebr-code-color': '#546e7a',
        '--cerebr-code-border': '#e7eaec'       
      }
    },
    {
      id: 'synthwave',
      name: 'Synthwave',
      description: '复古赛博朋克主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(39, 16, 62, var(--cerebr-opacity))',
        '--cerebr-text-color': '#ff7edb',
        '--cerebr-message-user-bg': 'rgba(54, 22, 87, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(45, 19, 72, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(34, 14, 54, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#36f9f6',
        '--cerebr-border-color': '#482a74',
        '--cerebr-hover-color': 'rgba(255, 126, 219, 0.15)',
        '--cerebr-tooltip-bg': '#2a1b3d',
        '--cerebr-highlight': '#fe4450',
        '--cerebr-code-bg': '#241b2f',
        '--cerebr-code-color': '#ff7edb',
        '--cerebr-code-border': '#482a74'       
      }
    },
    {
      id: 'apple-light',
      name: 'Apple Light',
      description: 'macOS浅色主题',
      type: 'light',
      variables: {
        '--cerebr-opacity': '0.65',
        '--cerebr-bg-color': 'rgba(255, 255, 255, var(--cerebr-opacity))',
        '--cerebr-text-color': '#333333',
        '--cerebr-message-user-bg': 'rgba(209, 232, 255, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(240, 240, 247, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(248, 248, 255, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#007aff',
        '--cerebr-border-color': '#e4e4e4',
        '--cerebr-hover-color': 'rgba(0, 122, 255, 0.05)',
        '--cerebr-tooltip-bg': '#ffffff',
        '--cerebr-highlight': '#007aff',
        '--cerebr-code-bg': '#f6f8fa',
        '--cerebr-code-color': '#333333',
        '--cerebr-code-border': '#e4e4e4'       
      }
    },
    {
      id: 'apple-dark',
      name: 'Apple Dark',
      description: 'macOS深色主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.8',
        '--cerebr-bg-color': 'rgba(28, 28, 30, var(--cerebr-opacity))',
        '--cerebr-text-color': '#e4e4e4',
        '--cerebr-message-user-bg': 'rgba(50, 50, 56, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(40, 40, 45, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(36, 36, 38, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#0a84ff',
        '--cerebr-border-color': '#3d3d41',
        '--cerebr-hover-color': 'rgba(10, 132, 255, 0.1)',
        '--cerebr-tooltip-bg': '#1c1c1e',
        '--cerebr-highlight': '#0a84ff',
        '--cerebr-code-bg': '#2c2c2e',
        '--cerebr-code-color': '#e4e4e4',
        '--cerebr-code-border': '#3d3d41'       
      }
    },
    {
      id: 'gruvbox-dark',
      name: 'Gruvbox Dark',
      description: '复古暖色调深色主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(40, 40, 40, var(--cerebr-opacity))',
        '--cerebr-text-color': '#ebdbb2',
        '--cerebr-message-user-bg': 'rgba(60, 56, 54, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(50, 48, 47, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(45, 43, 42, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#b8bb26',
        '--cerebr-border-color': '#504945',
        '--cerebr-hover-color': 'rgba(251, 73, 52, 0.1)',
        '--cerebr-tooltip-bg': '#282828',
        '--cerebr-highlight': '#fb4934',
        '--cerebr-code-bg': '#3c3836',
        '--cerebr-code-color': '#ebdbb2',
        '--cerebr-code-border': '#504945'       
      }
    },
    {
      id: 'gruvbox-light',
      name: 'Gruvbox Light',
      description: '复古暖色调浅色主题',
      type: 'light',
      variables: {
        '--cerebr-opacity': '0.75',
        '--cerebr-bg-color': 'rgba(251, 241, 199, var(--cerebr-opacity))',
        '--cerebr-text-color': '#3c3836',
        '--cerebr-message-user-bg': 'rgba(235, 219, 178, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(242, 229, 188, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(249, 245, 215, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#9d0006',
        '--cerebr-border-color': '#d5c4a1',
        '--cerebr-hover-color': 'rgba(157, 0, 6, 0.05)',
        '--cerebr-tooltip-bg': '#fbf1c7',
        '--cerebr-highlight': '#9d0006',
        '--cerebr-code-bg': '#ebdbb2',
        '--cerebr-code-color': '#3c3836',
        '--cerebr-code-border': '#d5c4a1'       
      }
    },
    {
      id: 'ayu-mirage',
      name: 'Ayu Mirage',
      description: '柔和中性色调主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.8',
        '--cerebr-bg-color': 'rgba(31, 33, 42, var(--cerebr-opacity))',
        '--cerebr-text-color': '#cccac2',
        '--cerebr-message-user-bg': 'rgba(44, 48, 58, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(38, 41, 50, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(26, 28, 35, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#ffcc66',
        '--cerebr-border-color': '#373e4c',
        '--cerebr-hover-color': 'rgba(255, 204, 102, 0.1)',
        '--cerebr-tooltip-bg': '#1f212a',
        '--cerebr-highlight': '#f29e74',
        '--cerebr-code-bg': '#272d38',
        '--cerebr-code-color': '#cccac2',
        '--cerebr-code-border': '#373e4c'       
      }
    },
    {
      id: 'ayu-light',
      name: 'Ayu Light',
      description: '柔和浅色调主题',
      type: 'light',
      variables: {
        '--cerebr-opacity': '0.7',
        '--cerebr-bg-color': 'rgba(250, 250, 250, var(--cerebr-opacity))',
        '--cerebr-text-color': '#5c6166',
        '--cerebr-message-user-bg': 'rgba(235, 239, 242, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(245, 245, 245, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(255, 255, 255, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#ff9940',
        '--cerebr-border-color': '#e8e8e8',
        '--cerebr-hover-color': 'rgba(255, 153, 64, 0.05)',
        '--cerebr-tooltip-bg': '#fafafa',
        '--cerebr-highlight': '#ff9940',
        '--cerebr-code-bg': '#f8f9fa',
        '--cerebr-code-color': '#5c6166',
        '--cerebr-code-border': '#e8e8e8'       
      }
    },
    {
      id: 'catppuccin-mocha',
      name: 'Catppuccin Mocha',
      description: '柔和深色咖啡主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(30, 30, 46, var(--cerebr-opacity))',
        '--cerebr-text-color': '#cdd6f4',
        '--cerebr-message-user-bg': 'rgba(49, 50, 68, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(40, 40, 58, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(24, 24, 38, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#cba6f7',
        '--cerebr-border-color': '#45475a',
        '--cerebr-hover-color': 'rgba(203, 166, 247, 0.1)',
        '--cerebr-tooltip-bg': '#1e1e2e',
        '--cerebr-highlight': '#f5c2e7',
        '--cerebr-code-bg': '#313244',
        '--cerebr-code-color': '#cdd6f4',
        '--cerebr-code-border': '#45475a'       
      }
    },
    {
      id: 'catppuccin-latte',
      name: 'Catppuccin Latte',
      description: '柔和浅色奶茶主题',
      type: 'light',
      variables: {
        '--cerebr-opacity': '0.75',
        '--cerebr-bg-color': 'rgba(239, 241, 245, var(--cerebr-opacity))',
        '--cerebr-text-color': '#4c4f69',
        '--cerebr-message-user-bg': 'rgba(220, 224, 232, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(230, 233, 239, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(249, 250, 251, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#8839ef',
        '--cerebr-border-color': '#bcc0cc',
        '--cerebr-hover-color': 'rgba(136, 57, 239, 0.05)',
        '--cerebr-tooltip-bg': '#eff1f5',
        '--cerebr-highlight': '#8839ef',
        '--cerebr-code-bg': '#e6e9ef',
        '--cerebr-code-color': '#4c4f69',
        '--cerebr-code-border': '#bcc0cc'       
      }
    },
    {
      id: 'onedark-pro',
      name: 'One Dark Pro',
      description: '专业深色开发主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(40, 44, 52, var(--cerebr-opacity))',
        '--cerebr-text-color': '#abb2bf',
        '--cerebr-message-user-bg': 'rgba(55, 61, 72, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(47, 52, 61, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(33, 37, 43, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#c678dd',
        '--cerebr-border-color': '#3e4451',
        '--cerebr-hover-color': 'rgba(198, 120, 221, 0.1)',
        '--cerebr-tooltip-bg': '#282c34',
        '--cerebr-highlight': '#e06c75',
        '--cerebr-code-bg': '#282c34',
        '--cerebr-code-color': '#abb2bf',
        '--cerebr-code-border': '#3e4451'       
      }
    },
    {
      id: 'palenight',
      name: 'Palenight',
      description: '紫色调深夜主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(41, 45, 62, var(--cerebr-opacity))',
        '--cerebr-text-color': '#bfc7d5',
        '--cerebr-message-user-bg': 'rgba(59, 66, 86, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(50, 55, 73, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(34, 38, 53, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#c792ea',
        '--cerebr-border-color': '#4e5579',
        '--cerebr-hover-color': 'rgba(199, 146, 234, 0.1)',
        '--cerebr-tooltip-bg': '#292d3e',
        '--cerebr-highlight': '#ff5370',
        '--cerebr-code-bg': '#292d3e',
        '--cerebr-code-color': '#bfc7d5',
        '--cerebr-code-border': '#4e5579'       
      }
    },
    {
      id: 'rosepine',
      name: 'Rosé Pine',
      description: '舒适柔和深色主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(25, 23, 36, var(--cerebr-opacity))',
        '--cerebr-text-color': '#e0def4',
        '--cerebr-message-user-bg': 'rgba(42, 39, 57, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(33, 30, 46, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(19, 17, 29, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#c4a7e7',
        '--cerebr-border-color': '#42384d',
        '--cerebr-hover-color': 'rgba(196, 167, 231, 0.1)',
        '--cerebr-tooltip-bg': '#191724',
        '--cerebr-highlight': '#eb6f92',
        '--cerebr-code-bg': '#1f1d2e',
        '--cerebr-code-color': '#e0def4',
        '--cerebr-code-border': '#42384d'       
      }
    },
    {
      id: 'rosepine-dawn',
      name: 'Rosé Pine Dawn',
      description: '舒适柔和浅色主题',
      type: 'light',
      variables: {
        '--cerebr-opacity': '0.75',
        '--cerebr-bg-color': 'rgba(250, 244, 237, var(--cerebr-opacity))',
        '--cerebr-text-color': '#575279',
        '--cerebr-message-user-bg': 'rgba(236, 226, 216, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(242, 236, 229, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(255, 250, 243, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#907aa9',
        '--cerebr-border-color': '#e5e0d9',
        '--cerebr-hover-color': 'rgba(144, 122, 169, 0.05)',
        '--cerebr-tooltip-bg': '#faf4ed',
        '--cerebr-highlight': '#d7827e',
        '--cerebr-code-bg': '#f2ede9',
        '--cerebr-code-color': '#575279',
        '--cerebr-code-border': '#e5e0d9'       
      }
    },
    {
      id: 'github-dimmed',
      name: 'GitHub Dimmed',
      description: 'GitHub 柔和灰暗主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(34, 39, 46, var(--cerebr-opacity))',
        '--cerebr-text-color': '#adbac7',
        '--cerebr-message-user-bg': 'rgba(47, 54, 61, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(40, 46, 53, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(31, 36, 43, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#768390',
        '--cerebr-border-color': '#444c56',
        '--cerebr-hover-color': 'rgba(83, 155, 245, 0.1)',
        '--cerebr-tooltip-bg': '#22272e',
        '--cerebr-highlight': '#539bf5',
        '--cerebr-code-bg': '#2d333b',
        '--cerebr-code-color': '#adbac7',
        '--cerebr-code-border': '#444c56'       
      }
    },
    {
      id: 'night-owl',
      name: 'Night Owl',
      description: '夜猫子编程主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(1, 22, 39, var(--cerebr-opacity))',
        '--cerebr-text-color': '#d6deeb',
        '--cerebr-message-user-bg': 'rgba(21, 42, 59, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(11, 32, 49, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(1, 18, 32, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#82aaff',
        '--cerebr-border-color': '#5f7e97',
        '--cerebr-hover-color': 'rgba(130, 170, 255, 0.1)',
        '--cerebr-tooltip-bg': '#011627',
        '--cerebr-highlight': '#c792ea',
        '--cerebr-code-bg': '#011627',
        '--cerebr-code-color': '#d6deeb',
        '--cerebr-code-border': '#5f7e97'       
      }
    },
    {
      id: 'cobalt2',
      name: 'Cobalt2',
      description: '深蓝高对比度主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(0, 35, 53, var(--cerebr-opacity))',
        '--cerebr-text-color': '#e0edff',
        '--cerebr-message-user-bg': 'rgba(16, 51, 69, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(8, 43, 61, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(0, 29, 47, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#ffc600',
        '--cerebr-border-color': '#0d3a58',
        '--cerebr-hover-color': 'rgba(255, 198, 0, 0.1)',
        '--cerebr-tooltip-bg': '#002535',
        '--cerebr-highlight': '#ffc600',
        '--cerebr-code-bg': '#002535',
        '--cerebr-code-color': '#e0edff',
        '--cerebr-code-border': '#0d3a58'       
      }
    },
    {
      id: 'winter-is-coming',
      name: 'Winter is Coming',
      description: '蓝色冷调主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(20, 30, 51, var(--cerebr-opacity))',
        '--cerebr-text-color': '#b7ceff',
        '--cerebr-message-user-bg': 'rgba(30, 40, 61, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(25, 35, 56, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(17, 27, 45, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#95d0f9',
        '--cerebr-border-color': '#264172',
        '--cerebr-hover-color': 'rgba(149, 208, 249, 0.1)',
        '--cerebr-tooltip-bg': '#0e1729',
        '--cerebr-highlight': '#219fd5',
        '--cerebr-code-bg': '#0e1729',
        '--cerebr-code-color': '#b7ceff',
        '--cerebr-code-border': '#264172'       
      }
    },
    {
      id: 'horizon',
      name: 'Horizon',
      description: '温暖橙粉色调主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(28, 30, 39, var(--cerebr-opacity))',
        '--cerebr-text-color': '#e0e0e0',
        '--cerebr-message-user-bg': 'rgba(38, 40, 49, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(33, 35, 44, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(25, 27, 36, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#e95678',
        '--cerebr-border-color': '#32374d',
        '--cerebr-hover-color': 'rgba(233, 86, 120, 0.1)',
        '--cerebr-tooltip-bg': '#1c1e27',
        '--cerebr-highlight': '#fab795',
        '--cerebr-code-bg': '#232534',
        '--cerebr-code-color': '#e0e0e0',
        '--cerebr-code-border': '#32374d'       
      }
    },
    {
      id: 'noctis',
      name: 'Noctis',
      description: '低对比舒适夜间主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(32, 32, 32, var(--cerebr-opacity))',
        '--cerebr-text-color': '#c5cddb',
        '--cerebr-message-user-bg': 'rgba(42, 42, 42, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(37, 37, 37, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(29, 29, 29, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#72b7c0',
        '--cerebr-border-color': '#3c3c3c',
        '--cerebr-hover-color': 'rgba(114, 183, 192, 0.1)',
        '--cerebr-tooltip-bg': '#202020',
        '--cerebr-highlight': '#cec5a9',
        '--cerebr-code-bg': '#252525',
        '--cerebr-code-color': '#c5cddb',
        '--cerebr-code-border': '#3c3c3c'       
      }
    },
    {
      id: 'radical',
      name: 'Radical',
      description: '紫粉色高对比主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(20, 19, 34, var(--cerebr-opacity))',
        '--cerebr-text-color': '#e0e0e0',
        '--cerebr-message-user-bg': 'rgba(30, 29, 44, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(25, 24, 39, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(17, 16, 31, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#fe428e',
        '--cerebr-border-color': '#38364d',
        '--cerebr-hover-color': 'rgba(254, 66, 142, 0.1)',
        '--cerebr-tooltip-bg': '#141322',
        '--cerebr-highlight': '#a9ff68',
        '--cerebr-code-bg': '#1e1c31',
        '--cerebr-code-color': '#e0e0e0',
        '--cerebr-code-border': '#38364d'       
      }
    },
    {
      id: 'slack-dark',
      name: 'Slack Dark',
      description: 'Slack风格深色主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(31, 41, 55, var(--cerebr-opacity))',
        '--cerebr-text-color': '#e2e8f0',
        '--cerebr-message-user-bg': 'rgba(41, 51, 65, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(36, 46, 60, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(26, 36, 50, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#36c5f0',
        '--cerebr-border-color': '#4b5563',
        '--cerebr-hover-color': 'rgba(54, 197, 240, 0.1)',
        '--cerebr-tooltip-bg': '#1e293b',
        '--cerebr-highlight': '#ecb22e',
        '--cerebr-code-bg': '#1a202c',
        '--cerebr-code-color': '#e2e8f0',
        '--cerebr-code-border': '#4b5563'       
      }
    },
    {
      id: 'eva-dark',
      name: 'Eva Dark',
      description: '多彩现代深色主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(41, 45, 60, var(--cerebr-opacity))',
        '--cerebr-text-color': '#f8f8f2',
        '--cerebr-message-user-bg': 'rgba(51, 55, 70, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(46, 50, 65, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(36, 40, 55, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#56b6c2',
        '--cerebr-border-color': '#3b3f54',
        '--cerebr-hover-color': 'rgba(86, 182, 194, 0.1)',
        '--cerebr-tooltip-bg': '#292d3c',
        '--cerebr-highlight': '#7cd850',
        '--cerebr-code-bg': '#292d3c',
        '--cerebr-code-color': '#f8f8f2',
        '--cerebr-code-border': '#3b3f54'       
      }
    },
    {
      id: 'embark',
      name: 'Embark',
      description: '深紫色系主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(30, 30, 46, var(--cerebr-opacity))',
        '--cerebr-text-color': '#cbe3e7',
        '--cerebr-message-user-bg': 'rgba(42, 42, 58, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(36, 36, 52, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(24, 24, 40, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#a1efd3',
        '--cerebr-border-color': '#3e3859',
        '--cerebr-hover-color': 'rgba(161, 239, 211, 0.1)',
        '--cerebr-tooltip-bg': '#1e1c31',
        '--cerebr-highlight': '#f48fb1',
        '--cerebr-code-bg': '#2d2b40',
        '--cerebr-code-color': '#cbe3e7',
        '--cerebr-code-border': '#3e3859'       
      }
    },
    {
      id: 'andromeda',
      name: 'Andromeda',
      description: '星际科幻深色主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(35, 37, 46, var(--cerebr-opacity))',
        '--cerebr-text-color': '#d5ced9',
        '--cerebr-message-user-bg': 'rgba(45, 47, 56, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(40, 42, 51, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(32, 34, 43, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#c78feb',
        '--cerebr-border-color': '#4a4c57',
        '--cerebr-hover-color': 'rgba(199, 143, 235, 0.1)',
        '--cerebr-tooltip-bg': '#23252e',
        '--cerebr-highlight': '#26c7d0',
        '--cerebr-code-bg': '#23252e',
        '--cerebr-code-color': '#d5ced9',
        '--cerebr-code-border': '#4a4c57'       
      }
    },
    {
      id: 'shades-of-purple',
      name: 'Shades of Purple',
      description: '紫色系高彩度主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(42, 35, 81, var(--cerebr-opacity))',
        '--cerebr-text-color': '#fff9f9',
        '--cerebr-message-user-bg': 'rgba(52, 45, 91, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(47, 40, 86, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(36, 30, 76, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#fad000',
        '--cerebr-border-color': '#5d4d96',
        '--cerebr-hover-color': 'rgba(250, 208, 0, 0.1)',
        '--cerebr-tooltip-bg': '#2d2b55',
        '--cerebr-highlight': '#ff9d00',
        '--cerebr-code-bg': '#2d2b55',
        '--cerebr-code-color': '#fff9f9',
        '--cerebr-code-border': '#5d4d96'       
      }
    },
    {
      id: 'deepdark-material',
      name: 'Deep Dark Material',
      description: '黑暗物质深色主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(14, 14, 14, var(--cerebr-opacity))',
        '--cerebr-text-color': '#cccccc',
        '--cerebr-message-user-bg': 'rgba(31, 31, 31, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(26, 26, 26, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(18, 18, 18, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#4db6ac',
        '--cerebr-border-color': '#303030',
        '--cerebr-hover-color': 'rgba(77, 182, 172, 0.1)',
        '--cerebr-tooltip-bg': '#151515',
        '--cerebr-highlight': '#ff5370',
        '--cerebr-code-bg': 'rgba(255, 255, 255, 0.03)',
        '--cerebr-code-color': '#cccccc',
        '--cerebr-code-border': '#303030'       
      }
    },
    {
      id: 'hubble',
      name: 'Hubble',
      description: '星空深蓝主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(14, 24, 44, var(--cerebr-opacity))',
        '--cerebr-text-color': '#d8e5ff',
        '--cerebr-message-user-bg': 'rgba(24, 34, 54, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(19, 29, 49, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(11, 21, 41, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#6ca4f4',
        '--cerebr-border-color': '#28375c',
        '--cerebr-hover-color': 'rgba(108, 164, 244, 0.1)',
        '--cerebr-tooltip-bg': '#0e182c',
        '--cerebr-highlight': '#ee8e66',
        '--cerebr-code-bg': '#0e182c',
        '--cerebr-code-color': '#d8e5ff',
        '--cerebr-code-border': '#28375c'       
      }
    },
    {
      id: 'green-forest',
      name: 'Green Forest',
      description: '森林绿色主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(21, 32, 22, var(--cerebr-opacity))',
        '--cerebr-text-color': '#d9e6dd',
        '--cerebr-message-user-bg': 'rgba(31, 42, 32, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(26, 37, 27, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(16, 27, 17, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#87c095',
        '--cerebr-border-color': '#324233',
        '--cerebr-hover-color': 'rgba(135, 192, 149, 0.1)',
        '--cerebr-tooltip-bg': '#172018',
        '--cerebr-highlight': '#d9c87c',
        '--cerebr-code-bg': '#172018',
        '--cerebr-code-color': '#d9e6dd',
        '--cerebr-code-border': '#324233'       
      }
    },
    // 新增透明空灵主题
    {
      id: 'crystal-clear',
      name: '水晶透明',
      description: '高透明度水晶质感主题',
      type: 'light',
      variables: {
        '--cerebr-opacity': '0.4',
        '--cerebr-bg-color': 'rgba(255, 255, 255, var(--cerebr-opacity))',
        '--cerebr-text-color': '#333333',
        '--cerebr-message-user-bg': 'rgba(209, 232, 255, 0.3)',
        '--cerebr-message-ai-bg': 'rgba(245, 245, 245, 0.25)',
        '--cerebr-input-bg': 'rgba(248, 248, 255, 0.35)',
        '--cerebr-icon-color': '#5a9de4',
        '--cerebr-border-color': 'rgba(228, 228, 228, 0.4)',
        '--cerebr-hover-color': 'rgba(0, 122, 255, 0.05)',
        '--cerebr-tooltip-bg': 'rgba(255, 255, 255, 0.7)',
        '--cerebr-highlight': '#0084ff',
        '--cerebr-code-bg': 'rgba(246, 248, 250, 0.6)',
        '--cerebr-code-color': '#333333',
        '--cerebr-code-border': 'rgba(225, 228, 232, 0.4)'       
      }
    },
    {
      id: 'dark-glass',
      name: '暗夜玻璃',
      description: '深色透明玻璃质感主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.5',
        '--cerebr-bg-color': 'rgba(20, 20, 28, var(--cerebr-opacity))',
        '--cerebr-text-color': '#e0e0e0',
        '--cerebr-message-user-bg': 'rgba(45, 50, 70, 0.35)',
        '--cerebr-message-ai-bg': 'rgba(30, 35, 50, 0.3)',
        '--cerebr-input-bg': 'rgba(25, 25, 35, 0.4)',
        '--cerebr-icon-color': '#a0a8d0',
        '--cerebr-border-color': 'rgba(60, 65, 80, 0.4)',
        '--cerebr-hover-color': 'rgba(255, 255, 255, 0.05)',
        '--cerebr-tooltip-bg': 'rgba(20, 20, 28, 0.85)',
        '--cerebr-highlight': '#7d8df9',
        '--cerebr-code-bg': 'rgba(30, 30, 40, 0.6)',
        '--cerebr-code-color': '#e0e0e0',
        '--cerebr-code-border': 'rgba(60, 65, 80, 0.4)'       
      }
    },
    {
      id: 'aurora-borealis',
      name: '极光',
      description: '北极光渐变透明主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.45',
        '--cerebr-bg-color': 'rgba(16, 24, 40, var(--cerebr-opacity))',
        '--cerebr-text-color': '#e2f0ff',
        '--cerebr-message-user-bg': 'rgba(32, 87, 120, 0.3)',
        '--cerebr-message-ai-bg': 'rgba(23, 47, 73, 0.25)',
        '--cerebr-input-bg': 'rgba(15, 30, 55, 0.4)',
        '--cerebr-icon-color': '#67d7e6',
        '--cerebr-border-color': 'rgba(65, 176, 194, 0.3)',
        '--cerebr-hover-color': 'rgba(103, 215, 230, 0.1)',
        '--cerebr-tooltip-bg': 'rgba(16, 24, 40, 0.8)',
        '--cerebr-highlight': '#67d7e6',
        '--cerebr-code-bg': 'rgba(15, 30, 55, 0.6)',
        '--cerebr-code-color': '#e2f0ff',
        '--cerebr-code-border': 'rgba(65, 176, 194, 0.3)'       
      }
    },
    {
      id: 'sakura-mist',
      name: '樱花雾',
      description: '淡粉色透明梦幻主题',
      type: 'light',
      variables: {
        '--cerebr-opacity': 1,
        '--cerebr-bg-color': 'rgb(253 253 253 / 88%)',
        '--cerebr-text-color': 'hsl(304 10% 12% / 1)',
        '--cerebr-message-user-bg': 'rgb(255 230 240)',
        '--cerebr-message-ai-bg': 'rgb(250 240 245)',
        '--cerebr-input-bg': 'rgb(255 245 250)',
        '--cerebr-icon-color': '#e68bb3',
        '--cerebr-border-color': 'rgba(230, 210, 220, 0.4)',
        '--cerebr-hover-color': 'rgba(230, 139, 179, 0.05)',
        '--cerebr-tooltip-bg': 'rgba(255, 250, 250, 0.75)',
        '--cerebr-highlight': '#e68bb3',
        '--cerebr-code-bg': 'rgba(250, 245, 248, 0.5)',
        '--cerebr-code-color': '#5d4c5c',
        '--cerebr-code-border': 'rgba(230, 210, 220, 0.4)'       
      }
    },
    {
      id: 'ocean-depths',
      name: '深海',
      description: '深蓝色海洋透明主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.55',
        '--cerebr-bg-color': 'rgba(5, 30, 52, var(--cerebr-opacity))',
        '--cerebr-text-color': '#c5e2ff',
        '--cerebr-message-user-bg': 'rgba(20, 60, 100, 0.3)',
        '--cerebr-message-ai-bg': 'rgba(15, 45, 75, 0.25)',
        '--cerebr-input-bg': 'rgba(10, 35, 65, 0.4)',
        '--cerebr-icon-color': '#4fb4ff',
        '--cerebr-border-color': 'rgba(30, 90, 150, 0.4)',
        '--cerebr-hover-color': 'rgba(79, 180, 255, 0.1)',
        '--cerebr-tooltip-bg': 'rgba(5, 30, 52, 0.85)',
        '--cerebr-highlight': '#4fb4ff',
        '--cerebr-code-bg': 'rgba(10, 35, 65, 0.6)',
        '--cerebr-code-color': '#c5e2ff',
        '--cerebr-code-border': 'rgba(30, 90, 150, 0.4)'       
      }
    },
    {
      id: 'github-universe',
      name: 'GitHub Universe',
      description: 'GitHub Universe 会议主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(14, 17, 22, var(--cerebr-opacity))',
        '--cerebr-text-color': '#e6edf3',
        '--cerebr-message-user-bg': 'rgba(24, 30, 44, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(19, 23, 33, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(10, 13, 18, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#f778ba',
        '--cerebr-border-color': '#30363d',
        '--cerebr-hover-color': 'rgba(247, 120, 186, 0.1)',
        '--cerebr-tooltip-bg': '#0d1117',
        '--cerebr-highlight': '#ff9bce',
        '--cerebr-code-bg': '#161b22',
        '--cerebr-code-color': '#e6edf3',
        '--cerebr-code-border': '#30363d'       
      }
    },
    {
      id: 'kanagawa',
      name: 'Kanagawa',
      description: '日式浮世绘风格主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(31, 34, 42, var(--cerebr-opacity))',
        '--cerebr-text-color': '#dcd7ba',
        '--cerebr-message-user-bg': 'rgba(42, 46, 58, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(36, 40, 50, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(28, 30, 38, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#7e9cd8',
        '--cerebr-border-color': '#54546d',
        '--cerebr-hover-color': 'rgba(126, 156, 216, 0.1)',
        '--cerebr-tooltip-bg': '#1f2430',
        '--cerebr-highlight': '#c0a36e',
        '--cerebr-code-bg': '#282b36',
        '--cerebr-code-color': '#dcd7ba',
        '--cerebr-code-border': '#54546d'       
      }
    },
    {
      id: 'everforest',
      name: 'Everforest',
      description: '低饱和度森林配色主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(45, 53, 59, var(--cerebr-opacity))',
        '--cerebr-text-color': '#d3c6aa',
        '--cerebr-message-user-bg': 'rgba(55, 66, 72, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(50, 59, 65, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(40, 48, 54, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#a7c080',
        '--cerebr-border-color': '#4f5b58',
        '--cerebr-hover-color': 'rgba(167, 192, 128, 0.1)',
        '--cerebr-tooltip-bg': '#2d353b',
        '--cerebr-highlight': '#e67e80',
        '--cerebr-code-bg': '#343f44',
        '--cerebr-code-color': '#d3c6aa',
        '--cerebr-code-border': '#4f5b58'       
      }
    },
    {
      id: 'moonlight',
      name: 'Moonlight',
      description: '月光蓝紫色调主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(31, 33, 45, var(--cerebr-opacity))',
        '--cerebr-text-color': '#c8d3f5',
        '--cerebr-message-user-bg': 'rgba(41, 44, 60, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(36, 39, 53, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(26, 28, 40, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#c099ff',
        '--cerebr-border-color': '#444a73',
        '--cerebr-hover-color': 'rgba(192, 153, 255, 0.1)',
        '--cerebr-tooltip-bg': '#1f212d',
        '--cerebr-highlight': '#65bcff',
        '--cerebr-code-bg': '#252838',
        '--cerebr-code-color': '#c8d3f5',
        '--cerebr-code-border': '#444a73'       
      }
    },
    {
      id: 'operaTint',
      name: '歌剧院',
      description: '优雅红棕色调浅色主题',
      type: 'light',
      variables: {
        '--cerebr-opacity': '0.75',
        '--cerebr-bg-color': 'rgba(245, 240, 235, var(--cerebr-opacity))',
        '--cerebr-text-color': '#5c4033',
        '--cerebr-message-user-bg': 'rgba(233, 225, 215, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(240, 233, 225, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(250, 245, 240, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#a05a2c',
        '--cerebr-border-color': '#d9ccbd',
        '--cerebr-hover-color': 'rgba(160, 90, 44, 0.05)',
        '--cerebr-tooltip-bg': '#f5f0eb',
        '--cerebr-highlight': '#b8664e',
        '--cerebr-code-bg': '#f0e8e0',
        '--cerebr-code-color': '#5c4033',
        '--cerebr-code-border': '#d9ccbd'       
      }
    },
    {
      id: 'true-black',
      name: '纯黑',
      description: '真正的黑色背景主题，适合OLED屏幕',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.9',
        '--cerebr-bg-color': 'rgba(0, 0, 0, var(--cerebr-opacity))',
        '--cerebr-text-color': '#cccccc',
        '--cerebr-message-user-bg': 'rgba(24, 24, 24, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(0, 0, 0, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(10, 10, 10, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#888888',
        '--cerebr-border-color': '#2a2a2a',
        '--cerebr-hover-color': 'rgba(255, 255, 255, 0.05)',
        '--cerebr-tooltip-bg': '#000000',
        '--cerebr-highlight': '#3a71c1',
        '--cerebr-code-bg': '#0a0a0a',
        '--cerebr-code-color': '#cccccc',
        '--cerebr-code-border': '#2a2a2a'       
      }
    },
    {
      id: 'dark-reader',
      name: 'Dark Reader',
      description: '类似浏览器护眼插件的暗色主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.9',
        '--cerebr-bg-color': 'rgba(27, 27, 27, var(--cerebr-opacity))',
        '--cerebr-text-color': '#d8d4cf',
        '--cerebr-message-user-bg': 'rgba(38, 38, 38, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(33, 33, 33, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(22, 22, 22, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#a09a91',
        '--cerebr-border-color': '#444444',
        '--cerebr-hover-color': 'rgba(255, 255, 255, 0.05)',
        '--cerebr-tooltip-bg': '#1b1b1b',
        '--cerebr-highlight': '#5da9e9',
        '--cerebr-code-bg': '#222222',
        '--cerebr-code-color': '#d8d4cf',
        '--cerebr-code-border': '#444444'       
      }
    },
    {
      id: 'midnight-oil',
      name: '午夜灯火',
      description: '深夜阅读护眼主题，偏暖色调',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.9',
        '--cerebr-bg-color': 'rgba(21, 21, 21, var(--cerebr-opacity))',
        '--cerebr-text-color': '#c5b9a0',
        '--cerebr-message-user-bg': 'rgba(33, 31, 28, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(27, 25, 24, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(17, 17, 17, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#a18f72',
        '--cerebr-border-color': '#3a3530',
        '--cerebr-hover-color': 'rgba(161, 143, 114, 0.1)',
        '--cerebr-tooltip-bg': '#151515',
        '--cerebr-highlight': '#b59d74',
        '--cerebr-code-bg': '#1a1a19',
        '--cerebr-code-color': '#c5b9a0',
        '--cerebr-code-border': '#3a3530'       
      }
    },
    {
      id: 'astro-dark',
      name: '星空黑',
      description: '深空星辰风格深色主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.9',
        '--cerebr-bg-color': 'rgba(10, 12, 21, var(--cerebr-opacity))',
        '--cerebr-text-color': '#bbc2d0',
        '--cerebr-message-user-bg': 'rgba(20, 24, 38, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(15, 18, 30, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(8, 10, 18, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#6b8cce',
        '--cerebr-border-color': '#2a3048',
        '--cerebr-hover-color': 'rgba(107, 140, 206, 0.1)',
        '--cerebr-tooltip-bg': '#0a0c15',
        '--cerebr-highlight': '#5b8def',
        '--cerebr-code-bg': '#12151f',
        '--cerebr-code-color': '#bbc2d0',
        '--cerebr-code-border': '#2a3048'       
      }
    },
    {
      id: 'edge-dark',
      name: 'Edge Dark',
      description: 'Microsoft Edge 浏览器深色主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(32, 32, 32, var(--cerebr-opacity))',
        '--cerebr-text-color': '#e5e5e5',
        '--cerebr-message-user-bg': 'rgba(42, 42, 42, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(37, 37, 37, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(27, 27, 27, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#33b4ff',
        '--cerebr-border-color': '#404040',
        '--cerebr-hover-color': 'rgba(51, 180, 255, 0.1)',
        '--cerebr-tooltip-bg': '#202020',
        '--cerebr-highlight': '#0078d7',
        '--cerebr-code-bg': '#252525',
        '--cerebr-code-color': '#e5e5e5',
        '--cerebr-code-border': '#404040'       
      }
    },
    {
      id: 'vibrant-ink',
      name: 'Vibrant Ink',
      description: '高对比度文字编辑器主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '0.85',
        '--cerebr-bg-color': 'rgba(0, 0, 0, var(--cerebr-opacity))',
        '--cerebr-text-color': '#ffffff',
        '--cerebr-message-user-bg': 'rgba(32, 32, 32, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(15, 15, 15, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(10, 10, 10, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#ff6600',
        '--cerebr-border-color': '#333333',
        '--cerebr-hover-color': 'rgba(255, 102, 0, 0.1)',
        '--cerebr-tooltip-bg': '#000000',
        '--cerebr-highlight': '#ffcc00',
        '--cerebr-code-bg': '#0a0a0a',
        '--cerebr-code-color': '#ffffff',
        '--cerebr-code-border': '#333333'       
      }
    },
    {
      id: 'alabaster',
      name: 'Alabaster',
      description: '极简白色纸张风格主题',
      type: 'light',
      variables: {
        '--cerebr-opacity': '0.75',
        '--cerebr-bg-color': 'rgba(253, 253, 253, var(--cerebr-opacity))',
        '--cerebr-text-color': '#000000',
        '--cerebr-message-user-bg': 'rgba(243, 243, 243, var(--cerebr-opacity))',
        '--cerebr-message-ai-bg': 'rgba(248, 248, 248, var(--cerebr-opacity))',
        '--cerebr-input-bg': 'rgba(255, 255, 255, var(--cerebr-opacity))',
        '--cerebr-icon-color': '#777777',
        '--cerebr-border-color': '#eeeeee',
        '--cerebr-hover-color': 'rgba(0, 0, 0, 0.03)',
        '--cerebr-tooltip-bg': '#fdfdfd',
        '--cerebr-highlight': '#000000',
        '--cerebr-code-bg': '#f7f7f7',
        '--cerebr-code-color': '#000000',
        '--cerebr-code-border': '#eeeeee'       
      }
    },
    // 不透明高可读性主题（新增）
    {
      id: 'clarity-light',
      name: 'Clarity Light',
      description: '高对比极简浅色不透明主题',
      type: 'light',
      variables: {
        '--cerebr-opacity': '1',
        '--cerebr-bg-color': '#f7f7f8',
        '--cerebr-text-color': '#1f2937',
        '--cerebr-message-user-bg': '#ffffff',
        '--cerebr-message-ai-bg': '#f9fafb',
        '--cerebr-input-bg': '#ffffff',
        '--cerebr-icon-color': '#667085',
        '--cerebr-border-color': '#e5e7eb',
        '--cerebr-hover-color': 'rgba(0, 0, 0, 0.03)',
        '--cerebr-tooltip-bg': '#ffffff',
        '--cerebr-highlight': '#3a5da8',
        '--cerebr-code-bg': '#f3f4f6',
        '--cerebr-code-color': '#1f2937',
        '--cerebr-code-border': '#e5e7eb'       
      }
    },
    {
      id: 'sepia-light',
      name: 'Warm Sepia',
      description: '护眼暖调浅色不透明主题',
      type: 'light',
      variables: {
        '--cerebr-opacity': '1',
        '--cerebr-bg-color': '#f8f4e8',
        '--cerebr-text-color': '#3e3529',
        '--cerebr-message-user-bg': '#efe6d4',
        '--cerebr-message-ai-bg': '#fbf7ee',
        '--cerebr-input-bg': '#f5efe2',
        '--cerebr-icon-color': '#8b6f47',
        '--cerebr-border-color': '#e4dccb',
        '--cerebr-hover-color': 'rgba(0, 0, 0, 0.03)',
        '--cerebr-tooltip-bg': '#fffdf7',
        '--cerebr-highlight': '#c47f2c',
        '--cerebr-code-bg': '#f2ebda',
        '--cerebr-code-color': '#3e3529',
        '--cerebr-code-border': '#e4dccb'       
      }
    },
    {
      id: 'slate-light',
      name: 'Slate Light',
      description: '中性灰浅色不透明主题',
      type: 'light',
      variables: {
        '--cerebr-opacity': '1',
        '--cerebr-bg-color': '#f7f7f8',
        '--cerebr-text-color': '#202227',
        '--cerebr-message-user-bg': '#e6f0ff',
        '--cerebr-message-ai-bg': '#ffffff',
        '--cerebr-input-bg': '#ffffff',
        '--cerebr-icon-color': '#5b616e',
        '--cerebr-border-color': '#d9dde3',
        '--cerebr-hover-color': 'rgba(0, 0, 0, 0.03)',
        '--cerebr-tooltip-bg': '#ffffff',
        '--cerebr-highlight': '#0ea5e9',
        '--cerebr-code-bg': '#eef2f7',
        '--cerebr-code-color': '#202227',
        '--cerebr-code-border': '#d9dde3'       
      }
    },
    {
      id: 'charcoal-dark',
      name: 'Charcoal',
      description: '高对比炭黑不透明主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '1',
        '--cerebr-bg-color': '#121417',
        '--cerebr-text-color': '#cdd1d6',
        '--cerebr-message-user-bg': '#1e232a',
        '--cerebr-message-ai-bg': '#171b20',
        '--cerebr-input-bg': '#0f1216',
        '--cerebr-icon-color': '#9aa3ad',
        '--cerebr-border-color': '#2a2f36',
        '--cerebr-hover-color': 'rgba(255, 255, 255, 0.06)',
        '--cerebr-tooltip-bg': '#0e1115',
        '--cerebr-highlight': '#4ea1ff',
        '--cerebr-code-bg': '#0f141a',
        '--cerebr-code-color': '#cdd1d6',
        '--cerebr-code-border': '#2a2f36'       
      }
    },
    {
      id: 'graphite-dark',
      name: 'Graphite Dark',
      description: '中性灰深色不透明主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '1',
        '--cerebr-bg-color': '#1a1c1f',
        '--cerebr-text-color': '#d0d5dd',
        '--cerebr-message-user-bg': '#23262b',
        '--cerebr-message-ai-bg': '#1f2226',
        '--cerebr-input-bg': '#15171a',
        '--cerebr-icon-color': '#9ea7b3',
        '--cerebr-border-color': '#343a40',
        '--cerebr-hover-color': 'rgba(255, 255, 255, 0.06)',
        '--cerebr-tooltip-bg': '#131519',
        '--cerebr-highlight': '#7aa2f7',
        '--cerebr-code-bg': '#121417',
        '--cerebr-code-color': '#d0d5dd',
        '--cerebr-code-border': '#343a40'       
      }
    },
    {
      id: 'espresso-dark',
      name: 'Espresso',
      description: '暖调咖啡深色不透明主题',
      type: 'dark',
      variables: {
        '--cerebr-opacity': '1',
        '--cerebr-bg-color': '#1c1a19',
        '--cerebr-text-color': '#e6d9c6',
        '--cerebr-message-user-bg': '#262220',
        '--cerebr-message-ai-bg': '#201d1b',
        '--cerebr-input-bg': '#151312',
        '--cerebr-icon-color': '#d0b48a',
        '--cerebr-border-color': '#3a322c',
        '--cerebr-hover-color': 'rgba(230, 217, 198, 0.08)',
        '--cerebr-tooltip-bg': '#141210',
        '--cerebr-highlight': '#d08a4e',
        '--cerebr-code-bg': '#171513',
        '--cerebr-code-color': '#e6d9c6',
        '--cerebr-code-border': '#3a322c'       
      }
    }
  ];

  // 精选主题：优先覆盖“明/暗、低对比/高对比、冷暖色系、纯黑系”等差异明显的风格。
  // 其余主题在预览区收纳到“更多主题”，降低“看起来都差不多”的选择负担。
  const FEATURED_THEME_IDS = [
    'auto',
    'light',
    'dark',
    'github-light',
    'github-dark',
    'vscode-dark',
    'solarized-light',
    'solarized-dark',
    'tokyo-night',
    'tokyo-night-light',
    'nord',
    'catppuccin-mocha',
    'catppuccin-latte',
    'true-black',
    'alabaster'
  ];

  // 汇总所有由主题系统管理的 CSS 变量，避免切换主题后残留旧主题变量。
  // 说明：仅清理主题管理器自己维护的变量，不影响其它设置项写入的 root 变量。
  const MANAGED_THEME_VARIABLES = Array.from(
    PREDEFINED_THEMES.reduce((result, theme) => {
      const vars = theme?.variables || {};
      Object.keys(vars).forEach((key) => result.add(key));
      return result;
    }, new Set())
  );

  function clearManagedThemeVariables(root) {
    if (!root || !root.style) return;
    MANAGED_THEME_VARIABLES.forEach((key) => {
      root.style.removeProperty(key);
    });
  }

  function applyThemeVariables(root, variables) {
    if (!root || !root.style) return;
    Object.entries(variables || {}).forEach(([key, value]) => {
      root.style.setProperty(key, value);
    });
  }

  function splitThemesForPreview(currentThemeId) {
    const featuredSet = new Set(FEATURED_THEME_IDS);
    const normalizedCurrentThemeId = String(currentThemeId || '').trim();
    if (normalizedCurrentThemeId) {
      featuredSet.add(normalizedCurrentThemeId);
    }

    const featuredThemes = [];
    const extraThemes = [];
    PREDEFINED_THEMES.forEach((theme) => {
      if (featuredSet.has(theme.id)) {
        featuredThemes.push(theme);
      } else {
        extraThemes.push(theme);
      }
    });

    return {
      featuredThemes,
      extraThemes
    };
  }

  /**
   * 获取所有可用主题
   * @returns {Array<Object>} 主题列表
   */
  function getAvailableThemes() {
    return PREDEFINED_THEMES;
  }

  /**
   * 根据ID获取主题
   * @param {string} themeId - 主题ID
   * @returns {Object|null} 主题对象或null（未找到时）
   */
  function getThemeById(themeId) {
    return PREDEFINED_THEMES.find(theme => theme.id === themeId) || null;
  }

  /**
   * 应用主题到DOM
   * @param {string} themeId - 主题ID
   * @returns {boolean} 是否成功应用主题
   */
  function applyTheme(themeId) {
    const theme = getThemeById(themeId);
    if (!theme) return false;

    const root = document.documentElement;
    
    // 更新data-theme属性，供主题预览识别当前主题
    root.setAttribute('data-theme', themeId);
    
    // 清除所有主题相关的类
    root.classList.remove('dark-theme', 'light-theme');
    // 先清除旧主题变量，防止“主题 A 有、主题 B 无”的变量残留。
    clearManagedThemeVariables(root);
    
    // 应用主题类和变量
    if (theme.type === 'auto') {
      // 跟随系统主题
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.classList.add(prefersDark ? 'dark-theme' : 'light-theme');
      
      // 应用对应主题的CSS变量
      const systemTheme = getThemeById(prefersDark ? 'dark' : 'light');
      applyThemeVariables(root, systemTheme?.variables);
    } else {
      // 根据主题类型添加对应的类
      root.classList.add(theme.type === 'dark' ? 'dark-theme' : 'light-theme');
      
      // 应用主题CSS变量
      applyThemeVariables(root, theme.variables);
    }
    
    // 更新主题选择器标题，显示当前主题名称
    const themeTitleSpan = document.querySelector("#theme-selector > div.theme-title > span");
    if (themeTitleSpan) {
      themeTitleSpan.textContent = theme.name;
    }
    
    return true;
  }

  /**
   * 设置监听系统主题变化事件
   */
  function setupSystemThemeListener() {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    
    // 当系统主题变化且当前使用的是自动主题时，更新主题
    const handleThemeChange = (e) => {
      const currentThemeId = document.documentElement.getAttribute('data-theme') || 'auto';
      if (currentThemeId === 'auto') {
        applyTheme('auto');
      }
    };
    
    // 添加事件监听
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleThemeChange);
    } else if (mediaQuery.addListener) {
      // 兼容性处理
      mediaQuery.addListener(handleThemeChange);
    }
  }

  /**
   * 渲染主题预览卡片
   * @param {HTMLElement} container - 预览卡片容器元素
   * @param {Function} onThemeSelect - 主题选择回调函数
   */
  function renderThemePreview(container, onThemeSelect) {
    if (!container) return;
    
    // 清空容器
    container.innerHTML = '';
    container.classList.remove('theme-preview-grid--show-all');
    container.dataset.themePreviewExpanded = '0';
    
    // 获取当前主题ID
    const currentThemeId = document.documentElement.getAttribute('data-theme') || 'auto';
    
    // 检测系统深浅色模式，用于auto主题的预览
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const { featuredThemes, extraThemes } = splitThemesForPreview(currentThemeId);
    const hasExtraThemes = extraThemes.length > 0;
    // 默认收起“更多主题”，避免首次打开就被大量相近主题淹没。
    let showAllThemes = false;
    let moreToggleButton = null;

    function updatePreviewExpandedState(expanded) {
      showAllThemes = !!expanded;
      container.classList.toggle('theme-preview-grid--show-all', showAllThemes);
      container.dataset.themePreviewExpanded = showAllThemes ? '1' : '0';
      container.querySelectorAll('.theme-preview-card--extra').forEach((card) => {
        card.style.display = showAllThemes ? 'flex' : 'none';
      });
      if (!moreToggleButton) return;
      moreToggleButton.setAttribute('aria-expanded', showAllThemes ? 'true' : 'false');
      moreToggleButton.textContent = showAllThemes
        ? (moreToggleButton.dataset.labelExpanded || '收起更多主题')
        : (moreToggleButton.dataset.labelCollapsed || '显示更多主题');
    }

    function createPreviewCard(theme, isExtraCard = false) {
      const themeId = theme.id;
      
      // 创建预览卡片
      const previewCard = document.createElement('div');
      previewCard.className = 'theme-preview-card';
      if (isExtraCard) {
        previewCard.classList.add('theme-preview-card--extra');
        previewCard.style.display = showAllThemes ? 'flex' : 'none';
      }
      previewCard.setAttribute('data-theme-id', themeId);
      
      if (themeId === currentThemeId) {
        previewCard.classList.add('active');
      }
      
      // 设置预览卡片的CSS变量
      let themeVars;
      
      // 为auto主题特殊处理，使用系统当前深浅模式对应的主题变量
      if (themeId === 'auto') {
        const systemTheme = getThemeById(prefersDark ? 'dark' : 'light');
        themeVars = systemTheme.variables;
        
        // 为auto主题预览卡片添加标识
        previewCard.classList.add(prefersDark ? 'dark-mode' : 'light-mode');
      } else {
        themeVars = theme.variables;
      }

      // 移除透明度，确保预览卡片中的颜色是不透明的
      const removeOpacity = (colorValue) => {
        const raw = String(colorValue || '');
        return raw.replace('rgba', 'rgb').replace('var(--cerebr-opacity)', '1');
      };
      
      previewCard.style.setProperty('--preview-header', themeVars['--cerebr-border-color'] || '#ffffff');
      previewCard.style.setProperty('--preview-body-bg', removeOpacity(themeVars['--cerebr-bg-color']) || '#ffffff');
      previewCard.style.setProperty('--preview-user-msg', themeVars['--cerebr-message-user-bg'] || '#e1f5fe');
      previewCard.style.setProperty('--preview-ai-msg', themeVars['--cerebr-message-ai-bg'] || '#f5f5f5');
      previewCard.style.setProperty('--preview-highlight', themeVars['--cerebr-highlight'] || '#007acc');
      previewCard.style.setProperty('--preview-text-color', themeVars['--cerebr-text-color'] || '#333333');
      previewCard.style.setProperty('--preview-icon-color', themeVars['--cerebr-icon-color'] || '#586069');
      
      // 创建预览内容
      const previewContent = document.createElement('div');
      previewContent.className = 'theme-preview-content';
      
      // 创建顶部栏
      const header = document.createElement('div');
      header.className = 'theme-preview-header';
      
      // 添加主题颜色小圆点
      const colorDotsContainer = document.createElement('div');
      colorDotsContainer.className = 'theme-preview-dots';
      
      // 添加highlight颜色小圆点
      const highlightDot = document.createElement('span');
      highlightDot.className = 'theme-preview-dot highlight-dot';
      highlightDot.style.backgroundColor = themeVars['--cerebr-highlight'] || '#007acc';
           
      // 添加icon颜色小圆点
      const iconDot = document.createElement('span');
      iconDot.className = 'theme-preview-dot icon-dot';
      iconDot.style.backgroundColor = themeVars['--cerebr-icon-color'] || '#586069';

      // 添加text颜色小圆点
      const textDot = document.createElement('span');
      textDot.className = 'theme-preview-dot text-dot';
      textDot.style.backgroundColor = themeVars['--cerebr-text-color'] || '#333333';
 
      const dummy = document.createElement('span');
      dummy.className = 'theme-preview-dot dummy-dot';

      // 将小圆点添加到容器
      colorDotsContainer.appendChild(highlightDot);
      colorDotsContainer.appendChild(iconDot);
      colorDotsContainer.appendChild(textDot);
      colorDotsContainer.appendChild(dummy);
      
      // 将小圆点容器添加到头部
      header.appendChild(colorDotsContainer);
      
      // 创建消息区域
      const messagesContainer = document.createElement('div');
      messagesContainer.className = 'theme-preview-messages';
      
      // 添加模拟消息
      const aiMessage1 = document.createElement('div');
      aiMessage1.className = 'theme-preview-message ai';
      
      const userMessage = document.createElement('div');
      userMessage.className = 'theme-preview-message user';
      
      const aiMessage2 = document.createElement('div');
      aiMessage2.className = 'theme-preview-message ai';
      
      messagesContainer.appendChild(aiMessage1);
      messagesContainer.appendChild(userMessage);
      messagesContainer.appendChild(aiMessage2);
      
      // 创建主题名称
      const themeName = document.createElement('div');
      themeName.className = 'theme-preview-card-name';
      themeName.textContent = theme.name;
      
      // 为auto主题添加系统模式指示
      if (themeId === 'auto') {
        const modeIndicator = document.createElement('span');
        modeIndicator.className = 'auto-theme-indicator';
        modeIndicator.textContent = prefersDark ? ' (当前: 深色)' : ' (当前: 浅色)';
        themeName.appendChild(modeIndicator);
      }
      
      // 组装预览卡片
      previewContent.appendChild(header);
      previewContent.appendChild(messagesContainer);
      previewCard.appendChild(previewContent);
      previewCard.appendChild(themeName);
      
      // 添加点击事件
      previewCard.addEventListener('click', () => {
        // 移除其他卡片的active类
        container.querySelectorAll('.theme-preview-card.active').forEach(card => {
          card.classList.remove('active');
        });
        
        // 为当前卡片添加active类
        previewCard.classList.add('active');
        if (isExtraCard && !showAllThemes) {
          // 选中“更多主题”中的卡片后自动展开，避免活动项被隐藏。
          updatePreviewExpandedState(true);
        }
        
        // 调用回调函数
        if (typeof onThemeSelect === 'function') {
          onThemeSelect(themeId);
        }
      });

      return previewCard;
    }

    featuredThemes.forEach((theme) => {
      container.appendChild(createPreviewCard(theme, false));
    });
    extraThemes.forEach((theme) => {
      container.appendChild(createPreviewCard(theme, true));
    });

    if (hasExtraThemes) {
      moreToggleButton = document.createElement('button');
      moreToggleButton.type = 'button';
      moreToggleButton.className = 'theme-preview-more-toggle';
      moreToggleButton.dataset.labelCollapsed = `显示其余 ${extraThemes.length} 个主题`;
      moreToggleButton.dataset.labelExpanded = `收起其余 ${extraThemes.length} 个主题`;
      moreToggleButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        updatePreviewExpandedState(!showAllThemes);
      });
      container.appendChild(moreToggleButton);
    }

    updatePreviewExpandedState(showAllThemes);
  }

  /**
   * 初始化函数
   * @param {string} [initialThemeId] - 初始应用的主题ID，若未提供则使用'auto'
   */
  function init(initialThemeId) {
    setupSystemThemeListener();
    
    // 应用初始主题
    const themeToApply = initialThemeId || document.documentElement.getAttribute('data-theme') || 'auto';
    applyTheme(themeToApply);
  }

  // 返回主题管理器接口
  return {
    getAvailableThemes,
    getThemeById,
    applyTheme,
    renderThemePreview,
    init
  };
} 
