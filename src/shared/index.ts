/**
 * 跨进程共享类型（主进程 / preload / 渲染进程共用）
 */

/** 项目元信息（持久化在 electron-store 中） */
export interface ProjectMeta {
  /** 唯一 id（基于路径哈希，同路径不重复添加） */
  id: string
  /** 显示名（默认取目录名，可改名） */
  name: string
  /** 真实文件夹绝对路径 */
  path: string
  /** 添加时间戳 */
  createdAt: number
}

/** Git 文件变更状态（语义化，已从 git 原始状态映射） */
export type FileStatus =
  | 'added' // 新增 / 已暂存的新文件
  | 'modified' // 修改
  | 'deleted' // 删除
  | 'renamed' // 重命名
  | 'untracked' // 未跟踪

export interface FileChange {
  /**
   * 仓库相对路径（git 可用的 pathspec，统一取新路径）。
   * 注意：对 rename，这里是「重命名后的新路径」，不是 `old → new` 形式，
   * 以便直接作为 `git add` / `git reset` / `git diff --` 的 pathspec。
   */
  path: string
  status: FileStatus
  /** 是否已暂存 */
  staged: boolean
  /**
   * rename 时的原路径（重命名前的旧路径）。
   * 仅 status='renamed' 时有值，供 UI 展示「old → new」形态；
   * 操作（stage/unstage/diff）一律用 `path`（新路径），不要用此字段。
   */
  renamedFrom?: string
}

/** 提交历史条目 */
export interface LogEntry {
  hash: string
  /** 短 hash */
  hashShort: string
  author: string
  /** ISO 时间字符串 */
  date: string
  message: string
  /** 是否已推送到上游（false=本地未推送） */
  pushed: boolean
}

/** 分支信息 */
export interface BranchInfo {
  current: string
  tracking: string | null
  ahead: number
  behind: number
}

/* ============================================================
 * AI 提交信息功能相关类型
 * ========================================================== */

/** AI 服务协议格式 */
export type AiProtocol = 'openai' | 'anthropic'

/** 自定义配置的 URL 模式 */
export type UrlMode = 'auto' | 'full'

/** 思考强度（DeepSeek 思考模式：low/medium 会被服务端映射为 high，故仅暴露 high/max） */
export type ThinkingEffort = 'high' | 'max'

/** 预选服务商（保留扩展位，便于后续新增） */
export type AiProviderId = 'glm' | 'deepseek' | 'custom'

/** 一条提交前缀（标签），可作为提示词注入 */
export interface CommitPrefix {
  /** 唯一 id */
  id: string
  /** 显示名 / 注入文本，如 feat / fix / TASK#12345 */
  label: string
  /** 可选描述：主面板 hover 时由 NTooltip 展示，留空则回退到默认提示 */
  description?: string
}

/** AI 服务完整配置（持久化） */
export interface AiServiceConfig {
  /** 预选服务商 or 自定义 */
  provider: AiProviderId
  /** 预选服务商：模型 id（glm-4.7-flash / deepseek-v4-flash / deepseek-v4-pro / 自填） */
  presetModel: string
  /** 预选服务商：是否自定义模型（true 则 model 为手填值） */
  presetCustomModel: boolean
  /** 自定义：协议 */
  protocol: AiProtocol
  /** 自定义：URL 模式 */
  urlMode: UrlMode
  /** 自定义：用户输入的地址（auto 模式填到 /v1，full 模式填完整） */
  baseUrl: string
  /** 自定义：模型 id */
  model: string
  /** API key（仅主进程存储） */
  apiKey: string
  /**
   * 是否启用思考模式（DeepSeek）。
   * 启用后模型会先输出一段思维链（reasoning_content）再产出最终回答，
   * 提升准确性但耗时略增。本应用只取最终 content，静默消费 reasoning。
   */
  thinking: boolean
  /** 思考强度（仅 thinking=true 时生效） */
  thinkingEffort: ThinkingEffort
}

/** 单个项目的 AI 卡片文本缓存（草稿 + 上次生成完的可编辑结果） */
export interface ProjectDraft {
  /** 生成前用户手写的要点草稿（idle 态输入） */
  draft: string
  /** 上次生成完的可编辑结果（editing 态文本；流式中间态不落盘） */
  message: string
}

/** AI 偏好（生成行为，持久化） */
export interface AiPrefs {
  /**
   * 各项目选中的前缀 id（按项目独立缓存，切换项目/重开自动恢复上次选择）。
   * key = projectId，value = prefixId 或 null（无前缀）。
   */
  selectedPrefixByProject: Record<string, string | null>
  /**
   * 各项目的 AI 卡片文本缓存（草稿 + 上次生成结果），
   * 切换项目/重开自动恢复。key = projectId。
   */
  draftByProject: Record<string, ProjectDraft>
  /** 详细模式：true 则底部生成子项列表 */
  detailed: boolean
  /** 自定义生成规则（持久化，可重置） */
  customRules: string
  /** 前缀列表（跨项目共享） */
  prefixes: CommitPrefix[]
}

