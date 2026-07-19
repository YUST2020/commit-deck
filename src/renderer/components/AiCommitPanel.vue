<script setup lang="ts">
/**
 * AI 提交信息面板（统一布局）。
 *
 * 统一结构：前缀条 → 主体（单一文本区，idle 作草稿 / generating 作流式 / editing 作结果）
 *           → 始终显示的工具栏（详细开关 + 来源/忽略提示 + 操作按钮）。
 *
 * 交互流：
 *   idle       → 草稿框（可选）+ [生成]；详细开关可先调
 *   generating → 流式输出 + [停止]
 *   editing    → 可编辑结果 + [重新生成] / [提交] / [提交并推送]
 *   error      → 错误提示 + [重试]
 *
 * 被忽略/截断的文件：工具栏显示计数，点击弹层查看明细。
 */
import { computed, ref } from 'vue'
import {
  NButton,
  NInput,
  NModal,
  NPopover,
  NTag,
  NAlert,
  NSwitch,
  NSpace,
  NTooltip,
  NScrollbar,
  NText,
  useMessage,
  useDialog
} from 'naive-ui'
import {
  Sparkles,
  CircleStop,
  RefreshCw,
  Check,
  CircleAlert,
  Settings2,
  HelpCircle,
  Plus,
  ListPlus,
  CloudUpload,
  FileWarning,
  Zap,
  ZapOff,
  ScanEye
} from 'lucide-vue-next'
import type { AiServiceConfig, CommitPrefix, OmittedFile } from '@shared/index'
import { useAiStore } from '@/stores/useAiStore'
import { useGitStore } from '@/stores/useGitStore'
import { useCodeReviewStore } from '@/stores/useCodeReviewStore'
import AiServiceConfigModal from './AiServiceConfigModal.vue'
import PrefixManager from './PrefixManager.vue'
import CodeReviewModal from './CodeReviewModal.vue'
import ReviewFilePicker from './ReviewFilePicker.vue'

const ai = useAiStore()
const git = useGitStore()
const review = useCodeReviewStore()
const message = useMessage()
const dialog = useDialog()

const noPrefixSelected = computed(() => !ai.selectedPrefixId)

/** 主体文本区当前显示的值（idle 用草稿；其余用 message） */
const bodyValue = computed(() =>
  ai.phase === 'idle' ? ai.userDraft : ai.message
)
function onBodyInput(v: string): void {
  if (ai.phase === 'idle') {
    // idle 态：写入草稿，setUserDraft 内部已 debounce 落盘到当前项目
    ai.setUserDraft(v)
  } else {
    // editing 态：直接改 message，并 debounce 落盘到当前项目
    ai.message = v
    ai.scheduleSaveDraft()
  }
}
/** 主体 placeholder */
const bodyPlaceholder = computed(() => {
  switch (ai.phase) {
    case 'idle':
      return '请输入提交信息，输入内容会作为AI参考'
    case 'editing':
      return '提交信息（可编辑）'
    default:
      return ''
  }
})

/* ---------- 被忽略文件辅助 ---------- */
function omittedLabel(reason: OmittedFile['reason']): string {
  switch (reason) {
    case 'binary':
      return '二进制'
    case 'generated':
      return '产物'
    case 'too_large':
      return '过大'
    case 'size_limit':
      return '总量限制'
    default:
      return '已省略'
  }
}
function omittedTagType(reason: OmittedFile['reason']): 'default' | 'warning' | 'info' {
  // size_limit 用 warning（整体截断，影响较大），其余用 info
  return reason === 'size_limit' ? 'warning' : 'info'
}
function omittedReasonText(files: OmittedFile[]): string {
  const counts: Record<string, number> = {}
  for (const f of files) counts[f.reason] = (counts[f.reason] ?? 0) + 1
  const parts = Object.entries(counts).map(([k, n]) => `${omittedLabel(k as OmittedFile['reason'])} ${n}`)
  return '合计：' + parts.join(' · ')
}

/** 快捷新增前缀弹窗状态（Electron 沙箱不支持 window.prompt，改用自有弹窗） */
const quickAddOpen = ref(false)
const quickAddValue = ref('')

