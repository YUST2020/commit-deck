<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NSplit } from 'naive-ui'
import { FolderOpen } from 'lucide-vue-next'
import FileStatusPanel from '@/components/FileStatusPanel.vue'
import DiffViewer from '@/components/DiffViewer.vue'
import AiCommitPanel from '@/components/AiCommitPanel.vue'
import CommitHistory from '@/components/CommitHistory.vue'
import { useProjectStore } from '@/stores/useProjectStore'
import { useGitStore } from '@/stores/useGitStore'
import { useAiStore } from '@/stores/useAiStore'

const project = useProjectStore()
const git = useGitStore()
const ai = useAiStore()

/**
 * 撤回成功后：若 AI 面板输入框为空（无草稿、无生成结果），
 * 则把被撤回提交的 message 填充进去，方便用户直接修改后重新提交。
 */
function onUndoCommit(commitMessage: string): void {
  if (!ai.userDraft.trim() && !ai.message.trim()) {
    ai.setUserDraft(commitMessage)
  }
}

const hasProject = computed(() => !!project.active)

/**
 * 左列：变更列表(pane-1, 上) / 提交历史(pane-2, 下)
 * --------------------------------------------------
 * 折叠交互（参考 GitLens / VSCode 面板）：
 * - 收起时，提交历史「向下折叠」为只剩头部，上方变更列表自动撑满腾出的空间；
 * - 展开时，回到收起前的拖拽位置（用 rememberedSize 记忆）；
 * - 初始提交历史占整体高度的 1/3（变更占 2/3）。
 *
 * n-split 的 size = pane-1（变更）占比。受控 + ResizeObserver 量取容器高度，
 * 以便收起时把 pane-2 精确压成「头部高度」，避免出现死区。
 */
const CHANGES_DEFAULT = 2 / 3 // 变更列表初始占比 → 提交历史占 1/3
const HISTORY_HEAD_PX = 28 // 提交历史头部实测高度（padding 4+4 + 内容行 16 + 安全余量）
// 折叠时 pane-2 还含本 pane 的上下间距（4px × 2），需叠加进目标高度，否则头部被裁。
// 该间距值与下方 :deep(.n-split-pane) 的 padding 保持一致。

const leftColRef = ref<HTMLElement | null>(null)
const colHeight = ref(600) // 容器实际高度，ResizeObserver 持续更新

const historySize = ref(CHANGES_DEFAULT) // 受控的 pane-1 占比
const rememberedSize = ref(CHANGES_DEFAULT) // 收起前记忆的位置
const historyExpanded = ref(true)

/** 左右分栏（外层水平 NSplit）：左列初始占比，对齐原 grid 的 0.9fr : 1.4fr
 *  （0.9 / 2.3 ≈ 0.39）。受控 size：切换项目时整块 grid 随 :key 重建，
 *  但本 ref 在 setup 层，故拖拽位置在项目间保留（符合「拖一次定格局」的直觉）。 */
const hSplitSize = ref(0.39)

/** 收起态下 pane-1 的占比：让 pane-2 ≈ 头部高度 + 卡片上下间距 */
const collapsedSize = computed(() => {
  const h = colHeight.value || 600
  // pane-2 目标高度 = 头部实测 + 卡片上下 padding（CARD_GAP_CSS × 2）
  const pane2Target = HISTORY_HEAD_PX + 8 // 8 = 上下各 4px 间距
  const size = 1 - pane2Target / h
  return Math.max(0.5, Math.min(0.97, size))
})

/** 实际绑定到 n-split 的 size：展开用记忆位置，收起用压缩值 */
const effectiveSize = computed(() =>
  historyExpanded.value ? historySize.value : collapsedSize.value
)

/** 拖拽时同步更新；仅在展开态下记忆，避免被收起态的压缩值写脏 */
function onSizeUpdate(v: number): void {
  if (!historyExpanded.value) return
  historySize.value = v
  rememberedSize.value = v
}

