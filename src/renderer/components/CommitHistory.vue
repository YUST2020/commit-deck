<script setup lang="ts">
import { computed } from 'vue'
import { NTag, NScrollbar, useMessage, useDialog } from 'naive-ui'
import { GitCommit, GitBranch, RefreshCw, ChevronDown, CloudUpload, CloudDownload, Cloud, CloudOff, Undo2, History } from 'lucide-vue-next'
import type { BranchInfo, GitSyncResultCode, LogEntry } from '@shared/index'
import { useGitStore } from '@/stores/useGitStore'

const props = defineProps<{
  logs: LogEntry[]
  branch: BranchInfo | null
  expanded?: boolean
  refreshing?: boolean
}>()

// undo 事件：撤回成功后抛出被撤回提交的完整 message，由父组件决定是否填充 AI 面板。
// 这样 CommitHistory 保持纯展示职责，不直接依赖 useAiStore（也规避 HMR 缓存问题）。
const emit = defineEmits<{ refresh: []; toggle: []; undo: [message: string] }>()

const git = useGitStore()
const message = useMessage()
const dialog = useDialog()

/** 相对时间：简单实现，避免引入额外依赖 */
function relTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const diff = Date.now() - d.getTime()
  const m = 60_000
  const h = 60 * m
  const day = 24 * h
  if (diff < h) return Math.max(1, Math.floor(diff / m)) + ' 分钟前'
  if (diff < day) return Math.floor(diff / h) + ' 小时前'
  if (diff < 30 * day) return Math.floor(diff / day) + ' 天前'
  return d.toLocaleDateString()
}

function firstLine(msg: string): string {
  return msg.split('\n')[0] || msg
}

const aheadBehind = computed(() => {
  if (!props.branch) return ''
  const { ahead, behind } = props.branch
  const parts: string[] = []
  if (ahead) parts.push(`↑${ahead}`)
  if (behind) parts.push(`↓${behind}`)
  return parts.join(' ')
})

/** 是否存在本地未推送的提交（有上游且 ahead>0） */
const hasUnpushed = computed(
  () => !!props.branch && props.branch.tracking !== null && props.branch.ahead > 0
)

/** 远端是否有未拉取的提交（有上游且 behind>0）：决定「拉取」按钮是否显示 */
const hasRemoteAhead = computed(
  () => !!props.branch && props.branch.tracking !== null && props.branch.behind > 0
)

/**
 * 统一处理 push/pull 的结构化结果，按 result code 分支弹窗。
 * 成功类（pushed/fast_forwarded/up_to_date）用 message；失败类用 dialog 弹窗。
 *
 * @param action 操作名，用于失败兜底文案
 * @returns 是否成功（成功类为 true）
 */
function handleSyncResult(
  res: { ok: boolean; result?: GitSyncResultCode; message: string },
  action: '推送' | '拉取'
): boolean {
  if (res.ok) {
    // 成功类：pushed / fast_forwarded / up_to_date
    if (res.result === 'up_to_date') message.info(res.message)
    else message.success(res.message)
    return true
  }
  // 失败类：按 code 分流弹窗
  const code = res.result ?? 'unknown'
  if (code === 'conflict_aborted') {
    dialog.warning({
      title: '存在冲突',
      content: '与远端存在冲突，已自动回退到操作前的状态。请在其他 Git 管理工具中解决冲突后再' + action + '。',
      positiveText: '知道了'
    })
  } else if (code === 'no_upstream') {
    dialog.warning({
      title: '未设置上游',
      content: res.message,
      positiveText: '知道了'
    })
  } else if (code === 'network') {
    dialog.error({
      title: '网络/认证失败',
      content: res.message,
      positiveText: '知道了'
    })
  } else {
    // rejected / unknown
    dialog.error({
      title: action + '失败',
      content: res.message,
      positiveText: '知道了'
    })
  }
  return false
}

async function onPush(): Promise<void> {
  const res = await git.push()
  handleSyncResult(res, '推送')
}

