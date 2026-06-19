/**
 * 主题 composable
 * --------------------------------------------------
 * 1. 管理"明色/暗色/跟随系统"三种模式
 * 2. 把设计 token 映射到 Naive UI 的 GlobalThemeOverrides
 *    —— 让 Naive 组件的颜色/圆角/字号与本应用的 token 体系完全一致
 * 3. 同步 <html data-theme> 属性，驱动 tokens.css 里的 CSS 变量切换
 */
import { computed, ref, watch } from 'vue'
import { darkTheme, type GlobalThemeOverrides } from 'naive-ui'
import {
  fontFamily,
  fontSize,
  radius,
  neutralScale,
  brandScale,
  intentScale
} from '@/tokens/tokens'

export type ThemeMode = 'light' | 'dark' | 'auto'

const themeMode = ref<ThemeMode>('auto')

/** 当前是否为暗色（auto 时解析系统偏好） */
export function useTheme() {
  const prefersDark = usePrefersDark()

  const isDark = computed(() =>
    themeMode.value === 'auto' ? prefersDark.value : themeMode.value === 'dark'
  )

  const naiveTheme = computed(() => (isDark.value ? darkTheme : null))

  /** Naive UI 全局主题覆盖 —— 单点映射，确保组件与 token 一致 */
  const themeOverrides = computed<GlobalThemeOverrides>(() =>
    buildOverrides(isDark.value)
  )

  // 同步 data-theme 到 <html>，驱动 CSS 变量
  watch(
    isDark,
    (dark) => {
      document.documentElement.setAttribute(
        'data-theme',
        dark ? 'dark' : 'light'
      )
    },
    { immediate: true }
  )

  function setMode(mode: ThemeMode) {
    themeMode.value = mode
  }

  return {
    mode: themeMode,
    isDark,
    naiveTheme,
    themeOverrides,
    setMode
  }
}

/** 构造 Naive 主题覆盖（明暗共用结构，仅色值不同） */
function buildOverrides(isDark: boolean): GlobalThemeOverrides {
  const common = {
    fontFamily: fontFamily.sans,
    fontFamilyMono: fontFamily.mono,
    fontWeight: '400',
    fontWeightStrong: '600',
    fontSize: fontSize.base,
    borderRadius: radius.md,
    borderRadiusSmall: radius.sm
  }

  return {
    common: {
      ...common,
      ...(isDark ? darkCommonColors : lightCommonColors)
    },
    Button: {
      // 按钮高度偏紧凑，桌面端更合适
      heightMedium: '32px',
      heightSmall: '28px',
      borderRadiusMedium: radius.md,
      textColorPrimary: isDark ? neutralScale[900] : '#fff',
      textColorHoverPrimary: isDark ? neutralScale[900] : '#fff',
      textColorFocusPrimary: isDark ? neutralScale[900] : '#fff'
    },
    Input: {
      borderRadius: radius.md
    },
    Tag: {
      borderRadius: radius.sm,
      fontWeightStrong: '600'
    },
    Menu: {
      itemHeight: '36px',
      borderRadius: radius.md
    },
    Card: {
      borderRadius: radius.lg,
      paddingMedium: '16px 20px'
    },
    Layout: {
      color: 'transparent'
    }
  }
}

const lightCommonColors = {
  bodyColor: neutralScale[50],
  cardColor: neutralScale[0],
  modalColor: neutralScale[0],
  popoverColor: neutralScale[0],
  primaryColor: brandScale[600],
  primaryColorHover: brandScale[700],
  primaryColorPressed: brandScale[800],
  primaryColorSuppl: brandScale[500],
  textColorBase: neutralScale[900],
  textColor1: neutralScale[900],
  textColor2: neutralScale[600],
  textColor3: neutralScale[500],
  borderColor: neutralScale[200],
  dividerColor: neutralScale[200],
  successColor: intentScale.success,
  warningColor: intentScale.warning,
  errorColor: intentScale.error,
  infoColor: intentScale.info
}

const darkCommonColors = {
  bodyColor: neutralScale[950],
  cardColor: neutralScale[900],
  modalColor: neutralScale[900],
  popoverColor: neutralScale[800],
  primaryColor: brandScale[400],
  primaryColorHover: brandScale[300],
  primaryColorPressed: brandScale[200],
  primaryColorSuppl: brandScale[500],
  textColorBase: neutralScale[50],
  textColor1: neutralScale[50],
  textColor2: neutralScale[300],
  textColor3: neutralScale[400],
  borderColor: neutralScale[700],
  dividerColor: neutralScale[800],
  successColor: intentScale.success,
  warningColor: intentScale.warning,
  errorColor: intentScale.error,
  infoColor: intentScale.info
}

/** 监听系统暗色偏好 */
function usePrefersDark() {
  const prefers = ref(false)
  if (typeof window !== 'undefined' && window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    prefers.value = mq.matches
    mq.addEventListener('change', (e) => (prefers.value = e.matches))
  }
  return prefers
}