function openQuickAdd(): void {
  quickAddValue.value = ''
  quickAddOpen.value = true
}

function confirmQuickAdd(): void {
  const label = quickAddValue.value.trim()
  if (!label) return
  void ai.addPrefix(label).then(() => {
    const created = ai.prefs?.prefixes.slice(-1)[0]
    if (created) void ai.selectPrefix(created.id)
  })
  quickAddOpen.value = false
}

function onSelectPrefix(id: string | null): void {
  void ai.selectPrefix(id)
}

function onConfigSave(payload: { config: AiServiceConfig; rules: string }): void {
  void ai.saveConfig(payload.config)
  void ai.updateRules(payload.rules)
  message.success('已保存')
}

async function onPrefixSave(prefixes: CommitPrefix[]): Promise<void> {
  await ai.setPrefixes(prefixes)
}

function onGenerate(): void {
  if (!ai.canGenerate) {
    message.info('当前没有可生成的改动')
    return
  }
  void ai.generate()
}

function onAbort(): void {
  void ai.abort()
}

async function onCommit(push: boolean): Promise<void> {
  // 如果在 idle 态且有草稿，先同步到 message，供 ai.commit 使用
  if (ai.phase === 'idle' && ai.userDraft.trim()) {
    ai.message = ai.userDraft.trim()
  }

  const msg = ai.message.trim()
  if (!msg) {
    message.warning('提交信息为空')
    return
  }
  const res = await ai.commit({ push })
  if (res.ok) {
    if (res.message.startsWith('已提交，但推送失败')) {
      message.success('已提交')
      dialog.error({
        title: '推送失败',
        content: res.message.replace('已提交，但推送失败：', ''),
        positiveText: '知道了'
      })
    } else {
      message.success(res.message)
      // 提交成功后显式清空内存状态，确保 UI 立即响应
      ai.setUserDraft('')
      ai.message = ''
      ai.phase = 'idle'
    }
  } else {
    dialog.error({
      title: push ? '提交/推送失败' : '提交失败',
      content: res.message,
      positiveText: '知道了'
    })
  }
}
</script>

