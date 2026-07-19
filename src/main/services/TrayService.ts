/**
 * 系统托盘服务
 * --------------------------------------------------
 * - 创建托盘图标 + 右键菜单（显示窗口 / 退出）
 * - 单击托盘：显示并聚焦主窗口
 *
 * 图标：优先从 build/icon.png 加载（nativeImage.createFromPath），
 * 失败时回落到内嵌 base64 PNG（兜底）。
 *
 * 退出回调：由主进程注入 `onQuit`（负责置 allowQuit=true 后退出，
 * 否则会被主窗口 'close' 拦截器转去弹关闭确认框，导致「退出」无效）。
 */
import { join } from 'path'
import { Menu, Tray, nativeImage, type BrowserWindow } from 'electron'

/**
 * 兜底托盘图标：32×32 品牌靛蓝 PNG（白色 commit-deck 竖线 + 环）。
 * 仅当 build/icon.png 加载失败时使用。
 */
const FALLBACK_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA3ElEQVRYhe2WMQ7CQAxG/4JiOQTc7VxkB7EdxMpNoBjk4jbgY0xEJ2EzcQkJiDuwS7EViwY+pg+TtNC00/2+b9e+tN0OAMrxvwbQ8z6u6/p8z/MOz/NO13WUZdm23W++/5dlWZMkiQkhBIDneY4lScI0TQiB53nSOI4JIQKgqmqa5mmCYVnWNE0AcF2XACC5EUJummaRYRj+HcdxpgmEYVkvSRLP8wSAc75tG6ZpAoDruoYQAsdxqOu6BcuyiqLIWZanGf4BKFnWnQHwJUkSZ5om13WdpimmaR4AwDTNVVW9pmn6B5AvyzIw/m8A8Dzv/pmneQB4nnc/gDAMMwyPTwAAAABJRU5ErkJggg=='

let tray: Tray | null = null

/** 构造托盘图标：优先文件，失败回落 base64。 */
function buildIcon(): Electron.NativeImage {
  try {
    const fromFile = nativeImage.createFromPath(join(__dirname, '../../build/icon.png'))
    if (!fromFile.isEmpty()) return fromFile
  } catch {
    // 文件不存在或解析失败，走兜底
  }
  return nativeImage.createFromDataURL(FALLBACK_ICON_DATA_URL)
}

export interface TrayDeps {
  /** 取主窗口的 getter（避免循环依赖） */
  getWindow: () => BrowserWindow | null
  /** 退出回调：由主进程注入，负责置 allowQuit 后真正退出 */
  onQuit: () => void
}

export const TrayService = {
  create(deps: TrayDeps): Tray {
    if (tray) return tray
    const { getWindow, onQuit } = deps
    const icon = buildIcon()
    tray = new Tray(icon)
    tray.setToolTip('CommitDeck')

    const menu = Menu.buildFromTemplate([
      {
        label: '显示窗口',
        click: () => {
          const win = getWindow()
          if (!win) return
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          // 必须经 onQuit 置 allowQuit=true，否则会触发 'close' 拦截 → 弹确认框，退出被吞
          onQuit()
        }
      }
    ])
    tray.setContextMenu(menu)

    // 单击托盘：显示并聚焦
    tray.on('click', () => {
      const win = getWindow()
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })

    return tray
  },

  destroy(): void {
    tray?.destroy()
    tray = null
  }
}