async function onPull(): Promise<void> {
  const res = await git.pull()
  handleSyncResult(res, '拉取')
}

/**
 * 撤回提交：在 index（0=最新）处的未推送提交上点击，
 * 表示撤回到该提交之前（含该提交，共 index+1 个）。
 * 软重置，改动保留到暂存区。
 */
function onUndo(index: number, commit: LogEntry): void {
  // 正在撤回中：忽略重复点击
  if (git.undoing) return
  const count = index + 1
  dialog.warning({
    title: `撤回 ${count} 个提交`,
    content: `将撤回到「${firstLine(commit.message)}」之前（共 ${count} 个未推送提交）。改动会保留到暂存区，可重新提交，不会丢失代码。`,
    positiveText: '确认撤回',
    negativeText: '取消',
    // onPositiveClick 不返回 Promise → Naive UI 会立即关闭弹窗，
    // 彻底避免「等待异步期间确认按钮仍可被多次点击」的并发问题。
    // 撤回的异步逻辑在弹窗关闭后继续执行，状态由 store 内的 undoing 锁保护。
    onPositiveClick: () => {
      void git.undoCommit(count).then((res) => {
        if (res.ok) {
          message.success(res.message)
          // 撤回成功后，把被撤回提交的完整 message 抛给父组件
          emit('undo', commit.message)
        } else {
          dialog.error({
            title: '撤回失败',
            content: res.message,
            positiveText: '知道了'
          })
        }
      })
    }
  })
}
</script>

<template>
  <div class="history" :class="{ 'history--collapsed': !expanded }">
    <!-- 头部：可点击收起/展开 -->
    <div class="history__head" @click="emit('toggle')">
      <div class="history__title">
        <ChevronDown :size="16" class="history__chevron" />
        <GitCommit :size="14" />
        提交历史
        <span class="history__count">{{ logs.length }}</span>
      </div>

      <div class="history__meta" @click.stop>
        <NTag v-if="branch?.current" size="tiny" round :bordered="false" type="info">
          <template #icon><GitBranch :size="12" /></template>
          {{ branch.current }}
        </NTag>
        <span v-if="aheadBehind" class="history__ab">{{ aheadBehind }}</span>
        <!-- 拉取按钮 -->
        <button
          class="history__pull"
          :disabled="git.pulling"
          :title="`拉取远端 ${branch?.behind ?? 0} 个提交（rebase 合并）`"
          @click="onPull"
        >
          <CloudDownload :size="14" :class="{ 'icon-spin--active': git.pulling }" />
          <span class="history__pull-text">拉取</span>
        </button>
        <!-- 推送按钮：本地有未推送提交时显示 -->
        <button
          v-if="hasUnpushed"
          class="history__push"
          :disabled="git.pushing"
          :title="`推送 ${branch?.ahead ?? 0} 个本地提交到远程`"
          @click="onPush"
        >
          <CloudUpload :size="14" :class="{ 'icon-spin--active': git.pushing }" />
          <span class="history__push-text">推送</span>
        </button>
        <button
          class="history__iconbtn"
          title="刷新"
          :disabled="refreshing"
          @click="emit('refresh')"
        >
          <RefreshCw :size="14" class="icon-spin" :class="{ 'icon-spin--active': refreshing }" />
        </button>
      </div>
    </div>

    <!-- 内容：收起时高度塌缩 -->
    <div class="history__body-wrap">
      <div class="history__body">
        <NScrollbar v-if="logs.length">
          <div
            v-for="(c, i) in logs"
            :key="c.hash"
            class="commit"
            :class="{ 'commit--last': i === logs.length - 1 }"
            :style="{ '--stagger': i }"
          >
            <!-- 时间线竖线：精确对准 dot 水平中心 -->
            <div class="commit__rail">
              <div class="commit__dot"></div>
              <div v-if="i !== logs.length - 1" class="commit__line"></div>
            </div>

            <div class="commit__main">
              <div class="commit__msg">{{ firstLine(c.message) }}</div>
              <div class="commit__sub">
                <code class="commit__hash">{{ c.hashShort }}</code>
                <span class="commit__author">{{ c.author }}</span>
                <span class="commit__time">{{ relTime(c.date) }}</span>
                <!-- 推送状态标识 -->
                <span
                  v-if="c.pushed"
                  class="commit__push commit__push--done"
                  title="已推送到远程"
                >
                  <Cloud :size="11" />
                </span>
                <span
                  v-else
                  class="commit__push commit__push--local"
                  title="本地提交，尚未推送"
                >
                  <CloudOff :size="11" />
                  未推送
                </span>
                <!-- 撤回按钮：仅未推送提交显示，hover 时浮现 -->
                <button
                  v-if="!c.pushed"
                  class="commit__undo"
                  :title="`撤回到此提交之前（共 ${i + 1} 个）`"
                  @click.stop="onUndo(i, c)"
                >
                  <Undo2 :size="12" />
                </button>
              </div>
            </div>
          </div>
        </NScrollbar>
        <div v-else class="history__empty-wrap">
          <div class="empty-guide">
            <div class="empty-guide__icon"><History :size="22" /></div>
            <div class="empty-guide__title">还没有提交记录</div>
            <div class="empty-guide__desc">开始你的第一次提交吧</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.history {
  /* 撑满 split 给的格子；pane 高度由外层 n-split 的 size 控制
     （收起时 pane-2 被压缩到约等于头部高度，向下让出空间给变更列表）。
     白底卡片：浮起于灰色画布，圆角裁剪，与上方「变更」卡片靠缝隙分隔。 */
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border-radius: var(--r-lg);
  overflow: hidden;
  min-width: 0;
}

