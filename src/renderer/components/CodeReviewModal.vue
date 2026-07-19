<script setup lang="ts">
/**
 * 代码审查结果浮窗
 * --------------------------------------------------
 * 由 AiCommitPanel 底部「代码审查」按钮触发（useCodeReviewStore.open）。
 * 复用 useAiStore.config（provider/key/model），审查对象为未提交的改动（与 commit 同源 diff）。
 *
 * 产出：流式 Markdown（总体评价 + 🔴严重 / 🟡建议 / 🔵可选 分级清单），由 useMarkdown 渲染。
 * 分级标题由 prompt 约束固定输出（emoji + 文字），前端用 CSS 给各级 h2 左侧加 intent 色竖条。
 *
 * 状态机（ReviewPhase）：idle / generating / done / error。
 * 空态（idle 且无结果）显示引导卡；error 显示 NAlert + 重试；generating 显示流式内容 + 停止。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { NModal, NButton, NScrollbar, NAlert, NTag, NProgress, useMessage } from 'naive-ui'
import { ScanEye, CircleStop, RefreshCw, Copy, ClipboardCheck } from 'lucide-vue-next'
import { useCodeReviewStore } from '@/stores/useCodeReviewStore'
import { useMarkdown } from '@/composables/useMarkdown'

const review = useCodeReviewStore()
const message = useMessage()
const { render } = useMarkdown()

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ 'update:show': [v: boolean] }>()

/** 关闭浮窗（走 store.close：若仍在跑会先中断） */
async function onClose(): Promise<void> {
  await review.close()
  emit('update:show', false)
}

/** 重新审查（复用上次选中的文件范围，保持审查对象一致） */
function onRetry(): void {
  void review.retry()
}

