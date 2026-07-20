import { join } from 'path'
import { app, BrowserWindow, shell, ipcMain } from 'electron'
import { registerProjectIpc } from './ipc/project'
import { registerGitIpc } from './ipc/git'
import { registerConfigIpc } from './ipc/config'
import { registerAiIpc } from './ipc/ai'
import { registerWindowResizeIpc } from './ipc/windowResize'
import { StoreService } from './services/StoreService'
import { TrayService } from './services/TrayService'
import { ShortcutService } from './services/ShortcutService'

// 主窗口引用（模块内私有）
let mainWindow: BrowserWindow | null = null
/**
 * 放行标志位：托盘「退出」/ window:quit 时置 true，
 * 使 'close' 拦截器跳过「询问渲染层」流程，真正退出。
 */
let allowQuit = false

/**
 * 静默启动标志：当由开机自启（带 --hidden 参数）唤起时，仅加载托盘，不弹出主窗口。
 * setLoginItemSettings 的 args 会注入该参数；此处从命令行读取。
 */
const startSilent = process.argv.includes('--hidden')

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    // 移除系统默认标题栏（含最小化/关闭按钮），改由渲染进程自定义控件
    frame: false,
    title: 'CommitDesk',
    // 透明窗口：让渲染层外圆角以外的区域透明露出桌面。
    // 注意：transparent 窗口不能设置 backgroundColor，故移除。
    transparent: true,
    // 保留系统阴影（Windows 下透明窗口仍可有原生投影），增强浮起感
    hasShadow: true,
    // Windows 任务栏 / 标题栏图标：显式指定，避免显示默认 Electron 图标
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    // 静默启动（仅托盘）时不弹出窗口；用户可经托盘点击 / 全局快捷键唤出
    if (!startSilent) mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 支持 F12 打开控制台
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      mainWindow?.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  // 关闭拦截：自定义关闭按钮、Alt+F4 都会触发。
  // allowQuit=false 时阻止默认关闭，转而通知渲染层走「关闭确认」决策流程；
  // 渲染层最终会调 window:hideToTray（隐藏）或 window:quit（置 allowQuit 后退出）。
  // allowQuit=true 时放行，真正退出应用。
  mainWindow.on('close', (event) => {
    if (!allowQuit && mainWindow && !mainWindow.isDestroyed()) {
      event.preventDefault()
      mainWindow.webContents.send('window:requestClose')
    }
  })

  // 开发环境加载 dev server，生产环境加载打包文件
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerProjectIpc()
  registerGitIpc()
  registerConfigIpc()
  registerAiIpc()
  registerWindowIpc()
  // Windows 自定义 resize IPC（透明无边框窗口无原生 WS_THICKFRAME，需手动热区+setBounds）
  registerWindowResizeIpc(() => mainWindow)
  createWindow()
  // 创建系统托盘（getter 注入主窗口引用，避免耦合窗口生命周期）。
  // onQuit：托盘「退出」必须先置 allowQuit=true 再 quit，否则会触发
  // 主窗口 'close' 拦截器 → 转去弹关闭确认框，导致「退出」被吞掉。
  TrayService.create({
    getWindow: () => mainWindow,
    onQuit: () => {
      allowQuit = true
      app.quit()
    }
  })

  // 启动时按持久化设置同步系统登录项（保持开机自启状态与设置一致）
  syncLoginItem()

  // 初始化全局快捷键：注入主窗口 getter 后立即注册一次
  ShortcutService.init(() => mainWindow)
  ShortcutService.refresh()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 应用退出前清理全局快捷键，避免热键残留（globalShortcut 进程退出本会自动注销，显式清理更稳妥）
app.on('will-quit', () => {
  ShortcutService.destroy()
})

/**
 * 窗口控件 IPC：渲染进程自定义标题栏调用。
 * 入参校验发件人，避免任意 webContents 触发。
 */
function registerWindowIpc(): void {
  ipcMain.on('window:minimize', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize()
  })

  // 自定义关闭按钮：触发原生 close（走 'close' 拦截器 → 关闭确认流程）
  ipcMain.on('window:close', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
  })

  // 隐藏到托盘（不退出进程）
  ipcMain.on('window:hideToTray', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) win.hide()
  })

  // 真正退出应用：置 allowQuit 后再 close，放行 'close' 拦截器
  ipcMain.on('window:quit', (e) => {
    allowQuit = true
    BrowserWindow.fromWebContents(e.sender)?.close()
  })
}

/**
 * 按持久化的 launchAtLogin / launchSilent 设置同步系统登录项。
 * 在应用启动与设置变更时调用。
 *
 * launchSilent=true 时，自启命令追加 --hidden 参数；启动时 index.ts 检测该参数
 * 跳过窗口显示，实现「仅加载托盘」的静默启动。
 */
export function syncLoginItem(): void {
  const { launchAtLogin, launchSilent } = StoreService.getAppSettings()
  app.setLoginItemSettings({
    openAtLogin: launchAtLogin,
    args: launchSilent ? ['--hidden'] : []
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
