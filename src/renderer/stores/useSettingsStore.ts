/**
 * 应用级设置 store
 * --------------------------------------------------
 * 管理：开机自启 / 最小化到托盘 / 关闭确认。
 *
 * 关闭决策流程（handleClose）：
 *   主进程触发 onRequestClose → 读取 settings：
 *     - remindOnClose=false → 直接执行 closeAction（隐藏到托盘 / 退出）
 *     - remindOnClose=true  → 打开关闭确认弹窗（由 App.vue 监听 openConfirm 触发）
 *
 * IPC 传参一律转纯对象（AGENTS.md 共性 Bug：响应式 Proxy 无法 structured clone）。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AppSettings, CloseAction } from '@shared/index'

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings | null>(null)
  /** 关闭确认弹窗是否打开（App.vue 挂载的 CloseConfirmDialog 监听此值） */
  const confirmOpen = ref(false)

  /** 初始化：启动时从持久层加载 */
  async function init(): Promise<void> {
    settings.value = await window.api.getAppSettings()
  }

  /** 内部：写回持久层（转纯对象避免 IPC clone 失败） */
  async function persist(next: AppSettings): Promise<void> {
    settings.value = next
    await window.api.setAppSettings(JSON.parse(JSON.stringify(next)) as AppSettings)
  }

  /** 开机自动启动开关。关闭自启时联动关闭静默启动（无自启则静默无意义） */
  async function setLaunchAtLogin(v: boolean): Promise<void> {
    if (!settings.value) return
    await persist({
      ...settings.value,
      launchAtLogin: v,
      // 关闭自启 → 静默启动失去前提，一并关闭
      launchSilent: v ? settings.value.launchSilent : false
    })
  }

  /** 关闭主窗口时的默认操作 */
  async function setCloseAction(action: CloseAction): Promise<void> {
    if (!settings.value) return
    await persist({ ...settings.value, closeAction: action })
  }

  /** 关闭时是否提醒（关闭确认框「不再提醒」勾选的反向） */
  async function setRemindOnClose(v: boolean): Promise<void> {
    if (!settings.value) return
    await persist({ ...settings.value, remindOnClose: v })
  }

  /**
   * 开机静默启动开关。开启静默时联动开启自启（静默的前提是开机启动）。
   * 关闭静默不影响自启状态。
   */
  async function setLaunchSilent(v: boolean): Promise<void> {
    if (!settings.value) return
    await persist({
      ...settings.value,
      launchSilent: v,
      launchAtLogin: v ? true : settings.value.launchAtLogin
    })
  }

  /** 全局快捷键开关 */
  async function setGlobalShortcutEnabled(v: boolean): Promise<void> {
    if (!settings.value) return
    await persist({ ...settings.value, globalShortcutEnabled: v })
  }

  /** 全局快捷键键位（Electron accelerator 字符串，如 "Alt+Shift+G"） */
  async function setGlobalShortcut(accel: string): Promise<void> {
    if (!settings.value) return
    await persist({ ...settings.value, globalShortcut: accel })
  }

  /**
   * 关闭确认框「不再提醒 + 记住选择」：把 remindOnClose 置 false，并保存所选 action。
   * 同时立即按该 action 执行关闭。
   */
  async function setRememberedAndClose(action: CloseAction): Promise<void> {
    if (settings.value) {
      await persist({ ...settings.value, remindOnClose: false, closeAction: action })
    }
    executeClose(action)
  }

  /** 直接按 action 隐藏到托盘 / 退出，不修改设置 */
  function executeClose(action: CloseAction): void {
    if (action === 'tray') {
      window.api.windowHideToTray()
    } else {
      window.api.windowQuit()
    }
  }

  /**
   * 关闭决策入口（App.vue 收到 onRequestClose 时调用）。
   * - 已选「不再提醒」→ 直接执行默认操作
   * - 否则 → 打开确认弹窗（由用户当场选择）
   */
  function handleClose(): void {
    const s = settings.value
    if (!s) {
      // 设置尚未加载，兜底退出
      window.api.windowQuit()
      return
    }
    if (!s.remindOnClose) {
      executeClose(s.closeAction)
    } else {
      confirmOpen.value = true
    }
  }

  return {
    settings,
    confirmOpen,
    init,
    setLaunchAtLogin,
    setCloseAction,
    setRemindOnClose,
    setLaunchSilent,
    setGlobalShortcutEnabled,
    setGlobalShortcut,
    setRememberedAndClose,
    executeClose,
    handleClose
  }
})
