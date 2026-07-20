/**
 * 渲染进程全局类型声明
 * window.api 由 preload 通过 contextBridge 注入。
 * 此处仅做类型声明，使渲染进程可访问 window.api.*。
 *
 * Api 类型来自 preload，为避免循环依赖，这里用结构性声明（与 preload 导出保持一致）。
 */
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

type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }
type GResult<T> = { ok: true; data: T } | { ok: false; error: { message: string } }

export interface AppApi {
  // 项目
  pickDirectory: () => Promise<string | null>
  listProjects: () => Promise<ProjectMeta[]>
  addProject: (path: string) => Promise<Result<ProjectMeta>>
  removeProject: (id: string) => Promise<Result<null>>
  renameProject: (id: string, name: string) => Promise<Result<ProjectMeta>>
  validateProject: (id: string) => Promise<{ ok: boolean; isRepo: boolean }>
  // Git
  checkRepo: (repoPath: string) => Promise<boolean>
  gitStatus: (repoPath: string) => Promise<GResult<FileChange[]>>
  gitLog: (repoPath: string, maxCount?: number) => Promise<GResult<LogEntry[]>>
  gitBranch: (repoPath: string) => Promise<GResult<BranchInfo | null>>
  gitFetch: (repoPath: string) => Promise<GResult<null>>
  gitDiffFile: (repoPath: string, file: string | string[], staged: boolean) => Promise<GResult<string>>
  gitDiffStaged: (repoPath: string) => Promise<GResult<string>>
  gitAdd: (repoPath: string, files: string[]) => Promise<GResult<null>>
  gitReset: (repoPath: string, files: string[]) => Promise<GResult<null>>
  gitCommit: (repoPath: string, message: string) => Promise<GResult<string>>
  gitPush: (repoPath: string) => Promise<GResult<GitSyncResult>>
  // 拉取远端（git pull --rebase）；冲突时主进程自动 abort 回退
  gitPull: (repoPath: string) => Promise<GResult<GitSyncResult>>
  gitUndoCommit: (repoPath: string, count: number) => Promise<GResult<null>>
  // 差异聚合（供 AI：暂存优先，否则全量；含大文件保护；model 用于按上下文长度动态推算总量上限）
  // forceIncludePaths：用户指定「强制包含」的文件路径，优先占用配额、尽量发全文（二进制/产物除外）
  // onlyPaths：代码审查文件选择器选中的路径白名单（仅保留这些文件的 diff；为空=不过滤）
  gitDiffForAi: (repoPath: string, model?: string, forceIncludePaths?: string[], onlyPaths?: string[]) => Promise<GResult<DiffForAi>>
  // 代码审查文件选择器取数：列出可审查的改动文件（含 contentOmitted 标记）
  gitChangedFiles: (repoPath: string) => Promise<GResult<ChangedFilesForReview>>
  // AI 生成（流式）
  // task：复用同一流式传输通道承载多种任务（默认 'commit'；'review' 走独立事件通道）
  aiGenerate: (input: {
    repoPath: string
    config: AiServiceConfig
    messages: AiMessage[]
    task?: 'commit' | 'review'
  }) => Promise<{ ok: boolean; error?: string }>
  aiAbort: () => Promise<void>
  onAiChunk: (cb: (delta: string) => void) => () => void
  onAiDone: (cb: () => void) => () => void
  onAiError: (cb: (err: { message: string }) => void) => () => void
  // 代码审查专用流事件（与 commit 流解耦，互不污染）
  onAiReviewChunk: (cb: (delta: string) => void) => () => void
  onAiReviewDone: (cb: () => void) => () => void
  onAiReviewError: (cb: (err: { message: string }) => void) => () => void
  // AI 配置 / 偏好（持久化）
  getAiService: () => Promise<AiServiceConfig>
  setAiService: (cfg: AiServiceConfig) => Promise<void>
  getAiPrefs: () => Promise<AiPrefs>
  setAiPrefs: (prefs: AiPrefs) => Promise<void>
  resetAiRules: () => Promise<string>
  // 连通性测试：用当前配置发最小请求验证可达性（无需先保存配置）
  testAiConnection: (config: AiServiceConfig) => Promise<{ ok: boolean; error?: string }>
  // 偏好（UI 偏好持久化）
  getSiderCollapsed: () => Promise<boolean>
  setSiderCollapsed: (collapsed: boolean) => Promise<void>
  // 应用级设置（开机自启 / 最小化到托盘 / 关闭确认）
  getAppSettings: () => Promise<AppSettings>
  setAppSettings: (settings: AppSettings) => Promise<AppSettings>
  getLaunchAtLogin: () => Promise<boolean>
  // 窗口控件（自定义标题栏）
  windowMinimize: () => void
  // 触发原生 close（走主进程 'close' 拦截 → 关闭确认决策流程）
  windowClose: () => void
  // 直接隐藏到托盘
  windowHideToTray: () => void
  // 真正退出应用
  windowQuit: () => void
  // 自定义窗口 resize（仅 Windows）：透明无边框窗口无原生 WS_THICKFRAME，
  // 由渲染层 8 方向热区触发，主进程轮询 cursor + setBounds 完成缩放
  windowResizeStart: (dir: ResizeDir) => Promise<void>
  windowResizeEnd: () => Promise<void>
  // 平台标识（渲染层沙箱拿不到 process.platform）
  platform: string
  // 订阅主进程的「关闭决策请求」（自定义关闭按钮 / Alt+F4 触发）；返回取消订阅
  onRequestClose: (cb: () => void) => () => void
}

declare global {
  interface Window {
    api: AppApi
  }
}