/* 头部 */
.history__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-2) var(--sp-4);
  /* 卡片内头部与正文同色（透明），仅靠字重区分标题，不画分隔线 */
  gap: var(--sp-2);
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
  transition: background var(--dur-fast) var(--ease-standard);
}

.history__head:hover {
  background: var(--bg-hover);
}

.history__title {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-primary);
}

/* chevron 收起时旋转 */
.history__chevron {
  color: var(--text-tertiary);
  transition: transform var(--dur-base) var(--ease-standard);
}

.history--collapsed .history__chevron {
  transform: rotate(-90deg);
}

.history__count {
  color: var(--text-tertiary);
  font-weight: 500;
}

.history__meta {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.history__ab {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text-secondary);
}

.history__iconbtn {
  color: var(--text-tertiary);
  padding: var(--sp-1);
  border-radius: var(--r-sm);
  display: grid;
  place-items: center;
  transition: color var(--dur-fast), background var(--dur-fast);
}

.history__iconbtn:hover {
  color: var(--text-primary);
  background: var(--bg-app);
}

.history__iconbtn:disabled {
  cursor: default;
  opacity: 0.6;
}

/* 推送按钮（头部，本地有未推送提交时显示） */
.history__push {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: var(--fs-xs);
  font-weight: 500;
  color: var(--text-on-brand);
  background: var(--brand);
  padding: 2px var(--sp-2);
  border-radius: var(--r-full, 9999px);
  transition: background var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard),
    opacity var(--dur-fast) var(--ease-standard);
}
.history__push:hover:not(:disabled) {
  background: var(--brand-hover);
  transform: translateY(-1px);
}
.history__push:disabled {
  opacity: 0.6;
  cursor: default;
}
.history__push-text {
  line-height: 1;
}

/* 拉取按钮（头部，远端有未拉取提交时显示）：次级操作，用次级色调，与推送按钮主次分明 */
.history__pull {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: var(--fs-xs);
  font-weight: 500;
  color: var(--text-secondary);
  background: var(--bg-hover);
  padding: 2px var(--sp-2);
  border-radius: var(--r-full, 9999px);
  transition: background var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard),
    opacity var(--dur-fast) var(--ease-standard);
}
.history__pull:hover:not(:disabled) {
  background: var(--bg-selected);
  color: var(--text-primary);
  transform: translateY(-1px);
}
.history__pull:disabled {
  opacity: 0.6;
  cursor: default;
}
.history__pull-text {
  line-height: 1;
}

