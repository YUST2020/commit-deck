<script setup lang="ts">
import { NButton, NScrollbar, NBadge } from 'naive-ui'
import { Plus, Minus, RefreshCw, Check } from 'lucide-vue-next'
import type { FileChange, FileStatus } from '@shared/index'

defineProps<{
  files: FileChange[]
  selected: string | null
  staged: FileChange[]
  unstaged: FileChange[]
  loading?: boolean
}>()

const emit = defineEmits<{
  /**
   * 选中文件查看 diff。
   * renamedFrom 用于 rename 文件——loadDiff 时需要同时传新旧路径才能让
   * git 识别 rename（否则只看新路径会显示成 new file）。
   */
  select: [path: string, staged: boolean, renamedFrom?: string]
  stage: [files: string[]]
  unstage: [files: string[]]
  refresh: []
}>()

// 状态 → 标签 + 颜色映射（用 CSS 变量而非 n-tag，避免内部 padding 造成的右侧异常空白）
const statusMap: Record<FileStatus, { label: string; color: string }> = {
  added: { label: 'A', color: 'var(--git-added)' },
  modified: { label: 'M', color: 'var(--git-modified)' },
  deleted: { label: 'D', color: 'var(--git-deleted)' },
  renamed: { label: 'R', color: 'var(--git-renamed)' },
  untracked: { label: '?', color: 'var(--git-untracked)' }
}

const SEP = /[\\/]/
function fileName(p: string): string {
  const parts = p.split(SEP)
  return parts[parts.length - 1] ?? p
}
function dirName(p: string): string {
  const parts = p.split(SEP)
  parts.pop()
  return parts.join('/')
}

/**
 * 收集某条文件改动作为 pathspec 列表传给 git。
 * - 普通（非 rename）文件：仅 [path]。
 * - rename 文件：[path, renamedFrom]（新路径 + 旧路径）。
 *
 * 之所以对 rename 同时传两个路径：`git reset -- <new>` 只重置新路径，
 * rename 的「删旧路径」改动会残留在 staged delete。同时传新旧两路径，
 * git 才能完整撤销 staged rename（旧路径回到 index，新路径从 index 移除）。
 * 注：worktree 的 rename 不会被 git reset 撤销（reset 只动 index），
 * 因此撤销后 a.txt 仍可能显示为 worktree deleted、b.txt 显示为 untracked——
 * 这是 git 的固有行为，但至少避免了「a.txt 在 staged delete」的误导状态。
 */
function pathspecOf(f: FileChange): string[] {
  return f.renamedFrom ? [f.path, f.renamedFrom] : [f.path]
}
</script>

<template>
  <div class="panel">
    <div class="panel__head">
      <div class="panel__title">
        变更
        <NBadge
          :value="staged.length"
          :max="99"
          color="var(--brand)"
          :show="staged.length > 0"
        />
      </div>
      <div class="panel__tools">
        <NButton text size="tiny" type="primary" :disabled="!unstaged.length" @click="emit('stage', unstaged.flatMap(pathspecOf))">
          全部暂存
        </NButton>
        <NButton quaternary size="tiny" :disabled="loading" @click="emit('refresh')">
          <template #icon>
            <RefreshCw :size="14" class="icon-spin" :class="{ 'icon-spin--active': loading }" />
          </template>
        </NButton>
      </div>
    </div>

    <div v-if="!files.length" class="panel__empty-wrap">
      <div class="empty-guide">
        <div class="empty-guide__icon"><Check :size="24" /></div>
        <div class="empty-guide__title">工作区没有改动</div>
        <div class="empty-guide__desc">所有的变更都已暂存或提交，环境整洁</div>
      </div>
    </div>

    <NScrollbar v-else class="panel__body">
      <!-- 已暂存 -->
      <div v-if="staged.length" class="group">
        <div class="group__label">
          已暂存 <span class="group__count">{{ staged.length }}</span>
        </div>
        <div
          v-for="(f, i) in staged"
          :key="'s-' + f.path"
          class="file-row"
          :class="{ 'file-row--active': f.path === selected }"
          :style="{ '--stagger': i }"
          @click="emit('select', f.path, true, f.renamedFrom)"
        >
          <span class="file-row__badge" :style="{ color: statusMap[f.status].color }">
            {{ statusMap[f.status].label }}
          </span>
          <div class="file-row__main">
            <span class="file-row__name" :class="{ 'file-row__name--deleted': f.status === 'deleted' }">{{ fileName(f.path) }}</span>
            <span v-if="f.renamedFrom" class="file-row__rename" :title="`重命名自 ${f.renamedFrom}`">← {{ fileName(f.renamedFrom) }}</span>
            <span class="file-row__dir" :title="dirName(f.path)">{{ dirName(f.path) }}</span>
          </div>
          <button class="file-row__act" title="取消暂存" @click.stop="emit('unstage', pathspecOf(f))">
            <Minus :size="14" />
          </button>
        </div>
      </div>

      <!-- 未暂存 -->
      <div v-if="unstaged.length" class="group">
        <div class="group__label">
          未暂存 <span class="group__count">{{ unstaged.length }}</span>
        </div>
        <div
          v-for="(f, i) in unstaged"
          :key="'u-' + f.path"
          class="file-row"
          :class="{ 'file-row--active': f.path === selected }"
          :style="{ '--stagger': i }"
          @click="emit('select', f.path, false, f.renamedFrom)"
        >
          <span class="file-row__badge" :style="{ color: statusMap[f.status].color }">
            {{ statusMap[f.status].label }}
          </span>
          <div class="file-row__main">
            <span class="file-row__name" :class="{ 'file-row__name--deleted': f.status === 'deleted' }">{{ fileName(f.path) }}</span>
            <span v-if="f.renamedFrom" class="file-row__rename" :title="`重命名自 ${f.renamedFrom}`">← {{ fileName(f.renamedFrom) }}</span>
            <span class="file-row__dir" :title="dirName(f.path)">{{ dirName(f.path) }}</span>
          </div>
          <button class="file-row__act" title="暂存" @click.stop="emit('stage', pathspecOf(f))">
            <Plus :size="14" />
          </button>
        </div>
      </div>
    </NScrollbar>
  </div>