<template>
  <div class="ai">
    <!-- 头部：标题 + 设置 -->
    <div class="ai__head">
      <Sparkles :size="15" class="ai__head-icon" />
      <span class="ai__head-title">AI 提交信息</span>
      <span class="ai__head-spacer" />
      <NTag
        v-if="git.stagedCount"
        size="tiny"
        round
        :bordered="false"
        type="success"
        class="ai__head-tag"
      >
        {{ git.stagedCount }} 已暂存
      </NTag>
      <button class="ai__icon-btn" title="AI 服务配置" @click="ai.configModalOpen = true">
        <Settings2 :size="15" />
      </button>
    </div>

    <!-- 前缀选择条：分段胶囊式（用 div 规避原生 button 默认样式） -->
    <div class="px">
      <span class="px__label">前缀</span>
      <NScrollbar x-scrollable class="px__scroll">
        <div class="px__track">
          <div
            class="px__item"
            :class="{ 'px__item--active': noPrefixSelected }"
            role="button"
            tabindex="0"
            title="不添加前缀"
            @click="onSelectPrefix(null)"
            @keydown.enter.prevent="onSelectPrefix(null)"
          >
            无
          </div>
          <div
            v-for="p in ai.prefs?.prefixes ?? []"
            :key="p.id"
            class="px__item"
            :class="{ 'px__item--active': ai.selectedPrefixId === p.id }"
            role="button"
            tabindex="0"
            :title="`提交信息以 ${p.label} 开头`"
            @click="onSelectPrefix(p.id)"
            @keydown.enter.prevent="onSelectPrefix(p.id)"
          >
            {{ p.label }}
          </div>
        </div>
      </NScrollbar>
      <div class="px__actions">
        <div
          class="px__btn"
          role="button"
          tabindex="0"
          title="快捷新增前缀"
          @click="openQuickAdd"
          @keydown.enter.prevent="openQuickAdd"
        >
          <Plus :size="13" />
        </div>
        <div
          class="px__btn"
          role="button"
          tabindex="0"
          title="管理前缀"
          @click="ai.prefixModalOpen = true"
          @keydown.enter.prevent="ai.prefixModalOpen = true"
        >
          <ListPlus :size="13" />
        </div>
      </div>
    </div>

    <!-- 主体：统一文本区（idle=草稿 / generating=流式 / editing=结果） -->
    <div class="ai__body">
      <!-- 错误态：覆盖式提示 -->
      <NAlert
        v-if="ai.phase === 'error'"
        type="error"
        :bordered="false"
        class="ai__error"
      >
        <template #icon><CircleAlert :size="15" /></template>
        {{ ai.error || '生成失败，请检查配置与网络' }}
      </NAlert>

      <!-- 统一文本区（idle=草稿 / editing=结果） -->
      <NInput
        v-else-if="ai.phase !== 'generating'"
        :value="bodyValue"
        type="textarea"
        :placeholder="bodyPlaceholder"
        :autosize="{ minRows: 4, maxRows: 14 }"
        class="ai__textarea"
        @update:value="onBodyInput"
      />

      <!-- 生成中：专用流式展示（不置灰，品牌色调 + 光标 + 加载条） -->
      <div v-else class="ai__stream">
        <div class="ai__stream-bar">
          <span class="ai__stream-dot" />
          <span class="ai__stream-label">生成中</span>
        </div>
        <div class="ai__stream-out">
          <span v-if="!ai.message" class="ai__stream-wait">等待响应…</span>
          <template v-else>{{ ai.message }}</template>
          <span class="ai__stream-caret" />
        </div>
      </div>

      <!-- 未配置提示（idle） -->
      <div v-if="ai.phase === 'idle' && !ai.isConfigured" class="ai__nokey">
        <CircleAlert :size="12" />
        <NText depth="3">未配置 API Key，请在右上角设置中配置</NText>
      </div>
    </div>

    <!-- 工具栏（始终显示） -->
    <div class="ai__bar">
      <!-- 左：详细开关（idle/editing 均可调） -->
      <div
        v-if="ai.phase === 'idle' || ai.phase === 'editing'"
        class="ai__detail"
        @click="ai.toggleDetailed(!ai.prefs?.detailed)"
      >
        <NSwitch
          size="small"
          :value="ai.prefs?.detailed ?? false"
          :rubber-band="false"
          @click.stop
          @update:value="(v) => ai.toggleDetailed(v)"
        />
        <NText class="ai__detail-text">详细</NText>
        <NTooltip trigger="hover" placement="top" :show-arrow="false">
          <template #trigger>
            <div class="flex items-center" @click.stop>
              <HelpCircle :size="13" class="ai__detail-help" />
            </div>
          </template>
          <div class="flex flex-col gap-1.5 py-1 px-0.5">
            <div class="font-bold text-xs">详细模式</div>
            <div class="text-xs opacity-90 leading-relaxed">
              开启：生成首行概要后，追加具体的改动要点列表。<br />
              关闭：仅生成一行精简的提交信息。
            </div>
          </div>
        </NTooltip>
      </div>

      <!-- 左：被忽略文件计数（可点击查看明细） -->
      <NPopover
        v-if="ai.omittedFiles.length"
        trigger="click"
        placement="top"
        :width="420"
      >
        <template #trigger>
          <button class="ai__omitted" title="查看被忽略的文件">
            <FileWarning :size="12" />
            {{ ai.omittedFiles.length }} 个文件已折叠
          </button>
        </template>
        <div class="omitted">
          <div class="omitted__title">以下文件内容已折叠</div>
          <div class="omitted__list">
            <div
              v-for="(f, i) in ai.omittedFiles"
              :key="i"
              class="omitted__row"
            >
              <span class="omitted__path" :title="f.path">{{ f.path }}</span>
              <NTag
                size="tiny"
                :bordered="false"
                :type="omittedTagType(f.reason)"
                round
                class="omitted__tag"
              >
                {{ omittedLabel(f.reason) }}
              </NTag>
              <!-- 强制包含开关：非二进制可点（点击后下次生成发送全文）；
                   二进制强制无效，禁用 + tooltip 说明 -->
              <NTooltip v-if="f.reason !== 'binary'">
                <template #trigger>
                  <button
                    class="omitted__force"
                    :class="{ 'omitted__force--on': ai.isForceIncluded(f.path) }"
                    :title="ai.isForceIncluded(f.path) ? '取消强制包含' : '强制包含（下次生成发送全文）'"
                    @click="ai.toggleForceInclude(f.path)"
                  >
                    <Zap v-if="ai.isForceIncluded(f.path)" :size="12" />
                    <ZapOff v-else :size="12" />
                  </button>
                </template>
                {{ ai.isForceIncluded(f.path)
                  ? '已设为强制包含：下次生成将尽量发送该文件全文（总量超限时部分截断）'
                  : '强制包含：下次生成将尽量发送该文件全文（总量超限时部分截断）' }}
              </NTooltip>
              <NTooltip v-else>
                <template #trigger>
                  <button class="omitted__force omitted__force--disabled" disabled>
                    <ZapOff :size="12" />
                  </button>
                </template>
                二进制内容无法解析，不可强制包含
              </NTooltip>
            </div>
          </div>
          <div class="omitted__note">{{ omittedReasonText(ai.omittedFiles) }}</div>
          <!-- 有强制包含项时显示「重新生成」按钮，触发带上强制文件全文的新请求 -->
          <NButton
            v-if="ai.forceIncludePaths.length"
            size="small"
            type="primary"
            block
            class="omitted__regen"
            @click="onGenerate"
          >
            <template #icon><RefreshCw :size="14" /></template>
            重新生成（含 {{ ai.forceIncludePaths.length }} 个强制文件）
          </NButton>
        </div>
      </NPopover>

      <span class="ai__bar-spacer" />

      <!-- 右：随状态变化的操作 -->
      <!-- 代码审查入口：贴在生成按钮左侧（spacer 之后、状态操作组之前），
           先弹树状文件选择器，确认范围后再审查 -->
      <NButton
        size="small"
        quaternary
        class="ai__review-btn"
        :loading="review.phase === 'generating'"
        title="选择文件并审查当前未提交的改动"
        @click="review.openPicker()"
      >
        <template #icon><ScanEye :size="14" /></template>
        代码审查
      </NButton>

      <template v-if="ai.phase === 'idle'">
        <NButton size="small" secondary :disabled="!ai.canGenerate" @click="onGenerate">
          <template #icon><Sparkles :size="14" /></template>
          生成
        </NButton>
        <NButton
          size="small"
          type="primary"
          :disabled="!bodyValue.trim() || !git.stagedCount || ai.commitPushing"
          :loading="ai.committing"
          @click="onCommit(false)"
        >
          <template #icon><Check :size="14" /></template>
          提交
        </NButton>
        <NButton
          size="small"
          type="primary"
          ghost
          :disabled="!bodyValue.trim() || !git.stagedCount || ai.committing"
          :loading="ai.commitPushing"
          @click="onCommit(true)"
        >
          <template #icon><CloudUpload :size="14" /></template>
          提交并推送
        </NButton>
      </template>

      <template v-else-if="ai.phase === 'generating'">
        <NButton size="small" type="error" ghost @click="onAbort">
          <template #icon><CircleStop :size="14" /></template>
          停止
        </NButton>
      </template>

      <template v-else-if="ai.phase === 'editing'">
        <NButton size="small" quaternary @click="onGenerate">
          <template #icon><RefreshCw :size="14" /></template>
          重新生成
        </NButton>
        <NButton size="small" type="primary" :disabled="!git.stagedCount || ai.commitPushing" :loading="ai.committing" @click="onCommit(false)">
          <template #icon><Check :size="14" /></template>
          提交
        </NButton>
        <NButton size="small" type="primary" ghost :disabled="!git.stagedCount || ai.committing" :loading="ai.commitPushing" @click="onCommit(true)">
          <template #icon><CloudUpload :size="14" /></template>
          提交并推送
        </NButton>
      </template>

      <template v-else>
        <!-- error -->
        <NButton size="small" secondary @click="onGenerate">
          <template #icon><RefreshCw :size="14" /></template>
          重试
        </NButton>
        <NButton size="small" quaternary @click="ai.configModalOpen = true">
          <template #icon><Settings2 :size="14" /></template>
          配置
        </NButton>
      </template>
    </div>

    <!-- 配置弹窗（仅加载完毕后挂载） -->
    <AiServiceConfigModal
      v-if="ai.config && ai.prefs"
      v-model:show="ai.configModalOpen"
      :config="ai.config"
      :rules="ai.prefs.customRules"
      @save="onConfigSave"
    />
    <PrefixManager
      v-if="ai.prefs"
      v-model:show="ai.prefixModalOpen"
      :prefixes="ai.prefs.prefixes"
      @save="onPrefixSave"
    />

    <!-- 代码审查结果浮窗（底部「代码审查」按钮触发；审查对象与 commit 同源 diff） -->
    <CodeReviewModal v-model:show="review.modalOpen" />

    <!-- 文件选择器：点「代码审查」先选范围，确认后再审查 -->
    <ReviewFilePicker v-model:show="review.pickerOpen" />

    <!-- 快捷新增前缀弹窗（Electron 沙箱禁用 window.prompt） -->
    <NModal
      preset="card"
      title="快捷新增前缀"
      style="width: 360px; max-width: 92vw"
      :bordered="false"
      :show="quickAddOpen"
      @update:show="(v) => (quickAddOpen = v)"
    >
      <NInput
        v-model:value="quickAddValue"
        placeholder="如 feat / TASK#12345"
        @keydown.enter="confirmQuickAdd"
      />
      <template #footer>
        <NSpace justify="end" :size="8">
          <NButton size="small" @click="quickAddOpen = false">取消</NButton>
          <NButton size="small" type="primary" :disabled="!quickAddValue.trim()" @click="confirmQuickAdd">
            添加
          </NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.ai {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border-radius: var(--r-lg);
  overflow: hidden;
  min-width: 0;
}

