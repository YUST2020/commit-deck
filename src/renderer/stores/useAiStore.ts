/**
 * AI 提交信息 store
 * --------------------------------------------------
 * 管理：服务配置 / 偏好（前缀/详细/规则）/ 生成状态机 / 流式累积 / 提交推送。
 *
 * 流式渲染性能（参考方案文档 6.5.1）：
 *   流式增量高频到达，逐字符 += 会触发整组件重渲染。
 *   故用 shallowRef + 节流 flush（每 30ms 批量写一次到展示用的 message）。
 *
 * 切换项目（参考 6.5.3）：activeId 变化时 abort + 重置生成态。
 */
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, toRaw } from 'vue'
import { DEFAULT_RULES, buildMessages } from '@/ai/prompts'
import { genPrefixIdLocal } from '@/ai/prefixId'
import type { AiMessage, AiPrefs, AiServiceConfig, CommitPrefix, OmittedFile, ProjectDraft } from '@shared/index'
import { useGitStore } from './useGitStore'
import { useProjectStore } from './useProjectStore'

export type AiPhase = 'idle' | 'generating' | 'editing' | 'error'

/**
 * 将任意值转成「纯对象」，用于跨 IPC 边界。
 * Vue 响应式对象（ref.value / 展开自 ref 的对象 / Pinia state）是 Proxy，
 * 无法被 IPC 的 structured clone 序列化，会抛 "An object could not be cloned"。
 * 统一在此去 Proxy（JSON 往返兜底函数/undefined）。
 */
function toPlain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