/** 复制原始 Markdown 结果到剪贴板（短暂切换图标做反馈） */
const copied = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | null = null
async function onCopy(): Promise<void> {
  if (!review.message.trim()) return
  try {
    await navigator.clipboard.writeText(review.message)
    message.success('已复制到剪贴板')
    if (copyTimer) clearTimeout(copyTimer)
    copied.value = true
    copyTimer = setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch {
    message.error('复制失败，请手动选择文本复制')
  }
}

/** 渲染后的 HTML（供 v-html） */
const rendered = computed(() => render(review.message))

/** 是否处于空态：未开始且无结果 */
const isEmpty = computed(
  () => review.phase === 'idle' && !review.message.trim() && !review.error
)

/** 审查范围文案 */
const scopeLabel = computed(() => (review.source === 'all' ? '全量改动' : '暂存改动'))

/**
 * 假进度条：审查实际进度不可知（流式前是黑盒），用一个基于「预估总时长」推进、
 * 但故意不平滑（每次跳变幅度/间隔都带随机）的进度条，让用户有"在动"的体感而非干等。
 *
 * 预估：按审查文件数推算总时长（文件越多 diff 越长，首 token 越久 + 输出越长）。
 * 推进策略：进度随时间渐近 90%，封顶 90% 直到收到首块（message 非空）即填满 100%。
 * 不平滑：定时器间隔与增量都随机化，避免匀速线性推进（那更像是假的）。
 *
 * 全程用百分比（0~100）表达，不混用小数与百分比，避免 min/max 套娃出错。
 */
const progress = ref(0)
/** 预估总时长（ms）：按文件数粗估，单文件 ~1.2s，封顶 45s（审查本就比 commit 慢） */
const EST_MS = computed(() => Math.min(45000, 2500 + review.lastReviewFileCount * 1200))
let progressTimer: ReturnType<typeof setTimeout> | null = null

function stopProgress(): void {
  if (progressTimer) {
    clearTimeout(progressTimer)
    progressTimer = null
  }
}
function startProgress(): void {
  stopProgress()
  progress.value = 3
  const startAt = Date.now()
  // 不规则推进：每次随机间隔 + 随机增量，渐近但不超过 90%
  const tick = (): void => {
    const est = EST_MS.value
    const ratio = Math.min(1, (Date.now() - startAt) / est) // 0~1：归一化耗时
    // 目标进度（百分比）：起始 15%，随时间渐近 90%（非线性，越接近末尾越慢）
    const target = 15 + Math.pow(ratio, 0.8) * 75 // ratio=0→15, ratio=1→90
    // 叠加随机抖动（-2~+6%，偏正），避免每次都精确落在曲线上
    const jitter = (Math.random() * 8) - 2
    const next = Math.max(progress.value + 1, Math.min(90, target + jitter))
    // 只增不减，且封顶 90%
    progress.value = Math.min(90, Math.max(progress.value, next))
    if (progress.value < 90) {
      // 下次跳变：随机 350~900ms
      progressTimer = setTimeout(tick, 350 + Math.random() * 550)
    }
  }
  progressTimer = setTimeout(tick, 400)
}
/** 首块到达：填满进度（done 事件随后到达） */
function fillProgress(): void {
  stopProgress()
  progress.value = 100
}

watch(
  () => review.phase,
  (ph) => {
    if (ph === 'generating') startProgress()
    else stopProgress()
  }
)
// 首块到达即填满
watch(
  () => review.message.trim().length > 0,
  (hasContent) => {
    if (hasContent && review.phase === 'generating') fillProgress()
  }
)
onUnmounted(stopProgress)
</script>

<template>
  <NModal
    :show="props.show"
    preset="card"
    :bordered="false"
    size="huge"
    :title="undefined"
    style="width: min(960px, 92vw); height: 86vh; display: flex; flex-direction: column"
    content-style="flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column"
    :mask-closable="true"
    @update:show="(v: boolean) => !v && onClose()"
  >
    <!-- 头部：标题 + 审查范围 + 操作 -->
    <template #header>
      <div class="cr-head">
        <div class="cr-head__left">
          <ScanEye :size="17" class="cr-head__icon" />
          <span class="cr-head__title">代码审查</span>
          <NTag
            v-if="review.source"
            size="tiny"
            round
            :bordered="false"
            class="cr-head__scope"
          >
            {{ scopeLabel }}
          </NTag>
          <NTag
            v-if="review.truncated"
            size="tiny"
            round
            :bordered="false"
            type="warning"
            class="cr-head__scope"
          >
            部分文件已省略
          </NTag>
        </div>
        <div class="cr-head__right">
          <NButton
            quaternary
            size="small"
            :disabled="!review.message.trim()"
            title="复制审查结果"
            @click="onCopy"
          >
            <template #icon>
              <ClipboardCheck v-if="copied" :size="15" />
              <Copy v-else :size="15" />
            </template>
            复制
          </NButton>
          <NButton
            v-if="review.phase === 'generating'"
            quaternary
            size="small"
            type="error"
            title="停止审查"
            @click="review.abortReview()"
          >
            <template #icon><CircleStop :size="15" /></template>
            停止
          </NButton>
          <NButton
            v-else-if="review.phase === 'error' || review.phase === 'done'"
            quaternary
            size="small"
            type="primary"
            title="重新审查"
            @click="onRetry"
          >
            <template #icon><RefreshCw :size="15" /></template>
            重新审查
          </NButton>
        </div>
      </div>
    </template>

    <!-- 关闭按钮（Naive card preset 自带，这里复用右上角） -->
    <template #header-extra>
      <span />
    </template>

    <!-- 内容区：可滚动，flex:1 + min-height:0（AGENTS.md 布局规范，不写死高度） -->
    <div class="cr-body">
      <!-- 空态引导卡（AGENTS.md：禁用 n-empty，用自定义占位） -->
      <div v-if="isEmpty" class="cr-empty">
        <div class="cr-empty__icon"><ScanEye :size="32" /></div>
        <div class="cr-empty__title">尚未审查</div>
        <div class="cr-empty__desc">点击「重新审查」开始分析当前未提交的改动</div>
      </div>

      <!-- 错误态 -->
      <div v-else-if="review.phase === 'error'" class="cr-error">
        <NAlert type="error" :show-icon="true">{{ review.error || '审查失败' }}</NAlert>
        <div class="cr-error__tip">可检查 AI 配置后重试，或确认当前有可审查的改动。</div>
      </div>

      <!-- 生成中 + 无内容：假进度条（按提示词长度预估、不规则推进），无冗余文字 -->
      <div v-else-if="review.phase === 'generating' && !review.message.trim()" class="cr-loading">
        <NProgress
          type="line"
          :percentage="progress"
          :show-indicator="false"
          :height="8"
          :border-radius="4"
          class="cr-loading__bar"
        />
      </div>

      <!-- 有内容（generating 部分 / done）：流式 Markdown 渲染 -->
      <NScrollbar v-else class="cr-scroll">
        <!-- 生成中指示条 -->
        <div v-if="review.phase === 'generating'" class="cr-streaming">
          <span class="cr-streaming__dot" />审查中…
        </div>
        <!-- eslint-disable-next-line vue/no-v-html -- markdown-it html:false 已转义，安全 -->
        <div class="cr-md" v-html="rendered" />
      </NScrollbar>
    </div>
  </NModal>
</template>

<style scoped>
.cr-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  width: 100%;
}
.cr-head__left {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}
.cr-head__icon {
  color: var(--brand);
  flex-shrink: 0;
}
.cr-head__title {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-primary);
}
.cr-head__scope {
  flex-shrink: 0;
}
.cr-head__right {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  flex-shrink: 0;
}

.cr-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* 滚动区撑满。
   height:0 配合 flex:1：让 NScrollbar 的 .n-scrollbar{height:100%} 解析到确定高度。
   仅靠 max-height（在 .n-card 上）不建立确定高度上下文，height:100% 会塌缩到内容高度→不溢出→滚不动。 */
