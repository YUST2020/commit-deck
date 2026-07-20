/**
 * preload：通过 contextBridge 暴露受限的 window.api
 * 只暴露具名方法，不暴露 ipcRenderer。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type {
  AiMessage,
  AiPrefs,
  AiServiceConfig,
  AppSettings,
  BranchInfo,
  ChangedFilesForReview,
  DiffForAi,
  FileChange,
  GitSyncResult,
  LogEntry,
  ProjectMeta,
  ResizeDir
} from '@shared/index'

/** 统一的可序列化结果类型 */
type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }
type GResult<T> = { ok: true; data: T } | { ok: false; error: { message: string } }

const api = {
  // ---------- 项目 ----------
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('project:pickDirectory'),
  listProjects: (): Promise<ProjectMeta[]> => ipcRenderer.invoke('project:list'),
  addProject: (path: string): Promise<Result<ProjectMeta>> =>
    ipcRenderer.invoke('project:add', path),
  removeProject: (id: string): Promise<Result<null>> =>
    ipcRenderer.invoke('project:remove', id),
  renameProject: (id: string, name: string): Promise<Result<ProjectMeta>> =>
    ipcRenderer.invoke('project:rename', id, name),
  validateProject: (id: string): Promise<{ ok: boolean; isRepo: boolean }> =>
    ipcRenderer.invoke('project:validate', id),

  // ---------- Git ----------
  checkRepo: (repoPath: string): Promise<boolean> =>
    ipcRenderer.invoke('git:checkRepo', repoPath),
  gitStatus: (repoPath: string): Promise<GResult<FileChange[]>> =>
    ipcRenderer.invoke('git:status', repoPath),
  gitLog: (repoPath: string, maxCount?: number): Promise<GResult<LogEntry[]>> =>
    ipcRenderer.invoke('git:log', repoPath, maxCount),
  gitBranch: (repoPath: string): Promise<GResult<BranchInfo | null>> =>
    ipcRenderer.invoke('git:branch', repoPath),
  gitFetch: (repoPath: string): Promise<GResult<null>> =>
    ipcRenderer.invoke('git:fetch', repoPath),
  gitDiffFile: (repoPath: string, file: string, staged: boolean): Promise<GResult<string>> =>
    ipcRenderer.invoke('git:diffFile', repoPath, file, staged),
  gitDiffStaged: (repoPath: string): Promise<GResult<string>> =>
    ipcRenderer.invoke('git:diffStaged', repoPath),
  gitAdd: (repoPath: string, files: string[]): Promise<GResult<null>> =>
    ipcRenderer.invoke('git:add', repoPath, files),
  gitReset: (repoPath: string, files: string[]): Promise<GResult<null>> =>
    ipcRenderer.invoke('git:reset', repoPath, files),
  gitCommit: (repoPath: string, message: string): Promise<GResult<string>> =>
    ipcRenderer.invoke('git:commit', repoPath, message),
  gitPush: (repoPath: string): Promise<GResult<GitSyncResult>> =>
    ipcRenderer.invoke('git:push', repoPath),
  // 拉取远端（git pull --rebase）；冲突时主进程自动 abort 回退
  gitPull: (repoPath: string): Promise<GResult<GitSyncResult>> =>
    ipcRenderer.invoke('git:pull', repoPath),
  // 撤回最近 N 个未推送的提交（soft reset，改动保留到暂存区）
  gitUndoCommit: (repoPath: string, count: number): Promise<GResult<null>> =>
    ipcRenderer.invoke('git:undoCommit', repoPath, count),
  // 差异聚合（供 AI：暂存优先，否则全量；含大文件保护；model 用于按上下文长度动态推算总量上限）
  // forceIncludePaths：用户指定「强制包含」的文件路径，优先占用配额、尽量发全文（二进制/产物除外）
  // onlyPaths：代码审查文件选择器选中的路径白名单（仅保留这些文件的 diff；为空=不过滤）
  gitDiffForAi: (repoPath: string, model?: string, forceIncludePaths?: string[], onlyPaths?: string[]): Promise<GResult<DiffForAi>> =>
    ipcRenderer.invoke('git:diffForAi', repoPath, model, forceIncludePaths, onlyPaths),
  // 代码审查文件选择器取数：列出可审查的改动文件（含 contentOmitted 标记，用于禁用二进制/产物勾选）
  gitChangedFiles: (repoPath: string): Promise<GResult<ChangedFilesForReview>> =>
    ipcRenderer.invoke('git:changedFiles', repoPath),

  // ---------- AI 生成（流式） ----------
  // task：复用同一流式传输通道承载多种任务（默认 'commit'；'review' 走独立事件通道）
  aiGenerate: (input: {
    repoPath: string
    config: AiServiceConfig
    messages: AiMessage[]
    task?: 'commit' | 'review'
  }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('ai:generate', input),
  aiAbort: (): Promise<void> => ipcRenderer.invoke('ai:abort'),
  // 订阅流事件：返回取消订阅函数
  onAiChunk: (cb: (delta: string) => void): (() => void) => {
    const listener = (_e: unknown, delta: string): void => cb(delta)
    ipcRenderer.on('ai:chunk', listener)
    return () => ipcRenderer.removeListener('ai:chunk', listener)
  },
  onAiDone: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('ai:done', listener)
    return () => ipcRenderer.removeListener('ai:done', listener)
  },
  onAiError: (cb: (err: { message: string }) => void): (() => void) => {
    const listener = (_e: unknown, err: { message: string }): void => cb(err)
    ipcRenderer.on('ai:error', listener)
    return () => ipcRenderer.removeListener('ai:error', listener)
  },
  // 代码审查专用流事件（与 commit 流解耦，互不污染）
  onAiReviewChunk: (cb: (delta: string) => void): (() => void) => {
    const listener = (_e: unknown, delta: string): void => cb(delta)
    ipcRenderer.on('ai:review:chunk', listener)
    return () => ipcRenderer.removeListener('ai:review:chunk', listener)
  },
  onAiReviewDone: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('ai:review:done', listener)
    return () => ipcRenderer.removeListener('ai:review:done', listener)
  },
  onAiReviewError: (cb: (err: { message: string }) => void): (() => void) => {
    const listener = (_e: unknown, err: { message: string }): void => cb(err)
    ipcRenderer.on('ai:review:error', listener)
    return () => ipcRenderer.removeListener('ai:review:error', listener)
  },

  // ---------- AI 配置 / 偏好（持久化） ----------
  getAiService: (): Promise<AiServiceConfig> => ipcRenderer.invoke('ai:getService'),
  setAiService: (cfg: AiServiceConfig): Promise<void> =>
    ipcRenderer.invoke('ai:setService', cfg),
  getAiPrefs: (): Promise<AiPrefs> => ipcRenderer.invoke('ai:getPrefs'),
  setAiPrefs: (prefs: AiPrefs): Promise<void> =>
    ipcRenderer.invoke('ai:setPrefs', prefs),
  resetAiRules: (): Promise<string> => ipcRenderer.invoke('ai:resetRules'),
  // 连通性测试：用当前配置发最小请求验证可达性（无需先保存配置）
  testAiConnection: (config: AiServiceConfig): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('ai:test', config),

  // ---------- 偏好（UI 偏好持久化） ----------
  getSiderCollapsed: (): Promise<boolean> =>
    ipcRenderer.invoke('config:getSiderCollapsed'),
  setSiderCollapsed: (collapsed: boolean): Promise<void> =>
    ipcRenderer.invoke('config:setSiderCollapsed', collapsed),

  // ---------- 应用级设置（开机自启 / 最小化到托盘 / 关闭确认） ----------
  getAppSettings: (): Promise<AppSettings> => ipcRenderer.invoke('app:getSettings'),
  setAppSettings: (settings: AppSettings): Promise<AppSettings> =>
    ipcRenderer.invoke('app:setSettings', settings),
  getLaunchAtLogin: (): Promise<boolean> => ipcRenderer.invoke('app:getLaunchAtLogin'),

  // ---------- 窗口控件（自定义标题栏） ----------
  windowMinimize: (): void => ipcRenderer.send('window:minimize'),
  // 触发窗口关闭：经主进程 'close' 拦截器走「关闭确认」决策流程
  // （allowQuit=false 时会转 onRequestClose，由渲染层弹框决定隐藏/退出）
  windowClose: (): void => ipcRenderer.send('window:close'),
  // 直接隐藏到托盘（关闭确认选「最小化到托盘」时调用）
  windowHideToTray: (): void => ipcRenderer.send('window:hideToTray'),
  // 真正退出应用（关闭确认选「退出」/ 托盘「退出」时调用）
  windowQuit: (): void => ipcRenderer.send('window:quit'),
  // ---------- 自定义窗口 resize（仅 Windows） ----------
  // 透明无边框窗口无原生 WS_THICKFRAME，由渲染层 8 方向热区触发，
  // 主进程轮询 cursor + setBounds 完成实际缩放。
  windowResizeStart: (dir: ResizeDir): Promise<void> =>
    ipcRenderer.invoke('window:resize:start', dir),
  windowResizeEnd: (): Promise<void> => ipcRenderer.invoke('window:resize:end'),
  // 平台标识（渲染层沙箱拿不到 process.platform，由 preload 暴露）
  // 用于判断是否渲染 Windows 专属的 resize 热区
  platform: process.platform,
  // 订阅主进程的「关闭决策请求」（自定义关闭按钮 / Alt+F4 触发）：
  // 收到后由渲染层弹确认框，再决定隐藏到托盘还是退出。
  onRequestClose: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('window:requestClose', listener)
    return () => ipcRenderer.removeListener('window:requestClose', listener)
  }
}

export type Api = typeof api

try {
  contextBridge.exposeInMainWorld('api', api)
} catch (e) {
  console.error('[preload] exposeInMainWorld failed:', e)
}