export const useAiStore = defineStore('ai', () => {
  const project = useProjectStore()
  const git = useGitStore()

  /* ---------- 配置 / 偏好（持久化） ---------- */
  const config = ref<AiServiceConfig | null>(null)
  const prefs = ref<AiPrefs | null>(null)
  /** 服务配置弹窗是否打开（卡片内齿轮触发） */
  const configModalOpen = ref(false)
  /** 前缀管理弹窗是否打开 */
  const prefixModalOpen = ref(false)

  /* ---------- 生成状态 ---------- */
  const phase = ref<AiPhase>('idle')
  /**
   * 流式累积缓冲：用 shallowRef 避免逐字符深响应式。
   * 组件通过 readMessage（computed）读取，由 flush 定时同步。
   */
  const buffer = shallowRef('')
  /** 展示/编辑用文本（节流同步自 buffer） */
  const message = ref('')
  const error = ref<string | null>(null)
  const truncated = ref(false)
  const source = ref<'staged' | 'all' | null>(null)
  /** 被忽略/折叠/截断的文件列表（点击可查看详情） */
  const omittedFiles = ref<OmittedFile[]>([])
  /**
   * 用户预填草稿：生成前用户可手写要点，生成时作为补充上下文发给 AI 润色。
   * 生成完成后清空（润色结果已写入 message）。
   */
  const userDraft = ref('')

  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let unsubChunk: (() => void) | null = null
  let unsubDone: (() => void) | null = null
  let unsubError: (() => void) | null = null

  /**
   * 草稿 / message 落盘的 debounce 定时器。
   * 文本输入高频，逐字符写 electron-store 会反复触发 IPC + 磁盘 IO；
   * 用 500ms 防抖合并，停顿后一次性持久化当前项目的文本缓存。
   */
  const DRAFT_DEBOUNCE_MS = 500
  let draftTimer: ReturnType<typeof setTimeout> | null = null

  /* ---------- getters ---------- */
  const hasConfig = computed(() => !!config.value)
  const isConfigured = computed(
    () => !!config.value && !!config.value.apiKey.trim()
  )
  /** 当前项目选中的前缀 id（按项目独立缓存，取自 selectedPrefixByProject[activeId]） */
  const selectedPrefixId = computed<string | null>(() => {
    const pid = project.activeId
    if (!pid || !prefs.value) return null
    const map = prefs.value.selectedPrefixByProject ?? {}
    return Object.prototype.hasOwnProperty.call(map, pid) ? (map[pid] ?? null) : null
  })
  const selectedPrefix = computed(() => {
    if (!prefs.value) return null
    const id = selectedPrefixId.value
    if (!id) return null
    return prefs.value.prefixes.find((p) => p.id === id) ?? null
  })
  /** 是否有可生成的内容（有暂存 或 工作区有任何改动） */
  const canGenerate = computed(() => git.files.length > 0)

  /* ---------- 初始化 ---------- */
  async function init(): Promise<void> {
    const [cfg, p] = await Promise.all([
      window.api.getAiService(),
      window.api.getAiPrefs()
    ])
    config.value = cfg
    prefs.value = p
  }

  /* ---------- 配置 / 偏好持久化 ---------- */
  async function saveConfig(cfg: AiServiceConfig): Promise<void> {
    config.value = cfg
    await window.api.setAiService(toPlain(cfg))
  }

  /** 内部：写回 prefs（前缀/详细/规则/选中变化后调用） */
  async function persistPrefs(next: AiPrefs): Promise<void> {
    prefs.value = next
    await window.api.setAiPrefs(toPlain(next))
  }

  /* ---------- 前缀管理 ---------- */
  async function addPrefix(label: string): Promise<void> {
    const trimmed = label.trim()
    if (!trimmed || !prefs.value) return
    // 去重（label 不区分大小写）
    if (prefs.value.prefixes.some((p) => p.label.toLowerCase() === trimmed.toLowerCase())) {
      return
    }
    const next: AiPrefs = {
      ...prefs.value,
      prefixes: [...prefs.value.prefixes, { id: genPrefixIdLocal(), label: trimmed }]
    }
    await persistPrefs(next)
  }

  async function removePrefix(id: string): Promise<void> {
    if (!prefs.value) return
    // 清掉所有引用了该前缀的项目选中记录
    const map = { ...(prefs.value.selectedPrefixByProject ?? {}) }
    for (const k of Object.keys(map)) {
      if (map[k] === id) map[k] = null
    }
    await persistPrefs({
      ...prefs.value,
      prefixes: prefs.value.prefixes.filter((p) => p.id !== id),
      selectedPrefixByProject: map
    })
  }

  async function selectPrefix(id: string | null): Promise<void> {
    if (!prefs.value) return
    const pid = project.activeId
    if (!pid) return
    // 写入按项目缓存的选中（不覆盖其它项目的记录）
    const map = { ...(prefs.value.selectedPrefixByProject ?? {}) }
    map[pid] = id
    await persistPrefs({ ...prefs.value, selectedPrefixByProject: map })
  }

  /** 批量替换前缀列表（用于管理弹窗的增删 + 拖拽排序后整体保存） */
  async function setPrefixes(next: CommitPrefix[]): Promise<void> {
    if (!prefs.value) return
    // 若当前项目选中的前缀已被删除，清掉该项目的选中
    const pid = project.activeId
    const map = { ...(prefs.value.selectedPrefixByProject ?? {}) }
    if (pid && map[pid] && !next.some((p) => p.id === map[pid])) {
      map[pid] = null
    }
    await persistPrefs({ ...prefs.value, prefixes: next, selectedPrefixByProject: map })
  }

  async function toggleDetailed(v: boolean): Promise<void> {
    if (!prefs.value) return
    await persistPrefs({ ...prefs.value, detailed: v })
  }

  async function updateRules(text: string): Promise<void> {
    if (!prefs.value) return
    await persistPrefs({ ...prefs.value, customRules: text })
  }

  async function resetRules(): Promise<void> {
    if (!prefs.value) return
    // 走主进程重置（保证持久层一致），再同步本地
    const rules = await window.api.resetAiRules()
    await persistPrefs({ ...prefs.value, customRules: rules })
  }

  /* ---------- 流式生成 ---------- */
  /** 把 buffer 节流同步到 message（每 ~30ms 批量刷新一次） */
  function scheduleFlush(): void {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      message.value = buffer.value
    }, 30)
  }

  /** 订阅主进程流事件（幂等：重复调用先解绑旧的） */
  function subscribe(): void {
    unsubscribe()
    unsubChunk = window.api.onAiChunk((delta) => {
      buffer.value = buffer.value + delta
      scheduleFlush()
    })
    unsubDone = window.api.onAiDone(() => {
      // flush 残留缓冲后切到编辑态
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      message.value = buffer.value
      userDraft.value = '' // 草稿已被 AI 润色进结果，清空
      phase.value = 'editing'
    })
    unsubError = window.api.onAiError((err) => {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      message.value = buffer.value
      error.value = err.message
      phase.value = 'error'
    })
  }

  function unsubscribe(): void {
    unsubChunk?.()
    unsubDone?.()
    unsubError?.()
    unsubChunk = unsubDone = unsubError = null
  }

  /** 校验配置，缺 key 时打开配置弹窗并返回 false */
  function ensureConfigured(): boolean {
    if (!config.value || !config.value.apiKey.trim()) {
      error.value = '请先在「服务配置」中填写 API Key'
      phase.value = 'error'
      configModalOpen.value = true
      return false
    }
    return true
  }

  /**
   * 触发生成。
   * 流程：取 diff → 组装 messages → 订阅流 → invoke 启动。
   */
  async function generate(): Promise<void> {
    const repoPath = project.active?.path
    if (!repoPath) return
    if (!ensureConfigured()) return

    // 重置态
    phase.value = 'generating'
    error.value = null
    buffer.value = ''
    message.value = ''
    truncated.value = false
    omittedFiles.value = []

    // 取 diff（暂存优先，否则全量）
    // 传 model 给主进程，用于按模型上下文长度动态推算 diff 总量上限
    const cfgSnap = config.value
    const modelForDiff = cfgSnap
      ? cfgSnap.presetCustomModel
        ? cfgSnap.model
        : cfgSnap.presetModel
      : undefined
    const diffRes = await window.api.gitDiffForAi(repoPath, modelForDiff)
    if (!diffRes.ok) {
      error.value = diffRes.error.message || '获取差异失败'
      phase.value = 'error'
      return
    }
    const { diff, truncated: t, source: src, omittedFiles: om } = diffRes.data
    truncated.value = t
    source.value = src
    omittedFiles.value = om ?? []

    if (!diff.trim()) {
      error.value = '没有可生成的改动'
      phase.value = 'error'
      return
    }

    // 组装消息（truncated=true 时会在 system prompt 注入"仅基于已展示内容总结"告知）
    const messages: AiMessage[] = buildMessages(
      {
        rules: prefs.value?.customRules || DEFAULT_RULES,
        prefix: selectedPrefix.value?.label ?? null,
        detailed: prefs.value?.detailed ?? true,
        source: src,
        userDraft: userDraft.value.trim() || null,
        truncated: t
      },
      diff
    )

    // 调试用：在控制台打印完整 prompt（system + user），便于排查生成效果
    // 主进程终端也有同样打印（AiService.streamGenerate）；此处 DevTools 可见。
    const thinkFlag = cfgSnap?.thinking ? ` · thinking:${cfgSnap.thinkingEffort}` : ''
    // eslint-disable-next-line no-console
    console.groupCollapsed(
      `%c[AI Prompt]%c ${messages.length} msgs · ${src} · diff ${diff.length} chars${
        userDraft.value.trim() ? ' · 含草稿' : ''
      }${thinkFlag}`,
      'color:#4f46e5;font-weight:600',
      'color:inherit'
    )
    for (const m of messages) {
      // eslint-disable-next-line no-console
      console.log(
        `%c[${m.role}] (${m.content.length} chars)`,
        'color:#4f46e5;font-weight:600',
        m.content
      )
    }
    // eslint-disable-next-line no-console
    console.groupEnd()

    // 订阅流事件
    subscribe()

    // IPC 无法 structured-clone Vue 响应式代理，必须转成纯对象/纯数组。
    // 用 JSON 序列化兜底（同时去掉 undefined 字段与函数），彻底切断 Proxy。
    const plainConfig = JSON.parse(JSON.stringify(toRaw(config.value)!)) as AiServiceConfig
    const plainMessages = JSON.parse(JSON.stringify(messages.map((m) => toRaw(m)))) as AiMessage[]

    // 启动生成（主进程通过事件推流）
    const res = await window.api.aiGenerate({
      repoPath,
      config: plainConfig,
      messages: plainMessages
    })
    if (!res.ok) {
      // error 事件通常会先到，这里兜底
      if (phase.value === 'generating') {
        error.value = res.error || '生成失败'
        phase.value = 'error'
      }
    }
  }

  async function abort(): Promise<void> {
    await window.api.aiAbort()
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    message.value = buffer.value
    // 保留已生成文本，回到编辑态（用户可基于部分结果修改）
    phase.value = message.value.trim() ? 'editing' : 'idle'
  }

  function regenerate(): Promise<void> {
    return generate()
  }

  /* ---------- 提交 / 推送 ---------- */
  /**
   * 提交（可选推送）。
   * 成功 → 返回 { ok:true }；失败 → 返回 { ok:false, message }，由调用方弹窗（用户决策：弹窗确认）。
   */
  async function commit(opts: { push: boolean }): Promise<{
    ok: boolean
    message: string
    commitHash?: string
  }> {
    const repoPath = project.active?.path
    if (!repoPath) return { ok: false, message: '未选择项目' }
    const msg = message.value.trim()
    if (!msg) return { ok: false, message: '提交信息为空' }

    // commit
    const commitRes = await window.api.gitCommit(repoPath, msg)
    if (!commitRes.ok) {
      return { ok: false, message: commitRes.error.message || '提交失败' }
    }

    // 提交成功，立即清空内存中的草稿和消息，让 UI 快速反馈
    userDraft.value = ''
    message.value = ''
    if (draftTimer) {
      clearTimeout(draftTimer)
      draftTimer = null
    }

    // 刷新 git 状态（status + log + branch）
    await git.refreshAll()

    // 清掉当前项目的草稿缓存（持久化层）
    const committedPid = project.activeId
    if (committedPid) await clearDraft(committedPid)

    if (!opts.push) {
      return { ok: true, message: '已提交', commitHash: commitRes.data }
    }

    // push
    const pushRes = await window.api.gitPush(repoPath)
    if (!pushRes.ok) {
      // commit 成功但 push 失败：返回特殊标记，调用方分别提示
      return {
        ok: true,
        message: '已提交，但推送失败：' + (pushRes.error.message || '未知错误'),
        commitHash: commitRes.data
      }
    }
    await git.refreshAll()
    return { ok: true, message: '已提交并推送', commitHash: commitRes.data }
  }

  /* ---------- 切换项目清理 ---------- */
  function reset(): void {
    void window.api.aiAbort()
    unsubscribe()
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (draftTimer) {
      clearTimeout(draftTimer)
      draftTimer = null
    }
    phase.value = 'idle'
    buffer.value = ''
    message.value = ''
    userDraft.value = ''
    error.value = null
    truncated.value = false
    source.value = null
    omittedFiles.value = []
  }

  /** 设置预填草稿（生成前的用户输入）。变更后 debounce 写盘。 */
  function setUserDraft(v: string): void {
    userDraft.value = v
    scheduleSaveDraft()
  }

  /* ---------- 按项目的草稿/结果持久化 ---------- */
  /**
   * 把当前项目的 userDraft / message 写入 prefs.draftByProject（落盘）。
   * 只在 idle / editing 态持久化（generating 流式中间态不落盘，切走时丢弃）。
   */
  async function persistDraftNow(pid: string): Promise<void> {
    if (!prefs.value) return
    const next: ProjectDraft = {
      draft: userDraft.value,
      message: phase.value === 'editing' ? message.value : ''
    }
    // 值未变化则跳过写盘
    const prev = prefs.value.draftByProject?.[pid]
    if (prev && prev.draft === next.draft && prev.message === next.message) return
    const drafts = { ...(prefs.value.draftByProject ?? {}) }
    drafts[pid] = next
    await persistPrefs({ ...prefs.value, draftByProject: drafts })
  }

  /** debounced 版本：500ms 停顿后落盘当前项目草稿。 */
  function scheduleSaveDraft(): void {
    const pid = project.activeId
    if (!pid) return
    if (draftTimer) clearTimeout(draftTimer)
    draftTimer = setTimeout(() => {
      draftTimer = null
      void persistDraftNow(pid)
    }, DRAFT_DEBOUNCE_MS)
  }

  /** 清掉某项目的草稿缓存（提交成功后调用，避免下次进来还显示旧 message） */
  async function clearDraft(pid: string): Promise<void> {
    if (!prefs.value) return
    if (draftTimer) {
      clearTimeout(draftTimer)
      draftTimer = null
    }

    // 如果是当前活跃项目，同时也清掉内存中的值，避免提交后界面还残留
    if (pid === project.activeId) {
      userDraft.value = ''
      message.value = ''
    }

    if (!prefs.value.draftByProject || !(pid in prefs.value.draftByProject)) return
    const drafts = { ...prefs.value.draftByProject }
    delete drafts[pid]
    await persistPrefs({ ...prefs.value, draftByProject: drafts })
  }

  /**
   * 切换项目时的 AI 卡片状态切换：
   *   1. 离开旧项目：generating 态自动 abort 并丢弃；idle/editing 态的文本落盘缓存。
   *   2. 进入新项目：从缓存恢复 userDraft / message，phase 复位为 idle，
   *      清空生成态临时字段。
   *
   * @param prevId 旧项目 id（可能为 null：首次选中）
   * @param nextId 新项目 id
   */
  async function switchProject(prevId: string | null, nextId: string): Promise<void> {
    // 取消未决的 debounce 落盘（避免把旧项目文本写到新项目 key）
    if (draftTimer) {
      clearTimeout(draftTimer)
      draftTimer = null
    }

    // ---- 1. 离开旧项目 ----
    if (prevId) {
      if (phase.value === 'generating') {
        // 生成中切走：abort 并丢弃部分结果（按既定决策）
        await window.api.aiAbort()
        unsubscribe()
        if (flushTimer) {
          clearTimeout(flushTimer)
          flushTimer = null
        }
      } else {
        // idle / editing / error：把文本落盘到旧项目
        await persistDraftNow(prevId)
      }
    }

    // ---- 2. 重置临时态 ----
    unsubscribe()
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    phase.value = 'idle'
    error.value = null
    truncated.value = false
    source.value = null
    omittedFiles.value = []
    buffer.value = ''

    // ---- 3. 恢复新项目文本 ----
    const cached = prefs.value?.draftByProject?.[nextId]
    userDraft.value = cached?.draft ?? ''
    // 即使上次是 editing，恢复时也复位为 idle：让用户重新审视/生成，
    // 避免一进来就停在「提交按钮」态造成误解。
    message.value = cached?.message ?? ''
  }

  return {
    // state
    config, prefs, configModalOpen, prefixModalOpen,
    phase, message, error, truncated, source, userDraft, omittedFiles,
    // getters
    hasConfig, isConfigured, selectedPrefix, selectedPrefixId, canGenerate,
    // init / 持久化
    init, saveConfig,
    // 前缀 / 偏好
    addPrefix, removePrefix, selectPrefix, setPrefixes, toggleDetailed, updateRules, resetRules,
    // 生成
    generate, abort, regenerate, setUserDraft,
    // 按项目草稿持久化
    scheduleSaveDraft, persistDraftNow, clearDraft, switchProject,
    // 提交
    commit,
    // 清理
    reset
  }
})

export type CommitPrefix_ = CommitPrefix // re-export for convenience
