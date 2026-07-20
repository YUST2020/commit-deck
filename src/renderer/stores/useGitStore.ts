/**
 * Git store：围绕当前项目读取 git 状态、提交历史、分支信息。
 * 所有 action 依赖 useProjectStore.active 的 path。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { BranchInfo, FileChange, GitSyncResult, GitSyncResultCode, LogEntry } from '@shared/index'
import { useProjectStore } from './useProjectStore'

export const useGitStore = defineStore('git', () => {
  const project = useProjectStore()

  const files = ref<FileChange[]>([])
  const logs = ref<LogEntry[]>([])
  const branch = ref<BranchInfo | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  /** 单独刷新历史时的加载态（驱动提交历史刷新按钮旋转） */
  const refreshingLog = ref(false)
  /** refreshAll 节流：5s 内只触发一次（供窗口聚焦等高频事件使用） */
  const THROTTLE_MS = 5000
  let lastRefreshAt = 0
  /** 刷新按钮最小加载显示时长：保证旋转动画至少可见 1s，避免接口过快导致动画一闪而过 */
  const MIN_LOADING_MS = 1000
  /** 等待至自 start 起经过 minMs：用于刷新按钮的最低显示时长兜底 */
  async function holdLoading(start: number, minMs = MIN_LOADING_MS): Promise<void> {
    const elapsed = Date.now() - start
    if (elapsed < minMs) {
      await new Promise((r) => setTimeout(r, minMs - elapsed))
    }
  }
  /** 选中查看 diff 的文件 */
  const selectedPath = ref<string | null>(null)
  /** 看 工作区态 / 暂存态 */
  const selectedStaged = ref(false)
  /**
   * 选中文件的 rename 旧路径（若有）。
   * 用于 loadDiff 时一并传 [path, renamedFrom] 给 git diff，
   * 让 git 能识别 rename（仅传新路径会让 rename 显示为 new file）。
   */
  const selectedRenamedFrom = ref<string | undefined>(undefined)
  const diffText = ref('')
  const loadingDiff = ref(false)

  const stagedFiles = computed(() => files.value.filter((f) => f.staged))
  const unstagedFiles = computed(() => files.value.filter((f) => !f.staged))
  const stagedCount = computed(() => stagedFiles.value.length)
  const repoPath = computed(() => project.active?.path ?? null)

  async function refreshAll(): Promise<void> {
    if (!repoPath.value) return
    const start = Date.now()
    loading.value = true
    // 同步置位 refreshingLog：refreshAll 统一持有 + 兜底关闭，
    // 避免 refreshLog 内部过早复位造成提交历史按钮提前停转。
    refreshingLog.value = true
    error.value = null
    try {
      // 走 core 版本，状态由本方法统一管理
      // 先并行读取本地各项状态，确保 UI 快速响应
      await Promise.all([refreshStatus(), refreshLogCore(), refreshBranch()])

      // 异步执行 fetch 更新远端追踪分支，不阻塞本地数据展示。
      // fetch 完成后再次刷新分支信息以更新 ahead/behind 数值。
      void window.api.gitFetch(repoPath.value).then((res) => {
        if (res.ok) refreshBranch()
      })
    } catch (e) {
      error.value = e instanceof Error ? e.message : '加载失败'
    } finally {
      // 保证旋转动画至少可见 MIN_LOADING_MS（接口过快时延迟关闭 loading）
      await holdLoading(start)
      loading.value = false
      refreshingLog.value = false
    }
  }

  async function refreshStatus(): Promise<void> {
    if (!repoPath.value) return
    const res = await window.api.gitStatus(repoPath.value)
    if (!res.ok) {
      error.value = res.error.message
      return
    }
    files.value = res.data
    // 选中态自愈：commit / stage / unstage 之后，原选中的 (path, staged)
    // 可能已不存在（如已提交、或文件已切到另一态）。
    // 校验当前 selectedPath+selectedStaged 是否仍命中 files；不命中则按
    // 优先级回退：同 path 另一态 → 清空选中。
    // 命中则按需重载 diff（selectedStaged 可能因 stage/unstage 切换）。
    reconcileSelection()
  }

  /**
   * 刷新 files 后校验并修正 selectedPath / selectedStaged。
   * - 若 (path, staged) 仍在 files 中：保持选中，diff 视 staged 是否变化决定是否重载；
   * - 若 path 已不存在于当前 staged 态，但存在于另一态：切到另一态并重载 diff；
   * - 若 path 完全消失（已 commit / 撤销改动）：清空选中与 diff。
   * 目的：避免 commit/stage/unstage 后 DiffViewer 仍指向已不存在的条目，
   *      显示陈旧或空的 diff（用户困惑）。
   */
  function reconcileSelection(): void {
    const p = selectedPath.value
    if (!p) return
    const sameSide = files.value.find((f) => f.path === p && f.staged === selectedStaged.value)
    if (sameSide) {
      // 同侧命中：若 renamedFrom 与当前保存的不一致（理论上同 path 同侧 rename 不会变），
      // 同步一次以防万一；不主动重载（selectFile 时已拉过 diff）。
      if (sameSide.renamedFrom !== selectedRenamedFrom.value) {
        selectedRenamedFrom.value = sameSide.renamedFrom
      }
      return
    }
    // 同侧不命中：尝试切到另一态
    const otherSide = files.value.find((f) => f.path === p)
    if (otherSide) {
      selectedStaged.value = otherSide.staged
      selectedRenamedFrom.value = otherSide.renamedFrom
      void loadDiff()
      return
    }
    // 完全消失：清空选中
    selectedPath.value = null
    selectedStaged.value = false
    selectedRenamedFrom.value = undefined
    diffText.value = ''
  }

  /** 提交历史加载的纯调用：不管理 refreshingLog 状态，供 refreshAll 统一托管 */
  async function refreshLogCore(): Promise<void> {
    if (!repoPath.value) return
    const res = await window.api.gitLog(repoPath.value, 50)
    if (res.ok) logs.value = res.data
  }

  async function refreshLog(): Promise<void> {
    if (!repoPath.value) return
    const start = Date.now()
    refreshingLog.value = true
    try {
      await refreshLogCore()
      // 异步 fetch 并在完成后更新分支信息（ahead/behind）
      void window.api.gitFetch(repoPath.value).then((res) => {
        if (res.ok) refreshBranch()
      })
    } finally {
      // 保证提交历史刷新按钮旋转动画至少可见 MIN_LOADING_MS（单独点提交历史刷新时生效）
      await holdLoading(start)
      refreshingLog.value = false
    }
  }

  async function refreshBranch(): Promise<void> {
    if (!repoPath.value) return
    const res = await window.api.gitBranch(repoPath.value)
    if (res.ok) branch.value = res.data
  }

  /** 选中某文件并加载其 diff。rename 文件需传 renamedFrom 才能让 git 识别 rename。 */
  async function selectFile(path: string, staged: boolean, renamedFrom?: string): Promise<void> {
    selectedPath.value = path
    selectedStaged.value = staged
    selectedRenamedFrom.value = renamedFrom
    await loadDiff()
  }

  async function loadDiff(): Promise<void> {
    if (!repoPath.value || !selectedPath.value) {
      diffText.value = ''
      return
    }
    loadingDiff.value = true
    try {
      // rename 文件：传 [path, renamedFrom]，让 git 看到「删旧+加新」成对改动，
      // 从而识别为 rename 并输出 rename from/to 形式 diff。
      const fileArg = selectedRenamedFrom.value
        ? [selectedPath.value, selectedRenamedFrom.value]
        : selectedPath.value
      const res = await window.api.gitDiffFile(
        repoPath.value,
        fileArg,
        selectedStaged.value
      )
      diffText.value = res.ok ? res.data : ''
    } finally {
      loadingDiff.value = false
    }
  }

  /**
   * 暂存 / 取消暂存后刷新。
   * 注意：刷新会触发 reconcileSelection 自动调整选中态——
   * 例如选中 unstaged 条目点「+ 暂存」后，文件切到 staged 列表，
   * selectedStaged 自动翻转为 true 并重载 staged diff，无需用户重新点选。
   */
  async function stage(files_: string[]): Promise<void> {
    if (!repoPath.value) return
    const res = await window.api.gitAdd(repoPath.value, files_)
    if (res.ok) await refreshStatus()
  }
  async function unstage(files_: string[]): Promise<void> {
    if (!repoPath.value) return
    const res = await window.api.gitReset(repoPath.value, files_)
    if (res.ok) await refreshStatus()
  }

  /**
   * 节流刷新：5s 内只执行一次。用于窗口聚焦等高频事件，
   * 避免频繁调 git。force=true 可强制立即刷新。
   */
  async function refreshAllThrottled(force = false): Promise<void> {
    const now = Date.now()
    if (!force && now - lastRefreshAt < THROTTLE_MS) return
    lastRefreshAt = now
    await refreshAll()
  }

  /** 切换项目时重置 */
  function reset(): void {
    files.value = []
    logs.value = []
    branch.value = null
    selectedPath.value = null
    selectedStaged.value = false
    selectedRenamedFrom.value = undefined
    diffText.value = ''
    error.value = null
  }

  /**
   * 切换到另一个项目：清空旧项目数据并加载新项目。
   * 与「reset() + refreshAll()」分开调用的区别：二者必须串成一个原子动作，
   * 否则中间态会触发整块卸载/重挂 → 闪屏。
   * 串成一次调用后，UI 侧只靠 keyed <Transition> 淡入淡出过渡（见 WorkspaceView）。
   */
  async function switchProject(): Promise<void> {
    if (!repoPath.value) return
    reset()
    await refreshAll()
  }

  /** 推送按钮加载态（避免重复点击） */
  const pushing = ref(false)
  /** 拉取按钮加载态（避免重复点击） */
  const pulling = ref(false)
  const undoing = ref(false)

  /**
   * 推送到上游。
   * 返回结构化结果：UI 据 `result` 分支弹窗（成功 / 冲突已回退 / 网络失败 / 无上游…）。
   * - ok=true 仅表示「推送成功」；
   * - ok=false 时 `result` 携带细分 code，`message` 为友好文案。
   *
   * 注意：push 内部已含「被拒 → pull --rebase → 重试」流程，冲突会自动 abort 回退，
   * 故 ok=false 的 conflict_aborted 表示仓库已回到操作前的干净状态。
   */
  async function push(): Promise<{
    ok: boolean
    result?: GitSyncResultCode
    message: string
  }> {
    if (!repoPath.value) return { ok: false, message: '未选择项目' }
    if (pushing.value) return { ok: false, message: '正在推送中' }
    pushing.value = true
    try {
      const res = await window.api.gitPush(repoPath.value)
      if (!res.ok) {
        return { ok: false, result: 'unknown', message: res.error.message || '推送失败' }
      }
      const data = res.data
      if (data.result === 'pushed') {
        await refreshAll()
        return { ok: true, result: 'pushed', message: '已推送' }
      }
      // 失败类：主进程已处理冲突回退，透传友好文案
      return { ok: false, result: data.result, message: data.message || '推送失败' }
    } finally {
      pushing.value = false
    }
  }

  /**
   * 拉取远端（git pull --rebase）。
   * - 已是最新 → ok=true, result=up_to_date；
   * - rebase 成功 → ok=true, result=fast_forwarded；
   * - 冲突 → ok=false, result=conflict_aborted（主进程已自动 abort 回退）。
   */
  async function pull(): Promise<{
    ok: boolean
    result?: GitSyncResultCode
    message: string
  }> {
    if (!repoPath.value) return { ok: false, message: '未选择项目' }
    if (pulling.value) return { ok: false, message: '正在拉取中' }
    pulling.value = true
    try {
      const res = await window.api.gitPull(repoPath.value)
      if (!res.ok) {
        return { ok: false, result: 'unknown', message: res.error.message || '拉取失败' }
      }
      const data = res.data
      await refreshAll()
      if (data.result === 'up_to_date') {
        return { ok: true, result: 'up_to_date', message: '已是最新' }
      }
      if (data.result === 'fast_forwarded') {
        return { ok: true, result: 'fast_forwarded', message: '已拉取并合并' }
      }
      // 失败类
      return { ok: false, result: data.result, message: data.message || '拉取失败' }
    } finally {
      pulling.value = false
    }
  }

  /**
   * 撤回最近 count 个未推送的提交（soft reset，改动保留到暂存区）。
   * 成功后刷新全部状态；失败返回错误信息由调用方弹窗。
   */
  async function undoCommit(count: number): Promise<{ ok: boolean; message: string }> {
    if (!repoPath.value) return { ok: false, message: '未选择项目' }
    if (undoing.value) return { ok: false, message: '正在撤回中' }
    undoing.value = true
    try {
      const res = await window.api.gitUndoCommit(repoPath.value, count)
      if (!res.ok) {
        return { ok: false, message: res.error.message || '撤回失败' }
      }
      await refreshAll()
      return {
        ok: true,
        message: `已撤回 ${count} 个提交，改动已保留到暂存区`
      }
    } finally {
      undoing.value = false
    }
  }

  return {
    files, logs, branch, loading, refreshingLog, error,
    selectedPath, selectedStaged, diffText, loadingDiff,
    stagedFiles, unstagedFiles, stagedCount, repoPath, pushing, pulling, undoing,
    refreshAll, refreshAllThrottled, refreshStatus, refreshLog, refreshBranch,
    selectFile, loadDiff, stage, unstage, reset, switchProject, push, pull, undoCommit
  }
})
