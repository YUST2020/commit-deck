/**
 * 代码审查 store
 * --------------------------------------------------
 * 管理：审查结果浮窗开关 / 审查状态机 / 流式累积。
 * 与 useAiStore（commit message）彻底解耦：
 *   - 订阅独立的 ai:review:* 事件（主进程按 task 分流推送），互不污染 buffer；
 *   - 复用 useAiStore.config（provider/apiKey/model）与 useGitStore 的 diff 来源（gitDiffForAi），
 *     保证「审查的就是即将提交的改动」。
 *
 * 单流约束：主进程同窗口任意时刻只能跑一个任务。触发审查时若 commit 正在生成，
 * 先调 useAiStore.abort() 让出流，再启动审查。
 *
 * 流式渲染性能：沿用 useAiStore 的 shallowRef + 30ms 节流 flush 方案。
 */
import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import { buildReviewMessages } from '@/ai/reviewPrompts'
import type { AiMessage, AiServiceConfig, ChangedFileInfo, OmittedFile } from '@shared/index'
import { useAiStore } from './useAiStore'
import { useProjectStore } from './useProjectStore'

export type ReviewPhase = 'idle' | 'generating' | 'done' | 'error'

/**
 * 将任意值转成「纯对象」，用于跨 IPC 边界（与 useAiStore.toPlain 同理）。
 * Vue 响应式对象是 Proxy，无法被 IPC 的 structured clone 序列化，
 * 会抛 "An object could not be cloned"。统一用 JSON 往返兜底。
 */
function toPlain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

