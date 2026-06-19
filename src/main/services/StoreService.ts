/**
 * 持久化服务（基于 electron-store）
 * 负责项目列表、AI 配置、AI 偏好、UI 偏好的读写。
 */
import Store from 'electron-store'
import type {
  AiPrefs,
  AiServiceConfig,
  AppSettings,
  CloseAction,
  CommitPrefix,
  ProjectDraft,
  ProjectMeta
} from '@shared/index'

/** 默认生成规则（Conventional Commits 中文 + 详细模式约束） */
export const DEFAULT_AI_RULES = `你是一名资深的 Git 提交信息撰写专家。请根据提供的代码差异（diff），生成一条简洁、准确的 commit message。

规则：
1. 遵循 Conventional Commits 规范，格式为：<type>(<scope>): <subject>。
2. type 从以下选取：feat / fix / docs / style / refactor / perf / test / build / ci / chore / revert。
3. subject 用中文，简明描述本次改动的目的（做了什么 / 为什么），不超过 50 字，句末不加句号。
4. scope 可选，表示改动范围（模块/组件名）；不确定时可省略。
5. 优先总结改动意图，不要逐行复述 diff。
6. 直接输出最终 commit message，不要任何解释、前言、代码块标记或多余空行。`

/** 预设前缀：默认无（用户按需自建，如 feat / TASK#12345） */
export const DEFAULT_PREFIXES: CommitPrefix[] = []

export interface AppConfig {
  projects: ProjectMeta[]
  aiService: AiServiceConfig
  aiPrefs: AiPrefs
  siderCollapsed: boolean
  appSettings: AppSettings
}

/** AI 服务默认配置：预选 glm（OpenAI 兼容格式） */
const DEFAULT_AI_SERVICE: AiServiceConfig = {
  provider: 'glm',
  presetModel: 'glm-4.7-flash',
  presetCustomModel: false,
  protocol: 'openai',
  urlMode: 'auto',
  baseUrl: '',
  model: '',
  apiKey: '',
  thinking: false,
  thinkingEffort: 'high'
}

/**
 * 规范化 AI 服务配置：兼容旧版本持久化数据（缺 thinking / thinkingEffort 字段）。
 * 思考强度仅接受合法值，非法值回落到默认 'high'。
 */
function normalizeAiService(raw: Partial<AiServiceConfig> | undefined): AiServiceConfig {
  const r = (raw ?? {}) as Partial<AiServiceConfig>
  const validEffort: AiServiceConfig['thinkingEffort'][] = ['high', 'max']
  return {
    ...DEFAULT_AI_SERVICE,
    ...r,
    thinking: typeof r.thinking === 'boolean' ? r.thinking : DEFAULT_AI_SERVICE.thinking,
    thinkingEffort: r.thinkingEffort && validEffort.includes(r.thinkingEffort)
      ? r.thinkingEffort
      : DEFAULT_AI_SERVICE.thinkingEffort
  }
}

/** AI 偏好默认值 */
const DEFAULT_AI_PREFS: AiPrefs = {
  selectedPrefixByProject: {},
  draftByProject: {},
  detailed: false,
  customRules: DEFAULT_AI_RULES,
  prefixes: DEFAULT_PREFIXES
}

/**
 * 规范化 AI 偏好：兼容旧版本（曾用 selectedPrefixId 全局字段）。
 * 缺字段补默认值，保证返回结构完整、避免下游 undefined。
 */
function normalizePrefs(raw: Partial<AiPrefs> | undefined): AiPrefs {
  const r = raw ?? {}
  // 旧版单字段迁移到按项目 map（无法归到具体项目，作为全局默认丢弃即可）
  const hasMap = Object.prototype.hasOwnProperty.call(r, 'selectedPrefixByProject')
  const oldSingle = (r as { selectedPrefixId?: string | null }).selectedPrefixId
  // draftByProject：逐项校验结构，非法值回落为空缓存，避免脏数据导致渲染异常
  const rawDrafts = (r.draftByProject ?? {}) as Record<string, unknown>
  const draftByProject: Record<string, ProjectDraft> = {}
  for (const [k, v] of Object.entries(rawDrafts)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const d = v as Partial<ProjectDraft>
      draftByProject[k] = {
        draft: typeof d.draft === 'string' ? d.draft : '',
        message: typeof d.message === 'string' ? d.message : ''
      }
    }
  }
  return {
    selectedPrefixByProject: hasMap
      ? (r.selectedPrefixByProject as Record<string, string | null>) ?? {}
      : {},
    draftByProject,
    detailed: typeof r.detailed === 'boolean' ? r.detailed : DEFAULT_AI_PREFS.detailed,
    customRules: typeof r.customRules === 'string' ? r.customRules : DEFAULT_AI_PREFS.customRules,
    prefixes: Array.isArray(r.prefixes) ? (r.prefixes as CommitPrefix[]) : []
  }
  // oldSingle 仅用于迁移提示，不强行归属项目
  void oldSingle
}

