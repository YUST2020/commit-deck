/**
 * 设计 Token 单一事实来源（Single Source of Truth）
 * --------------------------------------------------
 * 所有可复用的设计决策都集中在这里定义，其它文件（CSS 变量、Naive 主题、组件内联样式）
 * 都必须引用这里的值，禁止在业务代码里硬编码颜色/尺寸/字号/圆角/阴影。
 *
 * 三层结构：
 *   primitive（原始）  —— 与主题无关的原子值（色阶、字号刻度、间距步长）
 *   semantic（语义）   —— 按用途命名的值（背景、文字、边框、主色），随明暗主题变化
 *   mapping           —— 把 semantic 映射到 Naive UI 主题 overrides
 *
 * 修改流程：改这里 → 自动同步到 CSS 变量（tokens.css）与 Naive 主题（useTheme）。
 */

/* ============================================================
 * 1. Primitive（原始 token）—— 原子值，不随主题变化
 * ========================================================== */

/** 中性色阶（从深到浅）。受 GitHub Primer / Linear 风格启发，冷调低饱和。 */
export const neutralScale = {
  0: '#ffffff',
  50: '#f6f8fa',
  100: '#eceff3',
  200: '#d9dee5',
  300: '#b8c0cc',
  400: '#8b95a6',
  500: '#5c6675',
  600: '#424b59',
  700: '#2f3743',
  800: '#1c232e',
  900: '#11161e',
  950: '#0a0e14',
  1000: '#06090d'
} as const

/** 品牌主色 —— 选用克制的靛蓝（Indigo），传递"工具/专业"气质，避免 Git 橙红的燥感 */
export const brandScale = {
  50: '#eef2ff',
  100: '#e0e7ff',
  200: '#c7d2fe',
  300: '#a5b4fc',
  400: '#818cf8',
  500: '#6366f1', // 主色
  600: '#4f46e5',
  700: '#4338ca',
  800: '#3730a3',
  900: '#312e81'
} as const

/** 语义功能色（success/warning/error/info）—— 与 Naive 默认色系对齐 */
export const intentScale = {
  success: '#18a058',
  warning: '#f0a020',
  error: '#d03050',
  info: '#2080f0'
} as const

/** git 状态专用色（用于文件状态标签等） */
export const gitScale = {
  added: '#18a058', // 新增 / 已暂存
  modified: '#f0a020', // 修改
  deleted: '#d03050', // 删除
  renamed: '#2080f0', // 重命名
  untracked: '#8b95a6' // 未跟踪（中性灰）
} as const

/** 字体族 */
export const fontFamily = {
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', Roboto, Helvetica, Arial, sans-serif",
  mono: "'JetBrains Mono', 'Fira Code', 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace"
} as const

/** 字号刻度（采用 1.125 模数，桌面端阅读舒适） */
export const fontSize = {
  xs: '11px',
  sm: '12px',
  base: '13px', // 桌面端基准字号比 Web 小一档
  md: '14px',
  lg: '16px',
  xl: '18px',
  '2xl': '22px',
  '3xl': '28px'
} as const

/** 字重 */
export const fontWeight = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700
} as const

/** 行高 */
export const lineHeight = {
  tight: 1.25,
  base: 1.5,
  relaxed: 1.7
} as const

/** 间距步长（4px 基准，1×4 基数网格） */
export const spacing = {
  0: '0px',
  1: '2px',
  2: '4px',
  3: '6px',
  4: '8px',
  5: '10px',
  6: '12px',
  8: '16px',
  10: '20px',
  12: '24px',
  16: '32px',
  20: '40px',
  24: '48px'
} as const

/** 圆角 —— 现代简约风偏小圆角，克制不花哨 */
export const radius = {
  none: '0px',
  sm: '3px',
  base: '5px',
  md: '6px',
  lg: '8px',
  xl: '12px',
  full: '9999px'
} as const

/** 描边宽度 */
export const borderWidth = {
  hairline: '0.5px',
  thin: '1px',
  thick: '2px'
} as const

/** 阴影 —— 低高度、柔和、多层叠加（简约现代风的关键：阴影要轻） */
export const shadow = {
  xs: '0 1px 2px rgba(6, 9, 13, 0.04)',
  sm: '0 1px 3px rgba(6, 9, 13, 0.06), 0 1px 2px rgba(6, 9, 13, 0.04)',
  md: '0 4px 12px rgba(6, 9, 13, 0.08), 0 2px 4px rgba(6, 9, 13, 0.04)',
  lg: '0 12px 28px rgba(6, 9, 13, 0.12), 0 4px 8px rgba(6, 9, 13, 0.06)',
  focus: '0 0 0 3px rgba(99, 102, 241, 0.22)'
} as const