export const useCodeReviewStore = defineStore('codeReview', () => {
  const project = useProjectStore()
  const ai = useAiStore()

  /* ---------- 浮窗 / 状态 ---------- */
  /** 审查结果浮窗是否打开（AiCommitPanel 底部按钮触发） */
  const modalOpen = ref(false)
  const phase = ref<ReviewPhase>('idle')
  /**
   * 流式累积缓冲：用 shallowRef 避免逐字符深响应式。
   * 组件通过 reviewMessage（节流同步）读取。
   */
  const buffer = shallowRef('')
  /** 展示用文本（Markdown 源，由 CodeReviewModal 渲染；节流同步自 buffer） */
  const message = ref('')
  const error = ref<string | null>(null)
  const truncated = ref(false)
  const source = ref<'staged' | 'all' | null>(null)
  /** 被忽略/折叠/截断的文件列表（与 commit 同源，取自 gitDiffForAi） */
  const omittedFiles = ref<OmittedFile[]>([])

  /* ---------- 文件选择器 ---------- */
  /** 选择器浮窗是否打开（「代码审查」按钮触发，先选文件再审查） */
  const pickerOpen = ref(false)
  /** 选择器取数 loading */
  const pickerLoading = ref(false)
  /** 改动文件清单（gitChangedFiles 返回，供 ReviewFilePicker 构建树） */
  const changedFiles = ref<ChangedFileInfo[]>([])
  /** 选择器展示的来源标签（暂存 / 全量），随 changedFiles 一起取 */
  const pickerSource = ref<'staged' | 'all' | null>(null)
  /** 上次审查实际选中的文件数（用于 prompt 约束总结篇幅 + loading 文案） */
  const lastReviewFileCount = ref(0)
  /** 上次审查实际选中的文件路径（重试时复用，保持同一审查范围） */
  const lastReviewPaths = ref<string[]>([])

  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let unsubChunk: (() => void) | null = null
  let unsubDone: (() => void) | null = null
  let unsubError: (() => void) | null = null

  /**
   * 首块超时看门狗：aiGenerate 返回成功后启动，收到第一个 chunk 即清除。
   * 若在窗口内既无数据也无 done/error（连接挂起），切到 error 提示，避免一直转圈。
   * 仅在「尚未收到任何数据」时计时——一旦开始流式输出就说明链路活着，不再误杀慢审查。
   */
  const FIRST_CHUNK_TIMEOUT_MS = 30_000
  let firstChunkTimer: ReturnType<typeof setTimeout> | null = null
  let receivedAnyChunk = false

  function startFirstChunkWatchdog(): void {
    clearFirstChunkWatchdog()
    receivedAnyChunk = false
    firstChunkTimer = setTimeout(() => {
      firstChunkTimer = null
      // 仍在 generating 且一块都没收到 → 判定为连接挂起
      if (phase.value === 'generating' && !receivedAnyChunk) {
        unsubscribe()
        error.value = '审查无响应：服务长时间未返回数据，请检查网络或 AI 配置后重试'
        phase.value = 'error'
      }
    }, FIRST_CHUNK_TIMEOUT_MS)
  }
  function clearFirstChunkWatchdog(): void {
    if (firstChunkTimer) {
      clearTimeout(firstChunkTimer)
      firstChunkTimer = null
    }
  }

  /* ---------- 流式 ---------- */
  /** 把 buffer 节流同步到 message（每 ~30ms 批量刷新一次） */
  function scheduleFlush(): void {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      message.value = buffer.value
    }, 30)
  }

  /** 订阅主进程审查流事件（幂等：重复调用先解绑旧的） */
  function subscribe(): void {
    unsubscribe()
    unsubChunk = window.api.onAiReviewChunk((delta) => {
      receivedAnyChunk = true
      // 首块到达 → 链路确认存活，清除看门狗
      clearFirstChunkWatchdog()
      buffer.value = buffer.value + delta
      scheduleFlush()
    })
    unsubDone = window.api.onAiReviewDone(() => {
      clearFirstChunkWatchdog()
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      message.value = buffer.value
      phase.value = 'done'
    })
    unsubError = window.api.onAiReviewError((err) => {
      clearFirstChunkWatchdog()
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

  /** 校验配置（复用 useAiStore.config），缺 key 时打开配置弹窗并返回 false */
  function ensureConfigured(): boolean {
    const cfg = ai.config
    if (!cfg || !cfg.apiKey.trim()) {
      error.value = '请先在「服务配置」中填写 API Key'
      phase.value = 'error'
      ai.configModalOpen = true
      return false
    }
    return true
  }

  /**
   * 触发审查：取 diff → 组装 messages → 订阅 review 流 → invoke 启动（task:'review'）。
   * @param onlyPaths 仅审查这些路径的改动（来自文件选择器勾选；为空=全量，与 commit 同源）
   */
  async function generateReview(onlyPaths: string[] = []): Promise<void> {
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
    lastReviewFileCount.value = onlyPaths.length
    lastReviewPaths.value = onlyPaths

    try {
      // 取 diff（与 commit 同源：暂存优先，否则全量）。
      // 传 model 给主进程，用于按模型上下文长度动态推算 diff 总量上限。
      // review 走文件选择器语义：onlyPaths 限定审查范围（不再用 commit 的 forceIncludePaths）。
      const cfgSnap = ai.config
      const modelForDiff = cfgSnap
        ? cfgSnap.presetCustomModel
          ? cfgSnap.model
          : cfgSnap.presetModel
        : undefined
      const diffRes = await window.api.gitDiffForAi(repoPath, modelForDiff, [], onlyPaths)
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
        error.value = '没有可审查的改动'
        phase.value = 'error'
        return
      }

      const messages: AiMessage[] = buildReviewMessages(
        { source: src, truncated: t, fileCount: onlyPaths.length || undefined },
        diff
      )

      // 订阅审查流事件
      subscribe()

      // IPC 无法 structured-clone Vue 响应式代理，必须转成纯对象/纯数组（共性 Bug 规范）。
      // 注意 config 来自 useAiStore（Pinia state 的 Proxy），即使 toRaw 也只能脱一层；
      // 用 toPlain（JSON 往返）彻底切断 Proxy，避免 "An object could not be cloned"。
      const plainConfig = toPlain(cfgSnap) as AiServiceConfig
      const plainMessages = toPlain(messages) as AiMessage[]

      const res = await window.api.aiGenerate({
        repoPath,
        config: plainConfig,
        messages: plainMessages,
        task: 'review'
      })
      if (!res.ok) {
        // error 事件通常会先到，这里兜底
        if (phase.value === 'generating') {
          error.value = res.error || '审查失败'
          phase.value = 'error'
        }
      } else if (phase.value === 'generating') {
        // 启动成功但流事件尚未到达：挂上看门狗，防连接挂起导致一直转圈
        startFirstChunkWatchdog()
      }
    } catch (e) {
      // 任何意外异常（IPC clone 失败、网络、序列化等）都要兜住，绝不能卡在 generating 态转圈。
      // 保留原始错误到控制台（便于排查），同时给出可读提示。
      console.error('[generateReview] 审查失败:', e)
      clearFirstChunkWatchdog()
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      message.value = buffer.value
      const reason = e instanceof Error ? e.message : String(e)
      // 把生硬的 IPC clone 错误翻译成可读文案
      error.value =
        reason.includes('could not be cloned')
          ? '审查启动失败：参数无法序列化，请重试'
          : `审查失败：${reason}`
      phase.value = message.value.trim() ? 'done' : 'error'
    }
  }

  /** 中断当前审查（用户主动停止）；保留已生成文本，回到 done 态 */
  async function abortReview(): Promise<void> {
    clearFirstChunkWatchdog()
    await window.api.aiAbort()
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    message.value = buffer.value
    phase.value = message.value.trim() ? 'done' : 'idle'
  }

  /**
   * 重试审查：复用上次选择的文件范围（保持审查对象一致，不退回选择器）。
   * 若无历史路径（异常路径），退化为全量审查。
   */
  function retry(): Promise<void> {
    return generateReview(lastReviewPaths.value)
  }

  /**
   * 打开文件选择器并拉取改动文件列表（点击「代码审查」按钮触发）。
   * 选择器展示文件后由用户勾选，确认后再走 startReview → generateReview。
   * 取数失败时直接落到 error 态并提示，不卡 loading。
   */
  async function openPicker(): Promise<void> {
    const repoPath = project.active?.path
    if (!repoPath) return
    pickerOpen.value = true
    pickerLoading.value = true
    changedFiles.value = []
    pickerSource.value = null
    try {
      const res = await window.api.gitChangedFiles(repoPath)
      if (!res.ok) {
        throw new Error(res.error.message || '获取改动文件失败')
      }
      changedFiles.value = res.data.files
      pickerSource.value = res.data.source
    } catch (e) {
      console.error('[review.openPicker] 获取改动文件失败:', e)
      const reason = e instanceof Error ? e.message : String(e)
      error.value = `获取改动文件失败：${reason}`
      phase.value = 'error'
      modalOpen.value = true
      pickerOpen.value = false
    } finally {
      pickerLoading.value = false
    }
  }

  /** 关闭文件选择器（取消） */
  function closePicker(): void {
    pickerOpen.value = false
  }

  /**
   * 选择器确认后启动审查。
   * 单流约束：若 commit 正在生成，先让 useAiStore.abort() 释放流，再启动审查。
   * generateReview 内部已有完整异常兜底；这里再包一层防止 ai.abort 等抛出未处理 rejection。
   */
  async function startReview(paths: string[]): Promise<void> {
    pickerOpen.value = false
    modalOpen.value = true
    try {
      if (ai.phase === 'generating') {
        await ai.abort()
      }
      await generateReview(paths)
    } catch (e) {
      // 理论上 generateReview 已兜底，这里防御外层（如 ai.abort）异常导致卡 generating
      console.error('[review.startReview] 启动失败:', e)
      const reason = e instanceof Error ? e.message : String(e)
      error.value = `审查启动失败：${reason}`
      phase.value = 'error'
    }
  }

  /** 关闭浮窗：若审查仍在跑则先中断，再隐藏（不清空结果，下次打开保留） */
  async function close(): Promise<void> {
    if (phase.value === 'generating') {
      await abortReview()
    }
    modalOpen.value = false
  }

  /**
   * 切换项目时调用：中断在跑的审查 + 清空结果。
   * 在 App.vue 的 watch(project.activeId) 中挂上，与 ai.switchProject / git.switchProject 并列。
   */
  async function switchProject(): Promise<void> {
    clearFirstChunkWatchdog()
    if (phase.value === 'generating') {
      await abortReview()
    }
    unsubscribe()
    pickerOpen.value = false
    pickerLoading.value = false
    changedFiles.value = []
    pickerSource.value = null
    phase.value = 'idle'
    buffer.value = ''
    message.value = ''
    error.value = null
    truncated.value = false
    source.value = null
    omittedFiles.value = []
    lastReviewFileCount.value = 0
    lastReviewPaths.value = []
  }

  return {
    modalOpen,
    phase,
    message,
    error,
    truncated,
    source,
    omittedFiles,
    // 文件选择器
    pickerOpen,
    pickerLoading,
    changedFiles,
    pickerSource,
    lastReviewFileCount,
    openPicker,
    closePicker,
    startReview,
    generateReview,
    retry,
    abortReview,
    close,
    switchProject
  }
})