/* 头部 */
.ai__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  flex-shrink: 0;
}
.ai__head-icon {
  color: var(--brand);
}
.ai__head-title {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-primary);
}
.ai__head-spacer {
  flex: 1;
}
.ai__head-tag {
  font-size: 10px;
}
.ai__icon-btn {
  color: var(--text-tertiary);
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: var(--r-sm);
  flex-shrink: 0;
  transition: color var(--dur-fast), background var(--dur-fast);
}
.ai__icon-btn:hover {
  color: var(--brand);
  background: var(--bg-hover);
}
.ai__icon-btn--sm {
  width: 22px;
  height: 22px;
}

/* 前缀选择条：分段胶囊容器 */
.px {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-3) var(--sp-2);
  flex-shrink: 0;
}
.px__label {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  flex-shrink: 0;
}
.px__scroll {
  flex: 1;
  min-width: 0;
}
/* 轨道：统一容器，内凹质感 */
.px__track {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  background: var(--bg-app);
  border-radius: var(--r-full, 9999px);
  min-width: 0;
}
.px__item {
  font-size: var(--fs-xs);
  font-family: var(--font-mono);
  color: var(--text-tertiary);
  padding: 3px var(--sp-3);
  border-radius: var(--r-full, 9999px);
  white-space: nowrap;
  line-height: 1.6;
  cursor: pointer;
  user-select: none;
  transition: color var(--dur-base) var(--ease-standard),
    background var(--dur-base) var(--ease-standard),
    box-shadow var(--dur-base) var(--ease-standard);
}
.px__item:hover {
  color: var(--text-primary);
}
.px__item--active {
  color: var(--text-on-brand);
  background: var(--brand);
  box-shadow: 0 1px 2px var(--brand-glow);
}
.px__item--active:hover {
  color: var(--text-on-brand);
}
/* 右侧操作按钮组 */
.px__actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}
.px__btn {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  color: var(--text-tertiary);
  border-radius: var(--r-full, 9999px);
  cursor: pointer;
  transition: color var(--dur-base) var(--ease-standard),
    background var(--dur-base) var(--ease-standard);
}
.px__btn:hover {
  color: var(--brand);
  background: var(--bg-hover);
}