/** 头部点击：切换展开/收起；展开时恢复记忆位置 */
function onToggle(): void {
  historyExpanded.value = !historyExpanded.value
  if (historyExpanded.value) historySize.value = rememberedSize.value
}

let ro: ResizeObserver | null = null
function measure(): void {
  if (leftColRef.value) colHeight.value = leftColRef.value.clientHeight
}

/** 窗口聚焦时执行节流刷新，确保看到的是最新 git 状态 */
function onWindowFocus(): void {
  if (hasProject.value) {
    git.refreshAllThrottled()
  }
}

onMounted(() => {
  measure()
  if (leftColRef.value && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => measure())
    ro.observe(leftColRef.value)
  }
  if (hasProject.value) git.refreshAll()

  window.addEventListener('focus', onWindowFocus)
})
onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
  window.removeEventListener('focus', onWindowFocus)
})
</script>

<template>
  <div class="workspace">
    <!-- 无项目空态：自定义占位卡片（AGENTS.md 禁用 n-empty） -->
    <div v-if="!hasProject" class="workspace__empty">
      <div class="workspace__empty-card">
        <div class="workspace__empty-icon">
          <FolderOpen :size="32" />
        </div>
        <div class="workspace__empty-title">未选择项目</div>
        <div class="workspace__empty-desc">从左侧选择一个项目，或添加一个新项目开始</div>
      </div>
    </div>

    <!-- 工作台：切换项目时用 keyed <Transition> 做淡入淡出，
         不再用居中大 spinner 替换整块（那样会卸载右侧造成闪屏）。
         - grid 绑定 :key="project.activeId"，项目变化即整块重建；
         - 外层 <Transition> + mode="out-in"：旧内容先淡出、新内容再淡入，
           避免新旧同屏叠加错位，过渡一气呵成。
         新项目初始为空数据（各面板自带空态），随 git 数据到位自动填充，
         配合面板自身的局部 loading 反馈（刷新图标旋转）。 -->
    <Transition v-else name="workspace-switch" mode="out-in">
      <div :key="project.activeId ?? 'none'" class="workspace__grid">
        <!-- 左右分栏：外层水平 n-split（可拖拽分割）。
             命中热区藏在两列卡片的竖向缝隙里，抓手是中间一个小竖胶囊，
             与内部纵向拖拽条（横胶囊）视觉对称、风格统一。
             两列 pane 各自的横向 padding（--sp-2）合成左右卡片缝隙，
             透出灰色画布，卡片圆角在缝隙两侧自然显现（与纵向缝隙一致）。 -->
        <NSplit
          direction="horizontal"
          :min="0.2"
          :max="0.75"
          :size="hSplitSize"
          :resize-trigger-size="9"
          @update:size="(v: number) => (hSplitSize = v)"
        >
          <template #1>
            <!-- 左列：变更列表(上) / 提交历史(下)
                 内部用 n-split 可拖拽分割；收起提交历史时向下折叠、把空间让给变更。 -->
            <div ref="leftColRef" class="workspace__col workspace__col--left">
              <NSplit
                direction="vertical"
                :min="0.2"
                :max="historyExpanded ? 0.85 : 0.98"
                :size="effectiveSize"
                :resize-trigger-size="9"
                class="workspace__split-left"
                :class="{ 'workspace__split--collapsed': !historyExpanded }"
                @update:size="onSizeUpdate"
              >
                <template #1>
                  <FileStatusPanel
                    :files="git.files"
                    :selected="git.selectedPath"
                    :staged="git.stagedFiles"
                    :unstaged="git.unstagedFiles"
                    :loading="git.loading"
                    @select="(p, s, r) => git.selectFile(p, s, r)"
                    @stage="(f) => git.stage(f)"
                    @unstage="(f) => git.unstage(f)"
                    @refresh="git.refreshAll()"
                  />
                </template>
                <template #2>
                  <CommitHistory
                    :logs="git.logs"
                    :branch="git.branch"
                    :expanded="historyExpanded"
                    :refreshing="git.refreshingLog"
                    @refresh="git.refreshLog()"
                    @toggle="onToggle"
                    @undo="onUndoCommit"
                  />
                </template>
              </NSplit>
            </div>
          </template>

          <template #2>
            <!-- 右列：AI 提交信息(上) / 变更详情(下) -->
            <div class="workspace__col workspace__col--right">
              <NSplit
                direction="vertical"
                :min="0.2"
                :default-size="0.42"
                :max="0.7"
                :resize-trigger-size="9"
              >
                <template #1>
                  <AiCommitPanel />
                </template>
                <template #2>
                  <DiffViewer
                    :file="git.selectedPath ?? ''"
                    :diff="git.diffText"
                    :loading="git.loadingDiff"
                  />
                </template>
              </NSplit>
            </div>
          </template>
        </NSplit>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.workspace {
  height: 100%;
  background: var(--bg-app);
  position: relative;
  overflow: hidden;
}