/** 应用级设置默认值：默认最小化到托盘，关闭时每次询问，全局快捷键默认开启 */
const DEFAULT_APP_SETTINGS: AppSettings = {
  launchAtLogin: false,
  remindOnClose: true,
  closeAction: 'tray',
  launchSilent: false,
  globalShortcutEnabled: true,
  globalShortcut: 'Alt+Shift+G'
}

const DEFAULTS: AppConfig = {
  projects: [],
  aiService: DEFAULT_AI_SERVICE,
  aiPrefs: DEFAULT_AI_PREFS,
  siderCollapsed: false,
  appSettings: DEFAULT_APP_SETTINGS
}

/**
 * 规范化应用级设置：兼容旧版本持久化数据（缺字段补默认）。
 * closeAction 仅接受合法值，非法值回落到默认 'tray'。
 * globalShortcut 仅接受非空字符串，否则回落默认键。
 */
function normalizeAppSettings(raw: Partial<AppSettings> | undefined): AppSettings {
  const r = (raw ?? {}) as Partial<AppSettings>
  const validActions: CloseAction[] = ['quit', 'tray']
  return {
    launchAtLogin:
      typeof r.launchAtLogin === 'boolean' ? r.launchAtLogin : DEFAULT_APP_SETTINGS.launchAtLogin,
    remindOnClose:
      typeof r.remindOnClose === 'boolean'
        ? r.remindOnClose
        : DEFAULT_APP_SETTINGS.remindOnClose,
    closeAction:
      r.closeAction && validActions.includes(r.closeAction)
        ? r.closeAction
        : DEFAULT_APP_SETTINGS.closeAction,
    launchSilent:
      typeof r.launchSilent === 'boolean' ? r.launchSilent : DEFAULT_APP_SETTINGS.launchSilent,
    globalShortcutEnabled:
      typeof r.globalShortcutEnabled === 'boolean'
        ? r.globalShortcutEnabled
        : DEFAULT_APP_SETTINGS.globalShortcutEnabled,
    globalShortcut:
      typeof r.globalShortcut === 'string' && r.globalShortcut.trim()
        ? r.globalShortcut
        : DEFAULT_APP_SETTINGS.globalShortcut
  }
}

// electron-store v8 为 CJS，此处用 default 导出
const store = new Store<AppConfig>({
  name: 'config',
  defaults: DEFAULTS,
  clearInvalidConfig: true
})

/** 生成新前缀 id */
export function genPrefixId(): string {
  return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
}

export const StoreService = {
  getAll(): AppConfig {
    return {
      projects: store.get('projects'),
      aiService: store.get('aiService'),
      aiPrefs: store.get('aiPrefs'),
      siderCollapsed: store.get('siderCollapsed'),
      appSettings: store.get('appSettings')
    }
  },

  /* ---------- 项目 ---------- */
  getProjects(): ProjectMeta[] {
    return store.get('projects')
  },
  setProjects(projects: ProjectMeta[]): void {
    store.set('projects', projects)
  },

  /* ---------- AI 服务 ---------- */
  getAiService(): AiServiceConfig {
    return normalizeAiService(store.get('aiService') as Partial<AiServiceConfig> | undefined)
  },
  setAiService(cfg: AiServiceConfig): void {
    store.set('aiService', cfg)
  },

  /* ---------- AI 偏好 ---------- */
  getAiPrefs(): AiPrefs {
    return normalizePrefs(store.get('aiPrefs') as Partial<AiPrefs> | undefined)
  },
  setAiPrefs(prefs: AiPrefs): void {
    store.set('aiPrefs', prefs)
  },

  /** 恢复生成规则为默认值（保留前缀列表与其它偏好） */
  resetAiRules(): string {
    store.set('aiPrefs.customRules', DEFAULT_AI_RULES)
    return DEFAULT_AI_RULES
  },

  /* ---------- UI 偏好 ---------- */
  getSiderCollapsed(): boolean {
    return store.get('siderCollapsed')
  },
  setSiderCollapsed(collapsed: boolean): void {
    store.set('siderCollapsed', collapsed)
  },

  /* ---------- 应用级设置（开机自启 / 最小化到托盘 / 关闭确认） ---------- */
  getAppSettings(): AppSettings {
    return normalizeAppSettings(store.get('appSettings') as Partial<AppSettings> | undefined)
  },
  setAppSettings(s: AppSettings): void {
    store.set('appSettings', normalizeAppSettings(s))
  }
}