/* 主体：统一文本区 */
.ai__body {
  flex: 1;
  min-height: 0;
  padding: var(--sp-2) var(--sp-3) var(--sp-1);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.ai__error {
  flex-shrink: 0;
  margin: auto 0;
}
/* 文本区：idle/editing 可编辑；generating 只读但同款外观 */
.ai__textarea {
  flex: 1;
  min-height: 0;
}
.ai__textarea :deep(textarea) {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  line-height: 1.65;
  resize: none;
}

/* 生成中：专用流式展示（不置灰） */
.ai__stream {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  overflow: hidden;
}
.ai__stream-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-3);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
/* 呼吸光点 */
.ai__stream-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--brand);
  animation: pulse 1.2s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 0.4; transform: scale(0.9); }
  50% { opacity: 1; transform: scale(1.2); }
}
.ai__stream-label {
  font-size: var(--fs-xs);
  font-weight: 500;
  color: var(--text-secondary);
}
.ai__stream-src {
  font-size: 10px;
}
/* 流式输出区 */
.ai__stream-out {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--sp-3);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  line-height: 1.65;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
.ai__stream-wait {
  color: var(--text-tertiary);
  font-style: italic;
}
/* 行内闪烁光标 */
.ai__stream-caret {
  display: inline-block;
  width: 7px;
  height: 1.1em;
  margin-left: 1px;
  vertical-align: text-bottom;
  background: var(--brand);
  border-radius: 1px;
  animation: blink-caret 1s steps(2) infinite;
}
@keyframes blink-caret {
  50% { opacity: 0; }
}