.workspace__empty {
  height: 100%;
  display: grid;
  place-items: center;
}

.workspace__empty-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--sp-2);
  padding: var(--sp-8);
  animation: empty-fade-in var(--dur-base) var(--ease-standard) both;
}

.workspace__empty-icon {
  width: 64px;
  height: 64px;
  border-radius: var(--r-xl);
  display: grid;
  place-items: center;
  color: var(--brand);
  background: var(--bg-selected);
  margin-bottom: var(--sp-2);
}

.workspace__empty-title {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-primary);
}

.workspace__empty-desc {
  font-size: var(--fs-sm);
  color: var(--text-tertiary);
  line-height: 1.6;
  max-width: 280px;
}

@keyframes empty-fade-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 左右两列栅格 → 现为「灰色画布」容器：内部改用水平 n-split 排两列，
   本容器只负责画布背景 + 四周 padding（给卡片呼吸空间）。
   列间缝隙由各 pane 的横向 padding 合成（见下方 .n-split-pane）。 */
.workspace__grid {
  height: 100%;
  background: var(--bg-app);
  padding: var(--sp-3);
  box-sizing: border-box;
}

/* 外层水平 split 撑满画布 */
.workspace__grid :deep(> .n-split) {
  height: 100%;
}

/* 两列都是灰色画布的一部分（透明，透出 grid 的 --bg-app 底）。
   卡片浮起感由内部面板的 --bg-panel + 圆角 + margin 提供。 */
.workspace__col {
  height: 100%;
  min-width: 0;
  overflow: hidden;
  background: transparent;
}

.workspace__col :deep(.n-split) {
  height: 100%;
}

/* 卡片间距：
   - 外层水平 split 的 pane：左右各留 --sp-2 padding，合成左右卡片竖向缝隙；
   - 内层纵向 split 的 pane：上下各留 --sp-2 padding，合成上下卡片横向缝隙。
   首尾 pane 的外侧不再叠加间距，避免与画布 padding 双重留白。 */
.workspace__grid :deep(> .n-split > .n-split-pane) {
  padding-left: var(--sp-2);
  padding-right: var(--sp-2);
}
.workspace__grid :deep(> .n-split > .n-split-pane-1) {
  padding-left: 0;
}
.workspace__grid :deep(> .n-split > .n-split-pane-2) {
  padding-right: 0;
}

.workspace__col :deep(.n-split-pane) {
  padding-top: var(--sp-2);
  padding-bottom: var(--sp-2);
}
/* 首个 pane 顶部紧贴 grid padding，不再叠加间距；末个 pane 底部同理，
   避免与画布 padding 双重留白。 */
.workspace__col :deep(.n-split-pane-1) {
  padding-top: 0;
}
.workspace__col :deep(.n-split-pane-2) {
  padding-bottom: 0;
}

