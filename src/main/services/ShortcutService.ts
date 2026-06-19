/**
 * 全局快捷键服务
 * --------------------------------------------------
 * - 注册系统级全局快捷键，用于唤出/隐藏主窗口（toggle）
 * - 快捷键开关与键位持久化在 AppSettings 中，设置变更时调用 refresh() 重新注册
 *
 * 单例：主进程内仅注册一份快捷键。init() 注入主窗口 getter（避免循环依赖），
 * refresh() 读取最新 AppSettings 决定注册/注销。
 *
 * toggle 行为：窗口可见且聚焦 → 隐藏到托盘；否则 restore + show + focus。
 * （与托盘点击的「显示并聚焦」逻辑保持一致，便于用户形成统一心智）
 *
 * 注意：globalShortcut 是系统级热键，即使应用未聚焦也能响应。
 * 应用退出时主进程会通过 unregisterAll() 清理（index.ts 的 will-quit）。
 */
import { globalShortcut, type BrowserWindow } from 'electron'
import { StoreService } from './StoreService'

let getWindow: (() => BrowserWindow | null) | null = null
/** 当前已注册的 accelerator 字符串，用于精确 unregister 避免误清其它注册 */
let registeredAccel: string | null = null

export const ShortcutService = {
  /**
   * 初始化：注入主窗口 getter。
   * 必须在 app.whenReady 之后、TrayService.create 之后调用。
   */
  init(getter: () => BrowserWindow | null): void {
    getWindow = getter
  },

  /**
   * 按最新 AppSettings 重新注册快捷键。
   * 先注销旧的，再按需注册新的。设置变更与启动时都会调用。
   * 注册失败（键位非法或被系统/其它应用占用）时仅 warn，不抛错——避免阻塞设置保存。
   */
  refresh(): void {
    // 先清掉旧的注册
    if (registeredAccel) {
      globalShortcut.unregister(registeredAccel)
      registeredAccel = null
    }

    if (!getWindow) return

    const { globalShortcutEnabled, globalShortcut: accel } = StoreService.getAppSettings()
    if (!globalShortcutEnabled || !accel) return

    const ok = globalShortcut.register(accel, () => {
      const win = getWindow?.()
      if (!win || win.isDestroyed()) return
      // toggle：可见且聚焦则隐藏，否则显示并聚焦
      if (win.isVisible() && win.isFocused()) {
        win.hide()
      } else {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
    })

    if (ok) {
      registeredAccel = accel
    } else {
      console.warn(`[ShortcutService] 快捷键注册失败（可能被占用或格式非法）：${accel}`)
    }
  },

  /** 注销全部本服务注册的快捷键（应用退出时调用） */
  destroy(): void {
    if (registeredAccel) {
      globalShortcut.unregister(registeredAccel)
      registeredAccel = null
    }
  }
}