/* 未配置提示 */
.ai__nokey {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  justify-content: center;
  flex-shrink: 0;
  padding-bottom: var(--sp-1);
}

/* 工具栏（始终显示） */
.ai__bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  flex-shrink: 0;
  flex-wrap: wrap;
  row-gap: var(--sp-1);
}
.ai__bar-spacer {
  flex: 1;
}
/* 代码审查入口：位于右簇最左（生成按钮左侧），无需额外左间距 */
.ai__review-btn {
  flex-shrink: 0;
}
.ai__detail {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-2);
  margin-left: calc(var(--sp-1) * -1);
  border-radius: var(--r-base);
  cursor: pointer;
  user-select: none;
  transition: background var(--dur-fast) var(--ease-standard);
}
.ai__detail-text {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  line-height: 1;
}
.ai__detail-help {
  color: var(--text-tertiary);
  cursor: help;
  transition: color var(--dur-fast);
  margin-left: -2px;
  opacity: 0.8;
}
.ai__detail:hover .ai__detail-help {
  opacity: 1;
}
.ai__detail-help:hover {
  color: var(--brand);
}
.ai__src-tag {
  font-size: 10px;
}
/* 被忽略文件按钮 */
.ai__omitted {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  background: var(--bg-hover);
  padding: 2px var(--sp-2);
  border-radius: var(--r-full, 9999px);
  cursor: pointer;
  transition: color var(--dur-base) var(--ease-standard),
    background var(--dur-base) var(--ease-standard);
}
.ai__omitted:hover {
  color: var(--intent-warning, #d97706);
  background: var(--bg-selected);
}

/* 被忽略文件弹层 */
.omitted {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  max-height: 320px;
}
.omitted__title {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-primary);
}
.omitted__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: auto;
  max-height: 220px;
}
.omitted__row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 2px 0;
}
.omitted__path {
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.omitted__tag {
  font-size: 10px;
  flex-shrink: 0;
}
.omitted__note {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  border-top: 1px solid var(--border);
  padding-top: var(--sp-2);
}
/* 强制包含按钮：默认弱化，激活时品牌色高亮 */
.omitted__force {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition:
    background var(--dur-base) var(--ease-standard),
    color var(--dur-base) var(--ease-standard);
}
.omitted__force:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}
.omitted__force--on {
  color: var(--brand);
  background: var(--bg-hover);
}
.omitted__force--disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.omitted__force--disabled:hover {
  background: transparent;
  color: var(--text-tertiary);
}
.omitted__regen {
  margin-top: var(--sp-1);
  flex-shrink: 0;
}
</style>