/* NSplit 拖拽区：Naive UI 实际类名是 .n-split__resize-trigger(wrapper) +
   .n-split__resize-trigger 子元素。此前写成了不存在的 .n-split-bar，
   导致默认灰色条常驻——这正是「拖拽线突兀」的根因。
   重设计原则：拖拽条本体「永远透明」，所有视觉信号都由中间一个胶囊形
   抓手（::after）单一承担，避免出现满宽粗条 + 中间细条叠加的杂乱感。
   - 命中热区 9px 藏在卡片缝隙里，更好抓；
   - 默认就有一个极淡的小圆点暗示「这里可拖」；
   - hover/拖拽时圆点变品牌色、轻微放大，反馈克制但清晰。

   ★ 关键：水平 split 与纵向 split 的 trigger 同属一个 DOM 子树
   （内层 trigger 是外层 grid 的后代），若用 .workspace__grid / .workspace__col
   这类存在包含关系的作用域，hover 规则会交叉污染——外层设 height、内层设 width，
   两条叠加成 32×32 方块被圆角裁成「圆形」。故改用 Naive 自带的方向修饰类
   .n-split--horizontal / .n-split--vertical 做精确隔离，互不干扰。
   选择器整体放进单个 :deep()（含 ::after），确保 Vue scoped 编译正确拼接。 */

/* 命中区（wrapper）：永远透明，仅做尺寸/热区。两个方向共用。 */
:deep(.n-split__resize-trigger-wrapper) {
  position: relative;
  background-color: transparent;
}

/* 触发条本体：永远透明。 */
:deep(.n-split__resize-trigger) {
  background-color: transparent !important;
}

/* —— 外层水平 split：竖胶囊（高 > 宽）—— */
:deep(.n-split--horizontal > .n-split__resize-trigger-wrapper)::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 3px;
  height: 24px;
  border-radius: var(--r-full, 9999px);
  background-color: var(--text-tertiary);
  opacity: 0.35;
  transition: height var(--dur-base) var(--ease-standard),
    opacity var(--dur-base) var(--ease-standard),
    background-color var(--dur-base) var(--ease-standard);
  pointer-events: none;
}
:deep(.n-split--horizontal > .n-split__resize-trigger-wrapper:hover::after) {
  height: 32px;
  opacity: 1;
  background-color: var(--brand);
}

/* —— 内层纵向 split：横胶囊（宽 > 高）—— */
:deep(.n-split--vertical > .n-split__resize-trigger-wrapper)::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 24px;
  height: 3px;
  border-radius: var(--r-full, 9999px);
  background-color: var(--text-tertiary);
  opacity: 0.35;
  transition: width var(--dur-base) var(--ease-standard),
    opacity var(--dur-base) var(--ease-standard),
    background-color var(--dur-base) var(--ease-standard);
  pointer-events: none;
}
:deep(.n-split--vertical > .n-split__resize-trigger-wrapper:hover::after) {
  width: 32px;
  opacity: 1;
  background-color: var(--brand);
}

/* 折叠态下禁用拖拽手势，并隐藏抓手 pill（保持 9px 间距占位即可） */
.workspace__split--collapsed :deep(.n-split__resize-trigger-wrapper) {
  cursor: default !important;
}
.workspace__split--collapsed :deep(.n-split__resize-trigger-wrapper)::after {
  display: none !important;
}

/* 收起/展开过渡：仅过渡 pane-1 的 flex-basis，
   pane-2（flex:1）随之自然跟随，呈现「向下折叠」的平滑动画。 */
.workspace__col--left :deep(.n-split-pane-1) {
  transition: flex-basis var(--dur-slow) var(--ease-standard);
}

/* 切换项目时的淡入淡出（仅 opacity，GPU 友好）。
   时长用 --dur-slow(260ms) + 项目标准缓动，与全局动效一致。 */
.workspace-switch-enter-active,
.workspace-switch-leave-active {
  transition: opacity var(--dur-slow) var(--ease-standard);
}

.workspace-switch-enter-from,
.workspace-switch-leave-to {
  opacity: 0;
}
</style>
