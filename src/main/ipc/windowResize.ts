/**
 * 自定义窗口 resize IPC（仅 Windows）。
 * —— transparent frameless 窗口被 Electron 移除 WS_THICKFRAME，原生 resize 不可用，
 *    改由渲染层 8 方向热区 mousedown 触发 → 主进程轮询 cursor + setBounds 实现。
 *
 * 设计要点：
 * 1. 主进程自己轮询 `screen.getCursorScreenPoint()`，不依赖渲染层 mousemove。
 *    mouse 越过 .app-root 进入透明边带/桌面外后，渲染层会丢失 mousemove，
 *    只有系统级 cursor 坐标全程可靠。
 * 2. 主进程无 requestAnimationFrame，用 setInterval(16ms) ≈ 60fps。
 * 3. getBounds/getCursorScreenPoint/setBounds 在 Windows 上均返回 DIP，单位一致，
 *    直接相减无需手动乘 DPI 缩放。
 * 4. minSize clamp 后必须回算 x/y（左/上边拖动时把被 clamp 掉的尺寸补回左/上坐标），
 *    否则窗口会被"挤"向负方向。
 * 5. 全程不监听 will-resize，避免 electron#33897（will-resize 内调 setBounds 行为异常）。
 */
import { BrowserWindow, ipcMain, screen } from 'electron'
import type { Rectangle } from 'electron'
import type { ResizeDir } from '@shared/index'

/** 合法方向枚举（用于入参校验） */
const VALID_DIRS: readonly ResizeDir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

/** 兜底最小尺寸（与 index.ts 的 minWidth/minHeight 保持一致；getMinimumSize 返回空数组时使用） */
const FALLBACK_MIN_W = 960
const FALLBACK_MIN_H = 640

/** 轮询间隔（≈60fps；主进程无 rAF） */
const POLL_INTERVAL_MS = 16

/** 一次进行中的 resize 会话（resizeDir !== null 表示进行中） */
interface ResizeSession {
  dir: ResizeDir
  startBounds: Rectangle
  startCursor: { x: number; y: number }
  minW: number
  minH: number
  timer: NodeJS.Timeout
}

let session: ResizeSession | null = null

/**
 * 按 resize 方向 + 当前 cursor 增量，计算新的窗口 bounds。
 * 左/上边拖动：边坐标随 cursor 移，宽/高反向变化；右/下边拖动：宽/高随 cursor 增。
 */
function computeBounds(s: ResizeSession, cursor: { x: number; y: number }): Rectangle {
  const dx = cursor.x - s.startCursor.x
  const dy = cursor.y - s.startCursor.y
  const { x: sx, y: sy, width: sw, height: sh } = s.startBounds

  let x = sx
  let y = sy
  let w = sw
  let h = sh

  if (s.dir.includes('e')) {
    w = sw + dx
  }
  if (s.dir.includes('s')) {
    h = sh + dy
  }
  // 西/北边拖动：先按 cursor 移边坐标，宽/高随之反向变化
  if (s.dir.includes('w')) {
    x = sx + dx
    w = sw - dx
  }
  if (s.dir.includes('n')) {
    y = sy + dy
    h = sh - dy
  }

  // clamp 宽度：左/西边拖动时被 clamp 掉的部分要补回 x，否则窗口被向左挤
  if (w < s.minW) {
    if (s.dir.includes('w')) x = sx + (sw - s.minW)
    w = s.minW
  }
  // clamp 高度：北边同理
  if (h < s.minH) {
    if (s.dir.includes('n')) y = sy + (sh - s.minH)
    h = s.minH
  }

  return { x, y, width: w, height: h }
}

/** 单帧轮询：取系统 cursor → 算新 bounds → setBounds */
function tick(win: BrowserWindow, s: ResizeSession): void {
  if (win.isDestroyed()) {
    stopResize()
    return
  }
  const cursor = screen.getCursorScreenPoint()
  const next = computeBounds(s, cursor)
  win.setBounds(next, false)
}

/** 结束当前 resize 会话（清理 timer + 清状态） */
function stopResize(): void {
  if (!session) return
  clearInterval(session.timer)
  session = null
}

/**
 * 注册窗口 resize IPC。
 * 仅 Windows 注册；其他平台 transparent 窗口原生 resize 可用，无需此机制。
 */
export function registerWindowResizeIpc(
  getMainWindow: () => BrowserWindow | null
): void {
  if (process.platform !== 'win32') return

  ipcMain.handle('window:resize:start', (e, dir: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? getMainWindow()
    if (!win || win.isDestroyed()) return

    if (!isResizeDir(dir)) {
      throw new Error(`非法的 resize 方向: ${String(dir)}`)
    }

    // 重入保护：上一次未结束先清理（理论上不会发生，渲染层 mousedown 期间不会再触发）
    if (session) stopResize()

    const minSize = win.getMinimumSize()
    const minW = minSize[0] > 0 ? minSize[0] : FALLBACK_MIN_W
    const minH = minSize[1] > 0 ? minSize[1] : FALLBACK_MIN_H

    const startBounds = win.getBounds()
    const startCursor = screen.getCursorScreenPoint()

    const s: ResizeSession = {
      dir,
      startBounds,
      startCursor,
      minW,
      minH,
      // 先占位，下一行回填 timer
      timer: undefined as unknown as NodeJS.Timeout
    }
    s.timer = setInterval(() => tick(win, s), POLL_INTERVAL_MS)
    session = s

    // 窗口关闭兜底清理（防泄漏）
    win.once('closed', stopResize)
  })

  ipcMain.handle('window:resize:end', () => {
    stopResize()
  })
}

/** 入参类型守卫（unknown → ResizeDir） */
function isResizeDir(v: unknown): v is ResizeDir {
  return typeof v === 'string' && (VALID_DIRS as readonly string[]).includes(v)
}