</template>

<style scoped>
.panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  /* 白底卡片：浮起于灰色画布之上，圆角 + overflow 裁剪内部内容。
     margin 留出与相邻卡片/画布边缘的缝隙。 */
  background: var(--bg-panel);
  border-radius: var(--r-lg);
  overflow: hidden;
  min-width: 0;
}

.panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-3) var(--sp-4);
  /* 卡片内头部与正文同色（透明），仅靠字重区分标题，不画分隔线 */
}

.panel__title {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.panel__tools {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

.panel__body {
  flex: 1;
  min-height: 0;
  padding: var(--sp-2);
}

.panel__empty-wrap {
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
  gap: var(--sp-2);
  animation: fade-in var(--dur-slow) var(--ease-standard) both;
}

@keyframes fade-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

.empty-guide__icon {
  width: 52px;
  height: 52px;
  border-radius: var(--r-xl);
  display: grid;
  place-items: center;
  color: var(--brand);
  background: var(--bg-selected);
  margin-bottom: var(--sp-1);
}

.empty-guide__title {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-primary);
}

.empty-guide__desc {
  font-size: var(--fs-sm);
  color: var(--text-tertiary);
  line-height: 1.6;
  max-width: 200px;
}

.group {
  margin-bottom: var(--sp-4);
}

.group__label {
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text-tertiary);
  padding: var(--sp-2) var(--sp-2) var(--sp-1);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.group__count {
  color: var(--text-secondary);
  font-weight: 500;
}

.file-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2);
  border-radius: var(--r-md);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-standard);
  animation: row-in var(--dur-slow) var(--ease-standard) both;
  animation-delay: calc(var(--stagger, 0) * 16ms);
}

@keyframes row-in {
  from { opacity: 0; transform: translateX(-4px); }
  to { opacity: 1; transform: translateX(0); }
}

.file-row:hover {
  background: var(--bg-hover);
}

.file-row--active {
  background: var(--bg-selected);
}

/* 选中态左侧品牌色指示条 */
.file-row--active::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 50%;
  width: 3px;
  height: 16px;
  border-radius: var(--r-full, 9999px);
  background: var(--brand);
  transform: translateY(-50%);
}

/* 状态徽标：固定等宽，无多余 padding，对齐文件名首字符 */
.file-row__badge {
  flex-shrink: 0;
  width: 14px;
  text-align: center;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  font-weight: 700;
  line-height: 1;
}

.file-row__main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
}

.file-row__name {
  font-size: var(--fs-sm);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0; /* 文件名优先完整显示，目录在后截断 */
  max-width: 60%;
}

/* 删除态文件名：划线 + 弱化色，强化视觉表达 */
.file-row__name--deleted {
  text-decoration: line-through;
  color: var(--text-tertiary);
}

/* rename 旧文件名提示：弱化色 + 小字号，附在新文件名后，
   既保留「重命名自 xxx」的信息，又不喧宾夺主 */
.file-row__rename {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  white-space: nowrap;
  flex-shrink: 0;
}

.file-row__dir {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
}

.file-row__act {
  opacity: 0;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  padding: var(--sp-1);
  border-radius: var(--r-sm);
  display: grid;
  place-items: center;
  flex-shrink: 0;
  transition: opacity var(--dur-fast), color var(--dur-fast), background var(--dur-fast);
}

.file-row:hover .file-row__act {
  opacity: 1;
}

.file-row__act:hover {
  color: var(--brand);
  background: var(--bg-app);
}
</style>