/* 内容容器：展开时撑满头部以下剩余空间；收起时整块隐藏
   （pane 高度由 n-split 压到≈头部高度，向下让出空间给变更列表） */
.history__body-wrap {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.history--collapsed .history__body-wrap {
  display: none;
}

.history__body {
  height: 100%;
  padding: var(--sp-2) var(--sp-3);
  display: flex;
  flex-direction: column;
}

.history__empty-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-4);
}

.empty-guide {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--sp-1);
  animation: fade-in var(--dur-slow) var(--ease-standard) both;
}

@keyframes fade-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

.empty-guide__icon {
  width: 42px;
  height: 42px;
  border-radius: var(--r-lg);
  display: grid;
  place-items: center;
  color: var(--brand);
  background: var(--bg-selected);
  margin-bottom: var(--sp-1);
}

.empty-guide__title {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.empty-guide__desc {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  line-height: 1.6;
}

/* 单条提交 */
.commit {
  position: relative;
  display: flex;
  gap: var(--sp-2);
  padding: var(--sp-1) 0;
  animation: commit-in var(--dur-slow) var(--ease-standard) both;
  animation-delay: calc(var(--stagger, 0) * 18ms);
}

@keyframes commit-in {
  from { opacity: 0; transform: translateX(-4px); }
  to { opacity: 1; transform: translateX(0); }
}

/* 时间线轨道：dot 与 line 在同一垂直线上，确保对齐 */
.commit__rail {
  position: relative;
  width: 16px;
  flex-shrink: 0;
  display: flex;
  justify-content: center;
  padding-top: 4px;
}

.commit__dot {
  width: 10px;
  height: 10px;
  border-radius: var(--r-full, 9999px);
  background: var(--bg-panel);
  border: 2px solid var(--text-tertiary);
  z-index: 1;
  transition: border-color var(--dur-base), background var(--dur-base);
}

/* 第一条（最新）用品牌色实心强调 */
.commit:first-child .commit__dot {
  border-color: var(--brand);
  background: var(--brand);
}

.commit:hover .commit__dot {
  border-color: var(--brand);
}

/* 竖线：从 dot 中心向下延伸 */
.commit__line {
  position: absolute;
  top: 9px; /* dot 中心 = padding-top(4) + dot半径(5) */
  bottom: -4px;
  width: 2px;
  background: var(--border);
}

.commit__main {
  flex: 1;
  min-width: 0;
  padding-bottom: var(--sp-2);
}

.commit__msg {
  font-size: var(--fs-sm);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.5;
}

.commit__sub {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-top: 3px;
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
}

.commit__hash {
  font-family: var(--font-mono);
  color: var(--brand);
}

.commit__author {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 推送状态标识（每条提交） */
.commit__push {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 10px;
  white-space: nowrap;
  flex-shrink: 0;
  margin-left: auto;
  padding-left: var(--sp-1);
}
.commit__push--done {
  color: var(--text-quaternary, var(--text-tertiary));
  opacity: 0.7;
}
.commit__push--local {
  color: var(--intent-warning, #d97706);
  background: var(--bg-selected);
  padding: 1px var(--sp-2);
  border-radius: var(--r-full, 9999px);
  font-weight: 500;
}

/* 撤回按钮：默认隐藏，hover 提交行时浮现 */
.commit__undo {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  color: var(--text-tertiary);
  border-radius: var(--r-sm);
  flex-shrink: 0;
  opacity: 0;
  transition: color var(--dur-fast) var(--ease-standard),
    background var(--dur-fast) var(--ease-standard),
    opacity var(--dur-fast) var(--ease-standard);
}
.commit:hover .commit__undo {
  opacity: 1;
}
.commit__undo:hover {
  color: var(--intent-error, #dc2626);
  background: var(--bg-app);
}

.commit__time {
  white-space: nowrap;
  margin-left: auto;
}
</style>