/** 动效缓动与时长 */
export const motion = {
  duration: {
    fast: '120ms',
    base: '180ms',
    slow: '260ms'
  },
  easing: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    emphasized: 'cubic-bezier(0.2, 0, 0, 1.2)',
    exit: 'cubic-bezier(0.4, 0, 1, 1)'
  }
} as const

/** 组件级尺寸常量（侧栏宽度、面板内边距等） */
export const layout = {
  siderWidth: '240px',
  siderCollapsedWidth: '54px',
  aiPanelWidth: '380px',
  headerHeight: '48px',
  panelPadding: '16px',
  listItemHeight: '36px'
} as const

/** z-index 层级管理（避免随意写 9999） */
export const zIndex = {
  base: 0,
  dropdown: 1000,
  sticky: 1100,
  modal: 2000,
  toast: 3000
} as const

/* ============================================================
 * 2. Semantic（语义 token）—— 随明暗主题变化
 * ========================================================== */

export interface SemanticTokens {
  /** 应用底色（最底层背景） */
  bgApp: string
  /** 卡片/面板背景 */
  bgPanel: string
  /** 次级面板 / 悬浮层背景 */
  bgElevated: string
  /** 选中态背景 */
  bgSelected: string
  /** 悬浮态背景 */
  bgHover: string
  /** 主文字 */
  textPrimary: string
  /** 次级文字（路径、说明） */
  textSecondary: string
  /** 占位/禁用文字 */
  textTertiary: string
  /** 主色及其对比文字色 */
  textOnBrand: string
  /** 描边边框 */
  border: string
  /** 强调描边（hover/focus） */
  borderStrong: string
  /** 品牌主色 */
  brand: string
  brandHover: string
  brandActive: string
}

/** 明色主题语义 token */
export const lightSemantic: SemanticTokens = {
  bgApp: neutralScale[50],
  bgPanel: neutralScale[0],
  bgElevated: neutralScale[0],
  bgSelected: brandScale[50],
  bgHover: neutralScale[100],
  textPrimary: neutralScale[900],
  textSecondary: neutralScale[500],
  textTertiary: neutralScale[400],
  textOnBrand: '#ffffff',
  border: neutralScale[200],
  borderStrong: neutralScale[300],
  brand: brandScale[600],
  brandHover: brandScale[700],
  brandActive: brandScale[800]
}

/** 暗色主题语义 token */
export const darkSemantic: SemanticTokens = {
  bgApp: neutralScale[950],
  bgPanel: neutralScale[900],
  bgElevated: neutralScale[800],
  bgSelected: brandScale[900],
  bgHover: neutralScale[800],
  textPrimary: neutralScale[50],
  textSecondary: neutralScale[400],
  textTertiary: neutralScale[500],
  textOnBrand: '#ffffff',
  border: neutralScale[700],
  borderStrong: neutralScale[600],
  brand: brandScale[400],
  brandHover: brandScale[300],
  brandActive: brandScale[200]
}

/* ============================================================
 * 3. CSS 变量生成器
 *    将 semantic token 写入 :root / [data-theme="dark"]
 *    业务 CSS 统一用 var(--xxx) 引用。
 * ========================================================== */

const TOKEN_TO_CSS_VAR: Record<keyof SemanticTokens, string> = {
  bgApp: '--bg-app',
  bgPanel: '--bg-panel',
  bgElevated: '--bg-elevated',
  bgSelected: '--bg-selected',
  bgHover: '--bg-hover',
  textPrimary: '--text-primary',
  textSecondary: '--text-secondary',
  textTertiary: '--text-tertiary',
  textOnBrand: '--text-on-brand',
  border: '--border',
  borderStrong: '--border-strong',
  brand: '--brand',
  brandHover: '--brand-hover',
  brandActive: '--brand-active'
}

/** 把 SemanticTokens 对象转成 CSS 声明字符串 */
export function semanticToCssVars(tokens: SemanticTokens): string {
  return (Object.keys(TOKEN_TO_CSS_VAR) as (keyof SemanticTokens)[])
    .map((k) => `  ${TOKEN_TO_CSS_VAR[k]}: ${tokens[k]};`)
    .join('\n')
}

export { TOKEN_TO_CSS_VAR }