/** OpenAI 风格消息（主进程 AiService 输入） */
export interface AiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/* ============================================================
 * 应用级设置（开机自启 / 最小化到托盘 / 关闭确认）
 * ========================================================== */

/** 关闭主窗口时的默认操作 */
export type CloseAction = 'quit' | 'tray'

/** 应用级设置（持久化在 electron-store 中） */
export interface AppSettings {
  /** 开机自动启动 */
  launchAtLogin: boolean
  /** 关闭主窗口时是否弹确认框（「不再提醒」的反向：true=每次都问） */
  remindOnClose: boolean
  /** 关闭主窗口时的默认操作 */
  closeAction: CloseAction
  /** 开机静默启动：自启时仅加载托盘，不弹出主窗口（需配合 launchAtLogin） */
  launchSilent: boolean
  /** 全局快捷键开关：开启后可用快捷键唤出/隐藏主窗口 */
  globalShortcutEnabled: boolean
  /** 全局快捷键（Electron accelerator 格式，如 "Alt+Shift+G"） */
  globalShortcut: string
}

/** 一条被忽略/截断的文件记录 */
export interface OmittedFile {
  /** 文件路径 */
  path: string
  /** 处理方式 */
  reason:
    | 'binary'        // 二进制文件
    | 'generated'     // 产物/锁文件
    | 'too_large'     // 单文件过大被折叠
    | 'size_limit'    // 因总量上限被整体省略
  /** 处理方式的人类可读说明 */
  note: string
}

/** 差异聚合结果（供 AI：暂存优先，否则全量） */
export interface DiffForAi {
  /** 聚合并过滤后的 diff 文本 */
  diff: string
  /** 是否因体积过大被截断 */
  truncated: boolean
  /** 被忽略/折叠/截断的文件列表（点击可查看详情） */
  omittedFiles: OmittedFile[]
  /** 来源：暂存改动 or 全量改动 */
  source: 'staged' | 'all'
}

/** push 结果（旧：仅成功时返回 remote/branch，已被 GitSyncResult 取代，保留以兼容） */
export interface PushResult {
  remote: string
  branch: string
}

/* ============================================================
 * Git 同步（push / pull）结果：结构化分类，驱动 UI 弹窗文案
 * ========================================================== */

/**
 * 同步操作的结果分类。
 * - 成功类：pushed / pulled / up_to_date / fast_forwarded
 * - 失败类（已自动回退，仓库回到操作前状态）：conflict_aborted / no_upstream / rejected / network / unknown
 */
export type GitSyncResultCode =
  | 'pushed' // 推送成功（fast-forward 或 rebase 后重试成功）
  | 'pulled' // 拉取完成（兼容别名，等同于 fast_forwarded）
  | 'up_to_date' // 拉取时已是最新，无变化
  | 'fast_forwarded' // 拉取后 rebase 成功，本地已快进
  | 'conflict_aborted' // 拉取/合并产生冲突，已自动 abort 回退
  | 'no_upstream' // 当前分支无上游（需先在终端 push -u 配置）
  | 'rejected' // push 仍被拒（rebase 后仍 non-fast-forward，罕见）
  | 'network' // 网络/认证失败
  | 'unknown' // 其它未分类错误

/** push / pull 的统一返回结构（结构化，便于 UI 按 code 分支弹窗） */
export interface GitSyncResult {
  result: GitSyncResultCode
  remote?: string
  branch?: string
  /** 失败时的友好中文文案（可直接展示给用户） */
  message?: string
}

/**
 * 供「代码审查文件选择器」用的单个改动文件信息。
 * 与 DiffAggregator 的 OmittedFile 规则同源：contentOmitted=true 表示该文件内容
 * 已被规则折叠（二进制/产物/锁），审查无意义，选择器中应禁用勾选。
 */
export interface ChangedFileInfo {
  /** 仓库相对路径 */
  path: string
  /** 文件变更状态（与 FileChange.status 语义一致） */
  status: FileStatus
  /** 是否已暂存 */
  staged: boolean
  /** 内容是否会被规则折叠（二进制/产物/锁文件） */
  contentOmitted: boolean
  /** 折叠原因（contentOmitted=true 时给出，用于选择器徽标文案） */
  omitReason?: 'binary' | 'generated'
}

/** 代码审查文件列表（供选择器构建树） */
export interface ChangedFilesForReview {
  /** 来源：暂存改动 or 全量改动（与 DiffForAi.source 同源判断） */
  source: 'staged' | 'all'
  /** 改动文件清单 */
  files: ChangedFileInfo[]
}

/**
 * 自定义窗口 resize 方向（仅 Windows 平台 transparent frameless 窗口使用）。
 *
 * 背景：transparent 窗口被 Electron 移除 WS_THICKFRAME，原生 resize 不可用，
 * 改由渲染层 8 方向热区 + 主进程 setBounds 轮询实现（见 main/ipc/windowResize.ts）。
 * 4 个直边 + 4 个角，命名取首字母组合。
 */
export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