.cr-scroll {
  flex: 1;
  min-height: 0;
  height: 0;
  padding-right: var(--sp-1);
  /* 审查结果需可被光标选中复制（NScrollbar 内部容器需放开 user-select） */
  user-select: text;
  -webkit-user-select: text;
}

/* —— 空态 —— */
.cr-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: var(--sp-2);
  padding: var(--sp-8);
  animation: cr-fade-in var(--dur-base) var(--ease-standard) both;
}
.cr-empty__icon {
  width: 64px;
  height: 64px;
  border-radius: var(--r-xl);
  display: grid;
  place-items: center;
  color: var(--brand);
  background: var(--bg-selected);
  margin-bottom: var(--sp-2);
}
.cr-empty__title {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-primary);
}
.cr-empty__desc {
  font-size: var(--fs-sm);
  color: var(--text-tertiary);
  line-height: 1.6;
  max-width: 320px;
}

/* —— 错误态 —— */
.cr-error {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-2);
}
.cr-error__tip {
  font-size: var(--fs-sm);
  color: var(--text-tertiary);
}

/* —— loading：进度条居中，无冗余文字 —— */
.cr-loading {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-3);
  padding: var(--sp-8);
}
.cr-loading__bar {
  width: min(360px, 80%);
}

/* —— 流式指示 —— */
.cr-streaming {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-xs);
  color: var(--brand);
  margin-bottom: var(--sp-2);
}
.cr-streaming__dot {
  width: 6px;
  height: 6px;
  border-radius: var(--r-full, 9999px);
  background: var(--brand);
  animation: cr-pulse 1s var(--ease-standard) infinite;
}
@keyframes cr-pulse {
  0%,
  100% {
    opacity: 0.4;
    transform: scale(0.8);
  }
  50% {
    opacity: 1;
    transform: scale(1.2);
  }
}

/* —— Markdown 渲染样式（走语义 token，不硬编码颜色） —— */
.cr-md {
  font-size: var(--fs-base);
  line-height: 1.75;
  color: var(--text-primary);
  word-break: break-word;
  /* 审查结果需可被光标选中复制：NModal/NScrollbar 默认可能继承 user-select:none，显式开启 */
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}
.cr-md :deep(p) {
  margin: 0 0 var(--sp-2);
}
.cr-md :deep(h2) {
  font-size: var(--fs-md);
  font-weight: 600;
  margin: var(--sp-4) 0 var(--sp-2);
  padding-left: var(--sp-2);
  color: var(--text-primary);
  border-left: 3px solid var(--border);
  line-height: 1.4;
  scroll-margin-top: var(--sp-3);
}
/* 分级标题着色：useMarkdown 按 emoji 给 h2 打 data-severity，左竖条用 intent 色区分 */
.cr-md :deep(h2[data-severity='critical']) {
  border-left-color: var(--intent-error);
}
.cr-md :deep(h2[data-severity='warning']) {
  border-left-color: var(--intent-warning);
}
.cr-md :deep(h2[data-severity='info']) {
  border-left-color: var(--intent-info);
}

.cr-md :deep(ul),
.cr-md :deep(ol) {
  margin: 0 0 var(--sp-2);
  padding-left: var(--sp-5);
}
.cr-md :deep(li) {
  margin: var(--sp-2) 0;
}
.cr-md :deep(li):hover {
  /* 列表项 hover 轻微背景变深（AGENTS.md 交互反馈） */
  background: var(--bg-hover);
  border-radius: var(--r-sm);
}
/* 文件名行：prompt 约定每条首行为「**文件:行号**」独占一行（其后 <br> 换行接描述）。
   强化首行视觉权重，使其与下方描述明显分组。 */
.cr-md :deep(li > strong:first-child) {
  display: inline-block;
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.5;
  margin-bottom: var(--sp-1);
}
.cr-md :deep(strong) {
  font-weight: 600;
  color: var(--text-primary);
}
.cr-md :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.9em;
  padding: 1px 5px;
  border-radius: var(--r-sm);
  background: var(--bg-selected);
  color: var(--text-primary);
}
.cr-md :deep(pre) {
  margin: 0 0 var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  background: var(--bg-selected);
  overflow-x: auto;
}
.cr-md :deep(pre code) {
  padding: 0;
  background: transparent;
}
.cr-md :deep(blockquote) {
  margin: 0 0 var(--sp-2);
  padding: var(--sp-1) var(--sp-3);
  border-left: 3px solid var(--brand);
  color: var(--text-secondary);
}
.cr-md :deep(a) {
  color: var(--brand);
  text-decoration: none;
  transition: opacity var(--dur-base) var(--ease-standard);
}
.cr-md :deep(a):hover {
  opacity: 0.8;
}

@keyframes cr-fade-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
